const path = require("path");
const { runPythonScript } = require("./spawn-python");
const { parsePythonJson } = require("./parse-python-json");
const { callLLM, MAX_OUTPUT_TOKENS } = require("./llm");
const { storeScreenshotBatch, storeVideoBatch } = require("./image-storage");
const { saveReport } = require("./report-archive");
const {
  getReportExamplesContext,
  isShipmozoRelated,
  EXAMPLE_PRD_STRUCTURE,
  EXAMPLE_TECH_GUIDE_STRUCTURE,
} = require("./report-examples");
const { getGithubContextText } = require("./github-repo-context");
const { isReportMcpEnabled, isSplitDocPipeline } = require("./mcp-report-generation");
const { paceReportGeneration } = require("./llm-throttle");
const { resolvePrdLlmPair, resolveManualLlmPair } = require("./report-llm-split");
const { isRenderDeploy } = require("./public-url");

const DOCS_RECORD_VIDEO = (() => {
  const explicit = process.env.DOCS_RECORD_VIDEO;
  if (explicit != null && String(explicit).trim() !== "") {
    return String(explicit).trim().toLowerCase() === "true";
  }
  return false;
})();
const DOCS_PRD_INCLUDE_GITHUB =
  String(process.env.DOCS_PRD_INCLUDE_GITHUB ?? "false").trim().toLowerCase() === "true";

const { generateDocViaMcpAgent } = require("./mcp-report-agent");
const { validatePrdQuality } = require("./prd-quality");
const { sanitizeMermaidBlocksInMarkdown, MERMAID_PRD_RULES } = require("./mermaid-sanitize");
const { formatLessonsForPrompt } = require("./ai-heal-lessons");
const { isBackendOnlyModule } = require("./backend-only-module");
const {
  isDocsCaptureHealEnabled,
  proposeScreenshotHealPlan,
  healPlanEnvValue,
  resolveHealProvider,
} = require("./ai-screenshot-heal");
const {
  isCaptureMcpHealEnabled,
  runMcpClaudeHealRound,
} = require("./capture-mcp-claude-heal");

const ROOT = path.join(__dirname, "..");

function isDocsGenFast() {
  const v = String(process.env.DOCS_GEN_FAST ?? "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

const DOCS_PRD_MAX_TOKENS = Number(
  process.env.DOCS_PRD_MAX_TOKENS || (isDocsGenFast() ? 3000 : MAX_OUTPUT_TOKENS)
);
const DOCS_MANUAL_MAX_TOKENS = Number(
  process.env.DOCS_MANUAL_MAX_TOKENS || (isDocsGenFast() ? 2800 : MAX_OUTPUT_TOKENS)
);
const DOCS_PRD_TIMEOUT_MS = Number(
  process.env.DOCS_PRD_TIMEOUT_MS || (isDocsGenFast() ? 120000 : 600000)
);
const DOCS_MANUAL_TIMEOUT_MS = Number(
  process.env.DOCS_MANUAL_TIMEOUT_MS || (isDocsGenFast() ? 120000 : 600000)
);
const PRD_IN_MANUAL_MAX_CHARS_FAST = Number(
  process.env.PRD_IN_MANUAL_MAX_CHARS || (isDocsGenFast() ? 4000 : 10000)
);
const PRD_IN_MANUAL_MAX_CHARS = PRD_IN_MANUAL_MAX_CHARS_FAST;

const COMPACT_PRD_STRUCTURE = `
1. **Module Overview & Business Purpose**
2. **UI Structure & User Actions**
3. **Workflow & Business Rules**
4. **Dependencies & Module Linkages**
5. **Data & Field Presence Mapping**
6. **System Architecture** (brief + one mermaid flowchart)
7. **Key APIs** (bullet list only)
`.trim();

const COMPACT_MANUAL_STRUCTURE = `
1. Purpose · 2. Who Uses It · 3. UI Overview · 4. Step-by-Step Actions (numbered)
5. Common Workflows · 6. Errors/Tips
`.trim();

const BACKEND_ONLY_PRD_STRUCTURE = `
1. **Service Overview & Business Purpose**
2. **API Endpoints** (method, path, auth, purpose per endpoint)
3. **Request & Response Schemas** (fields, types, examples)
4. **Validation & Business Rules**
5. **Error Codes & Failure Modes**
6. **Data Model & Persistence**
7. **Integrations & Dependencies** (webhooks, queues, downstream services)
8. **Non-Functional Requirements** (performance, security, rate limits)
`.trim();

const API_INTEGRATION_GUIDE_STRUCTURE = `
1. **Overview & Use Cases**
2. **Authentication & Base URL**
3. **Endpoint Reference** (method, path, headers, body, response)
4. **Request Examples** (curl or JSON samples)
5. **Error Handling**
6. **Webhooks / Callbacks** (if applicable)
7. **Testing Notes**
`.trim();

function resolveFastDocLlmPair() {
  const provider =
    process.env.REPORT_PRD_PROVIDER ||
    process.env.REPORT_MANUAL_PROVIDER ||
    "azure-openai";
  const model =
    process.env.REPORT_PRD_MODEL ||
    process.env.REPORT_MANUAL_MODEL ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    "gpt-4.1-mini";
  return { provider, model };
}

async function withGithubContext(prompt, { moduleName = "", query = "" } = {}) {
  const { text, error } = await getGithubContextText({ moduleName, query: query || moduleName });
  if (!text) {
    if (error) {
      return `${prompt}\n\n(GitHub source skipped: ${error})`;
    }
    return prompt;
  }
  return `${prompt}

--- PANEL SOURCE CODE (public GitHub) ---
GitHub may lag production. Priority: (1) live screenshots, (2) Quick Search navigation (Ctrl+B on dashboard → search module → Enter), (3) PRD/user notes.
Use repo for field names and API hints only when consistent with live panel — not outdated sidebar routes.
${text}
--- end GitHub source ---`;
}

async function maybeGithubContext(prompt, { moduleName = "", query = "" } = {}) {
  if (!DOCS_PRD_INCLUDE_GITHUB) return prompt;
  return withGithubContext(prompt, { moduleName, query });
}

const EXAMPLE_SOURCES = [
  {
    title: "Shipmozo report templates (Google Doc)",
    url: "https://docs.google.com/document/d/1dSZGnrEbOfBjiSPBnxzGdG22-PnstyG3vFh268kRBk0/edit",
  },
];

function finalizePrdMarkdown(text) {
  return sanitizeMermaidBlocksInMarkdown(String(text || ""));
}

function appendMediaToManual(manual, screenshots = [], videos = []) {
  let out = String(manual || "").trim();
  const hasImages = /!\[[^\]]*\]\([^)]+\)/.test(out);
  const hasVideos =
    /\[▶[^\]]*\]\([^)]+\)/.test(out) ||
    /\[[^\]]*\]\([^)]+\.(webm|mp4|mov|m4v)(\?|#|$)/i.test(out) ||
    /\/videos\//i.test(out);

  if (screenshots.length && !hasImages) {
    const block = screenshots
      .map((s) => `**${s.label}**\n\n![${s.label}](${s.url})`)
      .join("\n\n");
    out += `\n\n## Screenshots from live panel\n\n${block}`;
  }

  if (videos.length && !hasVideos) {
    const block = videos.map((v) => `[▶ ${v.label}](${v.url})`).join("\n\n");
    out += `\n\n## Screen recordings\n\n${block}`;
  }

  return out;
}

function finalizeManualMarkdown(manual, screenshots = [], videos = []) {
  return appendMediaToManual(
    sanitizeMermaidBlocksInMarkdown(String(manual || "")),
    screenshots,
    videos
  );
}

function nowSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildDocSystem(moduleName, description) {
  const fast = isDocsGenFast();
  const knownIssues = formatLessonsForPrompt({ maxLessons: fast ? 4 : 12 });
  const mcpNote = isReportMcpEnabled()
    ? "\n- When an MCP CONTEXT block is present: treat Postman APIs and Playwright UI snapshot as primary evidence for sections 2, 6, and 7; mark gaps as TBD.\n"
    : "";
  const examples = fast ? "" : `${getReportExamplesContext()}\n\n`;
  const fastRules = fast
    ? "- Be concise; one mermaid diagram max; no appendix beyond section 7\n"
    : `- Mermaid diagrams where useful\n- ${MERMAID_PRD_RULES}\n- Match example report rigor`;
  return `You are a Senior QA Architect + Product Engineer for Shipmozo-style logistics SaaS.

${knownIssues ? `${knownIssues}\n` : ""}${examples}Rules:
- Markdown only, no filler preamble
- No duplication; tight professional prose
${fastRules}${mcpNote}`;
}

function buildDocSystemForManual(moduleName, description) {
  if (!isDocsGenFast()) return buildDocSystem(moduleName, description);
  return `You are a technical writer for Shipmozo merchant panel operators.
Write a concise user manual in Markdown. Embed provided screenshot/video URLs verbatim. Number steps.`;
}

function buildPrdPromptBackendOnly({ moduleName, description }) {
  const appendix = isDocsGenFast()
    ? "Keep total output under ~2500 words. One mermaid sequence diagram for request lifecycle."
    : `Add **Technical Appendix** in the same document:
## Integration Examples
- Sample requests/responses and webhook payloads

## Operational Notes
- Deployment, monitoring, retry/idempotency assumptions

Target: a developer can implement and integrate without panel UI knowledge.`;

  return `Generate a **backend/API technical PRD** for service: **${moduleName}**.

This is an API-only backend service with **NO merchant panel UI**. Do NOT include UI Structure, screenshots, panel navigation, operator workflows, or user-manual-style click paths.

${description ? `User context:\n${description}\n` : ""}

Use this structure EXACTLY:

${BACKEND_ONLY_PRD_STRUCTURE}

${appendix}`;
}

function buildApiIntegrationGuidePrompt({ moduleName, description, prd }) {
  return `Write an **API Integration Guide** for backend service: **${moduleName}**.

Audience: engineers integrating with this API (not panel operators). No UI screenshots or panel workflows.

${description ? `User context:\n${description}\n` : ""}

Follow this structure:
${API_INTEGRATION_GUIDE_STRUCTURE}

--- Technical PRD (reference — do not repeat verbatim) ---
${prd}
--- end PRD ---

Requirements:
- Markdown only, numbered steps where helpful
- Include concrete endpoint paths and field names from the PRD
- Mark unknowns as TBD rather than inventing panel UI`;
}

function buildPrdPrompt({ moduleName, description, backendOnly }) {
  if (backendOnly || isBackendOnlyModule({ moduleName, description, backendOnly })) {
    return buildPrdPromptBackendOnly({ moduleName, description });
  }
  const structure = isDocsGenFast() ? COMPACT_PRD_STRUCTURE : EXAMPLE_PRD_STRUCTURE;
  const appendix = isDocsGenFast()
    ? "Keep total output under ~2500 words. One mermaid flowchart required."
    : `Then add **Technical Appendix** (all engineering detail in this same document):
## 6. System Architecture
- Services, panels (User vs Partner), communication patterns, Mermaid diagram

## 7. Data Model & APIs
- Entities, relationships (Mermaid ER diagram — follow erDiagram rules above), key API endpoints and webhooks

## 8. Integrations & Infrastructure
- Couriers, channels (Shopify etc.), queues/cron, auth, observability

## 9. Non-Functional Requirements
- Performance, security, compliance, scale assumptions

Target: one self-contained PRD a developer can implement from — not a high-level summary only.`;

  return `Generate a **complete technical PRD** for module: **${moduleName}**.

${description ? `User context:\n${description}\n` : ""}

Use this structure EXACTLY:

${structure}

${appendix}`;
}

function buildManualPrompt({ moduleName, description, prd, screenshots, videos = [], backendOnly }) {
  if (backendOnly || isBackendOnlyModule({ moduleName, description, backendOnly })) {
    return buildApiIntegrationGuidePrompt({ moduleName, description, prd });
  }
  const shotList =
    screenshots.length > 0
      ? screenshots
          .map(
            (s, i) =>
              `${i + 1}. **${s.label}** (id: ${s.id}) → embed: ![${s.label}](${s.url})`
          )
          .join("\n")
      : "(No live screenshots — write steps and mark [Screenshot: description] placeholders)";

  const videoList =
    videos.length > 0
      ? videos
          .map(
            (v, i) =>
              `${i + 1}. **${v.label}** (id: ${v.id}) → link: [▶ ${v.label}](${v.url})`
          )
          .join("\n")
      : "(No screen recording — describe modal flows in text)";

  return `Write a **User Manual** (operator training guide) for module: **${moduleName}**.

${description ? `User context:\n${description}\n` : ""}

Follow this guide structure:
${isDocsGenFast() ? COMPACT_MANUAL_STRUCTURE : EXAMPLE_TECH_GUIDE_STRUCTURE}

--- Technical PRD (reference — do not repeat verbatim) ---
${prd}
--- end PRD ---

--- Live screenshots (MUST embed in matching steps) ---
${shotList}
--- end screenshots ---

--- Screen recordings (link under matching workflow steps) ---
${videoList}
--- end videos ---

Requirements:
1. Number every user action step (1. 2. 3.) per workflow
2. Embed screenshots ONLY from the list above — copy the exact ![label](url) line verbatim
3. Under steps that show motion, modals opening, or multi-click flows, add the matching [▶ label](url) video link from the list above
4. NEVER invent image or video URLs — use only URLs from the screenshot and video lists
5. If no screenshot matches a step, write **[Screenshot: short description]** as plain text (no ![](...) markdown)
6. Sections: Purpose, Who Uses It, UI Overview, Filters, Bulk Actions, Step-by-Step Actions, Related Modules, Common Workflows, Errors/Tips
7. Mark steps as **Verified (screenshot)** or **Verified (video)** when real media from the lists is included
8. Practical tone — new employee can operate the module from this manual alone`;
}

function resolveCaptureHealAttempts() {
  if (!isDocsCaptureHealEnabled()) return 1;
  const onRender = isRenderDeploy();
  if (onRender) return 1;
  const explicit = process.env.DOCS_CAPTURE_HEAL_ATTEMPTS;
  if (explicit != null && String(explicit).trim() !== "") {
    return Math.max(1, Number(explicit) || 1);
  }
  return 5;
}

function resolveCaptureBudgetS() {
  const explicit = process.env.DOCS_CAPTURE_BUDGET_S;
  let budget;
  if (explicit != null && String(explicit).trim() !== "") {
    budget = Number(explicit) || 120;
  } else if (isRenderDeploy()) {
    budget = 180;
  } else if (isDocsCaptureHealEnabled()) {
    budget = 180;
  } else {
    const captureFast =
      String(process.env.DOCS_CAPTURE_FAST ?? "true").trim().toLowerCase() !== "false";
    budget = isDocsGenFast() ? 120 : captureFast ? 100 : 120;
  }
  if (DOCS_RECORD_VIDEO && budget < 330) budget = 330;
  return budget;
}

function resolveCaptureTimeoutMs() {
  const budgetS = resolveCaptureBudgetS();
  const minFromBudget = (budgetS + 120) * 1000;
  const videoFloor = DOCS_RECORD_VIDEO ? 450000 : 0;
  const explicit = process.env.DOCS_CAPTURE_TIMEOUT_MS;
  if (explicit != null && String(explicit).trim() !== "") {
    return Math.max(Number(explicit) || 150000, minFromBudget, videoFloor);
  }
  if (isRenderDeploy()) {
    return Math.max(DOCS_RECORD_VIDEO ? 450000 : 120000, minFromBudget, videoFloor);
  }
  if (isDocsCaptureHealEnabled() && isCaptureMcpHealEnabled()) {
    return Math.max(180000, minFromBudget, videoFloor);
  }
  if (isDocsCaptureHealEnabled()) return Math.max(150000, minFromBudget, videoFloor);
  return Math.max(isDocsGenFast() ? 120000 : 150000, minFromBudget, videoFloor);
}

function attemptTimeoutMs(baseMs, attempt) {
  const scaled = baseMs * (1 + 0.25 * (attempt - 1));
  return Math.min(Math.round(scaled), 420000);
}

function attemptBudgetS(baseBudget, attempt) {
  return Math.round(baseBudget * (1 + 0.15 * (attempt - 1)));
}

const DOCS_CAPTURE_TIMEOUT_MS = resolveCaptureTimeoutMs();
const DOCS_CAPTURE_MAX_ATTEMPTS = Number(
  process.env.DOCS_CAPTURE_MAX_ATTEMPTS ||
    (isRenderDeploy() ? 1 : isDocsCaptureHealEnabled() ? 2 : 1)
);
const DOCS_CAPTURE_HEAL_ATTEMPTS = resolveCaptureHealAttempts();
const DOCS_HEADLESS = String(process.env.DOCS_HEADLESS ?? "true").trim().toLowerCase() !== "false";
const DOCS_CAPTURE_FAST = String(process.env.DOCS_CAPTURE_FAST ?? "true").trim().toLowerCase() !== "false";

function docsCaptureEnv(sessionId) {
  const videoDir = path.join(ROOT, "output", "cloud-images", sessionId, "raw", "videos");
  const fast = isDocsGenFast();
  const budgetS = resolveCaptureBudgetS();
  const onRender = isRenderDeploy();
  const singleShot =
    process.env.DOCS_CAPTURE_SINGLE_SHOT != null
      ? String(process.env.DOCS_CAPTURE_SINGLE_SHOT).trim() !== "0"
      : (fast && budgetS <= 30) || onRender;
  const defaultPostNavWait = DOCS_RECORD_VIDEO && onRender ? "1.5" : "2.5";
  const defaultVideoWalkthrough = DOCS_RECORD_VIDEO ? (onRender ? "5" : "12") : onRender ? "0" : "12";
  const defaultAddOrderVideo = DOCS_RECORD_VIDEO ? (onRender ? "10" : "18") : onRender ? "0" : "18";
  const renderFast = onRender && !isDocsCaptureHealEnabled();
  return {
    HEADLESS: DOCS_HEADLESS ? "1" : "0",
    SHIPMOZO_EMAIL: String(process.env.SHIPMOZO_EMAIL || "").trim(),
    SHIPMOZO_PASSWORD: String(process.env.SHIPMOZO_PASSWORD || "").trim(),
    SHIPMOZO_PANEL_URL: String(process.env.SHIPMOZO_PANEL_URL || "").trim(),
    DOCS_CAPTURE_FAST: DOCS_CAPTURE_FAST ? "1" : "0",
    DOCS_CAPTURE_BUDGET_S: String(budgetS),
    DOCS_CAPTURE_SINGLE_SHOT: singleShot ? "1" : "0",
    DOCS_GEN_FAST: fast ? "1" : "0",
    E2E_FAST: renderFast ? "1" : onRender ? "0" : "1",
    LOGIN_WAIT_S: onRender ? "45" : String(process.env.LOGIN_WAIT_S || "30"),
    RENDER: onRender ? "true" : "",
    RECORD_VIDEO: DOCS_RECORD_VIDEO ? "1" : "0",
    DOCS_RECORD_VIDEO: DOCS_RECORD_VIDEO ? "1" : "0",
    E2E_VIDEO_DIR: videoDir,
    DOCS_CAPTURE_HEAL_ENABLED: isDocsCaptureHealEnabled() ? "1" : "0",
    DOCS_CAPTURE_HEAL_ATTEMPTS: String(resolveCaptureHealAttempts()),
    DOCS_CAPTURE_HEAL_PROVIDER: resolveHealProvider(),
    DOCS_CAPTURE_ALLOW_DIRECT_URL:
      process.env.DOCS_CAPTURE_ALLOW_DIRECT_URL != null
        ? String(process.env.DOCS_CAPTURE_ALLOW_DIRECT_URL).trim()
        : "0",
    DOCS_CAPTURE_ALLOW_ORDER_ADD_URL:
      process.env.DOCS_CAPTURE_ALLOW_ORDER_ADD_URL != null
        ? String(process.env.DOCS_CAPTURE_ALLOW_ORDER_ADD_URL).trim()
        : "true",
    DOCS_CAPTURE_POST_NAV_WAIT_S: String(
      process.env.DOCS_CAPTURE_POST_NAV_WAIT_S || defaultPostNavWait
    ),
    DOCS_SCREENSHOT_TIMEOUT_MS: String(
      process.env.DOCS_SCREENSHOT_TIMEOUT_MS || (onRender ? "45000" : "8000")
    ),
    DOCS_VIDEO_WALKTHROUGH_S: String(
      process.env.DOCS_VIDEO_WALKTHROUGH_S || defaultVideoWalkthrough
    ),
    DOCS_ADD_ORDER_VIDEO_S: String(process.env.DOCS_ADD_ORDER_VIDEO_S || defaultAddOrderVideo),
    DOCS_CAPTURE_USE_NAV_MAP:
      process.env.DOCS_CAPTURE_USE_NAV_MAP != null
        ? String(process.env.DOCS_CAPTURE_USE_NAV_MAP).trim()
        : "true",
    DOCS_CAPTURE_ALLOW_NAV_MAP_URL:
      process.env.DOCS_CAPTURE_ALLOW_NAV_MAP_URL != null
        ? String(process.env.DOCS_CAPTURE_ALLOW_NAV_MAP_URL).trim()
        : "true",
  };
}

const BAD_SCREENSHOT_URL = /page not found|could not be found|404|not-found/i;

function isRateCalculatorModule(moduleName, description = "") {
  const hay = `${moduleName} ${description}`.toLowerCase();
  if (/rate\s*calcul|raet\s*calcul|rat\s*calcul/.test(hay)) return true;
  if (hay.includes("calcul") && /rate|raet|courier|shipping|freight|tools/.test(hay)) {
    return true;
  }
  const mod = String(moduleName || "").toLowerCase().trim();
  if (["rate calculator", "rate-calculator", "rate_calculator"].includes(mod)) return true;
  if (mod === "tools" || mod === "tool") return true;
  return false;
}

function isChannelModule(moduleName, description = "") {
  const hay = `${moduleName} ${description}`.toLowerCase();
  return /shopify|integration|channels?|woocommerce|amazon/.test(hay);
}

function screenshotLooksBad(shot) {
  if (!shot) return true;
  if (shot.notFound || shot.rejected) return true;
  const blob = `${shot.id || ""} ${shot.label || ""} ${shot.url || ""}`.toLowerCase();
  if (BAD_SCREENSHOT_URL.test(blob)) return true;
  return false;
}

function filterGoodScreenshots(screenshots) {
  return (screenshots || []).filter((s) => !screenshotLooksBad(s));
}

function filterScreenshotsForModule(moduleName, description, screenshots) {
  if (!Array.isArray(screenshots) || !screenshots.length) return [];
  const stripLoginOnly = isRateCalculatorModule(moduleName, description) || isChannelModule(moduleName, description);
  if (!stripLoginOnly) return screenshots;
  const filtered = screenshots.filter((s) => {
    const blob = `${s.id || ""} ${s.label || ""} ${s.url || ""}`.toLowerCase();
    if (blob.includes("after login") || blob.includes("dashboard_after_login")) return false;
    if (blob.includes("sidebar after login")) return false;
    if (blob.includes("login") && !blob.includes("shopify") && !blob.includes("channel")) return false;
    return true;
  });
  // Never fall back to login/dashboard shots for integration or rate-calculator modules.
  return filtered;
}

function minScreenshotsFor(moduleName, description = "") {
  if (isDocsGenFast()) return 1;
  if (isRateCalculatorModule(moduleName, description)) return 2;
  if (isChannelModule(moduleName, description)) return 2;
  return String(moduleName).toLowerCase().includes("dashboard") ? 3 : 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureScreenshots(
  sessionId,
  moduleName,
  description = "",
  timeoutMs = resolveCaptureTimeoutMs(),
  extraEnv = {}
) {
  const args = [sessionId, moduleName];
  if (description?.trim()) args.push(description.trim());
  console.log(
    `[doc-capture] spawn capture_module_screenshots.py session=${sessionId} module=${moduleName} timeout=${timeoutMs}ms`
  );
  const proc = await runPythonScript("capture_module_screenshots.py", args, timeoutMs, {
    env: { ...docsCaptureEnv(sessionId), ...extraEnv },
    onStderr: (line) => console.log(line),
  });

  const raw = (proc.stdout || "").trim();
  if (!raw) {
    console.warn("[doc-capture] no stdout", proc.error || proc.stderr?.slice(0, 500));
    return {
      ok: false,
      error: proc.error || proc.stderr || "Screenshot capture produced no output",
      screenshots: [],
      videos: [],
    };
  }

  const { data, error } = parsePythonJson(raw);
  if (!data) {
    console.warn("[doc-capture] invalid JSON", error || raw.slice(0, 200));
    return {
      ok: false,
      error: error || `Invalid capture JSON: ${raw.slice(0, 200)}`,
      screenshots: [],
      videos: [],
    };
  }
  console.log(
    `[doc-capture] python finished ok=${data.ok} shots=${(data.screenshots || []).length} error=${data.error || "none"}`
  );
  return data;
}

function observationLooksWrong(observation, moduleName, description = "") {
  if (!observation || typeof observation !== "object") return false;
  if (observation.is404 || observation.isBrokenRoute || observation.onLogin) return true;
  if (observation.moduleVerified === true) return false;
  if (observation.moduleVerified === false) return true;
  if (isRateCalculatorModule(moduleName, description)) {
    if (observation.onRateCalculator) return false;
    if (observation.onDashboard) return true;
    const text = String(observation.pageTextPreview || "").toLowerCase();
    if (!text.includes("pincode") && !text.includes("calculate")) return true;
  }
  if (isChannelModule(moduleName, description)) {
    if (observation.onChannel) return false;
    if (observation.onDashboard && !observation.onChannelHub) return true;
    const url = String(observation.url || "").toLowerCase();
    if (url.includes("manage-courier")) return true;
  }
  return false;
}

async function captureObserveOnly(sessionId, moduleName, description = "", extraEnv = {}) {
  return captureScreenshots(sessionId, moduleName, description, resolveCaptureTimeoutMs(), {
    ...extraEnv,
    DOCS_CAPTURE_OBSERVE_ONLY: "1",
  });
}

function captureLooksFailed(last, moduleName, description, minShots) {
  const raw = last.screenshots || [];
  const good = filterGoodScreenshots(filterScreenshotsForModule(moduleName, description, raw));
  const count = good.length;
  const rejected = (last.rejectedShots || 0) + (raw.length - good.length);
  const pageWrong = count < 1 && observationLooksWrong(last.pageState, moduleName, description);
  const failed = count < 1;
  return { failed, good, count, rejected, raw, pageWrong };
}

async function captureScreenshotsWithHeal(
  sessionId,
  moduleName,
  maxAttempts = DOCS_CAPTURE_HEAL_ATTEMPTS,
  description = "",
  timeoutMs = resolveCaptureTimeoutMs()
) {
  const minShots = minScreenshotsFor(moduleName, description);
  const healEnabled = isDocsCaptureHealEnabled();
  const mcpHeal = healEnabled && isCaptureMcpHealEnabled();
  const effectiveMax = healEnabled
    ? isRenderDeploy()
      ? 1
      : Math.max(
          maxAttempts,
          Number(process.env.DOCS_CAPTURE_HEAL_ATTEMPTS || 5)
        )
    : 1;
  const baseBudgetS = resolveCaptureBudgetS();

  let last = { ok: false, error: "Capture not attempted", screenshots: [] };
  let healPlan = null;
  const healHistory = [];
  let healRounds = 0;
  let observation = null;

  for (let attempt = 1; attempt <= effectiveMax; attempt += 1) {
    const attemptTimeout = attemptTimeoutMs(timeoutMs, attempt);
    console.log(
      `[doc-capture] attempt ${attempt}/${effectiveMax} heal=${healEnabled} mcp=${mcpHeal} module=${moduleName}`
    );
    const extraEnv = {
      DOCS_CAPTURE_ATTEMPT: String(attempt),
      DOCS_CAPTURE_BUDGET_S: String(attemptBudgetS(baseBudgetS, attempt)),
    };
    if (healPlan) {
      extraEnv.DOCS_CAPTURE_HEAL_PLAN = healPlanEnvValue({
        ...healPlan,
        moduleName,
        description,
      });
    }

    if (healEnabled && attempt > 1) {
      const observe = await captureObserveOnly(sessionId, moduleName, description, extraEnv);
      observation = observe.pageState || observation;
      if (observation && !observationLooksWrong(observation, moduleName, description)) {
        last = await captureScreenshots(sessionId, moduleName, description, attemptTimeout, extraEnv);
      } else {
        last = observe;
        last.ok = false;
        last.error =
          last.error ||
          "Module not verified after heal plan — wrong page (dashboard/login/404)";
      }
    } else {
      last = await captureScreenshots(sessionId, moduleName, description, attemptTimeout, extraEnv);
    }

    observation = last.pageState || observation;
    const { failed, good, count, rejected, pageWrong } = captureLooksFailed(
      last,
      moduleName,
      description,
      minShots
    );

    if (!failed) {
      console.log(`[doc-capture] success attempt ${attempt}: ${count} screenshot(s)`);
      const belowMin = count < minShots;
      return {
        ...last,
        screenshots: good,
        ok: true,
        attempts: attempt,
        healed: attempt > 1 || healRounds > 0,
        healRounds,
        healProvider: healRounds > 0 ? resolveHealProvider() : undefined,
        rejectedShots: rejected,
        pageState: observation,
        warning: belowMin
          ? `Only ${count} good screenshot(s); wanted at least ${minShots}${
              rejected ? ` (${rejected} rejected: 404/login)` : ""
            }`
          : rejected
            ? `Rejected ${rejected} bad screenshot(s) (404/login/wrong module)`
            : undefined,
      };
    }

    last = {
      ...last,
      screenshots: good,
      ok: false,
      rejectedShots: rejected,
      pageState: observation,
      error:
        last.error ||
        (pageWrong
          ? `Wrong page after capture (dashboard/login/404) — attempt ${attempt}/${effectiveMax}`
          : rejected
            ? `${rejected} screenshot(s) rejected (404/login/wrong module); ${count} usable (attempt ${attempt}/${effectiveMax})`
            : `Only ${count} screenshot(s); need at least 1 (attempt ${attempt}/${effectiveMax})`),
    };

    console.warn(
      `[doc-capture] attempt ${attempt} failed: ${last.error} (good=${count} rejected=${rejected})`
    );

    if (!healEnabled || attempt >= effectiveMax) break;

    healRounds += 1;
    const healObservation = observation || {
      url: good[0]?.url || last.screenshots?.[0]?.url || "",
      pageTextPreview: "",
      agentHints: [],
    };

    const healed = mcpHeal
      ? await runMcpClaudeHealRound({
          moduleName,
          description,
          observation: healObservation,
          lastError: last.error,
          history: healHistory,
          attempt: healRounds,
        })
      : await proposeScreenshotHealPlan({
          moduleName,
          description,
          observation: healObservation,
          lastError: last.error,
          history: healHistory,
          attempt: healRounds,
        });
    healPlan = healed.plan;
    if (healed.mcpObservation) {
      observation = { ...healObservation, ...healed.mcpObservation };
    }
    healHistory.push({
      attempt: healRounds,
      error: last.error,
      plan: healPlan,
      meta: healed.meta,
      observation: healObservation,
      mcpObservation: healed.mcpObservation,
    });

    console.log(
      mcpHeal
        ? `[doc-capture] MCP+Claude heal round ${healRounds}: ${healPlan?.rationale || healed.meta?.error || "retry"} (provider=${healed.meta?.provider})`
        : `[doc-capture] heal round ${healRounds}: ${healPlan?.rationale || healed.meta?.error || "retry"} (provider=${healed.meta?.provider})`
    );
    await sleep(1200 * attempt);
  }

  return {
    ...last,
    attempts: effectiveMax,
    healed: healRounds > 0 && Boolean(last.ok),
    healRounds,
    healProvider: healRounds > 0 ? resolveHealProvider() : undefined,
    pageState: observation,
    captureError: last.error,
  };
}

async function storeCaptureMedia(sessionId, moduleName, description, capture) {
  let screenshots = [];
  let videos = [];
  if (capture.screenshots?.length) {
    screenshots = filterScreenshotsForModule(
      moduleName,
      description,
      await storeScreenshotBatch(sessionId, capture.screenshots)
    );
  }
  if (capture.videos?.length) {
    videos = await storeVideoBatch(sessionId, capture.videos);
  }
  return { screenshots, videos };
}

async function generatePrd({ moduleName, description, model, provider, backendOnly }) {
  const apiOnly = backendOnly || isBackendOnlyModule({ moduleName, description, backendOnly });
  const fast = isDocsGenFast();
  const fastPair = fast ? resolveFastDocLlmPair() : null;
  const { prdProvider, prdModel } = fastPair
    ? { prdProvider: fastPair.provider, prdModel: fastPair.model }
    : resolvePrdLlmPair({ provider, model });

  if (isReportMcpEnabled() && !fast) {
    const gh = await getGithubContextText({ moduleName, query: moduleName });
    const extraContext = gh.text ? `GitHub panel source (secondary):\n${gh.text.slice(0, 4000)}` : "";
    const extraBlocks = gh.text ? `GitHub panel source (secondary):\n${gh.text.slice(0, 8000)}` : "";
    const structurePrompt = buildPrdPrompt({ moduleName, description, backendOnly: apiOnly });
    const agent = await generateDocViaMcpAgent({
      docType: "prd",
      moduleName,
      description,
      structurePrompt,
      extraContext,
      extraBlocks,
      model,
      provider,
    });
    const prdQuality = validatePrdQuality(agent.content, { docType: "prd" });
    return {
      content: finalizePrdMarkdown(agent.content),
      truncated: agent.truncated,
      model: agent.model,
      usage: agent.usage,
      generatedBy: agent.generatedBy,
      llmSplit: agent.llmSplit,
      mcpAgent: agent.mcpAgent,
      mcpSources: agent.mcpSources,
      prdHeal: agent.prdHeal,
      prdQuality,
    };
  }

  const result = await callLLM({
    model: prdModel,
    provider: prdProvider,
    scope: "report_gen",
    system: buildDocSystem(moduleName, description),
    maxTokens: DOCS_PRD_MAX_TOKENS,
    timeoutMs: DOCS_PRD_TIMEOUT_MS,
    messages: [
      {
        role: "user",
        content: fast
          ? buildPrdPrompt({ moduleName, description, backendOnly: apiOnly })
          : await maybeGithubContext(
              buildPrdPrompt({ moduleName, description, backendOnly: apiOnly }),
              { moduleName }
            ),
      },
    ],
  });

  return {
    content: finalizePrdMarkdown(result.text),
    truncated: result.stop_reason === "max_tokens",
    model: result.model,
    usage: result.usage,
    generatedBy: fast
      ? `prd-fast-${prdProvider}`
      : isSplitDocPipeline()
        ? `prd-${prdProvider}`
        : "llm",
    llmSplit: { prd: { provider: prdProvider, model: prdModel } },
    mcpAgent: null,
    mcpSources: null,
  };
}

async function generateUserManual({
  moduleName,
  description,
  prd,
  screenshots,
  videos = [],
  model,
  provider,
  backendOnly,
}) {
  const apiOnly = backendOnly || isBackendOnlyModule({ moduleName, description, backendOnly });
  if (!isDocsGenFast()) await paceReportGeneration();
  const fast = isDocsGenFast();
  const fastPair = fast ? resolveFastDocLlmPair() : null;
  const { manualProvider, manualModel } = fastPair
    ? { manualProvider: fastPair.provider, manualModel: fastPair.model }
    : resolveManualLlmPair({ provider, model });

  const manualPrdLimit = fast ? 4000 : PRD_IN_MANUAL_MAX_CHARS;
  const compactPrd =
    String(prd || "").length > manualPrdLimit
      ? `${String(prd).slice(0, manualPrdLimit)}\n\n…[PRD truncated for rate limits]`
      : String(prd || "");

  // Manual: OpenAI/Azure from PRD + screenshots + videos only (no second MCP gather).
  const result = await callLLM({
    model: manualModel,
    provider: manualProvider,
    scope: "report_gen",
    system: buildDocSystemForManual(moduleName, description),
    maxTokens: DOCS_MANUAL_MAX_TOKENS,
    timeoutMs: DOCS_MANUAL_TIMEOUT_MS,
    messages: [
      {
        role: "user",
        content: buildManualPrompt({
          moduleName,
          description,
          prd: compactPrd,
          screenshots: apiOnly ? [] : screenshots,
          videos: apiOnly ? [] : videos,
          backendOnly: apiOnly,
        }),
      },
    ],
  });

  return {
    content: finalizeManualMarkdown(result.text, screenshots, videos),
    truncated: result.stop_reason === "max_tokens" || compactPrd.length < String(prd || "").length,
    model: result.model,
    usage: result.usage,
    generatedBy: fast
      ? `manual-fast-${manualProvider}`
      : isSplitDocPipeline()
        ? `manual-${manualProvider}`
        : isReportMcpEnabled()
          ? "llm-from-prd"
          : "llm",
    llmSplit: { manual: { provider: manualProvider, model: manualModel } },
    mcpAgent: null,
    mcpSources: null,
  };
}

async function generateModulePackage({
  moduleName,
  description = "",
  model,
  provider,
  captureScreens = true,
  backendOnly = false,
}) {
  const sessionId = nowSessionId();
  const apiOnly = backendOnly || isBackendOnlyModule({ moduleName, description, backendOnly });
  const doCapture = captureScreens && !apiOnly;

  const prdOut = await generatePrd({ moduleName, description, model, provider, backendOnly: apiOnly });

  let screenshots = [];
  let videos = [];
  let captureError = null;
  let capture = null;

  if (doCapture) {
    capture = await captureScreenshotsWithHeal(
      sessionId,
      moduleName,
      DOCS_CAPTURE_HEAL_ATTEMPTS,
      description
    );
    if (capture.screenshots?.length || capture.videos?.length) {
      const stored = await storeCaptureMedia(sessionId, moduleName, description, capture);
      screenshots = stored.screenshots;
      videos = stored.videos;
    }
    if (!screenshots.length) {
      captureError =
        capture.error ||
        capture.warning ||
        (isRateCalculatorModule(moduleName, description)
          ? "Rate Calculator not reached — no module screenshots (dashboard shots excluded)"
          : "No screenshots captured");
    } else if (capture.warning) {
      captureError = capture.warning;
    }
  }

  const manualOut = await generateUserManual({
    moduleName,
    description,
    prd: prdOut.content,
    screenshots,
    videos,
    model,
    provider,
    backendOnly: apiOnly,
  });

  const packageResult = {
    sessionId,
    moduleName,
    prd: prdOut.content,
    user_manual: manualOut.content,
    screenshots,
    videos,
    captureError,
    backendOnly: apiOnly,
    captureAttempts: doCapture ? capture?.attempts : undefined,
    captureHealed: doCapture ? capture?.healed : undefined,
    captureHealRounds: doCapture ? capture?.healRounds : undefined,
    captureHealProvider: doCapture ? capture?.healProvider : undefined,
    prdTruncated: prdOut.truncated,
    manualTruncated: manualOut.truncated,
    shipmozoMode: isShipmozoRelated(moduleName, description),
    exampleSources: EXAMPLE_SOURCES,
  };

  try {
    await saveReport({
      sessionId,
      moduleName,
      description,
      prd: packageResult.prd,
      user_manual: packageResult.user_manual,
      screenshots,
      videos,
    });
    packageResult.saved = true;
  } catch (err) {
    packageResult.saved = false;
    packageResult.saveError = err.message;
  }

  return packageResult;
}

async function generateModulePackageStep({
  step,
  sessionId,
  moduleName,
  description = "",
  prd = "",
  screenshots = [],
  videos = [],
  model,
  provider,
  captureScreens = true,
  backendOnly = false,
}) {
  const apiOnly = backendOnly || isBackendOnlyModule({ moduleName, description, backendOnly });
  const doCapture = captureScreens && !apiOnly;

  if (step === "prd") {
    const prdOut = await generatePrd({ moduleName, description, model, provider, backendOnly: apiOnly });
    let saved = false;
    let saveError = null;
    try {
      await saveReport({
        sessionId,
        moduleName,
        description,
        prd: prdOut.content,
        user_manual: "",
        screenshots: [],
      });
      saved = true;
    } catch (err) {
      saveError = err.message;
    }
    return {
      step: "prd",
      sessionId,
      prd: prdOut.content,
      prdTruncated: prdOut.truncated,
      model: prdOut.model,
      usage: prdOut.usage,
      generatedBy: prdOut.generatedBy,
      mcpAgent: prdOut.mcpAgent,
      mcpSources: prdOut.mcpSources,
      prdHeal: prdOut.prdHeal,
      prdQuality: prdOut.prdQuality,
      backendOnly: apiOnly,
      saved,
      saveError,
    };
  }

  if (step === "screenshots") {
    if (!doCapture) {
      return {
        step: "screenshots",
        sessionId,
        screenshots: [],
        videos: [],
        captureError: apiOnly ? "Skipped — backend/API-only service (no panel UI)" : "Screenshot capture disabled",
        skipped: true,
        backendOnly: apiOnly,
      };
    }
    let screenshots = [];
    let videos = [];
    let captureError = null;
    let captureMeta = {};

    if (doCapture) {
      console.log(`[doc-capture] step screenshots session=${sessionId} module=${moduleName}`);
      const capture = await captureScreenshotsWithHeal(
        sessionId,
        moduleName,
        DOCS_CAPTURE_MAX_ATTEMPTS,
        description
      );
      captureMeta = {
        captureAttempts: capture.attempts,
        captureHealed: capture.healed,
      };
      if (capture.screenshots?.length || capture.videos?.length) {
        const stored = await storeCaptureMedia(sessionId, moduleName, description, capture);
        screenshots = stored.screenshots;
        videos = stored.videos;
      }
      if (!screenshots.length) {
        captureError =
          capture.error ||
          (isRateCalculatorModule(moduleName, description)
            ? "Rate Calculator not reached — no module screenshots"
            : "No screenshots captured");
      }
    }

    return { step: "screenshots", sessionId, screenshots, videos, captureError, ...captureMeta };
  }

  if (step === "manual") {
    if (!prd) throw new Error("prd is required for manual step");

    const manualOut = await generateUserManual({
      moduleName,
      description,
      prd,
      screenshots,
      videos,
      model,
      provider,
      backendOnly: apiOnly,
    });

    let saved = false;
    let saveError = null;
    try {
      await saveReport({
        sessionId,
        moduleName,
        description,
        prd,
        user_manual: manualOut.content,
        screenshots,
        videos,
      });
      saved = true;
    } catch (err) {
      saveError = err.message;
    }

    return {
      step: "manual",
      sessionId,
      user_manual: manualOut.content,
      manualTruncated: manualOut.truncated,
      model: manualOut.model,
      usage: manualOut.usage,
      generatedBy: manualOut.generatedBy,
      mcpAgent: manualOut.mcpAgent,
      mcpSources: manualOut.mcpSources,
      backendOnly: apiOnly,
      saved,
      saveError,
    };
  }

  throw new Error(`Unknown step: ${step}`);
}

module.exports = {
  EXAMPLE_SOURCES,
  generateModulePackage,
  generateModulePackageStep,
  captureScreenshotsWithHeal,
  resolveCaptureTimeoutMs,
  resolveCaptureBudgetS,
  nowSessionId,
  getReportExamplesContext,
  validatePrdQuality,
  screenshotLooksBad,
  filterGoodScreenshots,
  filterScreenshotsForModule,
  isDocsGenFast,
  appendMediaToManual,
  finalizeManualMarkdown,
};
