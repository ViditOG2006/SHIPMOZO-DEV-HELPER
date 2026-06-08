const { getApiKey, getModel, resolveProvider } = require("./ai-config");
const { getProviderDef } = require("./providers");

const MAX_OUTPUT_TOKENS = 8192;

function noKeyError(provider) {
  const def = getProviderDef(provider);
  const err = new Error(
    `No API key for ${def.label}. Set ${def.envKey} in .env or save a key in API Settings.`
  );
  err.code = "NO_API_KEY";
  return err;
}

function normalizeMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: String(system) });
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    out.push({ role, content: String(m.content || "") });
  }
  return out;
}

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 120000);

async function callOpenAICompatible({
  url,
  apiKey,
  model,
  messages,
  maxTokens,
  extraHeaders = {},
  jsonMode = false,
}) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message || data?.message || `API error (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const text = data.choices?.[0]?.message?.content?.trim() || "";
  return {
    text,
    model: data.model || model,
    usage: data.usage,
    stop_reason: data.choices?.[0]?.finish_reason,
  };
}

async function callClaudeApi({ apiKey, model, messages, system, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
  };
  const systemMsg = system || messages.find((m) => m.role === "system")?.content;
  if (systemMsg) body.system = String(systemMsg);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message || data?.message || `Anthropic API error (${res.status})`;
    throw new Error(msg);
  }
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return {
    text,
    model: data.model,
    usage: data.usage,
    stop_reason: data.stop_reason,
  };
}

async function callGeminiApi({ apiKey, model, messages, maxTokens }) {
  const parts = [];
  for (const m of messages) {
    if (m.role === "system") {
      parts.push({ text: `System: ${m.content}\n` });
      continue;
    }
    parts.push({
      text: `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}\n`,
    });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message || data?.message || `Gemini API error (${res.status})`;
    throw new Error(msg);
  }
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("")
    .trim();
  return {
    text,
    model,
    usage: data.usageMetadata,
    stop_reason: data.candidates?.[0]?.finishReason,
  };
}

async function callLLM({ messages, system, maxTokens = 2048, model, provider, jsonMode = false }) {
  const active = resolveProvider(provider);
  const apiKey = getApiKey(active);
  if (!apiKey) throw noKeyError(active);

  let chosenModel = model || getModel(active);
  if (active === "openrouter" && chosenModel && !chosenModel.includes("/")) {
    chosenModel = `openai/${chosenModel}`;
  }
  const capped = Math.min(maxTokens, MAX_OUTPUT_TOKENS);
  const normalized = normalizeMessages(messages, system);

  let result;
  switch (active) {
    case "openai":
      result = await callOpenAICompatible({
        url: "https://api.openai.com/v1/chat/completions",
        apiKey,
        model: chosenModel,
        messages: normalized,
        maxTokens: capped,
        jsonMode,
      });
      break;
    case "openrouter":
      result = await callOpenAICompatible({
        url: "https://openrouter.ai/api/v1/chat/completions",
        apiKey,
        model: chosenModel,
        messages: normalized,
        maxTokens: capped,
        jsonMode,
        extraHeaders: {
          "HTTP-Referer": process.env.PUBLIC_BASE_URL || "http://localhost:3000",
          "X-Title": "Shipmozo Dev Helper",
        },
      });
      break;
    case "gemini":
      result = await callGeminiApi({
        apiKey,
        model: chosenModel,
        messages: normalized,
        maxTokens: capped,
      });
      break;
    case "claude":
    default:
      result = await callClaudeApi({
        apiKey,
        model: chosenModel,
        messages: normalized,
        system,
        maxTokens: capped,
      });
      break;
  }

  return { ...result, provider: active };
}

async function testConnection(model, provider) {
  const result = await callLLM({
    model,
    provider,
    maxTokens: 64,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
  });
  return {
    ok: true,
    reply: result.text,
    model: result.model,
    provider: result.provider,
  };
}

module.exports = {
  callLLM,
  testConnection,
  MAX_OUTPUT_TOKENS,
};
