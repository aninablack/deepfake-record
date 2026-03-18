const { getAnonClient } = require("../lib/supabase");

module.exports = async (_req, res) => {
  try {
    const client = getAnonClient();

    const [{ count, error: countError }, { data: latestData, error: latestError }, { data: topPlatformData, error: topPlatformError }, { count: verifiedCount, error: verifiedCountError }] = await Promise.all([
      client.from("incidents").select("id", { count: "exact", head: true }),
      client.from("incidents").select("published_at").order("published_at", { ascending: false }).limit(1),
      client.rpc("top_platform"),
      client.from("historical_verified_incidents").select("id", { count: "exact", head: true }),
    ]);

    if (countError) throw countError;
    if (latestError) throw latestError;
    if (topPlatformError) throw topPlatformError;
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
    const latestMinutes = latestIso ? Math.max(1, Math.floor((Date.now() - new Date(latestIso).getTime()) / 60000)) : null;

    res.status(200).json({
      ok: true,
      total: count || 0,
      live_total: count || 0,
      verified_total: verifiedCountError ? 0 : (verifiedCount || 0),
      scanned_total: scannedTotal,
      latest_minutes_ago: latestMinutes,
      top_platform: topPlatformData && topPlatformData[0] ? topPlatformData[0].platform : "Unknown",
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, total: 0, live_total: 0, verified_total: 0, scanned_total: 0, latest_minutes_ago: null, top_platform: "Unknown" });
  }
};
