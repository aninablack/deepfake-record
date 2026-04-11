/**
 * lib/placeholders.js
 * Image resolution for deepfake-record incidents.
 *
 * Priority chain:
 *   1. Article socialimage / RSS enclosure / media:content (from ingest)
 *   2. og:image fetched from article URL
 *   3. twitter:image fetched from article URL
 *   4. First <img> in article body above size threshold
 *   5. Pollinations AI generated image (always -- never fall back to title-only)
 *
 * Returns: { url: string, documented: boolean }
 *   documented: true  = real editorial image from source
 *   documented: false = AI-generated placeholder
 */

const QUALITY_MIN_WIDTH = 200;
const FETCH_TIMEOUT_MS = 6000;

const IMAGE_DOMAIN_BLOCKLIST = [
  'googleusercontent.com',
  'gstatic.com',
  'google.com',
  'fbcdn.net',
  'twimg.com',
  'pbs.twimg.com',
  'gravatar.com',
  'wp.com',
];

const IMAGE_PATH_BLOCKLIST = [
  '/author/',
  '/byline/',
  '/staff/',
  '/contributor/',
  '/reporter/',
  '/writer/',
  '/journalist/',
  '/profile/',
  '/avatar/',
  '/headshot/',
  '/bio/',
  '/team/',
  '/people/',
  '/person/',
];

const GENERIC_IMAGE_PATTERNS = [
  /logo/i,
  /favicon/i,
  /apple-touch-icon/i,
  /site-icon/i,
  /brandmark/i,
  /wordmark/i,
  /default[-_]?image/i,
  /placeholder/i,
  /fallback/i,
  /og[-_]?image/i,
  /social[-_]?image/i,
  /fbshare/i,
  /site-share/i,
  /share-image/i,
  /brand[-_]?image/i,
  /no-image/i,
  /coming-soon/i,
  /\/themes\/.*og-image/i,
  /gstatic\.com\/images\/branding/i,
  /news\.google\.com.*(logo|gnews|google-news)/i,
  /(\bcbc\b.*default\.jpg|unindia|nonstoplocal|gray-.*fallback)/i,
];

function isBlockedImageDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return IMAGE_DOMAIN_BLOCKLIST.some(d => hostname.includes(d));
  } catch {
    return false;
  }
}

function isAuthorOrProfileImage(url) {
  const lower = String(url || '').toLowerCase();
  return IMAGE_PATH_BLOCKLIST.some(p => lower.includes(p));
}

function isGenericSiteImage(url) {
  const lower = String(url || '').toLowerCase();
  return GENERIC_IMAGE_PATTERNS.some(re => re.test(lower));
}

function isQualityImage(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) return false;
  if (isBlockedImageDomain(trimmed)) return false;
  if (isAuthorOrProfileImage(trimmed)) return false;
  if (isGenericSiteImage(trimmed)) return false;
  if (/\.(ico|gif|svg)$/i.test(trimmed)) return false;
  return true;
}

async function fetchArticleImage(articleUrl) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        'user-agent': 'deepfake-record/1.0 (+https://deepfake-record.vercel.app)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    if (!res.ok) return null;

    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 50 * 1024;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
      if (totalBytes >= maxBytes) {
        reader.cancel();
        break;
      }
    }

    const html = new TextDecoder().decode(
      chunks.reduce((acc, chunk) => {
        const merged = new Uint8Array(acc.length + chunk.length);
        merged.set(acc);
        merged.set(chunk, acc.length);
        return merged;
      }, new Uint8Array(0))
    );

    const candidates = [];

    const ogImage = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
    ) || html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i
    );
    if (ogImage?.[1]) candidates.push(ogImage[1].trim());

    const ogSecure = html.match(
      /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i
    );
    if (ogSecure?.[1]) candidates.push(ogSecure[1].trim());

    const twitterImage = html.match(
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i
    ) || html.match(
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
    );
    if (twitterImage?.[1]) candidates.push(twitterImage[1].trim());

    const imgTags = html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi);
    for (const match of imgTags) {
      const src = match[1]?.trim();
      if (src && /^https?:\/\//i.test(src)) {
        const widthMatch = match[0].match(/width=["']?(\d+)/i);
        const width = widthMatch ? parseInt(widthMatch[1], 10) : 999;
        if (width >= QUALITY_MIN_WIDTH) {
          candidates.push(src);
          break;
        }
      }
    }

    for (const candidate of candidates) {
      if (isQualityImage(candidate)) return candidate;
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Category-specific SVG placeholder images, returned as base64 data URIs.
 * These replace Pollinations-generated images as fallbacks when no editorial
 * image is available. SVG data URIs:
 *   - load instantly (no external dependency)
 *   - look intentional and on-brand
 *   - are displayed by the frontend as real card images (not the text fallback)
 *
 * Design language: dark background, subtle grid, category icon, accent colour bar.
 *   fraud        → red  (#E53E3E) — network node graph (identity/data breach)
 *   political    → blue (#3182CE) — broadcast signal tower (propaganda/disinfo)
 *   entertainment → amber (#D69E2E) — monitor frame (synthetic screen media)
 */

const _FRAUD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="#0d1117"/><rect width="800" height="450" fill="#1a0808" opacity=".45"/><g stroke="#fff" stroke-opacity=".04" stroke-width="1"><line x1="0" y1="75" x2="800" y2="75"/><line x1="0" y1="150" x2="800" y2="150"/><line x1="0" y1="225" x2="800" y2="225"/><line x1="0" y1="300" x2="800" y2="300"/><line x1="0" y1="375" x2="800" y2="375"/><line x1="133" y1="0" x2="133" y2="450"/><line x1="266" y1="0" x2="266" y2="450"/><line x1="400" y1="0" x2="400" y2="450"/><line x1="533" y1="0" x2="533" y2="450"/><line x1="666" y1="0" x2="666" y2="450"/></g><circle cx="400" cy="218" r="130" fill="#cc1a1a" opacity=".05"/><g stroke="#E53E3E" fill="none"><line x1="280" y1="170" x2="400" y2="218" stroke-opacity=".28" stroke-width="1"/><line x1="522" y1="163" x2="400" y2="218" stroke-opacity=".28" stroke-width="1"/><line x1="465" y1="298" x2="400" y2="218" stroke-opacity=".28" stroke-width="1"/><line x1="318" y1="305" x2="400" y2="218" stroke-opacity=".28" stroke-width="1"/><line x1="220" y1="240" x2="400" y2="218" stroke-opacity=".18" stroke-width="1"/><line x1="572" y1="260" x2="400" y2="218" stroke-opacity=".18" stroke-width="1"/><line x1="280" y1="170" x2="522" y2="163" stroke-opacity=".12" stroke-width="1"/><line x1="522" y1="163" x2="465" y2="298" stroke-opacity=".12" stroke-width="1"/><line x1="465" y1="298" x2="318" y2="305" stroke-opacity=".12" stroke-width="1"/><line x1="318" y1="305" x2="280" y2="170" stroke-opacity=".12" stroke-width="1"/><circle cx="400" cy="218" r="10" fill="#E53E3E" fill-opacity=".75" stroke="none"/><circle cx="280" cy="170" r="5" stroke-opacity=".65" stroke-width="1.5"/><circle cx="522" cy="163" r="5" stroke-opacity=".65" stroke-width="1.5"/><circle cx="465" cy="298" r="5" stroke-opacity=".65" stroke-width="1.5"/><circle cx="318" cy="305" r="5" stroke-opacity=".65" stroke-width="1.5"/><circle cx="220" cy="240" r="4" stroke-opacity=".4" stroke-width="1"/><circle cx="572" cy="260" r="4" stroke-opacity=".4" stroke-width="1"/><circle cx="400" cy="218" r="42" stroke-opacity=".18" stroke-width="1" stroke-dasharray="4 4"/><circle cx="400" cy="218" r="82" stroke-opacity=".09" stroke-width="1" stroke-dasharray="3 6"/></g><rect x="0" y="441" width="800" height="9" fill="#E53E3E" opacity=".35"/><rect x="0" y="441" width="220" height="9" fill="#E53E3E" opacity=".9"/><text x="32" y="424" font-family="monospace" font-size="10" fill="#E53E3E" letter-spacing="3" opacity=".65">FRAUD INCIDENT</text><g fill="none" stroke="#E53E3E" stroke-opacity=".18" stroke-width="1.5"><path d="M14,14 L14,34 M14,14 L34,14"/><path d="M786,14 L786,34 M786,14 L766,14"/><path d="M14,436 L14,416 M14,436 L34,436"/><path d="M786,436 L786,416 M786,436 L766,436"/></g></svg>`;

const _POLITICAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="#0a0e1a"/><rect width="800" height="450" fill="#080c18" opacity=".5"/><g stroke="#fff" stroke-opacity=".04" stroke-width="1"><line x1="0" y1="75" x2="800" y2="75"/><line x1="0" y1="150" x2="800" y2="150"/><line x1="0" y1="225" x2="800" y2="225"/><line x1="0" y1="300" x2="800" y2="300"/><line x1="0" y1="375" x2="800" y2="375"/><line x1="133" y1="0" x2="133" y2="450"/><line x1="266" y1="0" x2="266" y2="450"/><line x1="400" y1="0" x2="400" y2="450"/><line x1="533" y1="0" x2="533" y2="450"/><line x1="666" y1="0" x2="666" y2="450"/></g><g fill="none" stroke="#3182CE"><circle cx="400" cy="210" r="160" fill="#1a4a8a" fill-opacity=".06" stroke="none"/><circle cx="400" cy="210" r="130" stroke-opacity=".07" stroke-width="1" stroke-dasharray="5 5"/><circle cx="400" cy="210" r="90" stroke-opacity=".13" stroke-width="1.5" stroke-dasharray="5 4"/><circle cx="400" cy="210" r="52" stroke-opacity=".28" stroke-width="2" stroke-dasharray="5 3"/><circle cx="400" cy="210" r="12" fill="#3182CE" fill-opacity=".8" stroke="none"/><line x1="400" y1="198" x2="400" y2="72" stroke-opacity=".45" stroke-width="2.5"/><line x1="400" y1="340" x2="368" y2="388" stroke-opacity=".38" stroke-width="2"/><line x1="400" y1="340" x2="432" y2="388" stroke-opacity=".38" stroke-width="2"/><line x1="355" y1="290" x2="445" y2="290" stroke-opacity=".28" stroke-width="1.5"/><line x1="368" y1="315" x2="432" y2="315" stroke-opacity=".18" stroke-width="1"/><circle cx="400" cy="72" r="5" fill="#3182CE" fill-opacity=".6" stroke="none"/></g><rect x="0" y="441" width="800" height="9" fill="#3182CE" opacity=".35"/><rect x="0" y="441" width="220" height="9" fill="#3182CE" opacity=".9"/><text x="32" y="424" font-family="monospace" font-size="10" fill="#3182CE" letter-spacing="3" opacity=".65">POLITICAL INCIDENT</text><g fill="none" stroke="#3182CE" stroke-opacity=".18" stroke-width="1.5"><path d="M14,14 L14,34 M14,14 L34,14"/><path d="M786,14 L786,34 M786,14 L766,14"/><path d="M14,436 L14,416 M14,436 L34,436"/><path d="M786,436 L786,416 M786,436 L766,436"/></g></svg>`;

const _ENTERTAINMENT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450" fill="#0f0d09"/><rect width="800" height="450" fill="#18140a" opacity=".45"/><g stroke="#fff" stroke-opacity=".04" stroke-width="1"><line x1="0" y1="75" x2="800" y2="75"/><line x1="0" y1="150" x2="800" y2="150"/><line x1="0" y1="225" x2="800" y2="225"/><line x1="0" y1="300" x2="800" y2="300"/><line x1="0" y1="375" x2="800" y2="375"/><line x1="133" y1="0" x2="133" y2="450"/><line x1="266" y1="0" x2="266" y2="450"/><line x1="400" y1="0" x2="400" y2="450"/><line x1="533" y1="0" x2="533" y2="450"/><line x1="666" y1="0" x2="666" y2="450"/></g><g fill="none" stroke="#D69E2E"><rect x="232" y="118" width="336" height="210" rx="8" stroke-opacity=".45" stroke-width="2.5"/><rect x="244" y="130" width="312" height="186" rx="5" stroke-opacity=".2" stroke-width="1"/><line x1="232" y1="192" x2="568" y2="192" stroke-opacity=".14" stroke-width="1"/><line x1="232" y1="225" x2="568" y2="225" stroke-opacity=".14" stroke-width="1"/><line x1="232" y1="258" x2="568" y2="258" stroke-opacity=".1" stroke-width="1"/><line x1="232" y1="291" x2="568" y2="291" stroke-opacity=".08" stroke-width="1"/><line x1="350" y1="328" x2="450" y2="328" stroke-opacity=".32" stroke-width="2"/><line x1="372" y1="328" x2="372" y2="356" stroke-opacity=".32" stroke-width="2"/><line x1="428" y1="328" x2="428" y2="356" stroke-opacity=".32" stroke-width="2"/><line x1="338" y1="356" x2="462" y2="356" stroke-opacity=".32" stroke-width="2"/></g><ellipse cx="400" cy="223" rx="68" ry="55" fill="#D69E2E" opacity=".07"/><circle cx="400" cy="223" r="9" fill="#D69E2E" opacity=".75"/><line x1="400" y1="118" x2="400" y2="214" stroke="#D69E2E" stroke-opacity=".25" stroke-width="1.5"/><g stroke="#D69E2E" stroke-opacity=".12" stroke-width="1" fill="none"><line x1="210" y1="98" x2="232" y2="118"/><line x1="590" y1="98" x2="568" y2="118"/><line x1="210" y1="348" x2="232" y2="328"/><line x1="590" y1="348" x2="568" y2="328"/></g><rect x="0" y="441" width="800" height="9" fill="#D69E2E" opacity=".35"/><rect x="0" y="441" width="220" height="9" fill="#D69E2E" opacity=".9"/><text x="32" y="424" font-family="monospace" font-size="10" fill="#D69E2E" letter-spacing="3" opacity=".65">SYNTHETIC MEDIA</text><g fill="none" stroke="#D69E2E" stroke-opacity=".18" stroke-width="1.5"><path d="M14,14 L14,34 M14,14 L34,14"/><path d="M786,14 L786,34 M786,14 L766,14"/><path d="M14,436 L14,416 M14,436 L34,436"/><path d="M786,436 L786,416 M786,436 L766,436"/></g></svg>`;

// Pre-encode once at module load — no runtime encoding cost per request
const _SVG_PLACEHOLDERS = (() => {
  const enc = (svg) => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return {
    fraud:         enc(_FRAUD_SVG),
    political:     enc(_POLITICAL_SVG),
    entertainment: enc(_ENTERTAINMENT_SVG),
  };
})();

function buildCategoryPlaceholder(category) {
  const key = String(category || '').toLowerCase();
  return _SVG_PLACEHOLDERS[key] || _SVG_PLACEHOLDERS.entertainment;
}

async function resolveImage(article, opts) {
  const title = String(article.title || '').trim();
  const summary = String(article.description || article.summary || '').trim();
  const articleUrl = String(article.url || article.article_url || '').trim();
  const category = String(article.category || 'entertainment').toLowerCase();

  const socialImage = String(article.socialimage || '').trim();
  if (socialImage && isQualityImage(socialImage)) {
    return { url: socialImage, documented: true };
  }

  if (articleUrl && !/news\.google\.com/i.test(articleUrl)) {
    const fetched = await fetchArticleImage(articleUrl);
    if (fetched && isQualityImage(fetched)) {
      return { url: fetched, documented: true };
    }
  }

  const generated = buildCategoryPlaceholder(category);
  return { url: generated, documented: false };
}

module.exports = { resolveImage, isQualityImage, buildCategoryPlaceholder };
