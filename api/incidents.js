const { getAnonClient } = require("../lib/supabase");

function toProxyUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/api/image-proxy?")) return raw;
  if (/image\.pollinations\.ai/i.test(raw)) return raw;
  return `/api/image-proxy?url=${encodeURIComponent(raw)}`;
}

function hasDeepfakeSignal(text) {
  return /(deepfake|deep fake|voice clone|cloned voice|vocal clone|synthetic voice|voice deepfake|audio deepfake|fake audio|fake video|face swap|synthetic media|ai impersonation|ai song|ai[- ]generated song|soundalike|mimic(?:ked|ry)? voice|ai porn|non-consensual)/i.test(
    String(text || "")
  );
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\|.*$/g, " ")
    .replace(/[\(\[]\s*debunked\s*[\)\]]/g, " ")
    .replace(/\b(debunked|fact[\s-]?check|aol\.co\.uk|the independent|bbc)\b/g, " ")
    .replace(/\bdeepfakes\b/g, "deepfake")
    .replace(/\bartists\b/g, "artist")
    .replace(/[\|\-:]\s*(bbc|cnn|reuters|ap|associated press|news|live updates?).*$/i, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => !["the", "a", "an", "of", "and", "to", "for", "in", "on", "its"].includes(w))
    .slice(0, 10)
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
  const current = String(row.category || "").toLowerCase();
  if (["fraud", "political", "entertainment"].includes(current)) return current;
  if (["audio", "culture", "celeb", "synthetic"].includes(current)) return "entertainment";
  return "entertainment";
}

function dedupeAndFilter(rows) {
  const byUrl = new Map();
  const byTitle = new Map();
  const byIncidentKey = new Map();
  const byId = new Map();
  const blockedDomains = new Set(["bignewsnetwork.com", "haskellforall.com", "intouchweekly.com", "citizensvoice.com"]);
  const sourceRank = { factchecker: 3, major_outlet: 2, other: 1 };
  const pickPreferred = (prev, next) => {
    const prevRank = sourceRank[String(prev.source_priority || "").toLowerCase()] || 0;
    const nextRank = sourceRank[String(next.source_priority || "").toLowerCase()] || 0;
    if (nextRank !== prevRank) return nextRank > prevRank ? next : prev;
    const prevConf = Number(prev.confidence) || 0;
    const nextConf = Number(next.confidence) || 0;
    if (nextConf !== prevConf) return nextConf > prevConf ? next : prev;
    return new Date(next.published_at || 0).getTime() > new Date(prev.published_at || 0).getTime() ? next : prev;
  };

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
    const next = { ...row, category: classifyCategory(row), image_url: toProxyUrl(row.image_url) };

    const incidentKey = String(row.incident_key || "").trim();
    if (incidentKey) {
      const prev = byIncidentKey.get(incidentKey);
      byIncidentKey.set(incidentKey, prev ? pickPreferred(prev, next) : next);
    }

    // Always attempt both URL and title dedupe so near-identical Google News cards collapse.
    if (urlKey) {
      const prev = byUrl.get(urlKey);
      byUrl.set(urlKey, prev ? pickPreferred(prev, next) : next);
    }
    if (titleKey) {
      const prev = byTitle.get(titleKey);
      byTitle.set(titleKey, prev ? pickPreferred(prev, next) : next);
    }
  }
  for (const item of byIncidentKey.values()) byId.set(item.id, item);
  for (const item of byUrl.values()) byId.set(item.id, item);
  for (const item of byTitle.values()) byId.set(item.id, item);
  const finalByTitle = new Map();
  for (const item of byId.values()) {
    const key = normalizeTitle(item.title);
    if (!key) continue;
    const prev = finalByTitle.get(key);
    finalByTitle.set(key, prev ? pickPreferred(prev, item) : item);
  }
  return Array.from(finalByTitle.values())
    .sort((a, b) => new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime())
    .slice(0, 200);
}

function rebalanceSources(rows, limit) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return [];

  const maxGoogleShare = Math.max(8, Math.floor(limit * 0.4));
  const maxPerDomain = Math.max(2, Math.floor(limit * 0.2));

  const selected = [];
  const domainCounts = new Map();
  let googleCount = 0;

  const canTake = (row) => {
    const domain = String(row.source_domain || "").toLowerCase() || "unknown";
    const currentDomainCount = domainCounts.get(domain) || 0;
    if (currentDomainCount >= maxPerDomain) return false;
    if (domain === "news.google.com" && googleCount >= maxGoogleShare) return false;
    return true;
  };

  const take = (row) => {
    const domain = String(row.source_domain || "").toLowerCase() || "unknown";
    selected.push(row);
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    if (domain === "news.google.com") googleCount += 1;
  };

  // Pass 1: take best items respecting caps.
  for (const row of items) {
    if (selected.length >= limit) break;
    if (canTake(row)) take(row);
  }

  // Pass 2: fill remaining slots with anything recent if we still have room.
  if (selected.length < limit) {
    for (const row of items) {
      if (selected.length >= limit) break;
      if (selected.find((x) => x.id === row.id)) continue;
      take(row);
    }
  }

  return selected.slice(0, limit);
}

module.exports = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 80), 200);
    const client = getAnonClient();

    const { data, error } = await client
      .from("incidents")
      .select("id,source_id,title,summary,category,category_label,confidence,platform,source_domain,source_type,claim_url,reported_on,article_url,image_url,image_type,rights_status,usage_note,published_at,status,incident_key,source_priority")
      .order("published_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const deduped = dedupeAndFilter(data || []);
    const clean = rebalanceSources(deduped, limit);
    res.status(200).json({ ok: true, incidents: clean });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, incidents: [] });
  }
};
