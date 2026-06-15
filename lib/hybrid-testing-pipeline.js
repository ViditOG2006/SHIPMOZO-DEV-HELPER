const { nowSessionId } = require("./doc-generation");
const { saveDataset } = require("./test-dataset-store");
const { saveRun } = require("./test-run-store");
const { importDatasetFromPostmanCollection } = require("./postman-mcp-dataset");
const { generateTestCasesViaPostmanMcpAgent } = require("./mcp-postman-testcase-agent");
const { normalizeImportedDataset, saveNavScript } = require("./e2e-script-store");
const { runE2eBatch } = require("./test-e2e-batch");
const { runTestStep, buildRunRecord } = require("./test-dataset-runner");
const { isAiScopeEnabled } = require("./ai-scope");

const { isPanelE2eScenario, isPanelUiScenario } = require("./panel-ui-scenario");

function mergeScenarios(apiScenarios = [], e2eScenarios = []) {
  const out = [];
  const seen = new Set();
  for (const s of [...apiScenarios, ...e2eScenarios]) {
    const id = String(s.id || "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(s);
  }
  return out;
}

function buildMergedDataset({ apiScenarios, e2eScenarios, title, collectionId, postmanMeta }) {
  const scenarios = mergeScenarios(apiScenarios, e2eScenarios);
  const id = nowSessionId().replace(/[^0-9_a-z]/gi, "");
  return {
    id,
    title: title || "Hybrid API + UI test suite",
    summary: `${scenarios.filter((s) => s.category === "api").length} API + ${scenarios.filter(isPanelE2eScenario).length} E2E scenario(s)`,
    requirement: "Hybrid workflow — Postman API + imported UI scripts",
    scenarios,
    scenarioCount: scenarios.length,
    generatedBy: "hybrid-pipeline",
    postman: {
      collectionId: collectionId || process.env.POSTMAN_COLLECTION_ID || null,
      ...(postmanMeta || {}),
    },
    createdAt: new Date().toISOString(),
  };
}

async function executeHybridRun(dataset, opts = {}) {
  const runId = opts.runId || `${dataset.id}_run_${Date.now()}`;
  const startedAt = new Date().toISOString();
  const scenarios = dataset.scenarios || [];
  const panelE2e = scenarios.filter(isPanelE2eScenario);
  const apiScenarios = scenarios.filter((s) => !isPanelE2eScenario(s));

  const results = [];
  let batchMeta = null;

  if (panelE2e.length && !opts.skipLive) {
    batchMeta = await runE2eBatch(
      panelE2e,
      {
        runId,
        showBrowser: opts.showBrowser !== false,
        captureEvidence: opts.captureEvidence !== false,
        model: opts.model,
        provider: opts.provider,
        skipAiHeal: opts.skipAiHeal ?? !isAiScopeEnabled("script_debug"),
      },
      { datasetTitle: dataset.title }
    );
    for (const r of batchMeta.results || []) {
      results.push(r);
    }
  } else if (panelE2e.length && opts.skipLive) {
    for (const s of panelE2e) {
      results.push({
        scenarioId: s.id,
        title: s.title,
        status: "skipped",
        reason: "skipLive enabled",
      });
    }
  }

  const postmanFolders = dataset.postman?.selectedFolders?.length
    ? dataset.postman.selectedFolders
    : null;

  for (const scenario of apiScenarios) {
    const step = await runTestStep({
      runId,
      scenario,
      skipLive: opts.skipLive,
      captureEvidence: opts.captureEvidence !== false,
      showBrowser: opts.showBrowser !== false,
      model: opts.model,
      provider: opts.provider,
      postmanFolders,
    });
    results.push(step);
  }

  const run = buildRunRecord({
    runId,
    dataset,
    results,
    startedAt,
    options: {
      skipLive: opts.skipLive,
      captureEvidence: opts.captureEvidence !== false,
      showBrowser: opts.showBrowser !== false,
      hybrid: true,
    },
  });
  saveRun(run);

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;

  return {
    ok: failed === 0 && passed > 0,
    run,
    batch: batchMeta,
    summary: run.summary,
  };
}

/**
 * Hybrid pipeline: Postman API scenarios + user E2E scripts → optional Run all.
 *
 * postmanMode: "skip" | "import" | "agent"
 */
async function runHybridTestingPipeline({
  postmanMode = "import",
  collectionId = "",
  postmanRequirement = "",
  postmanFolders = null,
  e2eDataset = null,
  e2eScenarios = null,
  navScript = null,
  title = "",
  runTests = true,
  saveDataset: shouldSave = true,
  model,
  provider,
  showBrowser = true,
  captureEvidence = true,
  skipLive = false,
  runId,
  options = {},
} = {}) {
  const phases = [];
  let apiScenarios = [];
  let resolvedCollectionId = String(collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  let postmanMeta = {};

  const mode = String(postmanMode || "import").toLowerCase();

  if (mode === "agent") {
    if (!String(postmanRequirement || "").trim()) {
      throw new Error("postmanRequirement is required when postmanMode=agent");
    }
    if (!isAiScopeEnabled("testcase_gen")) {
      throw new Error("testcase_gen must be in AI_SCOPE for Postman MCP agent");
    }
    const ds = await generateTestCasesViaPostmanMcpAgent({
      requirement: postmanRequirement,
      options,
      model,
      provider,
    });
    apiScenarios = ds.scenarios || [];
    resolvedCollectionId = ds.postman?.collectionId || resolvedCollectionId;
    postmanMeta = ds.postman || {};
    phases.push({ phase: "postman-agent", ok: true, collectionId: resolvedCollectionId });
  } else if (mode === "import") {
    const cid = resolvedCollectionId;
    if (!cid) {
      throw new Error("collectionId or POSTMAN_COLLECTION_ID required for postmanMode=import");
    }
    const folders = (postmanFolders || options.folders || [])
      .map((f) => String(f || "").trim())
      .filter(Boolean);
    if (!folders.length) {
      throw new Error("Select at least one Postman test group (folder) for import mode");
    }
    const ds = await importDatasetFromPostmanCollection({
      collectionId: cid,
      requirement: postmanRequirement || `Imported collection ${cid}`,
      options: { ...options, folders },
      folders,
    });
    apiScenarios = ds.scenarios || [];
    postmanMeta = ds.postman || {};
    phases.push({ phase: "postman-import", ok: true, collectionId: cid, scenarioCount: apiScenarios.length });
  } else {
    phases.push({ phase: "postman-skip", ok: true });
  }

  let uiScenarios = [];
  if (Array.isArray(e2eScenarios) && e2eScenarios.length) {
    uiScenarios = e2eScenarios;
  } else if (e2eDataset) {
    const normalized = normalizeImportedDataset(e2eDataset, { title: "UI scenarios" });
    uiScenarios = normalized.scenarios || [];
  }

  if (navScript) {
    saveNavScript(navScript, { source: "hybrid-pipeline" });
    phases.push({ phase: "nav-script", ok: true });
  }

  if (!apiScenarios.length && !uiScenarios.length) {
    return {
      ok: false,
      phase: "merge",
      error: "No API or E2E scenarios — import collection and/or E2E JSON",
      phases,
      dataset: null,
      run: null,
    };
  }

  for (const s of apiScenarios) {
    if (!s.inputs) s.inputs = {};
    if (resolvedCollectionId && !s.inputs.postmanCollectionId) {
      s.inputs.postmanCollectionId = resolvedCollectionId;
    }
  }

  const dataset = buildMergedDataset({
    apiScenarios,
    e2eScenarios: uiScenarios,
    title,
    collectionId: resolvedCollectionId,
    postmanMeta,
  });

  if (shouldSave) saveDataset(dataset);
  phases.push({
    phase: "merge",
    ok: true,
    apiCount: apiScenarios.length,
    e2eCount: uiScenarios.length,
  });

  if (!runTests) {
    return {
      ok: true,
      phase: "ready",
      dataset,
      collectionId: resolvedCollectionId,
      phases,
      run: null,
    };
  }

  const run = await executeHybridRun(dataset, {
    runId,
    model,
    provider,
    showBrowser,
    captureEvidence,
    skipLive,
  });
  phases.push({ phase: "run", ok: run.ok, summary: run.summary });

  return {
    ok: run.ok,
    phase: "complete",
    dataset,
    collectionId: resolvedCollectionId,
    phases,
    run: run.run,
    batch: run.batch,
    summary: run.summary,
  };
}

module.exports = {
  runHybridTestingPipeline,
  executeHybridRun,
  buildMergedDataset,
  isPanelE2eScenario,
};
