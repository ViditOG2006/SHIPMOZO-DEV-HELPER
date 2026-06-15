/** Build per-run env overrides for Python Playwright scripts. */
function pythonEnvFromContext(ctx = {}) {
  const env = { E2E_FAST: "1" };
  const uiRun = ctx.runTarget === "frontend" || ctx.runTarget === "both";
  const recordEvidence = ctx.captureEvidence !== false && (uiRun || ctx.recordVideo);

  if (ctx.showBrowser === true) env.HEADLESS = "false";
  else if (uiRun && recordEvidence) env.HEADLESS = "true";
  else if (ctx.showBrowser === false) env.HEADLESS = "true";

  if (recordEvidence) {
    env.RECORD_VIDEO = "1";
    if (ctx.runId) env.E2E_VIDEO_DIR = `output/test-runs/${ctx.runId}/videos`;
  }
  if (!recordEvidence) env.SKIP_SCREENSHOTS = "1";

  return env;
}

module.exports = { pythonEnvFromContext };
