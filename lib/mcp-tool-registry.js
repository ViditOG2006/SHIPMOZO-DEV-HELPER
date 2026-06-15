const { createMcpHttpClient, callMcpTool, listMcpTools, toolText, pingMcpUrl } = require("./mcp-client");
const { postmanMcpUrl, postmanHeaders } = require("./postman-mcp-config");
const { ensurePlaywrightMcp, playwrightMcpUrl } = require("./ensure-playwright-mcp");

const PLAYWRIGHT_REPORT_TOOLS = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_wait_for",
  "browser_tabs",
]);

async function getPostmanClient() {
  const key = String(process.env.POSTMAN_API_KEY || "").trim();
  if (!key) return null;
  return createMcpHttpClient("postman-agent", postmanMcpUrl(), postmanHeaders());
}

async function getPlaywrightClient() {
  if (!(await pingMcpUrl(playwrightMcpUrl()))) {
    await ensurePlaywrightMcp();
  }
  return createMcpHttpClient("playwright-agent", playwrightMcpUrl());
}

async function listAvailableMcpTools() {
  const catalog = [];

  const postman = await getPostmanClient();
  if (postman) {
    try {
      const listed = await listMcpTools(postman);
      for (const t of listed.tools || []) {
        catalog.push({
          server: "postman",
          name: t.name,
          description: t.description || "",
        });
      }
    } catch (err) {
      catalog.push({ server: "postman", name: "_error", description: err.message });
    }
  }

  try {
    const pw = await getPlaywrightClient();
    const listed = await listMcpTools(pw);
    for (const t of listed.tools || []) {
      if (!PLAYWRIGHT_REPORT_TOOLS.has(t.name)) continue;
      catalog.push({
        server: "playwright",
        name: t.name,
        description: t.description || "",
      });
    }
  } catch (err) {
    catalog.push({ server: "playwright", name: "_error", description: err.message });
  }

  return catalog;
}

function formatToolCatalogForPrompt(catalog) {
  if (!catalog.length) return "(no MCP servers configured)";
  return catalog
    .filter((t) => t.name !== "_error")
    .slice(0, 60)
    .map((t) => `- ${t.server}.${t.name}: ${String(t.description).slice(0, 120)}`)
    .join("\n");
}

async function executeMcpToolCall(server, tool, args = {}) {
  const started = Date.now();
  const name = String(server || "").toLowerCase();
  const toolName = String(tool || "").trim();
  if (!toolName) throw new Error("MCP tool name is required");

  let client;
  if (name === "postman") {
    client = await getPostmanClient();
    if (!client) throw new Error("POSTMAN_API_KEY not configured");
  } else if (name === "playwright") {
    client = await getPlaywrightClient();
  } else {
    throw new Error(`Unknown MCP server: ${server}`);
  }

  const result = await callMcpTool(client, toolName, args && typeof args === "object" ? args : {});
  const text = toolText(result);
  return {
    server: name,
    tool: toolName,
    arguments: args,
    text: text || "(empty MCP response)",
    durationMs: Date.now() - started,
    isError: Boolean(result?.isError),
  };
}

module.exports = {
  listAvailableMcpTools,
  formatToolCatalogForPrompt,
  executeMcpToolCall,
  PLAYWRIGHT_REPORT_TOOLS,
};
