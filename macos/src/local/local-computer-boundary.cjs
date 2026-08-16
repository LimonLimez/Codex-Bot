"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_ID_PATTERN = /^grant-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^permission-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["local", "cursor", "not-now"]);
const DECISIONS = new Set(["deny", "once", "always"]);
const MODE_FIELDS = new Set(["botId", "mode"]);
const DECISION_FIELDS = new Set([
  "requestId", "botId", "targetId", "targetGeneration", "decision",
]);
const REVOKE_FIELDS = new Set(["botId", "grantId"]);

class LocalComputerBoundaryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalComputerBoundaryError";
    this.code = code;
  }
}

function boundaryError(message, code) {
  return new LocalComputerBoundaryError(message, code);
}

function safeUUID(makeUUID) {
  let value;
  try { value = makeUUID(); } catch {
    throw boundaryError("Computer identity could not be created.", "OPENBOT_COMPUTER_IDENTITY_FAILED");
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw boundaryError("Computer identity could not be created.", "OPENBOT_COMPUTER_IDENTITY_FAILED");
  }
  return value.toLowerCase();
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) {
    throw boundaryError("Computer bot ID is invalid.", "OPENBOT_COMPUTER_REQUEST_INVALID");
  }
  return value.toLowerCase();
}

function clonePlainObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw boundaryError(`${label} must be a plain request.`, "OPENBOT_COMPUTER_REQUEST_INVALID");
  }
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw boundaryError(`${label} must be a plain request.`, "OPENBOT_COMPUTER_REQUEST_INVALID");
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key) || !("value" in descriptors[key]))) {
    throw boundaryError(`${label} must be a plain request.`, "OPENBOT_COMPUTER_REQUEST_INVALID");
  }
  const copy = {};
  for (const field of fields) {
    if (!descriptors[field]) {
      throw boundaryError(`${label} must be a plain request.`, "OPENBOT_COMPUTER_REQUEST_INVALID");
    }
    copy[field] = descriptors[field].value;
  }
  return copy;
}

function normalizeModeRequest(value) {
  const input = clonePlainObject(value, MODE_FIELDS, "Computer selection");
  if (!MODES.has(input.mode)) {
    throw boundaryError("Computer mode is invalid.", "OPENBOT_COMPUTER_REQUEST_INVALID");
  }
  return { botId: normalizeBotId(input.botId), mode: input.mode };
}

function normalizeDecision(value) {
  const input = clonePlainObject(value, DECISION_FIELDS, "Permission decision");
  if (typeof input.requestId !== "string" || !REQUEST_ID_PATTERN.test(input.requestId)
    || typeof input.targetId !== "string" || !TARGET_ID_PATTERN.test(input.targetId)
    || !Number.isSafeInteger(input.targetGeneration) || input.targetGeneration < 0
    || !DECISIONS.has(input.decision)) {
    throw boundaryError("Permission decision is invalid.", "OPENBOT_COMPUTER_REQUEST_INVALID");
  }
  return Object.freeze({
    requestId: input.requestId.toLowerCase(),
    botId: normalizeBotId(input.botId),
    targetId: input.targetId.toLowerCase(),
    targetGeneration: input.targetGeneration,
    decision: input.decision,
  });
}

function normalizeRevoke(value) {
  const input = clonePlainObject(value, REVOKE_FIELDS, "Permission revocation");
  if (typeof input.grantId !== "string" || !GRANT_ID_PATTERN.test(input.grantId)) {
    throw boundaryError("Permission grant is invalid.", "OPENBOT_COMPUTER_REQUEST_INVALID");
  }
  return { botId: normalizeBotId(input.botId), grantId: input.grantId.toLowerCase() };
}

function timestamp(now) {
  let value;
  try { value = now(); } catch {
    throw boundaryError("Computer time source failed.", "OPENBOT_COMPUTER_TIME_FAILED");
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw boundaryError("Computer time source failed.", "OPENBOT_COMPUTER_TIME_FAILED");
  }
  return value;
}

function freezeClone(value, seen = new Map(), depth = 0) {
  if (depth > 16) throw boundaryError("Computer result is unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw boundaryError("Computer result is unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw boundaryError("Computer result is unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
  }
  const array = Array.isArray(value);
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw boundaryError("Computer result is unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
  }
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !("value" in descriptors[key])
      || /(?:bookmark|path|endpoint|password|secret|token|url)/i.test(key))) {
    throw boundaryError("Computer result is unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw boundaryError("Computer result is unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
    }
  }
  const copy = array ? [] : {};
  seen.set(value, copy);
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = freezeClone(descriptors[key].value, seen, depth + 1);
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function publicState(record) {
  if (!record || typeof record !== "object" || typeof record.botId !== "string"
    || !record.computer || typeof record.computer !== "object") {
    throw boundaryError("Computer state is unavailable.", "OPENBOT_COMPUTER_UNAVAILABLE");
  }
  return freezeClone({ botId: record.botId, computer: record.computer });
}

function publicPermissions(botId, permissions) {
  if (!Array.isArray(permissions)) {
    throw boundaryError("Computer permissions are unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
  }
  return freezeClone({ botId, permissions });
}

function publicPermissionRequests(botId, requests) {
  if (!Array.isArray(requests) || requests.length > 32) {
    throw boundaryError("Computer permission requests are unavailable.", "OPENBOT_COMPUTER_RESULT_INVALID");
  }
  return freezeClone({ botId, requests });
}

function sameComputer(left, right) {
  return Boolean(left && right
    && left.mode === right.mode
    && left.generation === right.generation
    && left.localProfileId === right.localProfileId
    && left.nativeAgentId === right.nativeAgentId);
}

class LocalComputerBoundary extends EventEmitter {
  #store;
  #manager;
  #broker;
  #now;
  #randomUUID;
  #queues = new Map();
  #disposePromise = null;
  #disposed = false;
  #onPermission;

  constructor({ store, manager, broker, now = () => new Date().toISOString(), randomUUID = crypto.randomUUID } = {}) {
    super();
    if (!store || typeof store.read !== "function" || typeof store.updateComputer !== "function"
      || !manager || typeof manager.open !== "function" || typeof manager.close !== "function"
      || typeof manager.dispose !== "function"
      || !broker || typeof broker.decide !== "function" || typeof broker.list !== "function"
      || typeof broker.listPending !== "function"
      || typeof broker.revoke !== "function" || typeof broker.dispose !== "function"
      || typeof now !== "function" || typeof randomUUID !== "function") {
      throw new TypeError("Local Computer boundary dependencies are invalid.");
    }
    this.#store = store;
    this.#manager = manager;
    this.#broker = broker;
    this.#now = now;
    this.#randomUUID = randomUUID;
    this.#onPermission = (value) => {
      if (this.#disposed) return;
      try { this.emit("permission-requested", freezeClone(value)); } catch {}
    };
    broker.on?.("request", this.#onPermission);
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {}
    }
    return true;
  }

  async selectMode(value) {
    this.#assertActive();
    const request = normalizeModeRequest(value);
    return this.#enqueue(request.botId, async () => {
      this.#assertActive();
      const record = await this.#requiredBot(request.botId);
      this.#assertActive();
      const generation = record.computer.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        throw boundaryError("Computer generation is exhausted.", "OPENBOT_COMPUTER_GENERATION_EXHAUSTED");
      }
      if (request.mode === "local") return this.#selectLocal(record, generation);
      await this.#manager.close(request.botId);
      this.#assertActive();
      const next = request.mode === "cursor"
        ? {
          mode: "cursor",
          generation,
          localProfileId: record.computer.localProfileId,
          nativeAgentId: record.computer.nativeAgentId || `cursor-${safeUUID(this.#randomUUID)}`,
          state: "unavailable",
          lastConfirmedAt: null,
          lastErrorCode: "CURSOR_ACCOUNT_REQUIRED",
        }
        : {
          mode: "not-now",
          generation,
          localProfileId: record.computer.localProfileId,
          nativeAgentId: record.computer.nativeAgentId,
          state: "unconfigured",
          lastConfirmedAt: null,
          lastErrorCode: null,
        };
      try {
        return await this.#persistAndPublish(request.botId, next);
      } catch (error) {
        if (record.computer.mode === "local" && record.computer.state === "ready") {
          try { await this.#manager.open(record); } catch {}
        }
        throw error;
      }
    });
  }

  async read(botId) {
    this.#assertActive();
    return publicState(await this.#requiredBot(normalizeBotId(botId)));
  }

  async decidePermission(value) {
    this.#assertActive();
    const decision = normalizeDecision(value);
    await this.#broker.decide(decision);
    this.#assertActive();
    return this.listPermissions(decision.botId);
  }

  async listPermissions(botId) {
    this.#assertActive();
    const normalizedBotId = normalizeBotId(botId);
    return publicPermissions(normalizedBotId, await this.#broker.list(normalizedBotId));
  }

  async listPermissionRequests(botId) {
    this.#assertActive();
    const normalizedBotId = normalizeBotId(botId);
    return publicPermissionRequests(normalizedBotId, await this.#broker.listPending(normalizedBotId));
  }

  async revokePermission(value) {
    this.#assertActive();
    const revoke = normalizeRevoke(value);
    await this.#broker.revoke(revoke);
    this.#assertActive();
    return this.listPermissions(revoke.botId);
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#broker.off?.("request", this.#onPermission);
    this.#queues.clear();
    this.removeAllListeners();
    this.#disposePromise = (async () => {
      try { await this.#manager.dispose(); } catch {}
      try { await this.#broker.dispose(); } catch {}
    })();
    return this.#disposePromise;
  }

  async #selectLocal(record, generation) {
    const localProfileId = record.computer.localProfileId || `local-${safeUUID(this.#randomUUID)}`;
    const starting = {
      mode: "local",
      generation,
      localProfileId,
      nativeAgentId: record.computer.nativeAgentId,
      state: "starting",
      lastConfirmedAt: null,
      lastErrorCode: null,
    };
    const persistedStarting = await this.#persistAndPublish(record.botId, starting);
    const ready = {
      ...starting,
      state: "ready",
      lastConfirmedAt: timestamp(this.#now),
    };
    let opened = false;
    try {
      await this.#manager.open({ ...record, computer: ready });
      opened = true;
      this.#assertActive();
      const current = await this.#requiredBot(record.botId);
      if (!sameComputer(current.computer, persistedStarting.computer)
        || current.computer.state !== "starting") {
        await this.#manager.close(record.botId);
        throw boundaryError("Computer selection was superseded.", "OPENBOT_COMPUTER_SUPERSEDED");
      }
      return await this.#persistAndPublish(record.botId, ready);
    } catch (error) {
      if (error instanceof LocalComputerBoundaryError && error.code === "OPENBOT_COMPUTER_SUPERSEDED") throw error;
      if (opened) {
        try { await this.#manager.close(record.botId); } catch {}
      }
      try {
        const current = await this.#requiredBot(record.botId);
        if (sameComputer(current.computer, starting) && current.computer.state === "starting") {
          await this.#persistAndPublish(record.botId, {
            ...starting,
            state: "unavailable",
            lastErrorCode: "OPENBOT_LOCAL_DESKTOP_START_FAILED",
          });
        }
      } catch {}
      throw boundaryError("Local Computer could not start.", "OPENBOT_COMPUTER_START_FAILED");
    }
  }

  async #requiredBot(botId) {
    let record;
    try { record = await this.#store.read(botId); } catch {
      throw boundaryError("Computer state is unavailable.", "OPENBOT_COMPUTER_UNAVAILABLE");
    }
    if (!record || record.botId !== botId || !record.computer) {
      throw boundaryError("Computer state is unavailable.", "OPENBOT_COMPUTER_UNAVAILABLE");
    }
    return record;
  }

  async #persistAndPublish(botId, computer) {
    this.#assertActive();
    let record;
    try { record = await this.#store.updateComputer(botId, computer); } catch {
      throw boundaryError("Computer state could not be saved.", "OPENBOT_COMPUTER_PERSIST_FAILED");
    }
    this.#assertActive();
    const state = publicState(record);
    this.emit("changed", state);
    return state;
  }

  #enqueue(botId, operation) {
    const previous = this.#queues.get(botId) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#queues.set(botId, tail);
    void tail.then(() => {
      if (this.#queues.get(botId) === tail) this.#queues.delete(botId);
    });
    return result;
  }

  #assertActive() {
    if (this.#disposed) {
      throw boundaryError("Local Computer boundary is disposed.", "OPENBOT_COMPUTER_DISPOSED");
    }
  }
}

module.exports = {
  LocalComputerBoundary,
  LocalComputerBoundaryError,
};
