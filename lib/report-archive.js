const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ARCHIVE_ROOT = path.join(ROOT, "output", "reports");
const INDEX_PATH = path.join(ARCHIVE_ROOT, "index.json");
const MANIFEST_PUBLIC_ID = "shipmozo-reports/manifest/reports-index";
let manifestDeliveryUrl = null;

let cloudIndexCache = null;
let cloudIndexLoadedAt = 0;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cloudReportsEnabled() {
  const mode = String(process.env.REPORT_STORAGE || "").toLowerCase();
  if (mode === "cloudinary" || mode === "cloud") return true;
  if (mode === "local" || mode === "filesystem") return false;
  return (
    (process.env.IMAGE_STORAGE || "").toLowerCase() === "cloudinary" ||
    Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.RENDER)
  );
}

function manifestFetchUrl() {
  if (manifestDeliveryUrl) return manifestDeliveryUrl;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud) return null;
  return `https://res.cloudinary.com/${cloud}/raw/upload/${MANIFEST_PUBLIC_ID}`;
}

function readIndexLocal() {
  ensureDir(ARCHIVE_ROOT);
  if (!fs.existsSync(INDEX_PATH)) return { reports: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { reports: [] };
  }
}

function writeIndexLocal(index) {
  ensureDir(ARCHIVE_ROOT);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

function signCloudinaryParams(params, apiSecret) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(sorted + apiSecret).digest("hex");
}

async function fetchUrlText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function uploadRawToCloudinary(content, sessionId, filename, { publicId } = {}) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return null;

  const folder = publicId ? undefined : `shipmozo-reports/${sessionId}`;
  const timestamp = Math.round(Date.now() / 1000);
  const params = publicId
    ? { timestamp, public_id: publicId, overwrite: "true", invalidate: "true" }
    : { folder, timestamp };
  const signature = signCloudinaryParams(params, apiSecret);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  if (folder) form.append("folder", folder);
  if (publicId) {
    form.append("public_id", publicId);
    form.append("overwrite", "true");
    form.append("invalidate", "true");
  }
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `Cloudinary raw upload failed (${res.status})`);
  }
  return data.secure_url;
}

async function uploadManifest(index) {
  if (!cloudReportsEnabled()) return null;
  try {
    const url = await uploadRawToCloudinary(
      JSON.stringify(index, null, 2),
      "_manifest",
      "reports-index.json",
      { publicId: MANIFEST_PUBLIC_ID }
    );
    cloudIndexCache = index;
    cloudIndexLoadedAt = Date.now();
    if (url) manifestDeliveryUrl = url;
    console.log(`[reports] manifest uploaded (${index.reports?.length || 0} reports) -> ${url || "ok"}`);
    return url;
  } catch (err) {
    console.warn("[reports] manifest upload failed:", err.message);
    return null;
  }
}

async function loadCloudIndex(force = false) {
  if (!cloudReportsEnabled()) return null;
  if (!force && cloudIndexCache && Date.now() - cloudIndexLoadedAt < 20_000) {
    return cloudIndexCache;
  }
  const url = manifestFetchUrl();
  if (!url) return null;
  try {
    const text = await fetchUrlText(url);
    if (!text) return null;
    const parsed = JSON.parse(text);
    cloudIndexCache = parsed;
    cloudIndexLoadedAt = Date.now();
    return parsed;
  } catch (err) {
    if (!String(err.message || "").includes("404")) {
      console.warn("[reports] cloud manifest fetch failed:", err.message);
    }
    return null;
  }
}

async function readIndex() {
  const local = readIndexLocal();
  if (!cloudReportsEnabled()) return local;
  const cloud = await loadCloudIndex();
  if (!cloud?.reports?.length) return local;
  if (!local.reports?.length) {
    writeIndexLocal(cloud);
    return cloud;
  }
  const merged = new Map();
  for (const r of [...cloud.reports, ...local.reports]) {
    const prev = merged.get(r.sessionId);
    if (!prev || new Date(r.updatedAt || r.createdAt) > new Date(prev.updatedAt || prev.createdAt)) {
      merged.set(r.sessionId, r);
    }
  }
  const index = { reports: [...merged.values()] };
  writeIndexLocal(index);
  return index;
}

async function persistIndex(index) {
  writeIndexLocal(index);
  if (cloudReportsEnabled()) {
    try {
      await uploadManifest(index);
    } catch (err) {
      console.warn("[reports] manifest upload failed:", err.message);
    }
  }
}

async function syncReportToCloud(report) {
  const useCloud =
    cloudReportsEnabled() ||
    (process.env.IMAGE_STORAGE || "").toLowerCase() === "cloudinary" ||
    Boolean(process.env.CLOUDINARY_CLOUD_NAME);
  if (!useCloud) return null;

  try {
    const jsonUrl = await uploadRawToCloudinary(
      JSON.stringify(report, null, 2),
      report.sessionId,
      "report.json"
    );
    const manualUrl = report.user_manual
      ? await uploadRawToCloudinary(report.user_manual, report.sessionId, "user_manual.md")
      : null;
    const prdUrl = report.prd
      ? await uploadRawToCloudinary(report.prd, report.sessionId, "prd.md")
      : null;
    return { jsonUrl, manualUrl, prdUrl, storage: "cloudinary" };
  } catch (err) {
    console.warn("[reports] cloud sync failed:", err.message);
    return null;
  }
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function chunkManual(manual, moduleName, sessionId) {
  if (!manual) return [];
  const chunks = [];
  const sections = manual.split(/\n(?=##\s+)/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const titleMatch = trimmed.match(/^##\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].trim() : "Overview";
    chunks.push({
      id: `${sessionId}_${slugify(title)}`,
      sessionId,
      moduleName,
      title,
      text: trimmed,
      type: "section",
    });
  }

  const stepRegex = /(?:^|\n)((?:\d+\.\s+.+)(?:\n(?!\d+\.\s|##\s).+)*)/g;
  let match;
  while ((match = stepRegex.exec(manual)) !== null) {
    const text = match[1].trim();
    if (text.length < 20) continue;
    const stepNum = text.match(/^(\d+)\./)?.[1] || "0";
    chunks.push({
      id: `${sessionId}_step_${stepNum}_${slugify(text.slice(0, 40))}`,
      sessionId,
      moduleName,
      title: `Step ${stepNum}`,
      text,
      type: "step",
    });
  }

  return chunks;
}

async function saveReport({
  sessionId,
  moduleName,
  description = "",
  prd = "",
  user_manual = "",
  screenshots = [],
  videos = [],
}) {
  if (!sessionId || !moduleName) {
    throw new Error("sessionId and moduleName are required");
  }

  const createdAt = new Date().toISOString();
  const chunks = chunkManual(user_manual, moduleName, sessionId);

  const report = {
    sessionId,
    moduleName,
    description,
    prd,
    user_manual,
    screenshots,
    videos,
    chunks,
    createdAt,
    updatedAt: createdAt,
  };

  const reportDir = path.join(ARCHIVE_ROOT, sessionId);
  ensureDir(reportDir);
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2), "utf-8");
  if (prd) fs.writeFileSync(path.join(reportDir, "prd.md"), prd, "utf-8");
  if (user_manual) fs.writeFileSync(path.join(reportDir, "user_manual.md"), user_manual, "utf-8");

  const cloud = await syncReportToCloud(report);
  if (cloud) report.cloud = cloud;

  const index = await readIndex();
  const entry = {
    sessionId,
    moduleName,
    description,
    screenshotCount: screenshots.length,
    videoCount: videos.length,
    chunkCount: chunks.length,
    createdAt,
    updatedAt: createdAt,
    cloud: report.cloud || null,
  };

  const existing = index.reports.findIndex((r) => r.sessionId === sessionId);
  if (existing >= 0) index.reports[existing] = { ...index.reports[existing], ...entry };
  else index.reports.unshift(entry);

  await persistIndex(index);
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2), "utf-8");

  return report;
}

async function listReports() {
  const index = await readIndex();
  return index.reports.sort(
    (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
  );
}

function getReportLocal(sessionId) {
  const reportPath = path.join(ARCHIVE_ROOT, sessionId, "report.json");
  if (!fs.existsSync(reportPath)) return null;
  return JSON.parse(fs.readFileSync(reportPath, "utf-8"));
}

async function getReport(sessionId) {
  const local = getReportLocal(sessionId);
  if (local) return local;

  const index = await readIndex();
  const entry = index.reports.find((r) => r.sessionId === sessionId);
  if (entry?.cloud?.jsonUrl) {
    try {
      const text = await fetchUrlText(entry.cloud.jsonUrl);
      const report = JSON.parse(text);
      const reportDir = path.join(ARCHIVE_ROOT, sessionId);
      ensureDir(reportDir);
      fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2), "utf-8");
      return report;
    } catch (err) {
      console.warn(`[reports] cloud load failed for ${sessionId}:`, err.message);
    }
  }
  return null;
}

async function clearAllReports() {
  const index = await readIndex();
  for (const entry of index.reports) {
    const dir = path.join(ARCHIVE_ROOT, entry.sessionId);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  await persistIndex({ reports: [] });
  return { removed: index.reports.length };
}

async function deleteReport(sessionId) {
  if (!sessionId) return;
  const dir = path.join(ARCHIVE_ROOT, sessionId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  const index = await readIndex();
  index.reports = index.reports.filter((r) => r.sessionId !== sessionId);
  await persistIndex(index);
}

async function warmupReportArchive() {
  if (!cloudReportsEnabled()) return { cloud: false, count: readIndexLocal().reports.length };
  const index = await readIndex();
  return { cloud: true, count: index.reports?.length || 0 };
}

module.exports = {
  ARCHIVE_ROOT,
  saveReport,
  listReports,
  getReport,
  deleteReport,
  clearAllReports,
  chunkManual,
  cloudReportsEnabled,
  warmupReportArchive,
};
