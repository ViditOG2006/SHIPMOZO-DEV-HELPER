const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT, "output", "runtime");

function healProgressPath(runId) {
  if (!runId) return null;
  const safe = String(runId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(RUNTIME_DIR, `heal-progress-${safe}.json`);
}

function readHealProgress(runId) {
  const filePath = healProgressPath(runId);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function clearHealProgress(runId) {
  const filePath = healProgressPath(runId);
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

function writeHealProgress(runId, payload = {}) {
  const filePath = healProgressPath(runId);
  if (!filePath) return;
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const prev = readHealProgress(runId) || {};
  const next = {
    ...prev,
    ...payload,
    updatedAt: Date.now(),
    attempts: payload.attempts !== undefined ? payload.attempts : prev.attempts || [],
    logLines: payload.logLines !== undefined ? payload.logLines : prev.logLines || [],
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf-8");
}

function appendRunLog(runId, line) {
  const text = String(line || "").trim();
  if (!runId || !text) return;
  const filePath = healProgressPath(runId);
  if (!filePath) return;
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const prev = readHealProgress(runId) || {};
  const logLines = [...(prev.logLines || []), text];
  const next = { ...prev, logLines, updatedAt: Date.now() };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf-8");
}

module.exports = {
  healProgressPath,
  readHealProgress,
  clearHealProgress,
  writeHealProgress,
  appendRunLog,
};
