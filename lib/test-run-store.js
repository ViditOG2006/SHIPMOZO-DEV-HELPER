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

function deleteRun(runId) {
  const id = String(runId || "").trim();
  if (!id) throw new Error("runId is required");

  const filePath = path.join(RUNS_ROOT, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const dir = path.join(RUNS_ROOT, id);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const index = readIndex();
  index.runs = index.runs.filter((r) => r.runId !== id);
  writeIndex(index);
  return { ok: true, runId: id };
}

function deleteRunsForDataset(datasetId) {
  const id = String(datasetId || "").trim();
  if (!id) return { ok: true, removed: 0 };
  const runIds = readIndex()
    .runs.filter((r) => r.datasetId === id)
    .map((r) => r.runId);
  for (const runId of runIds) deleteRun(runId);
  return { ok: true, removed: runIds.length };
}

module.exports = { saveRun, getRun, listRuns, deleteRun, deleteRunsForDataset, RUNS_ROOT };
