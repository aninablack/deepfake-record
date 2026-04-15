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
  const staticDrops =
    /(fortnite|gaming skin|battle pass|haskell for all|agentic coding spec|iphone bug|nvidia dlss|meme backlash|fragility of truth|sora video|shutting down sora|openai shutting|war\s*,)/.test(t);
  const productShutdownNews =
    /\bshutting down\b/.test(t) &&
    /\b(product|feature|tool|app|service|model|platform|sora|chatgpt|gemini|copilot)\b/.test(t);
  return staticDrops || productShutdownNews;
}

function isGeneralAiBusinessNews(title, description) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  return /\b(earnings|revenue|valuation|funding|investment|market share|strategy|roadmap|product update|feature update|rollout|launch|announced|announcement|business model|quarterly|stock|shares|partnership)\b/.test(
    text
  );
}

function hasNamedVictimOrSpecificTarget(text) {
  const value = String(text || '');
  const explicitTargetTerms =
    /\b(victim|victims|targeted|employee|students?|teachers?|journalists?|candidate|politician|minister|prime minister|president|ceo|bank|company|school|hospital|child|minor|individual|person|woman|man)\b/i;
  const likelyNamedEntity = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}\b/.test(value);
  return explicitTargetTerms.test(value) || likelyNamedEntity;
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

const specialistSources = [
  'bellingcat.com', 'dfrlab.org', 'bbcverify', 'leadstories.com',
  'fullfact.org', 'politifact.com', '404media.co', 'therecord.media',
  'cyberscoop.com', 'darkreading.com', 'propublica.org',
  'theintercept.com', 'restofworld.org', 'krebsonsecurity.com'
];

const generalNewsSources = [
  'bbc.com', 'bbc.co.uk', 'aljazeera.com', 'independent.co.uk',
  'nbcnews.com', 'abcnews.go.com', 'thehill.com', 'axios.com',
  'wired.com', 'theguardian.com', 'dw.com', 'france24.com',
  'npr.org', 'techcrunch.com', 'theverge.com', 'arstechnica.com'
];

const highNoiseFeeds = [
  'feeds.bbci.co.uk/news/rss.xml',
  'feeds.bbci.co.uk/news/world/rss.xml',
  'feeds.bbci.co.uk/news/uk/rss.xml',
  'www.axios.com/feeds/feed.rss',
  'thehill.com/feed/',
  'abcnews.go.com/abcnews/topstories',
  'feeds.nbcnews.com/nbcnews/public/news',
  'rss.dw.com/rdf/rss-en-all',
  'www.france24.com/en/rss',
  'www.aljazeera.com/xml/rss/all.xml',
  'feeds.npr.org/1001/rss.xml',
  'www.independent.co.uk/news/uk/rss',
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
  const relevance = deepfakeRelevanceScore(title, description, article.domain || article.source_domain || article.url || '');
  // Must have at least one deepfake signal somewhere.
  if (!titleSignal && !fullSignal && relevance < 1) return false;

  // Opinion/editorial without explicit title signal is usually context noise.
  if (/(opinion|editorial)/i.test(title) && !titleSignal) return false;

  return true;
}

function sourceText(article) {
  return [
    article.domain || '',
    article.source_domain || '',
    article.url || '',
    article.article_url || '',
  ]
    .join(' ')
    .toLowerCase();
}

function inSourceList(source, list) {
  return list.some((d) => source.includes(String(d).toLowerCase()));
}

function hasGeneralNewsStrongDeepfakeKeyword(text) {
  return /\b(deepfake|voice clone|synthetic media|fake video|fake image|fake nude|fake porn|ai-generated image|ai-generated video|non-consensual imagery|manipulated video|face swap|impersonation scam|digital replica|cloned voice|fake audio|sexual deepfake|ai disinformation|synthetic video|forged video|fabricated video|ai manipulation|ai-powered scam|generative ai fraud|ai impersonation)\b/i.test(
    String(text || '')
  );
}

function passesTwoTierRelevance(article, title, summary, bodyText, sourceHint) {
  const source = sourceText(article);
  const titleSummaryText = `${title || ''} ${summary || ''}`.trim();
  const titleSummaryScore = deepfakeRelevanceScore(
    title,
    summary,
    sourceHint || source
  );
  const anywhereScore = deepfakeRelevanceScore(
    title,
    `${summary || ''} ${bodyText || ''}`.trim(),
    sourceHint || source
  );

  if (inSourceList(source, specialistSources)) {
    return anywhereScore >= 1;
  }
  if (inSourceList(source, generalNewsSources)) {
    return (
      titleSummaryScore >= 1 &&
      hasGeneralNewsStrongDeepfakeKeyword(titleSummaryText)
    );
  }
  return titleSummaryScore >= 2;
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

async function fetchArticleBodySnippet(url, timeoutMs = 5000, fallbackText = '', maxChars = 2000) {
  const input = canonicalizeUrl(url);
  if (!input || !/^https?:\/\//i.test(input)) return String(fallbackText || '').slice(0, maxChars);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, {
      headers: rssFetchHeaders(),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return String(fallbackText || '').slice(0, maxChars);
    const html = await res.text();
    const articleChunk =
      html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
      html.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
      html;
    const text = stripHtml(
      String(articleChunk || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return String(fallbackText || '').slice(0, maxChars);
    return text.slice(0, maxChars);
  } catch {
    return String(fallbackText || '').slice(0, maxChars);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * dedupeByStoryCluster — second-pass deduplication that collapses multiple outlets
 * covering the same real-world incident into a curated set of representatives.
 *
 * How it works:
 *   1. Tokenises each incident title into meaningful 5+ char words (stop-words and
 *      generic deepfake terms excluded).
 *   2. Clusters incidents whose token sets share ≥ 2 words AND whose publish dates
 *      fall within STORY_CLUSTER_WINDOW_DAYS (default 3) of each other AND share
 *      the same category.
 *   3. Keeps up to STORY_CLUSTER_MAX (default 2) incidents per cluster, chosen for
 *      SOURCE DIVERSITY: ideally one specialist/fact-checker and one general-news
 *      outlet, so each story gets both authority and breadth without flooding the
 *      feed with 8 articles on the same event.
 *
 * Env vars:
 *   STORY_CLUSTER_MAX          — max articles per story cluster (default 2)
 *   STORY_CLUSTER_WINDOW_DAYS  — day window for clustering same story (default 3)
 *
 * Set STORY_CLUSTER_MAX=0 to disable entirely.
 */
function dedupeByStoryCluster(incidents) {
  const maxPerCluster = Number(
    process.env.STORY_CLUSTER_MAX != null ? process.env.STORY_CLUSTER_MAX : 4
  );
  const windowDays = Number(process.env.STORY_CLUSTER_WINDOW_DAYS || 3);

  if (!Array.isArray(incidents) || incidents.length === 0) return incidents;
  if (!Number.isFinite(maxPerCluster) || maxPerCluster <= 0) return incidents; // disabled

  // Words present in nearly every deepfake article — excluded from cluster matching
  const STOP = new Set([
    'the','and','or','but','for','nor','yet','in','on','at','to','of','by','as',
    'is','are','was','were','been','be','have','has','had','will','would','could',
    'should','may','might','can','do','does','did','not','its','their','his','her',
    'this','that','with','from','about','over','under','after','before','which',
    'while','since','until','than','then','when','where','what','who','how','why',
    'into','onto','upon','says','said','show','shows','report','reports','warns',
    'urges','calls','claim','claims','slams','flags','denies','comes','amid',
    'against','using','first','last','more','most','also','just','only','even',
    'still','latest','viral','alert','breaking','accused',
    // Generic deepfake/AI terms present in almost every title
    'deepfake','deepfakes','fake','real','video','videos','image','images','audio',
    'media','online','generated','content','artificial','intelligence','synthetic',
    'check','fact',
  ]);

  const MIN_OVERLAP = 2;
  const MIN_LEN = 5;
  const maxWindowMs = windowDays * 24 * 60 * 60 * 1000;

  function tokenize(title) {
    return String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= MIN_LEN && !STOP.has(w));
  }

  // Quality score for a single item — higher = keep this one
  function scoreItem(item) {
    let s = 0;
    const sp = String(item?.source_priority || '').toLowerCase();
    if (sp === 'factchecker') s += 100;
    else if (sp === 'major_outlet') s += 50;
    if (String(item?.image_type || '').toLowerCase() === 'documented') s += 25;
    s += Math.round((Number(item?.confidence) || 0) * 20);
    const st = String(item?.source_type || '').toLowerCase();
    if (st === 'factcheck') s += 15;
    else if (st === 'news') s += 5;
    return s;
  }

  // Tier for source diversity picking: 0 = specialist/factcheck, 1 = general news, 2 = other
  function sourceTier(item) {
    const sp = String(item?.source_priority || '').toLowerCase();
    const st = String(item?.source_type || '').toLowerCase();
    if (sp === 'factchecker' || st === 'factcheck') return 0;
    if (sp === 'major_outlet') return 1;
    if (st === 'news') return 2;
    return 3;
  }

  /**
   * Pick up to `n` items from a cluster, prioritising source diversity.
   * Strategy: take the best item from each source tier in order, filling
   * remaining slots with the next-best overall. This ensures e.g. a fact-check
   * source and a general news source appear together rather than two identical
   * general-news articles.
   */
  function pickDiverse(items, n) {
    if (items.length <= n) return items;
    const sorted = [...items].sort((a, b) => scoreItem(b) - scoreItem(a));
    if (n === 1) return [sorted[0]];

    const picked = [];
    const used = new Set();

    // First pass: one best item per tier
    for (let tier = 0; tier <= 3 && picked.length < n; tier++) {
      const candidate = sorted.find(
        (item, idx) => sourceTier(item) === tier && !used.has(idx)
      );
      if (candidate) {
        used.add(sorted.indexOf(candidate));
        picked.push(candidate);
      }
    }

    // Second pass: fill remaining slots with next-best overall
    for (let i = 0; i < sorted.length && picked.length < n; i++) {
      if (!used.has(i)) {
        picked.push(sorted[i]);
        used.add(i);
      }
    }

    return picked;
  }

  // Clusters: { items, tokenPool, minMs, maxMs, category }
  const clusters = [];

  for (const incident of incidents) {
    const tokens = tokenize(incident.title);
    const publishedMs = new Date(incident.published_at || 0).getTime();
    const category = String(incident.category || '').toLowerCase();

    let bestCluster = null;
    let bestOverlap = MIN_OVERLAP - 1;

    for (const cluster of clusters) {
      if (cluster.category !== category) continue;
      if (publishedMs < cluster.minMs - maxWindowMs || publishedMs > cluster.maxMs + maxWindowMs) continue;
      const overlap = tokens.filter(t => cluster.tokenPool.has(t)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      bestCluster.items.push(incident);
      for (const t of tokens) bestCluster.tokenPool.add(t);
      bestCluster.minMs = Math.min(bestCluster.minMs, publishedMs);
      bestCluster.maxMs = Math.max(bestCluster.maxMs, publishedMs);
    } else {
      clusters.push({
        items: [incident],
        tokenPool: new Set(tokens),
        minMs: publishedMs,
        maxMs: publishedMs,
        category,
      });
    }
  }

  const result = [];
  for (const cluster of clusters) {
    result.push(...pickDiverse(cluster.items, maxPerCluster));
  }

  return result.sort(
    (a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime()
  );
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

async function fetchRssArticles(options = {}) {
  const skipFeeds = Array.isArray(options.skipFeeds) ? options.skipFeeds : [];
  const shouldSkip = (feedUrl) =>
    skipFeeds.some((needle) =>
      String(feedUrl || '').toLowerCase().includes(String(needle || '').toLowerCase())
    );
  const allFeeds = rotateFeedsForRun(splitCsv(config.rssFeeds));
  const feeds = allFeeds.filter((feedUrl) => !shouldSkip(feedUrl));
  const records = [];
  const feedStats = [];
  for (const feedUrl of feeds) {
    let status = 'error';
    let http = null;
    let fetchedItems = 0;
    try {
      const res = await fetch(feedUrl, { headers: rssFetchHeaders() });
      http = res.status;
      if (!res.ok) {
        status = 'http_error';
        feedStats.push({ feed: feedUrl, status, http, fetched_items: 0 });
        continue;
      }
      const xml = await res.text();
      const parsed = parseRssItems(xml).slice(0, config.rssMaxItemsPerFeed);
      fetchedItems = parsed.length;
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
          ingest_source: 'rss',
        });
      }
      status = 'ok';
      feedStats.push({ feed: feedUrl, status, http, fetched_items: fetchedItems });
    } catch {
      feedStats.push({ feed: feedUrl, status, http, fetched_items: 0 });
    }
  }
  return {
    records,
    feed_count: feeds.length,
    feed_stats: feedStats,
    skipped_feeds_count: allFeeds.length - feeds.length,
  };
}

function mapNewsDataRows(rows) {
  return rows.map((item) => {
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
      ingest_source: 'newsdata',
    };
  });
}

async function fetchNewsDataArticles(queryOverride = null, sizeOverride = null) {
  const apiKey = String(process.env.NEWSDATA_API_KEY || '').trim();
  if (!apiKey) return { records: [], status: 'missing_key', http: null };

  const rawQuery =
    String(queryOverride || process.env.NEWSDATA_QUERY || '').trim() ||
    'deepfake OR "voice clone" OR "synthetic media" OR "AI impersonation"';
  const query = rawQuery.replace(/^\((.*)\)$/s, '$1').trim();
  // Free tier supports up to 10 articles per request; enforce hard cap to avoid 422.
  const size = Math.max(1, Math.min(Number(sizeOverride || process.env.NEWSDATA_MAX_RECORDS || 10), 10));
  const endpoint = String(process.env.NEWSDATA_ENDPOINT || 'latest').trim().toLowerCase();
  const endpointPath = endpoint === 'news' ? 'news' : 'latest';
  const buildUrl = ({ q, includeLanguage = true }) => {
    const u = new URL(`https://newsdata.io/api/1/${endpointPath}`);
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
    if (!res.ok) {
      const body = await res.text();
      return { records: [], status: 'http_error', http: res.status, error: body.slice(0, 240) };
    }
    const json = await res.json();
    const rows = Array.isArray(json?.results) ? json.results : [];
    const records = mapNewsDataRows(rows);
    return { records, status: rows.length ? 'ok' : 'ok_zero_results', http: res.status, error: null };
  } catch {
    return { records: [], status: 'fetch_failed', http: null, error: null };
  }
}

async function fetchGoogleFactCheckArticles() {
  const apiKey = String(process.env.GOOGLE_FACTCHECK_API_KEY || '').trim();
  if (!apiKey) return { records: [], status: 'missing_key', http: null, error: null };

  const queries = ['deepfake', 'fake video', 'AI generated', 'synthetic media', 'voice clone'];
  const endpoint = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';
  const all = [];
  let status = 'ok';
  let http = 200;
  let error = null;

  for (const q of queries) {
    try {
      const url = new URL(endpoint);
      url.searchParams.set('query', q);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('pageSize', '10');
      const res = await fetch(url.toString(), {
        headers: {
          accept: 'application/json',
          'user-agent': 'deepfake-record/1.0 (+https://deepfake-record.vercel.app)',
        },
      });
      http = res.status;
      if (!res.ok) {
        const body = await res.text();
        status = 'http_error';
        error = body.slice(0, 240);
        continue;
      }
      const json = await res.json();
      const claims = Array.isArray(json?.claims) ? json.claims : [];
      for (const claim of claims) {
        const review = Array.isArray(claim?.claimReview) ? claim.claimReview[0] : null;
        const articleUrl = canonicalizeUrl(review?.url || '') || null;
        const sourceDomain = String(review?.publisher?.name || '').trim().toLowerCase() || 'factchecktools';
        const title = String(claim?.text || '').trim();
        if (!title) continue;
        all.push({
          title,
          url: articleUrl,
          seendate: claim?.claimDate || null,
          domain: sourceDomain,
          sourcecountry: null,
          language: 'en',
          socialimage: null,
          description: '',
          source_type: 'factcheck',
          source_priority_override: 'factchecker',
          claim_url: null,
          ingest_source: 'factcheck',
        });
      }
    } catch (e) {
      status = 'fetch_failed';
      error = String(e?.message || 'fetch failed');
    }
  }

  const seen = new Set();
  const records = all.filter((item) => {
    const key =
      canonicalizeUrl(item.url || '') ||
      `${String(item.domain || '').toLowerCase()}|${String(item.title || '').toLowerCase()}`;
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);

  if (status === 'ok' && records.length === 0) status = 'ok_zero_results';
  return { records, status, http, error };
}

function utcDayRange(date = new Date()) {
  const d = new Date(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}

function readHeader(req, name) {
  const value = req?.headers?.[name] || req?.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function hasValidIngestKey(req) {
  const expected = String(process.env.INGEST_SECRET || '').trim();
  if (!expected) return true;
  const fromHeader = readHeader(req, 'x-ingest-key').trim();
  const fromQuery = String(req?.query?.key || '').trim();
  const provided = fromHeader || fromQuery;
  return Boolean(provided) && provided === expected;
}

async function getIngestBudgetStatus(client) {
  const maxRunsPerDay = Math.max(1, Number(process.env.INGEST_MAX_RUNS_PER_DAY || 6));
  const cooldownMinutes = Math.max(1, Number(process.env.INGEST_COOLDOWN_MINUTES || 180));
  const cooldownMs = cooldownMinutes * 60 * 1000;
  const now = Date.now();

  const { start, end } = utcDayRange();
  const countRes = await client
    .from('ingest_runs')
    .select('id', { count: 'exact', head: true })
    .gte('run_at', start)
    .lt('run_at', end);

  const lastRunRes = await client
    .from('ingest_runs')
    .select('run_at')
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // If optional analytics table doesn't exist, do not block ingest.
  if (countRes.error || lastRunRes.error) {
    return { allowed: true, reason: null, telemetry_unavailable: true };
  }

  const runsToday = Number(countRes.count || 0);
  if (runsToday >= maxRunsPerDay) {
    return {
      allowed: false,
      reason: 'daily_run_budget_reached',
      runs_today: runsToday,
      max_runs_per_day: maxRunsPerDay,
      cooldown_minutes: cooldownMinutes,
    };
  }

  const lastRunAt = lastRunRes?.data?.run_at ? new Date(lastRunRes.data.run_at).getTime() : null;
  if (Number.isFinite(lastRunAt)) {
    const elapsedMs = now - lastRunAt;
    if (elapsedMs < cooldownMs) {
      return {
        allowed: false,
        reason: 'cooldown_active',
        runs_today: runsToday,
        max_runs_per_day: maxRunsPerDay,
        cooldown_minutes: cooldownMinutes,
        next_allowed_in_minutes: Math.ceil((cooldownMs - elapsedMs) / 60000),
      };
    }
  }

  return {
    allowed: true,
    reason: null,
    runs_today: runsToday,
    max_runs_per_day: maxRunsPerDay,
    cooldown_minutes: cooldownMinutes,
  };
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

function overrideCategoryByKeywords(title, description, currentType) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  const politicalPattern =
    /(election|vote|voting|government|minister|prime minister|parliament|senate|president|campaign|propaganda|state media|disinformation|russia|china|iran|military|councillor|governor|legislation|bill|law|congress|fbi|cia|police|court|judge|criminal|lawmaker|politician|policy|regulation|gov\s*\.?\s*shapiro|schools?)/i;
  const fraudPattern =
    /(scam|wire transfer|bank|phishing|financial|crypto|investment|impersonat|money|romance scam|security|ftc|doj|arrest|charged|lawsuit|sued|fraud|theft|extortion|identity theft|sexualized deepfake|sold fake|fake porn|pornograf|stupro digitale|virtual rape|personality rights misuse)/i;

  // Keep obvious fact-check exemplars in entertainment unless there is explicit
  // political/fraud language to avoid overfitting false positives.
  const entertainmentFactcheckPattern =
    /(fact check:|fake video shows|does not show|ai-generated\.)/i;

  if (fraudPattern.test(text)) return 'fraud';
  if (politicalPattern.test(text)) return 'political';
  if (entertainmentFactcheckPattern.test(text) && currentType === 'entertainment') return 'entertainment';
  return currentType;
}

async function normalize(client, article, index, dropCounters = null) {
  const title = (article.title || '').trim();
  if (/^(disinfo update|weekly update|newsletter|roundup|digest)\b/i.test(title)) {
    bumpDrop(dropCounters, 'dropped_generic_update_title');
    return null;
  }
  const lang = String(article.language || '').toLowerCase().trim();
  if (lang && !['en', 'english'].includes(lang)) {
    bumpDrop(dropCounters, 'dropped_non_english');
    return null;
  }
  const sourceType = article.source_type || 'news';
  const isFactcheck = sourceType === 'factcheck';
  const trustedDomains = [
    'bellingcat.com',
    'dfrlab.org',
    'disinfo.eu',
    'snopes.com',
    'politifact.com',
    'fullfact.org',
    'bleepingcomputer.com',
    'krebsonsecurity.com',
    '404media.co',
    'therecord.media',
    'cyberscoop.com',
    'propublica.org',
    'theintercept.com',
    'restofworld.org',
    'theguardian.com',
    'bbc.co.uk',
    'bbc.com',
    'wired.com',
    'arstechnica.com',
    'theverge.com',
    'techcrunch.com',
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
  const strongDeepfakeKeywordInTitle = hasStrongDeepfakeSignal(title);
  const strongIncidentSignal = /(victim|victimized|lawsuit|sued|arrest|charged|jailed|banned|ban|removed|takedown|scam|fraud|impersonation|child porn|non-consensual)/i.test(
    `${title} ${description}`
  );
  if (lowValueGuide && !strongIncidentSignal && !strongDeepfakeKeywordInTitle) {
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
  const sourceHint = `${article.domain || ''} ${article.source_domain || ''} ${article.url || ''} ${article.socialimage || ''} ${article.social_image || ''}`;
  const source = String(article.domain || '').toLowerCase();
  const trustedMatchText = [
    article.url || '',
    article.domain || '',
    article.source_domain || '',
    article.socialimage || '',
    article.social_image || '',
  ]
    .join(' ')
    .toLowerCase();
  const trustedAiRelaxDomains = [
    'bbc.co.uk',
    'bbc.com',
    'independent.co.uk',
    'theguardian.com',
    'aljazeera.com',
    'dw.com',
    'france24.com',
    'npr.org',
    'axios.com',
    'wired.com',
    'nbcnews.com',
    'abcnews.go.com',
    'thehill.com',
  ];
  const trustedDeepfakeSignal =
    /\b(deepfake|voice clone|fake video|synthetic media|ai-generated|ai generated)\b/i;
  const trustedAiAnchor = /\b(ai|artificial intelligence)\b/i;
  const trustedAiRisk =
    /\b(deepfake|synthetic media|fake video|fake image|voice clone|ai-generated|manipulated video|disinformation|misinformation|fabricated|non-consensual|impersonation|forged|smear|cameo|influence operation|information operation|state media|propaganda|disinformation video|coordinated campaign|foreign interference|russian operation|iranian operation|chinese operation)\b/i;
  const trustedManipulationOnly =
    /\b(manipulated video|fabricated video|fake footage|forged video|edited video|altered video|doctored image|false video)\b/i;
  let relevanceSummary = description;
  const trustedTextBase = `${title} ${description} ${article.url || ''}`;
  const trustedAiRelaxDomain = trustedAiRelaxDomains.find((d) => trustedMatchText.includes(d));
  const baseRelevance = deepfakeRelevanceScore(title, description, sourceHint);
  if (article.ingest_source === 'rss' && trustedAiRelaxDomain && baseRelevance < 1) {
    const isBbcTrusted =
      /(bbc\.com|bbc\.co\.uk|bbci\.co\.uk)/i.test(trustedMatchText);
    const snippetChars = isBbcTrusted ? 5000 : 2000;
    const snippet = await fetchArticleBodySnippet(article.url, 5000, `${title} ${description}`, snippetChars);
    if (snippet) relevanceSummary = `${description} ${snippet}`.trim();
  }
  const trustedText = `${title} ${relevanceSummary} ${article.url || ''}`;
  const hasTrustedAiAnchor = trustedAiAnchor.test(trustedText);
  const hasTrustedAiRisk = trustedAiRisk.test(trustedText);
  const hasTrustedManipulationOnly = trustedManipulationOnly.test(trustedText);
  const trustedAiRelaxPass =
    Boolean(trustedAiRelaxDomain) &&
    (
      trustedDeepfakeSignal.test(trustedText) ||
      (hasTrustedAiAnchor && hasTrustedAiRisk) ||
      hasTrustedManipulationOnly
    );
  const fullText = `${title} ${relevanceSummary} ${article.url || ''}`;
  const relevanceScore = deepfakeRelevanceScore(title, relevanceSummary, sourceHint);
  const twoTierPass = passesTwoTierRelevance(article, title, description, relevanceSummary, sourceHint);
  if (!twoTierPass) {
    bumpDrop(dropCounters, 'dropped_not_deepfake_relevant');
    return null;
  }
  const factcheckCandidate =
    isFactcheck && (relevanceScore >= 1 || hasStrongDeepfakeSignal(fullText));
  if (isFactcheck && !factcheckCandidate) {
    bumpDrop(dropCounters, 'dropped_factcheck_candidate');
    return null;
  }
  if (!passesStrictRelevance(article, title, description)) {
    bumpDrop(dropCounters, 'dropped_strict_relevance');
    return null;
  }
  const incidentCandidate = isIncidentCandidate(article, title, relevanceSummary);
  const namedVictimOrTarget = hasNamedVictimOrSpecificTarget(`${title} ${relevanceSummary}`);
  const generalBusinessNews = isGeneralAiBusinessNews(title, relevanceSummary);
  if (!incidentCandidate && !namedVictimOrTarget && generalBusinessNews) {
    bumpDrop(dropCounters, 'dropped_general_ai_business_news');
    return null;
  }
  // Fact-check sources are already curated; avoid over-pruning due to softer wording.
  if (isFactcheck && relevanceScore < 1) {
    bumpDrop(dropCounters, 'dropped_factcheck_relevance_floor');
    return null;
  }
  if (!isFactcheck && isContextOnlyArticle(`${title} ${relevanceSummary} ${article.url || ''}`)) {
    bumpDrop(dropCounters, 'dropped_context_only');
    return null;
  }
  const classified = classifyIncident(`${title} ${relevanceSummary} ${article.domain || ''} ${article.language || ''}`);
  // Emergency runtime override for production incidents_category_check mismatches.
  if (process.env.FORCE_CATEGORY_FALLBACK === '1' && classified.type === 'entertainment') {
    classified.type = 'entertainment';
    classified.label = 'Entertainment';
  }
  const politicsHint = /(propaganda|government|minister|election|state media|campaign|parliament|senate|president)/i.test(`${title} ${relevanceSummary}`);
  if (politicsHint && classified.type === 'entertainment') {
    classified.type = 'political';
    classified.label = 'Political';
  }
  const overriddenType = overrideCategoryByKeywords(title, relevanceSummary, classified.type);
  if (overriddenType !== classified.type) {
    classified.type = overriddenType;
    classified.label = overriddenType === 'fraud' ? 'Fraud' : (overriddenType === 'political' ? 'Political' : classified.label);
  }
  const sourceDomain = article.domain || 'unknown';
  let articleUrl = canonicalizeUrl(article.url || '');
  const publishedAt = parseSeenDate(article.seendate);
  const articleAgeMs = Date.now() - new Date(publishedAt).getTime();
  const maxAgeMs = Math.max(1, Number(config.maxArticleAgeDays || 14)) * 24 * 60 * 60 * 1000;
  if (Number.isFinite(articleAgeMs) && articleAgeMs > maxAgeMs) {
    bumpDrop(dropCounters, 'dropped_too_old');
    return null;
  }
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
  // Never persist SVG data URIs — they're 2-4 KB per row and are the main
  // cause of Supabase Disk IO budget depletion. The frontend generates
  // category SVGs and Pollinations fallbacks client-side, so storing null
  // here is equivalent from the user's perspective.
  const imageUrl = (image.url && !image.url.startsWith('data:')) ? image.url : null;
  const reportedPlatforms = detectReportedPlatforms(`${title} ${relevanceSummary} ${articleUrl || ''}`);
  const reportedOn = reportedPlatforms.length ? reportedPlatforms.join(',') : null;
  const modalities = deriveModalities(`${title} ${relevanceSummary}`);
  const tags = deriveTags(`${title} ${relevanceSummary}`);

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
    summary: relevanceSummary,
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
    source_priority: article.source_priority_override || deriveSourcePriority(sourceDomain),
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

async function insertPendingOnly(client, incidents) {
  if (!Array.isArray(incidents) || incidents.length === 0) return { inserted: 0, skipped_existing: 0 };
  const keys = Array.from(new Set(incidents.map((i) => String(i.source_id || '').trim()).filter(Boolean)));
  const existing = new Set();
  const chunkSize = 200;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const { data, error } = await client.from('incidents').select('source_id').in('source_id', chunk);
    if (error) throw error;
    for (const row of (data || [])) {
      if (row?.source_id) existing.add(String(row.source_id));
    }
  }
  const toInsert = incidents.filter((i) => !existing.has(String(i.source_id || '')));
  if (!toInsert.length) return { inserted: 0, skipped_existing: incidents.length };
  const { error } = await client.from('incidents').insert(toInsert);
  if (error) throw error;
  return { inserted: toInsert.length, skipped_existing: incidents.length - toInsert.length };
}

function hasDeepfakeSignal(text) {
  return /(deepfake|deep fake|voice clone|cloned voice|vocal clone|synthetic voice|voice deepfake|audio deepfake|fake audio|fake video|face swap|synthetic media|ai impersonation|ai song|ai[- ]generated song|soundalike|mimic(?:ked|ry)? voice|ai porn|non-consensual|digital forgery|manipulated media)/i.test(
    String(text || '')
  );
}

function hasIncidentHarmSignal(text) {
  return /(victim|victimized|lawsuit|sued|arrest|charged|jailed|banned|ban|removed|takedown|scam|fraud|impersonation|child porn|non-consensual|abuse|harassment|extortion|identity theft|sexual(?:ized)? deepfake|revenge porn|illegal|criminal|court|judge|prosecutor|indicted|convicted)/i.test(
    String(text || '')
  );
}

function isGateSampleExcludedByStyle(item) {
  const title = String(item?.title || '').toLowerCase();
  const url = String(item?.article_url || '').toLowerCase();
  const hay = `${title} ${url}`;
  return (
    /\/opinion\/|\/analysis\/|\/explainer\/|\/features?\//.test(url) ||
    /\b(opinion|analysis|explainer|newsletter|digest|roundup)\b/.test(hay) ||
    /^how to\b/.test(title) ||
    /\bwelcome to\b/.test(title)
  );
}

function parseDomainSet(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function evaluateIngestGate({ fetched, normalizedKept, deduped, incidents }) {
  const minFetched = Math.max(1, Number(process.env.MIN_FETCHED_PER_INGEST || 300));
  const minNormalizedKept = Math.max(1, Number(process.env.MIN_NORMALIZED_KEPT_PER_INGEST || 15));
  const minDeduped = Math.max(1, Number(process.env.MIN_DEDUPED_PER_INGEST || 8));
  const freshnessWindowHours = Math.max(1, Number(process.env.FRESHNESS_WINDOW_HOURS || 24));
  const maxSampleOfftopic = Math.max(0, Number(process.env.MAX_SAMPLE_OFFTOPIC || 5));
  const nowMs = Date.now();
  const freshnessMs = freshnessWindowHours * 60 * 60 * 1000;
  const recentInBatch = (incidents || []).some((i) => {
    const t = new Date(i.published_at || 0).getTime();
    return Number.isFinite(t) && (nowMs - t) <= freshnessMs;
  });
  const sample = [...(incidents || [])]
    .sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime())
    .slice(0, 20);
  const excludedDomains = parseDomainSet(process.env.GATE_OFFTOPIC_EXCLUDED_DOMAINS || '');
  const sampleOfftopicRows = sample.filter((i) => {
    const sourceType = String(i.source_type || '').toLowerCase();
    if (sourceType === 'factcheck' || sourceType === 'social_report' || sourceType === 'community') return false;
    if (isGateSampleExcludedByStyle(i)) return false;
    const domain = String(i.source_domain || '').toLowerCase().trim();
    if (domain && excludedDomains.has(domain)) return false;
    const hay = `${i.title || ''} ${i.article_url || ''} ${i.claim_url || ''}`;
    if (hasDeepfakeSignal(hay)) return false;
    if (hasIncidentHarmSignal(hay)) return false;
    return true;
  });
  const sampleOfftopic = sampleOfftopicRows.length;
  const sampleOfftopicItems = sampleOfftopicRows.map((i) => ({
    title: i.title || null,
    source_type: i.source_type || null,
    source_domain: i.source_domain || null,
    article_url: i.article_url || null,
    claim_url: i.claim_url || null,
    published_at: i.published_at || null,
    reason: 'missing_deepfake_signal_in_title_or_url',
  }));

  const checks = {
    quantity_fetched: fetched >= minFetched,
    quantity_normalized: normalizedKept >= minNormalizedKept,
    quantity_deduped: deduped >= minDeduped,
    freshness_recent_incident: recentInBatch,
    quality_sample_offtopic: sampleOfftopic <= maxSampleOfftopic,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    pass: failed.length === 0,
    failed_checks: failed,
    thresholds: {
      min_fetched: minFetched,
      min_normalized_kept: minNormalizedKept,
      min_deduped: minDeduped,
      freshness_window_hours: freshnessWindowHours,
      max_sample_offtopic: maxSampleOfftopic,
    },
    metrics: {
      fetched,
      normalized_kept: normalizedKept,
      deduped,
      sample_size: sample.length,
      sample_offtopic: sampleOfftopic,
      recent_in_batch: recentInBatch,
      sample_offtopic_items: sampleOfftopicItems,
    },
  };
}

async function upsertContextArticles(client, articles) {
  if (articles.length === 0) return { inserted: 0 };
  const { error } = await client.from('context_articles').upsert(articles, { onConflict: 'source_id' });
  if (error) throw error;
  return { inserted: articles.length };
}

async function dedupeSimilarIncidents(client) {
  const { error } = await client.rpc('dedupe_similar_incidents');
  if (error) return { ok: false };
  return { ok: true };
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

module.exports = async (req, res) => {
  try {
    const client = getServiceClient();
    if (!hasValidIngestKey(req)) {
      return res.status(401).json({
        ok: false,
        error: 'unauthorized',
        reason: 'missing_or_invalid_ingest_key',
      });
    }

    const budget = await getIngestBudgetStatus(client);
    if (!budget.allowed) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        skip_reason: budget.reason,
        budget,
        at: new Date().toISOString(),
      });
    }

    let raw = [];
    const warnings = [];
    let gdeltPrimaryFailed = false;
    try {
      raw = await fetchGdelt();
    } catch (err) {
      gdeltPrimaryFailed = true;
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
    let rssFeedStats = [];
    let gdeltFailedFeedsSkipped = false;
    let newsDataRaw = [];
    let newsDataStatus = 'disabled';
    let newsDataHttp = null;
    let newsDataError = null;
    let factCheckRaw = [];
    let factCheckStatus = 'disabled';
    let factCheckHttp = null;
    let factCheckError = null;
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
      gdeltFailedFeedsSkipped = Boolean(gdeltPrimaryFailed);
      const rssResult = await fetchRssArticles({
        skipFeeds: gdeltPrimaryFailed ? highNoiseFeeds : [],
      });
      rssRaw = Array.isArray(rssResult?.records) ? rssResult.records : [];
      rssFeedCount = Number(rssResult?.feed_count || 0);
      rssFeedStats = Array.isArray(rssResult?.feed_stats) ? rssResult.feed_stats : [];
    } catch {
      rssRaw = [];
      rssFeedCount = 0;
      rssFeedStats = [];
      warnings.push('RSS fetch failed; continuing with remaining sources.');
    }
    try {
      const allowNewsData = await canUseNewsDataToday(client);
      if (allowNewsData) {
        const newsDataResult = await fetchNewsDataArticles();
        newsDataRaw = Array.isArray(newsDataResult?.records) ? newsDataResult.records : [];
        newsDataStatus = String(newsDataResult?.status || 'unknown');
        newsDataHttp = newsDataResult?.http ?? null;
        newsDataError = newsDataResult?.error || null;
        const targetedQueries = gdeltPrimaryFailed
          ? [
              'deepfake fraud',
              'fake video politics',
              'voice clone scam',
              'AI impersonation',
              'synthetic media incident',
              'deepfake disinformation',
              'fake nude images',
              'AI-generated fake',
              'deepfake arrest',
              'deepfake lawsuit',
              'deepfake election',
              'deepfake celebrity',
              'deepfake pornography',
              'voice cloning fraud',
              'AI manipulation campaign',
            ]
          : [
              'deepfake disinformation',
              'AI video manipulation',
              'synthetic media incident',
            ];
        const configuredCap = Math.max(0, Number(process.env.NEWSDATA_TARGETED_QUERY_CAP || 1));
        const queryCap = Math.min(gdeltPrimaryFailed ? 8 : 2, configuredCap);
        for (const q of targetedQueries.slice(0, queryCap)) {
          try {
            const targeted = await fetchNewsDataArticles(q, 5);
            if (Array.isArray(targeted?.records) && targeted.records.length) {
              newsDataRaw.push(...targeted.records);
            }
          } catch {
            // best-effort targeted search
          }
        }
        const seenNewsData = new Set();
        newsDataRaw = newsDataRaw.filter((item) => {
          const key = canonicalizeUrl(item.url || '') || `${item.domain || ''}|${(item.title || '').toLowerCase()}`;
          if (!key) return false;
          if (seenNewsData.has(key)) return false;
          seenNewsData.add(key);
          return true;
        });
      } else if (String(process.env.NEWSDATA_API_KEY || '').trim()) {
        newsDataRaw = [];
        newsDataStatus = 'daily_cap_reached';
        warnings.push('NewsData quota cap reached for today; skipped.');
      }
    } catch {
      newsDataRaw = [];
      newsDataStatus = 'fetch_failed';
      newsDataHttp = null;
      newsDataError = null;
      warnings.push('NewsData fetch failed; continuing with remaining sources.');
    }
    try {
      const factCheckResult = await fetchGoogleFactCheckArticles();
      factCheckRaw = Array.isArray(factCheckResult?.records) ? factCheckResult.records : [];
      factCheckStatus = String(factCheckResult?.status || 'unknown');
      factCheckHttp = factCheckResult?.http ?? null;
      factCheckError = factCheckResult?.error || null;
    } catch {
      factCheckRaw = [];
      factCheckStatus = 'fetch_failed';
      factCheckHttp = null;
      factCheckError = null;
      warnings.push('Fact Check Tools fetch failed; continuing with remaining sources.');
    }

    const mergedRaw = [...raw, ...rssRaw, ...newsDataRaw, ...factCheckRaw, ...redditRaw];
    const dropCounters = {};
    const normalized = await Promise.all(
      mergedRaw.map((item, idx) => normalize(client, item, idx, dropCounters))
    );
    const normalizedKept = normalized.filter(Boolean);
    const deduped = dedupeByStoryCluster(dedupeIncidents(normalizedKept));
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
    const gate = evaluateIngestGate({
      fetched: mergedRaw.length,
      normalizedKept: normalizedKept.length,
      deduped: deduped.length,
      incidents,
    });
    const publishStatus = gate.pass ? 'reported_as_synthetic' : 'pending_review';
    const gatedIncidents = incidents.map((i) => ({ ...i, status: publishStatus }));
    const result = gate.pass
      ? await upsertIncidents(client, gatedIncidents)
      : await insertPendingOnly(client, gatedIncidents);
    if (gate.pass) {
      await dedupeSimilarIncidents(client);
    } else {
      warnings.push(`Publish gate failed (${gate.failed_checks.join(', ')}). New rows inserted as pending_review only; live feed unchanged.`);
    }
    const contextResult = await upsertContextArticles(client, contextArticles);
    const eventsResult = await logIncidentEvents(client, gatedIncidents);
    await logIngestRun(client, mergedRaw.length, result.inserted);
    res.status(200).json({
      ok: true,
      fetched: mergedRaw.length,
      normalized_kept: normalizedKept.length,
      normalized_dropped: mergedRaw.length - normalizedKept.length,
      deduped: deduped.length,
      balanced: incidents.length,
      upserted: result.inserted,
      published_status: publishStatus,
      publish_gate: gate,
      fetched_gdelt: raw.length,
      fetched_rss: rssRaw.length,
      fetched_rss_feeds: rssFeedCount,
      fetched_rss_by_feed: rssFeedStats,
      fetched_newsdata: newsDataRaw.length,
      newsdata_status: newsDataStatus,
      newsdata_http: newsDataHttp,
      newsdata_error: newsDataError,
      fetched_factcheck: factCheckRaw.length,
      factcheck_status: factCheckStatus,
      factcheck_http: factCheckHttp,
      factcheck_error: factCheckError,
      fetched_reddit: redditRaw.length,
      reddit_statuses: redditStatuses,
      context_fetched: rawContext.length,
      context_upserted: contextResult.inserted,
      archived_events_logged: eventsResult.inserted || 0,
      gdelt_failed_feeds_skipped: gdeltFailedFeedsSkipped,
      budget,
      limits: {
        rss_feeds_per_run: config.rssFeedsPerRun,
        rss_max_items_per_feed: config.rssMaxItemsPerFeed,
        newsdata_targeted_query_cap: Math.max(0, Number(process.env.NEWSDATA_TARGETED_QUERY_CAP || 1)),
      },
      dropped: dropCounters,
      warning: warnings.length ? warnings.join(' ') : null,
      at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
