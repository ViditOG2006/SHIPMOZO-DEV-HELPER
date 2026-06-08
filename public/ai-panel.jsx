const { useEffect, useState, useRef, useLayoutEffect } = React;

const FALLBACK_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    keyHint: "sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
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
  {
    id: "claude",
    label: "Claude (Anthropic)",
    models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
    keyHint: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/",
  },
];

const CHAT_KEY = window.DevHelperStorage?.KEYS?.CHAT || "shipmozo-chat-v1";
const DEFAULT_CHAT = [
  {
    role: "assistant",
    content:
        "Ask about any Shipmozo module — billing, Shopify integration, orders, etc. I scan the **whole panel sidebar**, open matching pages, and reply with steps and screenshots from each page.",
  },
];

const fetchJson = (path, options) => window.DevHelperApi.fetchJson(path, options);

function loadChatMessages() {
  const saved = window.DevHelperStorage?.loadJson(CHAT_KEY, null);
  if (Array.isArray(saved) && saved.length) return saved;
  return DEFAULT_CHAT;
}

function AiPanel({ hideSettings = false, settingsOnly = false, onConfiguredChange, onBusyChange }) {
  const [config, setConfig] = useState(null);
  const [provider, setProvider] = useState("openrouter");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [modelOptions, setModelOptions] = useState(["openai/gpt-4o-mini"]);
  const [messages, setMessages] = useState(loadChatMessages);
  const [chatInput, setChatInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("info");
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
    const data = await fetchJson("/api/ai/config");
    setConfig(data);
    if (data.provider) setProvider(data.provider);
    if (data.model) setModel(data.model);
    if (data.models?.length) setModelOptions(data.models);
    applyProviderModels(data, data.provider || "openai");
    onConfiguredChange?.(data);
    return data;
  };

  useEffect(() => {
    loadConfig().catch((err) => {
      setMessage(String(err));
      setMessageType("err");
    });
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
      const data = await fetchJson("/api/ai/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setApiKeyInput("");
      await loadConfig();
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
    if (!config?.configured) {
      setMessage("Add an API key in API Settings first.");
      setMessageType("err");
      return;
    }

    const pending = [
      ...messages,
      { role: "user", content: text },
      { role: "assistant", content: "_Browsing Shipmozo panel… (usually 45–75 seconds)_", pending: true },
    ];
    setMessages(pending);
    setChatInput("");
    setLoading(true);
    setMessageType("info");
    const started = Date.now();
    const tick = setInterval(() => {
      const sec = Math.floor((Date.now() - started) / 1000);
      setMessage(`Browsing Shipmozo panel and capturing screenshots… (${sec}s)`);
    }, 1000);
    setMessage("Browsing Shipmozo panel (up to 2 module pages)… (0s)");

    try {
      const serverCheck = await window.DevHelperApi.checkServer();
      if (!serverCheck.ok) {
        throw new Error(serverCheck.error || "Backend not running. Run npm start first.");
      }

      const payloadMessages = pending
        .filter((m) => !m.pending && (m.role === "user" || m.role === "assistant"))
        .map(({ role, content }) => ({ role, content }));
      const data = await fetchJson("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 300000,
        body: JSON.stringify({
          messages: payloadMessages,
          model,
          provider: config?.provider || provider,
          useLivePanel: true,
        }),
      });
      setMessage("");
      const answer = (data.reply || "").trim() || "No reply received from AI.";
      setMessages([
        ...messages,
        { role: "user", content: text },
        {
          role: "assistant",
          content: answer,
          livePanel: data.livePanel,
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
          content: `**Could not complete request.**\n\n${errText}\n\nCheck that \`npm start\` is running and SHIPMOZO_EMAIL / SHIPMOZO_PASSWORD are set in .env.`,
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

  const activeProviderMeta = providerList.find((p) => p.id === provider) || providerList[0] || {};

  const settingsCard = (
    <div className="card">
      <div className="card-header">
        <div>
          <h2>AI provider</h2>
          <p className="hint" style={{ marginTop: 4 }}>
            OpenAI, Gemini, OpenRouter, or Claude — keys in <code>.env</code> or below.
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
      <div className="chat-log" ref={chatLogRef}>
        {messages.map((msg, idx) => (
          <div key={idx} className={`chat-msg ${msg.role}`}>
            <div className="chat-avatar">{msg.role === "user" ? "You" : "AI"}</div>
            <div className="chat-bubble">
              {msg.role === "assistant" ? (
                <article
                  className="markdown-body"
                  dangerouslySetInnerHTML={{
                  __html:
                    window.DevHelperMarkdown?.parse(msg.content || "") ||
                    marked.parse(msg.content || ""),
                }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
              )}
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
                  {msg.livePanel.usedSavedManual && msg.livePanel.savedManualModules?.length
                    ? ` · + manual: ${msg.livePanel.savedManualModules.join(", ")}`
                    : ""}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-composer">
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
            {loading ? "Browsing panel…" : "Send"}
          </button>
          <button className="muted" onClick={clearChat} disabled={loading}>
            Clear chat
          </button>
          <span className="hint" style={{ margin: 0 }}>Ctrl+Enter to send · ~2 min per question</span>
        </div>
      </div>
    </div>
  );

  return (
    <div>
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
