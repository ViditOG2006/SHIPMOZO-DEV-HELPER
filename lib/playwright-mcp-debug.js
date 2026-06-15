const { createMcpHttpClient, callMcpTool, toolText } = require("./mcp-client");
const { ensurePlaywrightMcp } = require("./ensure-playwright-mcp");

function defaultNavScript(moduleName) {
  return {
    version: 1,
    module: moduleName,
    rationale: "Ctrl+B Quick Search nav (Playwright MCP validated)",
    navSteps: [
      { op: "dismiss_overlays" },
      { op: "hotkey", keys: "Control+b" },
      { op: "wait", ms: 100 },
      { op: "fill_placeholder", placeholder: "Quick Search", text: "rate calculator" },
      { op: "wait", ms: 80 },
      { op: "click_text", text: "Rate Calculator", contains: "Tools" },
      { op: "wait_for_text", text: "pincode", timeout_ms: 2500 },
    ],
    verifyTexts: ["origin pincode", "package type", "calculate"],
    scenarioPlans: [],
    source: "default",
  };
}

function scriptDebugBackend() {
  return String(process.env.SCRIPT_DEBUG_BACKEND || "mcp").trim().toLowerCase();
}

function isPlaywrightMcpEnabled() {
  return scriptDebugBackend() === "mcp";
}

function healBackendLabel() {
  return isPlaywrightMcpEnabled() ? "Playwright MCP" : "OpenRouter";
}

function panelBaseUrl() {
  return String(process.env.SHIPMOZO_PANEL_URL || "https://panel.appiify.com").replace(/\/$/, "");
}

function findRefInSnapshot(snapshot, patterns) {
  const lines = String(snapshot || "").split("\n");
  const pats = (Array.isArray(patterns) ? patterns : [patterns]).map(
    (p) => (p instanceof RegExp ? p : new RegExp(p, "i"))
  );
  for (let i = 0; i < lines.length; i++) {
    if (!pats.some((p) => p.test(lines[i]))) continue;
    const window = lines.slice(Math.max(0, i - 2), i + 4).join("\n");
    const refMatch = window.match(/(?:ref:\s*|ref=|\[ref=)([^\s\]]+)/);
    if (refMatch) return refMatch[1];
  }
  return null;
}

function snapshotHas(snapshot, pattern) {
  return new RegExp(pattern, "i").test(String(snapshot || ""));
}

function parseUrlFromSnapshot(snapshot) {
  const m = String(snapshot || "").match(/(?:Page URL|url):\s*(\S+)/i);
  return m ? m[1].replace(/[)\]}>]+$/, "") : "";
}

function resolveQuickSearchQuery(moduleName, description = "") {
  const hay = `${moduleName} ${description}`.toLowerCase();
  if (/amazon|shopify|woocommerce|channel/.test(hay)) return "Order Channels";
  if (/rate\s*calcul|calcul/.test(hay)) return "rate calculator";
  return String(moduleName || "").trim();
}

function resolveChannelClickText(moduleName, description = "") {
  const hay = `${moduleName} ${description}`.toLowerCase();
  if (hay.includes("amazon")) return "Amazon";
  if (hay.includes("shopify")) return "Shopify";
  return "";
}

async function mcpSnapshot(client) {
  const result = await callMcpTool(client, "browser_snapshot", {});
  return toolText(result);
}

async function mcpClick(client, target, element) {
  const args = { target, ref: target };
  if (element) args.element = element;
  return callMcpTool(client, "browser_click", args);
}

async function mcpType(client, target, text, element) {
  const args = { target, ref: target, text };
  if (element) args.element = element;
  return callMcpTool(client, "browser_type", args);
}

async function tryPanelLogin(client, snapshot) {
  const email = process.env.SHIPMOZO_EMAIL;
  const password = process.env.SHIPMOZO_PASSWORD;
  if (!email || !password) return snapshot;
  if (!snapshotHas(snapshot, "email|password|sign in|log in")) return snapshot;

  const emailRef =
    findRefInSnapshot(snapshot, [/email/i, /username/i]) ||
    findRefInSnapshot(snapshot, /textbox/i);
  const passRef = findRefInSnapshot(snapshot, /password/i);

  if (emailRef) {
    await mcpType(client, emailRef, email, "email");
  }
  if (passRef) {
    await mcpType(client, passRef, password, "password");
  }
  const loginRef =
    findRefInSnapshot(snapshot, [/sign in/i, /log in/i, /login/i]) ||
    findRefInSnapshot(snapshot, /button/i);
  if (loginRef) {
    await mcpClick(client, loginRef, "login");
  } else {
    await callMcpTool(client, "browser_press_key", { key: "Enter" });
  }
  await callMcpTool(client, "browser_wait_for", { time: 2 });
  return mcpSnapshot(client);
}

async function navigateModuleViaMcp({ moduleName, description = "", client, snapshot: initialSnapshot }) {
  const panelUrl = panelBaseUrl();
  let snapshot = initialSnapshot;
  const stepsRun = [];

  if (!snapshot) {
    await callMcpTool(client, "browser_navigate", { url: `${panelUrl}/dashboard` });
    snapshot = await mcpSnapshot(client);
    snapshot = await tryPanelLogin(client, snapshot);
  }

  const hay = `${moduleName} ${description}`.toLowerCase();
  const isRateCalc = /rate\s*calcul|calcul/.test(hay);
  const isChannel = /amazon|shopify|woocommerce|channel/.test(hay);
  const channelName = resolveChannelClickText(moduleName, description);
  const searchQuery = resolveQuickSearchQuery(moduleName, description);

  if (isRateCalc && snapshotHas(snapshot, "origin pincode|calculate freight|rate calculator")) {
    return { ok: true, snapshot, stepsRun: ["already_on_target"], url: parseUrlFromSnapshot(snapshot) };
  }
  if (isChannel && channelName && snapshotHas(snapshot, channelName)) {
    return { ok: true, snapshot, stepsRun: ["already_on_target"], url: parseUrlFromSnapshot(snapshot) };
  }

  await callMcpTool(client, "browser_press_key", { key: "Control+b" });
  stepsRun.push("hotkey:Control+b");
  await callMcpTool(client, "browser_wait_for", { time: 0.15 });
  snapshot = await mcpSnapshot(client);

  const searchRef =
    findRefInSnapshot(snapshot, [/quick search/i, /search pages/i, /search/i]) ||
    findRefInSnapshot(snapshot, /textbox/i);
  if (searchRef) {
    await mcpType(client, searchRef, searchQuery, "quick search");
    stepsRun.push(`type:${searchQuery}`);
  } else {
    await callMcpTool(client, "browser_press_key", { key: searchQuery.charAt(0) || "s" });
    stepsRun.push("fallback:first_char");
  }

  await callMcpTool(client, "browser_wait_for", { time: 0.2 });
  snapshot = await mcpSnapshot(client);

  if (isRateCalc) {
    const resultRef = findRefInSnapshot(snapshot, [/rate calculator/i, /tools/i]);
    if (resultRef) {
      await mcpClick(client, resultRef, "Rate Calculator");
      stepsRun.push("click:Rate Calculator");
    } else {
      await callMcpTool(client, "browser_press_key", { key: "Enter" });
      stepsRun.push("press:Enter");
    }
  } else if (isChannel && channelName) {
    await callMcpTool(client, "browser_press_key", { key: "Enter" });
    stepsRun.push("press:Enter");
    await callMcpTool(client, "browser_wait_for", { time: 1.2 });
    snapshot = await mcpSnapshot(client);
    const cardRef = findRefInSnapshot(snapshot, [new RegExp(channelName, "i"), /channel/i]);
    if (cardRef) {
      await mcpClick(client, cardRef, channelName);
      stepsRun.push(`click:${channelName}`);
    }
  } else {
    await callMcpTool(client, "browser_press_key", { key: "Enter" });
    stepsRun.push("press:Enter");
  }

  await callMcpTool(client, "browser_wait_for", { time: 1.5 });
  snapshot = await mcpSnapshot(client);
  const url = parseUrlFromSnapshot(snapshot) || panelUrl;

  let ok = !snapshotHas(snapshot, "page not found|404|manage-courier");
  if (isRateCalc) {
    ok =
      ok &&
      snapshotHas(snapshot, "origin pincode|calculate|package type|delivery pincode");
  } else if (isChannel && channelName) {
    ok = ok && snapshotHas(snapshot, channelName);
  }

  return { ok, snapshot, stepsRun, url };
}

async function executeMcpNavSteps(client, navSteps) {
  const stepsRun = [];

  for (const step of navSteps || []) {
    const op = step.op;
    if (op === "dismiss_overlays") {
      await callMcpTool(client, "browser_press_key", { key: "Escape" });
      stepsRun.push("dismiss_overlays");
    } else if (op === "hotkey") {
      const keys = step.keys || "Control+b";
      await callMcpTool(client, "browser_press_key", { key: keys });
      stepsRun.push(`hotkey:${keys}`);
    } else if (op === "wait") {
      const sec = Math.max(0, Number(step.ms || 80)) / 1000;
      await callMcpTool(client, "browser_wait_for", { time: sec });
      stepsRun.push(`wait:${step.ms}`);
    } else if (op === "fill_placeholder" || op === "fill_label") {
      const snapshot = await mcpSnapshot(client);
      const patterns =
        op === "fill_placeholder"
          ? [new RegExp(step.placeholder || "quick search", "i"), /textbox/i]
          : [new RegExp(step.label || "", "i"), /textbox/i];
      const ref = findRefInSnapshot(snapshot, patterns);
      if (ref) {
        await mcpType(client, ref, step.text || "", step.placeholder || step.label || "input");
        stepsRun.push(`${op}:${step.text}`);
      } else {
        stepsRun.push(`${op}:no_ref`);
      }
    } else if (op === "click_text") {
      const snapshot = await mcpSnapshot(client);
      const patterns = step.contains
        ? [new RegExp(`${step.contains}.*${step.text}`, "i"), new RegExp(step.text, "i")]
        : [new RegExp(step.text, "i")];
      const ref = findRefInSnapshot(snapshot, patterns);
      if (ref) {
        await mcpClick(client, ref, step.text);
        stepsRun.push(`click_text:${step.text}`);
      } else {
        stepsRun.push(`click_text:no_ref`);
      }
    } else if (op === "click_role") {
      const snapshot = await mcpSnapshot(client);
      const ref = findRefInSnapshot(snapshot, [
        new RegExp(step.name || "", "i"),
        new RegExp(step.role || "button", "i"),
      ]);
      if (ref) {
        await mcpClick(client, ref, step.name);
        stepsRun.push(`click_role:${step.name}`);
      } else {
        stepsRun.push(`click_role:no_ref`);
      }
    } else if (op === "press_key") {
      await callMcpTool(client, "browser_press_key", { key: step.key || "Enter" });
      stepsRun.push(`press_key:${step.key || "Enter"}`);
    } else if (op === "wait_for_text") {
      const text = step.text || "";
      const timeoutSec = Math.max(0.5, Number(step.timeout_ms || 2500) / 1000);
      try {
        await callMcpTool(client, "browser_wait_for", { text, time: timeoutSec });
      } catch {
        await callMcpTool(client, "browser_wait_for", { time: timeoutSec });
      }
      stepsRun.push(`wait_for_text:${text}`);
    }
  }

  const snapshot = await mcpSnapshot(client);
  return { ok: true, snapshot, stepsRun, url: parseUrlFromSnapshot(snapshot) };
}

async function navigateToRateCalculator(client) {
  return navigateModuleViaMcp({ moduleName: "Rate Calculator", description: "rate calculator", client });
}

/**
 * Script debugger via Playwright MCP — validates Quick Search nav and returns a cached navSteps script.
 */
async function healNavScriptViaMcp({
  observation = null,
  scenarios = [],
  datasetTitle = "",
  moduleName = "",
  attempt = 1,
} = {}) {
  const module = moduleName || "Rate Calculator";
  const url = await ensurePlaywrightMcp();
  const client = await createMcpHttpClient("playwright", url);

  console.log(`[playwright-mcp] script debug attempt ${attempt} — ${url}`);

  let navResult;
  try {
    navResult = await navigateToRateCalculator(client);
  } catch (err) {
    const script = defaultNavScript(module);
    script.source = "playwright_mcp_error";
    script.aiError = err.message;
    script.healAttempt = attempt;
    return {
      script,
      meta: {
        cached: false,
        model: "playwright-mcp",
        provider: "mcp",
        error: err.message,
        rationale: script.rationale,
        stepCount: script.navSteps.length,
        attempt,
      },
    };
  }

  const script = defaultNavScript(module);
  script.source = "playwright_mcp";
  script.healAttempt = attempt;
  script.rationale = navResult.ok
    ? `Playwright MCP reached Rate Calculator (steps: ${navResult.stepsRun.join(" → ")})`
    : `Playwright MCP nav incomplete at ${observation?.url || panelBaseUrl()} — using default Quick Search script`;
  if (!navResult.ok && observation?.brokenReason) {
    script.rationale += `. Panel issue: ${observation.brokenReason}`;
  }

  return {
    script,
    meta: {
      cached: false,
      model: "playwright-mcp",
      provider: "mcp",
      rationale: script.rationale,
      stepCount: script.navSteps.length,
      mcpStepsRun: navResult.stepsRun,
      onRateCalculator: navResult.ok,
      attempt,
    },
  };
}

module.exports = {
  scriptDebugBackend,
  isPlaywrightMcpEnabled,
  healBackendLabel,
  healNavScriptViaMcp,
  panelBaseUrl,
  findRefInSnapshot,
  snapshotHas,
  parseUrlFromSnapshot,
  resolveQuickSearchQuery,
  mcpSnapshot,
  tryPanelLogin,
  navigateModuleViaMcp,
  navigateToRateCalculator,
  executeMcpNavSteps,
};
