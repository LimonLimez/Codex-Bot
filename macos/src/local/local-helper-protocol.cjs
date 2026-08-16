"use strict";

const { EventEmitter } = require("node:events");

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 4096;
const MAX_STRING_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REQUEST_FIELDS = new Set([
  "requestId",
  "botId",
  "targetId",
  "targetGeneration",
  "taskId",
  "capability",
  "operation",
  "arguments",
]);
const SUCCESS_FIELDS = new Set(["requestId", "ok", "value"]);
const FAILURE_FIELDS = new Set(["requestId", "ok", "errorCode"]);
const ALLOWED_OPERATIONS = new Set([
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^request-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}$/;
const SECRET_KEY_PATTERN = /(?:auth(?:orization)?|bearer|bookmark|cookie|credential|password|secret|token)/i;
const SECRET_VALUE_PATTERN = /(?:\/Users\/|(?:^|[\s;])~\/|Authorization\s*:|\bBearer\s+|\bBasic\s+|(?:access[_-]?token|password|cookie)\s*[:=])/i;

class LocalHelperError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalHelperError";
    this.code = code;
  }
}

function helperError(message, code) {
  return new LocalHelperError(message, code);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function cloneBounded(value, label) {
  const state = { nodes: 0, bytes: 0, seen: new Set() };
  const clone = cloneNode(value, state, 0, label);
  if (state.bytes > MAX_MESSAGE_BYTES) throw new Error(`${label} is oversized.`);
  return clone;
}

function cloneNode(value, state, depth, label) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error(`${label} is oversized.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains an invalid number.`);
    state.bytes += 8;
    return value;
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_STRING_BYTES || value.includes("\0") || SECRET_VALUE_PATTERN.test(value)) {
      throw new Error(`${label} contains invalid or private text.`);
    }
    state.bytes += bytes;
    return value;
  }
  if (typeof value !== "object") throw new Error(`${label} must contain JSON-compatible plain data.`);
  if (state.seen.has(value)) throw new Error(`${label} cannot contain cycles.`);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new Error(`${label} must use plain objects and arrays.`);
  }
  let descriptors;
  let keys;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw new Error(`${label} must contain plain data values only.`);
  }
  if (keys.some((key) => typeof key !== "string")) throw new Error(`${label} cannot contain symbols.`);
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key) || (!(array && key === "length") && SECRET_KEY_PATTERN.test(key))) {
      throw new Error(`${label} contains a forbidden field.`);
    }
    if (!("value" in descriptors[key])) throw new Error(`${label} must not contain accessors.`);
    state.bytes += Buffer.byteLength(key, "utf8");
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw new Error(`${label} arrays must be dense.`);
    }
  }
  state.seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = cloneNode(descriptors[key].value, state, depth + 1, label);
  }
  state.seen.delete(value);
  return copy;
}

function cloneInput(value, label) {
  try {
    return cloneBounded(value, label);
  } catch (error) {
    if (/plain data values only/i.test(error?.message || "")) throw error;
    if (value && typeof value === "object") {
      try {
        Object.getOwnPropertyDescriptors(value);
      } catch {
        throw new TypeError(`${label} must contain plain data values only.`);
      }
    }
    throw error;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field.`);
  }
  for (const key of allowed) {
    if (!hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) throw new Error("Helper bot ID is invalid.");
  return value.toLowerCase();
}

function normalizeTargetId(value) {
  if (typeof value !== "string" || !TARGET_ID_PATTERN.test(value)) throw new Error("Helper target ID is invalid.");
  return value.toLowerCase();
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Helper target generation is invalid.");
  return value;
}

function normalizeTaskId(value) {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw helperError("Local helper task is invalid.", "OPENBOT_LOCAL_HELPER_TASK_INVALID");
  }
  return value;
}

function normalizeRequest(value) {
  let cloned;
  try {
    cloned = cloneInput(value, "Helper request");
  } catch (error) {
    if (/plain data/i.test(error?.message || "")) throw error;
    throw new TypeError("Helper request must contain plain data values only.");
  }
  const request = assertPlainObject(cloned, "Helper request");
  assertExactKeys(request, REQUEST_FIELDS, "Helper request");
  if (typeof request.requestId !== "string" || !REQUEST_ID_PATTERN.test(request.requestId)) {
    throw new Error("Helper request ID is invalid.");
  }
  if (typeof request.taskId !== "string" || !SAFE_ID_PATTERN.test(request.taskId)) {
    throw new Error("Helper task ID is invalid.");
  }
  if (!ALLOWED_OPERATIONS.has(request.capability) || request.operation !== request.capability) {
    throw new Error("Helper operation is invalid.");
  }
  assertPlainObject(request.arguments, "Helper arguments");
  return deepFreeze({
    requestId: request.requestId.toLowerCase(),
    botId: normalizeBotId(request.botId),
    targetId: normalizeTargetId(request.targetId),
    targetGeneration: normalizeGeneration(request.targetGeneration),
    taskId: request.taskId,
    capability: request.capability,
    operation: request.operation,
    arguments: request.arguments,
  });
}

function normalizeReply(value) {
  let reply;
  try {
    reply = assertPlainObject(cloneBounded(value, "Helper reply"), "Helper reply");
  } catch {
    throw helperError("Local helper protocol failed.", "OPENBOT_LOCAL_HELPER_PROTOCOL_FAILED");
  }
  if (typeof reply.ok !== "boolean") {
    throw helperError("Local helper protocol failed.", "OPENBOT_LOCAL_HELPER_PROTOCOL_FAILED");
  }
  try {
    assertExactKeys(reply, reply.ok ? SUCCESS_FIELDS : FAILURE_FIELDS, "Helper reply");
    if (typeof reply.requestId !== "string" || !REQUEST_ID_PATTERN.test(reply.requestId)) throw new Error("id");
    if (!reply.ok && (typeof reply.errorCode !== "string" || !ERROR_CODE_PATTERN.test(reply.errorCode))) {
      throw new Error("code");
    }
  } catch {
    throw helperError("Local helper protocol failed.", "OPENBOT_LOCAL_HELPER_PROTOCOL_FAILED");
  }
  return deepFreeze(reply);
}

function normalizeReplyIdentity(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reply");
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("reply");
    const ok = descriptors.ok;
    const requestId = descriptors.requestId;
    if (!ok || !("value" in ok) || typeof ok.value !== "boolean"
      || !requestId || !("value" in requestId) || typeof requestId.value !== "string"
      || !REQUEST_ID_PATTERN.test(requestId.value)) throw new Error("reply");
    const allowed = ok.value ? SUCCESS_FIELDS : FAILURE_FIELDS;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== allowed.size || keys.some((key) => typeof key !== "string"
      || !allowed.has(key) || !("value" in descriptors[key]))) throw new Error("reply");
    if (!ok.value) {
      const errorCode = descriptors.errorCode.value;
      if (typeof errorCode !== "string" || !ERROR_CODE_PATTERN.test(errorCode)) throw new Error("reply");
    }
    return Object.freeze({ requestId: requestId.value.toLowerCase(), ok: ok.value });
  } catch {
    throw helperError("Local helper protocol failed.", "OPENBOT_LOCAL_HELPER_PROTOCOL_FAILED");
  }
}

function normalizeShellReply(value) {
  try {
    const identity = normalizeReplyIdentity(value);
    if (!identity.ok) return normalizeReply(value);
    const top = Object.getOwnPropertyDescriptors(value);
    const rawResult = top.value.value;
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) throw new Error("result");
    const prototype = Object.getPrototypeOf(rawResult);
    const descriptors = Object.getOwnPropertyDescriptors(rawResult);
    const fields = new Set(["exitCode", "stdout", "stderr"]);
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.size
      || keys.some((key) => typeof key !== "string" || !fields.has(key) || !("value" in descriptors[key]))) {
      throw new Error("result");
    }
    const exitCode = descriptors.exitCode.value;
    const stdout = descriptors.stdout.value;
    const stderr = descriptors.stderr.value;
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255
      || typeof stdout !== "string" || typeof stderr !== "string"
      || Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_STRING_BYTES) {
      throw new Error("result");
    }
    return deepFreeze({
      requestId: identity.requestId,
      ok: true,
      value: { exitCode, stdout, stderr },
    });
  } catch (error) {
    if (error instanceof LocalHelperError) throw error;
    throw helperError("Local helper protocol failed.", "OPENBOT_LOCAL_HELPER_PROTOCOL_FAILED");
  }
}

function assertCurrent(request, current) {
  let valid = false;
  try {
    valid = current?.botId === request.botId
      && current?.computer?.mode === "local"
      && current.computer.localProfileId === request.targetId
      && current.computer.generation === request.targetGeneration
      && current.computer.state === "ready";
  } catch {
    valid = false;
  }
  if (!valid) {
    throw helperError("Local helper request is stale.", "OPENBOT_LOCAL_HELPER_STALE");
  }
}

class LocalHelperProtocol extends EventEmitter {
  #transport;
  #readCurrentComputer;
  #timeoutMs;
  #setTimer;
  #clearTimer;
  #pending = new Map();
  #operations = new Map();
  #unsubscribeMessage;
  #unsubscribeExit;
  #disposePromise = null;
  #disposing = false;
  #disposed = false;

  constructor({
    transport,
    readCurrentComputer,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    super();
    if (!transport || typeof transport.send !== "function" || typeof transport.cancel !== "function"
      || typeof transport.onMessage !== "function" || typeof transport.onExit !== "function"
      || typeof transport.dispose !== "function") {
      throw new TypeError("Local helper protocol requires a bounded transport.");
    }
    if (typeof readCurrentComputer !== "function") {
      throw new TypeError("Local helper protocol requires current Computer lookup.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
      || typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("Local helper protocol timeout configuration is invalid.");
    }
    this.#transport = transport;
    this.#readCurrentComputer = readCurrentComputer;
    this.#timeoutMs = timeoutMs;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#unsubscribeMessage = transport.onMessage((message) => {
      void this.#receive(message);
    });
    this.#unsubscribeExit = transport.onExit(() => {
      this.#terminate(helperError("Local helper exited.", "OPENBOT_LOCAL_HELPER_EXITED"));
    });
  }

  async run(value) {
    this.#assertActive();
    const request = normalizeRequest(value);
    if (this.#operations.has(request.requestId) || this.#pending.has(request.requestId)) {
      throw helperError("Local helper request is already pending.", "OPENBOT_LOCAL_HELPER_DUPLICATE");
    }

    let finishOperation;
    const operation = {
      request,
      cancelled: false,
      cancelSent: false,
      phase: "checking",
      done: new Promise((resolve) => { finishOperation = resolve; }),
      finish: () => finishOperation(),
    };
    this.#operations.set(request.requestId, operation);

    try {
      await this.#assertCurrent(request);
      this.#assertActive();
      this.#assertOperationActive(operation);

      let resolvePending;
      let rejectPending;
      const pending = new Promise((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
      const timer = this.#setTimer(() => {
        if (!this.#pending.has(request.requestId)) return;
        this.#terminate(helperError("Local helper operation timed out.", "OPENBOT_LOCAL_HELPER_TIMEOUT"));
      }, this.#timeoutMs);
      this.#pending.set(request.requestId, {
        request,
        operation,
        resolve: resolvePending,
        reject: rejectPending,
        timer,
      });
      try {
        operation.phase = "sending";
        await this.#transport.send(request);
        operation.phase = "pending";
        if (operation.cancelled) await this.#cancelOperation(operation);
        else {
          await this.#assertCurrent(request);
          this.#assertActive();
        }
      } catch (error) {
        const failure = error instanceof LocalHelperError
          ? error
          : helperError("Local helper send failed.", "OPENBOT_LOCAL_HELPER_SEND_FAILED");
        this.#settle(request.requestId, failure, true);
      }
      return await pending;
    } finally {
      if (this.#operations.get(request.requestId) === operation) this.#operations.delete(request.requestId);
      operation.finish();
    }
  }

  async cancelTask(value) {
    this.#assertActive();
    const taskId = normalizeTaskId(value);
    const matches = [...this.#operations.values()]
      .filter((operation) => operation.request.taskId === taskId);
    for (const operation of matches) operation.cancelled = true;
    try {
      for (const operation of matches) {
        if (operation.phase === "pending") await this.#cancelOperation(operation);
      }
    } catch {
      const failure = helperError("Local helper cancellation failed.", "OPENBOT_LOCAL_HELPER_CANCEL_FAILED");
      this.#terminate(failure);
      throw failure;
    }
    await Promise.all(matches.map((operation) => operation.done));
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    this.#disposing = true;
    const operations = [...this.#operations.values()];
    for (const operation of operations) operation.cancelled = true;
    this.#disposePromise = (async () => {
      try {
        for (const operation of operations) {
          if (operation.phase === "pending") await this.#cancelOperation(operation);
        }
        await Promise.all(operations.map((operation) => operation.done));
      } catch {
        this.#terminate(helperError("Local helper disposal failed.", "OPENBOT_LOCAL_HELPER_DISPOSED"));
        return;
      }
      this.#terminate(helperError("Local helper protocol is disposed.", "OPENBOT_LOCAL_HELPER_DISPOSED"));
    })();
    return this.#disposePromise;
  }

  async #receive(value) {
    if (this.#disposed) return;
    let identity;
    let reply;
    try {
      identity = normalizeReplyIdentity(value);
    } catch (error) {
      this.#terminate(error);
      return;
    }
    const pending = this.#pending.get(identity.requestId);
    if (!pending) {
      this.#terminate(helperError("Local helper protocol failed.", "OPENBOT_LOCAL_HELPER_PROTOCOL_FAILED"));
      return;
    }
    try {
      reply = pending.request.operation === "shell.execute" && identity.ok
        ? normalizeShellReply(value)
        : normalizeReply(value);
    } catch (error) {
      this.#terminate(error);
      return;
    }
    // A correlated terminal reply for an operation we cancelled is the helper's
    // process-group acknowledgement. The owning Computer may already have been
    // removed while close or generation replacement waits for that acknowledgement.
    if (pending.operation.cancelled) {
      const code = !reply.ok && reply.errorCode === "OPENBOT_LOCAL_CANCELLED"
        ? reply.errorCode
        : "OPENBOT_LOCAL_HELPER_CANCELLED";
      this.#settle(
        reply.requestId,
        helperError("Local helper task was cancelled.", code),
        true,
      );
      return;
    }
    try {
      await this.#assertCurrent(pending.request);
      this.#assertNotDisposed();
    } catch (error) {
      this.#settle(reply.requestId, error, true);
      return;
    }
    if (!reply.ok) {
      const failure = helperError("Local helper operation failed.", reply.errorCode);
      this.#settle(reply.requestId, failure, true);
      return;
    }
    this.#settle(reply.requestId, reply.value, false);
  }

  async #assertCurrent(request) {
    this.#assertNotDisposed();
    let current;
    try {
      current = await this.#readCurrentComputer(request.botId);
    } catch {
      throw helperError("Local helper request is stale.", "OPENBOT_LOCAL_HELPER_STALE");
    }
    this.#assertNotDisposed();
    assertCurrent(request, current);
  }

  #settle(requestId, outcome, rejected) {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    this.#clearTimer(pending.timer);
    if (rejected) pending.reject(outcome);
    else pending.resolve(outcome);
  }

  #failAll(error) {
    for (const requestId of [...this.#pending.keys()]) this.#settle(requestId, error, true);
  }

  #terminate(error) {
    if (this.#disposed) return;
    this.#disposing = true;
    this.#disposed = true;
    this.#failAll(error);
    try { this.#unsubscribeMessage?.(); } catch {}
    try { this.#unsubscribeExit?.(); } catch {}
    this.#unsubscribeMessage = null;
    this.#unsubscribeExit = null;
    try {
      const result = this.#transport.dispose();
      void Promise.resolve(result).catch(() => {});
    } catch {}
    this.removeAllListeners();
  }

  #assertActive() {
    if (this.#disposed || this.#disposing) {
      throw helperError("Local helper protocol is disposed.", "OPENBOT_LOCAL_HELPER_DISPOSED");
    }
  }

  #assertNotDisposed() {
    if (this.#disposed) {
      throw helperError("Local helper protocol is disposed.", "OPENBOT_LOCAL_HELPER_DISPOSED");
    }
  }

  #assertOperationActive(operation) {
    if (operation.cancelled) {
      throw helperError("Local helper task was cancelled.", "OPENBOT_LOCAL_HELPER_CANCELLED");
    }
  }

  async #cancelOperation(operation) {
    if (operation.cancelSent || !this.#pending.has(operation.request.requestId)) return;
    operation.cancelSent = true;
    await this.#transport.cancel(operation.request.requestId);
  }
}

module.exports = {
  ALLOWED_OPERATIONS,
  LocalHelperError,
  LocalHelperProtocol,
  MAX_DEPTH,
  MAX_MESSAGE_BYTES,
  MAX_NODES,
  normalizeReply,
  normalizeRequest,
};
