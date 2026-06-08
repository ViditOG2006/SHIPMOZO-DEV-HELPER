const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RUNS_ROOT = path.join(ROOT, "output", "test-runs");
const INDEX_PATH = path.join(RUNS_ROOT, "index.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readIndex() {
  ensureDir(RUNS_ROOT);
  if (!fs.existsSync(INDEX_PATH)) return { runs: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { runs: [] };
  }
}

function writeIndex(index) {
  ensureDir(RUNS_ROOT);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

function saveRun(run) {
  if (!run?.runId) throw new Error("runId is required");
  ensureDir(RUNS_ROOT);
  const filePath = path.join(RUNS_ROOT, `${run.runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(run, null, 2), "utf-8");

  const index = readIndex();
  const entry = {
    runId: run.runId,
    datasetId: run.datasetId,
    datasetTitle: run.datasetTitle || "",
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
  };
  index.runs = [entry, ...index.runs.filter((r) => r.runId !== run.runId)].slice(0, 100);
  writeIndex(index);
  return run;
}

function getRun(runId) {
  const filePath = path.join(RUNS_ROOT, `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function listRuns(datasetId) {
  const runs = readIndex().runs;
  if (!datasetId) return runs;
  return runs.filter((r) => r.datasetId === datasetId);
}

module.exports = { saveRun, getRun, listRuns, RUNS_ROOT };
