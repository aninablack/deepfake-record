const STRONG_SIGNAL_TERMS = [
  "deepfake",
  "deep fake",
  "voice clone",
  "cloned voice",
  "synthetic media",
  "face swap",
  "face swapping",
  "ai-generated",
  "ai generated",
];

const MEDIUM_SIGNAL_TERMS = [
  "synthetic content",
  "synthetic image",
  "synthetic audio",
  "generated image",
  "generated video",
  "generated audio",
  "ai video",
  "ai videos",
  "ai clone",
  "digital clone",
  "digital double",
  "virtual human",
  "avatar impersonation",
  "doctored footage",
  "doctored photo",
  "doctored image",
  "digitally altered",
  "digitally manipulated",
  "digitally modified",
  "image manipulation",
  "video manipulation",
  "audio manipulation",
  "photo manipulation",
  "manipulated media",
  "altered footage",
  "edited footage",
  "lip sync attack",
  "reenactment video",
  "disinformation campaign",
  "smear campaign",
  "cameo",
  "influence operation",
  "information operation",
  "coordinated inauthentic behavior",
  "state-sponsored",
  "state-sponsored content",
  "foreign interference",
  "election interference",
  "propaganda video",
  "narrative manipulation",
  "computational propaganda",
  "information warfare",
  "hybrid warfare",
  "cognitive warfare",
  "astroturfing",
  "bot network",
  "troll farm",
  "russian disinformation",
  "chinese disinformation",
  "iranian disinformation",
  "impersonation scam",
  "identity fraud",
  "digital impersonation",
  "voice impersonation",
  "audio impersonation",
  "phone scam",
  "vishing",
  "ceo fraud",
  "business email compromise",
  "romance scam",
  "investment scam",
  "crypto scam",
  "fake endorsement",
  "celebrity scam",
  "fake celebrity",
  "unauthorized likeness",
  "personality rights",
  "right of publicity",
  "non-consensual intimate",
  "ncii",
  "image-based abuse",
  "revenge porn",
  "sextortion",
  "false claims",
  "misleading video",
  "out of context",
  "misattributed",
  "fabricated quote",
  "fake quote",
  "false quote",
  "invented quote",
  "ai-generated quotes",
  "unverified video",
  "debunked",
  "fact check",
  "false narrative",
  "misinformation spread",
  "viral hoax",
  "content authenticity",
  "provenance",
  "watermarking",
  "c2pa",
  "content credentials",
  "media forensics",
  "digital forensics",
  "image forensics",
  "video forensics",
  "synthetic detection",
  "liveness detection",
  "biometric fraud",
  "identity verification bypass",
  "fake news anchor",
  "fake newsreader",
  "impersonated politician",
  "fake politician",
  "cloned politician",
  "fabricated speech",
  "fake speech",
  "fake announcement",
  "fake press conference",
  "financial deepfake",
  "medical deepfake",
  "insurance fraud video",
  "court evidence manipulation",
  "manipulated video",
  "fabricated video",
  "fake footage",
  "forged video",
  "altered video",
  "doctored image",
  "false video",
];

const TRUSTED_RELAX_DOMAINS = [
  "bbc.co.uk",
  "bbc.com",
  "independent.co.uk",
  "theguardian.com",
  "ft.com",
  "foreignpolicy.com",
  "france24.com",
  "aljazeera.com",
  "dw.com",
  "npr.org",
  "axios.com",
  "wired.com",
  "nbcnews.com",
  "abcnews.go.com",
  "thehill.com",
  "restofworld.org",
  "theintercept.com",
  "propublica.org",
];

const DEEPFAKE_NEEDLES = Array.from(new Set([...STRONG_SIGNAL_TERMS, ...MEDIUM_SIGNAL_TERMS]));

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

function countNeedles(text, needles) {
  const content = String(text || "").toLowerCase();
  return needles.filter((k) => content.includes(k)).length;
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

function isDeepfakeRelevant(text, sourceHint = "") {
  const full = String(text || "").toLowerCase();
  const strongMatches = countNeedles(full, STRONG_SIGNAL_TERMS);
  const mediumMatches = countNeedles(full, MEDIUM_SIGNAL_TERMS);
  const source = String(sourceHint || "").toLowerCase();
  const isTrusted = TRUSTED_RELAX_DOMAINS.some((d) => source.includes(d));
  return strongMatches > 0 || mediumMatches >= 2 || (isTrusted && mediumMatches >= 1);
}

function isTitleDeepfakeSpecific(title) {
  return hasNeedle(title, DEEPFAKE_NEEDLES);
}

function deepfakeRelevanceScore(title, summary, sourceHint = "") {
  const combined = `${title || ""} ${summary || ""}`.toLowerCase();
  const source = String(sourceHint || "").toLowerCase();
  const strongMatches = countNeedles(combined, STRONG_SIGNAL_TERMS);
  const mediumMatches = countNeedles(combined, MEDIUM_SIGNAL_TERMS);
  const isTrusted = TRUSTED_RELAX_DOMAINS.some((d) => source.includes(d));

  // Strong signal: automatic pass.
  if (strongMatches > 0) return Math.max(3, strongMatches * 3 + mediumMatches);
  // Medium signals: pass with 2+ terms, or 1 term from trusted domains.
  if (mediumMatches >= 2) return Math.max(2, mediumMatches);
  if (isTrusted && mediumMatches >= 1) return 1;
  return 0;
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
  if (/(factcheck|snopes|politifact|fullfact|reuters|apnews|afp|bellingcat|dfrlab|leadstories)/.test(d)) return "factchecker";
  if (
    /(bbc|ft\.com|nytimes|guardian|cnn|washingtonpost|propublica|theintercept|restofworld|theverge|techcrunch|technologyreview|cyberscoop|therecord\.media|krebsonsecurity|darkreading|404media|ftc\.gov|justice\.gov|ncsc\.gov\.uk)/.test(d)
  ) return "major_outlet";
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
