const SCOPES = {
  SCRIPT_DEBUG: "script_debug",
  TESTCASE_GEN: "testcase_gen",
  REPORT_GEN: "report_gen",
  CHAT: "chat",
};

const DEFAULT_SCOPES = [
  SCOPES.SCRIPT_DEBUG,
  SCOPES.TESTCASE_GEN,
  SCOPES.REPORT_GEN,
  SCOPES.CHAT,
];

const SCOPE_LABELS = {
  [SCOPES.SCRIPT_DEBUG]: "script debugger",
  [SCOPES.TESTCASE_GEN]: "testcase generator",
  [SCOPES.REPORT_GEN]: "report generator",
  [SCOPES.CHAT]: "general chat",
};

const KNOWN_SCOPES = new Set(Object.values(SCOPES));

let cachedScopes = null;

function parseScopeList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && KNOWN_SCOPES.has(s));
}

function getAiScopes() {
  if (cachedScopes) return cachedScopes;
  const fromEnv = process.env.AI_SCOPE;
  const parsed = fromEnv != null && String(fromEnv).trim() !== ""
    ? parseScopeList(fromEnv)
    : [...DEFAULT_SCOPES];
  cachedScopes = parsed.length ? parsed : [...DEFAULT_SCOPES];
  return cachedScopes;
}

function isAiScopeEnabled(scope) {
  return getAiScopes().includes(String(scope || "").trim().toLowerCase());
}

function getAiLimitedMessage() {
  const enabled = getAiScopes().map((s) => SCOPE_LABELS[s] || s);
  if (!enabled.length) return "AI is disabled (no scopes enabled in AI_SCOPE).";
  return `AI is limited to: ${enabled.join(", ")}.`;
}

function getChatDisabledReason() {
  return (
    `AI chat is disabled. ${getAiLimitedMessage()} ` +
    "To enable panel Q&A, add chat to AI_SCOPE in .env " +
    "(e.g. AI_SCOPE=script_debug,testcase_gen,report_gen,chat) and restart npm start."
  );
}

function isChatAiEnabled() {
  return isAiScopeEnabled(SCOPES.CHAT);
}

function assertAiScope(scope) {
  if (isAiScopeEnabled(scope)) return;
  const label = SCOPE_LABELS[scope] || scope;
  const err = new Error(`${label} is disabled. ${getAiLimitedMessage()}`);
  err.code = "AI_SCOPE_DISABLED";
  err.scope = scope;
  throw err;
}

function getAiScopeStatus() {
  const enabled = getAiScopes();
  let backends = {};
  try {
    const { scriptDebugBackend } = require("./playwright-mcp-debug");
    const { testcaseBackend, testcaseBackendLabel } = require("./testcase-backend");
    const { reportBackend } = require("./mcp-report-generation");
    const { apiRunBackend, apiRunBackendLabel } = require("./api-run-backend");
    backends = {
      scriptDebug: scriptDebugBackend(),
      testcaseGen: testcaseBackend(),
      testcaseGenLabel: testcaseBackendLabel(),
      apiRun: apiRunBackend(),
      apiRunLabel: apiRunBackendLabel(),
      reportGen: reportBackend(),
    };
  } catch {
    /* optional modules */
  }
  return {
    enabled,
    defaults: DEFAULT_SCOPES,
    labels: SCOPE_LABELS,
    chatEnabled: isChatAiEnabled(),
    scriptDebugEnabled: isAiScopeEnabled(SCOPES.SCRIPT_DEBUG),
    testcaseGenEnabled: isAiScopeEnabled(SCOPES.TESTCASE_GEN),
    reportGenEnabled: isAiScopeEnabled(SCOPES.REPORT_GEN),
    limitedMessage: getAiLimitedMessage(),
    chatDisabledReason: isChatAiEnabled() ? null : getChatDisabledReason(),
    backends,
  };
}

module.exports = {
  SCOPES,
  DEFAULT_SCOPES,
  SCOPE_LABELS,
  getAiScopes,
  isAiScopeEnabled,
  isChatAiEnabled,
  getChatDisabledReason,
  getAiLimitedMessage,
  assertAiScope,
  getAiScopeStatus,
};
