const { spawn } = require("child_process");
const path = require("path");
const { storeScreenshotBatch } = require("./image-storage");
const { parsePythonJson } = require("./parse-python-json");
const {
  normalizeMediaSrc,
  isResolvableMediaUrl,
  normalizeMarkdownImages,
  extractMarkdownImageUrls,
  repairMarkdownImages,
} = require("./media-url");

const ROOT = path.join(__dirname, "..");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const BROWSE_TIMEOUT_MS = Number(process.env.PANEL_BROWSE_TIMEOUT_MS || 150000);

function chatSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `chat_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function runPanelBrowse(query, sessionId = chatSessionId(), timeoutMs = BROWSE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const proc = spawn(
      PYTHON_BIN,
      ["-u", path.join(ROOT, "parse_panel_for_chat.py"), sessionId, query],
      { cwd: ROOT, env: process.env }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        error: `Panel browse timed out after ${Math.round(timeoutMs / 1000)}s`,
        sessionId,
        query,
        pages: [],
        screenshots: [],
      });
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      finish({
        ok: false,
        error: err.message || "Failed to start panel browse",
        sessionId,
        query,
        pages: [],
        screenshots: [],
      });
    });

    proc.on("close", () => {
      const raw = stdout.trim();
      if (!raw) {
        finish({
          ok: false,
          error: stderr.trim() || "Panel browse produced no output",
          sessionId,
          query,
          pages: [],
          screenshots: [],
        });
        return;
      }
      const { data, error } = parsePythonJson(raw);
      if (!data) {
        finish({
          ok: false,
          error: error || `Invalid browse JSON: ${raw.slice(0, 200)}`,
          sessionId,
          query,
          pages: [],
          screenshots: [],
        });
        return;
      }
      finish(data);
    });
  });
}

function browseTimeoutMs(req) {
  const host = String(req?.headers?.host || "").toLowerCase();
  if (host.includes("trycloudflare.com") || host.includes("cfargotunnel.com")) {
    return Number(process.env.TUNNEL_BROWSE_TIMEOUT_MS || 85000);
  }
  return BROWSE_TIMEOUT_MS;
}

async function browsePanelForChat(query, { timeoutMs } = {}) {
  const sessionId = chatSessionId();
  const result = await runPanelBrowse(query, sessionId, timeoutMs || BROWSE_TIMEOUT_MS);

  const poorLabel = (s) =>
    /filter|search|loading|scrolled|full page|row selected|bulk action/i.test(
      `${s.label || ""} ${s.id || ""}`
    );

  result.pages = (result.pages || []).filter((p) => !p.notFound && !p.poorScreenshot);
  const okUrls = new Set(
    result.pages.map((p) => (p.url || "").split("?")[0]).filter(Boolean)
  );
  result.screenshots = (result.screenshots || []).filter((s) => {
    if (poorLabel(s)) return false;
    const u = (s.url || "").split("?")[0];
    const navShot =
      /module view|navigation:/i.test(s.label || "") || s.id === "after_login";
    if (!navShot && u && !okUrls.has(u)) return false;
    return !u || okUrls.has(u) || s.id === "after_login";
  });

  let screenshots = [];
  if (result.screenshots?.length) {
    try {
      screenshots = await storeScreenshotBatch(sessionId, result.screenshots);
    } catch (err) {
      result.storageError = err.message;
    }
  }

  return { ...result, sessionId, storedScreenshots: screenshots };
}

function formatPagesForPrompt(pages) {
  if (!pages?.length) return "(No page content captured)";
  return pages
    .map((p, i) => {
      if (p.error) return `### Page ${i + 1} — error\nURL: ${p.url}\nError: ${p.error}`;
      const fields = (p.fields || []).join(", ");
      const buttons = (p.buttons || []).join(", ");
      const links = (p.sidebarLinks || [])
        .slice(0, 12)
        .map((l) => l.text)
        .join(", ");
      return `### Page ${i + 1}: ${p.pageLabel || p.title || "Shipmozo panel"}
URL: ${p.url}
Sidebar: ${links}
Buttons: ${buttons}
Form fields: ${fields}

Visible text:
${p.text || "(empty)"}`;
    })
    .join("\n\n---\n\n");
}

function buildLivePanelSystemPrompt(baseSystem, browse, storedScreenshots) {
  const shotLines =
    storedScreenshots?.length > 0
      ? storedScreenshots
          .map((s) => `- ${s.label}: ![${s.label}](${s.url})`)
          .join("\n")
      : "(no screenshots)";

  const pageBlock = formatPagesForPrompt(browse.pages);

  return `${baseSystem}

You are answering by parsing the LIVE Shipmozo merchant panel (just browsed with Playwright).
Rules:
- Base your answer ONLY on the live page text, buttons, fields, and screenshots below
- Write a DETAILED operator guide: at least 8–15 numbered steps when the task allows
- For each step include: where to click (exact sidebar/menu/button label), what fields to fill, and what you should see after
- Use markdown sections: ## Overview, ## Prerequisites, ## Step-by-step, ## Tips / common issues
- Embed screenshot markdown images inline immediately after the step they illustrate — NEVER say you cannot provide screenshots
- Do NOT reference saved manuals, Help/Support docs, or guess flows not visible on the pages
- Do NOT embed or describe screenshots that show "page not found", loading spinners, or filter/search drawers
- Prefer screenshots labeled "Module view" or "Navigation" — they show the sidebar and main module screen
- Explain navigation: which sidebar menu to expand and which item to click to reach the feature
- If the live pages do not show enough detail, say what was missing and which menu path to try

User question context: ${browse.query || ""}

--- LIVE SCREENSHOTS (embed in answer) ---
${shotLines}
--- END SCREENSHOTS ---

--- LIVE PAGE PARSE ---
${pageBlock}
--- END LIVE PARSE ---`;
}

function normalizeScreenshotList(screenshots) {
  return (screenshots || [])
    .map((s) => {
      if (!s?.url) return null;
      return {
        ...s,
        label: s.label || s.id || "Screenshot",
        url: normalizeMediaSrc(s.url),
      };
    })
    .filter(Boolean);
}

function appendScreenshotsIfMissing(reply, screenshots) {
  const shots = normalizeScreenshotList(screenshots);
  let out = normalizeMarkdownImages(reply);

  if (!shots.length) return out;

  out = repairMarkdownImages(out, shots);
  const embedded = extractMarkdownImageUrls(out);
  const working = embedded.filter(isResolvableMediaUrl);

  const unused = shots.filter((s) => s.url && !embedded.includes(s.url));

  if (!working.length) {
    const block = shots
      .map((s) => `**${s.label}**\n\n![${s.label}](${s.url})`)
      .join("\n\n");
    return `${out.trim()}\n\n### Screenshots from saved manual\n\n${block}`;
  }

  if (unused.length) {
    const block = unused
      .map((s) => `**${s.label}**\n\n![${s.label}](${s.url})`)
      .join("\n\n");
    out = `${out.trim()}\n\n### Screenshots from saved manual\n\n${block}`;
  }

  return out;
}

function mergeScreenshots(liveShots, manualShots) {
  const urls = new Set();
  const out = [];
  for (const s of normalizeScreenshotList([...(liveShots || []), ...(manualShots || [])])) {
    if (s.url && !urls.has(s.url)) {
      urls.add(s.url);
      out.push(s);
    }
  }
  return out.slice(0, 10);
}

module.exports = {
  browsePanelForChat,
  browseTimeoutMs,
  buildLivePanelSystemPrompt,
  appendScreenshotsIfMissing,
  mergeScreenshots,
};
