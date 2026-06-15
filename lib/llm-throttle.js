/**
 * Client-side Claude rate-limit guard: cooldown + rolling TPM/RPM + retry on 429.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttleEnabled() {
  const v = String(process.env.LLM_THROTTLE ?? "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function tpmLimit() {
  const n = Number(process.env.ANTHROPIC_TPM_LIMIT || 8000);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

function rpmLimit() {
  const n = Number(process.env.ANTHROPIC_RPM_LIMIT || 2);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function cooldownMs() {
  const n = Number(process.env.LLM_COOLDOWN_MS || 20000);
  return Number.isFinite(n) && n >= 0 ? n : 20000;
}

function maxRetries() {
  const n = Number(process.env.LLM_RATE_LIMIT_MAX_RETRIES || 5);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function retryEnabled() {
  const v = String(process.env.LLM_RATE_LIMIT_RETRY ?? "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

/** Input tokens only (chars / 3.5 — conservative vs chars/4). */
function estimateInputTokens(messages, system) {
  let chars = String(system || "").length;
  for (const m of messages || []) {
    chars += String(m.content || "").length;
  }
  return Math.ceil(chars / 3.5);
}

const WINDOW_MS = 60_000;
const recentCalls = [];
let lastCallAt = 0;

function pruneWindow(now = Date.now()) {
  while (recentCalls.length && now - recentCalls[0].at > WINDOW_MS) {
    recentCalls.shift();
  }
}

function windowUsage(now = Date.now()) {
  pruneWindow(now);
  return {
    requests: recentCalls.length,
    inputTokens: recentCalls.reduce((s, e) => s + e.inputTokens, 0),
  };
}

function recordUsage(inputTokens, now = Date.now()) {
  recentCalls.push({ at: now, inputTokens: Math.max(0, inputTokens) });
  lastCallAt = now;
  pruneWindow(now);
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    err?.status === 429 ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("tokens per minute") ||
    msg.includes("requests per minute") ||
    msg.includes("would exceed")
  );
}

function retryDelayMs(attempt) {
  const base = Number(process.env.LLM_RATE_LIMIT_RETRY_MS || 70000);
  return base + attempt * 8000;
}

/** Trim user message content so a single request fits TPM budget. */
function clampMessagesForTpm(messages, system, budget = tpmLimit()) {
  const sysChars = String(system || "").length;
  const maxMsgChars = Math.max(4000, Math.floor((budget * 3.5) - sysChars - 500));
  return (messages || []).map((m) => {
    const content = String(m.content || "");
    if (content.length <= maxMsgChars) return m;
    console.warn(
      `[llm-throttle] truncating message ${content.length} → ${maxMsgChars} chars for TPM budget`
    );
    return {
      ...m,
      content:
        content.slice(0, maxMsgChars) +
        "\n\n…[truncated to stay within Claude rate limits — regenerate with REPORT_BACKEND=llm for full context]",
    };
  });
}

function clampSystemForTpm(system, budget = tpmLimit()) {
  const s = String(system || "");
  const maxSys = Math.floor(budget * 3.5 * 0.25);
  if (s.length <= maxSys) return s;
  return s.slice(0, maxSys) + "\n…[system truncated]";
}

/**
 * Wait until rolling TPM/RPM budget + cooldown allow the next call.
 * If a single request exceeds TPM, wait for a full 60s window reset first.
 */
async function waitForBudget(estimatedInputTokens) {
  if (!throttleEnabled()) return;

  const limit = tpmLimit();
  const est = Math.max(1, estimatedInputTokens);
  let waited = 0;
  const maxWait = Number(process.env.LLM_THROTTLE_MAX_WAIT_MS || 600000);

  while (waited < maxWait) {
    const now = Date.now();
    pruneWindow(now);
    const { requests, inputTokens } = windowUsage(now);

    const rpmOk = requests < rpmLimit();
    const tpmOk = inputTokens + est <= limit;
    const cooldownOk = !lastCallAt || now - lastCallAt >= cooldownMs();

    if (rpmOk && tpmOk && cooldownOk) return;

    let delay = 3000;
    if (!cooldownOk && lastCallAt) {
      delay = Math.max(delay, cooldownMs() - (now - lastCallAt) + 200);
    }
    if (!tpmOk || !rpmOk) {
      const oldest = recentCalls[0];
      delay = oldest
        ? Math.max(delay, WINDOW_MS - (now - oldest.at) + 800)
        : Math.max(delay, est > limit ? WINDOW_MS + 1000 : 8000);
    }

    console.log(
      `[llm-throttle] waiting ${Math.ceil(delay / 1000)}s (RPM ${requests}/${rpmLimit()}, TPM ~${inputTokens}+${est}/${limit})`
    );
    await sleep(delay);
    waited += delay;
  }

  console.warn("[llm-throttle] clearing token window after max wait");
  recentCalls.length = 0;
  lastCallAt = 0;
  await sleep(WINDOW_MS);
}

/** Extra gap before doc-generation LLM calls (PRD then manual). */
function isDocsGenFast() {
  const v = String(process.env.DOCS_GEN_FAST ?? "true").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

async function paceReportGeneration() {
  if (!throttleEnabled() || isDocsGenFast()) return;
  const gap = Number(process.env.REPORT_GEN_PACE_MS || 8000);
  if (!lastCallAt) return;
  const since = Date.now() - lastCallAt;
  if (since < gap) {
    const wait = gap - since;
    console.log(`[llm-throttle] report-gen pace: waiting ${Math.ceil(wait / 1000)}s after previous LLM call`);
    await sleep(wait);
  }
}

async function withClaudeThrottle({ messages, system, maxTokens, fn }) {
  let msgs = messages;
  let sys = system;
  const attempts = retryEnabled() ? maxRetries() : 1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let est = estimateInputTokens(msgs, sys);
    if (est > tpmLimit()) {
      msgs = clampMessagesForTpm(msgs, sys);
      sys = clampSystemForTpm(sys);
      est = estimateInputTokens(msgs, sys);
    }
    await waitForBudget(est);

    try {
      const result = await fn({ messages: msgs, system: sys });
      const used =
        result?.usage?.input_tokens || result?.usage?.prompt_tokens || estimateInputTokens(msgs, sys);
      recordUsage(used);
      return result;
    } catch (err) {
      if (!retryEnabled() || !isRateLimitError(err) || attempt >= attempts - 1) {
        throw err;
      }
      const delay = retryDelayMs(attempt);
      console.log(
        `[llm-throttle] rate limited — retry ${attempt + 1}/${attempts - 1} in ${Math.ceil(delay / 1000)}s`
      );
      recentCalls.length = 0;
      lastCallAt = 0;
      await sleep(delay);
      msgs = clampMessagesForTpm(messages, system);
      sys = clampSystemForTpm(system);
    }
  }
  throw new Error("Claude throttle: unreachable");
}

module.exports = {
  throttleEnabled,
  estimateInputTokens,
  waitForBudget,
  paceReportGeneration,
  withClaudeThrottle,
  isRateLimitError,
  windowUsage,
  clampMessagesForTpm,
};
