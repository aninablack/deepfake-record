function sendFallbackImage(res) {
  // Return a non-2xx so <img> triggers onerror in the frontend and can switch
  // to Pollinations/title fallback logic.
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(502).json({ ok: false, error: "Image fetch failed" });
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
