function pollinationsUrl(title) {
  const safe = encodeURIComponent(
    `editorial news illustration about synthetic media incident, ${title || "deepfake report"}, no logos, no product shots, no random landscapes, no food closeups`
  );
  return `https://image.pollinations.ai/prompt/${safe}?width=800&height=600&nologo=true`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function canonicalizeUrl(url) {
  if (!isHttpUrl(url)) return "";
  try {
    const u = new URL(url);
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "gclid",
      "fbclid",
      "mc_cid",
      "mc_eid",
      "oc",
    ].forEach((k) => u.searchParams.delete(k));
    u.hash = "";
    return u.toString();
  } catch {
    return String(url || "").trim();
  }
}

function isLikelyLogoImage(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return true;
  return (
    /logo|favicon|apple-touch-icon|site-icon|brandmark|wordmark/.test(u) ||
    /gstatic\.com\/images\/branding/.test(u) ||
    /news\.google\.com.*(logo|gnews|google-news)/.test(u)
  );
}

function isLikelyGenericScene(url) {
  const u = String(url || "").toLowerCase();
  return /(road|mountain|landscape|forest|beach|food|onion|coffee[-_]?beans|shells|city-night|stock-photo|unsplash)/.test(
    u
  );
}

function toAbsoluteUrl(candidate, baseUrl) {
  if (!candidate) return "";
  const raw = String(candidate).trim();
  if (!raw) return "";
  if (isHttpUrl(raw)) return raw;
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

function parseMetaImageCandidates(html, pageUrl) {
  const source = String(html || "");
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
  ];
  const out = [];
  for (const re of patterns) {
    const matches = source.matchAll(new RegExp(re.source, "gi"));
    for (const m of matches) {
      if (!m || !m[1]) continue;
      const absolute = toAbsoluteUrl(m[1], pageUrl);
      if (!isHttpUrl(absolute)) continue;
      out.push(absolute);
    }
  }
  return Array.from(new Set(out));
}

async function resolveGoogleNewsArticleUrl(url) {
  if (!isHttpUrl(url)) return "";
  if (!/news\.google\.com/i.test(url)) return canonicalizeUrl(url);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "deepfake-record/1.0 (+image-enrichment)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timeout);
    const finalUrl = canonicalizeUrl(response.url || "");
    if (finalUrl && !/news\.google\.com/i.test(finalUrl)) return finalUrl;
  } catch {
    // best effort only
  }
  return canonicalizeUrl(url);
}

function scoreImage(url, title) {
  const u = String(url || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  let score = 0;
  if (!u) return -100;
  if (isLikelyLogoImage(u)) score -= 100;
  if (isLikelyGenericScene(u)) score -= 30;
  if (/pollinations\.ai/.test(u)) score -= 40;
  if (/(wp-content|uploads|cdn|media|images?)/.test(u)) score += 15;
  const titleTokens = t
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 8);
  for (const token of titleTokens) {
    if (u.includes(token)) score += 8;
  }
  return score;
}

async function fetchArticleImage(pageUrl, title) {
  if (!isHttpUrl(pageUrl)) return "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "deepfake-record/1.0 (+image-enrichment)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return "";
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) return "";
    const html = await response.text();
    const candidates = parseMetaImageCandidates(html, pageUrl);
    if (!candidates.length) return "";
    const scored = candidates
      .map((u) => ({ u, score: scoreImage(u, title) }))
      .sort((a, b) => b.score - a.score);
    return scored[0].score >= 0 ? scored[0].u : "";
  } catch {
    return "";
  }
}

async function getCachedThumb(client, articleUrl) {
  if (!client || !articleUrl) return null;
  try {
    const { data, error } = await client
      .from("thumbnail_cache")
      .select("resolved_url,documented,source,status,quality_score")
      .eq("article_url", articleUrl)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

async function upsertCachedThumb(client, payload) {
  if (!client || !payload?.article_url) return;
  try {
    await client.from("thumbnail_cache").upsert(payload, { onConflict: "article_url" });
  } catch {
    // non-blocking
  }
}

async function resolveImage(item, options = {}) {
  const client = options.client || null;
  const rawPageUrl = String(item.url || "").trim();
  const pageUrl = await resolveGoogleNewsArticleUrl(rawPageUrl);
  const cacheKey = canonicalizeUrl(pageUrl || rawPageUrl);
  const title = item.title || item.headline || "synthetic media incident";

  const cached = await getCachedThumb(client, cacheKey);
  if (cached) {
    const cachedUrl = String(cached.resolved_url || "").trim();
    if (cached.status === "accepted" && isHttpUrl(cachedUrl)) {
      return {
        url: cachedUrl,
        documented: Boolean(cached.documented),
        source: cached.source || "cache",
      };
    }
  }

  const direct = String(item.socialimage || item.image_url || "").trim();
  const directScore = scoreImage(direct, title);
  if (isHttpUrl(direct) && directScore >= 0) {
    await upsertCachedThumb(client, {
      article_url: cacheKey,
      resolved_url: direct,
      documented: true,
      source: "feed",
      quality_score: directScore,
      status: "accepted",
      checked_at: new Date().toISOString(),
      note: "Accepted direct feed/social image.",
    });
    return { url: direct, documented: true, source: "feed" };
  }
  const extracted = await fetchArticleImage(pageUrl, title);
  const extractedScore = scoreImage(extracted, title);
  if (isHttpUrl(extracted) && extractedScore >= 0) {
    await upsertCachedThumb(client, {
      article_url: cacheKey,
      resolved_url: extracted,
      documented: true,
      source: "article_meta",
      quality_score: extractedScore,
      status: "accepted",
      checked_at: new Date().toISOString(),
      note: "Accepted meta image from article page.",
    });
    return { url: extracted, documented: true, source: "article_meta" };
  }
  const fallback = pollinationsUrl(title);
  await upsertCachedThumb(client, {
    article_url: cacheKey,
    resolved_url: fallback,
    documented: false,
    source: "fallback",
    quality_score: -10,
    status: "fallback",
    checked_at: new Date().toISOString(),
    note: "No acceptable documented image found; generated fallback.",
  });
  return {
    url: fallback,
    documented: false,
    source: "fallback",
  };
}

module.exports = { resolveImage, pollinationsUrl };
