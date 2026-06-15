const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "module",
  "shipmozo",
  "test",
  "case",
  "api",
  "from",
  "with",
  "using",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function deriveSearchKeywords(moduleName = "", description = "", extra = []) {
  const parts = [moduleName, description, ...(Array.isArray(extra) ? extra : [extra])].filter(Boolean);
  return [...new Set(parts.flatMap((p) => tokenize(p)))];
}

function scoreRequestMatch(request, keywords = []) {
  const hay = `${request.name || ""} ${request._postmanFolder || ""}`.toLowerCase();
  const kws = keywords.map((k) => String(k || "").toLowerCase()).filter(Boolean);
  if (!kws.length) return 0;

  let score = 0;
  let matched = 0;
  for (const k of kws) {
    if (hay.includes(k)) {
      matched += 1;
      score += k.length > 4 ? 3 : 2;
    }
  }

  if (kws.length > 1 && matched < kws.length) return 0;
  return score;
}

/**
 * Return all Postman collection requests whose name/folder matches keywords.
 * One entry per request — never collapsed by endpoint.
 */
function searchPostmanRequests(requests = [], { query = "", keywords = [], minScore = 2 } = {}) {
  const kws = keywords.length ? keywords : tokenize(query);
  if (!kws.length) return [];

  const min = Math.max(1, Number(minScore) || 2);
  const matches = [];

  for (const req of requests) {
    const score = scoreRequestMatch(req, kws);
    if (score >= min) {
      matches.push({
        item: req,
        folder: req._postmanFolder || "",
        score,
      });
    }
  }

  return matches.sort((a, b) => b.score - a.score || String(a.item.name).localeCompare(b.item.name));
}

module.exports = {
  tokenize,
  deriveSearchKeywords,
  scoreRequestMatch,
  searchPostmanRequests,
};
