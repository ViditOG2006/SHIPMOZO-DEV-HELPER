const fs = require("fs");
const path = require("path");
const newman = require("newman");
const { fetchPostmanCollection, fetchPostmanEnvironment } = require("./postman-api-client");
const { filterCollectionByFolders } = require("./postman-mcp-dataset");

const ROOT = path.join(__dirname, "..");
const RUN_DIR = path.join(ROOT, "output", "runtime", "postman-run");

function runNewmanLib({ collection, environment, reportPath, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const opts = {
      collection,
      timeoutRequest: timeoutMs,
      reporters: ["json"],
      reporter: { json: { export: reportPath } },
    };
    if (environment) {
      opts.environment = {
        name: environment.name || "env",
        values: environment.values || [],
      };
    }
    newman.run(opts, (err, summary) => {
      if (err) reject(err);
      else resolve(summary);
    });
  });
}

function parseNewmanReport(report) {
  const run = report?.run || report;
  const executions = run?.executions || [];
  let passed = 0;
  let failed = 0;
  const byName = {};

  for (const ex of executions) {
    const name = String(ex.item?.name || ex.assertions?.[0]?.assertion || "request").trim();
    const failedAsserts = (ex.assertions || []).filter((a) => a.error);
    const ok = failedAsserts.length === 0 && !ex.requestError;
    if (ok) passed += 1;
    else failed += 1;
    byName[name.toLowerCase()] = {
      ok,
      failedAsserts: failedAsserts.length,
      status: ex.response?.code,
      requestError: ex.requestError?.message,
    };
  }

  const stats = run?.stats || {};
  const assertions = stats.assertions || {};
  const ok =
    failed === 0 &&
    passed > 0 &&
    (assertions.failed == null || assertions.failed === 0);

  return {
    ok,
    passed: assertions.total ? assertions.total - (assertions.failed || 0) : passed,
    failed: assertions.failed ?? failed,
    byName,
    stats,
    blob: JSON.stringify({ stats, executionCount: executions.length }).slice(0, 12000),
  };
}

function normalizeRequestKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function matchScenarioToExecution(scenario, byName, blob) {
  const names = [
    scenario.inputs?.postmanRequestName,
    scenario.title,
  ]
    .map(normalizeRequestKey)
    .filter(Boolean);

  const entries = Object.entries(byName || {});

  for (const n of names) {
    if (byName[n]) return byName[n];
    const partial = entries.find(([k]) => {
      const key = normalizeRequestKey(k);
      return key.includes(n) || n.includes(key);
    });
    if (partial) return partial[1];
    const tcId = n.match(/tc-[a-z0-9-]+/i)?.[0];
    if (tcId) {
      const byTc = entries.find(([k]) => normalizeRequestKey(k).includes(tcId.toLowerCase()));
      if (byTc) return byTc[1];
    }
  }

  const path = String(scenario.inputs?.apiEndpoint || "").toLowerCase();
  if (path && blob.toLowerCase().includes(path.replace(/^\//, ""))) {
    return { ok: true, matchedBy: "endpoint" };
  }
  return null;
}

/**
 * Fetch collection from Postman API and run with Newman (no runCollection MCP tool needed).
 */
async function runPostmanCollectionViaNewman({ collectionId, environmentId, folders = null }) {
  let collection = await fetchPostmanCollection(collectionId);
  if (folders?.length) {
    collection = filterCollectionByFolders(collection, folders);
  }
  const environment = environmentId ? await fetchPostmanEnvironment(environmentId) : null;

  const runId = `${Date.now()}_${String(collectionId).slice(0, 8)}`;
  const dir = path.join(RUN_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });

  const collectionPath = path.join(dir, "collection.json");
  const reportPath = path.join(dir, "newman-report.json");

  const newmanCollection = {
    info: collection.info || { name: collection.name || "Collection", schema: collection.schema },
    item: collection.item || [],
    variable: collection.variable,
    auth: collection.auth,
    event: collection.event,
  };
  fs.writeFileSync(collectionPath, JSON.stringify(newmanCollection, null, 2), "utf-8");

  console.log(`[postman-newman] running collection ${collectionId}${environmentId ? ` env ${environmentId}` : ""}`);

  const timeoutMs = Number(process.env.POSTMAN_NEWMAN_REQUEST_TIMEOUT_MS || 60000);
  let summary;
  try {
    summary = await runNewmanLib({
      collection: newmanCollection,
      environment,
      reportPath,
      timeoutMs,
    });
  } catch (err) {
    throw new Error(`Newman run failed: ${err.message}`);
  }

  let report = {};
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    } catch {
      report = {};
    }
  }

  const outcome = parseNewmanReport(report.run ? report : { run: summary?.run });
  outcome.exitCode = summary?.run?.failures?.length ? 1 : 0;
  outcome.collectionId = collectionId;
  outcome.environmentId = environmentId || null;
  outcome.runner = "newman";

  if (!outcome.passed && !outcome.failed) {
    const stats = summary?.run?.stats;
    if (stats?.assertions) {
      outcome.passed = stats.assertions.total - (stats.assertions.failed || 0);
      outcome.failed = stats.assertions.failed || 0;
      outcome.ok = outcome.failed === 0 && outcome.passed > 0;
    }
  }

  return outcome;
}

module.exports = {
  runPostmanCollectionViaNewman,
  parseNewmanReport,
  matchScenarioToExecution,
};
