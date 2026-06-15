const { killAllPythonForRun } = require("./spawn-python");
const { clearPostmanRunCache } = require("./postman-run-cache");

const jobs = new Map();
const runIndex = new Map();
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function pruneJobs() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if ((job.finishedAt || job.startedAt) < cutoff) jobs.delete(id);
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
  return job;
}

function failRunStepJob(id, error) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === "cancelled") return job;
  job.status = "error";
  job.error = String(error || "Test step failed");
  job.finishedAt = Date.now();
  return job;
}

function getRunStepJob(id) {
  return jobs.get(id) || null;
}

function getTestingJob(id) {
  return jobs.get(id) || null;
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
