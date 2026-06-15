const fs = require("fs");

const path = require("path");

const { runPythonScript } = require("./spawn-python");

const { parsePythonJson } = require("./parse-python-json");

const { storeScreenshotBatch } = require("./image-storage");

const { pythonEnvFromContext } = require("./playwright-env");

const {
  proposeHealScript,
  proposeScenarioHeal,
  inferModuleName,
  scriptLooksStale,
} = require("./ai-e2e-heal");

const { writeHealProgress, appendRunLog, clearHealProgress } = require("./heal-progress");

const { recordHealRunFailure, loadHealLessons } = require("./ai-heal-lessons");

const { isAiScopeEnabled } = require("./ai-scope");
const { isPlaywrightMcpEnabled, healBackendLabel } = require("./playwright-mcp-debug");
const { isScriptFirstTestcaseBackend } = require("./testcase-backend");



function isE2ePanelScenario(scenario) {

  return Boolean(scenario.inputs?.e2eFlow || scenario.inputs?.uiAction);

}



function isRateCalculatorE2eScenario(scenario) {

  const flow = String(scenario.inputs?.e2eFlow || scenario.inputs?.uiAction || "");

  return flow.startsWith("rate_calculator");

}



function runnerUtils() {

  return require("./test-dataset-runner");

}



const ROOT = path.join(__dirname, "..");

const AI_SCRIPT_CACHE = path.join(ROOT, "output", "runtime", "e2e-ai-script.json");

const AGENT_MAX_ATTEMPTS = Number(process.env.PANEL_AI_HEAL_MAX_ATTEMPTS || 3);

const SCENARIO_HEAL_MAX_ATTEMPTS = Number(process.env.SCENARIO_HEAL_MAX_ATTEMPTS || 3);

const AGENT_ATTEMPT_TIMEOUT_MS = Number(process.env.PANEL_AI_HEAL_ATTEMPT_TIMEOUT_MS || 45000);

const BATCH_TIMEOUT_MS = Number(process.env.PANEL_E2E_BATCH_TIMEOUT_MS || 600000);



function getValidCachedScriptPath() {

  if (!fs.existsSync(AI_SCRIPT_CACHE)) return "";

  try {

    const cached = JSON.parse(fs.readFileSync(AI_SCRIPT_CACHE, "utf-8"));

    if (cached?.navSteps?.length && !scriptLooksStale(cached)) return AI_SCRIPT_CACHE;

  } catch {

    /* ignore */

  }

  return "";

}



async function persistE2eVideo(runId, videoPath, scenarioId) {
  if (!videoPath || !fs.existsSync(videoPath)) return null;
  const destDir = path.join(ROOT, "output", "test-runs", runId, "videos");
  fs.mkdirSync(destDir, { recursive: true });
  const base = `${String(scenarioId || "ui").replace(/[^\w-]+/g, "_")}.webm`;
  const dest = path.join(destDir, base);
  try {
    fs.copyFileSync(videoPath, dest);
    const rel = `/test-runs/${runId}/videos/${base}`;
    return { path: dest, url: rel, type: "video/webm" };
  } catch {
    return { path: videoPath, url: videoPath, type: "video/webm" };
  }
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



function parseStdout(proc) {

  const raw = (proc.stdout || "").trim();

  if (!raw) {

    return { data: null, error: proc.error || proc.stderr || "Script produced no output" };

  }

  return parsePythonJson(raw);

}



function purgeStaleNavCache() {

  const navCache = path.join(ROOT, "output", "runtime", "e2e-nav-rate-calculator.json");

  if (!fs.existsSync(navCache)) return;

  try {

    const cached = JSON.parse(fs.readFileSync(navCache, "utf-8"));

    if (scriptLooksStale(cached)) {

      fs.unlinkSync(navCache);

      console.log("[ai-heal] Purged stale e2e-nav-rate-calculator.json (manage-courier)");

    }

  } catch {

    /* ignore */

  }

}



async function invokeE2eBatchPython(runId, listPath, navScriptPath, ctx, { label = "E2E session" } = {}) {

  const args = [runId, listPath];

  if (navScriptPath && fs.existsSync(navScriptPath)) {

    args.push("--nav-script", navScriptPath);

  }

  appendRunLog(runId, `▶ ${label} — Playwright browser starting…`);

  writeHealProgress(runId, { phase: "e2e_running", currentStep: label });

  const proc = await runPythonScript("run_panel_e2e_session.py", args, BATCH_TIMEOUT_MS, {

    env: pythonEnvFromContext(ctx),

    killKey: `${runId}:batch`,

    onStderr: (line) => appendRunLog(runId, line),

  });

  return parseStdout(proc);

}



/** Nav/scenario self-heal — Playwright MCP when SCRIPT_DEBUG_BACKEND=mcp, else OpenRouter. */

async function runE2eNavHeal(ctx, { force = false, scenarios = [], datasetTitle = "" } = {}) {

  const started = Date.now();

  const runId = ctx.runId || `heal_${Date.now()}`;

  purgeStaleNavCache();

  const tmpDir = path.join(ROOT, "output", "test-runs", runId, "ai-heal");

  fs.mkdirSync(tmpDir, { recursive: true });



  const agentHistory = [];

  let scriptPath = !force ? getValidCachedScriptPath() : "";

  let aiMeta = {};

  let lastData = null;



  const manifest = scenarios

    .slice(0, 12)

    .map((s) => `${s.id}: ${s.title} (${s.inputs?.e2eFlow || "?"})`)

    .join("; ");

  const moduleName = inferModuleName(scenarios, datasetTitle);

  const lessonCount = loadHealLessons().length;



  console.log(`[ai-agent] runId=${runId} — nav script self-heal (max ${AGENT_MAX_ATTEMPTS} attempts)`);

  if (scriptPath) {

    console.log(`[ai-agent] replay cached script first: ${scriptPath}`);

  }



  const healLabel = healBackendLabel();
  const navStartLine = scriptPath
    ? `Replay saved nav script → ${healLabel} repairs only if it fails`
    : isPlaywrightMcpEnabled()
      ? `${healLabel} validates Quick Search nav script`
      : `OpenRouter writes nav script (${lessonCount} known issues in context)`;

  const attempts = [{ id: "agent", ok: false, logLine: navStartLine }];
  appendRunLog(runId, `🧠 ${healLabel} nav self-heal — max ${AGENT_MAX_ATTEMPTS} attempt(s)`);

  appendRunLog(runId, `  ${navStartLine}`);

  writeHealProgress(runId, {

    phase: scriptPath ? "ai_executing" : "ai_observing",

    currentStep: `${healLabel} nav self-heal`,

    attempts,

  });



  for (let attempt = 1; attempt <= AGENT_MAX_ATTEMPTS; attempt++) {

    writeHealProgress(runId, {

      phase: scriptPath ? "ai_executing" : "ai_observing",

      attempts,

    });



    const args = [runId, tmpDir, String(attempt)];

    if (scriptPath && fs.existsSync(scriptPath)) args.push(scriptPath);



    console.log(

      `[ai-agent] tick ${attempt}${scriptPath ? " (execute script)" : " (observe — no script yet)"}`

    );



    const proc = await runPythonScript("run_panel_ai_heal_agent.py", args, AGENT_ATTEMPT_TIMEOUT_MS, {

      env: pythonEnvFromContext(ctx),

      killKey: `${runId}:heal`,

      onStderr: (line) => appendRunLog(runId, line),

    });



    const { data, error } = parseStdout(proc);

    if (!data) {

      const failLine = `✗ Browser tick ${attempt} failed: ${proc.killed ? "Stopped" : error || proc.stderr || "no output"}`;

      attempts.push({ id: `attempt_${attempt}`, ok: false, logLine: failLine });

      appendRunLog(runId, failLine);

      writeHealProgress(runId, { phase: "failed", attempts });

      return {

        ok: false,

        error: proc.killed ? "Stopped by user" : error || "Agent browser tick failed",

        cancelled: Boolean(proc.killed),

        durationMs: Date.now() - started,

        attempts,

        aiMeta,

        agentAttempts: attempt,

      };

    }



    lastData = data;

    const obs = data.observation || {};

    const observeLine = `👁 Attempt ${attempt}: ${obs.url || data.pageUrl || "?"}${obs.onRateCalculator ? " (on RC)" : obs.is404 ? " (404!)" : ""}`;

    attempts.push({ id: `observe_${attempt}`, ok: true, logLine: observeLine });

    appendRunLog(runId, observeLine);

    if (obs.consoleLogs?.length) {

      for (const cl of obs.consoleLogs.slice(-6)) {

        appendRunLog(runId, `  browser: ${cl}`);

      }

    }

    for (const line of data.stepsRun || []) {

      const stepLine = `  ${line}`;

      attempts.push({ id: "ai_step", ok: line.startsWith("✓"), logLine: stepLine });

      appendRunLog(runId, stepLine);

    }



    if (data.ok) {

      const finalScriptPath = AI_SCRIPT_CACHE;

      if (scriptPath && fs.existsSync(scriptPath)) {

        try {

          fs.copyFileSync(scriptPath, finalScriptPath);

        } catch {

          /* ignore */

        }

      }

      const okLine = `✓ Nav script OK on attempt ${attempt}${scriptPath && attempt === 1 ? " (cached replay)" : ` (${aiMeta.model || healLabel})`}`;

      attempts.push({ id: "agent", ok: true, logLine: okLine });

      appendRunLog(runId, okLine);

      writeHealProgress(runId, { phase: "done", attempts });

      return {

        ok: true,

        cached: Boolean(scriptPath && attempt === 1 && !aiMeta.model),

        aiGenerated: Boolean(aiMeta.model),

        script: data.script,

        pageUrl: data.pageUrl,

        origin: data.origin,

        attempts,

        aiMeta,

        rationale: data.rationale || aiMeta.rationale,

        scenarioPlans: data.script?.scenarioPlans || [],

        agentAttempts: attempt,

        durationMs: Date.now() - started,

        ms: Date.now() - started,

      };

    }



    agentHistory.push({

      attempt,

      observation: obs,

      result: data.result,

      pageUrl: data.pageUrl,

      stepsRun: data.stepsRun,

      script: scriptPath ? JSON.parse(fs.readFileSync(scriptPath, "utf-8")) : null,

    });



    if (attempt >= AGENT_MAX_ATTEMPTS) break;



    writeHealProgress(runId, {
      phase: "ai_thinking",
      currentStep: `${healLabel} writing nav script`,
      attempts,
    });

    const thinkLine = `🧠 ${healLabel} repairing nav script (attempt ${attempt} failed)…`;

    attempts.push({ id: "heal", ok: false, logLine: thinkLine });

    appendRunLog(runId, thinkLine);

    appendRunLog(

      runId,

      `  context: url=${obs.url || "?"} 404=${Boolean(obs.is404)} onRC=${Boolean(obs.onRateCalculator)}`

    );



    const { script, meta } = await proposeHealScript({

      observation: obs,

      history: agentHistory,

      scenarios,

      datasetTitle,

      moduleName,

      model: ctx.model,

      provider: ctx.provider,

      attempt: attempt + 1,

    });



    aiMeta = meta;

    scriptPath = path.join(tmpDir, `script-attempt-${attempt + 1}.json`);

    fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2), "utf-8");



    const planLine = `✓ ${healLabel} nav plan (${meta.stepCount} steps): ${String(meta.rationale || script.rationale || "").slice(0, 200)}`;

    attempts.push({ id: "heal", ok: true, logLine: planLine });

    appendRunLog(runId, planLine);

    writeHealProgress(runId, { phase: "ai_executing", attempts });

  }



  const failError =

    lastData?.brokenReason || lastData?.errors?.join("; ") || "Could not heal navigation to Rate Calculator";

  recordHealRunFailure({

    pageUrl: lastData?.pageUrl,

    error: failError,

    observation: lastData?.observation,

    attempt: AGENT_MAX_ATTEMPTS,

  });



  writeHealProgress(runId, { phase: "failed", attempts });

  return {

    ok: false,

    error: failError,

    pageUrl: lastData?.pageUrl,

    attempts,

    aiMeta,

    agentAttempts: AGENT_MAX_ATTEMPTS,

    durationMs: Date.now() - started,

  };

}



async function mapBatchResults(data, e2eScenarios, runId) {

  const byId = new Map();

  for (const raw of data.results || []) {

    const scenario = e2eScenarios.find((s) => s.id === raw.scenarioId);

    if (!scenario) continue;



    const { screenshots, count } = await persistE2eScreenshot(runId, raw.screenshot);
    const video = await persistE2eVideo(runId, raw.video, raw.scenarioId);

    const pageUrl = String(raw.pageUrl || "");

    const flowOk = raw.ok !== false;

    const brokenRoute =

      pageUrl.toLowerCase().includes("manage-courier") &&

      !pageUrl.toLowerCase().includes("rate-calculator");



    const actual = {

      ok: flowOk && !brokenRoute,

      e2eFlow: raw.e2eFlow,

      pageUrl: raw.pageUrl,

      uiText: raw.uiText,

      stepsRun: raw.stepsRun || [],

      screenshots,

      screenshotCount: count,

      video,

      error:

        raw.error ||

        (brokenRoute ? "Landed on manage-courier 404 route" : null) ||

        (!flowOk ? "E2E flow failed" : null),

      endpoint: "/api/testing/e2e-batch",

      method: "PLAYWRIGHT",

    };



    if (raw.stepsRun?.length) {

      console.log(

        `[e2e-batch] ${scenario.id} ${actual.ok ? "PASS" : "FAIL"} — ${pageUrl}`,

        raw.stepsRun.join(" | ")

      );

    }



    const { evaluateAssertions, baseResult } = runnerUtils();

    const assertions = evaluateAssertions(actual, scenario.expectedResults, scenario);

    byId.set(

      scenario.id,

      baseResult(scenario, {

        status: assertions.passed ? "passed" : "failed",

        durationMs: raw.durationMs || 0,

        assertions,

        screenshots,

        video,

        actual: {

          e2eFlow: actual.e2eFlow,

          pageUrl: actual.pageUrl,

          screenshotCount: count,

          video,

          error: actual.error,

          stepsRun: actual.stepsRun,

          uiPreview: actual.uiText ? String(actual.uiText).slice(0, 280) : undefined,

        },

      })

    );

  }



  const { baseResult } = runnerUtils();

  const results = e2eScenarios.map(

    (s) =>

      byId.get(s.id) ||

      baseResult(s, {

        status: "failed",

        error: data.error || "No result from batch runner",

        assertions: { passed: false, failures: ["Batch runner did not return this scenario"] },

      })

  );



  return results;

}



function detectScenarioConfigFailures(rawResults, scenarios) {

  const failures = [];

  const resultById = new Map((rawResults || []).map((r) => [r.scenarioId, r]));



  for (const scenario of scenarios || []) {

    const id = scenario.id;

    const raw = resultById.get(id);

    const flow = scenario.inputs?.e2eFlow || scenario.inputs?.uiAction;

    const isE2e =

      scenario.category === "e2e" || Boolean(flow) || isE2ePanelScenario(scenario);



    if (isE2e && !flow) {

      failures.push({

        scenarioId: id,

        error: "Missing e2eFlow/uiAction on E2E scenario",

        scenario,

        raw,

      });

      continue;

    }



    if (!raw) continue;

    const err = String(raw.error || "");

    const instant = (raw.durationMs || 0) <= 0;

    const configError =

      /unsupported e2e flow/i.test(err) ||

      (instant && err && /unsupported|missing.*e2e|e2e flow/i.test(err));



    if (configError) {

      failures.push({ scenarioId: id, error: err, scenario, raw });

    }

  }



  return failures;

}



function mergeScenarioPatches(scenarios, patches) {

  const byId = new Map((patches || []).map((p) => [p.scenarioId, p]));

  return (scenarios || []).map((s) => {

    const patch = byId.get(s.id);

    if (!patch) return s;

    const inputs = { ...(s.inputs || {}) };

    if (patch.e2eFlow) inputs.e2eFlow = patch.e2eFlow;

    if (patch.formData) inputs.formData = patch.formData;

    return { ...s, inputs };

  });

}



async function runE2eScenarioHeal(

  ctx,

  { scenarios, failures, datasetTitle, batchResults, listPath, needsRcNav, navScriptPath }

) {

  const runId = ctx.runId || `e2e_batch_${Date.now()}`;

  const started = Date.now();

  let currentScenarios = [...(scenarios || [])];

  let batchData = batchResults;

  const healAttempts = [];

  let lastPatches = [];

  let lastRationale = "";

  let lastMeta = {};



  const healLabel = healBackendLabel();

  for (let attempt = 1; attempt <= SCENARIO_HEAL_MAX_ATTEMPTS; attempt++) {

    const activeFailures = detectScenarioConfigFailures(batchData, currentScenarios);

    if (!activeFailures.length) {

      return {

        ok: true,

        attempts: attempt - 1,

        patches: lastPatches,

        rationale: lastRationale,

        scenarios: currentScenarios,

        healAttempts,

        meta: lastMeta,

        durationMs: Date.now() - started,

      };

    }



    console.log(

      `[e2e-session] ${healLabel} self-heal: fixing scenario e2eFlow… (attempt ${attempt}/${SCENARIO_HEAL_MAX_ATTEMPTS})`

    );



    const healLine = `🧠 ${healLabel} repairing scenario e2eFlow (${activeFailures.length} failure(s))…`;

    healAttempts.push({ id: `scenario_heal_${attempt}`, ok: false, logLine: healLine });

    appendRunLog(runId, healLine);

    for (const f of activeFailures.slice(0, 8)) {

      appendRunLog(runId, `  ✗ ${f.scenarioId}: ${f.error || "config error"}`);

    }



    writeHealProgress(runId, {

      phase: "scenario_heal",

      currentStep: `Scenario e2eFlow heal ${attempt}/${SCENARIO_HEAL_MAX_ATTEMPTS}`,

      attempts: healAttempts,

    });



    const { patches, rationale, meta } = await proposeScenarioHeal({

      failures: activeFailures,

      scenarios: currentScenarios,

      datasetTitle,

      model: ctx.model,

      provider: ctx.provider,

      attempt,

    });



    lastPatches = patches;

    lastRationale = rationale;

    lastMeta = meta;



    if (!patches.length) {

      const noPatchLine = `✗ ${healLabel} returned no patches: ${meta.error || "empty response"}`;

      healAttempts.push({ id: `scenario_heal_${attempt}`, ok: false, logLine: noPatchLine });

      appendRunLog(runId, noPatchLine);

      break;

    }



    currentScenarios = mergeScenarioPatches(currentScenarios, patches);

    fs.writeFileSync(listPath, JSON.stringify(currentScenarios, null, 2), "utf-8");



    const patchedIds = patches.map((p) => p.scenarioId).join(", ");

    const patchLine = `✓ Patched ${patchedIds}: ${String(rationale || "").slice(0, 200)}`;

    healAttempts.push({ id: `scenario_heal_${attempt}`, ok: true, logLine: patchLine });

    appendRunLog(runId, patchLine);

    for (const p of patches) {

      appendRunLog(runId, `  · ${p.scenarioId} → ${p.e2eFlow}${p.reason ? ` (${p.reason})` : ""}`);

    }



    writeHealProgress(runId, { phase: "scenario_heal", attempts: healAttempts });



    const { data, error } = await invokeE2eBatchPython(

      runId,

      listPath,

      needsRcNav ? navScriptPath : "",

      ctx,

      { label: `Re-run after scenario patch (${attempt})` }

    );



    if (!data) {

      const rerunFail = `✗ Batch re-run failed: ${error || "no output"}`;

      healAttempts.push({ id: `scenario_heal_rerun_${attempt}`, ok: false, logLine: rerunFail });

      appendRunLog(runId, rerunFail);

      break;

    }



    batchData = data.results || [];

    const remaining = detectScenarioConfigFailures(batchData, currentScenarios);

    if (!remaining.length) {

      writeHealProgress(runId, { phase: "done", attempts: healAttempts });

      return {

        ok: true,

        attempts: attempt,

        patches: lastPatches,

        rationale: lastRationale,

        scenarios: currentScenarios,

        healAttempts,

        meta: lastMeta,

        batchData: data,

        durationMs: Date.now() - started,

      };

    }

  }



  const failError =

    lastMeta.error ||

    `Scenario e2eFlow self-heal exhausted after ${SCENARIO_HEAL_MAX_ATTEMPTS} attempt(s)`;

  recordHealRunFailure({

    error: failError,

    observation: { failures: detectScenarioConfigFailures(batchData, currentScenarios) },

    attempt: SCENARIO_HEAL_MAX_ATTEMPTS,

  });



  writeHealProgress(runId, { phase: "failed", attempts: healAttempts });



  return {

    ok: false,

    error: failError,

    attempts: SCENARIO_HEAL_MAX_ATTEMPTS,

    patches: lastPatches,

    rationale: lastRationale,

    scenarios: currentScenarios,

    healAttempts,

    meta: lastMeta,

    durationMs: Date.now() - started,

  };

}



/** Run E2E scenarios in one browser session — scripts only; AI heals nav on failure. */

async function runE2eBatch(scenarios, ctx, { forceHeal = false, datasetTitle = "" } = {}) {

  if (ctx.skipAiHeal === undefined) {
    ctx = { ...ctx, skipAiHeal: !isAiScopeEnabled("script_debug") };
  }

  const runId = ctx.runId || `e2e_batch_${Date.now()}`;

  let e2eScenarios = Array.isArray(scenarios) ? scenarios : [];

  if (!e2eScenarios.length) {

    return { ok: true, results: [], heal: null, scenarioHeal: null, durationMs: 0 };

  }

  const needsRcNav = e2eScenarios.some((s) => isRateCalculatorE2eScenario(s));



  const tmpDir = path.join(ROOT, "output", "test-runs", runId, "e2e-batch");

  fs.mkdirSync(tmpDir, { recursive: true });

  const listPath = path.join(tmpDir, "scenarios.json");

  fs.writeFileSync(listPath, JSON.stringify(e2eScenarios, null, 2), "utf-8");



  clearHealProgress(runId);

  writeHealProgress(runId, {

    phase: "e2e_batch",

    currentStep: `0 / ${e2eScenarios.length}`,

    attempts: [],

  });

  appendRunLog(runId, `▶ E2E batch — ${e2eScenarios.length} scenario(s), one browser login`);



  const started = Date.now();

  let navScriptPath = forceHeal ? "" : getValidCachedScriptPath();

  let healResult = null;

  let scenarioHealResult = null;



  if (navScriptPath) {

    console.log(`[e2e-batch] Using cached nav script: ${navScriptPath}`);

  }



  let { data, error } = await invokeE2eBatchPython(
    runId,
    listPath,
    needsRcNav ? navScriptPath : "",
    ctx,
    { label: "E2E session (first pass)" }
  );



  if (!data) {

    return {

      ok: false,

      error: error || "E2E session failed",

      cancelled: false,

      results: [],

      heal: null,

      scenarioHeal: null,

      durationMs: Date.now() - started,

    };

  }



  if (data.needsAiHeal && needsRcNav && !ctx.skipAiHeal) {

    console.log(`[e2e-session] RC nav failed — ${healBackendLabel()} self-heal (scripts only)…`);

    appendRunLog(
      runId,
      `⚠ RC navigation failed — ${healBackendLabel()} nav self-heal starting…`
    );

    healResult = await runE2eNavHeal(ctx, {

      force: forceHeal,

      scenarios: e2eScenarios.filter((s) => isRateCalculatorE2eScenario(s)),

      datasetTitle,

    });

    if (!healResult.ok) {

      return {

        ok: false,

        error: healResult.error || "Navigation self-heal failed",

        cancelled: Boolean(healResult.cancelled),

        results: [],

        heal: healResult,

        scenarioHeal: null,

        durationMs: Date.now() - started,

      };

    }

    navScriptPath = getValidCachedScriptPath();

    ({ data, error } = await invokeE2eBatchPython(runId, listPath, navScriptPath, ctx, {
      label: "E2E session (after nav heal)",
    }));

    if (!data) {

      return {

        ok: false,

        error: error || "E2E batch failed after heal",

        results: [],

        heal: healResult,

        scenarioHeal: null,

        durationMs: Date.now() - started,

      };

    }

  }



  const configFailures = detectScenarioConfigFailures(data.results, e2eScenarios);
  const skipScenarioHeal = ctx.skipScenarioHeal || isScriptFirstTestcaseBackend();

  if (configFailures.length && skipScenarioHeal) {
    appendRunLog(
      runId,
      `⚠ ${configFailures.length} scenario config issue(s) — scenario AI heal skipped (script-first; fix scripts manually)`
    );
  }

  if (configFailures.length && !ctx.skipAiHeal && !skipScenarioHeal) {

    appendRunLog(

      runId,

      `⚠ ${configFailures.length} scenario(s) missing/wrong e2eFlow — ${healBackendLabel()} scenario self-heal starting…`

    );

    scenarioHealResult = await runE2eScenarioHeal(ctx, {

      scenarios: e2eScenarios,

      failures: configFailures,

      datasetTitle,

      batchResults: data.results,

      listPath,

      needsRcNav,

      navScriptPath,

    });



    if (scenarioHealResult.scenarios) {

      e2eScenarios = scenarioHealResult.scenarios;

    }



    if (scenarioHealResult.batchData) {

      data = scenarioHealResult.batchData;

    } else if (!scenarioHealResult.ok) {

      const results = await mapBatchResults(data, e2eScenarios, runId);

      return {

        ok: false,

        error: scenarioHealResult.error || "Scenario e2eFlow self-heal failed",

        heal: healResult || data.heal || null,

        scenarioHeal: scenarioHealResult,

        results,

        durationMs: Date.now() - started,

      };

    }

  }



  const results = await mapBatchResults(data, e2eScenarios, runId);



  const passed = results.filter((r) => r.status === "passed").length;

  const failed = results.filter((r) => r.status === "failed").length;

  appendRunLog(runId, `■ Batch done — ${passed} passed, ${failed} failed`);

  writeHealProgress(runId, { phase: "done", currentStep: `${passed + failed} / ${e2eScenarios.length}` });



  return {

    ok: data.ok !== false && !data.needsAiHeal,

    error: data.error || null,

    heal: healResult || data.heal || null,

    scenarioHeal: scenarioHealResult,

    results,

    durationMs: Date.now() - started,

  };

}



module.exports = {

  runE2eNavHeal,

  runE2eBatch,

  runE2eScenarioHeal,

  detectScenarioConfigFailures,

  mergeScenarioPatches,

  isE2ePanelScenario,

  getValidCachedScriptPath,

};

