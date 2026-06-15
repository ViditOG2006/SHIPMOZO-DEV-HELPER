const { createMcpHttpClient, callMcpTool, toolText } = require("./mcp-client");
const { parsePostmanMcpResult } = require("./postman-mcp-parse");
const { postmanMcpUrl, postmanHeaders } = require("./postman-mcp-config");
const { ensurePlaywrightMcp } = require("./ensure-playwright-mcp");
const { loadNavigationMap } = require("./panel-navigation");

const DEFAULT_CONTEXT = ["postman", "playwright"];

function reportMcpContextProviders() {
  const raw = String(process.env.REPORT_MCP_CONTEXT || DEFAULT_CONTEXT.join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return raw.length ? raw : DEFAULT_CONTEXT;
}

function panelBaseUrl() {
  return String(process.env.SHIPMOZO_PANEL_URL || "https://panel.appiify.com").replace(/\/$/, "");
}

function flattenPostmanItems(items = [], out = []) {
  for (const item of items) {
    if (item.item?.length) flattenPostmanItems(item.item, out);
    else if (item.request) out.push(item);
  }
  return out;
}

function formatPostmanRequestsForPrd(requests, collectionName) {
  if (!requests.length) return "(no API requests in collection)";
  const lines = requests.slice(0, 40).map((item, i) => {
    const req = item.request || {};
    const method = String(req.method || "GET").toUpperCase();
    const url =
      typeof req.url === "string"
        ? req.url
        : req.url?.raw || (Array.isArray(req.url?.path) ? req.url.path.join("/") : "/");
    const desc = item.description || req.description || "";
    return `${i + 1}. **${item.name || "Request"}** — \`${method} ${url}\`${desc ? `\n   ${String(desc).slice(0, 200)}` : ""}`;
  });
  return `Collection: **${collectionName || "Postman"}**\n\n${lines.join("\n")}`;
}

async function fetchPostmanReportContext({ moduleName, description }) {
  const key = String(process.env.POSTMAN_API_KEY || "").trim();
  if (!key) {
    return { ok: false, skipped: true, error: "POSTMAN_API_KEY not set", text: "" };
  }

  const query = String(description || moduleName || "shipmozo").trim().slice(0, 120);
  const client = await createMcpHttpClient("postman-report", postmanMcpUrl(), postmanHeaders());

  let collection = null;
  const collectionId = String(process.env.POSTMAN_COLLECTION_ID || "").trim();
  if (collectionId) {
    const result = await callMcpTool(client, "getCollection", {
      collectionId,
      model: "full",
    });
    const data = parsePostmanMcpResult(result);
    collection = data?.collection || data;
  } else {
    const searchResult = await callMcpTool(client, "searchPostmanElementsInPrivateNetwork", {
      query,
    });
    const searchData = parsePostmanMcpResult(searchResult);
    const hits =
      searchData?.data ||
      searchData?.results ||
      searchData?.hits ||
      searchData?.collections ||
      [];
    let hit = hits.find((h) => /collection/i.test(h.type || h.elementType || "") || h.collection);
    if (!hit && hits.length) hit = hits[0];
    if (!hit) {
      return { ok: false, error: `No Postman collection matched "${query}"`, text: "" };
    }
    const cid = hit.id || hit.uid || hit.collectionId;
    const full = await callMcpTool(client, "getCollection", { collectionId: cid, model: "full" });
    const data = parsePostmanMcpResult(full);
    collection = data?.collection || data;
  }

  const requests = flattenPostmanItems(collection?.item || []);
  const text = formatPostmanRequestsForPrd(requests, collection?.info?.name);
  return {
    ok: true,
    collectionName: collection?.info?.name,
    requestCount: requests.length,
    text,
  };
}

function findRefInSnapshot(snapshot, patterns) {
  const lines = String(snapshot || "").split("\n");
  const pats = (Array.isArray(patterns) ? patterns : [patterns]).map(
    (p) => (p instanceof RegExp ? p : new RegExp(p, "i"))
  );
  for (let i = 0; i < lines.length; i++) {
    if (!pats.some((p) => p.test(lines[i]))) continue;
    const window = lines.slice(Math.max(0, i - 2), i + 4).join("\n");
    const refMatch = window.match(/(?:ref:\s*|ref=|\[ref=)([^\s\]]+)/);
    if (refMatch) return refMatch[1];
  }
  return null;
}

async function fetchPlaywrightReportContext({ moduleName }) {
  const url = await ensurePlaywrightMcp();
  const client = await createMcpHttpClient("playwright-report", url);
  const panelUrl = panelBaseUrl();
  const searchTerm = String(moduleName || "dashboard").trim();

  await callMcpTool(client, "browser_navigate", { url: `${panelUrl}/dashboard` });
  await callMcpTool(client, "browser_wait_for", { time: 1.5 });

  let snapshot = toolText(await callMcpTool(client, "browser_snapshot", {}));

  if (!/pincode|rate calculator/i.test(snapshot) && searchTerm.length > 2) {
    await callMcpTool(client, "browser_press_key", { key: "Control+b" });
    await callMcpTool(client, "browser_wait_for", { time: 0.2 });
    snapshot = toolText(await callMcpTool(client, "browser_snapshot", {}));
    const searchRef =
      findRefInSnapshot(snapshot, [/quick search/i, /search/i]) ||
      findRefInSnapshot(snapshot, /textbox/i);
    if (searchRef) {
      await callMcpTool(client, "browser_type", {
        target: searchRef,
        ref: searchRef,
        text: searchTerm,
      });
      await callMcpTool(client, "browser_press_key", { key: "Enter" });
      await callMcpTool(client, "browser_wait_for", { time: 1.5 });
      snapshot = toolText(await callMcpTool(client, "browser_snapshot", {}));
    }
  }

  const trimmed = String(snapshot || "").slice(0, 6000);
  return {
    ok: Boolean(trimmed),
    url: panelUrl,
    text: trimmed || "(empty page snapshot)",
  };
}

function navHintsForModule(moduleName) {
  const nav = loadNavigationMap();
  const q = String(moduleName || "").toLowerCase();
  const hits = (nav.pages || [])
    .filter((p) => {
      const blob = `${p.text} ${p.href} ${p.path}`.toLowerCase();
      return q && blob.includes(q);
    })
    .slice(0, 8)
    .map((p) => `- ${p.text} → ${p.href || p.path}`);
  return hits.length ? hits.join("\n") : "(no nav map hits)";
}

/**
 * Gather MCP context for PRD / manual generation (Postman APIs + live UI snapshot).
 */
async function gatherReportMcpContext({ moduleName, description = "" }) {
  const providers = reportMcpContextProviders();
  const sources = {};
  const errors = [];

  if (providers.includes("postman")) {
    try {
      sources.postman = await fetchPostmanReportContext({ moduleName, description });
      if (!sources.postman.ok && !sources.postman.skipped) {
        errors.push(`Postman: ${sources.postman.error}`);
      }
    } catch (err) {
      sources.postman = { ok: false, error: err.message, text: "" };
      errors.push(`Postman: ${err.message}`);
    }
  }

  if (providers.includes("playwright")) {
    try {
      sources.playwright = await fetchPlaywrightReportContext({ moduleName });
      if (!sources.playwright.ok) errors.push(`Playwright: ${sources.playwright.error || "snapshot failed"}`);
    } catch (err) {
      sources.playwright = { ok: false, error: err.message, text: "" };
      errors.push(`Playwright: ${err.message}`);
    }
  }

  sources.navigation = { ok: true, text: navHintsForModule(moduleName) };

  const blocks = [];
  if (sources.postman?.text) {
    blocks.push(`### Postman MCP — API surface\n${sources.postman.text}`);
  }
  if (sources.playwright?.text) {
    blocks.push(
      `### Playwright MCP — live panel accessibility snapshot\nUse for UI Structure & User Actions. Mark unverified items as "Derived from snapshot".\n\`\`\`\n${sources.playwright.text}\n\`\`\``
    );
  }
  if (sources.navigation?.text) {
    blocks.push(`### Panel navigation map\n${sources.navigation.text}`);
  }

  return {
    providers,
    sources,
    errors,
    combinedText: blocks.length
      ? `\n\n--- MCP CONTEXT (Postman + Playwright — prefer over stale guesses) ---\n${blocks.join("\n\n")}\n--- end MCP context ---\n`
      : "",
  };
}

module.exports = {
  reportMcpContextProviders,
  gatherReportMcpContext,
};
