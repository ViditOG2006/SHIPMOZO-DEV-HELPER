/** Extract and repair JSON from LLM text (markdown fences, truncation, trailing commas). */

function repairJsonText(text) {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/\r\n/g, "\n");
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryCloseTruncatedJson(text) {
  let s = repairJsonText(text.trim());
  const start = s.indexOf("{");
  if (start < 0) return null;
  s = s.slice(start);

  const attempts = [s];
  const openBraces = (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;
  const openBrackets = (s.match(/\[/g) || []).length - (s.match(/]/g) || []).length;
  if (openBraces > 0 || openBrackets > 0) {
    let closed = s.replace(/,\s*$/, "");
    closed += "]".repeat(Math.max(0, openBrackets));
    closed += "}".repeat(Math.max(0, openBraces));
    attempts.push(closed);
  }

  for (const candidate of attempts) {
    const parsed = tryParseJson(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function extractSheetRowsArray(text) {
  const match = text.match(/"sheetRows"\s*:\s*\[/);
  if (!match) return null;

  const startIdx = text.indexOf("[", match.index);
  if (startIdx < 0) return null;

  const rows = [];
  let depth = 0;
  let objStart = -1;

  for (let i = startIdx + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        const chunk = text.slice(objStart, i + 1);
        const obj = tryParseJson(repairJsonText(chunk));
        if (obj) rows.push(obj);
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }

  return rows.length ? rows : null;
}

function extractScenariosArray(text) {
  const match = text.match(/"scenarios"\s*:\s*\[/);
  if (!match) return null;

  const startIdx = text.indexOf("[", match.index);
  if (startIdx < 0) return null;

  const scenarios = [];
  let depth = 0;
  let objStart = -1;

  for (let i = startIdx + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        const chunk = text.slice(objStart, i + 1);
        const obj = tryParseJson(repairJsonText(chunk));
        if (obj) scenarios.push(obj);
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }

  return scenarios.length ? scenarios : null;
}

function extractJsonFromLlm(text) {
  const raw = (text || "").trim();
  if (!raw) return { data: null, error: "empty response" };

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = tryParseJson(repairJsonText(fence[1].trim())) || tryCloseTruncatedJson(fence[1]);
    if (parsed) return { data: parsed, error: null };
  }

  let parsed = tryParseJson(repairJsonText(raw));
  if (parsed) return { data: parsed, error: null };

  parsed = tryCloseTruncatedJson(raw);
  if (parsed) return { data: parsed, error: null };

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    parsed = tryParseJson(repairJsonText(raw.slice(start, end + 1)));
    if (parsed) return { data: parsed, error: null };
    parsed = tryCloseTruncatedJson(raw.slice(start, end + 1));
    if (parsed) return { data: parsed, error: null };
  }

  const scenarios = extractScenariosArray(raw);
  if (scenarios?.length) {
    const titleMatch = raw.match(/"title"\s*:\s*"([^"]*)"/);
    const summaryMatch = raw.match(/"summary"\s*:\s*"([^"]*)"/);
    return {
      data: {
        title: titleMatch?.[1] || "Test dataset",
        summary: summaryMatch?.[1] || "Recovered from partial AI response",
        scenarios,
        markdownSummary: "",
      },
      error: null,
      partial: true,
    };
  }

  const sheetRows = extractSheetRowsArray(raw);
  if (sheetRows?.length) {
    const titleMatch = raw.match(/"title"\s*:\s*"([^"]*)"/);
    const summaryMatch = raw.match(/"summary"\s*:\s*"([^"]*)"/);
    const moduleShortCodeMatch = raw.match(/"moduleShortCode"\s*:\s*"([^"]*)"/);
    return {
      data: {
        title: titleMatch?.[1] || "Test dataset",
        summary: summaryMatch?.[1] || "Recovered from partial AI response",
        moduleShortCode: moduleShortCodeMatch?.[1],
        sheetRows,
        markdownSummary: "",
      },
      error: null,
      partial: true,
    };
  }

  return { data: null, error: `Could not parse JSON (${raw.slice(0, 180)}…)` };
}

module.exports = {
  extractJsonFromLlm,
  repairJsonText,
  tryCloseTruncatedJson,
  extractSheetRowsArray,
  extractScenariosArray,
};
