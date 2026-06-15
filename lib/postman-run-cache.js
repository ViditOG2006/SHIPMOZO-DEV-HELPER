/** Newman / Postman collection results cached per test run (runId). */

const byRun = new Map();
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [runId, entry] of byRun) {
    if (entry.startedAt < cutoff) byRun.delete(runId);
  }
}

function getPostmanRunCache(runId) {
  if (!runId) return null;
  prune();
  let entry = byRun.get(runId);
  if (!entry) {
    entry = { startedAt: Date.now(), cache: {} };
    byRun.set(runId, entry);
  }
  return entry.cache;
}

function clearPostmanRunCache(runId) {
  if (runId) byRun.delete(runId);
}

module.exports = { getPostmanRunCache, clearPostmanRunCache };
