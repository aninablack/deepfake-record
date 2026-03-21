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

const CATEGORY_STYLES = {
  fraud: [
    'dark editorial illustration',
    'cybercrime digital deception identity theft',
    'muted navy charcoal and deep red tones',
    'shadowy figure at computer screens',
  ].join(', '),
  political: [
    'editorial news photography style illustration',
    'government power democracy media',
    'muted blue grey and white tones',
    'parliament podium microphone broadcast',
  ].join(', '),
  entertainment: [
    'editorial magazine style illustration',
    'celebrity culture media technology',
    'warm muted amber and rose tones',
    'stage screen spotlight spotlight',
  ].join(', '),
};

function extractSubject(title) {
  const stripped = String(title || '')
    .replace(/\s+[-|]\s+\S+(\.\S+)+\s*$/i, '')
    .replace(/\s+[-|]\s+(BBC|CNN|Reuters|AP|Guardian|Times|Post|Record|TechCrunch|Wired|Vice|Politifact|FullFact|Snopes|Bellingcat|Breitbart|NME|Decrypt|Yahoo|Bloomberg|Forbes|Axios)[^-|]*$/i, '')
    .trim();
  return stripped.split(/\s+/).slice(0, 10).join(' ');
}

function buildPollinationsUrl(title, category, summary) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.entertainment;
  const subject = extractSubject(title);
  const context = summary
    ? extractSubject(summary).split(/\s+/).slice(0, 6).join(' ')
    : '';

  const promptParts = [
    style,
    'subject: ' + subject,
    context ? 'context: ' + context : '',
    'photorealistic editorial quality',
    'wide 16:9 format',
    'no text no watermarks no logos no faces distorted',
  ].filter(Boolean).join(', ');

  const encoded = encodeURIComponent(promptParts);
  const seed = Math.abs(
    String(title || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  ) % 99999;

  return 'https://image.pollinations.ai/prompt/' + encoded + '?width=800&height=450&nologo=true&seed=' + seed;
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

  const generated = buildPollinationsUrl(title, category, summary);
  return { url: generated, documented: false };
}

module.exports = { resolveImage, isQualityImage, buildPollinationsUrl };
