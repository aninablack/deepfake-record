function pollinationsUrl(title) {
  const safe = encodeURIComponent(`editorial abstract redacted synthetic media still, minimal, white background, ${title || "deepfake report"}`);
  return `https://image.pollinations.ai/prompt/${safe}?width=800&height=600&nologo=true`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
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

function parseMetaImage(html, pageUrl) {
  const source = String(html || "");
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["'][^>]*>/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["'][^>]*>/i,
  ];
  for (const re of patterns) {
    const m = source.match(re);
    if (m && m[1]) {
      const absolute = toAbsoluteUrl(m[1], pageUrl);
      if (isHttpUrl(absolute)) return absolute;
    }
  }
  return "";
}

async function fetchArticleImage(pageUrl) {
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
    return parseMetaImage(html, pageUrl);
  } catch {
    return "";
  }
}

async function resolveImage(item) {
  const direct = String(item.socialimage || item.image_url || "").trim();
  if (isHttpUrl(direct)) {
    return { url: direct, documented: true, source: "feed" };
  }
  const pageUrl = String(item.url || "").trim();
  const extracted = await fetchArticleImage(pageUrl);
  if (isHttpUrl(extracted)) {
    return { url: extracted, documented: true, source: "article_meta" };
  }
  return {
    url: pollinationsUrl(item.title || item.headline || "synthetic media incident"),
    documented: false,
    source: "fallback",
  };
}

module.exports = { resolveImage, pollinationsUrl };
