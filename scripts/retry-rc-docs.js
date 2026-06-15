/** Retry Rate Calculator manual + test cases after rate-limit cooldown. */
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
const MODULE = "Rate Calculator";

async function api(path, body, { timeoutMs = 300000 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function main() {
  console.log("Waiting 90s for Claude rate limit cooldown…");
  await new Promise((r) => setTimeout(r, 90000));

  const sessionId = `rc_retry_${Date.now()}`;
  console.log("Generating PRD (compact)…");
  const prdRes = await api("/api/docs/generate-step", {
    step: "prd",
    moduleName: MODULE,
    description: "Domestic/international rate calculator with pincode, weight, dimensions",
    sessionId,
    provider: "claude",
  });
  const prd = prdRes.prd || "";
  console.log(`PRD: ${prd.length} chars`);

  console.log("Generating user manual…");
  const manualRes = await api("/api/docs/generate-step", {
    step: "manual",
    moduleName: MODULE,
    sessionId,
    prd,
    screenshots: [],
    provider: "claude",
  });
  const manual = manualRes.user_manual || "";
  console.log(`Manual: ${manual.length} chars · saved=${manualRes.saved}`);

  console.log("Generating test cases from docs…");
  const ds = await api("/api/testing/generate-from-docs", {
    moduleName: MODULE,
    prd,
    userManual: manual,
    sessionId,
    provider: "claude",
    save: true,
  });
  const n = ds.dataset?.scenarios?.length || ds.dataset?.sheetRowCount || 0;
  console.log(`Test cases: ${n} · id=${ds.dataset?.id}`);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
