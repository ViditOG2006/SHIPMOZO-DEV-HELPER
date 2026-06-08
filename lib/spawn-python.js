const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
let pythonChain = Promise.resolve();

function runPythonScript(scriptName, args, timeoutMs = 600000) {
  const job = pythonChain.then(
    () =>
      new Promise((resolve) => {
        const scriptPath = path.join(ROOT, scriptName);
        const proc = spawn(PYTHON_BIN, ["-u", scriptPath, ...args], {
          cwd: ROOT,
          env: process.env,
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
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
          });
        }, timeoutMs);

        proc.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        proc.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        proc.on("error", (err) => {
          finish({ ok: false, error: err.message, stdout, stderr });
        });
        proc.on("close", (code) => {
          finish({
            ok: code === 0,
            code,
            stdout,
            stderr,
            error: code === 0 ? null : stderr.trim() || `Exit code ${code}`,
          });
        });
      })
  );

  pythonChain = job.catch(() => {});
  return job;
}

module.exports = { runPythonScript };
