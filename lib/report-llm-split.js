/**
 * Split report generation across providers (no ai-config import — avoids circular deps).
 */

const { PROVIDERS, getProviderDef, readEnvKey, isAzureOpenAiEnvReady } = require("./providers");

function envProvider(role) {
  const key =
    role === "prd"
      ? process.env.REPORT_PRD_PROVIDER
      : role === "manual"
        ? process.env.REPORT_MANUAL_PROVIDER
        : role === "testcase"
          ? process.env.TESTCASE_PROVIDER
          : role === "orchestrator"
            ? process.env.REPORT_ORCHESTRATOR_PROVIDER
            : process.env.REPORT_COMPILE_PROVIDER;
  const id = String(key || "").trim().toLowerCase();
  return id || null;
}

function envModel(role) {
  const key =
    role === "prd"
      ? process.env.REPORT_PRD_MODEL
      : role === "manual"
        ? process.env.REPORT_MANUAL_MODEL
        : role === "testcase"
          ? process.env.TESTCASE_MODEL
          : role === "orchestrator"
            ? process.env.REPORT_ORCHESTRATOR_MODEL
            : process.env.REPORT_COMPILE_MODEL;
  return String(key || "").trim() || null;
}

function isSplitEnabled() {
  return Boolean(envProvider("orchestrator") || envProvider("compile"));
}

function modelForProvider(providerId) {
  const def = getProviderDef(providerId);
  const fromEnv = process.env[def.modelEnv];
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return def.defaultModel;
}

function resolveReportProvider(role, explicit) {
  const fromEnv = envProvider(role);
  if (fromEnv && PROVIDERS[fromEnv]) return fromEnv;

  if (role === "prd" || role === "compile") {
    if (readEnvKey(getProviderDef("claude"))) return "claude";
  }

  if (role === "testcase") {
    if (readEnvKey(getProviderDef("claude"))) return "claude";
    if (isAzureOpenAiEnvReady()) return "azure-openai";
    if (readEnvKey(getProviderDef("openai"))) return "openai";
    if (readEnvKey(getProviderDef("openrouter"))) return "openrouter";
  }

  if (role === "manual" || role === "orchestrator") {
    if (isAzureOpenAiEnvReady()) return "azure-openai";
    if (readEnvKey(getProviderDef("openai"))) return "openai";
    if (readEnvKey(getProviderDef("openrouter"))) return "openrouter";
  }

  if (role === "orchestrator") {
    if (isAzureOpenAiEnvReady()) return "azure-openai";
    if (readEnvKey(getProviderDef("openai"))) return "openai";
    if (readEnvKey(getProviderDef("openrouter"))) return "openrouter";
  }

  if (role === "compile") {
    if (readEnvKey(getProviderDef("claude"))) return "claude";
  }

  if (explicit && PROVIDERS[explicit]) return explicit;
  const forced = process.env.AI_PROVIDER;
  if (forced && PROVIDERS[forced]) return forced;
  return "claude";
}

function modelBelongsToProvider(model, providerId) {
  const m = String(model || "").trim();
  if (!m) return false;
  const def = getProviderDef(providerId);
  const lower = m.toLowerCase();
  if (def.models?.some((x) => x.toLowerCase() === lower)) return true;
  if (providerId === "claude") return lower.includes("claude");
  if (providerId === "gemini") return lower.includes("gemini");
  if (providerId === "openrouter") return m.includes("/");
  if (providerId === "azure-openai" || providerId === "openai") {
    return !lower.includes("claude") && !lower.includes("gemini") && !m.includes("/");
  }
  return false;
}

function resolveReportModel(role, providerId, explicitModel) {
  const fromEnv = envModel(role);
  if (fromEnv) return fromEnv;
  if (explicitModel && modelBelongsToProvider(explicitModel, providerId)) {
    return String(explicitModel).trim();
  }
  return modelForProvider(providerId);
}

function roleStatus(role) {
  const mapped =
    role === "prd" ? "prd" : role === "manual" ? "manual" : role;
  const provider = resolveReportProvider(mapped);
  const def = getProviderDef(provider);
  const model = resolveReportModel(mapped, provider);
  const configured =
    provider === "azure-openai" ? isAzureOpenAiEnvReady() : Boolean(readEnvKey(def));
  return {
    role,
    provider,
    providerLabel: def.label,
    model,
    configured,
    hasEnvKey: Boolean(readEnvKey(def)),
  };
}

function getReportLlmSplitStatus() {
  const prd = roleStatus("prd");
  const manual = roleStatus("manual");
  const orchestrator = roleStatus("orchestrator");
  const compile = roleStatus("compile");
  return {
    enabled: isSplitEnabled() || prd.provider !== manual.provider,
    prd,
    manual,
    orchestrator,
    compile,
    label: `${prd.providerLabel} (PRD) → Playwright → ${manual.providerLabel} (user manual)`,
  };
}

function resolveReportLlmPair({ provider, model } = {}) {
  const orchestratorProvider = resolveReportProvider("orchestrator", provider);
  const compileProvider = resolveReportProvider("compile", provider);
  return {
    orchestratorProvider,
    orchestratorModel: resolveReportModel("orchestrator", orchestratorProvider, null),
    compileProvider,
    compileModel: resolveReportModel("compile", compileProvider, model),
  };
}

function resolvePrdLlmPair({ provider, model } = {}) {
  const prdProvider = resolveReportProvider("prd", provider);
  return {
    prdProvider,
    prdModel: resolveReportModel("prd", prdProvider, model),
  };
}

function resolveManualLlmPair({ provider, model } = {}) {
  const manualProvider = resolveReportProvider("manual", provider);
  return {
    manualProvider,
    manualModel: resolveReportModel("manual", manualProvider, model),
  };
}

function resolveTestcaseLlmPair({ provider, model } = {}) {
  const testcaseProvider = resolveReportProvider("testcase", provider);
  return {
    testcaseProvider,
    testcaseModel: resolveReportModel("testcase", testcaseProvider, model),
  };
}

module.exports = {
  isSplitEnabled,
  resolveReportProvider,
  resolveReportModel,
  resolveReportLlmPair,
  resolvePrdLlmPair,
  resolveManualLlmPair,
  resolveTestcaseLlmPair,
  getReportLlmSplitStatus,
};
