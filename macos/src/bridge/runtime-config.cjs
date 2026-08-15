"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BOT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_EFFORTS = Object.freeze({
  "gpt-5.6-sol": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-terra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-luna": Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  "gpt-5.5": Object.freeze(["low", "medium", "high", "xhigh"]),
  "gpt-5.4": Object.freeze(["low", "medium", "high", "xhigh"]),
  "gpt-5.4-mini": Object.freeze(["low", "medium", "high", "xhigh"]),
  "gpt-5.3-codex-spark": Object.freeze(["low", "medium", "high", "xhigh"]),
  "claude-fable-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-opus-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-sonnet-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
});
const CONFIG_KEYS = Object.freeze([
  "botId",
  "generation",
  "endpoint",
  "credential",
  "model",
  "reasoningEffort",
]);
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const INFERENCE_CAPABILITY = /^[a-f0-9]{64}$/;
const SERVICE_TIER = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const OPTIONAL_MODELS = new Set(["claude-fable-5", "claude-opus-5", "claude-sonnet-5"]);

class BridgeConfigError extends Error {
  constructor() {
    super("Codex bridge configuration is invalid.");
    this.name = "BridgeConfigError";
    this.code = "CODEX_BRIDGE_CONFIG_INVALID";
  }
}

function fail() {
  throw new BridgeConfigError();
}

function exactPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    fail();
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  if (prototype !== Object.prototype || keys.some((key) => typeof key !== "string")) {
    fail();
  }
  const names = keys;
  if (
    names.length !== CONFIG_KEYS.length ||
    CONFIG_KEYS.some((key) => !names.includes(key))
  ) {
    fail();
  }
}

function normalizeEndpoint(value) {
  if (typeof value !== "string" || value.trim() !== value) fail();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail();
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/v1" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^\d+$/.test(parsed.port)
  ) {
    fail();
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail();
  const canonical = `http://127.0.0.1:${port}/v1`;
  if (value !== canonical) fail();
  return canonical;
}

function normalizeCredential(value) {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 256 ||
    value.trim() !== value ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    fail();
  }
  return value;
}

function normalizeInferenceEndpoint(value) {
  if (typeof value !== "string" || value.trim() !== value) fail();
  let parsed;
  try { parsed = new URL(value); } catch { fail(); }
  if (parsed.protocol !== "tcp:" || parsed.hostname !== "127.0.0.1"
    || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== ""
    || parsed.search !== "" || parsed.hash !== "" || !/^\d+$/.test(parsed.port)) fail();
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || value !== `tcp://127.0.0.1:${port}`) fail();
  return value;
}

function createInferenceRuntimeConfig({
  botId,
  generation,
  endpoint,
  credential,
  provider,
  model,
  reasoningEffort,
  serviceTier = null,
}) {
  if (typeof botId !== "string" || !BOT_UUID.test(botId)
    || !Number.isSafeInteger(generation) || generation < 0) fail();
  if (!new Set(["openai-codex", "cliproxy-anthropic"]).has(provider)
    || typeof model !== "string" || !MODEL_ID.test(model)
    || typeof reasoningEffort !== "string" || !EFFORT.test(reasoningEffort)
    || (reasoningEffort === "ultra-code" && provider !== "cliproxy-anthropic")
    || !(serviceTier === null || (typeof serviceTier === "string" && SERVICE_TIER.test(serviceTier)))) fail();
  const config = {
    botId,
    generation,
    provider,
    model,
    reasoningEffort,
    serviceTier,
  };
  Object.defineProperties(config, {
    endpoint: {
      value: normalizeInferenceEndpoint(endpoint),
      enumerable: false,
      configurable: false,
      writable: false,
    },
    credential: {
      value: typeof credential === "string" && INFERENCE_CAPABILITY.test(credential)
        ? credential
        : fail(),
      enumerable: false,
      configurable: false,
      writable: false,
    },
  });
  return Object.freeze(config);
}

function createRuntimeConfig(value) {
  exactPlainObject(value);
  if (typeof value.botId !== "string" || !BOT_UUID.test(value.botId)) fail();
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) fail();
  const efforts = typeof value.model === "string" ? MODEL_EFFORTS[value.model] : null;
  if (!efforts) fail();
  if (
    typeof value.reasoningEffort !== "string" ||
    (value.reasoningEffort !== "none" && !efforts.includes(value.reasoningEffort))
  ) {
    fail();
  }

  const config = {
    botId: value.botId,
    generation: value.generation,
    model: value.model,
    reasoningEffort: value.reasoningEffort === "ultra-code" ? "max" : value.reasoningEffort,
  };
  Object.defineProperties(config, {
    endpoint: {
      value: normalizeEndpoint(value.endpoint),
      enumerable: false,
      configurable: false,
      writable: false,
    },
    credential: {
      value: normalizeCredential(value.credential),
      enumerable: false,
      configurable: false,
      writable: false,
    },
  });
  return Object.freeze(config);
}

function readConversationBindings(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.length > 4096) fail();
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024
      || (stat.mode & 0o077) !== 0) fail();
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.schemaVersion !== 1 || !parsed.bindings || typeof parsed.bindings !== "object"
      || Array.isArray(parsed.bindings)) fail();
    const bindings = Object.create(null);
    for (const [conversationId, botId] of Object.entries(parsed.bindings)) {
      if (!CONVERSATION_ID.test(conversationId) || typeof botId !== "string"
        || !botId.startsWith("bot-") || !BOT_UUID.test(botId.slice(4))) fail();
      bindings[conversationId] = botId;
    }
    return { schemaVersion: 1, bindings };
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, bindings: Object.create(null) };
    if (error instanceof BridgeConfigError) throw error;
    fail();
  }
}

function writeConversationBindings(file, state) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail();
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (error instanceof BridgeConfigError) throw error;
    fail();
  }
}

function selectedBotId(environment, registry, options) {
  const conversationId = options?.conversationId;
  if (conversationId == null) return registry.activeBotId;
  if (typeof conversationId !== "string" || !CONVERSATION_ID.test(conversationId)) fail();
  const file = environment.CODEX_BOT_CONVERSATION_BINDINGS;
  const state = readConversationBindings(file);
  const retained = state.bindings[conversationId];
  if (retained) return retained;
  state.bindings[conversationId] = registry.activeBotId;
  writeConversationBindings(file, state);
  return registry.activeBotId;
}

function loadRuntimeConfig(environment = process.env, options = {}) {
  if (environment == null || typeof environment !== "object") fail();
  if (environment.CODEX_BOT_MODEL_SELECTIONS != null) {
    let file;
    let stat;
    let registry;
    try {
      file = environment.CODEX_BOT_MODEL_SELECTIONS;
      if (typeof file !== "string" || !path.isAbsolute(file) || file.length > 4096) fail();
      stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024
        || (stat.mode & 0o077) !== 0) fail();
      registry = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error instanceof BridgeConfigError) throw error;
      fail();
    }
    const activeBotId = registry?.activeBotId;
    if (registry?.schemaVersion !== 1
      || typeof activeBotId !== "string"
      || !activeBotId.startsWith("bot-")
      || !BOT_UUID.test(activeBotId.slice(4))
      || !registry.selections || typeof registry.selections !== "object"
      || Array.isArray(registry.selections)) {
      fail();
    }
    const selectedBot = selectedBotId(environment, registry, options);
    const selection = registry.selections[selectedBot];
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) fail();
    const hasInferenceBridge = environment.CODEX_BOT_INFERENCE_ENDPOINT !== undefined
      || environment.CODEX_BOT_INFERENCE_CAPABILITY !== undefined;
    if (hasInferenceBridge) {
      return createInferenceRuntimeConfig({
        botId: selectedBot.slice(4),
        generation: selection.generation,
        endpoint: environment.CODEX_BOT_INFERENCE_ENDPOINT,
        credential: environment.CODEX_BOT_INFERENCE_CAPABILITY,
        provider: selection.provider ?? (OPTIONAL_MODELS.has(selection.model)
          ? "cliproxy-anthropic" : "openai-codex"),
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        serviceTier: selection.serviceTier ?? null,
      });
    }
    return createRuntimeConfig({
      botId: selectedBot.slice(4),
      generation: selection.generation,
      endpoint: environment.CODEX_BOT_CLIPROXY_URL,
      credential: environment.CODEX_BOT_CLIPROXY_TOKEN,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    });
  }
  const generation = Number(environment.CODEX_BOT_RUNTIME_GENERATION);
  return createRuntimeConfig({
    botId: environment.CODEX_BOT_ID,
    generation,
    endpoint: environment.CODEX_BOT_CLIPROXY_URL,
    credential: environment.CODEX_BOT_CLIPROXY_TOKEN,
    model: environment.CODEX_BOT_MODEL,
    reasoningEffort: environment.CODEX_BOT_REASONING_EFFORT,
  });
}

function generateCredential() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = {
  BridgeConfigError,
  createRuntimeConfig,
  generateCredential,
  loadRuntimeConfig,
};
