const express = require("express");
const fs = require("fs");
const path = require("path");
const { getConfigStatus, saveConfig, clearStoredApiKey, resolveChatProvider, resolveChatModel } = require("./lib/ai-config");
const {
  isAiScopeEnabled,
  isChatAiEnabled,
  getChatDisabledReason,
  getAiScopeStatus,
} = require("./lib/ai-scope");
const { callLLM, testConnection } = require("./lib/llm");
const {
  generateModulePackage,
  generateModulePackageStep,
  captureScreenshotsWithHeal,
  nowSessionId,
  EXAMPLE_SOURCES,
  getReportExamplesContext,
} = require("./lib/doc-generation");
const { docsCaptureTimeoutMs } = require("./lib/tunnel-host");
const {
  createScreenshotJob,
  updateScreenshotJob,
  getScreenshotJob,
} = require("./lib/screenshot-job-store");
const {
  createTestcaseGenJob,
  updateTestcaseGenJob,
  getTestcaseGenJob,
} = require("./lib/testcase-gen-job-store");
const { storeScreenshotBatch, storeVideoBatch, CLOUD_ROOT } = require("./lib/image-storage");
const { saveReport, listReports, getReport, deleteReport, warmupReportArchive, cloudReportsEnabled } = require("./lib/report-archive");
const {
  searchReports,
  buildRetrievalContext,
  buildRetrievalContextForSession,
  buildKnowledgeSystemPrompt,
  buildHybridSystemPrompt,
  liveBrowseMatchesQuery,
} = require("./lib/report-retrieval");
const {
  browsePanelForChat,
  browseTimeoutMs,
  appendScreenshotsIfMissing,
  mergeScreenshots,
} = require("./lib/panel-browse");
const { loadNavigationMap, getNavigationMapPath } = require("./lib/panel-navigation");
const { clearAllAppData } = require("./lib/clear-app-data");
const { runPythonScript } = require("./lib/spawn-python");
const {
  generateTestDataset,
  generateTestDatasetFromDocs,
  ensureRunnableScenarios,
  TEST_AREAS,
  SCOPE_TYPES,
} = require("./lib/test-dataset-generation");
const { buildRateCalculatorE2eDataset } = require("./lib/rate-calculator-dataset");
const {
  saveDataset,
  getDataset,
  listDatasets,
  deleteDataset,
} = require("./lib/test-dataset-store");
const { runTestDataset, runTestStep } = require("./lib/test-dataset-runner");
const {
  createRunStepJob,
  createTestingJob,
  finishRunStepJob,
  failRunStepJob,
  getRunStepJob,
  getTestingJob,
  cancelJobsForRun,
  isJobCancelled,
} = require("./lib/test-run-jobs");
const { runE2eNavHeal, runE2eBatch } = require("./lib/test-e2e-batch");
const {
  isScriptFirstTestcaseBackend,
  isAiTestcaseGenerationEnabled,
  testcaseBackendLabel,
} = require("./lib/testcase-backend");
const {
  getNavScript,
  saveNavScript,
  normalizeImportedDataset,
} = require("./lib/e2e-script-store");
const { readHealProgress, clearHealProgress } = require("./lib/heal-progress");
const { getRun, listRuns, saveRun, deleteRun } = require("./lib/test-run-store");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
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

loadDotEnv();

const { applyPlaywrightBrowsersEnv, ensurePlaywrightBrowsersOnStartup } = require("./lib/playwright-browsers");
applyPlaywrightBrowsersEnv();

const app = express();
const ROOT = __dirname;

fs.mkdirSync(CLOUD_ROOT, { recursive: true });

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

const { cloudinaryConfigured } = require("./lib/image-storage");

const {
  clearRuntimePublicUrl,
  getRuntimePublicUrl,
  getLocalBaseUrl,
  getPublicBaseUrl,
  getTunnelStatus,
  getTunnelError,
  getRecommendedAppUrl,
  isAutoTunnelEnabled,
  isRenderDeploy,
  getRenderExternalUrl,
  tunnelUrlIsActive,
} = require("./lib/public-url");

app.get("/api/health", (_req, res) => {
  const localUrl = getLocalBaseUrl();
  const publicUrl = getRuntimePublicUrl() || null;
  const aiScope = getAiScopeStatus();
  const features = [
    ...(isChatAiEnabled() ? ["chat"] : []),
    "module-docs",
    "test-dataset",
    "test-run",
    "run-step",
    ...(aiScope.scriptDebugEnabled ? ["e2e-heal"] : []),
    "e2e-batch",
    "ai-heal-lessons",
    "hybrid-pipeline",
    "testing-setup",
    "postman-import",
    "frontend-scenarios",
    "reports",
    "auto-tunnel",
  ];
  res.json({
    ok: true,
    version: "dev-helper-v30",
    features,
    aiScope,
    localUrl,
    publicUrl,
    recommendedUrl: getRecommendedAppUrl(),
    publicBaseUrl: getPublicBaseUrl(),
    datasetMaxOutputTokens: Number(process.env.DATASET_MAX_OUTPUT_TOKENS || 6000),
    tunnelActive: tunnelUrlIsActive(),
    tunnelStatus: getTunnelStatus(),
    tunnelError: getTunnelError() || null,
    autoTunnel: isAutoTunnelEnabled(),
    render: isRenderDeploy(),
    renderExternalUrl: getRenderExternalUrl() || null,
    urlNote: isRenderDeploy()
      ? "On Render — use renderExternalUrl (stable HTTPS). Cloudflare tunnel is disabled."
      : "Local: use localUrl. trycloudflare.com links expire when npm start stops.",
    ai: getConfigStatus(),
    cloudinary: cloudinaryConfigured(),
    imageStorage: process.env.IMAGE_STORAGE || "local",
    panelLoginConfigured:
      Boolean(String(process.env.SHIPMOZO_EMAIL || "").trim()) &&
      Boolean(String(process.env.SHIPMOZO_PASSWORD || "").trim()),
    reportStorage: cloudReportsEnabled() ? "cloudinary" : "local",
  });
});

app.get("/api/ai/config", (_req, res) => {
  res.json(getConfigStatus());
});

app.post("/api/ai/config", (req, res) => {
  const apiKey = req.body?.apiKey;
  const model = req.body?.model;
  const provider = req.body?.provider;
  const githubRepoUrl = req.body?.githubRepoUrl;
  if (
    apiKey === undefined &&
    model === undefined &&
    provider === undefined &&
    githubRepoUrl === undefined
  ) {
    res.status(400).json({ error: "Provide provider, apiKey, model, and/or githubRepoUrl" });
    return;
  }
  res.json(saveConfig({ apiKey, model, provider, githubRepoUrl }));
});

app.get("/api/ai/github/status", async (_req, res) => {
  try {
    const { getGithubRepoStatus } = require("./lib/github-repo-context");
    const status = await getGithubRepoStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/github/refresh", async (_req, res) => {
  try {
    const { getGithubRepoStatus } = require("./lib/github-repo-context");
    const status = await getGithubRepoStatus({ forceRefresh: true });
    res.json({ ok: status.ok, ...status });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.delete("/api/ai/config", (_req, res) => {
  res.json(clearStoredApiKey());
});

app.post("/api/ai/test", async (req, res) => {
  try {
    const result = await testConnection(req.body?.model, req.body?.provider);
    res.json(result);
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.post("/api/app/clear-data", async (_req, res) => {
  try {
    res.json(await clearAllAppData());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/panel/navigation", (_req, res) => {
  const map = loadNavigationMap();
  res.json({
    ok: true,
    path: getNavigationMapPath(),
    source: map.source,
    discoveredAt: map.discoveredAt,
    pageCount: map.pageCount || map.pages?.length || 0,
    pages: map.pages || [],
  });
});

app.post("/api/panel/discover-navigation", async (_req, res) => {
  try {
    const proc = await runPythonScript("discover_panel_navigation.py", [], 300000);
    const raw = (proc.stdout || "").trim();
    let meta = {};
    if (raw) {
      try {
        meta = JSON.parse(raw.split("\n").pop());
      } catch {
        meta = { ok: proc.ok, output: raw.slice(-500) };
      }
    }
    if (!proc.ok) {
      res.status(502).json({
        error: proc.error || proc.stderr || "Navigation discovery failed",
        ...meta,
      });
      return;
    }
    const map = loadNavigationMap();
    res.json({
      ok: true,
      message: "Panel navigation map updated from live website crawl",
      pageCount: map.pageCount || map.pages?.length || 0,
      source: map.source,
      discoveredAt: map.discoveredAt,
      ...meta,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/docs/examples", (_req, res) => {
  res.json({
    sources: EXAMPLE_SOURCES,
    outputs: ["prd", "user_manual"],
    summary: "PRD = full technical module doc. User manual = step-by-step guide with embedded screenshot URLs.",
    previewLength: getReportExamplesContext().length,
  });
});

app.get("/api/testing/setup", (_req, res) => {
  try {
    const { getTestingSetupStatus } = require("./lib/testing-setup");
    res.json({ ok: true, ...getTestingSetupStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/testing/meta", (_req, res) => {
  res.json({
    ok: true,
    testAreas: TEST_AREAS,
    scopeTypes: SCOPE_TYPES,
    generateFromDocs: isAiTestcaseGenerationEnabled(),
    scriptFirst: isScriptFirstTestcaseBackend(),
    testcaseBackend: testcaseBackendLabel(),
    apiRunBackend: require("./lib/api-run-backend").apiRunBackendLabel(),
    workflowDoc: "docs/TESTING-WORKFLOW.md",
    navPageCount: loadNavigationMap().pageCount || 0,
    e2eFlows: [
      "rate_calculator_open",
      "rate_calculator_domestic_happy",
      "rate_calculator_international_toggle",
      "rate_calculator_invalid_pincode",
      "rate_calculator_missing_weight",
      "rate_calculator_heavy_parcel",
      "rate_calculator_dimensions",
    ],
  });
});

app.post("/api/testing/frontend-scenarios/pairs", (req, res) => {
  try {
    const { uiScenariosForFolders } = require("./lib/postman-ui-pairs");
    const folders = (req.body?.folders || []).map((f) => String(f || "").trim()).filter(Boolean);
    const scenarios = uiScenariosForFolders(folders);
    res.json({ ok: true, scenarios, count: scenarios.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/testing/frontend-scenarios/build", (req, res) => {
  try {
    const { buildFrontendScenariosFromText } = require("./lib/frontend-scenario-builder");
    const scenarios = buildFrontendScenariosFromText(String(req.body?.text || ""));
    res.json({ ok: true, scenarios, count: scenarios.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/testing/seed/rate-calculator", (_req, res) => {
  try {
    const dataset = buildRateCalculatorE2eDataset();
    saveDataset(dataset);
    res.json({ ok: true, dataset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/testing/datasets", (_req, res) => {
  res.json({ ok: true, datasets: listDatasets() });
});

app.get("/api/testing/datasets/:id", (req, res) => {
  let dataset = getDataset(String(req.params.id || "").trim());
  if (!dataset) {
    res.status(404).json({ error: "Test dataset not found" });
    return;
  }
  dataset = ensureRunnableScenarios(dataset);
  res.json({ ok: true, dataset });
});

app.post("/api/testing/datasets/delete", (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  res.json(deleteDataset(id));
});

app.post("/api/testing/datasets/import", (req, res) => {
  try {
    const raw = req.body?.dataset ?? req.body;
    let dataset = normalizeImportedDataset(raw, { title: req.body?.title });
    if (req.body?.save !== false) {
      dataset = saveDataset(dataset);
    }
    res.json({ ok: true, dataset });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/testing/scripts/nav", (_req, res) => {
  const script = getNavScript();
  res.json({
    ok: true,
    script,
    path: script ? "output/runtime/e2e-ai-script.json" : null,
  });
});

app.post("/api/testing/scripts/nav", (req, res) => {
  try {
    const script = req.body?.script ?? req.body;
    const saved = saveNavScript(script, {
      module: req.body?.module,
      source: req.body?.source || "user-import",
    });
    res.json({ ok: true, ...saved });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/testing/runs", (req, res) => {
  const datasetId = String(req.query.datasetId || "").trim();
  res.json({ ok: true, runs: listRuns(datasetId || undefined) });
});

app.get("/api/testing/runs/:runId", (req, res) => {
  const run = getRun(String(req.params.runId || "").trim());
  if (!run) {
    res.status(404).json({ error: "Test run not found" });
    return;
  }
  res.json({ ok: true, run });
});

app.post("/api/testing/runs/delete", (req, res) => {
  try {
    const runId = String(req.body?.runId || "").trim();
    if (!runId) {
      res.status(400).json({ error: "runId is required" });
      return;
    }
    res.json(deleteRun(runId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function runStepPayload(req) {
  const postmanFolders = req.body?.postmanFolders;
  return {
    runId: String(req.body?.runId || nowSessionId()).trim(),
    scenario: req.body?.scenario,
    skipLive: req.body?.skipLive === true,
    captureEvidence: req.body?.captureEvidence !== false,
    showBrowser: req.body?.showBrowser !== false,
    model: req.body?.model,
    provider: req.body?.provider,
    postmanFolders: Array.isArray(postmanFolders) ? postmanFolders : null,
    runTarget: String(req.body?.runTarget || "backend"),
    index: Number(req.body?.index) || 0,
    total: Number(req.body?.total) || 0,
  };
}

app.post("/api/testing/run-step/start", async (req, res) => {
  const {
    scenario,
    runId,
    skipLive,
    captureEvidence,
    showBrowser,
    model,
    provider,
    postmanFolders,
    runTarget,
    index,
    total,
  } = runStepPayload(req);
  if (!scenario?.id) {
    res.status(400).json({ error: "scenario with id is required" });
    return;
  }

  const jobId = createRunStepJob({
    runId,
    scenarioId: scenario.id,
    index,
    total,
  });

  res.json({ ok: true, jobId, runId, status: "running", index, total });

  setImmediate(async () => {
    try {
      const result = await runTestStep({
        runId,
        scenario,
        skipLive,
        captureEvidence,
        showBrowser,
        model,
        provider,
        postmanFolders,
        runTarget,
      });
      if (isJobCancelled(jobId)) return;
      finishRunStepJob(jobId, result);
    } catch (err) {
      if (isJobCancelled(jobId)) return;
      failRunStepJob(jobId, err.message);
    }
  });
});

app.get("/api/testing/run-step/status/:jobId", (req, res) => {
  const job = getRunStepJob(String(req.params.jobId || "").trim());
  if (!job) {
    res.status(404).json({ error: "Test step job not found" });
    return;
  }
  res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    runId: job.runId,
    scenarioId: job.scenarioId,
    index: job.index,
    total: job.total,
    result: job.result,
    error: job.error,
    elapsedSeconds: Math.floor((Date.now() - job.startedAt) / 1000),
  });
});

function testingJobStatus(job) {
  let attempts = job.attempts || job.result?.attempts || null;
  let healPhase = null;
  let liveProgress = null;
  if (
    job.status === "running" &&
    job.runId &&
    (job.kind === "e2e-heal" || job.kind === "e2e-batch" || job.kind === "docs-pipeline")
  ) {
    const live = readHealProgress(job.runId);
    if (live) {
      if (live.attempts?.length) attempts = live.attempts;
      healPhase = live.phase || "running";
      liveProgress = {
        phase: live.phase || "running",
        currentStep: live.currentStep || null,
        attempts: live.attempts || [],
        logLines: live.logLines || [],
      };
    }
  }
  return {
    ok: true,
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    runId: job.runId,
    startedAt: job.startedAt,
    result: job.result,
    error: job.error,
    attempts,
    healPhase,
    liveProgress,
    elapsedSeconds: Math.floor((Date.now() - job.startedAt) / 1000),
  };
}

app.get("/api/testing/e2e-heal/ping", (_req, res) => {
  const { resolveTestcaseLlmPair } = require("./lib/report-llm-split");
  const tc = resolveTestcaseLlmPair();
  res.json({ ok: true, feature: "e2e-heal", agent: tc.testcaseProvider, model: tc.testcaseModel });
});

app.post("/api/testing/e2e-heal/start", async (req, res) => {
  if (!isAiScopeEnabled("script_debug")) {
    res.status(403).json({
      error: `Script debugger AI is disabled. ${getAiScopeStatus().limitedMessage}`,
      code: "AI_SCOPE_DISABLED",
      aiScope: getAiScopeStatus(),
    });
    return;
  }

  const runId = String(req.body?.runId || nowSessionId()).trim();
  const showBrowser = req.body?.showBrowser !== false;
  const force = req.body?.force === true;
  const scenarios = Array.isArray(req.body?.scenarios) ? req.body.scenarios : [];
  const datasetTitle = String(req.body?.datasetTitle || "").trim();
  const model = req.body?.model;
  const provider = req.body?.provider;

  const jobId = createTestingJob("e2e-heal", { runId });
  res.json({ ok: true, jobId, status: "running" });

  setImmediate(async () => {
    try {
      const result = await runE2eNavHeal(
        { runId, showBrowser, model, provider },
        { force, scenarios, datasetTitle }
      );
      clearHealProgress(runId);
      if (isJobCancelled(jobId)) return;
      const job = getTestingJob(jobId);
      if (job) job.attempts = result.attempts || [];
      finishRunStepJob(jobId, result);
    } catch (err) {
      if (isJobCancelled(jobId)) return;
      failRunStepJob(jobId, err.message);
    }
  });
});

app.get("/api/testing/e2e-heal/status/:jobId", (req, res) => {
  const job = getTestingJob(String(req.params.jobId || "").trim());
  if (!job || job.kind !== "e2e-heal") {
    res.status(404).json({ error: "Heal job not found" });
    return;
  }
  res.json(testingJobStatus(job));
});

app.get("/api/testing/ai-heal/lessons", (_req, res) => {
  const { loadHealLessons } = require("./lib/ai-heal-lessons");
  const lessons = loadHealLessons();
  res.json({ ok: true, count: lessons.length, lessons });
});

app.post("/api/testing/ai-heal/lessons", (req, res) => {
  const { appendHealLesson } = require("./lib/ai-heal-lessons");
  const issue = String(req.body?.issue || req.body?.problem || "").trim();
  const fix = String(req.body?.fix || req.body?.solution || "").trim();
  const title = String(req.body?.title || "").trim();
  const module = String(req.body?.module || "").trim();
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];

  if (!issue || !fix) {
    res.status(400).json({ error: "issue and fix are required" });
    return;
  }

  try {
    const result = appendHealLesson({ title, issue, fix, module: module || undefined, tags });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/testing/e2e-batch/start", async (req, res) => {
  const runId = String(req.body?.runId || nowSessionId()).trim();
  const scenarios = req.body?.scenarios;
  const showBrowser = req.body?.showBrowser !== false;
  const forceHeal = req.body?.forceHeal === true;
  const captureEvidence = req.body?.captureEvidence !== false;
  const datasetTitle = String(req.body?.datasetTitle || "").trim();
  const model = req.body?.model;
  const provider = req.body?.provider;

  if (!Array.isArray(scenarios) || !scenarios.length) {
    res.status(400).json({ error: "scenarios array is required" });
    return;
  }

  const jobId = createTestingJob("e2e-batch", { runId, total: scenarios.length });
  res.json({ ok: true, jobId, runId, status: "running", total: scenarios.length });

  setImmediate(async () => {
    try {
      const runTarget = String(req.body?.runTarget || "backend");
      const result = await runE2eBatch(
        scenarios,
        {
          runId,
          showBrowser,
          captureEvidence,
          runTarget,
          recordVideo: runTarget === "frontend" || runTarget === "both",
          model,
          provider,
          skipAiHeal: !isAiScopeEnabled("script_debug"),
        },
        { forceHeal, datasetTitle }
      );
      if (isJobCancelled(jobId)) return;
      finishRunStepJob(jobId, result);
    } catch (err) {
      if (isJobCancelled(jobId)) return;
      failRunStepJob(jobId, err.message);
    }
  });
});

app.get("/api/testing/e2e-batch/status/:jobId", (req, res) => {
  const job = getTestingJob(String(req.params.jobId || "").trim());
  if (!job || job.kind !== "e2e-batch") {
    res.status(404).json({ error: "E2E batch job not found" });
    return;
  }
  res.json(testingJobStatus(job));
});

app.post("/api/testing/run-step", async (req, res) => {
  const { scenario, runId, skipLive, captureEvidence, showBrowser, model, provider, index, total } =
    runStepPayload(req);
  if (!scenario?.id) {
    res.status(400).json({ error: "scenario with id is required" });
    return;
  }

  try {
    const result = await runTestStep({
      runId,
      scenario,
      skipLive,
      captureEvidence,
      showBrowser,
      model,
      provider,
    });
    res.json({
      ok: true,
      runId,
      result,
      index,
      total,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/testing/run/stop", (req, res) => {
  const runId = String(req.body?.runId || "").trim();
  if (!runId) {
    res.status(400).json({ error: "runId is required" });
    return;
  }
  const outcome = cancelJobsForRun(runId, String(req.body?.reason || "Stopped by user"));
  res.json({ ok: true, ...outcome });
});

app.post("/api/testing/run/complete", (req, res) => {
  const run = req.body?.run;
  if (!run?.runId || !Array.isArray(run.results)) {
    res.status(400).json({ error: "run with runId and results array is required" });
    return;
  }
  saveRun(run);
  res.json({ ok: true, run });
});

app.post("/api/testing/run", async (req, res) => {
  const datasetId = String(req.body?.datasetId || "").trim();
  const dataset = req.body?.dataset || (datasetId ? getDataset(datasetId) : null);

  if (!dataset?.scenarios?.length) {
    res.status(400).json({ error: "datasetId or dataset with scenarios is required" });
    return;
  }

  try {
    const run = await runTestDataset({
      datasetId: dataset.id || datasetId,
      dataset,
      scenarioIds: Array.isArray(req.body?.scenarioIds) ? req.body.scenarioIds : undefined,
      skipLive: req.body?.skipLive === true,
      captureEvidence: req.body?.captureEvidence !== false,
      model: req.body?.model,
      provider: req.body?.provider,
      options: {
        runTarget: String(req.body?.runTarget || "backend"),
        showBrowser: req.body?.showBrowser !== false,
        captureEvidence: req.body?.captureEvidence !== false,
      },
    });
    res.json({ ok: true, run });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/testing/generate", async (req, res) => {
  const requirement = String(req.body?.requirement || "").trim();
  if (!requirement) {
    res.status(400).json({ error: "requirement is required (plain text)" });
    return;
  }
  if (isScriptFirstTestcaseBackend()) {
    res.status(400).json({
      error:
        "TESTCASE_BACKEND=scripts — import scenario JSON via POST /api/testing/datasets/import instead of AI generation.",
    });
    return;
  }
  const { isPostmanMcpEnabled } = require("./lib/postman-mcp-dataset");
  if (!isPostmanMcpEnabled() && !getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }
  if (isPostmanMcpEnabled() && !process.env.POSTMAN_API_KEY) {
    res.status(400).json({
      error: "POSTMAN_API_KEY is required for Postman MCP testcase generation",
    });
    return;
  }

  try {
    let dataset = await generateTestDataset({
      requirement,
      options: req.body?.options || {},
      model: req.body?.model,
      provider: req.body?.provider,
    });
    dataset = ensureRunnableScenarios(dataset);
    if (req.body?.save !== false) saveDataset(dataset);
    res.json({ ok: true, dataset });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.post("/api/testing/pipeline/from-docs/start", async (req, res) => {
  const moduleName = String(req.body?.moduleName || "").trim();
  const prd = String(req.body?.prd || "");
  const userManual = String(req.body?.userManual || req.body?.user_manual || "");
  const description = String(req.body?.description || "");
  const sessionId = String(req.body?.sessionId || "").trim();
  const showBrowser = req.body?.showBrowser !== false;
  const captureEvidence = req.body?.captureEvidence !== false;
  const model = req.body?.model;
  const provider = req.body?.provider;

  if (!moduleName) {
    res.status(400).json({ error: "moduleName is required" });
    return;
  }
  if (!prd.trim() && !userManual.trim()) {
    res.status(400).json({ error: "prd or userManual is required" });
    return;
  }
  if (isScriptFirstTestcaseBackend()) {
    res.status(400).json({
      error:
        "TESTCASE_BACKEND=scripts — import scripts and use Run all; doc pipeline is disabled.",
    });
    return;
  }
  if (!getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }

  const runId = String(req.body?.runId || nowSessionId()).trim();
  const { runDocsToE2ePipeline } = require("./lib/test-docs-pipeline");
  const jobId = createTestingJob("docs-pipeline", { runId, moduleName });
  res.json({ ok: true, jobId, runId, status: "running" });

  setImmediate(async () => {
    try {
      const result = await runDocsToE2ePipeline({
        moduleName,
        prd,
        userManual,
        description,
        sessionId,
        options: req.body?.options || {},
        model,
        provider,
        runId,
        showBrowser,
        captureEvidence,
      });
      if (isJobCancelled(jobId)) return;
      finishRunStepJob(jobId, result);
    } catch (err) {
      if (isJobCancelled(jobId)) return;
      failRunStepJob(jobId, err.message);
    }
  });
});

app.get("/api/testing/pipeline/from-docs/status/:jobId", (req, res) => {
  const job = getTestingJob(String(req.params.jobId || "").trim());
  if (!job || job.kind !== "docs-pipeline") {
    res.status(404).json({ error: "Pipeline job not found" });
    return;
  }
  res.json(testingJobStatus(job));
});

app.get("/api/testing/postman/collection-groups", async (req, res) => {
  const collectionId = String(req.query?.collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  if (!collectionId) {
    res.status(400).json({ error: "collectionId or POSTMAN_COLLECTION_ID is required" });
    return;
  }
  if (!String(process.env.POSTMAN_API_KEY || "").trim()) {
    res.status(400).json({ error: "POSTMAN_API_KEY is required" });
    return;
  }
  try {
    const { listPostmanCollectionGroupsForId } = require("./lib/postman-mcp-dataset");
    const data = await listPostmanCollectionGroupsForId(collectionId);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/testing/postman/search", async (req, res) => {
  const collectionId = String(req.body?.collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  const moduleName = String(req.body?.moduleName || req.body?.query || "").trim();
  const keywords = (req.body?.keywords || [])
    .map((k) => String(k || "").trim().toLowerCase())
    .filter(Boolean);
  if (!collectionId) {
    res.status(400).json({ error: "collectionId or POSTMAN_COLLECTION_ID is required" });
    return;
  }
  if (!moduleName && !keywords.length) {
    res.status(400).json({ error: "moduleName, query, or keywords is required" });
    return;
  }
  if (!String(process.env.POSTMAN_API_KEY || "").trim()) {
    res.status(400).json({ error: "POSTMAN_API_KEY is required" });
    return;
  }
  try {
    const { searchPostmanCollectionRequests } = require("./lib/postman-mcp-dataset");
    const data = await searchPostmanCollectionRequests({
      collectionId,
      moduleName,
      keywords,
      query: String(req.body?.query || moduleName).trim(),
      minScore: req.body?.minScore,
    });
    res.json({
      ok: true,
      collectionId: data.collectionId,
      collectionName: data.collectionName,
      keywords: data.keywords,
      requestCount: data.requests.length,
      requests: data.requests,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/testing/postman/import-collection", async (req, res) => {
  const collectionId = String(req.body?.collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  if (!collectionId) {
    res.status(400).json({ error: "collectionId is required" });
    return;
  }
  if (!String(process.env.POSTMAN_API_KEY || "").trim()) {
    res.status(400).json({ error: "POSTMAN_API_KEY is required" });
    return;
  }
  const folders = (req.body?.folders || req.body?.options?.folders || [])
    .map((f) => String(f || "").trim())
    .filter(Boolean);
  if (!folders.length) {
    res.status(400).json({
      error: "Select at least one test group (folders). Load groups from GET /api/testing/postman/collection-groups",
    });
    return;
  }
  try {
    const { importDatasetFromPostmanCollection } = require("./lib/postman-mcp-dataset");
    let dataset = await importDatasetFromPostmanCollection({
      collectionId,
      requirement: String(req.body?.requirement || "").trim(),
      options: req.body?.options || {},
      folders,
    });
    const frontendNotes = String(req.body?.frontendNotes || req.body?.frontendText || "").trim();
    if (frontendNotes) {
      const { mergeFrontendNotesIntoDataset } = require("./lib/frontend-scenario-builder");
      dataset = mergeFrontendNotesIntoDataset(dataset, frontendNotes);
    }
    if (req.body?.save !== false) dataset = saveDataset(dataset);
    res.json({ ok: true, dataset, collectionId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/testing/hybrid-pipeline/start", async (req, res) => {
  const runId = String(req.body?.runId || nowSessionId()).trim();
  const { runHybridTestingPipeline } = require("./lib/hybrid-testing-pipeline");
  const jobId = createTestingJob("hybrid-pipeline", { runId });
  res.json({ ok: true, jobId, runId, status: "running" });

  setImmediate(async () => {
    try {
      const result = await runHybridTestingPipeline({
        postmanMode: req.body?.postmanMode || "import",
        collectionId: req.body?.collectionId,
        postmanRequirement: req.body?.postmanRequirement,
        postmanFolders: req.body?.postmanFolders || req.body?.folders,
        e2eDataset: req.body?.e2eDataset,
        e2eScenarios: req.body?.e2eScenarios,
        navScript: req.body?.navScript,
        title: req.body?.title,
        runTests: req.body?.runTests !== false,
        saveDataset: req.body?.save !== false,
        model: req.body?.model,
        provider: req.body?.provider,
        showBrowser: req.body?.showBrowser !== false,
        captureEvidence: req.body?.captureEvidence !== false,
        skipLive: req.body?.skipLive === true,
        runId,
        options: req.body?.options || {},
      });
      if (isJobCancelled(jobId)) return;
      finishRunStepJob(jobId, result);
    } catch (err) {
      if (isJobCancelled(jobId)) return;
      failRunStepJob(jobId, err.message);
    }
  });
});

app.get("/api/testing/hybrid-pipeline/status/:jobId", (req, res) => {
  const job = getTestingJob(String(req.params.jobId || "").trim());
  if (!job || job.kind !== "hybrid-pipeline") {
    res.status(404).json({ error: "Hybrid pipeline job not found" });
    return;
  }
  res.json(testingJobStatus(job));
});

app.post("/api/testing/postman-agent/generate", async (req, res) => {
  const requirement = String(req.body?.requirement || "").trim();
  if (!requirement) {
    res.status(400).json({ error: "requirement is required (describe APIs to test)" });
    return;
  }
  if (!isAiScopeEnabled("testcase_gen")) {
    res.status(403).json({ error: "testcase_gen is not enabled in AI_SCOPE" });
    return;
  }
  if (!getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }
  if (!String(process.env.POSTMAN_API_KEY || "").trim()) {
    res.status(400).json({ error: "POSTMAN_API_KEY is required for Postman MCP agent" });
    return;
  }

  try {
    const { generateTestCasesViaPostmanMcpAgent } = require("./lib/mcp-postman-testcase-agent");
    let dataset = await generateTestCasesViaPostmanMcpAgent({
      requirement,
      options: req.body?.options || {},
      model: req.body?.model,
      provider: req.body?.provider,
    });
    dataset = ensureRunnableScenarios(dataset);
    if (req.body?.save !== false) saveDataset(dataset);
    res.json({ ok: true, dataset });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.post("/api/testing/generate-from-docs/start", async (req, res) => {
  const moduleName = String(req.body?.moduleName || "").trim();
  const prd = String(req.body?.prd || "");
  const userManual = String(req.body?.userManual || req.body?.user_manual || "");
  const description = String(req.body?.description || "");
  const sessionId = String(req.body?.sessionId || "").trim();

  if (!moduleName) {
    res.status(400).json({ error: "moduleName is required" });
    return;
  }
  if (!prd.trim() && !userManual.trim()) {
    res.status(400).json({ error: "prd or userManual is required" });
    return;
  }
  if (isScriptFirstTestcaseBackend()) {
    res.status(400).json({
      error:
        "TESTCASE_BACKEND=scripts — import scenario JSON via POST /api/testing/datasets/import.",
    });
    return;
  }
  if (!getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }

  const jobId = createTestcaseGenJob({ moduleName });
  res.json({ ok: true, jobId, status: "running" });

  const body = req.body;
  setImmediate(async () => {
    try {
      let dataset = await generateTestDatasetFromDocs({
        moduleName,
        prd,
        userManual,
        description,
        sessionId,
        options: body?.options || {},
        model: body?.model,
        provider: body?.provider,
      });
      dataset = ensureRunnableScenarios(dataset);
      if (body?.save !== false) saveDataset(dataset);
      updateTestcaseGenJob(jobId, { status: "done", dataset });
    } catch (err) {
      updateTestcaseGenJob(jobId, { status: "error", error: err.message || String(err) });
    }
  });
});

app.get("/api/testing/generate-from-docs/status/:jobId", (req, res) => {
  const job = getTestcaseGenJob(String(req.params.jobId || "").trim());
  if (!job) {
    res.status(404).json({ error: "Test case generation job not found" });
    return;
  }
  res.json({
    ok: job.status === "done",
    jobId: job.id,
    status: job.status,
    moduleName: job.moduleName,
    dataset: job.dataset || null,
    error: job.error || null,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
  });
});

app.post("/api/testing/generate-from-docs", async (req, res) => {
  const moduleName = String(req.body?.moduleName || "").trim();
  const prd = String(req.body?.prd || "");
  const userManual = String(req.body?.userManual || req.body?.user_manual || "");
  const description = String(req.body?.description || "");
  const sessionId = String(req.body?.sessionId || "").trim();

  if (!moduleName) {
    res.status(400).json({ error: "moduleName is required" });
    return;
  }
  if (!prd.trim() && !userManual.trim()) {
    res.status(400).json({ error: "prd or userManual is required" });
    return;
  }
  if (isScriptFirstTestcaseBackend()) {
    res.status(400).json({
      error:
        "TESTCASE_BACKEND=scripts — import scenario JSON via POST /api/testing/datasets/import.",
    });
    return;
  }
  if (!getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }

  try {
    let dataset = await generateTestDatasetFromDocs({
      moduleName,
      prd,
      userManual,
      description,
      sessionId,
      options: req.body?.options || {},
      model: req.body?.model,
      provider: req.body?.provider,
    });
    dataset = ensureRunnableScenarios(dataset);
    if (req.body?.save !== false) saveDataset(dataset);
    res.json({ ok: true, dataset });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.get("/api/reports", async (_req, res) => {
  try {
    res.json({ ok: true, reports: await listReports() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/reports/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    res.status(400).json({ error: "q query parameter is required" });
    return;
  }
  try {
    const result = await searchReports(q);
    const retrieval = await buildRetrievalContext(result);
    res.json({ ok: true, ...result, retrieval });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/reports/:sessionId", async (req, res) => {
  try {
    const report = await getReport(req.params.sessionId);
    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }
    res.json({ ok: true, report });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

async function handleDeleteReport(sessionId, res) {
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  await deleteReport(sessionId);
  res.json({ ok: true, sessionId });
}

app.delete("/api/reports/:sessionId", async (req, res) => {
  try {
    await handleDeleteReport(String(req.params.sessionId || "").trim(), res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/reports/delete", async (req, res) => {
  try {
    await handleDeleteReport(String(req.body?.sessionId || "").trim(), res);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/reports/save", async (req, res) => {
  try {
    const report = await saveReport({
      sessionId: String(req.body?.sessionId || "").trim(),
      moduleName: String(req.body?.moduleName || "").trim(),
      description: String(req.body?.description || "").trim(),
      prd: String(req.body?.prd || ""),
      user_manual: String(req.body?.user_manual || ""),
      screenshots: Array.isArray(req.body?.screenshots) ? req.body.screenshots : [],
    });
    res.json({ ok: true, report: { sessionId: report.sessionId, moduleName: report.moduleName, cloud: report.cloud } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/docs/screenshots/start", async (req, res) => {
  const sessionId = String(req.body?.sessionId || nowSessionId()).trim();
  const moduleName = String(req.body?.moduleName || req.body?.appName || "").trim();
  const description = String(req.body?.description || "").trim();

  if (!moduleName) {
    res.status(400).json({ error: "moduleName is required" });
    return;
  }

  const jobId = createScreenshotJob({ sessionId, moduleName });
  const captureTimeout = docsCaptureTimeoutMs(req);
  const { resolveCaptureBudgetS } = require("./lib/doc-generation");
  const captureBudgetS = resolveCaptureBudgetS();
  const maxAttempts = Number(process.env.DOCS_CAPTURE_MAX_ATTEMPTS || 2);

  console.log(
    `[doc-capture] job ${jobId} timeout=${captureTimeout}ms budget=${captureBudgetS}s video=${process.env.DOCS_RECORD_VIDEO || "off"}`
  );

  res.json({ ok: true, jobId, sessionId, captureTimeoutMs: captureTimeout, captureBudgetS });

  setImmediate(async () => {
    try {
      const capture = await captureScreenshotsWithHeal(
        sessionId,
        moduleName,
        maxAttempts,
        description,
        captureTimeout
      );
      let screenshots = [];
      let videos = [];
      let captureError = null;
      if (capture.screenshots?.length) {
        screenshots = await storeScreenshotBatch(sessionId, capture.screenshots);
      }
      if (capture.videos?.length) {
        videos = await storeVideoBatch(sessionId, capture.videos);
      }
      const { filterScreenshotsForModule } = require("./lib/doc-generation");
      screenshots = filterScreenshotsForModule(moduleName, description, screenshots);
      if (!screenshots.length) {
        captureError = capture.error || capture.warning || "No screenshots captured";
      } else if (capture.warning) {
        captureError = capture.warning;
      }
      updateScreenshotJob(jobId, {
        status: "done",
        screenshots,
        videos,
        captureError,
        captureAttempts: capture.attempts,
        captureHealed: capture.healed,
      });
    } catch (err) {
      updateScreenshotJob(jobId, {
        status: "error",
        captureError: err.message,
      });
    }
  });
});

app.get("/api/docs/screenshots/status/:jobId", (req, res) => {
  const job = getScreenshotJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Screenshot job not found" });
    return;
  }
  res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    sessionId: job.sessionId,
    screenshots: job.screenshots,
    videos: job.videos || [],
    captureError: job.captureError,
    captureAttempts: job.captureAttempts,
    captureHealed: job.captureHealed,
    elapsedSeconds: Math.floor((Date.now() - job.startedAt) / 1000),
  });
});

app.post("/api/docs/generate-step", async (req, res) => {
  const step = String(req.body?.step || "").trim();
  const moduleName = String(req.body?.moduleName || req.body?.appName || "").trim();
  const sessionId = String(req.body?.sessionId || nowSessionId()).trim();

  if (!step) {
    res.status(400).json({ error: "step is required (prd | screenshots | manual)" });
    return;
  }
  if (!moduleName) {
    res.status(400).json({ error: "moduleName is required" });
    return;
  }
  if (!getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }

  try {
    const result = await generateModulePackageStep({
      step,
      sessionId,
      moduleName,
      description: String(req.body?.description || "").trim(),
      prd: String(req.body?.prd || "").trim(),
      screenshots: Array.isArray(req.body?.screenshots) ? req.body.screenshots : [],
      videos: Array.isArray(req.body?.videos) ? req.body.videos : [],
      model: req.body?.model,
      provider: req.body?.provider,
      captureScreens: req.body?.captureScreens !== false,
      backendOnly: req.body?.backendOnly === true,
    });
    res.json({ ok: true, moduleName, ...result });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.post("/api/docs/generate-module", async (req, res) => {
  const moduleName = String(req.body?.moduleName || req.body?.appName || "").trim();
  const description = String(req.body?.description || "").trim();
  const captureScreens = req.body?.captureScreens !== false;
  const backendOnly = req.body?.backendOnly === true;

  if (!moduleName) {
    res.status(400).json({ error: "moduleName is required" });
    return;
  }
  if (!getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }

  try {
    const result = await generateModulePackage({
      moduleName,
      description,
      model: req.body?.model,
      provider: req.body?.provider,
      captureScreens,
      backendOnly,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

async function loadSavedManualContext(req, userQuery) {
  const reportSessionId = String(req.body?.reportSessionId || "").trim();
  if (reportSessionId) {
    return await buildRetrievalContextForSession(reportSessionId, userQuery);
  }
  if (!userQuery.trim()) {
    return { hasContext: false, contextText: "", sources: [], screenshots: [] };
  }
  return await buildRetrievalContext(await searchReports(userQuery));
}

async function appendGithubContext(system, userQuery) {
  if (!userQuery.trim()) return system;
  try {
    const { getGithubContextText } = require("./lib/github-repo-context");
    const gh = await getGithubContextText({ query: userQuery });
    if (gh?.text) {
      return `${system}\n\n--- PANEL SOURCE CODE (public GitHub) ---\n${gh.text}\n--- end GitHub source ---`;
    }
  } catch {
    /* optional context */
  }
  return system;
}

async function buildChatContext({ req, messages, useLivePanel, preloadedBrowse, includeHealLessons = false }) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userQuery = lastUser?.content || "";
  const baseSystem =
    "You are a helpful Shipmozo operations assistant for logistics SaaS (orders, couriers, shipping).";

  let browse = { ok: false, pages: [], storedScreenshots: [], error: null };
  let system = req.body?.system || `${baseSystem} Be concise and practical.`;
  let manualRetrieval = await loadSavedManualContext(req, userQuery);
  let usedSavedManual = manualRetrieval.hasContext;

  if (useLivePanel && userQuery.trim()) {
    if (preloadedBrowse) {
      browse = preloadedBrowse;
    } else {
      try {
        browse = await browsePanelForChat(userQuery, { timeoutMs: browseTimeoutMs(req) });
      } catch (err) {
        browse = { ok: false, error: err.message, pages: [], storedScreenshots: [] };
      }
    }

    if (!req.body?.reportSessionId) {
      if (liveBrowseMatchesQuery(browse, userQuery)) {
        manualRetrieval = { hasContext: false, contextText: "", sources: [], screenshots: [] };
        usedSavedManual = false;
      } else if (!manualRetrieval.hasContext) {
        const searchResult = await searchReports(userQuery);
        if (searchResult.hits.length > 0) {
          manualRetrieval = await buildRetrievalContext(searchResult);
          usedSavedManual = manualRetrieval.hasContext;
        }
      }
    }

    system = buildHybridSystemPrompt(
      baseSystem,
      browse,
      browse.storedScreenshots || [],
      manualRetrieval
    );
    system = await appendGithubContext(system, userQuery);
    if (!browse.ok && browse.error) {
      system += `\n\nNote: live panel browse failed (${browse.error}). Use saved manual supplement if present.`;
    }
  } else if (userQuery.trim() || manualRetrieval.hasContext) {
    system = buildKnowledgeSystemPrompt(baseSystem, manualRetrieval);
    system = await appendGithubContext(system, userQuery);
  }

  if (includeHealLessons || req.body?.includeHealLessons) {
    const { formatLessonsForPrompt } = require("./lib/ai-heal-lessons");
    const maxLessons = Number(req.body?.maxHealLessons) || 12;
    const lessons = formatLessonsForPrompt({ maxLessons });
    if (lessons) system += `\n\n${lessons}`;
  }

  const allScreenshots = mergeScreenshots(
    browse.storedScreenshots,
    manualRetrieval.screenshots
  );

  return { browse, system, manualRetrieval, usedSavedManual, allScreenshots, userQuery, useLivePanel };
}

app.post("/api/ai/chat/browse", async (req, res) => {
  if (!isChatAiEnabled()) {
    res.status(403).json({
      error: getChatDisabledReason(),
      code: "AI_SCOPE_DISABLED",
      aiScope: getAiScopeStatus(),
    });
    return;
  }

  const query = String(req.body?.query || "").trim();
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  try {
    const browse = await browsePanelForChat(query, { timeoutMs: browseTimeoutMs(req) });
    res.json({ ok: browse.ok !== false, browse });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  if (!isChatAiEnabled()) {
    res.status(403).json({
      error: getChatDisabledReason(),
      code: "AI_SCOPE_DISABLED",
      aiScope: getAiScopeStatus(),
    });
    return;
  }

  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const useLivePanel = req.body?.useLivePanel === true;
  const preloadedBrowse =
    useLivePanel && req.body?.browse && typeof req.body.browse === "object"
      ? req.body.browse
      : null;

  try {
    const { browse, system, usedSavedManual, allScreenshots, manualRetrieval } =
      await buildChatContext({
        req,
        messages,
        useLivePanel,
        preloadedBrowse,
        includeHealLessons: req.body?.includeHealLessons !== false,
      });

    const chatProvider = resolveChatProvider(req.body?.provider);
    const chatModel = req.body?.model || resolveChatModel(chatProvider);

    const result = await callLLM({
      messages,
      system,
      maxTokens: Number(req.body?.maxTokens) || 4096,
      model: chatModel,
      provider: chatProvider,
    });
    const reply = appendScreenshotsIfMissing(result.text, allScreenshots);
    const screenshots = allScreenshots.map((s) => ({
      label: s.label || s.id || "Screenshot",
      url: s.url,
      id: s.id || null,
    }));

    res.json({
      reply,
      screenshots,
      model: result.model,
      usage: result.usage,
      stop_reason: result.stop_reason,
      livePanel: {
        used: useLivePanel && Boolean(browse.pages?.length || browse.storedScreenshots?.length),
        ok: browse.ok,
        sessionId: browse.sessionId,
        pageCount: browse.pages?.length || 0,
        screenshots: allScreenshots,
        error: browse.error || null,
        usedSavedManual: usedSavedManual || manualRetrieval.hasContext,
        savedManualModules: manualRetrieval.sources?.map((s) => s.moduleName) || [],
        visitedPages: browse.visited_pages || [],
        navMapPages: browse.nav_map_pages || 0,
        knowledgeMode: !useLivePanel,
        reportSessionId: String(req.body?.reportSessionId || "").trim() || null,
      },
    });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found" });
});

app.use("/cloud-images", express.static(path.join(ROOT, "output", "cloud-images")));
app.use("/test-runs", express.static(path.join(ROOT, "output", "test-runs")));
app.use((req, res, next) => {
  if (/\.(jsx?|html|css)$/i.test(req.path)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static(path.join(ROOT, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[server] unhandledRejection:", err);
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
let tunnelProc = null;

clearRuntimePublicUrl();

ensurePlaywrightBrowsersOnStartup().catch((err) => {
  console.error("[playwright] startup ensure failed:", err.message);
});

warmupReportArchive()
  .then((info) => {
    if (info.cloud) console.log(`[reports] cloud manifest loaded (${info.count} reports)`);
  })
  .catch((err) => console.warn("[reports] warmup failed:", err.message));

const server = app.listen(port, host, () => {
  const localUrl = getLocalBaseUrl();
  const renderUrl = getRenderExternalUrl();
  console.log("");
  console.log("========================================");
  console.log(" Shipmozo Dev Helper");
  console.log("========================================");
  if (isRenderDeploy()) {
    console.log(`Render URL:       ${renderUrl || localUrl}  ← public HTTPS (no Cloudflare tunnel)`);
    console.log("Cloudflare tunnel: off on Render (use Render URL above)");
  } else {
    console.log(`Local (this PC):  ${localUrl}  ← open this URL (always works)`);
    console.log("Note: Old trycloudflare.com bookmarks die after restart — do not use them.");
  }

  if (isAutoTunnelEnabled()) {
    console.log("Public tunnel:    starting cloudflared… (optional, for phone/tablet)");
    const { ensureAndStartTunnel } = require("./lib/start-tunnel");
    ensureAndStartTunnel(port, {
      onUrl: (url) => {
        console.log(`Public (all devices): ${url}`);
        console.log("");
        console.log("Share the public URL with phone/tablet. Keep this window open.");
        console.log("========================================");
        console.log("");
      },
      onLog: (text) => {
        const low = text.toLowerCase();
        if (low.includes("trycloudflare.com")) return;
        if (
          low.includes("context canceled") ||
          low.includes("control stream encountered") ||
          low.includes("failed to serve tunnel connection") ||
          low.includes("failed to run the datagram handler")
        ) {
          return;
        }
        if (low.includes("error") || low.includes("err ")) {
          console.warn("[tunnel]", text.trim().slice(0, 240));
        }
      },
    })
      .then((proc) => {
        tunnelProc = proc;
      })
      .catch((err) => {
        console.error("[tunnel] Failed to start:", err.message);
      });
  } else {
    console.log("Public tunnel:    off (PUBLIC_TUNNEL=false or Render deploy)");
    console.log("========================================");
    console.log("");
  }
});

function shutdown() {
  if (tunnelProc) {
    try {
      tunnelProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
