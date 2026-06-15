const {
  sanitizeMermaidSource,
  sanitizeMermaidBlocksInMarkdown,
  unwrapDocumentCodeFence,
  isValidMermaidSource,
  looksLikeCodeNotMermaid,
  inferCodeLang,
} = require("../lib/mermaid-sanitize");

const SAMPLE = `erDiagram
    Channel ||--o{ ChannelOrder : imports
    Channel ||--o{ ChannelLog : logs
    Channel ||--|| ChannelConfig : has
    ChannelOrder ||--|| Order : creates
    User ||--o{ Channel : owns
    
    Channel {
        uuid id PK
        uuid user_id FK
        string channel_type
        enum status
        timestamp last_sync_at
        datetime created_at
    }
    
    ChannelConfig {
        uuid channel_id PK,FK
        json field_mappings
    }`;

const cleaned = sanitizeMermaidSource(SAMPLE);
const bad = [" PK", " FK", "PK,FK", "enum status", "uuid id", "json field", "datetime created_at"];
const good = ["string id", "string user_id", "string channel_type", "string status", "string channel_id"];

let ok = true;
for (const token of bad) {
  if (cleaned.includes(token)) {
    console.error("FAIL: still contains", token);
    ok = false;
  }
}
for (const token of good) {
  if (!cleaned.includes(token)) {
    console.error("FAIL: missing", token);
    ok = false;
  }
}

const md = "## 7. Data Model\n\n```mermaid\n" + SAMPLE + "\n```\n";
const mdOut = sanitizeMermaidBlocksInMarkdown(md);
if (!mdOut.includes("string channel_id")) {
  console.error("FAIL: markdown block not sanitized");
  ok = false;
}

const tsBlock = `## Types\n\n\`\`\`mermaid
interface CourierConfig {
  user_id: string;
  courier_id: string;
  enabled: boolean;
  api_key: string;
}
\`\`\`\n`;

const tsOut = sanitizeMermaidBlocksInMarkdown(tsBlock);
if (!tsOut.includes("```typescript")) {
  console.error("FAIL: TypeScript block not reclassified");
  ok = false;
}
if (tsOut.includes("```mermaid")) {
  console.error("FAIL: TypeScript still in mermaid fence");
  ok = false;
}
if (!looksLikeCodeNotMermaid("interface Foo { x: string; }")) {
  console.error("FAIL: should detect interface as code");
  ok = false;
}
if (!isValidMermaidSource("erDiagram\n  A ||--o{ B : x")) {
  console.error("FAIL: should accept erDiagram");
  ok = false;
}
if (inferCodeLang("interface X {}") !== "typescript") {
  console.error("FAIL: inferCodeLang for interface");
  ok = false;
}

const fenced = "```markdown\n# PRD Title\n\n## Section\n\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
const unfenced = unwrapDocumentCodeFence(fenced);
if (!unfenced.startsWith("# PRD Title")) {
  console.error("FAIL: unwrapDocumentCodeFence did not unwrap markdown fence");
  ok = false;
}
if (sanitizeMermaidBlocksInMarkdown(fenced).startsWith("```")) {
  console.error("FAIL: sanitizeMermaidBlocksInMarkdown left outer fence");
  ok = false;
}

const FLOWCHART = `graph TD
    A[User Opens Add Order UI] --> B[User Inputs Order Data]
    B --> C{Validate Fields Client-side}
    C -->|Fail| D[Show Validation Errors]
    C -->|Pass| E[Submit Order Request (API)]
    E --> F[Backend Validation]
    F -->|Fail| G[Return Error Response]
    F -->|Pass| H[Persist Order in DB]
    H --> I[Trigger Inventory Reservation]
    H --> J[Send Confirmation Notification]
    H --> K[Return Success Response]
    K --> L[Show Confirmation UI]
    L --> M{User wants to Add Another?}
    M -->|Yes| B
    M -->|No| N[Return to Orders List]`;

const flowClean = sanitizeMermaidSource(FLOWCHART);
if (!flowClean.includes('E["Submit Order Request (API)"]')) {
  console.error("FAIL: flowchart parentheses not quoted in node E");
  ok = false;
}
if (!flowClean.includes('M{"User wants to Add Another?"}')) {
  console.error("FAIL: flowchart question mark not quoted in node M");
  ok = false;
}
if (flowClean.includes("E[Submit Order Request (API)]")) {
  console.error("FAIL: unquoted parentheses still present");
  ok = false;
}

const FAILING_FLOWCHART = `flowchart LR
    subgraph External Sources
        ChannelAPIs("Channels: Amazon, Shopify, eBay")
        PaymentGateway(Payment Services)
    end
    subgraph NewOrdersModule
        Ingest(Service): Order Ingest Service
        Normalize(Service): Normalization & Validation
        ProcessQueue(Queue): Order Processing Queue
        UI(Client): User Interface
    end`;

const failingClean = sanitizeMermaidSource(FAILING_FLOWCHART);
const failingChecks = [
  ['subgraph External_Sources [External Sources]', 'subgraph title'],
  ['PaymentGateway("Payment Services")', 'unquoted paren label'],
  ['Ingest["Order Ingest Service"]', 'colon Service syntax'],
  ['Normalize["Normalization & Validation"]', 'colon Normalize syntax'],
  ['ProcessQueue["Order Processing Queue"]', 'colon Queue syntax'],
  ['UI["User Interface"]', 'colon UI syntax'],
];
for (const [token, label] of failingChecks) {
  if (!failingClean.includes(token)) {
    console.error("FAIL:", label, "- expected", token);
    console.error("Got:", failingClean);
    ok = false;
  }
}
if (failingClean.includes("(Service):") || failingClean.includes("(Queue):")) {
  console.error("FAIL: PlantUML-style colon nodes still present");
  ok = false;
}

if (ok) {
  console.log("OK mermaid sanitize");
  console.log(cleaned.split("\n").slice(7, 16).join("\n"));
} else {
  process.exit(1);
}
