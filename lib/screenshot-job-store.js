const jobs = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;

function pruneJobs() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, job] of jobs) {
    if ((job.finishedAt || job.startedAt) < cutoff) jobs.delete(id);
  }
}

function createScreenshotJob({ sessionId, moduleName }) {
  pruneJobs();
  const id = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, {
    id,
    status: "running",
    sessionId,
    moduleName,
    startedAt: Date.now(),
    finishedAt: null,
    screenshots: [],
    videos: [],
    captureError: null,
    captureAttempts: 0,
    captureHealed: false,
  });
  return id;
}

function updateScreenshotJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  if (patch.status === "done" || patch.status === "error") {
    job.finishedAt = Date.now();
  }
  return job;
}

function getScreenshotJob(id) {
  return jobs.get(id) || null;
}

module.exports = {
  createScreenshotJob,
  updateScreenshotJob,
  getScreenshotJob,
};
