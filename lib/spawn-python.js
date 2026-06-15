const { spawn } = require("child_process");
const path = require("path");
const { applyPlaywrightBrowsersEnv } = require("./playwright-browsers");

const ROOT = path.join(__dirname, "..");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
let pythonChain = Promise.resolve();

/** @type {Map<string, { proc: import('child_process').ChildProcess, scriptName: string }>} */
const activeByKey = new Map();

function registerProcess(killKey, proc, scriptName) {
  if (!killKey || !proc) return;
  activeByKey.set(killKey, { proc, scriptName });
}

function unregisterProcess(killKey) {
  if (killKey) activeByKey.delete(killKey);
}

function killPythonByKey(killKey) {
  const entry = activeByKey.get(killKey);
  if (!entry?.proc) return false;
  const { proc } = entry;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 1500);
  activeByKey.delete(killKey);
  return true;
}

function killAllPythonForRun(runId) {
  if (!runId) return 0;
  let killed = 0;
  for (const key of [...activeByKey.keys()]) {
    if (key === runId || key.startsWith(`${runId}:`)) {
      if (killPythonByKey(key)) killed += 1;
    }
  }
  return killed;
}

function runPythonScript(scriptName, args, timeoutMs = 600000, options = {}) {
  applyPlaywrightBrowsersEnv();
  const env = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    ...(options.env || {}),
  };
  const killKey = options.killKey || null;

  const job = pythonChain.then(
    () =>
      new Promise((resolve) => {
        const scriptPath = path.join(ROOT, scriptName);
        const proc = spawn(PYTHON_BIN, ["-u", scriptPath, ...args], {
          cwd: ROOT,
          env,
        });

        if (killKey) registerProcess(killKey, proc, scriptName);

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killKey) unregisterProcess(killKey);
          resolve(result);
        };

        const timer = setTimeout(() => {
          try {
            proc.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          finish({
            ok: false,
            error: `Python script timed out after ${Math.round(timeoutMs / 1000)}s`,
            stdout: "",
            stderr,
            killed: true,
          });
        }, timeoutMs);

        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderr += text;
          if (typeof options.onStderr === "function") {
            for (const line of text.split(/\r?\n/)) {
              const t = line.trim();
              if (t) options.onStderr(t);
            }
          }
        });
        proc.on("error", (err) => {
          finish({ ok: false, error: err.message, stdout, stderr, killed: false });
        });
        proc.on("close", (code, signal) => {
          const stopped = signal === "SIGTERM" || signal === "SIGKILL";
          finish({
            ok: code === 0 && !stopped,
            code,
            signal,
            stdout,
            stderr,
            killed: stopped,
            error:
              code === 0 && !stopped
                ? null
                : stopped
                  ? "Stopped by user"
                  : stderr.trim() || `Exit code ${code}`,
          });
        });
      })
  );

  pythonChain = job.catch(() => {});
  return job;
}

module.exports = {
  runPythonScript,
  killPythonByKey,
  killAllPythonForRun,
};
