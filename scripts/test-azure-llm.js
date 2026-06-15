const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = value;
}

const { getApiKey, resolveProvider } = require("../lib/ai-config");
const { getProviderDef, readProviderEndpoint, readProviderApiVersion } = require("../lib/providers");

function azureUrl(deployment) {
  const def = getProviderDef("azure-openai");
  const endpoint = readProviderEndpoint(def).replace(/\/$/, "");
  const ver = encodeURIComponent(readProviderApiVersion(def));
  return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${ver}`;
}

(async () => {
  const provider = "azure-openai";
  const model = process.env.AZURE_OPENAI_DEPLOYMENT;
  const apiKey = getApiKey(provider);
  console.log("provider", provider, "key?", Boolean(apiKey), "resolve", resolveProvider(provider));

  const messages = [{ role: "user", content: 'Reply JSON: {"action":"finish_gathering","reason":"test"}' }];
  const body = {
    model,
    max_tokens: 64,
    messages,
    response_format: { type: "json_object" },
  };

  const res = await fetch(azureUrl(model), {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  console.log("status", res.status, JSON.stringify(data).slice(0, 400));

  const { callLLM } = require("../lib/llm");
  try {
    const r = await callLLM({
      provider: "azure-openai",
      model,
      scope: "report_gen",
      maxTokens: 64,
      jsonMode: true,
      messages,
    });
    console.log("callLLM OK:", r.text);
  } catch (e) {
    console.error("callLLM FAIL:", e.message, "status", e.status);
  }
})();
