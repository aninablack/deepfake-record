const { getServiceClient } = require("../lib/supabase");
const { config } = require("../lib/config");
const { classifyIncident, platformFromUrl } = require("../lib/classify");
const { resolveImageUrl } = require("../lib/placeholders");

async function fetchGdelt() {
  const params = new URLSearchParams({
    query: config.gdeltQuery,
    mode: "artlist",
    maxrecords: String(config.gdeltMaxRecords),
    format: "json",
    sort: "datedesc",
  });

  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
  const res = await fetch(url, { headers: { "user-agent": "deepfake-record/1.0" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GDELT request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return Array.isArray(json.articles) ? json.articles : [];
}

function normalize(article) {
  const title = (article.title || "").trim();
  const description = (article.seendate ? `Seen ${article.seendate}` : "") + (article.sourcecountry ? ` · ${article.sourcecountry}` : "");
  const classified = classifyIncident(`${title} ${article.domain || ""} ${article.language || ""}`);
  const sourceDomain = article.domain || "unknown";
  const articleUrl = article.url || null;
  const imageUrl = resolveImageUrl(article);
  const publishedAt = parseSeenDate(article.seendate);

  return {
    source_id: articleUrl || `${sourceDomain}:${title}`,
    title: title || "Untitled incident",
    summary: description,
    category: classified.type,
    category_label: classified.label,
    confidence: Number(classified.score.toFixed(2)),
    source_domain: sourceDomain,
    platform: platformFromUrl(articleUrl || sourceDomain),
    article_url: articleUrl,
    image_url: imageUrl,
    country: article.sourcecountry || null,
    language: article.language || null,
    published_at: publishedAt,
    status: "reported_as_synthetic",
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

async function upsertIncidents(client, incidents) {
  if (incidents.length === 0) return { inserted: 0 };
  const { error } = await client.from("incidents").upsert(incidents, { onConflict: "source_id" });
  if (error) throw error;
  return { inserted: incidents.length };
}

module.exports = async (req, res) => {
  try {
    const client = getServiceClient();
    const raw = await fetchGdelt();
    const incidents = raw.map(normalize);
    const result = await upsertIncidents(client, incidents);
    res.status(200).json({ ok: true, fetched: raw.length, upserted: result.inserted, at: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
