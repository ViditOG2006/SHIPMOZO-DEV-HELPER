const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

const { runPostmanCollectionViaNewman, matchScenarioToExecution } = require("../lib/postman-newman-runner");

const folder = process.argv[2] || "01_Warehouse_APIs";
const requestName = process.argv[3] || "TC-WH-N01 Get Warehouses Negative (invalid keys)";

runPostmanCollectionViaNewman({
  collectionId: process.env.POSTMAN_COLLECTION_ID,
  environmentId: process.env.POSTMAN_ENVIRONMENT_ID,
  folders: [folder],
})
  .then((r) => {
    console.log("collection ok=", r.ok, "failed=", r.failed, "passed=", r.passed);
    for (const [k, v] of Object.entries(r.byName || {})) {
      console.log(v.ok ? "PASS" : "FAIL", k);
    }
    const scenario = {
      title: requestName,
      inputs: { postmanRequestName: requestName },
    };
    console.log("match:", matchScenarioToExecution(scenario, r.byName, r.blob || ""));
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
