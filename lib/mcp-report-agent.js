const { callLLM } = require("./llm");
const { extractJsonFromLlm } = require("./parse-llm-json");
const {
  listAvailableMcpTools,
  formatToolCatalogForPrompt,
  executeMcpToolCall,
} = require("./mcp-tool-registry");
const { loadNavigationMap } = require("./panel-navigation");
const { resolveReportLlmPair } = require("./report-llm-split");
const { validatePrdQuality, gatherLooksSufficient } = require("./prd-quality");
const { formatLessonsForPrompt } = require("./ai-heal-lessons");

function knownIssuesBlock(maxLessons = 20) {
  const block = formatLessonsForPrompt({ maxLessons });
  return block ? `\n\n${block}` : "";
}

const MAX_GATHER_ROUNDS = Number(process.env.REPORT_MCP_AGENT_ROUNDS || 3);
const DOCS_PRD_MAX_HEAL_ATTEMPTS = Number(process.env.DOCS_PRD_MAX_HEAL_ATTEMPTS || 1);
const MCP_SOURCE_CHARS = Number(process.env.REPORT_MCP_SOURCE_MAX_CHARS || 2500);
const MCP_RESULT_CHARS = Number(process.env.REPORT_MCP_RESULT_MAX_CHARS || 3500);
const MCP_COMPILE_MAX_SOURCES = Number(process.env.REPORT_MCP_COMPILE_MAX_SOURCES || 3);
const ORCHESTRATOR_SYSTEM = `You are an MCP orchestrator for Shipmozo Dev Helper documentation.

Your ONLY job in this phase is to decide which MCP tools to call to gather evidence for a PRD or user manual.

RULES:
1. Output a single JSON object per turn (no markdown fences).
2. Actions:
   - "mcp_call": run one MCP tool. Fields: server ("postman"|"playwright"), tool, arguments (object), reason (string).
   - "finish_gathering": stop when you have enough API + UI evidence. Fields: reason, summary (what was collected).
3. Prefer Postman for APIs (getWorkspaces, getCollections, getCollection, searchPostmanElementsInPrivateNetwork).
4. Prefer Playwright for live panel UI (browser_navigate to panel URL, browser_snapshot, browser_press_key Control+b for Quick Search).
5. For Amazon/Shopify/WooCommerce channels: Quick Search the **Order Channels** or **Channels** module first, then navigate in-page to the channel card — do NOT Quick Search "amazon integration" or "amazon channel" directly.
6. Do NOT write the PRD/manual in this phase — only gather via MCP.
7. Use POSTMAN_COLLECTION_ID / workspace from env when mentioned in context.
8. Max one mcp_call per turn.${knownIssuesBlock(16)}`;

function navContextBlock() {
  const nav = loadNavigationMap();
  const lines = (nav.pages || [])
    .slice(0, 12)
    .map((p) => `${p.text} → ${p.href || p.path}`);
  return lines.length ? lines.join("\n") : "(empty nav map)";
}

function buildGatherUserPrompt({ docType, moduleName, description, extraContext }) {
  const panelUrl = String(process.env.SHIPMOZO_PANEL_URL || "https://panel.appiify.com").replace(
    /\/$/,
    ""
  );
  return `Gather MCP evidence for ${docType === "manual" ? "user manual" : "PRD"}.

Module: ${moduleName}
User context: ${description || "(none)"}
Panel base URL: ${panelUrl}
POSTMAN_COLLECTION_ID: ${process.env.POSTMAN_COLLECTION_ID || "(not set — search or list collections)"}
POSTMAN_WORKSPACE_ID: ${process.env.POSTMAN_WORKSPACE_ID || "(not set)"}

Navigation map hints:
${navContextBlock()}

${extraContext ? `Additional context:\n${extraContext}\n` : ""}

Start by calling MCP tools to collect API definitions and live UI snapshot evidence.`;
}

function formatSourcesBlock(sources) {
  if (!sources.length) return "(no MCP sources gathered)";
  return sources
    .slice(0, MCP_COMPILE_MAX_SOURCES)
    .map(
      (s, i) =>
        `### MCP_SOURCE_${i + 1}: ${s.server}.${s.tool}\nReason: ${s.reason || "—"}\n\`\`\`\n${String(s.text).slice(0, MCP_SOURCE_CHARS)}\n\`\`\``
    )
    .join("\n\n");
}

async function orchestratorTurn({
  messages,
  model,
  provider,
  system = ORCHESTRATOR_SYSTEM,
  scope = "report_gen",
}) {
  const result = await callLLM({
    model,
    provider,
    scope,
    system,
    jsonMode: true,
    maxTokens: 1200,
    messages,
  });
  const { data, error } = extractJsonFromLlm(result.text);
  if (!data || !data.action) {
    throw new Error(error || "Orchestrator did not return valid JSON action");
  }
  return { action: data, usage: result.usage, model: result.model };
}

async function gatherMcpSources({
  docType,
  moduleName,
  description,
  extraContext,
  model,
  provider,
  allowedServers = null,
  orchestratorSystem = ORCHESTRATOR_SYSTEM,
  maxRounds = MAX_GATHER_ROUNDS,
  scope = "report_gen",
}) {
  let catalog = await listAvailableMcpTools();
  if (Array.isArray(allowedServers) && allowedServers.length) {
    const allow = new Set(allowedServers.map((s) => String(s).toLowerCase()));
    catalog = catalog.filter((t) => allow.has(t.server));
  }
  const toolList = formatToolCatalogForPrompt(catalog);

  const messages = [
    {
      role: "user",
      content: `${buildGatherUserPrompt({ docType, moduleName, description, extraContext })}\n\nAvailable MCP tools:\n${toolList}`,
    },
  ];

  const sources = [];
  const toolCalls = [];
  let finishReason = "";
  let totalUsage = {};

  for (let round = 1; round <= maxRounds; round++) {
    const { action, usage } = await orchestratorTurn({
      messages,
      model,
      provider,
      system: orchestratorSystem,
      scope,
    });
    if (usage) totalUsage = usage;

    if (action.action === "finish_gathering") {
      if (!gatherLooksSufficient(sources) && round < maxRounds) {
        messages.push({
          role: "assistant",
          content: JSON.stringify(action),
        });
        messages.push({
          role: "user",
          content:
            "Not enough evidence yet — need at least one successful Playwright UI snapshot OR Postman API source. Call mcp_call (do not finish_gathering).",
        });
        continue;
      }
      finishReason = action.reason || action.summary || "orchestrator finished";
      break;
    }

    if (action.action !== "mcp_call") {
      messages.push({
        role: "assistant",
        content: JSON.stringify(action),
      });
      messages.push({
        role: "user",
        content: 'Invalid action. Reply JSON with action "mcp_call" or "finish_gathering" only.',
      });
      continue;
    }

    let callResult;
    try {
      callResult = await executeMcpToolCall(action.server, action.tool, action.arguments || {});
    } catch (err) {
      callResult = {
        server: action.server,
        tool: action.tool,
        arguments: action.arguments,
        text: `ERROR: ${err.message}`,
        isError: true,
      };
    }

    const entry = {
      round,
      reason: action.reason || "",
      ...callResult,
    };
    sources.push(entry);
    toolCalls.push({
      round,
      server: entry.server,
      tool: entry.tool,
      reason: entry.reason,
      isError: entry.isError,
      chars: entry.text.length,
    });

    messages.push({ role: "assistant", content: JSON.stringify(action) });
    messages.push({
      role: "user",
      content: `MCP result (${entry.server}.${entry.tool}):\n${entry.text.slice(0, MCP_RESULT_CHARS)}\n\nCall another tool or finish_gathering if enough evidence.`,
    });

    if (round === maxRounds) {
      finishReason = `max rounds (${maxRounds})`;
    }
  }

  return {
    sources,
    toolCalls,
    finishReason,
    usage: totalUsage,
    catalogSize: catalog.length,
  };
}

async function compileDocumentFromMcpSources({
  docType,
  moduleName,
  description,
  structurePrompt,
  sources,
  extraBlocks = "",
  model,
  provider,
}) {
  const sourcesBlock = formatSourcesBlock(sources);
  const compileSystem = `You compile Shipmozo documentation from MCP_SOURCE blocks and EXTRA blocks below.

RULES:
- Prefer MCP sources for APIs, fields, buttons, and workflows; use EXTRA (GitHub, user context) when MCP is thin.
- Do NOT invent specifics absent from all sources — infer only standard Shipmozo logistics patterns when clearly implied.
- Never write "TBD — wait for next MCP run" or defer sections. Fill every heading with substantive content.
- Use "TBD — not observed in MCP sources" only for a specific bullet when neither MCP nor EXTRA mentions it.
- Markdown only. Follow the requested structure exactly with all sections complete.
- Cite MCP_SOURCE_N for non-obvious claims (inline, e.g. [MCP_SOURCE_2]).
- You are a compiler/editor producing production-ready docs, not a draft with placeholders.${knownIssuesBlock(12)}`;

  const compileUser = `${structurePrompt}

Module: **${moduleName}**
${description ? `Context: ${description}\n` : ""}

--- MCP SOURCES (primary evidence) ---
${sourcesBlock}
--- end MCP sources ---

${extraBlocks ? `--- EXTRA (secondary) ---\n${extraBlocks}\n--- end EXTRA ---\n` : ""}

Compile the full ${docType === "manual" ? "user manual" : "PRD"} now using ONLY the evidence above.`;

  const result = await callLLM({
    model,
    provider,
    scope: "report_gen",
    system: compileSystem,
    maxTokens: 8192,
    messages: [{ role: "user", content: compileUser }],
  });

  return {
    content: result.text,
    truncated: result.stop_reason === "max_tokens",
    model: result.model,
    usage: result.usage,
  };
}

/**
 * LLM orchestrates MCP tool calls, then LLM compiles PRD/manual from gathered MCP transcripts only.
 */
async function generateDocViaMcpAgent({
  docType,
  moduleName,
  description,
  structurePrompt,
  extraContext = "",
  extraBlocks = "",
  model,
  provider,
  orchestratorProvider,
  orchestratorModel,
  compileProvider,
  compileModel,
}) {
  const pair = resolveReportLlmPair({ provider, model });
  const orchProvider = orchestratorProvider || pair.orchestratorProvider;
  const orchModel = orchestratorModel || pair.orchestratorModel;
  const compProvider = compileProvider || pair.compileProvider;
  const compModel = compileModel || pair.compileModel;

  let lastGather = null;
  let lastCompiled = null;
  let prdHeal = { attempts: 0, issues: [] };

  for (let healAttempt = 1; healAttempt <= DOCS_PRD_MAX_HEAL_ATTEMPTS; healAttempt += 1) {
    const gatherRounds = MAX_GATHER_ROUNDS + (healAttempt - 1) * 2;
    const healHint =
      healAttempt > 1
        ? `\n\nHEAL RETRY ${healAttempt}: prior PRD had TBD placeholders or was too thin. Gather more Playwright UI + Postman API evidence before finish_gathering.`
        : "";

    const gather = await gatherMcpSources({
      docType,
      moduleName,
      description,
      extraContext: `${extraContext || ""}${healHint}`,
      model: orchModel,
      provider: orchProvider,
      maxRounds: gatherRounds,
    });
    lastGather = gather;

    const compiled = await compileDocumentFromMcpSources({
      docType,
      moduleName,
      description,
      structurePrompt,
      sources: gather.sources,
      extraBlocks,
      model: compModel,
      provider: compProvider,
    });
    lastCompiled = compiled;
    prdHeal.attempts = healAttempt;

    if (docType !== "prd") {
      break;
    }

    const quality = validatePrdQuality(compiled.content, { docType });
    if (quality.ok) {
      prdHeal.issues = [];
      break;
    }
    prdHeal.issues = quality.issues;
    if (healAttempt >= DOCS_PRD_MAX_HEAL_ATTEMPTS) {
      break;
    }
  }

  const gather = lastGather;
  const compiled = lastCompiled;

  const generatedBy =
    orchProvider === compProvider
      ? "mcp-agent+llm"
      : `mcp-${orchProvider}+compile-${compProvider}`;

  return {
    ...compiled,
    generatedBy,
    prdHeal,
    llmSplit: {
      orchestrator: { provider: orchProvider, model: orchModel },
      compile: { provider: compProvider, model: compModel },
    },
    mcpAgent: {
      finishReason: gather.finishReason,
      toolCalls: gather.toolCalls,
      sourceCount: gather.sources.length,
      catalogSize: gather.catalogSize,
      healAttempts: prdHeal.attempts,
    },
    mcpSources: gather.sources.map((s) => ({
      server: s.server,
      tool: s.tool,
      reason: s.reason,
      chars: s.text?.length || 0,
      isError: s.isError,
    })),
  };
}

module.exports = {
  ORCHESTRATOR_SYSTEM,
  gatherMcpSources,
  compileDocumentFromMcpSources,
  generateDocViaMcpAgent,
  validatePrdQuality,
  gatherLooksSufficient,
};
