/**
 * Full Rate Calculator pipeline: Claude docs → test cases → Newman API → Playwright E2E.
 * Usage: node scripts/run-rate-calculator-smoke.js
 */
const BASE = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3000";
const MODULE = "Rate Calculator";
const POSTMAN_FOLDER = "05_Utility_APIs";

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
  console.log(`[${ok ? "PASS" : "FAIL"}] ${phase}${detail ? ` — ${detail}` : ""}`);
}

function rateApiScenarios(scenarios = []) {
  return scenarios.filter(
    (s) =>
      s.category === "api" &&
      (/rate calculator|TC-RC/i.test(s.title || "") || /rate calculator|TC-RC/i.test(s.description || ""))
  );
}

async function main() {
  console.log("=== Rate Calculator — full pipeline ===\n");

  const health = await api("/api/health");
  log("Health + Claude", health.ai?.configured, `provider=${health.ai?.provider}`);
  if (!health.ai?.configured) process.exit(1);

  console.log("\n--- 1. Doc generation (PRD → screenshots → manual) ---");
  const sessionId = `rc_${Date.now()}`;
  let prd = "";
  let screenshots = [];

  try {
    const prdRes = await api(
      "/api/docs/generate-step",
      {
        step: "prd",
        moduleName: MODULE,
        description:
          "Domestic and international freight rate calculator: origin/delivery pincode, weight, dimensions, invoice value, courier rate comparison",
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
      description: "Rate Calculator domestic form and results",
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

  let manual = "";
  try {
    const manualRes = await api(
      "/api/docs/generate-step",
      {
        step: "manual",
        moduleName: MODULE,
        description: "Rate Calculator user guide with screenshots",
        sessionId,
        prd,
        screenshots,
        provider: "claude",
      },
      { timeoutMs: 300000 }
    );
    manual = manualRes.user_manual || "";
    log("User manual", manual.length > 300, `${manual.length} chars · saved=${manualRes.saved}`);
  } catch (e) {
    log("User manual", false, e.message);
  }

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
    const n = ds.dataset?.scenarios?.length || ds.dataset?.sheetRowCount || 0;
    log("Test dataset from docs", n > 0, `${n} cases · id=${ds.dataset?.id}`);
  } catch (e) {
    log("Test dataset from docs", false, e.message);
  }

  console.log("\n--- 3. Postman Utility APIs (Rate Calculator + Pincode) ---");
  let postmanDataset = null;
  try {
    const imp = await api(
      "/api/testing/postman/import-collection",
      {
        collectionId: process.env.POSTMAN_COLLECTION_ID,
        folders: [POSTMAN_FOLDER],
        frontendNotes: "rate calculator form visible, calculate domestic rates",
        save: true,
      },
      { timeoutMs: 120000 }
    );
    postmanDataset = imp.dataset;
    const apiN = (postmanDataset.scenarios || []).filter((s) => s.category === "api").length;
    const uiN = (postmanDataset.scenarios || []).filter((s) => s.category === "e2e").length;
    log("Postman import", apiN > 0, `${apiN} API + ${uiN} UI scenarios`);
  } catch (e) {
    log("Postman import", false, e.message);
  }

  const runId = `rc_run_${Date.now()}`;
  const apiTargets = rateApiScenarios(postmanDataset?.scenarios || []);
  if (apiTargets.length) {
    for (const scenario of apiTargets.slice(0, 2)) {
      try {
        const start = await api("/api/testing/run-step/start", {
          runId,
          scenario,
          skipLive: true,
          captureEvidence: false,
          runTarget: "backend",
          postmanFolders: [POSTMAN_FOLDER],
          provider: "claude",
        });
        const job = await poll(`/api/testing/run-step/status/${start.jobId}`, { maxWaitMs: 120000 });
        log(`Newman ${scenario.id}`, job.result?.status === "passed", job.result?.status);
      } catch (e) {
        log(`Newman ${scenario.id}`, false, e.message);
      }
    }
  } else {
    log("Newman API", false, "no Rate Calculator API scenarios found");
  }

  console.log("\n--- 4. Builtin Rate Calculator E2E (Playwright) ---");
  let e2eDataset = null;
  try {
    const seed = await api("/api/testing/seed/rate-calculator", {});
    e2eDataset = seed.dataset;
    log("Seed E2E dataset", (e2eDataset.scenarios || []).length > 0, `id=${e2eDataset.id}`);
  } catch (e) {
    log("Seed E2E dataset", false, e.message);
  }

  const e2eScenarios = (e2eDataset?.scenarios || []).filter((s) => s.category === "e2e").slice(0, 4);
  if (e2eScenarios.length) {
    try {
      const batchStart = await api("/api/testing/e2e-batch/start", {
        runId,
        scenarios: e2eScenarios,
        captureEvidence: true,
        runTarget: "frontend",
        provider: "claude",
      });
      const batch = await poll(`/api/testing/e2e-batch/status/${batchStart.jobId}`, {
        maxWaitMs: 600000,
      });
      const results = batch.result?.results || [];
      const passed = results.filter((r) => r.status === "passed").length;
      log("Playwright E2E batch", passed > 0, `${passed}/${results.length} passed`);
      for (const r of results) {
        log(`  ${r.scenarioId || r.id}`, r.status === "passed", r.status);
      }
    } catch (e) {
      log("Playwright E2E batch", false, e.message);
    }
  }

  const uiPairs = (postmanDataset?.scenarios || []).filter((s) => s.category === "e2e").slice(0, 2);
  if (uiPairs.length) {
    console.log("\n--- 5. Postman-paired UI scenarios ---");
    try {
      const batchStart = await api("/api/testing/e2e-batch/start", {
        runId,
        scenarios: uiPairs,
        captureEvidence: true,
        runTarget: "both",
        provider: "claude",
      });
      const batch = await poll(`/api/testing/e2e-batch/status/${batchStart.jobId}`, {
        maxWaitMs: 300000,
      });
      const results = batch.result?.results || [];
      const passed = results.filter((r) => r.status === "passed").length;
      log("Paired UI batch", passed > 0, `${passed}/${results.length} passed`);
    } catch (e) {
      log("Paired UI batch", false, e.message);
    }
  }

  console.log("\n=== Rate Calculator pipeline finished ===");
}

// Load .env for POSTMAN_COLLECTION_ID when run standalone
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
