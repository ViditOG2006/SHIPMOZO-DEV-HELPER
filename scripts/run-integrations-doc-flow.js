/**
 * Full Module Docs flow: Integrations / Shopify channel
 */
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

const BASE = "http://127.0.0.1:3000";
const MODULE = "Integrations";
const DESCRIPTION = "Shopify integration channel — connect store, sync orders, webhooks, channel settings";

async function api(path, body, { timeoutMs = 900000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}

async function poll(path, { maxWaitMs = 900000, pollMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const st = await api(path, null, { timeoutMs: 60000 });
    if (st.status === "done" || st.status === "error" || st.status === "failed") return st;
    process.stdout.write(`  … ${st.status || "running"} ${st.elapsedSeconds || 0}s\r`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timeout polling ${path}`);
}

function log(phase, ok, detail = "") {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${phase}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  console.log("=== Integrations / Shopify — full doc flow ===\n");

  const health = await api("/api/health");
  const split = health.ai?.reportLlmSplit;
  log(
    "Claude PRD",
    split?.prd?.configured,
    `${split?.prd?.providerLabel || split?.compile?.providerLabel} · ${split?.prd?.model || split?.compile?.model}`
  );
  log(
    "OpenAI manual",
    split?.manual?.configured,
    `${split?.manual?.providerLabel || split?.orchestrator?.providerLabel} · ${split?.manual?.model || split?.orchestrator?.model}`
  );
  if (!split?.prd?.configured && !split?.compile?.configured) {
    console.error("Claude PRD provider not configured");
    process.exit(1);
  }

  const sessionId = `int_${Date.now()}`;
  let prd = "";

  console.log("\n--- Step 1: PRD ---");
  try {
    const t0 = Date.now();
    const prdRes = await api("/api/docs/generate-step", {
      step: "prd",
      moduleName: MODULE,
      description: DESCRIPTION,
      sessionId,
      provider: "claude",
    });
    prd = prdRes.prd || "";
    const sec = Math.round((Date.now() - t0) / 1000);
    log("PRD", prd.length > 500, `${prd.length} chars · ${prdRes.generatedBy} · ${sec}s`);
  } catch (e) {
    log("PRD", false, e.message);
    process.exit(1);
  }

  console.log("\n--- Step 2: Screenshots & video ---");
  let screenshots = [];
  let videos = [];
  try {
    const shotStart = await api("/api/docs/screenshots/start", {
      moduleName: MODULE,
      description: DESCRIPTION,
      sessionId,
    });
    const shotJob = await poll(`/api/docs/screenshots/status/${shotStart.jobId}`);
    screenshots = shotJob.screenshots || [];
    videos = shotJob.videos || [];
    log(
      "Screenshots",
      screenshots.length > 0,
      `${screenshots.length} shot(s)${shotJob.captureError ? ` (${shotJob.captureError})` : ""}`
    );
    log("Videos", videos.length > 0, `${videos.length} recording(s)`);
  } catch (e) {
    log("Screenshots", false, e.message);
  }

  console.log("\n--- Step 3: User manual ---");
  try {
    const t0 = Date.now();
    const manualRes = await api("/api/docs/generate-step", {
      step: "manual",
      moduleName: MODULE,
      description: DESCRIPTION,
      sessionId,
      prd,
      screenshots,
      videos,
    });
    const manual = manualRes.user_manual || "";
    const sec = Math.round((Date.now() - t0) / 1000);
    log("User manual", manual.length > 300, `${manual.length} chars · ${manualRes.generatedBy} · saved=${manualRes.saved} · ${sec}s`);
  } catch (e) {
    log("User manual", false, e.message);
    process.exit(1);
  }

  console.log("\n=== Done ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
