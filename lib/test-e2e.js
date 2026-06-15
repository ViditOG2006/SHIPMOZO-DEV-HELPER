const fs = require("fs");
const path = require("path");
const { runPythonScript } = require("./spawn-python");
const { parsePythonJson } = require("./parse-python-json");
const { storeScreenshotBatch } = require("./image-storage");
const { pythonEnvFromContext } = require("./playwright-env");

const ROOT = path.join(__dirname, "..");
const E2E_TIMEOUT_DEFAULT_MS = 300000;
const E2E_TIMEOUT_MIN_MS = 180000;

function e2eTimeoutMs(scenario) {
  const configured = Number(process.env.PANEL_E2E_TIMEOUT_MS || E2E_TIMEOUT_DEFAULT_MS);
  return Math.max(configured, E2E_TIMEOUT_MIN_MS);
}

async function persistE2eScreenshot(runId, shot) {
  if (!shot) return { screenshots: [], count: 0 };

  const pathToUse = shot.path || shot.localPath;
  if (!pathToUse || !fs.existsSync(pathToUse)) {
    return { screenshots: [], count: 0 };
  }

  const normalized = { ...shot, path: pathToUse };
  try {
    const stored = await storeScreenshotBatch(runId, [normalized]);
    return { screenshots: stored, count: stored.length };
  } catch {
    return { screenshots: [normalized], count: 1 };
  }
}

async function runE2eScenario(scenario, ctx) {
  const flow = scenario.inputs?.e2eFlow || scenario.inputs?.uiAction;
  if (!flow) {
    return {
      ok: false,
      error: "E2E scenario missing inputs.e2eFlow or inputs.uiAction",
      durationMs: 0,
    };
  }

  const runId = ctx.runId || `e2e_${Date.now()}`;
  const tmpDir = path.join(ROOT, "output", "test-runs", runId, "e2e-input");
  fs.mkdirSync(tmpDir, { recursive: true });
  const scenarioPath = path.join(tmpDir, `${scenario.id}.json`);
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");

  const started = Date.now();
  const proc = await runPythonScript(
    "run_panel_e2e.py",
    [runId, scenarioPath],
    e2eTimeoutMs(scenario),
    { env: pythonEnvFromContext(ctx), killKey: `${runId}:e2e` }
  );

  const raw = (proc.stdout || "").trim();
  if (!raw) {
    return {
      ok: false,
      error: proc.error || proc.stderr || "E2E script produced no output",
      durationMs: Date.now() - started,
    };
  }

  const { data, error } = parsePythonJson(raw);
  if (!data) {
    return {
      ok: false,
      error: error || `Invalid E2E JSON: ${raw.slice(0, 200)}`,
      durationMs: Date.now() - started,
    };
  }

  const { screenshots, count } = await persistE2eScreenshot(runId, data.screenshot);

  return {
    ok: data.ok !== false,
    e2eFlow: data.e2eFlow || flow,
    pageUrl: data.pageUrl,
    uiText: data.uiText,
    referenceId: data.referenceId,
    stepsRun: data.stepsRun || [],
    screenshots,
    screenshotCount: count,
    error: data.error || (!data.ok ? "E2E flow failed" : null),
    durationMs: Date.now() - started,
    endpoint: "/api/testing/e2e",
    method: "PLAYWRIGHT",
  };
}

module.exports = { runE2eScenario, e2eTimeoutMs };
