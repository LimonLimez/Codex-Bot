"use strict";

const crypto = require("node:crypto");

const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_TARGET_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const WORKSPACE_ID_PATTERN = /^workspace-[a-f0-9]{64}$/;
const RESOLVE_FIELDS = new Set(["botId", "conversationId", "taskId"]);
const DISPOSE_FIELDS = new Set(["botId", "taskId"]);
const TASK_CURRENT_FIELDS = new Set([
  "mode", "botId", "taskId", "targetId", "targetGeneration", "workspaceId",
]);
const ACTION_FIELDS = new Set([
  "mode",
  "botId",
  "conversationId",
  "taskId",
  "targetId",
  "targetGeneration",
  "workspaceId",
  "capability",
  "operation",
  "arguments",
  "resourceId",
  "resourceLabel",
  "reason",
]);
const LOCAL_TOOLS = Object.freeze([
  "browser.navigate",
  "browser.capture",
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_STRING_BYTES = 128 * 1024;
const MAX_NODES = 4096;

class ComputerTargetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ComputerTargetError";
    this.code = code;
  }
}

function targetError(message, code) {
  return new ComputerTargetError(message, code);
}

function clonePlain(value, state = { seen: new Set(), nodes: 0, bytes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || state.bytes > MAX_MESSAGE_BYTES) {
    throw targetError("Computer target request is oversized.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  if (depth > 16) throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
    return value;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_STRING_BYTES || state.bytes + bytes > MAX_MESSAGE_BYTES) {
      throw targetError("Computer target request is oversized.", "OPENBOT_COMPUTER_TARGET_INVALID");
    }
    state.bytes += bytes;
    return value;
  }
  if (typeof value !== "object" || state.seen.has(value)) {
    throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
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
    throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || !Object.hasOwn(descriptors[key], "value"))) {
    throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  for (const key of keys) {
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > MAX_MESSAGE_BYTES) {
      throw targetError("Computer target request is oversized.", "OPENBOT_COMPUTER_TARGET_INVALID");
    }
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
    }
  }
  state.seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = clonePlain(descriptors[key].value, state, depth + 1);
  }
  state.seen.delete(value);
  return copy;
}

function exactRequest(value, fields) {
  const request = clonePlain(value);
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  const keys = Object.keys(request);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))
    || [...fields].some((key) => !Object.hasOwn(request, key))) {
    throw targetError("Computer target request is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  return request;
}

function botId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) {
    throw targetError("Computer target bot ID is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value) || value.includes("..")) {
    throw targetError(`Computer target ${label} is invalid.`, "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  return value;
}

function optionalAbortSignal(value) {
  if (value === null || value === undefined) return null;
  try {
    if (!(value instanceof AbortSignal)) throw new TypeError("invalid signal");
  } catch { throw targetError("Computer target cancellation is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID"); }
  return value;
}

function normalizeResolve(value) {
  const request = exactRequest(value, RESOLVE_FIELDS);
  return Object.freeze({
    botId: botId(request.botId),
    conversationId: safeId(request.conversationId, "conversation ID"),
    taskId: safeId(request.taskId, "task ID"),
  });
}

function normalizeDispose(value) {
  const request = exactRequest(value, DISPOSE_FIELDS);
  return Object.freeze({
    botId: botId(request.botId),
    taskId: safeId(request.taskId, "task ID"),
  });
}

function normalizeTaskCurrent(value) {
  const request = exactRequest(value, TASK_CURRENT_FIELDS);
  if (request.mode !== "local" || typeof request.targetId !== "string"
    || !LOCAL_TARGET_PATTERN.test(request.targetId)
    || !Number.isSafeInteger(request.targetGeneration) || request.targetGeneration < 0
    || typeof request.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(request.workspaceId)) {
    throw targetError("Computer target task is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  return Object.freeze({
    ...request,
    botId: botId(request.botId),
    taskId: safeId(request.taskId, "task ID"),
  });
}

function normalizeAction(value) {
  const action = exactRequest(value, ACTION_FIELDS);
  if (action.mode !== "local" || typeof action.targetId !== "string"
    || !LOCAL_TARGET_PATTERN.test(action.targetId)
    || !Number.isSafeInteger(action.targetGeneration) || action.targetGeneration < 0
    || typeof action.workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(action.workspaceId)) {
    throw targetError("Computer target action is invalid.", "OPENBOT_COMPUTER_TARGET_INVALID");
  }
  return Object.freeze({
    ...action,
    botId: botId(action.botId),
    conversationId: safeId(action.conversationId, "conversation ID"),
    taskId: safeId(action.taskId, "task ID"),
  });
}

function currentIdentity(record, expectedBotId) {
  let valid = false;
  try {
    valid = record?.botId === expectedBotId
      && record.computer && typeof record.computer === "object"
      && ["not-now", "local", "cursor"].includes(record.computer.mode)
      && Number.isSafeInteger(record.computer.generation)
      && record.computer.generation >= 0;
  } catch {
    valid = false;
  }
  if (!valid) throw targetError("Computer target is unavailable.", "OPENBOT_COMPUTER_TARGET_UNAVAILABLE");
  const computer = record.computer;
  if (computer.mode === "not-now") {
    throw targetError("Computer is not configured.", "OPENBOT_COMPUTER_NOT_CONFIGURED");
  }
  if (computer.mode === "cursor") {
    throw targetError("Cursor Remote Computer is unavailable.", "OPENBOT_CURSOR_COMPUTER_UNAVAILABLE");
  }
  if (computer.state !== "ready" || typeof computer.localProfileId !== "string"
    || !LOCAL_TARGET_PATTERN.test(computer.localProfileId)) {
    throw targetError("Local Computer is unavailable.", "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE");
  }
  return Object.freeze({
    mode: "local",
    botId: expectedBotId,
    targetId: computer.localProfileId,
    targetGeneration: computer.generation,
  });
}

function identityKey(identity) {
  return `${identity.mode}\0${identity.botId}\0${identity.targetId}\0${identity.targetGeneration}`;
}

function sameIdentity(left, right) {
  return left.mode === right.mode && left.botId === right.botId
    && left.targetId === right.targetId
    && left.targetGeneration === right.targetGeneration;
}

function taskKey(request) {
  return `${request.botId}\0${request.taskId}`;
}

function botTaskKey(request) {
  return `${request.botId}\0${request.taskId}`;
}

function taskWorkspaceId(identity, request) {
  const digest = crypto.createHash("sha256")
    .update(identityKey(identity))
    .update("\0")
    .update(request.taskId)
    .digest("hex");
  return `workspace-${digest}`;
}

function publicTarget(identity, workspaceId) {
  return Object.freeze({
    mode: identity.mode,
    botId: identity.botId,
    targetId: identity.targetId,
    targetGeneration: identity.targetGeneration,
    workspaceId,
    tools: LOCAL_TOOLS,
  });
}

function managerSession(value, identity) {
  let session;
  try { session = clonePlain(value); } catch {
    throw targetError("Local Computer target is unavailable.", "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE");
  }
  if (!session || typeof session !== "object" || Array.isArray(session)
    || session.botId !== identity.botId || session.targetId !== identity.targetId
    || session.targetGeneration !== identity.targetGeneration || session.state !== "ready") {
    throw targetError("Local Computer target is unavailable.", "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE");
  }
  return session;
}

class ComputerTargetRouter {
  #store;
  #localManager;
  #sessions = new Map();
  #tasks = new Map();
  #taskEpochs = new Map();
  #disposed = false;

  constructor({ store, localManager } = {}) {
    if (!store || typeof store.read !== "function"
      || !localManager || typeof localManager.open !== "function"
      || typeof localManager.run !== "function"
      || typeof localManager.navigate !== "function"
      || typeof localManager.capture !== "function") {
      throw new TypeError("Computer target router dependencies are invalid.");
    }
    this.#store = store;
    this.#localManager = localManager;
  }

  async resolve(value, rawSignal = null) {
    this.#assertActive();
    const request = normalizeResolve(value);
    const signal = optionalAbortSignal(rawSignal);
    const epochKey = botTaskKey(request);
    const epoch = this.#taskEpochs.get(epochKey) ?? 0;
    let rejectCancellation = null;
    const cancellation = signal && new Promise((resolve, reject) => { rejectCancellation = reject; });
    if (cancellation) void cancellation.catch(() => {});
    const cancel = () => {
      if (!this.#disposed) {
        if ((this.#taskEpochs.get(epochKey) ?? 0) === epoch) {
          this.#taskEpochs.set(epochKey, epoch + 1);
        }
        this.#tasks.delete(taskKey(request));
      }
      rejectCancellation?.(targetError(
        "Computer task was disposed.",
        "OPENBOT_COMPUTER_TASK_DISPOSED",
      ));
    };
    if (signal) {
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    }
    const wait = (effect) => cancellation ? Promise.race([effect, cancellation]) : effect;
    try {
      this.#assertTaskEpoch(epochKey, epoch);
      const record = await wait(Promise.resolve().then(() => this.#store.read(request.botId)));
      this.#assertActive();
      this.#assertTaskEpoch(epochKey, epoch);
      const identity = currentIdentity(record, request.botId);
      await wait(this.#openLocal(record, identity));
      this.#assertActive();
      this.#assertTaskEpoch(epochKey, epoch);
      const currentRecord = await wait(Promise.resolve().then(() => this.#store.read(request.botId)));
      const current = currentIdentity(currentRecord, request.botId);
      this.#assertActive();
      this.#assertTaskEpoch(epochKey, epoch);
      if (!sameIdentity(identity, current)) {
        throw targetError("Computer target changed.", "OPENBOT_COMPUTER_TARGET_STALE");
      }
      const key = taskKey(request);
      const currentTask = this.#tasks.get(key);
      const workspaceId = currentTask?.identityKey === identityKey(identity)
        ? currentTask.workspaceId
        : taskWorkspaceId(identity, request);
      this.#tasks.set(key, Object.freeze({ identityKey: identityKey(identity), workspaceId }));
      return publicTarget(identity, workspaceId);
    } finally {
      if (signal) signal.removeEventListener("abort", cancel);
    }
  }

  async assertTaskCurrent(value) {
    this.#assertActive();
    const expected = normalizeTaskCurrent(value);
    const current = currentIdentity(await this.#store.read(expected.botId), expected.botId);
    this.#assertActive();
    const task = this.#tasks.get(taskKey(expected));
    if (expected.mode !== current.mode || expected.targetId !== current.targetId
      || expected.targetGeneration !== current.targetGeneration || !task
      || task.identityKey !== identityKey(current) || task.workspaceId !== expected.workspaceId) {
      throw targetError("Computer target changed.", "OPENBOT_COMPUTER_TARGET_STALE");
    }
  }

  async run(value) {
    this.#assertActive();
    const action = normalizeAction(value);
    const epochKey = botTaskKey(action);
    const epoch = this.#taskEpochs.get(epochKey) ?? 0;
    await this.assertTaskCurrent({
      mode: action.mode,
      botId: action.botId,
      taskId: action.taskId,
      targetId: action.targetId,
      targetGeneration: action.targetGeneration,
      workspaceId: action.workspaceId,
    });
    this.#assertActive();
    this.#assertTaskEpoch(epochKey, epoch);
    const target = Object.freeze({
      mode: action.mode,
      botId: action.botId,
      targetId: action.targetId,
      targetGeneration: action.targetGeneration,
    });
    const identity = {
      botId: action.botId,
      targetId: action.targetId,
      targetGeneration: action.targetGeneration,
    };
    let result;
    if (action.operation === "browser.navigate" && action.capability === action.operation) {
      const argumentsValue = exactRequest(action.arguments, new Set(["url"]));
      result = await this.#localManager.navigate({ ...identity, url: argumentsValue.url });
    } else if (action.operation === "browser.capture" && action.capability === action.operation) {
      exactRequest(action.arguments, new Set());
      result = await this.#localManager.capture(identity);
    } else {
      result = await this.#localManager.run({
        ...identity,
        taskId: action.taskId,
        capability: action.capability,
        operation: action.operation,
        arguments: action.arguments,
        resourceId: action.resourceId,
        resourceLabel: action.resourceLabel,
        reason: action.reason,
      });
    }
    this.#assertActive();
    this.#assertTaskEpoch(epochKey, epoch);
    const current = currentIdentity(await this.#store.read(action.botId), action.botId);
    this.#assertActive();
    this.#assertTaskEpoch(epochKey, epoch);
    if (!sameIdentity(target, current)) {
      throw targetError("Computer target changed.", "OPENBOT_COMPUTER_TARGET_STALE");
    }
    return result;
  }

  async disposeTask(value) {
    this.#assertActive();
    const request = normalizeDispose(value);
    const epochKey = botTaskKey(request);
    this.#taskEpochs.set(epochKey, (this.#taskEpochs.get(epochKey) ?? 0) + 1);
    this.#tasks.delete(taskKey(request));
    if (typeof this.#localManager.disposeTask === "function") {
      await this.#localManager.disposeTask(request);
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sessions.clear();
    this.#tasks.clear();
    this.#taskEpochs.clear();
  }

  async #openLocal(record, identity) {
    const key = identityKey(identity);
    let entry = this.#sessions.get(identity.botId);
    if (!entry || entry.key !== key) {
      const promise = Promise.resolve()
        .then(() => {
          this.#assertActive();
          return this.#localManager.open({ botId: identity.botId, computer: record.computer });
        })
        .then((value) => managerSession(value, identity));
      entry = { key, promise };
      this.#sessions.set(identity.botId, entry);
      void promise.catch(() => {
        if (this.#sessions.get(identity.botId) === entry) this.#sessions.delete(identity.botId);
      });
    }
    await entry.promise;
  }

  #assertTaskEpoch(key, epoch) {
    if ((this.#taskEpochs.get(key) ?? 0) !== epoch) {
      throw targetError("Computer task was disposed.", "OPENBOT_COMPUTER_TASK_DISPOSED");
    }
  }

  #assertActive() {
    if (this.#disposed) {
      throw targetError("Computer target router is disposed.", "OPENBOT_COMPUTER_TARGET_DISPOSED");
    }
  }
}

module.exports = {
  ComputerTargetError,
  ComputerTargetRouter,
};
