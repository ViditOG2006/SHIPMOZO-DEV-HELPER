const fs = require("fs");
const path = require("path");
const { callLLM } = require("./llm");
const { loadNavigationMap } = require("./panel-navigation");
const { getGithubContextText } = require("./github-repo-context");
const { parsePythonJson } = require("./parse-python-json");
const { formatLessonsForPrompt } = require("./ai-heal-lessons");
const { isPlaywrightMcpEnabled, healNavScriptViaMcp, healBackendLabel } = require("./playwright-mcp-debug");
const { resolveTestcaseLlmPair } = require("./report-llm-split");

function resolveHealLlm({ model, provider } = {}) {
  const pair = resolveTestcaseLlmPair({ provider, model });
  return { model: pair.testcaseModel, provider: pair.testcaseProvider };
}

const ROOT = path.join(__dirname, "..");
const AI_SCRIPT_CACHE = path.join(ROOT, "output", "runtime", "e2e-ai-script.json");

const AI_AGENT_SYSTEM = `You are an autonomous QA agent self-healing Playwright navigation on the Shipmozo merchant panel.

You work like a senior engineer in a loop:
1. READ the live page observation (URL, visible text, buttons, 404 markers)
2. READ prior failed attempts — never repeat a failed approach (especially manage-courier URLs)
3. WRITE a corrected navSteps script for the CURRENT page state

CRITICAL PANEL RULES (2024+):
1. Primary navigation: Ctrl+B → "Quick Search Pages" → type module name → click result (e.g. "Tools → Rate Calculator").
2. NEVER use /courier/manage-courier URL — it 404s on many tenants.
3. NEVER use sidebar icon guessing or hardcoded hrefs unless Quick Search fails.
4. Verify with visible UI text markers, not URL alone.
5. SPEED TARGET: entire nav script completes in 3–5 seconds. Each E2E test case on the panel should finish in 5–10 seconds total.
6. Keep navSteps to 4–6 operations only. wait ops: 50–120ms. wait_for_text timeout_ms: 1500–2500 max. No sleep longer than 300ms.

Allowed step ops only:
- dismiss_overlays
- hotkey (keys: "Control+b")
- wait (ms: number)
- fill_placeholder (placeholder: string, text: string)
- fill_label (label: string, text: string)
- click_text (text: string, optional contains: string)
- press_key (key: "Enter" | "ArrowDown")
- wait_for_text (text: string, timeout_ms: number)
- click_role (role: "tab"|"button", name: string)

If already on Rate Calculator (onRateCalculator=true): return minimal navSteps [] with verifyTexts.

If on 404/broken route: first dismiss_overlays, then Ctrl+B — do NOT use browser back to manage-courier.

Output ONLY valid JSON:
{
  "version": 1,
  "module": "Rate Calculator",
  "rationale": "what you see on the page and what you will try differently",
  "navSteps": [ { "op": "...", ... } ],
  "verifyTexts": ["origin pincode", "calculate"],
  "scenarioPlans": [
    { "scenarioId": "TC-001", "e2eFlow": "rate_calculator_open", "steps": ["human readable step"] }
  ]
}`;

const AI_HEAL_SYSTEM = AI_AGENT_SYSTEM;

const SUPPORTED_E2E_FLOWS = [
  "rate_calculator_open",
  "rate_calculator_domestic_happy",
  "rate_calculator_domestic_calculate",
  "rate_calculator_international_toggle",
  "rate_calculator_invalid_pincode",
  "rate_calculator_missing_weight",
  "rate_calculator_heavy_parcel",
  "rate_calculator_dimensions",
  "order_create",
  "order_create_domestic",
  "order_verify_new_orders",
  "order_verify",
  "orders_verify",
];

const SCENARIO_HEAL_SYSTEM = `You are an autonomous QA agent repairing Shipmozo panel E2E scenario configuration.

Your job: fix inputs.e2eFlow and inputs.formData on failed scenarios so Playwright can run them in one browser session.

SUPPORTED e2eFlow values (use ONLY these — exact strings):

Rate Calculator:
- rate_calculator_open — open RC page, verify UI markers
- rate_calculator_domestic_happy — domestic happy path
- rate_calculator_domestic_calculate — fill pins/weight and calculate
- rate_calculator_international_toggle — switch to international tab
- rate_calculator_invalid_pincode — negative: bad pincode
- rate_calculator_missing_weight — negative: missing weight
- rate_calculator_heavy_parcel — heavy parcel case
- rate_calculator_dimensions — dimension-based calculation

Orders:
- order_create / order_create_domestic — fill Add Order form, save, verify in New Orders (create+verify)
- order_verify_new_orders / order_verify / orders_verify — verify order in New Orders only; reuse referenceId from a prior create scenario in the SAME session (ORDER_REF_ID / SESSION_LAST_ORDER_REF)

RULES:
1. Read failed scenario title, description, steps, and error — pick the correct e2eFlow from the list above.
2. "Verify recently added order" / "New Orders" / search by ref → order_verify_new_orders (NOT create).
3. "Create order" / "Add order" / fill form + save → order_create_domestic.
4. Rate calculator scenarios → appropriate rate_calculator_* flow.
5. For verify flows after a create in the same batch, set formData.referenceId only if the scenario text names a specific ref; otherwise leave formData empty so the runner uses the session ref from the prior create.
6. Do NOT invent new flow names. Do NOT use navigation-only flows for order E2E.
7. Patch ONLY scenarios that failed or are clearly misconfigured.

Output ONLY valid JSON:
{
  "rationale": "brief explanation of what was wrong and how you fixed each scenario",
  "patches": [
    {
      "scenarioId": "TC-001",
      "e2eFlow": "order_create_domestic",
      "formData": { "referenceId": "optional" },
      "reason": "why this patch"
    }
  ]
}`;

function summarizeScenarios(scenarios = []) {
  return scenarios.slice(0, 16).map((s) => ({
    id: s.id,
    title: s.title,
    module: s.module,
    type: s.type,
    priority: s.priority,
    e2eFlow: s.inputs?.e2eFlow || s.inputs?.uiAction || null,
    formData: s.inputs?.formData || s.inputs?.e2eForm || null,
    steps: s.steps || [],
    description: (s.description || "").slice(0, 280),
    expectedResults: {
      uiMustContain: s.expectedResults?.uiMustContain || [],
      uiMustNotContain: s.expectedResults?.uiMustNotContain || [],
      pageUrlMustContain: s.expectedResults?.pageUrlMustContain || null,
    },
  }));
}

function buildTestRunManifest(scenarios = [], datasetTitle = "") {
  const lines = [
    `Dataset: ${datasetTitle || "(unnamed)"}`,
    `Total E2E scenarios: ${scenarios.length}`,
    "",
    "Tests to execute after navigation heals:",
  ];
  for (const s of scenarios.slice(0, 16)) {
    const flow = s.inputs?.e2eFlow || s.inputs?.uiAction || "?";
    const expect = (s.expectedResults?.uiMustContain || []).join(", ") || "—";
    lines.push(`- ${s.id}: ${s.title}`);
    lines.push(`  flow=${flow} | expect UI: ${expect}`);
    if (s.steps?.length) lines.push(`  steps: ${s.steps.join(" → ")}`);
  }
  return lines.join("\n");
}

function scriptLooksStale(script) {
  if (!script) return true;
  const blob = JSON.stringify(script).toLowerCase();
  if (blob.includes("manage-courier") || blob.includes("manage_courier")) return true;
  if (script.pageUrl && String(script.pageUrl).toLowerCase().includes("manage-courier")) return true;
  return false;
}

function inferModuleName(scenarios, datasetTitle = "") {
  const first = scenarios[0];
  if (first?.module) return first.module;
  if (first?.inputs?.moduleName) return first.inputs.moduleName;
  const hay = `${datasetTitle} ${scenarios.map((s) => s.title).join(" ")}`.toLowerCase();
  if (hay.includes("rate") && hay.includes("calcul")) return "Rate Calculator";
  if (hay.includes("shopify")) return "Shopify";
  return datasetTitle || "Rate Calculator";
}

function defaultAiScript(moduleName) {
  return {
    version: 1,
    module: moduleName,
    rationale: "Default Ctrl+B Quick Search plan (AI fallback)",
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

function parseAiScriptJson(raw) {
  const { data, error } = parsePythonJson(raw);
  if (data && Array.isArray(data.navSteps)) return data;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed.navSteps)) return parsed;
    }
  } catch {
    /* ignore */
  }
  throw new Error(error || "AI did not return navSteps JSON");
}

function buildKnownIssuesBlock() {
  return formatLessonsForPrompt({ maxLessons: 40 });
}

function buildAgentRepairPrompt({
  observation,
  history = [],
  scenarios = [],
  datasetTitle = "",
  moduleName = "",
  attempt = 1,
  navHint = "",
  ghText = "",
  knownIssues = "",
}) {
  const module = moduleName || inferModuleName(scenarios, datasetTitle);
  const runManifest = buildTestRunManifest(scenarios, datasetTitle);
  const obs = observation || {};
  const lessons = knownIssues || buildKnownIssuesBlock();

  let failureBlock = "";
  if (history.length) {
    failureBlock = "\n\n## Prior attempts (learn from these — do NOT repeat failures)\n";
    for (const h of history.slice(-4)) {
      failureBlock += `\n### Attempt ${h.attempt}\n`;
      failureBlock += `URL after run: ${h.pageUrl || h.observation?.url || "?"}\n`;
      if (h.result?.errors?.length) {
        failureBlock += `Errors: ${h.result.errors.join("; ")}\n`;
      }
      if (h.stepsRun?.length) {
        failureBlock += `Steps: ${h.stepsRun.slice(-6).join(" | ")}\n`;
      }
      if (h.script?.rationale) {
        failureBlock += `Prior plan: ${h.script.rationale}\n`;
      }
    }
  }

  return `## Self-heal attempt ${attempt} — module: **${module}**

SPEED: Nav script must run in 3–5s. Playwright flows after nav target 5–10s per test case — use minimal waits only.

${lessons ? `${lessons}\n` : ""}
${runManifest}

## Live page observation (READ CAREFULLY)
\`\`\`json
${JSON.stringify(obs, null, 2)}
\`\`\`

Agent hints from runtime: ${(obs.agentHints || []).join(" · ") || "none"}
${obs.consoleLogs?.length ? `\n## Browser console (recent)\n${obs.consoleLogs.slice(-12).join("\n")}\n` : ""}
${failureBlock}

## Tests to run after navigation succeeds
${JSON.stringify(summarizeScenarios(scenarios), null, 2)}

Panel nav hints (never manage-courier):
${navHint || "Ctrl+B → Quick Search → Tools → Rate Calculator"}

${ghText ? `GitHub (may be stale):\n${ghText.slice(0, 4000)}` : ""}

Return JSON only. Fix the script for what you SEE now on the page.`;
}

async function proposeHealScript({
  observation = null,
  history = [],
  scenarios = [],
  datasetTitle = "",
  moduleName = "",
  model,
  provider,
  attempt = 1,
} = {}) {
  if (isPlaywrightMcpEnabled()) {
    return healNavScriptViaMcp({
      observation,
      history,
      scenarios,
      datasetTitle,
      moduleName,
      attempt,
    });
  }

  const module = moduleName || inferModuleName(scenarios, datasetTitle);

  const nav = loadNavigationMap();
  const navHint = (nav.pages || [])
    .filter((p) => {
      const href = String(p.href || "").toLowerCase();
      if (href.includes("manage-courier")) return false;
      return /rate|calcul|tools/i.test(`${p.text} ${p.href}`);
    })
    .slice(0, 8)
    .map((p) => `${p.text} → ${p.href}`)
    .join("\n");

  const { text: ghText } = await getGithubContextText({
    moduleName: module,
    query: `${module} rate calculator navigation`,
  });

  const knownIssues = buildKnownIssuesBlock();

  const userPrompt = buildAgentRepairPrompt({
    observation,
    history,
    scenarios,
    datasetTitle,
    moduleName: module,
    attempt,
    navHint,
    ghText,
    knownIssues,
  });

  const messages = [];
  for (const h of history.slice(-3)) {
    messages.push({
      role: "user",
      content: `Attempt ${h.attempt} ended at ${h.observation?.url || "?"}. Errors: ${(h.result?.errors || []).join("; ") || "navigation did not reach Rate Calculator"}`,
    });
    messages.push({
      role: "assistant",
      content: `That approach failed. I will try a different navigation strategy based on the new observation.`,
    });
  }
  messages.push({ role: "user", content: userPrompt });

  console.log(`[ai-agent] repair attempt ${attempt} — ${observation?.url || "no url"}`);

  try {
    const system = `${AI_AGENT_SYSTEM}\n\n${knownIssues}`.trim();
    const healLlm = resolveHealLlm({ model, provider });

    const result = await callLLM({
      model: healLlm.model,
      provider: healLlm.provider,
      scope: "script_debug",
      system,
      maxTokens: 4000,
      jsonMode: true,
      messages,
    });

    const script = parseAiScriptJson(result.text);
    script.module = script.module || module;
    script.source = "ai_heal_agent";
    script.model = result.model;
    script.generatedAt = new Date().toISOString();
    script.healAttempt = attempt;

    return {
      script,
      meta: {
        cached: false,
        model: result.model,
        provider: healLlm.provider,
        rationale: script.rationale,
        stepCount: (script.navSteps || []).length,
        usage: result.usage,
        attempt,
      },
    };
  } catch (err) {
    const script = defaultAiScript(module);
    script.source = "default_fallback";
    script.aiError = err.message;
    script.healAttempt = attempt;
    return {
      script,
      meta: {
        cached: false,
        model: "default",
        provider: "fallback",
        error: err.message,
        rationale: script.rationale,
        stepCount: script.navSteps.length,
        attempt,
      },
    };
  }
}

async function generateAiE2eScript({
  scenarios = [],
  datasetTitle = "",
  moduleName = "",
  model,
  provider,
  force = false,
} = {}) {
  const module = moduleName || inferModuleName(scenarios, datasetTitle);

  if (!force && fs.existsSync(AI_SCRIPT_CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(AI_SCRIPT_CACHE, "utf-8"));
      if (
        cached?.navSteps?.length &&
        cached.module?.toLowerCase() === module.toLowerCase() &&
        !scriptLooksStale(cached)
      ) {
        console.log(`[ai-heal] Reusing cached script (${cached.navSteps.length} steps)`);
        return {
          script: cached,
          meta: { cached: true, model: cached.model || "cache", provider: "cache" },
        };
      }
      if (scriptLooksStale(cached)) {
        console.log("[ai-heal] Discarding stale cached script (manage-courier / broken route)");
      }
    } catch {
      /* regenerate */
    }
  }

  if (isPlaywrightMcpEnabled()) {
    console.log(`[ai-heal] ${healBackendLabel()} generating nav script for ${module}`);
    return healNavScriptViaMcp({
      scenarios,
      datasetTitle,
      moduleName: module,
      attempt: 1,
    });
  }

  const nav = loadNavigationMap();
  const navHint = (nav.pages || [])
    .filter((p) => {
      const href = String(p.href || "").toLowerCase();
      if (href.includes("manage-courier")) return false;
      return /rate|calcul|tools/i.test(`${p.text} ${p.href}`);
    })
    .slice(0, 8)
    .map((p) => `${p.text} → ${p.href}`)
    .join("\n");

  const runManifest = buildTestRunManifest(scenarios, datasetTitle);
  console.log(`[ai-heal] ${healBackendLabel()} context:\n`, runManifest);

  const { text: ghText } = await getGithubContextText({
    moduleName: module,
    query: `${module} rate calculator navigation`,
  });

  const knownIssues = buildKnownIssuesBlock();

  const userPrompt = `Create an execution script for module: **${module}**

${knownIssues ? `${knownIssues}\n` : ""}
${runManifest}

After navSteps succeed, these Playwright flows will run in the same browser session:
${JSON.stringify(summarizeScenarios(scenarios), null, 2)}

Your scenarioPlans[] must mirror the tests above (scenarioId, e2eFlow, human steps).

Panel navigation hints (NEVER use manage-courier URLs):
${navHint || "Use Ctrl+B Quick Search only"}

${ghText ? `GitHub context (may be stale — prefer Quick Search):\n${ghText.slice(0, 6000)}` : ""}

Return JSON only. navSteps must start with Ctrl+B Quick Search for ${module}.
verifyTexts must include pincode + calculate so we never pass on a 404 page.`;

  try {
    const system = `${AI_HEAL_SYSTEM}\n\n${knownIssues}`.trim();
    const healLlm = resolveHealLlm({ model, provider });

    const result = await callLLM({
      model: healLlm.model,
      provider: healLlm.provider,
      scope: "script_debug",
      system,
      maxTokens: 4000,
      jsonMode: true,
      messages: [{ role: "user", content: userPrompt }],
    });

    const script = parseAiScriptJson(result.text);
    script.module = script.module || module;
    script.source = "ai_heal";
    script.model = result.model;
    script.generatedAt = new Date().toISOString();

    fs.mkdirSync(path.dirname(AI_SCRIPT_CACHE), { recursive: true });
    fs.writeFileSync(AI_SCRIPT_CACHE, JSON.stringify(script, null, 2), "utf-8");

    return {
      script,
      meta: {
        cached: false,
        model: result.model,
        provider: healLlm.provider,
        rationale: script.rationale,
        stepCount: script.navSteps.length,
        usage: result.usage,
      },
    };
  } catch (err) {
    const script = defaultAiScript(module);
    script.source = "default_fallback";
    script.aiError = err.message;
    return {
      script,
      meta: {
        cached: false,
        model: "default",
        provider: "fallback",
        error: err.message,
        rationale: script.rationale,
        stepCount: script.navSteps.length,
      },
    };
  }
}

function scenarioTextBlob(scenario) {
  return `${scenario.title || ""} ${scenario.description || ""} ${(scenario.steps || []).join(" ")} ${scenario.module || ""}`.toLowerCase();
}

/** Rule-based e2eFlow inference — used when SCRIPT_DEBUG_BACKEND=mcp (no OpenRouter). */
function inferE2eFlowFromScenario(scenario) {
  const blob = scenarioTextBlob(scenario);
  const module = String(scenario.module || "").toLowerCase();

  if (/rate.?calcul|calculat.*rate|freight|pincode/i.test(blob) || module.includes("rate")) {
    if (/invalid|bad|wrong.*pin|negative/i.test(blob)) return "rate_calculator_invalid_pincode";
    if (/missing.*weight|no weight|empty weight|without weight/i.test(blob)) {
      return "rate_calculator_missing_weight";
    }
    if (/international/i.test(blob)) return "rate_calculator_international_toggle";
    if (/heavy|large parcel|high weight/i.test(blob)) return "rate_calculator_heavy_parcel";
    if (/dimension|length|width|height|lwh/i.test(blob)) return "rate_calculator_dimensions";
    if (/calculat|calculate|submit|get rate|click calculate/i.test(blob)) {
      return "rate_calculator_domestic_calculate";
    }
    if (/open|navigate|reachable|load/i.test(blob)) return "rate_calculator_open";
    return "rate_calculator_domestic_happy";
  }

  const wantsVerify =
    /verify|recently added|search.*order|find.*order|new orders list|confirm.*visible|list shows|filter reset/i.test(
      blob
    );
  const wantsCreate =
    /create|add order|orders\/add|fill.*form|save order|new order form|second domestic|minimum required|required fields/i.test(
      blob
    );

  if (wantsVerify && !wantsCreate) return "order_verify_new_orders";
  if (wantsCreate || scenario.type === "boundary") return "order_create_domestic";
  if (/order/i.test(blob)) return wantsVerify ? "order_verify_new_orders" : "order_create_domestic";

  return null;
}

function proposeScenarioHealViaRules({ failures = [], attempt = 1 } = {}) {
  const patches = [];
  for (const f of failures) {
    const scenario = f.scenario;
    if (!scenario) continue;
    const current = scenario.inputs?.e2eFlow || scenario.inputs?.uiAction;
    const inferred = inferE2eFlowFromScenario(scenario);
    if (!inferred || inferred === current) continue;
    patches.push({
      scenarioId: f.scenarioId,
      e2eFlow: inferred,
      formData: scenario.inputs?.formData || undefined,
      reason: `Inferred from title/steps (${healBackendLabel()} rules)`,
    });
  }

  const rationale =
    patches.length > 0
      ? `${healBackendLabel()} mapped ${patches.length} scenario(s) to supported e2eFlow values`
      : "No rule-based e2eFlow patches available";

  console.log(`[scenario-heal] ${healBackendLabel()} rules attempt ${attempt} — ${patches.length} patch(es)`);

  return {
    rationale,
    patches,
    meta: {
      model: "playwright-mcp",
      provider: "mcp",
      patchCount: patches.length,
      attempt,
      ruleBased: true,
    },
  };
}

function parseScenarioHealJson(raw) {
  const { data, error } = parsePythonJson(raw);
  if (data && Array.isArray(data.patches)) return data;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed.patches)) return parsed;
    }
  } catch {
    /* ignore */
  }
  throw new Error(error || "AI did not return scenario heal patches JSON");
}

function buildScenarioHealPrompt({
  failures = [],
  scenarios = [],
  datasetTitle = "",
  attempt = 1,
  knownIssues = "",
}) {
  const failedSummary = failures.map((f) => ({
    scenarioId: f.scenarioId,
    title: f.scenario?.title,
    module: f.scenario?.module,
    category: f.scenario?.category,
    currentE2eFlow: f.scenario?.inputs?.e2eFlow || f.scenario?.inputs?.uiAction || null,
    formData: f.scenario?.inputs?.formData || f.scenario?.inputs?.e2eForm || null,
    steps: f.scenario?.steps || [],
    description: (f.scenario?.description || "").slice(0, 280),
    error: f.error || f.raw?.error || "config failure",
    durationMs: f.raw?.durationMs,
  }));

  return `## Scenario config self-heal attempt ${attempt}

Dataset: ${datasetTitle || "(unnamed)"}
Failed scenarios: ${failures.length}

${knownIssues ? `${knownIssues}\n` : ""}
## Failures to repair
${JSON.stringify(failedSummary, null, 2)}

## Full scenario list (for session context — verify flows may depend on prior creates)
${JSON.stringify(summarizeScenarios(scenarios), null, 2)}

Supported flows: ${SUPPORTED_E2E_FLOWS.join(", ")}

Return JSON only with rationale and patches[].`;
}

async function proposeScenarioHeal({
  failures = [],
  scenarios = [],
  datasetTitle = "",
  model,
  provider,
  attempt = 1,
} = {}) {
  if (isPlaywrightMcpEnabled()) {
    return proposeScenarioHealViaRules({ failures, scenarios, attempt });
  }

  const knownIssues = buildKnownIssuesBlock();
  const userPrompt = buildScenarioHealPrompt({
    failures,
    scenarios,
    datasetTitle,
    attempt,
    knownIssues,
  });

  console.log(
    `[ai-scenario-heal] repair attempt ${attempt} — ${failures.length} failure(s)`
  );

  try {
    const system = `${SCENARIO_HEAL_SYSTEM}\n\n${knownIssues}`.trim();
    const healLlm = resolveHealLlm({ model, provider });
    const result = await callLLM({
      model: healLlm.model,
      provider: healLlm.provider,
      scope: "script_debug",
      system,
      maxTokens: 3000,
      jsonMode: true,
      messages: [{ role: "user", content: userPrompt }],
    });

    const healed = parseScenarioHealJson(result.text);
    const patches = (healed.patches || []).filter((p) => p.scenarioId && p.e2eFlow);

    return {
      rationale: healed.rationale || "",
      patches,
      meta: {
        model: result.model,
        provider: healLlm.provider,
        patchCount: patches.length,
        usage: result.usage,
        attempt,
      },
    };
  } catch (err) {
    console.error(`[ai-scenario-heal] failed: ${err.message}`);
    return {
      rationale: "",
      patches: [],
      meta: {
        error: err.message,
        model: "none",
        provider: resolveHealLlm({ model, provider }).provider,
        patchCount: 0,
        attempt,
      },
    };
  }
}

module.exports = {
  AI_SCRIPT_CACHE,
  SUPPORTED_E2E_FLOWS,
  SCENARIO_HEAL_SYSTEM,
  generateAiE2eScript,
  proposeHealScript,
  proposeScenarioHeal,
  proposeScenarioHealViaRules,
  inferE2eFlowFromScenario,
  inferModuleName,
  defaultAiScript,
  scriptLooksStale,
  healBackendLabel,
};
