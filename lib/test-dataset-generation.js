const { callLLM, MAX_OUTPUT_TOKENS } = require("./llm");
const { loadNavigationMap } = require("./panel-navigation");
const { nowSessionId } = require("./doc-generation");
const { extractJsonFromLlm } = require("./parse-llm-json");

const TEST_AREAS = [
  "chat",
  "module_docs",
  "screenshots",
  "api",
  "e2e",
  "navigation",
];

const SCOPE_TYPES = [
  "happy_path",
  "negative",
  "boundary",
  "concurrency",
  "performance",
  "recovery",
  "security",
];

const SCENARIO_CATEGORIES = [
  "chat",
  "module_docs",
  "screenshots",
  "api",
  "e2e",
  "navigation",
  "config",
];

const SCENARIO_TYPES = [
  "happy_path",
  "negative",
  "boundary",
  "security",
  "concurrency",
  "performance",
  "recovery",
];

function navModuleList() {
  const nav = loadNavigationMap();
  return (nav.pages || [])
    .slice(0, 40)
    .map((p) => `${p.text} (${p.path || p.href})`)
    .join("\n");
}

function buildSystemPrompt(compact = false) {
  return `You are a Senior QA Architect for Shipmozo Dev Helper.

CRITICAL: Output a single JSON object only. No markdown fences. No prose before or after JSON.
Escape newlines inside strings. Keep scenario descriptions under ${compact ? 80 : 120} characters.

Dev Helper APIs (use these only):
- POST /api/ai/chat — live panel Q&A
- POST /api/docs/generate-step — prd | screenshots | manual
- GET /api/health, /api/ai/config, /api/panel/navigation

Do NOT invent Shipmozo order REST APIs or fields like orderID/status.
For order flows use category "chat" with chatQuery and expectedResults: minScreenshots 1, minPagesVisited 1, replyMustContain ["order"], maxDurationSeconds 180.

Categories: ${SCENARIO_CATEGORIES.join(", ")}
Types: ${SCENARIO_TYPES.join(", ")}`;
}

function buildUserPrompt({ requirement, options, compact = false }) {
  const minScenarios = Math.min(Math.max(Number(options.minScenarios) || 10, 4), compact ? 8 : 12);
  const modules = options.targetModules?.trim() || "infer from requirement";

  return `Requirement: ${requirement.trim()}

Generate exactly ${minScenarios} test scenarios for Shipmozo Dev Helper.
Target modules: ${modules}
${compact ? "COMPACT MODE: short steps (max 4 each), minimal expectedResults, empty tags arrays." : ""}

Panel nav (sample):
${navModuleList()}

Return JSON:
{
  "title": "string",
  "summary": "string",
  "scenarios": [{
    "id": "TC-001",
    "title": "string",
    "category": "chat",
    "type": "happy_path",
    "priority": "high",
    "module": "Quick Add",
    "description": "string",
    "preconditions": ["string"],
    "inputs": {
      "moduleName": null,
      "chatQuery": "How do I create a new order?",
      "description": null,
      "apiEndpoint": null,
      "apiMethod": null,
      "apiBody": null,
      "envVars": [],
      "uiAction": null,
      "useLivePanel": true,
      "captureScreens": true
    },
    "steps": ["string"],
    "expectedResults": {
      "httpStatus": null,
      "minScreenshots": 1,
      "minPagesVisited": 1,
      "responseFields": [],
      "replyMustContain": ["order"],
      "replyMustNotContain": [],
      "prdSections": [],
      "manualMustHave": [],
      "errorMessage": null,
      "maxDurationSeconds": 180,
      "custom": null
    },
    "tags": []
  }],
  "coverageMatrix": { "byCategory": {}, "byType": {}, "byPriority": {} },
  "markdownSummary": "brief markdown string"
}`;
}

function normalizeScenario(s, index) {
  const id = s.id || `TC-${String(index + 1).padStart(3, "0")}`;
  return {
    id,
    title: String(s.title || "Untitled scenario"),
    category: SCENARIO_CATEGORIES.includes(s.category) ? s.category : "e2e",
    type: SCENARIO_TYPES.includes(s.type) ? s.type : "happy_path",
    priority: ["critical", "high", "medium", "low"].includes(s.priority) ? s.priority : "medium",
    module: s.module || null,
    description: String(s.description || ""),
    preconditions: Array.isArray(s.preconditions) ? s.preconditions.map(String) : [],
    inputs: {
      moduleName: s.inputs?.moduleName ?? null,
      chatQuery: s.inputs?.chatQuery ?? null,
      description: s.inputs?.description ?? null,
      apiEndpoint: s.inputs?.apiEndpoint ?? null,
      apiMethod: s.inputs?.apiMethod ?? null,
      apiBody: s.inputs?.apiBody ?? null,
      envVars: Array.isArray(s.inputs?.envVars) ? s.inputs.envVars.map(String) : [],
      uiAction: s.inputs?.uiAction ?? null,
      useLivePanel: s.inputs?.useLivePanel ?? null,
      captureScreens: s.inputs?.captureScreens ?? null,
    },
    steps: Array.isArray(s.steps) ? s.steps.map(String) : [],
    expectedResults: {
      httpStatus: s.expectedResults?.httpStatus ?? null,
      minScreenshots: s.expectedResults?.minScreenshots ?? null,
      minPagesVisited: s.expectedResults?.minPagesVisited ?? null,
      responseFields: Array.isArray(s.expectedResults?.responseFields)
        ? s.expectedResults.responseFields.map(String)
        : [],
      replyMustContain: Array.isArray(s.expectedResults?.replyMustContain)
        ? s.expectedResults.replyMustContain.map(String)
        : [],
      replyMustNotContain: Array.isArray(s.expectedResults?.replyMustNotContain)
        ? s.expectedResults.replyMustNotContain.map(String)
        : [],
      prdSections: Array.isArray(s.expectedResults?.prdSections)
        ? s.expectedResults.prdSections.map(String)
        : [],
      manualMustHave: Array.isArray(s.expectedResults?.manualMustHave)
        ? s.expectedResults.manualMustHave.map(String)
        : [],
      errorMessage: s.expectedResults?.errorMessage ?? null,
      maxDurationSeconds: s.expectedResults?.maxDurationSeconds ?? null,
      custom: s.expectedResults?.custom ?? null,
    },
    tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
  };
}

function buildCoverageMatrix(scenarios) {
  const byCategory = {};
  const byType = {};
  const byPriority = {};
  for (const s of scenarios) {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
    byType[s.type] = (byType[s.type] || 0) + 1;
    byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
  }
  return { byCategory, byType, byPriority };
}

function normalizeDataset(parsed, { requirement, options, model, usage, partial }) {
  const scenarios = (parsed.scenarios || []).map(normalizeScenario);
  const coverageMatrix = parsed.coverageMatrix?.byCategory
    ? parsed.coverageMatrix
    : buildCoverageMatrix(scenarios);

  return {
    version: 1,
    id: nowSessionId(),
    title: String(parsed.title || "Test dataset"),
    summary: String(parsed.summary || ""),
    requirement: String(requirement || ""),
    options: options || {},
    scenarios,
    scenarioCount: scenarios.length,
    coverageMatrix,
    markdownSummary: String(parsed.markdownSummary || ""),
    createdAt: new Date().toISOString(),
    model: model || null,
    usage: usage || null,
    partial: Boolean(partial),
  };
}

async function requestDataset({ requirement, options, model, provider, compact, jsonMode }) {
  return callLLM({
    model,
    provider,
    system: buildSystemPrompt(compact),
    maxTokens: compact ? 6000 : MAX_OUTPUT_TOKENS,
    jsonMode,
    messages: [{ role: "user", content: buildUserPrompt({ requirement, options, compact }) }],
  });
}

async function generateTestDataset({ requirement, options = {}, model, provider }) {
  const req = String(requirement || "").trim();
  if (!req) throw new Error("requirement text is required");

  const attempts = [
    { compact: false, jsonMode: true, label: "standard" },
    { compact: true, jsonMode: true, label: "compact" },
    { compact: true, jsonMode: false, label: "compact-no-json-mode" },
  ];

  let lastError = "unknown";
  let lastPreview = "";

  for (const attempt of attempts) {
    let result;
    try {
      result = await requestDataset({
        requirement: req,
        options,
        model,
        provider,
        compact: attempt.compact,
        jsonMode: attempt.jsonMode,
      });
    } catch (err) {
      lastError = err.message;
      continue;
    }

    if (!result.text) {
      lastError = "empty AI response";
      continue;
    }

    const { data, error, partial } = extractJsonFromLlm(result.text);
    lastPreview = result.text.slice(0, 240);
    lastError = error || (result.stop_reason === "max_tokens" ? "response truncated" : "invalid JSON");

    if (data?.scenarios?.length) {
      return normalizeDataset(data, {
        requirement: req,
        options,
        model: result.model,
        usage: result.usage,
        partial,
      });
    }

    if (result.stop_reason === "max_tokens" && !attempt.compact) {
      continue;
    }
  }

  throw new Error(
    `AI did not return valid test dataset JSON (${lastError}). Try a shorter requirement or reduce min scenarios. Preview: ${lastPreview}`
  );
}

module.exports = {
  generateTestDataset,
  TEST_AREAS,
  SCOPE_TYPES,
  extractJsonFromLlm,
};
