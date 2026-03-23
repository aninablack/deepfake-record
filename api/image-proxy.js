function sendFallbackImage(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ece8f4"/><stop offset="100%" stop-color="#d8d0e8"/></linearGradient></defs><rect width="1200" height="675" fill="url(#bg)"/><g fill="#7f6b9e" opacity="0.38"><circle cx="200" cy="220" r="170"/><circle cx="1000" cy="180" r="150"/><circle cx="620" cy="540" r="210"/></g><g stroke="#6d5a8a" stroke-width="16" opacity="0.28"><line x1="220" y1="430" x2="980" y2="430"/><line x1="300" y1="495" x2="900" y2="495"/></g></svg>`;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).send(svg);
}

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let response = await fetch(upstream.toString(), {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; DeepfakeRecordImageProxy/1.0)',
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        referer: `${upstream.protocol}//${upstream.host}/`,
      },
    });
    clearTimeout(timeout);

    // Some origins reject hotlinking with referer/user-agent combinations.
    if (!response.ok || !response.body) {
      response = await fetch(upstream.toString(), {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; DeepfakeRecordImageProxy/1.0)',
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
    }

    if (!response.ok || !response.body) {
      sendFallbackImage(res);
      return;
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const cacheControl = response.headers.get('cache-control') || 'public, max-age=3600';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const arrayBuffer = await response.arrayBuffer();
    res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    sendFallbackImage(res);
  }
};
