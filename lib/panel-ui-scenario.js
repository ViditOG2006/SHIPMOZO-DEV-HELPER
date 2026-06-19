/** Which dataset scenarios count as live panel UI runs (screenshots / Playwright). */

function panelE2eFlow(scenario) {
  return String(scenario?.inputs?.e2eFlow || scenario?.inputs?.uiAction || "").trim();
}

function isPanelE2eScenario(scenario) {
  const flow = panelE2eFlow(scenario);
  if (!flow) return false;
  if (scenario?.category === "e2e") return true;
  // Order/rate Playwright flows must batch even when category was mis-tagged.
  return /^(order_|rate_calculator)/.test(flow);
}

function isPanelUiScenario(scenario) {
  if (!scenario) return false;
  if (isPanelE2eScenario(scenario)) return true;
  if (scenario.category === "screenshots") return true;
  if (scenario.category === "navigation" && scenario.inputs?.useLivePanel !== false) {
    return true;
  }
  return false;
}

function filterScenariosForRunTarget(scenarios, target = "backend", options = {}) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const backendOnly = Boolean(options.backendOnly);
  if (target === "backend" || (backendOnly && target === "both")) {
    return list.filter((s) => s.category === "api");
  }
  if (target === "frontend") return list.filter(isPanelUiScenario);
  const api = list.filter((s) => s.category === "api");
  const ui = list.filter(isPanelUiScenario);
  const seen = new Set();
  const out = [];
  for (const s of [...api, ...ui]) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

module.exports = {
  panelE2eFlow,
  isPanelE2eScenario,
  isPanelUiScenario,
  filterScenariosForRunTarget,
};
