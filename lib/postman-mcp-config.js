function postmanMcpUrl() {
  return String(process.env.POSTMAN_MCP_URL || "https://mcp.postman.com/minimal").trim();
}

function postmanHeaders() {
  const key = String(process.env.POSTMAN_API_KEY || "").trim();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

module.exports = { postmanMcpUrl, postmanHeaders };
