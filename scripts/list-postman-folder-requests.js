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

const folderFilter = process.argv[2] || "05_Utility_APIs";
const { fetchPostmanCollection } = require("../lib/postman-api-client");

function walk(items, folder = "") {
  for (const i of items || []) {
    if (i.item) {
      walk(i.item, i.name || folder);
    } else if (folder === folderFilter) {
      console.log(i.name);
    }
  }
}

(async () => {
  const c = await fetchPostmanCollection(process.env.POSTMAN_COLLECTION_ID);
  walk(c.item);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
