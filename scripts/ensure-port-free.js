/** Kill any process listening on PORT (local Windows dev only). Skipped on Render. */
if (process.env.RENDER) {
  process.exit(0);
}

const { execSync } = require("child_process");

const port = String(process.env.PORT || "3000").trim();

function freePortWindows() {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf-8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`[prestart] Freed port ${port} (stopped PID ${pid})`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* port already free */
  }
}

if (process.platform === "win32") {
  freePortWindows();
}
