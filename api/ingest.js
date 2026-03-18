const { getServiceClient } = require('../lib/supabase');
const { config } = require('../lib/config');
const { classifyIncident, platformFromUrl } = require('../lib/classify');
const { resolveImageUrl } = require('../lib/placeholders');
const { scoreWithProviders, blendConfidence } = require('../lib/detectors');

async function fetchGdelt() {
  return fetchGdeltByQuery(config.gdeltQuery, config.gdeltMaxRecords);
}

async function fetchGdeltContext() {
  try {
    const primary = await fetchGdeltByQuery(config.gdeltContextQuery, config.gdeltContextMaxRecords);
    if (primary.length > 0) return primary;
    const fallbackQuery =
      '(deepfake OR "synthetic media" OR "AI-generated" OR "voice clone" OR "face swap" OR "AI porn" OR "deepfake law")';
    return await fetchGdeltByQuery(fallbackQuery, config.gdeltContextMaxRecords);
  } catch {
    // Context coverage is optional; never fail core incident ingestion.
    return [];
  }
}

async function fetchGdeltByQuery(query, maxrecords) {
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    maxrecords: String(maxrecords),
    format: 'json',
    sort: 'datedesc',
  });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, { headers: { 'user-agent': 'deepfake-record/1.0' } });
    if (res.ok) {
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`GDELT returned non-JSON success payload: ${text.slice(0, 200)}`);
      }
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

function classifyContextTopic(text) {
  const content = (text || '').toLowerCase();
  if (/(law|regulation|bill|act|policy|senate|parliament|legislation)/.test(content)) return 'Policy & Law';
  if (/(election|vote|campaign|democracy|politic|bias)/.test(content)) return 'Politics & Elections';
  if (/(teen|youth|child|school|mental health|body image)/.test(content)) return 'Youth Impact';
  if (/(algorithm|platform|recommendation|feed|moderation|social media)/.test(content)) return 'Platform Effects';
  return 'Public Impact';
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
    image_type: article.socialimage ? 'documented' : 'illustrative',
    rights_status: article.socialimage ? 'link_only' : 'unknown',
    usage_note: article.socialimage ? 'Editorial thumbnail from reporting source.' : 'Illustrative synthetic placeholder; not evidence image.',
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

async function upsertContextArticles(client, articles) {
  if (articles.length === 0) return { inserted: 0 };
  const { error } = await client.from('context_articles').upsert(articles, { onConflict: 'source_id' });
  if (error) throw error;
  return { inserted: articles.length };
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
    let raw = [];
    let warning = null;
    try {
      raw = await fetchGdelt();
    } catch (err) {
      if (String(err.message || '').includes('GDELT request failed (429)')) {
        warning = 'Primary GDELT feed rate-limited; run skipped safely.';
        raw = [];
      } else {
        throw err;
      }
    }
    const rawContext = await fetchGdeltContext();
    const incidents = await Promise.all(raw.map((item, idx) => normalize(item, idx)));
    const contextArticles = rawContext.map((article) => {
      const title = (article.title || '').trim();
      const sourceDomain = article.domain || 'unknown';
      const articleUrl = article.url || null;
      const publishedAt = parseSeenDate(article.seendate);
      const topic = classifyContextTopic(`${title} ${sourceDomain}`);
      return {
        source_id: articleUrl || `${sourceDomain}:${title}`,
        title: title || 'Untitled context article',
        summary:
          (article.seendate ? `Seen ${article.seendate}` : '') +
          (article.sourcecountry ? ` · ${article.sourcecountry}` : ''),
        topic_label: topic,
        source_domain: sourceDomain,
        article_url: articleUrl,
        image_url: resolveImageUrl(article),
        published_at: publishedAt,
      };
    });
    const result = await upsertIncidents(client, incidents);
    const contextResult = await upsertContextArticles(client, contextArticles);
    await logIngestRun(client, raw.length, result.inserted);
    res.status(200).json({
      ok: true,
      fetched: raw.length,
      upserted: result.inserted,
      context_fetched: rawContext.length,
      context_upserted: contextResult.inserted,
      warning,
      at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
