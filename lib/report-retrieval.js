const { listReports, getReport } = require("./report-archive");
const { buildLivePanelSystemPrompt } = require("./panel-browse");
const { normalizeMediaSrc, normalizeMarkdownImages } = require("./media-url");

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

function normalizeScreenshotEntry(entry) {
  if (!entry?.url) return null;
  return {
    label: entry.label || entry.id || "Screenshot",
    url: normalizeMediaSrc(entry.url),
    id: entry.id || null,
  };
}

function collectScreenshotsForHits(hits, report) {
  const urls = new Set();
  const shots = [];

  const addShot = (label, url) => {
    const normalized = normalizeMediaSrc(url);
    if (!normalized || urls.has(normalized)) return;
    urls.add(normalized);
    shots.push({ label: label || "Screenshot", url: normalized });
  };

  for (const hit of hits) {
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let m;
    while ((m = imgRegex.exec(hit.text)) !== null) {
      addShot(m[1], m[2]);
    }
  }

  if (report?.screenshots?.length) {
    for (const s of report.screenshots) {
      const entry = normalizeScreenshotEntry(s);
      if (entry) addShot(entry.label, entry.url);
    }
  }

  const manual = String(report?.user_manual || "");
  if (manual) {
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let m;
    while ((m = imgRegex.exec(manual)) !== null) {
      addShot(m[1], m[2]);
    }
  }

  return shots.slice(0, 8);
}

async function searchReports(query, { limit = 6 } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return { query, hits: [], reports: [] };

  const allHits = [];
  const entries = await listReports();

  for (const entry of entries) {
    const report = await getReport(entry.sessionId);
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
  const reports = (
    await Promise.all(
      reportIds.map(async (id) => {
        const r = await getReport(id);
        return r
          ? {
              sessionId: r.sessionId,
              moduleName: r.moduleName,
              screenshotCount: r.screenshots?.length || 0,
              cloud: r.cloud || null,
            }
          : null;
      })
    )
  ).filter(Boolean);

  return { query, tokens, hits, reports };
}

async function buildRetrievalContextForSession(sessionId, query = "", { limit = 8 } = {}) {
  const report = await getReport(sessionId);
  if (!report?.chunks?.length) {
    return {
      hasContext: false,
      contextText: "",
      sources: [],
      screenshots: [],
    };
  }

  const tokens = tokenize(query);
  let hits = [];

  if (tokens.length) {
    hits = report.chunks
      .map((chunk) => ({
        score: scoreChunk(chunk, tokens, report.moduleName),
        sessionId: report.sessionId,
        moduleName: report.moduleName,
        title: chunk.title,
        text: chunk.text,
        type: chunk.type,
        createdAt: report.createdAt,
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  if (!hits.length) {
    hits = report.chunks.slice(0, limit).map((chunk) => ({
      score: 1,
      sessionId: report.sessionId,
      moduleName: report.moduleName,
      title: chunk.title,
      text: chunk.text,
      type: chunk.type,
      createdAt: report.createdAt,
    }));
  }

  return await buildRetrievalContext({ query, tokens, hits, reports: [report] });
}

async function buildRetrievalContext(searchResult) {
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
      `### [${hit.moduleName}] ${hit.title} (session: ${hit.sessionId})\n${normalizeMarkdownImages(hit.text)}`
    );
    if (!sources.find((s) => s.sessionId === hit.sessionId)) {
      sources.push({
        sessionId: hit.sessionId,
        moduleName: hit.moduleName,
        title: hit.title,
      });
    }
  }

  const primaryReport = searchResult.hits[0]
    ? await getReport(searchResult.hits[0].sessionId)
    : null;
  const screenshots = collectScreenshotsForHits(searchResult.hits, primaryReport);

  let contextText = sections.join("\n\n---\n\n");
  const prdExcerpt = excerptPrd(primaryReport?.prd);
  if (prdExcerpt) {
    contextText = `### PRD — ${primaryReport.moduleName} (session: ${primaryReport.sessionId})\n${prdExcerpt}\n\n---\n\n${contextText}`;
  }

  return {
    hasContext: true,
    contextText,
    sources,
    screenshots,
  };
}

function excerptPrd(prd, maxChars = 4500) {
  const text = String(prd || "").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...(PRD truncated for prompt size)...`;
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
          .map((s) => {
            const url = normalizeMediaSrc(s.url);
            return `- ${s.label}: ![${s.label}](${url})`;
          })
          .join("\n")
      : "(no screenshot URLs in library)";

  return `${baseSystem}

You answer Shipmozo operator questions using the SAVED PRD and USER MANUAL excerpts below.
Rules:
- NEVER say you cannot provide screenshots — you HAVE screenshot URLs below; embed them as Markdown images
- COPY EXACT ![label](url) markdown from the SCREENSHOT URLS section below — do NOT invent URLs, placeholders, or relative paths
- If a step has no matching screenshot in the list, describe the step in text only — never fabricate image links
- Write a DETAILED guide: expand into 8–15 numbered steps with exact UI labels, field names, and expected results
- Use sections: ## Overview, ## Step-by-step, ## Tips
- Prefer exact steps and wording from the manual excerpts
- Under each step, embed the matching screenshot using the exact URL from SCREENSHOT URLS
- Mention which module the steps come from
- If excerpts are incomplete, say what is missing
- Do not invent UI labels or flows not in the excerpts
- Do not tell the user to go to Help/Support — use the saved manual content

--- SCREENSHOT URLS (copy these EXACT markdown image lines into your answer) ---
${shotList}
--- END SCREENSHOTS ---

--- SAVED PRD + MANUAL EXCERPTS ---
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

  const shotList =
    manualRetrieval.screenshots?.length > 0
      ? manualRetrieval.screenshots
          .map((s) => `- ${s.label}: ![${s.label}](${normalizeMediaSrc(s.url)})`)
          .join("\n")
      : "(no saved manual screenshots)";

  return `${livePrompt}

Also use this SAVED USER MANUAL from a prior verified capture (prefer live panel when both agree; use manual to fill gaps):
- COPY EXACT ![label](url) from SAVED MANUAL SCREENSHOTS — never invent placeholder image URLs

--- SAVED MANUAL SCREENSHOTS ---
${shotList}
--- END SAVED MANUAL SCREENSHOTS ---

--- SAVED MANUAL (supplement) ---
${manualRetrieval.contextText}
--- END SAVED MANUAL ---`;
}

module.exports = {
  searchReports,
  buildRetrievalContext,
  buildRetrievalContextForSession,
  buildKnowledgeSystemPrompt,
  buildHybridSystemPrompt,
  liveBrowseMatchesQuery,
  tokenize,
};
