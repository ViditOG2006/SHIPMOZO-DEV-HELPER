/** Extract JSON object from Python script stdout (may include log lines). */

function parsePythonJson(stdout) {
  const raw = (stdout || "").trim();
  if (!raw) return { data: null, error: "No output" };

  try {
    return { data: JSON.parse(raw), error: null };
  } catch {
    /* fall through */
  }

  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      return { data: JSON.parse(line), error: null };
    } catch {
      continue;
    }
  }

  const start = raw.lastIndexOf("\n{");
  if (start >= 0) {
    try {
      return { data: JSON.parse(raw.slice(start + 1)), error: null };
    } catch {
      /* ignore */
    }
  }

  return { data: null, error: `Invalid JSON: ${raw.slice(0, 240)}` };
}

module.exports = { parsePythonJson };
