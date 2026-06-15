const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLOUD_ROOT = path.join(ROOT, "output", "cloud-images");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const { getAssetBaseUrl } = require("./public-url");

function localPublicUrl(sessionId, filename) {
  const base = getAssetBaseUrl();
  const path = `/cloud-images/${sessionId}/${filename}`;
  return base ? `${base}${path}` : path;
}

function cloudinaryConfigured() {
  return Boolean(process.env.CLOUDINARY_CLOUD_NAME);
}

function signCloudinaryParams(params, apiSecret) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(sorted + apiSecret).digest("hex");
}

async function uploadToCloudinary(filePath, sessionId, filename) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return null;

  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;
  const folder = `shipmozo-manuals/${sessionId}`;

  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer]);
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("folder", folder);

  if (uploadPreset) {
    form.append("upload_preset", uploadPreset);
  } else if (apiKey && apiSecret) {
    const timestamp = Math.round(Date.now() / 1000);
    const params = { folder, timestamp };
    const signature = signCloudinaryParams(params, apiSecret);
    form.append("api_key", apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
  } else {
    throw new Error(
      "Cloudinary needs CLOUDINARY_UPLOAD_PRESET or CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET"
    );
  }

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", body: form }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `Cloudinary upload failed (${res.status})`);
  }
  return data.secure_url;
}

async function storeImage(filePath, { sessionId, filename }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Screenshot not found: ${filePath}`);
  }

  const destDir = path.join(CLOUD_ROOT, sessionId);
  ensureDir(destDir);
  const destName = filename || path.basename(filePath);
  const destPath = path.join(destDir, destName);
  fs.copyFileSync(filePath, destPath);

  let cloudUrl = null;
  const skipCloud =
    process.env.SKIP_SCREENSHOTS === "1" || process.env.E2E_FAST === "1";
  const useCloudinary =
    !skipCloud &&
    ((process.env.IMAGE_STORAGE || "").toLowerCase() === "cloudinary" ||
      cloudinaryConfigured());

  if (useCloudinary) {
    try {
      cloudUrl = await uploadToCloudinary(destPath, sessionId, destName);
    } catch (err) {
      console.warn("Cloudinary upload failed, using local URL:", err.message);
    }
  }

  return {
    filename: destName,
    localPath: destPath,
    url: cloudUrl || localPublicUrl(sessionId, destName),
    storage: cloudUrl ? "cloudinary" : "local",
  };
}

async function uploadVideoToCloudinary(filePath, sessionId, filename) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return null;

  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET;
  const folder = `shipmozo-manuals/${sessionId}/videos`;

  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer]);
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("folder", folder);

  if (uploadPreset) {
    form.append("upload_preset", uploadPreset);
  } else if (apiKey && apiSecret) {
    const timestamp = Math.round(Date.now() / 1000);
    const params = { folder, timestamp };
    const signature = signCloudinaryParams(params, apiSecret);
    form.append("api_key", apiKey);
    form.append("timestamp", String(timestamp));
    form.append("signature", signature);
  } else {
    throw new Error(
      "Cloudinary needs CLOUDINARY_UPLOAD_PRESET or CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET"
    );
  }

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
    { method: "POST", body: form }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `Cloudinary video upload failed (${res.status})`);
  }
  return data.secure_url;
}

async function storeVideo(filePath, { sessionId, filename }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video not found: ${filePath}`);
  }

  const destDir = path.join(CLOUD_ROOT, sessionId, "videos");
  ensureDir(destDir);
  const destName = filename || path.basename(filePath);
  const destPath = path.join(destDir, destName);
  fs.copyFileSync(filePath, destPath);

  let cloudUrl = null;
  const skipCloud =
    process.env.SKIP_SCREENSHOTS === "1" || process.env.E2E_FAST === "1";
  const useCloudinary =
    !skipCloud &&
    ((process.env.IMAGE_STORAGE || "").toLowerCase() === "cloudinary" ||
      cloudinaryConfigured());

  if (useCloudinary) {
    try {
      cloudUrl = await uploadVideoToCloudinary(destPath, sessionId, destName);
    } catch (err) {
      console.warn("Cloudinary video upload failed, using local URL:", err.message);
    }
  }

  return {
    filename: destName,
    localPath: destPath,
    url: cloudUrl || localPublicUrl(sessionId, `videos/${destName}`),
    storage: cloudUrl ? "cloudinary" : "local",
    type: "video/webm",
  };
}

async function storeScreenshotBatch(sessionId, shots) {
  const stored = [];
  for (const shot of shots) {
    const out = await storeImage(shot.path, {
      sessionId,
      filename: shot.filename || path.basename(shot.path),
    });
    stored.push({
      id: shot.id,
      label: shot.label,
      step: shot.step,
      ...out,
    });
  }
  return stored;
}

async function storeVideoBatch(sessionId, videos) {
  const stored = [];
  for (const vid of videos || []) {
    const out = await storeVideo(vid.path, {
      sessionId,
      filename: vid.filename || path.basename(vid.path),
    });
    stored.push({
      id: vid.id,
      label: vid.label,
      ...out,
    });
  }
  return stored;
}

module.exports = {
  CLOUD_ROOT,
  getAssetBaseUrl,
  cloudinaryConfigured,
  storeImage,
  storeVideo,
  storeScreenshotBatch,
  storeVideoBatch,
};
