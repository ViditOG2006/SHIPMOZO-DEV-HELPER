/** Quick check: Azure OpenAI orchestrator can reply (used for MCP loops, not doc compile). */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const { getReportLlmSplitStatus } = require("../lib/report-llm-split");
const { callLLM } = require("../lib/llm");

(async () => {
  const split = getReportLlmSplitStatus();
  console.log("Report LLM split:", JSON.stringify(split, null, 2));
  if (!split.orchestrator.configured) {
    console.error("Orchestrator not configured — set AZURE_OPENAI_API_KEY in .env");
    process.exit(1);
  }
  const { provider, model } = split.orchestrator;
  const result = await callLLM({
    provider,
    model,
    scope: "report_gen",
    maxTokens: 32,
    jsonMode: true,
    messages: [{ role: "user", content: 'Reply JSON: {"action":"finish_gathering","reason":"test"}' }],
  });
  console.log("OK:", result.provider, result.model, result.text.slice(0, 120));
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
