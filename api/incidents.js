const { getAnonClient } = require("../lib/supabase");

function toProxyUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/api/image-proxy?")) return raw;
  if (/image\.pollinations\.ai/i.test(raw)) return raw;
  return `/api/image-proxy?url=${encodeURIComponent(raw)}`;
}

function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function isGoogleDomain(value) {
  const d = normalizeDomain(value);
  return d === "news.google.com" || d.endsWith(".news.google.com") || d.includes("google.com");
}

function isLowQualityThumb(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return true;
  return (
    /lh3\.googleusercontent\.com/.test(u) ||
    /favicon|apple-touch-icon|site-icon|wordmark|brandmark/.test(u) ||
    /logo|favicon|site-icon|wordmark|brandmark/.test(u)
  );
}

function isLowValueGuideRow(row) {
  const t = `${row.title || ""} ${row.summary || ""}`.toLowerCase();
  const guidePattern =
    /(deepfakemaker|deepfake maker|face swap|how to|practical guide|guide to|tutorial|choosing the perfect|turn any clip|viral ai video|free unlimited|reaction gif)/i;
  const strongIncidentPattern =
    /(victim|victimized|lawsuit|sued|arrest|charged|jailed|banned|ban|removed|takedown|scam|fraud|impersonation|child porn|non-consensual|court|acquitted)/i;
  return guidePattern.test(t) && !strongIncidentPattern.test(t);
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

function storyFingerprint(row) {
  const text = `${row.title || ""} ${row.summary || ""}`.toLowerCase();
  const tokens = text
    .replace(/[\(\)\[\]\|,:;'"`’“”!?]/g, " ")
    .replace(/\b(debunked|fact[\s-]?check|aol\.co\.uk|the independent|bbc|news|video|ai|deepfake|deepfakes)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length >= 4)
    .filter((w) => !["with", "from", "that", "this", "over", "after", "their", "into", "about", "global", "organised", "organised"].includes(w));
  const unique = Array.from(new Set(tokens)).sort();
  return unique.slice(0, 8).join(" ");
}

function topicKey(row) {
  const cleaned = String(row.title || "")
    .toLowerCase()
    .replace(/\|.*$/g, " ")
    .replace(/[\(\)\[\],:;'"`’“”!?]/g, " ")
    .replace(/\b(ai|video|debunked|fact[\s-]?check|claims?|after|died|news|the|a|an|of|and|to|for|in|on|is)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter((w) => w.length >= 4).slice(0, 6);
  return tokens.join(" ");
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

function isHomepageLikeUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(String(url));
    const path = String(u.pathname || "/").replace(/\/+$/, "") || "/";
    const low = path.toLowerCase();
    return path === "/" || low === "/home" || low === "/index" || low === "/index.html" || low === "/news";
  } catch {
    return true;
  }
}

function deriveRecordType(row) {
  const sourceType = String(row.source_type || "").toLowerCase();
  const claim = String(row.claim_url || "").toLowerCase();
  const article = String(row.article_url || "").toLowerCase();
  const hasDirectClaim = /(x\.com|twitter\.com|tiktok\.com|instagram\.com|youtube\.com|youtu\.be|reddit\.com|t\.me|facebook\.com)/.test(claim);
  if (hasDirectClaim) return "incident_direct";
  if (sourceType === "context") return "context";
  if (sourceType === "news" || sourceType === "factcheck" || article) return "incident_report";
  return "context";
}

function classifyCategory(row) {
  const current = String(row.category || "").toLowerCase();
  if (["fraud", "political", "entertainment"].includes(current)) return current;
  if (["audio", "culture", "celeb", "synthetic"].includes(current)) return "entertainment";
  return "entertainment";
}

function deriveIngestSource(row) {
  const sourceType = String(row.source_type || "").toLowerCase();
  const domain = normalizeDomain(row.source_domain || "");
  if (sourceType === "social_report" || domain.includes("reddit.com")) return "reddit";
  if (sourceType === "factcheck") return "rss";
  if (sourceType === "news") return "gdelt";
  return "unknown";
}

function dedupeAndFilter(rows) {
  const byUrl = new Map();
  const byTitle = new Map();
  const byIncidentKey = new Map();
  const byId = new Map();
  const blockedDomains = new Set(["bignewsnetwork.com", "haskellforall.com", "intouchweekly.com", "citizensvoice.com"]);
  const sourceRank = {
    government: 5,
    cyber_security: 4,
    factchecker: 3,
    major_outlet: 2,
    other: 1,
  };
  const imageRelevanceScore = (row) => {
    const title = String(row.title || "").toLowerCase();
    const img = String(row.image_url || "").toLowerCase();
    let score = 0;
    if (!img) return score;
    if (img.includes("pollinations")) score -= 2;
    if (/(cafe|caf%C3%A9|coffee|netanyahu)/i.test(img) && /(cafe|caf\u00e9|netanyahu)/i.test(title)) score += 2;
    if (/(road|mountain|landscape|beach)/i.test(img) && /(deepfake|debunked|netanyahu|cafe|caf\u00e9)/i.test(title)) score -= 1;
    return score;
  };
  const pickPreferred = (prev, next) => {
    const prevHasDocImage =
      String(prev.image_type || "").toLowerCase() === "documented" && !!String(prev.image_url || "").trim();
    const nextHasDocImage =
      String(next.image_type || "").toLowerCase() === "documented" && !!String(next.image_url || "").trim();
    if (prevHasDocImage !== nextHasDocImage) return nextHasDocImage ? next : prev;

    const prevImg = imageRelevanceScore(prev);
    const nextImg = imageRelevanceScore(next);
    if (nextImg !== prevImg) return nextImg > prevImg ? next : prev;

    const prevRank = sourceRank[String(prev.source_priority || "").toLowerCase()] || 0;
    const nextRank = sourceRank[String(next.source_priority || "").toLowerCase()] || 0;
    if (nextRank !== prevRank) return nextRank > prevRank ? next : prev;
    const prevConf = Number(prev.confidence) || 0;
    const nextConf = Number(next.confidence) || 0;
    if (nextConf !== prevConf) return nextConf > prevConf ? next : prev;
    return new Date(next.published_at || 0).getTime() > new Date(prev.published_at || 0).getTime() ? next : prev;
  };

  for (const row of rows || []) {
    if (isLowValueGuideRow(row)) continue;
    const hay = `${row.title || ""} ${row.summary || ""} ${row.article_url || ""}`;
    const domain = normalizeDomain(row.source_domain);
    if (blockedDomains.has(domain)) continue;
    // Hide low-value homepage-only factcheck rows from live feed.
    const homepageOnly = isHomepageLikeUrl(row.article_url);
    const hasClaim = !!String(row.claim_url || "").trim();
    const sourceType = String(row.source_type || "").toLowerCase();
    if (homepageOnly && sourceType === "factcheck" && !hasClaim) continue;
    const isAudioTagged =
      String(row.category || "").toLowerCase() === "audio" ||
      /voice clone|audio deepfake|synthetic voice/i.test(String(row.category_label || ""));
    if (!hasDeepfakeSignal(hay) && !isAudioTagged) continue;
    const urlKey = canonicalUrl(row.article_url);
    const titleKey = normalizeTitle(row.title);
    const rawImage = String(row.image_url || "").toLowerCase();
    const isGenericGoogleThumb =
      isGoogleDomain(row.source_domain) &&
      (/lh3\.googleusercontent\.com/i.test(rawImage) || /lh3\.googleusercontent\.com%2f/i.test(rawImage));
    const isDocumentedSource =
      String(row.image_type || "").toLowerCase() === "documented" && !!String(row.image_url || "").trim();
    const isBadThumb = isGenericGoogleThumb || (!isDocumentedSource && isLowQualityThumb(rawImage));
    const isDocumented = !isBadThumb && isDocumentedSource;

    const next = {
      ...row,
      category: classifyCategory(row),
      record_type: deriveRecordType(row),
      image_url: isBadThumb ? "" : toProxyUrl(row.image_url),
      image_type: isDocumented ? "documented" : "illustrative",
      rights_status: isBadThumb ? "unknown" : row.rights_status,
      usage_note: isBadThumb ? "No article-specific evidence image; showing headline-only card." : row.usage_note,
    };

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

  const finalByStory = new Map();
  for (const item of finalByTitle.values()) {
    const storyKey = storyFingerprint(item) || topicKey(item) || normalizeTitle(item.title);
    if (!storyKey) continue;
    const prev = finalByStory.get(storyKey);
    finalByStory.set(storyKey, prev ? pickPreferred(prev, item) : item);
  }

  return Array.from(finalByStory.values())
    .sort((a, b) => {
      const aHasDoc = String(a.image_type || "").toLowerCase() === "documented" && !!String(a.image_url || "").trim();
      const bHasDoc = String(b.image_type || "").toLowerCase() === "documented" && !!String(b.image_url || "").trim();
      if (aHasDoc !== bHasDoc) return bHasDoc ? 1 : -1;
      return new Date(b.published_at || 0).getTime() - new Date(a.published_at || 0).getTime();
    })
    .slice(0, 1200);
}

function rebalanceSources(rows, limit) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return [];

  const maxGoogleShare = Math.max(8, Math.floor(limit * 0.35));
  const minNonGoogleTarget = Math.min(limit, Math.max(10, Math.floor(limit * 0.8)));
  const maxPerDomain = Math.max(2, Math.floor(limit * 0.2));
  const maxFactcheckShare = Math.max(6, Math.floor(limit * 0.35));

  const selected = [];
  const domainCounts = new Map();
  let googleCount = 0;
  let nonGoogleCount = 0;
  let factcheckCount = 0;

  const sourceBucket = (row) => {
    const domain = normalizeDomain(row.source_domain || "");
    const sourceType = String(row.source_type || "").toLowerCase();
    if (sourceType === "social_report" || domain === "reddit.com" || domain.endsWith(".reddit.com")) return "Reddit";
    if (domain.includes("news.google.com")) return "Google News";
    if (sourceType === "news" && !domain.includes("google")) return "GDELT Project";
    if (domain.includes("snopes.com")) return "Snopes";
    if (domain.includes("politifact.com")) return "PolitiFact";
    if (domain.includes("factcheck.afp.com")) return "AFP Fact Check";
    if (domain.includes("fullfact.org")) return "Full Fact";
    if (domain.includes("leadstories.com")) return "Lead Stories";
    if (domain.includes("bellingcat.com")) return "Bellingcat";
    if (domain.includes("dfrlab.org") || domain.includes("medium.com")) return "DFRLab";
    if (domain.includes("euvsdisinfo.eu")) return "EUvsDisinfo";
    return "";
  };

  const isLowQualityGoogleRow = (row) => {
    if (!isGoogleDomain(row.source_domain)) return false;
    const hasImage = !!String(row.image_url || "").trim();
    const confidence = Number(row.confidence) || 0;
    // Keep no-image Google rows as text-headline cards, but suppress lower-confidence noise.
    return !hasImage && confidence < 0.78;
  };

  const canTake = (row, opts = {}) => {
    const relaxGoogle = Boolean(opts.relaxGoogle);
    const relaxFactcheck = Boolean(opts.relaxFactcheck);
    const domain = normalizeDomain(row.source_domain) || "unknown";
    const sourceType = String(row.source_type || "").toLowerCase();
    const currentDomainCount = domainCounts.get(domain) || 0;
    if (currentDomainCount >= maxPerDomain) return false;
    if (!relaxGoogle && isGoogleDomain(domain) && googleCount >= maxGoogleShare) return false;
    if (!relaxFactcheck && sourceType === "factcheck" && factcheckCount >= maxFactcheckShare) return false;
    return true;
  };

  const take = (row) => {
    const domain = normalizeDomain(row.source_domain) || "unknown";
    const sourceType = String(row.source_type || "").toLowerCase();
    selected.push(row);
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
    if (isGoogleDomain(domain)) googleCount += 1;
    else nonGoogleCount += 1;
    if (sourceType === "factcheck") factcheckCount += 1;
  };

  const nonGoogleItems = items.filter((r) => !isGoogleDomain(r.source_domain));
  const googleItems = items.filter((r) => isGoogleDomain(r.source_domain) && !isLowQualityGoogleRow(r));

  // Pass -1: ensure source diversity for key listed feeds when records are available.
  const requiredBuckets = [
    "GDELT Project",
    "Google News",
    "Snopes",
    "PolitiFact",
    "AFP Fact Check",
    "Full Fact",
    "Lead Stories",
    "Bellingcat",
    "DFRLab",
    "EUvsDisinfo",
    "Reddit",
  ];
  for (const bucket of requiredBuckets) {
    if (selected.length >= limit) break;
    const candidate = items.find((r) => sourceBucket(r) === bucket && canTake(r, { relaxGoogle: true, relaxFactcheck: true }));
    if (candidate) take(candidate);
  }

  // Pass 0: enforce non-Google minimum first when available.
  for (const row of nonGoogleItems) {
    if (selected.length >= limit) break;
    if (nonGoogleCount >= minNonGoogleTarget) break;
    if (canTake(row)) take(row);
  }

  // Pass 1: prioritize non-Google and non-factcheck items first.
  const prioritized = [
    ...nonGoogleItems.filter((r) => deriveRecordType(r) === "incident_direct"),
    ...nonGoogleItems.filter((r) => {
      const d = String(r.source_domain || "").toLowerCase();
      const t = String(r.source_type || "").toLowerCase();
      return !isGoogleDomain(d) && t !== "factcheck";
    }),
    ...nonGoogleItems.filter((r) => {
      const d = String(r.source_domain || "").toLowerCase();
      const t = String(r.source_type || "").toLowerCase();
      return !isGoogleDomain(d) && t === "factcheck";
    }),
    ...googleItems,
  ];
  for (const row of prioritized) {
    if (selected.length >= limit) break;
    if (selected.find((x) => x.id === row.id)) continue;
    if (canTake(row)) take(row);
  }

  // Pass 2: fill remaining slots with anything recent if we still have room.
  if (selected.length < limit) {
    for (const row of [...nonGoogleItems, ...googleItems]) {
      if (selected.length >= limit) break;
      if (selected.find((x) => x.id === row.id)) continue;
      if (canTake(row)) take(row);
    }
  }

  // Pass 3: if still under-filled, relax source-mix caps to avoid tiny galleries.
  if (selected.length < limit) {
    for (const row of items) {
      if (selected.length >= limit) break;
      if (selected.find((x) => x.id === row.id)) continue;
      if (canTake(row, { relaxGoogle: true, relaxFactcheck: true })) take(row);
    }
  }

  return selected.slice(0, limit);
}

module.exports = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 300), 1200);
    const poolLimit = Math.min(Math.max(limit * 8, 1200), 6000);
    const googlePoolLimit = Math.max(20, Math.floor(poolLimit * 0.25));
    const nonGooglePoolLimit = Math.max(120, poolLimit - googlePoolLimit);
    const client = getAnonClient();
    const selectFields =
      "id,source_id,title,summary,category,category_label,confidence,platform,source_domain,source_type,claim_url,reported_on,article_url,image_url,image_type,rights_status,usage_note,published_at,status,incident_key,source_priority";

    const nonGoogleReq = client
      .from("incidents")
      .select(selectFields)
      .not("source_domain", "ilike", "%google.com%")
      .order("published_at", { ascending: false })
      .limit(nonGooglePoolLimit);

    const googleReq = client
      .from("incidents")
      .select(selectFields)
      .ilike("source_domain", "%google.com%")
      .order("published_at", { ascending: false })
      .limit(googlePoolLimit);

    const sourceFallbackSpecs = [
      { key: "snopes", column: "source_domain", op: "ilike", value: "%snopes.com%" },
      { key: "politifact", column: "source_domain", op: "ilike", value: "%politifact.com%" },
      { key: "afp", column: "source_domain", op: "ilike", value: "%factcheck.afp.com%" },
      { key: "fullfact", column: "source_domain", op: "ilike", value: "%fullfact.org%" },
      { key: "leadstories", column: "source_domain", op: "ilike", value: "%leadstories.com%" },
      { key: "bellingcat", column: "source_domain", op: "ilike", value: "%bellingcat.com%" },
      { key: "dfrlab", column: "source_domain", op: "ilike", value: "%dfrlab.org%" },
      { key: "euvsdisinfo", column: "source_domain", op: "ilike", value: "%euvsdisinfo.eu%" },
      { key: "reddit", column: "source_type", op: "eq", value: "social_report" },
      { key: "gdelt", column: "source_type", op: "eq", value: "news" },
      { key: "googlenews", column: "source_domain", op: "ilike", value: "%google.com%" },
    ];
    const sourceFallbackReqs = sourceFallbackSpecs.map((spec) => {
      let q = client.from("incidents").select(selectFields).order("published_at", { ascending: false }).limit(1);
      if (spec.op === "ilike") q = q.ilike(spec.column, spec.value);
      if (spec.op === "eq") q = q.eq(spec.column, spec.value);
      return q;
    });

    const [{ data: nonGoogleData, error: nonGoogleError }, { data: googleData, error: googleError }, ...fallbackResults] = await Promise.all([
      nonGoogleReq,
      googleReq,
      ...sourceFallbackReqs,
    ]);

    if (nonGoogleError) throw nonGoogleError;
    if (googleError) throw googleError;

    const fallbackRows = fallbackResults.flatMap((r) => (r && !r.error && Array.isArray(r.data) ? r.data : []));
    const data = [...(nonGoogleData || []), ...(googleData || []), ...fallbackRows];

    const deduped = dedupeAndFilter(data || []);
    const clean = deduped.slice(0, limit).map((row) => {
      const rawImage = String(row.image_url || "").toLowerCase();
      const shouldStripGenericGoogle =
        isGoogleDomain(row.source_domain) &&
        (/lh3\.googleusercontent\.com/i.test(rawImage) || /lh3\.googleusercontent\.com%2f/i.test(rawImage));
      if (!shouldStripGenericGoogle) return { ...row, ingest_source: deriveIngestSource(row) };
      return {
        ...row,
        image_url: "",
        image_type: "illustrative",
        rights_status: "unknown",
        usage_note: "Google aggregator thumbnail omitted; no article-specific evidence image.",
        ingest_source: deriveIngestSource(row),
      };
    });
    res.status(200).json({ ok: true, incidents: clean });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, incidents: [] });
  }
};
