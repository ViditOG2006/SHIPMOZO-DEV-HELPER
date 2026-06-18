(function () {
const { useEffect, useState, useRef, useLayoutEffect } = React;

const fetchJson = (path, options) => window.DevHelperApi.fetchJson(path, options);

const REPORT_TABS = [
  { id: "prd", label: "PRD (Technical)" },
  { id: "user_manual", label: "User Manual" },
];

function downloadText(filename, text) {
  if (!text) return;
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function ReportsPanel({ configured, model, provider, onGoToTesting }) {
  const [reports, setReports] = useState([]);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState([]);
  const [selected, setSelected] = useState(null);
  const [reportTab, setReportTab] = useState("prd");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [navInfo, setNavInfo] = useState(null);
  const reportMarkdownRef = useRef(null);
  const searchMarkdownRef = useRef(null);

  const loadNavMap = async () => {
    try {
      const data = await fetchJson("/api/panel/navigation");
      setNavInfo(data);
    } catch {
      /* ignore */
    }
  };

  const clearAllData = async () => {
    if (
      !confirm(
        "Clear ALL saved data?\n\n• Saved reports\n• Chat history (browser)\n• Module Docs draft (browser)\n• Screenshot cache & login session\n\nAPI keys in .env are kept."
      )
    ) {
      return;
    }
    setLoading(true);
    setMessage("Clearing saved data…");
    setMessageType("info");
    try {
      await fetchJson("/api/app/clear-data", { method: "POST" });
      window.DevHelperStorage?.clearAllAppData?.();
      setReports([]);
      setSearchHits([]);
      setSelected(null);
      setNavInfo(null);
      setMessage("All saved app data cleared. Hard refresh recommended.");
      setMessageType("ok");
      await loadNavMap();
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const refreshNavMap = async () => {
    if (!confirm("Crawl the live Shipmozo panel to rebuild the navigation map? Takes 2–5 minutes.")) return;
    setLoading(true);
    setMessage("Crawling panel for navigation map…");
    setMessageType("info");
    try {
      const data = await fetchJson("/api/panel/discover-navigation", {
        method: "POST",
        timeoutMs: 300000,
      });
      setMessage(`Navigation map updated: ${data.pageCount} pages.`);
      setMessageType("ok");
      await loadNavMap();
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const loadReports = async () => {
    setLoading(true);
    try {
      const data = await fetchJson("/api/reports");
      setReports(data.reports || []);
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReports();
    loadNavMap();
  }, []);

  useLayoutEffect(() => {
    let cancelled = false;
    (async () => {
      await window.DevHelperMarkdown?.enhance(searchMarkdownRef.current);
      if (cancelled) return;
      await window.DevHelperMarkdown?.enhance(reportMarkdownRef.current);
    })();
    return () => {
      cancelled = true;
    };
  }, [searchHits, selected, reportTab]);

  const openReport = async (sessionId) => {
    setLoading(true);
    setMessage("");
    try {
      const data = await fetchJson(`/api/reports/${sessionId}`);
      setSelected(data.report);
      setReportTab(data.report?.prd ? "prd" : "user_manual");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const deleteOne = async (sessionId) => {
    if (!confirm("Delete this saved report? This does not delete any Cloudinary backups.")) return;
    setLoading(true);
    setMessage("");
    try {
      await fetchJson("/api/reports/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (selected?.sessionId === sessionId) setSelected(null);
      await loadReports();
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const createTestCases = async () => {
    if (!selected?.moduleName) return;
    if (!selected.prd && !selected.user_manual) {
      setMessage("This report has no PRD or user manual content.");
      setMessageType("err");
      return;
    }
    if (!configured) {
      setMessage("Configure an AI API key in API Settings first.");
      setMessageType("err");
      return;
    }

    setLoading(true);
    setMessage(`Creating test cases for ${selected.moduleName}…`);
    setMessageType("info");

    try {
      const data = await window.DevHelperApi.startAndPollTestcaseGen(
        {
          moduleName: selected.moduleName,
          prd: selected.prd || "",
          userManual: selected.user_manual || "",
          description: selected.description || "",
          sessionId: selected.sessionId,
          save: true,
          options: { minScenarios: 10, includeLivePanel: true },
        },
        {
          onProgress: (_st, sec) => {
            setMessage(`Creating test cases for ${selected.moduleName}… (${sec}s)`);
          },
        }
      );
      setMessage(`Created ${data.dataset.scenarioCount} test scenarios.`);
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

  const runSearch = async () => {
    const q = searchQ.trim();
    if (!q) return;
    setLoading(true);
    setMessage("");
    try {
      const data = await fetchJson(`/api/reports/search?q=${encodeURIComponent(q)}`);
      setSearchHits(data.hits || []);
      if (!data.hits?.length) {
        setMessage(`No saved manual sections matched "${q}".`);
        setMessageType("info");
      }
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const selectedReportMarkdown = selected
    ? reportTab === "prd"
      ? selected.prd
      : window.DevHelperMarkdown?.appendMediaIfMissing?.(
          selected.user_manual,
          selected.screenshots || [],
          selected.videos || []
        ) || selected.user_manual
    : "";

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <div>
            <h2>Report library</h2>
            <p className="hint" style={{ marginTop: 4 }}>
              PRDs and user manuals saved locally · synced to Cloudinary when configured
            </p>
          </div>
        </div>

        {navInfo && (
          <p className="hint" style={{ marginTop: 0 }}>
            Navigation map: <strong>{navInfo.pageCount}</strong> pages ({navInfo.source})
            {navInfo.discoveredAt ? ` · updated ${new Date(navInfo.discoveredAt).toLocaleString()}` : ""}
          </p>
        )}

        <div className="toolbar">
          <button className="muted" onClick={refreshNavMap} disabled={loading}>
            Refresh navigation map
          </button>
          <button className="danger" onClick={clearAllData} disabled={loading}>
            Clear all app data
          </button>
        </div>

        <label className="field">Search saved manuals</label>
        <div className="row">
          <input
            type="text"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder='e.g. "create an order", "bulk assign courier"'
            style={{ flex: 1, minWidth: 220 }}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
          />
          <button className="primary" onClick={runSearch} disabled={loading}>
            Search
          </button>
        </div>
      </div>

      {message && (
        <div className={`alert alert-${messageType === "ok" ? "success" : messageType === "err" ? "error" : "info"}`}>
          {message}
        </div>
      )}

      {searchHits.length > 0 && (
        <div className="card" ref={searchMarkdownRef}>
          <h3>Search results ({searchHits.length})</h3>
          {searchHits.map((hit, idx) => (
            <div key={idx} className="search-hit">
              <div className="search-hit-header">
                {hit.moduleName} · {hit.title} · score {hit.score}
              </div>
              <article
                className="markdown-body docs-preview"
                dangerouslySetInnerHTML={{
                  __html: window.DevHelperMarkdown?.parse(hit.text) || marked.parse(hit.text),
                }}
              />
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3>All reports ({reports.length})</h3>
          <button className="muted" onClick={loadReports} disabled={loading}>
            Refresh
          </button>
        </div>
        {!reports.length ? (
          <div className="empty-state">
            <div className="empty-state-icon">📚</div>
            <p>No reports yet — generate a module doc first</p>
          </div>
        ) : (
          <ul className="report-list">
            {reports.map((r) => (
              <li key={r.sessionId} className="report-item">
                <div className="report-item-info">
                  <div className="report-item-title">{r.moduleName}</div>
                  <div className="report-item-meta">
                    {r.screenshotCount || 0} screenshots · {new Date(r.createdAt).toLocaleString()}
                    {r.cloud?.prdUrl && (
                      <>
                        {" · "}
                        <a href={r.cloud.prdUrl} target="_blank" rel="noreferrer">
                          PRD
                        </a>
                      </>
                    )}
                    {r.cloud?.manualUrl && (
                      <>
                        {" · "}
                        <a href={r.cloud.manualUrl} target="_blank" rel="noreferrer">
                          manual
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <div className="report-item-actions">
                  <button type="button" className="primary" onClick={() => openReport(r.sessionId)}>
                    Open
                  </button>
                  <button className="danger" onClick={() => deleteOne(r.sessionId)} disabled={loading}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <div className="card">
          <div className="card-header">
            <h3>
              {selected.moduleName}{" "}
              <span className="badge badge-muted">{selected.sessionId}</span>
            </h3>
            <div className="toolbar">
              <button
                className="muted"
                type="button"
                disabled={!selected.prd}
                onClick={() =>
                  downloadText(`${selected.moduleName || "module"}-prd.md`, selected.prd)
                }
              >
                Download PRD
              </button>
              <button
                className="muted"
                type="button"
                disabled={!selected.user_manual}
                onClick={() =>
                  downloadText(`${selected.moduleName || "module"}-manual.md`, selected.user_manual)
                }
              >
                Download manual
              </button>
              <button
                className="primary"
                onClick={createTestCases}
                disabled={loading || !configured}
              >
                {loading && message.includes("test cases") ? "Creating…" : "Create test cases"}
              </button>
              <button className="muted" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
          </div>
          <div className="nav-tabs">
            {REPORT_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={reportTab === t.id ? "active" : ""}
                onClick={() => setReportTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {selected.screenshots?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4>Screenshots</h4>
              <div className="screens-grid">
                {selected.screenshots.map((s) => (
                  <figure key={s.id || s.url}>
                    <img src={s.url} alt={s.label || "Screenshot"} />
                    <figcaption>{s.label}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
          {selected.videos?.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4>Screen recordings</h4>
              <div className="screens-grid">
                {selected.videos.map((v) => (
                  <figure key={v.id || v.url}>
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
          {!selectedReportMarkdown ? (
            <div className="empty-state">
              <p>No {reportTab === "prd" ? "PRD" : "user manual"} saved for this report.</p>
            </div>
          ) : (
            <article
              ref={reportMarkdownRef}
              className="markdown-body docs-preview"
              dangerouslySetInnerHTML={{
                __html:
                  window.DevHelperMarkdown?.parse(selectedReportMarkdown) ||
                  marked.parse(selectedReportMarkdown),
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

window.ReportsPanel = ReportsPanel;
})();
