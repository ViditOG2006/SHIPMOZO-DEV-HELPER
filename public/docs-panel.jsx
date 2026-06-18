(function () {
const { useEffect, useState, useRef, useLayoutEffect } = React;

const TABS = [
  { id: "prd", label: "PRD (Technical)" },
  { id: "user_manual", label: "User Manual", backendLabel: "API Integration Guide" },
];

const DOCS_KEY = window.DevHelperStorage?.KEYS?.DOCS || "shipmozo-docs-v1";

/** Client waits — server may throttle/retry Claude; 15 min per LLM step is OK. */
const DOCS_LLM_STEP_TIMEOUT_MS = 900000;
const DOCS_SCREENSHOT_START_TIMEOUT_MS = 90000;
const DOCS_SCREENSHOT_POLL_TIMEOUT_MS = 120000;
const DOCS_SCREENSHOT_MAX_WAIT_MS = 900000;

const DEFAULT_DOCS = {
  moduleName: "New Orders",
  description: "",
  captureScreens: true,
  backendOnly: false,
  activeTab: "prd",
  prd: "",
  userManual: "",
  screenshots: [],
  videos: [],
  sessionId: "",
  message: "",
  messageType: "info",
};

function downloadMarkdown(filename, text) {
  if (!text) return;
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function loadDocsState() {
  const saved = window.DevHelperStorage?.loadJson(DOCS_KEY, null);
  if (saved && typeof saved === "object") return { ...DEFAULT_DOCS, ...saved };
  return DEFAULT_DOCS;
}

function DocsPanel({ configured, model, provider, onBusyChange, onGoToTesting }) {
  const initial = useRef(loadDocsState());
  const [moduleName, setModuleName] = useState(initial.current.moduleName);
  const [description, setDescription] = useState(initial.current.description);
  const [captureScreens, setCaptureScreens] = useState(initial.current.captureScreens);
  const [backendOnly, setBackendOnly] = useState(Boolean(initial.current.backendOnly));
  const [exampleSources, setExampleSources] = useState([]);
  const [activeTab, setActiveTab] = useState(initial.current.activeTab);
  const [prd, setPrd] = useState(initial.current.prd);
  const [userManual, setUserManual] = useState(initial.current.userManual);
  const [screenshots, setScreenshots] = useState(initial.current.screenshots);
  const [videos, setVideos] = useState(initial.current.videos || []);
  const [sessionId, setSessionId] = useState(initial.current.sessionId);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(initial.current.message);
  const [messageType, setMessageType] = useState(initial.current.messageType);
  const [showSource, setShowSource] = useState(false);
  const markdownRef = useRef(null);

  useEffect(() => {
    window.DevHelperStorage?.saveJson(DOCS_KEY, {
      moduleName,
      description,
      captureScreens,
      backendOnly,
      activeTab,
      prd,
      userManual,
      screenshots,
      videos,
      sessionId,
      message,
      messageType,
    });
  }, [
    moduleName,
    description,
    captureScreens,
    backendOnly,
    activeTab,
    prd,
    userManual,
    screenshots,
    videos,
    sessionId,
    message,
    messageType,
  ]);

  useEffect(() => {
    onBusyChange?.(loading);
  }, [loading, onBusyChange]);

  useEffect(() => {
    window.DevHelperApi.fetchJson("/api/docs/examples")
      .then((data) => setExampleSources(data.sources || []))
      .catch(() => {});
  }, []);

  const clearDocs = () => {
    if (!confirm("Clear saved PRD and user manual from this browser?")) return;
    setPrd("");
    setUserManual("");
    setScreenshots([]);
    setVideos([]);
    setSessionId("");
    setMessage("");
    setMessageType("info");
    setActiveTab("prd");
    window.DevHelperStorage?.saveJson(DOCS_KEY, { ...DEFAULT_DOCS, moduleName, description, captureScreens, backendOnly });
  };

  const generateTestCases = async () => {
    const name = moduleName.trim();
    if (!name) {
      setMessage("Enter a module name.");
      setMessageType("err");
      return;
    }
    if (!prd && !userManual) {
      setMessage("Generate PRD and user manual first.");
      setMessageType("err");
      return;
    }
    if (!configured) {
      setMessage("Configure an AI API key in API Settings first.");
      setMessageType("err");
      return;
    }

    setLoading(true);
    setMessage("Creating test cases from PRD and user manual…");
    setMessageType("info");

    try {
      const data = await window.DevHelperApi.startAndPollTestcaseGen(
        {
          moduleName: name,
          prd,
          userManual,
          description,
          sessionId,
          save: true,
          options: {
            minScenarios: 10,
            includeLivePanel: !backendOnly,
            backendOnly,
          },
        },
        {
          onProgress: (_st, sec) => {
            setMessage(`Creating test cases from PRD and user manual… (${sec}s)`);
          },
        }
      );
      setMessage(`Created ${data.dataset.scenarioCount} test scenarios — opening Test Dataset…`);
      setMessageType("ok");
      if (onGoToTesting) onGoToTesting(data.dataset);
      else {
        window.dispatchEvent(
          new CustomEvent("devhelper:import-dataset", { detail: { dataset: data.dataset } })
        );
      }
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const generate = async () => {
    const name = moduleName.trim();
    if (!name) {
      setMessage("Enter a module name.");
      setMessageType("err");
      return;
    }
    if (!configured) {
      setMessage("Configure an AI API key in API Settings (OpenAI, Gemini, etc.).");
      setMessageType("err");
      return;
    }

    setLoading(true);
    setMessageType("info");
    setPrd("");
    setUserManual("");
    setScreenshots([]);
    setVideos([]);
    setSessionId("");

    const started = Date.now();
    const tick = setInterval(() => {
      const sec = Math.floor((Date.now() - started) / 1000);
      setMessage((prev) => {
        const base = prev.replace(/ \(\d+s\)$/, "");
        return `${base} (${sec}s)`;
      });
    }, 1000);

    const setStep = (text) => setMessage(text);

    const payload = {
      moduleName: name,
      description: description.trim(),
      model,
      provider,
      captureScreens: backendOnly ? false : captureScreens,
      backendOnly,
    };

    try {
      const totalSteps = backendOnly ? 2 : 3;
      setStep(`Step 1/${totalSteps}: Generating ${backendOnly ? "API" : "technical"} PRD…`);
      const prdData = await window.DevHelperApi.fetchJson("/api/docs/generate-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: DOCS_LLM_STEP_TIMEOUT_MS,
        body: JSON.stringify({
          moduleName: name,
          description: description.trim(),
          captureScreens: backendOnly ? false : captureScreens,
          backendOnly,
          step: "prd",
        }),
      });

      const sid = prdData.sessionId || "";
      setSessionId(sid);
      setPrd(prdData.prd || "");

      let shots = [];
      let vids = [];
      let shotWarning = null;

      if (!backendOnly) {
      setStep(`Step 2/${totalSteps}: Capturing screenshots…`);
      try {
        const shotStart = await window.DevHelperApi.fetchJson("/api/docs/screenshots/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeoutMs: DOCS_SCREENSHOT_START_TIMEOUT_MS,
          body: JSON.stringify({ ...payload, sessionId: sid }),
        });
        const jobId = shotStart.jobId;
        const pollMs = 2500;
        const maxWaitMs = DOCS_SCREENSHOT_MAX_WAIT_MS;
        const pollStarted = Date.now();
        let shotData = null;
        let networkFails = 0;
        while (Date.now() - pollStarted < maxWaitMs) {
          await new Promise((r) => setTimeout(r, pollMs));
          const sec = Math.floor((Date.now() - pollStarted) / 1000);
          setStep(`Step 2/3: Capturing screenshots… (${sec}s)`);
          try {
            const status = await window.DevHelperApi.fetchJson(
              `/api/docs/screenshots/status/${jobId}`,
              { timeoutMs: DOCS_SCREENSHOT_POLL_TIMEOUT_MS }
            );
            networkFails = 0;
            if (status.status === "done" || status.status === "error") {
              shotData = status;
              break;
            }
          } catch (pollErr) {
            networkFails += 1;
            if (networkFails > 20) {
              throw new Error(
                `Lost connection while waiting for screenshots (tunnel may have reconnected). ${pollErr}`
              );
            }
            setStep(`Step 2/3: Waiting for server… (${sec}s, retry ${networkFails})`);
          }
        }
        if (!shotData) {
          throw new Error(
            `Screenshot capture timed out after ${Math.round(DOCS_SCREENSHOT_MAX_WAIT_MS / 60000)} minutes`
          );
        }
        if (shotData.status === "error") {
          throw new Error(shotData.captureError || "Screenshot capture failed");
        }
        shots = shotData.screenshots || [];
        vids = shotData.videos || [];
        if (shotData.captureError) shotWarning = shotData.captureError;
        setScreenshots(shots);
        setVideos(vids);
      } catch (shotErr) {
        shotWarning = String(shotErr);
        setScreenshots([]);
        setVideos([]);
        setStep(`Step 2/${totalSteps}: Screenshots skipped (${shotWarning}). Writing user manual…`);
      }
      }

      setStep(
        backendOnly
          ? `Step 2/${totalSteps}: Writing API integration guide…`
          : `Step 3/${totalSteps}: Writing user manual (Azure OpenAI)…`
      );
      const manualData = await window.DevHelperApi.fetchJson("/api/docs/generate-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: DOCS_LLM_STEP_TIMEOUT_MS,
        body: JSON.stringify({
          moduleName: name,
          description: description.trim(),
          captureScreens: false,
          backendOnly,
          step: "manual",
          sessionId: sid,
          prd: prdData.prd || "",
          screenshots: shots,
          videos: vids,
        }),
      });

      setUserManual(manualData.user_manual || "");

      const parts = [];
      const agent = prdData.mcpAgent || manualData.mcpAgent;
      if (agent?.toolCalls?.length) {
        parts.push(
          `MCP agent: ${agent.toolCalls.length} tool call(s), ${agent.sourceCount || "?"} source(s)`
        );
      }
      if (prdData.generatedBy === "mcp-agent+llm") parts.push("PRD: LLM orchestrated MCP → compiled doc");
      if (prdData.prdTruncated) parts.push("PRD may be truncated (8K token limit)");
      if (manualData.manualTruncated) parts.push("User manual may be truncated");
      if (shotWarning) parts.push(`Screenshots: ${shotWarning}`);
      else if (shots.length)
        parts.push(`${shots.length} screenshot(s) stored (${shots[0]?.storage || "local"})`);
      if (manualData.saved) parts.push("Saved to report library");
      else if (manualData.saveError) parts.push(`Save failed: ${manualData.saveError}`);
      parts.push("Saved in browser until you clear");

      setMessage(
        parts.length ? `Done. ${parts.join(" · ")}` : "PRD and user manual generated successfully."
      );
      setMessageType(parts.some((p) => p.includes("truncated") || p.startsWith("Screenshots:")) ? "info" : "ok");
      setActiveTab("prd");
    } catch (err) {
      setMessage(`Failed: ${err}`);
      setMessageType("err");
    } finally {
      clearInterval(tick);
      setLoading(false);
    }
  };

  const activeContent =
    activeTab === "prd"
      ? window.DevHelperMarkdown?.appendMediaIfMissing?.(prd, screenshots, videos) || prd
      : window.DevHelperMarkdown?.appendMediaIfMissing?.(userManual, screenshots, videos) ||
        userManual;

  useLayoutEffect(() => {
    let cancelled = false;
    (async () => {
      if (showSource) return;
      await window.DevHelperMarkdown?.enhance(markdownRef.current);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [activeContent, activeTab, screenshots, videos, showSource]);

  const stepActive = loading
    ? message.includes("Step 3")
      ? 3
      : message.includes("Step 2")
        ? 2
        : 1
    : prd
      ? userManual
        ? 0
        : screenshots.length
          ? 2
          : 1
      : 0;

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <div>
            <h2>Generate documentation</h2>
            <p className="hint" style={{ marginTop: 4 }}>
              Technical PRD (Claude) + user manual (OpenAI) with live screenshots
            </p>
          </div>
          {sessionId && <span className="badge badge-muted">{sessionId}</span>}
        </div>

        <label className="field">Module name</label>
        <input
          type="text"
          value={moduleName}
          onChange={(e) => setModuleName(e.target.value)}
          placeholder="e.g. Billing, Quick Add, New Orders"
        />

        <label className="field">Notes (optional)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Special flows, panel type, edge cases…"
          style={{ minHeight: 64 }}
        />

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={backendOnly}
            onChange={(e) => {
              const on = e.target.checked;
              setBackendOnly(on);
              if (on) setCaptureScreens(false);
            }}
          />
          Backend/API service (no panel UI)
        </label>
        <p className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
          Skips screenshots; PRD covers APIs only; test generation imports Postman API scenarios only.
        </p>

        {!backendOnly && (
        <>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={captureScreens}
            onChange={(e) => setCaptureScreens(e.target.checked)}
          />
          Capture live screenshots (needs SHIPMOZO_EMAIL / PASSWORD in .env)
        </label>
        <p className="hint">
          Cloudinary when configured · otherwise <code>/cloud-images/&lt;session&gt;/</code>
        </p>
        </>
        )}

        <div className="step-progress">
          <span className={`step-chip ${stepActive === 1 ? "active" : stepActive > 1 || prd ? "done" : ""}`}>
            1 · PRD
          </span>
          {!backendOnly && (
          <span className={`step-chip ${stepActive === 2 ? "active" : stepActive > 2 || screenshots.length ? "done" : ""}`}>
            2 · Screenshots
          </span>
          )}
          <span className={`step-chip ${stepActive === (backendOnly ? 2 : 3) ? "active" : userManual ? "done" : ""}`}>
            {backendOnly ? "2 · API Guide" : "3 · User Manual"}
          </span>
        </div>

        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="primary" onClick={generate} disabled={loading}>
            {loading
              ? "Generating…"
              : backendOnly
                ? "Generate API PRD + Guide"
                : "Generate PRD + User Manual"}
          </button>
          <button
            className="primary"
            onClick={generateTestCases}
            disabled={loading || (!prd && !userManual)}
            title="AI builds test scenarios from the PRD and user manual above"
          >
            {loading && message.includes("test cases") ? "Creating tests…" : "Create test cases"}
          </button>
          <button className="muted" onClick={clearDocs} disabled={loading}>
            Clear output
          </button>
        </div>
      </div>

      {message && (
        <div className={`alert alert-${messageType === "ok" ? "success" : messageType === "err" ? "error" : "info"}`}>
          {message}
        </div>
      )}

      {screenshots.length > 0 && (
        <div className="card">
          <h3>Screenshots</h3>
          <div className="screens-grid">
            {screenshots.map((s) => (
              <figure key={s.id}>
                <img src={s.url} alt={s.label} />
                <figcaption>{s.label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      {videos.length > 0 && (
        <div className="card">
          <h3>Screen recordings</h3>
          <div className="screens-grid">
            {videos.map((v) => (
              <figure key={v.id}>
                <video src={v.url} controls style={{ width: "100%", maxHeight: 280 }} />
                <figcaption>
                  <a href={v.url} target="_blank" rel="noreferrer">
                    {v.label}
                  </a>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header" style={{ marginBottom: 8 }}>
          <div className="nav-tabs" style={{ flex: 1 }}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={activeTab === t.id ? "active" : ""}
                onClick={() => {
                  setActiveTab(t.id);
                  setShowSource(false);
                }}
              >
                {backendOnly && t.backendLabel ? t.backendLabel : t.label}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <button
              className="muted"
              type="button"
              disabled={!activeContent}
              onClick={() => setShowSource((v) => !v)}
            >
              {showSource ? "View preview" : "View source"}
            </button>
            <button
              className="muted"
              type="button"
              disabled={!prd}
              onClick={() => downloadMarkdown(`${moduleName.trim() || "module"}-prd.md`, prd)}
            >
              Download PRD
            </button>
            <button
              className="muted"
              type="button"
              disabled={!userManual}
              onClick={() =>
                downloadMarkdown(`${moduleName.trim() || "module"}-manual.md`, userManual)
              }
            >
              Download manual
            </button>
          </div>
        </div>

        {!activeContent ? (
          <div className="empty-state">
            <div className="empty-state-icon">📄</div>
            <p>Generated PRD and user manual will appear here</p>
          </div>
        ) : showSource ? (
          <pre className="docs-source-view">
            <code>
              {window.DevHelperMarkdown?.unwrapDocumentCodeFence?.(activeContent) || activeContent}
            </code>
          </pre>
        ) : (
          <article
            ref={markdownRef}
            className="markdown-body docs-preview"
            dangerouslySetInnerHTML={{
              __html: window.DevHelperMarkdown?.parse(activeContent) || marked.parse(activeContent),
            }}
          />
        )}
      </div>
    </div>
  );
}

window.DocsPanel = DocsPanel;
})();
