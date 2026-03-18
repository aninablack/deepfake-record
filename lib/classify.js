const CATEGORY_RULES = [
  { type: "fraud", label: "Fraud", keywords: ["scam", "fraud", "bank", "transfer", "ceo", "finance", "crypto", "phishing"] },
  { type: "audio", label: "Voice clone", keywords: ["audio", "voice", "call", "voicemail", "speech", "phone"] },
  { type: "political", label: "Political", keywords: ["election", "president", "minister", "government", "campaign", "parliament", "senator", "vote"] },
  { type: "celeb", label: "Celebrity", keywords: ["celebrity", "actor", "actress", "singer", "musician", "influencer", "star"] },
  { type: "synthetic", label: "Synthetic image", keywords: ["image", "photo", "picture", "video", "visual", "generated"] },
];

function classifyIncident(text) {
  const content = (text || "").toLowerCase();
  let best = { type: "synthetic", label: "Synthetic image", score: 0.5 };

  for (const rule of CATEGORY_RULES) {
    const matches = rule.keywords.filter((k) => content.includes(k)).length;
    if (matches > 0) {
      const score = Math.min(0.99, 0.6 + matches * 0.08);
      if (score > best.score) {
        best = { type: rule.type, label: rule.label, score };
      }
    }
  }

  return best;
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

module.exports = { classifyIncident, platformFromUrl };
