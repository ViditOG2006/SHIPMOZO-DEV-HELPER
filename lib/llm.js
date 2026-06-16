const { getApiKey, getModel, resolveProvider, resolveChatProvider, resolveChatModel } = require("./ai-config");
const {
  getProviderDef,
  readProviderEndpoint,
  readProviderApiVersion,
  isAzureOpenAiEnvReady,
} = require("./providers");
const { assertAiScope } = require("./ai-scope");
const { withClaudeThrottle } = require("./llm-throttle");

function clodChatUrl(def) {
  const base = String(process.env[def.baseUrlEnv] || "https://api.clod.io/v1").replace(/\/$/, "");
  return `${base}/chat/completions`;
}

function azureOpenAIChatUrl(def, deployment) {
  const endpoint = readProviderEndpoint(def).replace(/\/$/, "");
  const apiVersion = readProviderApiVersion(def);
  const dep = encodeURIComponent(deployment);
  const ver = encodeURIComponent(apiVersion);
  return `${endpoint}/openai/deployments/${dep}/chat/completions?api-version=${ver}`;
}

const MAX_OUTPUT_TOKENS = 8192;

function isOpenRouterCreditsError(message) {
  return /more credits|can only afford|insufficient credits|prompt tokens limit exceeded|tokens limit exceeded/i.test(
    String(message || "")
  );
}

const CREDITS_RETRY_MIN_TOKENS = 128;

/** Parse "can only afford 7856" from OpenRouter 402-style errors. */
function parseAffordableMaxTokens(message) {
  const m = String(message || "").match(/can only afford\s+(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function creditsTooLowForDataset(affordable) {
  return affordable != null && affordable < 512;
}

async function callOpenRouterWithCreditRetry(params) {
  let tokens = params.maxTokens;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callOpenAICompatible({ ...params, maxTokens: tokens });
    } catch (err) {
      if (isOpenRouterCreditsError(err.message)) {
        const affordable = parseAffordableMaxTokens(err.message);
        err.affordableMaxTokens = affordable;
        if (
          affordable != null &&
          affordable < tokens &&
          affordable >= CREDITS_RETRY_MIN_TOKENS
        ) {
          tokens = Math.floor(affordable * 0.95);
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error("OpenRouter request failed after credit retry");
}

function noKeyError(provider) {
  const def = getProviderDef(provider);
  let msg = `No API key for ${def.label}. Set ${def.envKey} in .env or save a key in API Settings.`;
  if (provider === "azure-openai") {
    msg =
      `Azure OpenAI not configured. Set ${def.envKey}, ${def.endpointEnv}, and ${def.modelEnv} in .env ` +
      `(chat deployment name, e.g. gpt-4.1-mini — not text-embedding-3-small).`;
  }
  const err = new Error(msg);
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

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 600000);

async function callOpenAICompatible({
  url,
  apiKey,
  model,
  messages,
  maxTokens,
  extraHeaders = {},
  authHeader,
  jsonMode = false,
  timeoutMs,
}) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const headers = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (authHeader) {
    Object.assign(headers, authHeader);
  } else {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || LLM_TIMEOUT_MS),
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

async function callClaudeApi({ apiKey, model, messages, system, maxTokens, timeoutMs }) {
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
    signal: AbortSignal.timeout(timeoutMs || LLM_TIMEOUT_MS),
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
    const err = new Error(msg);
    err.status = res.status;
    err.isModelError = /model/i.test(msg) && res.status === 404;
    throw err;
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

async function callGeminiApi({ apiKey, model, messages, maxTokens, timeoutMs }) {
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
    signal: AbortSignal.timeout(timeoutMs || LLM_TIMEOUT_MS),
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

async function callLLM({
  messages,
  system,
  maxTokens = 2048,
  model,
  provider,
  jsonMode = false,
  timeoutMs,
  scope,
}) {
  if (scope) assertAiScope(scope);

  let active = resolveProvider(provider);
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
        timeoutMs,
      });
      break;
    case "azure-openai": {
      const azureDef = getProviderDef("azure-openai");
      const endpoint = readProviderEndpoint(azureDef);
      if (!endpoint) {
        const err = new Error(
          `Azure OpenAI endpoint missing. Set ${azureDef.endpointEnv} in .env (e.g. https://your-resource.cognitiveservices.azure.com).`
        );
        err.code = "NO_API_KEY";
        throw err;
      }
      result = await callOpenAICompatible({
        url: azureOpenAIChatUrl(azureDef, chosenModel),
        apiKey,
        model: chosenModel,
        messages: normalized,
        maxTokens: capped,
        jsonMode,
        timeoutMs,
        authHeader: { "api-key": apiKey },
      });
      break;
    }
    case "openrouter":
      result = await callOpenRouterWithCreditRetry({
        url: "https://openrouter.ai/api/v1/chat/completions",
        apiKey,
        model: chosenModel,
        messages: normalized,
        maxTokens: capped,
        jsonMode,
        timeoutMs,
        extraHeaders: {
          "HTTP-Referer": process.env.PUBLIC_BASE_URL || "http://localhost:3000",
          "X-Title": "Shipmozo Dev Helper",
        },
      });
      break;
    case "clod": {
      const clodDef = getProviderDef("clod");
      result = await callOpenAICompatible({
        url: clodChatUrl(clodDef),
        apiKey,
        model: chosenModel,
        messages: normalized,
        maxTokens: capped,
        jsonMode,
        timeoutMs,
      });
      break;
    }
    case "gemini":
      result = await callGeminiApi({
        apiKey,
        model: chosenModel,
        messages: normalized,
        maxTokens: capped,
        timeoutMs,
      });
      break;
    case "claude":
    default: {
      const claudeFallbacks = [
        chosenModel,
        "claude-sonnet-4-5-20250929",
        "claude-3-5-sonnet-20241022",
      ].filter((m, i, a) => m && a.indexOf(m) === i);
      let lastErr;
      for (const modelTry of claudeFallbacks) {
        try {
          result = await withClaudeThrottle({
            messages: normalized,
            system,
            maxTokens: capped,
            fn: ({ messages: m, system: s } = {}) =>
              callClaudeApi({
                apiKey,
                model: modelTry,
                messages: m || normalized,
                system: s !== undefined ? s : system,
                maxTokens: capped,
                timeoutMs,
              }),
          });
          break;
        } catch (err) {
          lastErr = err;
          if (!err.isModelError && !/model/i.test(err.message)) throw err;
        }
      }
      if (!result) {
        if (isAzureOpenAiEnvReady() && active === "claude") {
          const azureDef = getProviderDef("azure-openai");
          const azureKey = getApiKey("azure-openai");
          const azureModel = resolveChatModel("azure-openai");
          const endpoint = readProviderEndpoint(azureDef);
          result = await callOpenAICompatible({
            url: azureOpenAIChatUrl(azureDef, azureModel),
            apiKey: azureKey,
            model: azureModel,
            messages: normalized,
            maxTokens: capped,
            jsonMode,
            timeoutMs,
            authHeader: { "api-key": azureKey },
          });
          active = "azure-openai";
        } else {
          throw lastErr;
        }
      }
      break;
    }
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
  isOpenRouterCreditsError,
  parseAffordableMaxTokens,
  creditsTooLowForDataset,
  CREDITS_RETRY_MIN_TOKENS,
};
