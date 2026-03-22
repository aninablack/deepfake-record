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
  return /(deepfake|deep fake|voice clone|cloned voice|face swap|fake audio|fake video|ai porn|non-consensual|synthetic media|manipulated media|digital forgery|ai impersonation|synthetic voice|audio cloning|ai-generated image|ai-generated video|generative ai fraud|identity fraud|ai fraud|fake likeness|unauthorized likeness|ai clone|cloned likeness|liveness detection|biometric fraud|synthetic identity|ai impersonat|fake celebrity|fake politician|fabricated video|fabricated audio|fabricated image|forged video|forged image|ai-powered scam|deepfake porn|deepfake fraud|deepfake election|deepfake celebrity|deepfake political|image manipulation|video manipulation|audio manipulation)/i.test(
    String(text || '')
  );
}

const TRUSTED_DEEPFAKE_DOMAINS = [
  'bellingcat.com',
  'dfrlab.org',
  'euvsdisinfo.eu',
  'snopes.com',
  'politifact.com',
  'fullfact.org',
  'bleepingcomputer.com',
  'krebsonsecurity.com',
  '404media.co',
  'therecord.media',
];

const RSS_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (compatible; deepfake-record/1.0; +https://deepfake-record.vercel.app)',
];

function rssFetchHeaders() {
  const ua = RSS_USER_AGENTS[Math.floor(Math.random() * RSS_USER_AGENTS.length)];
  return {
    'user-agent': ua,
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, text/html;q=0.8, */*;q=0.7',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
    pragma: 'no-cache',
    'cache-control': 'no-cache',
  };
}

function passesStrictRelevance(article, title, description) {
  const full = `${title} ${description} ${article.url || ''}`;
  const titleSignal = hasStrongDeepfakeSignal(title);
  const fullSignal = hasStrongDeepfakeSignal(full);
  const relevance = deepfakeRelevanceScore(title, description);
  // Must have at least one deepfake signal somewhere.
  if (!titleSignal && !fullSignal && relevance < 1) return false;

  // Opinion/editorial without explicit title signal is usually context noise.
  if (/(opinion|editorial)/i.test(title) && !titleSignal) return false;

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

function pickNonHomepageCandidate(candidateLinks = []) {
  for (const raw of candidateLinks || []) {
    const u = canonicalizeUrl(raw);
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    if (isHomepageLikeUrl(u)) continue;
    if (/\.(jpg|png|gif|webp|svg)$/i.test(u)) continue;
    return u;
  }
  return "";
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
    if (t === 'news') return 4;
    if (t === 'factcheck') return 3;
    if (t === 'social_report') return 2;
    return 0;
  };

  const pick = (a, b) => {
    const aUrl = String(a?.article_url || "").trim();
    const bUrl = String(b?.article_url || "").trim();
    const aHasLink = !!aUrl;
    const bHasLink = !!bUrl;
    if (aHasLink !== bHasLink) return bHasLink ? b : a;

    const aHomepage = isHomepageLikeUrl(aUrl);
    const bHomepage = isHomepageLikeUrl(bUrl);
    if (aHomepage !== bHomepage) return bHomepage ? a : b;

    const aDoc = String(a?.image_type || "").toLowerCase() === "documented" && !!String(a?.image_url || "").trim();
    const bDoc = String(b?.image_type || "").toLowerCase() === "documented" && !!String(b?.image_url || "").trim();
    if (aDoc !== bDoc) return bDoc ? b : a;

    const aGoogle = /(^|\.)news\.google\.com$/i.test(String(a?.source_domain || ""));
    const bGoogle = /(^|\.)news\.google\.com$/i.test(String(b?.source_domain || ""));
    if (aGoogle !== bGoogle) return bGoogle ? a : b;

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
    const description = matchTag(block, 'description');
    const links = Array.from(block.matchAll(/https?:\/\/[^\s"'<>]+/gi)).map((m) => m[0]);
    const mediaUrl =
      matchFirst(block, [
        /<media:content[^>]+url=["']([^"']+)["'][^>]*>/i,
        /<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*>/i,
        /<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i,
      ]) ||
      matchFirst(description, [/<img[^>]+src=["']([^"']+)["'][^>]*>/i]);
    items.push({
      title: matchTag(block, 'title'),
      description,
      link: matchTag(block, 'link'),
      pubDate: matchTag(block, 'pubDate') || matchTag(block, 'dc:date'),
      links,
      mediaUrl,
    });
  }
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of entryBlocks) {
    const description = matchTag(block, 'summary') || matchTag(block, 'content');
    const links = Array.from(block.matchAll(/https?:\/\/[^\s"'<>]+/gi)).map((m) => m[0]);
    const mediaUrl =
      matchFirst(block, [
        /<media:content[^>]+url=["']([^"']+)["'][^>]*>/i,
        /<media:thumbnail[^>]+url=["']([^"']+)["'][^>]*>/i,
        /<link[^>]+rel=["']enclosure["'][^>]+href=["']([^"']+)["'][^>]*>/i,
        /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']enclosure["'][^>]*>/i,
      ]) ||
      matchFirst(description, [/<img[^>]+src=["']([^"']+)["'][^>]*>/i]);
    const atomAlternateLink = matchFirst(block, [
      /<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["'][^>]*>/i,
      /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']alternate["'][^>]*>/i,
    ]);
    const atomCanonicalLink = matchFirst(block, [
      /<link[^>]+href=["']([^"']+)["'][^>]*>/i,
    ]);
    items.push({
      title: matchTag(block, 'title'),
      description,
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

function classifyRssSourceType(feedUrl, articleUrl, claimUrl = null) {
  if (claimUrl) return 'social_report';
  const text = `${feedUrl || ''} ${articleUrl || ''}`.toLowerCase();
  if (/(snopes|politifact|factcheck|fullfact|leadstories|euvsdisinfo)/.test(text)) return 'factcheck';
  return 'news';
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

  const headers = rssFetchHeaders();

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
      const res = await fetch(feedUrl, { headers: rssFetchHeaders() });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseRssItems(xml).slice(0, config.rssMaxItemsPerFeed);
      for (const item of parsed) {
        const textLinks = extractUrlsFromText(`${item.title || ""} ${item.description || ""}`);
        const allLinks = [...(item.links || []), ...textLinks];
        let canonicalLink = "";
        if (isGoogleNewsUrl(item.link)) {
          canonicalLink = await resolveGooglePublisherUrl(item.link, allLinks);
        } else {
          canonicalLink = pickBestArticleUrl(item.link, allLinks);
          if (isGoogleNewsUrl(canonicalLink)) {
            canonicalLink = await resolveGooglePublisherUrl(canonicalLink, allLinks);
          }
        }
        if (isHomepageLikeUrl(canonicalLink)) {
          const nonHomepage = pickNonHomepageCandidate(allLinks);
          if (nonHomepage) canonicalLink = nonHomepage;
        }
        const claimFromLinks = pickClaimUrl(allLinks);
        const claimUrl = claimFromLinks || (isDirectPlatformUrl(canonicalLink) ? canonicalLink : null);
        const sourceType = classifyRssSourceType(feedUrl, canonicalLink, claimUrl);
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
          source_type: sourceType,
          claim_url: claimUrl,
        });
      }
    } catch {
      // Skip failed feed and continue.
    }
  }
  return { records, feed_count: feeds.length };
}

async function fetchNewsDataArticles() {
  const apiKey = String(process.env.NEWSDATA_API_KEY || '').trim();
  if (!apiKey) return { records: [], status: 'missing_key', http: null };

  const rawQuery =
    String(process.env.NEWSDATA_QUERY || '').trim() ||
    'deepfake OR "voice clone" OR "synthetic media" OR "AI impersonation"';
  const query = rawQuery.replace(/^\((.*)\)$/s, '$1').trim();
  // Free tier supports up to 10 articles per request; enforce hard cap to avoid 422.
  const size = Math.max(1, Math.min(Number(process.env.NEWSDATA_MAX_RECORDS || 10), 10));
  const buildUrl = ({ q, includeLanguage = true }) => {
    const u = new URL('https://newsdata.io/api/1/news');
    u.searchParams.set('apikey', apiKey);
    if (includeLanguage) u.searchParams.set('language', 'en');
    u.searchParams.set('q', q);
    u.searchParams.set('size', String(size));
    return u.toString();
  };

  try {
    let res = await fetch(buildUrl({ q: query, includeLanguage: true }), {
      headers: {
        accept: 'application/json',
        'user-agent': 'deepfake-record/1.0 (+https://deepfake-record.vercel.app)',
      },
    });
    if (res.status === 422) {
      // Provider-side validation can reject richer queries/filters on some plans.
      // Retry with a minimal, broadly-compatible payload.
      res = await fetch(buildUrl({ q: 'deepfake', includeLanguage: false }), {
        headers: {
          accept: 'application/json',
          'user-agent': 'deepfake-record/1.0 (+https://deepfake-record.vercel.app)',
        },
      });
    }
    if (!res.ok) return { records: [], status: 'http_error', http: res.status };
    const json = await res.json();
    const rows = Array.isArray(json?.results) ? json.results : [];
    const records = rows.map((item) => {
      const link = canonicalizeUrl(item?.link || '');
      const domain = String(item?.source_id || '').trim().toLowerCase() || (() => {
        try {
          return new URL(link).hostname.replace(/^www\./, '');
        } catch {
          return 'unknown';
        }
      })();
      const description = String(item?.description || item?.content || '').trim();
      return {
        title: String(item?.title || '').trim(),
        url: link,
        seendate: item?.pubDate || item?.pubDateTZ || null,
        domain,
        sourcecountry: null,
        language: String(item?.language || 'en').trim().toLowerCase(),
        socialimage: canonicalizeUrl(item?.image_url || '') || null,
        description,
        source_type: 'news',
        claim_url: null,
      };
    });
    return { records, status: rows.length ? 'ok' : 'ok_zero_results', http: res.status };
  } catch {
    return { records: [], status: 'fetch_failed', http: null };
  }
}

function utcDayRange(date = new Date()) {
  const d = new Date(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function canUseNewsDataToday(client) {
  const apiKey = String(process.env.NEWSDATA_API_KEY || '').trim();
  if (!apiKey) return false;

  // NewsData free tier is typically 200 credits/day.
  const limit = Math.max(0, Number(process.env.NEWSDATA_DAILY_CALL_LIMIT || 120));
  if (!Number.isFinite(limit) || limit <= 0) return false;

  const { start, end } = utcDayRange();
  const { count, error } = await client
    .from('ingest_runs')
    .select('id', { count: 'exact', head: true })
    .gte('run_at', start)
    .lt('run_at', end);

  if (error) return true;
  const callsToday = Number(count || 0);
  return callsToday < limit;
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

function bumpDrop(dropCounters, key) {
  if (!dropCounters) return;
  dropCounters[key] = Number(dropCounters[key] || 0) + 1;
}

async function normalize(client, article, index, dropCounters = null) {
  const title = (article.title || '').trim();
  const sourceType = article.source_type || 'news';
  const isFactcheck = sourceType === 'factcheck';
  const trustedDomains = [
    'bellingcat.com',
    'dfrlab.org',
    'euvsdisinfo.eu',
    'snopes.com',
    'politifact.com',
    'fullfact.org',
    'bleepingcomputer.com',
    'krebsonsecurity.com',
    '404media.co',
    'therecord.media',
    'wired.com',
    'arstechnica.com',
    'theverge.com',
    'technologyreview.com',
    'ftc.gov',
    'justice.gov',
    'ncsc.gov.uk',
  ];
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
    bumpDrop(dropCounters, 'dropped_low_value_guide');
    return null;
  }
  if (shouldExcludeDomain(article.domain)) {
    bumpDrop(dropCounters, 'dropped_excluded_domain');
    return null;
  }
  if (isExcludedByTitle(title)) {
    bumpDrop(dropCounters, 'dropped_excluded_title');
    return null;
  }
  const fullText = `${title} ${description} ${article.url || ''}`;
  const isTrustedSource = trustedDomains.some((d) => String(article.domain || '').toLowerCase().includes(d));
  const trustedSignalPass = isTrustedSource && hasStrongDeepfakeSignal(fullText);
  const factcheckCandidate =
    isFactcheck && (deepfakeRelevanceScore(title, description) >= 1 || hasStrongDeepfakeSignal(fullText));
  if (!trustedSignalPass && !isFactcheck && !isDeepfakeRelevant(fullText)) {
    bumpDrop(dropCounters, 'dropped_not_deepfake_relevant');
    return null;
  }
  if (!trustedSignalPass && isFactcheck && !factcheckCandidate) {
    bumpDrop(dropCounters, 'dropped_factcheck_candidate');
    return null;
  }
  if (!trustedSignalPass && !passesStrictRelevance(article, title, description)) {
    bumpDrop(dropCounters, 'dropped_strict_relevance');
    return null;
  }
  const incidentCandidate = isIncidentCandidate(article, title, description);
  // Fact-check sources are already curated; avoid over-pruning due to softer wording.
  if (!trustedSignalPass && isFactcheck && deepfakeRelevanceScore(title, description) < 1) {
    bumpDrop(dropCounters, 'dropped_factcheck_relevance_floor');
    return null;
  }
  if (!trustedSignalPass && !isFactcheck && isContextOnlyArticle(`${title} ${description} ${article.url || ''}`)) {
    bumpDrop(dropCounters, 'dropped_context_only');
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
  if (isHomepageLikeUrl(articleUrl) && !isFactcheck) {
    // Skip low-quality homepage links for generic news, but allow curated fact-check feeds.
    bumpDrop(dropCounters, 'dropped_homepage_news_url');
    return null;
  }
  const image = await resolveImage(article, { client });
  const imageUrl = image.url;
  const publishedAt = parseSeenDate(article.seendate);
  const reportedPlatforms = detectReportedPlatforms(`${title} ${description} ${articleUrl || ''}`);
  const reportedOn = reportedPlatforms.length ? reportedPlatforms.join(',') : null;
  const modalities = deriveModalities(`${title} ${description}`);
  const tags = deriveTags(`${title} ${description}`);

  // Hard guard: never persist incidents without a resolvable article/claim URL.
  if (!String(articleUrl || '').trim() && !String(claimUrl || '').trim()) {
    bumpDrop(dropCounters, 'dropped_link_guard');
    return null;
  }

  let providerScores = [];
  if (index < config.detectionMaxItems) {
    providerScores = await scoreWithProviders(article);
  }

  const blended = blendConfidence(classified.score, providerScores);
  const adjustedConfidence = (!isFactcheck && !incidentCandidate)
    ? Math.max(0.25, Number(blended.confidence || 0) * 0.85)
    : Number(blended.confidence || 0);

  return {
    source_id: articleUrl || `${sourceDomain}:${title}`,
    title: title || 'Untitled incident',
    summary: description,
    category: classified.type,
    category_label: classified.label,
    confidence: Number(adjustedConfidence.toFixed(2)),
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

function balanceIncidentsBySourceType(incidents) {
  const list = Array.isArray(incidents) ? incidents : [];
  if (!list.length) return [];

  const maxFactcheckShareRaw = Number(process.env.MAX_FACTCHECK_SHARE || 0.4);
  const maxFactcheckShare = Number.isFinite(maxFactcheckShareRaw)
    ? Math.min(0.8, Math.max(0.2, maxFactcheckShareRaw))
    : 0.4;
  const minFactcheckWhenNoNewsRaw = Number(process.env.MIN_FACTCHECK_WHEN_NO_NEWS || 24);
  const minFactcheckWhenNoNews = Number.isFinite(minFactcheckWhenNoNewsRaw)
    ? Math.max(0, Math.floor(minFactcheckWhenNoNewsRaw))
    : 24;

  const news = list.filter((i) => String(i.source_type || '').toLowerCase() === 'news');
  const social = list.filter((i) => String(i.source_type || '').toLowerCase() === 'social_report');
  const factcheck = list.filter((i) => String(i.source_type || '').toLowerCase() === 'factcheck');
  const other = list.filter((i) => !['news', 'social_report', 'factcheck'].includes(String(i.source_type || '').toLowerCase()));

  const required = [...news, ...social, ...other];

  const factcheckScore = (row) => {
    const confidence = Number(row.confidence) || 0;
    const documented = String(row.image_type || '').toLowerCase() === 'documented' ? 1 : 0;
    const hasLink = String(row.article_url || row.claim_url || '').trim() ? 1 : 0;
    const published = new Date(row.published_at || 0).getTime() || 0;
    return (documented * 1000) + (hasLink * 500) + Math.round(confidence * 100) + Math.round(published / 1e10);
  };

  const rankedFactcheck = [...factcheck].sort((a, b) => factcheckScore(b) - factcheckScore(a));

  let factcheckCap = 0;
  if (required.length === 0) {
    factcheckCap = minFactcheckWhenNoNews;
  } else {
    factcheckCap = Math.floor((maxFactcheckShare / (1 - maxFactcheckShare)) * required.length);
  }
  const selectedFactcheck = rankedFactcheck.slice(0, Math.max(0, factcheckCap));

  const balanced = [...required, ...selectedFactcheck].sort(
    (a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime()
  );
  return balanced;
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
    let newsDataRaw = [];
    let newsDataStatus = 'disabled';
    let newsDataHttp = null;
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
    try {
      const allowNewsData = await canUseNewsDataToday(client);
      if (allowNewsData) {
        const newsDataResult = await fetchNewsDataArticles();
        newsDataRaw = Array.isArray(newsDataResult?.records) ? newsDataResult.records : [];
        newsDataStatus = String(newsDataResult?.status || 'unknown');
        newsDataHttp = newsDataResult?.http ?? null;
      } else if (String(process.env.NEWSDATA_API_KEY || '').trim()) {
        newsDataRaw = [];
        newsDataStatus = 'daily_cap_reached';
        warnings.push('NewsData quota cap reached for today; skipped.');
      }
    } catch {
      newsDataRaw = [];
      newsDataStatus = 'fetch_failed';
      newsDataHttp = null;
      warnings.push('NewsData fetch failed; continuing with remaining sources.');
    }
    const mergedRaw = [...raw, ...rssRaw, ...newsDataRaw, ...redditRaw];
    const dropCounters = {};
    const normalized = await Promise.all(mergedRaw.map((item, idx) => normalize(client, item, idx, dropCounters)));
    const normalizedKept = normalized.filter(Boolean);
    const deduped = dedupeIncidents(normalizedKept);
    const incidents = balanceIncidentsBySourceType(deduped);
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
      normalized_kept: normalizedKept.length,
      normalized_dropped: mergedRaw.length - normalizedKept.length,
      deduped: deduped.length,
      balanced: incidents.length,
      upserted: result.inserted,
      fetched_gdelt: raw.length,
      fetched_rss: rssRaw.length,
      fetched_rss_feeds: rssFeedCount,
      fetched_newsdata: newsDataRaw.length,
      newsdata_status: newsDataStatus,
      newsdata_http: newsDataHttp,
      fetched_reddit: redditRaw.length,
      reddit_statuses: redditStatuses,
      context_fetched: rawContext.length,
      context_upserted: contextResult.inserted,
      archived_events_logged: eventsResult.inserted || 0,
      dropped: dropCounters,
      warning: warnings.length ? warnings.join(' ') : null,
      at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
