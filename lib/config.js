const defaultExcludedDomains = [
  'womansworld.com',
  'ibtimes.co.uk',
  'thailand-business-news.com',
  'hawaiitelegraph.com',
  'wdbj7.com',
  'nbcrightnow.com',
  'graphic.com.gh',
  'onrec.com',
  'uniindia.com',
  'jewishworldreview.com',
  'bignewsnetwork.com',
  'haskellforall.com',
  'vice.com',
];

function mergeExcludedDomains(envValue) {
  const envDomains = String(envValue || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([...defaultExcludedDomains, ...envDomains])).join(',');
}

const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey:
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',

  gdeltQuery:
    process.env.GDELT_QUERY ||
    '(deepfake OR "synthetic media" OR "AI-generated" OR "voice clone")',
  gdeltMaxRecords: Number(process.env.GDELT_MAX_RECORDS || 200),

  gdeltContextQuery:
    process.env.GDELT_CONTEXT_QUERY ||
    '((deepfake OR "synthetic media") AND (law OR regulation OR election OR algorithm OR teenager OR youth OR "social media" OR bias OR policy))',
  gdeltContextMaxRecords: Number(process.env.GDELT_CONTEXT_MAX_RECORDS || 40),

  rssFeeds:
    process.env.RSS_FEEDS ||
    [
      'https://www.politifact.com/rss/all/',
      'https://fullfact.org/feed/',
      'https://leadstories.com/atom.xml',
      'https://www.bellingcat.com/feed/',
      'https://dfrlab.org/feed/',
      'https://euvsdisinfo.eu/feed/',
      'https://feeds.bbci.co.uk/news/bbcverify/rss.xml',
      'https://feeds.bbci.co.uk/news/technology/rss.xml',
      'https://krebsonsecurity.com/feed/',
      'https://therecord.media/feed/',
      'https://cyberscoop.com/feed/',
      'https://www.darkreading.com/rss.xml',
      'https://www.404media.co/feed',
      'https://www.propublica.org/feeds/propublica/main',
      'https://theintercept.com/feed/?rss',
      'https://restofworld.org/feed/latest/',
      'https://www.technologyreview.com/feed/',
      'https://www.theverge.com/rss/index.xml',
      'https://techcrunch.com/feed/',
      'https://www.theguardian.com/technology/artificialintelligenceai/rss',
      'https://www.theguardian.com/media/rss',
      'https://www.ftc.gov/feeds/press-release.xml',
      'https://www.justice.gov/news/rss?m=1',
      'https://www.ncsc.gov.uk/api/1/services/v1/report-rss-feed.xml',
      'https://blog.youtube/rss/',
      'https://about.fb.com/news/feed/',
    ].join(','),

  rssMaxItemsPerFeed: Number(process.env.RSS_MAX_ITEMS_PER_FEED || 30),
  rssFeedsPerRun: Number(process.env.RSS_FEEDS_PER_RUN || 26),
  rssRotationWindowMinutes: Number(process.env.RSS_ROTATION_WINDOW_MINUTES || 15),
  contextFetchIntervalMinutes: Number(process.env.CONTEXT_FETCH_INTERVAL_MINUTES || 60),
  maxArticleAgeDays: Number(process.env.MAX_ARTICLE_AGE_DAYS || 14),

  excludedDomains: mergeExcludedDomains(process.env.EXCLUDED_DOMAINS),

  hiveApiUrl: process.env.HIVE_API_URL || '',
  hiveApiKey: process.env.HIVE_API_KEY || '',
  realityDefenderApiUrl: process.env.REALITY_DEFENDER_API_URL || '',
  realityDefenderApiKey: process.env.REALITY_DEFENDER_API_KEY || '',
  detectionTimeoutMs: Number(process.env.DETECTION_TIMEOUT_MS || 7000),
  detectionMaxItems: Number(process.env.DETECTION_MAX_ITEMS || 20),
};

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = { config, requireEnv };
