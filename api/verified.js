const { getAnonClient } = require('../lib/supabase');

module.exports = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 120), 300);
    const client = getAnonClient();

    const { data, error } = await client
      .from('historical_verified_incidents')
      .select('id,source_id,title,summary,category,category_label,confidence,platform,source_domain,source_url,image_url,image_type,rights_status,usage_note,published_at,status')
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.status(200).json({ ok: true, incidents: data || [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, incidents: [] });
  }
};
