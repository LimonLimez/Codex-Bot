"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { types } = require("node:util");

const { validateProvider } = require("./runtime-provider.cjs");

const BLOCKED_CODE = "REMOTE_PROVIDER_GATE_BLOCKED";
const BLOCKED_MESSAGE = "Remote provider verification is not configured.";
const FAILED_CODE = "REMOTE_PROVIDER_GATE_FAILED";
const FAILED_MESSAGE = "Remote provider verification failed.";
const YOUTUBE_URL = "https://www.youtube.com/";
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function publicError(code, message) {
  const error = new Error(message);
  error.name = "RemoteProviderGateError";
  error.code = code;
  error.stack = `${error.name}: ${message}`;
  return error;
}

function blockedError() {
  return publicError(BLOCKED_CODE, BLOCKED_MESSAGE);
}

function failedError() {
  return publicError(FAILED_CODE, FAILED_MESSAGE);
}

function objectDescriptors(value, label, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw new TypeError(`${label} must contain data fields only.`);
  }
  if (expectedKeys) {
    const actual = [...keys].sort().join(",");
    const expected = [...expectedKeys].sort().join(",");
    if (actual !== expected) throw new TypeError(`${label} has invalid fields.`);
  }
  return descriptors;
}

function privateModulePath(value) {
  try {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw blockedError();
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw blockedError();
    return value;
  } catch {
    throw blockedError();
  }
}

function configuredModule(modulePath, factoryName) {
  try {
    const loaded = require(privateModulePath(modulePath));
    const descriptors = objectDescriptors(loaded, "Remote provider module", [factoryName]);
    const factory = descriptors[factoryName].value;
    if (typeof factory !== "function") throw blockedError();
    return factory.call(loaded);
  } catch {
    throw blockedError();
  }
}

function normalizedExerciseInput(value) {
  const descriptors = objectDescriptors(
    value,
    "Remote computer exercise input",
    ["botId", "runtimeId", "generation", "url"],
  );
  const botId = descriptors.botId.value;
  const runtimeId = descriptors.runtimeId.value;
  const generation = descriptors.generation.value;
  const url = descriptors.url.value;
  if (typeof botId !== "string" || !BOT_ID_PATTERN.test(botId)) throw failedError();
  if (typeof runtimeId !== "string" || !SAFE_IDENTIFIER_PATTERN.test(runtimeId)) throw failedError();
  if (!Number.isSafeInteger(generation) || generation < 1) throw failedError();
  if (url !== YOUTUBE_URL) throw failedError();
  return Object.freeze({ botId: botId.toLowerCase(), runtimeId, generation, url });
}

function normalizedAcknowledgement(value, expected) {
  let descriptors;
  try {
    descriptors = objectDescriptors(value, "Remote computer exercise acknowledgement");
  } catch {
    throw failedError();
  }
  const required = ["accepted", "botId", "runtimeId", "generation", "url"];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    throw failedError();
  }
  if (descriptors.accepted.value !== true
    || descriptors.botId.value !== expected.botId
    || descriptors.runtimeId.value !== expected.runtimeId
    || descriptors.generation.value !== expected.generation
    || descriptors.url.value !== expected.url) {
    throw failedError();
  }
  return Object.freeze({ accepted: true, ...expected });
}

function validateComputerExercise(raw) {
  let descriptors;
  try {
    descriptors = objectDescriptors(
      raw,
      "Remote computer exercise",
      ["openRemoteUrl", "dispose"],
    );
  } catch {
    throw new TypeError("Remote computer exercise is invalid.");
  }
  const openRemoteUrl = descriptors.openRemoteUrl.value;
  const dispose = descriptors.dispose.value;
  if (typeof openRemoteUrl !== "function" || typeof dispose !== "function") {
    throw new TypeError("Remote computer exercise is invalid.");
  }

  let disposed = false;
  return Object.freeze({
    async openRemoteUrl(input) {
      if (disposed) throw failedError();
      let normalized;
      try {
        normalized = normalizedExerciseInput(input);
        const rawResult = await openRemoteUrl.call(raw, normalized);
        return normalizedAcknowledgement(rawResult, normalized);
      } catch (error) {
        if (error?.code === FAILED_CODE) throw error;
        throw failedError();
      }
    },

    async dispose() {
      if (disposed) return undefined;
      disposed = true;
      try {
        await dispose.call(raw);
        return undefined;
      } catch {
        throw failedError();
      }
    },
  });
}

function loadLiveGateDependencies(options) {
  try {
    const descriptors = objectDescriptors(
      options,
      "Remote provider gate configuration",
      ["providerModulePath", "exerciseModulePath"],
    );
    const rawProvider = configuredModule(descriptors.providerModulePath.value, "createProvider");
    const rawExercise = configuredModule(descriptors.exerciseModulePath.value, "createExercise");
    const provider = validateProvider(rawProvider);
    const exercise = validateComputerExercise(rawExercise);
    return Object.freeze({ provider, exercise });
  } catch {
    throw blockedError();
  }
}

module.exports = {
  loadLiveGateDependencies,
  validateComputerExercise,
};
