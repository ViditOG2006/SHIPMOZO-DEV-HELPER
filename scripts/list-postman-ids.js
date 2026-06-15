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

const key = String(process.env.POSTMAN_API_KEY || "").trim();
if (!key) {
  console.error("Set POSTMAN_API_KEY in .env first.");
  process.exit(1);
}

const ws = String(process.env.POSTMAN_WORKSPACE_ID || "").trim();

async function get(apiPath) {
  const res = await fetch(`https://api.getpostman.com${apiPath}`, {
    headers: { "X-Api-Key": key },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return data;
}

(async () => {
  let colPath = ws ? `/collections?workspace=${encodeURIComponent(ws)}` : "/collections";
  let { collections = [] } = await get(colPath);
  if (ws && !collections.length) {
    console.log(`(no collections in workspace ${ws} — listing all accessible)\n`);
    ({ collections = [] } = await get("/collections"));
  }

  console.log("=== COLLECTIONS ===");
  if (!collections.length) console.log("(none found — check POSTMAN_API_KEY)");
  for (const c of collections) {
    console.log(`Name: ${c.name}`);
    console.log(`  UID:  ${c.uid}`);
    console.log("");
  }

  let envPath2 = ws ? `/environments?workspace=${encodeURIComponent(ws)}` : "/environments";
  let { environments = [] } = await get(envPath2);
  if (ws && !environments.length) {
    ({ environments = [] } = await get("/environments"));
  }

  console.log("=== ENVIRONMENTS ===");
  if (!environments.length) console.log("(none found)");
  for (const e of environments) {
    console.log(`Name: ${e.name}`);
    console.log(`  UID:  ${e.uid}`);
    console.log("");
  }
})().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
