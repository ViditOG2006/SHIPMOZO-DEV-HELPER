const { callLLM } = require("./llm");
const { extractJsonFromLlm } = require("./parse-llm-json");
const { gatherMcpSources } = require("./mcp-report-agent");
const {
  QA_SHEET_ARCHITECT_PROMPT,
  deriveModuleShortCode,
  buildSheetJsonSchemaInstruction,
} = require("./qa-sheet-template");

function buildDocsSystemPrompt(compact = false) {
  return `${QA_SHEET_ARCHITECT_PROMPT}

CRITICAL: Respond with a single valid JSON object only. No markdown code fences.
${compact ? "COMPACT MODE enabled." : ""}`;
}

function truncateForPrompt(text, max) {
  const s = String(text || "");
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated]`;
}

function buildDocsUserPrompt({ moduleName, prd, userManual, description, options, compact }) {
  const moduleShortCode = deriveModuleShortCode(moduleName);
  return `Module under test: **${moduleName}**
Module short code: **${moduleShortCode}**
${description ? `Context:\n${description}\n` : ""}

--- PRD ---
${truncateForPrompt(prd, compact ? 5000 : 10000)}
--- end PRD ---

--- USER MANUAL ---
${truncateForPrompt(userManual, compact ? 5000 : 10000)}
--- end USER MANUAL ---`;
}

const TESTCASE_ORCHESTRATOR_SYSTEM = `You are an MCP orchestrator for Shipmozo E2E test-case generation.

Input: PRD + User Manual (provided in the user message). Postman is NOT used.

Your job: call Playwright MCP tools ONLY to verify UI flows described in the docs (navigate panel, snapshot, Quick Search Ctrl+B).

Output JSON per turn:
- "mcp_call": { server: "playwright", tool, arguments, reason }
- "finish_gathering": { reason, summary }

Do NOT write test cases in this phase. Max one mcp_call per turn.`;

function formatSourcesForTestCompile(sources) {
  if (!sources.length) return "(no Playwright MCP verification — use PRD/manual only)";
  return sources
    .map(
      (s, i) =>
        `### MCP_VERIFY_${i + 1}: playwright.${s.tool}\n${String(s.text).slice(0, 8000)}`
    )
    .join("\n\n");
}

async function compileTestDatasetFromDocs({
  moduleName,
  prd,
  userManual,
  description,
  options,
  sources,
  model,
  provider,
}) {
  const moduleShortCode = deriveModuleShortCode(moduleName);
  const docsBlock = buildDocsUserPrompt({
    moduleName,
    prd,
    userManual,
    description,
    options,
    compact: true,
  });
  const mcpBlock = formatSourcesForTestCompile(sources);

  const compileUser = `${docsBlock}

--- PLAYWRIGHT MCP VERIFICATION (optional UI evidence) ---
${mcpBlock}
--- end MCP verification ---

${buildSheetJsonSchemaInstruction({ moduleName, moduleShortCode })}

Compile test cases JSON from PRD + manual + MCP verification ONLY.
Prefer runnable E2E scenarios (category e2e, inputs.e2eFlow) when docs describe panel UI flows.
Do not invent APIs or screens not in the docs or MCP snapshots.`;

  const result = await callLLM({
    model,
    provider,
    scope: "testcase_gen",
    system: `${buildDocsSystemPrompt(true)}

You are a compiler: output single JSON object with sheetRows and/or scenarios derived from the documentation and MCP evidence.`,
    jsonMode: true,
    maxTokens: Number(process.env.DATASET_MAX_OUTPUT_TOKENS || 6000),
    timeoutMs: Number(process.env.DATASET_LLM_TIMEOUT_MS || 240000),
    messages: [{ role: "user", content: compileUser }],
  });

  const { data, error } = extractJsonFromLlm(result.text);
  if (!data) throw new Error(error || "Test case compiler did not return valid JSON");

  return { data, model: result.model, usage: result.usage };
}

/**
 * PRD + user manual → LLM commands Playwright MCP → LLM compiles test dataset JSON.
 */
async function generateTestCasesViaMcpAgent({
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
  const docsBlock = buildDocsUserPrompt({
    moduleName: name,
    prd: prdText || "(none)",
    userManual: manualText || "(none)",
    description,
    options,
    compact: true,
  });

  const gather = await gatherMcpSources({
    docType: "testcases",
    moduleName: name,
    description,
    extraContext: `PRIMARY SOURCE — PRD and User Manual (do not use Postman):\n${docsBlock.slice(0, 12000)}`,
    model,
    provider,
    allowedServers: ["playwright"],
    orchestratorSystem: TESTCASE_ORCHESTRATOR_SYSTEM,
    maxRounds: Number(process.env.TESTCASE_MCP_AGENT_ROUNDS || 5),
    scope: "testcase_gen",
  });

  const { data, model: compileModel, usage } = await compileTestDatasetFromDocs({
    moduleName: name,
    prd: prdText,
    userManual: manualText,
    description,
    options,
    sources: gather.sources,
    model,
    provider,
  });

  const requirement = `Test cases for module "${name}" from PRD + user manual (MCP agent)`;
  const sourceDocs = {
    moduleName: name,
    sessionId: sessionId || null,
    description: String(description || "").slice(0, 500),
    prdChars: prdText.length,
    manualChars: manualText.length,
    generatedBy: "docs-mcp-agent",
  };

  for (const s of data.scenarios || []) {
    if (!s.inputs) s.inputs = {};
    if (!s.inputs.moduleName) s.inputs.moduleName = name;
    if (s.inputs.useLivePanel == null) s.inputs.useLivePanel = true;
  }

  const { normalizeDataset } = require("./test-dataset-generation");
  const dataset = normalizeDataset(data, {
    requirement,
    options: { ...options, fromDocs: true, moduleName: name, qaSheetFormat: Boolean(data.sheetRows?.length) },
    model: compileModel,
    usage,
    partial: false,
    sourceDocs,
  });

  dataset.generatedBy = "docs-mcp-agent";
  dataset.mcpAgent = {
    finishReason: gather.finishReason,
    toolCalls: gather.toolCalls,
    sourceCount: gather.sources.length,
  };

  return dataset;
}

module.exports = {
  generateTestCasesViaMcpAgent,
};
