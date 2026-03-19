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
      "https://news.google.com/rss/search?q=deepfake+when:7d&hl=en-GB&gl=GB&ceid=GB:en",
      "https://news.google.com/rss/search?q=deepfake+when:7d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=%22voice+clone%22+when:7d&hl=en-US&gl=US&ceid=US:en",
      "https://news.google.com/rss/search?q=%22face+swap%22+when:7d&hl=en-US&gl=US&ceid=US:en",
      "https://www.snopes.com/feed/",
      "https://www.politifact.com/rss/all/",
      "https://factcheck.afp.com/rss.xml",
      "https://fullfact.org/feed/",
      "https://leadstories.com/hoax-alert/rss.xml",
      "https://www.bellingcat.com/feed/",
      "https://medium.com/feed/dfrlab",
      "https://euvsdisinfo.eu/feed/",
      "https://www.ftc.gov/news-events/news/press-releases.xml",
      "https://www.europol.europa.eu/rss.xml",
      "https://www.wired.com/feed/rss",
      "https://www.theregister.com/security/headlines.atom",
    ].join(","),
  rssMaxItemsPerFeed: Number(process.env.RSS_MAX_ITEMS_PER_FEED || 30),
  redditSubreddits:
    process.env.REDDIT_SUBREDDITS ||
    ["deepfakes", "MediaSynthesis", "scams", "OSINT", "technology", "news", "worldnews"].join(","),
  redditMaxItemsPerSubreddit: Number(process.env.REDDIT_MAX_ITEMS_PER_SUBREDDIT || 20),
  redditQuery:
    process.env.REDDIT_QUERY || '(deepfake OR "ai fake" OR "voice clone" OR "synthetic media")',
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
