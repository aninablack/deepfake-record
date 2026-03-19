const { getServiceClient } = require("../lib/supabase");
const { resolveImage } = require("../lib/placeholders");

function isLikelyFallback(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("image.pollinations.ai") || value.startsWith("data:image/svg+xml");
}

module.exports = async (req, res) => {
  try {
    const client = getServiceClient();
    const limit = Math.min(Number(req.query.limit || 120), 300);

    const { data, error } = await client
      .from("incidents")
      .select("id,title,article_url,image_url,image_type")
      .order("published_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const rows = (data || []).filter((r) => {
      if (!r.article_url) return false;
      if (String(r.image_type || "").toLowerCase() !== "documented") return true;
      return isLikelyFallback(r.image_url);
    });

    let checked = 0;
    let updated = 0;
    let unchanged = 0;

    for (const row of rows) {
      checked += 1;
      const resolved = await resolveImage({
        title: row.title,
        url: row.article_url,
        image_url: "",
        socialimage: "",
      }, { client });

      if (!resolved.documented || !resolved.url) {
        unchanged += 1;
        continue;
      }

      if (String(row.image_url || "").trim() === String(resolved.url).trim() && String(row.image_type || "").toLowerCase() === "documented") {
        unchanged += 1;
        continue;
      }

      const { error: updateError } = await client
        .from("incidents")
        .update({
          image_url: resolved.url,
          image_type: "documented",
          rights_status: "link_only",
          usage_note: "Editorial thumbnail from reporting source.",
        })
        .eq("id", row.id);

      if (updateError) {
        unchanged += 1;
        continue;
      }
      updated += 1;
    }

    res.status(200).json({
      ok: true,
      scanned: rows.length,
      checked,
      updated,
      unchanged,
      at: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
};
