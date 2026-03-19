module.exports = async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ ok: false, error: 'Missing url query parameter' });
      return;
    }

    let upstream;
    try {
      upstream = new URL(rawUrl);
    } catch {
      res.status(400).json({ ok: false, error: 'Invalid url' });
      return;
    }

    if (!/^https?:$/i.test(upstream.protocol)) {
      res.status(400).json({ ok: false, error: 'Only http/https URLs are allowed' });
      return;
    }

    const response = await fetch(upstream.toString(), {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DeepfakeRecordImageProxy/1.0)',
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        referer: `${upstream.protocol}//${upstream.host}/`,
      },
    });

    if (!response.ok || !response.body) {
      res.status(502).json({ ok: false, error: `Upstream returned ${response.status}` });
      return;
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const cacheControl = response.headers.get('cache-control') || 'public, max-age=86400';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const arrayBuffer = await response.arrayBuffer();
    res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Proxy failed' });
  }
};
