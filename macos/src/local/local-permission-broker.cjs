"use strict";

const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const MAX_TEXT_BYTES = 512;
const MAX_BOOKMARK_BYTES = 64 * 1024;
const MAX_PENDING_PER_BOT = 32;
const MAX_PENDING_TOTAL = 64;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REQUEST_FIELDS = new Set([
  "botId",
  "targetId",
  "targetGeneration",
  "capability",
  "resourceId",
  "resourceLabel",
  "reason",
]);
const SHELL_REQUEST_FIELDS = new Set([...REQUEST_FIELDS, "command"]);
const DECISION_FIELDS = new Set([
  "requestId",
  "botId",
  "targetId",
  "targetGeneration",
  "decision",
]);
const REVOKE_FIELDS = new Set(["botId", "grantId"]);
const TASK_CONTEXT_FIELDS = new Set(["taskId"]);
const CANCEL_TASK_FIELDS = new Set(["botId", "taskId"]);
const DECISIONS = new Set(["deny", "once", "always"]);
const CAPABILITIES = new Set([
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^permission-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_ID_PATTERN = /^grant-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

class PermissionBrokerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PermissionBrokerError";
    this.code = code;
  }
}

function brokerError(message, code) {
  return new PermissionBrokerError(message, code);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clonePlain(value, seen = new Set()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") throw new TypeError("Permission data must contain plain data values only.");
  if (seen.has(value)) throw new TypeError("Permission data cannot contain cycles.");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Permission data must use plain objects and arrays.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) throw new TypeError("Permission data contains symbol fields.");
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError("Permission data contains a forbidden field.");
    if (!("value" in descriptors[key])) throw new TypeError("Permission data must not contain accessors.");
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw new TypeError("Permission data arrays must be dense.");
    }
  }
  seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = clonePlain(descriptors[key].value, seen);
  }
  seen.delete(value);
  return copy;
}

function cloneInput(value, label) {
  try {
    return clonePlain(value);
  } catch {
    throw new TypeError(`${label} must contain plain data values only.`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key) || !fields.has(key)) throw new Error(`${label} contains an unsupported field.`);
  }
  for (const key of fields) {
    if (!hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) throw new Error("Bot ID is invalid.");
  return value.toLowerCase();
}

function normalizeTargetId(value) {
  if (typeof value !== "string" || !TARGET_ID_PATTERN.test(value)) throw new Error("Local target ID is invalid.");
  return value.toLowerCase();
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Target generation is invalid.");
  return value;
}

function normalizeDisplayText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES
    || /[\0-\x1f\x7f]/.test(value) || /[\\/]/.test(value)
    || /(?:^|\s)(?:file:|~(?:\/|\s|$)|\/Users\/)/i.test(value)) {
    throw new Error(`${label} is invalid or contains private path data.`);
  }
  return value;
}

function normalizeRequest(value) {
  const request = assertPlainObject(cloneInput(value, "Permission request"), "Permission request");
  assertExactKeys(
    request,
    request.capability === "shell.execute" ? SHELL_REQUEST_FIELDS : REQUEST_FIELDS,
    "Permission request",
  );
  if (typeof request.capability !== "string" || !CAPABILITIES.has(request.capability)) {
    throw new Error("Permission capability is invalid.");
  }
  if (typeof request.resourceId !== "string" || !RESOURCE_ID_PATTERN.test(request.resourceId)
    || request.resourceId.includes("..")) {
    throw new Error("Permission resource ID is invalid.");
  }
  if (request.capability === "shell.execute"
    && (typeof request.command !== "string" || request.command.length === 0
      || request.command.includes("\0") || Buffer.byteLength(request.command, "utf8") > 8192)) {
    throw new Error("Shell permission command is invalid.");
  }
  return {
    botId: normalizeBotId(request.botId),
    targetId: normalizeTargetId(request.targetId),
    targetGeneration: normalizeGeneration(request.targetGeneration),
    capability: request.capability,
    resourceId: request.resourceId,
    resourceLabel: normalizeDisplayText(request.resourceLabel, "Permission resource label"),
    reason: normalizeDisplayText(request.reason, "Permission reason"),
    ...(request.capability === "shell.execute" ? { command: request.command } : {}),
  };
}

function normalizeDecision(value) {
  const decision = assertPlainObject(cloneInput(value, "Permission decision"), "Permission decision");
  assertExactKeys(decision, DECISION_FIELDS, "Permission decision");
  if (typeof decision.requestId !== "string" || !REQUEST_ID_PATTERN.test(decision.requestId)) {
    throw new Error("Permission request ID is invalid.");
  }
  if (!DECISIONS.has(decision.decision)) throw new Error("Permission decision is invalid.");
  return {
    requestId: decision.requestId.toLowerCase(),
    botId: normalizeBotId(decision.botId),
    targetId: normalizeTargetId(decision.targetId),
    targetGeneration: normalizeGeneration(decision.targetGeneration),
    decision: decision.decision,
  };
}

function normalizeRevoke(value) {
  const input = assertPlainObject(cloneInput(value, "Permission revocation"), "Permission revocation");
  assertExactKeys(input, REVOKE_FIELDS, "Permission revocation");
  if (typeof input.grantId !== "string" || !GRANT_ID_PATTERN.test(input.grantId)) {
    throw new Error("Permission grant ID is invalid.");
  }
  return { botId: normalizeBotId(input.botId), grantId: input.grantId.toLowerCase() };
}

function normalizeTaskContext(value) {
  if (value === undefined) return null;
  const input = assertPlainObject(cloneInput(value, "Permission task context"), "Permission task context");
  assertExactKeys(input, TASK_CONTEXT_FIELDS, "Permission task context");
  if (typeof input.taskId !== "string" || !TASK_ID_PATTERN.test(input.taskId)) {
    throw new Error("Permission task ID is invalid.");
  }
  return { taskId: input.taskId };
}

function normalizeCancelTask(value) {
  const input = assertPlainObject(cloneInput(value, "Permission task cancellation"), "Permission task cancellation");
  assertExactKeys(input, CANCEL_TASK_FIELDS, "Permission task cancellation");
  if (typeof input.taskId !== "string" || !TASK_ID_PATTERN.test(input.taskId)) {
    throw new Error("Permission task ID is invalid.");
  }
  return { botId: normalizeBotId(input.botId), taskId: input.taskId };
}

function storeRequest(request) {
  return {
    botId: request.botId,
    targetId: request.targetId,
    targetGeneration: request.targetGeneration,
    capability: request.capability,
    resourceId: request.resourceId,
    resourceLabel: request.resourceLabel,
  };
}

function safeUUID(makeUUID) {
  const value = makeUUID();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Generated request UUID is invalid.");
  return value.toLowerCase();
}

function frozenPrompt(requestId, request) {
  return Object.freeze({
    requestId,
    botId: request.botId,
    targetId: request.targetId,
    targetGeneration: request.targetGeneration,
    capability: request.capability,
    resourceLabel: request.resourceLabel,
    reason: request.reason,
    ...(request.capability === "shell.execute"
      ? { command: request.command, allowsAlways: false }
      : {}),
  });
}

function sameDecision(entry, decision) {
  return entry.request.botId === decision.botId
    && entry.request.targetId === decision.targetId
    && entry.request.targetGeneration === decision.targetGeneration;
}

function assertCurrent(request, current) {
  let matches = false;
  try {
    matches = current !== null
      && typeof current === "object"
      && current.botId === request.botId
      && current.computer !== null
      && typeof current.computer === "object"
      && current.computer.mode === "local"
      && current.computer.localProfileId === request.targetId
      && current.computer.generation === request.targetGeneration
      && current.computer.state === "ready";
  } catch {
    matches = false;
  }
  if (!matches) {
    throw brokerError(
      "Permission request is stale or cancelled because the bot Computer changed.",
      "OPENBOT_PERMISSION_STALE",
    );
  }
}

function currentLocalTarget(botId, value) {
  const current = cloneInput(value, "Current Computer");
  if (!current || typeof current !== "object" || current.botId !== botId
    || !current.computer || typeof current.computer !== "object"
    || current.computer.mode !== "local" || current.computer.state !== "ready"
    || typeof current.computer.localProfileId !== "string"
    || !TARGET_ID_PATTERN.test(current.computer.localProfileId)
    || !Number.isSafeInteger(current.computer.generation) || current.computer.generation < 0) {
    return null;
  }
  return {
    targetId: current.computer.localProfileId.toLowerCase(),
    targetGeneration: current.computer.generation,
  };
}

function sameTarget(left, right) {
  return left !== null && right !== null
    && left.targetId === right.targetId
    && left.targetGeneration === right.targetGeneration;
}

function normalizeBookmark(value) {
  const bookmark = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : (value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null);
  if (!bookmark || bookmark.length === 0 || bookmark.length > MAX_BOOKMARK_BYTES) {
    throw brokerError("Selected resource is unavailable.", "OPENBOT_PERMISSION_RESOURCE_UNAVAILABLE");
  }
  return bookmark;
}

function safeFailure(error, message = "Local Computer permission operation failed.") {
  if (error instanceof PermissionBrokerError) return error;
  return brokerError(message, "OPENBOT_PERMISSION_OPERATION_FAILED");
}

class LocalPermissionBroker extends EventEmitter {
  #store;
  #readCurrentComputer;
  #chooseResource;
  #tcc;
  #randomUUID;
  #pending = new Map();
  #taskEpochs = new Map();
  #disposed = false;

  constructor({ store, readCurrentComputer, chooseResource, tcc, randomUUID = crypto.randomUUID } = {}) {
    super();
    if (!store || typeof store.authorize !== "function" || typeof store.remember !== "function"
      || typeof store.revoke !== "function" || typeof store.listPublic !== "function") {
      throw new TypeError("Local permission broker requires a permission store.");
    }
    if (typeof readCurrentComputer !== "function" || typeof chooseResource !== "function") {
      throw new TypeError("Local permission broker requires Computer and resource adapters.");
    }
    if (!tcc || typeof tcc.ensure !== "function") {
      throw new TypeError("Local permission broker requires a TCC adapter.");
    }
    if (typeof randomUUID !== "function") throw new TypeError("Local permission broker UUID source is invalid.");
    this.#store = store;
    this.#readCurrentComputer = readCurrentComputer;
    this.#chooseResource = chooseResource;
    this.#tcc = tcc;
    this.#randomUUID = randomUUID;
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Renderer observers cannot change permission state or block other observers.
      }
    }
    return true;
  }

  async request(value, effect, rawContext) {
    if (this.#disposed) throw brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    const request = normalizeRequest(value);
    const context = normalizeTaskContext(rawContext);
    if (typeof effect !== "function") throw new TypeError("Permission effect must be a function.");
    const task = this.#beginTask(request.botId, context);
    try {
    try {
      await this.#assertCurrent(request);
      this.#assertTaskActive(task);
      if (request.capability === "shell.execute") {
        await this.#assertCurrent(request);
        this.#assertTaskActive(task);
      } else {
        const remembered = await this.#store.authorize(storeRequest(request));
        this.#assertTaskActive(task);
        await this.#assertCurrent(request);
        this.#assertTaskActive(task);
        if (remembered?.allowed === true) {
          const bookmark = normalizeBookmark(remembered.privateBookmark);
          await this.#ensureTcc(request);
          this.#assertTaskActive(task);
          await this.#assertCurrent(request);
          this.#assertTaskActive(task);
          return await this.#runEffect(effect, bookmark);
        }
        if (remembered?.allowed !== false) {
          throw brokerError("Stored permission result is unavailable.", "OPENBOT_PERMISSION_OPERATION_FAILED");
        }
      }
    } catch (error) {
      throw safeFailure(error);
    }

    if (this.#disposed) throw brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    this.#assertTaskActive(task);
    let botPending = 0;
    for (const entry of this.#pending.values()) {
      if (entry.request.botId === request.botId) botPending += 1;
    }
    if (botPending >= MAX_PENDING_PER_BOT || this.#pending.size >= MAX_PENDING_TOTAL) {
      throw brokerError(
        "Too many Computer permission requests are pending.",
        "OPENBOT_PERMISSION_QUEUE_FULL",
      );
    }
    const requestId = `permission-${safeUUID(this.#randomUUID)}`;
    return await new Promise((resolve, reject) => {
      this.#pending.set(requestId, { request, task, effect, resolve, reject });
      this.emit("request", frozenPrompt(requestId, request));
    });
    } finally {
      this.#endTask(task);
    }
  }

  async decide(value) {
    if (this.#disposed) throw brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    const decision = normalizeDecision(value);
    const entry = this.#pending.get(decision.requestId);
    if (!entry || !sameDecision(entry, decision)) {
      throw brokerError("Permission request is unavailable.", "OPENBOT_PERMISSION_UNAVAILABLE");
    }
    if (entry.request.capability === "shell.execute" && decision.decision === "always") {
      throw brokerError(
        "Full host shell permission is available for one command only.",
        "OPENBOT_PERMISSION_ALWAYS_UNAVAILABLE",
      );
    }
    this.#pending.delete(decision.requestId);

    if (decision.decision === "deny") {
      const denied = brokerError("Permission request was denied.", "OPENBOT_PERMISSION_DENIED");
      entry.reject(denied);
      throw denied;
    }

    let grant = null;
    try {
      this.#assertTaskActive(entry.task);
      await this.#assertCurrent(entry.request);
      this.#assertTaskActive(entry.task);
      const bookmark = normalizeBookmark(await this.#chooseResource(storeRequest(entry.request)));
      this.#assertTaskActive(entry.task);
      await this.#assertCurrent(entry.request);
      this.#assertTaskActive(entry.task);
      await this.#ensureTcc(entry.request);
      this.#assertTaskActive(entry.task);
      await this.#assertCurrent(entry.request);
      this.#assertTaskActive(entry.task);
      if (decision.decision === "always") {
        grant = await this.#store.remember(storeRequest(entry.request), bookmark);
        this.#assertTaskActive(entry.task);
        try {
          await this.#assertCurrent(entry.request);
        } catch (error) {
          await this.#revokeCreatedGrant(entry.request.botId, grant);
          throw error;
        }
      }
      const result = await this.#runEffect(entry.effect, bookmark);
      entry.resolve(result);
      return result;
    } catch (error) {
      const failure = safeFailure(error);
      entry.reject(failure);
      throw failure;
    }
  }

  async list(botId) {
    if (this.#disposed) throw brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    try {
      const normalizedBotId = normalizeBotId(botId);
      const target = currentLocalTarget(
        normalizedBotId,
        await this.#readCurrentComputer(normalizedBotId),
      );
      if (target === null) return Object.freeze([]);
      const grants = await this.#store.listPublic(normalizedBotId, target);
      const confirmedTarget = currentLocalTarget(
        normalizedBotId,
        await this.#readCurrentComputer(normalizedBotId),
      );
      return sameTarget(target, confirmedTarget)
        ? Object.freeze(grants.filter((grant) => grant?.capability !== "shell.execute"))
        : Object.freeze([]);
    } catch (error) {
      throw safeFailure(error);
    }
  }

  async listPending(botId) {
    if (this.#disposed) throw brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    const normalizedBotId = normalizeBotId(botId);
    const prompts = [];
    for (const [requestId, entry] of this.#pending) {
      if (entry.request.botId !== normalizedBotId) continue;
      prompts.push(frozenPrompt(requestId, entry.request));
    }
    return Object.freeze(prompts);
  }

  async revoke(value) {
    if (this.#disposed) throw brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    const input = normalizeRevoke(value);
    try {
      await this.#store.revoke(input.botId, input.grantId);
    } catch (error) {
      throw safeFailure(error);
    }
  }

  cancelBot(botId) {
    const normalizedBotId = normalizeBotId(botId);
    for (const state of this.#taskEpochs.values()) {
      if (state.botId === normalizedBotId) state.epoch += 1;
    }
    const failure = brokerError("Permission request was cancelled.", "OPENBOT_PERMISSION_CANCELLED");
    for (const [requestId, entry] of this.#pending) {
      if (entry.request.botId !== normalizedBotId) continue;
      this.#pending.delete(requestId);
      entry.reject(failure);
    }
  }

  cancelTask(value) {
    const input = normalizeCancelTask(value);
    const state = this.#taskEpochs.get(`${input.botId}\0${input.taskId}`);
    if (state) state.epoch += 1;
    const failure = brokerError("Permission request was cancelled.", "OPENBOT_PERMISSION_CANCELLED");
    for (const [requestId, entry] of this.#pending) {
      if (entry.request.botId !== input.botId || entry.task?.taskId !== input.taskId) continue;
      this.#pending.delete(requestId);
      entry.reject(failure);
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const failure = brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    for (const entry of this.#pending.values()) entry.reject(failure);
    this.#pending.clear();
    this.#taskEpochs.clear();
    this.removeAllListeners();
  }

  #beginTask(botId, context) {
    if (context === null) return null;
    const key = `${botId}\0${context.taskId}`;
    let state = this.#taskEpochs.get(key);
    if (!state) {
      state = { active: 0, botId, epoch: 0 };
      this.#taskEpochs.set(key, state);
    }
    state.active += 1;
    return Object.freeze({ epoch: state.epoch, key, taskId: context.taskId });
  }

  #assertTaskActive(task) {
    if (task === null) return;
    const state = this.#taskEpochs.get(task.key);
    if (!state || state.epoch !== task.epoch) {
      throw brokerError("Permission request was cancelled.", "OPENBOT_PERMISSION_CANCELLED");
    }
  }

  #endTask(task) {
    if (task === null) return;
    const state = this.#taskEpochs.get(task.key);
    if (!state) return;
    state.active -= 1;
    if (state.active === 0) this.#taskEpochs.delete(task.key);
  }

  async #assertCurrent(request) {
    this.#assertActive();
    let current;
    try {
      current = await this.#readCurrentComputer(request.botId);
    } catch {
      throw brokerError("Permission request is stale or cancelled.", "OPENBOT_PERMISSION_STALE");
    }
    this.#assertActive();
    assertCurrent(request, current);
  }

  async #ensureTcc(request) {
    try {
      const result = await this.#tcc.ensure(Object.freeze({
        botId: request.botId,
        capability: request.capability,
        resourceLabel: request.resourceLabel,
      }));
      if (result === false) throw new Error("denied");
    } catch {
      throw brokerError("Required macOS permission is unavailable.", "OPENBOT_PERMISSION_TCC_UNAVAILABLE");
    }
  }

  async #runEffect(effect, bookmark) {
    this.#assertActive();
    try {
      return await effect(Buffer.from(bookmark));
    } catch {
      throw brokerError("Local Computer action failed.", "OPENBOT_PERMISSION_ACTION_FAILED");
    }
  }

  async #revokeCreatedGrant(botId, grant) {
    if (!grant || typeof grant !== "object" || typeof grant.grantId !== "string"
      || !GRANT_ID_PATTERN.test(grant.grantId)) return;
    try {
      await this.#store.revoke(botId, grant.grantId.toLowerCase());
    } catch {
      // Preserve the stale decision result; cleanup can retry from stored grants.
    }
  }

  #assertActive() {
    if (this.#disposed) {
      throw brokerError("Permission broker is disposed.", "OPENBOT_PERMISSION_DISPOSED");
    }
  }
}

module.exports = {
  LocalPermissionBroker,
  PermissionBrokerError,
};
