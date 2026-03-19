const { getAnonClient } = require("../lib/supabase");

function hasDeepfakeSignal(text) {
  return /(deepfake|deep fake|voice clone|cloned voice|vocal clone|synthetic voice|voice deepfake|audio deepfake|fake audio|fake video|face swap|synthetic media|ai impersonation|ai song|ai[- ]generated song|soundalike|mimic(?:ked|ry)? voice|ai porn|non-consensual)/i.test(
    String(text || "")
  );
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[\|\-:]\s*(bbc|cnn|reuters|ap|associated press|news|live updates?).*$/i, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 12)
    .join(" ");
}

function canonicalUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "mc_cid", "mc_eid"].forEach((k) =>
      u.searchParams.delete(k)
    );
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "").trim();
  }
}

function classifyCategory(row) {
  const hay = `${row.title || ""} ${row.summary || ""}`.toLowerCase();
  const hasAudioFakeSignal =
    /(voice clone|cloned voice|vocal clone|synthetic voice|voice deepfake|audio deepfake|deepfake audio|fake audio|ai impersonation|soundalike|mimic(?:ked|ry)? voice)/.test(
      hay
    );
  if (
    hasAudioFakeSignal ||
    (/(song|music|track|record label|artist|singer|beyonc|sony music)/.test(hay) &&
      /(deepfake|deep fake|voice clone|synthetic voice|audio deepfake|fake audio|ai impersonation|soundalike|mimic(?:ked|ry)? voice)/.test(hay))
  ) {
    return "audio";
  }
  if (/(scam|fraud|impersonation|wire transfer|extortion|phishing|bank)/.test(hay)) return "fraud";
  if (/(election|government|minister|campaign|parliament|senate|president|council|councillor|propaganda|state media|lawmaker|politician)/.test(hay)) return "political";
  if (/(artist|writer|music|film|cinema|entertainment|creative|copyright)/.test(hay) && hasDeepfakeSignal(hay)) return "culture";
  if (/(celebrity|actor|actress|singer|star|influencer)/.test(hay) && hasDeepfakeSignal(hay)) return "celeb";
  return row.category || "synthetic";
}

function dedupeAndFilter(rows) {
  const byUrl = new Map();
  const byTitle = new Map();
  const byId = new Map();
  const blockedDomains = new Set(["bignewsnetwork.com", "haskellforall.com", "intouchweekly.com", "citizensvoice.com"]);
  for (const row of rows || []) {
    const hay = `${row.title || ""} ${row.summary || ""} ${row.article_url || ""}`;
    const domain = String(row.source_domain || "").toLowerCase();
    if (blockedDomains.has(domain)) continue;
    const isAudioTagged =
      String(row.category || "").toLowerCase() === "audio" ||
      /voice clone|audio deepfake|synthetic voice/i.test(String(row.category_label || ""));
    if (!hasDeepfakeSignal(hay) && !isAudioTagged) continue;
    const urlKey = canonicalUrl(row.article_url);
    const titleKey = normalizeTitle(row.title);
    const next = { ...row, category: classifyCategory(row) };

    // Always attempt both URL and title dedupe so near-identical Google News cards collapse.
    if (urlKey) {
      const prev = byUrl.get(urlKey);
      if (!prev || new Date(next.published_at || 0).getTime() > new Date(prev.published_at || 0).getTime()) {
        byUrl.set(urlKey, next);
      }
    }
    if (titleKey) {
      const prev = byTitle.get(titleKey);
      if (!prev || new Date(next.published_at || 0).getTime() > new Date(prev.published_at || 0).getTime()) {
        byTitle.set(titleKey, next);
      }
    }
  }
  for (const item of byUrl.values()) byId.set(item.id, item);
  for (const item of byTitle.values()) byId.set(item.id, item);
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime())
    .slice(0, 200);
}

module.exports = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 80), 200);
    const client = getAnonClient();

    const { data, error } = await client
      .from("incidents")
      .select("id,source_id,title,summary,category,category_label,confidence,platform,source_domain,source_type,claim_url,reported_on,article_url,image_url,image_type,rights_status,usage_note,published_at,status")
      .order("published_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const clean = dedupeAndFilter(data || []).slice(0, limit);
    res.status(200).json({ ok: true, incidents: clean });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, incidents: [] });
  }
};
