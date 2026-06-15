const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATASET_ROOT = path.join(ROOT, "output", "test-datasets");
const INDEX_PATH = path.join(DATASET_ROOT, "index.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readIndex() {
  ensureDir(DATASET_ROOT);
  if (!fs.existsSync(INDEX_PATH)) return { datasets: [] };
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { datasets: [] };
  }
}

function writeIndex(index) {
  ensureDir(DATASET_ROOT);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}

function saveDataset(dataset) {
  if (!dataset?.id) throw new Error("dataset id is required");
  ensureDir(DATASET_ROOT);
  const filePath = path.join(DATASET_ROOT, `${dataset.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2), "utf-8");

  const index = readIndex();
  const entry = {
    id: dataset.id,
    title: dataset.title || "Untitled dataset",
    scenarioCount: dataset.scenarios?.length || 0,
    createdAt: dataset.createdAt || new Date().toISOString(),
    requirementPreview: String(dataset.requirement || "").slice(0, 160),
  };
  const existing = index.datasets.findIndex((d) => d.id === dataset.id);
  if (existing >= 0) index.datasets[existing] = entry;
  else index.datasets.unshift(entry);
  writeIndex(index);
  return dataset;
}

function getDataset(id) {
  const filePath = path.join(DATASET_ROOT, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function listDatasets() {
  return readIndex().datasets;
}

function deleteDataset(id) {
  const datasetId = String(id || "").trim();
  if (!datasetId) throw new Error("id is required");

  const filePath = path.join(DATASET_ROOT, `${datasetId}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const index = readIndex();
  index.datasets = index.datasets.filter((d) => d.id !== datasetId);
  writeIndex(index);

  const { deleteRunsForDataset } = require("./test-run-store");
  const { removed: runsRemoved } = deleteRunsForDataset(datasetId);

  return { ok: true, id: datasetId, runsRemoved };
}

module.exports = {
  saveDataset,
  getDataset,
  listDatasets,
  deleteDataset,
  DATASET_ROOT,
};
