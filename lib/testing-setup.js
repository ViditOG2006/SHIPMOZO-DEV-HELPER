const fs = require("fs");
const path = require("path");
const { getConfigStatus } = require("./ai-config");
const { getAiScopeStatus, isAiScopeEnabled } = require("./ai-scope");
const { apiRunBackend, apiRunBackendLabel } = require("./api-run-backend");
const { testcaseBackendLabel } = require("./testcase-backend");
const { getNavScript } = require("./e2e-script-store");

const NAV_SCRIPT_PATH = path.join(__dirname, "..", "output", "runtime", "e2e-ai-script.json");

function envSet(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function getTestingSetupStatus() {
  const ai = getConfigStatus();
  const aiScope = getAiScopeStatus();
  const postmanKey = envSet("POSTMAN_API_KEY");
  const collectionId = envSet("POSTMAN_COLLECTION_ID");
  const workspaceId = envSet("POSTMAN_WORKSPACE_ID");
  const panelLogin = envSet("SHIPMOZO_EMAIL") && envSet("SHIPMOZO_PASSWORD");
  const apiBase = envSet("SHIPMOZO_API_BASE_URL") || envSet("API_BASE_URL");
  const apiRun = apiRunBackend();

  let newmanOk = false;
  try {
    require.resolve("newman");
    newmanOk = true;
  } catch {
    newmanOk = false;
  }

  const navScript = getNavScript();
  const navScriptFile = fs.existsSync(NAV_SCRIPT_PATH);

  const items = [
    {
      id: "llm",
      label: "LLM API key",
      required: true,
      ok: ai.configured,
      hint: ai.configured
        ? `Provider: ${ai.provider} · model: ${ai.model}`
        : "Set ANTHROPIC_API_KEY + AI_PROVIDER=claude in .env (or API Settings)",
    },
    {
      id: "postman_key",
      label: "Postman API key (PMAK)",
      required: true,
      ok: postmanKey,
      hint: postmanKey
        ? "POSTMAN_API_KEY is set"
        : "https://postman.postman.co/settings/me/api-keys",
    },
    {
      id: "postman_collection",
      label: "Postman collection ID",
      required: false,
      ok: collectionId,
      hint: collectionId
        ? `POSTMAN_COLLECTION_ID=${process.env.POSTMAN_COLLECTION_ID}`
        : "Optional if AI creates collection — otherwise paste collection UID from Postman",
    },
    {
      id: "postman_workspace",
      label: "Postman workspace ID",
      required: false,
      ok: workspaceId,
      hint: workspaceId ? "Set" : "Recommended for AI collection create",
    },
    {
      id: "api_run",
      label: "API run backend",
      required: true,
      ok: apiRun === "postman-mcp" || apiRun === "http",
      hint: `Current: ${apiRunBackendLabel()} (set API_RUN_BACKEND=postman-mcp)`,
    },
    {
      id: "newman",
      label: "Newman (npm)",
      required: apiRun === "postman-mcp" || apiRun === "postman",
      ok: newmanOk,
      hint: newmanOk ? "Installed" : "Run npm install",
    },
    {
      id: "panel_login",
      label: "Shipmozo panel login",
      required: true,
      ok: panelLogin,
      hint: panelLogin ? "SHIPMOZO_EMAIL + SHIPMOZO_PASSWORD" : "Required for UI E2E tests",
    },
    {
      id: "nav_script",
      label: "Nav script (frontend)",
      required: false,
      ok: navScriptFile || Boolean(navScript?.navSteps?.length),
      hint: navScriptFile
        ? "output/runtime/e2e-ai-script.json"
        : "Import nav script JSON in Testing tab",
    },
    {
      id: "testcase_gen",
      label: "AI scope: testcase_gen",
      required: false,
      ok: isAiScopeEnabled("testcase_gen"),
      hint: "Needed only for Postman MCP agent (create collection)",
    },
    {
      id: "script_debug",
      label: "AI scope: script_debug",
      required: false,
      ok: isAiScopeEnabled("script_debug"),
      hint: "Needed for Playwright MCP nav heal on UI failure",
    },
    {
      id: "api_base",
      label: "API base URL (http mode only)",
      required: apiRun === "http",
      ok: apiBase,
      hint: apiBase ? "SHIPMOZO_API_BASE_URL set" : "Only if API_RUN_BACKEND=http",
    },
  ];

  const requiredMissing = items.filter((i) => i.required && !i.ok).map((i) => i.id);
  const readyForHybridRun =
    ai.configured &&
    postmanKey &&
    panelLogin &&
    (apiRun !== "postman-mcp" || newmanOk) &&
    (collectionId || isAiScopeEnabled("testcase_gen"));

  return {
    ok: requiredMissing.length === 0,
    readyForHybridRun,
    requiredMissing,
    backends: {
      testcaseGen: testcaseBackendLabel(),
      apiRun: apiRunBackendLabel(),
      scriptDebug: aiScope.backends?.scriptDebug || "mcp",
    },
    items,
    docsPath: "docs/TESTING-WORKFLOW.md",
  };
}

module.exports = { getTestingSetupStatus };
