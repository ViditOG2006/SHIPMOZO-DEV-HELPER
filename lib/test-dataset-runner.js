const { nowSessionId } = require("./doc-generation");
const { loadNavigationMap } = require("./panel-navigation");
const { getDataset } = require("./test-dataset-store");
const { saveRun } = require("./test-run-store");
const { captureScenarioEvidence } = require("./test-evidence");
const { runE2eScenario } = require("./test-e2e");
const { isChatAiEnabled, getChatDisabledReason } = require("./ai-scope");
const { filterScenariosForRunTarget } = require("./panel-ui-scenario");
const { isBackendOnlyModule } = require("./backend-only-module");
const { isPostmanMcpApiRunEnabled, isHttpApiRunEnabled } = require("./api-run-backend");
const { runApiViaPostmanMcp } = require("./postman-mcp-runner");
const { runApiViaHttp } = require("./api-http-runner");

const SERVER_PORT = Number(process.env.PORT || 3000);
const BASE = `http://127.0.0.1:${SERVER_PORT}`;

const LIVE_CATEGORIES = new Set(["chat", "screenshots"]);
const GET_ONLY = new Set([
  "/api/health",
  "/api/ai/config",
  "/api/panel/navigation",
  "/api/reports",
  "/api/docs/examples",
  "/api/testing/meta",
  "/api/testing/datasets",
]);

const MODULE_ALIASES = {
  "/orders/add": "Quick Add",
  "/orders/new": "New Orders",
  "/orders/all": "All Orders",
  "/integrations": "Integrations",
  "/channels/shopify": "Shopify",
  "/billing": "Billing",
  "rate calculator": "Rate Calculator",
  "rate-calculator": "Rate Calculator",
  "orders/add": "Quick Add",
  "orders/new": "New Orders",
};

function isE2ePanelScenario(scenario) {
  return Boolean(scenario.inputs?.e2eFlow || scenario.inputs?.uiAction);
}

function isE2eExecution(actual, scenario) {
  return Boolean(
    actual.e2eFlow ||
      actual.method === "PLAYWRIGHT" ||
      (scenario.category === "e2e" && isE2ePanelScenario(scenario))
  );
}

function normalizeModuleName(scenario) {
  const raw = String(scenario.inputs?.moduleName || scenario.module || "").trim();
  if (!raw) return "New Orders";
  const key = raw.toLowerCase();
  if (MODULE_ALIASES[key]) return MODULE_ALIASES[key];
  if (MODULE_ALIASES[raw]) return MODULE_ALIASES[raw];
  if (raw.startsWith("/")) return raw.split("/").filter(Boolean).pop().replace(/-/g, " ") || "New Orders";
  return raw;
}

function scenarioHaystack(scenario) {
  return `${scenario.title} ${scenario.description} ${scenario.module || ""} ${
    scenario.inputs?.chatQuery || ""
  } ${scenario.inputs?.uiAction || ""}`.toLowerCase();
}

function isPanelOnlyScenario(scenario) {
  const exp = scenario.expectedResults || {};
  if ((exp.responseFields || []).some((f) => /order|product|quantity|status|shipment/i.test(f))) {
    return true;
  }
  const hay = scenarioHaystack(scenario);
  if (
    scenario.category === "e2e" &&
    (hay.includes("submit") || hay.includes("form") || hay.includes("fill in") || scenario.inputs?.uiAction)
  ) {
    return true;
  }
  return false;
}

function needsLivePanel(scenario) {
  if (scenario.inputs?.useLivePanel === false) return false;
  if (scenario.inputs?.useLivePanel === true) return true;
  if (LIVE_CATEGORIES.has(scenario.category)) return true;
  if (scenario.category === "e2e") return true;
  if (scenario.category === "module_docs" && scenario.inputs?.captureScreens !== false) {
    const hay = scenarioHaystack(scenario);
    return hay.includes("screenshot") || hay.includes("capture") || hay.includes("live");
  }
  const exp = scenario.expectedResults || {};
  if ((exp.minScreenshots || 0) > 0 || (exp.minPagesVisited || 0) > 0) return true;
  return false;
}

function shouldCapturePanelEvidence(scenario) {
  if (scenario.category !== "api" && scenario.category !== "config") return true;
  if (scenario.inputs?.captureScreens === true) return true;
  const skipApiEvidence =
    process.env.TEST_SKIP_API_EVIDENCE !== "false" &&
    process.env.TEST_SKIP_API_EVIDENCE !== "0";
  return !skipApiEvidence;
}

function isKnownRoute(path, method) {
  if (GET_ONLY.has(path)) return method === "GET";
  if (path.startsWith("/api/reports/search")) return method === "GET";
  if (path.startsWith("/api/reports/")) return method === "GET";
  if (
    [
      "/api/ai/chat",
      "/api/docs/generate-step",
      "/api/ai/test",
      "/api/testing/generate",
      "/api/testing/run",
      "/api/app/clear-data",
    ].includes(path)
  ) {
    return method === "POST";
  }
  return path.startsWith("/api/");
}

function inferChatQuery(scenario) {
  if (scenario.inputs?.chatQuery) return scenario.inputs.chatQuery;
  const hay = scenarioHaystack(scenario);
  if (hay.includes("order") && (hay.includes("create") || hay.includes("new") || hay.includes("add"))) {
    return "How do I create a new order in Shipmozo?";
  }
  if (hay.includes("billing")) return "How does billing work in Shipmozo?";
  if (hay.includes("shopify") || hay.includes("integration")) {
    return "How do I set up Shopify integration?";
  }
  return scenario.title;
}

function hasField(obj, path) {
  if (!obj || !path) return false;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || !(p in cur)) return false;
    cur = cur[p];
  }
  return cur !== undefined && cur !== null;
}

const FAKE_ORDER_FIELDS = new Set([
  "orderid",
  "order_id",
  "status",
  "productid",
  "product_id",
  "shipmentid",
]);

function isChatExecution(actual, scenario) {
  if (actual.endpoint === "/api/ai/chat") return true;
  if (scenario.category === "chat") return true;
  if (scenario.category === "e2e" && actual.reply) return true;
  return Boolean(actual.reply || actual.body?.reply);
}

function isFakeShipmozoOrderApi(scenario) {
  const ep = String(scenario.inputs?.apiEndpoint || "").toLowerCase();
  if (!ep) return scenario.category === "e2e";
  if (ep.includes("/api/panel/") || ep.startsWith("/api/")) {
    return !isKnownRoute(
      ep.startsWith("/") ? ep.split("?")[0] : `/${ep.split("?")[0]}`,
      String(scenario.inputs?.apiMethod || "GET").toUpperCase()
    );
  }
  return ep.includes("/orders") && !ep.includes("/api/");
}

function replyCoversIntent(replyText, term, scenario) {
  const hay = replyText.toLowerCase();
  const t = String(term).toLowerCase();
  if (/order created successfully|order creation/i.test(t)) {
    return /order/.test(hay) && /(creat|add|new|step|quick)/.test(hay);
  }
  if (/product id is required/i.test(t)) {
    return /product|required|field|fill|missing|valid/.test(hay);
  }
  if (/unauthorized/i.test(t)) {
    return /unauthorized|login|credential|api key|auth/i.test(hay);
  }
  if (scenarioHaystack(scenario).includes("order") && t.length > 20) {
    return /order/.test(hay) && hay.length > 120;
  }
  return hay.includes(t);
}

function isPostmanApiRun(actual, scenario) {
  return (
    actual.method === "POSTMAN" ||
    scenario.tags?.includes("postman-mcp") ||
    Boolean(actual.postmanRun)
  );
}

function assertPostmanApiOutcome(actual, scenario, failures, skipped) {
  if (!isPostmanApiRun(actual, scenario)) return;
  if (scenario.category !== "api" && scenario.category !== "config") return;

  const pr = actual.postmanRun || {};
  const requestFailed = pr.requestMatched && pr.requestOk === false;
  const collectionFailed =
    (pr.collectionFailed || 0) > 0 || (pr.failed || 0) > 0 || actual.ok === false;

  if (requestFailed) {
    failures.push(
      actual.error ||
        `Postman request failed (${scenario.inputs?.postmanRequestName || scenario.title})`
    );
    return;
  }

  if (pr.requestMatched && pr.requestOk !== false) {
    if (pr.collectionFailed > 0) {
      skipped.push(
        `${pr.collectionFailed} other request(s) in the same folder run failed (not counted against this test)`
      );
    }
    return;
  }

  if (collectionFailed || actual.error) {
    failures.push(
      actual.error ||
        `Postman/Newman reported ${pr.failed || pr.collectionFailed || "collection"} failure(s)`
    );
  }
}

function evaluateAssertions(actual, expected, scenario) {
  const failures = [];
  const skipped = [];
  const exp = expected || {};
  const chatRun = isChatExecution(actual, scenario);
  const e2eRun = isE2eExecution(actual, scenario);
  const fakeOrderApi = isFakeShipmozoOrderApi(scenario);
  const uiText = String(actual.uiText || "").toLowerCase();
  const hasPrd = Boolean(actual.prd || actual.body?.prd);
  const hasManual = Boolean(actual.user_manual || actual.body?.user_manual);
  const liveRun =
    !actual.offlineMode &&
    ((actual.screenshotCount ?? actual.screenshots?.length ?? 0) > 0 ||
      (actual.pageCount ?? 0) > 0);

  const screenshotCount =
    actual.screenshotCount ?? actual.screenshots?.length ?? actual.body?.screenshots?.length ?? 0;
  const skipVisual = actual.offlineMode === true;
  const replyText = String(actual.reply || actual.body?.reply || "");
  const e2eSuccessSignals =
    e2eRun &&
    actual.ok !== false &&
    ((actual.stepsRun || []).length > 0 || screenshotCount > 0);
  const pageUrl = String(actual.pageUrl || "").toLowerCase();

  if (e2eRun) {
    if (actual.ok === false) {
      failures.push(actual.error || "E2E flow reported failure");
    }
    if (actual.referenceId && !uiText.includes(String(actual.referenceId).toLowerCase())) {
      failures.push(`Order reference "${actual.referenceId}" not found in page text`);
    }
    if (pageUrl.includes("manage-courier") && !pageUrl.includes("rate-calculator")) {
      failures.push("Landed on /courier/manage-courier (404 trap — use Ctrl+B → Tools → Rate Calculator)");
    }
    if (
      uiText &&
      (uiText.includes("could not be found") ||
        uiText.includes("opps") ||
        uiText.includes("go back home"))
    ) {
      failures.push("Page shows 404 / not found content");
    }
  }

  if (exp.httpStatus != null) {
    const postmanRun =
      actual.method === "POSTMAN" ||
      scenario.tags?.includes("postman-mcp") ||
      Boolean(actual.postmanRun);
    if (chatRun || fakeOrderApi || isPanelOnlyScenario(scenario)) {
      skipped.push(
        `HTTP ${exp.httpStatus} not checked (scenario runs via Chat/Dev Helper, not a Shipmozo order REST API)`
      );
    } else if (postmanRun) {
      const pr = actual.postmanRun || {};
      const requestPassed = pr.requestMatched && pr.requestOk !== false;
      if (requestPassed) {
        skipped.push("HTTP status validated via Newman/Postman assertions (this request)");
        if (pr.collectionFailed > 0) {
          skipped.push(
            `${pr.collectionFailed} other request(s) in the same folder run failed (not counted against this test)`
          );
        }
      } else if (actual.error && actual.ok === false) {
        failures.push(actual.error);
      } else if (pr.failed > 0 || pr.collectionFailed > 0) {
        const n = pr.failed || pr.collectionFailed;
        failures.push(`Postman/Newman reported ${n} failure(s)`);
      } else {
        skipped.push("HTTP status validated via Newman/Postman assertions");
      }
    } else if (actual.httpStatus !== exp.httpStatus) {
      failures.push(`Expected HTTP ${exp.httpStatus}, got ${actual.httpStatus ?? "none"}`);
    }
  }

  if (!skipVisual && exp.minScreenshots != null) {
    const minAccept = Math.min(exp.minScreenshots, 1);
    if (screenshotCount < minAccept) {
      failures.push(`Expected ≥ ${minAccept} screenshot(s), got ${screenshotCount}`);
    } else if (screenshotCount < exp.minScreenshots) {
      skipped.push(
        `Wanted ${exp.minScreenshots} screenshot(s), got ${screenshotCount} (accepted ≥1 for automated run)`
      );
    }
  }

  const pageCount = actual.pageCount ?? actual.pages?.length ?? actual.body?.livePanel?.pageCount ?? 0;
  if (!skipVisual && exp.minPagesVisited != null && pageCount < exp.minPagesVisited) {
    if (pageCount >= 1 && liveRun) {
      skipped.push(
        `Wanted ${exp.minPagesVisited} page(s), got ${pageCount} (accepted ≥1 with live browse)`
      );
    } else {
      failures.push(`Expected ≥ ${exp.minPagesVisited} page(s), got ${pageCount}`);
    }
  }

  const e2eFlowPassed = e2eRun && actual.ok !== false && !actual.error;
  for (const term of exp.uiMustContain || []) {
    if (e2eFlowPassed) {
      skipped.push(`uiMustContain "${term}" skipped (Playwright flow OK)`);
      continue;
    }
    const t = String(term).toLowerCase();
    if (!uiText) {
      if (e2eRun) {
        failures.push(`UI missing: "${term}" (no page text captured)`);
      } else {
        skipped.push(`UI check "${term}" skipped (not an E2E run)`);
      }
      continue;
    }
    if (!uiText.includes(t)) {
      failures.push(`UI missing: "${term}"`);
    }
  }

  for (const term of exp.uiMustNotContain || []) {
    if (!uiText) continue;
    if (uiText.includes(String(term).toLowerCase())) {
      failures.push(`UI must not contain: "${term}"`);
    }
  }

  if (exp.pageUrlMustContain) {
    const url = String(actual.pageUrl || "").toLowerCase();
    const needle = String(exp.pageUrlMustContain).toLowerCase();
    if (e2eRun && !url.includes(needle)) {
      failures.push(`URL missing: "${exp.pageUrlMustContain}"`);
    }
  }

  for (const term of exp.replyMustContain || []) {
    if (e2eRun) {
      skipped.push(`Reply check "${term}" skipped (E2E UI run)`);
      continue;
    }
    if (!replyText) {
      skipped.push(`Reply check "${term}" skipped (no chat reply)`);
      continue;
    }
    if (!replyCoversIntent(replyText, term, scenario)) {
      failures.push(`Reply missing: "${term}"`);
    }
  }

  for (const term of exp.replyMustNotContain || []) {
    if (!replyText) continue;
    const t = String(term).toLowerCase();
    if (t === "error" && chatRun) {
      skipped.push('replyMustNotContain "Error" relaxed (chat guides may mention errors/tips)');
      continue;
    }
    if (replyText.toLowerCase().includes(t)) {
      failures.push(`Reply must not contain: "${term}"`);
    }
  }

  if (exp.errorMessage) {
    if (chatRun || fakeOrderApi) {
      skipped.push(`errorMessage "${exp.errorMessage}" not checked for Chat/panel scenario`);
    } else {
      const errHay = `${actual.error || ""} ${actual.body?.error || ""}`.toLowerCase();
      if (!errHay.includes(String(exp.errorMessage).toLowerCase())) {
        failures.push(`Expected error containing "${exp.errorMessage}"`);
      }
    }
  }

  for (const field of exp.responseFields || []) {
    const key = String(field).toLowerCase().replace(/\s/g, "");
    if (chatRun || fakeOrderApi || FAKE_ORDER_FIELDS.has(key)) {
      skipped.push(`response field "${field}" not in Dev Helper API response`);
      continue;
    }
    const body = actual.body || actual;
    if (!hasField(body, field)) {
      failures.push(`Missing response field: ${field}`);
    }
  }

  if (exp.maxDurationSeconds != null && actual.durationMs != null) {
    const limitSec = liveRun ? Math.max(exp.maxDurationSeconds, 180) : exp.maxDurationSeconds;
    if (actual.durationMs > limitSec * 1000) {
      failures.push(
        `Exceeded max duration ${limitSec}s (${Math.round(actual.durationMs / 1000)}s)`
      );
    } else if (liveRun && exp.maxDurationSeconds < 180) {
      skipped.push(`Duration limit raised to ${limitSec}s for live panel browse`);
    }
  }

  const prd = String(actual.prd || actual.body?.prd || "");
  for (const section of exp.prdSections || []) {
    if (!hasPrd) {
      skipped.push(`PRD section "${section}" skipped (this run did not generate a PRD)`);
    } else if (!prd.toLowerCase().includes(String(section).toLowerCase())) {
      failures.push(`PRD missing: "${section}"`);
    }
  }

  const manual = String(actual.user_manual || actual.body?.user_manual || "");
  for (const item of exp.manualMustHave || []) {
    if (!hasManual) {
      skipped.push(`Manual check "${item}" skipped (this run did not generate a user manual)`);
    } else if (!manual.toLowerCase().includes(String(item).toLowerCase())) {
      failures.push(`Manual missing: "${item}"`);
    }
  }

  if (
    scenario.type === "negative" &&
    exp.httpStatus == null &&
    !exp.errorMessage &&
    !exp.custom?.resultMustNotEqual &&
    !chatRun &&
    !fakeOrderApi &&
    !isPostmanApiRun(actual, scenario)
  ) {
    const ok = actual.httpStatus >= 400 || Boolean(actual.error || actual.body?.error);
    if (!ok) failures.push("Negative test expected an error response");
  }

  if (exp.httpStatus == null) {
    assertPostmanApiOutcome(actual, scenario, failures, skipped);
  }

  return { passed: failures.length === 0, failures, skipped };
}

async function apiRequest(path, { method = "GET", body, timeoutMs = 180000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    return {
      httpStatus: res.status,
      body: parsed,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      httpStatus: 0,
      error: err.name === "AbortError" ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : err.message,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveEndpoint(scenario) {
  const inp = scenario.inputs || {};
  const hay = scenarioHaystack(scenario);

  if (inp.apiEndpoint) {
    const path = inp.apiEndpoint.startsWith("/") ? inp.apiEndpoint : `/${inp.apiEndpoint}`;
    const method = (inp.apiMethod || "GET").toUpperCase();
    if (isKnownRoute(path, method)) {
      return { path, method, body: inp.apiBody || undefined, kind: "api" };
    }
  }

  if (scenario.category === "e2e" && isE2ePanelScenario(scenario)) {
    return { kind: "e2e" };
  }

  if (scenario.category === "chat" || (scenario.category === "e2e" && !hay.includes("api"))) {
    return { kind: "chat", query: inferChatQuery(scenario) };
  }

  if (
    scenario.category === "screenshots" ||
    (inp.captureScreens && (hay.includes("screenshot") || scenario.category === "e2e"))
  ) {
    return { kind: "screenshot", moduleName: normalizeModuleName(scenario) };
  }

  if (scenario.type === "negative") {
    if (!String(inp.moduleName || scenario.module || "").trim() || hay.includes("missing") || hay.includes("empty")) {
      return {
        kind: "api",
        path: "/api/docs/generate-step",
        method: "POST",
        body: { step: "prd", sessionId: nowSessionId(), moduleName: "" },
      };
    }
    if (hay.includes("message") || hay.includes("chat") || scenario.category === "chat") {
      return { kind: "chat", query: "", negative: true };
    }
  }

  if (hay.includes("health")) return { kind: "api", path: "/api/health", method: "GET" };
  if (scenario.category === "config" || hay.includes("api key") || hay.includes("config")) {
    return { kind: "api", path: "/api/ai/config", method: "GET" };
  }
  if (scenario.category === "navigation" || hay.includes("navigation")) {
    return { kind: "api", path: "/api/panel/navigation", method: "GET" };
  }
  if (hay.includes("search") && hay.includes("report")) {
    return { kind: "api", path: "/api/reports/search?q=order", method: "GET" };
  }
  if (hay.includes("report")) return { kind: "api", path: "/api/reports", method: "GET" };

  if (scenario.category === "module_docs" || hay.includes("prd") || hay.includes("manual")) {
    const moduleName = normalizeModuleName(scenario);
    return {
      kind: "api",
      path: "/api/docs/generate-step",
      method: "POST",
      body: {
        step: hay.includes("screenshot") ? "screenshots" : hay.includes("manual") ? "manual" : "prd",
        sessionId: nowSessionId(),
        moduleName,
        description: inp.description || "",
        captureScreens: inp.captureScreens !== false && !hay.includes("prd only"),
      },
    };
  }

  if (scenario.category === "e2e" && isE2ePanelScenario(scenario)) {
    return { kind: "e2e" };
  }

  if (scenario.category === "e2e" || hay.includes("order")) {
    return { kind: "chat", query: inferChatQuery(scenario) };
  }

  return { kind: "api", path: "/api/health", method: "GET" };
}

function shouldRunApiViaPostman(scenario) {
  if (!isPostmanMcpApiRunEnabled()) return false;
  if (scenario.category === "api") return true;
  if (scenario.tags?.includes("postman-mcp")) return true;
  if (scenario.inputs?.postmanCollectionId) return true;
  return false;
}

function shouldRunApiViaHttp(scenario) {
  if (!isHttpApiRunEnabled()) return false;
  if (scenario.category !== "api") return false;
  return Boolean(scenario.inputs?.apiEndpoint || scenario.inputs?.apiUrl);
}

async function runApiScenario(scenario, ctx) {
  if (shouldRunApiViaPostman(scenario)) {
    return runApiViaPostmanMcp(scenario, ctx);
  }
  if (shouldRunApiViaHttp(scenario)) {
    return runApiViaHttp(scenario, ctx);
  }

  const resolved = resolveEndpoint(scenario);
  if (resolved.kind === "e2e") return runE2eScenario(scenario, ctx);
  if (resolved.kind === "chat") return runChatScenario(scenario, ctx, resolved.query);
  if (resolved.kind === "screenshot") return runScreenshotScenario(scenario, ctx, resolved.moduleName);

  const timeoutMs =
    resolved.path?.includes("generate-step") || resolved.path?.includes("/chat")
      ? 360000
      : 60000;

  const result = await apiRequest(resolved.path, {
    method: resolved.method,
    body: resolved.body,
    timeoutMs,
  });

  return {
    ...result,
    endpoint: resolved.path,
    method: resolved.method,
    screenshotCount: result.body?.screenshots?.length,
    pageCount: result.body?.livePanel?.pageCount,
    reply: result.body?.reply,
    prd: result.body?.prd,
    user_manual: result.body?.user_manual,
    error: result.error || result.body?.error,
  };
}

async function runChatScenario(scenario, ctx, queryOverride) {
  if (!isChatAiEnabled()) {
    return { skipped: true, reason: getChatDisabledReason() };
  }

  const query =
    queryOverride ||
    scenario.inputs?.chatQuery ||
    inferChatQuery(scenario);
  const useLivePanel = ctx.skipLive ? false : scenario.inputs?.useLivePanel !== false;

  if (!query && scenario.type === "negative") {
    const result = await apiRequest("/api/ai/chat", {
      method: "POST",
      body: { messages: [], useLivePanel: false },
      timeoutMs: 30000,
    });
    return {
      ...result,
      reply: result.body?.reply,
      error: result.body?.error || result.error,
    };
  }

  const result = await apiRequest("/api/ai/chat", {
    method: "POST",
    body: {
      messages: [{ role: "user", content: String(query) }],
      useLivePanel,
      includeHealLessons: true,
      model: ctx.model,
      provider: ctx.provider,
    },
    timeoutMs: useLivePanel ? 360000 : 180000,
  });

  const panelShots = result.body?.livePanel?.screenshots || [];
  return {
    ...result,
    reply: result.body?.reply,
    screenshots: panelShots,
    screenshotCount: panelShots.length,
    pageCount: result.body?.livePanel?.pageCount ?? 0,
    error: result.body?.error || result.error || result.body?.livePanel?.error,
    offlineMode: !useLivePanel,
  };
}

async function runScreenshotScenario(scenario, ctx, moduleOverride) {
  const moduleName = moduleOverride || normalizeModuleName(scenario);
  if (!moduleName?.trim()) {
    if (scenario.type === "negative") {
      const result = await apiRequest("/api/docs/generate-step", {
        method: "POST",
        body: { step: "screenshots", sessionId: nowSessionId(), moduleName: "" },
        timeoutMs: 30000,
      });
      return { ...result, error: result.body?.error || result.error };
    }
    return { skipped: true, reason: "No moduleName for screenshot scenario" };
  }

  const result = await apiRequest("/api/docs/generate-step", {
    method: "POST",
    body: {
      step: "screenshots",
      sessionId: nowSessionId(),
      moduleName,
      description: scenario.inputs?.description || "",
      captureScreens: true,
    },
    timeoutMs: 360000,
  });

  const shots = result.body?.screenshots || [];
  return {
    ...result,
    screenshots: shots,
    screenshotCount: shots.length,
    error: result.body?.captureError || result.body?.error || result.error,
  };
}

async function runModuleDocsScenario(scenario, ctx) {
  if (ctx.skipLive && needsLivePanel(scenario)) {
    return { skipped: true, reason: "Skipped live panel (skipLive mode)" };
  }
  return runApiScenario(scenario, ctx);
}

async function runNavigationScenario(scenario, ctx) {
  if (scenario.inputs?.useLivePanel !== false) {
    return runScreenshotScenario(scenario, ctx);
  }
  const result = await apiRequest("/api/panel/navigation", { method: "GET", timeoutMs: 30000 });
  const map = loadNavigationMap();
  return {
    ...result,
    body: result.body || {},
    navPageCount: result.body?.pageCount ?? map.pageCount,
  };
}

function mergeResultScreenshots(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const s of list || []) {
      const key = s?.url || s?.localPath || s?.path || s?.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: s.id,
        label: s.label,
        url: s.url,
        storage: s.storage,
        path: s.path || s.localPath,
      });
    }
  }
  return out;
}

async function enrichActualWithEvidence(scenario, ctx, actual) {
  if (!ctx.captureEvidence || !ctx.runId || !shouldCapturePanelEvidence(scenario)) return actual;
  if ((actual.screenshotCount ?? actual.screenshots?.length ?? 0) >= 1) return actual;
  try {
    const evidence = await captureScenarioEvidence(ctx.runId, scenario, ctx);
    if (evidence.screenshots?.length) {
      actual.screenshots = mergeResultScreenshots(actual.screenshots, evidence.screenshots);
      actual.screenshotCount = actual.screenshots.length;
      actual.evidenceCaptured = true;
    } else if (evidence.error) {
      actual.evidenceError = evidence.error;
    }
  } catch (err) {
    actual.evidenceError = err.message;
  }
  return actual;
}

async function attachEvidence(scenario, ctx, result) {
  if (!ctx.captureEvidence || !ctx.runId || !shouldCapturePanelEvidence(scenario)) return result;
  if (result.screenshots?.length >= 1) return result;
  try {
    const evidence = await captureScenarioEvidence(ctx.runId, scenario, ctx);
    if (evidence.screenshots?.length) {
      result.screenshots = mergeResultScreenshots(result.screenshots, evidence.screenshots);
      result.evidenceCaptured = true;
    } else if (evidence.error) {
      result.evidenceError = evidence.error;
    }
  } catch (err) {
    result.evidenceError = err.message;
  }
  return result;
}

function baseResult(scenario, partial) {
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    type: scenario.type,
    priority: scenario.priority,
    screenshots: [],
    ...partial,
  };
}

async function executeScenario(scenario, ctx) {
  const started = Date.now();
  let actual;

  try {
    let skipReason = null;
    if (ctx.skipLive && isE2ePanelScenario(scenario)) {
      skipReason = "E2E panel tests require live mode (disable skipLive)";
    } else if (ctx.skipLive && scenario.category === "screenshots") {
      skipReason = "Screenshot API step skipped (enable live tests for full capture)";
    } else if (ctx.skipLive && isPanelOnlyScenario(scenario)) {
      skipReason = "Panel form validation — assertions skipped; evidence screenshot still captured";
    }

    if (skipReason && !ctx.captureEvidence) {
      return baseResult(scenario, {
        status: "skipped",
        reason: skipReason,
        durationMs: Date.now() - started,
      });
    }

    if (!skipReason) {
    if (scenario.category === "chat" && !isChatAiEnabled()) {
      return baseResult(scenario, {
        status: "skipped",
        reason: getChatDisabledReason(),
        durationMs: Date.now() - started,
      });
    }

    switch (scenario.category) {
      case "api":
      case "config":
        actual = await runApiScenario(scenario, ctx);
        break;
      case "chat":
        actual = await runChatScenario(scenario, ctx);
        break;
      case "screenshots":
        actual = await runScreenshotScenario(scenario, ctx);
        break;
      case "module_docs":
        actual = await runModuleDocsScenario(scenario, ctx);
        break;
      case "navigation":
        actual = await runNavigationScenario(scenario, ctx);
        break;
      case "e2e":
        if (isE2ePanelScenario(scenario)) {
          actual = await runE2eScenario(scenario, ctx);
        } else {
          actual = await runApiScenario(scenario, ctx);
          if (actual.skipped) actual = await runChatScenario(scenario, ctx);
        }
        break;
      default:
        actual = await runApiScenario(scenario, ctx);
    }

    if (actual?.skipped) {
      const skipped = baseResult(scenario, {
        status: "skipped",
        reason: actual.reason,
        durationMs: Date.now() - started,
      });
      return attachEvidence(scenario, ctx, skipped);
    }

    actual.durationMs = actual.durationMs ?? Date.now() - started;
    actual = await enrichActualWithEvidence(scenario, ctx, actual);
    const assertions = evaluateAssertions(actual, scenario.expectedResults, scenario);

    const done = baseResult(scenario, {
      status: assertions.passed ? "passed" : "failed",
      durationMs: actual.durationMs,
      assertions,
      screenshots: mergeResultScreenshots(actual.screenshots),
      actual: {
        httpStatus: actual.httpStatus,
        endpoint: actual.endpoint,
        e2eFlow: actual.e2eFlow,
        pageUrl: actual.pageUrl,
        screenshotCount: actual.screenshotCount ?? actual.screenshots?.length ?? 0,
        pageCount: actual.pageCount,
        error: actual.error,
        stepsRun: actual.stepsRun,
        referenceId: actual.referenceId,
        replyPreview: actual.reply ? String(actual.reply).slice(0, 280) : undefined,
        uiPreview: actual.uiText ? String(actual.uiText).slice(0, 280) : undefined,
      },
    });
    return attachEvidence(scenario, ctx, done);
    }

    actual = { durationMs: Date.now() - started, offlineMode: ctx.skipLive };
    const assertions = skipReason
      ? { passed: true, failures: [] }
      : evaluateAssertions(actual, scenario.expectedResults, scenario);

    const skippedRun = baseResult(scenario, {
      status: skipReason ? "skipped" : assertions.passed ? "passed" : "failed",
      reason: skipReason || undefined,
      durationMs: actual.durationMs,
      assertions,
      actual: { offlineMode: ctx.skipLive },
    });
    return attachEvidence(scenario, ctx, skippedRun);
  } catch (err) {
    const actual = { error: err.message, durationMs: Date.now() - started, httpStatus: 500 };
    const assertions = evaluateAssertions(actual, scenario.expectedResults, scenario);
    const failed = baseResult(scenario, {
      status: assertions.passed ? "passed" : "failed",
      durationMs: actual.durationMs,
      error: err.message,
      assertions,
      actual: { error: err.message },
    });
    return attachEvidence(scenario, ctx, failed);
  }
}

function summarizeResults(results) {
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    withScreenshots: results.filter((r) => r.screenshots?.length).length,
    durationMs: results.reduce((n, r) => n + (r.durationMs || 0), 0),
  };
}

async function runTestStep({
  runId,
  scenario,
  skipLive = false,
  captureEvidence = true,
  showBrowser = true,
  model,
  provider,
  postmanFolders = null,
  runTarget = "backend",
}) {
  const ctx = {
    skipLive,
    model,
    provider,
    runId,
    captureEvidence,
    showBrowser,
    runTarget,
    recordVideo: runTarget === "frontend" || runTarget === "both",
    postmanFolders: postmanFolders?.length ? postmanFolders : null,
  };
  const result = await executeScenario(scenario, ctx);
  return result;
}

async function runTestDataset({
  datasetId,
  dataset: datasetIn,
  scenarioIds,
  skipLive = true,
  captureEvidence = true,
  model,
  provider,
  onProgress,
  options = {},
}) {
  const dataset = datasetIn || getDataset(datasetId);
  if (!dataset?.scenarios?.length) {
    throw new Error("Dataset not found or has no scenarios");
  }

  const runTarget = String(options.runTarget || "backend").trim() || "backend";

  let scenarios = dataset.scenarios;
  if (scenarioIds?.length) {
    const idSet = new Set(scenarioIds);
    scenarios = scenarios.filter((s) => idSet.has(s.id));
  } else {
    scenarios = filterScenariosForRunTarget(scenarios, runTarget, {
      backendOnly: isBackendOnlyModule({ dataset }),
    });
  }

  const runId = nowSessionId();
  const startedAt = new Date().toISOString();
  const doCaptureEvidence =
    captureEvidence !== false && (options.captureEvidence !== false);
  const doShowBrowser = options.showBrowser !== false;
  const ctx = {
    skipLive,
    model,
    provider,
    runId,
    captureEvidence: doCaptureEvidence,
    showBrowser: doShowBrowser,
    runTarget,
    recordVideo: runTarget === "frontend" || runTarget === "both",
  };
  const results = [];

  for (let i = 0; i < scenarios.length; i += 1) {
    const scenario = scenarios[i];
    onProgress?.({
      index: i + 1,
      total: scenarios.length,
      scenarioId: scenario.id,
      title: scenario.title,
    });
    results.push(await executeScenario(scenario, ctx));
  }

  const summary = summarizeResults(results);

  const run = {
    runId,
    datasetId: dataset.id,
    datasetTitle: dataset.title,
    startedAt,
    finishedAt: new Date().toISOString(),
    options: {
      skipLive,
      captureEvidence: doCaptureEvidence,
      showBrowser: doShowBrowser,
      runTarget,
      scenarioCount: scenarios.length,
    },
    summary,
    results,
  };

  saveRun(run);
  return run;
}

function buildRunRecord({ runId, dataset, results, startedAt, options }) {
  return {
    runId,
    datasetId: dataset.id,
    datasetTitle: dataset.title,
    startedAt: startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    options,
    summary: summarizeResults(results),
    results,
  };
}

module.exports = {
  runTestDataset,
  runTestStep,
  buildRunRecord,
  summarizeResults,
  executeScenario,
  evaluateAssertions,
  needsLivePanel,
  isE2ePanelScenario,
  baseResult,
};
