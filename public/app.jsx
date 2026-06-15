const { useEffect, useState } = React;



const VIEWS = {

  docs: {

    title: "Module Docs",

    subtitle: "Generate technical PRDs and user manuals with live panel screenshots",

    icon: "📄",

  },

  chat: {

    title: "Chat",

    subtitle: "Ask questions — answers from saved PRDs and user manuals (instant)",

    icon: "💬",

  },

  reports: {

    title: "Saved Reports",

    subtitle: "Browse, search, and manage generated documentation",

    icon: "📚",

  },

  testing: {

    title: "Test Dataset",

    subtitle: "Generate scenarios from PRD + manual, or describe requirements in text",

    icon: "🧪",

  },

  settings: {

    title: "API Settings",

    subtitle: "Configure OpenAI, OpenRouter, Gemini, or Claude",

    icon: "⚙️",

  },

};



function App() {

  const [view, setView] = useState("docs");

  const [configured, setConfigured] = useState(false);

  const [model, setModel] = useState("openai/gpt-4o-mini");

  const [provider, setProvider] = useState("openrouter");

  const [serverOk, setServerOk] = useState(true);

  const [serverError, setServerError] = useState("");

  const [publicUrl, setPublicUrl] = useState("");

  const [recommendedUrl, setRecommendedUrl] = useState("");

  const [localUrl, setLocalUrl] = useState("");

  const [tunnelStatus, setTunnelStatus] = useState("off");

  const [tunnelError, setTunnelError] = useState("");

  const [docsBusy, setDocsBusy] = useState(false);

  const [chatBusy, setChatBusy] = useState(false);

  const [testingBusy, setTestingBusy] = useState(false);

  const [testingImport, setTestingImport] = useState(null);

  const goToTestingWithDataset = (dataset) => {
    setTestingImport(dataset || null);
    setView("testing");
  };



  const refreshServerStatus = () =>

    window.DevHelperApi.checkServer().then((result) => {

      if (!result.ok) {

        setServerOk(false);

        setServerError(result.error);

        return false;

      }

      setServerOk(true);

      setServerError("");

      setPublicUrl(result.data?.publicUrl || "");

      setRecommendedUrl(result.data?.recommendedUrl || result.data?.localUrl || "");

      setLocalUrl(result.data?.localUrl || "");

      setTunnelStatus(result.data?.tunnelStatus || "off");

      setTunnelError(result.data?.tunnelError || "");

      const data = result.data?.ai || {};

      setConfigured(Boolean(data.configured));

      if (data.model) setModel(data.model);

      if (data.provider) setProvider(data.provider);

      return true;

    });



  useEffect(() => {

    refreshServerStatus();

    window.DevHelperApi.fetchJson("/api/ai/config")

      .then((data) => {

        setConfigured(Boolean(data.configured));

        if (data.model) setModel(data.model);

        if (data.provider) setProvider(data.provider);

      })

      .catch((err) => {

        setServerOk(false);

        setServerError(String(err));

      });

    const id = setInterval(() => refreshServerStatus(), 5000);

    return () => clearInterval(id);

  }, []);



  const current = VIEWS[view] || VIEWS.docs;

  const busy = docsBusy || chatBusy || testingBusy;



  return (

    <div className="app-shell">

      <aside className="sidebar">

        <div className="sidebar-brand">

          <div className="brand-icon">📦</div>

          <div>

            <div className="brand-title">Shipmozo</div>

            <div className="brand-sub">Dev Helper</div>

          </div>

        </div>



        <nav className="sidebar-nav">

          {Object.entries(VIEWS).map(([id, meta]) => (

            <button

              key={id}

              type="button"

              className={`nav-item ${view === id ? "active" : ""}`}

              onClick={() => setView(id)}

            >

              <span className="nav-icon">{meta.icon}</span>

              {meta.title}

            </button>

          ))}

        </nav>



        <div className="sidebar-footer">

          <div className="status-pill">

            <span className={`status-dot ${serverOk ? "ok" : "err"}`} />

            {serverOk ? "Server connected" : "Server offline"}

          </div>

          <div className="status-pill">

            <span className={`status-dot ${configured ? "ok" : "err"}`} />

            {configured ? "AI configured" : "AI not configured"}

          </div>

          {busy && (

            <div className="status-pill">

              <span className="status-dot busy" />

              Working…

            </div>

          )}

          {recommendedUrl && (

            <div className="status-pill" title="Always use this on your PC — tunnel URLs expire after restart">

              💻{" "}
              <a
                href={recommendedUrl}
                onClick={(e) => {
                  try {
                    if (new URL(recommendedUrl).origin === window.location.origin) {
                      e.preventDefault();
                    }
                  } catch {
                    /* ignore */
                  }
                }}
                style={{ color: "inherit", fontWeight: 600 }}
              >
                {recommendedUrl.replace(/^https?:\/\//, "")}
              </a>

            </div>

          )}

          {tunnelStatus === "starting" && (

            <div className="status-pill" title="New URL appears in ~5s after npm start">

              📱 Tunnel starting…

            </div>

          )}

          {tunnelStatus === "failed" && (

            <div className="status-pill" title={tunnelError || "Cloudflare tunnel failed"}>

              📱 Tunnel failed — use laptop URL or run: winget install Cloudflare.cloudflared

            </div>

          )}

          {publicUrl && tunnelStatus === "ready" && (

            <div className="status-pill public-url-pill" title="Phone/tablet only — dies when you stop npm start; do not bookmark">

              📱{" "}

              <a href={publicUrl} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "none" }}>

                {publicUrl.replace("https://", "")}

              </a>

            </div>

          )}

        </div>

      </aside>



      <main className="main-content">

        <header className="page-header">

          <h1>{current.title}</h1>

          <p className="subtitle">{current.subtitle}</p>

        </header>



        {!serverOk && (

          <div className="alert server-alert">

            <strong>Backend not connected.</strong> {serverError}

            <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>

              Run <code>npm start</code> in the project folder, then open{" "}

              <a href="http://127.0.0.1:3000">http://127.0.0.1:3000</a>

              {" "}on this PC. Old <code>trycloudflare.com</code> links stop working after restart.

            </p>

          </div>

        )}



        <div style={{ display: view === "docs" ? "block" : "none" }}>

          <DocsPanel

            configured={configured}

            model={model}

            provider={provider}

            onBusyChange={setDocsBusy}

            onGoToTesting={goToTestingWithDataset}

          />

        </div>

        <div style={{ display: view === "reports" ? "block" : "none" }}>

          <ReportsPanel

            configured={configured}

            model={model}

            provider={provider}

            onGoToTesting={goToTestingWithDataset}

          />

        </div>

        <div style={{ display: view === "testing" ? "block" : "none" }}>

          <TestingPanel

            configured={configured}

            model={model}

            provider={provider}

            onBusyChange={setTestingBusy}

            importDataset={testingImport}

            onImportDatasetHandled={() => setTestingImport(null)}

          />

        </div>

        <div style={{ display: view === "chat" || view === "settings" ? "block" : "none" }}>

          <AiPanel

            hideSettings={view === "chat"}

            settingsOnly={view === "settings"}

            onBusyChange={setChatBusy}

            onConfiguredChange={(cfg) => {

              setConfigured(Boolean(cfg?.configured));

              if (cfg?.model) setModel(cfg.model);

              if (cfg?.provider) setProvider(cfg.provider);

            }}

          />

        </div>

      </main>

    </div>

  );

}



ReactDOM.createRoot(document.getElementById("root")).render(<App />);

