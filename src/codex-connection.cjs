"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_ROOT = process.env.CODEX_BOT_STATE_ROOT || path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Codex Bot Bridge");
const CONFIG_PATH = path.join(STATE_ROOT, "connection.json");
const BRIDGE_LOG_PATH = path.join(STATE_ROOT, "logs", "bridge.jsonl");
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING = "high";
const DEFAULT_PROXY_URL = "http://127.0.0.1:8317/v1";
const DEFAULT_PROXY_KEY = "codex-bot-local";
const STATE_KEY = Symbol.for("codexbot.connection.state");
const OAUTH_KEY = Symbol.for("codexbot.connection.oauth");
const WINDOWS_POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const SECRET_FIELD_NAME = /^(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|device[-_]?code|password|passwd|secret)$/i;
const URL_FIELD_NAME = /(?:^|[-_])(?:url|uri|target|destination|origin)$/i;

function publicOriginForLog(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "[REDACTED URL]";
    return parsed.origin.slice(0, 300);
  } catch {
    return "[REDACTED URL]";
  }
}

function redactSensitiveText(value) {
  let text = String(value ?? "");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => publicOriginForLog(url));
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
  text = text.replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
  text = text.replace(/\b(device\s+code)\s+([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/gi, "$1 [REDACTED]");
  text = text.replace(
    /\b(authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|device[-_]?code|password|passwd|secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, name, separator, secret) => `${name}${separator}${secret.startsWith('"') ? '"[REDACTED]"' : secret.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"}`,
  );
  return text.slice(0, 4_000);
}

function redactLogDetails(value, key = "") {
  if (SECRET_FIELD_NAME.test(key)) return "[REDACTED]";
  if (typeof value === "string") return URL_FIELD_NAME.test(key) ? publicOriginForLog(value) : redactSensitiveText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactLogDetails(item));
  if (typeof value === "object") {
    const redacted = {};
    for (const [name, item] of Object.entries(value).slice(0, 100)) redacted[name] = redactLogDetails(item, name);
    return redacted;
  }
  return redactSensitiveText(value);
}

function redactError(error) {
  const original = error instanceof Error ? error : new Error(String(error));
  const message = redactSensitiveText(original.message || "The operation failed.");
  if (message === original.message) return original;
  const redacted = new Error(message);
  redacted.name = original.name;
  if (typeof original.code === "string" || typeof original.code === "number") redacted.code = original.code;
  return redacted;
}

function safeJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeConfig(value) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function decodeJwt(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function newestCodexAuth() {
  const authRoot = process.env.GROK_BOT_CODEX_AUTH_DIR || path.join(os.homedir(), ".cli-proxy-api");
  try {
    return fs.readdirSync(authRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^codex-.*\.json$/i.test(entry.name))
      .map((entry) => {
        const file = path.join(authRoot, entry.name);
        return { file, modifiedMs: fs.statSync(file).mtimeMs, auth: safeJson(file) };
      })
      .filter((item) => item.auth && item.auth.disabled !== true && item.auth.expired !== true)
      .sort((a, b) => b.modifiedMs - a.modifiedMs)[0] || null;
  } catch {
    return null;
  }
}

function account() {
  const item = newestCodexAuth();
  if (!item) return { signedIn: false, name: null, email: null, plan: null, avatarUrl: null };
  const id = decodeJwt(item.auth.id_token) || {};
  const access = decodeJwt(item.auth.access_token) || {};
  const authInfo = access["https://api.openai.com/auth"] || id["https://api.openai.com/auth"] || {};
  const profile = access["https://api.openai.com/profile"] || id["https://api.openai.com/profile"] || {};
  return {
    signedIn: true,
    name: id.name || profile.name || item.auth.name || item.auth.email || "Codex user",
    email: id.email || profile.email || item.auth.email || null,
    plan: authInfo.chatgpt_plan_type || item.auth.plan_type || null,
    accountId: authInfo.chatgpt_account_id || item.auth.account_id || null,
    // Codex OAuth currently provides no picture claim. Keep this null so the
    // UI uses honest account initials instead of inventing an avatar.
    avatarUrl: id.picture || profile.picture || null,
    refreshedAt: item.auth.last_refresh || new Date(item.modifiedMs).toISOString(),
  };
}

function powershellDataProtection(script, input) {
  if (!fs.existsSync(WINDOWS_POWERSHELL)) throw new Error(`Windows PowerShell is missing: ${WINDOWS_POWERSHELL}`);
  const result = childProcess.spawnSync(WINDOWS_POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw redactError(new Error(String(result.stderr || "Windows credential protection failed.").trim()));
  return String(result.stdout || "").trim();
}

function protectSecret(secret) {
  return powershellDataProtection(
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))",
    secret,
  );
}

function unprotectSecret(value) {
  return powershellDataProtection(
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))",
    value,
  );
}

function state() {
  if (!globalThis[STATE_KEY]) globalThis[STATE_KEY] = { configMtime: -1, config: null, apiKey: null };
  const shared = globalThis[STATE_KEY];
  let modified = -1;
  try { modified = fs.statSync(CONFIG_PATH).mtimeMs; } catch {}
  if (shared.config == null || shared.configMtime !== modified) {
    shared.config = safeJson(CONFIG_PATH, { mode: "codex-oauth", model: DEFAULT_MODEL, reasoningEffort: DEFAULT_REASONING });
    shared.configMtime = modified;
    shared.apiKey = null;
  }
  return shared;
}

function getConnection() {
  const shared = state();
  const config = shared.config || {};
  if (config.mode === "api-key" && config.protectedApiKey) {
    if (!shared.apiKey) shared.apiKey = unprotectSecret(config.protectedApiKey);
    return {
      mode: "api-key",
      route: "openai-api-key",
      baseUrl: "https://api.openai.com/v1",
      apiKey: shared.apiKey,
      model: config.model || DEFAULT_MODEL,
      reasoningEffort: config.reasoningEffort || DEFAULT_REASONING,
    };
  }
  return {
    mode: "codex-oauth",
    route: "cliproxyapi-codex-oauth",
    baseUrl: process.env.GROK_BOT_CLIPROXY_URL || DEFAULT_PROXY_URL,
    apiKey: process.env.GROK_BOT_CLIPROXY_KEY || DEFAULT_PROXY_KEY,
    model: process.env.GROK_BOT_CLIPROXY_MODEL || config.model || DEFAULT_MODEL,
    reasoningEffort: process.env.GROK_BOT_REASONING_EFFORT || config.reasoningEffort || DEFAULT_REASONING,
  };
}

function setMode(mode) {
  const previous = safeJson(CONFIG_PATH, {});
  writeConfig({ ...previous, mode, model: previous.model || DEFAULT_MODEL, reasoningEffort: previous.reasoningEffort || DEFAULT_REASONING });
  globalThis[STATE_KEY] = null;
}

function setApiKey(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (normalized.length < 20) throw new Error("Enter a complete OpenAI API key.");
  const previous = safeJson(CONFIG_PATH, {});
  writeConfig({
    ...previous,
    mode: "api-key",
    model: previous.model || DEFAULT_MODEL,
    reasoningEffort: previous.reasoningEffort || DEFAULT_REASONING,
    protectedApiKey: protectSecret(normalized),
  });
  globalThis[STATE_KEY] = null;
}

async function verifyApiKey(apiKey) {
  if (String(apiKey || "").trim().length < 20) {
    throw new Error("Enter a complete OpenAI API key.");
  }
  const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(DEFAULT_MODEL)}`, {
    headers: { Authorization: `Bearer ${String(apiKey || "").trim()}` },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(redactSensitiveText(`OpenAI rejected this API key (${response.status}): ${detail}`));
  }
  return true;
}

function beginCodexOAuth() {
  setMode("codex-oauth");
  const executable = process.env.GROK_BOT_CLIPROXY_EXE;
  const config = process.env.GROK_BOT_CLIPROXY_CONFIG;
  if (!executable || !config) throw new Error("CLIProxyAPI is not configured for this installation.");
  if (!fs.existsSync(executable)) throw new Error("CLIProxyAPI executable was not found.");

  const active = globalThis[OAUTH_KEY];
  if (active?.child && !active.child.killed && active.child.exitCode === null) return active.promise;

  const child = childProcess.spawn(executable, ["-codex-device-login", "-no-browser", "-config", config], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const promise = new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = () => {
      const url = output.match(/Codex device URL:\s*(https:\/\/\S+)/i)?.[1];
      const code = output.match(/Codex device code:\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/i)?.[1];
      if (!url || !code || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        url,
        code: code.toUpperCase(),
        message: "Open the official OpenAI device page and enter this one-time code.",
      });
    };
    const append = (chunk) => {
      output = `${output}${String(chunk || "")}`.slice(-16_000);
      finish();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (globalThis[OAUTH_KEY]?.child === child) globalThis[OAUTH_KEY] = null;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Codex sign-in stopped before a device code was issued (exit ${code ?? "unknown"}).`));
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Codex sign-in did not issue a device code in time. Try again."));
    }, 15_000);
  });
  globalThis[OAUTH_KEY] = { child, promise };
  return promise;
}

function usage() {
  const totals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    since: null,
    lastCompletedAt: null,
    model: null,
    availability: { state: "ready", message: null, lastErrorAt: null, resetsAt: null },
  };
  try {
    for (const line of fs.readFileSync(BRIDGE_LOG_PATH, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (!totals.since) totals.since = item.time || null;
      if (item.event === "request" && item.model) totals.model = item.model;
      if (item.event === "error") {
        totals.availability.lastErrorAt = item.time || totals.availability.lastErrorAt;
        const message = String(item.message || "");
        const jsonStart = message.indexOf("{");
        let providerError = null;
        if (jsonStart >= 0) {
          try { providerError = JSON.parse(message.slice(jsonStart)).error || null; } catch {}
        }
        if (providerError?.type === "usage_limit_reached" || providerError?.code === "model_cooldown") {
          const resetSeconds = Number(providerError.reset_seconds || 0);
          totals.availability = {
            state: providerError.code === "model_cooldown" ? "model-cooldown" : "usage-limit",
            message: providerError.message || (providerError.code === "model_cooldown" ? "This Codex model is temporarily cooling down." : "The Codex OAuth usage limit has been reached."),
            lastErrorAt: item.time || totals.availability.lastErrorAt,
            resetsAt: providerError.resets_at
              ? new Date(Number(providerError.resets_at) * 1000).toISOString()
              : resetSeconds > 0
                ? new Date(Date.now() + resetSeconds * 1000).toISOString()
                : providerError.reset_time || null,
          };
        } else if (totals.availability.state !== "usage-limit") {
          totals.availability = {
            state: "error",
            message: providerError?.message || message.slice(0, 500) || "The last Codex request failed.",
            lastErrorAt: item.time || totals.availability.lastErrorAt,
            resetsAt: providerError?.reset_time || null,
          };
        }
      }
      if (item.event !== "complete") continue;
      totals.requests += 1;
      totals.promptTokens += Number(item.promptTokens || 0);
      totals.completionTokens += Number(item.completionTokens || 0);
      totals.totalTokens += Number(item.totalTokens || 0);
      totals.toolCalls += Number(item.toolCallCount || 0);
      totals.lastCompletedAt = item.time || totals.lastCompletedAt;
      if (totals.availability.lastErrorAt && new Date(totals.lastCompletedAt).getTime() > new Date(totals.availability.lastErrorAt).getTime()) {
        totals.availability = { state: "ready", message: null, lastErrorAt: null, resetsAt: null };
      }
    }
  } catch {}
  return totals;
}

function publicStatus() {
  const connection = getConnection();
  return {
    product: "Codex Bot",
    connection: { mode: connection.mode, route: connection.route, model: connection.model, reasoningEffort: connection.reasoningEffort },
    account: account(),
    usage: usage(),
    settings: { automaticUpdates: false, maxBrowserSeats: Number(process.env.GROK_BOT_BROWSER_SEAT_LIMIT || 3) },
    verifiedPlugins: [],
  };
}

module.exports = {
  account, beginCodexOAuth, getConnection, publicStatus, setApiKey, setMode, usage, verifyApiKey,
  publicOriginForLog, redactError, redactLogDetails, redactSensitiveText,
};
