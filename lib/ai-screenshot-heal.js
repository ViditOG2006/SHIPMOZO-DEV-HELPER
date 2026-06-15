const { callLLM } = require("./llm");
const { parsePythonJson } = require("./parse-python-json");
const { formatLessonsForPrompt } = require("./ai-heal-lessons");
const { isAiScopeEnabled, SCOPES } = require("./ai-scope");
const { getProviderDef } = require("./providers");
const { isRenderDeploy } = require("./public-url");

const SCREENSHOT_HEAL_SYSTEM = `You repair Shipmozo panel navigation for documentation screenshot capture.

GOAL: reach the target module page so Playwright can save a valid screenshot (not login, not 404).

CRITICAL RULES:
1. Primary nav: Ctrl+B → Quick Search Pages → type module name → click result.
2. Amazon / Shopify / channel sub-pages: NEVER Quick Search "amazon" or "amazon integration".
   Flow: Ctrl+B → "Order Channels" → Enter → click channel card in-page (e.g. Amazon).
3. Add Order / create order: NEVER Quick Search "new orders" first — use "Add Order" only. Target URL /orders/add (form), not /orders/new (list).
4. When Quick Search fails, use panel-navigation.json (nav map): match module label/href/keywords — e.g. Add Order → /orders/add?type=DOM.
5. NEVER use /courier/manage-courier — it 404s.
6. NEVER goto /channels/amazon directly when DOCS_CAPTURE_ALLOW_DIRECT_URL=false.
7. Keep navSteps to 4–8 ops. wait: 50–120ms. wait_for_text timeout_ms: 1500–4000.
8. If already on target module (page text matches), return minimal navSteps [].
9. NEVER claim Chromium/browser is not installed. Doc capture uses Python Playwright; Chromium is pre-installed on the server. MCP unavailability is a sidecar connectivity issue, not a missing browser — propose navigation fixes only.

Allowed ops: dismiss_overlays, hotkey, wait, fill_placeholder, fill_label, click_text, press_key, wait_for_text, click_role.

Output ONLY valid JSON:
{
  "rationale": "what you see and what you will try",
  "quickSearchQuery": "Order Channels",
  "hubClickText": "",
  "channelClickText": "Amazon",
  "navSteps": [ { "op": "dismiss_overlays" }, { "op": "hotkey", "keys": "Control+b" } ],
  "verifyTexts": ["amazon", "channel"]
}`;

function isDocsCaptureHealEnabled() {
  const onRender = isRenderDeploy();
  const rawEnv = process.env.DOCS_CAPTURE_HEAL_ENABLED;

  if (onRender) {
    if (rawEnv === undefined || String(rawEnv).trim() === "") return false;
    const raw = String(rawEnv).trim().toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
  }

  const raw = String(rawEnv ?? "true").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off") return false;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (process.env.DOCS_CAPTURE_HEAL_PROVIDER) return true;
  const claudeFlag = process.env.DOCS_CAPTURE_HEAL_CLAUDE;
  if (claudeFlag !== undefined) {
    return String(claudeFlag).trim().toLowerCase() !== "false";
  }
  return true;
}

function resolveHealProvider() {
  const explicit = String(process.env.DOCS_CAPTURE_HEAL_PROVIDER || "").trim().toLowerCase();
  if (explicit) {
    if (explicit === "openrouter") {
      console.warn(
        "[screenshot-heal] OpenRouter is not used for doc capture heal — falling back to openai/azure-openai"
      );
      return process.env.OPENAI_API_KEY ? "openai" : "azure-openai";
    }
    if (explicit === "claude" && !process.env.ANTHROPIC_API_KEY) {
      console.warn("[screenshot-heal] DOCS_CAPTURE_HEAL_PROVIDER=claude but ANTHROPIC_API_KEY missing — falling back");
    } else if (explicit === "openai" && !process.env.OPENAI_API_KEY && process.env.AZURE_OPENAI_API_KEY) {
      return "azure-openai";
    } else {
      return explicit;
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.AZURE_OPENAI_API_KEY) return "azure-openai";
  return String(process.env.REPORT_ORCHESTRATOR_PROVIDER || "azure-openai").trim().toLowerCase();
}

function resolveHealModel(provider) {
  const explicit = process.env.DOCS_CAPTURE_HEAL_MODEL;
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (provider === "claude") return "claude-sonnet-4-20250514";
  const def = getProviderDef(provider);
  return def?.defaultModel || "gpt-4.1-mini";
}

function resolveHealScope() {
  if (isAiScopeEnabled(SCOPES.SCRIPT_DEBUG)) return SCOPES.SCRIPT_DEBUG;
  if (isAiScopeEnabled(SCOPES.REPORT_GEN)) return SCOPES.REPORT_GEN;
  return SCOPES.SCRIPT_DEBUG;
}

function defaultRateCalculatorHealPlan(moduleName, description = "") {
  return {
    rationale: "Default Quick Search → Rate Calculator (no LLM)",
    quickSearchQuery: "rate calculator",
    hubClickText: "",
    channelClickText: "",
    navSteps: [
      { op: "dismiss_overlays" },
      { op: "hotkey", keys: "Control+b" },
      { op: "wait", ms: 100 },
      { op: "fill_placeholder", placeholder: "Quick Search", text: "rate calculator" },
      { op: "wait", ms: 80 },
      { op: "press_key", key: "Enter" },
      { op: "wait", ms: 1200 },
      { op: "click_text", text: "Rate Calculator", contains: "Tools" },
    ],
    verifyTexts: ["pincode", "calculate"],
    source: "default_rate_calculator",
  };
}

function defaultAddOrderHealPlan(moduleName, description = "") {
  return {
    rationale: "Default Quick Search → Add Order form (not New Orders list)",
    quickSearchQuery: "Add Order",
    hubClickText: "",
    channelClickText: "",
    navSteps: [
      { op: "dismiss_overlays" },
      { op: "hotkey", keys: "Control+b" },
      { op: "wait", ms: 120 },
      { op: "fill_placeholder", placeholder: "Quick Search", text: "add order" },
      { op: "wait", ms: 100 },
      { op: "press_key", key: "Enter" },
      { op: "wait", ms: 1500 },
      { op: "wait_for_text", text: "phone", timeout_ms: 4000 },
    ],
    verifyTexts: ["add order", "phone", "create"],
    source: "default_add_order",
  };
}

function defaultChannelHealPlan(moduleName, description = "") {
  const hay = `${moduleName} ${description}`.toLowerCase();
  const channel =
    hay.includes("amazon") ? "Amazon" : hay.includes("shopify") ? "Shopify" : "";
  return {
    rationale: "Default Order Channels hub → channel card (no LLM)",
    quickSearchQuery: "Order Channels",
    hubClickText: "",
    channelClickText: channel,
    navSteps: channel
      ? [
          { op: "dismiss_overlays" },
          { op: "hotkey", keys: "Control+b" },
          { op: "wait", ms: 100 },
          { op: "fill_placeholder", placeholder: "Quick Search", text: "Order Channels" },
          { op: "wait", ms: 80 },
          { op: "press_key", key: "Enter" },
          { op: "wait", ms: 1200 },
          { op: "click_text", text: channel },
        ]
      : [
          { op: "dismiss_overlays" },
          { op: "hotkey", keys: "Control+b" },
          { op: "wait", ms: 100 },
          { op: "fill_placeholder", placeholder: "Quick Search", text: moduleName },
          { op: "wait", ms: 80 },
          { op: "press_key", key: "Enter" },
        ],
    verifyTexts: channel ? [channel.toLowerCase(), "channel"] : [],
    source: "default_channel",
  };
}

function parseHealPlanJson(raw) {
  const { data, error } = parsePythonJson(raw);
  if (data && (data.navSteps || data.quickSearchQuery || data.channelClickText)) {
    return data;
  }
  try {
    const m = String(raw || "").match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.navSteps || parsed.quickSearchQuery || parsed.channelClickText) {
        return parsed;
      }
    }
  } catch {
    /* ignore */
  }
  throw new Error(error || "Heal LLM did not return a valid plan JSON");
}

function buildScreenshotHealPrompt({
  moduleName,
  description = "",
  observation = null,
  lastError = "",
  history = [],
  attempt = 1,
}) {
  const lessons = formatLessonsForPrompt({ maxLessons: 20, tags: ["screenshots", "navigation", "integrations", "amazon"] });
  let failureBlock = "";
  if (history.length) {
    failureBlock = "\n## Prior heal attempts (do NOT repeat)\n";
    for (const h of history.slice(-3)) {
      failureBlock += `- Attempt ${h.attempt}: ${h.error || "failed"} | plan: ${h.plan?.rationale || "?"}\n`;
    }
  }

  const obs = { ...(observation || {}) };
  const mcpSnapshotText = obs.mcpSnapshot ? String(obs.mcpSnapshot).slice(0, 6000) : "";
  const mcpBlock = mcpSnapshotText
    ? `\n## Playwright MCP snapshot (live browser)\n\`\`\`\n${mcpSnapshotText}\n\`\`\`\n`
    : "";
  const infraBlock =
    obs.mcpUnavailable || /playwright mcp|mcp not reachable|auto-start disabled/i.test(lastError)
      ? `\n## Capture infrastructure\nPlaywright MCP sidecar is NOT available (normal on Render/production). Python Playwright Chromium IS installed and runs capture_module_screenshots.py. Do NOT report "browser not installed" — focus on Shipmozo panel navigation.\n`
      : obs.captureBrowserAvailable === false
        ? ""
        : `\n## Capture infrastructure\nScreenshots are captured via Python Playwright (Chromium installed on server).\n`;
  const observationForJson = mcpSnapshotText
    ? { ...obs, mcpSnapshot: `[see MCP snapshot block — ${mcpSnapshotText.length} chars]` }
    : obs;

  return `## Screenshot heal attempt ${attempt} — module: **${moduleName}**
${description ? `Description: ${description}\n` : ""}
${lessons}

## Last capture error
${lastError || "No screenshots / 404 / login-only / timeout"}

## Live page observation
\`\`\`json
${JSON.stringify(observationForJson, null, 2)}
\`\`\`
${mcpBlock}${infraBlock}${failureBlock}

Return JSON heal plan only. Target module screenshots, not dashboard login.`;
}

async function proposeScreenshotHealPlan({
  moduleName,
  description = "",
  observation = null,
  lastError = "",
  history = [],
  attempt = 1,
  provider,
  model,
} = {}) {
  const healProvider = provider || resolveHealProvider();
  const healModel = model || resolveHealModel(healProvider);
  const scope = resolveHealScope();

  const userPrompt = buildScreenshotHealPrompt({
    moduleName,
    description,
    observation,
    lastError,
    history,
    attempt,
  });

  console.log(
    `[screenshot-heal] heal attempt ${attempt} — provider=${healProvider} model=${healModel} scope=${scope}`
  );

  try {
    const result = await callLLM({
      provider: healProvider,
      model: healModel,
      scope,
      system: SCREENSHOT_HEAL_SYSTEM,
      maxTokens: 2000,
      jsonMode: true,
      messages: [{ role: "user", content: userPrompt }],
    });

    const plan = parseHealPlanJson(result.text);
    plan.source = `${healProvider}_heal`;
    plan.healProvider = healProvider;
    plan.healModel = result.model;
    plan.healAttempt = attempt;

    return {
      plan,
      meta: {
        provider: healProvider,
        model: result.model,
        scope,
        rationale: plan.rationale,
        usage: result.usage,
        attempt,
      },
    };
  } catch (err) {
    console.error(`[screenshot-heal] LLM failed: ${err.message} — using default heal plan`);
    const hay = `${moduleName} ${description}`.toLowerCase();
    const plan = /rate\s*calcul|calcul/.test(hay)
      ? defaultRateCalculatorHealPlan(moduleName, description)
      : /add\s*order|create\s*order|orders\/add/.test(hay)
        ? defaultAddOrderHealPlan(moduleName, description)
        : defaultChannelHealPlan(moduleName, description);
    plan.healError = err.message;
    plan.healAttempt = attempt;
    return {
      plan,
      meta: {
        provider: healProvider,
        model: "default",
        scope,
        error: err.message,
        rationale: plan.rationale,
        attempt,
        fallback: true,
      },
    };
  }
}

function healPlanEnvValue(plan) {
  return JSON.stringify(plan);
}

module.exports = {
  isDocsCaptureHealEnabled,
  resolveHealProvider,
  resolveHealModel,
  resolveHealScope,
  buildScreenshotHealPrompt,
  defaultChannelHealPlan,
  defaultAddOrderHealPlan,
  defaultRateCalculatorHealPlan,
  proposeScreenshotHealPlan,
  healPlanEnvValue,
  SCREENSHOT_HEAL_SYSTEM,
};
