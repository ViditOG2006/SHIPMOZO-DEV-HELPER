// Backward-compatible shim — use lib/llm.js for all providers.
const { callLLM, testConnection, MAX_OUTPUT_TOKENS } = require("./llm");

async function callClaude(opts) {
  return callLLM({ ...opts, provider: opts.provider || "claude" });
}

module.exports = {
  callClaude,
  callLLM,
  testConnection,
  MAX_OUTPUT_TOKENS,
};
