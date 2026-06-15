const { Client } = require("@modelcontextprotocol/sdk/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const clients = new Map();

function toolText(result) {
  if (!result?.content?.length) return "";
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n")
    .trim();
}

async function pingMcpUrl(url, headers = {}) {
  try {
    const client = await createMcpHttpClient(`ping:${url}`, url, headers, { reuse: false });
    await client.close();
    return true;
  } catch {
    return false;
  }
}

async function createMcpHttpClient(name, url, headers = {}, { reuse = true } = {}) {
  const key = `${name}:${url}`;
  if (reuse && clients.has(key)) return clients.get(key);

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: Object.keys(headers).length ? { headers } : undefined,
  });
  const client = new Client({ name: "shipmozo-dev-helper", version: "1.0.0" });
  await client.connect(transport);
  if (reuse) clients.set(key, client);
  return client;
}

async function callMcpTool(client, toolName, args = {}) {
  return client.callTool({ name: toolName, arguments: args });
}

async function listMcpTools(client) {
  const result = await client.listTools();
  return result?.tools || [];
}

module.exports = {
  createMcpHttpClient,
  callMcpTool,
  listMcpTools,
  toolText,
  pingMcpUrl,
};
