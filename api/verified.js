const { getAnonClient } = require('../lib/supabase');

function toProxyUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/api/image-proxy?')) return raw;
  if (/image\.pollinations\.ai/i.test(raw)) return raw;
  return `/api/image-proxy?url=${encodeURIComponent(raw)}`;
}

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

    const clean = (data || []).map((row) => ({ ...row, image_url: toProxyUrl(row.image_url) }));
    res.status(200).json({ ok: true, incidents: clean });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, incidents: [] });
  }
};
