function isTunnelHost(req) {
  const host = String(req?.headers?.host || "").toLowerCase();
  const forwarded = String(req?.headers?.["x-forwarded-host"] || "").toLowerCase();
  const hay = `${host} ${forwarded}`;
  return hay.includes("trycloudflare.com") || hay.includes("cfargotunnel.com");
}

function docsCaptureTimeoutMs(_req) {
  // Screenshot capture runs as a background job with short status polls, so tunnel
  // clients can use the full Playwright budget (not the old 90s single-request cap).
  return Number(process.env.DOCS_CAPTURE_TIMEOUT_MS || 300000);
}

module.exports = { isTunnelHost, docsCaptureTimeoutMs };
