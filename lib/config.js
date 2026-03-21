const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  // Accept both names to avoid deployment breakage across platforms/docs.
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
      // ── Fact-checkers (highest signal, curated deepfake/misinfo coverage) ──
      'https://www.politifact.com/rss/all/',
      'https://fullfact.org/feed/',
      'https://leadstories.com/atom.xml',

      // ── Investigative / disinformation research ──
      'https://www.bellingcat.com/feed/',
      'https://dfrlab.org/feed/',                          // Direct DFRLab (not Medium)
      'https://euvsdisinfo.eu/feed/',                      // Keep — may work server-side

      // ── BBC (verified working, carries media:thumbnail images) ──
      'https://feeds.bbci.co.uk/news/bbcverify/rss.xml',  // BBC Verify — best deepfake feed
      'https://feeds.bbci.co.uk/news/technology/rss.xml', // BBC Technology

      // ── Cybersecurity / fraud (verified working) ──
      'https://krebsonsecurity.com/feed/',
      'https://therecord.media/feed/',
      'https://cyberscoop.com/feed/',
      'https://www.darkreading.com/rss.xml',

      // ── Investigative journalism (open feeds) ──
      'https://www.404media.co/feed',
      'https://www.propublica.org/feeds/propublica/main',
      'https://theintercept.com/feed/?rss',
      'https://restofworld.org/feed/latest/',              // Global AI/tech impact

      // ── Tech press (broad but deepfake-relevant stories pass filter) ──
      'https://www.technologyreview.com/feed/',
      'https://www.theverge.com/rss/index.xml',
      'https://techcrunch.com/feed/',

      // ── Guardian (open, image-rich, strong AI coverage) ──
      'https://www.theguardian.com/technology/artificialintelligenceai/rss',
      'https://www.theguardian.com/media/rss',

      // ── Government / law enforcement (verified working) ──
      'https://www.ftc.gov/feeds/press-release.xml',
      'https://www.justice.gov/feeds/opa/justice-news.xml',
      'https://www.ncsc.gov.uk/api/1/services/v1/report-rss-feed.xml',

      // ── Platform newsrooms (for takedown/policy incidents) ──
      'https://blog.youtube/rss/',
      'https://about.fb.com/news/feed/',
    ].join(','),

  rssMaxItemsPerFeed: Number(process.env.RSS_MAX_ITEMS_PER_FEED || 30),

  // Run all feeds every cycle — 26 feeds, all verified open
  rssFeedsPerRun: Number(process.env.RSS_FEEDS_PER_RUN || 26),
  rssRotationWindowMinutes: Number(process.env.RSS_ROTATION_WINDOW_MINUTES || 15),

  // Context query runs less frequently than core ingest
  contextFetchIntervalMinutes: Number(process.env.CONTEXT_FETCH_INTERVAL_MINUTES || 60),

  // Hard age gate — never ingest articles older than this
  maxArticleAgeDays: Number(process.env.MAX_ARTICLE_AGE_DAYS || 14),

  excludedDomains:
    process.env.EXCLUDED_DOMAINS ||
    [
      // Low-quality aggregators confirmed in data
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
      // Vice — old articles dominating, remove until fresher sources fill gap
      'vice.com',
    ].join(','),

  // Optional detector integrations
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
