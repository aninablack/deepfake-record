const { getServiceClient } = require("../lib/supabase");
const { resolveImage } = require("../lib/placeholders");

function isLikelyFallback(url) {
  const value = String(url || "").toLowerCase();
  return value.includes("image.pollinations.ai") || value.startsWith("data:image/svg+xml");
}

function isWeakOrMissingThumb(url) {
  const value = String(url || "").trim().toLowerCase();
  if (!value) return true;
  if (/lh3\.googleusercontent\.com/.test(value)) return true;
  if (/logo|favicon|apple-touch-icon|site-icon|brandmark|wordmark/.test(value)) return true;
  if (/(default[-_]?image|placeholder|fallback-graphics|top_image|og[_-]?image|social[_-]?image|fbshare|site-share|share-image|brand[-_]?image|no-image|coming-soon)/.test(value)) return true;
  return false;
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
      const imageType = String(r.image_type || "").toLowerCase();
      if (imageType !== "documented") return true;
      if (isLikelyFallback(r.image_url)) return true;
      if (isWeakOrMissingThumb(r.image_url)) return true;
      return false;
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
