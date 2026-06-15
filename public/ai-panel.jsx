const { useEffect, useState, useRef, useLayoutEffect } = React;

const FALLBACK_PROVIDERS = [
  {
    id: "claude",
    label: "Claude (Anthropic)",
    models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022", "claude-3-5-sonnet-20241022"],
    keyHint: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/",
  },
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    keyHint: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    keyHint: "Azure API key",
    docsUrl: "https://portal.azure.com/",
    setupHint:
      "Requires AZURE_OPENAI_ENDPOINT + chat deployment (e.g. gpt-4.1-mini). Embedding deployments like text-embedding-3-small will not work.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    models: ["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-3.5-sonnet"],
    keyHint: "sk-or-v1-...",
    docsUrl: "https://openrouter.ai/keys",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    models: ["gemini-1.5-flash", "gemini-1.5-pro"],
    keyHint: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
  },
];

const CHAT_KEY = window.DevHelperStorage?.KEYS?.CHAT || "shipmozo-chat-v1";
const GITHUB_REPO_KEY = window.DevHelperStorage?.KEYS?.GITHUB_REPO || "shipmozo-github-repo-v1";

function loadGithubRepoFromLocal() {
  const saved = window.DevHelperStorage?.loadJson(GITHUB_REPO_KEY, null);
  return String(saved?.url || "").trim();
}

function saveGithubRepoToLocal(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return;
  window.DevHelperStorage?.saveJson(GITHUB_REPO_KEY, { url: trimmed, savedAt: Date.now() });
}

function clearGithubRepoLocal() {
  window.DevHelperStorage?.remove(GITHUB_REPO_KEY);
}
const DEFAULT_CHAT = [
  {
    role: "assistant",
    content:
      "Ask about any Shipmozo module — orders, billing, Shopify, rate calculator, etc.\n\nBy default I answer from **saved PRDs and user manuals** (Module Docs / Reports). Turn on **Use live panel** to browse the merchant panel with Playwright (~1–2 min).",
  },
];

const fetchJson = (path, options) => window.DevHelperApi.fetchJson(path, options);

function normalizeShotList(shots) {
  return (shots || [])
    .map((s) => {
      if (!s?.url) return null;
      const url = window.DevHelperMarkdown?.normalizeMediaSrc?.(s.url) || s.url;
      return { label: s.label || s.id || "Screenshot", url, id: s.id || null };
    })
    .filter(Boolean);
}

function buildAssistantContent(rawReply, screenshots = [], videos = []) {
  const reply = String(rawReply || "").trim();
  if (!reply) return "No reply received from AI.";
  return (
    window.DevHelperMarkdown?.appendMediaIfMissing?.(reply, screenshots, videos) || reply
  );
}

function replyHasWorkingImages(htmlOrMd) {
  const text = String(htmlOrMd || "");
  if (/!\[[^\]]*\]\((https?:\/\/[^)]+|\/cloud-images\/[^)]+)\)/.test(text)) return true;
  if (/<img[^>]+src=["'](https?:\/\/[^"']+|\/cloud-images\/[^"']+)/i.test(text)) return true;
  return false;
}

function ChatScreenshotGallery({ screenshots }) {
  const shots = normalizeShotList(screenshots);
  if (!shots.length) return null;

  return (
    <div className="chat-screenshots" style={{ marginTop: 12 }}>
      <p className="hint" style={{ margin: "0 0 8px", fontSize: 12 }}>
        Screenshots from saved manual
      </p>
      <div className="screens-grid">
        {shots.map((s, i) => (
          <figure key={`${s.url}-${i}`}>
            <a href={s.url} target="_blank" rel="noreferrer">
              <img src={s.url} alt={s.label} loading="lazy" decoding="async" />
            </a>
            <figcaption>{s.label}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function loadChatMessages() {
  const saved = window.DevHelperStorage?.loadJson(CHAT_KEY, null);
  if (Array.isArray(saved) && saved.length) return saved;
  return DEFAULT_CHAT;
}

function AiPanel({ hideSettings = false, settingsOnly = false, onConfiguredChange, onBusyChange }) {
  const [config, setConfig] = useState(null);
  const [provider, setProvider] = useState("claude");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-20250514");
  const [modelOptions, setModelOptions] = useState([
    "claude-sonnet-4-20250514",
    "claude-3-5-haiku-20241022",
  ]);
  const [messages, setMessages] = useState(loadChatMessages);
  const [chatInput, setChatInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
  const [githubRepoInput, setGithubRepoInput] = useState("");
  const [githubStatus, setGithubStatus] = useState(null);
  const [aiScope, setAiScope] = useState(null);
  const [useLivePanel, setUseLivePanel] = useState(false);
  const [reportSessionId, setReportSessionId] = useState("");
  const [savedReports, setSavedReports] = useState([]);
  const chatEndRef = useRef(null);
  const chatLogRef = useRef(null);

  useEffect(() => {
    window.DevHelperStorage?.saveJson(CHAT_KEY, messages);
  }, [messages]);

  const applyProviderModels = (data, providerId) => {
    const p = (data.supportedProviders || []).find((x) => x.id === providerId);
    if (p?.models?.length) {
      setModelOptions(p.models);
      if (!p.models.includes(model)) setModel(p.models[0]);
    }
  };

  const providerList = config?.supportedProviders?.length
    ? config.supportedProviders
    : FALLBACK_PROVIDERS;

  const loadConfig = async () => {
    const localRepo = loadGithubRepoFromLocal();
    if (localRepo) setGithubRepoInput(localRepo);

    const data = await fetchJson("/api/ai/config");
    setConfig(data);
    if (data.provider) setProvider(data.provider);
    if (data.model) setModel(data.model);
    if (data.models?.length) setModelOptions(data.models);

    const repoUrl = data.githubRepoUrl || localRepo;
    if (repoUrl) setGithubRepoInput(repoUrl);
    if (data.githubRepoUrl) saveGithubRepoToLocal(data.githubRepoUrl);
    else if (localRepo && !data.githubRepoUrl) {
      try {
        await fetchJson("/api/ai/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ githubRepoUrl: localRepo }),
        });
      } catch {
        /* server sync optional */
      }
    }

    applyProviderModels(data, data.provider || "openai");
    onConfiguredChange?.(data);
    return data;
  };

  const loadGithubStatus = async () => {
    try {
      const data = await fetchJson("/api/ai/github/status");
      setGithubStatus(data);
    } catch {
      setGithubStatus(null);
    }
  };

  useEffect(() => {
    loadConfig()
      .then(() => loadGithubStatus())
      .catch((err) => {
        setMessage(String(err));
        setMessageType("err");
      });
    fetchJson("/api/health")
      .then((data) => setAiScope(data.aiScope || null))
      .catch(() => setAiScope(null));
    fetchJson("/api/reports")
      .then((data) => setSavedReports(data.reports || []))
      .catch(() => setSavedReports([]));
  }, []);

  useEffect(() => {
    onBusyChange?.(loading);
  }, [loading, onBusyChange]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useLayoutEffect(() => {
    window.DevHelperMarkdown?.enhance(chatLogRef.current);
  }, [messages]);

  const onProviderChange = (next) => {
    setProvider(next);
    if (config?.supportedProviders) {
      applyProviderModels(config, next);
      const p = config.supportedProviders.find((x) => x.id === next);
      if (p) setModel(p.models[0]);
    }
  };

  const saveKey = async () => {
    setLoading(true);
    setMessage("");
    try {
      const activeProvider = config?.forcedProvider || provider;
      const body = { provider: activeProvider, model };
      if (apiKeyInput.trim().startsWith("sk-proj-") && activeProvider !== "openai") {
        throw new Error(
          "That looks like an OpenAI key (no quota). Use OpenRouter provider or paste your sk-or-v1-... key."
        );
      }
      if (apiKeyInput.trim()) body.apiKey = apiKeyInput.trim();
      body.githubRepoUrl = githubRepoInput.trim();
      if (body.githubRepoUrl) saveGithubRepoToLocal(body.githubRepoUrl);
      else clearGithubRepoLocal();
      const data = await fetchJson("/api/ai/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setApiKeyInput("");
      await loadConfig();
      await loadGithubStatus();
      setMessage(`${data.providerLabel} settings saved.`);
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const clearKey = async () => {
    if (!confirm("Remove API key stored in .ai-config.json? (.env keys are unchanged)")) return;
    setLoading(true);
    setMessage("");
    try {
      await fetchJson("/api/ai/config", { method: "DELETE" });
      await loadConfig();
      setMessage("Stored API key cleared.");
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const testKey = async () => {
    setLoading(true);
    setMessage(`Testing ${config?.providerLabel || "AI"} API...`);
    setMessageType("info");
    try {
      const data = await fetchJson("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          provider: config?.forcedProvider || config?.provider || provider,
        }),
      });
      setMessage(`Connected via ${data.provider} (${data.model}): ${data.reply}`);
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text) return;
    if (aiScope && !aiScope.chatEnabled) {
      const hint =
        aiScope.chatDisabledReason ||
        "AI chat is disabled. Add chat to AI_SCOPE in .env and restart npm start.";
      setMessage(hint);
      setMessageType("err");
      setMessages([
        ...messages,
        { role: "user", content: text },
        {
          role: "assistant",
          content: `**Chat is disabled.**\n\n${hint}`,
        },
      ]);
      return;
    }
    if (!config?.configured) {
      setMessage("Add an API key in API Settings first.");
      setMessageType("err");
      return;
    }

    const pending = [
      ...messages,
      { role: "user", content: text },
      {
        role: "assistant",
        content: useLivePanel
          ? "_Browsing Shipmozo panel… (usually 45–75 seconds)_"
          : "_Searching saved manuals and generating answer…_",
        pending: true,
      },
    ];
    setMessages(pending);
    setChatInput("");
    setLoading(true);
    setMessageType("info");
    const started = Date.now();
    const tick = setInterval(() => {
      const sec = Math.floor((Date.now() - started) / 1000);
      setMessage(
        useLivePanel
          ? `Browsing Shipmozo panel and capturing screenshots… (${sec}s)`
          : `Generating answer from saved docs… (${sec}s)`
      );
    }, 1000);
    setMessage(
      useLivePanel
        ? "Browsing Shipmozo panel (up to 2 module pages)… (0s)"
        : "Searching saved PRDs and user manuals… (0s)"
    );

    try {
      const serverCheck = await window.DevHelperApi.checkServer();
      if (!serverCheck.ok) {
        throw new Error(serverCheck.error || "Backend not running. Run npm start first.");
      }

      const payloadMessages = pending
        .filter((m) => !m.pending && (m.role === "user" || m.role === "assistant"))
        .map(({ role, content }) => ({ role, content }));

      let browsePayload = null;
      if (useLivePanel) {
        setMessage("Step 1/2: Browsing Shipmozo panel and capturing screenshots…");
        const browseData = await fetchJson("/api/ai/chat/browse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          timeoutMs: 180000,
          body: JSON.stringify({ query: text }),
        });
        browsePayload = browseData.browse;
        setMessage("Step 2/2: Generating answer from live panel data…");
      } else {
        setMessage("Generating answer from saved PRD / user manual…");
      }

      const chatBody = {
        messages: payloadMessages,
        model,
        provider: config?.provider || provider,
        useLivePanel,
        includeHealLessons: true,
      };
      if (reportSessionId) chatBody.reportSessionId = reportSessionId;
      if (browsePayload) chatBody.browse = browsePayload;

      const data = await fetchJson("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: useLivePanel ? 180000 : 120000,
        body: JSON.stringify(chatBody),
      });
      setMessage("");
      const screenshots = normalizeShotList(
        data.screenshots || data.livePanel?.screenshots || []
      );
      const answer = buildAssistantContent(data.reply, screenshots);
      setMessages([
        ...messages,
        { role: "user", content: text },
        {
          role: "assistant",
          content: answer,
          livePanel: data.livePanel,
          screenshots,
        },
      ]);
    } catch (err) {
      const errText = String(err);
      setMessage(errText);
      setMessageType("err");
      setMessages([
        ...messages,
        { role: "user", content: text },
        {
          role: "assistant",
          content: `**Could not complete request.**\n\n${errText}\n\nCheck that \`npm start\` is running.${useLivePanel ? " For live panel mode, SHIPMOZO_EMAIL / SHIPMOZO_PASSWORD must be set in .env." : " Generate docs in Module Docs if no saved manual matches."}`,
        },
      ]);
    } finally {
      clearInterval(tick);
      setLoading(false);
    }
  };

  const clearChat = () => {
    if (!confirm("Clear chat history?")) return;
    const fresh = [{ role: "assistant", content: "Chat cleared. How can I help?" }];
    setMessages(fresh);
    window.DevHelperStorage?.saveJson(CHAT_KEY, fresh);
  };

  const clearGithubRepo = async () => {
    if (!confirm("Remove saved GitHub repo URL from this browser and server config?")) return;
    clearGithubRepoLocal();
    setGithubRepoInput("");
    setGithubStatus(null);
    setLoading(true);
    try {
      await fetchJson("/api/ai/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubRepoUrl: "" }),
      });
      await loadGithubStatus();
      setMessage("GitHub repo URL removed.");
      setMessageType("ok");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const refreshGithubIndex = async () => {
    setLoading(true);
    setMessage("Refreshing GitHub repo index…");
    setMessageType("info");
    try {
      const data = await fetchJson("/api/ai/github/refresh", { method: "POST", timeoutMs: 60000 });
      setGithubStatus(data);
      setMessage(data.message || "GitHub index refreshed.");
      setMessageType(data.ok ? "ok" : "err");
    } catch (err) {
      setMessage(String(err));
      setMessageType("err");
    } finally {
      setLoading(false);
    }
  };

  const activeProviderMeta = providerList.find((p) => p.id === provider) || providerList[0] || {};

  const githubCard = (
    <div className="card">
      <div className="card-header">
        <div>
          <h2>Panel source code (GitHub)</h2>
          <p className="hint" style={{ marginTop: 4 }}>
            Public panel repo for PRDs, manuals, and tests. Saved in this browser until you remove it.
            GitHub may be older than production — live panel + Ctrl+B Quick Search win over stale routes.
          </p>
        </div>
        {githubStatus?.ok && (
          <span className="badge">{githubStatus.pathCount || 0} files indexed</span>
        )}
      </div>

      <label className="field">Public repository URL</label>
      <input
        type="url"
        value={githubRepoInput}
        onChange={(e) => {
          const v = e.target.value;
          setGithubRepoInput(v);
          if (v.trim()) saveGithubRepoToLocal(v);
        }}
        placeholder="https://github.com/org/shipmozo-panel"
        autoComplete="off"
      />
      <p className="hint">
        Example: <code>https://github.com/your-org/merchant-panel</code> — must be <strong>public</strong>.
        Optional: set <code>GITHUB_TOKEN</code> in <code>.env</code> for higher API limits.
      </p>

      {githubStatus && (
        <p className={`hint ${githubStatus.ok ? "" : ""}`} style={{ marginTop: 8 }}>
          {githubStatus.ok
            ? `${githubStatus.message} · branch ${githubStatus.branch}`
            : githubStatus.message}
          {githubStatus.hint ? ` · ${githubStatus.hint}` : ""}
        </p>
      )}

      <div className="toolbar" style={{ marginTop: 12 }}>
        <button className="muted" onClick={refreshGithubIndex} disabled={loading || !githubRepoInput.trim()}>
          Refresh repo index
        </button>
        <button className="muted" onClick={clearGithubRepo} disabled={loading || !githubRepoInput.trim()}>
          Remove repo URL
        </button>
      </div>
    </div>
  );

  const settingsCard = (
    <div className="card">
      <div className="card-header">
        <div>
          <h2>AI provider</h2>
          <p className="hint" style={{ marginTop: 4 }}>
            OpenAI, Azure OpenAI, Gemini, OpenRouter, or Claude — keys in <code>.env</code> or below.
          </p>
        </div>
        <div>
          <span className={`badge ${config?.configured ? "" : "badge-muted"}`}>
            {config?.configured
              ? `${config.providerLabel} ready`
              : "API key missing"}
          </span>
        </div>
      </div>

      {config?.maskedKey && (
        <p className="hint" style={{ marginTop: 0 }}>
          Active key: <code>{config.maskedKey}</code>
          {config?.source ? ` · source: ${config.source}` : ""}
        </p>
      )}

      <div className="settings-grid">
        <div>
          <label className="field">Provider</label>
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value)}
            disabled={Boolean(config?.forcedProvider)}
          >
            {providerList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field">Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      {config?.forcedProvider && (
        <p className="hint">
          Provider locked to <b>{config.providerLabel}</b> via <code>AI_PROVIDER</code> in{" "}
          <code>.env</code>.
        </p>
      )}
      {activeProviderMeta.docsUrl && (
        <p className="hint">
          Get a key:{" "}
          <a href={activeProviderMeta.docsUrl} target="_blank" rel="noreferrer">
            {activeProviderMeta.docsUrl}
          </a>
        </p>
      )}
      {activeProviderMeta.setupHint && (
        <p className="hint">{activeProviderMeta.setupHint}</p>
      )}

      <label className="field">API key</label>
      <input
        type="password"
        value={apiKeyInput}
        onChange={(e) => setApiKeyInput(e.target.value)}
        placeholder={activeProviderMeta.keyHint || config?.keyHint || "API key"}
        autoComplete="off"
      />

      <div className="toolbar" style={{ marginTop: 16 }}>
        <button className="primary" onClick={saveKey} disabled={loading}>
          Save settings
        </button>
        <button className="muted" onClick={testKey} disabled={loading}>
          Test connection
        </button>
        <button className="danger" onClick={clearKey} disabled={loading}>
          Clear stored key
        </button>
      </div>
    </div>
  );

  const chatCard = (
    <div className="card chat-card">
      {aiScope && !aiScope.chatEnabled && (
        <div className="alert alert-info" style={{ margin: "0 0 12px" }}>
          Chat is disabled — not in <code>AI_SCOPE</code>. Add{" "}
          <code>chat</code> to <code>AI_SCOPE</code> in <code>.env</code> (e.g.{" "}
          <code>AI_SCOPE=script_debug,testcase_gen,report_gen,chat</code>) and restart{" "}
          <code>npm start</code>.
        </div>
      )}
      <div className="chat-log" ref={chatLogRef}>
        {messages.map((msg, idx) => {
          const msgShots = normalizeShotList(
            msg.screenshots || msg.livePanel?.screenshots || []
          );
          const displayContent =
            msg.role === "assistant"
              ? buildAssistantContent(msg.content, msgShots)
              : msg.content;
          const usedManual = msg.livePanel?.usedSavedManual || msg.livePanel?.knowledgeMode;
          const showGallery =
            msg.role === "assistant" &&
            msgShots.length > 0 &&
            (!replyHasWorkingImages(displayContent) || usedManual);

          return (
          <div key={idx} className={`chat-msg ${msg.role}`}>
            <div className="chat-avatar">{msg.role === "user" ? "You" : "AI"}</div>
            <div className="chat-bubble">
              {msg.role === "assistant" ? (
                <article
                  className="markdown-body"
                  dangerouslySetInnerHTML={{
                  __html:
                    window.DevHelperMarkdown?.parse(displayContent || "") ||
                    marked.parse(displayContent || ""),
                }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
              )}
              {showGallery && <ChatScreenshotGallery screenshots={msgShots} />}
              {msg.livePanel?.used && (
                <div className="chat-meta">
                  Live panel
                  {msg.livePanel.pageCount ? ` · ${msg.livePanel.pageCount} page(s)` : ""}
                  {msg.livePanel.screenshots?.length
                    ? ` · ${msg.livePanel.screenshots.length} screenshot(s)`
                    : ""}
                  {msg.livePanel.visitedPages?.length
                    ? ` · ${msg.livePanel.visitedPages.join(", ")}`
                    : ""}
                </div>
              )}
              {!msg.livePanel?.used &&
                (msg.livePanel?.usedSavedManual || msg.livePanel?.knowledgeMode) && (
                <div className="chat-meta">
                  Saved docs
                  {msg.livePanel.savedManualModules?.length
                    ? ` · ${msg.livePanel.savedManualModules.join(", ")}`
                    : ""}
                  {msg.livePanel.reportSessionId
                    ? ` · session ${msg.livePanel.reportSessionId}`
                    : ""}
                  {msg.livePanel.screenshots?.length
                    ? ` · ${msg.livePanel.screenshots.length} screenshot(s)`
                    : ""}
                </div>
              )}
            </div>
          </div>
          );
        })}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-composer">
        <div className="toolbar" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
          <label className="checkbox-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={useLivePanel}
              onChange={(e) => setUseLivePanel(e.target.checked)}
              disabled={loading}
            />
            Use live panel (slow)
          </label>
          {savedReports.length > 0 && (
            <select
              value={reportSessionId}
              onChange={(e) => setReportSessionId(e.target.value)}
              disabled={loading}
              style={{ maxWidth: 280 }}
              title="Pin a saved report as chat context"
            >
              <option value="">Auto-match saved reports</option>
              {savedReports.map((r) => (
                <option key={r.sessionId} value={r.sessionId}>
                  {r.moduleName || "Module"} — {r.sessionId}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="hint" style={{ margin: "0 0 8px" }}>
          {useLivePanel
            ? "Live mode opens Chromium, logs into the panel, and captures fresh screenshots (~1–2 min)."
            : "Uses saved PRD + user manual from Module Docs / Reports. Generate docs there first if nothing matches."}
        </p>
        <textarea
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          placeholder="Ask about billing, orders, Shopify integration…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              sendChat();
            }
          }}
        />
        <div className="toolbar">
          <button className="primary" onClick={sendChat} disabled={loading}>
            {loading ? (useLivePanel ? "Browsing panel…" : "Thinking…") : "Send"}
          </button>
          <button className="muted" onClick={clearChat} disabled={loading}>
            Clear chat
          </button>
          <span className="hint" style={{ margin: 0 }}>
            Ctrl+Enter to send
            {useLivePanel ? " · ~2 min per question" : " · usually under 30s"}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      {!hideSettings && githubCard}
      {!hideSettings && settingsCard}
      {message && (
        <div className={`alert alert-${messageType === "ok" ? "success" : messageType === "err" ? "error" : "info"}`}>
          {message}
        </div>
      )}
      {!settingsOnly && chatCard}
    </div>
  );
}
