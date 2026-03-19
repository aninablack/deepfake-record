function sendFallbackImage(res) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><rect width="1200" height="675" fill="#e9e6f0"/><g fill="#6f5a8d" opacity="0.55"><circle cx="260" cy="210" r="150"/><circle cx="960" cy="180" r="130"/></g><text x="600" y="360" font-family="Georgia,serif" font-size="44" text-anchor="middle" fill="#241a33">Image unavailable</text><text x="600" y="410" font-family="Arial,sans-serif" font-size="22" text-anchor="middle" fill="#4b3b66">Showing headline-only card</text></svg>`;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
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
    const cacheControl = response.headers.get('cache-control') || 'public, max-age=86400';

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
