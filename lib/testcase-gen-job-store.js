const jobs = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;

function pruneJobs() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if ((job.finishedAt || job.startedAt) < cutoff) jobs.delete(id);
  }
}

function createTestcaseGenJob({ moduleName }) {
  pruneJobs();
  const id = `tcgen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, {
    id,
    status: "running",
    moduleName,
    startedAt: Date.now(),
    finishedAt: null,
    dataset: null,
    error: null,
  });
  return id;
}

function updateTestcaseGenJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  if (patch.status === "done" || patch.status === "error") {
    job.finishedAt = Date.now();
  }
  return job;
}

function getTestcaseGenJob(id) {
  return jobs.get(id) || null;
}

module.exports = {
  createTestcaseGenJob,
  updateTestcaseGenJob,
  getTestcaseGenJob,
};
