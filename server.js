const express = require("express");
const fs = require("fs");
const path = require("path");
const { getConfigStatus, saveConfig, clearStoredApiKey } = require("./lib/ai-config");
const { callLLM, testConnection } = require("./lib/llm");
const {
  generateModulePackage,
  generateModulePackageStep,
  nowSessionId,
  EXAMPLE_SOURCES,
  getReportExamplesContext,
} = require("./lib/doc-generation");
const { CLOUD_ROOT } = require("./lib/image-storage");
const { saveReport, listReports, getReport, deleteReport } = require("./lib/report-archive");
const {
  searchReports,
  buildRetrievalContext,
  buildHybridSystemPrompt,
  liveBrowseMatchesQuery,
} = require("./lib/report-retrieval");
const {
  browsePanelForChat,
  appendScreenshotsIfMissing,
  mergeScreenshots,
} = require("./lib/panel-browse");
const { loadNavigationMap, getNavigationMapPath } = require("./lib/panel-navigation");
const { clearAllAppData } = require("./lib/clear-app-data");
const { runPythonScript } = require("./lib/spawn-python");
const { generateTestDataset, TEST_AREAS, SCOPE_TYPES } = require("./lib/test-dataset-generation");
const {
  saveDataset,
  getDataset,
  listDatasets,
  deleteDataset,
} = require("./lib/test-dataset-store");
const { runTestDataset, runTestStep } = require("./lib/test-dataset-runner");
const { getRun, listRuns, saveRun } = require("./lib/test-run-store");

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

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: "dev-helper-v5",
    features: ["chat", "module-docs", "test-dataset", "test-run", "reports"],
    ai: getConfigStatus(),
    cloudinary: cloudinaryConfigured(),
    imageStorage: process.env.IMAGE_STORAGE || "local",
  });
});

app.get("/api/ai/config", (_req, res) => {
  res.json(getConfigStatus());
});

app.post("/api/ai/config", (req, res) => {
  const apiKey = req.body?.apiKey;
  const model = req.body?.model;
  const provider = req.body?.provider;
  if (apiKey === undefined && model === undefined && provider === undefined) {
    res.status(400).json({ error: "Provide provider, apiKey, and/or model" });
    return;
  }
  res.json(saveConfig({ apiKey, model, provider }));
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

app.post("/api/app/clear-data", (_req, res) => {
  try {
    res.json(clearAllAppData());
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

app.get("/api/testing/meta", (_req, res) => {
  res.json({
    ok: true,
    testAreas: TEST_AREAS,
    scopeTypes: SCOPE_TYPES,
    navPageCount: loadNavigationMap().pageCount || 0,
  });
});

app.get("/api/testing/datasets", (_req, res) => {
  res.json({ ok: true, datasets: listDatasets() });
});

app.get("/api/testing/datasets/:id", (req, res) => {
  const dataset = getDataset(String(req.params.id || "").trim());
  if (!dataset) {
    res.status(404).json({ error: "Test dataset not found" });
    return;
  }
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

app.post("/api/testing/run-step", async (req, res) => {
  const scenario = req.body?.scenario;
  if (!scenario?.id) {
    res.status(400).json({ error: "scenario with id is required" });
    return;
  }

  const runId = String(req.body?.runId || nowSessionId()).trim();

  try {
    const result = await runTestStep({
      runId,
      scenario,
      skipLive: req.body?.skipLive === true,
      captureEvidence: req.body?.captureEvidence !== false,
      model: req.body?.model,
      provider: req.body?.provider,
    });
    res.json({
      ok: true,
      runId,
      result,
      index: Number(req.body?.index) || 0,
      total: Number(req.body?.total) || 0,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
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
  if (!getConfigStatus().configured) {
    res.status(400).json({ error: "AI API key is not configured" });
    return;
  }

  try {
    const dataset = await generateTestDataset({
      requirement,
      options: req.body?.options || {},
      model: req.body?.model,
      provider: req.body?.provider,
    });
    if (req.body?.save !== false) saveDataset(dataset);
    res.json({ ok: true, dataset });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.get("/api/reports", (_req, res) => {
  res.json({ ok: true, reports: listReports() });
});

app.get("/api/reports/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) {
    res.status(400).json({ error: "q query parameter is required" });
    return;
  }
  const result = searchReports(q);
  const retrieval = buildRetrievalContext(result);
  res.json({ ok: true, ...result, retrieval });
});

app.get("/api/reports/:sessionId", (req, res) => {
  const report = getReport(req.params.sessionId);
  if (!report) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  res.json({ ok: true, report });
});

function handleDeleteReport(sessionId, res) {
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  deleteReport(sessionId);
  res.json({ ok: true, sessionId });
}

app.delete("/api/reports/:sessionId", (req, res) => {
  handleDeleteReport(String(req.params.sessionId || "").trim(), res);
});

app.post("/api/reports/delete", (req, res) => {
  handleDeleteReport(String(req.body?.sessionId || "").trim(), res);
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
      model: req.body?.model,
      provider: req.body?.provider,
      captureScreens: req.body?.captureScreens !== false,
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
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.code === "NO_API_KEY" ? 400 : 502).json({ error: err.message });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) {
    res.status(400).json({ error: "messages array is required" });
    return;
  }

  const useLivePanel = req.body?.useLivePanel !== false;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userQuery = lastUser?.content || "";

  const baseSystem =
    "You are a helpful Shipmozo operations assistant for logistics SaaS (orders, couriers, shipping).";

  let browse = { ok: false, pages: [], storedScreenshots: [], error: null };
  let system = req.body?.system || `${baseSystem} Be concise and practical.`;

  let manualRetrieval = { hasContext: false, contextText: "", sources: [], screenshots: [] };
  let usedSavedManual = false;

  if (useLivePanel && userQuery.trim()) {
    try {
      browse = await browsePanelForChat(userQuery);
    } catch (err) {
      browse = { ok: false, error: err.message, pages: [], storedScreenshots: [] };
    }

    const searchResult = searchReports(userQuery);
    if (searchResult.hits.length > 0 && !liveBrowseMatchesQuery(browse, userQuery)) {
      manualRetrieval = buildRetrievalContext(searchResult);
      usedSavedManual = manualRetrieval.hasContext;
    }

    system = buildHybridSystemPrompt(
      baseSystem,
      browse,
      browse.storedScreenshots,
      manualRetrieval
    );
    if (!browse.ok && browse.error) {
      system += `\n\nNote: live panel browse failed (${browse.error}). Use saved manual supplement if present.`;
    }
  }

  const allScreenshots = mergeScreenshots(
    browse.storedScreenshots,
    manualRetrieval.screenshots
  );

  try {
    const result = await callLLM({
      messages,
      system,
      maxTokens: Number(req.body?.maxTokens) || 4096,
      model: req.body?.model,
      provider: req.body?.provider,
    });
    const reply = appendScreenshotsIfMissing(result.text, allScreenshots);

    res.json({
      reply,
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
        usedSavedManual,
        savedManualModules: manualRetrieval.sources?.map((s) => s.moduleName) || [],
        visitedPages: browse.visited_pages || [],
        navMapPages: browse.nav_map_pages || 0,
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
app.listen(port, host, () => {
  console.log(`Dev Helper AI running on http://127.0.0.1:${port}`);
});
