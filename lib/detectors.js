const { config } = require('./config');

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractConfidence(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const directKeys = ['confidence', 'score', 'probability', 'likelihood', 'deepfake_confidence'];
  for (const key of directKeys) {
    const v = toNumber(payload[key]);
    if (v !== null) return normalizeScore(v);
  }

  const nestedKeys = ['result', 'data', 'output', 'prediction'];
  for (const key of nestedKeys) {
    const v = extractConfidence(payload[key]);
    if (v !== null) return v;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const v = extractConfidence(item);
      if (v !== null) return v;
    }
  }

  return null;
}

function normalizeScore(v) {
  if (v <= 1) return Math.max(0, Math.min(1, v));
  if (v <= 100) return Math.max(0, Math.min(1, v / 100));
  return null;
}

async function callDetector({ name, url, apiKey, article, timeoutMs }) {
  if (!url || !apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      article_url: article.url || null,
      image_url: article.socialimage || null,
      title: article.title || null,
      text: `${article.title || ''} ${article.domain || ''}`.trim(),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const payload = await res.json();
    const confidence = extractConfidence(payload);
    if (confidence === null) return null;

    return { name, confidence };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function scoreWithProviders(article) {
  const timeoutMs = config.detectionTimeoutMs;
  const [hive, realityDefender] = await Promise.all([
    callDetector({
      name: 'hive',
      url: config.hiveApiUrl,
      apiKey: config.hiveApiKey,
      article,
      timeoutMs,
    }),
    callDetector({
      name: 'reality_defender',
      url: config.realityDefenderApiUrl,
      apiKey: config.realityDefenderApiKey,
      article,
      timeoutMs,
    }),
  ]);

  return [hive, realityDefender].filter(Boolean);
}

function blendConfidence(baseScore, providerScores) {
  if (!providerScores || providerScores.length === 0) {
    return { confidence: baseScore, method: 'heuristic_only' };
  }

  const providerAvg = providerScores.reduce((acc, p) => acc + p.confidence, 0) / providerScores.length;
  const blended = (baseScore * 0.5) + (providerAvg * 0.5);

  return {
    confidence: Math.max(0, Math.min(1, blended)),
    method: `heuristic+${providerScores.map((p) => p.name).join('+')}`,
  };
}

module.exports = { scoreWithProviders, blendConfidence };
