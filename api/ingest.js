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
const { resolveImageUrl } = require('../lib/placeholders');
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
  return /(deepfake|deep fake|voice clone|cloned voice|face swap|fake audio|fake video|ai porn|non-consensual|synthetic media)/i.test(
    String(text || '')
  );
}

function passesStrictRelevance(article, title, description) {
  const sourceType = article.source_type || 'news';
  const full = `${title} ${description} ${article.url || ''}`;
  const titleSignal = hasStrongDeepfakeSignal(title);
  const fullSignal = hasStrongDeepfakeSignal(full);

  // Never ingest if no strong deepfake signal exists anywhere.
  if (!titleSignal && !fullSignal) return false;

  // Opinion/editorial pieces must still be explicit in title to avoid generic policy content.
  if (/(opinion|editorial|analysis)/i.test(title) && !titleSignal) return false;

  // Raise quality bar globally to reduce false positives.
  if (deepfakeRelevanceScore(title, description) < 3) return false;

  // News sources require explicit title signal.
  if (sourceType === 'news' && !titleSignal) return false;

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

function dedupeIncidents(items) {
  const unique = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  for (const item of items) {
    const canonicalUrl = canonicalizeUrl(item.article_url);
    const cleanTitle = String(item.title || '')
      .toLowerCase()
      .replace(/[\|\-:]\s*(bbc|cnn|reuters|ap|associated press|news|live updates?).*$/i, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const keyTitle = cleanTitle.split(' ').slice(0, 14).join(' ');
    if (canonicalUrl && seenUrl.has(canonicalUrl)) continue;
    if (keyTitle && seenTitle.has(keyTitle)) continue;
    if (canonicalUrl) seenUrl.add(canonicalUrl);
    if (keyTitle) seenTitle.add(keyTitle);
    unique.push({ ...item, article_url: canonicalUrl || item.article_url });
  }
  return unique;
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
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const links = Array.from(block.matchAll(/https?:\/\/[^\s"'<>]+/gi)).map((m) => m[0]);
    items.push({
      title: matchTag(block, 'title'),
      description: matchTag(block, 'description'),
      link: matchTag(block, 'link'),
      pubDate: matchTag(block, 'pubDate') || matchTag(block, 'dc:date'),
      links,
    });
  }
  const entryBlocks = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of entryBlocks) {
    const links = Array.from(block.matchAll(/https?:\/\/[^\s"'<>]+/gi)).map((m) => m[0]);
    items.push({
      title: matchTag(block, 'title'),
      description: matchTag(block, 'summary') || matchTag(block, 'content'),
      link: matchAttrTag(block, 'link', 'href') || matchTag(block, 'id'),
      pubDate: matchTag(block, 'updated') || matchTag(block, 'published'),
      links,
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

async function fetchRssArticles() {
  const feeds = splitCsv(config.rssFeeds);
  const records = [];
  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, { headers: { 'user-agent': 'deepfake-record/1.0' } });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseRssItems(xml).slice(0, config.rssMaxItemsPerFeed);
      for (const item of parsed) {
        const canonicalLink = canonicalizeUrl(item.link);
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
          socialimage: null,
          description: item.description || '',
          source_type: 'factcheck',
          claim_url: pickClaimUrl(item.links || []),
        });
      }
    } catch {
      // Skip failed feed and continue.
    }
  }
  return records;
}

async function fetchRedditArticles() {
  const subs = splitCsv(config.redditSubreddits);
  const records = [];
  for (const sub of subs) {
    const searchUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json?restrict_sr=1&sort=new&limit=${config.redditMaxItemsPerSubreddit}&q=${encodeURIComponent(config.redditQuery)}`;
    const newUrl = `https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=${config.redditMaxItemsPerSubreddit}`;
    try {
      let children = [];
      const searchRes = await fetch(searchUrl, { headers: { 'user-agent': 'deepfake-record/1.0 (+contact: deepfake-record)' } });
      if (searchRes.ok) {
        const searchJson = await searchRes.json();
        children = searchJson?.data?.children || [];
      }
      if (children.length === 0) {
        const newRes = await fetch(newUrl, { headers: { 'user-agent': 'deepfake-record/1.0 (+contact: deepfake-record)' } });
        if (!newRes.ok) continue;
        const newJson = await newRes.json();
        const raw = newJson?.data?.children || [];
        const q = String(config.redditQuery || '').toLowerCase();
        const needles = q.replace(/[()"]/g, '').split(/\s+or\s+/i).map((s) => s.trim()).filter(Boolean);
        children = raw.filter((it) => {
          const d = it?.data || {};
          const hay = `${d.title || ''} ${d.selftext || ''} ${d.url || ''}`.toLowerCase();
          return needles.some((n) => hay.includes(n.toLowerCase()));
        });
      }

      for (const item of children) {
        const post = item?.data || {};
        const articleUrl = post.url_overridden_by_dest || post.url || `https://www.reddit.com${post.permalink || ''}`;
        records.push({
          title: post.title || '',
          url: articleUrl,
          seendate: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
          domain: post.domain || 'reddit.com',
          sourcecountry: null,
          language: 'en',
          socialimage: post.thumbnail && /^https?:\/\//.test(post.thumbnail) ? post.thumbnail : null,
          description: post.selftext || '',
          source_type: 'social_report',
          reddit_permalink: post.permalink ? `https://www.reddit.com${post.permalink}` : null,
          claim_url: canonicalizeUrl(articleUrl),
        });
      }
    } catch {
      // Skip failed subreddit and continue.
    }
  }
  return records;
}

async function fetchGdeltByQuery(query, maxrecords) {
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    maxrecords: String(maxrecords),
    format: 'json',
    sort: 'datedesc',
  });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, { headers: { 'user-agent': 'deepfake-record/1.0' } });
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
    if (res.status === 429 && attempt < 2) {
      await sleep(6000 * (attempt + 1));
      continue;
    }

    throw new Error(`GDELT request failed (${res.status}): ${body.slice(0, 300)}`);
  }
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

async function normalize(article, index) {
  const title = (article.title || '').trim();
  const description =
    article.description ||
    (article.seendate ? `Seen ${article.seendate}` : '') + (article.sourcecountry ? ` · ${article.sourcecountry}` : '');
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
  if (!isIncidentCandidate(article, title, description)) {
    return null;
  }
  // Tighten generic news intake to avoid unrelated AI/culture stories.
  if ((article.source_type || 'news') === 'news' && !isTitleDeepfakeSpecific(title)) {
    return null;
  }
  if (isContextOnlyArticle(`${title} ${description} ${article.url || ''}`)) {
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
  const articleUrl = article.url || null;
  const imageUrl = article.socialimage || article.image_url || null;
  const publishedAt = parseSeenDate(article.seendate);
  const sourceType = article.source_type || 'news';
  const claimUrl = article.claim_url || null;
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
    image_type: 'documented',
    rights_status: article.socialimage ? 'link_only' : 'unknown',
    usage_note: article.socialimage ? 'Editorial thumbnail from reporting source.' : 'No source image provided in reporting.',
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

module.exports = async (_req, res) => {
  try {
    const client = getServiceClient();
    let raw = [];
    let warning = null;
    try {
      raw = await fetchGdelt();
    } catch (err) {
      if (String(err.message || '').includes('GDELT request failed (429)')) {
        warning = 'Primary GDELT feed rate-limited; run skipped safely.';
        raw = [];
      } else {
        throw err;
      }
    }
    const rawContext = await fetchGdeltContext();
    const rssRaw = await fetchRssArticles();
    const redditRaw = await fetchRedditArticles();
    const mergedRaw = [...raw, ...rssRaw, ...redditRaw];
    const normalized = await Promise.all(mergedRaw.map((item, idx) => normalize(item, idx)));
    const incidents = dedupeIncidents(normalized.filter(Boolean));
    const contextArticles = rawContext.map((article) => {
      const title = (article.title || '').trim();
      const sourceDomain = article.domain || 'unknown';
      const articleUrl = article.url || null;
      const publishedAt = parseSeenDate(article.seendate);
      const topic = classifyContextTopic(`${title} ${sourceDomain}`);
      return {
        source_id: articleUrl || `${sourceDomain}:${title}`,
        title: title || 'Untitled context article',
        summary:
          (article.seendate ? `Seen ${article.seendate}` : '') +
          (article.sourcecountry ? ` · ${article.sourcecountry}` : ''),
        topic_label: topic,
        source_domain: sourceDomain,
        article_url: articleUrl,
        image_url: resolveImageUrl(article),
        published_at: publishedAt,
      };
    });
    const result = await upsertIncidents(client, incidents);
    const contextResult = await upsertContextArticles(client, contextArticles);
    await logIngestRun(client, mergedRaw.length, result.inserted);
    res.status(200).json({
      ok: true,
      fetched: mergedRaw.length,
      deduped: incidents.length,
      upserted: result.inserted,
      fetched_gdelt: raw.length,
      fetched_rss: rssRaw.length,
      fetched_reddit: redditRaw.length,
      context_fetched: rawContext.length,
      context_upserted: contextResult.inserted,
      warning,
      at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
