const fs = require("fs");
const path = require("path");
const { getGithubRepoUrl } = require("./ai-config");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(ROOT, "output", "runtime");
const TREE_CACHE_MS = Number(process.env.GITHUB_TREE_CACHE_MS || 60 * 60 * 1000);
const MAX_FILES = Number(process.env.GITHUB_CONTEXT_MAX_FILES || 10);
const MAX_CHARS = Number(process.env.GITHUB_CONTEXT_MAX_CHARS || 28000);
const FETCH_TIMEOUT_MS = Number(process.env.GITHUB_FETCH_TIMEOUT_MS || 25000);

const RELEVANT_EXT = new Set([".tsx", ".ts", ".jsx", ".js", ".vue", ".php", ".json"]);
const SKIP_PATH =
  /(?:^|\/)(node_modules|dist|build|\.next|coverage|__tests__|__mocks__|\.git|vendor|storybook-static)(\/|$)/i;
const NAV_HINTS = [
  "sidebar",
  "navigation",
  "nav-",
  "/nav/",
  "menu",
  "routes",
  "router",
  "layout",
  "pages/",
  "app/",
];

function parseGithubRepoUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (u.hostname.replace(/^www\./, "") !== "github.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    let branch = "";
    if (parts[2] === "tree" && parts[3]) {
      branch = parts.slice(3).join("/");
    }
    return {
      owner,
      repo,
      branch: branch || null,
      canonical: `https://github.com/${owner}/${repo}`,
    };
  } catch {
    return null;
  }
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Shipmozo-Dev-Helper",
  };
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubFetch(url) {
  const res = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `GitHub API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function treeCachePath(parsed) {
  const safe = `${parsed.owner}_${parsed.repo}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CACHE_DIR, `github-tree-${safe}.json`);
}

function readTreeCache(parsed) {
  const file = treeCachePath(parsed);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Date.now() - (data.cachedAt || 0) > TREE_CACHE_MS) return null;
    if (data.canonical !== parsed.canonical) return null;
    return data;
  } catch {
    return null;
  }
}

function writeTreeCache(parsed, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(treeCachePath(parsed), JSON.stringify(data, null, 2), "utf-8");
}

async function loadRepoTree(parsed, { force = false } = {}) {
  if (!force) {
    const cached = readTreeCache(parsed);
    if (cached?.paths?.length) return cached;
  }

  const repoMeta = await githubFetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`);
  const branch = parsed.branch || repoMeta.default_branch || "main";
  const tree = await githubFetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );

  const paths = (tree.tree || [])
    .filter((item) => item.type === "blob" && item.path)
    .map((item) => item.path)
    .filter((p) => RELEVANT_EXT.has(path.extname(p).toLowerCase()))
    .filter((p) => !SKIP_PATH.test(p));

  const payload = {
    canonical: parsed.canonical,
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    paths,
    truncated: Boolean(tree.truncated),
    cachedAt: Date.now(),
  };
  writeTreeCache(parsed, payload);
  return payload;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function slugTokens(text) {
  const tokens = tokenize(text);
  const slugs = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [...new Set([...tokens, ...slugs, slugs.join("-")])];
}

function scorePath(filePath, hints) {
  const low = filePath.toLowerCase();
  let score = 0;
  for (const hint of hints) {
    const h = hint.toLowerCase();
    if (!h) continue;
    if (low.includes(h)) score += h.length > 4 ? 12 : 6;
    if (low.includes(h.replace(/\s+/g, "-"))) score += 10;
    if (low.includes(h.replace(/\s+/g, "_"))) score += 8;
  }
  for (const nav of NAV_HINTS) {
    if (low.includes(nav)) score += 4;
  }
  if (/\/(page|index|route|layout)\.(tsx|ts|jsx|js)$/i.test(low)) score += 3;
  if (low.endsWith("navigation.json")) score += 15;
  return score;
}

function pickRelevantPaths(paths, { moduleName = "", query = "" } = {}) {
  const hints = [...slugTokens(moduleName), ...tokenize(query)].filter(Boolean);
  const scored = paths
    .map((p) => ({ path: p, score: scorePath(p, hints) }))
    .sort((a, b) => b.score - a.score);

  const withSignal = scored.filter((s) => s.score > 0);
  const chosen = (withSignal.length ? withSignal : scored).slice(0, MAX_FILES).map((s) => s.path);

  if (hints.length && chosen.length < 4) {
    for (const p of scored.slice(0, MAX_FILES * 2).map((s) => s.path)) {
      if (!chosen.includes(p)) chosen.push(p);
      if (chosen.length >= MAX_FILES) break;
    }
  }
  return chosen;
}

async function fetchRawFile(parsed, branch, filePath) {
  const url = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${branch}/${filePath}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "Shipmozo-Dev-Helper" },
  });
  if (!res.ok) return "";
  const text = await res.text();
  return text.length > 6000 ? `${text.slice(0, 6000)}\n// ... truncated ...` : text;
}

async function getGithubContextBlock({ moduleName = "", query = "", forceRefresh = false } = {}) {
  const repoUrl = getGithubRepoUrl();
  const parsed = parseGithubRepoUrl(repoUrl);
  if (!parsed) return null;

  try {
    const tree = await loadRepoTree(parsed, { force: forceRefresh });
    const selected = pickRelevantPaths(tree.paths || [], { moduleName, query });
    if (!selected.length) return null;

    const chunks = [];
    let total = 0;
    for (const filePath of selected) {
      if (total >= MAX_CHARS) break;
      const content = await fetchRawFile(parsed, tree.branch, filePath);
      if (!content.trim()) continue;
      const block = `### ${filePath}\n\`\`\`\n${content}\n\`\`\``;
      if (total + block.length > MAX_CHARS) {
        const room = MAX_CHARS - total - 80;
        if (room > 400) {
          chunks.push(`### ${filePath}\n\`\`\`\n${content.slice(0, room)}\n// ... truncated ...\n\`\`\``);
        }
        break;
      }
      chunks.push(block);
      total += block.length;
    }

    if (!chunks.length) return null;

    const staleNote =
      "IMPORTANT: GitHub code may be OUT OF DATE vs the live Shipmozo panel. " +
      "Prefer live screenshots and current UI (Quick Search: Ctrl+B on dashboard) over stale routes or sidebar paths from this repo. " +
      "Use repo files for field names and API hints only when they match live behavior.\n\n";

    return {
      text: `${staleNote}Repository: ${tree.canonical} (branch: ${tree.branch})\nFiles (${chunks.length}):\n\n${chunks.join("\n\n")}`,
      meta: {
        repo: tree.canonical,
        branch: tree.branch,
        fileCount: chunks.length,
        moduleName: moduleName || null,
        truncated: tree.truncated,
      },
    };
  } catch (err) {
    return {
      text: "",
      error: err.message,
      meta: { repo: parsed.canonical, fileCount: 0 },
    };
  }
}

async function getGithubContextText(options) {
  const block = await getGithubContextBlock(options);
  if (!block?.text) return { text: "", meta: block?.meta || null, error: block?.error || null };
  return block;
}

async function getGithubRepoStatus({ forceRefresh = false } = {}) {
  const repoUrl = getGithubRepoUrl();
  const parsed = parseGithubRepoUrl(repoUrl);
  if (!parsed) {
    return {
      configured: false,
      repoUrl: repoUrl || "",
      ok: false,
      message: repoUrl ? "Invalid GitHub URL — use https://github.com/owner/repo" : "No repo configured",
    };
  }

  try {
    const tree = await loadRepoTree(parsed, { force: forceRefresh });
    return {
      configured: true,
      ok: true,
      repoUrl: parsed.canonical,
      branch: tree.branch,
      pathCount: tree.paths?.length || 0,
      cachedAt: tree.cachedAt,
      truncated: tree.truncated,
      message: `Indexed ${tree.paths?.length || 0} source files`,
    };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      repoUrl: parsed.canonical,
      message: err.message,
      hint:
        err.status === 404
          ? "Repo not found or private — use a public repo or set GITHUB_TOKEN in .env"
          : err.status === 403
            ? "GitHub rate limit — set GITHUB_TOKEN in .env or wait an hour"
            : null,
    };
  }
}

module.exports = {
  parseGithubRepoUrl,
  getGithubContextBlock,
  getGithubContextText,
  getGithubRepoStatus,
  loadRepoTree,
};
