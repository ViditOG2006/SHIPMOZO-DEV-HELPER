const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { isRenderDeploy } = require("./public-url");

const ROOT = path.join(__dirname, "..");
const DEFAULT_RELATIVE = ".playwright-browsers";

function resolvePlaywrightBrowsersPath() {
  const explicit = String(process.env.PLAYWRIGHT_BROWSERS_PATH || "").trim();
  if (explicit) return path.resolve(explicit);
  return path.join(ROOT, DEFAULT_RELATIVE);
}

/** Set PLAYWRIGHT_BROWSERS_PATH for Node + child Python processes. */
function applyPlaywrightBrowsersEnv() {
  const browsersPath = resolvePlaywrightBrowsersPath();
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return browsersPath;
}

function findChromiumBinary(dir, depth = 0) {
  if (depth > 6 || !dir || !fs.existsSync(dir)) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && (entry.name === "chrome-headless-shell" || entry.name === "chrome")) {
      return true;
    }
    if (entry.isDirectory() && findChromiumBinary(full, depth + 1)) {
      return true;
    }
  }
  return false;
}

function runPythonPlaywrightInstall(timeoutMs = 120000) {
  return new Promise((resolve) => {
    const browsersPath = applyPlaywrightBrowsersEnv();
    fs.mkdirSync(browsersPath, { recursive: true });
    const pythonBin = process.env.PYTHON_BIN || "python3";
    const proc = spawn(pythonBin, ["-m", "playwright", "install", "chromium"], {
      cwd: ROOT,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath },
    });

    let stderr = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        path: browsersPath,
        error: `Playwright install timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, path: browsersPath, error: err.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && findChromiumBinary(browsersPath);
      resolve({
        ok,
        path: browsersPath,
        error: ok ? null : stderr.trim() || `playwright install exit ${code}`,
      });
    });
  });
}

let ensurePromise = null;

/**
 * On Render, build cache under /opt/render/.cache does not ship to runtime.
 * Browsers must live in the project tree (or be installed once at startup).
 */
async function ensurePlaywrightBrowsersOnStartup() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const browsersPath = applyPlaywrightBrowsersEnv();
      fs.mkdirSync(browsersPath, { recursive: true });

      if (findChromiumBinary(browsersPath)) {
        console.log(`[playwright] Chromium ready at ${browsersPath}`);
        return { ok: true, path: browsersPath, skipped: true };
      }

      if (!isRenderDeploy()) {
        console.warn(
          `[playwright] Chromium not found under ${browsersPath} — run: npm run playwright:install`
        );
        return { ok: false, path: browsersPath, skipped: true };
      }

      console.log(`[playwright] Chromium missing at runtime — installing to ${browsersPath}...`);
      const result = await runPythonPlaywrightInstall();
      if (result.ok) {
        console.log(`[playwright] Chromium installed at ${result.path}`);
      } else {
        console.error(`[playwright] Chromium install failed: ${result.error}`);
      }
      return result;
    })();
  }
  return ensurePromise;
}

module.exports = {
  ROOT,
  DEFAULT_RELATIVE,
  resolvePlaywrightBrowsersPath,
  applyPlaywrightBrowsersEnv,
  findChromiumBinary,
  ensurePlaywrightBrowsersOnStartup,
};
