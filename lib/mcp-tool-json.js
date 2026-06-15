const { toolText } = require("./mcp-client");

function parseMcpToolJson(result) {
  const text = toolText(result);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
  }
  return text;
}

module.exports = { parseMcpToolJson };
