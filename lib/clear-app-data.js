const fs = require("fs");
const path = require("path");
const { clearAllReports } = require("./report-archive");

const ROOT = path.join(__dirname, "..");
const OUTPUT = path.join(ROOT, "output");

function rmDirIfExists(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function rmFileIfExists(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

async function clearAllAppData() {
  const reports = await clearAllReports();

  rmDirIfExists(path.join(OUTPUT, "cloud-images"));
  fs.mkdirSync(path.join(OUTPUT, "cloud-images"), { recursive: true });

  rmDirIfExists(path.join(OUTPUT, "workflow"));

  rmFileIfExists(path.join(OUTPUT, "shipmozo-state.json"));
  rmFileIfExists(path.join(OUTPUT, "shipmozo-dashboard.png"));

  return {
    ok: true,
    reportsRemoved: reports.removed,
    cleared: [
      "saved reports",
      "screenshot cache (cloud-images)",
      "workflow output",
      "panel login session",
    ],
    localStorageKeys: ["shipmozo-chat-v1", "shipmozo-docs-v1", "shipmozo-github-repo-v1"],
    note: "API keys in .env are kept. Cloudinary backups are not deleted.",
  };
}

module.exports = { clearAllAppData };
