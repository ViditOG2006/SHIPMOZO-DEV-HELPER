(function () {
  const API_PORT = "3000";
  const API_HOST = "127.0.0.1";

  function apiBase() {
    if (window.location.protocol === "file:") {
      return `http://${API_HOST}:${API_PORT}`;
    }
    // Same origin — works for localhost, LAN IP, and Cloudflare tunnel (HTTPS).
    return "";
  }

  function expectedAppUrl() {
    if (window.location.protocol !== "file:") {
      return window.location.origin;
    }
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
        const host = window.location.hostname || "";
        const tunnelHint = host.includes("trycloudflare.com")
          ? ` This trycloudflare.com link is dead (tunnel expired). Run npm start and open http://${API_HOST}:${API_PORT} instead. `
          : " ";
        throw new Error(
          `Cannot reach API at ${url}.${tunnelHint}Run npm start, then open http://${API_HOST}:${API_PORT} (${msg})`
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

  async function startAndPollTestcaseGen(body, { onProgress, maxWaitMs = 600000 } = {}) {
    const start = await fetchJson("/api/testing/generate-from-docs/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeoutMs: 60000,
      body: JSON.stringify(body),
    });
    const jobId = start.jobId;
    const pollMs = 2500;
    const pollTimeoutMs = 60000;
    const pollStarted = Date.now();
    let lastStatus = null;
    let networkFails = 0;
    while (Date.now() - pollStarted < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        lastStatus = await fetchJson(`/api/testing/generate-from-docs/status/${jobId}`, {
          timeoutMs: pollTimeoutMs,
        });
        networkFails = 0;
        if (onProgress) {
          onProgress(lastStatus, Math.floor((Date.now() - pollStarted) / 1000));
        }
        if (lastStatus.status === "done" || lastStatus.status === "error") break;
      } catch (pollErr) {
        networkFails += 1;
        if (networkFails > 20) throw pollErr;
      }
    }
    if (!lastStatus || lastStatus.status === "running") {
      throw new Error(
        `Test case generation timed out after ${Math.round(maxWaitMs / 60000)} minutes`
      );
    }
    if (lastStatus.status === "error") {
      throw new Error(lastStatus.error || "Test case generation failed");
    }
    return { ok: true, dataset: lastStatus.dataset };
  }

  window.DevHelperApi = {
    apiBase,
    apiUrl,
    fetchJson,
    checkServer,
    startAndPollTestcaseGen,
    expectedAppUrl,
    API_PORT,
    API_HOST,
  };
})();
