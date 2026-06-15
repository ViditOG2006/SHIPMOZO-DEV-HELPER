/**
 * End-to-end smoke: Claude docs → test cases → Postman/Newman API → Playwright UI.
 * Usage: node scripts/run-full-smoke.js
 * Requires: npm start running, .env with Claude + Postman + Shipmozo login.
 */
const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const MODULE = "Warehouses";

async function api(path, body, { timeoutMs = 180000 } = {}) {
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
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${path} invalid JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(data.error || `${path} HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function poll(path, { maxWaitMs = 600000, pollMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const st = await api(path, null, { timeoutMs: 30000 });
    if (st.status === "done" || st.status === "error" || st.status === "failed") return st;
    process.stdout.write(`  … ${st.status || "running"} ${st.elapsedSeconds || 0}s\r`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timeout polling ${path}`);
}

function log(phase, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${phase}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== Shipmozo Dev Helper — full smoke test ===\n");

  const health = await api("/api/health");
  log("Health + Claude", health.ai?.configured, `provider=${health.ai?.provider} model=${health.ai?.model}`);
  if (!health.ai?.configured) process.exit(1);

  const aiTest = await api("/api/ai/test", { provider: "claude" }, { timeoutMs: 60000 });
  log("Claude connection", aiTest.ok, aiTest.reply?.slice(0, 40));

  console.log("\n--- 1. Doc generation (PRD → screenshots → manual) ---");
  const sessionId = `smoke_${Date.now()}`;
  let prd = "";
  let screenshots = [];

  try {
    const prdRes = await api(
      "/api/docs/generate-step",
      {
        step: "prd",
        moduleName: MODULE,
        description: "Warehouse list, add warehouse, pin code validation",
        sessionId,
        provider: "claude",
      },
      { timeoutMs: 300000 }
    );
    prd = prdRes.prd || "";
    log("PRD generation", prd.length > 500, `${prd.length} chars · ${prdRes.generatedBy || "llm"}`);
  } catch (e) {
    log("PRD generation", false, e.message);
  }

  try {
    const shotStart = await api("/api/docs/screenshots/start", {
      moduleName: MODULE,
      description: "Warehouse settings",
      sessionId,
    });
    const shotJob = await poll(`/api/docs/screenshots/status/${shotStart.jobId}`, {
      maxWaitMs: 420000,
    });
    screenshots = shotJob.screenshots || [];
    log(
      "Playwright screenshots",
      screenshots.length > 0,
      `${screenshots.length} shot(s)${shotJob.captureError ? ` warn: ${shotJob.captureError}` : ""}`
    );
  } catch (e) {
    log("Playwright screenshots", false, e.message);
  }

  try {
    const manualRes = await api(
      "/api/docs/generate-step",
      {
        step: "manual",
        moduleName: MODULE,
        description: "Warehouse settings",
        sessionId,
        prd,
        screenshots,
        provider: "claude",
      },
      { timeoutMs: 300000 }
    );
    const manual = manualRes.user_manual || "";
    log("User manual", manual.length > 300, `${manual.length} chars · saved=${manualRes.saved}`);

    console.log("\n--- 2. Test cases from PRD + manual (Claude) ---");
    try {
      const ds = await api(
        "/api/testing/generate-from-docs",
        {
          moduleName: MODULE,
          prd,
          userManual: manual,
          sessionId,
          provider: "claude",
          save: true,
        },
        { timeoutMs: 300000 }
      );
      const n = ds.dataset?.scenarios?.length || 0;
      log("Test dataset from docs", n > 0, `${n} scenarios · id=${ds.dataset?.id}`);
    } catch (e) {
      log("Test dataset from docs", false, e.message);
    }
  } catch (e) {
    log("User manual", false, e.message);
  }

  console.log("\n--- 3. Postman import + Newman API + Playwright UI ---");
  let dataset = null;
  try {
    const imp = await api(
      "/api/testing/postman/import-collection",
      {
        collectionId: process.env.POSTMAN_COLLECTION_ID,
        folders: ["00_Setup_And_Auth", "01_Warehouse_APIs"],
        frontendNotes: "warehouse list visible",
        save: true,
      },
      { timeoutMs: 120000 }
    );
    dataset = imp.dataset;
    const apiN = (dataset.scenarios || []).filter((s) => s.category === "api").length;
    const uiN = (dataset.scenarios || []).filter((s) => s.category === "e2e").length;
    log("Postman import", apiN > 0, `${apiN} API + ${uiN} UI scenarios`);
  } catch (e) {
    log("Postman import", false, e.message);
    process.exit(1);
  }

  const apiScenarios = (dataset.scenarios || []).filter((s) => s.category === "api").slice(0, 2);
  const runId = `smoke_run_${Date.now()}`;
  let apiPassed = 0;
  for (const scenario of apiScenarios) {
    try {
      const start = await api("/api/testing/run-step/start", {
        runId,
        scenario,
        skipLive: true,
        captureEvidence: false,
        runTarget: "backend",
        postmanFolders: ["01_Warehouse_APIs"],
        provider: "claude",
      });
      const job = await poll(`/api/testing/run-step/status/${start.jobId}`, { maxWaitMs: 120000 });
      const ok = job.result?.status === "passed";
      if (ok) apiPassed += 1;
      log(`Newman ${scenario.id}`, ok, job.result?.status);
    } catch (e) {
      log(`Newman ${scenario.id}`, false, e.message);
    }
  }

  const uiScenarios = (dataset.scenarios || []).filter((s) => s.category === "e2e").slice(0, 2);
  if (uiScenarios.length) {
    try {
      const batchStart = await api("/api/testing/e2e-batch/start", {
        runId,
        scenarios: uiScenarios,
        captureEvidence: true,
        runTarget: "both",
        provider: "claude",
      });
      const batch = await poll(`/api/testing/e2e-batch/status/${batchStart.jobId}`, {
        maxWaitMs: 300000,
      });
      const results = batch.result?.results || [];
      const passed = results.filter((r) => r.status === "passed").length;
      log("Playwright UI batch", passed > 0, `${passed}/${results.length} passed`);
    } catch (e) {
      log("Playwright UI batch", false, e.message);
    }
  } else {
    log("Playwright UI batch", false, "no UI scenarios");
  }

  console.log("\n=== Smoke test finished ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
