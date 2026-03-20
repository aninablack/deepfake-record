const { getServiceClient } = require("../lib/supabase");
const { resolveImage } = require("../lib/placeholders");

module.exports = async (req, res) => {
  try {
    const client = getServiceClient();
    const limit = Math.min(Number(req.query.limit || 500), 800);

    const { data, error } = await client
      .from("incidents")
      .select("id,title,article_url,image_url,image_type,source_domain,source_type,published_at")
      .order("published_at", { ascending: false })
      .limit(Math.min(limit * 3, 2000));

    if (error) throw error;

    const rows = (data || []).filter((r) => {
      const sourceDomain = String(r.source_domain || "").toLowerCase();
      const isGoogle = sourceDomain.includes("google.com") || sourceDomain.includes("news.google.com");
      if (!isGoogle) return false;
      const imageType = String(r.image_type || "").toLowerCase();
      const imageUrl = String(r.image_url || "").trim();
      const lowUrl = imageUrl.toLowerCase();
      const unusableGoogleThumb =
        /lh3\.googleusercontent\.com/.test(lowUrl) ||
        /default[-_]?image|placeholder|fallback|og[_-]?image|social[_-]?image|fbshare|site-share|share-image|brand[-_]?image|no-image|coming-soon/.test(
          lowUrl
        ) ||
        /favicon|apple-touch-icon|site-icon|wordmark|brandmark|logo/.test(lowUrl);
      if (!imageUrl || imageType !== "documented") return true;
      return unusableGoogleThumb;
    }).slice(0, limit);

    let checked = 0;
    let updated = 0;
    let unchanged = 0;

    for (const row of rows) {
      checked += 1;
      const resolved = await resolveImage(
        {
          title: row.title,
          url: row.article_url,
          image_url: "",
          socialimage: "",
          source_type: row.source_type || "factcheck",
        },
        { client }
      );

      if (!resolved.documented || !resolved.url) {
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
