const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ARCHIVE_ROOT = path.join(ROOT, "output", "reports");
const INDEX_PATH = path.join(ARCHIVE_ROOT, "index.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readIndex() {
  ensureDir(ARCHIVE_ROOT);
  if (!fs.existsSync(INDEX_PATH)) return { reports: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { reports: [] };
  }
}

function writeIndex(index) {
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

async function uploadRawToCloudinary(content, sessionId, filename) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) return null;

  const folder = `shipmozo-reports/${sessionId}`;
  const timestamp = Math.round(Date.now() / 1000);
  const params = { folder, timestamp };
  const signature = signCloudinaryParams(params, apiSecret);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("folder", folder);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("resource_type", "raw");

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

async function syncReportToCloud(report) {
  const useCloud =
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
    console.warn("Report cloud sync failed:", err.message);
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

  const index = readIndex();
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

  writeIndex(index);
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2), "utf-8");

  return report;
}

function listReports() {
  const index = readIndex();
  return index.reports.sort(
    (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
  );
}

function getReport(sessionId) {
  const reportPath = path.join(ARCHIVE_ROOT, sessionId, "report.json");
  if (!fs.existsSync(reportPath)) return null;
  return JSON.parse(fs.readFileSync(reportPath, "utf-8"));
}

function clearAllReports() {
  const index = readIndex();
  for (const entry of index.reports) {
    const dir = path.join(ARCHIVE_ROOT, entry.sessionId);
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  writeIndex({ reports: [] });
  return { removed: index.reports.length };
}

function deleteReport(sessionId) {
  if (!sessionId) return;
  const dir = path.join(ARCHIVE_ROOT, sessionId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // ignore filesystem errors, index update still proceeds
  }

  const index = readIndex();
  index.reports = index.reports.filter((r) => r.sessionId !== sessionId);
  writeIndex(index);
}

module.exports = {
  ARCHIVE_ROOT,
  saveReport,
  listReports,
  getReport,
  deleteReport,
  clearAllReports,
  chunkManual,
};
