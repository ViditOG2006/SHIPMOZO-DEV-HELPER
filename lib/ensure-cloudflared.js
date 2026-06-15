const { execSync } = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");

const { isAutoTunnelEnabled, isRenderDeploy } = require("./public-url");

const ROOT = path.join(__dirname, "..");
const BIN_DIR = path.join(ROOT, "bin");
const BUNDLED_WIN = path.join(BIN_DIR, "cloudflared.exe");
const BUNDLED_UNIX = path.join(BIN_DIR, "cloudflared");

const DOWNLOAD_URLS = {
  win32: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
  linux: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
  darwin: "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz",
};

function fileExists(candidate) {
  return Boolean(candidate && candidate !== "cloudflared" && fs.existsSync(candidate));
}

function findOnPath() {
  try {
    const cmd = process.platform === "win32" ? "where.exe cloudflared" : "which cloudflared";
    const out = execSync(cmd, { encoding: "utf8", windowsHide: true }).trim();
    const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (fileExists(first)) return first;
  } catch {
    /* not on PATH */
  }
  return "";
}

function findInstalled() {
  const fromEnv = process.env.CLOUDFLARED_PATH;
  if (fileExists(fromEnv)) return fromEnv;

  const bundled = process.platform === "win32" ? BUNDLED_WIN : BUNDLED_UNIX;
  if (fileExists(bundled)) return bundled;

  const onPath = findOnPath();
  if (onPath) return onPath;

  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Cloudflare", "cloudflared", "cloudflared.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "cloudflared",
      "cloudflared.exe"
    ),
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
  ];

  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }

  return "";
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    const request = (targetUrl) => {
      https
        .get(targetUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            request(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed (${res.statusCode})`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => resolve(dest));
          });
        })
        .on("error", reject);
    };
    request(url);
    file.on("error", reject);
  });
}

async function downloadCloudflared(log) {
  const platform = process.platform;
  const url = DOWNLOAD_URLS[platform];
  if (!url) {
    throw new Error(`Auto-download is not supported on ${platform}`);
  }

  if (platform === "darwin") {
    throw new Error(
      "Install cloudflared on macOS: brew install cloudflared — or set CLOUDFLARED_PATH"
    );
  }

  const dest = platform === "win32" ? BUNDLED_WIN : BUNDLED_UNIX;
  log?.(`Downloading cloudflared to ${dest} …`);
  await downloadFile(url, dest);
  if (platform !== "win32") {
    fs.chmodSync(dest, 0o755);
  }
  log?.("cloudflared downloaded.");
  return dest;
}

async function resolveCloudflaredBinary({ allowDownload = true, log } = {}) {
  if (!isAutoTunnelEnabled() || isRenderDeploy()) {
    return "";
  }

  const existing = findInstalled();
  if (existing) return existing;

  if (!allowDownload) return "";

  try {
    return await downloadCloudflared(log);
  } catch (err) {
    log?.(`Could not download cloudflared: ${err.message}`);
    return "";
  }
}

module.exports = {
  resolveCloudflaredBinary,
  findInstalled,
  BUNDLED_WIN,
  BIN_DIR,
};
