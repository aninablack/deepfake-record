const DEEPFAKE_NEEDLES = [
  "deepfake", "deep fake", "voice clone", "cloned voice", "synthetic voice",
  "audio deepfake", "deepfake audio", "face swap", "synthetic media",
  "ai impersonation", "fake video", "fake audio", "ai-generated fake",
  "non-consensual", "ai porn", "soundalike", "mimic voice",
  "ai-generated", "ai generated", "digital replica", "manipulated video",
  "forged video", "fabricated video", "image manipulation", "audio manipulation",
  "disinformation", "non-consensual imagery", "ncii", "identity fraud", "impersonation"
];

const FRAUD_NEEDLES = [
  "scam", "fraud", "impersonation", "wire transfer", "payment", "bank", "phishing", "extortion"
];

const POLITICAL_NEEDLES = [
  "election", "government", "minister", "campaign", "parliament", "senate", "president",
  "council", "councillor", "state media", "lawmaker", "politician", "vote"
];

const ENTERTAINMENT_NEEDLES = [
  "artist", "music", "song", "film", "cinema", "celebrity", "actor", "actress", "singer",
  "record label", "sony music", "copyright", "entertainment"
];

const ACTION_NEEDLES = [
  "targeted", "victimized", "impersonated", "scammed", "removed", "takedown", "debunked",
  "arrested", "charged", "banned", "sued", "lawsuit", "investigat", "reported", "shared", "viral"
];

const TAG_RULES = [
  ["celebrity", /(celebrity|actor|actress|star|influencer)/i],
  ["politician", /(president|minister|senator|lawmaker|council|councillor|politician)/i],
  ["musician", /(musician|singer|song|record label|sony music|beyonc)/i],
  ["executive", /(ceo|executive|founder)/i],
  ["public_figure", /(public figure|high profile)/i],
  ["election", /(election|campaign|vote|ballot)/i],
  ["romance_scam", /(romance scam|catfish)/i],
  ["financial_fraud", /(fraud|wire transfer|bank|phishing|payment scam)/i],
  ["non_consensual", /(non-consensual|without consent|revenge porn)/i],
  ["satire", /(satire|parody)/i],
  ["removed", /(removed|taken down|takedown|deleted)/i],
  ["debunked", /(debunked|fact check|fact-check)/i],
  ["viral", /(viral|millions of views|trending)/i],
  ["ongoing", /(ongoing|continuing|still circulating)/i],
];

function hasNeedle(text, needles) {
  const content = (text || "").toLowerCase();
  return needles.some((k) => content.includes(k));
}

function hasSpecificActor(text) {
  const content = String(text || "");
  const namedLike = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/.test(content);
  const orgLike = /\b(Inc|Ltd|LLC|Corp|Company|Council|Government|Ministry|Police|Court|BBC|Reuters|Sony|TikTok|YouTube|Instagram|Meta|OpenAI)\b/.test(content);
  return namedLike || orgLike;
}

function hasActionSignal(text) {
  return hasNeedle(text, ACTION_NEEDLES);
}

function hasTimeAnchor(article, text) {
  if (article && article.seendate) return true;
  return /\b(20\d{2}|yesterday|today|last week|this week|on monday|on tuesday|on wednesday|on thursday|on friday)\b/i.test(
    String(text || "")
  );
}

function classifyIncident(text) {
  const content = (text || "").toLowerCase();
  if (hasNeedle(content, FRAUD_NEEDLES)) return { type: "fraud", label: "Fraud", score: 0.86 };
  if (hasNeedle(content, POLITICAL_NEEDLES)) return { type: "political", label: "Political", score: 0.84 };
  if (hasNeedle(content, ENTERTAINMENT_NEEDLES)) return { type: "entertainment", label: "Entertainment", score: 0.8 };
  return { type: "entertainment", label: "Entertainment", score: 0.62 };
}

function isContextOnlyArticle(text) {
  const content = (text || "").toLowerCase();
  const contextSignals = [
    "disclose", "disclosure", "ethics", "policy", "regulation", "law",
    "artists", "writers", "copyright", "creator", "culture", "opinion",
    "analysis", "editorial"
  ];
  const incidentSignals = [
    "deepfake", "synthetic media", "voice clone", "face swap", "impersonat",
    "hoax", "scam", "fraud", "fake video", "ai porn", "non-consensual"
  ];
  const hasContext = contextSignals.some((k) => content.includes(k));
  const hasIncident = incidentSignals.some((k) => content.includes(k));
  return hasContext && !hasIncident;
}

function isDeepfakeRelevant(text) {
  return hasNeedle(text, DEEPFAKE_NEEDLES);
}

function isTitleDeepfakeSpecific(title) {
  return hasNeedle(title, DEEPFAKE_NEEDLES);
}

function deepfakeRelevanceScore(title, summary) {
  const t = (title || "").toLowerCase();
  const s = (summary || "").toLowerCase();
  const strong = [
    "deepfake", "deep fake", "voice clone", "face swap",
    "fake video", "fake audio", "ai porn", "non-consensual",
    "ai-generated", "ai generated", "digital replica", "forged video",
    "fabricated video", "manipulated video", "cloned voice", "ncii"
  ];
  const medium = [
    "synthetic media", "manipulated media", "ai impersonation", "genai hoax",
    "image manipulation", "audio manipulation", "disinformation",
    "non-consensual imagery", "identity fraud", "impersonation"
  ];
  let score = 0;
  for (const k of strong) {
    if (t.includes(k)) score += 3;
    else if (s.includes(k)) score += 1;
  }
  for (const k of medium) {
    if (t.includes(k)) score += 2;
    else if (s.includes(k)) score += 1;
  }
  return score;
}

function deriveModalities(text) {
  const content = String(text || "").toLowerCase();
  const set = new Set();
  if (/(image|photo|still|picture|face swap)/.test(content)) set.add("image");
  if (/(video|clip|footage|face swap)/.test(content)) set.add("video");
  if (/(audio|voice|song|speech|sound|vocal|clone)/.test(content)) set.add("audio");
  if (/(quote|statement|post text|fabricated statement|fake statement)/.test(content)) set.add("text");
  if (set.size === 0) set.add("image");
  return Array.from(set);
}

function deriveTags(text) {
  const content = String(text || "");
  const tags = [];
  for (const [tag, re] of TAG_RULES) {
    if (re.test(content)) tags.push(tag);
  }
  return tags.slice(0, 8);
}

function deriveHarmLevel(confidence, text) {
  const content = String(text || "").toLowerCase();
  if (/(millions?|viral|election|financial|bank|child|minor|non-consensual)/.test(content)) return "high";
  if ((Number(confidence) || 0) >= 0.75) return "medium";
  return "low";
}

function deriveSourcePriority(sourceDomain = "") {
  const d = String(sourceDomain || "").toLowerCase();
  if (
    /(europol|interpol|ftc\.gov|justice\.gov|cisa\.gov|ncsc\.gov\.uk|gov\.uk|europa\.eu)/.test(d)
  ) {
    return "government";
  }
  if (
    /(bleepingcomputer|krebsonsecurity|therecord\.media|recordedfuture)/.test(d)
  ) {
    return "cyber_security";
  }
  if (/(factcheck|snopes|politifact|fullfact|reuters|apnews|afp)/.test(d)) return "factchecker";
  if (/(bbc|ft\.com|nytimes|guardian|cnn|washingtonpost)/.test(d)) return "major_outlet";
  return "other";
}

function buildIncidentKey(entityText, category, publishedAt) {
  const entity = String(entityText || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join("-");
  const day = publishedAt ? new Date(publishedAt).toISOString().slice(0, 10) : "unknown-date";
  return `${entity || "unknown-entity"}|${category}|${day}`;
}

function isIncidentCandidate(article, title, summary) {
  const full = `${title || ""} ${summary || ""} ${article?.url || ""}`;
  if (!isDeepfakeRelevant(full)) return false;
  if (!hasSpecificActor(full)) return false;
  if (!hasActionSignal(full)) return false;
  if (!hasTimeAnchor(article, full)) return false;
  return true;
}

function platformFromUrl(url) {
  if (!url) return "Web";
  const map = [
    ["twitter.com", "X"],
    ["x.com", "X"],
    ["youtube.com", "YouTube"],
    ["tiktok.com", "TikTok"],
    ["instagram.com", "Instagram"],
    ["reddit.com", "Reddit"],
    ["facebook.com", "Facebook"],
    ["telegram", "Telegram"],
  ];
  const lower = url.toLowerCase();
  for (const [needle, label] of map) {
    if (lower.includes(needle)) return label;
  }
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "Web";
  }
}

function detectReportedPlatforms(text) {
  const content = (text || "").toLowerCase();
  const map = [
    ["x", /\b(x|twitter)\b|x\.com|twitter\.com/g],
    ["tiktok", /\btiktok\b|tiktok\.com/g],
    ["instagram", /\binstagram\b|instagram\.com/g],
    ["facebook", /\bfacebook\b|facebook\.com/g],
    ["youtube", /\byoutube\b|youtube\.com|youtu\.be/g],
    ["reddit", /\breddit\b|reddit\.com/g],
    ["telegram", /\btelegram\b|t\.me/g],
    ["whatsapp", /\bwhatsapp\b/g],
  ];
  return map.filter(([, re]) => re.test(content)).map(([name]) => name);
}

module.exports = {
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
};
