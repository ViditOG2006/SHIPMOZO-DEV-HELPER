const fs = require("fs");
const path = require("path");
const {
  PROVIDERS,
  getProviderDef,
  readEnvKey,
  detectProviderFromEnv,
} = require("./providers");

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
  const forced = getForcedProvider();
  if (forced) return forced;

  const file = readConfigFile();
  if (explicit && PROVIDERS[explicit]) return explicit;
  if (file.provider && PROVIDERS[file.provider]) return file.provider;
  return detectProviderFromEnv() || "openrouter";
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
    configured: Boolean(getApiKey(id) || (id === provider && apiKey)),
    hasEnvKey: Boolean(readEnvKey(getProviderDef(id))),
  }));

  return {
    provider,
    providerLabel: def.label,
    forcedProvider: getForcedProvider(),
    configured: Boolean(apiKey),
    maskedKey: maskApiKey(apiKey),
    model,
    source,
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
    })),
  };
}

function saveConfig({ apiKey, model, provider }) {
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
  resolveProvider,
  getConfigStatus,
  saveConfig,
  clearStoredApiKey,
  maskApiKey,
};
