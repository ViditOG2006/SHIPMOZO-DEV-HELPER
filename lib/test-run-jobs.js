const fs = require("fs");
const path = require("path");
const { killAllPythonForRun } = require("./spawn-python");
const { clearPostmanRunCache } = require("./postman-run-cache");

const jobs = new Map();
const runIndex = new Map();
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const JOBS_DIR = path.join(__dirname, "..", "output", "runtime", "test-step-jobs");

function ensureJobsDir() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
}

function jobFilePath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

function persistJob(job) {
  if (!job?.id) return;
  try {
    ensureJobsDir();
    fs.writeFileSync(jobFilePath(job.id), JSON.stringify(job, null, 2), "utf-8");
  } catch {
    // non-fatal — in-memory job still works locally
  }
}

function loadJobFromDisk(id) {
  const filePath = jobFilePath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function pruneJobs() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if ((job.finishedAt || job.startedAt) < cutoff) {
      jobs.delete(id);
      try {
        fs.unlinkSync(jobFilePath(id));
      } catch {
        // ignore missing file
      }
    }
  }
  for (const [runId, ids] of runIndex) {
    if (![...ids].some((id) => jobs.has(id))) runIndex.delete(runId);
  }
}

function linkJobToRun(jobId, runId) {
  if (!runId) return;
  if (!runIndex.has(runId)) runIndex.set(runId, new Set());
  runIndex.get(runId).add(jobId);
}

function createRunStepJob({ runId, scenarioId, index, total }) {
  return createTestingJob("step", { runId, scenarioId, index, total });
}

function createTestingJob(kind, meta = {}) {
  pruneJobs();
  const id = `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    kind,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    ...meta,
  };
  jobs.set(id, job);
  persistJob(job);
  if (meta.runId) linkJobToRun(id, meta.runId);
  return id;
}

function isJobCancelled(id) {
  const job = jobs.get(id);
  return job?.status === "cancelled";
}

function cancelJobsForRun(runId, reason = "Stopped by user") {
  pruneJobs();
  clearPostmanRunCache(runId);
  const killed = killAllPythonForRun(runId);
  const ids = runIndex.get(runId) || new Set();
  let cancelled = 0;

  for (const id of ids) {
    const job = jobs.get(id);
    if (!job || job.status !== "running") continue;
    job.status = "cancelled";
    job.error = reason;
    job.finishedAt = Date.now();
    job.result = {
      ok: false,
      cancelled: true,
      error: reason,
      ...(job.result || {}),
    };
    persistJob(job);
    cancelled += 1;
  }

  return { runId, cancelled, killed };
}

function finishRunStepJob(id, result) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === "cancelled") return job;
  job.status = "done";
  job.result = result;
  job.finishedAt = Date.now();
  persistJob(job);
  return job;
}

function failRunStepJob(id, error) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === "cancelled") return job;
  job.status = "error";
  job.error = String(error || "Test step failed");
  job.finishedAt = Date.now();
  persistJob(job);
  return job;
}

function getRunStepJob(id) {
  let job = jobs.get(id);
  if (!job) {
    job = loadJobFromDisk(id);
    if (job) {
      jobs.set(id, job);
      if (job.runId) linkJobToRun(id, job.runId);
    }
  }
  return job || null;
}

function getTestingJob(id) {
  return getRunStepJob(id);
}

function getRunningJobsForRun(runId) {
  const ids = runIndex.get(runId) || new Set();
  return [...ids].map((id) => jobs.get(id)).filter((j) => j && j.status === "running");
}

module.exports = {
  createRunStepJob,
  createTestingJob,
  finishRunStepJob,
  failRunStepJob,
  getRunStepJob,
  getTestingJob,
  cancelJobsForRun,
  isJobCancelled,
  getRunningJobsForRun,
};
