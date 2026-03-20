const { getServiceClient } = require('../lib/supabase');
const { config } = require('../lib/config');
const {
  classifyIncident,
  platformFromUrl,
  detectReportedPlatforms,
  isContextOnlyArticle,
  isDeepfakeRelevant,
  isTitleDeepfakeSpecific,
  deepfakeRelevanceScore,
  deriveModalities,
  deriveTags,
  deriveHarmLevel,
  deriveSourcePriority,
  buildIncidentKey,
  isIncidentCandidate,
} = require('../lib/classify');
const { resolveImage } = require('../lib/placeholders');
const { scoreWithProviders, blendConfidence } = require('../lib/detectors');

async function fetchGdelt() {
  return fetchGdeltByQuery(config.gdeltQuery, config.gdeltMaxRecords);
}

async function fetchGdeltContext() {
  try {
    const primary = await fetchGdeltByQuery(config.gdeltContextQuery, config.gdeltContextMaxRecords);
    if (primary.length > 0) return primary;
    const fallbackQuery =
      '(deepfake OR "synthetic media" OR "AI-generated" OR "voice clone" OR "face swap" OR "AI porn" OR "deepfake law")';
    return await fetchGdeltByQuery(fallbackQuery, config.gdeltContextMaxRecords);
  } catch {
    // Context coverage is optional; never fail core incident ingestion.
    return [];
  }
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function rotateFeedsForRun(feeds) {
  const list = Array.isArray(feeds) ? feeds.filter(Boolean) : [];
  if (!list.length) return [];
  const perRun = Math.max(1, Math.min(Number(config.rssFeedsPerRun || list.length), list.length));
  if (perRun >= list.length) return list;
  const windowMinutes = Math.max(1, Number(config.rssRotationWindowMinutes || 15));
  const bucket = Math.floor(Date.now() / (windowMinutes * 60 * 1000));
  const start = (bucket * perRun) % list.length;
  const out = [];
  for (let i = 0; i < perRun; i += 1) {
    out.push(list[(start + i) % list.length]);
  }
  return out;
}

function shouldFetchContextThisRun() {
  const interval = Math.max(15, Number(config.contextFetchIntervalMinutes || 60));
  const now = new Date();
  const minutesSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutesSinceMidnight % interval < 15;
}

function shouldExcludeDomain(domain) {
  const hardBlocked = new Set([
    'bignewsnetwork.com',
    'haskellforall.com',
  ]);
  const list = splitCsv(config.excludedDomains).map((d) => d.toLowerCase());
  const value = String(domain || '').toLowerCase();
  if (hardBlocked.has(value)) return true;
  return list.some((d) => value.includes(d));
}

function isExcludedByTitle(title) {
  const t = String(title || '').toLowerCase();
  return /(fortnite|gaming skin|battle pass|haskell for all|agentic coding spec|iphone bug|nvidia dlss|meme backlash)/.test(t);
}

function hasStrongDeepfakeSignal(text) {
  return /(deepfake|deep fake|voice clone|cloned voice|face swap|fake audio|fake video|ai porn|non-consensual|synthetic media|manipulated media|digital forgery|ai impersonation)/i.test(
    String(text || '')
  );
}

function passesStrictRelevance(article, title, description) {
  const sourceType = article.source_type || 'news';
  const full = `${title} ${description} ${article.url || ''}`;
  const titleSignal = hasStrongDeepfakeSignal(title);
  const fullSignal = hasStrongDeepfakeSignal(full);
  const relevance = deepfakeRelevanceScore(title, description);

  // For fact-check feeds, allow softer wording if relevance still indicates deepfake context.
  if (sourceType === 'factcheck') {
    if (!titleSignal && !fullSignal && relevance < 1) return false;
  } else if (!titleSignal && !fullSignal) {
    // News/social records still require explicit deepfake-style signal.
    return false;
  }

  // Opinion/editorial pieces must still be explicit in title to avoid generic policy content.
  if (/(opinion|editorial|analysis)/i.test(title) && !titleSignal) return false;

  // Raise quality bar globally to reduce false positives.
  if (sourceType === 'factcheck') {
    if (relevance < 1) return false;
  } else if (relevance < 2) {
    return false;
  }

  // News sources should still carry a strong signal in title OR body.
  if (sourceType === 'news' && !titleSignal && !fullSignal) return false;

  return true;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(text) {
  return decodeXmlEntities(text).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonicalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const dropParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'mc_cid',
      'mc_eid',
    ];
    dropParams.forEach((p) => u.searchParams.delete(p));
    u.hash = '';
    return u.toString();
  } catch {
    return String(url).trim();
  }
}

function isHomepageLikeUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    const path = String(u.pathname || "/").trim();
    const cleanPath = path.replace(/\/+$/, "") || "/";
    const low = cleanPath.toLowerCase();
    if (cleanPath === "/") return true;
    if (["/home", "/index", "/index.html", "/news"].includes(low)) return true;
    return false;
  } catch {
    return true;
  }
}

function dedupeIncidents(items) {
  const byUrl = new Map();
  const byTitle = new Map();

  const normalizedTitleKey = (title) =>
    String(title || '')
      .toLowerCase()
      .replace(/[\|\-:]\s*(bbc|cnn|reuters|ap|associated press|news|live updates?).*$/i, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 14)
      .join(' ');

  const priority = (item) => {
    const t = String(item?.source_type || '').toLowerCase();
    if (t === 'social_report') return 3;
    if (t === 'factcheck') return 2;
    if (t === 'news') return 1;
    return 0;
  };

  const pick = (a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pb > pa ? b : a;
    const ta = new Date(a?.published_at || a?.seendate || 0).getTime();
    const tb = new Date(b?.published_at || b?.seendate || 0).getTime();
    return tb > ta ? b : a;
  };

  for (const item of items || []) {
    const normalized = { ...item, article_url: canonicalizeUrl(item.article_url) || item.article_url };
    const urlKey = canonicalizeUrl(normalized.article_url);
    const titleKey = normalizedTitleKey(normalized.title);
    if (urlKey) byUrl.set(urlKey, byUrl.has(urlKey) ? pick(byUrl.get(urlKey), normalized) : normalized);
    if (titleKey) byTitle.set(titleKey, byTitle.has(titleKey) ? pick(byTitle.get(titleKey), normalized) : normalized);
  }

  const merged = new Map();
  for (const item of byUrl.values()) merged.set(item.source_id || item.article_url || item.title, item);
  for (const item of byTitle.values()) {
    const key = item.source_id || item.article_url || item.title;
    merged.set(key, merged.has(key) ? pick(merged.get(key), item) : item);
  }
  return Array.from(merged.values());
}

function matchTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? stripHtml(m[1]) : '';
}

function matchAttrTag(block, tag, attrName) {
  const re = new RegExp(`<${tag}[^>]*${attrName}=["']([^"']+)["'][^>]*>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function parseRssItems(xml) {
  const items = [];
  const matchFirst = (block, patterns) => {
    for (const re of patterns) {
      const m = block.match(re);
      if (m && m[1]) return String(m[1]).trim();
    }
    return "";
  };
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const links = Array.from(block.matchAll(/https?:\/\/[^\s"'<>]+/gi)).map((m) => m[0]);
    const mediaUrl = matchFirst(block, [
      /<media:content[^>]+url=["']([^"']+)["'][^>]*>/i,
      /<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*>/i,
      /<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i,
    ]);
    items.push({
      title: matchTag(block, 'title'),
      description: matchTag(block, 'description'),
      link: matchTag(block, 'link'),
      pubDate: matchTag(block, 'pubDate') || matchTag(block, 'dc:date'),
      links,
      mediaUrl,
    });
  }
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of entryBlocks) {
    const links = Array.from(block.matchAll(/https?:\/\/[^\s"'<>]+/gi)).map((m) => m[0]);
    const mediaUrl = matchFirst(block, [
      /<media:content[^>]+url=["']([^"']+)["'][^>]*>/i,
      /<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*>/i,
      /<link[^>]+rel=["']enclosure["'][^>]+href=["']([^"']+)["'][^>]*>/i,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']enclosure["'][^>]*>/i,
    ]);
    const atomAlternateLink = matchFirst(block, [
      /<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["'][^>]*>/i,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']alternate["'][^>]*>/i,
    ]);
    const atomCanonicalLink = matchFirst(block, [
      /<link[^>]+href=["']([^"']+)["'][^>]*>/i,
    ]);
    items.push({
      title: matchTag(block, 'title'),
      description: matchTag(block, 'summary') || matchTag(block, 'content'),
      link: atomAlternateLink || atomCanonicalLink || matchTag(block, 'id'),
      pubDate: matchTag(block, 'updated') || matchTag(block, 'published'),
      links,
      mediaUrl,
    });
  }
  return items;
}

function pickClaimUrl(candidateLinks = []) {
  const socialNeedles = ['x.com/', 'twitter.com/', 'tiktok.com/', 'instagram.com/', 'facebook.com/', 'youtube.com/', 'youtu.be/', 'reddit.com/', 't.me/'];
  for (const link of candidateLinks) {
    const lower = String(link || '').toLowerCase();
    if (socialNeedles.some((n) => lower.includes(n))) return canonicalizeUrl(link);
  }
  return null;
}

function extractUrlsFromText(text) {
  const raw = String(text || "");
  const matches = Array.from(raw.matchAll(/https?:\/\/[^\s"'<>]+/gi)).map((m) => canonicalizeUrl(m[0]));
  return matches.filter(Boolean);
}

function isDirectPlatformUrl(url) {
  const low = String(url || "").toLowerCase();
  return /(x\.com|twitter\.com|tiktok\.com|instagram\.com|facebook\.com|youtube\.com|youtu\.be|reddit\.com|t\.me)/.test(low);
}

function pickBestArticleUrl(primaryLink, candidateLinks = []) {
  const canonicalPrimary = canonicalizeUrl(primaryLink);
  const links = Array.isArray(candidateLinks) ? candidateLinks : [];
  const isGoogleLike = (u) => /(news\.google\.com|googleusercontent\.com|gstatic\.com)/i.test(String(u || ""));
  const isHomepageLike = (u) => {
    try {
      const x = new URL(String(u || ""));
      const p = String(x.pathname || "/").replace(/\/+$/, "") || "/";
      const low = p.toLowerCase();
      return p === "/" || low === "/home" || low === "/index" || low === "/index.html" || low === "/news";
    } catch {
      return true;
    }
  };
  const scoreUrl = (u) => {
    if (!u) return -999;
    let s = 0;
    if (!isGoogleLike(u)) s += 40;
    if (!isHomepageLike(u)) s += 35;
    if (/\/\d{4}\/\d{2}\//.test(u)) s += 15;
    if (/(\/news\/|\/article|\/story|\/tech\/|\/politics\/|\/world\/|\/business\/)/i.test(u)) s += 15;
    if (/\.(rss|xml)(\?|$)/i.test(u) || /\/feed(\/|$)|\/rss(\/|$)|\/atom(\/|$)/i.test(u)) s -= 120;
    if (/\.(jpg|png|gif|webp|svg)$/i.test(u)) s -= 100;
    return s;
  };

  const all = Array.from(new Set([canonicalPrimary, ...links.map(canonicalizeUrl)].filter(Boolean)));
  const sorted = all.sort((a, b) => scoreUrl(b) - scoreUrl(a));
  const best = sorted[0] || "";
  if (best) return best;

  for (const raw of links) {
    const candidate = canonicalizeUrl(raw);
    if (!candidate) continue;
    if (candidate === canonicalPrimary) continue;
    if (!/^https?:\/\//i.test(candidate)) continue;
    if (isGoogleLike(candidate)) continue;
    return candidate;
  }
  return canonicalPrimary;
}

function isGoogleNewsUrl(url) {
  const low = String(url || "").toLowerCase();
  return /news\.google\.com\/rss\/articles\//.test(low) || /news\.google\.com\//.test(low);
}

function isGoogleOwnedHost(hostname = "") {
  const h = String(hostname || "").toLowerCase();
  return /(^|\.)google\./.test(h) || /(^|\.)googleusercontent\.com$/.test(h) || /(^|\.)gstatic\.com$/.test(h);
}

function extractFirstNonGoogleUrlFromHtml(html) {
  const matches = Array.from(String(html || "").matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)).map((m) => m[0]);
  for (const raw of matches) {
    const u = canonicalizeUrl(raw);
    if (!u) continue;
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      if (!isGoogleOwnedHost(host)) return u;
    } catch {
      // ignore malformed candidate
    }
  }
  return "";
}

async function resolveGooglePublisherUrl(url, candidateLinks = []) {
  const input = canonicalizeUrl(url);
  if (!input || !isGoogleNewsUrl(input)) return input;

  const headers = { "user-agent": "deepfake-record/1.0 (+contact: deepfake-record)" };

  try {
    const res = await fetch(input, { redirect: "follow", headers });
    const finalUrl = canonicalizeUrl(res.url || "");
    if (finalUrl) {
      try {
        const host = new URL(finalUrl).hostname.replace(/^www\./, "");
        if (!isGoogleOwnedHost(host)) return finalUrl;
      } catch {
        // continue
      }
    }
    const body = await res.text();
    const extracted = extractFirstNonGoogleUrlFromHtml(body);
    if (extracted) return extracted;
  } catch {
    // continue with fallbacks below
  }

  const fromCandidates = pickBestArticleUrl("", candidateLinks);
  if (fromCandidates && !isGoogleNewsUrl(fromCandidates)) return fromCandidates;
  return input;
}

async function fetchRssArticles() {
  const feeds = rotateFeedsForRun(splitCsv(config.rssFeeds));
  const records = [];
  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, { headers: { 'user-agent': 'deepfake-record/1.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseRssItems(xml).slice(0, config.rssMaxItemsPerFeed);
      for (const item of parsed) {
        const textLinks = extractUrlsFromText(`${item.title || ""} ${item.description || ""}`);
        const allLinks = [...(item.links || []), ...textLinks];
        let canonicalLink = pickBestArticleUrl(item.link, allLinks);
        if (isGoogleNewsUrl(canonicalLink)) {
          canonicalLink = await resolveGooglePublisherUrl(canonicalLink, allLinks);
        }
        const claimFromLinks = pickClaimUrl(allLinks);
        const claimUrl = claimFromLinks || (isDirectPlatformUrl(canonicalLink) ? canonicalLink : null);
        records.push({
          title: item.title,
          url: canonicalLink,
          seendate: item.pubDate,
          domain: (() => {
            try {
              return new URL(canonicalLink).hostname.replace(/^www\./, '');
            } catch {
              return 'unknown';
            }
          })(),
          sourcecountry: null,
          language: 'en',
          socialimage: canonicalizeUrl(item.mediaUrl || "") || null,
          description: item.description || '',
          source_type: claimUrl ? 'social_report' : 'factcheck',
          claim_url: claimUrl,
        });
      }
    } catch {
      // Skip failed feed and continue.
    }
  }
  return { records, feed_count: feeds.length };
}

async function fetchGdeltByQuery(query, maxrecords) {
  const totalAttempts = 4;
  const maxByAttempt = [
    Math.max(20, Number(maxrecords) || 80),
    Math.max(20, Math.floor((Number(maxrecords) || 80) * 0.75)),
    Math.max(15, Math.floor((Number(maxrecords) || 80) * 0.5)),
    Math.max(10, Math.floor((Number(maxrecords) || 80) * 0.35)),
  ];
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const params = new URLSearchParams({
      query,
      mode: 'artlist',
      maxrecords: String(maxByAttempt[Math.min(attempt, maxByAttempt.length - 1)]),
      format: 'json',
      sort: 'datedesc',
    });
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
    const timeoutMs = 10000 + attempt * 4000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'deepfake-record/1.0 (+contact: deepfake-record)',
          accept: 'application/json,text/plain,*/*',
        },
        signal: controller.signal,
      });

      if (res.ok) {
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`GDELT returned non-JSON success payload: ${text.slice(0, 200)}`);
        }
        return Array.isArray(json.articles) ? json.articles : [];
      }

      const body = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < totalAttempts - 1) {
        const base = res.status === 429 ? 4500 : 2500;
        await sleep(base + attempt * 2000);
        continue;
      }

      throw new Error(`GDELT request failed (${res.status}): ${body.slice(0, 300)}`);
    } catch (err) {
      lastError = err;
      if (attempt < totalAttempts - 1) {
        await sleep(1800 + attempt * 1600);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError) throw lastError;
  return [];
}

function classifyContextTopic(text) {
  const content = (text || '').toLowerCase();
  if (/(law|regulation|bill|act|policy|senate|parliament|legislation)/.test(content)) return 'Policy & Law';
  if (/(election|vote|campaign|democracy|politic|bias)/.test(content)) return 'Politics & Elections';
  if (/(teen|youth|child|school|mental health|body image)/.test(content)) return 'Youth Impact';
  if (/(algorithm|platform|recommendation|feed|moderation|social media)/.test(content)) return 'Platform Effects';
  return 'Public Impact';
}

async function normalize(client, article, index) {
  const title = (article.title || '').trim();
  const sourceType = article.source_type || 'news';
  const isFactcheck = sourceType === 'factcheck';
  const description =
    article.description ||
    (article.seendate ? `Seen ${article.seendate}` : '') + (article.sourcecountry ? ` · ${article.sourcecountry}` : '');
  const lowValueGuide = /(deepfakemaker|deepfake maker|how to|practical guide|guide to|tutorial|choosing the perfect|turn any clip|viral ai video|face swap)/i.test(
    `${title} ${description}`
  );
  const strongIncidentSignal = /(victim|victimized|lawsuit|sued|arrest|charged|jailed|banned|ban|removed|takedown|scam|fraud|impersonation|child porn|non-consensual)/i.test(
    `${title} ${description}`
  );
  if (lowValueGuide && !strongIncidentSignal) {
    return null;
  }
  if (shouldExcludeDomain(article.domain)) {
    return null;
  }
  if (isExcludedByTitle(title)) {
    return null;
  }
  const fullText = `${title} ${description} ${article.url || ''}`;
  if (!isDeepfakeRelevant(fullText)) {
    return null;
  }
  if (!passesStrictRelevance(article, title, description)) {
    return null;
  }
  if (!isFactcheck && !isIncidentCandidate(article, title, description)) {
    return null;
  }
  // Tighten generic news intake to avoid unrelated AI/culture stories.
  if (sourceType === 'news' && !isTitleDeepfakeSpecific(title)) {
    return null;
  }
  // Fact-check sources are already curated; avoid over-pruning due to softer wording.
  if (isFactcheck && deepfakeRelevanceScore(title, description) < 1) {
    return null;
  }
  if (!isFactcheck && isContextOnlyArticle(`${title} ${description} ${article.url || ''}`)) {
    return null;
  }
  const classified = classifyIncident(`${title} ${description} ${article.domain || ''} ${article.language || ''}`);
  // Emergency runtime override for production incidents_category_check mismatches.
  if (process.env.FORCE_CATEGORY_FALLBACK === '1' && classified.type === 'entertainment') {
    classified.type = 'entertainment';
    classified.label = 'Entertainment';
  }
  const politicsHint = /(propaganda|government|minister|election|state media|campaign|parliament|senate|president)/i.test(`${title} ${description}`);
  if (politicsHint && classified.type === 'entertainment') {
    classified.type = 'political';
    classified.label = 'Political';
  }
  const sourceDomain = article.domain || 'unknown';
  let articleUrl = canonicalizeUrl(article.url || '');
  const claimUrl = article.claim_url
    ? canonicalizeUrl(article.claim_url)
    : (isDirectPlatformUrl(articleUrl) ? articleUrl : null);
  const homepageLike = isHomepageLikeUrl(articleUrl);
  if (homepageLike && claimUrl && !isHomepageLikeUrl(claimUrl)) {
    articleUrl = claimUrl;
  }
  if (isHomepageLikeUrl(articleUrl)) {
    // Skip low-quality homepage links that are not incident-level records.
    return null;
  }
  const image = await resolveImage(article, { client });
  const imageUrl = image.url;
  const publishedAt = parseSeenDate(article.seendate);
  const reportedPlatforms = detectReportedPlatforms(`${title} ${description} ${articleUrl || ''}`);
  const reportedOn = reportedPlatforms.length ? reportedPlatforms.join(',') : null;
  const modalities = deriveModalities(`${title} ${description}`);
  const tags = deriveTags(`${title} ${description}`);

  let providerScores = [];
  if (index < config.detectionMaxItems) {
    providerScores = await scoreWithProviders(article);
  }

  const blended = blendConfidence(classified.score, providerScores);

  return {
    source_id: articleUrl || `${sourceDomain}:${title}`,
    title: title || 'Untitled incident',
    summary: description,
    category: classified.type,
    category_label: classified.label,
    confidence: Number(blended.confidence.toFixed(2)),
    source_domain: sourceDomain,
    platform: platformFromUrl(articleUrl || sourceDomain),
    source_type: sourceType,
    claim_url: claimUrl,
    reported_on: reportedOn,
    article_url: articleUrl,
    image_url: imageUrl,
    image_type: image.documented ? 'documented' : 'illustrative',
    rights_status: image.documented ? 'link_only' : 'unknown',
    usage_note: image.documented ? 'Editorial thumbnail from reporting source.' : 'Illustrative synthetic placeholder; not evidence image.',
    country: article.sourcecountry || null,
    language: article.language || null,
    published_at: publishedAt,
    status: 'reported_as_synthetic',
    modalities,
    tags,
    harm_level: deriveHarmLevel(blended.confidence, `${title} ${description}`),
    source_priority: deriveSourcePriority(sourceDomain),
    incident_key: buildIncidentKey(title, classified.type, publishedAt),
  };
}

function parseSeenDate(seenDate) {
  if (!seenDate) return new Date().toISOString();

  const direct = new Date(seenDate);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const compact = String(seenDate).trim();
  const m = compact.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertIncidents(client, incidents) {
  if (incidents.length === 0) return { inserted: 0 };
  const { error } = await client.from('incidents').upsert(incidents, { onConflict: 'source_id' });
  if (error) throw error;
  return { inserted: incidents.length };
}

async function upsertContextArticles(client, articles) {
  if (articles.length === 0) return { inserted: 0 };
  const { error } = await client.from('context_articles').upsert(articles, { onConflict: 'source_id' });
  if (error) throw error;
  return { inserted: articles.length };
}

async function logIngestRun(client, fetched, upserted) {
  // Optional analytics table for "items scanned" counter.
  const { error } = await client.from('ingest_runs').insert({
    fetched,
    upserted,
    run_at: new Date().toISOString(),
  });
  // Do not fail ingest if this optional table is missing.
  if (error) return false;
  return true;
}

async function logIncidentEvents(client, incidents) {
  if (!Array.isArray(incidents) || incidents.length === 0) return { inserted: 0 };
  const now = new Date().toISOString();
  const rows = incidents.map((item) => ({
    source_id: item.source_id || null,
    article_url: item.article_url || null,
    title: item.title || null,
    category: item.category || null,
    confidence: Number(item.confidence) || 0,
    source_domain: item.source_domain || null,
    source_type: item.source_type || null,
    image_type: item.image_type || null,
    published_at: item.published_at || null,
    seen_at: now,
  }));
  const { error } = await client.from('incident_events').insert(rows);
  if (error) return { inserted: 0, skipped: true };
  return { inserted: rows.length };
}

module.exports = async (_req, res) => {
  try {
    const client = getServiceClient();
    let raw = [];
    const warnings = [];
    try {
      raw = await fetchGdelt();
    } catch (err) {
      const msg = String(err?.message || '').trim();
      if (msg.includes('GDELT request failed (429)')) {
        warnings.push('Primary GDELT feed rate-limited; run skipped safely.');
      } else {
        warnings.push(`Primary GDELT fetch failed; continuing with other sources. (${msg || 'unknown error'})`);
      }
      raw = [];
    }
    if (raw.length === 0) {
      let gdeltFallback = [];
      try {
        gdeltFallback = await fetchGdeltContext();
      } catch {
        gdeltFallback = [];
      }
      if (gdeltFallback.length > 0) {
        raw = gdeltFallback.map((item) => ({ ...item, source_type: item.source_type || 'news' }));
        warnings.push('Using fallback GDELT context feed.');
      }
    }
    let rawContext = [];
    let rssRaw = [];
    let rssFeedCount = 0;
    const redditRaw = [];
    const redditStatuses = [];

    if (shouldFetchContextThisRun()) {
      try {
        rawContext = await fetchGdeltContext();
      } catch {
        rawContext = [];
        warnings.push('Context feed fetch failed; continuing without context records.');
      }
    }
    try {
      const rssResult = await fetchRssArticles();
      rssRaw = Array.isArray(rssResult?.records) ? rssResult.records : [];
      rssFeedCount = Number(rssResult?.feed_count || 0);
    } catch {
      rssRaw = [];
      rssFeedCount = 0;
      warnings.push('RSS fetch failed; continuing with remaining sources.');
    }
    const mergedRaw = [...raw, ...rssRaw, ...redditRaw];
    const normalized = await Promise.all(mergedRaw.map((item, idx) => normalize(client, item, idx)));
    const incidents = dedupeIncidents(normalized.filter(Boolean));
    const contextArticles = await Promise.all(rawContext.map(async (article) => {
      const title = (article.title || '').trim();
      const sourceDomain = article.domain || 'unknown';
      const articleUrl = article.url || null;
      const publishedAt = parseSeenDate(article.seendate);
      const topic = classifyContextTopic(`${title} ${sourceDomain}`);
      const image = await resolveImage(article, { client });
      return {
        source_id: articleUrl || `${sourceDomain}:${title}`,
        title: title || 'Untitled context article',
        summary:
          (article.seendate ? `Seen ${article.seendate}` : '') +
          (article.sourcecountry ? ` · ${article.sourcecountry}` : ''),
        topic_label: topic,
        source_domain: sourceDomain,
        article_url: articleUrl,
        image_url: image.url,
        published_at: publishedAt,
      };
    }));
    const result = await upsertIncidents(client, incidents);
    const contextResult = await upsertContextArticles(client, contextArticles);
    const eventsResult = await logIncidentEvents(client, incidents);
    await logIngestRun(client, mergedRaw.length, result.inserted);
    res.status(200).json({
      ok: true,
      fetched: mergedRaw.length,
      deduped: incidents.length,
      upserted: result.inserted,
      fetched_gdelt: raw.length,
      fetched_rss: rssRaw.length,
      fetched_rss_feeds: rssFeedCount,
      fetched_reddit: redditRaw.length,
      reddit_statuses: redditStatuses,
      context_fetched: rawContext.length,
      context_upserted: contextResult.inserted,
      archived_events_logged: eventsResult.inserted || 0,
      warning: warnings.length ? warnings.join(' ') : null,
      at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
