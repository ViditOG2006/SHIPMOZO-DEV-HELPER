const PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    keyHint: "sk-... or sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  "azure-openai": {
    id: "azure-openai",
    label: "Azure OpenAI",
    envKey: "AZURE_OPENAI_API_KEY",
    modelEnv: "AZURE_OPENAI_DEPLOYMENT",
    endpointEnv: "AZURE_OPENAI_ENDPOINT",
    apiVersionEnv: "AZURE_OPENAI_API_VERSION",
    defaultApiVersion: "2024-12-01-preview",
    defaultModel: "gpt-4.1-mini",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    keyHint: "Azure OpenAI API key (Keys and Endpoint)",
    docsUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
    setupHint:
      "Requires a chat deployment (e.g. gpt-4.1-mini). Embedding deployments such as text-embedding-3-small will not work.",
  },
  claude: {
    id: "claude",
    label: "Claude (Anthropic)",
    envKey: "ANTHROPIC_API_KEY",
    altEnvKeys: ["CLAUDE_API_KEY"],
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-4-5-20250929",
    models: [
      "claude-sonnet-4-5-20250929",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
    keyHint: "sk-ant-api03-...",
    docsUrl: "https://console.anthropic.com/",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    altEnvKeys: ["GOOGLE_API_KEY"],
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-1.5-flash",
    models: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"],
    keyHint: "AIza...",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (many models)",
    envKey: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "openai/gpt-4o-mini",
    models: [
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
      "anthropic/claude-3.5-sonnet",
      "google/gemini-flash-1.5",
    ],
    keyHint: "sk-or-...",
    docsUrl: "https://openrouter.ai/keys",
  },
  clod: {
    id: "clod",
    label: "CLōD (OpenAI-compatible)",
    envKey: "CLOD_API_KEY",
    altEnvKeys: ["CLOD_API_TOKEN"],
    modelEnv: "CLOD_MODEL",
    baseUrlEnv: "CLOD_API_BASE_URL",
    defaultModel: "OpenAI/gpt-oss-20B",
    models: [
      "OpenAI/gpt-oss-20B",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gpt-4.1",
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    ],
    keyHint: "JWT from clod.io dashboard",
    docsUrl: "https://clod.io/docs/openai-sdk",
  },
};

function getProviderDef(providerId) {
  return PROVIDERS[providerId] || PROVIDERS.openai;
}

function readEnvKey(def) {
  const primary = process.env[def.envKey];
  if (primary && String(primary).trim()) return String(primary).trim();
  for (const alt of def.altEnvKeys || []) {
    const v = process.env[alt];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

function readEnvVar(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : "";
}

function readProviderEndpoint(def) {
  return def.endpointEnv ? readEnvVar(def.endpointEnv) : "";
}

function readProviderApiVersion(def) {
  if (!def.apiVersionEnv) return "";
  return readEnvVar(def.apiVersionEnv) || def.defaultApiVersion || "";
}

function isAzureOpenAiEnvReady() {
  const def = PROVIDERS["azure-openai"];
  return Boolean(
    readEnvKey(def) && readProviderEndpoint(def) && readEnvVar(def.modelEnv)
  );
}

function detectProviderFromEnv() {
  const order = ["claude", "openai", "azure-openai", "openrouter", "clod", "gemini"];
  for (const id of order) {
    const def = PROVIDERS[id];
    if (id === "azure-openai") {
      if (isAzureOpenAiEnvReady()) return id;
      continue;
    }
    if (readEnvKey(def)) return id;
  }
  return null;
}

module.exports = {
  PROVIDERS,
  getProviderDef,
  readEnvKey,
  readEnvVar,
  readProviderEndpoint,
  readProviderApiVersion,
  isAzureOpenAiEnvReady,
  detectProviderFromEnv,
};
