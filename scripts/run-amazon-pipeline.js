/**
 * Full E2E pipeline: Amazon channel integration
 * Docs (PRD → screenshots → manual) → test cases → run all
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const MODULE = "Amazon";
const DESCRIPTION =
  "Amazon channel integration — connect seller account, MWS/SP-API credentials, order sync, inventory sync, channel settings";

const summary = {
  startedAt: new Date().toISOString(),
  phases: {},
  artifacts: {},
};

async function api(path, body, { timeoutMs = 900000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function poll(path, { maxWaitMs = 900000, pollMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const st = await api(path, null, { timeoutMs: 60000 });
    if (st.status === "done" || st.status === "error" || st.status === "failed") return st;
    process.stdout.write(`  … ${st.status || "running"} ${st.elapsedSeconds || Math.round((st.elapsedMs || 0) / 1000)}s\r`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timeout polling ${path}`);
}

function log(phase, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${phase}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const pipelineStart = Date.now();
  console.log("=== Amazon Channel Integration — full pipeline ===\n");

  const health = await api("/api/health");
  const split = health.ai?.reportLlmSplit;
  log("Server health", health.ok, health.localUrl);
  log(
    "Claude PRD",
    split?.prd?.configured,
    `${split?.prd?.providerLabel} · ${split?.prd?.model}`
  );
  log(
    "Azure manual",
    split?.manual?.configured,
    `${split?.manual?.providerLabel} · ${split?.manual?.model}`
  );

  const sessionId = `amazon_${Date.now()}`;
  summary.sessionId = sessionId;
  let prd = "";
  let userManual = "";
  let screenshots = [];
  let videos = [];

  // --- Phase 1: Docs ---
  console.log("\n--- Phase 1: PRD ---");
  const prdT0 = Date.now();
  try {
    const prdRes = await api("/api/docs/generate-step", {
      step: "prd",
      moduleName: MODULE,
      description: DESCRIPTION,
      sessionId,
      provider: "claude",
    });
    prd = prdRes.prd || "";
    const sec = Math.round((Date.now() - prdT0) / 1000);
    summary.phases.prd = { ok: prd.length > 500, chars: prd.length, seconds: sec, model: prdRes.generatedBy };
    log("PRD", summary.phases.prd.ok, `${prd.length} chars · ${prdRes.generatedBy} · ${sec}s`);
  } catch (e) {
    summary.phases.prd = { ok: false, error: e.message };
    log("PRD", false, e.message);
    process.exit(1);
  }

  console.log("\n--- Phase 1b: Screenshots & video ---");
  const shotT0 = Date.now();
  try {
    const shotStart = await api("/api/docs/screenshots/start", {
      moduleName: MODULE,
      description: DESCRIPTION,
      sessionId,
    });
    const shotJob = await poll(`/api/docs/screenshots/status/${shotStart.jobId}`, { maxWaitMs: 420000 });
    screenshots = shotJob.screenshots || [];
    videos = shotJob.videos || [];
    const sec = Math.round((Date.now() - shotT0) / 1000);
    summary.phases.screenshots = {
      ok: screenshots.length > 0,
      count: screenshots.length,
      videos: videos.length,
      seconds: sec,
      captureError: shotJob.captureError || null,
    };
    log("Screenshots", summary.phases.screenshots.ok, `${screenshots.length} shot(s) · ${sec}s`);
    log("Videos", videos.length > 0, `${videos.length} recording(s)`);
  } catch (e) {
    summary.phases.screenshots = { ok: false, error: e.message };
    log("Screenshots", false, e.message);
  }

  console.log("\n--- Phase 1c: User manual ---");
  const manualT0 = Date.now();
  try {
    const manualRes = await api("/api/docs/generate-step", {
      step: "manual",
      moduleName: MODULE,
      description: DESCRIPTION,
      sessionId,
      prd,
      screenshots,
      videos,
    });
    userManual = manualRes.user_manual || "";
    const sec = Math.round((Date.now() - manualT0) / 1000);
    summary.phases.manual = {
      ok: userManual.length > 300,
      chars: userManual.length,
      seconds: sec,
      model: manualRes.generatedBy,
      saved: manualRes.saved,
    };
    log("User manual", summary.phases.manual.ok, `${userManual.length} chars · ${manualRes.generatedBy} · ${sec}s`);
    summary.artifacts.reportDir = path.join("output", "reports", sessionId);
  } catch (e) {
    summary.phases.manual = { ok: false, error: e.message };
    log("User manual", false, e.message);
    process.exit(1);
  }

  // --- Phase 2: Test case generation ---
  console.log("\n--- Phase 2: Test cases (async) ---");
  const tcT0 = Date.now();
  let dataset = null;
  try {
    const start = await api("/api/testing/generate-from-docs/start", {
      moduleName: MODULE,
      prd,
      userManual,
      description: DESCRIPTION,
      sessionId,
      save: true,
      options: { minScenarios: 10, includeLivePanel: true },
    });
    const st = await poll(`/api/testing/generate-from-docs/status/${start.jobId}`, { maxWaitMs: 300000 });
    if (st.status === "error") throw new Error(st.error);
    dataset = st.dataset;
    const sec = Math.round((Date.now() - tcT0) / 1000);
    const scenarios = dataset?.scenarios || [];
    const apiN = scenarios.filter((s) => s.category === "api").length;
    const e2eN = scenarios.filter((s) => s.category === "e2e").length;
    const navN = scenarios.filter((s) => s.category === "navigation").length;
    const sheetN = dataset?.sheetRowCount || dataset?.sheetRows?.length || 0;
    summary.phases.testgen = {
      ok: scenarios.length > 0 || sheetN > 0,
      datasetId: dataset?.id,
      scenarioCount: scenarios.length,
      sheetRows: sheetN,
      api: apiN,
      e2e: e2eN,
      navigation: navN,
      model: dataset?.model,
      seconds: sec,
    };
    log(
      "Test generation",
      summary.phases.testgen.ok,
      `${scenarios.length} scenarios (${apiN} API, ${e2eN} E2E, ${navN} nav) · sheet=${sheetN} · model=${dataset?.model} · ${sec}s`
    );
    summary.artifacts.datasetId = dataset?.id;
  } catch (e) {
    summary.phases.testgen = { ok: false, error: e.message };
    log("Test generation", false, e.message);
    process.exit(1);
  }

  // --- Phase 3: Execute all test cases ---
  console.log("\n--- Phase 3: Execute all test cases ---");
  const runT0 = Date.now();
  const runId = `amazon_run_${Date.now()}`;
  try {
    const runRes = await api(
      "/api/testing/run",
      {
        dataset,
        datasetId: dataset.id,
        captureEvidence: true,
        skipLive: false,
      },
      { timeoutMs: 1800000 }
    );
    const run = runRes.run || runRes;
    const results = run.results || [];
    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const uiResults = results.filter((r) =>
      /e2e|screenshot|playwright/i.test(`${r.kind || ""} ${r.method || ""} ${r.error || ""}`)
    );
    const apiResults = results.filter((r) =>
      /api|newman|postman|http/i.test(`${r.kind || ""} ${r.method || ""}`)
    );
    const sec = Math.round((Date.now() - runT0) / 1000);
    summary.phases.execution = {
      ok: passed > 0,
      runId: run.id || runId,
      total: results.length,
      passed,
      failed,
      skipped,
      uiPassed: uiResults.filter((r) => r.status === "passed").length,
      uiFailed: uiResults.filter((r) => r.status === "failed").length,
      apiPassed: apiResults.filter((r) => r.status === "passed").length,
      apiFailed: apiResults.filter((r) => r.status === "failed").length,
      seconds: sec,
      failures: results
        .filter((r) => r.status === "failed")
        .map((r) => ({ id: r.scenarioId, title: r.title, error: r.error || r.reason })),
    };
    log("Test execution", passed > 0, `${passed}/${results.length} passed · ${failed} failed · ${skipped} skipped · ${sec}s`);
    summary.artifacts.runId = run.id || runId;
    summary.artifacts.runPath = path.join("data", "test-runs", `${summary.artifacts.runId}.json`);
  } catch (e) {
    summary.phases.execution = { ok: false, error: e.message };
    log("Test execution", false, e.message);
  }

  const totalSec = Math.round((Date.now() - pipelineStart) / 1000);
  summary.finishedAt = new Date().toISOString();
  summary.totalSeconds = totalSec;

  const outPath = path.join("output", "runtime", `amazon-pipeline-${sessionId}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log("\n=== Pipeline summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nSummary written: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
