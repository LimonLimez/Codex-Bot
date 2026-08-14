"use strict";

const crypto = require("node:crypto");

const BOT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"]);
const REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
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
  if (typeof value.model !== "string" || !MODEL_IDS.has(value.model)) fail();
  if (
    typeof value.reasoningEffort !== "string" ||
    !REASONING_EFFORTS.has(value.reasoningEffort)
  ) {
    fail();
  }

  const config = {
    botId: value.botId,
    generation: value.generation,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
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
