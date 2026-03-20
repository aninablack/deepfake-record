const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  // Accept both names to avoid deployment breakage across platforms/docs.
  supabaseServiceRoleKey:
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  gdeltQuery: process.env.GDELT_QUERY || '(deepfake OR "synthetic media" OR "AI-generated" OR "voice clone")',
  gdeltMaxRecords: Number(process.env.GDELT_MAX_RECORDS || 200),
  gdeltContextQuery:
    process.env.GDELT_CONTEXT_QUERY ||
    '((deepfake OR "synthetic media") AND (law OR regulation OR election OR algorithm OR teenager OR youth OR "social media" OR bias OR policy))',
  gdeltContextMaxRecords: Number(process.env.GDELT_CONTEXT_MAX_RECORDS || 40),
  rssFeeds:
    process.env.RSS_FEEDS ||
    [
      // Major fact-check and investigation desks
      "https://www.snopes.com/feed/",
      "https://www.politifact.com/rss/all/",
      "https://factcheck.afp.com/rss.xml",
      "https://fullfact.org/feed/",
      "https://leadstories.com/hoax-alert/rss.xml",
      "https://www.bellingcat.com/feed/",
      "https://medium.com/feed/dfrlab",
      "https://euvsdisinfo.eu/feed/",

      // BBC / AP / Reuters / major outlets
      "https://feeds.bbci.co.uk/news/reality_check/rss.xml",
      "https://feeds.bbci.co.uk/news/technology/rss.xml",
      "https://apnews.com/hub/artificial-intelligence?output=1",
      "https://www.reuters.com/world/rss",
      "https://www.reuters.com/technology/rss",
      "https://feeds.washingtonpost.com/rss/national",
      "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
      "https://rss.nytimes.com/services/xml/rss/nyt/MediaandAdvertising.xml",

      // Cyber/fraud publications
      "https://www.bleepingcomputer.com/feed/",
      "https://krebsonsecurity.com/feed/",
      "https://therecord.media/feed/",
      "https://www.wired.com/feed/rss",
      "https://www.theregister.com/security/headlines.atom",

      // Law enforcement and government advisories
      "https://www.europol.europa.eu/rss.xml",
      "https://www.interpol.int/en/News-and-Events/News/rss",
      "https://www.ftc.gov/news-events/news/press-releases.xml",
      "https://www.justice.gov/opa/pr/rss.xml",
      "https://www.ncsc.gov.uk/api/1/services/v1/report-rss-feed.xml",
      "https://www.cisa.gov/news.xml",

      // Platform governance / policy
      "https://blog.youtube/rss/",
      "https://about.fb.com/news/feed/",
      "https://newsroom.tiktok.com/en/feed",
      "https://blog.x.com/en_us/rss.xml",
    ].join(","),
  rssMaxItemsPerFeed: Number(process.env.RSS_MAX_ITEMS_PER_FEED || 30),
  // Quota protection: only fetch a rotating subset of feeds per run.
  rssFeedsPerRun: Number(process.env.RSS_FEEDS_PER_RUN || 14),
  rssRotationWindowMinutes: Number(process.env.RSS_ROTATION_WINDOW_MINUTES || 15),
  // Quota protection: context query is optional and can run less frequently than core ingest.
  contextFetchIntervalMinutes: Number(process.env.CONTEXT_FETCH_INTERVAL_MINUTES || 60),
  excludedDomains:
    process.env.EXCLUDED_DOMAINS ||
    [
      "womansworld.com",
      "ibtimes.co.uk",
      "thailand-business-news.com",
    ].join(","),

  // Optional detector integrations (provider URLs + keys)
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
