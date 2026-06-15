const { createMcpHttpClient, callMcpTool } = require("./mcp-client");
const { ensurePlaywrightMcp } = require("./ensure-playwright-mcp");
const { isRenderDeploy } = require("./public-url");
const {
  mcpSnapshot,
  tryPanelLogin,
  panelBaseUrl,
  navigateModuleViaMcp,
  executeMcpNavSteps,
  snapshotHas,
  parseUrlFromSnapshot,
} = require("./playwright-mcp-debug");
const {
  isDocsCaptureHealEnabled,
  proposeScreenshotHealPlan,
  resolveHealProvider,
} = require("./ai-screenshot-heal");

const MCP_SNAPSHOT_MAX = 6000;

function isCaptureMcpHealEnabled() {
  if (!isDocsCaptureHealEnabled()) return false;
  if (isRenderDeploy()) {
    const raw = process.env.DOCS_CAPTURE_HEAL_MCP;
    if (raw === undefined || String(raw).trim() === "") return false;
    const v = String(raw).trim().toLowerCase();
    return v === "true" || v === "1" || v === "on" || v === "yes";
  }
  const raw = process.env.DOCS_CAPTURE_HEAL_MCP;
  if (raw !== undefined) {
    const v = String(raw).trim().toLowerCase();
    if (v === "false" || v === "0" || v === "off" || v === "no") return false;
    if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  }
  return true;
}

function isMcpOnlyCaptureError(message = "") {
  return /playwright mcp|mcp not reachable|mcp is not running|auto-start disabled/i.test(
    String(message || "")
  );
}

function enrichCaptureHealError(lastError = "", mcpObservation = null) {
  const mcpError = mcpObservation?.error || "";
  const combined = `${lastError} ${mcpError}`.trim();
  if (!isMcpOnlyCaptureError(combined)) return lastError || mcpError || "";
  return [
    lastError || "Screenshot capture failed",
    "Playwright MCP sidecar is unavailable (expected on Render/production).",
    "Python Playwright Chromium IS installed for capture — do not treat this as a missing browser.",
    "Propose navigation heal steps only.",
    mcpError ? `MCP detail: ${mcpError}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function parseSnapshotHints(snapshot) {
  const lines = String(snapshot || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const pageTextPreview = lines.slice(0, 50).join(" ").slice(0, 500);
  return { pageTextPreview, agentHints: [] };
}

function trimMcpSnapshot(snapshot) {
  return String(snapshot || "").slice(0, MCP_SNAPSHOT_MAX);
}

/**
 * Observe target module via Playwright MCP — login, Quick Search nav, snapshot + URL hints.
 */
async function observeModuleViaMcp({ moduleName, description = "", client: existingClient }) {
  const mcpUrl = await ensurePlaywrightMcp();
  const client = existingClient || (await createMcpHttpClient("playwright-capture-heal", mcpUrl));
  const panelUrl = panelBaseUrl();

  await callMcpTool(client, "browser_navigate", { url: `${panelUrl}/dashboard` });
  let snapshot = await mcpSnapshot(client);
  snapshot = await tryPanelLogin(client, snapshot);

  const navResult = await navigateModuleViaMcp({
    moduleName,
    description,
    client,
    snapshot,
  });
  snapshot = navResult.snapshot || snapshot;
  const pageUrl = navResult.url || parseUrlFromSnapshot(snapshot) || panelUrl;
  const hints = parseSnapshotHints(snapshot);

  return {
    mcpSnapshot: trimMcpSnapshot(snapshot),
    url: pageUrl,
    ...hints,
    onLogin: snapshotHas(snapshot, "sign in|log in|password"),
    is404: snapshotHas(snapshot, "page not found|404"),
    mcpStepsRun: navResult.stepsRun || [],
    onTarget: Boolean(navResult.ok),
    client,
  };
}

async function executeHealPlanViaMcp(client, plan) {
  const navSteps = plan?.navSteps || [];
  if (!navSteps.length) return { ok: true, stepsRun: [], snapshot: "" };
  return executeMcpNavSteps(client, navSteps);
}

/**
 * One MCP observe + Claude heal round: enrich observation, propose plan, optionally validate via MCP.
 */
async function runMcpClaudeHealRound({
  moduleName,
  description = "",
  observation = null,
  lastError = "",
  history = [],
  attempt = 1,
} = {}) {
  let mcpObservation = {};
  let client = null;

  try {
    const observed = await observeModuleViaMcp({ moduleName, description });
    client = observed.client;
    const { client: _c, ...rest } = observed;
    mcpObservation = rest;
  } catch (err) {
    console.warn(`[capture-mcp-heal] MCP observe failed: ${err.message}`);
    mcpObservation = {
      error: err.message,
      mcpSnapshot: "",
      mcpUnavailable: true,
      captureBrowserAvailable: true,
    };
  }

  const enrichedObservation = {
    ...(observation || {}),
    mcpSnapshot: mcpObservation.mcpSnapshot || "",
    mcpUrl: mcpObservation.url || "",
    mcpStepsRun: mcpObservation.mcpStepsRun,
    mcpOnTarget: mcpObservation.onTarget,
    mcpUnavailable: mcpObservation.mcpUnavailable || false,
    captureBrowserAvailable: mcpObservation.captureBrowserAvailable ?? true,
  };
  if (mcpObservation.pageTextPreview) {
    enrichedObservation.pageTextPreview = mcpObservation.pageTextPreview;
  }
  if (mcpObservation.onLogin) enrichedObservation.onLogin = true;
  if (mcpObservation.is404) enrichedObservation.is404 = true;

  const provider = resolveHealProvider();
  const healLastError = enrichCaptureHealError(lastError, mcpObservation);
  const healed = await proposeScreenshotHealPlan({
    moduleName,
    description,
    observation: enrichedObservation,
    lastError: healLastError,
    history,
    attempt,
    provider,
  });

  let mcpValidation = null;
  if (client && healed.plan?.navSteps?.length) {
    try {
      mcpValidation = await executeHealPlanViaMcp(client, healed.plan);
      if (mcpValidation.mcpSnapshot) {
        mcpObservation.postHealSnapshot = trimMcpSnapshot(mcpValidation.mcpSnapshot);
      }
    } catch (err) {
      mcpValidation = { ok: false, error: err.message };
    }
  }

  return {
    plan: healed.plan,
    mcpObservation,
    meta: {
      ...healed.meta,
      mcpValidation,
      mcpEnabled: true,
    },
  };
}

module.exports = {
  isCaptureMcpHealEnabled,
  isMcpOnlyCaptureError,
  enrichCaptureHealError,
  observeModuleViaMcp,
  executeHealPlanViaMcp,
  runMcpClaudeHealRound,
  MCP_SNAPSHOT_MAX,
};
