const { listReports, getReport } = require("./report-archive");
const { buildLivePanelSystemPrompt } = require("./panel-browse");

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "under",
  "again", "further", "then", "once", "here", "there", "when", "where",
  "why", "how", "all", "each", "few", "more", "most", "other", "some",
  "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too",
  "very", "just", "and", "but", "if", "or", "because", "until", "while",
  "me", "my", "i", "you", "your", "we", "our", "they", "their", "it", "its",
  "what", "which", "who", "whom", "this", "that", "these", "those", "am",
  "tell", "show", "give", "help", "please", "method", "way",
]);

function tokenize(query) {
  return String(query)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function scoreChunk(chunk, tokens, moduleBoost = "") {
  const haystack = `${chunk.moduleName} ${chunk.title} ${chunk.text}`.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    const count = (haystack.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
    if (count > 0) score += count * (token.length > 4 ? 3 : 2);
  }

  if (moduleBoost && haystack.includes(moduleBoost.toLowerCase())) {
    score += 5;
  }

  if (chunk.type === "step") score += 2;
  if (chunk.text.includes("![")) score += 3;

  return score;
}

function collectScreenshotsForHits(hits, report) {
  const urls = new Set();
  const shots = [];

  for (const hit of hits) {
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let m;
    while ((m = imgRegex.exec(hit.text)) !== null) {
      if (!urls.has(m[2])) {
        urls.add(m[2]);
        shots.push({ label: m[1] || "Screenshot", url: m[2] });
      }
    }
  }

  if (report?.screenshots?.length) {
    for (const s of report.screenshots) {
      if (s.url && !urls.has(s.url)) {
        urls.add(s.url);
        shots.push({ label: s.label || s.id, url: s.url });
      }
    }
  }

  return shots.slice(0, 8);
}

function searchReports(query, { limit = 6 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return { query, hits: [], reports: [] };

  const allHits = [];

  for (const entry of listReports()) {
    const report = getReport(entry.sessionId);
    if (!report?.chunks?.length) continue;

    for (const chunk of report.chunks) {
      const score = scoreChunk(chunk, tokens, entry.moduleName);
      if (score > 0) {
        allHits.push({
          score,
          sessionId: report.sessionId,
          moduleName: report.moduleName,
          title: chunk.title,
          text: chunk.text,
          type: chunk.type,
          createdAt: report.createdAt,
        });
      }
    }
  }

  allHits.sort((a, b) => b.score - a.score);
  const hits = allHits.slice(0, limit);

  const reportIds = [...new Set(hits.map((h) => h.sessionId))];
  const reports = reportIds.map((id) => {
    const r = getReport(id);
    return r
      ? {
          sessionId: r.sessionId,
          moduleName: r.moduleName,
          screenshotCount: r.screenshots?.length || 0,
          cloud: r.cloud || null,
        }
      : null;
  }).filter(Boolean);

  return { query, tokens, hits, reports };
}

function buildRetrievalContext(searchResult) {
  if (!searchResult.hits.length) {
    return {
      hasContext: false,
      contextText: "",
      sources: [],
      screenshots: [],
    };
  }

  const sections = [];
  const sources = [];

  for (const hit of searchResult.hits) {
    sections.push(
      `### [${hit.moduleName}] ${hit.title} (session: ${hit.sessionId})\n${hit.text}`
    );
    if (!sources.find((s) => s.sessionId === hit.sessionId)) {
      sources.push({
        sessionId: hit.sessionId,
        moduleName: hit.moduleName,
        title: hit.title,
      });
    }
  }

  const primaryReport = getReport(searchResult.hits[0].sessionId);
  const screenshots = collectScreenshotsForHits(searchResult.hits, primaryReport);

  return {
    hasContext: true,
    contextText: sections.join("\n\n---\n\n"),
    sources,
    screenshots,
  };
}

function buildKnowledgeSystemPrompt(baseSystem, retrieval) {
  if (!retrieval.hasContext) {
    return `${baseSystem}

No matching content was found in saved PRDs or user manuals.
Tell the user they can generate documentation first in the Module Docs tab, then ask again.`;
  }

  const shotList =
    retrieval.screenshots?.length > 0
      ? retrieval.screenshots
          .map((s) => `- ${s.label}: ![${s.label}](${s.url})`)
          .join("\n")
      : "(no screenshot URLs in library)";

  return `${baseSystem}

You answer Shipmozo operator questions using the SAVED USER MANUAL excerpts below.
Rules:
- NEVER say you cannot provide screenshots — you HAVE screenshot URLs below; embed them as Markdown images
- Write a DETAILED guide: expand into 8–15 numbered steps with exact UI labels, field names, and expected results
- Use sections: ## Overview, ## Step-by-step, ## Tips
- Prefer exact steps and wording from the manual excerpts
- Under each step, embed the matching screenshot: ![label](url)
- Mention which module the steps come from
- If excerpts are incomplete, say what is missing
- Do not invent UI labels or flows not in the excerpts
- Do not tell the user to go to Help/Support — use the saved manual content

--- SCREENSHOT URLS (embed these in your answer) ---
${shotList}
--- END SCREENSHOTS ---

--- SAVED MANUAL EXCERPTS ---
${retrieval.contextText}
--- END EXCERPTS ---`;
}

function liveBrowseMatchesQuery(browse, query) {
  const pageText = (browse.pages || [])
    .map((p) => `${p.title || ""} ${p.text || ""} ${(p.buttons || []).join(" ")}`)
    .join(" ")
    .toLowerCase();
  if (!pageText.trim()) return false;

  const tokens = tokenize(query).filter((t) => t.length > 2);
  if (!tokens.length) return pageText.length > 200;
  return tokens.some((t) => pageText.includes(t));
}

function buildHybridSystemPrompt(baseSystem, browse, storedScreenshots, manualRetrieval) {
  const livePrompt = buildLivePanelSystemPrompt(
    baseSystem,
    browse,
    storedScreenshots
  );

  if (!manualRetrieval?.hasContext) return livePrompt;

  return `${livePrompt}

Also use this SAVED USER MANUAL from a prior verified capture (prefer live panel when both agree; use manual to fill gaps):
--- SAVED MANUAL (supplement) ---
${manualRetrieval.contextText}
--- END SAVED MANUAL ---`;
}

module.exports = {
  searchReports,
  buildRetrievalContext,
  buildKnowledgeSystemPrompt,
  buildHybridSystemPrompt,
  liveBrowseMatchesQuery,
  tokenize,
};
