const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT, "output", "runtime");
const PUBLIC_URL_FILE = path.join(RUNTIME_DIR, "public-url.txt");

let memoryUrl = "";
let tunnelStatus = "off"; // off | starting | ready | failed
let tunnelError = "";

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function clearRuntimePublicUrl() {
  memoryUrl = "";
  tunnelError = "";
  tunnelStatus = isAutoTunnelEnabled() ? "starting" : "off";
  try {
    if (fs.existsSync(PUBLIC_URL_FILE)) fs.unlinkSync(PUBLIC_URL_FILE);
  } catch {
    /* ignore */
  }
}

function getTunnelStatus() {
  return tunnelStatus;
}

function getTunnelError() {
  return tunnelError;
}

function setTunnelFailed(message) {
  tunnelStatus = "failed";
  tunnelError = String(message || "Tunnel failed").trim();
  memoryUrl = "";
  try {
    if (fs.existsSync(PUBLIC_URL_FILE)) fs.unlinkSync(PUBLIC_URL_FILE);
  } catch {
    /* ignore */
  }
}

function invalidateTunnelUrl() {
  memoryUrl = "";
  if (tunnelStatus === "ready") {
    tunnelStatus = "failed";
    tunnelError = tunnelError || "Tunnel disconnected — use localhost URL";
  }
  try {
    if (fs.existsSync(PUBLIC_URL_FILE)) fs.unlinkSync(PUBLIC_URL_FILE);
  } catch {
    /* ignore */
  }
}

function setRuntimePublicUrl(url) {
  const clean = String(url || "").trim().replace(/\/$/, "");
  if (!clean) return;
  memoryUrl = clean;
  tunnelStatus = "ready";
  tunnelError = "";
  try {
    ensureRuntimeDir();
    fs.writeFileSync(PUBLIC_URL_FILE, clean, "utf-8");
  } catch {
    /* ignore */
  }
}

function getRuntimePublicUrl() {
  if (tunnelStatus !== "ready" && tunnelStatus !== "starting") {
    return "";
  }
  if (memoryUrl) return memoryUrl;
  try {
    if (fs.existsSync(PUBLIC_URL_FILE)) {
      const fromFile = fs.readFileSync(PUBLIC_URL_FILE, "utf-8").trim();
      if (fromFile) {
        memoryUrl = fromFile;
        return fromFile;
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

function getLocalBaseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function tunnelUrlIsActive() {
  return tunnelStatus === "ready" && Boolean(getRuntimePublicUrl());
}

/** Shareable URL (phone / remote). Only valid while tunnel process is running. */
function getPublicBaseUrl() {
  if (tunnelUrlIsActive()) {
    return getRuntimePublicUrl();
  }
  const env = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (env && tunnelStatus !== "failed") return env.replace(/\/$/, "");
  return getLocalBaseUrl();
}

/** Screenshot paths — relative so they work on localhost and active tunnel (never embed dead trycloudflare URLs). */
function getAssetBaseUrl() {
  return "";
}

function getRecommendedAppUrl() {
  return tunnelUrlIsActive() ? getRuntimePublicUrl() : getLocalBaseUrl();
}

function isAutoTunnelEnabled() {
  const flag = String(process.env.PUBLIC_TUNNEL || "true").toLowerCase();
  return !["0", "false", "no", "off"].includes(flag);
}

module.exports = {
  clearRuntimePublicUrl,
  setRuntimePublicUrl,
  getRuntimePublicUrl,
  getPublicBaseUrl,
  getAssetBaseUrl,
  getRecommendedAppUrl,
  getLocalBaseUrl,
  getTunnelStatus,
  getTunnelError,
  setTunnelFailed,
  invalidateTunnelUrl,
  isAutoTunnelEnabled,
  tunnelUrlIsActive,
  PUBLIC_URL_FILE,
};
