const { useEffect, useState } = React;



const VIEWS = {

  docs: {

    title: "Module Docs",

    subtitle: "Generate technical PRDs and user manuals with live panel screenshots",

    icon: "📄",

  },

  chat: {

    title: "Chat",

    subtitle: "Ask questions — browses the live Shipmozo panel for answers",

    icon: "💬",

  },

  reports: {

    title: "Saved Reports",

    subtitle: "Browse, search, and manage generated documentation",

    icon: "📚",

  },

  testing: {

    title: "Test Dataset",

    subtitle: "Describe requirements in text — AI generates scenarios and inputs",

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

  const [docsBusy, setDocsBusy] = useState(false);

  const [chatBusy, setChatBusy] = useState(false);

  const [testingBusy, setTestingBusy] = useState(false);



  const refreshServerStatus = () =>

    window.DevHelperApi.checkServer().then((result) => {

      if (!result.ok) {

        setServerOk(false);

        setServerError(result.error);

        return false;

      }

      setServerOk(true);

      setServerError("");

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

    const id = setInterval(() => refreshServerStatus(), 15000);

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

              In the project folder run <code>npm start</code>, then open{" "}

              <a href="http://127.0.0.1:3000">http://127.0.0.1:3000</a>

            </p>

          </div>

        )}



        <div style={{ display: view === "docs" ? "block" : "none" }}>

          <DocsPanel

            configured={configured}

            model={model}

            provider={provider}

            onBusyChange={setDocsBusy}

          />

        </div>

        <div style={{ display: view === "reports" ? "block" : "none" }}>

          <ReportsPanel />

        </div>

        <div style={{ display: view === "testing" ? "block" : "none" }}>

          <TestingPanel

            configured={configured}

            model={model}

            provider={provider}

            onBusyChange={setTestingBusy}

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

