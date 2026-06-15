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

const hasKey = Boolean(String(process.env.POSTMAN_API_KEY || "").trim().length > 8);
console.log("POSTMAN_API_KEY set:", hasKey);
if (!hasKey) process.exit(1);

const { createMcpHttpClient, callMcpTool } = require("../lib/mcp-client");
const { parsePostmanMcpResult } = require("../lib/postman-mcp-parse");
const { postmanMcpUrl, postmanHeaders } = require("../lib/postman-mcp-config");

(async () => {
  const client = await createMcpHttpClient("test", postmanMcpUrl(), postmanHeaders(), {
    reuse: false,
  });
  const tools = await client.listTools();
  console.log("MCP tools available:", (tools?.tools || []).length);

  const r = await callMcpTool(client, "getWorkspaces", {});
  const { toolText } = require("../lib/mcp-client");
  const raw = toolText(r);
  const data = parsePostmanMcpResult(r);
  const workspaces =
    data?.workspaces ||
    data?.data ||
    data?.workspace ||
    (Array.isArray(data) ? data : []);
  console.log("Postman MCP OK. Raw response chars:", raw.length);
  console.log("Raw preview:", raw.slice(0, 280).replace(process.env.POSTMAN_API_KEY, "***"));
  console.log("Postman MCP OK. Workspaces:", Array.isArray(workspaces) ? workspaces.length : 0);
  for (const w of (Array.isArray(workspaces) ? workspaces : []).slice(0, 10)) {
    const name = w.name || "(unnamed)";
    const id = w.id || w.uid || "?";
    console.log(`  - ${name} | id: ${id}`);
  }
  await client.close();
})().catch((err) => {
  console.error("Postman MCP failed:", err.message);
  process.exit(1);
});
