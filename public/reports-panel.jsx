const { useEffect, useState, useRef, useLayoutEffect } = React;

const fetchJson = (path, options) => window.DevHelperApi.fetchJson(path, options);

function ReportsPanel() {
  const [reports, setReports] = useState([]);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState([]);
  const [selected, setSelected] = useState(null);
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
    window.DevHelperMarkdown?.enhance(searchMarkdownRef.current);
    window.DevHelperMarkdown?.enhance(reportMarkdownRef.current);
  }, [searchHits, selected]);

  const openReport = async (sessionId) => {
    setLoading(true);
    setMessage("");
    try {
      const data = await fetchJson(`/api/reports/${sessionId}`);
      setSelected(data.report);
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
                className="markdown-body"
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
                    {r.cloud?.jsonUrl && (
                      <>
                        {" · "}
                        <a href={r.cloud.jsonUrl} target="_blank" rel="noreferrer">
                          cloud backup
                        </a>
                      </>
                    )}
                  </div>
                </div>
                <div className="report-item-actions">
                  <button className="primary" onClick={() => openReport(r.sessionId)}>
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
            <button className="muted" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <article
            ref={reportMarkdownRef}
            className="markdown-body"
            dangerouslySetInnerHTML={{
              __html:
                window.DevHelperMarkdown?.parse(selected.user_manual || "") ||
                marked.parse(selected.user_manual || ""),
            }}
          />
        </div>
      )}
    </div>
  );
}
