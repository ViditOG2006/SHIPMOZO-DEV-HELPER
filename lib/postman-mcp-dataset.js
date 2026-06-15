const { createMcpHttpClient, callMcpTool } = require("./mcp-client");
const { parsePostmanMcpResult } = require("./postman-mcp-parse");
const { nowSessionId } = require("./doc-generation");

function orderTemplateFallback(requirement, options, meta) {
  const { buildOrderE2eTemplateDataset } = require("./test-dataset-generation");
  return buildOrderE2eTemplateDataset(requirement, options, meta);
}

const {
  testcaseBackend,
  isPostmanMcpEnabled,
  isPostmanMcpAgentEnabled,
  isDocsMcpTestcaseEnabled,
  isDocsLlmTestcaseEnabled,
  isScriptFirstTestcaseBackend,
  isAiTestcaseGenerationEnabled,
  testcaseBackendLabel,
} = require("./testcase-backend");

const { postmanMcpUrl, postmanHeaders } = require("./postman-mcp-config");

function parseJsonTool(result) {
  return parsePostmanMcpResult(result);
}

function extractUrlPath(rawUrl) {
  const s = String(rawUrl || "");
  if (!s) return "/";
  if (s.startsWith("{{")) {
    const pathPart = s.replace(/^\{\{[^}]+\}\}/, "");
    return pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  }
  try {
    const u = new URL(s);
    return u.pathname + u.search;
  } catch {
    return s.startsWith("/") ? s : `/${s}`;
  }
}

function friendlyFolderLabel(folderName) {
  const n = String(folderName || "").trim();
  if (!n) return "Other";
  if (/setup|auth/i.test(n)) return "Login & Auth";
  if (/warehouse/i.test(n)) return "Warehouse APIs";
  if (/order/i.test(n)) return "Order APIs";
  if (/courier/i.test(n)) return "Courier APIs";
  if (/track|label/i.test(n)) return "Tracking & Labels";
  if (/utility|rate|pincode/i.test(n)) return "Utility APIs";
  if (/misc/i.test(n)) return "Misc APIs";
  return n.replace(/^\d+_/, "").replace(/_/g, " ");
}

function inferScenarioTypeFromRequestName(name) {
  const n = String(name || "");
  if (/-N\d|negative|invalid|missing|bad|error/i.test(n)) return "negative";
  return "happy_path";
}

function parsePostmanTestExpectations(item) {
  const exec = (item.event || [])
    .filter((e) => e.listen === "test")
    .flatMap((e) => e.script?.exec || []);
  const script = exec.join("\n");
  const type = inferScenarioTypeFromRequestName(item.name);
  const expectedResults = {
    httpStatus: null,
    replyMustContain: [],
    replyMustNotContain: [],
    uiMustContain: [],
    responseFields: [],
    custom: {},
  };

  if (/have\.status\(200\)|\.status\(200\)/i.test(script)) {
    expectedResults.httpStatus = 200;
  }

  if (/result.*not.*["']1["']|not\.eql\(["']1["']\)/i.test(script)) {
    expectedResults.custom.resultMustNotEqual = "1";
    expectedResults.httpStatus = null;
  } else if (/result.*eql\(["']1["']\)/i.test(script)) {
    expectedResults.custom.resultMustEqual = "1";
    if (expectedResults.httpStatus == null) expectedResults.httpStatus = 200;
  }

  const fieldMatches = script.matchAll(/\.property\(["']([^"']+)["']\)/g);
  for (const m of fieldMatches) {
    if (m[1] && !expectedResults.responseFields.includes(m[1])) {
      expectedResults.responseFields.push(m[1]);
    }
  }

  if (type === "negative") {
    expectedResults.httpStatus = null;
  } else if (expectedResults.httpStatus == null && type === "happy_path") {
    expectedResults.httpStatus = 200;
  }

  if (!Object.keys(expectedResults.custom).length) delete expectedResults.custom;

  return { type, expectedResults };
}

function postmanItemToScenario(item, index, collectionName, folderName = "", moduleName = "") {
  const req = item.request || {};
  const method = String(req.method || "GET").toUpperCase();
  const path = extractUrlPath(
    typeof req.url === "string" ? req.url : req.url?.raw || req.url?.path?.join("/") || "/"
  );
  const body =
    typeof req.body === "string"
      ? req.body
      : req.body?.raw
        ? req.body.raw
        : null;
  const folder = folderName || item._postmanFolder || "";
  const moduleLabel = moduleName || (folder ? friendlyFolderLabel(folder) : collectionName || "API");
  const { type, expectedResults } = parsePostmanTestExpectations(item);

  return {
    id: `TC-${String(index + 1).padStart(3, "0")}`,
    title: item.name || `Request ${index + 1}`,
    category: "api",
    type,
    priority: type === "negative" ? "high" : "medium",
    module: moduleLabel,
    description: `From Postman: ${method} ${path}`,
    preconditions: [],
    inputs: {
      apiEndpoint: path,
      apiMethod: method,
      apiBody: body,
      postmanFolder: folder || null,
      postmanRequestName: item.name || null,
      chatQuery: null,
      moduleName: moduleName || null,
      e2eFlow: null,
      formData: null,
      useLivePanel: null,
    },
    steps: [`Call ${method} ${path}`],
    expectedResults,
    tags: ["postman-mcp"],
  };
}

function flattenPostmanItems(items = [], folderName = "", out = []) {
  for (const item of items || []) {
    if (item.item?.length) {
      flattenPostmanItems(item.item, item.name || folderName, out);
    } else if (item.request) {
      out.push({ ...item, _postmanFolder: folderName || item._postmanFolder || "" });
    }
  }
  return out;
}

function listPostmanCollectionGroups(collection) {
  const groups = [];
  for (const item of collection.item || []) {
    if (item.item?.length) {
      const requests = flattenPostmanItems(item.item, item.name, []);
      groups.push({
        id: item.name,
        name: item.name,
        label: friendlyFolderLabel(item.name),
        requestCount: requests.length,
      });
    } else if (item.request) {
      let misc = groups.find((g) => g.id === "__root__");
      if (!misc) {
        misc = { id: "__root__", name: "__root__", label: "Other requests", requestCount: 0 };
        groups.push(misc);
      }
      misc.requestCount += 1;
    }
  }
  return groups;
}

function filterCollectionByFolders(collection, folderNames = []) {
  const names = (Array.isArray(folderNames) ? folderNames : [folderNames])
    .map((f) => String(f || "").trim().toLowerCase())
    .filter(Boolean);
  if (!names.length) return collection;

  const includeRoot = names.includes("__root__");
  const folderSet = new Set(names.filter((n) => n !== "__root__"));

  const item = (collection.item || []).filter((entry) => {
    if (entry.item?.length) {
      return folderSet.has(String(entry.name || "").toLowerCase());
    }
    if (entry.request) return includeRoot;
    return false;
  });

  return { ...collection, item };
}

function normalizeFolderFilter(options = {}) {
  const raw = options.folders || options.postmanFolders || options.selectedFolders || [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((f) => String(f || "").trim())
    .filter(Boolean);
}

function normalizePostmanDataset({ requirement, options, collection, workspaceName }) {
  const folderFilter = normalizeFolderFilter(options);
  let scopedCollection = collection;
  if (folderFilter.length) {
    scopedCollection = filterCollectionByFolders(collection, folderFilter);
  }

  let requests = flattenPostmanItems(scopedCollection.item || []);
  if (folderFilter.length) {
    const folderSet = new Set(folderFilter.map((f) => f.toLowerCase()));
    requests = requests.filter((r) => folderSet.has(String(r._postmanFolder || "").toLowerCase()));
  }

  const cap = Number(options.minScenarios);
  if (Number.isFinite(cap) && cap > 0 && !folderFilter.length) {
    requests = requests.slice(0, cap);
  }

  const scenarios = requests.map((item, i) =>
    postmanItemToScenario(item, i, collection.info?.name, item._postmanFolder)
  );

  const id = nowSessionId().replace(/[^0-9_]/g, "");
  return {
    version: 2,
    id,
    title: collection.info?.name || "Postman API Test Cases",
    summary: `Generated from Postman collection via MCP (${workspaceName || "workspace"})`,
    requirement: String(requirement || "").trim(),
    options: { ...options, qaSheetFormat: false },
    sourceDocs: null,
    moduleShortCode: "API",
    format: "dev_helper_scenarios",
    sheetRows: [],
    sheetRowCount: 0,
    sheetTsv: "",
    scenarios,
    generatedBy: "postman-mcp",
    postman: {
      collectionId: collection.info?._postman_id || collection.info?.uid,
      collectionName: collection.info?.name,
      requestCount: requests.length,
      totalRequestCount: flattenPostmanItems(collection.item || []).length,
      selectedFolders: folderFilter,
      groups: listPostmanCollectionGroups(collection),
    },
    createdAt: new Date().toISOString(),
  };
}

async function pickCollection(client, { requirement, collectionId, workspaceId }) {
  if (collectionId) {
    const result = await callMcpTool(client, "getCollection", {
      collectionId: String(collectionId),
      model: "full",
    });
    const data = parseJsonTool(result);
    if (data?.collection) return data.collection;
    if (data?.item) return data;
    throw new Error("Postman MCP getCollection returned no collection");
  }

  const query = String(requirement || "shipmozo").trim().slice(0, 120);
  const searchResult = await callMcpTool(client, "searchPostmanElementsInPrivateNetwork", {
    query,
  });
  const searchData = parseJsonTool(searchResult);
  const hits =
    searchData?.data ||
    searchData?.results ||
    searchData?.hits ||
    searchData?.collections ||
    [];

  let hit = hits.find((h) => /collection/i.test(h.type || h.elementType || "") || h.collection);
  if (!hit && hits.length) hit = hits[0];
  if (!hit) {
    if (workspaceId) {
      const listResult = await callMcpTool(client, "getCollections", { workspace: workspaceId });
      const listData = parseJsonTool(listResult);
      const collections = listData?.collections || listData?.data || [];
      if (!collections.length) throw new Error("No Postman collections found in workspace");
      hit = { id: collections[0].id || collections[0].uid };
    } else {
      throw new Error(
        `No Postman collection matched "${query}". Set POSTMAN_COLLECTION_ID or POSTMAN_WORKSPACE_ID.`
      );
    }
  }

  const cid = hit.id || hit.uid || hit.collectionId || hit.collection?.id;
  const full = await callMcpTool(client, "getCollection", { collectionId: cid, model: "full" });
  const data = parseJsonTool(full);
  return data?.collection || data;
}

/**
 * Build Dev Helper test dataset from a Postman collection via Postman MCP.
 */
async function generateTestDatasetFromPostman({
  requirement,
  options = {},
  collectionId,
  workspaceId,
} = {}) {
  const key = String(process.env.POSTMAN_API_KEY || "").trim();
  if (!key) {
    throw new Error(
      "POSTMAN_API_KEY is required for Postman MCP testcase generation. Get one at https://postman.postman.co/settings/me/api-keys"
    );
  }

  const url = postmanMcpUrl();
  const client = await createMcpHttpClient("postman", url, postmanHeaders());
  const collection = await pickCollection(client, {
    requirement,
    collectionId: collectionId || process.env.POSTMAN_COLLECTION_ID,
    workspaceId: workspaceId || process.env.POSTMAN_WORKSPACE_ID,
  });

  const dataset = normalizePostmanDataset({
    requirement,
    options,
    collection,
    workspaceName: process.env.POSTMAN_WORKSPACE_NAME || "",
  });

  if (!dataset.scenarios?.length) {
    if (requirement && /order|e2e|playwright/i.test(requirement)) {
      return orderTemplateFallback(requirement, options, {
        creditsNote: "Postman collection had no requests — order E2E template used.",
      });
    }
    throw new Error("Postman collection has no API requests to convert into scenarios");
  }

  return dataset;
}

async function importDatasetFromPostmanCollection({
  collectionId,
  requirement = "",
  options = {},
  folders = null,
} = {}) {
  const { fetchPostmanCollection } = require("./postman-api-client");
  const id = String(collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  if (!id) {
    throw new Error("collectionId or POSTMAN_COLLECTION_ID is required");
  }
  const collection = await fetchPostmanCollection(id);
  const mergedOptions = { ...options };
  const selected = folders || options.folders || options.postmanFolders;
  if (selected?.length) {
    mergedOptions.folders = selected;
  }
  const dataset = normalizePostmanDataset({
    requirement: requirement || `Imported Postman collection ${id}`,
    options: mergedOptions,
    collection,
    workspaceName: process.env.POSTMAN_WORKSPACE_NAME || "",
  });
  if (mergedOptions.folders?.length && !dataset.scenarios?.length) {
    throw new Error("No requests matched the selected test groups");
  }
  if (mergedOptions.includeUiPairs !== false && mergedOptions.folders?.length) {
    const { uiScenariosForFolders } = require("./postman-ui-pairs");
    const uiPairs = uiScenariosForFolders(mergedOptions.folders, {
      startId: (dataset.scenarios?.length || 0) + 1,
    });
    if (uiPairs.length) {
      dataset.scenarios = [...(dataset.scenarios || []), ...uiPairs];
      dataset.scenarioCount = dataset.scenarios.length;
      dataset.postman = dataset.postman || {};
      dataset.postman.uiPairs = uiPairs.map((s) => s.id);
      dataset.summary = `${dataset.scenarios.length - uiPairs.length} API + ${uiPairs.length} UI paired scenario(s)`;
    }
  }
  return dataset;
}

async function listPostmanCollectionGroupsForId(collectionId) {
  const { fetchPostmanCollection } = require("./postman-api-client");
  const id = String(collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  if (!id) throw new Error("collectionId or POSTMAN_COLLECTION_ID is required");
  const collection = await fetchPostmanCollection(id);
  return {
    collectionId: id,
    collectionName: collection.info?.name || "Collection",
    groups: listPostmanCollectionGroups(collection),
    totalRequests: flattenPostmanItems(collection.item || []).length,
  };
}

function postmanRequestsToScenarios(items, collection, { startIndex = 0, moduleName = "" } = {}) {
  return (items || []).map((item, i) =>
    postmanItemToScenario(
      item,
      startIndex + i,
      collection.info?.name,
      item._postmanFolder,
      moduleName
    )
  );
}

function buildCoverageMatrix(scenarios) {
  const byCategory = {};
  const byType = {};
  const byPriority = {};
  for (const s of scenarios) {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
    byType[s.type] = (byType[s.type] || 0) + 1;
    byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
  }
  return { byCategory, byType, byPriority };
}

function mergePostmanApiScenariosIntoDataset(dataset, postmanScenarios, { moduleName = "" } = {}) {
  if (!postmanScenarios?.length) return dataset;

  const postmanEndpoints = new Set(
    postmanScenarios.map((s) => String(s.inputs?.apiEndpoint || "").toLowerCase()).filter(Boolean)
  );
  const postmanNames = new Set(
    postmanScenarios.map((s) => String(s.inputs?.postmanRequestName || "").toLowerCase()).filter(Boolean)
  );

  const nonApi = (dataset.scenarios || []).filter((s) => s.category !== "api");
  const keptApi = (dataset.scenarios || []).filter((s) => {
    if (s.category !== "api") return false;
    const ep = String(s.inputs?.apiEndpoint || "").toLowerCase();
    const name = String(s.inputs?.postmanRequestName || s.title || "").toLowerCase();
    if (ep && postmanEndpoints.has(ep) && !s.inputs?.postmanRequestName) return false;
    if (name && postmanNames.has(name)) return false;
    return true;
  });

  let allScenarios = [...nonApi, ...keptApi, ...postmanScenarios];
  const seen = new Set();
  allScenarios = allScenarios.filter((s) => {
    const key =
      s.category === "api" && s.inputs?.postmanRequestName
        ? `postman:${String(s.inputs.postmanRequestName).toLowerCase()}`
        : `id:${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  allScenarios = allScenarios.map((s, i) => ({
    ...s,
    id: `TC-${String(i + 1).padStart(3, "0")}`,
    inputs: {
      ...s.inputs,
      moduleName: s.inputs?.moduleName || moduleName || s.module || null,
    },
  }));

  const apiCount = allScenarios.filter((s) => s.category === "api").length;
  const uiCount = allScenarios.length - apiCount;

  return {
    ...dataset,
    scenarios: allScenarios,
    scenarioCount: allScenarios.length,
    coverageMatrix: buildCoverageMatrix(allScenarios),
    postman: {
      ...(dataset.postman || {}),
      mergedApiScenarios: postmanScenarios
        .map((s) => s.inputs?.postmanRequestName)
        .filter(Boolean),
      apiScenarioCount: apiCount,
    },
    summary: dataset.summary
      ? `${dataset.summary} (${apiCount} API incl. ${postmanScenarios.length} from Postman)`
      : `${apiCount} API + ${uiCount} UI scenario(s)`,
  };
}

async function searchPostmanCollectionRequests({
  collectionId,
  query = "",
  keywords = [],
  moduleName = "",
  minScore,
} = {}) {
  const { fetchPostmanCollection } = require("./postman-api-client");
  const { deriveSearchKeywords, searchPostmanRequests } = require("./postman-folder-search");
  const id = String(collectionId || process.env.POSTMAN_COLLECTION_ID || "").trim();
  if (!id) throw new Error("collectionId or POSTMAN_COLLECTION_ID is required");

  const collection = await fetchPostmanCollection(id);
  const requests = flattenPostmanItems(collection.item || []);
  const kws = keywords?.length
    ? keywords.map((k) => String(k).toLowerCase())
    : deriveSearchKeywords(moduleName, query);
  const matches = searchPostmanRequests(requests, {
    query: query || moduleName,
    keywords: kws,
    minScore: minScore ?? (kws.length >= 2 ? 2 : 1),
  });

  return {
    collectionId: id,
    collectionName: collection.info?.name || "Collection",
    keywords: kws,
    requests: matches.map((m) => {
      const req = m.item.request || {};
      const path = extractUrlPath(
        typeof req.url === "string" ? req.url : req.url?.raw || req.url?.path?.join("/") || "/"
      );
      return {
        name: m.item.name,
        folder: m.folder,
        score: m.score,
        method: String(req.method || "GET").toUpperCase(),
        path,
        type: inferScenarioTypeFromRequestName(m.item.name),
      };
    }),
    items: matches.map((m) => m.item),
    collection,
  };
}

async function enrichDatasetWithPostmanApi(
  dataset,
  { moduleName = "", collectionId, keywords, query, description = "" } = {}
) {
  if (!String(process.env.POSTMAN_API_KEY || "").trim()) return dataset;
  const name = String(moduleName || dataset.sourceDocs?.moduleName || "").trim();
  if (!name) return dataset;

  try {
    const search = await searchPostmanCollectionRequests({
      collectionId,
      moduleName: name,
      keywords,
      query: query || description || name,
    });
    if (!search.items?.length) return dataset;

    const cid = search.collectionId;
    let postmanScenarios = postmanRequestsToScenarios(search.items, search.collection, {
      moduleName: name,
    });
    postmanScenarios = postmanScenarios.map((s) => ({
      ...s,
      inputs: {
        ...s.inputs,
        postmanCollectionId: cid,
        moduleName: name,
      },
    }));

    return mergePostmanApiScenariosIntoDataset(dataset, postmanScenarios, { moduleName: name });
  } catch (err) {
    console.warn(`[postman-merge] ${err.message}`);
    return dataset;
  }
}

module.exports = {
  testcaseBackend,
  isPostmanMcpEnabled,
  isPostmanMcpAgentEnabled,
  isDocsMcpTestcaseEnabled,
  isDocsLlmTestcaseEnabled,
  isScriptFirstTestcaseBackend,
  isAiTestcaseGenerationEnabled,
  testcaseBackendLabel,
  generateTestDatasetFromPostman,
  importDatasetFromPostmanCollection,
  listPostmanCollectionGroups,
  listPostmanCollectionGroupsForId,
  filterCollectionByFolders,
  normalizePostmanDataset,
  friendlyFolderLabel,
  postmanMcpUrl,
  postmanHeaders,
  flattenPostmanItems,
  inferScenarioTypeFromRequestName,
  parsePostmanTestExpectations,
  postmanRequestsToScenarios,
  searchPostmanCollectionRequests,
  mergePostmanApiScenariosIntoDataset,
  enrichDatasetWithPostmanApi,
};
