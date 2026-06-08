(function () {
  const API_PORT = "3000";
  const API_HOST = "127.0.0.1";

  function apiBase() {
    if (window.location.protocol === "file:") {
      return `http://${API_HOST}:${API_PORT}`;
    }
    // Same Node app (any hostname: 127.0.0.1, localhost, LAN IP)
    if (window.location.port === API_PORT) return "";
    return `http://${API_HOST}:${API_PORT}`;
  }

  function expectedAppUrl() {
    return `http://${API_HOST}:${API_PORT}`;
  }

  function apiUrl(path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    return `${apiBase()}${p}`;
  }

  async function fetchJson(path, options = {}) {
    const url = apiUrl(path);
    const timeoutMs = options.timeoutMs || 0;
    const { timeoutMs: _drop, ...fetchOptions } = options;

    let controller;
    let timer;
    if (timeoutMs > 0 && typeof AbortController !== "undefined") {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      fetchOptions.signal = controller.signal;
    }

    let res;
    try {
      res = await fetch(url, fetchOptions);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (err.name === "AbortError") {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s. Try again.`);
      }
      if (
        msg.toLowerCase().includes("fetch failed") ||
        msg.toLowerCase().includes("failed to fetch") ||
        msg.toLowerCase().includes("networkerror")
      ) {
        throw new Error(
          `Cannot reach API at ${url}. In a terminal run: npm start — then open ${expectedAppUrl()} (${msg})`
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (text.trim().startsWith("<!")) {
        throw new Error(
          `Cannot reach API at ${url}. In a terminal run: npm start — then open http://${API_HOST}:${API_PORT}`
        );
      }
      throw new Error(`Invalid response from ${url}: ${text.slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function checkServer() {
    try {
      const data = await fetchJson("/api/health");
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  window.DevHelperApi = {
    apiBase,
    apiUrl,
    fetchJson,
    checkServer,
    expectedAppUrl,
    API_PORT,
    API_HOST,
  };
})();
