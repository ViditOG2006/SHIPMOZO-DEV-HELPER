const { useEffect, useState, useRef, useLayoutEffect } = React;

const TESTING_KEY = window.DevHelperStorage?.KEYS?.TESTING || "shipmozo-testing-v1";

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
  showAdvanced: false,
};

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

function TestingPanel({ configured, model, provider, onBusyChange }) {
  const [form, setForm] = useState(loadFormState);
  const [dataset, setDataset] = useState(null);
  const [savedList, setSavedList] = useState([]);
  const [activeView, setActiveView] = useState("scenarios");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [runResult, setRunResult] = useState(null);
  const [skipLive, setSkipLive] = useState(false);
  const [captureEvidence, setCaptureEvidence] = useState(true);
  const [runProgress, setRunProgress] = useState("");
  const [runLog, setRunLog] = useState([]);
  const [currentScenario, setCurrentScenario] = useState(null);
  const [liveResults, setLiveResults] = useState([]);
  const summaryRef = useRef(null);

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
  });

  const resultByScenarioId = (id) =>
    (runResult?.results || liveResults)?.find((r) => r.scenarioId === id);

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

  const runTests = async () => {
    if (!dataset?.scenarios?.length) {
      setMessage("Generate or open a dataset first.");
      setMessageType("err");
      return;
    }

    const scenarios = dataset.scenarios;
    const runId = `${dataset.id}_run_${Date.now()}`;
    const startedAt = new Date().toISOString();
    const results = [];

    setLoading(true);
    setRunResult(null);
    setLiveResults([]);
    setRunLog([]);
    setCurrentScenario(null);
    setActiveView("runner");
    setMessage("Test run started — executing scenarios one by one…");
    setMessageType("info");

    try {
      for (let i = 0; i < scenarios.length; i += 1) {
        const scenario = scenarios[i];
        setCurrentScenario(scenario);
        setRunProgress(`${i + 1} / ${scenarios.length}: ${scenario.id}`);
        appendLog(`▶ ${scenario.id} — ${scenario.title}`);

        const step = await window.DevHelperApi.fetchJson("/api/testing/run-step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeoutMs: 600000,
          body: JSON.stringify({
            runId,
            scenario,
            index: i + 1,
            total: scenarios.length,
            skipLive,
            captureEvidence,
            model,
            provider,
          }),
        });

        const result = step.result;
        results.push(result);
        setLiveResults([...results]);

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
        options: { skipLive, captureEvidence },
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
      setMessage(String(err));
      setMessageType("err");
      appendLog(`ERROR: ${err}`);
    } finally {
      setLoading(false);
      setRunProgress("");
      setCurrentScenario(null);
    }
  };

  const downloadRunJson = () => {
    if (!runResult) return;
    const blob = new Blob([JSON.stringify(runResult, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `test-run-${runResult.runId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
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
      setDataset(data.dataset);
      setRunResult(null);
      setMessage(
        `Generated ${data.dataset.scenarioCount} scenarios · saved as ${data.dataset.id}`
      );
      setMessageType("ok");
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

  const loadSaved = async (id) => {
    setLoading(true);
    setMessage("");
    try {
      const data = await window.DevHelperApi.fetchJson(`/api/testing/datasets/${id}`);
      setDataset(data.dataset);
      setActiveView("scenarios");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const deleteSaved = async (id) => {
    if (!confirm("Delete this saved test dataset?")) return;
    setLoading(true);
    try {
      await window.DevHelperApi.fetchJson("/api/testing/datasets/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (dataset?.id === id) setDataset(null);
      const list = await window.DevHelperApi.fetchJson("/api/testing/datasets");
      setSavedList(list.datasets || []);
      setMessage("Dataset deleted.");
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
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

  return (
    <div>
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
                  />
                  {a.label}
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
      </div>

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
        <div className="card">
          <div className="card-header">
            <h3>Saved datasets ({savedList.length})</h3>
          </div>
          <ul className="report-list">
            {savedList.map((d) => (
              <li key={d.id} className="report-item">
                <div className="report-item-info">
                  <div className="report-item-title">{d.title}</div>
                  <div className="report-item-meta">
                    {d.scenarioCount} scenarios · {new Date(d.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="report-item-actions">
                  <button className="primary" onClick={() => loadSaved(d.id)}>
                    Open
                  </button>
                  <button className="danger" onClick={() => deleteSaved(d.id)} disabled={loading}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {dataset && (
        <div className="card">
          <div className="card-header">
            <div>
              <h2>{dataset.title}</h2>
              <p className="hint" style={{ marginTop: 4 }}>
                {dataset.summary}
              </p>
            </div>
            <div className="toolbar">
              <button className="primary" onClick={runTests} disabled={loading}>
                {loading && runProgress ? runProgress : loading ? "Running…" : "Run tests in UI"}
              </button>
              <button className="muted" onClick={downloadJson}>
                Download dataset
              </button>
              {runResult && (
                <button className="muted" onClick={downloadRunJson}>
                  Download results
                </button>
              )}
              <button className="muted" onClick={copyMarkdown}>
                Copy markdown
              </button>
            </div>
          </div>

          <label className="checkbox-row" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={captureEvidence}
              onChange={(e) => setCaptureEvidence(e.target.checked)}
              disabled={loading}
            />
            Capture panel screenshot for every test (Playwright evidence)
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={skipLive}
              onChange={(e) => setSkipLive(e.target.checked)}
              disabled={loading}
            />
            Skip live Chat browse (faster API-only assertions; evidence screenshot still captured)
          </label>

          {(runResult || liveResults.length > 0) && (
            <div className="run-summary">
              {(() => {
                const s =
                  runResult?.summary || {
                    passed: liveResults.filter((r) => r.status === "passed").length,
                    failed: liveResults.filter((r) => r.status === "failed").length,
                    skipped: liveResults.filter((r) => r.status === "skipped").length,
                    withScreenshots: liveResults.filter((r) => r.screenshots?.length).length,
                    total: liveResults.length,
                    durationMs: liveResults.reduce((n, r) => n + (r.durationMs || 0), 0),
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

          <div className="coverage-row">
            {Object.entries(dataset.coverageMatrix?.byCategory || {}).map(([k, v]) => (
              <span key={k} className="badge badge-muted">
                {k}: {v}
              </span>
            ))}
          </div>

          <div className="nav-tabs" style={{ marginTop: 14, marginBottom: 14 }}>
            <button
              type="button"
              className={activeView === "scenarios" ? "active" : ""}
              onClick={() => setActiveView("scenarios")}
            >
              Scenarios ({dataset.scenarioCount})
            </button>
            <button
              type="button"
              className={activeView === "summary" ? "active" : ""}
              onClick={() => setActiveView("summary")}
            >
              Markdown summary
            </button>
            <button
              type="button"
              className={activeView === "runner" ? "active" : ""}
              onClick={() => setActiveView("runner")}
              disabled={!loading && !runLog.length}
            >
              Runner{loading ? "…" : runLog.length ? ` (${runLog.length})` : ""}
            </button>
            <button
              type="button"
              className={activeView === "results" ? "active" : ""}
              onClick={() => setActiveView("results")}
              disabled={!runResult && !liveResults.length}
            >
              Results
              {runResult
                ? ` (${runResult.summary.passed}/${runResult.summary.total})`
                : liveResults.length
                  ? ` (${liveResults.length})`
                  : ""}
            </button>
            <button
              type="button"
              className={activeView === "json" ? "active" : ""}
              onClick={() => setActiveView("json")}
            >
              Raw JSON
            </button>
          </div>

          {activeView === "scenarios" && (
            <div className="scenario-list">
              {dataset.scenarios.map((s) => {
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
            </div>
          )}

          {activeView === "runner" && (loading || runLog.length > 0) && (
            <div>
              {runProgress && dataset && (
                <div className="run-progress-bar">
                  <div
                    className="run-progress-fill"
                    style={{
                      width: `${(liveResults.length / Math.max(dataset.scenarios.length, 1)) * 100}%`,
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
              {liveResults.length > 0 && (
                <div className="screens-grid" style={{ marginTop: 14 }}>
                  {liveResults
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

          {activeView === "results" && (runResult || liveResults.length > 0) && (
            <div className="scenario-list">
              {(runResult?.results || liveResults).map((r) => (
                <div key={r.scenarioId} className={`result-row ${r.status}`}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <strong>{r.scenarioId}</strong> — {r.title}
                      <div className="hint">
                        {r.category} · {r.type} · {Math.round((r.durationMs || 0) / 1000)}s
                        {r.screenshots?.length ? ` · ${r.screenshots.length} screenshot(s)` : ""}
                      </div>
                    </div>
                    {statusBadge(r.status)}
                  </div>
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
