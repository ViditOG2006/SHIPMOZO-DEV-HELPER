const path = require("path");
const { runPythonScript } = require("./spawn-python");
const { parsePythonJson } = require("./parse-python-json");
const { callLLM, MAX_OUTPUT_TOKENS } = require("./llm");
const { storeScreenshotBatch } = require("./image-storage");
const { saveReport } = require("./report-archive");
const {
  getReportExamplesContext,
  isShipmozoRelated,
  EXAMPLE_PRD_STRUCTURE,
  EXAMPLE_TECH_GUIDE_STRUCTURE,
} = require("./report-examples");

const ROOT = path.join(__dirname, "..");

const EXAMPLE_SOURCES = [
  {
    title: "Shipmozo report templates (Google Doc)",
    url: "https://docs.google.com/document/d/1dSZGnrEbOfBjiSPBnxzGdG22-PnstyG3vFh268kRBk0/edit",
  },
];

function nowSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildDocSystem(moduleName, description) {
  return `You are a Senior QA Architect + Product Engineer for Shipmozo-style logistics SaaS.

${getReportExamplesContext()}

Rules:
- Markdown only, no filler preamble
- No duplication; tight professional prose
- Mermaid diagrams where useful
- Match example report rigor`;
}

function buildPrdPrompt({ moduleName, description }) {
  return `Generate a **complete technical PRD** for module: **${moduleName}**.

${description ? `User context:\n${description}\n` : ""}

Use this structure EXACTLY:

${EXAMPLE_PRD_STRUCTURE}

Then add **Technical Appendix** (all engineering detail in this same document):
## 6. System Architecture
- Services, panels (User vs Partner), communication patterns, Mermaid diagram

## 7. Data Model & APIs
- Entities, relationships (Mermaid ER), key API endpoints and webhooks

## 8. Integrations & Infrastructure
- Couriers, channels (Shopify etc.), queues/cron, auth, observability

## 9. Non-Functional Requirements
- Performance, security, compliance, scale assumptions

Target: one self-contained PRD a developer can implement from — not a high-level summary only.`;
}

function buildManualPrompt({ moduleName, description, prd, screenshots }) {
  const shotList =
    screenshots.length > 0
      ? screenshots
          .map(
            (s, i) =>
              `${i + 1}. **${s.label}** (id: ${s.id}) → embed: ![${s.label}](${s.url})`
          )
          .join("\n")
      : "(No live screenshots — write steps and mark [Screenshot: description] placeholders)";

  return `Write a **User Manual** (operator training guide) for module: **${moduleName}**.

${description ? `User context:\n${description}\n` : ""}

Follow this guide structure from team examples:
${EXAMPLE_TECH_GUIDE_STRUCTURE}

--- Technical PRD (reference — do not repeat verbatim) ---
${prd}
--- end PRD ---

--- Live screenshots (MUST embed in matching steps) ---
${shotList}
--- end screenshots ---

Requirements:
1. Number every user action step (1. 2. 3.) per workflow
2. Under each major action, embed the matching screenshot using the exact Markdown image URL provided
3. Sections: Purpose, Who Uses It, UI Overview, Filters, Bulk Actions, Step-by-Step Actions, Related Modules, Common Workflows, Errors/Tips
4. Mark steps as **Verified (screenshot)** when image URL is used
5. Practical tone — new employee can operate the module from this manual alone`;
}

const DOCS_CAPTURE_TIMEOUT_MS = Number(process.env.DOCS_CAPTURE_TIMEOUT_MS || 300000);
const DOCS_CAPTURE_MAX_ATTEMPTS = Number(process.env.DOCS_CAPTURE_MAX_ATTEMPTS || 1);

function minScreenshotsFor(moduleName) {
  return String(moduleName).toLowerCase().includes("dashboard") ? 3 : 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureScreenshots(sessionId, moduleName, description = "") {
  const args = [sessionId, moduleName];
  if (description?.trim()) args.push(description.trim());
  const proc = await runPythonScript(
    "capture_module_screenshots.py",
    args,
    DOCS_CAPTURE_TIMEOUT_MS
  );

  const raw = (proc.stdout || "").trim();
  if (!raw) {
    return {
      ok: false,
      error: proc.error || proc.stderr || "Screenshot capture produced no output",
      screenshots: [],
    };
  }

  const { data, error } = parsePythonJson(raw);
  if (!data) {
    return { ok: false, error: error || `Invalid capture JSON: ${raw.slice(0, 200)}`, screenshots: [] };
  }
  return data;
}

async function captureScreenshotsWithHeal(
  sessionId,
  moduleName,
  maxAttempts = 3,
  description = ""
) {
  const minShots = minScreenshotsFor(moduleName);
  let last = { ok: false, error: "Capture not attempted", screenshots: [] };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await captureScreenshots(sessionId, moduleName, description);
    const count = last.screenshots?.length || 0;
    if (last.ok && count >= 1) {
      const belowMin = count < minShots;
      return {
        ...last,
        ok: true,
        attempts: attempt,
        healed: attempt > 1,
        warning: belowMin
          ? `Only ${count} screenshot(s); wanted at least ${minShots}`
          : undefined,
      };
    }
    last = {
      ...last,
      ok: false,
      error:
        last.error ||
        `Only ${count} screenshot(s); need at least 1 (attempt ${attempt}/${maxAttempts})`,
    };
    if (attempt < maxAttempts) await sleep(2000 * attempt);
  }

  return { ...last, attempts: maxAttempts, healed: false };
}

async function generatePrd({ moduleName, description, model, provider }) {
  const result = await callLLM({
    model,
    provider,
    system: buildDocSystem(moduleName, description),
    maxTokens: MAX_OUTPUT_TOKENS,
    messages: [{ role: "user", content: buildPrdPrompt({ moduleName, description }) }],
  });

  return {
    content: result.text,
    truncated: result.stop_reason === "max_tokens",
    model: result.model,
    usage: result.usage,
  };
}

async function generateUserManual({ moduleName, description, prd, screenshots, model, provider }) {
  const result = await callLLM({
    model,
    provider,
    system: buildDocSystem(moduleName, description),
    maxTokens: MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: "user",
        content: buildManualPrompt({ moduleName, description, prd, screenshots }),
      },
    ],
  });

  return {
    content: result.text,
    truncated: result.stop_reason === "max_tokens",
    model: result.model,
    usage: result.usage,
  };
}

async function generateModulePackage({
  moduleName,
  description = "",
  model,
  provider,
  captureScreens = true,
}) {
  const sessionId = nowSessionId();

  const prdOut = await generatePrd({ moduleName, description, model, provider });

  let screenshots = [];
  let captureError = null;

  if (captureScreens) {
    const capture = await captureScreenshotsWithHeal(sessionId, moduleName, 3, description);
    if (capture.screenshots?.length) {
      screenshots = await storeScreenshotBatch(sessionId, capture.screenshots);
    }
    if (!screenshots.length) {
      captureError = capture.error || capture.warning || "No screenshots captured";
    } else if (capture.warning) {
      captureError = capture.warning;
    }
  }

  const manualOut = await generateUserManual({
    moduleName,
    description,
    prd: prdOut.content,
    screenshots,
    model,
    provider,
  });

  const packageResult = {
    sessionId,
    moduleName,
    prd: prdOut.content,
    user_manual: manualOut.content,
    screenshots,
    captureError,
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
  model,
  provider,
  captureScreens = true,
}) {
  if (step === "prd") {
    const prdOut = await generatePrd({ moduleName, description, model, provider });
    return {
      step: "prd",
      sessionId,
      prd: prdOut.content,
      prdTruncated: prdOut.truncated,
      model: prdOut.model,
      usage: prdOut.usage,
    };
  }

  if (step === "screenshots") {
    let screenshots = [];
    let captureError = null;
    let captureMeta = {};

    if (captureScreens) {
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
      if (capture.screenshots?.length) {
        screenshots = await storeScreenshotBatch(sessionId, capture.screenshots);
      }
      if (!screenshots.length) {
        captureError = capture.error || "No screenshots captured";
      }
    }

    return { step: "screenshots", sessionId, screenshots, captureError, ...captureMeta };
  }

  if (step === "manual") {
    if (!prd) throw new Error("prd is required for manual step");

    const manualOut = await generateUserManual({
      moduleName,
      description,
      prd,
      screenshots,
      model,
      provider,
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
  nowSessionId,
  getReportExamplesContext,
};
