const PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    keyHint: "sk-... or sk-proj-...",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  claude: {
    id: "claude",
    label: "Claude (Anthropic)",
    envKey: "ANTHROPIC_API_KEY",
    altEnvKeys: ["CLAUDE_API_KEY"],
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-4-20250514",
    models: [
      "claude-sonnet-4-20250514",
      "claude-3-5-haiku-20241022",
      "claude-3-5-sonnet-20241022",
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

function detectProviderFromEnv() {
  const order = ["openrouter", "openai", "gemini", "claude"];
  for (const id of order) {
    const def = PROVIDERS[id];
    if (readEnvKey(def)) return id;
  }
  return null;
}

module.exports = {
  PROVIDERS,
  getProviderDef,
  readEnvKey,
  detectProviderFromEnv,
};
