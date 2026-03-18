const { getAnonClient } = require('../lib/supabase');

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
    res.status(200).json({ ok: true, articles: data || [] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, articles: [] });
  }
};
