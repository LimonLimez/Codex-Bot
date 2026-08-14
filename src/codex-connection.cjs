"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_ROOT =
  process.env.CODEX_BOT_STATE_ROOT ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Codex Bot Bridge");
const CONFIG_PATH = path.join(STATE_ROOT, "connection.json");
const BRIDGE_LOG_PATH = path.join(STATE_ROOT, "logs", "bridge.jsonl");
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING = "high";
const DEFAULT_FAST_MODE = false;
const MODEL_CATALOG = Object.freeze([
  Object.freeze({
    id: "gpt-5.6-sol",
    label: "5.6 Sol",
    description: "Frontier capability for the hardest work.",
  }),
  Object.freeze({
    id: "gpt-5.6-terra",
    label: "5.6 Terra",
    description: "Balanced capability and speed.",
  }),
  Object.freeze({
    id: "gpt-5.6-luna",
    label: "5.6 Luna",
    description: "Efficient for quick, routine work.",
  }),
]);
const REASONING_EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MODEL_IDS = new Set(MODEL_CATALOG.map((model) => model.id));
const REASONING_VALUES = new Set(REASONING_EFFORTS);
const DEFAULT_PROXY_URL = "http://127.0.0.1:8317/v1";
const DEFAULT_PROXY_KEY = "codex-bot-local";
const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
const STATE_KEY = Symbol.for("codexbot.connection.state");
const OAUTH_KEY = Symbol.for("codexbot.connection.oauth");
const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const SECRET_FIELD_NAME =
  /^(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|device[-_]?code|password|passwd|secret)$/i;
const URL_FIELD_NAME = /(?:^|[-_])(?:url|uri|target|destination|origin)$/i;

function publicOriginForLog(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return "[REDACTED URL]";
    return parsed.origin.slice(0, 300);
  } catch {
    return "[REDACTED URL]";
  }
}

function redactSensitiveText(value) {
  let text = String(value ?? "");
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
    publicOriginForLog(url),
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
    "[REDACTED]",
  );
  text = text.replace(
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g,
    "[REDACTED]",
  );
  text = text.replace(
    /\b(device\s+code)\s+([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/gi,
    "$1 [REDACTED]",
  );
  text = text.replace(
    /\b(authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|device[-_]?code|password|passwd|secret)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    (_match, name, separator, secret) =>
      `${name}${separator}${secret.startsWith('"') ? '"[REDACTED]"' : secret.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"}`,
  );
  return text.slice(0, 4_000);
}

function redactLogDetails(value, key = "") {
  if (SECRET_FIELD_NAME.test(key)) return "[REDACTED]";
  if (typeof value === "string")
    return URL_FIELD_NAME.test(key)
      ? publicOriginForLog(value)
      : redactSensitiveText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactLogDetails(item));
  if (typeof value === "object") {
    const redacted = {};
    for (const [name, item] of Object.entries(value).slice(0, 100))
      redacted[name] = redactLogDetails(item, name);
    return redacted;
  }
  return redactSensitiveText(value);
}

function redactError(error) {
  const original = error instanceof Error ? error : new Error(String(error));
  const message = redactSensitiveText(
    original.message || "The operation failed.",
  );
  if (message === original.message) return original;
  const redacted = new Error(message);
  redacted.name = original.name;
  if (typeof original.code === "string" || typeof original.code === "number")
    redacted.code = original.code;
  return redacted;
}

function safeJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function plainObject(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function bootstrapModel() {
  const candidate = String(process.env.GROK_BOT_CLIPROXY_MODEL || "");
  return MODEL_IDS.has(candidate) ? candidate : DEFAULT_MODEL;
}

function bootstrapReasoning() {
  const candidate = String(
    process.env.GROK_BOT_REASONING_EFFORT || "",
  ).toLowerCase();
  return REASONING_VALUES.has(candidate) ? candidate : DEFAULT_REASONING;
}

function bootstrapFastMode() {
  const candidate = String(process.env.GROK_BOT_FAST_MODE || "").toLowerCase();
  if (candidate === "true" || candidate === "1") return true;
  if (candidate === "false" || candidate === "0") return false;
  return DEFAULT_FAST_MODE;
}

function validateModel(value) {
  if (typeof value !== "string" || !MODEL_IDS.has(value)) {
    throw new SettingsValidationError(
      `model must be one of: ${[...MODEL_IDS].join(", ")}.`,
    );
  }
  return value;
}

function validateReasoningEffort(value) {
  if (typeof value !== "string" || !REASONING_VALUES.has(value)) {
    throw new SettingsValidationError(
      `reasoningEffort must be one of: ${REASONING_EFFORTS.join(", ")}.`,
    );
  }
  return value;
}

function validateFastMode(value) {
  if (typeof value !== "boolean")
    throw new SettingsValidationError("fastMode must be a boolean.");
  return value;
}

class SettingsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SettingsValidationError";
    this.statusCode = 400;
  }
}

function normalizeAgentId(value, { required = false } = {}) {
  if (value == null && !required) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value
  ) {
    throw new SettingsValidationError(
      "agentId must be a non-empty string no longer than 200 characters.",
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value) ||
    ["__proto__", "prototype", "constructor"].includes(value)
  ) {
    throw new SettingsValidationError(
      "agentId contains unsupported characters.",
    );
  }
  return value;
}

function storedDefaults(config = {}) {
  const nested = plainObject(config.defaults) ? config.defaults : {};
  const storedModel = hasOwn(nested, "model") ? nested.model : config.model;
  const storedReasoning = hasOwn(nested, "reasoningEffort")
    ? nested.reasoningEffort
    : config.reasoningEffort;
  const storedFastMode = hasOwn(nested, "fastMode")
    ? nested.fastMode
    : config.fastMode;
  return {
    model: MODEL_IDS.has(storedModel) ? storedModel : bootstrapModel(),
    reasoningEffort: REASONING_VALUES.has(storedReasoning)
      ? storedReasoning
      : bootstrapReasoning(),
    fastMode:
      typeof storedFastMode === "boolean"
        ? storedFastMode
        : bootstrapFastMode(),
  };
}

function storedAgentOverride(config, agentId) {
  if (!agentId || !plainObject(config?.agentPreferences)) return null;
  if (!hasOwn(config.agentPreferences, agentId)) return null;
  const candidate = config.agentPreferences[agentId];
  if (!plainObject(candidate)) return null;
  const override = {};
  if (MODEL_IDS.has(candidate.model)) override.model = candidate.model;
  if (REASONING_VALUES.has(candidate.reasoningEffort))
    override.reasoningEffort = candidate.reasoningEffort;
  if (typeof candidate.fastMode === "boolean")
    override.fastMode = candidate.fastMode;
  return Object.keys(override).length ? override : null;
}

function preferencePatch(value, { requireOne = true } = {}) {
  if (!plainObject(value))
    throw new SettingsValidationError("Settings must be a JSON object.");
  const patch = {};
  if (hasOwn(value, "model")) patch.model = validateModel(value.model);
  if (hasOwn(value, "reasoningEffort"))
    patch.reasoningEffort = validateReasoningEffort(value.reasoningEffort);
  if (hasOwn(value, "fastMode"))
    patch.fastMode = validateFastMode(value.fastMode);
  if (requireOne && Object.keys(patch).length === 0) {
    throw new SettingsValidationError(
      "At least one of model, reasoningEffort, or fastMode is required.",
    );
  }
  return patch;
}

function writeConfig(value) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const temporary = `${CONFIG_PATH}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, CONFIG_PATH);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
  }
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
  const authRoot =
    process.env.GROK_BOT_CODEX_AUTH_DIR ||
    path.join(os.homedir(), ".cli-proxy-api");
  try {
    return (
      fs
        .readdirSync(authRoot, { withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && /^codex-.*\.json$/i.test(entry.name),
        )
        .map((entry) => {
          const file = path.join(authRoot, entry.name);
          return {
            file,
            modifiedMs: fs.statSync(file).mtimeMs,
            auth: safeJson(file),
          };
        })
        .filter(
          (item) =>
            item.auth &&
            item.auth.disabled !== true &&
            item.auth.expired !== true,
        )
        .sort((a, b) => b.modifiedMs - a.modifiedMs)[0] || null
    );
  } catch {
    return null;
  }
}

function account() {
  const item = newestCodexAuth();
  if (!item)
    return {
      signedIn: false,
      name: null,
      email: null,
      plan: null,
      avatarUrl: null,
    };
  const id = decodeJwt(item.auth.id_token) || {};
  const access = decodeJwt(item.auth.access_token) || {};
  const authInfo =
    access["https://api.openai.com/auth"] ||
    id["https://api.openai.com/auth"] ||
    {};
  const profile =
    access["https://api.openai.com/profile"] ||
    id["https://api.openai.com/profile"] ||
    {};
  return {
    signedIn: true,
    name:
      id.name ||
      profile.name ||
      item.auth.name ||
      item.auth.email ||
      "Codex user",
    email: id.email || profile.email || item.auth.email || null,
    plan: authInfo.chatgpt_plan_type || item.auth.plan_type || null,
    accountId: authInfo.chatgpt_account_id || item.auth.account_id || null,
    // Codex OAuth currently provides no picture claim. Keep this null so the
    // UI uses honest account initials instead of inventing an avatar.
    avatarUrl: id.picture || profile.picture || null,
    refreshedAt:
      item.auth.last_refresh || new Date(item.modifiedMs).toISOString(),
  };
}

function powershellDataProtection(script, input) {
  if (!fs.existsSync(WINDOWS_POWERSHELL))
    throw new Error(`Windows PowerShell is missing: ${WINDOWS_POWERSHELL}`);
  const result = childProcess.spawnSync(
    WINDOWS_POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw redactError(
      new Error(
        String(result.stderr || "Windows credential protection failed.").trim(),
      ),
    );
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
  if (!globalThis[STATE_KEY])
    globalThis[STATE_KEY] = { configMtime: -1, config: null, apiKey: null };
  const shared = globalThis[STATE_KEY];
  let modified = -1;
  try {
    modified = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {}
  if (shared.config == null || shared.configMtime !== modified) {
    const loaded = safeJson(CONFIG_PATH, {});
    shared.config = plainObject(loaded) ? loaded : {};
    shared.configMtime = modified;
    shared.apiKey = null;
  }
  return shared;
}

function getPreferences(agentId = null) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const config = state().config || {};
  const defaults = storedDefaults(config);
  const override = storedAgentOverride(config, normalizedAgentId);
  return {
    agentId: normalizedAgentId,
    defaults: { ...defaults },
    override: override ? { ...override } : null,
    effective: { ...defaults, ...(override || {}) },
  };
}

function writePreferences(config, defaults) {
  writeConfig({
    ...config,
    // Keep the established fields synchronized so older patched runtimes can
    // still read a newly written configuration without losing the selection.
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    fastMode: defaults.fastMode,
    defaults: { ...defaults },
  });
  globalThis[STATE_KEY] = null;
}

function setDefaultPreferences(update) {
  const patch = preferencePatch(update);
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const defaults = { ...storedDefaults(config), ...patch };
  writePreferences(config, defaults);
  return getPreferences();
}

function cloneAgentPreferences(value) {
  const output = Object.create(null);
  if (!plainObject(value)) return output;
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    output[key] = item;
  }
  return output;
}

function setAgentPreferences(agentId, update) {
  const normalizedAgentId = normalizeAgentId(agentId, { required: true });
  const patch = preferencePatch(update);
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const agentPreferences = cloneAgentPreferences(config.agentPreferences);
  const current = storedAgentOverride(config, normalizedAgentId) || {};
  agentPreferences[normalizedAgentId] = { ...current, ...patch };
  const defaults = storedDefaults(config);
  writePreferences({ ...config, agentPreferences }, defaults);
  return getPreferences(normalizedAgentId);
}

function clearAgentPreferences(agentId) {
  const normalizedAgentId = normalizeAgentId(agentId, { required: true });
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const agentPreferences = cloneAgentPreferences(config.agentPreferences);
  delete agentPreferences[normalizedAgentId];
  const defaults = storedDefaults(config);
  writePreferences({ ...config, agentPreferences }, defaults);
  return getPreferences(normalizedAgentId);
}

function applySettingsUpdate(body) {
  if (!plainObject(body))
    throw new SettingsValidationError("Settings must be a JSON object.");
  const allowed = new Set([
    "scope",
    "agentId",
    "model",
    "reasoningEffort",
    "fastMode",
    "inherit",
    "clear",
  ]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new SettingsValidationError(`Unknown settings field: ${unknown[0]}.`);
  if (body.scope !== "default" && body.scope !== "agent") {
    throw new SettingsValidationError(
      'scope must be either "default" or "agent".',
    );
  }
  const isClear = hasOwn(body, "inherit") || hasOwn(body, "clear");
  if (hasOwn(body, "inherit") && body.inherit !== true)
    throw new SettingsValidationError("inherit must be true when provided.");
  if (hasOwn(body, "clear") && body.clear !== true)
    throw new SettingsValidationError("clear must be true when provided.");
  if (hasOwn(body, "inherit") && hasOwn(body, "clear"))
    throw new SettingsValidationError("Use either inherit or clear, not both.");
  const update = preferencePatch(body, { requireOne: false });

  if (body.scope === "default") {
    if (hasOwn(body, "agentId"))
      throw new SettingsValidationError(
        "agentId is only valid for agent settings.",
      );
    if (isClear)
      throw new SettingsValidationError(
        "Global defaults cannot inherit or be cleared.",
      );
    if (Object.keys(update).length === 0)
      throw new SettingsValidationError("At least one preference is required.");
    return {
      operation: "update-default",
      preferences: setDefaultPreferences(update),
    };
  }

  const agentId = normalizeAgentId(body.agentId, { required: true });
  if (isClear) {
    if (Object.keys(update).length)
      throw new SettingsValidationError(
        "Clear requests cannot include preference values.",
      );
    return {
      operation: "clear-agent",
      preferences: clearAgentPreferences(agentId),
    };
  }
  if (Object.keys(update).length === 0)
    throw new SettingsValidationError("At least one preference is required.");
  return {
    operation: "update-agent",
    preferences: setAgentPreferences(agentId, update),
  };
}

function getConnection(agentId = null) {
  const shared = state();
  const config = shared.config || {};
  const preferences = getPreferences(agentId).effective;
  if (config.mode === "api-key" && config.protectedApiKey) {
    if (!shared.apiKey) shared.apiKey = unprotectSecret(config.protectedApiKey);
    return {
      mode: "api-key",
      route: "openai-api-key",
      baseUrl: "https://api.openai.com/v1",
      apiKey: shared.apiKey,
      ...preferences,
    };
  }
  return {
    mode: "codex-oauth",
    route: "cliproxyapi-codex-oauth",
    baseUrl: process.env.GROK_BOT_CLIPROXY_URL || DEFAULT_PROXY_URL,
    apiKey: process.env.GROK_BOT_CLIPROXY_KEY || DEFAULT_PROXY_KEY,
    ...preferences,
  };
}

function setMode(mode) {
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  writePreferences({ ...config, mode }, storedDefaults(config));
}

function setApiKey(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (normalized.length < 20)
    throw new Error("Enter a complete OpenAI API key.");
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  writePreferences(
    {
      ...config,
      mode: "api-key",
      protectedApiKey: protectSecret(normalized),
    },
    storedDefaults(config),
  );
}

async function verifyApiKey(apiKey) {
  if (String(apiKey || "").trim().length < 20) {
    throw new Error("Enter a complete OpenAI API key.");
  }
  const response = await fetch(
    `https://api.openai.com/v1/models/${encodeURIComponent(DEFAULT_MODEL)}`,
    {
      headers: { Authorization: `Bearer ${String(apiKey || "").trim()}` },
    },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(
      redactSensitiveText(
        `OpenAI rejected this API key (${response.status}): ${detail}`,
      ),
    );
  }
  return true;
}

function normalizeCodexDeviceUrl(value) {
  try {
    const candidate = new URL(String(value || ""));
    const pathname = candidate.pathname.replace(/\/+$/, "");
    if (
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password ||
      candidate.hostname !== "auth.openai.com" ||
      candidate.port ||
      pathname !== "/codex/device" ||
      candidate.search ||
      candidate.hash
    )
      return null;
    return CODEX_DEVICE_URL;
  } catch {
    return null;
  }
}

function beginCodexOAuth() {
  setMode("codex-oauth");
  const executable = process.env.GROK_BOT_CLIPROXY_EXE;
  const config = process.env.GROK_BOT_CLIPROXY_CONFIG;
  if (!executable || !config)
    throw new Error("CLIProxyAPI is not configured for this installation.");
  if (!fs.existsSync(executable))
    throw new Error("CLIProxyAPI executable was not found.");

  const active = globalThis[OAUTH_KEY];
  if (active?.child && !active.child.killed && active.child.exitCode === null)
    return active.promise;

  const child = childProcess.spawn(
    executable,
    ["-codex-device-login", "-no-browser", "-config", config],
    {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const promise = new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = () => {
      const printedUrl = output.match(
        /Codex device URL:\s*(https:\/\/\S+)/i,
      )?.[1];
      const code = output.match(
        /Codex device code:\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/i,
      )?.[1];
      if (!printedUrl || !code || settled) return;
      const url = normalizeCodexDeviceUrl(printedUrl);
      if (!url) {
        settled = true;
        clearTimeout(timeout);
        child.kill();
        reject(
          new Error(
            "Codex sign-in returned an unexpected device page. Only the official OpenAI device page is allowed.",
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        url,
        code: code.toUpperCase(),
        message:
          "Open the official OpenAI device page and enter this one-time code.",
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
      reject(
        new Error(
          `Codex sign-in stopped before a device code was issued (exit ${code ?? "unknown"}).`,
        ),
      );
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          "Codex sign-in did not issue a device code in time. Try again.",
        ),
      );
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
    availability: {
      state: "ready",
      message: null,
      lastErrorAt: null,
      resetsAt: null,
    },
  };
  try {
    for (const line of fs
      .readFileSync(BRIDGE_LOG_PATH, "utf8")
      .split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (!totals.since) totals.since = item.time || null;
      if (item.event === "request" && item.model) totals.model = item.model;
      if (item.event === "error") {
        totals.availability.lastErrorAt =
          item.time || totals.availability.lastErrorAt;
        const message = String(item.message || "");
        const jsonStart = message.indexOf("{");
        let providerError = null;
        if (jsonStart >= 0) {
          try {
            providerError = JSON.parse(message.slice(jsonStart)).error || null;
          } catch {}
        }
        if (
          providerError?.type === "usage_limit_reached" ||
          providerError?.code === "model_cooldown"
        ) {
          const resetSeconds = Number(providerError.reset_seconds || 0);
          totals.availability = {
            state:
              providerError.code === "model_cooldown"
                ? "model-cooldown"
                : "usage-limit",
            message:
              providerError.message ||
              (providerError.code === "model_cooldown"
                ? "This Codex model is temporarily cooling down."
                : "The Codex OAuth usage limit has been reached."),
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
            message:
              providerError?.message ||
              message.slice(0, 500) ||
              "The last Codex request failed.",
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
      if (
        totals.availability.lastErrorAt &&
        new Date(totals.lastCompletedAt).getTime() >
          new Date(totals.availability.lastErrorAt).getTime()
      ) {
        totals.availability = {
          state: "ready",
          message: null,
          lastErrorAt: null,
          resetsAt: null,
        };
      }
    }
  } catch {}
  return totals;
}

function publicStatus(agentId = null) {
  const preferences = getPreferences(agentId);
  const connection = getConnection(preferences.agentId);
  return {
    product: "Codex Bot",
    connection: {
      mode: connection.mode,
      route: connection.route,
      model: connection.model,
      reasoningEffort: connection.reasoningEffort,
      fastMode: connection.fastMode,
    },
    account: account(),
    usage: usage(),
    settings: {
      automaticUpdates: false,
      maxBrowserSeats: Number(process.env.GROK_BOT_BROWSER_SEAT_LIMIT || 3),
    },
    preferences: {
      catalog: {
        models: MODEL_CATALOG.map((model) => ({ ...model })),
        reasoningEfforts: [...REASONING_EFFORTS],
        fastMode: { supported: true, default: DEFAULT_FAST_MODE },
      },
      agentId: preferences.agentId,
      defaults: { ...preferences.defaults },
      effective: { ...preferences.effective },
      override: preferences.override ? { ...preferences.override } : null,
    },
    verifiedPlugins: [],
  };
}

module.exports = {
  MODEL_CATALOG,
  REASONING_EFFORTS,
  SettingsValidationError,
  account,
  applySettingsUpdate,
  beginCodexOAuth,
  clearAgentPreferences,
  getConnection,
  getPreferences,
  publicStatus,
  setAgentPreferences,
  setApiKey,
  setDefaultPreferences,
  setMode,
  usage,
  verifyApiKey,
  normalizeCodexDeviceUrl,
  publicOriginForLog,
  redactError,
  redactLogDetails,
  redactSensitiveText,
};
