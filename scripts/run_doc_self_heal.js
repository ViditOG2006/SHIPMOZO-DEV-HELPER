#!/usr/bin/env node
/**
 * Self-healing doc runner — retries until PRD + user manual + screenshots succeed.
 * Usage: node scripts/run_doc_self_heal.js Dashboard
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

const { generateModulePackage, validatePrdQuality } = require("../lib/doc-generation");

const moduleName = process.argv[2] || "Dashboard";
const description =
  process.argv[3] ||
  "Shipmozo user panel — capture every main page from sidebar with self-healing navigation.";
const maxRuns = Number(process.env.DOC_HEAL_MAX_RUNS || 3);

function minShots(name) {
  return name.toLowerCase().includes("dashboard") ? 6 : 3;
}

async function runOnce(attempt) {
  console.log(`\n=== Attempt ${attempt}/${maxRuns}: ${moduleName} ===`);
  const result = await generateModulePackage({
    moduleName,
    description,
    captureScreens: true,
  });

  const prdQuality = validatePrdQuality(result.prd || "", { docType: "prd" });
  const ok =
    prdQuality.ok &&
    Boolean(result.user_manual && result.user_manual.length > 200) &&
    (result.screenshots?.length || 0) >= minShots(moduleName);

  console.log(`Session: ${result.sessionId}`);
  console.log(`PRD: ${result.prd?.length || 0} chars (quality: ${prdQuality.ok ? "ok" : prdQuality.issues.join(", ")})`);
  console.log(`Manual: ${result.user_manual?.length || 0} chars`);
  console.log(`Screenshots: ${result.screenshots?.length || 0}`);
  if (result.captureError) console.log(`Capture note: ${result.captureError}`);

  return { ok, result };
}

(async () => {
  for (let i = 1; i <= maxRuns; i += 1) {
    try {
      const { ok, result } = await runOnce(i);
      if (ok) {
        console.log("\nSuccess — PRD, user manual, and screenshots ready.");
        process.exit(0);
      }
    } catch (err) {
      console.error(`Attempt ${i} failed:`, err.message);
    }
  }
  console.error(`\nFailed after ${maxRuns} attempts. Check SHIPMOZO_EMAIL/PASSWORD and OpenRouter key.`);
  process.exit(1);
})();
