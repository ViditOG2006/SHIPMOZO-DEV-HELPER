const { spawn } = require("child_process");
const path = require("path");
const { pingMcpUrl } = require("./mcp-client");

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPlaywrightMcp(timeoutMs = 45000) {
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
  if (process.env.PLAYWRIGHT_MCP_AUTO_START === "false") {
    throw new Error(
      `Playwright MCP is not running at ${url}. Start with: npx @playwright/mcp@latest --port ${playwrightMcpPort()}`
    );
  }
  spawnPlaywrightMcp();
  return waitForPlaywrightMcp();
}

module.exports = {
  ensurePlaywrightMcp,
  playwrightMcpUrl,
  waitForPlaywrightMcp,
};
