const fs = require("fs");
const path = require("path");
const {
  PROVIDERS,
  getProviderDef,
  readEnvKey,
  readEnvVar,
  readProviderEndpoint,
  isAzureOpenAiEnvReady,
  detectProviderFromEnv,
} = require("./providers");
const { getAiScopeStatus } = require("./ai-scope");

const CONFIG_PATH = path.join(__dirname, "..", ".ai-config.json");

function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfigFile(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function maskApiKey(key) {
  if (!key || key.length < 8) return key ? "••••" : "";
  return `${key.slice(0, 7)}••••${key.slice(-4)}`;
}

function getForcedProvider() {
  const forced = process.env.AI_PROVIDER;
  return forced && PROVIDERS[forced] ? forced : null;
}

function resolveProvider(explicit) {
  if (explicit && PROVIDERS[explicit]) return explicit;

  const forced = getForcedProvider();
  if (forced) return forced;

  const file = readConfigFile();
  if (file.provider && PROVIDERS[file.provider]) return file.provider;
  return detectProviderFromEnv() || "claude";
}

function isProviderConfigured(providerId, apiKey) {
  if (!apiKey) return false;
  if (providerId === "azure-openai") {
    const def = getProviderDef("azure-openai");
    const endpoint = readProviderEndpoint(def);
    const file = readConfigFile();
    const deployment =
      readEnvVar(def.modelEnv) ||
      (file.provider === "azure-openai" && file.model) ||
      "";
    return Boolean(endpoint && String(deployment).trim());
  }
  return true;
}

function getApiKey(providerId) {
  const provider = resolveProvider(providerId);
  const def = getProviderDef(provider);
  const fromEnv = readEnvKey(def);
  if (fromEnv) return fromEnv;
  const file = readConfigFile();
  if (file.provider === provider && file.apiKey) {
    return String(file.apiKey).trim();
  }
  return "";
}

function getModel(providerId) {
  const provider = resolveProvider(providerId);
  const def = getProviderDef(provider);
  const file = readConfigFile();
  const fromEnv = process.env[def.modelEnv];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  if (file.provider === provider && file.model) return file.model;
  return def.defaultModel;
}

function getConfigStatus() {
  const provider = resolveProvider();
  const def = getProviderDef(provider);
  const apiKey = getApiKey(provider);
  const model = getModel(provider);
  const file = readConfigFile();

  const fromEnv = Boolean(readEnvKey(def));
  const source = fromEnv ? "env" : file.apiKey ? "file" : "none";

  const available = Object.keys(PROVIDERS).map((id) => ({
    id,
    label: PROVIDERS[id].label,
    configured: isProviderConfigured(id, getApiKey(id)),
    hasEnvKey: id === "azure-openai" ? isAzureOpenAiEnvReady() : Boolean(readEnvKey(getProviderDef(id))),
  }));

  const githubRepoUrl = getGithubRepoUrl();

  return {
    provider,
    providerLabel: def.label,
    forcedProvider: getForcedProvider(),
    configured: isProviderConfigured(provider, apiKey),
    maskedKey: maskApiKey(apiKey),
    model,
    source,
    githubRepoUrl,
    defaultModel: def.defaultModel,
    models: def.models,
    keyHint: def.keyHint,
    docsUrl: def.docsUrl,
    providers: available,
    supportedProviders: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      models: p.models,
      keyHint: p.keyHint,
      docsUrl: p.docsUrl,
      setupHint: p.setupHint,
    })),
    aiScope: getAiScopeStatus(),
    reportLlmSplit: require("./report-llm-split").getReportLlmSplitStatus(),
    chatProvider: resolveChatProvider(),
    chatModel: resolveChatModel(resolveChatProvider()),
  };
}

function resolveChatProvider(explicit) {
  const chatEnv = String(process.env.CHAT_PROVIDER || "").trim();
  if (chatEnv && PROVIDERS[chatEnv]) return chatEnv;
  if (explicit && PROVIDERS[explicit]) return explicit;
  if (isAzureOpenAiEnvReady()) return "azure-openai";
  return resolveProvider();
}

function resolveChatModel(providerId) {
  const chatModel = String(process.env.CHAT_MODEL || "").trim();
  if (chatModel) return chatModel;
  return getModel(providerId);
}

function getGithubRepoUrl() {
  const fromEnv = String(process.env.GITHUB_REPO_URL || "").trim();
  if (fromEnv) return fromEnv;
  const file = readConfigFile();
  return String(file.githubRepoUrl || "").trim();
}

function saveConfig({ apiKey, model, provider, githubRepoUrl }) {
  const current = readConfigFile();
  const next = { ...current };

  if (provider !== undefined) {
    const trimmed = String(provider || "").trim();
    if (trimmed && PROVIDERS[trimmed]) next.provider = trimmed;
  }

  if (apiKey !== undefined) {
    const trimmed = String(apiKey || "").trim();
    if (trimmed) next.apiKey = trimmed;
    else delete next.apiKey;
  }

  if (model !== undefined) {
    const trimmedModel = String(model || "").trim();
    if (trimmedModel) next.model = trimmedModel;
    else delete next.model;
  }

  if (githubRepoUrl !== undefined) {
    const trimmedRepo = String(githubRepoUrl || "").trim();
    if (trimmedRepo) next.githubRepoUrl = trimmedRepo;
    else delete next.githubRepoUrl;
  }

  writeConfigFile(next);
  return getConfigStatus();
}

function clearStoredApiKey() {
  const current = readConfigFile();
  delete current.apiKey;
  writeConfigFile(current);
  return getConfigStatus();
}

module.exports = {
  CONFIG_PATH,
  getApiKey,
  getModel,
  getGithubRepoUrl,
  resolveProvider,
  resolveChatProvider,
  resolveChatModel,
  getConfigStatus,
  saveConfig,
  clearStoredApiKey,
  maskApiKey,
};
