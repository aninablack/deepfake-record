const { getServiceClient } = require('../lib/supabase');
const { config } = require('../lib/config');
const { classifyIncident, platformFromUrl } = require('../lib/classify');
const { resolveImageUrl } = require('../lib/placeholders');
const { scoreWithProviders, blendConfidence } = require('../lib/detectors');

async function fetchGdelt() {
  const params = new URLSearchParams({
    query: config.gdeltQuery,
    mode: 'artlist',
    maxrecords: String(config.gdeltMaxRecords),
    format: 'json',
    sort: 'datedesc',
  });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, { headers: { 'user-agent': 'deepfake-record/1.0' } });
    if (res.ok) {
      const json = await res.json();
      return Array.isArray(json.articles) ? json.articles : [];
    }

    const body = await res.text();
    if (res.status === 429 && attempt < 2) {
      await sleep(6000 * (attempt + 1));
      continue;
    }

    throw new Error(`GDELT request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return [];
}

async function normalize(article, index) {
  const title = (article.title || '').trim();
  const description = (article.seendate ? `Seen ${article.seendate}` : '') + (article.sourcecountry ? ` · ${article.sourcecountry}` : '');
  const classified = classifyIncident(`${title} ${article.domain || ''} ${article.language || ''}`);
  const sourceDomain = article.domain || 'unknown';
  const articleUrl = article.url || null;
  const imageUrl = resolveImageUrl(article);
  const publishedAt = parseSeenDate(article.seendate);

  let providerScores = [];
  if (index < config.detectionMaxItems) {
    providerScores = await scoreWithProviders(article);
  }

  const blended = blendConfidence(classified.score, providerScores);

  return {
    source_id: articleUrl || `${sourceDomain}:${title}`,
    title: title || 'Untitled incident',
    summary: description,
    category: classified.type,
    category_label: classified.label,
    confidence: Number(blended.confidence.toFixed(2)),
    source_domain: sourceDomain,
    platform: platformFromUrl(articleUrl || sourceDomain),
    article_url: articleUrl,
    image_url: imageUrl,
    country: article.sourcecountry || null,
    language: article.language || null,
    published_at: publishedAt,
    status: 'reported_as_synthetic',
  };
}

function parseSeenDate(seenDate) {
  if (!seenDate) return new Date().toISOString();

  const direct = new Date(seenDate);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  const compact = String(seenDate).trim();
  const m = compact.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertIncidents(client, incidents) {
  if (incidents.length === 0) return { inserted: 0 };
  const { error } = await client.from('incidents').upsert(incidents, { onConflict: 'source_id' });
  if (error) throw error;
  return { inserted: incidents.length };
}

async function logIngestRun(client, fetched, upserted) {
  // Optional analytics table for "items scanned" counter.
  const { error } = await client.from('ingest_runs').insert({
    fetched,
    upserted,
    run_at: new Date().toISOString(),
  });
  // Do not fail ingest if this optional table is missing.
  if (error) return false;
  return true;
}

module.exports = async (_req, res) => {
  try {
    const client = getServiceClient();
    const raw = await fetchGdelt();
    const incidents = await Promise.all(raw.map((item, idx) => normalize(item, idx)));
    const result = await upsertIncidents(client, incidents);
    await logIngestRun(client, raw.length, result.inserted);
    res.status(200).json({ ok: true, fetched: raw.length, upserted: result.inserted, at: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
