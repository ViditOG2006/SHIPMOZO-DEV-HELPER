/**
 * How API (backend) scenarios are executed during test runs.
 *
 * local       — HTTP to Dev Helper / inferred routes (default)
 * postman-mcp — Newman runs Postman collection (fetched via Postman API)
 * postman     — alias for postman-mcp
 * http        — direct HTTP to SHIPMOZO_API_BASE_URL + apiEndpoint
 */

function apiRunBackend() {
  return String(process.env.API_RUN_BACKEND || "local").trim().toLowerCase();
}

function isPostmanMcpApiRunEnabled() {
  const b = apiRunBackend();
  return b === "postman-mcp" || b === "postman";
}

function isHttpApiRunEnabled() {
  return apiRunBackend() === "http";
}

function apiRunBackendLabel() {
  if (isPostmanMcpApiRunEnabled()) {
    return "postman (Newman + Postman API — MCP runCollection not required)";
  }
  if (isHttpApiRunEnabled()) return "http (direct API calls)";
  return "local (Dev Helper routes)";
}

module.exports = {
  apiRunBackend,
  isPostmanMcpApiRunEnabled,
  isHttpApiRunEnabled,
  apiRunBackendLabel,
};
