const { generateTestDatasetFromDocs, ensureRunnableScenarios } = require("./test-dataset-generation");
const { runE2eBatch } = require("./test-e2e-batch");
const { saveDataset } = require("./test-dataset-store");
const { isScriptFirstTestcaseBackend } = require("./testcase-backend");

function filterE2eScenarios(dataset) {
  const scenarios = Array.isArray(dataset?.scenarios) ? dataset.scenarios : [];
  return scenarios.filter((s) => s.category === "e2e" || s.inputs?.e2eFlow || s.inputs?.uiAction);
}

/**
 * Full pipeline: PRD + manual → MCP test cases → E2E run with Playwright MCP self-heal.
 */
async function runDocsToE2ePipeline({
  moduleName,
  prd,
  userManual,
  description = "",
  sessionId = "",
  options = {},
  model,
  provider,
  runId,
  showBrowser = false,
  captureEvidence = true,
  saveDataset: shouldSave = true,
}) {
  if (isScriptFirstTestcaseBackend()) {
    return {
      ok: false,
      phase: "generate",
      error:
        "TESTCASE_BACKEND=scripts — doc pipeline disabled. Import your scripts and use Run all in the Testing tab.",
      dataset: null,
      batch: null,
    };
  }

  let dataset = await generateTestDatasetFromDocs({
    moduleName,
    prd,
    userManual,
    description,
    sessionId,
    options,
    model,
    provider,
  });
  dataset = ensureRunnableScenarios(dataset);
  if (shouldSave) saveDataset(dataset);

  const e2eScenarios = filterE2eScenarios(dataset);
  if (!e2eScenarios.length) {
    return {
      ok: false,
      phase: "generate",
      error: "No runnable E2E scenarios in dataset — check PRD/manual describe panel UI flows",
      dataset,
      batch: null,
    };
  }

  const batch = await runE2eBatch(
    e2eScenarios,
    { runId, showBrowser, captureEvidence, model, provider },
    { datasetTitle: dataset.title || moduleName }
  );

  return {
    ok: batch.ok,
    phase: "complete",
    dataset,
    e2eCount: e2eScenarios.length,
    batch,
  };
}

module.exports = { runDocsToE2ePipeline, filterE2eScenarios };
