const { callLLM } = require("./llm");
const { extractJsonFromLlm } = require("./parse-llm-json");
const { gatherMcpSources } = require("./mcp-report-agent");
const { parsePostmanMcpResult } = require("./postman-mcp-parse");
const { nowSessionId } = require("./doc-generation");

const POSTMAN_TESTCASE_ORCHESTRATOR = `You are an MCP orchestrator for Shipmozo **backend API** test automation via Postman MCP.

Your job: **CREATE or UPDATE** a Postman collection with API requests and test scripts. Dev Helper runs the collection later via Newman (not runCollection MCP).

Output JSON per turn (no markdown fences):
- "action": "mcp_call" — fields: server ("postman" only), tool, arguments (object), reason (string)
- "action": "finish_gathering" — fields: reason, summary, collectionId (string if known), workspaceId (string if known)

Workflow (typical):
1. getWorkspaces — find target workspace (use POSTMAN_WORKSPACE_ID from context when set)
2. getCollections — see existing collections OR use POSTMAN_COLLECTION_ID to update
3. createCollection — new collection shell in workspace (if no suitable collection exists)
4. createCollectionRequest — add each API test (flat list; createCollectionFolder may be unavailable)
5. updateCollectionRequest — add/fix test scripts (pm.test assertions) on requests
6. createEnvironment / getEnvironments — base URL + auth variables when needed
7. getCollection — verify requests exist after create/update
8. finish_gathering — when collection is ready (include collectionId in response)

RULES:
- Max **one** mcp_call per turn. Postman only — never Playwright.
- Each request should include Postman **tests** tab scripts (pm.test assertions).
- Use workspace/collection IDs returned by prior MCP calls — do not invent UUIDs.
- Prefer updating POSTMAN_COLLECTION_ID when set; otherwise create a new collection named from the requirement.
- Include happy path + at least one negative/boundary API case when requirement allows.
- Do NOT write Dev Helper JSON in this phase — only Postman MCP operations.`;

function formatSourcesForCompile(sources) {
  if (!sources.length) return "(no Postman MCP actions recorded)";
  return sources
    .map(
      (s, i) =>
        `### POSTMAN_MCP_${i + 1}: ${s.tool}${s.isError ? " [ERROR]" : ""}\nReason: ${s.reason || "—"}\n\`\`\`\n${String(s.text).slice(0, 10000)}\n\`\`\``
    )
    .join("\n\n");
}

function tryParseSourceText(text) {
  const raw = String(text || "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return parsePostmanMcpResult({ content: [{ type: "text", text: raw }] });
  }
}

function extractPostmanIds(sources, finishMeta = {}) {
  let collectionId =
    String(finishMeta.collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  let workspaceId =
    String(finishMeta.workspaceId || process.env.POSTMAN_WORKSPACE_ID || "").trim();
  let collectionName = "";

  for (const s of sources) {
    const data = tryParseSourceText(s.text);
    if (!data) continue;

    const coll = data.collection || data.data?.collection || data;
    if (coll?.info?.name) collectionName = coll.info.name;
    const cid =
      coll?.info?.uid ||
      coll?.info?._postman_id ||
      coll?.id ||
      coll?.uid ||
      data.collectionId ||
      data.id;
    if (cid && /collection|create/i.test(`${s.tool} ${s.reason}`)) {
      collectionId = String(cid);
    }
    const wid = data.workspace?.id || data.workspaceId || data.workspace;
    if (wid) workspaceId = String(wid);
  }

  if (!collectionId) {
    for (const s of sources) {
      const m = String(s.text || "").match(
        /collection[_\s-]?(?:id|uid)["'\s:]*["']?([a-zA-Z0-9-]{8,})/i
      );
      if (m) {
        collectionId = m[1];
        break;
      }
    }
  }

  return { collectionId, workspaceId, collectionName };
}

async function compileTestDatasetFromPostmanMcp({
  requirement,
  sources,
  finishMeta,
  options,
  model,
  provider,
}) {
  const mcpBlock = formatSourcesForCompile(sources);
  const ids = extractPostmanIds(sources, finishMeta);

  const compileUser = `Requirement:
${requirement}

Postman IDs detected: collectionId=${ids.collectionId || "(unknown)"} workspaceId=${ids.workspaceId || "(unknown)"}

--- POSTMAN MCP ACTION LOG (primary evidence) ---
${mcpBlock}
--- end log ---

Compile a Dev Helper test dataset JSON from the Postman MCP log above.

Output a single JSON object:
{
  "title": "string",
  "summary": "string",
  "scenarios": [
    {
      "id": "API-001",
      "title": "string",
      "category": "api",
      "type": "happy_path|negative|boundary",
      "priority": "critical|high|medium|low",
      "description": "string",
      "steps": ["..."],
      "inputs": {
        "apiMethod": "GET|POST|PUT|PATCH|DELETE",
        "apiEndpoint": "/path",
        "apiBody": null,
        "postmanCollectionId": "${ids.collectionId || ""}",
        "postmanRequestName": "request name in collection"
      },
      "expectedResults": {
        "httpStatus": 200,
        "responseFields": []
      },
      "tags": ["postman-mcp", "postman-agent"]
    }
  ]
}

RULES:
- One scenario per API request created or run in the MCP log.
- Use only APIs evidenced in POSTMAN_MCP_* blocks — do not invent endpoints.
- Set inputs.postmanCollectionId on every scenario when collectionId is known.
- Minimum ${Number(options.minScenarios) || 4} scenarios when log has enough requests.`;

  const result = await callLLM({
    model,
    provider,
    scope: "testcase_gen",
    system: `You compile test datasets from Postman MCP action logs only. Output single valid JSON object. No markdown fences.`,
    jsonMode: true,
    maxTokens: Number(process.env.DATASET_MAX_OUTPUT_TOKENS || 6000),
    timeoutMs: Number(process.env.DATASET_LLM_TIMEOUT_MS || 240000),
    messages: [{ role: "user", content: compileUser }],
  });

  const { data, error } = extractJsonFromLlm(result.text);
  if (!data?.scenarios?.length) {
    throw new Error(error || "Postman MCP compiler did not return scenarios[]");
  }

  if (ids.collectionId) {
    data.postman = {
      ...(data.postman || {}),
      collectionId: ids.collectionId,
      workspaceId: ids.workspaceId || undefined,
      collectionName: ids.collectionName || undefined,
      createdBy: "postman-mcp-agent",
    };
    for (const s of data.scenarios) {
      if (!s.inputs) s.inputs = {};
      if (!s.inputs.postmanCollectionId) s.inputs.postmanCollectionId = ids.collectionId;
      if (!s.tags?.includes("postman-mcp")) {
        s.tags = [...(s.tags || []), "postman-mcp", "postman-agent"];
      }
    }
  }

  return { data, model: result.model, usage: result.usage, postmanIds: ids };
}

/**
 * LLM commands Postman MCP to create/update collections + requests, runCollection, then compile dataset JSON.
 */
async function generateTestCasesViaPostmanMcpAgent({
  requirement,
  options = {},
  model,
  provider,
}) {
  const req = String(requirement || "").trim();
  if (!req) throw new Error("requirement text is required");

  const key = String(process.env.POSTMAN_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "POSTMAN_API_KEY is required. Get one at https://postman.postman.co/settings/me/api-keys"
    );
  }

  const apiBase = String(process.env.SHIPMOZO_API_BASE_URL || process.env.API_BASE_URL || "").trim();
  const gather = await gatherMcpSources({
    docType: "postman-api-tests",
    moduleName: options.moduleName || "API",
    description: req,
    extraContext: `API test requirement:
${req}

POSTMAN_WORKSPACE_ID: ${process.env.POSTMAN_WORKSPACE_ID || "(call getWorkspaces)"}
POSTMAN_COLLECTION_ID: ${process.env.POSTMAN_COLLECTION_ID || "(create new collection unless requirement says update existing)"}
POSTMAN_ENVIRONMENT_ID: ${process.env.POSTMAN_ENVIRONMENT_ID || "(optional)"}
API base URL: ${apiBase || "(infer from requirement or use {{baseUrl}} variable)"}`,
    model,
    provider,
    allowedServers: ["postman"],
    orchestratorSystem: POSTMAN_TESTCASE_ORCHESTRATOR,
    maxRounds: Number(process.env.POSTMAN_MCP_AGENT_ROUNDS || 12),
    scope: "testcase_gen",
  });

  let finishMeta = {};
  const lastAssistant = gather.toolCalls?.length
    ? gather.sources[gather.sources.length - 1]
    : null;
  if (gather.finishReason) {
    finishMeta = { reason: gather.finishReason };
  }

  const { data, model: compileModel, usage, postmanIds } =
    await compileTestDatasetFromPostmanMcp({
      requirement: req,
      sources: gather.sources,
      finishMeta,
      options,
      model,
      provider,
    });

  const { normalizeDataset } = require("./test-dataset-generation");
  const dataset = normalizeDataset(data, {
    requirement: req,
    options: { ...options, qaSheetFormat: false },
    model: compileModel,
    usage,
    partial: false,
    sourceDocs: null,
  });

  dataset.generatedBy = "postman-mcp-agent";
  dataset.postman = {
    ...(dataset.postman || {}),
    ...postmanIds,
    agent: {
      finishReason: gather.finishReason,
      toolCalls: gather.toolCalls,
      rounds: gather.sources.length,
    },
  };

  return dataset;
}

module.exports = {
  generateTestCasesViaPostmanMcpAgent,
  POSTMAN_TESTCASE_ORCHESTRATOR,
  extractPostmanIds,
};
