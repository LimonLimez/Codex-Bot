"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_ROOT =
  process.env.CODEX_BOT_STATE_ROOT ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Open Bot");
const CONFIG_PATH = path.join(STATE_ROOT, "connection.json");
const BRIDGE_LOG_PATH = path.join(STATE_ROOT, "logs", "bridge.jsonl");
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING = "high";
const DEFAULT_FAST_MODE = false;
const DEFAULT_RESPONSE_MODE = "chat";
const RESPONSE_MODES = Object.freeze(["chat", "search", "research"]);
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
const LOCAL_PROVIDER_ID = "local";
const LOCAL_REASONING_EFFORTS = Object.freeze(["none"]);
const LOCAL_MODEL_LIMIT = 200;
const LOCAL_MODELS_RESPONSE_LIMIT = 1024 * 1024;
const IMAGE_MODEL = "gpt-image-2";
const IMAGE_RESPONSE_LIMIT = 24 * 1024 * 1024;
const IMAGE_PROMPT_LIMIT = 4_000;
const IMAGE_SIZES = Object.freeze(["1024x1024", "1536x1024", "1024x1536"]);
const IMAGE_QUALITIES = Object.freeze(["low", "medium", "high"]);
const CLIPROXY_PROVIDERS = Object.freeze([
  Object.freeze({
    id: "codex",
    label: "OpenAI Codex",
    description: "Use a ChatGPT account with Codex access.",
    loginKind: "device",
    loginFlag: "-codex-device-login",
    authType: "codex",
    authFilePattern: /^codex-.*\.json$/i,
    defaultModel: DEFAULT_MODEL,
    reasoningEfforts: REASONING_EFFORTS,
    fastModeSupported: true,
    models: MODEL_CATALOG,
  }),
  Object.freeze({
    id: "claude",
    label: "Anthropic Claude",
    description: "Connect a Claude account through Anthropic OAuth.",
    loginKind: "oauth",
    loginFlag: "-claude-login",
    authType: "claude",
    authFilePattern: /^claude-.*\.json$/i,
    defaultModel: "claude-sonnet-5",
    reasoningEfforts: Object.freeze([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    fastModeSupported: false,
    models: Object.freeze([
      Object.freeze({
        id: "claude-opus-5",
        label: "Claude Opus 5",
        description: "Maximum capability for demanding long-horizon work.",
      }),
      Object.freeze({
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        description: "Balanced agentic coding and everyday work.",
      }),
      Object.freeze({
        id: "claude-fable-5",
        label: "Claude Fable 5",
        description: "Capable general reasoning for broad workflows.",
      }),
    ]),
  }),
  Object.freeze({
    id: "antigravity",
    label: "Google Antigravity",
    description: "Connect Google models through Antigravity OAuth.",
    loginKind: "oauth",
    loginFlag: "-antigravity-login",
    authType: "antigravity",
    authFilePattern: /^antigravity(?:-.*)?\.json$/i,
    defaultModel: "gemini-3.6-flash-high",
    reasoningEfforts: Object.freeze(["low", "medium", "high"]),
    fastModeSupported: false,
    models: Object.freeze([
      Object.freeze({
        id: "gemini-3.6-flash-high",
        label: "Gemini 3.6 Flash",
        description: "Fast Google model with high reasoning.",
      }),
      Object.freeze({
        id: "gemini-pro-agent",
        label: "Gemini 3.1 Pro",
        description: "Google's higher-capability agent model.",
      }),
      Object.freeze({
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Claude routed through the Antigravity account.",
      }),
    ]),
  }),
  Object.freeze({
    id: "kimi",
    label: "Moonshot Kimi",
    description: "Connect a Kimi account with device authorization.",
    loginKind: "device",
    loginFlag: "-kimi-login",
    authType: "kimi",
    authFilePattern: /^kimi-.*\.json$/i,
    defaultModel: "kimi-k3",
    reasoningEfforts: Object.freeze(["low", "high", "max"]),
    fastModeSupported: false,
    models: Object.freeze([
      Object.freeze({
        id: "kimi-k3",
        label: "Kimi K3",
        description: "Moonshot's next-generation flagship model.",
      }),
      Object.freeze({
        id: "kimi-k3-256k",
        label: "Kimi K3 256K",
        description: "Kimi K3 with a lower-quota 256K context.",
      }),
      Object.freeze({
        id: "kimi-k2.7-code-highspeed",
        label: "Kimi K2.7 Code HighSpeed",
        description: "Coding-focused Kimi with higher output speed.",
      }),
    ]),
  }),
  Object.freeze({
    id: "xai",
    label: "xAI",
    description: "Connect an xAI account with device authorization.",
    loginKind: "device",
    loginFlag: "-xai-login",
    authType: "xai",
    authFilePattern: /^xai-.*\.json$/i,
    defaultModel: "grok-4.5",
    reasoningEfforts: Object.freeze(["none", "low", "medium", "high"]),
    fastModeSupported: false,
    models: Object.freeze([
      Object.freeze({
        id: "grok-4.5",
        label: "Grok 4.5",
        description: "xAI's flagship agentic model.",
      }),
      Object.freeze({
        id: "grok-4.3",
        label: "Grok 4.3",
        description: "Long-context reasoning with optional thinking.",
      }),
      Object.freeze({
        id: "grok-build-0.1",
        label: "Grok Build 0.1",
        description: "Fast coding model for software workflows.",
      }),
    ]),
  }),
  Object.freeze({
    id: "vertex",
    label: "Google Vertex AI",
    description: "Import a Google Cloud service-account JSON key.",
    loginKind: "service-account",
    loginFlag: "-vertex-import",
    authType: "vertex",
    authFilePattern: /^vertex-.*\.json$/i,
    defaultModel: "gemini-3.1-pro",
    reasoningEfforts: Object.freeze(["none", "low", "medium", "high"]),
    fastModeSupported: false,
    models: Object.freeze([
      Object.freeze({
        id: "gemini-3.6-flash",
        label: "Gemini 3.6 Flash",
        description: "Fast Vertex model for high-volume work.",
      }),
      Object.freeze({
        id: "gemini-3.1-pro",
        label: "Gemini 3.1 Pro",
        description: "High-capability Gemini through Google Cloud.",
      }),
      Object.freeze({
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        description: "Stable, efficient Vertex model.",
      }),
    ]),
  }),
]);
const LOCAL_PROVIDER = Object.freeze({
  id: LOCAL_PROVIDER_ID,
  label: "Local models",
  description: "Connect Ollama, LM Studio, or vLLM running on this PC.",
  loginKind: "local",
  loginFlag: null,
  authType: null,
  authFilePattern: /^$/,
  defaultModel: "local-model",
  reasoningEfforts: LOCAL_REASONING_EFFORTS,
  fastModeSupported: false,
  models: Object.freeze([]),
});
const PROVIDERS = Object.freeze([...CLIPROXY_PROVIDERS, LOCAL_PROVIDER]);
const PROVIDERS_BY_ID = new Map(
  PROVIDERS.map((provider) => [provider.id, provider]),
);
const DEFAULT_PROVIDER_ID = "codex";
const DEFAULT_PROXY_URL = "http://127.0.0.1:8317/v1";
const DEFAULT_PROXY_KEY = "codex-bot-local";
const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
const STATE_KEY = Symbol.for("codexbot.connection.state");
const OAUTH_KEY = Symbol.for("codexbot.connection.oauth");
const PROVIDER_LOGIN_SETTLE_MS = 10_000;
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

function recordObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function providerFor(value) {
  return PROVIDERS_BY_ID.get(String(value || "")) || null;
}

function normalizeProviderId(value) {
  const provider = providerFor(value);
  if (!provider) {
    throw new SettingsValidationError(
      `provider must be one of: ${PROVIDERS.map((item) => item.id).join(", ")}.`,
    );
  }
  return provider.id;
}

function activeProviderId(config = {}) {
  if (config.mode === "api-key") return DEFAULT_PROVIDER_ID;
  return providerFor(config.provider)?.id || DEFAULT_PROVIDER_ID;
}

function localServerConfig(config = state().config || {}) {
  const candidate = config.localServer;
  if (!plainObject(candidate) || !Array.isArray(candidate.models)) return null;
  let baseUrl;
  try {
    baseUrl = normalizeLocalBaseUrl(candidate.baseUrl);
  } catch {
    return null;
  }
  const models = candidate.models
    .filter(
      (model) =>
        plainObject(model) &&
        typeof model.id === "string" &&
        model.id.length > 0 &&
        model.id.length <= 200 &&
        model.id.trim() === model.id &&
        !/[\u0000-\u001f\u007f]/.test(model.id),
    )
    .slice(0, LOCAL_MODEL_LIMIT)
    .map((model) => ({
      id: model.id,
      label:
        typeof model.label === "string" && model.label.trim()
          ? model.label.trim().slice(0, 200)
          : model.id,
      description: "Available from the configured local model server.",
    }));
  if (!models.length) return null;
  return {
    baseUrl,
    protectedApiKey:
      typeof candidate.protectedApiKey === "string"
        ? candidate.protectedApiKey
        : null,
    models,
  };
}

function modelsFor(providerId, config = state().config || {}) {
  if (providerId === LOCAL_PROVIDER_ID)
    return localServerConfig(config)?.models || [];
  return (providerFor(providerId) || providerFor(DEFAULT_PROVIDER_ID)).models;
}

function modelIdsFor(providerId, config = state().config || {}) {
  return new Set(modelsFor(providerId, config).map((model) => model.id));
}

function bootstrapModel(
  providerId = DEFAULT_PROVIDER_ID,
  config = state().config || {},
) {
  const provider = providerFor(providerId) || providerFor(DEFAULT_PROVIDER_ID);
  const candidate = String(process.env.GROK_BOT_CLIPROXY_MODEL || "");
  const modelIds = modelIdsFor(provider.id, config);
  if (provider.id === LOCAL_PROVIDER_ID)
    return modelIds.has(candidate)
      ? candidate
      : modelIds.values().next().value || provider.defaultModel;
  return modelIds.has(candidate) ? candidate : provider.defaultModel;
}

function bootstrapReasoning(providerId = DEFAULT_PROVIDER_ID) {
  const provider = providerFor(providerId) || providerFor(DEFAULT_PROVIDER_ID);
  const candidate = String(
    process.env.GROK_BOT_REASONING_EFFORT || "",
  ).toLowerCase();
  if (provider.reasoningEfforts.includes(candidate)) return candidate;
  return provider.reasoningEfforts.includes(DEFAULT_REASONING)
    ? DEFAULT_REASONING
    : provider.reasoningEfforts[0];
}

function bootstrapFastMode() {
  const candidate = String(process.env.GROK_BOT_FAST_MODE || "").toLowerCase();
  if (candidate === "true" || candidate === "1") return true;
  if (candidate === "false" || candidate === "0") return false;
  return DEFAULT_FAST_MODE;
}

function validateModel(
  value,
  providerId = DEFAULT_PROVIDER_ID,
  config = state().config || {},
) {
  const modelIds = modelIdsFor(providerId, config);
  if (typeof value !== "string" || !modelIds.has(value)) {
    throw new SettingsValidationError(
      `model must be one of: ${[...modelIds].join(", ")}.`,
    );
  }
  return value;
}

function validateReasoningEffort(value, providerId = DEFAULT_PROVIDER_ID) {
  const efforts =
    providerFor(providerId)?.reasoningEfforts || REASONING_EFFORTS;
  if (typeof value !== "string" || !efforts.includes(value)) {
    throw new SettingsValidationError(
      `reasoningEffort must be one of: ${efforts.join(", ")}.`,
    );
  }
  return value;
}

function validateFastMode(value) {
  if (typeof value !== "boolean")
    throw new SettingsValidationError("fastMode must be a boolean.");
  return value;
}

function validateResponseMode(value) {
  if (typeof value !== "string" || !RESPONSE_MODES.includes(value)) {
    throw new SettingsValidationError(
      `responseMode must be one of: ${RESPONSE_MODES.join(", ")}.`,
    );
  }
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

function storedProviderPreferences(config, providerId) {
  if (!recordObject(config?.providerPreferences)) return null;
  const candidate = config.providerPreferences[providerId];
  return recordObject(candidate) ? candidate : null;
}

function storedDefaults(config = {}, providerId = activeProviderId(config)) {
  const provider = providerFor(providerId) || providerFor(DEFAULT_PROVIDER_ID);
  const providerStored = storedProviderPreferences(config, provider.id);
  const canUseLegacy = provider.id === activeProviderId(config);
  const nested = providerStored
    ? providerStored
    : canUseLegacy && plainObject(config.defaults)
      ? config.defaults
      : {};
  const storedModel = hasOwn(nested, "model") ? nested.model : config.model;
  const storedReasoning = hasOwn(nested, "reasoningEffort")
    ? nested.reasoningEffort
    : config.reasoningEffort;
  const storedFastMode = hasOwn(nested, "fastMode")
    ? nested.fastMode
    : config.fastMode;
  const storedResponseMode = hasOwn(nested, "responseMode")
    ? nested.responseMode
    : config.responseMode;
  const modelIds = modelIdsFor(provider.id, config);
  return {
    model: modelIds.has(storedModel)
      ? storedModel
      : bootstrapModel(provider.id, config),
    reasoningEffort: provider.reasoningEfforts.includes(storedReasoning)
      ? storedReasoning
      : bootstrapReasoning(provider.id),
    fastMode:
      provider.fastModeSupported && typeof storedFastMode === "boolean"
        ? storedFastMode
        : provider.fastModeSupported
          ? bootstrapFastMode()
          : false,
    responseMode: RESPONSE_MODES.includes(storedResponseMode)
      ? storedResponseMode
      : DEFAULT_RESPONSE_MODE,
  };
}

function storedAgentPreferenceMap(config, providerId) {
  if (recordObject(config?.providerAgentPreferences?.[providerId]))
    return config.providerAgentPreferences[providerId];
  if (
    providerId === activeProviderId(config) &&
    plainObject(config?.agentPreferences)
  )
    return config.agentPreferences;
  return null;
}

function storedAgentOverride(
  config,
  agentId,
  providerId = activeProviderId(config),
) {
  const provider = providerFor(providerId) || providerFor(DEFAULT_PROVIDER_ID);
  const agentPreferences = storedAgentPreferenceMap(config, provider.id);
  if (!agentId || !agentPreferences || !hasOwn(agentPreferences, agentId))
    return null;
  const candidate = agentPreferences[agentId];
  if (!plainObject(candidate)) return null;
  const override = {};
  if (modelIdsFor(provider.id, config).has(candidate.model))
    override.model = candidate.model;
  if (provider.reasoningEfforts.includes(candidate.reasoningEffort))
    override.reasoningEffort = candidate.reasoningEffort;
  if (provider.fastModeSupported && typeof candidate.fastMode === "boolean")
    override.fastMode = candidate.fastMode;
  if (RESPONSE_MODES.includes(candidate.responseMode))
    override.responseMode = candidate.responseMode;
  return Object.keys(override).length ? override : null;
}

function preferencePatch(
  value,
  { requireOne = true, providerId = DEFAULT_PROVIDER_ID } = {},
) {
  if (!plainObject(value))
    throw new SettingsValidationError("Settings must be a JSON object.");
  const provider = providerFor(providerId) || providerFor(DEFAULT_PROVIDER_ID);
  const patch = {};
  if (hasOwn(value, "model"))
    patch.model = validateModel(value.model, provider.id, state().config || {});
  if (hasOwn(value, "reasoningEffort"))
    patch.reasoningEffort = validateReasoningEffort(
      value.reasoningEffort,
      provider.id,
    );
  if (hasOwn(value, "fastMode")) {
    if (!provider.fastModeSupported)
      throw new SettingsValidationError(
        `${provider.label} does not expose Fast mode through CLIProxyAPI.`,
      );
    patch.fastMode = validateFastMode(value.fastMode);
  }
  if (hasOwn(value, "responseMode"))
    patch.responseMode = validateResponseMode(value.responseMode);
  if (requireOne && Object.keys(patch).length === 0) {
    throw new SettingsValidationError(
      "At least one of model, reasoningEffort, fastMode, or responseMode is required.",
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

function authRoot() {
  return (
    process.env.GROK_BOT_CODEX_AUTH_DIR ||
    path.join(os.homedir(), ".cli-proxy-api")
  );
}

function newestProviderAuth(providerId) {
  const provider = providerFor(providerId);
  if (!provider) return null;
  const root = authRoot();
  try {
    return (
      fs
        .readdirSync(root, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.toLowerCase().endsWith(".json") &&
            provider.authFilePattern.test(entry.name),
        )
        .map((entry) => {
          const file = path.join(root, entry.name);
          return {
            file,
            modifiedMs: fs.statSync(file).mtimeMs,
            auth: safeJson(file),
          };
        })
        .filter(
          (item) =>
            plainObject(item.auth) &&
            (item.auth.type === provider.authType ||
              provider.authFilePattern.test(path.basename(item.file))) &&
            item.auth.disabled !== true &&
            item.auth.expired !== true,
        )
        .sort((a, b) => b.modifiedMs - a.modifiedMs)[0] || null
    );
  } catch {
    return null;
  }
}

function account(providerId = activeProviderId(state().config || {})) {
  const provider = providerFor(providerId) || providerFor(DEFAULT_PROVIDER_ID);
  if (provider.id === LOCAL_PROVIDER_ID) {
    const local = localServerConfig();
    return {
      signedIn: Boolean(local),
      provider: provider.id,
      providerLabel: provider.label,
      name: local ? "Local model server" : null,
      email: null,
      plan: null,
      avatarUrl: null,
    };
  }
  const item = newestProviderAuth(provider.id);
  if (!item)
    return {
      signedIn: false,
      provider: provider.id,
      providerLabel: provider.label,
      name: null,
      email: null,
      plan: null,
      avatarUrl: null,
    };
  const id = provider.id === "codex" ? decodeJwt(item.auth.id_token) || {} : {};
  const access =
    provider.id === "codex" ? decodeJwt(item.auth.access_token) || {} : {};
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
    provider: provider.id,
    providerLabel: provider.label,
    name:
      id.name ||
      profile.name ||
      item.auth.organization_name ||
      item.auth.label ||
      item.auth.project_id ||
      item.auth.name ||
      item.auth.email ||
      `${provider.label} account`,
    email: id.email || profile.email || item.auth.email || null,
    plan:
      provider.id === "codex"
        ? authInfo.chatgpt_plan_type || item.auth.plan_type || null
        : null,
    accountId: authInfo.chatgpt_account_id || item.auth.account_id || null,
    // Codex OAuth currently provides no picture claim. Keep this null so the
    // UI uses honest account initials instead of inventing an avatar.
    avatarUrl: id.picture || profile.picture || null,
    refreshedAt:
      item.auth.last_refresh || new Date(item.modifiedMs).toISOString(),
  };
}

function providerConnections() {
  return PROVIDERS.map((provider) => {
    const providerAccount = account(provider.id);
    const local =
      provider.id === LOCAL_PROVIDER_ID ? localServerConfig() : null;
    const credential =
      provider.id === LOCAL_PROVIDER_ID
        ? null
        : newestProviderAuth(provider.id);
    return {
      id: provider.id,
      label: provider.label,
      description: provider.description,
      loginKind: provider.loginKind,
      signedIn: providerAccount.signedIn,
      accountName: providerAccount.signedIn ? providerAccount.name : null,
      credentialRevision: credential
        ? Math.max(0, Math.floor(credential.modifiedMs))
        : null,
      ...(provider.id === LOCAL_PROVIDER_ID
        ? { baseUrl: local?.baseUrl || null }
        : {}),
    };
  });
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
    globalThis[STATE_KEY] = {
      configMtime: -1,
      config: null,
      apiKey: null,
      localApiKey: null,
    };
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
    shared.localApiKey = null;
  }
  return shared;
}

function getPreferences(agentId = null) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const config = state().config || {};
  const providerId = activeProviderId(config);
  const defaults = storedDefaults(config, providerId);
  const override = storedAgentOverride(config, normalizedAgentId, providerId);
  return {
    agentId: normalizedAgentId,
    provider: providerId,
    defaults: { ...defaults },
    override: override ? { ...override } : null,
    effective: { ...defaults, ...(override || {}) },
  };
}

function cloneProviderRecord(value) {
  const output = Object.create(null);
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return output;
  for (const [key, item] of Object.entries(value)) {
    if (providerFor(key) && plainObject(item)) output[key] = { ...item };
  }
  return output;
}

function writePreferences(
  config,
  defaults,
  providerId = activeProviderId(config),
) {
  const providerPreferences = cloneProviderRecord(config.providerPreferences);
  providerPreferences[providerId] = { ...defaults };
  writeConfig({
    ...config,
    // Keep the established fields synchronized so older patched runtimes can
    // still read a newly written configuration without losing the selection.
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    fastMode: defaults.fastMode,
    responseMode: defaults.responseMode,
    defaults: { ...defaults },
    providerPreferences,
  });
  globalThis[STATE_KEY] = null;
}

function setDefaultPreferences(update) {
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const providerId = activeProviderId(config);
  const patch = preferencePatch(update, { providerId });
  const defaults = { ...storedDefaults(config, providerId), ...patch };
  writePreferences(config, defaults, providerId);
  return getPreferences();
}

function cloneAgentPreferences(value) {
  const output = Object.create(null);
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return output;
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    output[key] = item;
  }
  return output;
}

function setAgentPreferences(agentId, update) {
  const normalizedAgentId = normalizeAgentId(agentId, { required: true });
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const providerId = activeProviderId(config);
  const patch = preferencePatch(update, { providerId });
  const agentPreferences = cloneAgentPreferences(
    storedAgentPreferenceMap(config, providerId),
  );
  const current =
    storedAgentOverride(config, normalizedAgentId, providerId) || {};
  agentPreferences[normalizedAgentId] = { ...current, ...patch };
  const providerAgentPreferences = cloneProviderRecord(
    config.providerAgentPreferences,
  );
  providerAgentPreferences[providerId] = agentPreferences;
  const defaults = storedDefaults(config, providerId);
  writePreferences(
    { ...config, agentPreferences, providerAgentPreferences },
    defaults,
    providerId,
  );
  return getPreferences(normalizedAgentId);
}

function clearAgentPreferences(agentId) {
  const normalizedAgentId = normalizeAgentId(agentId, { required: true });
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const providerId = activeProviderId(config);
  const agentPreferences = cloneAgentPreferences(
    storedAgentPreferenceMap(config, providerId),
  );
  delete agentPreferences[normalizedAgentId];
  const providerAgentPreferences = cloneProviderRecord(
    config.providerAgentPreferences,
  );
  providerAgentPreferences[providerId] = agentPreferences;
  const defaults = storedDefaults(config, providerId);
  writePreferences(
    { ...config, agentPreferences, providerAgentPreferences },
    defaults,
    providerId,
  );
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
    "responseMode",
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
  const providerId = activeProviderId(state().config || {});
  const update = preferencePatch(body, {
    requireOne: false,
    providerId,
  });

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
      provider: "openai-api-key",
      providerLabel: "OpenAI API key",
      baseUrl: "https://api.openai.com/v1",
      apiKey: shared.apiKey,
      ...preferences,
    };
  }
  const providerId = activeProviderId(config);
  const provider = providerFor(providerId);
  if (provider.id === LOCAL_PROVIDER_ID) {
    const local = localServerConfig(config);
    if (!local)
      throw new SettingsValidationError(
        "Connect and discover a local model server before using local models.",
      );
    if (local.protectedApiKey && !shared.localApiKey)
      shared.localApiKey = unprotectSecret(local.protectedApiKey);
    return {
      mode: "local",
      route: "local-openai-compatible",
      provider: provider.id,
      providerLabel: provider.label,
      baseUrl: local.baseUrl,
      apiKey: shared.localApiKey || null,
      reasoningSupported: false,
      ...preferences,
    };
  }
  return {
    mode: "cliproxy-oauth",
    route: `cliproxyapi-${provider.id}-oauth`,
    provider: provider.id,
    providerLabel: provider.label,
    baseUrl: process.env.GROK_BOT_CLIPROXY_URL || DEFAULT_PROXY_URL,
    apiKey: process.env.GROK_BOT_CLIPROXY_KEY || DEFAULT_PROXY_KEY,
    ...preferences,
  };
}

function setMode(mode) {
  if (
    mode !== "api-key" &&
    mode !== "codex-oauth" &&
    mode !== "cliproxy-oauth" &&
    mode !== "local"
  )
    throw new SettingsValidationError("Unsupported connection mode.");
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const providerId =
    mode === "codex-oauth" ? DEFAULT_PROVIDER_ID : activeProviderId(config);
  writePreferences(
    {
      ...config,
      mode: mode === "codex-oauth" ? "cliproxy-oauth" : mode,
      provider: providerId,
    },
    storedDefaults(config, providerId),
    providerId,
  );
}

function setProvider(value) {
  const providerId = normalizeProviderId(value);
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const previousProviderId = activeProviderId(config);
  const providerPreferences = cloneProviderRecord(config.providerPreferences);
  providerPreferences[previousProviderId] = storedDefaults(
    config,
    previousProviderId,
  );
  const providerAgentPreferences = cloneProviderRecord(
    config.providerAgentPreferences,
  );
  providerAgentPreferences[previousProviderId] = cloneAgentPreferences(
    storedAgentPreferenceMap(config, previousProviderId),
  );
  const nextConfig = {
    ...config,
    mode: providerId === LOCAL_PROVIDER_ID ? "local" : "cliproxy-oauth",
    provider: providerId,
    providerPreferences,
    providerAgentPreferences,
    agentPreferences: cloneAgentPreferences(
      providerAgentPreferences[providerId],
    ),
  };
  writePreferences(
    nextConfig,
    storedDefaults(nextConfig, providerId),
    providerId,
  );
  return publicStatus();
}

function useProvider(value) {
  const providerId = normalizeProviderId(value);
  const provider = providerFor(providerId);
  if (providerId === LOCAL_PROVIDER_ID && !localServerConfig())
    throw new SettingsValidationError(
      "Connect and discover a local model server before selecting it.",
    );
  if (providerId !== LOCAL_PROVIDER_ID && !account(providerId).signedIn)
    throw new SettingsValidationError(
      `${provider.label} is not connected. Finish its official sign-in before selecting it.`,
    );
  cancelProviderLogin(providerId);
  return setProvider(providerId);
}

function normalizeLocalBaseUrl(value) {
  let candidate;
  try {
    candidate = new URL(String(value || "").trim());
  } catch {
    throw new SettingsValidationError(
      "Enter a valid local URL such as http://127.0.0.1:11434/v1.",
    );
  }
  const pathname = candidate.pathname.replace(/\/+$/, "");
  if (
    candidate.protocol !== "http:" ||
    candidate.hostname !== "127.0.0.1" ||
    !candidate.port ||
    candidate.username ||
    candidate.password ||
    candidate.search ||
    candidate.hash ||
    (pathname && pathname !== "/" && pathname !== "/v1")
  ) {
    throw new SettingsValidationError(
      "Local model servers must use a literal http://127.0.0.1:<port> URL with an optional /v1 path.",
    );
  }
  const port = Number(candidate.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new SettingsValidationError(
      "The local model server port is invalid.",
    );
  for (const reserved of [
    process.env.GROK_BOT_CLIPROXY_URL,
    process.env.GROK_BOT_GATEWAY_URL,
    process.env.SAND_HOST_GATEWAY_URL,
  ]) {
    try {
      const reservedUrl = new URL(String(reserved || ""));
      if (
        reservedUrl.hostname === "127.0.0.1" &&
        Number(reservedUrl.port) === port
      )
        throw new SettingsValidationError(
          "Choose the local model server port, not an Open Bot internal service port.",
        );
    } catch (error) {
      if (error instanceof SettingsValidationError) throw error;
    }
  }
  return `http://127.0.0.1:${port}/v1`;
}

async function readBoundedText(response, limit) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit)
      throw new SettingsValidationError(
        "The local model catalog is too large.",
      );
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new SettingsValidationError(
          "The local model catalog is too large.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function normalizeDiscoveredModels(value) {
  if (!plainObject(value) || !Array.isArray(value.data))
    throw new SettingsValidationError(
      "The local server did not return an OpenAI-compatible model catalog.",
    );
  const seen = new Set();
  const models = [];
  for (const item of value.data) {
    const id = plainObject(item) ? item.id : null;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > 200 ||
      id.trim() !== id ||
      /[\u0000-\u001f\u007f]/.test(id) ||
      seen.has(id)
    )
      continue;
    seen.add(id);
    models.push({ id, label: id });
    if (models.length >= LOCAL_MODEL_LIMIT) break;
  }
  if (!models.length)
    throw new SettingsValidationError(
      "The local server returned no usable model IDs.",
    );
  return models;
}

async function configureLocalProvider({ baseUrl, apiKey = "" } = {}) {
  const normalizedBaseUrl = normalizeLocalBaseUrl(baseUrl);
  const normalizedApiKey = String(apiKey || "").trim();
  if (normalizedApiKey.length > 4096 || /[\r\n\0]/.test(normalizedApiKey))
    throw new SettingsValidationError("The optional local API key is invalid.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const existingLocal = localServerConfig(config);
  let effectiveApiKey = normalizedApiKey;
  let protectedApiKey = null;
  if (
    !effectiveApiKey &&
    existingLocal?.baseUrl === normalizedBaseUrl &&
    existingLocal.protectedApiKey
  ) {
    effectiveApiKey = unprotectSecret(existingLocal.protectedApiKey);
    protectedApiKey = existingLocal.protectedApiKey;
  }
  let response;
  try {
    const headers = { Accept: "application/json" };
    if (effectiveApiKey) headers.Authorization = `Bearer ${effectiveApiKey}`;
    response = await fetch(`${normalizedBaseUrl}/models`, {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError")
      throw new SettingsValidationError("The local model server timed out.");
    throw new SettingsValidationError(
      "Open Bot could not reach that local model server.",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok)
    throw new SettingsValidationError(
      `The local model server rejected model discovery (${response.status}).`,
    );
  let parsed;
  try {
    parsed = JSON.parse(
      await readBoundedText(response, LOCAL_MODELS_RESPONSE_LIMIT),
    );
  } catch (error) {
    if (error instanceof SettingsValidationError) throw error;
    throw new SettingsValidationError(
      "The local model server returned invalid JSON.",
    );
  }
  const models = normalizeDiscoveredModels(parsed);
  if (normalizedApiKey) protectedApiKey = protectSecret(normalizedApiKey);
  const localServer = {
    baseUrl: normalizedBaseUrl,
    models,
    ...(protectedApiKey ? { protectedApiKey } : {}),
  };
  const nextConfig = {
    ...config,
    mode: "local",
    provider: LOCAL_PROVIDER_ID,
    localServer,
  };
  writePreferences(
    nextConfig,
    {
      model: models[0].id,
      reasoningEffort: "none",
      fastMode: false,
    },
    LOCAL_PROVIDER_ID,
  );
  return publicStatus();
}

function setApiKey(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (normalized.length < 20)
    throw new Error("Enter a complete OpenAI API key.");
  const previous = safeJson(CONFIG_PATH, {});
  const config = plainObject(previous) ? previous : {};
  const defaults = storedDefaults(config, DEFAULT_PROVIDER_ID);
  writePreferences(
    {
      ...config,
      mode: "api-key",
      protectedApiKey: protectSecret(normalized),
      provider: DEFAULT_PROVIDER_ID,
    },
    defaults,
    DEFAULT_PROVIDER_ID,
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

async function readBoundedResponseText(response, limit = IMAGE_RESPONSE_LIMIT) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new Error("OpenAI returned an image response larger than allowed.");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > limit)
      throw new Error("OpenAI returned an image response larger than allowed.");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(
          "OpenAI returned an image response larger than allowed.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function imageCapability() {
  const config = state().config || {};
  const available =
    config.mode === "api-key" && Boolean(config.protectedApiKey);
  return {
    available,
    model: IMAGE_MODEL,
    sizes: [...IMAGE_SIZES],
    qualities: [...IMAGE_QUALITIES],
    reason: available
      ? null
      : "GPT Image 2 requires a direct OpenAI API key. A Codex subscription login does not grant Images API access.",
  };
}

async function generateImage(request, fetchImpl = fetch) {
  if (!plainObject(request))
    throw new SettingsValidationError("Image request must be a JSON object.");
  const allowed = new Set(["prompt", "size", "quality"]);
  const unknown = Object.keys(request).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new SettingsValidationError(`Unknown image field: ${unknown[0]}.`);
  const prompt = String(request.prompt || "").trim();
  if (!prompt || prompt.length > IMAGE_PROMPT_LIMIT)
    throw new SettingsValidationError(
      `prompt must be between 1 and ${IMAGE_PROMPT_LIMIT} characters.`,
    );
  const size = request.size || "1024x1024";
  const quality = request.quality || "medium";
  if (!IMAGE_SIZES.includes(size))
    throw new SettingsValidationError(
      `size must be one of: ${IMAGE_SIZES.join(", ")}.`,
    );
  if (!IMAGE_QUALITIES.includes(quality))
    throw new SettingsValidationError(
      `quality must be one of: ${IMAGE_QUALITIES.join(", ")}.`,
    );
  const connection = getConnection();
  if (connection.route !== "openai-api-key")
    throw new SettingsValidationError(imageCapability().reason);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let response;
  let raw;
  try {
    response = await fetchImpl("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size, quality }),
      signal: controller.signal,
    });
    raw = await readBoundedResponseText(response);
  } catch (error) {
    if (error?.name === "AbortError")
      throw new Error("GPT Image 2 timed out. Try again.");
    if (/^OpenAI returned an image response larger/.test(error?.message || ""))
      throw error;
    throw new Error("GPT Image 2 could not be reached. Try again.");
  } finally {
    clearTimeout(timeout);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned an unreadable image response.");
  }
  if (!response.ok) {
    const detail = redactSensitiveText(
      String(
        payload?.error?.message ||
          `OpenAI image request failed (${response.status}).`,
      ),
    );
    throw new Error(detail.slice(0, 500));
  }
  const base64 = payload?.data?.[0]?.b64_json;
  if (
    typeof base64 !== "string" ||
    base64.length < 16 ||
    base64.length > IMAGE_RESPONSE_LIMIT * 2 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  )
    throw new Error("OpenAI did not return a valid image.");
  const imageBytes = Buffer.from(base64, "base64");
  if (
    imageBytes.length < 16 ||
    imageBytes.length > IMAGE_RESPONSE_LIMIT ||
    !imageBytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw new Error("OpenAI did not return a valid PNG image.");
  return {
    model: IMAGE_MODEL,
    size,
    quality,
    dataUrl: `data:image/png;base64,${base64}`,
  };
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

function normalizeProviderLoginUrl(providerId, value) {
  if (providerId === "codex") return normalizeCodexDeviceUrl(value);
  try {
    const candidate = new URL(String(value || ""));
    if (
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password ||
      candidate.port ||
      candidate.hash
    )
      return null;
    const rules = {
      claude: ["claude.ai", "/oauth/authorize"],
      antigravity: ["accounts.google.com", "/o/oauth2/v2/auth"],
      kimi: ["www.kimi.com", "/code/authorize_device"],
      xai: ["accounts.x.ai", "/oauth2/device"],
    };
    const rule = rules[providerId];
    if (!rule || candidate.hostname !== rule[0]) return null;
    if (rule[1] && candidate.pathname.replace(/\/+$/, "") !== rule[1])
      return null;
    if (!rule[1] && (!candidate.pathname || candidate.pathname === "/"))
      return null;
    return candidate.toString();
  } catch {
    return null;
  }
}

function providerLoginOutput(providerId, output) {
  const provider = providerFor(providerId);
  if (!provider || provider.loginKind === "service-account") return null;
  const rawUrl =
    providerId === "codex"
      ? output.match(/Codex device URL:\s*(https:\/\/\S+)/i)?.[1]
      : providerId === "kimi" || providerId === "xai"
        ? output.match(/To authenticate, please visit:\s*(https:\/\/\S+)/i)?.[1]
        : output.match(
            /Visit the following URL to continue authentication:\s*(https:\/\/\S+)/i,
          )?.[1];
  const url = normalizeProviderLoginUrl(providerId, rawUrl);
  if (!rawUrl) return null;
  if (!url)
    throw new Error(
      `${provider.label} sign-in returned an unexpected page. Only the reviewed official provider page is allowed.`,
    );
  const code =
    providerId === "codex"
      ? output.match(
          /Codex device code:\s*([A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?)/i,
        )?.[1]
      : output.match(
          /(?:User code:|Then enter this code:)\s*([A-Z0-9-]{4,32})/i,
        )?.[1];
  if (providerId === "codex" && !code) return null;
  return {
    provider: provider.id,
    providerLabel: provider.label,
    url,
    code: code ? code.toUpperCase() : null,
    message: code
      ? `Open the official ${provider.label} page and enter this one-time code.`
      : `Finish ${provider.label} sign-in in the official provider page.`,
  };
}

function cliProxyConfiguration() {
  const executable = process.env.GROK_BOT_CLIPROXY_EXE;
  const config = process.env.GROK_BOT_CLIPROXY_CONFIG;
  if (!executable || !config)
    throw new Error("CLIProxyAPI is not configured for this installation.");
  if (!fs.existsSync(executable))
    throw new Error("CLIProxyAPI executable was not found.");
  return { executable, config };
}

function beginProviderLogin(value) {
  const providerId = normalizeProviderId(value);
  const provider = providerFor(providerId);
  if (!provider.loginFlag)
    throw new SettingsValidationError(
      "Local models use endpoint discovery instead of provider sign-in.",
    );
  if (provider.loginKind === "service-account")
    throw new SettingsValidationError(
      "Google Vertex AI requires a service-account JSON import.",
    );
  const { executable, config } = cliProxyConfiguration();
  const previousCredential = newestProviderAuth(providerId);
  const previousCredentialRevision = previousCredential
    ? Math.max(0, Math.floor(previousCredential.modifiedMs))
    : null;

  const active = globalThis[OAUTH_KEY];
  if (active?.child && !active.child.killed && active.child.exitCode === null) {
    if (active.providerId === providerId) return active.promise;
    active.child.kill();
  }

  // A fresh callback origin prevents Chrome from restoring a cached localhost
  // success page from an earlier OAuth state. Keep this below Windows' default
  // dynamic client-port range; CLIProxyAPI still owns the actual bind check.
  const callbackPort =
    providerId === "antigravity" ? crypto.randomInt(41_000, 49_000) : null;
  const child = childProcess.spawn(
    executable,
    [
      provider.loginFlag,
      "-no-browser",
      ...(callbackPort ? ["-oauth-callback-port", String(callbackPort)] : []),
      "-config",
      config,
    ],
    {
      detached: false,
      // Keep stdin open while the user finishes the browser flow. CLIProxyAPI
      // can fall back to an interactive callback prompt; immediate EOF makes
      // that prompt terminate before the credential is saved.
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const session = {
    child,
    providerId,
    providerLabel: provider.label,
    previousCredentialRevision,
    state: "starting",
    message: `Preparing ${provider.label} sign-in...`,
    output: "",
    promise: null,
  };
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      let result;
      try {
        result = providerLoginOutput(providerId, session.output);
      } catch (error) {
        settled = true;
        clearTimeout(timeout);
        child.kill();
        session.state = "error";
        session.message = redactSensitiveText(error.message).slice(0, 500);
        reject(error);
        return;
      }
      if (!result) return;
      settled = true;
      clearTimeout(timeout);
      session.state = "waiting";
      session.message = result.message;
      resolve({ ...result, previousCredentialRevision });
    };
    const append = (chunk) => {
      session.output = `${session.output}${String(chunk || "")}`.slice(-16_000);
      finish();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => {
      session.state = "error";
      session.message = `${provider.label} sign-in failed locally: ${redactSensitiveText(error.message).slice(0, 300)}`;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      session.exitCode = code;
      reconcileProviderLoginSession(session);
      if (session.state === "waiting" || session.state === "starting") {
        if (settled && code === 0) {
          session.state = "settling";
          session.settleDeadlineAt = Date.now() + PROVIDER_LOGIN_SETTLE_MS;
          session.message = `Finishing ${provider.label} connection locally...`;
        } else {
          session.state = "error";
          session.message = providerLoginFailureMessage(
            provider,
            session.output,
            code,
          );
        }
      }
      if (!settled) {
        settled = true;
        reject(new Error(session.message));
      }
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      session.state = "error";
      session.message = `${provider.label} sign-in did not issue an authorization page in time. Try again.`;
      reject(new Error(session.message));
    }, 15_000);
  });
  session.promise = promise;
  globalThis[OAUTH_KEY] = session;
  return promise;
}

function providerLoginFailureMessage(provider, _output, code) {
  const output = String(_output || "");
  if (
    provider.id === "antigravity" &&
    /failed to fetch project ID|no project_id in response/i.test(output)
  )
    return "Google sign-in succeeded, but Antigravity did not assign this account a cloud project. Confirm this Google account has Antigravity access, finish any required onboarding, then reconnect.";
  if (
    /failed to start callback server|listen tcp|address already in use|bind:/i.test(
      output,
    )
  )
    return `${provider.label} could not start its local browser callback. Close the conflicting app and try again.`;
  if (
    /token exchange failed|oauth2\/token|(?:oauth2\.googleapis\.com|token endpoint)[\s\S]{0,160}(?:i\/o timeout|timed? out)/i.test(
      output,
    )
  )
    return `${provider.label} browser approval finished, but the local token exchange could not reach the provider. Check the connection and try again.`;
  if (/authentication timed out|callback[^\r\n]{0,80}timed? out/i.test(output))
    return `${provider.label} did not receive the browser callback before it expired. Keep the sign-in page open, finish the browser step, then try again.`;
  if (/invalid state/i.test(output))
    return `${provider.label} received a callback from an older sign-in attempt. Close stale provider tabs and try the new sign-in page again.`;
  return `${provider.label} sign-in did not finish locally after the browser step (exit ${code ?? "unknown"}). Check that the local callback port is available, then try again.`;
}

function reconcileProviderLoginSession(session = globalThis[OAUTH_KEY]) {
  if (!session || !["starting", "waiting", "settling"].includes(session.state))
    return session;
  const credential = newestProviderAuth(session.providerId);
  const revision = credential
    ? Math.max(0, Math.floor(credential.modifiedMs))
    : null;
  if (revision == null || revision === session.previousCredentialRevision) {
    if (
      session.state === "settling" &&
      Date.now() >= Number(session.settleDeadlineAt || 0)
    ) {
      session.state = "error";
      session.message = providerLoginFailureMessage(
        providerFor(session.providerId),
        session.output,
        session.exitCode,
      );
    }
    return session;
  }
  session.state = "connected";
  session.message = `${session.providerLabel} connected. Models and reasoning controls are now updated for this provider.`;
  setProvider(session.providerId);
  return session;
}

function providerLoginStatus() {
  const session = reconcileProviderLoginSession();
  if (!session) return null;
  return {
    provider: session.providerId,
    providerLabel: session.providerLabel,
    state: session.state,
    message: session.message,
  };
}

function cancelProviderLogin(value) {
  const providerId = normalizeProviderId(value);
  const active = globalThis[OAUTH_KEY];
  if (!active || !["starting", "waiting", "settling"].includes(active.state))
    return { cancelled: false, provider: providerId };
  if (active.providerId !== providerId)
    throw new SettingsValidationError(
      `No ${providerFor(providerId).label} sign-in is currently active.`,
    );
  active.state = "cancelled";
  active.message = `${active.providerLabel} sign-in cancelled.`;
  if (active.child && !active.child.killed && active.child.exitCode === null)
    active.child.kill();
  return { cancelled: true, provider: providerId };
}

function beginCodexOAuth() {
  return beginProviderLogin(DEFAULT_PROVIDER_ID);
}

function validateVertexServiceAccount(value) {
  if (!plainObject(value))
    throw new SettingsValidationError(
      "Choose a Google service-account JSON key file.",
    );
  const required = ["project_id", "client_email", "private_key"];
  for (const key of required) {
    if (typeof value[key] !== "string" || !value[key].trim())
      throw new SettingsValidationError(
        `The Vertex service-account key is missing ${key}.`,
      );
  }
  if (
    hasOwn(value, "type") &&
    String(value.type || "").trim() !== "service_account"
  )
    throw new SettingsValidationError(
      'The Vertex key type must be "service_account".',
    );
  if (
    hasOwn(value, "token_uri") &&
    value.token_uri !== "https://oauth2.googleapis.com/token"
  )
    throw new SettingsValidationError(
      "The Vertex key has an unexpected OAuth token endpoint.",
    );
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 512_000)
    throw new SettingsValidationError(
      "The Vertex service-account key is unexpectedly large.",
    );
  return serialized;
}

async function importVertexServiceAccount(value) {
  const serialized = validateVertexServiceAccount(value);
  const { executable, config } = cliProxyConfiguration();
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  const temporary = path.join(
    STATE_ROOT,
    `.vertex-import-${process.pid}-${crypto.randomBytes(8).toString("hex")}.json`,
  );
  fs.writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    const output = await new Promise((resolve, reject) => {
      const child = childProcess.spawn(
        executable,
        ["-vertex-import", temporary, "-config", config],
        {
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let captured = "";
      let settled = false;
      const append = (chunk) => {
        captured = `${captured}${String(chunk || "")}`.slice(-64_000);
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
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (
          code !== 0 ||
          !/Vertex credentials imported:\s*[^\r\n]+/i.test(captured)
        ) {
          reject(
            new Error(
              "CLIProxyAPI could not import that Vertex service-account key.",
            ),
          );
          return;
        }
        resolve(captured);
      });
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error("Vertex credential import timed out."));
      }, 30_000);
    });
    void output;
    if (!newestProviderAuth("vertex"))
      throw new Error(
        "CLIProxyAPI finished without installing Vertex credentials.",
      );
    setProvider("vertex");
    return publicStatus();
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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
  const login = providerLoginStatus();
  const preferences = getPreferences(agentId);
  const connection = getConnection(preferences.agentId);
  const provider = providerFor(preferences.provider);
  const activeAccount = account(preferences.provider);
  const primaryAccount = account("codex");
  const namedAccount = primaryAccount.signedIn
    ? primaryAccount
    : activeAccount.signedIn && !/ account$/i.test(activeAccount.name || "")
      ? activeAccount
      : null;
  const localUsername = String(os.userInfo().username || "").trim();
  return {
    product: "Open Bot",
    connection: {
      mode: connection.mode,
      route: connection.route,
      provider: connection.provider,
      providerLabel: connection.providerLabel,
      model: connection.model,
      reasoningEffort: connection.reasoningEffort,
      fastMode: connection.fastMode,
      responseMode: connection.responseMode,
    },
    account: activeAccount,
    owner: {
      name: namedAccount?.name || localUsername || "Open Bot user",
      email: namedAccount?.email || null,
      avatarUrl: namedAccount?.avatarUrl || null,
    },
    providers: providerConnections(),
    providerLogin: login,
    usage: usage(),
    settings: {
      automaticUpdates: false,
      maxBrowserSeats: Number(process.env.GROK_BOT_BROWSER_SEAT_LIMIT || 3),
      alwaysOn: {
        workerActive: process.env.GROK_BOT_LOCAL_ROUTINES === "1",
        catchupHours: 24,
        restartAttempts: 10,
      },
    },
    images: imageCapability(),
    preferences: {
      catalog: {
        models: modelsFor(provider.id).map((model) => ({ ...model })),
        reasoningEfforts: [...provider.reasoningEfforts],
        fastMode: {
          supported: provider.fastModeSupported,
          default: provider.fastModeSupported ? DEFAULT_FAST_MODE : false,
        },
        responseModes: [...RESPONSE_MODES],
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
  CLIPROXY_PROVIDERS,
  MODEL_CATALOG,
  REASONING_EFFORTS,
  RESPONSE_MODES,
  SettingsValidationError,
  account,
  applySettingsUpdate,
  beginCodexOAuth,
  beginProviderLogin,
  cancelProviderLogin,
  configureLocalProvider,
  clearAgentPreferences,
  getConnection,
  getPreferences,
  generateImage,
  imageCapability,
  publicStatus,
  importVertexServiceAccount,
  setAgentPreferences,
  setApiKey,
  setDefaultPreferences,
  setMode,
  setProvider,
  useProvider,
  usage,
  verifyApiKey,
  normalizeCodexDeviceUrl,
  normalizeLocalBaseUrl,
  normalizeProviderLoginUrl,
  providerLoginOutput,
  providerLoginStatus,
  publicOriginForLog,
  redactError,
  redactLogDetails,
  redactSensitiveText,
};
