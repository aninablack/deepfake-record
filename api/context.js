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
    const limit = Math.min(Number(req.query.limit || 24), 60);
    const client = getAnonClient();

    const { data, error } = await client
      .from('context_articles')
      .select('id,source_id,title,summary,topic_label,source_domain,article_url,image_url,published_at')
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    const clean = (data || []).map((row) => ({ ...row, image_url: toProxyUrl(row.image_url) }));
    res.status(200).json({ ok: true, articles: clean });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, articles: [] });
  }
};
