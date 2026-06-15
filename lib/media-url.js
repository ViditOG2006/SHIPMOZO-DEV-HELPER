function normalizeMediaSrc(href) {
  const raw = String(href || "").trim();
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("blob:")) {
    return raw;
  }
  if (raw.startsWith("/")) return raw;
  return `/${raw.replace(/^\.?\//, "")}`;
}

function isResolvableMediaUrl(url) {
  const u = normalizeMediaSrc(url);
  if (!u) return false;
  if (/^https?:\/\//i.test(u) || u.startsWith("data:") || u.startsWith("blob:")) return true;
  return u.startsWith("/cloud-images/");
}

function isPlaceholderImageUrl(url) {
  const u = String(url || "").trim().toLowerCase();
  if (!u) return true;
  if (/^https?:\/\//i.test(u)) {
    return /placeholder|example\.com/.test(u) && !u.includes("cloudinary");
  }
  if (u.startsWith("/cloud-images/")) return false;
  return true;
}

function normalizeMarkdownImages(md) {
  return String(md || "").replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    return `![${alt}](${normalizeMediaSrc(url)})`;
  });
}

function extractMarkdownImageUrls(md) {
  const urls = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(String(md || ""))) !== null) {
    urls.push(normalizeMediaSrc(m[1]));
  }
  return urls;
}

function findScreenshotForAlt(alt, screenshots = []) {
  const key = String(alt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!key) return null;

  let best = null;
  let bestScore = 0;

  for (const shot of screenshots) {
    const label = String(shot.label || shot.id || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!label) continue;

    if (label === key) return shot;
    if (label.includes(key) || key.includes(label)) {
      const score = Math.min(label.length, key.length);
      if (score > bestScore) {
        bestScore = score;
        best = shot;
      }
      continue;
    }

    const keyTokens = key.split(/\s+/).filter((t) => t.length > 2);
    const labelTokens = label.split(/\s+/).filter((t) => t.length > 2);
    const overlap = keyTokens.filter((t) => labelTokens.some((lt) => lt.includes(t) || t.includes(lt))).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      best = shot;
    }
  }

  return best;
}

function repairMarkdownImages(md, screenshots = []) {
  const shots = (screenshots || []).filter((s) => s?.url);
  const fallback = shots[0] || null;

  return String(md || "").replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    let fixed = normalizeMediaSrc(url);
    if (isPlaceholderImageUrl(url) || !isResolvableMediaUrl(fixed)) {
      const match = findScreenshotForAlt(alt, shots) || fallback;
      if (match?.url) fixed = normalizeMediaSrc(match.url);
    }
    return `![${alt}](${fixed})`;
  });
}

module.exports = {
  normalizeMediaSrc,
  isResolvableMediaUrl,
  isPlaceholderImageUrl,
  normalizeMarkdownImages,
  extractMarkdownImageUrls,
  findScreenshotForAlt,
  repairMarkdownImages,
};
