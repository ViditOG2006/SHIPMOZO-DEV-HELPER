const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLOUD_ROOT = path.join(ROOT, "output", "cloud-images");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getPublicBaseUrl() {
  return (
    process.env.PUBLIC_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || 3000}`
  ).replace(/\/$/, "");
}

function localPublicUrl(sessionId, filename) {
  return `${getPublicBaseUrl()}/cloud-images/${sessionId}/${filename}`;
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
  const useCloudinary =
    (process.env.IMAGE_STORAGE || "").toLowerCase() === "cloudinary" ||
    cloudinaryConfigured();

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

module.exports = {
  CLOUD_ROOT,
  getPublicBaseUrl,
  cloudinaryConfigured,
  storeImage,
  storeScreenshotBatch,
};
