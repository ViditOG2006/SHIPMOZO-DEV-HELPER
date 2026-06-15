/** Turn plain-text UI test notes into runnable E2E scenarios. */

function extractModuleQuery(line) {
  const s = String(line || "").trim();
  if (!s) return "";
  const beforeDash = s.split(/\s*[-–—:]\s+/)[0].trim();
  const words = beforeDash.split(/\s+/).filter(Boolean);
  if (!words.length) return s.slice(0, 40);
  const joined = words.slice(0, 4).join(" ");
  const low = joined.toLowerCase();
  if (low.includes("shopify")) return s.length <= 48 ? s : "shopify integration";
  if (low.includes("channel")) return "channels";
  if (low.includes("filter")) return words[0].toLowerCase().includes("order") ? "new orders" : joined;
  if (low.includes("integration")) return "integrations";
  return joined;
}

function extractVerifyTexts(line) {
  const s = String(line || "").toLowerCase();
  const tokens = [];
  for (const kw of [
    "shopify",
    "filter",
    "integration",
    "channel",
    "channels",
    "connect",
    "status",
    "badge",
    "sync",
    "order",
    "export",
    "search",
  ]) {
    if (s.includes(kw)) tokens.push(kw);
  }
  return [...new Set(tokens)];
}

function buildFrontendScenariosFromText(text, { startId = 1 } = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);

  return lines.map((line, i) => {
    const id = `UI-${String(startId + i).padStart(3, "0")}`;
    const moduleQuery = extractModuleQuery(line);
    const verifyTexts = extractVerifyTexts(line);
    return {
      id,
      title: line,
      category: "e2e",
      type: "happy_path",
      priority: "medium",
      module: moduleQuery || "Panel",
      description: `UI check: ${line}`,
      preconditions: ["Logged into merchant panel"],
      inputs: {
        e2eFlow: "panel_ui_check",
        moduleQuery,
        checkNotes: line,
        verifyTexts: verifyTexts.length ? verifyTexts : [moduleQuery.split(" ")[0]].filter(Boolean),
        useLivePanel: true,
      },
      steps: [`Quick Search → ${moduleQuery}`, `Verify: ${line}`],
      expectedResults: {
        uiMustContain: verifyTexts,
      },
      tags: ["frontend-custom"],
    };
  });
}

function mergeFrontendNotesIntoDataset(dataset, text, { tag = "frontend-custom" } = {}) {
  const notes = String(text || "").trim();
  if (!notes) return dataset;
  const startId = (dataset.scenarios?.length || 0) + 1;
  const customUi = buildFrontendScenariosFromText(notes, { startId }).map((s) => ({
    ...s,
    tags: [...new Set([...(s.tags || []), tag])],
  }));
  if (!customUi.length) return dataset;
  const apiCount = (dataset.scenarios || []).filter((s) => s.category === "api").length;
  const uiCount = (dataset.scenarios || []).filter((s) => s.category === "e2e").length + customUi.length;
  return {
    ...dataset,
    scenarios: [...(dataset.scenarios || []), ...customUi],
    scenarioCount: (dataset.scenarios?.length || 0) + customUi.length,
    postman: {
      ...(dataset.postman || {}),
      customFrontendNotes: notes,
      customFrontendIds: customUi.map((s) => s.id),
    },
    summary: dataset.summary
      ? `${dataset.summary} + ${customUi.length} custom UI`
      : `${apiCount} API + ${uiCount} UI scenario(s)`,
  };
}

module.exports = { buildFrontendScenariosFromText, mergeFrontendNotesIntoDataset };
