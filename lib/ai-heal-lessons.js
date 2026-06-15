const fs = require("fs");
const path = require("path");

const LESSONS_PATH = path.join(__dirname, "..", "data", "ai-heal-lessons.json");
const RUNTIME_LESSONS_PATH = path.join(__dirname, "..", "output", "runtime", "ai-heal-lessons-runtime.json");

function defaultStore() {
  return { version: 1, lessons: [] };
}

function loadHealLessons() {
  const merged = [];
  const seen = new Set();

  for (const filePath of [LESSONS_PATH, RUNTIME_LESSONS_PATH]) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      for (const lesson of data.lessons || []) {
        const id = lesson.id || `${lesson.issue || ""}`.slice(0, 80);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push({ ...lesson, id });
      }
    } catch {
      /* ignore corrupt file */
    }
  }
  return merged;
}

function saveRuntimeLessons(lessons) {
  const dir = path.dirname(RUNTIME_LESSONS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    RUNTIME_LESSONS_PATH,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        lessons,
      },
      null,
      2
    ),
    "utf-8"
  );
}

function loadRuntimeLessonsOnly() {
  if (!fs.existsSync(RUNTIME_LESSONS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_LESSONS_PATH, "utf-8")).lessons || [];
  } catch {
    return [];
  }
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function lessonSortRank(lesson) {
  const tags = lesson.tags || [];
  const tagCritical = tags.includes("critical") ? 0 : 1;
  const sev = SEVERITY_RANK[String(lesson.severity || "").toLowerCase()] ?? 2;
  return tagCritical * 10 + sev;
}

function formatLessonsForPrompt({ maxLessons = 40, tags = [], module = "" } = {}) {
  let lessons = loadHealLessons().sort((a, b) => lessonSortRank(a) - lessonSortRank(b));
  if (tags.length || module) {
    const tagSet = new Set(tags.map((t) => String(t).toLowerCase()));
    const mod = String(module || "").toLowerCase();
    lessons = lessons.filter((l) => {
      const lt = (l.tags || []).map((t) => String(t).toLowerCase());
      const tagHit = tagSet.size ? [...tagSet].some((t) => lt.includes(t)) : true;
      const modHit = mod
        ? String(l.module || "")
            .toLowerCase()
            .includes(mod)
        : true;
      return tagHit && modHit;
    });
  }
  lessons = lessons.slice(0, maxLessons);

  if (!lessons.length) return "";

  const lines = [
    "## KNOWN ISSUES (user-reported — MUST follow; do not repeat these mistakes)",
    "",
  ];
  for (const l of lessons) {
    lines.push(`### ${l.id || "lesson"}`);
    if (l.module) lines.push(`Module: ${l.module}`);
    lines.push(`Problem: ${l.issue}`);
    lines.push(`Required fix: ${l.fix}`);
    lines.push("");
  }
  return lines.join("\n");
}

function slugId(text) {
  return (
    String(text || "lesson")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || `lesson-${Date.now()}`
  );
}

function appendHealLesson({ title, issue, fix, tags = [], module = "", source = "user-report" } = {}) {
  if (!issue || !fix) {
    throw new Error("issue and fix are required");
  }

  const id = slugId(title || issue);
  const runtime = loadRuntimeLessonsOnly();
  const all = loadHealLessons();

  if (all.some((l) => l.id === id)) {
    return { ok: true, id, duplicate: true, count: all.length };
  }

  const lesson = {
    id,
    tags: tags.length ? tags : ["user-report"],
    module: module || undefined,
    issue: String(issue).trim(),
    fix: String(fix).trim(),
    source,
    addedAt: new Date().toISOString(),
  };

  runtime.push(lesson);
  saveRuntimeLessons(runtime);
  console.log(`[ai-heal-lessons] Added lesson: ${id}`);

  return { ok: true, id, duplicate: false, count: all.length + 1, lesson };
}

function recordHealRunFailure({ pageUrl = "", error = "", observation = null, attempt = 0 } = {}) {
  const url = String(pageUrl || observation?.url || "").toLowerCase();
  const err = String(error || observation?.brokenReason || "").trim();
  if (!url && !err) return null;

  let issue = err || `Navigation/heal failed at ${pageUrl || "unknown URL"}`;
  let fix = "Read observation and prior attempts; use Ctrl+B Quick Search; never manage-courier.";
  let tags = ["self-heal", "runtime"];
  let module = "Rate Calculator";

  if (url.includes("manage-courier")) {
    issue = `Heal attempt ${attempt} landed on manage-courier: ${pageUrl}`;
    fix = "Do not use manage-courier. Ctrl+B → rate calculator → Tools → Rate Calculator.";
    tags.push("navigation", "critical");
  } else if (observation?.is404 || /opps|could not be found/i.test(err)) {
    issue = `Heal attempt ${attempt} hit 404 page: ${pageUrl}`;
    fix = "Dismiss overlays, Ctrl+B from dashboard, verify pincode+calculate on success.";
    tags.push("verification");
  } else if (url.includes("/orders/")) {
    module = "New Orders";
    issue = `Automation on orders page caused wrong state: ${issue}`;
    fix = "Do not fill date filters. Reset filters before search. Use order_create_domestic e2eFlow for real orders.";
    tags.push("orders");
  }

  const id = slugId(`runtime-${issue.slice(0, 40)}-${attempt}`);
  const runtime = loadRuntimeLessonsOnly();
  if (runtime.some((l) => l.id === id)) return null;

  return appendHealLesson({ title: id, issue, fix, tags, module, source: "heal-run" });
}

module.exports = {
  LESSONS_PATH,
  loadHealLessons,
  formatLessonsForPrompt,
  appendHealLesson,
  recordHealRunFailure,
};
