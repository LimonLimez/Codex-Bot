"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BOT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_EFFORTS = Object.freeze({
  "gpt-5.6-sol": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-terra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.5": Object.freeze(["low", "medium", "high", "xhigh"]),
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

function loadRuntimeConfig(environment = process.env) {
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
    const selection = registry?.selections?.[activeBotId];
    if (registry?.schemaVersion !== 1
      || typeof activeBotId !== "string"
      || !activeBotId.startsWith("bot-")
      || !BOT_UUID.test(activeBotId.slice(4))
      || !selection || typeof selection !== "object" || Array.isArray(selection)) {
      fail();
    }
    return createRuntimeConfig({
      botId: activeBotId.slice(4),
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
