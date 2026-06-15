const fs = require("fs");
const path = require("path");
const { nowSessionId } = require("./doc-generation");
const { ensureRunnableScenarios } = require("./test-dataset-generation");

const ROOT = path.join(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT, "output", "runtime");
const NAV_SCRIPT_PATH = path.join(RUNTIME_DIR, "e2e-ai-script.json");

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function validateNavScript(script) {
  if (!script || typeof script !== "object") {
    throw new Error("nav script must be a JSON object");
  }
  if (!Array.isArray(script.navSteps)) {
    throw new Error("nav script must include navSteps array (use [] if already on target page)");
  }
  return script;
}

function getNavScript() {
  if (!fs.existsSync(NAV_SCRIPT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(NAV_SCRIPT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function saveNavScript(script, meta = {}) {
  const validated = validateNavScript(script);
  ensureRuntimeDir();
  const payload = {
    version: validated.version || 1,
    module: validated.module || meta.module || "Rate Calculator",
    rationale: validated.rationale || meta.rationale || "User-provided nav script",
    navSteps: validated.navSteps,
    verifyTexts: validated.verifyTexts || [],
    scenarioPlans: validated.scenarioPlans || [],
    source: validated.source || meta.source || "user-import",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(NAV_SCRIPT_PATH, JSON.stringify(payload, null, 2), "utf-8");
  return { path: NAV_SCRIPT_PATH, script: payload };
}

function normalizeImportedDataset(raw, { title } = {}) {
  if (!raw) throw new Error("dataset JSON is required");

  let body = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error("invalid JSON string");
    }
  }

  let scenarios = body.scenarios;
  if (!Array.isArray(scenarios) || !scenarios.length) {
    if (Array.isArray(body)) scenarios = body;
    else if (Array.isArray(body.tests)) scenarios = body.tests;
  }
  if (!Array.isArray(scenarios) || !scenarios.length) {
    throw new Error("dataset must include scenarios[] (or tests[]) with at least one item");
  }

  const normalizedScenarios = scenarios.map((s, index) => {
    const inputs = { ...(s.inputs || {}) };
    if (!inputs.e2eFlow && inputs.uiAction) inputs.e2eFlow = inputs.uiAction;
    return {
      ...s,
      id: String(s.id || s.TC_ID || `TC-${String(index + 1).padStart(3, "0")}`),
      title: String(s.title || s.Description || s.id || `Scenario ${index + 1}`),
      category: s.category || (inputs.e2eFlow || inputs.uiAction ? "e2e" : "api"),
      type: s.type || "happy_path",
      priority: s.priority || "medium",
      inputs,
      steps: s.steps || (typeof s.Steps === "string" ? s.Steps.split(/\n+/).filter(Boolean) : []),
    };
  });

  const id = String(body.id || nowSessionId());
  const dataset = {
    id,
    title: String(body.title || title || "Imported E2E scripts"),
    requirement: String(body.requirement || "User-provided E2E scripts (script-first)"),
    summary: String(body.summary || `${normalizedScenarios.length} imported scenario(s)`),
    scenarios: normalizedScenarios,
    scenarioCount: normalizedScenarios.length,
    sheetRows: body.sheetRows || [],
    generatedBy: "user-import",
    source: "user-import",
    createdAt: body.createdAt || new Date().toISOString(),
    options: { ...(body.options || {}), fromImport: true },
  };

  return ensureRunnableScenarios(dataset);
}

module.exports = {
  NAV_SCRIPT_PATH,
  getNavScript,
  saveNavScript,
  validateNavScript,
  normalizeImportedDataset,
};
