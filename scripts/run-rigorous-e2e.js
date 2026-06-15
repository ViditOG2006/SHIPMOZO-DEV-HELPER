/**
 * Rigorous full-stack E2E: docs → chat → testgen → execute with heal retries.
 * Usage: node scripts/run-rigorous-e2e.js
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

const { generateModulePackageStep } = require("../lib/doc-generation");
const {
  generateTestDatasetFromDocs,
  ensureRunnableScenarios,
} = require("../lib/test-dataset-generation");
const { saveDataset } = require("../lib/test-dataset-store");
const { saveRun } = require("../lib/test-run-store");
const { runTestDataset, runTestStep } = require("../lib/test-dataset-runner");
const { appendHealLesson } = require("../lib/ai-heal-lessons");
const { getConfigStatus } = require("../lib/ai-config");
const { getAiScopeStatus } = require("../lib/ai-scope");

const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";
const MODULE = "Amazon";
const DESCRIPTION =
  "Amazon channel integration — connect seller account, MWS/SP-API credentials, order sync, inventory sync, channel settings";

const summary = {
  startedAt: new Date().toISOString(),
  steps: [],
  phases: {},
  artifacts: {},
  heals: [],
};

function recordStep(step, status, notes = "") {
  summary.steps.push({ step, status, notes, at: new Date().toISOString() });
  const mark = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "WARN";
  console.log(`[${mark}] ${step}${notes ? ` — ${notes}` : ""}`);
}

async function recordLesson({ step, issue, fix, tags = [] }) {
  if (!issue || !fix) return null;
  try {
    const res = appendHealLesson({
      title: `rigorous-e2e-${slug(step)}`,
      issue: `[${step}] ${issue}`,
      fix,
      module: MODULE,
      tags: ["rigorous-e2e", ...tags],
      source: "rigorous-e2e",
    });
    summary.heals.push({ type: "lesson-recorded", step, id: res.id, duplicate: res.duplicate });
    return res;
  } catch (e) {
    summary.heals.push({ type: "lesson-record-failed", step, error: e.message });
    return null;
  }
}

function slug(s) {
  return String(s || "step")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48);
}

const CHAT_QUESTIONS = [
  "how do i integrate amazon order channel",
  "what credentials do i need for amazon sp-api integration",
  "how do i sync orders from amazon to shipmozo",
];

async function api(path, body, { timeoutMs = 1200000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
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
    } catch (e) {
      lastErr = e;
      const msg = e.cause?.message || e.message || String(e);
      if (attempt < retries && /fetch failed|aborted|ECONNRESET|socket|Headers Timeout/i.test(msg)) {
        console.log(`  … retry ${attempt + 1}/${retries} for ${path} (${msg})`);
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw new Error(msg);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
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

function verifyPrd(prd) {
  const issues = [];
  if (!prd || prd.length < 500) issues.push(`too short (${prd?.length || 0} chars)`);
  if (!/```mermaid/i.test(prd) && !/flowchart|sequenceDiagram|graph TD/i.test(prd))
    issues.push("no mermaid diagram");
  if (!/amazon/i.test(prd)) issues.push("missing Amazon keyword");
  return { ok: issues.length === 0, issues };
}

async function healScreenshots(moduleName, description, sessionId, attempt) {
  summary.heals.push({
    type: "screenshot-retry",
    attempt,
    at: new Date().toISOString(),
    note: "Retrying screenshot capture after failure",
  });
  return generateModulePackageStep({
    step: "screenshots",
    sessionId,
    moduleName,
    description,
    captureScreens: true,
  });
}

async function main() {
  const pipelineStart = Date.now();
  console.log("=== Rigorous E2E — Amazon Order Channel ===\n");

  // Step 0: Health (local config + server for chat)
  const aiScope = getAiScopeStatus();
  const aiCfg = getConfigStatus();
  let healthOk = aiCfg.configured;
  try {
    const health = await api("/api/health", null, { timeoutMs: 15000 });
    healthOk = health.ok && aiCfg.configured;
  } catch {
    healthOk = aiCfg.configured;
  }
  const chatOk = aiScope.chatEnabled === true;
  recordStep(
    "Server health",
    healthOk ? "PASS" : "FAIL",
    `chat=${chatOk} reportBackend=${aiScope.backends?.reportGen}`
  );
  const split = aiCfg.reportLlmSplit || {};
  recordStep(
    "Claude PRD configured",
    split.prd?.configured ? "PASS" : "FAIL",
    `${split.prd?.providerLabel || "claude"} · ${split.prd?.model || "?"}`
  );
  recordStep(
    "Azure manual configured",
    split.manual?.configured ? "PASS" : "FAIL",
    `${split.manual?.providerLabel || "azure"} · ${split.manual?.model || "?"}`
  );
  if (!healthOk) process.exit(1);

  const sessionId = `amazon_${Date.now()}`;
  summary.sessionId = sessionId;
  let prd = "";
  let userManual = "";
  let screenshots = [];
  let videos = [];

  // Step 1: PRD
  console.log("\n--- Phase 1: PRD ---");
  const prdT0 = Date.now();
  try {
    const prdRes = await generateModulePackageStep({
      step: "prd",
      moduleName: MODULE,
      description: DESCRIPTION,
      sessionId,
      provider: "claude",
    });
    prd = prdRes.prd || "";
    const quality = verifyPrd(prd);
    const sec = Math.round((Date.now() - prdT0) / 1000);
    summary.phases.prd = {
      ok: quality.ok,
      chars: prd.length,
      seconds: sec,
      model: prdRes.generatedBy,
      issues: quality.issues,
    };
    recordStep(
      "PRD generation",
      quality.ok ? "PASS" : "WARN",
      `${prd.length} chars · mermaid=${!quality.issues.includes("no mermaid diagram")} · ${sec}s`
    );
    if (quality.issues.length) {
      recordStep("PRD quality", "WARN", quality.issues.join("; "));
      await recordLesson({
        step: "PRD quality",
        issue: quality.issues.join("; "),
        fix: "Ensure PRD includes mermaid diagram, Amazon keywords, and >500 chars. Re-run with Claude PRD backend.",
        tags: ["prd", "report-gen"],
      });
    }
  } catch (e) {
    summary.phases.prd = { ok: false, error: e.message };
    recordStep("PRD generation", "FAIL", e.message);
    await recordLesson({
      step: "PRD generation",
      issue: e.message,
      fix: "Check Claude API key, REPORT_BACKEND=split, and server logs for /api/docs/generate-step.",
      tags: ["prd", "critical"],
    });
    process.exit(1);
  }

  // Step 2: Screenshots + video (with heal retry)
  console.log("\n--- Phase 1b: Screenshots & video ---");
  const shotT0 = Date.now();
  const maxShotAttempts = Number(process.env.DOC_HEAL_MAX_RUNS || 3);
  let shotJob = null;
  for (let attempt = 1; attempt <= maxShotAttempts; attempt++) {
    try {
      if (attempt === 1) {
        shotJob = await generateModulePackageStep({
          step: "screenshots",
          sessionId,
          moduleName: MODULE,
          description: DESCRIPTION,
          captureScreens: true,
        });
      } else {
        shotJob = await healScreenshots(MODULE, DESCRIPTION, sessionId, attempt);
      }
      screenshots = shotJob.screenshots || [];
      videos = shotJob.videos || [];
      if (screenshots.length > 0) break;
      if (attempt < maxShotAttempts) {
        recordStep("Screenshot heal", "WARN", `attempt ${attempt} got 0 shots — retrying`);
        await recordLesson({
          step: "Screenshots",
          issue: `Attempt ${attempt}: 0 screenshots captured`,
          fix: "Use Ctrl+B → 'order channels' hub → click Amazon on page. Never direct /channels/amazon URL. Check SHIPMOZO login.",
          tags: ["screenshots", "navigation", "self-heal"],
        });
      }
    } catch (e) {
      if (attempt >= maxShotAttempts) {
        summary.phases.screenshots = { ok: false, error: e.message };
        recordStep("Screenshots", "FAIL", e.message);
        await recordLesson({
          step: "Screenshots",
          issue: e.message,
          fix: "QS to Order Channels hub first, then in-page Amazon click. Set DOCS_CAPTURE_ALLOW_DIRECT_URL=false.",
          tags: ["screenshots", "critical"],
        });
        break;
      }
      summary.heals.push({ type: "screenshot-error-retry", attempt, error: e.message });
      recordStep("Screenshot heal", "WARN", `attempt ${attempt} error: ${e.message}`);
    }
  }
  const shotSec = Math.round((Date.now() - shotT0) / 1000);
  if (screenshots.length > 0) {
    summary.phases.screenshots = {
      ok: true,
      count: screenshots.length,
      videos: videos.length,
      seconds: shotSec,
      captureError: shotJob?.captureError || null,
    };
    recordStep("Screenshots", "PASS", `${screenshots.length} shot(s) · ${shotSec}s`);
    recordStep("Videos", videos.length > 0 ? "PASS" : "WARN", `${videos.length} recording(s)`);
    summary.artifacts.screenshotsDir = path.join("output", "cloud-images", sessionId);
  }

  // Step 3: User manual
  console.log("\n--- Phase 1c: User manual ---");
  const manualT0 = Date.now();
  try {
    const manualRes = await generateModulePackageStep({
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
    const manualOk = userManual.length > 300;
    summary.phases.manual = {
      ok: manualOk,
      chars: userManual.length,
      seconds: sec,
      model: manualRes.generatedBy,
      saved: manualRes.saved,
    };
    recordStep(
      "User manual",
      manualOk ? "PASS" : "FAIL",
      `${userManual.length} chars · ${manualRes.generatedBy} · ${sec}s`
    );
    summary.artifacts.reportDir = path.join("output", "reports", sessionId);
  } catch (e) {
    summary.phases.manual = { ok: false, error: e.message };
    recordStep("User manual", "FAIL", e.message);
    process.exit(1);
  }

  // Step 4+5: Chat verification AND test case generation in parallel
  console.log("\n--- Phase 2+3: Chat + test cases (parallel) ---");
  const parallelT0 = Date.now();

  async function runChatVerification() {
    const chatT0 = Date.now();
    const chatResults = [];
    for (const question of CHAT_QUESTIONS) {
      try {
        const chatRes = await api(
          "/api/ai/chat",
          {
            messages: [{ role: "user", content: question }],
            useLivePanel: true,
            includeHealLessons: true,
          },
          { timeoutMs: 300000 }
        );
        const reply = chatRes.reply || chatRes.content || chatRes.message || "";
        const ok =
          reply.length > 50 &&
          !/AI chat is disabled|AI_SCOPE_DISABLED/i.test(reply) &&
          !/^error:/i.test(reply.trim());
        chatResults.push({
          question,
          ok,
          replyChars: reply.length,
          preview: reply.slice(0, 180),
          browseOk: chatRes.browse?.ok,
        });
        recordStep(
          `Chat: ${question.slice(0, 40)}…`,
          ok ? "PASS" : "WARN",
          `${reply.length} chars`
        );
        if (!ok) {
          await recordLesson({
            step: "Chat",
            issue: `Weak reply for "${question}": ${reply.slice(0, 120)}`,
            fix: "Ensure AI_SCOPE includes chat. Use live panel browse. Check Claude key and SHIPMOZO login.",
            tags: ["chat"],
          });
        }
      } catch (e) {
        chatResults.push({ question, ok: false, error: e.message });
        recordStep(`Chat: ${question.slice(0, 40)}…`, "FAIL", e.message);
        await recordLesson({
          step: "Chat",
          issue: `${question}: ${e.message}`,
          fix: "Add chat to AI_SCOPE. Verify npm start and SHIPMOZO_EMAIL/PASSWORD.",
          tags: ["chat", "critical"],
        });
      }
    }
    const allOk = chatResults.every((r) => r.ok);
    const sec = Math.round((Date.now() - chatT0) / 1000);
    return { ok: allOk, results: chatResults, seconds: sec };
  }

  async function runTestGeneration() {
    const tcT0 = Date.now();
    let dataset = await generateTestDatasetFromDocs({
      moduleName: MODULE,
      prd,
      userManual,
      description: DESCRIPTION,
      sessionId,
      options: { minScenarios: 10, includeLivePanel: true },
    });
    dataset = ensureRunnableScenarios(dataset);
    saveDataset(dataset);
    const sec = Math.round((Date.now() - tcT0) / 1000);
    const scenarios = dataset?.scenarios || [];
    const apiN = scenarios.filter((s) => s.category === "api").length;
    const e2eN = scenarios.filter((s) => s.category === "e2e").length;
    const navN = scenarios.filter((s) => s.category === "navigation").length;
    const sheetN = dataset?.sheetRowCount || dataset?.sheetRows?.length || 0;
    const genOk = scenarios.length >= 5 || sheetN >= 5;
    return {
      ok: genOk,
      dataset,
      datasetId: dataset?.id,
      scenarioCount: scenarios.length,
      sheetRows: sheetN,
      api: apiN,
      e2e: e2eN,
      navigation: navN,
      model: dataset?.model,
      seconds: sec,
    };
  }

  let dataset = null;
  try {
    const [chatPhase, testgenPhase] = await Promise.all([
      runChatVerification(),
      runTestGeneration(),
    ]);
    const parallelSec = Math.round((Date.now() - parallelT0) / 1000);
    summary.phases.chat = { ...chatPhase, parallelSeconds: parallelSec };
    summary.phases.testgen = { ...testgenPhase, parallelSeconds: parallelSec };
    dataset = testgenPhase.dataset;
    recordStep(
      "Test generation",
      testgenPhase.ok ? "PASS" : "WARN",
      `${testgenPhase.scenarioCount} scenarios (${testgenPhase.api} API, ${testgenPhase.e2e} E2E, ${testgenPhase.navigation} nav) · sheet=${testgenPhase.sheetRows} · ${testgenPhase.seconds}s`
    );
    recordStep(
      "Chat verification",
      chatPhase.ok ? "PASS" : "WARN",
      `${chatPhase.results.filter((r) => r.ok).length}/${chatPhase.results.length} questions OK · ${chatPhase.seconds}s`
    );
    summary.artifacts.datasetId = testgenPhase.datasetId;
    summary.artifacts.datasetPath = testgenPhase.datasetId
      ? path.join("data", "test-datasets", `${testgenPhase.datasetId}.json`)
      : null;
    if (!testgenPhase.ok) {
      await recordLesson({
        step: "Test generation",
        issue: `Only ${testgenPhase.scenarioCount} scenarios generated`,
        fix: "Set TESTCASE_BACKEND=docs, TESTCASE_PROVIDER=azure-openai. Ensure PRD+manual are complete.",
        tags: ["testcase-gen"],
      });
    }
  } catch (e) {
    summary.phases.testgen = { ok: false, error: e.message };
    recordStep("Test generation", "FAIL", e.message);
    await recordLesson({
      step: "Test generation",
      issue: e.message,
      fix: "Use async /generate-from-docs/start. Check Azure OpenAI for testcase gen.",
      tags: ["testcase-gen", "critical"],
    });
    process.exit(1);
  }

  // Step 6: Execute all test cases (with e2e self-heal built into runner)
  console.log("\n--- Phase 4: Execute all test cases ---");
  const runT0 = Date.now();
  const runId = `amazon_run_${Date.now()}`;
  try {
    const scenarios = dataset.scenarios || [];
    const apiScenarios = scenarios.filter((s) => s.category === "api");
    const uiScenarios = scenarios.filter((s) => s.category !== "api");
    const results = [];

    for (let i = 0; i < apiScenarios.length; i++) {
      const scenario = apiScenarios[i];
      process.stdout.write(`  API ${i + 1}/${apiScenarios.length}: ${scenario.id}\r`);
      results.push(
        await runTestStep({
          runId,
          scenario,
          skipLive: false,
          captureEvidence: true,
          showBrowser: false,
          runTarget: "backend",
        })
      );
    }
    for (let i = 0; i < uiScenarios.length; i++) {
      const scenario = uiScenarios[i];
      process.stdout.write(`  UI ${i + 1}/${uiScenarios.length}: ${scenario.id}\r`);
      results.push(
        await runTestStep({
          runId,
          scenario,
          skipLive: false,
          captureEvidence: true,
          showBrowser: true,
          runTarget: "frontend",
        })
      );
    }

    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const blocked = results.filter((r) => r.status === "blocked").length;
    const sec = Math.round((Date.now() - runT0) / 1000);
    const run = {
      id: runId,
      runId,
      datasetId: dataset.id,
      datasetTitle: dataset.title,
      startedAt: new Date(runT0).toISOString(),
      finishedAt: new Date().toISOString(),
      results,
      summary: { passed, failed, skipped, blocked, total: results.length },
    };
    saveRun(run);

    // Retry failed E2E scenarios with heal endpoint
    const failedE2e = results.filter(
      (r) =>
        r.status === "failed" &&
        dataset.scenarios?.find((s) => s.id === r.scenarioId && (s.category === "e2e" || s.inputs?.e2eFlow))
    );
    if (failedE2e.length > 0 && isAiScopeEnabled()) {
      recordStep("E2E heal retry", "WARN", `${failedE2e.length} failed E2E — attempting heal`);
      for (const fail of failedE2e.slice(0, 3)) {
        try {
          const scenario = dataset.scenarios.find((s) => s.id === fail.scenarioId);
          if (!scenario) continue;
          const healStart = await api("/api/testing/e2e-heal/start", {
            runId: run.id || runId,
            scenario,
            failureContext: fail.error || fail.reason,
          });
          const healJob = await poll(`/api/testing/e2e-heal/status/${healStart.jobId}`, {
            maxWaitMs: 300000,
          });
          if (healJob.result?.healed) {
            summary.heals.push({
              type: "e2e-heal",
              scenarioId: fail.scenarioId,
              healed: true,
              note: healJob.result?.summary || "heal applied",
            });
            recordStep(`Heal ${fail.scenarioId}`, "PASS", healJob.result?.summary || "healed");
          }
        } catch (he) {
          summary.heals.push({
            type: "e2e-heal",
            scenarioId: fail.scenarioId,
            healed: false,
            error: he.message,
          });
        }
      }
    }

    summary.phases.execution = {
      ok: passed > 0,
      runId: run.id || runId,
      total: results.length,
      passed,
      failed,
      skipped,
      blocked,
      seconds: sec,
      failures: results
        .filter((r) => r.status === "failed")
        .map((r) => ({ id: r.scenarioId, title: r.title, error: r.error || r.reason })),
    };
    recordStep(
      "Test execution",
      failed === 0 ? "PASS" : passed > 0 ? "WARN" : "FAIL",
      `${passed}/${results.length} passed · ${failed} failed · ${skipped} skipped · ${blocked} blocked · ${sec}s`
    );
    for (const fail of summary.phases.execution.failures.slice(0, 8)) {
      await recordLesson({
        step: `Test ${fail.id}`,
        issue: `${fail.title}: ${fail.error || "failed"}`,
        fix: "Review scenario category (api/e2e/navigation). For Amazon: QS→Order Channels→Amazon. API: verify Postman collection. E2E: use e2eFlow.",
        tags: ["test-execution", fail.id?.includes("api") ? "api" : "e2e"],
      });
    }
    summary.artifacts.runId = run.id || runId;
    summary.artifacts.runPath = path.join("data", "test-runs", `${summary.artifacts.runId}.json`);
  } catch (e) {
    summary.phases.execution = { ok: false, error: e.message };
    recordStep("Test execution", "FAIL", e.message);
    await recordLesson({
      step: "Test execution",
      issue: e.message,
      fix: "Check login state, Playwright, Postman MCP/Newman. Run with runTarget=both.",
      tags: ["test-execution", "critical"],
    });
  }

  // Collect artifact paths
  const artifactDirs = [
    path.join("output", "reports", sessionId),
    path.join("output", "cloud-images", sessionId),
    path.join("output", "test-runs"),
    path.join("data", "test-datasets"),
    path.join("data", "test-runs"),
  ];
  summary.artifacts.paths = artifactDirs.filter((d) => {
    const full = path.join(__dirname, "..", d);
    return fs.existsSync(full);
  });

  const totalSec = Math.round((Date.now() - pipelineStart) / 1000);
  summary.finishedAt = new Date().toISOString();
  summary.totalSeconds = totalSec;

  const outDir = path.join(__dirname, "..", "output", "runtime");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `rigorous-e2e-${sessionId}.json`);
  const mdPath = path.join(outDir, `rigorous-e2e-${sessionId}.md`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(mdPath, buildMarkdownReport(summary));

  console.log("\n=== Rigorous E2E summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nJSON report: ${outPath}`);
  console.log(`Markdown report: ${mdPath}`);

  const allPass = summary.steps.every((s) => s.status === "PASS");
  process.exit(allPass ? 0 : summary.phases.execution?.passed > 0 ? 0 : 1);
}

function isAiScopeEnabled() {
  return process.env.AI_SCOPE?.includes("script_debug") !== false;
}

function buildMarkdownReport(s) {
  const lines = [
    `# Rigorous E2E Test Report — ${MODULE}`,
    ``,
    `**Session:** ${s.sessionId}`,
    `**Started:** ${s.startedAt}`,
    `**Finished:** ${s.finishedAt}`,
    `**Duration:** ${s.totalSeconds}s`,
    ``,
    `## Step verification`,
    ``,
    `| Step | Status | Notes |`,
    `|------|--------|-------|`,
    ...s.steps.map((st) => `| ${st.step} | ${st.status} | ${st.notes || ""} |`),
    ``,
    `## Phases`,
    ``,
  ];
  for (const [name, phase] of Object.entries(s.phases || {})) {
    lines.push(`### ${name}`);
    lines.push("```json");
    lines.push(JSON.stringify(phase, null, 2));
    lines.push("```");
    lines.push("");
  }
  if (s.heals?.length) {
    lines.push(`## Self-heal & lessons (${s.heals.length})`);
    lines.push("");
    for (const h of s.heals) {
      lines.push(`- **${h.type}** ${h.step || h.scenarioId || ""} ${h.note || h.error || ""}`);
    }
    lines.push("");
  }
  lines.push(`## Artifacts`);
  lines.push("");
  for (const [k, v] of Object.entries(s.artifacts || {})) {
    if (k === "paths") continue;
    lines.push(`- **${k}:** ${v}`);
  }
  if (s.artifacts?.paths?.length) {
    lines.push(`- **paths:** ${s.artifacts.paths.join(", ")}`);
  }
  const pass = s.steps.filter((x) => x.status === "PASS").length;
  const warn = s.steps.filter((x) => x.status === "WARN").length;
  const fail = s.steps.filter((x) => x.status === "FAIL").length;
  lines.push("");
  lines.push(`## Verdict: ${pass} pass · ${warn} warn · ${fail} fail`);
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
