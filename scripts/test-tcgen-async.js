#!/usr/bin/env node
const BASE = process.env.BASE_URL || "http://127.0.0.1:3000";

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function main() {
  const reports = await api("/api/reports");
  const report = reports.reports?.find((r) => /integrat/i.test(r.moduleName || ""));
  if (!report) throw new Error("No Integrations report found");
  const full = await api(`/api/reports/${report.sessionId}`);
  const doc = full.report || full;
  const body = {
    moduleName: doc.moduleName,
    prd: doc.prd || "",
    userManual: doc.user_manual || "",
    sessionId: doc.sessionId,
    save: false,
    options: { minScenarios: 10, includeLivePanel: true },
  };
  const start = await api("/api/testing/generate-from-docs/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("jobId", start.jobId);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await api(`/api/testing/generate-from-docs/status/${start.jobId}`);
    console.log("status", st.status, "elapsed", Math.round(st.elapsedMs / 1000) + "s");
    if (st.status === "done") {
      console.log("OK scenarios", st.dataset?.scenarioCount, "sheetRows", st.dataset?.sheetRowCount, "model", st.dataset?.model);
      return;
    }
    if (st.status === "error") throw new Error(st.error);
  }
  throw new Error("timed out");
}

main().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
