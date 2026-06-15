/** Detect modules/services with no merchant panel UI (API-only backends). */

const BACKEND_ONLY_KEYWORDS = [
  "pincode serviceability",
  "serviceability api",
  "webhook",
  "api-only",
  "api only",
  "backend service",
];

function parseEnvBackendOnlyModules() {
  const raw = String(process.env.BACKEND_ONLY_MODULES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function textMatchesBackendOnlyKeywords(text) {
  const low = String(text || "").toLowerCase();
  return BACKEND_ONLY_KEYWORDS.some((kw) => low.includes(kw));
}

function matchesEnvModuleList(moduleName, blob) {
  const envList = parseEnvBackendOnlyModules();
  const nameLow = String(moduleName || "").toLowerCase();
  const blobLow = String(blob || "").toLowerCase();
  return envList.some((m) => nameLow.includes(m) || blobLow.includes(m));
}

function isTruthyFlag(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * @param {object} ctx
 * @param {string} [ctx.moduleName]
 * @param {string} [ctx.description]
 * @param {boolean} [ctx.backendOnly] — explicit user checkbox
 * @param {object} [ctx.sourceDocs]
 * @param {object} [ctx.options]
 * @param {object} [ctx.dataset]
 */
function isBackendOnlyModule(ctx = {}) {
  const dataset = ctx.dataset || {};
  const sourceDocs = ctx.sourceDocs || dataset.sourceDocs || {};
  const options = ctx.options || dataset.options || {};

  if (
    isTruthyFlag(ctx.backendOnly) ||
    isTruthyFlag(options.backendOnly) ||
    isTruthyFlag(sourceDocs.backendOnly) ||
    isTruthyFlag(dataset.backendOnly)
  ) {
    return true;
  }

  const moduleName = String(
    ctx.moduleName || sourceDocs.moduleName || dataset.sourceDocs?.moduleName || ""
  ).trim();
  const description = String(
    ctx.description || sourceDocs.description || options.description || ""
  ).trim();
  const blob = `${moduleName} ${description}`;

  if (textMatchesBackendOnlyKeywords(blob)) return true;
  if (matchesEnvModuleList(moduleName, blob)) return true;

  return false;
}

function stripNonApiScenarios(scenarios) {
  return (Array.isArray(scenarios) ? scenarios : []).filter((s) => s?.category === "api");
}

module.exports = {
  BACKEND_ONLY_KEYWORDS,
  isBackendOnlyModule,
  stripNonApiScenarios,
  textMatchesBackendOnlyKeywords,
};
