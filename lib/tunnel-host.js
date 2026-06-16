function isTunnelHost(req) {
  const host = String(req?.headers?.host || "").toLowerCase();
  const forwarded = String(req?.headers?.["x-forwarded-host"] || "").toLowerCase();
  const hay = `${host} ${forwarded}`;
  return hay.includes("trycloudflare.com") || hay.includes("cfargotunnel.com");
}

function docsCaptureTimeoutMs(_req) {
  try {
    const { resolveCaptureTimeoutMs } = require("./doc-generation");
    return resolveCaptureTimeoutMs();
  } catch {
    const videoOn = String(process.env.DOCS_RECORD_VIDEO || "").toLowerCase() !== "false";
    const floor = videoOn ? 450000 : 120000;
    return Math.max(Number(process.env.DOCS_CAPTURE_TIMEOUT_MS || floor), floor);
  }
}

module.exports = { isTunnelHost, docsCaptureTimeoutMs };
