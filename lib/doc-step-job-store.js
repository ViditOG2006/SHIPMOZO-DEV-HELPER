const jobs = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;

function pruneJobs() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if ((job.finishedAt || job.startedAt) < cutoff) jobs.delete(id);
  }
}

function createDocStepJob({ step, sessionId, moduleName }) {
  pruneJobs();
  const id = `docstep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, {
    id,
    status: "running",
    step,
    sessionId,
    moduleName,
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
  });
  return id;
}

function updateDocStepJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  if (patch.status === "done" || patch.status === "error") {
    job.finishedAt = Date.now();
  }
  return job;
}

function getDocStepJob(id) {
  return jobs.get(id) || null;
}

module.exports = {
  createDocStepJob,
  updateDocStepJob,
  getDocStepJob,
};
