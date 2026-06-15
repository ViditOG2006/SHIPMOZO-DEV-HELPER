const { spawn } = require("child_process");
const { resolveCloudflaredBinary } = require("./ensure-cloudflared");
const {
  setRuntimePublicUrl,
  setTunnelFailed,
  invalidateTunnelUrl,
  isAutoTunnelEnabled,
} = require("./public-url");

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/gi;

function extractTunnelUrl(text) {
  const matches = String(text || "").match(TUNNEL_URL_RE);
  if (!matches || !matches.length) return "";
  return matches[matches.length - 1].replace(/[|.\s]+$/, "");
}

function startCloudflareTunnel(port, { cloudflaredPath, onUrl, onLog } = {}) {
  if (!isAutoTunnelEnabled()) {
    return null;
  }
  const cloudflared = cloudflaredPath || "cloudflared";
  const localUrl = `http://127.0.0.1:${port}`;
  let announced = false;

  const proc = spawn(cloudflared, ["tunnel", "--url", localUrl], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const handleChunk = (chunk) => {
    const text = chunk.toString();
    onLog?.(text);
    const url = extractTunnelUrl(text);
    if (url && url !== announced) {
      announced = url;
      setRuntimePublicUrl(url);
      onUrl?.(url);
    }
  };

  proc.stdout.on("data", handleChunk);
  proc.stderr.on("data", handleChunk);

  proc.on("error", (err) => {
    const msg = `Could not start cloudflared: ${err.message}`;
    setTunnelFailed(msg);
    console.error(
      "[tunnel]",
      msg,
      "\nInstall: winget install Cloudflare.cloudflared",
      "\nOr set CLOUDFLARED_PATH to cloudflared.exe",
      "\nOr set PUBLIC_TUNNEL=false for local-only mode."
    );
  });

  proc.on("exit", (code) => {
    invalidateTunnelUrl();
    if (!announced && code && code !== 0) {
      setTunnelFailed(`cloudflared exited with code ${code}`);
      console.warn(`[tunnel] cloudflared exited (${code}) before a public URL was ready.`);
      console.warn("[tunnel] Use local URL: http://127.0.0.1:" + port);
    } else if (code && code !== 0) {
      setTunnelFailed(`cloudflared exited with code ${code}`);
      console.warn(`[tunnel] Tunnel URL is dead. Use local URL: http://127.0.0.1:${port}`);
    } else if (announced) {
      console.warn(`[tunnel] Tunnel closed. Bookmarked trycloudflare links will NOT work.`);
      console.warn(`[tunnel] Open http://127.0.0.1:${port} on this PC instead.`);
    }
  });

  return proc;
}

async function ensureAndStartTunnel(port, { onUrl, onLog } = {}) {
  if (!isAutoTunnelEnabled()) {
    return null;
  }

  const log = (line) => {
    if (line) console.log("[tunnel]", line);
    onLog?.(line + "\n");
  };

  const cloudflaredPath = await resolveCloudflaredBinary({
    allowDownload: String(process.env.TUNNEL_AUTO_DOWNLOAD || "true").toLowerCase() !== "false",
    log,
  });

  if (!cloudflaredPath) {
    const msg =
      "cloudflared not found. Install: winget install Cloudflare.cloudflared — or set CLOUDFLARED_PATH";
    setTunnelFailed(msg);
    console.error("[tunnel]", msg);
    console.error("[tunnel] Or set PUBLIC_TUNNEL=false to run local-only.");
    return null;
  }

  log(`Using ${cloudflaredPath}`);
  return startCloudflareTunnel(port, { cloudflaredPath, onUrl, onLog });
}

function findCloudflared() {
  const { findInstalled } = require("./ensure-cloudflared");
  return findInstalled() || "cloudflared";
}

module.exports = { startCloudflareTunnel, ensureAndStartTunnel, findCloudflared, extractTunnelUrl };
