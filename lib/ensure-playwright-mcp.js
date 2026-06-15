const { spawn } = require("child_process");
const path = require("path");
const { pingMcpUrl } = require("./mcp-client");
const { isRenderDeploy } = require("./public-url");

let child = null;

function playwrightMcpUrl() {
  return String(process.env.PLAYWRIGHT_MCP_URL || "http://127.0.0.1:8931/mcp").trim();
}

function playwrightMcpPort() {
  try {
    return new URL(playwrightMcpUrl()).port || "8931";
  } catch {
    return "8931";
  }
}

function isPlaywrightMcpAutoStartEnabled() {
  const raw = process.env.PLAYWRIGHT_MCP_AUTO_START;
  if (raw !== undefined) {
    const v = String(raw).trim().toLowerCase();
    if (v === "false" || v === "0" || v === "off" || v === "no") return false;
    if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  }
  return !isRenderDeploy();
}

function resolveMcpWaitTimeoutMs() {
  const explicit = process.env.PLAYWRIGHT_MCP_WAIT_MS;
  if (explicit != null && String(explicit).trim() !== "") {
    return Math.max(500, Number(explicit) || 2000);
  }
  if (!isPlaywrightMcpAutoStartEnabled()) return 2000;
  if (isRenderDeploy()) return 8000;
  return 45000;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPlaywrightMcp(timeoutMs = resolveMcpWaitTimeoutMs()) {
  const url = playwrightMcpUrl();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await pingMcpUrl(url)) return url;
    await sleep(500);
  }
  throw new Error(`Playwright MCP not reachable at ${url} after ${timeoutMs}ms`);
}

function spawnPlaywrightMcp() {
  if (child && !child.killed) return child;
  const port = playwrightMcpPort();
  const headless = process.env.PLAYWRIGHT_MCP_HEADLESS !== "false";
  const args = ["@playwright/mcp@latest", "--port", port];
  if (headless) args.push("--headless");

  const storageState = path.join(__dirname, "..", "output", "shipmozo-state.json");
  const fs = require("fs");
  if (fs.existsSync(storageState)) {
    args.push("--storage-state", storageState);
  }

  child = spawn("npx", args, {
    shell: true,
    stdio: "ignore",
    detached: false,
    env: { ...process.env },
  });
  child.on("exit", () => {
    child = null;
  });
  return child;
}

async function ensurePlaywrightMcp() {
  const url = playwrightMcpUrl();
  if (await pingMcpUrl(url)) return url;
  if (!isPlaywrightMcpAutoStartEnabled()) {
    throw new Error(
      `Playwright MCP is not running at ${url} (auto-start disabled). Start with: npx @playwright/mcp@latest --port ${playwrightMcpPort()}`
    );
  }
  spawnPlaywrightMcp();
  return waitForPlaywrightMcp();
}

module.exports = {
  ensurePlaywrightMcp,
  playwrightMcpUrl,
  waitForPlaywrightMcp,
  isPlaywrightMcpAutoStartEnabled,
  resolveMcpWaitTimeoutMs,
};
