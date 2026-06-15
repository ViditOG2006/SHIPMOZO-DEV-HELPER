const { toolText } = require("./mcp-client");

/** Postman minimal MCP often returns markdown tables instead of JSON. */
function parsePostmanMcpResult(result) {
  const text = toolText(result);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    /* markdown */
  }

  const workspaces = parseMarkdownTable(text).map((row) => ({
    id: row.id,
    name: decodeHtml(row.name || ""),
    type: row.type,
  }));
  if (workspaces.length && /workspace/i.test(text)) {
    return { workspaces };
  }

  const collections = parseMarkdownTable(text).map((row) => ({
    id: row.id || row.uid,
    name: decodeHtml(row.name || ""),
    uid: row.uid || row.id,
  }));
  if (collections.length && /collection/i.test(text)) {
    return { collections };
  }

  const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      /* ignore */
    }
  }

  return { rawMarkdown: text };
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

function parseMarkdownTable(text) {
  const lines = String(text || "").split("\n");
  const headerIdx = lines.findIndex((l) => /^\|/.test(l) && /\|/.test(l) && !/^\|[-\s|]+\|$/.test(l.trim()));
  if (headerIdx < 0 || headerIdx + 1 >= lines.length) return [];

  const headers = lines[headerIdx]
    .split("|")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const rows = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("|")) break;
    if (/^\|[-\s|]+\|$/.test(line)) continue;
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    if (!cells.length) continue;
    const row = {};
    headers.forEach((h, j) => {
      row[h] = cells[j] || "";
    });
    rows.push(row);
  }
  return rows;
}

module.exports = { parsePostmanMcpResult, parseMarkdownTable };
