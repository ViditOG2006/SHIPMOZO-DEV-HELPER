/**
 * Example report templates from Shipmozo QA / product documentation practice.
 * Source: https://docs.google.com/document/d/1dSZGnrEbOfBjiSPBnxzGdG22-PnstyG3vFh268kRBk0/
 * Teams thread references (content not publicly fetchable):
 * - https://teams.live.com/l/message/19:uni01_vc2wfa2q7yuudeo4eq3xf2obg5scxifnl34gnupljryx6bi2h2xq@thread.v2/1780560214401
 * - https://teams.live.com/l/message/19:uni01_vc2wfa2q7yuudeo4eq3xf2obg5scxifnl34gnupljryx6bi2h2xq@thread.v2/1780560246954
 */

const SHIPMOZO_PLATFORM_CONTEXT = `
Platform: Shipmozo — logistics aggregator SaaS (similar to Shiprocket / Shipway).
Panels:
- User Panel (merchant): React/Next.js SPA at https://panel.appiify.com — order creation, APIs, channels
- Partner Panel (admin): PHP/Laravel SSR at https://appiify.com/partner/ — read-only validation + operations
Order flow: Order Creation → Validation → Pricing → New Orders → Courier Assignment → AWB → Tracking
Partner Panel is a reflection layer (not a creation layer). Modules represent lifecycle stages.
`.trim();

const EXAMPLE_PRD_STRUCTURE = `
## Example PRD / module document structure (5 sections — follow for Shipmozo-style modules)

1. **Module Overview & Business Purpose**
   - What this module represents (specific, not generic)
   - Where it sits in lifecycle; why it exists; what users achieve
   - DO NOT repeat system-wide explanations or upstream/downstream here

2. **UI Structure & User Actions**
   - Table, filters, actions, navigation only
   - DO NOT explain columns/fields (refer to common field doc)

3. **Workflow & Business Rules**
   - A. Order flow (how data enters, transitions)
   - B. Lifecycle state (exact state orders represent)
   - C. Business rules — ONLY non-obvious: constraints, conditional actions, special logic
   - DO NOT include obvious validations or test-case-like statements

4. **Dependencies & Module Linkages**
   - Upstream sources, downstream modules, system connections
   - ONLY section where cross-module connections are explained

5. **Data & Field Presence Mapping**
   - Table: Field | May Have Data | Must Be Blank | Present in Order Detail | Present in Table
   - Lifecycle-based conditions; state-specific blank fields (e.g. AWB blank in New Orders)
   - DO NOT explain field meanings

**Quality rules:** No duplication; no generic fluff; readable in 2–3 minutes; ask if UI/logic unclear.
**Post-pass:** Tighten and remove duplication after draft.
`.trim();

const EXAMPLE_TECH_GUIDE_STRUCTURE = `
## Example technical / operational guide structure (Module Guide style)

1. Module Purpose
2. Who Uses It
3. Full UI Overview
4. Buttons and Exact Function
5. Filters and Their Use Cases
6. Bulk Actions Triggered by Selection
7. All User Actions (numbered step-by-step per action)
8. Related Modules Needed
9. Common Workflows
10. Common Errors / Blockers
11. Tips for Efficient Usage
12. Verified vs Publicly Derived Info
13. Confidence Level

**Exploration standard:** Document every click path, multi-select actions, filters, tabs, modals, import/export, pagination, empty vs populated states.
**Cross-module:** Document dependencies (e.g. New Orders → Warehouses, Wallet, Courier Settings, Channel Integrations).
**Non-hallucination:** Mark "Verified in Live Panel" vs "Derived from Public Source" vs "Inaccessible".
**Success:** A new operations employee can run the module using this guide alone.
`.trim();

const EXAMPLE_QA_REPORT_CONTEXT = `
## Example QA execution & report standards (for implementation / testing sections)

- Autonomous test execution with mandatory live browser screenshot evidence per test case
- Screenshot: viewport only, browser chrome with URL, status bar "Shipmozo QA • Test Evidence" + timestamp
- Professional .docx report: cover, executive summary, per-TC sections (objective, steps, expected vs actual, badge, screenshot), bugs, recommendations
- Flag: missing data, UI mismatch, unexpected behavior, slow response, panel inconsistencies
- Known constraints: oklch() CSS breaks html2canvas (patch getPropertyValue); one download per tab (fresh tab per capture)
`.trim();

const EXAMPLE_RUNTIME_ISSUES_CONTEXT = `
## Example live / runtime issues repository standards (for ops & reliability sections)

Include only recurring, operationally relevant issues (courier/API/webhook/queue/infra/integration), NOT one-time fixed UI bugs.
Spreadsheet columns: Issue_ID, Module, Issue_Detail, Frequency, Last_Occurred, Error_Message, Tech_Dependent, Resolution_Brief
Tech_Dependent: YES (engineering fix) | NO (external/third-party) | PARTIAL (internal mitigation, external root cause)
Knowledge base articles per Issue_ID when still relevant; evidence-first; no invented RCA.
`.trim();

function getReportExamplesContext() {
  return [
    "### Reference: Shipmozo platform context",
    SHIPMOZO_PLATFORM_CONTEXT,
    "",
    "### Reference: Example PRD / module doc format",
    EXAMPLE_PRD_STRUCTURE,
    "",
    "### Reference: Example technical / operational guide format",
    EXAMPLE_TECH_GUIDE_STRUCTURE,
    "",
    "### Reference: Example QA report expectations",
    EXAMPLE_QA_REPORT_CONTEXT,
    "",
    "### Reference: Example runtime issues knowledge standards",
    EXAMPLE_RUNTIME_ISSUES_CONTEXT,
  ].join("\n");
}

function isShipmozoRelated(appName, description) {
  const text = `${appName} ${description}`.toLowerCase();
  return (
    text.includes("shipmozo") ||
    text.includes("appiify") ||
    text.includes("logistics") ||
    text.includes("shiprocket") ||
    text.includes("shipway") ||
    text.includes("courier") ||
    text.includes("awb")
  );
}

module.exports = {
  getReportExamplesContext,
  isShipmozoRelated,
  SHIPMOZO_PLATFORM_CONTEXT,
};
