function pollinationsUrl(title) {
  const safe = encodeURIComponent(`editorial abstract redacted synthetic media still, minimal, white background, ${title || "deepfake report"}`);
  return `https://image.pollinations.ai/prompt/${safe}?width=800&height=600&nologo=true`;
}

function resolveImageUrl(item) {
  const direct = item.socialimage || item.image_url || "";
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  return pollinationsUrl(item.title || item.headline || "synthetic media incident");
}

module.exports = { resolveImageUrl, pollinationsUrl };
