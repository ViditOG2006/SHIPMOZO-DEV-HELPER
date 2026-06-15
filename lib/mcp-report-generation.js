function reportBackend() {
  return String(process.env.REPORT_BACKEND || "split").trim().toLowerCase();
}

function isReportMcpEnabled() {
  const b = reportBackend();
  return b === "mcp" || b === "mcp-agent" || b === "agent";
}

/** Claude PRD → Playwright capture → OpenAI/Azure manual (default, no MCP). */
function isSplitDocPipeline() {
  const b = reportBackend();
  return b === "split" || b === "pipeline" || b === "claude-openai";
}

function isReportFastLlm() {
  const b = reportBackend();
  return b === "llm" || b === "claude" || b === "fast" || isSplitDocPipeline();
}

module.exports = {
  reportBackend,
  isReportMcpEnabled,
  isSplitDocPipeline,
  isReportFastLlm,
};
