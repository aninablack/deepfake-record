const { getServiceClient } = require('../lib/supabase');
const {
  classifyIncident,
  platformFromUrl,
  detectReportedPlatforms,
  isDeepfakeRelevant,
  deepfakeRelevanceScore,
  deriveModalities,
  deriveTags,
  deriveHarmLevel,
  deriveSourcePriority,
  buildIncidentKey,
} = require('../lib/classify');
const { resolveImage } = require('../lib/placeholders');

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const rateLimitMap = new Map();

function canonicalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach((k) =>
      u.searchParams.delete(k)
    );
    u.hash = '';
    return u.toString();
  } catch {
    return String(url).trim();
  }
}

function cleanText(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i');
  return html.match(re)?.[1] || '';
}

function firstMatch(html, re) {
  return html.match(re)?.[1] || '';
}

function extractArticleParts(html) {
  const title =
    cleanText(extractMeta(html, 'og:title')) ||
    cleanText(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const summary =
    cleanText(extractMeta(html, 'description')) ||
    cleanText(extractMeta(html, 'og:description')) ||
    cleanText(firstMatch(html, /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i));
  const image = canonicalizeUrl(cleanText(extractMeta(html, 'og:image')) || cleanText(extractMeta(html, 'twitter:image')));
  const articleChunk =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
    html;
  const body = cleanText(articleChunk).slice(0, 1000);
  return { title, summary, image, body };
}

function getIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateLimitMap.get(ip) || [];
  const recent = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return true;
}

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'user-agent': 'deepfake-record-curate/1.0 (+https://deepfake-record.vercel.app)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  }
  const ip = getIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }

  try {
    const payload = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    const inputUrl = canonicalizeUrl(payload.url || '');
    if (!/^https?:\/\//i.test(inputUrl)) {
      return res.status(400).json({ ok: false, reason: 'invalid_url' });
    }

    const page = await fetchWithTimeout(inputUrl, 8000);
    if (!page.ok) {
      return res.status(400).json({ ok: false, reason: `fetch_failed_${page.status}` });
    }
    const finalUrl = canonicalizeUrl(page.url || inputUrl);
    const html = await page.text();
    const { title, summary, image, body } = extractArticleParts(html);
    if (!title) {
      return res.status(400).json({ ok: false, reason: 'missing_title' });
    }

    const sourceDomain = (() => {
      try {
        return new URL(finalUrl).hostname.replace(/^www\./, '').toLowerCase();
      } catch {
        return 'unknown';
      }
    })();
    const relevanceText = `${title} ${summary} ${body}`;
    const sourceHint = `${sourceDomain} ${finalUrl}`;
    const relevanceScore = deepfakeRelevanceScore(title, `${summary} ${body}`, sourceHint);
    const relevant = isDeepfakeRelevant(relevanceText, sourceHint) || relevanceScore >= 1;
    if (!relevant) {
      return res.status(200).json({ ok: false, reason: 'not_relevant' });
    }

    const client = getServiceClient();
    const sourceId = finalUrl;
    const existingBySourceId = await client.from('incidents').select('id,title').eq('source_id', sourceId).limit(1);
    if (!existingBySourceId.error && Array.isArray(existingBySourceId.data) && existingBySourceId.data.length > 0) {
      return res.status(200).json({ ok: true, reason: 'duplicate', title: existingBySourceId.data[0].title || title });
    }
    const existingByUrl = await client.from('incidents').select('id,title').eq('article_url', finalUrl).limit(1);
    if (!existingByUrl.error && Array.isArray(existingByUrl.data) && existingByUrl.data.length > 0) {
      return res.status(200).json({ ok: true, reason: 'duplicate', title: existingByUrl.data[0].title || title });
    }

    const classified = classifyIncident(`${title} ${summary} ${body} ${sourceDomain}`);
    const reportedPlatforms = detectReportedPlatforms(`${title} ${summary} ${body} ${finalUrl}`);
    const imageResolved = await resolveImage(
      { title, description: summary, domain: sourceDomain, socialimage: image || null, url: finalUrl },
      { client }
    );
    const nowIso = new Date().toISOString();
    const confidence = Math.min(0.95, Math.max(0.45, Number(classified.score || 0.7)));
    const row = {
      source_id: sourceId,
      title,
      summary: `${summary} ${body}`.trim().slice(0, 1800),
      category: classified.type,
      category_label: classified.label,
      confidence: Number(confidence.toFixed(2)),
      source_domain: sourceDomain,
      platform: platformFromUrl(finalUrl || sourceDomain),
      source_type: 'community',
      claim_url: null,
      reported_on: reportedPlatforms.length ? reportedPlatforms.join(',') : null,
      article_url: finalUrl,
      image_url: imageResolved.url || null,
      image_type: imageResolved.documented ? 'documented' : 'illustrative',
      rights_status: imageResolved.documented ? 'link_only' : 'unknown',
      usage_note: imageResolved.documented
        ? 'Editorial thumbnail from reporting source.'
        : 'Illustrative synthetic placeholder; not evidence image.',
      country: null,
      language: 'en',
      published_at: nowIso,
      status: 'reported_as_synthetic',
      modalities: deriveModalities(`${title} ${summary} ${body}`),
      tags: deriveTags(`${title} ${summary} ${body}`),
      harm_level: deriveHarmLevel(confidence, `${title} ${summary} ${body}`),
      source_priority: deriveSourcePriority(sourceDomain),
      incident_key: buildIncidentKey(title, classified.type, nowIso),
      ingest_source: 'community',
    };

    const inserted = await client.from('incidents').upsert([row], { onConflict: 'source_id' });
    if (inserted.error) {
      return res.status(500).json({
        ok: false,
        reason: 'insert_failed',
        detail: inserted.error.message || null,
      });
    }
    return res.status(200).json({ ok: true, reason: 'inserted', title });
  } catch {
    return res.status(500).json({ ok: false, reason: 'internal_error' });
  }
};
