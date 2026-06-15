const { runPythonScript } = require("./spawn-python");
const { parsePythonJson } = require("./parse-python-json");
const { storeScreenshotBatch } = require("./image-storage");
const { pythonEnvFromContext } = require("./playwright-env");

const EVIDENCE_TIMEOUT_MS = Number(process.env.TEST_EVIDENCE_TIMEOUT_MS || 180000);

async function captureScenarioEvidence(runId, scenario, ctx = {}) {
  const moduleName = scenario.inputs?.moduleName || scenario.module || "";
  const chatQuery = scenario.inputs?.chatQuery || "";
  const description = scenario.inputs?.description || "";

  const proc = await runPythonScript(
    "capture_test_evidence.py",
    [runId, scenario.id, moduleName, chatQuery, description],
    EVIDENCE_TIMEOUT_MS,
    { env: pythonEnvFromContext(ctx), killKey: `${runId}:evidence` }
  );

  const raw = (proc.stdout || "").trim();
  if (!raw) {
    return { ok: false, error: proc.stderr || "No evidence output", screenshots: [] };
  }

  const { data, error } = parsePythonJson(raw);
  if (!data?.ok || !data.screenshot) {
    return {
      ok: false,
      error: data?.error || error || "Evidence capture failed",
      screenshots: [],
    };
  }

  const stored = await storeScreenshotBatch(runId, [data.screenshot]);
  return { ok: true, screenshots: stored };
}

module.exports = { captureScenarioEvidence };
