const {
  callLLM,
  MAX_OUTPUT_TOKENS,
  isOpenRouterCreditsError,
  parseAffordableMaxTokens,
  creditsTooLowForDataset,
} = require("./llm");

const DATASET_LLM_TIMEOUT_MS = Number(process.env.DATASET_LLM_TIMEOUT_MS || 180000);
const DATASET_MAX_OUTPUT_TOKENS = Number(process.env.DATASET_MAX_OUTPUT_TOKENS || 6000);
const TESTCASE_FAST = String(process.env.TESTCASE_FAST ?? "1").trim() !== "0";
const { resolveTestcaseLlmPair } = require("./report-llm-split");
const { loadNavigationMap } = require("./panel-navigation");
const { nowSessionId } = require("./doc-generation");
const { extractJsonFromLlm } = require("./parse-llm-json");
const { getGithubContextText } = require("./github-repo-context");
const { formatLessonsForPrompt } = require("./ai-heal-lessons");
const { isBackendOnlyModule, stripNonApiScenarios } = require("./backend-only-module");
const {
  isPostmanMcpEnabled,
  isPostmanMcpAgentEnabled,
  isDocsMcpTestcaseEnabled,
  isScriptFirstTestcaseBackend,
  generateTestDatasetFromPostman,
  enrichDatasetWithPostmanApi,
  searchPostmanCollectionRequests,
  postmanRequestsToScenarios,
} = require("./postman-mcp-dataset");
const { generateTestCasesViaMcpAgent } = require("./mcp-testcase-agent");
const { generateTestCasesViaPostmanMcpAgent } = require("./mcp-postman-testcase-agent");
const {
  QA_SHEET_ARCHITECT_PROMPT,
  deriveModuleShortCode,
  normalizeSheetRow,
  buildSheetCoverageMatrix,
  sheetRowsToTsv,
  sheetRowsToCsv,
  sortSheetRows,
  buildSheetJsonSchemaInstruction,
} = require("./qa-sheet-template");

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
  const knownIssues = formatLessonsForPrompt({ maxLessons: compact ? 18 : 40 });
  return `You are a Senior QA Architect for Shipmozo Dev Helper.

${knownIssues ? `${knownIssues}\n` : ""}
CRITICAL: Output a single JSON object only. No markdown fences. No prose before or after JSON.
Escape newlines inside strings. Keep scenario descriptions under ${compact ? 80 : 120} characters.

Dev Helper APIs (use these only):
- POST /api/ai/chat — live panel Q&A
- POST /api/docs/generate-step — prd | screenshots | manual
- GET /api/health, /api/ai/config, /api/panel/navigation

Do NOT invent Shipmozo order REST APIs or fields like orderID/status.

E2E (real Shipmozo UI — Playwright fills forms and clicks buttons):
- category: "e2e"
- inputs.e2eFlow: rate_calculator_* OR order_create_domestic (create+verify) OR order_verify_new_orders (verify only in New Orders list)
- NEVER suggest manage-courier navigation; use Ctrl+B Quick Search for Rate Calculator
- inputs.formData: { serviceType, originPincode, deliveryPincode, weightKg, invoiceValue, length, width, height }
- expectedResults.uiMustContain: ["courier","rate"] etc. (NOT replyMustContain for e2e)
- SPEED: each E2E scenario must be runnable in 5–10 seconds (short steps, no long waits, one focused action per case)

Chat (AI guide only): category "chat" with chatQuery + replyMustContain.

Categories: ${SCENARIO_CATEGORIES.join(", ")}
Types: ${SCENARIO_TYPES.join(", ")}`;
}

function requirementWantsRunnerScenarios(requirement) {
  const low = String(requirement || "").toLowerCase();
  return (
    /orders?\/(add|new)|create.*new order|order_create|verify.*order|panel\.appi?ify\.com\/orders/i.test(
      low
    ) ||
    /\be2e\b|playwright|run (tests|in ui)|dev helper runner/i.test(low)
  );
}

function inferQaSheetFormat(requirement, options = {}) {
  if (requirementWantsRunnerScenarios(requirement)) return false;
  if (options.qaSheetFormat === false) return false;
  if (options.qaSheetFormat === true) return true;
  const low = String(requirement || "").toLowerCase();
  if (/google sheet|sheet row|from prd|module doc|confluence/i.test(low)) return true;
  return false;
}

function sheetRowToScenario(row, index, requirement = "") {
  const id = String(row.TC_ID || `TC-${String(index + 1).padStart(3, "0")}`);
  const desc = String(row.Description || row.description || "").trim();
  const stepsRaw = String(row.Steps || row.steps || "");
  const steps = stepsRaw
    .split(/\n|(?=\d+\.\s)/)
    .map((s) => s.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const level = String(row.Test_Level || row.test_level || "").toLowerCase();
  const blob = `${desc} ${stepsRaw} ${row.Expected || ""}`.toLowerCase();
  const orderFlow =
    requirementWantsRunnerScenarios(requirement) &&
    /order|add order|new order|orders\/add|orders\/new|create.*order|verify/.test(blob);

  if (orderFlow) {
    const wantsCreate = /create|add order|orders\/add|fill.*form|save order|new order form/i.test(blob);
    const wantsVerifyOnly =
      /verify|recently added|search.*order|find.*order|new orders list/i.test(blob) && !wantsCreate;
    const e2eFlow = wantsVerifyOnly ? "order_verify_new_orders" : "order_create_domestic";
    return normalizeScenario(
      {
        id,
        title: desc.slice(0, 100) || `Order E2E ${id}`,
        category: "e2e",
        type: /negative|invalid|boundary/.test(blob) ? "negative" : "happy_path",
        priority: row.Priority === "P0" ? "critical" : row.Priority === "P2" ? "low" : "high",
        module: row.Module || "Orders",
        description: desc || steps.join(" → "),
        inputs: {
          e2eFlow,
          formData: { referenceId: id.replace(/[^A-Za-z0-9_-]/g, "_") },
          useLivePanel: true,
        },
        steps: steps.length
          ? steps
          : e2eFlow === "order_verify_new_orders"
            ? ["Open New Orders", "Reset filters", "Search by reference"]
            : ["Open Add Order", "Fill domestic order form", "Save", "Verify in New Orders list"],
        expectedResults: {
          uiMustContain: ["order"],
          pageUrlMustContain: "/orders/new",
        },
        tags: String(row.Tags || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      },
      index
    );
  }

  const category =
    level.includes("end-to-end") || level.includes("e2e")
      ? "e2e"
      : /api only/i.test(row.Tags || "")
        ? "api"
        : /amazon|shopify|integration|channel|woocommerce/i.test(
              `${blob} ${String(row.Module || "").toLowerCase()} ${String(requirement || "").toLowerCase()}`
            )
          ? "screenshots"
          : "navigation";

  const moduleName =
    String(row.Module || "").trim() ||
    (/amazon/i.test(blob) ? "Amazon" : /shopify/i.test(blob) ? "Shopify" : "Integrations");

  return normalizeScenario(
    {
      id,
      title: desc.slice(0, 100) || id,
      category,
      type: /negative|invalid/.test(blob) ? "negative" : "happy_path",
      priority: row.Priority === "P0" ? "critical" : "medium",
      module: moduleName,
      description: desc,
      steps: steps.length ? steps : [stepsRaw.slice(0, 200)],
      inputs: {
        moduleName,
        useLivePanel: true,
        captureScreens: category === "screenshots",
      },
      expectedResults: {
        minScreenshots: category === "screenshots" ? 1 : null,
        uiMustContain: /order/i.test(blob) ? ["order"] : [],
        pageUrlMustContain: /orders\/new/i.test(blob) ? "/orders/new" : null,
      },
    },
    index
  );
}

function deriveScenariosFromSheetRows(sheetRows, requirement = "") {
  if (!Array.isArray(sheetRows) || !sheetRows.length) return [];
  return sheetRows.map((row, index) => sheetRowToScenario(row, index, requirement));
}

function ensureRunnableScenarios(dataset) {
  if (!dataset) return dataset;
  let out = dataset;
  if (!Array.isArray(out.scenarios) || !out.scenarios.length) {
    const sheetRows = out.sheetRows || [];
    const requirement = out.requirement || "";
    if (
      sheetRows.length &&
      (requirementWantsRunnerScenarios(requirement) || out.sourceDocs || out.options?.fromDocs)
    ) {
      const scenarios = deriveScenariosFromSheetRows(sheetRows, requirement);
      if (scenarios.length) {
        out = {
          ...out,
          scenarios,
          scenarioCount: scenarios.length,
          format: "dev_helper_scenarios",
          derivedFromSheet: true,
          coverageMatrix: buildCoverageMatrix(scenarios),
        };
      }
    }
  }
  return out;
}

const ORDER_E2E_TEMPLATE_SPECS = [
  {
    id: "TC-001",
    title: "Create domestic order via Add Order form",
    e2eFlow: "order_create_domestic",
    type: "happy_path",
    priority: "critical",
    description: "Fill Add Order form, save, verify order ref is set for session",
    steps: ["Open /orders/add", "Fill domestic order form", "Save order"],
  },
  {
    id: "TC-002",
    title: "Verify created order in New Orders list",
    e2eFlow: "order_verify_new_orders",
    type: "happy_path",
    priority: "critical",
    description: "Open New Orders, reset filters, search by reference from TC-001",
    steps: ["Open /orders/new", "Reset date filters", "Search referenceId"],
  },
  {
    id: "TC-003",
    title: "Create second domestic order with unique reference",
    e2eFlow: "order_create_domestic",
    type: "happy_path",
    priority: "high",
    description: "Second create in same session with distinct referenceId",
    steps: ["Open Add Order", "Fill form with new ref", "Save"],
  },
  {
    id: "TC-004",
    title: "Verify recently added order visible after filter reset",
    e2eFlow: "order_verify_new_orders",
    type: "happy_path",
    priority: "high",
    description: "Confirm latest order appears in Forward > Domestic > New",
    steps: ["New Orders tab", "Clear filters", "Search TC-003 ref"],
  },
  {
    id: "TC-005",
    title: "Create order — minimum required fields only",
    e2eFlow: "order_create_domestic",
    type: "boundary",
    priority: "medium",
    description: "Happy path with required fields only",
    steps: ["Add Order", "Required fields", "Save"],
  },
  {
    id: "TC-006",
    title: "Verify order list shows order content",
    e2eFlow: "order_verify_new_orders",
    type: "happy_path",
    priority: "medium",
    description: "List not empty after create scenarios",
    steps: ["New Orders", "Reset filters", "Confirm order visible"],
  },
  {
    id: "TC-007",
    title: "Chat — how to add a new order",
    category: "chat",
    type: "happy_path",
    priority: "low",
    description: "AI guide answers add-order question",
    steps: ["Ask chat about creating orders"],
    inputs: { chatQuery: "How do I create a new domestic order in the panel?" },
    expectedResults: { replyMustContain: ["order"] },
  },
  {
    id: "TC-008",
    title: "Navigation — orders module reachable",
    category: "navigation",
    type: "happy_path",
    priority: "low",
    description: "Panel navigation includes orders area",
    steps: ["Open orders section"],
    expectedResults: { pageUrlMustContain: "/orders" },
  },
];

function buildOrderE2eTemplateDataset(requirement, options = {}, { creditsNote = "" } = {}) {
  const minScenarios = Math.min(Math.max(Number(options.minScenarios) || 8, 4), 12);
  const specs = ORDER_E2E_TEMPLATE_SPECS.slice(0, minScenarios);
  const scenarios = specs.map((spec, index) =>
    normalizeScenario(
      {
        id: spec.id,
        title: spec.title,
        category: spec.category || "e2e",
        type: spec.type,
        priority: spec.priority,
        module: "Orders",
        description: spec.description,
        inputs: {
          e2eFlow: spec.e2eFlow || null,
          chatQuery: spec.inputs?.chatQuery || null,
          formData: spec.e2eFlow
            ? { referenceId: spec.id.replace(/[^A-Za-z0-9_-]/g, "_") }
            : null,
          useLivePanel: true,
        },
        steps: spec.steps,
        expectedResults: spec.expectedResults || {
          uiMustContain: spec.category === "e2e" ? ["order"] : [],
          pageUrlMustContain:
            spec.e2eFlow === "order_verify_new_orders" ? "/orders/new" : "/orders/add",
        },
        tags: ["template", "order-e2e"],
      },
      index
    )
  );

  const note = creditsNote || "OpenRouter credits low — used built-in order E2E template (no AI).";
  const dataset = normalizeDataset(
    {
      title: "Order Management E2E (built-in template)",
      summary: note,
      scenarios,
      markdownSummary: `## Order E2E template\n\n${note}\n\nRunnable in Dev Helper Run UI. Create scenarios use \`order_create_domestic\`; verify scenarios use \`order_verify_new_orders\`.`,
    },
    { requirement, options: { ...options, qaSheetFormat: false }, model: "local-template", usage: null }
  );
  return { ...dataset, generatedBy: "local-template", creditsNote: note };
}

function shouldUseOrderTemplateFallback(lastError, requirement) {
  if (!requirementWantsRunnerScenarios(requirement)) return false;
  if (!isOpenRouterCreditsError(lastError)) return false;
  const affordable = parseAffordableMaxTokens(lastError);
  return creditsTooLowForDataset(affordable) || affordable === null;
}

function orderE2ePromptBlock(requirement) {
  if (!requirementWantsRunnerScenarios(requirement)) return "";
  return `
ORDER / PANEL E2E (mandatory for create+verify requirements):
- order_create_domestic — Playwright fills Add Order form, saves, verifies in New Orders.
- order_verify_new_orders — open New Orders, reset filters, search referenceId (use after a create scenario or shared ref).
- ALWAYS set inputs.e2eFlow explicitly — never leave e2e scenarios without e2eFlow.
- Verify in New Orders: expectedResults.uiMustContain or pageUrlMustContain for /orders/new.
- Use SHIPMOZO_PANEL_URL origin (panel.appiify.com or panel.appify.com) — derive paths from requirement URLs.
- Add 1-2 chat or navigation scenarios only if needed; majority must be runnable e2e scenarios for Dev Helper Run UI.
- Keep JSON compact: short steps (max 4), minimal expectedResults fields, empty tags [].`;
}

function buildUserPrompt({ requirement, options, compact = false }) {
  const minScenarios = Math.min(Math.max(Number(options.minScenarios) || 10, 4), compact ? 8 : 12);
  const modules = options.targetModules?.trim() || "infer from requirement";

  return `Requirement: ${requirement.trim()}

Generate exactly ${minScenarios} test scenarios for Shipmozo Dev Helper (scenarios[] only — NO sheetRows).
Target modules: ${modules}
${compact ? "COMPACT MODE: short steps (max 4 each), minimal expectedResults, empty tags arrays." : ""}
${orderE2ePromptBlock(requirement)}

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
      postmanFolder: s.inputs?.postmanFolder ?? null,
      postmanRequestName: s.inputs?.postmanRequestName ?? null,
      postmanCollectionId: s.inputs?.postmanCollectionId ?? null,
      postmanEnvironmentId: s.inputs?.postmanEnvironmentId ?? null,
      postmanFolders: Array.isArray(s.inputs?.postmanFolders)
        ? s.inputs.postmanFolders.map(String)
        : null,
      envVars: Array.isArray(s.inputs?.envVars) ? s.inputs.envVars.map(String) : [],
      uiAction: s.inputs?.uiAction ?? null,
      e2eFlow: s.inputs?.e2eFlow ?? null,
      formData: s.inputs?.formData ?? s.inputs?.e2eForm ?? null,
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
      uiMustContain: Array.isArray(s.expectedResults?.uiMustContain)
        ? s.expectedResults.uiMustContain.map(String)
        : [],
      uiMustNotContain: Array.isArray(s.expectedResults?.uiMustNotContain)
        ? s.expectedResults.uiMustNotContain.map(String)
        : [],
      pageUrlMustContain: s.expectedResults?.pageUrlMustContain ?? null,
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

function normalizeDataset(parsed, { requirement, options, model, usage, partial, sourceDocs }) {
  const moduleName =
    sourceDocs?.moduleName || parsed.module || options?.moduleName || "";
  const moduleShortCode =
    parsed.moduleShortCode || deriveModuleShortCode(moduleName);

  const sheetRows = sortSheetRows(
    (parsed.sheetRows || []).map((row, index) =>
      normalizeSheetRow(row, { moduleName, moduleShortCode, index })
    )
  );

  let scenarios = (parsed.scenarios || []).map(normalizeScenario);
  if (!scenarios.length && sheetRows.length) {
    scenarios = deriveScenariosFromSheetRows(sheetRows, requirement);
  }
  let coverageMatrix = parsed.coverageMatrix;
  if (sheetRows.length) {
    coverageMatrix = buildSheetCoverageMatrix(sheetRows);
  } else if (!coverageMatrix?.byCategory) {
    coverageMatrix = buildCoverageMatrix(scenarios);
  }

  return {
    version: 2,
    id: nowSessionId(),
    title: String(parsed.title || "Test dataset"),
    summary: String(parsed.summary || ""),
    requirement: String(requirement || ""),
    options: options || {},
    sourceDocs: sourceDocs || null,
    moduleShortCode,
    format: sheetRows.length ? "google_sheet" : "dev_helper_scenarios",
    sheetRows,
    sheetRowCount: sheetRows.length,
    sheetTsv: sheetRows.length ? sheetRowsToTsv(sheetRows) : "",
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

function truncateForPrompt(text, max = 14000) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[... document truncated for AI prompt ...]`;
}

function buildDocsSystemPrompt(compact = false) {
  return `${QA_SHEET_ARCHITECT_PROMPT}

CRITICAL: Respond with a single valid JSON object only. No markdown code fences. No prose outside JSON.
Escape newlines inside JSON string values.
${compact ? "COMPACT MODE: keep Steps and Expected concise but still flow-based with multiple validations." : ""}

Input is Module Documentation (PRD + User Manual / Confluence-style). Treat it as the sole source of truth for module behavior.`;
}

function integrationChannelHint(moduleName) {
  const low = String(moduleName || "").toLowerCase();
  if (!/integrat|channel|shopify|woocommerce|amazon|flipkart/i.test(low)) return "";
  return `
Channel integration focus: connect/disconnect store, credential validation, order/product sync, webhook errors, duplicate store handling.
Prefer E2E scenarios that navigate to /channels/* (e.g. Shopify) and validate UI states from the PRD/manual.`;
}

function buildDocsUserPrompt({ moduleName, prd, userManual, description, options, compact }) {
  const moduleShortCode = deriveModuleShortCode(moduleName);
  const channelHint = integrationChannelHint(moduleName);

  return `Module under test: **${moduleName}**
Module short code for TC_ID: **${moduleShortCode}**
${description ? `Additional context:\n${description}\n` : ""}
${channelHint}

Read the full module documentation below. Extract requirement IDs (e.g. SHOP-UI-01) when present and reference them in each row's Description column.
Identify lifecycle flows, production risks, duplicate/credential/historical-data risks, and partner_id regression areas.
Then generate Google Sheet-ready test cases per the architect template.
${compact ? "COMPACT: 8-10 sheetRows only; Steps max 6 short lines; Expected max 400 chars each; keep JSON small enough to complete." : "Match reference depth (flow-based, 6-10 validations per TC, consolidated Expected)."}

--- MODULE DOCUMENTATION: PRD ---
${truncateForPrompt(prd, compact ? 5000 : 10000)}
--- end PRD ---

--- MODULE DOCUMENTATION: USER MANUAL ---
${truncateForPrompt(userManual, compact ? 5000 : 10000)}
--- end USER MANUAL ---

${buildSheetJsonSchemaInstruction({ moduleName, moduleShortCode })}

If anything critical is missing from the docs to write Integration/E2E cases, note it in markdownSummary — do not invent behavior.`;
}

function buildQaSheetUserPrompt({ requirement, options, compact }) {
  const modules = options.targetModules?.trim() || "infer from requirement";
  const moduleShortCode = deriveModuleShortCode(modules.split(",")[0] || "MOD");

  return `Requirement:\n${requirement.trim()}

Target module(s): ${modules}

${buildSheetJsonSchemaInstruction({ moduleName: modules.split(",")[0]?.trim() || "Module", moduleShortCode })}

${compact ? "COMPACT MODE: minimum 10 sheetRows." : "Aim for 10-14 sheetRows total."}`;
}

function buildQaSheetSystemPrompt(compact = false) {
  return `${QA_SHEET_ARCHITECT_PROMPT}

CRITICAL: Output single JSON object only. No markdown fences.
${compact ? "COMPACT MODE enabled." : ""}`;
}

async function finalizeDocsDataset(dataset, { moduleName, description, options, sourceDocs }) {
  const backendOnly = isBackendOnlyModule({ moduleName, description, options, sourceDocs, dataset });
  let out = dataset;
  if (options?.includePostmanApi !== false) {
    out = await enrichDatasetWithPostmanApi(out, {
      moduleName,
      collectionId: options?.postmanCollectionId,
      keywords: options?.postmanKeywords,
      query: description,
      description,
    });
  }
  if (backendOnly) {
    const scenarios = stripNonApiScenarios(out.scenarios);
    out = {
      ...out,
      scenarios,
      scenarioCount: scenarios.length,
      coverageMatrix: buildCoverageMatrix(scenarios),
      backendOnly: true,
      options: { ...(out.options || {}), backendOnly: true },
      sourceDocs: { ...(out.sourceDocs || sourceDocs || {}), backendOnly: true },
      summary: scenarios.length
        ? `${scenarios.length} Postman API scenario(s) — backend-only (no panel UI)`
        : out.summary,
      generatedBy: out.generatedBy || "postman-backend-only",
    };
  }
  return out;
}

async function generateBackendOnlyTestDatasetFromPostman({
  moduleName,
  description = "",
  sessionId = "",
  options = {},
}) {
  const name = String(moduleName || "").trim();
  if (!String(process.env.POSTMAN_API_KEY || "").trim()) {
    throw new Error(
      `POSTMAN_API_KEY is required for backend-only module "${name}". Configure your Postman collection.`
    );
  }

  const search = await searchPostmanCollectionRequests({
    collectionId: options?.postmanCollectionId,
    moduleName: name,
    keywords: options?.postmanKeywords,
    query: description || name,
  });

  if (!search.items?.length) {
    throw new Error(
      `No Postman API requests matched "${name}". Add matching requests to your collection or set POSTMAN_COLLECTION_ID.`
    );
  }

  let scenarios = postmanRequestsToScenarios(search.items, search.collection, { moduleName: name });
  scenarios = scenarios.map((s, i) => {
    const namedId = String(s.inputs?.postmanRequestName || "").match(/TC-[\w-]+/i)?.[0];
    return {
      ...s,
      id: namedId || `TC-${String(i + 1).padStart(3, "0")}`,
      inputs: {
        ...s.inputs,
        postmanCollectionId: search.collectionId,
        moduleName: name,
      },
    };
  });

  const requirement = `API tests for backend-only service "${name}"`;
  const sourceDocs = {
    moduleName: name,
    sessionId: sessionId || null,
    description: String(description || "").slice(0, 500),
    backendOnly: true,
  };

  return finalizeDocsDataset(
    normalizeDataset(
      {
        title: `${name} API tests`,
        summary: `${scenarios.length} Postman API scenario(s) — backend-only (no panel UI)`,
        scenarios,
        markdownSummary: `## ${name} — backend API tests\n\nImported ${scenarios.length} Postman request(s). No panel UI / E2E / navigation scenarios.`,
      },
      {
        requirement,
        options: { ...options, backendOnly: true, fromDocs: true, includePostmanApi: false },
        model: "postman-search",
        sourceDocs,
      }
    ),
    { moduleName: name, description, options: { ...options, backendOnly: true }, sourceDocs }
  );
}

async function generateTestDatasetFromDocs({
  moduleName,
  prd,
  userManual,
  description = "",
  sessionId = "",
  options = {},
  model,
  provider,
}) {
  const name = String(moduleName || "").trim();
  const prdText = String(prd || "").trim();
  const manualText = String(userManual || "").trim();

  if (!name) throw new Error("moduleName is required");
  if (!prdText && !manualText) {
    throw new Error("At least one of prd or userManual is required");
  }

  const backendOnly = isBackendOnlyModule({
    moduleName: name,
    description,
    options,
    backendOnly: options?.backendOnly,
  });

  if (backendOnly) {
    return generateBackendOnlyTestDatasetFromPostman({
      moduleName: name,
      description,
      sessionId,
      options,
    });
  }

  if (isScriptFirstTestcaseBackend()) {
    throw new Error(
      "TESTCASE_BACKEND=scripts — AI testcase generation is disabled. Import your scenario JSON via Testing → Import scripts, or set TESTCASE_BACKEND=docs for doc-based generation."
    );
  }

  if (isDocsMcpTestcaseEnabled()) {
    const dataset = await generateTestCasesViaMcpAgent({
      moduleName: name,
      prd: prdText,
      userManual: manualText,
      description,
      sessionId,
      options,
      model,
      provider,
    });
    return finalizeDocsDataset(dataset, { moduleName: name, description, options, sourceDocs: dataset.sourceDocs });
  }

  const tcLlm = resolveTestcaseLlmPair({ provider, model });
  model = tcLlm.testcaseModel;
  provider = tcLlm.testcaseProvider;

  const requirement = `Test cases for module "${name}" from generated PRD and user manual`;
  const sourceDocs = {
    moduleName: name,
    sessionId: sessionId || null,
    description: String(description || "").slice(0, 500),
    prdChars: prdText.length,
    manualChars: manualText.length,
  };

  const attempts = TESTCASE_FAST
    ? [
        { compact: true, jsonMode: true, skipGithub: true, maxTokens: DATASET_MAX_OUTPUT_TOKENS, label: "fast" },
        { compact: true, jsonMode: false, skipGithub: true, maxTokens: Math.min(4500, DATASET_MAX_OUTPUT_TOKENS), label: "fast-no-json" },
      ]
    : [
        { compact: true, jsonMode: true, skipGithub: false, maxTokens: DATASET_MAX_OUTPUT_TOKENS, label: "compact" },
        { compact: true, jsonMode: true, skipGithub: true, maxTokens: DATASET_MAX_OUTPUT_TOKENS, label: "compact-no-github" },
        { compact: false, jsonMode: true, skipGithub: true, maxTokens: DATASET_MAX_OUTPUT_TOKENS, label: "standard" },
        { compact: true, jsonMode: false, skipGithub: true, maxTokens: Math.min(4500, DATASET_MAX_OUTPUT_TOKENS), label: "compact-no-json-mode" },
      ];

  let lastError = "unknown";
  let lastPreview = "";

  for (const attempt of attempts) {
    let result;
    try {
      let docsPrompt = buildDocsUserPrompt({
        moduleName: name,
        prd: prdText || "(PRD not provided — use user manual only)",
        userManual: manualText || "(User manual not provided — use PRD only)",
        description,
        options,
        compact: attempt.compact,
      });
      if (!attempt.skipGithub) {
        docsPrompt = await appendGithubToPrompt(docsPrompt, { moduleName: name });
      }
      result = await callLLM({
        model,
        provider,
        scope: "testcase_gen",
        system: buildDocsSystemPrompt(attempt.compact),
        maxTokens: attempt.maxTokens,
        jsonMode: attempt.jsonMode,
        timeoutMs: DATASET_LLM_TIMEOUT_MS,
        messages: [{ role: "user", content: docsPrompt }],
      });
    } catch (err) {
      lastError = err.message || String(err);
      if (/fetch failed|abort|timeout/i.test(lastError)) {
        lastError = `OpenRouter/network timeout (${lastError})`;
      }
      continue;
    }

    if (!result.text) {
      lastError = "empty AI response";
      continue;
    }

    const { data, error, partial } = extractJsonFromLlm(result.text);
    lastPreview = result.text.slice(0, 240);
    lastError = error || (result.stop_reason === "max_tokens" ? "response truncated" : "invalid JSON");

    if (datasetMeetsMinimum(data, { useSheet: true, compact: attempt.compact })) {
      for (const s of data.scenarios || []) {
        if (!s.inputs) s.inputs = {};
        if (!s.inputs.moduleName) s.inputs.moduleName = name;
        if (s.inputs.useLivePanel == null) s.inputs.useLivePanel = true;
      }
      return finalizeDocsDataset(
        normalizeDataset(data, {
          requirement,
          options: { ...options, fromDocs: true, moduleName: name, qaSheetFormat: true },
          model: result.model,
          usage: result.usage,
          partial,
          sourceDocs,
        }),
        { moduleName: name, description, options, sourceDocs }
      );
    }

    if (partial && data?.sheetRows?.length >= 4) {
      return finalizeDocsDataset(
        normalizeDataset(data, {
          requirement,
          options: { ...options, fromDocs: true, moduleName: name, qaSheetFormat: true },
          model: result.model,
          usage: result.usage,
          partial: true,
          sourceDocs,
        }),
        { moduleName: name, description, options, sourceDocs }
      );
    }

    if (partial && data?.scenarios?.length >= 3) {
      return finalizeDocsDataset(
        normalizeDataset(data, {
          requirement,
          options: { ...options, fromDocs: true, moduleName: name, qaSheetFormat: false },
          model: result.model,
          usage: result.usage,
          partial: true,
          sourceDocs,
        }),
        { moduleName: name, description, options, sourceDocs }
      );
    }
  }

  const networkHint = /timeout|fetch failed/i.test(lastError)
    ? " Check network/OpenRouter key; large PRD+manual may need retry (compact mode runs automatically)."
    : "";
  throw new Error(
    `AI did not return valid test dataset JSON from docs (${lastError}). Need sheetRows (8+) or scenarios.${networkHint} Preview: ${lastPreview || "(no response)"}`
  );
}

async function appendGithubToPrompt(prompt, { moduleName = "", query = "" } = {}) {
  try {
    const { text } = await getGithubContextText({ moduleName, query: query || moduleName });
    if (!text) return prompt;
    return `${prompt}

--- PANEL SOURCE CODE (public GitHub) ---
GitHub may lag production. Priority: live panel, Ctrl+B Quick Search navigation, PRD — not outdated repo routes.
${text}
--- end GitHub source ---`;
  } catch {
    return prompt;
  }
}

function datasetMeetsMinimum(data, { useSheet, compact }) {
  if (!data) return false;
  if (useSheet) {
    const minRows = compact ? 6 : 8;
    return (data.sheetRows?.length || 0) >= minRows;
  }
  return (data.scenarios?.length || 0) >= 1;
}

async function requestDataset({
  requirement,
  options,
  model,
  provider,
  compact,
  jsonMode,
  useSheet,
  timeoutMs,
}) {
  const userPrompt = await appendGithubToPrompt(
    useSheet
      ? buildQaSheetUserPrompt({ requirement, options, compact })
      : buildUserPrompt({ requirement, options, compact }),
    { query: requirement }
  );
  return callLLM({
    model,
    provider,
    scope: "testcase_gen",
    system: useSheet ? buildQaSheetSystemPrompt(compact) : buildSystemPrompt(compact),
    maxTokens: compact ? DATASET_MAX_OUTPUT_TOKENS : Math.min(DATASET_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
    jsonMode,
    timeoutMs: timeoutMs || DATASET_LLM_TIMEOUT_MS,
    messages: [{ role: "user", content: userPrompt }],
  });
}

async function generateTestDataset({ requirement, options = {}, model, provider }) {
  const req = String(requirement || "").trim();
  if (!req) throw new Error("requirement text is required");

  const tcLlm = resolveTestcaseLlmPair({ provider, model });
  model = tcLlm.testcaseModel;
  provider = tcLlm.testcaseProvider;

  if (isScriptFirstTestcaseBackend()) {
    throw new Error(
      "TESTCASE_BACKEND=scripts — AI testcase generation is disabled. Import scenario JSON via POST /api/testing/datasets/import or the Testing UI."
    );
  }

  if (isPostmanMcpAgentEnabled()) {
    return generateTestCasesViaPostmanMcpAgent({
      requirement: req,
      options,
      model,
      provider,
    });
  }

  if (isPostmanMcpEnabled()) {
    try {
      return await generateTestDatasetFromPostman({
        requirement: req,
        options,
        collectionId: options.postmanCollectionId,
        workspaceId: options.postmanWorkspaceId,
      });
    } catch (err) {
      if (process.env.TESTCASE_BACKEND_FALLBACK === "llm" && requirementWantsRunnerScenarios(req)) {
        console.warn(`[postman-mcp] ${err.message} — falling back to LLM/template`);
      } else if (requirementWantsRunnerScenarios(req)) {
        return buildOrderE2eTemplateDataset(req, options, {
          creditsNote: `Postman MCP: ${err.message} — built-in order E2E template used.`,
        });
      } else {
        throw err;
      }
    }
  }

  const useSheetFirst = inferQaSheetFormat(req, options);
  const attemptPlans = [
    { useSheet: useSheetFirst, compact: false, jsonMode: true, label: useSheetFirst ? "sheet" : "scenarios" },
    { useSheet: useSheetFirst, compact: true, jsonMode: true, label: "compact" },
    { useSheet: false, compact: true, jsonMode: true, label: "scenarios-fallback" },
    { useSheet: useSheetFirst, compact: true, jsonMode: false, label: "no-json-mode" },
  ];

  let lastError = "unknown";
  let lastPreview = "";

  for (const attempt of attemptPlans) {
    let result;
    const opts = { ...options, qaSheetFormat: attempt.useSheet };
    try {
      result = await requestDataset({
        requirement: req,
        options: opts,
        model,
        provider,
        compact: attempt.compact,
        jsonMode: attempt.jsonMode,
        useSheet: attempt.useSheet,
        timeoutMs: DATASET_LLM_TIMEOUT_MS,
      });
    } catch (err) {
      lastError = err.message;
      if (shouldUseOrderTemplateFallback(lastError, req)) {
        const affordable = parseAffordableMaxTokens(lastError);
        return buildOrderE2eTemplateDataset(req, opts, {
          creditsNote: `OpenRouter credits exhausted (${affordable ?? "?"} tokens left) — built-in order E2E template used instead of AI.`,
        });
      }
      continue;
    }

    if (!result.text) {
      lastError = "empty AI response";
      continue;
    }

    const { data, error, partial } = extractJsonFromLlm(result.text);
    lastPreview = result.text.slice(0, 240);
    lastError = error || (result.stop_reason === "max_tokens" ? "response truncated" : "invalid JSON");

    if (datasetMeetsMinimum(data, { useSheet: attempt.useSheet, compact: attempt.compact })) {
      const normalized = normalizeDataset(data, {
        requirement: req,
        options: opts,
        model: result.model,
        usage: result.usage,
        partial,
      });
      if (requirementWantsRunnerScenarios(req) && !normalized.scenarios?.length) {
        lastError = "AI returned sheet rows without runnable scenarios";
        continue;
      }
      return normalized;
    }

    if (partial && data?.scenarios?.length >= 3) {
      return normalizeDataset(data, {
        requirement: req,
        options: { ...opts, qaSheetFormat: false },
        model: result.model,
        usage: result.usage,
        partial: true,
      });
    }

    if (partial && data?.sheetRows?.length >= 4 && !requirementWantsRunnerScenarios(req)) {
      return normalizeDataset(data, {
        requirement: req,
        options: { ...opts, qaSheetFormat: true },
        model: result.model,
        usage: result.usage,
        partial: true,
      });
    }
  }

  if (shouldUseOrderTemplateFallback(lastError, req)) {
    const affordable = parseAffordableMaxTokens(lastError);
    return buildOrderE2eTemplateDataset(req, options, {
      creditsNote: `OpenRouter credits exhausted (${affordable ?? "?"} tokens left) — built-in order E2E template used instead of AI.`,
    });
  }

  const affordable = parseAffordableMaxTokens(lastError);
  const creditsHint = isOpenRouterCreditsError(lastError)
    ? ` OpenRouter credits too low${affordable != null ? ` (${affordable} tokens left)` : ""} — add credits at https://openrouter.ai/settings/credits or switch AI provider in API Settings.`
    : "";
  const hint = useSheetFirst
    ? " Uncheck Google Sheet QA format for Run-in-UI / order E2E requirements."
    : "";
  throw new Error(
    `AI did not return valid test dataset JSON (${lastError}).${creditsHint} Try a shorter requirement or reduce min scenarios.${hint} Preview: ${lastPreview}`
  );
}

module.exports = {
  generateTestDataset,
  generateTestDatasetFromDocs,
  generateBackendOnlyTestDatasetFromPostman,
  buildOrderE2eTemplateDataset,
  inferQaSheetFormat,
  requirementWantsRunnerScenarios,
  deriveScenariosFromSheetRows,
  ensureRunnableScenarios,
  TEST_AREAS,
  SCOPE_TYPES,
  extractJsonFromLlm,
  sheetRowsToTsv,
  sheetRowsToCsv,
};
