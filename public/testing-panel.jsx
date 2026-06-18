const { useEffect, useState, useRef, useLayoutEffect } = React;

const TESTING_KEY = window.DevHelperStorage?.KEYS?.TESTING || "shipmozo-testing-v1";
const DOCS_KEY = window.DevHelperStorage?.KEYS?.DOCS || "shipmozo-docs-v1";

const TEST_AREAS = [
  { id: "chat", label: "Chat (live panel Q&A)" },
  { id: "module_docs", label: "Module Docs (PRD + manual)" },
  { id: "screenshots", label: "Screenshot capture" },
  { id: "api", label: "REST API endpoints" },
  { id: "e2e", label: "End-to-end UI flows" },
  { id: "navigation", label: "Panel navigation map" },
];

const SCOPE_TYPES = [
  { id: "happy_path", label: "Happy path" },
  { id: "negative", label: "Errors / negative" },
  { id: "boundary", label: "Boundary / edge" },
  { id: "concurrency", label: "Concurrency" },
  { id: "performance", label: "Performance / timeout" },
  { id: "recovery", label: "Recovery / retry" },
  { id: "security", label: "Security / auth" },
];

const DEFAULT_FORM = {
  requirement: "",
  testAreas: [],
  targetModules: "",
  scopeTypes: [],
  minScenarios: 10,
  expectedOutputs: "",
  constraints: "",
  priorityFocus: "",
  includeLivePanel: true,
  includeApiCases: true,
  includeOfflineCases: true,
  qaSheetFormat: false,
  showAdvanced: false,
};

const SHEET_COLUMNS = [
  "Submodule",
  "Module",
  "TC_ID",
  "Test_Level",
  "Description",
  "Pre-requisite",
  "Steps",
  "Expected",
  "Priority",
  "Testing Type",
  "Tags",
  "Platform",
];

function loadFormState() {
  const saved = window.DevHelperStorage?.loadJson(TESTING_KEY, null);
  if (saved?.form) return { ...DEFAULT_FORM, ...saved.form };
  return DEFAULT_FORM;
}

function priorityClass(p) {
  if (p === "critical") return "badge";
  if (p === "high") return "badge";
  return "badge badge-muted";
}

function isE2ePanelScenario(s) {
  return s.category === "e2e" && (s.inputs?.e2eFlow || s.inputs?.uiAction);
}

function isOrderE2eScenario(s) {
  const flow = String(s.inputs?.e2eFlow || s.inputs?.uiAction || "");
  return flow.startsWith("order_create");
}

/** Only Rate Calculator flows use Playwright batch + MCP nav heal. */
function isRateCalculatorE2eScenario(s) {
  const flow = String(s.inputs?.e2eFlow || s.inputs?.uiAction || "");
  return flow.startsWith("rate_calculator");
}

function scriptHealLabel(aiScope) {
  return aiScope?.backends?.scriptDebug === "mcp" ? "Playwright MCP" : "OpenRouter";
}

function isPanelE2eScenario(scenario) {
  return (
    scenario?.category === "e2e" &&
    Boolean(scenario.inputs?.e2eFlow || scenario.inputs?.uiAction)
  );
}

function isPanelUiScenario(scenario) {
  if (!scenario) return false;
  if (isPanelE2eScenario(scenario)) return true;
  if (scenario.category === "screenshots") return true;
  if (scenario.category === "navigation" && scenario.inputs?.useLivePanel !== false) {
    return true;
  }
  return false;
}

function isDatasetBackendOnly(ds) {
  if (!ds) return false;
  if (ds.backendOnly || ds.options?.backendOnly || ds.sourceDocs?.backendOnly) return true;
  const blob = `${ds.sourceDocs?.moduleName || ""} ${ds.title || ""}`.toLowerCase();
  return /pincode serviceability|serviceability api|webhook|api-only|api only|backend service/.test(blob);
}
const FOLDER_UI_PAIR_COUNTS = {
  "00_Setup_And_Auth": 1,
  "01_Warehouse_APIs": 1,
  "02_Order_APIs": 1,
  "05_Utility_APIs": 2,
};

function countPairedUiFromFolders(folders = []) {
  return folders.reduce((n, f) => n + (FOLDER_UI_PAIR_COUNTS[String(f || "").trim()] || 0), 0);
}

function groupScenariosForRun(scenarios, { apiFirst = true } = {}) {
  const panelE2e = scenarios.filter(isPanelE2eScenario);
  const panelUiSteps = scenarios.filter((s) => isPanelUiScenario(s) && !isPanelE2eScenario(s));
  const apiSteps = scenarios.filter((s) => !isPanelUiScenario(s));
  const groups = [];
  if (apiFirst) {
    for (const s of apiSteps) groups.push({ type: "step", scenario: s });
    if (panelE2e.length) groups.push({ type: "e2e_batch", scenarios: panelE2e });
    for (const s of panelUiSteps) groups.push({ type: "step", scenario: s });
  } else {
    if (panelE2e.length) groups.push({ type: "e2e_batch", scenarios: panelE2e });
    for (const s of panelUiSteps) groups.push({ type: "step", scenario: s });
    for (const s of apiSteps) groups.push({ type: "step", scenario: s });
  }
  return groups;
}

async function assertTestingApiReady(requiredFeatures = []) {
  const health = await window.DevHelperApi.fetchJson("/api/health", { timeoutMs: 10000 });
  const features = health.features || [];
  const missing = requiredFeatures.filter((f) => !features.includes(f));
  if (missing.length) {
    throw new Error(
      `Server API out of date (${health.version || "unknown"}). Missing: ${missing.join(", ")}. ` +
        `Stop the old process, run npm start, open http://127.0.0.1:3000 and hard-refresh (Ctrl+Shift+R).`
    );
  }
  return health;
}

function isStopError(err) {
  return Boolean(err?.cancelled) || /stopped by user/i.test(String(err?.message || err));
}

function formatHealAttempt(a) {
  if (!a) return "";
  if (a.logLine) return a.logLine;
  const id = a.id || "strategy";
  const detail = a.query
    ? ` query="${a.query}"`
    : a.url
      ? ` ${a.url}`
      : a.label
        ? ` "${a.label}"`
        : "";
  const where = a.pageUrl ? ` → ${a.pageUrl}` : "";
  return `${a.ok ? "✓" : "✗"} ${id}${detail}${where} (${a.ms ?? "?"}ms)`;
}

function healAttemptsToLog(attempts) {
  const lines = [];
  for (const a of attempts || []) {
    lines.push(formatHealAttempt(a));
    if (a.logs?.length) {
      a.logs.forEach((sub) => lines.push(`    ${sub}`));
    }
  }
  return lines;
}

function syncLiveRunProgress(lp, cursorRef, { appendLog, setHealState, elapsedSeconds }) {
  if (!lp) return;
  const lines = lp.logLines || [];
  if (lines.length > cursorRef.current) {
    lines.slice(cursorRef.current).forEach((line) => appendLog(line));
    cursorRef.current = lines.length;
  }
  if (lp.attempts?.length || lp.phase) {
    const phase =
      lp.phase === "failed" ? "failed" : lp.phase === "done" ? "done" : "running";
    setHealState({
      phase,
      attempts: lp.attempts || [],
      log: healAttemptsToLog(lp.attempts || []),
      elapsedSeconds,
    });
  }
}

async function pollTestingJob(
  startPath,
  statusPath,
  body,
  { onTick, maxWaitMs = 600000, shouldStop, pollMs = 1000 } = {}
) {
  const start = await window.DevHelperApi.fetchJson(startPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeoutMs: 30000,
    body: JSON.stringify(body),
  });
  const jobId = start.jobId;
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    if (shouldStop?.()) {
      const err = new Error("Stopped by user");
      err.cancelled = true;
      throw err;
    }
    await new Promise((r) => setTimeout(r, pollMs));
    const status = await window.DevHelperApi.fetchJson(`${statusPath}/${jobId}`, { timeoutMs: 20000 });
    onTick?.(status);
    if (status.status === "done") return status.result;
    if (status.status === "cancelled") {
      const err = new Error(status.error || "Stopped by user");
      err.cancelled = true;
      throw err;
    }
    if (status.status === "error") throw new Error(status.error || "Job failed");
  }
  throw new Error(`Timed out after ${Math.round(maxWaitMs / 1000)}s`);
}

function TestingPanel({ configured, model, provider, onBusyChange, importDataset, onImportDatasetHandled }) {
  const [form, setForm] = useState(loadFormState);
  const [dataset, setDataset] = useState(null);
  const [savedList, setSavedList] = useState([]);
  const [activeView, setActiveView] = useState("scenarios");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [runResult, setRunResult] = useState(null);
  const [skipLive, setSkipLive] = useState(true);
  const [captureEvidence, setCaptureEvidence] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [runTarget, setRunTarget] = useState("backend");
  const [includeUiOnImport, setIncludeUiOnImport] = useState(false);
  const [frontendNotes, setFrontendNotes] = useState("");
  const [runProgress, setRunProgress] = useState("");
  const [runLog, setRunLog] = useState([]);
  const [currentScenario, setCurrentScenario] = useState(null);
  const [liveResults, setLiveResults] = useState([]);
  const [healState, setHealState] = useState(null);
  const [aiScope, setAiScope] = useState(null);
  const [importDatasetText, setImportDatasetText] = useState("");
  const [importNavText, setImportNavText] = useState("");
  const [postmanAgentRequirement, setPostmanAgentRequirement] = useState("");
  const [postmanCollectionId, setPostmanCollectionId] = useState("");
  const [postmanMode, setPostmanMode] = useState("import");
  const [postmanGroups, setPostmanGroups] = useState([]);
  const [postmanSelectedFolders, setPostmanSelectedFolders] = useState([]);
  const [postmanGroupsLoading, setPostmanGroupsLoading] = useState(false);
  const [setupStatus, setSetupStatus] = useState(null);
  const [navScriptInfo, setNavScriptInfo] = useState("");
  const summaryRef = useRef(null);
  const runControlRef = useRef({ runId: null, stop: false });
  const liveLogCursorRef = useRef(0);
  const openDatasetRef = useRef(null);

  const clearRunState = () => {
    setRunResult(null);
    setLiveResults([]);
    setRunLog([]);
    setHealState(null);
    setRunProgress("");
    setCurrentScenario(null);
    runControlRef.current = { runId: null, stop: false };
  };

  /** Only show run output that belongs to the dataset currently open in the UI. */
  const runForCurrentDataset =
    runResult && dataset && runResult.datasetId === dataset.id ? runResult : null;
  const liveForCurrentDataset =
    loading || runForCurrentDataset ? liveResults : [];

  const testcaseBackend = aiScope?.backends?.testcaseGen || "scripts";
  const scriptFirst =
    testcaseBackend === "scripts" ||
    testcaseBackend === "import" ||
    testcaseBackend === "none";

  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const toggleList = (key, id) => {
    setForm((f) => {
      const list = f[key] || [];
      return {
        ...f,
        [key]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
      };
    });
  };

  useEffect(() => {
    window.DevHelperStorage?.saveJson(TESTING_KEY, { form });
  }, [form]);

  useEffect(() => {
    onBusyChange?.(loading);
  }, [loading, onBusyChange]);

  useLayoutEffect(() => {
    if (activeView === "summary") {
      window.DevHelperMarkdown?.enhance(summaryRef.current);
    }
  }, [dataset, activeView]);

  useEffect(() => {
    window.DevHelperApi.fetchJson("/api/testing/datasets")
      .then((d) => setSavedList(d.datasets || []))
      .catch(() => {});
    window.DevHelperApi.fetchJson("/api/health", { timeoutMs: 10000 })
      .then((h) => setAiScope(h.aiScope || h.ai?.aiScope || null))
      .catch(() => {});
    window.DevHelperApi.fetchJson("/api/testing/setup", { timeoutMs: 10000 })
      .then((s) => {
        setSetupStatus(s);
        const hint = s.items?.find((i) => i.id === "postman_collection")?.hint || "";
        const m = hint.match(/POSTMAN_COLLECTION_ID=([^\s]+)/);
        if (m?.[1]) setPostmanCollectionId(m[1]);
      })
      .catch(() => {});
    window.DevHelperApi.fetchJson("/api/testing/scripts/nav", { timeoutMs: 8000 })
      .then((d) => {
        if (d.script?.navSteps?.length) {
          setNavScriptInfo(`${d.script.navSteps.length} nav step(s) on disk`);
        }
      })
      .catch(() => {});
  }, []);

  const loadPostmanGroups = async (collectionIdOverride) => {
    const cid =
      String(collectionIdOverride || postmanCollectionId || "").trim() ||
      setupStatus?.items?.find((i) => i.id === "postman_collection")?.hint?.match(
        /POSTMAN_COLLECTION_ID=(.+)$/
      )?.[1] ||
      "";
    if (!cid) return;
    setPostmanGroupsLoading(true);
    try {
      const data = await window.DevHelperApi.fetchJson(
        `/api/testing/postman/collection-groups?collectionId=${encodeURIComponent(cid)}`,
        { timeoutMs: 120000 }
      );
      setPostmanGroups(data.groups || []);
      if (!postmanCollectionId.trim()) {
        setPostmanCollectionId(data.collectionId || cid);
      }
    } catch (err) {
      setMessage(String(err.message || err));
      setMessageType("err");
    } finally {
      setPostmanGroupsLoading(false);
    }
  };

  useEffect(() => {
    if (!setupStatus) return;
    const collOk = setupStatus.items?.find((i) => i.id === "postman_collection")?.ok;
    if (collOk || postmanCollectionId.trim()) {
      loadPostmanGroups();
    }
  }, [setupStatus]);

  const togglePostmanFolder = (folderId) => {
    setPostmanSelectedFolders((prev) =>
      prev.includes(folderId) ? prev.filter((x) => x !== folderId) : [...prev, folderId]
    );
  };

  useEffect(() => {
    clearRunState();
  }, [dataset?.id]);

  const applyImportedDataset = (ds) => {
    if (!ds) return false;
    const scenarioCount = ds.scenarios?.length || ds.scenarioCount || 0;
    const sheetCount = ds.sheetRows?.length || ds.sheetRowCount || 0;
    if (!scenarioCount && !sheetCount) return false;

    clearRunState();
    setDataset(ds);
    if (isDatasetBackendOnly(ds) && runTarget === "frontend") {
      setRunTarget("backend");
    }
    if (ds.postman?.selectedFolders?.length) {
      setPostmanSelectedFolders(ds.postman.selectedFolders);
    }
    if (ds.postman?.groups?.length) {
      setPostmanGroups(ds.postman.groups);
    }
    setActiveView(sheetCount && !scenarioCount ? "google_sheet" : "scenarios");
    const from = ds.sourceDocs?.moduleName || ds.title || "docs";
    const count = sheetCount || scenarioCount;
    const kind = sheetCount ? "sheet test cases" : "scenarios";
    const groupNote = ds.postman?.selectedFolders?.length
      ? ` (${ds.postman.selectedFolders.length} API group(s))`
      : "";
    setMessage(`Loaded ${count} ${kind} from ${from}${groupNote}`);
    setMessageType("ok");
    window.DevHelperApi.fetchJson("/api/testing/datasets")
      .then((d) => setSavedList(d.datasets || []))
      .catch(() => {});
    return true;
  };

  const resolveDatasetPayload = async (dsOrId) => {
    let ds =
      typeof dsOrId === "string"
        ? (await window.DevHelperApi.fetchJson(`/api/testing/datasets/${dsOrId}`)).dataset
        : dsOrId;
    if (ds?.id && !ds.scenarios?.length && !ds.sheetRows?.length) {
      const full = await window.DevHelperApi.fetchJson(`/api/testing/datasets/${ds.id}`);
      ds = full.dataset;
    }
    return ds;
  };

  const openDataset = async (dsOrId) => {
    setLoading(true);
    setMessage("");
    try {
      const ds = await resolveDatasetPayload(dsOrId);
      if (!applyImportedDataset(ds)) {
        throw new Error("Dataset is empty or could not be loaded.");
      }
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  openDatasetRef.current = openDataset;

  useEffect(() => {
    if (!importDataset) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setMessage("");
      try {
        const ds = await resolveDatasetPayload(importDataset);
        if (cancelled) return;
        if (!applyImportedDataset(ds)) {
          throw new Error("Dataset is empty or could not be loaded.");
        }
      } catch (err) {
        if (!cancelled) {
          setMessage(String(err));
          setMessageType("err");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          onImportDatasetHandled?.();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [importDataset]);

  useEffect(() => {
    const handler = (e) => {
      const fn = openDatasetRef.current;
      if (fn) fn(e.detail?.dataset).catch(() => {});
    };
    window.addEventListener("devhelper:import-dataset", handler);
    return () => window.removeEventListener("devhelper:import-dataset", handler);
  }, []);

  const buildOptions = () => ({
    testAreas: form.testAreas,
    targetModules: form.targetModules,
    scopeTypes: form.scopeTypes,
    minScenarios: form.minScenarios,
    expectedOutputs: form.expectedOutputs,
    constraints: form.constraints,
    priorityFocus: form.priorityFocus,
    includeLivePanel: form.includeLivePanel,
    includeApiCases: form.includeApiCases,
    includeOfflineCases: form.includeOfflineCases,
    qaSheetFormat: form.qaSheetFormat === true,
  });

  const resultByScenarioId = (id) =>
    (runForCurrentDataset?.results || liveForCurrentDataset)?.find((r) => r.scenarioId === id);

  const statusBadge = (status) => {
    if (!status) return null;
    const cls =
      status === "passed" ? "status-pass" : status === "failed" ? "status-fail" : "status-skip";
    return (
      <span className={`badge ${cls}`} style={{ textTransform: "capitalize" }}>
        {status}
      </span>
    );
  };

  const appendLog = (line) => setRunLog((prev) => [...prev, line]);

  const logScenarioResult = (scenario, result) => {
    const shotNote = result.screenshots?.length
      ? ` · ${result.screenshots.length} screenshot(s)`
      : result.evidenceError
        ? ` · no screenshot (${result.evidenceError})`
        : "";
    appendLog(
      `  ${result.status === "passed" ? "✓" : result.status === "failed" ? "✗" : "○"} ${scenario.id} ${result.status}${shotNote} (${Math.round((result.durationMs || 0) / 1000)}s)`
    );
    if (result.assertions?.failures?.length) {
      result.assertions.failures.forEach((f) => appendLog(`    · ${f}`));
    }
    if (result.assertions?.skipped?.length) {
      result.assertions.skipped.slice(0, 4).forEach((s) => appendLog(`    ○ ${s}`));
      if (result.assertions.skipped.length > 4) {
        appendLog(`    ○ …and ${result.assertions.skipped.length - 4} relaxed checks`);
      }
    }
  };

  const shouldStopRun = () => Boolean(runControlRef.current.stop);

  const stopTests = async () => {
    const runId = runControlRef.current.runId;
    if (!runId || runControlRef.current.stop) return;
    runControlRef.current.stop = true;
    appendLog("■ Stop requested — closing browser and cancelling jobs…");
    setMessage("Stopping test run…");
    setMessageType("info");
    try {
      await window.DevHelperApi.fetchJson("/api/testing/run/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 15000,
        body: JSON.stringify({ runId, reason: "Stopped by user" }),
      });
    } catch (err) {
      appendLog(`  … stop signal: ${err}`);
    }
  };

  const runSingleScenario = async (scenario, runId, index, total) => {
    setCurrentScenario(scenario);
    setRunProgress(`${index} / ${total}: ${scenario.id}`);
    appendLog(`▶ ${scenario.id} — ${scenario.title}`);

    const stepStart = await window.DevHelperApi.fetchJson("/api/testing/run-step/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeoutMs: 30000,
      body: JSON.stringify({
        runId,
        scenario,
        index,
        total,
        skipLive,
        captureEvidence,
        showBrowser,
        model,
        provider,
        postmanFolders: dataset?.postman?.selectedFolders || null,
        captureEvidence: uiEvidenceEnabled,
        runTarget,
      }),
    });

    const jobId = stepStart.jobId;
    const pollMs = 2500;
    const maxWaitMs = 600000;
    const pollStarted = Date.now();
    let step = null;
    let networkFails = 0;

    while (Date.now() - pollStarted < maxWaitMs) {
      if (shouldStopRun()) {
        const err = new Error("Stopped by user");
        err.cancelled = true;
        throw err;
      }
      await new Promise((r) => setTimeout(r, pollMs));
      const sec = Math.floor((Date.now() - pollStarted) / 1000);
      setRunProgress(`${index} / ${total}: ${scenario.id} (${sec}s)`);
      try {
        const status = await window.DevHelperApi.fetchJson(
          `/api/testing/run-step/status/${jobId}`,
          { timeoutMs: 20000 }
        );
        networkFails = 0;
        if (status.status === "done") {
          step = { result: status.result };
          break;
        }
        if (status.status === "cancelled") {
          const err = new Error(status.error || "Stopped by user");
          err.cancelled = true;
          throw err;
        }
        if (status.status === "error") {
          throw new Error(status.error || "Test step failed");
        }
      } catch (pollErr) {
        if (String(pollErr).includes("Test step failed")) throw pollErr;
        const pollMsg = String(pollErr);
        if (
          pollMsg.includes("not found") ||
          pollMsg.includes("Test step job not found") ||
          pollMsg.includes("Request failed (404)")
        ) {
          throw new Error("Server restarted — re-run tests");
        }
        networkFails += 1;
        if (networkFails > 24) throw pollErr;
        appendLog(`  … reconnecting (${networkFails})`);
      }
    }

    if (!step?.result) {
      throw new Error(`Test step timed out after ${Math.round(maxWaitMs / 1000)}s`);
    }
    return step.result;
  };

  const copySheetTsv = async () => {
    if (!dataset?.sheetTsv && !dataset?.sheetRows?.length) return;
    const tsv =
      dataset.sheetTsv ||
      [SHEET_COLUMNS.join("\t")]
        .concat(
          (dataset.sheetRows || []).map((row) =>
            SHEET_COLUMNS.map((col) => String(row[col] || "").replace(/\t/g, " ").replace(/\n/g, " ")).join(
              "\t"
            )
          )
        )
        .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      setMessage("Google Sheet TSV copied — paste into sheet row 1.");
      setMessageType("ok");
    } catch {
      setMessage("Could not copy — select from Google Sheet tab manually.");
      setMessageType("err");
    }
  };

  const downloadSheetCsv = () => {
    const rows = dataset?.sheetRows || [];
    if (!rows.length) return;
    const quote = (t) => `"${String(t || "").replace(/"/g, '""').replace(/\n/g, " ")}"`;
    const csv = [
      SHEET_COLUMNS.map(quote).join(","),
      ...rows.map((row) => SHEET_COLUMNS.map((col) => quote(row[col])).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `test-cases-${dataset.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const countApiScenarios = (list) => (list || []).filter((s) => s.category === "api").length;
  const countUiScenarios = (list) => (list || []).filter(isPanelUiScenario).length;
  const effectiveUiCount = (list, folders) => {
    const inDataset = countUiScenarios(list);
    return inDataset || countPairedUiFromFolders(folders);
  };

  const filterScenariosForRunTarget = (list, target, backendOnlyDataset = false) => {
    const scenarios = list || [];
    if (target === "backend" || (backendOnlyDataset && target === "both")) {
      return scenarios.filter((s) => s.category === "api");
    }
    if (target === "frontend") return scenarios.filter(isPanelUiScenario);
    return scenarios.filter((s) => s.category === "api" || isPanelUiScenario(s));
  };

  const datasetBackendOnly = isDatasetBackendOnly(dataset);

  const uiEvidenceEnabled = runTarget === "frontend" || runTarget === "both";

  const runTests = async () => {
    if (!dataset) {
      setMessage("Import tests first.");
      setMessageType("err");
      return;
    }

    let scenarios = filterScenariosForRunTarget(dataset.scenarios || [], runTarget, datasetBackendOnly);
    let pairedUiAdded = 0;
    if (!scenarios.length && dataset.sheetRows?.length && dataset.requirement) {
      try {
        const refreshed = await window.DevHelperApi.fetchJson(`/api/testing/datasets/${dataset.id}`);
        if (refreshed.dataset?.scenarios?.length) {
          setDataset(refreshed.dataset);
          scenarios = filterScenariosForRunTarget(refreshed.dataset.scenarios, runTarget, isDatasetBackendOnly(refreshed.dataset));
          setMessage(`Built ${scenarios.length} runnable scenarios from sheet rows.`);
          setMessageType("ok");
        }
      } catch {
        /* fall through */
      }
    }
    if (!datasetBackendOnly && (runTarget === "both" || runTarget === "frontend") && countUiScenarios(scenarios) === 0) {
      const folders = dataset.postman?.selectedFolders || [];
      if (folders.length) {
        try {
          const pair = await window.DevHelperApi.fetchJson("/api/testing/frontend-scenarios/pairs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folders }),
          });
          const paired = pair.scenarios || [];
          if (paired.length) {
            pairedUiAdded = paired.length;
            scenarios = filterScenariosForRunTarget(
              [...(dataset.scenarios || []), ...paired],
              runTarget,
              datasetBackendOnly
            );
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (!scenarios.length) {
      const label = runTarget === "backend" ? "API" : runTarget === "frontend" ? "UI" : "API or UI";
      setMessage(`No ${label} scenarios in this dataset for "${runTarget}" run.`);
      setMessageType("err");
      return;
    }
    const groups = groupScenariosForRun(scenarios, { apiFirst: runTarget === "both" || runTarget === "backend" });
    const hasE2eBatch = groups.some((g) => g.type === "e2e_batch");
    const runId = `${dataset.id}_run_${Date.now()}`;
    const startedAt = new Date().toISOString();
    const results = [];
    let stepIndex = 0;

    setLoading(true);
    clearRunState();
    liveLogCursorRef.current = 0;
    setActiveView("runner");
    setMessage("Test run started…");
    setMessageType("info");
    runControlRef.current = { runId, stop: false };

    const savePartialRun = async (results, note) => {
      if (!results.length) return;
      const summary = {
        total: results.length,
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter((r) => r.status === "failed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        withScreenshots: results.filter((r) => r.screenshots?.length).length,
        durationMs: results.reduce((n, r) => n + (r.durationMs || 0), 0),
        cancelled: true,
      };
      const run = {
        runId,
        datasetId: dataset.id,
        datasetTitle: dataset.title,
        startedAt,
        finishedAt: new Date().toISOString(),
        options: { skipLive, captureEvidence: uiEvidenceEnabled, showBrowser, runTarget, cancelled: true },
        summary,
        results,
      };
      try {
        await window.DevHelperApi.fetchJson("/api/testing/run/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ run }),
        });
      } catch {
        /* ignore */
      }
      setRunResult(run);
      setActiveView("results");
      setMessage(note || `Stopped — ${summary.passed} passed · ${summary.failed} failed (partial run)`);
      setMessageType("info");
    };

    try {
      const needBatch = hasE2eBatch && !skipLive;
      await assertTestingApiReady(needBatch ? ["e2e-batch", "run-step"] : ["run-step"]);

      if (pairedUiAdded) {
        appendLog(`▶ ${pairedUiAdded} paired UI test(s) — ${runTarget === "both" ? "API first, then Playwright" : "Playwright UI"}`);
      }

      for (const group of groups) {
        if (shouldStopRun()) break;
        if (group.type === "e2e_batch") {
          const batchScenarios = group.scenarios;
          appendLog(
            `▶ E2E session (${batchScenarios.length} tests, one login) — live ${scriptHealLabel(aiScope)} + Playwright logs below`
          );
          setRunProgress(`E2E batch: 0 / ${batchScenarios.length}`);
          setHealState({ phase: "running", log: ["Waiting for batch…"], attempts: [] });

          const batch = await pollTestingJob(
            "/api/testing/e2e-batch/start",
            "/api/testing/e2e-batch/status",
            {
              runId,
              scenarios: batchScenarios,
              showBrowser: false,
              captureEvidence: uiEvidenceEnabled,
              runTarget,
              datasetTitle: dataset.title,
              model,
              provider,
            },
            {
              maxWaitMs: 600000,
              pollMs: 1000,
              shouldStop: shouldStopRun,
              onTick: (st) => {
                const lp = st.liveProgress;
                if (lp?.currentStep) {
                  setRunProgress(lp.currentStep);
                } else {
                  setRunProgress(`E2E batch… ${st.elapsedSeconds || 0}s`);
                }
                syncLiveRunProgress(lp, liveLogCursorRef, {
                  appendLog,
                  setHealState,
                  elapsedSeconds: st.elapsedSeconds,
                });
              },
            }
          );

          const streamedLive = liveLogCursorRef.current > 1;

          if (batch?.heal) {
            const h = batch.heal;
            const strat = h.script?.strategyId || "ai_script";
            const healLbl = scriptHealLabel(aiScope);
            const aiNote = h.aiGenerated
              ? ` · ${healLbl} repaired nav`
              : h.cached
                ? " · cached replay"
                : "";
            if (!streamedLive) {
              appendLog(
                `✓ Nav script${h.agentAttempts ? ` (${h.agentAttempts} attempt(s))` : ""}: ${strat}${aiNote}`
              );
              if (h.rationale) appendLog(`  Plan: ${String(h.rationale).slice(0, 200)}`);
            }
            setHealState({
              phase: h.ok === false ? "failed" : "done",
              script: h.script,
              attempts: h.attempts || [],
              log: healAttemptsToLog(h.attempts || []),
              error: h.error,
            });
          }

          if (batch?.scenarioHeal && !streamedLive) {
            const sh = batch.scenarioHeal;
            const patchedIds = (sh.patches || []).map((p) => p.scenarioId).filter(Boolean);
            if (sh.ok) {
              appendLog(
                `✓ Scenario e2eFlow heal${sh.attempts ? ` (${sh.attempts} attempt(s))` : ""}${patchedIds.length ? `: ${patchedIds.join(", ")}` : ""}`
              );
            } else if (sh.attempts) {
              appendLog(`✗ Scenario e2eFlow heal failed after ${sh.attempts} attempt(s)`);
            }
            if (sh.rationale) appendLog(`  Scenario heal: ${String(sh.rationale).slice(0, 220)}`);
            for (const p of sh.patches || []) {
              if (p.scenarioId && p.e2eFlow) {
                appendLog(`  · ${p.scenarioId} → ${p.e2eFlow}${p.reason ? ` (${p.reason})` : ""}`);
              }
            }
          }

          if (!batch?.ok && batch?.error) {
            appendLog(`  ✗ Batch warning: ${batch.error}`);
            if (batch.heal?.ok === false) {
              throw new Error(batch.error || "Navigation self-heal failed");
            }
          }

          for (const scenario of batchScenarios) {
            stepIndex += 1;
            const result =
              (batch.results || []).find((r) => r.scenarioId === scenario.id) || {
                scenarioId: scenario.id,
                title: scenario.title,
                status: "failed",
                error: batch.error || "Missing batch result",
              };
            results.push(result);
            setLiveResults([...results]);
            const steps = result.actual?.stepsRun || [];
            if (steps.length) {
              steps.forEach((line) => appendLog(`    ${line}`));
            }
            if (result.actual?.pageUrl) {
              appendLog(`    URL: ${result.actual.pageUrl}`);
            }
            if (result.actual?.error) {
              appendLog(`    Error: ${result.actual.error}`);
            }
            console.log("[TestingPanel] E2E result", scenario.id, result.status, result.actual);
            logScenarioResult(scenario, result);
          }
          setHealState(null);
          continue;
        }

        const scenario = group.scenario;
        stepIndex += 1;
        const result = await runSingleScenario(scenario, runId, stepIndex, scenarios.length);
        results.push(result);
        setLiveResults([...results]);
        logScenarioResult(scenario, result);
      }

      const summary = {
        total: results.length,
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter((r) => r.status === "failed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        withScreenshots: results.filter((r) => r.screenshots?.length).length,
        durationMs: results.reduce((n, r) => n + (r.durationMs || 0), 0),
      };

      const run = {
        runId,
        datasetId: dataset.id,
        datasetTitle: dataset.title,
        startedAt,
        finishedAt: new Date().toISOString(),
        options: { skipLive, captureEvidence, showBrowser },
        summary,
        results,
      };

      await window.DevHelperApi.fetchJson("/api/testing/run/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run }),
      });

      setRunResult(run);
      setCurrentScenario(null);
      setActiveView("results");
      setMessage(
        `Done: ${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped · ${summary.withScreenshots}/${summary.total} with screenshots`
      );
      setMessageType(summary.failed > 0 ? "info" : "ok");
    } catch (err) {
      if (isStopError(err)) {
        appendLog("■ Run stopped by user");
        await savePartialRun(results, "Test run stopped — partial results saved");
      } else {
        setMessage(String(err));
        setMessageType("err");
        appendLog(`ERROR: ${err}`);
        if (results.length) await savePartialRun(results, `Error — partial results saved (${results.length} steps)`);
      }
    } finally {
      runControlRef.current = { runId: null, stop: false };
      setLoading(false);
      setRunProgress("");
      setCurrentScenario(null);
      setHealState(null);
    }
  };

  const downloadRunJson = () => {
    if (!runForCurrentDataset) return;
    const blob = new Blob([JSON.stringify(runForCurrentDataset, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `test-run-${runForCurrentDataset.runId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const generateFromDocs = async (source) => {
    const name = String(source.moduleName || "").trim();
    const prd = source.prd || "";
    const userManual = source.userManual || source.user_manual || "";
    if (!name || (!prd && !userManual)) {
      setMessage("Module name and PRD or user manual are required.");
      setMessageType("err");
      return;
    }
    if (!configured) {
      setMessage("Configure an AI API key in API Settings first.");
      setMessageType("err");
      return;
    }

    setLoading(true);
    setMessage(`Generating test cases from ${name} documentation…`);
    setMessageType("info");
    setDataset(null);

    try {
      const data = await window.DevHelperApi.startAndPollTestcaseGen(
        {
          moduleName: name,
          prd,
          userManual,
          description: source.description || "",
          sessionId: source.sessionId || "",
          save: true,
          options: {
            minScenarios: form.minScenarios || 15,
            includeLivePanel: form.includeLivePanel,
            backendOnly: Boolean(source.backendOnly),
          },
        },
        {
          onProgress: (_st, sec) => {
            setMessage(`Generating test cases from ${name} documentation… (${sec}s)`);
          },
        }
      );
      const ds = await resolveDatasetPayload(data.dataset);
      if (!applyImportedDataset(ds)) {
        throw new Error("Generated dataset is empty.");
      }
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const generateFromBrowserDocs = () => {
    const saved = window.DevHelperStorage?.loadJson(DOCS_KEY, null);
    if (!saved?.prd && !saved?.userManual) {
      setMessage("No PRD/manual in Module Docs — generate documentation first.");
      setMessageType("err");
      return;
    }
    generateFromDocs({
      moduleName: saved.moduleName,
      prd: saved.prd,
      userManual: saved.userManual,
      description: saved.description,
      sessionId: saved.sessionId,
      backendOnly: saved.backendOnly,
    });
  };

  const runFullPipelineFromDocs = async () => {
    const saved = window.DevHelperStorage?.loadJson(DOCS_KEY, null);
    if (!saved?.prd && !saved?.userManual) {
      setMessage("No PRD/manual in Module Docs — add or generate documentation first.");
      setMessageType("err");
      return;
    }
    if (!configured) {
      setMessage("Configure an AI API key in API Settings first.");
      setMessageType("err");
      return;
    }

    setLoading(true);
    clearRunState();
    liveLogCursorRef.current = 0;
    setActiveView("runner");
    setMessage("Pipeline: generating test cases from PRD/manual, then running E2E…");
    setMessageType("info");

    try {
      await assertTestingApiReady(["e2e-batch", "run-step"]);
      const runId = `pipeline_${Date.now()}`;
      const result = await pollTestingJob(
        "/api/testing/pipeline/from-docs/start",
        "/api/testing/pipeline/from-docs/status",
        {
          runId,
          moduleName: saved.moduleName,
          prd: saved.prd,
          userManual: saved.userManual,
          description: saved.description || "",
          sessionId: saved.sessionId || "",
          showBrowser,
          captureEvidence,
          model,
          provider,
          options: {
            minScenarios: form.minScenarios || 12,
            includeLivePanel: !saved.backendOnly,
            backendOnly: Boolean(saved.backendOnly),
          },
        },
        {
          maxWaitMs: 900000,
          pollMs: 1000,
          onTick: (st) => {
            setRunProgress(st.liveProgress?.currentStep || `Pipeline… ${st.elapsedSeconds || 0}s`);
            syncLiveRunProgress(st.liveProgress, liveLogCursorRef, {
              appendLog,
              setHealState,
              elapsedSeconds: st.elapsedSeconds,
            });
          },
        }
      );

      if (result?.dataset) applyImportedDataset(result.dataset);
      const batch = result?.batch;
      if (batch?.results?.length) {
        const passed = batch.results.filter((r) => r.status === "passed").length;
        const failed = batch.results.filter((r) => r.status === "failed").length;
        setMessage(
          `Pipeline done — ${passed} passed · ${failed} failed (${result.e2eCount || batch.results.length} E2E)`
        );
        setActiveView("results");
      } else if (result?.error) {
        setMessage(result.error);
        setMessageType("err");
      } else {
        setMessage("Pipeline finished — see dataset and runner logs.");
        setMessageType("info");
      }
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const generate = async () => {
    if (!form.requirement.trim()) {
      setMessage("Describe your testing requirements in the text field.");
      setMessageType("err");
      return;
    }
    if (!configured) {
      setMessage("Configure an AI API key in API Settings first.");
      setMessageType("err");
      return;
    }

    setLoading(true);
    setMessage("Generating test dataset with AI…");
    setMessageType("info");
    setDataset(null);

    try {
      const data = await window.DevHelperApi.fetchJson("/api/testing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 180000,
        body: JSON.stringify({
          requirement: form.requirement.trim(),
          options: buildOptions(),
          model,
          provider,
          save: true,
        }),
      });
      clearRunState();
      setDataset(data.dataset);
      const templateNote =
        data.dataset?.generatedBy === "local-template"
          ? ` · ${data.dataset.creditsNote || "built-in order E2E template (no OpenRouter credits used)"}`
          : "";
      setMessage(
        `Generated ${data.dataset.scenarioCount} scenarios · saved as ${data.dataset.id}${templateNote}`
      );
      setMessageType(data.dataset?.generatedBy === "local-template" ? "info" : "ok");
      setActiveView("scenarios");
      const list = await window.DevHelperApi.fetchJson("/api/testing/datasets");
      setSavedList(list.datasets || []);
    } catch (err) {
      const text = String(err);
      setMessage(
        text.includes("API route not found")
          ? `${text} — restart the server (npm start) and hard-refresh the browser.`
          : text
      );
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const loadSaved = (id) => openDataset(id);

  const refreshSavedList = async () => {
    const list = await window.DevHelperApi.fetchJson("/api/testing/datasets");
    setSavedList(list.datasets || []);
  };

  const deleteSaved = async (id) => {
    if (!confirm("Delete this test dataset and all saved runs for it?")) return;
    setLoading(true);
    try {
      const result = await window.DevHelperApi.fetchJson("/api/testing/datasets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (dataset?.id === id) {
        setDataset(null);
        clearRunState();
        setActiveView("scenarios");
      }
      await refreshSavedList();
      const runsNote =
        result.runsRemoved > 0 ? ` (${result.runsRemoved} run${result.runsRemoved === 1 ? "" : "s"} removed)` : "";
      setMessage(`Dataset deleted${runsNote}.`);
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const deleteRun = async (runId) => {
    if (!confirm("Delete this saved test run? Screenshots and recordings will be removed.")) return;
    setLoading(true);
    try {
      await window.DevHelperApi.fetchJson("/api/testing/runs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      if (runForCurrentDataset?.runId === runId) clearRunState();
      setMessage("Test run deleted.");
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const clearRunResults = () => {
    if (!confirm("Clear run log and results from this view? (Saved run file is kept on disk.)")) return;
    clearRunState();
    setActiveView("scenarios");
    setMessage("Run results cleared from view.");
    setMessageType("info");
  };

  const downloadJson = () => {
    if (!dataset) return;
    const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `test-dataset-${dataset.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyMarkdown = async () => {
    if (!dataset?.markdownSummary) return;
    try {
      await navigator.clipboard.writeText(dataset.markdownSummary);
      setMessage("Markdown summary copied to clipboard.");
      setMessageType("ok");
    } catch {
      setMessage("Could not copy — select and copy manually from Summary tab.");
      setMessageType("err");
    }
  };

  const clearForm = () => {
    if (!confirm("Clear form and generated dataset from this view?")) return;
    setForm(DEFAULT_FORM);
    setDataset(null);
    setMessage("");
    window.DevHelperStorage?.saveJson(TESTING_KEY, { form: DEFAULT_FORM });
  };

  const importDatasetFromJson = async () => {
    const raw = importDatasetText.trim();
    if (!raw) {
      setMessage("Paste scenario dataset JSON first.");
      setMessageType("err");
      return;
    }
    setLoading(true);
    try {
      const parsed = JSON.parse(raw);
      const data = await window.DevHelperApi.fetchJson("/api/testing/datasets/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 30000,
        body: JSON.stringify({ dataset: parsed, save: true }),
      });
      applyImportedDataset(data.dataset);
      setImportDatasetText("");
    } catch (err) {
      setMessage(String(err.message || err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const parseOptionalJson = (raw, label) => {
    const t = String(raw || "").trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      throw new Error(`Invalid ${label} JSON`);
    }
  };

  const importPostmanCollectionOnly = async () => {
    const cid = postmanCollectionId.trim();
    if (!cid) {
      setMessage("Set POSTMAN_COLLECTION_ID in .env.");
      setMessageType("err");
      return;
    }
    if (!postmanSelectedFolders.length) {
      setMessage("Select at least one test group.");
      setMessageType("err");
      return;
    }
    setLoading(true);
    try {
      const data = await window.DevHelperApi.fetchJson("/api/testing/postman/import-collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 120000,
        body: JSON.stringify({
          collectionId: cid,
          folders: postmanSelectedFolders,
          frontendNotes: frontendNotes.trim() || undefined,
          save: true,
        }),
      });
      let merged = data.dataset;
      const customUiCount = (merged.scenarios || []).filter(
        (s) => s.tags?.includes("frontend-custom")
      ).length;
      if (includeUiOnImport) {
        try {
          const ui = await window.DevHelperApi.fetchJson("/api/testing/seed/rate-calculator", {
            method: "POST",
          });
          const uiScenarios = ui.dataset?.scenarios || [];
          const apiCount = (merged.scenarios || []).filter((s) => s.category === "api").length;
          const uiCount =
            (merged.scenarios || []).filter((s) => s.category === "e2e").length + uiScenarios.length;
          merged = {
            ...merged,
            scenarios: [...(merged.scenarios || []), ...uiScenarios],
            scenarioCount: (merged.scenarios?.length || 0) + uiScenarios.length,
            summary: `${apiCount} API + ${uiCount} UI scenario(s)`,
          };
          await window.DevHelperApi.fetchJson("/api/testing/scripts/nav", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              script: {
                version: 1,
                module: "Rate Calculator",
                rationale: "Ctrl+B Quick Search",
                navSteps: [
                  { op: "dismiss_overlays" },
                  { op: "hotkey", keys: "Control+b" },
                  { op: "wait", ms: 100 },
                  { op: "fill_placeholder", placeholder: "Quick Search", text: "rate calculator" },
                  { op: "click_text", text: "Rate Calculator", contains: "Tools" },
                  { op: "wait_for_text", text: "pincode", timeout_ms: 2500 },
                ],
                verifyTexts: ["origin pincode", "calculate"],
              },
            }),
          });
          setNavScriptInfo("nav script saved for UI tests");
        } catch (uiErr) {
          setMessage(
            `Imported API scenarios; Rate Calculator UI add-on skipped: ${uiErr.message || uiErr}`
          );
          setMessageType("info");
        }
      }
      const hasUi =
        includeUiOnImport ||
        customUiCount > 0 ||
        countUiScenarios(merged.scenarios) > 0;
      if (includeUiOnImport || customUiCount > 0) {
        const saved = await window.DevHelperApi.fetchJson("/api/testing/datasets/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: merged, save: true }),
        });
        merged = saved.dataset || merged;
      }
      applyImportedDataset(merged);
      setRunTarget(hasUi ? "both" : "backend");
      setMessage(`Imported ${merged.scenarios?.length || 0} scenario(s).`);
      setMessageType("ok");
    } catch (err) {
      const text = String(err.message || err);
      setMessage(
        text.includes("API route not found")
          ? `${text} — restart the server (npm start) and hard-refresh the browser.`
          : text
      );
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const runFullHybridWorkflow = async () => {
    setLoading(true);
    clearRunState();
    setActiveView("runner");
    setMessage("Hybrid pipeline: Postman API + UI scripts → Run all…");
    setMessageType("info");
    try {
      await assertTestingApiReady(["hybrid-pipeline", "e2e-batch", "run-step", "testing-setup"]);
      let e2eDataset = null;
      let navScript = null;
      try {
        e2eDataset = parseOptionalJson(importDatasetText, "E2E dataset");
        navScript = parseOptionalJson(importNavText, "nav script");
      } catch (err) {
        setMessage(err.message);
        setMessageType("err");
        setLoading(false);
        return;
      }
      if (postmanMode === "import" && !postmanCollectionId.trim() && !setupStatus?.items?.find((i) => i.id === "postman_collection")?.ok) {
        setMessage("POSTMAN_COLLECTION_ID required in .env (import mode), or switch to agent/skip.");
        setMessageType("err");
        setLoading(false);
        return;
      }
      if (postmanMode === "import" && !postmanSelectedFolders.length) {
        setMessage("Select at least one API test group before running hybrid workflow.");
        setMessageType("err");
        setLoading(false);
        return;
      }
      if (postmanMode === "agent" && !postmanAgentRequirement.trim()) {
        setMessage("Describe APIs for Postman MCP agent, or use import mode with collection ID.");
        setMessageType("err");
        setLoading(false);
        return;
      }
      if (!e2eDataset && postmanMode === "skip") {
        setMessage("Paste E2E scenario JSON or enable Postman import/agent.");
        setMessageType("err");
        setLoading(false);
        return;
      }
      const result = await pollTestingJob(
        "/api/testing/hybrid-pipeline/start",
        "/api/testing/hybrid-pipeline/status",
        {
          postmanMode,
          collectionId: postmanCollectionId.trim() || undefined,
          postmanFolders: postmanSelectedFolders,
          postmanRequirement: postmanAgentRequirement.trim() || undefined,
          e2eDataset,
          navScript,
          runTests: true,
          showBrowser,
          captureEvidence,
          skipLive,
          model,
          provider,
        },
        {
          maxWaitMs: 900000,
          shouldStop: shouldStopRun,
          onTick: (st) => {
            if (st.progress?.phase) setRunProgress(`Pipeline: ${st.progress.phase}`);
          },
        }
      );
      if (result?.dataset) applyImportedDataset(result.dataset);
      if (result?.run) {
        setRunResult(result.run);
        setActiveView("results");
      }
      const sum = result?.summary || result?.run?.summary;
      setMessage(
        result?.ok
          ? `Hybrid run passed — ${sum?.passed ?? "?"} passed, ${sum?.failed ?? 0} failed`
          : `Hybrid run finished — ${sum?.failed ?? "?"} failed. Collection: ${result?.collectionId || "—"}`
      );
      setMessageType(result?.ok ? "ok" : "err");
      window.DevHelperApi.fetchJson("/api/testing/setup").then(setSetupStatus).catch(() => {});
    } catch (err) {
      if (!isStopError(err)) {
        setMessage(String(err.message || err));
        setMessageType("err");
      }
    } finally {
      setLoading(false);
    }
  };

  const generatePostmanApiTests = async () => {
    const requirement = postmanAgentRequirement.trim();
    if (!requirement) {
      setMessage("Describe the backend APIs to test first.");
      setMessageType("err");
      return;
    }
    if (!configured) {
      setMessage("Configure an AI API key in API Settings first.");
      setMessageType("err");
      return;
    }
    setLoading(true);
    setMessage("AI is commanding Postman MCP to create collection + tests…");
    setMessageType("info");
    try {
      const data = await window.DevHelperApi.fetchJson("/api/testing/postman-agent/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 600000,
        body: JSON.stringify({
          requirement,
          options: { minScenarios: 6 },
        }),
      });
      applyImportedDataset(data.dataset);
      setPostmanAgentRequirement("");
      const coll = data.dataset?.postman?.collectionId;
      setMessage(
        coll
          ? `Created API tests — Postman collection ${coll}. Run all with API_RUN_BACKEND=postman-mcp.`
          : "Created API test dataset from Postman MCP."
      );
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err.message || err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const importNavScriptFromJson = async () => {
    const raw = importNavText.trim();
    if (!raw) {
      setMessage("Paste nav script JSON first.");
      setMessageType("err");
      return;
    }
    setLoading(true);
    try {
      const parsed = JSON.parse(raw);
      const data = await window.DevHelperApi.fetchJson("/api/testing/scripts/nav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 15000,
        body: JSON.stringify({ script: parsed }),
      });
      const n = data.script?.navSteps?.length ?? 0;
      setNavScriptInfo(`${n} nav step(s) saved → output/runtime/e2e-ai-script.json`);
      setImportNavText("");
      setMessage(`Nav script imported (${n} steps). Batch runner replays this before any AI heal.`);
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err.message || err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const loadSampleNavScript = () => {
    setImportNavText(
      JSON.stringify(
        {
          version: 1,
          module: "Rate Calculator",
          rationale: "Ctrl+B Quick Search",
          navSteps: [
            { op: "dismiss_overlays" },
            { op: "hotkey", keys: "Control+b" },
            { op: "wait", ms: 100 },
            { op: "fill_placeholder", placeholder: "Quick Search", text: "rate calculator" },
            { op: "click_text", text: "Rate Calculator", contains: "Tools" },
            { op: "wait_for_text", text: "pincode", timeout_ms: 2500 },
          ],
          verifyTexts: ["origin pincode", "calculate"],
        },
        null,
        2
      )
    );
  };

  return (
    <div>
      {healState && (
        <div className="heal-modal-backdrop" role="dialog" aria-label="Self-healing navigation">
          <div className="heal-modal card">
            <h3>Self-healing navigation ({scriptHealLabel(aiScope)})</h3>
            <p className="hint">
              Dashboard → <strong>Ctrl+B</strong> → search <em>rate calculator</em> → select{" "}
              <em>Tools → Rate Calculator</em> (sidebar fallback if search fails)
            </p>
            {healState.elapsedSeconds != null && (
              <p className="hint">Elapsed: {healState.elapsedSeconds}s</p>
            )}
            {healState.phase === "running" && (
              <div className="alert alert-info">Trying navigation strategies…</div>
            )}
            {healState.phase === "done" && (
              <div className="alert alert-success">Navigation script saved — running tests next</div>
            )}
            {healState.phase === "failed" && (
              <div className="alert alert-error">{healState.error || "Heal failed"}</div>
            )}
            <div className="run-console heal-console">
              {(healState.log || []).map((line, i) => (
                <div key={i} className="run-console-line">
                  {line}
                </div>
              ))}
            </div>
            {loading && (
              <div className="toolbar" style={{ marginTop: 12 }}>
                <button className="danger" type="button" onClick={stopTests}>
                  Stop run
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Import tests</h2>
        <p className="hint" style={{ marginTop: 4, marginBottom: 12 }}>
          Collection from <code>.env</code>. Pick groups → Import → Run below.
        </p>
        {postmanGroupsLoading && <p className="hint">Loading test groups…</p>}
        {postmanGroups.length > 0 ? (
          <div className="checkbox-grid" style={{ marginBottom: 12 }}>
            {postmanGroups.map((g) => (
              <label key={g.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={postmanSelectedFolders.includes(g.id)}
                  onChange={() => togglePostmanFolder(g.id)}
                />
                <strong>{g.label}</strong>
                <span className="hint"> ({g.requestCount})</span>
              </label>
            ))}
          </div>
        ) : (
          !postmanGroupsLoading && (
            <button className="muted" type="button" onClick={() => loadPostmanGroups()} disabled={loading}>
              Load test groups
            </button>
          )
        )}
        <label className="field" style={{ marginTop: 12 }}>
          Frontend-only tests (no API) — one per line
        </label>
        <textarea
          value={frontendNotes}
          onChange={(e) => setFrontendNotes(e.target.value)}
          placeholder={`Shopify integration — verify connection status badge\nNew Orders — filter by today\nChannels — open integration settings`}
          style={{ minHeight: 88, fontFamily: "inherit", fontSize: 13 }}
        />
        <label className="checkbox-row" style={{ margin: "12px 0" }}>
          <input
            type="checkbox"
            checked={includeUiOnImport}
            onChange={(e) => setIncludeUiOnImport(e.target.checked)}
          />
          Also include sample Rate Calculator UI tests
        </label>
        <button
          className="primary"
          type="button"
          onClick={importPostmanCollectionOnly}
          disabled={loading || !postmanSelectedFolders.length}
        >
          Import
        </button>
      </div>

      {!scriptFirst && (
      <div className="card">
        <div className="card-header">
          <div>
            <h2>From PRD + user manual</h2>
            <p className="hint" style={{ marginTop: 4 }}>
              Optional AI path: LLM reads PRD/manual → test cases → E2E run (set TESTCASE_BACKEND=docs or docs-mcp)
            </p>
          </div>
        </div>
        <div className="toolbar">
          <button className="primary" onClick={generateFromBrowserDocs} disabled={loading || !configured}>
            {loading && message.includes("documentation") ? "Generating…" : "Generate test cases"}
          </button>
          <button
            className="primary"
            onClick={runFullPipelineFromDocs}
            disabled={loading || !configured}
            title="Generate from Module Docs draft then run all E2E scenarios"
          >
            {loading && message.includes("Pipeline") ? "Pipeline running…" : "Generate + Run all E2E"}
          </button>
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          Paste or generate PRD + manual in <strong>Module Docs</strong> first.
        </p>
      </div>
      )}

      {!scriptFirst && (
      <div className="card">
        <div className="card-header">
          <div>
            <h2>Testing requirements</h2>
            <p className="hint" style={{ marginTop: 4 }}>
              Describe what to test in plain text — AI builds a full scenario dataset
            </p>
          </div>
        </div>

        <label className="field">Your requirement *</label>
        <textarea
          value={form.requirement}
          onChange={(e) => setField("requirement", e.target.value)}
          placeholder={`Example:\nTest Chat and Module Docs for Billing, Quick Add, and Shopify Integration.\nInclude missing API key, empty module name, 0 screenshots, and running Chat + Docs at the same time.\nExpect at least 1 screenshot and numbered steps in the user manual.`}
          style={{ minHeight: 140 }}
        />

        <button
          type="button"
          className="muted"
          style={{ marginTop: 12 }}
          onClick={() => setField("showAdvanced", !form.showAdvanced)}
        >
          {form.showAdvanced ? "Hide optional fields" : "Show optional fields (precision)"}
        </button>

        {form.showAdvanced && (
          <div className="advanced-fields" style={{ marginTop: 14 }}>
            <label className="field">Test areas</label>
            <div className="checkbox-grid">
              {TEST_AREAS.map((a) => (
                <label key={a.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.testAreas.includes(a.id)}
                    onChange={() => toggleList("testAreas", a.id)}
                    disabled={a.id === "chat" && aiScope && !aiScope.chatEnabled}
                  />
                  {a.label}
                  {a.id === "chat" && aiScope && !aiScope.chatEnabled && (
                    <span className="hint">
                      {" "}
                      (disabled — add <code>chat</code> to <code>AI_SCOPE</code> in .env)
                    </span>
                  )}
                </label>
              ))}
            </div>

            <label className="field">Scope types</label>
            <div className="checkbox-grid">
              {SCOPE_TYPES.map((s) => (
                <label key={s.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.scopeTypes.includes(s.id)}
                    onChange={() => toggleList("scopeTypes", s.id)}
                  />
                  {s.label}
                </label>
              ))}
            </div>

            <label className="field">Target modules (optional)</label>
            <input
              type="text"
              value={form.targetModules}
              onChange={(e) => setField("targetModules", e.target.value)}
              placeholder="Billing, Quick Add, Shopify, New Orders…"
            />

            <div className="settings-grid">
              <div>
                <label className="field">Min scenarios</label>
                <input
                  type="number"
                  min={5}
                  max={80}
                  value={form.minScenarios}
                  onChange={(e) => setField("minScenarios", Number(e.target.value) || 15)}
                />
              </div>
              <div>
                <label className="field">Priority focus</label>
                <input
                  type="text"
                  value={form.priorityFocus}
                  onChange={(e) => setField("priorityFocus", e.target.value)}
                  placeholder="e.g. billing flows, screenshot reliability"
                />
              </div>
            </div>

            <label className="field">Expected outputs (optional)</label>
            <textarea
              value={form.expectedOutputs}
              onChange={(e) => setField("expectedOutputs", e.target.value)}
              placeholder="e.g. Chat replies must embed markdown images; PRD must have System Architecture section…"
              style={{ minHeight: 56 }}
            />

            <label className="field">Constraints (optional)</label>
            <textarea
              value={form.constraints}
              onChange={(e) => setField("constraints", e.target.value)}
              placeholder="e.g. max 2 min per live browse; use HEADLESS=true; no concurrent Python jobs…"
              style={{ minHeight: 56 }}
            />

            <label className="field">Include case types</label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.includeLivePanel}
                onChange={(e) => setField("includeLivePanel", e.target.checked)}
              />
              Live panel (Playwright + SHIPMOZO credentials)
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.includeApiCases}
                onChange={(e) => setField("includeApiCases", e.target.checked)}
              />
              REST API cases
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.includeOfflineCases}
                onChange={(e) => setField("includeOfflineCases", e.target.checked)}
              />
              Offline / mock / missing-config cases
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.qaSheetFormat === true}
                onChange={(e) => setField("qaSheetFormat", e.target.checked)}
              />
              Google Sheet QA format (flow-based TCs: Component → Integration → E2E)
            </label>
          </div>
        )}

        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="primary" onClick={generate} disabled={loading}>
            {loading ? "Generating…" : "Generate test dataset"}
          </button>
          <button className="muted" onClick={clearForm} disabled={loading}>
            Clear
          </button>
        </div>
        {aiScope && (
          <p className="hint" style={{ marginTop: 10 }}>
            {aiScope.limitedMessage}
            {aiScope.backends?.scriptDebug === "mcp" &&
              " Self-heal: Playwright MCP (nav + scenario e2eFlow on failure — no OpenRouter)."}
            {aiScope.backends?.scriptDebug === "llm" &&
              " Self-heal: OpenRouter LLM on nav/scenario failure."}
            {(aiScope.backends?.testcaseGen === "scripts" ||
              aiScope.backends?.testcaseGen === "import" ||
              aiScope.backends?.testcaseGen === "none") &&
              " Test cases: import your scripts — no AI generation."}
            {aiScope.backends?.testcaseGen === "docs-mcp" && " Test cases: PRD/manual + Playwright MCP."}
            {(aiScope.backends?.testcaseGen === "docs" ||
              aiScope.backends?.testcaseGen === "docs-llm") &&
              " Test cases: single LLM pass from PRD/manual."}
            {(aiScope.backends?.testcaseGen === "postman-mcp" ||
              aiScope.backends?.testcaseGen === "postman-agent") &&
              " Test cases: AI creates Postman collection via MCP."}
            {aiScope.backends?.testcaseGen === "postman" && " Test cases: read existing Postman collection."}
            {aiScope.backends?.testcaseGenLabel && ` (${aiScope.backends.testcaseGenLabel})`}
            {!aiScope.chatEnabled && " Chat scenarios are skipped during test runs."}
          </p>
        )}
      </div>
      )}

      {message && (
        <div
          className={`alert alert-${
            messageType === "ok" ? "success" : messageType === "err" ? "error" : "info"
          }`}
        >
          {message}
        </div>
      )}

      {savedList.length > 0 && (
        <details className="card" style={{ marginBottom: 12 }} open={savedList.length <= 3}>
          <summary className="hint" style={{ cursor: "pointer" }}>
            Saved test datasets ({savedList.length})
          </summary>
          <ul className="report-list" style={{ marginTop: 8 }}>
            {savedList.map((d) => (
              <li key={d.id} className="report-item">
                <div className="report-item-info">
                  <div className="report-item-title">{d.title}</div>
                  <div className="report-item-meta">
                    {d.scenarioCount} scenarios
                    {dataset?.id === d.id ? " · open" : ""}
                  </div>
                </div>
                <div className="report-item-actions">
                  <button
                    type="button"
                    className="muted"
                    onClick={() => loadSaved(d.id)}
                    disabled={loading}
                  >
                    Open
                  </button>
                  <button className="danger" onClick={() => deleteSaved(d.id)} disabled={loading}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {dataset && (
        <div className="card">
          <div className="card-header">
            <div>
              <h2>{dataset.title}</h2>
              <p className="hint" style={{ marginTop: 4 }}>
                {dataset.summary}
              </p>
              {dataset.sourceDocs?.moduleName && (
                <p className="hint" style={{ marginTop: 4 }}>
                  Source: PRD + manual for <strong>{dataset.sourceDocs.moduleName}</strong>
                  {dataset.sourceDocs.sessionId ? ` · ${dataset.sourceDocs.sessionId}` : ""}
                  {datasetBackendOnly ? " · backend/API only" : ""}
                </p>
              )}
            </div>
            <div className="toolbar" style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span className="hint" style={{ marginRight: 4 }}>
                Run:
              </span>
              {[
                {
                  id: "backend",
                  label: `Backend (${countApiScenarios(dataset.scenarios)})`,
                },
                ...(!datasetBackendOnly
                  ? [
                      {
                        id: "frontend",
                        label: `Frontend (${effectiveUiCount(dataset.scenarios, dataset.postman?.selectedFolders)})`,
                      },
                    ]
                  : []),
                {
                  id: "both",
                  label: datasetBackendOnly
                    ? `Both (${countApiScenarios(dataset.scenarios)})`
                    : `Both (${
                        countApiScenarios(dataset.scenarios) +
                        effectiveUiCount(dataset.scenarios, dataset.postman?.selectedFolders)
                      })`,
                },
              ].map((opt) => (
                <label key={opt.id} className="checkbox-row" style={{ marginRight: 8 }}>
                  <input
                    type="radio"
                    name="runTarget"
                    checked={runTarget === opt.id}
                    onChange={() => setRunTarget(opt.id)}
                    disabled={loading}
                  />
                  {opt.label}
                </label>
              ))}
              <button className="primary" onClick={runTests} disabled={loading}>
                {loading && runProgress ? runProgress : loading ? "Running…" : "Run"}
              </button>
              {loading && (
                <button className="danger" onClick={stopTests} type="button">
                  Stop
                </button>
              )}
              <button
                className="danger"
                type="button"
                onClick={() => deleteSaved(dataset.id)}
                disabled={loading}
                title="Remove dataset and all saved runs"
              >
                Delete dataset
              </button>
            </div>
          </div>

          <p className="hint" style={{ marginTop: 8 }}>
            {datasetBackendOnly
              ? "Backend-only service — API scenarios only (no panel UI runs)."
              : "Backend = API only. Frontend / Both = screenshots + screen recording (headless). API ~1 min/group · UI ~1–3 min/test."}
          </p>

          {(runForCurrentDataset || liveForCurrentDataset.length > 0) && (
            <div className="toolbar" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
              <button className="muted" type="button" onClick={clearRunResults} disabled={loading}>
                Clear results
              </button>
              {runForCurrentDataset && (
                <>
                  <button className="muted" type="button" onClick={downloadRunJson} disabled={loading}>
                    Download run JSON
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={() => deleteRun(runForCurrentDataset.runId)}
                    disabled={loading}
                  >
                    Delete run
                  </button>
                </>
              )}
            </div>
          )}

          {(runForCurrentDataset || liveForCurrentDataset.length > 0) && (
            <div className="run-summary">
              {(() => {
                const s =
                  runForCurrentDataset?.summary || {
                    passed: liveForCurrentDataset.filter((r) => r.status === "passed").length,
                    failed: liveForCurrentDataset.filter((r) => r.status === "failed").length,
                    skipped: liveForCurrentDataset.filter((r) => r.status === "skipped").length,
                    withScreenshots: liveForCurrentDataset.filter((r) => r.screenshots?.length).length,
                    total: liveForCurrentDataset.length,
                    durationMs: liveForCurrentDataset.reduce((n, r) => n + (r.durationMs || 0), 0),
                  };
                return (
                  <>
                    <div className="stat">
                      <strong>{s.passed}</strong>
                      Passed
                    </div>
                    <div className="stat">
                      <strong>{s.failed}</strong>
                      Failed
                    </div>
                    <div className="stat">
                      <strong>{s.skipped}</strong>
                      Skipped
                    </div>
                    <div className="stat">
                      <strong>{s.withScreenshots ?? 0}</strong>
                      With screenshots
                    </div>
                    <div className="stat">
                      <strong>{Math.round((s.durationMs || 0) / 1000)}s</strong>
                      Total time
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {(loading || runLog.length > 0 || runForCurrentDataset || liveForCurrentDataset.length > 0) && (
            <div className="nav-tabs" style={{ marginTop: 14, marginBottom: 14 }}>
              <button
                type="button"
                className={activeView === "runner" ? "active" : ""}
                onClick={() => setActiveView("runner")}
              >
                Log{loading ? "…" : ""}
              </button>
              <button
                type="button"
                className={activeView === "results" ? "active" : ""}
                onClick={() => setActiveView("results")}
              >
                Results
                {runForCurrentDataset
                  ? ` (${runForCurrentDataset.summary.passed}/${runForCurrentDataset.summary.total})`
                  : liveForCurrentDataset.length
                    ? ` (${liveForCurrentDataset.length})`
                    : ""}
              </button>
            </div>
          )}

          {activeView === "google_sheet" && dataset.sheetRows?.length > 0 && (
            <div>
              <p className="hint" style={{ marginBottom: 12 }}>
                Paste into Google Sheets starting at cell A1. Column order matches your QA template.
              </p>
              <div className="toolbar" style={{ marginBottom: 12 }}>
                <button className="primary" onClick={copySheetTsv}>
                  Copy TSV for Google Sheets
                </button>
                <button className="muted" onClick={downloadSheetCsv}>
                  Download CSV
                </button>
              </div>
              <div className="sheet-table-wrap">
                <table className="sheet-table">
                  <thead>
                    <tr>
                      {SHEET_COLUMNS.map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataset.sheetRows.map((row, idx) => (
                      <tr key={row.TC_ID || idx}>
                        {SHEET_COLUMNS.map((col) => (
                          <td key={col}>{row[col]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(activeView === "scenarios" || !loading) && (
            <details className="scenario-list" style={{ marginTop: 12 }}>
              <summary className="hint" style={{ cursor: "pointer" }}>
                Scenario list ({(dataset.scenarios || []).length})
              </summary>
              {(dataset.scenarios || []).map((s) => {
                const result = resultByScenarioId(s.id);
                return (
                <details key={s.id} className="scenario-card">
                  <summary>
                    <span className="scenario-id">{s.id}</span>
                    <span className="scenario-title">{s.title}</span>
                    {result && statusBadge(result.status)}
                    <span className={priorityClass(s.priority)}>{s.priority}</span>
                    <span className="badge badge-muted">{s.category}</span>
                    <span className="badge badge-muted">{s.type}</span>
                  </summary>
                  <div className="scenario-body">
                    {s.module && (
                      <p className="hint">
                        Module: <strong>{s.module}</strong>
                      </p>
                    )}
                    <p>{s.description}</p>
                    {s.preconditions?.length > 0 && (
                      <>
                        <strong>Preconditions</strong>
                        <ul>
                          {s.preconditions.map((p, i) => (
                            <li key={i}>{p}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {s.inputs && (
                      <>
                        <strong>Inputs</strong>
                        <pre className="scenario-pre">
                          {JSON.stringify(s.inputs, null, 2)}
                        </pre>
                      </>
                    )}
                    {s.steps?.length > 0 && (
                      <>
                        <strong>Steps</strong>
                        <ol>
                          {s.steps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ol>
                      </>
                    )}
                    {s.expectedResults && (
                      <>
                        <strong>Expected results</strong>
                        <pre className="scenario-pre">
                          {JSON.stringify(s.expectedResults, null, 2)}
                        </pre>
                      </>
                    )}
                    {result?.screenshots?.length > 0 && (
                      <div className="screens-grid" style={{ marginTop: 10 }}>
                        {result.screenshots.map((s) => (
                          <figure key={s.id || s.url}>
                            <img src={s.url} alt={s.label} />
                            <figcaption>{s.label}</figcaption>
                          </figure>
                        ))}
                      </div>
                    )}
                    {result && (
                      <>
                        <strong>Run result ({result.status})</strong>
                        {result.reason && <p className="hint">{result.reason}</p>}
                    {result.assertions?.failures?.length > 0 && (
                      <ul>
                        {result.assertions.failures.map((f, i) => (
                          <li key={i} style={{ color: "var(--error)" }}>{f}</li>
                        ))}
                      </ul>
                    )}
                    {result.assertions?.skipped?.length > 0 && (
                      <ul>
                        {result.assertions.skipped.map((s, i) => (
                          <li key={i} className="hint">{s}</li>
                        ))}
                      </ul>
                    )}
                        {result.actual && (
                          <pre className="scenario-pre">{JSON.stringify(result.actual, null, 2)}</pre>
                        )}
                        {result.error && <p className="hint" style={{ color: "var(--error)" }}>{result.error}</p>}
                      </>
                    )}
                  </div>
                </details>
              );
              })}
            </details>
          )}

          {activeView === "runner" && (loading || runLog.length > 0) && (
            <div>
              {runProgress && dataset && (
                <div className="run-progress-bar">
                  <div
                    className="run-progress-fill"
                    style={{
                      width: `${(liveForCurrentDataset.length / Math.max(dataset.scenarios.length, 1)) * 100}%`,
                    }}
                  />
                </div>
              )}
              {runProgress && (
                <div className="alert alert-info" style={{ marginBottom: 12 }}>
                  <strong>Running:</strong> {runProgress}
                  {currentScenario && (
                    <div className="hint" style={{ marginTop: 4 }}>
                      {currentScenario.title} ({currentScenario.category})
                    </div>
                  )}
                </div>
              )}
              <div className="run-console">
                {runLog.map((line, i) => (
                  <div key={i} className="run-console-line">
                    {line}
                  </div>
                ))}
              </div>
              {liveForCurrentDataset.length > 0 && (
                <div className="screens-grid" style={{ marginTop: 14 }}>
                  {liveForCurrentDataset
                    .filter((r) => r.screenshots?.length)
                    .flatMap((r) =>
                      r.screenshots.map((s) => (
                        <figure key={`${r.scenarioId}-${s.id || s.url}`}>
                          <img src={s.url} alt={s.label} />
                          <figcaption>
                            {r.scenarioId}: {s.label}
                          </figcaption>
                        </figure>
                      ))
                    )}
                </div>
              )}
            </div>
          )}

          {activeView === "results" && (runForCurrentDataset || liveForCurrentDataset.length > 0) && (
            <div className="scenario-list">
              {(runForCurrentDataset?.results || liveForCurrentDataset).map((r) => (
                <div key={r.scenarioId} className={`result-row ${r.status}`}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong>{r.scenarioId}</strong> — {r.title}
                      <div className="hint">
                        {r.category} · {r.type} · {Math.round((r.durationMs || 0) / 1000)}s
                        {r.screenshots?.length ? ` · ${r.screenshots.length} screenshot(s)` : ""}
                        {r.video?.url ? " · recording" : ""}
                      </div>
                    </div>
                    {statusBadge(r.status)}
                  </div>
                  {r.video?.url && (
                    <video
                      controls
                      style={{ display: "block", maxWidth: "100%", marginTop: 10 }}
                      src={r.video.url}
                    />
                  )}
                  {r.screenshots?.length > 0 && (
                    <div className="screens-grid" style={{ marginTop: 10 }}>
                      {r.screenshots.map((s) => (
                        <figure key={s.id || s.url}>
                          <img src={s.url} alt={s.label} />
                          <figcaption>{s.label}</figcaption>
                        </figure>
                      ))}
                    </div>
                  )}
                  {r.evidenceError && !r.screenshots?.length && (
                    <p className="hint" style={{ color: "var(--warning)" }}>
                      Screenshot failed: {r.evidenceError}
                    </p>
                  )}
                  {r.reason && <p className="hint">{r.reason}</p>}
                  {r.assertions?.failures?.length > 0 && (
                    <ul style={{ margin: "8px 0", color: "var(--error)" }}>
                      {r.assertions.failures.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  )}
                  {r.assertions?.skipped?.length > 0 && (
                    <ul style={{ margin: "8px 0", color: "var(--text-muted)", fontSize: 12 }}>
                      {r.assertions.skipped.map((s, i) => (
                        <li key={i}>○ {s}</li>
                      ))}
                    </ul>
                  )}
                  {r.actual && (
                    <pre className="scenario-pre" style={{ marginTop: 8 }}>
                      {JSON.stringify(r.actual, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeView === "summary" && (
            <article
              ref={summaryRef}
              className="markdown-body"
              dangerouslySetInnerHTML={{
                __html:
                  window.DevHelperMarkdown?.parse(dataset.markdownSummary || "") ||
                  marked.parse(dataset.markdownSummary || "_No summary generated_"),
              }}
            />
          )}

          {activeView === "json" && (
            <pre className="scenario-pre scenario-pre-large">
              {JSON.stringify(dataset, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
