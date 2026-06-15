# Shipmozo Dev Helper — Testing Workflow

Complete guide for **backend API testing** (Postman + Newman + Claude) and **frontend panel testing** (your Playwright scripts + heal on failure).

**App version:** `dev-helper-v28` (see `GET /api/health`)

---

## 1. Architecture at a glance

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                         YOU (requirements + scripts)                    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                               │
        ▼                                               ▼
┌───────────────────┐                         ┌───────────────────┐
│ BACKEND (API)     │                         │ FRONTEND (Panel)  │
├───────────────────┤                         ├───────────────────┤
│ Claude            │                         │ You import        │
│   orchestrator    │                         │ E2E scenarios +   │
│        ↓          │                         │ nav script JSON   │
│ Postman MCP       │                         │        ↓          │
│   create/update   │                         │ Python Playwright │
│   collection      │                         │   (one session)   │
│        ↓          │                         │        ↓          │
│ Dev Helper        │                         │ Playwright MCP    │
│   scenario JSON   │                         │   heal nav ONLY   │
│        ↓          │                         │   on UI failure   │
│ Run all →         │                         └───────────────────┘
│ Newman +          │
│ Postman API       │
└───────────────────┘
```

### Division of responsibility

| Layer | Technology | When AI runs |
|-------|------------|--------------|
| **API test design** | Claude + Postman MCP | When you click **Create API tests via Postman MCP** |
| **API test execution** | Newman (npm) + Postman REST API | Never — deterministic runner |
| **UI test design** | You (import scripts) | Never (script-first default) |
| **UI test execution** | Python Playwright | Never |
| **UI nav repair** | Playwright MCP (+ optional Claude fallback) | Only when navigation fails |

### What is Newman?

**Newman** is Postman’s headless collection runner. It executes the same HTTP requests and `pm.test()` JavaScript assertions as the Postman app, without a GUI. This project uses the **Newman npm library** — you do **not** need a separate “Newman MCP” server.

Official Postman **minimal MCP** can **create** collections but does **not** expose `runCollection`. Dev Helper fetches the collection via Postman’s REST API and runs it with Newman.

---

## 2. Prerequisites

### Install & start

```bash
npm install          # includes newman
npm start            # http://localhost:3000
```

### Required credentials

| Purpose | Variable |
|---------|----------|
| LLM (Claude) | `AI_PROVIDER=claude`, `ANTHROPIC_API_KEY` |
| Postman cloud | `POSTMAN_API_KEY` (PMAK-…) |
| Panel login | `SHIPMOZO_EMAIL`, `SHIPMOZO_PASSWORD` |
| API collection run | `POSTMAN_COLLECTION_ID` (+ optional `POSTMAN_ENVIRONMENT_ID`) |

### Recommended `.env` (hybrid workflow)

```env
# LLM — Claude recommended
AI_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-api03-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# AI scopes (minimal)
AI_SCOPE=script_debug,testcase_gen

# Frontend — you provide scripts
TESTCASE_BACKEND=scripts
SCRIPT_DEBUG_BACKEND=mcp
PLAYWRIGHT_MCP_AUTO_START=true

# Backend — Newman runs your Postman collection
API_RUN_BACKEND=postman-mcp
POSTMAN_API_KEY=PMAK-...
POSTMAN_WORKSPACE_ID=5f7b15b8-35ea-4187-81dc-ef746df6d02a
POSTMAN_COLLECTION_ID=<your-collection-uid>
POSTMAN_ENVIRONMENT_ID=<optional>

# Panel
SHIPMOZO_EMAIL=...
SHIPMOZO_PASSWORD=...
SHIPMOZO_PANEL_URL=https://panel.appiify.com
HEADLESS=false
```

Verify: open **API Settings** → test connection, or `GET /api/health`.

---

## 3. Configuration reference

### `TESTCASE_BACKEND` — how test *cases* are created

| Value | Meaning |
|-------|---------|
| **`scripts`** (default) | No AI. Import scenario JSON yourself. |
| `postman` | Read existing Postman collection → API scenarios (no create). |
| `postman-mcp` | Claude commands Postman MCP to **create** collection + tests. |
| `docs` | One Claude pass from PRD + manual. |
| `docs-mcp` | Claude + Playwright MCP + compile (most AI). |

### `API_RUN_BACKEND` — how API scenarios *run*

| Value | Meaning |
|-------|---------|
| `local` | HTTP to Dev Helper’s own `/api/*` routes only. |
| **`postman-mcp`** | Fetch collection from Postman API → **Newman** runs all requests + `pm.test`. |
| `http` | Direct `fetch` to `SHIPMOZO_API_BASE_URL` + `inputs.apiEndpoint`. |

### `SCRIPT_DEBUG_BACKEND` — UI nav when E2E fails

| Value | Meaning |
|-------|---------|
| **`mcp`** | Playwright MCP probes live panel, returns repaired `navSteps`. |
| `llm` | Claude writes nav script from page observation (no browser MCP). |

### `AI_SCOPE` — what Claude is allowed to do

| Scope | Enables |
|-------|---------|
| `script_debug` | E2E nav self-heal |
| `testcase_gen` | Postman MCP agent, doc-based test gen |
| `report_gen` | PRD / user manual generation |
| `chat` | AI Chat tab (off by default) |

---

## 4. Workflows

### Workflow A — Existing Postman collection (recommended for backend)

**Best when:** you already have requests + `pm.test` scripts in Postman.

1. Copy collection **UID** from Postman (Info → UID).
2. Set in `.env`:
   ```env
   POSTMAN_COLLECTION_ID=<uid>
   POSTMAN_ENVIRONMENT_ID=<uid>   # if you use {{baseUrl}}, tokens, etc.
   API_RUN_BACKEND=postman-mcp
   ```
3. **Option 1 — Import scenarios from collection**
   - Set `TESTCASE_BACKEND=postman` temporarily, or call `POST /api/testing/generate` with a requirement string.
   - Or paste a minimal dataset (see §6).
4. **Frontend:** Testing → **Script-first workflow** → import E2E scenarios + nav script.
5. **Run all** → Newman validates APIs; Python runs UI tests in one browser session.

---

### Workflow B — AI creates Postman collection (backend)

**Best when:** no collection yet; you describe APIs in plain English.

1. Ensure `POSTMAN_API_KEY`, Claude key, `testcase_gen` in `AI_SCOPE`.
2. Testing → **Backend API tests (Postman MCP)**.
3. Paste requirement, e.g.:
   ```text
   Shipmozo Orders API
   - POST /orders — create domestic order (201, body has order id)
   - GET /orders/{id} — fetch order
   - POST /orders — missing pincode → 400
   Base URL variable: {{baseUrl}} in environment
   Workspace: Vidit Gupta's Workspace
   ```
4. Click **Create API tests via Postman MCP**.
5. Claude orchestrates Postman MCP (`createCollection`, `createCollectionRequest`, `getCollection`, …).
6. Copy `dataset.postman.collectionId` → set `POSTMAN_COLLECTION_ID` in `.env`.
7. Create/link Postman **environment** with `baseUrl`, auth if needed → `POSTMAN_ENVIRONMENT_ID`.
8. Import frontend scripts (Workflow C).
9. **Run all**.

**API:** `POST /api/testing/postman-agent/generate`

```json
{
  "requirement": "Describe your APIs here…",
  "options": { "minScenarios": 6 },
  "save": true
}
```

---

### Workflow C — Frontend only (script-first)

**Best when:** you write all panel E2E scripts; AI only fixes UI breaks.

1. `TESTCASE_BACKEND=scripts`, `AI_SCOPE=script_debug`.
2. Testing → **Script-first workflow**.
3. **Import scenario dataset JSON** (§6.1).
4. **Import nav script JSON** → saved to `output/runtime/e2e-ai-script.json`.
5. Open dataset → **Run all**.

**Execution order:**

```text
Replay cached nav script (no AI)
    → Python runs each e2e scenario (one login)
    → If RC/nav fails → Playwright MCP self-heal (max 3 attempts)
    → Cache updated script → retry
```

**APIs:**

- `POST /api/testing/datasets/import` — scenario dataset
- `POST /api/testing/scripts/nav` — nav script
- `GET /api/testing/scripts/nav` — read current nav script

---

### Workflow D — Mixed dataset (API + UI in one run)

Use one dataset with both `category: "api"` and `category: "e2e"` scenarios.

**Run all** behavior:

| Scenario type | Runner |
|---------------|--------|
| `api` + `API_RUN_BACKEND=postman-mcp` | Newman (once per run, cached) |
| `e2e` + `inputs.e2eFlow` | Python batch (`run_panel_e2e_session.py`) |
| `chat`, `module_docs`, etc. | Per-step HTTP to Dev Helper APIs |

---

## 5. When Claude is invoked

| Action | Claude? |
|--------|---------|
| Import scripts / nav JSON | No |
| Run all — happy path | No |
| Run all — API via Newman | No |
| Run all — UI via Python | No |
| Nav fails during E2E | Yes (via Playwright MCP path, or Claude if `SCRIPT_DEBUG_BACKEND=llm`) |
| Create API tests via Postman MCP | Yes (orchestrator + compiler) |
| Generate from PRD/manual | Yes (if enabled) |
| AI Chat tab | Yes (if `chat` in `AI_SCOPE`) |

---

## 6. Data formats

### 6.1 Scenario dataset JSON

```json
{
  "title": "Orders — API + UI",
  "scenarios": [
    {
      "id": "API-001",
      "title": "Create order API",
      "category": "api",
      "type": "happy_path",
      "priority": "high",
      "inputs": {
        "apiMethod": "POST",
        "apiEndpoint": "/orders",
        "postmanCollectionId": "optional-override",
        "postmanRequestName": "Create order"
      },
      "expectedResults": { "httpStatus": 201 }
    },
    {
      "id": "UI-001",
      "title": "Verify order in New Orders",
      "category": "e2e",
      "type": "happy_path",
      "priority": "critical",
      "inputs": {
        "e2eFlow": "order_verify_new_orders",
        "useLivePanel": true
      },
      "expectedResults": {
        "uiMustContain": ["order"]
      }
    }
  ]
}
```

**Supported `e2eFlow` values** (panel Python runner):

- `rate_calculator_open`, `rate_calculator_domestic_happy`, `rate_calculator_international_toggle`, `rate_calculator_invalid_pincode`, `rate_calculator_missing_weight`, `rate_calculator_heavy_parcel`, `rate_calculator_dimensions`
- `order_create_domestic`, `order_verify_new_orders`

Sample RC dataset: `POST /api/testing/seed/rate-calculator`

### 6.2 Nav script JSON

Saved to `output/runtime/e2e-ai-script.json`.

```json
{
  "version": 1,
  "module": "Rate Calculator",
  "rationale": "Quick Search navigation",
  "navSteps": [
    { "op": "dismiss_overlays" },
    { "op": "hotkey", "keys": "Control+b" },
    { "op": "wait", "ms": 100 },
    { "op": "fill_placeholder", "placeholder": "Quick Search", "text": "rate calculator" },
    { "op": "click_text", "text": "Rate Calculator", "contains": "Tools" },
    { "op": "wait_for_text", "text": "pincode", "timeout_ms": 2500 }
  ],
  "verifyTexts": ["origin pincode", "calculate"],
  "scenarioPlans": []
}
```

**Allowed `op` values:** `dismiss_overlays`, `hotkey`, `wait`, `fill_placeholder`, `fill_label`, `click_text`, `press_key`, `wait_for_text`, `click_role`.

**Rule:** Never use `/courier/manage-courier` — use **Ctrl+B → Quick Search**.

---

## 7. Postman collection requirements (for Newman)

For `API_RUN_BACKEND=postman-mcp` to pass:

1. **Collection UID** in `POSTMAN_COLLECTION_ID` (or per-scenario `inputs.postmanCollectionId`).
2. **Test scripts** on requests (`pm.test("...", function () { ... })`).
3. **Environment** (recommended) with variables such as:
   - `baseUrl` — API host
   - `authToken` / API keys
4. Request **names** should match scenario `title` or `inputs.postmanRequestName` for per-scenario pass/fail mapping.

Newman run flow inside Dev Helper:

```text
GET https://api.getpostman.com/collections/{id}
GET https://api.getpostman.com/environments/{id}   (optional)
    ↓
newman.run({ collection, environment })
    ↓
Map results → scenario pass/fail
```

---

## 8. HTTP API reference (testing)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Version, AI scope, backends |
| GET | `/api/testing/meta` | E2E flows, backends, script-first flag |
| POST | `/api/testing/datasets/import` | Import scenario JSON |
| GET/POST | `/api/testing/scripts/nav` | Read/write nav script |
| POST | `/api/testing/postman-agent/generate` | Claude + Postman MCP create tests |
| POST | `/api/testing/e2e-batch/start` | UI E2E batch (poll status) |
| POST | `/api/testing/run-step/start` | Single non-E2E scenario |
| GET | `/api/testing/runs/:runId` | Run results |

---

## 9. MCP servers used

| MCP | URL | Role |
|-----|-----|------|
| **Postman MCP** | `https://mcp.postman.com/minimal` | Create/read collections (agent) |
| **Playwright MCP** | `http://127.0.0.1:8931/mcp` | UI snapshot + nav heal |

Postman MCP tools used by agent: `getWorkspaces`, `getCollections`, `getCollection`, `createCollection`, `createCollectionRequest`, `updateCollectionRequest`, `createEnvironment`, `getEnvironments`.

**Not used:** `runCollection` (unavailable on minimal MCP — replaced by Newman).

---

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| API scenarios all fail | Set `POSTMAN_COLLECTION_ID`; ensure collection has `pm.test` scripts |
| Newman can’t resolve URL | Add Postman environment with `baseUrl`; set `POSTMAN_ENVIRONMENT_ID` |
| E2E nav fails repeatedly | Check `output/runtime/e2e-ai-script.json`; run standalone heal: `POST /api/testing/e2e-heal/start` |
| “testcase_gen disabled” | Add `testcase_gen` to `AI_SCOPE` |
| Still uses CLōD instead of Claude | Set `AI_PROVIDER=claude` explicitly |
| Playwright MCP not reachable | `PLAYWRIGHT_MCP_AUTO_START=true` or run `npx @playwright/mcp@latest --port 8931` |
| Postman agent creates empty collection | Give concrete endpoints, methods, expected status codes in requirement |

---

## 11. Quick start checklist

- [ ] `npm install` && `npm start`
- [ ] Claude API key + `AI_PROVIDER=claude`
- [ ] Postman API key + workspace ID
- [ ] **Existing collection** → `POSTMAN_COLLECTION_ID` **OR** create via Postman MCP agent
- [ ] `API_RUN_BACKEND=postman-mcp`
- [ ] Import **frontend** E2E scenarios + nav script
- [ ] `SHIPMOZO_EMAIL` / `SHIPMOZO_PASSWORD`
- [ ] Testing → **Run all**
- [ ] Review results tab; fix nav script or Postman tests as needed

---

## 12. Optional paths (not default)

| Path | Use when |
|------|----------|
| `TESTCASE_BACKEND=docs-mcp` | Generate UI test cases from PRD + Playwright MCP |
| `REPORT_BACKEND=mcp` | Generate PRD/manual with Postman + Playwright evidence |
| `API_RUN_BACKEND=http` | Simple direct API calls without Postman |
| `TESTCASE_BACKEND=postman` | Import scenarios from existing collection only |

For your stated goal (**minimal AI**, **your scripts for UI**, **Postman for backend**), stick to **Workflow A + C** with the recommended `.env` in §2.

---

## 13. What you must provide (checklist)

Use **Testing → Hybrid workflow** setup checklist (`GET /api/testing/setup`) or verify manually:

### Required secrets & config

| Item | Env variable | Where to get it |
|------|----------------|-----------------|
| **Claude API key** | `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/) |
| **Force Claude** | `AI_PROVIDER=claude` | `.env` |
| **Postman API key** | `POSTMAN_API_KEY` | Postman → Settings → API keys (PMAK-…) |
| **Panel login** | `SHIPMOZO_EMAIL`, `SHIPMOZO_PASSWORD` | Your Shipmozo merchant account |
| **API run mode** | `API_RUN_BACKEND=postman-mcp` | `.env` |

### Strongly recommended

| Item | Env variable | Notes |
|------|----------------|-------|
| **Postman collection UID** | `POSTMAN_COLLECTION_ID` | Postman → Collection → Info → UID |
| **Postman workspace** | `POSTMAN_WORKSPACE_ID` | For AI collection create |
| **Postman environment** | `POSTMAN_ENVIRONMENT_ID` | If requests use `{{baseUrl}}`, tokens |
| **AI scopes** | `AI_SCOPE=script_debug,testcase_gen` | Heal + Postman agent |

### You provide as data (not keys)

| Item | How |
|------|-----|
| **UI E2E scenarios** | Paste JSON in Testing tab or import file |
| **Nav script** | Paste JSON → `output/runtime/e2e-ai-script.json` |
| **API collection** | Existing in Postman **or** describe APIs for AI agent |
| **API test scripts** | `pm.test()` in Postman requests (for Newman) |

### Optional

| Item | When |
|------|------|
| `SHIPMOZO_API_BASE_URL` | Only if `API_RUN_BACKEND=http` |
| `CLOUDINARY_*` | Screenshot storage for docs |
| `GITHUB_REPO_URL` | Stale code context for heal prompts |

### One-click in UI

**Testing** → **Hybrid workflow (API + UI)** → fill collection ID + E2E JSON + nav script → **Run full hybrid workflow**

**API:** `POST /api/testing/hybrid-pipeline/start`

```json
{
  "postmanMode": "import",
  "collectionId": "your-collection-uid",
  "e2eDataset": { "scenarios": [ ... ] },
  "navScript": { "version": 1, "navSteps": [ ... ] },
  "runTests": true
}
```
