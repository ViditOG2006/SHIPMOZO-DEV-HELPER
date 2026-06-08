const { useEffect, useState, useRef, useLayoutEffect } = React;

const TABS = [
  { id: "prd", label: "PRD (Technical)" },
  { id: "user_manual", label: "User Manual" },
];

const DOCS_KEY = window.DevHelperStorage?.KEYS?.DOCS || "shipmozo-docs-v1";

const DEFAULT_DOCS = {
  moduleName: "New Orders",
  description: "",
  captureScreens: true,
  activeTab: "prd",
  prd: "",
  userManual: "",
  screenshots: [],
  sessionId: "",
  message: "",
  messageType: "info",
};

function loadDocsState() {
  const saved = window.DevHelperStorage?.loadJson(DOCS_KEY, null);
  if (saved && typeof saved === "object") return { ...DEFAULT_DOCS, ...saved };
  return DEFAULT_DOCS;
}

function DocsPanel({ configured, model, provider, onBusyChange }) {
  const initial = useRef(loadDocsState());
  const [moduleName, setModuleName] = useState(initial.current.moduleName);
  const [description, setDescription] = useState(initial.current.description);
  const [captureScreens, setCaptureScreens] = useState(initial.current.captureScreens);
  const [exampleSources, setExampleSources] = useState([]);
  const [activeTab, setActiveTab] = useState(initial.current.activeTab);
  const [prd, setPrd] = useState(initial.current.prd);
  const [userManual, setUserManual] = useState(initial.current.userManual);
  const [screenshots, setScreenshots] = useState(initial.current.screenshots);
  const [sessionId, setSessionId] = useState(initial.current.sessionId);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(initial.current.message);
  const [messageType, setMessageType] = useState(initial.current.messageType);
  const markdownRef = useRef(null);

  useEffect(() => {
    window.DevHelperStorage?.saveJson(DOCS_KEY, {
      moduleName,
      description,
      captureScreens,
      activeTab,
      prd,
      userManual,
      screenshots,
      sessionId,
      message,
      messageType,
    });
  }, [
    moduleName,
    description,
    captureScreens,
    activeTab,
    prd,
    userManual,
    screenshots,
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
    setSessionId("");
    setMessage("");
    setMessageType("info");
    setActiveTab("prd");
    window.DevHelperStorage?.saveJson(DOCS_KEY, { ...DEFAULT_DOCS, moduleName, description, captureScreens });
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
      captureScreens,
    };

    try {
      setStep("Step 1/3: Generating technical PRD…");
      const prdData = await window.DevHelperApi.fetchJson("/api/docs/generate-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 180000,
        body: JSON.stringify({ ...payload, step: "prd" }),
      });

      const sid = prdData.sessionId || "";
      setSessionId(sid);
      setPrd(prdData.prd || "");

      setStep("Step 2/3: Capturing screenshots…");
      let shots = [];
      let shotWarning = null;
      try {
        const shotData = await window.DevHelperApi.fetchJson("/api/docs/generate-step", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeoutMs: 360000,
          body: JSON.stringify({ ...payload, step: "screenshots", sessionId: sid }),
        });
        shots = shotData.screenshots || [];
        if (shotData.captureError) shotWarning = shotData.captureError;
        setScreenshots(shots);
      } catch (shotErr) {
        shotWarning = String(shotErr);
        setScreenshots([]);
        setStep(`Step 2/3: Screenshots skipped (${shotWarning}). Writing user manual…`);
      }

      setStep("Step 3/3: Writing user manual…");
      const manualData = await window.DevHelperApi.fetchJson("/api/docs/generate-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 180000,
        body: JSON.stringify({
          ...payload,
          step: "manual",
          sessionId: sid,
          prd: prdData.prd || "",
          screenshots: shots,
        }),
      });

      setUserManual(manualData.user_manual || "");

      const parts = [];
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

  const activeContent = activeTab === "prd" ? prd : userManual;

  useLayoutEffect(() => {
    window.DevHelperMarkdown?.enhance(markdownRef.current);
  }, [activeContent, activeTab]);

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
              Technical PRD + user manual with live panel screenshots
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
            checked={captureScreens}
            onChange={(e) => setCaptureScreens(e.target.checked)}
          />
          Capture live screenshots (needs SHIPMOZO_EMAIL / PASSWORD in .env)
        </label>
        <p className="hint">
          Cloudinary when configured · otherwise <code>/cloud-images/&lt;session&gt;/</code>
        </p>

        <div className="step-progress">
          <span className={`step-chip ${stepActive === 1 ? "active" : stepActive > 1 || prd ? "done" : ""}`}>
            1 · PRD
          </span>
          <span className={`step-chip ${stepActive === 2 ? "active" : stepActive > 2 || screenshots.length ? "done" : ""}`}>
            2 · Screenshots
          </span>
          <span className={`step-chip ${stepActive === 3 ? "active" : userManual ? "done" : ""}`}>
            3 · User Manual
          </span>
        </div>

        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="primary" onClick={generate} disabled={loading}>
            {loading ? "Generating…" : "Generate PRD + User Manual"}
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

      <div className="card">
        <div className="nav-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={activeTab === t.id ? "active" : ""}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {!activeContent ? (
          <div className="empty-state">
            <div className="empty-state-icon">📄</div>
            <p>Generated PRD and user manual will appear here</p>
          </div>
        ) : (
          <article
            ref={markdownRef}
            className="markdown-body"
            dangerouslySetInnerHTML={{
              __html: window.DevHelperMarkdown?.parse(activeContent) || marked.parse(activeContent),
            }}
          />
        )}
      </div>
    </div>
  );
}
