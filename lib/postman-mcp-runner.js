const { createMcpHttpClient, callMcpTool, toolText, listMcpTools } = require("./mcp-client");
const { parsePostmanMcpResult } = require("./postman-mcp-parse");
const { postmanMcpUrl, postmanHeaders } = require("./postman-mcp-config");
const {
  runPostmanCollectionViaNewman,
  matchScenarioToExecution,
} = require("./postman-newman-runner");
const { getPostmanRunCache } = require("./postman-run-cache");

function collectionIdForScenario(scenario) {
  return (
    String(scenario?.inputs?.postmanCollectionId || "").trim() ||
    String(process.env.POSTMAN_COLLECTION_ID || "").trim()
  );
}

function environmentIdForScenario(scenario) {
  return (
    String(scenario?.inputs?.postmanEnvironmentId || "").trim() ||
    String(process.env.POSTMAN_ENVIRONMENT_ID || "").trim()
  );
}

function foldersForRun(scenario, ctx) {
  if (ctx?.postmanFolders?.length) return ctx.postmanFolders;
  const fromInputs = scenario?.inputs?.postmanFolders;
  if (Array.isArray(fromInputs) && fromInputs.length) return fromInputs;
  const folder = String(scenario?.inputs?.postmanFolder || "").trim();
  if (folder) return [folder];
  return null;
}

function parseRunOutcome(text, data) {
  const blob = `${text}\n${JSON.stringify(data || {})}`;
  const failed = (blob.match(/\bfailed\b/gi) || []).length;
  const passed = (blob.match(/\bpassed\b/gi) || []).length;
  const assertionsFailed = /assertion.*fail|test.*fail/i.test(blob);
  const ok =
    !assertionsFailed &&
    !/run failed|collection run failed|error:/i.test(blob) &&
    (passed > 0 || /success|completed/i.test(blob)) &&
    failed === 0;

  return { ok, passed, failed, blob: text.slice(0, 12000) };
}

let mcpRunCollectionCached = null;

async function mcpHasRunCollection() {
  if (mcpRunCollectionCached != null) return mcpRunCollectionCached;
  const key = String(process.env.POSTMAN_API_KEY || "").trim();
  if (!key) {
    mcpRunCollectionCached = false;
    return false;
  }
  try {
    const client = await createMcpHttpClient("postman-probe", postmanMcpUrl(), postmanHeaders(), {
      reuse: false,
    });
    const tools = await listMcpTools(client);
    await client.close().catch(() => {});
    mcpRunCollectionCached = (tools || []).some((t) => t.name === "runCollection");
    return mcpRunCollectionCached;
  } catch {
    mcpRunCollectionCached = false;
    return false;
  }
}

async function runPostmanCollectionOnce(ctx, scenario) {
  const collectionId = collectionIdForScenario(scenario);
  if (!collectionId) {
    throw new Error(
      "POSTMAN_COLLECTION_ID or scenario.inputs.postmanCollectionId is required for Postman API runs"
    );
  }

  const environmentId = environmentIdForScenario(scenario) || null;
  const folders = foldersForRun(scenario, ctx);
  const folderKey = folders?.length ? folders.slice().sort().join("|") : "all";
  const cacheKey = `${collectionId}:${environmentId || "no-env"}:${folderKey}`;
  const runCache = ctx.runId ? getPostmanRunCache(ctx.runId) : null;
  const cache = runCache || ctx._postmanRunCache || (ctx._postmanRunCache = {});
  if (cache[cacheKey]) {
    console.log(`[postman-newman] cache hit for folder run (${cacheKey.slice(0, 48)}…)`);
    return cache[cacheKey];
  }

  let payload;

  if (await mcpHasRunCollection()) {
    const client = await createMcpHttpClient("postman-run", postmanMcpUrl(), postmanHeaders());
    const args = { collectionId };
    if (environmentId) {
      args.environment = environmentId;
      args.environmentId = environmentId;
    }
    console.log(`[postman-mcp] runCollection ${collectionId}`);
    const result = await callMcpTool(client, "runCollection", args);
    const text = toolText(result);
    const data = parsePostmanMcpResult(result);
    const outcome = parseRunOutcome(text, data);
    payload = {
      ...outcome,
      collectionId,
      environmentId,
      data,
      runner: "postman-mcp",
      byName: {},
    };
    await client.close().catch(() => {});
  } else {
    console.log(`[postman-newman] runCollection not on MCP — using Newman + Postman API`);
    payload = await runPostmanCollectionViaNewman({ collectionId, environmentId, folders });
  }

  cache[cacheKey] = payload;
  return payload;
}

/**
 * Execute a backend API scenario via Postman collection run (Newman or MCP runCollection if available).
 */
async function runApiViaPostmanMcp(scenario, ctx) {
  const started = Date.now();
  try {
    const run = await runPostmanCollectionOnce(ctx, scenario);
    let ok = run.ok;
    let match = null;

    if (run.byName && Object.keys(run.byName).length) {
      match = matchScenarioToExecution(scenario, run.byName, run.blob || "");
      if (match) ok = match.ok !== false;
    }

    const requestMatched = Boolean(match);
    const requestOk = requestMatched ? match.ok !== false : null;

    return {
      ok,
      httpStatus: ok ? (match?.status || 200) : 0,
      method: scenario.inputs?.apiMethod || "POSTMAN",
      endpoint: scenario.inputs?.apiEndpoint || `postman:${run.collectionId}`,
      body: run.data || run.stats,
      postmanRun: {
        collectionId: run.collectionId,
        environmentId: run.environmentId,
        folders: foldersForRun(scenario, ctx),
        passed: run.passed,
        failed: requestMatched ? (requestOk ? 0 : 1) : run.failed,
        collectionFailed: run.failed,
        requestMatched,
        requestOk,
        requestStatus: match?.status,
        runner: run.runner || "newman",
        preview: String(run.blob || run.stdout || "").slice(0, 2000),
      },
      durationMs: Date.now() - started,
      skipped: false,
      error: ok
        ? undefined
        : requestMatched
          ? `Postman request failed (${scenario.inputs?.postmanRequestName || scenario.title})`
          : "Postman collection run reported failures",
    };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      method: "POSTMAN",
      endpoint: scenario.inputs?.apiEndpoint || "postman",
      error: err.message,
      durationMs: Date.now() - started,
      skipped: false,
    };
  }
}

module.exports = {
  runApiViaPostmanMcp,
  runPostmanCollectionOnce,
  collectionIdForScenario,
};
