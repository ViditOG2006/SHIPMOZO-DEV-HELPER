/**
 * Testcase generation backends (TESTCASE_BACKEND env).
 *
 * scripts / import / none — user provides scenarios + nav scripts (no AI test gen)
 * docs / docs-llm       — single LLM pass from PRD + manual
 * docs-mcp / mcp-docs   — LLM orchestrates Playwright MCP + compile (most AI)
 * postman               — read existing Postman collection → scenarios (no create)
 * postman-mcp           — LLM commands Postman MCP to create collection + tests + run
 * postman-agent         — alias for postman-mcp
 */

function testcaseBackend() {
  return String(process.env.TESTCASE_BACKEND || "scripts").trim().toLowerCase();
}

function isPostmanMcpAgentEnabled() {
  const b = testcaseBackend();
  return b === "postman-mcp" || b === "postman-agent" || b === "postman-create";
}

function isPostmanMcpEnabled() {
  return testcaseBackend() === "postman";
}

function isDocsMcpTestcaseEnabled() {
  const b = testcaseBackend();
  return b === "docs-mcp" || b === "mcp-docs";
}

function isDocsLlmTestcaseEnabled() {
  const b = testcaseBackend();
  return b === "docs" || b === "docs-llm" || b === "llm";
}

function isScriptFirstTestcaseBackend() {
  const b = testcaseBackend();
  return b === "scripts" || b === "import" || b === "none";
}

function isAiTestcaseGenerationEnabled() {
  return !isScriptFirstTestcaseBackend();
}

function testcaseBackendLabel() {
  const b = testcaseBackend();
  if (isScriptFirstTestcaseBackend()) return "scripts (import only, no AI)";
  if (isDocsMcpTestcaseEnabled()) return "docs-mcp (PRD/manual + Playwright MCP)";
  if (isDocsLlmTestcaseEnabled()) return "docs (single LLM pass from PRD/manual)";
  if (isPostmanMcpAgentEnabled()) return "postman-mcp (AI creates collection via MCP)";
  if (isPostmanMcpEnabled()) return "postman (read existing collection)";
  return b;
}

module.exports = {
  testcaseBackend,
  isPostmanMcpEnabled,
  isPostmanMcpAgentEnabled,
  isDocsMcpTestcaseEnabled,
  isDocsLlmTestcaseEnabled,
  isScriptFirstTestcaseBackend,
  isAiTestcaseGenerationEnabled,
  testcaseBackendLabel,
};
