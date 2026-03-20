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

function isLikelyDefaultThumb(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return true;
  return /(default[-_]?image|placeholder|fallback-graphics|top_image|og[_-]?image|social[_-]?image|fbshare|site-share|share-image|brand[-_]?image|no-image|coming-soon|\/themes\/.*og-image|\/theme\/images\/fbshare)/.test(
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

function parseInlineImageCandidates(html, pageUrl) {
  const source = String(html || "");
  const tags = source.match(/<img\b[^>]*>/gi) || [];
  const out = [];
  const srcRe = /\bsrc=["']([^"']+)["']/i;
  const dataSrcRe = /\bdata-(?:src|original|lazy-src|lazyload|image|url)=["']([^"']+)["']/i;
  const altRe = /\balt=["']([^"']*)["']/i;
  const titleRe = /\btitle=["']([^"']*)["']/i;
  const classRe = /\bclass=["']([^"']*)["']/i;
  const widthRe = /\bwidth=["']?(\d{2,4})["']?/i;
  const heightRe = /\bheight=["']?(\d{2,4})["']?/i;
  for (const tag of tags) {
    const src = (tag.match(srcRe)?.[1] || tag.match(dataSrcRe)?.[1] || "").trim();
    const absolute = toAbsoluteUrl(src, pageUrl);
    if (!isHttpUrl(absolute)) continue;
    const width = Number(tag.match(widthRe)?.[1] || 0);
    const height = Number(tag.match(heightRe)?.[1] || 0);
    if ((width && width < 120) || (height && height < 90)) continue;
    const meta = `${tag.match(altRe)?.[1] || ""} ${tag.match(titleRe)?.[1] || ""} ${tag.match(classRe)?.[1] || ""}`.trim();
    out.push({ url: absolute, meta, width, height });
  }
  const uniq = new Map();
  for (const c of out) {
    if (!uniq.has(c.url)) uniq.set(c.url, c);
  }
  return Array.from(uniq.values());
}

async function resolveGoogleNewsArticleUrl(url) {
  if (!isHttpUrl(url)) return "";
  if (!/news\.google\.com/i.test(url)) return canonicalizeUrl(url);
  const extractPublisherUrlFromHtml = (html) => {
    const source = String(html || "");
    const patterns = [
      /https?:\/\/[^\s"'<>]*\/articles\/[^\s"'<>]*/gi,
      /https?:\/\/[^\s"'<>]*\/news\/[^\s"'<>]*/gi,
      /https?:\/\/[^\s"'<>]*\?[^"'<>]*url=([^"'<>]+)/gi,
      /"(https?:\\\/\\\/[^"]+)"/gi,
    ];
    for (const re of patterns) {
      const matches = source.match(re) || [];
      for (const raw of matches) {
        let candidate = String(raw || "");
        if (!candidate) continue;
        const urlParamMatch = candidate.match(/[?&]url=([^&]+)/i);
        if (urlParamMatch && urlParamMatch[1]) {
          candidate = decodeURIComponent(urlParamMatch[1]);
        }
        candidate = candidate.replace(/\\\//g, "/");
        candidate = canonicalizeUrl(candidate);
        if (!candidate) continue;
        if (/news\.google\.com/i.test(candidate)) continue;
        if (!isHttpUrl(candidate)) continue;
        return candidate;
      }
    }
    return "";
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "deepfake-record/1.0 (+image-enrichment)",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timeout);
    const finalUrl = canonicalizeUrl(response.url || "");
    if (finalUrl && !/news\.google\.com/i.test(finalUrl)) return finalUrl;
    const html = await response.text();
    const extracted = extractPublisherUrlFromHtml(html);
    if (extracted) return extracted;
  } catch {
    // best effort only
  }
  return canonicalizeUrl(url);
}

function scoreImage(url, title, meta = "", width = 0, height = 0) {
  const u = String(url || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  const m = String(meta || "").toLowerCase();
  let score = 0;
  if (!u) return -100;
  if (isLikelyLogoImage(u)) score -= 100;
  if (isLikelyDefaultThumb(u)) score -= 45;
  if (isLikelyGenericScene(u)) score -= 15;
  if (/(^|\/)(author|authors|staff|writer|journalist|editor)(\/|$)/.test(u)) score -= 16;
  if (/(headshot|profile|avatar|bio-photo|portrait)/.test(u)) score -= 18;
  if (/(author|staff|writer|journalist|editor|headshot|profile|avatar)/.test(m)) score -= 12;
  if (/pollinations\.ai/.test(u)) score -= 40;
  if (/(wp-content|uploads|cdn|media|images?)/.test(u)) score += 15;
  // Credited editorial/stock wires are acceptable for linked preview cards.
  if (/(getty|gettyimages|shutterstock|alamy|istock|europanewswire|gado|apimages|reuters|afp)/.test(u)) score += 12;
  if (width && height) {
    // Penalize likely author portraits and tiny utility images.
    const ratio = width / Math.max(1, height);
    if (width < 140 || height < 140) score -= 10;
    if (ratio < 0.7 && width <= 420 && height <= 640) score -= 10;
  }
  const titleTokens = t
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 8);
  for (const token of titleTokens) {
    if (u.includes(token)) score += 8;
    if (m.includes(token)) score += 10;
  }
  return score;
}

async function fetchArticleImage(pageUrl, title) {
  if (!isHttpUrl(pageUrl)) return "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        "user-agent": "deepfake-record/1.0 (+image-enrichment)",
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    clearTimeout(timeout);
    if (!response.ok) return "";
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) return "";
    const html = await response.text();
    const metaCandidates = parseMetaImageCandidates(html, pageUrl).map((url) => ({ url, meta: "" }));
    const inlineCandidates = parseInlineImageCandidates(html, pageUrl);
    const candidates = [...metaCandidates, ...inlineCandidates];
    if (!candidates.length) return "";
    const scored = candidates
      .map((c) => {
        let score = scoreImage(c.url, title, c.meta || "", c.width || 0, c.height || 0);
        if (/hero|featured|lead|main-image|article-image/.test(String(c.meta || "").toLowerCase())) score += 12;
        return { u: c.url, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored[0].score >= -5 ? scored[0].u : "";
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
  if (isHttpUrl(direct) && directScore >= -5) {
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
  if (isHttpUrl(extracted) && extractedScore >= -5) {
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
