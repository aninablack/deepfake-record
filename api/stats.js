const { getAnonClient } = require("../lib/supabase");

function prettyPlatform(value) {
  const v = String(value || "").toLowerCase();
  if (!v) return "Unknown";
  if (v.includes("news.google.")) return "Google News";
  if (v.includes("reddit")) return "Reddit";
  if (v.includes("x.com") || v === "x" || v.includes("twitter")) return "X";
  if (v.includes("youtube")) return "YouTube";
  if (v.includes("instagram")) return "Instagram";
  if (v.includes("tiktok")) return "TikTok";
  if (v.includes("facebook")) return "Facebook";
  if (v.includes("whatsapp")) return "WhatsApp";
  if (v.includes("telegram")) return "Telegram";
  if (value === "Unknown") return "Unknown";
  return String(value).replace(/^www\./i, "");
}

function normalizeDomain(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function isGoogleDomain(value) {
  const d = normalizeDomain(value);
  return d === "news.google.com" || d.endsWith(".news.google.com") || d.includes("google.com");
}

module.exports = async (_req, res) => {
  try {
    const client = getAnonClient();

    const [{ count, error: countError }, { data: latestData, error: latestError }, { data: topPlatformData, error: topPlatformError }, { count: verifiedCount, error: verifiedCountError }, { count: archivedEventsCount, error: archivedEventsError }, { data: shownPool, error: shownPoolError }, { data: latestRunData, error: latestRunError }] = await Promise.all([
      client.from("incidents").select("id", { count: "exact", head: true }),
      client.from("incidents").select("published_at").order("published_at", { ascending: false }).limit(1),
      client.rpc("top_platform"),
      client.from("historical_verified_incidents").select("id", { count: "exact", head: true }),
      client.from("incident_events").select("id", { count: "exact", head: true }),
      client.from("incidents").select("platform,source_domain,published_at").order("published_at", { ascending: false }).limit(200),
      client.from("ingest_runs").select("run_at").order("run_at", { ascending: false }).limit(1),
    ]);

    if (countError) throw countError;
    if (latestError) throw latestError;
    if (topPlatformError) throw topPlatformError;
    if (shownPoolError) throw shownPoolError;
    if (latestRunError) throw latestRunError;
    if (verifiedCountError) {
      // Keep stats endpoint alive even before archive table migration runs.
      // verified_total will simply remain 0 until the table exists.
    }

    let scannedTotal = count || 0;
    const scannedQuery = await client.from("ingest_runs").select("fetched");
    if (!scannedQuery.error && Array.isArray(scannedQuery.data)) {
      scannedTotal = scannedQuery.data.reduce((acc, row) => acc + (Number(row.fetched) || 0), 0);
    }

    const latestIso = latestData && latestData[0] ? latestData[0].published_at : null;
    const latestIncidentMinutes = latestIso ? Math.max(1, Math.floor((Date.now() - new Date(latestIso).getTime()) / 60000)) : null;
    const latestRunIso = latestRunData && latestRunData[0] ? latestRunData[0].run_at : null;
    const latestRunMinutes = latestRunIso ? Math.max(1, Math.floor((Date.now() - new Date(latestRunIso).getTime()) / 60000)) : null;
    const shownRows = Array.isArray(shownPool) ? shownPool.slice(0, 40) : [];
    const shownPlatformCounts = new Map();
    for (const row of shownRows) {
      if (isGoogleDomain(row.source_domain)) continue;
      const key = prettyPlatform(row.platform || row.source_domain || "Unknown");
      shownPlatformCounts.set(key, (shownPlatformCounts.get(key) || 0) + 1);
    }
    const shownTop = Array.from(shownPlatformCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];

    res.status(200).json({
      ok: true,
      total: count || 0,
      live_total: count || 0,
      verified_total: verifiedCountError ? 0 : (verifiedCount || 0),
      archived_total: archivedEventsError ? 0 : (archivedEventsCount || 0),
      scanned_total: scannedTotal,
      latest_minutes_ago: latestRunMinutes,
      latest_ingest_at: latestRunIso,
      latest_ingest_minutes_ago: latestRunMinutes,
      latest_incident_at: latestIso,
      latest_incident_minutes_ago: latestIncidentMinutes,
      top_platform: prettyPlatform(topPlatformData && topPlatformData[0] ? topPlatformData[0].platform : "Unknown"),
      top_platform_all: prettyPlatform(topPlatformData && topPlatformData[0] ? topPlatformData[0].platform : "Unknown"),
      top_platform_shown: shownTop || prettyPlatform(topPlatformData && topPlatformData[0] ? topPlatformData[0].platform : "Unknown"),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      total: 0,
      live_total: 0,
      verified_total: 0,
      archived_total: 0,
      scanned_total: 0,
      latest_minutes_ago: null,
      latest_ingest_at: null,
      latest_ingest_minutes_ago: null,
      latest_incident_at: null,
      latest_incident_minutes_ago: null,
      top_platform: "Unknown",
      top_platform_all: "Unknown",
      top_platform_shown: "Unknown"
    });
  }
};
