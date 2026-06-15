/**
 * PRD quality validation for doc-generation self-heal loops.
 */

const TBD_PATTERN = /TBD\s*[—–-]|wait for next MCP/i;
const MIN_PRD_CHARS = Number(process.env.DOCS_PRD_MIN_CHARS || 1200);

const REQUIRED_HEADINGS = [
  /module overview/i,
  /ui structure/i,
  /workflow/i,
  /dependencies/i,
  /data.*field/i,
];

function prdHasTbdPlaceholders(content) {
  return TBD_PATTERN.test(String(content || ""));
}

function countTbdPlaceholders(content) {
  const matches = String(content || "").match(/TBD\s*[—–-][^\n]*/gi);
  return matches ? matches.length : 0;
}

function validatePrdQuality(content, { docType = "prd" } = {}) {
  const text = String(content || "").trim();
  const issues = [];

  if (!text) {
    issues.push("empty");
  } else if (text.length < MIN_PRD_CHARS) {
    issues.push(`too_short:${text.length}`);
  }

  const tbdCount = countTbdPlaceholders(text);
  if (tbdCount > 0) {
    issues.push(`tbd_placeholders:${tbdCount}`);
  }

  if (docType === "prd") {
    for (const pattern of REQUIRED_HEADINGS) {
      if (!pattern.test(text)) {
        issues.push(`missing_section:${pattern.source}`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    tbdCount,
    length: text.length,
  };
}

function gatherLooksSufficient(sources) {
  if (!Array.isArray(sources) || !sources.length) return false;
  const okSources = sources.filter((s) => !s.isError && String(s.text || "").length > 80);
  if (!okSources.length) return false;
  const hasUi = okSources.some((s) => s.server === "playwright");
  const hasApi = okSources.some((s) => s.server === "postman");
  return hasUi || hasApi;
}

module.exports = {
  MIN_PRD_CHARS,
  prdHasTbdPlaceholders,
  countTbdPlaceholders,
  validatePrdQuality,
  gatherLooksSufficient,
};
