/**
 * Shipmozo QA — Google Sheet test case template (TC generation from PRD / module docs).
 */

const SHEET_COLUMNS = [
  "Submodule",
  "Module",
  "TC_ID",
  "Test_Level",
  "Description",
  "Pre-requisite",
  "Steps",
  "Expected",
  "Priority",
  "Testing Type",
  "Tags",
  "Platform",
];

const TEST_LEVELS = ["Component", "Integration", "End-to-End"];
const TESTING_TYPES = ["Standard Functional", "Adhoc", "Non-functional"];
const PRIORITIES = ["P0", "P1", "P2"];
const PLATFORMS = ["Partner Panel", "User Panel", "API", "Cross-Panel", "Seller Panel"];
const APPROVED_TAGS = [
  "Smoke",
  "Standard",
  "Regression",
  "Negative",
  "Exploratory",
  "Adhoc",
  "UI only",
  "API only",
  "UI+API",
];

/** Normalized benchmark rows (Shopify channel PRD quality bar) for prompt injection. */
const EXAMPLE_SHEET_ROWS = [
  {
    Submodule: "Channel Configuration UI",
    Module: "Shopify",
    TC_ID: "TC-SHP-CMP-01",
    Test_Level: "Component",
    Description:
      "Req: SHOP-UI-01, SHOP-SET-01 — Validate Shopify channel edit page: status filter, configuration toggles, pushback status mapping table, branding fields, save/cancel, and field-level validation.",
    "Pre-requisite":
      "Seller Panel login; Shopify channel connected with valid test-store credentials; at least one synced order exists.",
    Steps:
      "1. Navigate to Channels > Shopify > Edit channel. 2. Verify page header, connection status badge, and all PRD-listed form sections render. 3. Change status filter dropdown and confirm order-list preview updates. 4. Toggle auto-update, fulfillment pushback, and external-fulfillment scope on/off. 5. Edit pushback status mapping rows (channel status → Shipmozo status). 6. Update branding fields (store display name, logo URL). 7. Save with valid data, re-open, and confirm persistence. 8. Attempt save with invalid credential/token field and verify inline validation.",
    Expected:
      "Edit page loads all sections without layout break; toggles and mappings persist after save and reload; status filter reflects correct subset; validation blocks invalid credentials with clear message; no duplicate mapping rows on re-save; branding updates visible on channel summary card.",
    Priority: "P0",
    "Testing Type": "Standard Functional",
    Tags: "Smoke, Standard, UI only",
    Platform: "Seller Panel",
  },
  {
    Submodule: "Order Sync & Pushback",
    Module: "Shopify",
    TC_ID: "TC-SHP-INT-01",
    Test_Level: "Integration",
    Description:
      "Req: SHOP-ORD-02, SHOP-PB-01, SHOP-GATE-01 — Channel order reflection in New Orders, channel-status master gate, fulfillment pushback to Shopify, and duplicate-order prevention after config change.",
    "Pre-requisite":
      "Shopify channel active; test orders in multiple Shopify statuses (unfulfilled, fulfilled, cancelled); pushback mapping configured; User Panel access for order verification.",
    Steps:
      "1. Place or sync a new Shopify order and verify it appears in Seller channel order list and User Panel New Orders with correct channel tag. 2. Change order status in Shopify and trigger/trigger-wait auto-update; confirm Shipmozo status follows channel-status master gate rules. 3. Assign AWB / mark fulfilled in Shipmozo and verify fulfillment pushback updates Shopify fulfillment state per mapping. 4. Toggle external-fulfillment scope off and confirm externally fulfilled orders are excluded from sync. 5. Rapidly change pushback mapping and auto-update toggle twice; confirm no duplicate orders or conflicting statuses. 6. Search/filter/export affected orders and confirm data consistency.",
    Expected:
      "Orders reflect across channel list and New Orders without duplication; status transitions respect master gate and mapping; fulfillment pushback matches configured scope; excluded external fulfillments do not create Shipmozo orders; rapid config changes do not spawn duplicates or orphan records; search/filter/export remain accurate.",
    Priority: "P0",
    "Testing Type": "Standard Functional",
    Tags: "Regression, UI+API",
    Platform: "Cross-Panel",
  },
];

const QA_SHEET_ARCHITECT_PROMPT = `You are acting as a Senior QA Architect + Product Analyst.
Building a QA system for a logistics SaaS platform (Shipmozo), similar to Shiprocket / Shipway.

🧠 SYSTEM CONTEXT

Panels:
- User Panel → order creation (write layer)
- Partner Panel → order visibility and validation (read-only layer)
- Seller Panel → channel/integration configuration

Order Flow:
Order Creation → Validation → New Orders → Pricing → Courier Assignment → AWB → Tracking

Important:
- Partner Panel is a reflection layer (no business logic execution)
- Modules represent lifecycle stages
- System recently removed partner_id → high regression risk
- User Panel navigation: from dashboard press **Ctrl+B** → Quick Search Pages → type module name (e.g. Rate Calculator) → select result (e.g. Tools → Rate Calculator). Prefer this over legacy sidebar paths in TC Steps.
- Public GitHub panel code may be OUT OF DATE vs production — do not copy stale sidebar routes from repo; use live UI behavior and PRD.

🎯 OBJECTIVE

Generate high-quality, compact, flow-based test cases in Google Sheet row format — matching the depth of production-grade channel/integration PRD test suites.
Test cases must be:
- Flow-based (1 TC = multiple validations, typically 6-10 per TC)
- Minimal row count but high coverage per row
- Regression-focused (duplicates, credentials, historical data, UI/backend mismatch)
- System-aware (not just UI)
- Directly executable by tester or AI

📋 REQUIREMENT ID REFERENCES (MANDATORY WHEN PRD HAS THEM)

When the PRD or module docs define requirement IDs (e.g. SHOP-UI-01, SHOP-SET-01, ORD-FLT-02), prefix the Description column:
  "Req: SHOP-UI-01, SHOP-SET-01 — <flow objective and validations>"
If no formal IDs exist, write a clear one-line objective without inventing IDs.

📤 OUTPUT FORMAT (STRICT — NO DEVIATION)

Generate test cases ONLY with these exact fields per row (JSON keys match column names):
Submodule | Module | TC_ID | Test_Level | Description | Pre-requisite | Steps | Expected | Priority | Testing Type | Tags | Platform

Do NOT change field names.
Do NOT add extra fields per row.
Do NOT output section headers like "Functional / Integration / Exploratory" or legacy labels (VIS/ADV).
Everything must be sheet-ready rows in sheetRows array.

🔢 DROPDOWN VALUES (STRICT — USE ONLY THESE)

Test_Level: Component | Integration | End-to-End
Testing Type: Standard Functional | Adhoc | Non-functional
Priority: P0 (critical) | P1 (high) | P2 (low)
Tags (comma-separated from): Smoke, Standard, Regression, Negative, Exploratory, Adhoc, UI only, API only, UI+API
Platform: Partner Panel | User Panel | API | Cross-Panel | Seller Panel

🧠 TEST GENERATION SEQUENCE (MANDATORY)

Order sheetRows array:
1. All Component level first (visible functional / UI-configuration flows)
2. Then Integration (cross-panel reflection, sync, pushback, gates)
3. Then End-to-End (full lifecycle regression)
Do NOT mix order.

🧪 TEST LEVEL DEFINITIONS

Component: edit-page UI, tables, search/filter, toggles, mapping grids, branding, pagination, navigation/routing, credential form validation
Integration: order reflection, channel-status master gate, auto-update, fulfillment pushback, external-fulfillment scope, cross-module data, cross-panel consistency
End-to-End: full channel lifecycle — connect → configure → sync → fulfill → pushback → historical safety

🧪 TESTING TYPE RULES

Standard Functional: happy path, negative/boundary, validation, core business logic
Adhoc: exploratory, concurrency, rapid config changes, UI/backend mismatch, credential rotation, stress, duplicates, cache/stale data, deep links
Non-functional: performance, security, compatibility, reliability

Legacy tier mapping (for your internal planning only — use sheet dropdowns above in output):
- "Visible Functional" → Test_Level: Component, Testing Type: Standard Functional
- "Integration" → Test_Level: Integration, Testing Type: Standard Functional (or Adhoc if exploratory)
- "Adhoc / Advanced" → Testing Type: Adhoc, or Test_Level: End-to-End when full regression lifecycle

Do NOT use Tags to represent Testing Type.

🧠 TEST DESIGN RULES (VERY IMPORTANT)

DO NOT create small fragmented test cases.
WRONG: separate TCs for "open edit page", "toggle auto-update", "check filter"
CORRECT: one TC covering edit-page UI + toggles + mapping + branding + save validation (6-10 checks)

EACH TEST CASE MUST:
- State a clear objective in Description (with Req IDs when available)
- Cover multiple validations (6-10 ideally) in one flow
- Use numbered Steps (8-12 steps typical for channel/integration modules)
- Use consolidated Expected (single paragraph; NOT step-wise bullet mirroring)

STEPS: directly readable actions a tester can follow; no abstraction; no references to other TC IDs
EXPECTED: consolidated outcomes covering visibility, state transitions, data consistency, search/filter, export, no duplication, credential handling, historical data safety

CHANNEL / INTEGRATION MODULES — COVER WHEN APPLICABLE (spread across levels, do not duplicate):
- Edit-page UI, status filter, configuration toggles, pushback status mapping, branding
- Order reflection (channel → New Orders / All Orders)
- Channel-status master gate and auto-update behavior
- Fulfillment pushback and external-fulfillment scope
- Duplicate prevention on config change or re-sync
- Credential handling (valid, invalid, expired token)
- UI vs backend mismatch after rapid config changes
- E2E regression across connect → sync → fulfill
- Historical order safety (pre-change orders unaffected)

ALWAYS COVER (all modules): lifecycle transitions, data consistency, search/filter, export, cross-module movement, cross-panel consistency, partner_id removal regression

MANDATORY REGRESSION: At least 1 Integration or End-to-End TC must validate no partner_id dependency, order visibility, search/filter/export unaffected, historical/pre-existing data works after config changes

AVOID: duplicate coverage across TCs, vague statements ("works as expected"), shallow UI-only when system behavior matters

📊 TC COUNT (STRICT)

Component: 5-7 | Integration: 3-5 | End-to-End: 1-2 | Total: 10-14 max per module
Include at least 1 Adhoc (Testing Type) TC and at least 1 Regression-tagged TC in the set.

🆔 TC_ID FORMAT

TC-<MODULE-SHORT>-<LEVEL>-<NUMBER>
Level codes: CMP | INT | E2E  (NOT VIS/ADV — those are legacy labels only)
Examples: TC-SHP-CMP-01, TC-ORD-INT-02, TC-PRICE-E2E-01

📌 QUALITY BENCHMARK (Shopify channel PRD — match this depth; adapt to target module)

| Tier (planning) | Sheet mapping | Example focus |
| Component / VIS | Test_Level: Component | Edit UI, filters, toggles, mapping table, branding, credential validation |
| Integration / INT | Test_Level: Integration | Order reflection, status gate, pushback, duplicate prevention |
| Adhoc / ADV | Testing Type: Adhoc or E2E | Rapid config changes, credential rotation, UI/backend mismatch, historical order safety |

Condensed pattern (Component):
  Description: "Req: SHOP-UI-01 — Validate channel edit page UI and configuration persistence."
  Steps: 8+ numbered actions across navigation, toggles, mapping, save, negative credential check.
  Expected: one paragraph — persistence, validation messages, no duplicate rows, UI consistency.

Condensed pattern (Integration):
  Description: "Req: SHOP-ORD-02 — Order sync, master gate, fulfillment pushback, no duplicates."
  Steps: sync order → status change → pushback → config churn → verify cross-panel.
  Expected: reflection accuracy, gate rules, pushback scope, duplicate-free, filter/export intact.

Condensed pattern (Adhoc / E2E):
  Description: "Req: SHOP-REG-01 — Rapid mapping changes and credential re-auth do not corrupt historical orders."
  Testing Type: Adhoc (or End-to-End if full lifecycle)
  Tags: Regression, Exploratory
  Steps: alter mapping twice quickly, rotate token, re-sync; verify old orders unchanged.
  Expected: historical orders stable; new syncs follow new rules; no duplicate AWB/status conflicts.

🧠 THINKING

Think: "What can break in production at scale?"
Focus: finance correctness, state integrity, cross-panel consistency, concurrency, idempotency, duplicate prevention, credential failures, failure at scale.

Do not assume. Do not invent module behavior not stated in the documentation.`;

const MODULE_SHORT_CODES = {
  "rate calculator": "RC",
  "new orders": "ORD",
  "all orders": "ORD",
  "quick add": "QADD",
  billing: "BILL",
  wallet: "WAL",
  shopify: "SHP",
  "courier assigned": "CA",
  ndr: "NDR",
  rto: "RTO",
  pricing: "PRICE",
  channels: "CH",
  integrations: "INTG",
};

function deriveModuleShortCode(moduleName) {
  const key = String(moduleName || "")
    .trim()
    .toLowerCase();
  if (MODULE_SHORT_CODES[key]) return MODULE_SHORT_CODES[key];
  const words = key.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length >= 2) return words.map((w) => w[0]).join("").toUpperCase().slice(0, 8);
  return (words[0] || "MOD").slice(0, 6).toUpperCase();
}

function coerceCell(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(String).join("; ");
  return String(value).trim();
}

function normalizeTags(tags) {
  const raw = coerceCell(tags);
  if (!raw) return "Standard";
  const parts = raw.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
  const valid = parts.filter((t) => APPROVED_TAGS.includes(t));
  return valid.length ? valid.join(", ") : "Standard";
}

function pickEnum(value, allowed, fallback) {
  const v = coerceCell(value);
  return allowed.includes(v) ? v : fallback;
}

function normalizeSheetRow(row, { moduleName = "", moduleShortCode = "", index = 0 } = {}) {
  const level = pickEnum(row.Test_Level, TEST_LEVELS, "Component");
  const levelCode = level === "Integration" ? "INT" : level === "End-to-End" ? "E2E" : "CMP";
  const out = {
    Submodule: coerceCell(row.Submodule) || coerceCell(row.submodule),
    Module: coerceCell(row.Module) || moduleName,
    TC_ID: coerceCell(row.TC_ID) || coerceCell(row.TC_ID),
    Test_Level: level,
    Description: coerceCell(row.Description),
    "Pre-requisite": coerceCell(row["Pre-requisite"] || row.Pre_requisite || row.prerequisite),
    Steps: coerceCell(row.Steps),
    Expected: coerceCell(row.Expected),
    Priority: pickEnum(row.Priority, PRIORITIES, "P1"),
    "Testing Type": pickEnum(row["Testing Type"] || row.Testing_Type, TESTING_TYPES, "Standard Functional"),
    Tags: normalizeTags(row.Tags),
    Platform: pickEnum(row.Platform, PLATFORMS, "User Panel"),
  };

  if ((!out.TC_ID || out.TC_ID.includes("??")) && moduleShortCode) {
    out.TC_ID = `TC-${moduleShortCode}-${levelCode}-${String(index + 1).padStart(2, "0")}`;
  }
  return out;
}

function sortSheetRows(rows) {
  const levelOrder = { Component: 0, Integration: 1, "End-to-End": 2 };
  return [...rows].sort(
    (a, b) => (levelOrder[a.Test_Level] ?? 9) - (levelOrder[b.Test_Level] ?? 9)
  );
}

function buildSheetCoverageMatrix(rows) {
  const byTestLevel = {};
  const byPriority = {};
  const byPlatform = {};
  const byTestingType = {};
  for (const r of rows) {
    byTestLevel[r.Test_Level] = (byTestLevel[r.Test_Level] || 0) + 1;
    byPriority[r.Priority] = (byPriority[r.Priority] || 0) + 1;
    byPlatform[r.Platform] = (byPlatform[r.Platform] || 0) + 1;
    byTestingType[r["Testing Type"]] = (byTestingType[r["Testing Type"]] || 0) + 1;
  }
  return { byTestLevel, byPriority, byPlatform, byTestingType };
}

function escapeTsvCell(text) {
  return String(text || "")
    .replace(/\t/g, " ")
    .replace(/\r?\n/g, " ")
    .trim();
}

function sheetRowsToTsv(rows) {
  const lines = [SHEET_COLUMNS.join("\t")];
  for (const row of rows) {
    lines.push(SHEET_COLUMNS.map((col) => escapeTsvCell(row[col])).join("\t"));
  }
  return lines.join("\n");
}

function sheetRowsToCsv(rows) {
  const quote = (text) => `"${String(text || "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  const lines = [SHEET_COLUMNS.map(quote).join(",")];
  for (const row of rows) {
    lines.push(SHEET_COLUMNS.map((col) => quote(row[col])).join(","));
  }
  return lines.join("\n");
}

function formatExampleSheetRowsForPrompt(rows = EXAMPLE_SHEET_ROWS) {
  return rows
    .map((row, i) => {
      const lines = SHEET_COLUMNS.map((col) => `  ${col}: ${row[col] || ""}`);
      return `Example ${i + 1}:\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function buildSheetJsonSchemaInstruction({ moduleName, moduleShortCode, includeExamples = true }) {
  const exampleBlock = includeExamples
    ? `

REFERENCE EXAMPLES (match this depth and structure; adapt Submodule/Module/Req IDs to "${moduleName}" — do NOT copy Shopify-specific behavior unless docs describe it):

${formatExampleSheetRowsForPrompt()}`
    : "";

  return `Return a single JSON object (no markdown fences):

{
  "title": "Test cases — ${moduleName}",
  "summary": "1-2 sentence coverage summary",
  "moduleShortCode": "${moduleShortCode}",
  "sheetRows": [
    {
      "Submodule": "optional sub-area",
      "Module": "${moduleName}",
      "TC_ID": "TC-${moduleShortCode}-CMP-01",
      "Test_Level": "Component",
      "Description": "Req: <ID-FROM-PRD> — flow-based objective with multiple validations",
      "Pre-requisite": "login, data setup",
      "Steps": "1. Step one. 2. Step two. ... (8-12 numbered steps for channel/integration modules)",
      "Expected": "consolidated expected outcomes in one paragraph (not step-wise)",
      "Priority": "P0",
      "Testing Type": "Standard Functional",
      "Tags": "Smoke, Regression",
      "Platform": "User Panel"
    }
  ],
  "scenarios": [],
  "markdownSummary": "brief markdown: levels covered, requirement IDs referenced, regression/duplicate/credential/historical-data notes, partner_id checks"
}

sheetRows is REQUIRED (10-14 rows). scenarios may be empty array (sheet format is primary).
Generate rows in order: Component (5-7), Integration (3-5), End-to-End (1-2).
Include at least 1 Adhoc Testing Type row and 1 Regression-tagged row.${exampleBlock}`;
}

module.exports = {
  SHEET_COLUMNS,
  TEST_LEVELS,
  TESTING_TYPES,
  PRIORITIES,
  PLATFORMS,
  APPROVED_TAGS,
  EXAMPLE_SHEET_ROWS,
  QA_SHEET_ARCHITECT_PROMPT,
  deriveModuleShortCode,
  normalizeSheetRow,
  buildSheetCoverageMatrix,
  sheetRowsToTsv,
  sheetRowsToCsv,
  formatExampleSheetRowsForPrompt,
  buildSheetJsonSchemaInstruction,
  sortSheetRows,
};
