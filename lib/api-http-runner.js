/**
 * Direct HTTP calls to Shipmozo (or any) backend API — no Postman runner.
 */

function apiBaseUrl() {
  return String(process.env.SHIPMOZO_API_BASE_URL || process.env.API_BASE_URL || "").replace(
    /\/$/,
    ""
  );
}

function resolveApiUrl(scenario) {
  const inp = scenario.inputs || {};
  const raw = String(inp.apiEndpoint || inp.apiUrl || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = apiBaseUrl();
  if (!base) return null;
  return `${base}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = String(process.env.SHIPMOZO_API_TOKEN || process.env.API_BEARER_TOKEN || "").trim();
  if (token) headers.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const apiKey = String(process.env.SHIPMOZO_API_KEY || process.env.API_KEY || "").trim();
  if (apiKey) headers["X-Api-Key"] = apiKey;
  return headers;
}

async function runApiViaHttp(scenario, ctx) {
  const started = Date.now();
  const url = resolveApiUrl(scenario);
  if (!url) {
    return {
      httpStatus: 0,
      skipped: true,
      reason: "Set SHIPMOZO_API_BASE_URL and scenario.inputs.apiEndpoint",
      durationMs: Date.now() - started,
    };
  }

  const method = String(scenario.inputs?.apiMethod || "GET").toUpperCase();
  let body = scenario.inputs?.apiBody;
  if (typeof body === "string" && body.trim()) {
    try {
      body = JSON.parse(body);
    } catch {
      /* send raw string */
    }
  }

  const timeoutMs = Number(process.env.API_HTTP_TIMEOUT_MS || 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: authHeaders(),
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 2000) };
    }
    return {
      httpStatus: res.status,
      method,
      endpoint: url,
      body: parsed,
      runner: "http",
      durationMs: Date.now() - started,
      skipped: false,
    };
  } catch (err) {
    return {
      httpStatus: 0,
      method,
      endpoint: url,
      error: err.name === "AbortError" ? `Timed out after ${timeoutMs}ms` : err.message,
      runner: "http",
      durationMs: Date.now() - started,
      skipped: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  apiBaseUrl,
  resolveApiUrl,
  runApiViaHttp,
};
