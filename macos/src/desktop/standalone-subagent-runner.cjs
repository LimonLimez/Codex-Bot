"use strict";

const { randomUUID } = require("node:crypto");
const { types } = require("node:util");
const { normalizeInferenceSelection } = require("./inference-provider-router.cjs");

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PARENT_TASK_ID = /^(?:parent|standalone-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TASK_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TOOL_ARGS_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_BYTES = 128 * 1024;
const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_CALLS = 8;
const MAX_STREAM_EVENTS = 4096;
const MAX_ACTIVE_PER_SESSION = 4;
const MAX_ACTIVE_TOTAL = 16;
const MAX_ISSUED_TASKS = 4096;
const DEFAULT_TIMEOUT_MS = 120_000;
const OPEN_CLEANUP_ACK_MS = 250;
const CHILD_TOOL_NAMES = new Set(["browser_navigate", "browser_capture", "shell_execute"]);

const SPAWN_SUBAGENT_TOOL = Object.freeze({
  type: "function",
  name: "spawn_subagent",
  description: "Run one bounded subtask with the same bot and model selection.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      task: Object.freeze({ type: "string", maxLength: MAX_TASK_BYTES }),
    }),
    required: Object.freeze(["task"]),
    additionalProperties: false,
  }),
});

class StandaloneSubagentError extends Error {
  constructor(code = "OPENBOT_SUBAGENT_OPERATION_FAILED", message = "OpenBot subagent operation failed.") {
    super(message);
    this.name = "StandaloneSubagentError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function failure(code = "OPENBOT_SUBAGENT_OPERATION_FAILED") {
  return new StandaloneSubagentError(
    code,
    code === "OPENBOT_SUBAGENT_CANCELLED"
      ? "OpenBot subagent was cancelled."
      : code === "OPENBOT_SUBAGENT_STALE"
        ? "OpenBot subagent selection changed."
        : "OpenBot subagent operation failed.",
  );
}

function ownData(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw failure();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw failure(); }
  if (prototype !== Object.prototype && prototype !== null) throw failure();
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]))
    || [...required].some((key) => !Object.hasOwn(descriptors, key))) throw failure();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function safeUuid(makeId) {
  let value;
  try { value = makeId(); } catch { throw failure(); }
  if (typeof value !== "string" || !UUID.test(value)) throw failure();
  return value;
}

function sameSelection(left, right) {
  return left.botId === right.botId
    && left.generation === right.generation
    && left.catalogGeneration === right.catalogGeneration
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && left.serviceTier === right.serviceTier;
}

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, frozen(nested)])));
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value)) throw failure();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw failure(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) throw failure();
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)) throw failure();
    output.push(descriptor.value);
  }
  return output;
}

function cloneJson(value, state = { bytes: 0, nodes: 0, seen: new Set() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 4096 || depth > 12 || state.bytes > MAX_TOOL_RESULT_BYTES) throw failure();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure();
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_TOOL_RESULT_BYTES || value.includes("\0")) throw failure();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.seen.has(value)) throw failure();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw failure(); }
  const array = Array.isArray(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || ["__proto__", "prototype", "constructor"].includes(key)
      || !("value" in descriptors[key]))) throw failure();
  if (array) {
    const elements = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) throw failure();
  }
  state.seen.add(value);
  const output = array ? [] : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    state.bytes += Buffer.byteLength(key, "utf8");
    output[key] = cloneJson(descriptor.value, state, depth + 1);
  }
  state.seen.delete(value);
  return frozen(output);
}

function toolCatalog(value) {
  const definitions = denseArray(value, CHILD_TOOL_NAMES.size);
  const names = new Set();
  const reviewed = [];
  for (const definition of definitions) {
    const raw = ownData(
      definition,
      new Set(["type", "name", "description", "parameters"]),
      new Set(["type", "name", "parameters"]),
    );
    if (raw.type !== "function" || !CHILD_TOOL_NAMES.has(raw.name)
      || names.has(raw.name) || (raw.description !== undefined && typeof raw.description !== "string")) {
      throw failure();
    }
    const parameters = cloneJson(raw.parameters);
    names.add(raw.name);
    reviewed.push(frozen({
      type: "function",
      name: raw.name,
      ...(raw.description === undefined ? {} : { description: raw.description }),
      parameters,
    }));
  }
  return Object.freeze({ definitions: Object.freeze(reviewed), names });
}

function toolResult(value) {
  const cloned = cloneJson(value);
  let text;
  try { text = JSON.stringify(cloned); } catch { throw failure(); }
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) throw failure();
  return frozen({ content: [{ type: "text", text }] });
}

class StandaloneSubagentRunner {
  #router;
  #readSelection;
  #toolBridge;
  #makeId;
  #setTimeout;
  #clearTimeout;
  #setCleanupTimeout;
  #clearCleanupTimeout;
  #timeoutMs;
  #tasks = new Map();
  #issuedTaskIds = new Set();
  #issuedConversationIds = new Set();
  #issuedInvocationIds = new Set();
  #sessions = new Set();
  #disposed = false;
  #disposePromise = null;

  constructor(rawOptions = {}) {
    const options = ownData(
      rawOptions,
      new Set([
        "router", "readSelection", "toolBridge", "makeId", "setTimeout", "clearTimeout", "timeoutMs",
        "setCleanupTimeout", "clearCleanupTimeout",
      ]),
      new Set(["router", "readSelection"]),
    );
    if (!options.router || typeof options.router !== "object" || types.isProxy(options.router)
      || typeof options.router.stream !== "function" || typeof options.readSelection !== "function"
      || (options.toolBridge !== undefined && (!options.toolBridge || typeof options.toolBridge !== "object"
        || types.isProxy(options.toolBridge) || typeof options.toolBridge.open !== "function"))
      || (options.makeId !== undefined && typeof options.makeId !== "function")) throw failure();
    if ((options.setTimeout !== undefined && typeof options.setTimeout !== "function")
      || (options.clearTimeout !== undefined && typeof options.clearTimeout !== "function")
      || (options.setCleanupTimeout !== undefined && typeof options.setCleanupTimeout !== "function")
      || (options.clearCleanupTimeout !== undefined && typeof options.clearCleanupTimeout !== "function")
      || ((options.setCleanupTimeout === undefined) !== (options.clearCleanupTimeout === undefined))
      || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs)
        || options.timeoutMs < 1 || options.timeoutMs > 300_000))) throw failure();
    this.#router = options.router;
    this.#readSelection = options.readSelection;
    this.#toolBridge = options.toolBridge || null;
    this.#makeId = options.makeId || randomUUID;
    this.#setTimeout = options.setTimeout || setTimeout;
    this.#clearTimeout = options.clearTimeout || clearTimeout;
    this.#setCleanupTimeout = options.setCleanupTimeout || setTimeout;
    this.#clearCleanupTimeout = options.clearCleanupTimeout || clearTimeout;
    this.#timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  async open(rawIdentity) {
    this.#available();
    const identity = ownData(rawIdentity, new Set(["botId", "conversationId", "taskId", "selection"]));
    if (typeof identity.botId !== "string" || !BOT_ID.test(identity.botId)
      || typeof identity.conversationId !== "string" || !CONVERSATION_ID.test(identity.conversationId)
      || typeof identity.taskId !== "string" || !PARENT_TASK_ID.test(identity.taskId)) throw failure();
    let selection;
    try { selection = normalizeInferenceSelection(identity.selection); } catch { throw failure(); }
    if (selection.botId !== identity.botId) throw failure();
    const session = {
      cleanups: new Set(),
      disposed: false,
      disposePromise: null,
      tasks: new Set(),
    };
    this.#sessions.add(session);
    const publicIdentity = Object.freeze({
      botId: identity.botId,
      conversationId: identity.conversationId,
      taskId: identity.taskId,
    });
    return Object.freeze({
      ...publicIdentity,
      definitions: Object.freeze([SPAWN_SUBAGENT_TOOL]),
      dispatch: (call) => this.#dispatch(session, publicIdentity, selection, call),
      dispose: async () => this.#disposeSession(session),
    });
  }

  async #dispatch(session, identity, selection, rawCall) {
    this.#available();
    if (session.disposed) throw failure("OPENBOT_SUBAGENT_CANCELLED");
    const call = ownData(rawCall, new Set([
      "botId", "conversationId", "taskId", "invocationId", "toolCallId", "toolName", "args",
    ]));
    if (call.botId !== identity.botId || call.conversationId !== identity.conversationId
      || call.taskId !== identity.taskId || typeof call.invocationId !== "string"
      || !INVOCATION_ID.test(call.invocationId) || typeof call.toolCallId !== "string"
      || !TOOL_CALL_ID.test(call.toolCallId) || call.toolName !== "spawn_subagent") throw failure();
    const args = ownData(call.args, new Set(["task"]));
    if (typeof args.task !== "string" || args.task.trim().length === 0 || args.task.includes("\0")
      || Buffer.byteLength(args.task, "utf8") > MAX_TASK_BYTES) throw failure();
    if (session.tasks.size >= MAX_ACTIVE_PER_SESSION || this.#tasks.size >= MAX_ACTIVE_TOTAL) throw failure();

    if (this.#issuedTaskIds.size >= MAX_ISSUED_TASKS) throw failure();
    const taskId = `subagent-${safeUuid(this.#makeId)}`;
    if (this.#issuedTaskIds.has(taskId)) throw failure();
    this.#issuedTaskIds.add(taskId);
    const conversationId = `conversation-${safeUuid(this.#makeId)}`;
    if (this.#issuedConversationIds.has(conversationId)) throw failure();
    this.#issuedConversationIds.add(conversationId);
    const invocationId = `invocation-${safeUuid(this.#makeId)}`;
    if (this.#issuedInvocationIds.has(invocationId)) throw failure();
    this.#issuedInvocationIds.add(invocationId);
    let rejectCancellation;
    const cancellation = new Promise((resolve, reject) => { rejectCancellation = reject; });
    void cancellation.catch(() => {});
    const operation = {
      abortController: new AbortController(),
      cancellation,
      cancellationSettled: false,
      conversationId,
      disposed: false,
      invocationId,
      parent: session,
      selection,
      taskId,
      timer: null,
      toolDispatch: null,
      toolCurrent: null,
      toolDisposePromise: null,
      toolOpen: null,
      toolOpenEpoch: 0,
      toolSession: null,
      rejectCancellation,
    };
    this.#tasks.set(taskId, operation);
    session.tasks.add(taskId);
    try {
      operation.timer = this.#setTimeout(() => {
        this.#cancelOperation(operation);
      }, this.#timeoutMs);
      operation.timer?.unref?.();
      await this.#raceOperation(operation, this.#assertCurrent(operation));
      let definitions = Object.freeze([]);
      let toolNames = new Set();
      if (this.#toolBridge) {
        const openRecord = {
          ackPromise: null,
          cancelled: false,
          cleanupPromise: null,
          epoch: operation.toolOpenEpoch + 1,
          promise: null,
        };
        operation.toolOpenEpoch = openRecord.epoch;
        openRecord.promise = Promise.resolve().then(() => this.#toolBridge.open(
          Object.freeze({ botId: identity.botId, conversationId, taskId }),
          operation.abortController.signal,
        ));
        operation.toolOpen = openRecord;
        const opened = await this.#raceOperation(operation, openRecord.promise);
        if (openRecord.cancelled || operation.toolOpenEpoch !== openRecord.epoch) {
          throw failure("OPENBOT_SUBAGENT_CANCELLED");
        }
        operation.toolSession = opened;
        await this.#raceOperation(operation, this.#assertCurrent(operation));
        const child = ownData(
          opened,
          new Set(["botId", "conversationId", "taskId", "definitions", "dispatch", "assertCurrent", "dispose"]),
          new Set(["botId", "conversationId", "taskId", "definitions", "dispatch"]),
        );
        if (child.botId !== identity.botId || child.conversationId !== conversationId
          || child.taskId !== taskId || !Array.isArray(child.definitions)
          || typeof child.dispatch !== "function"
          || (child.assertCurrent !== undefined && typeof child.assertCurrent !== "function")
          || (child.dispose !== undefined && typeof child.dispose !== "function")) throw failure();
        const catalog = toolCatalog(child.definitions);
        operation.toolDispatch = child.dispatch;
        operation.toolCurrent = child.assertCurrent || null;
        definitions = catalog.definitions;
        toolNames = catalog.names;
      }
      const output = await Promise.race([
        this.#runChild(operation, identity, args.task, definitions, toolNames),
        operation.cancellation,
      ]);
      await this.#raceOperation(operation, this.#assertToolCurrent(operation));
      await this.#raceOperation(operation, this.#assertCurrent(operation));
      return frozen({ status: "completed", output });
    } catch (error) {
      if (error?.code === "OPENBOT_SUBAGENT_STALE") throw failure("OPENBOT_SUBAGENT_STALE");
      if (error?.code === "OPENBOT_SUBAGENT_CANCELLED" || operation.abortController.signal.aborted
        || operation.parent.disposed || operation.disposed || this.#disposed) {
        throw failure("OPENBOT_SUBAGENT_CANCELLED");
      }
      throw failure();
    } finally {
      operation.disposed = true;
      if (operation.timer !== null) {
        try { this.#clearTimeout(operation.timer); } catch {}
        operation.timer = null;
      }
      this.#trackSessionCleanup(session, this.#cancelToolOpen(operation));
      await this.#disposeToolSession(operation);
      this.#tasks.delete(taskId);
      session.tasks.delete(taskId);
    }
  }

  async #runChild(operation, parentIdentity, task, definitions, toolNames) {
    const context = [frozen({ role: "user", content: task })];
    const seenCalls = new Set();
    let output = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      await this.#assertCurrent(operation);
      await this.#raceOperation(operation, this.#assertToolCurrent(operation));
      let stream;
      try {
        stream = await this.#router.stream(Object.freeze({
          selection: operation.selection,
          conversationId: operation.conversationId,
          messages: Object.freeze([...context]),
          tools: definitions,
          toolChoice: definitions.length > 0 ? "auto" : "none",
          invocationId: operation.invocationId,
          signal: operation.abortController.signal,
        }));
      } catch (error) {
        if (error?.code === "CODEX_INFERENCE_STALE") throw failure("OPENBOT_SUBAGENT_STALE");
        throw failure();
      }
      if (!stream || typeof stream !== "object" || types.isProxy(stream)
        || !stream.fullStream || typeof stream.fullStream[Symbol.asyncIterator] !== "function") throw failure();
      const consumed = await this.#consumeRound(operation, stream, toolNames, seenCalls, output);
      output = consumed.output;
      if (consumed.finishReason === "stop") return output;
      if (round >= MAX_TOOL_ROUNDS || !operation.toolSession || consumed.calls.length === 0) throw failure();
      const assistantContent = [];
      if (consumed.roundText) assistantContent.push(frozen({ type: "text", text: consumed.roundText }));
      assistantContent.push(...consumed.calls.map((call) => frozen({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args,
      })));
      context.push(frozen({ role: "assistant", content: assistantContent }));
      const results = [];
      for (const call of consumed.calls) {
        await this.#assertCurrent(operation);
        let value;
        try {
          value = await operation.toolDispatch.call(operation.toolSession, Object.freeze({
            botId: parentIdentity.botId,
            conversationId: operation.conversationId,
            taskId: operation.taskId,
            invocationId: operation.invocationId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.args,
          }));
        } catch { throw failure(); }
        await this.#assertCurrent(operation);
        results.push(frozen({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: toolResult(value),
          isError: false,
        }));
      }
      context.push(frozen({ role: "tool", content: results }));
    }
    throw failure();
  }

  async #consumeRound(operation, stream, toolNames, seenCalls, priorOutput) {
    const started = new Map();
    const argumentBytes = new Map();
    const calls = [];
    let roundArgumentBytes = 0;
    let roundText = "";
    let output = priorOutput;
    let finishReason = null;
    let eventCount = 0;
    for await (const rawEvent of stream.fullStream) {
      eventCount += 1;
      if (eventCount > MAX_STREAM_EVENTS) throw failure();
      await this.#assertCurrent(operation);
      const event = ownData(rawEvent, new Set([
        "type", "textDelta", "toolCallId", "toolName", "argsTextDelta", "args", "finishReason", "usage",
      ]), new Set(["type"]));
      if (event.type === "text-delta") {
        if (finishReason !== null || typeof event.textDelta !== "string" || event.textDelta.includes("\0")
          || Buffer.byteLength(output + event.textDelta, "utf8") > MAX_OUTPUT_BYTES) throw failure();
        output += event.textDelta;
        roundText += event.textDelta;
        continue;
      }
      if (event.type === "tool-call-streaming-start") {
        if (finishReason !== null || typeof event.toolCallId !== "string" || !TOOL_CALL_ID.test(event.toolCallId)
          || typeof event.toolName !== "string" || !toolNames.has(event.toolName)
          || started.size >= MAX_TOOL_CALLS || started.has(event.toolCallId)
          || seenCalls.has(event.toolCallId)) throw failure();
        started.set(event.toolCallId, event.toolName);
        continue;
      }
      if (event.type === "tool-call-delta") {
        if (finishReason !== null || typeof event.argsTextDelta !== "string"
          || event.argsTextDelta.includes("\0") || started.get(event.toolCallId) !== event.toolName) throw failure();
        const bytes = Buffer.byteLength(event.argsTextDelta, "utf8");
        const current = (argumentBytes.get(event.toolCallId) ?? 0) + bytes;
        roundArgumentBytes += bytes;
        if (current > MAX_TOOL_ARGS_BYTES || roundArgumentBytes > MAX_TOOL_ARGS_BYTES) throw failure();
        argumentBytes.set(event.toolCallId, current);
        continue;
      }
      if (event.type === "tool-call") {
        if (finishReason !== null || calls.length >= MAX_TOOL_CALLS
          || started.get(event.toolCallId) !== event.toolName || seenCalls.has(event.toolCallId)) throw failure();
        const args = cloneJson(event.args);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw failure();
        seenCalls.add(event.toolCallId);
        calls.push(frozen({ toolCallId: event.toolCallId, toolName: event.toolName, args }));
        continue;
      }
      if (event.type === "finish") {
        if (finishReason !== null || !new Set(["stop", "tool-calls"]).has(event.finishReason)) throw failure();
        finishReason = event.finishReason;
        continue;
      }
      throw failure();
    }
    if (finishReason === null || started.size !== calls.length
      || (finishReason === "stop" && calls.length !== 0)
      || (finishReason === "tool-calls" && calls.length === 0)) throw failure();
    return { calls, finishReason, output, roundText };
  }

  async #disposeToolSession(operation) {
    if (!operation.toolSession) return;
    await this.#disposeExactToolSession(operation, operation.toolSession);
  }

  #disposeExactToolSession(operation, rawSession) {
    if (operation.toolDisposePromise) return operation.toolDisposePromise;
    operation.toolDisposePromise = (async () => {
      try {
        const dispose = rawSession && Object.getOwnPropertyDescriptor(rawSession, "dispose")?.value;
        if (typeof dispose === "function") await dispose.call(rawSession);
      } catch {}
    })();
    return operation.toolDisposePromise;
  }

  #cancelToolOpen(operation) {
    const openRecord = operation.toolOpen;
    if (!openRecord) return Promise.resolve();
    if (!openRecord.cancelled) {
      openRecord.cancelled = true;
      if (operation.toolOpenEpoch === openRecord.epoch) operation.toolOpenEpoch += 1;
    }
    if (!openRecord.cleanupPromise) {
      openRecord.cleanupPromise = openRecord.promise.then(
        (opened) => this.#disposeExactToolSession(operation, opened),
        () => undefined,
      );
    }
    if (!openRecord.ackPromise) {
      openRecord.ackPromise = this.#pendingOpenCleanupAck(openRecord, operation);
    }
    return openRecord.ackPromise;
  }

  #pendingOpenCleanupAck(openRecord, operation) {
    return new Promise((resolve) => {
      let acknowledged = false;
      let openArrived = false;
      let timer = null;
      const clear = () => {
        if (timer === null) return;
        try { this.#clearCleanupTimeout(timer); } catch {}
        timer = null;
      };
      const finish = () => {
        if (acknowledged) return;
        acknowledged = true;
        clear();
        resolve();
      };
      try {
        timer = this.#setCleanupTimeout(() => {
          if (!openArrived) finish();
        }, OPEN_CLEANUP_ACK_MS);
      } catch {
        finish();
      }
      openRecord.promise.then(
        (opened) => {
          if (acknowledged) return;
          openArrived = true;
          clear();
          this.#disposeExactToolSession(operation, opened).then(finish, finish);
        },
        () => {
          openArrived = true;
          finish();
        },
      );
    });
  }

  #trackSessionCleanup(session, cleanup) {
    session.cleanups.add(cleanup);
    void cleanup.then(
      () => session.cleanups.delete(cleanup),
      () => session.cleanups.delete(cleanup),
    );
    return cleanup;
  }

  #raceOperation(operation, promise) {
    return Promise.race([promise, operation.cancellation]);
  }

  #cancelOperation(operation) {
    if (operation.cancellationSettled) return;
    operation.cancellationSettled = true;
    const error = failure("OPENBOT_SUBAGENT_CANCELLED");
    try { operation.abortController.abort(error); } catch {}
    try { operation.rejectCancellation(error); } catch {}
  }

  async #assertToolCurrent(operation) {
    if (!operation.toolCurrent) return;
    if (this.#disposed || operation.disposed || operation.parent.disposed
      || this.#tasks.get(operation.taskId) !== operation || operation.abortController.signal.aborted) {
      throw failure("OPENBOT_SUBAGENT_CANCELLED");
    }
    try { await operation.toolCurrent.call(operation.toolSession); }
    catch {
      if (this.#disposed || operation.disposed || operation.parent.disposed
        || this.#tasks.get(operation.taskId) !== operation || operation.abortController.signal.aborted) {
        throw failure("OPENBOT_SUBAGENT_CANCELLED");
      }
      throw failure("OPENBOT_SUBAGENT_STALE");
    }
    if (this.#disposed || operation.disposed || operation.parent.disposed
      || this.#tasks.get(operation.taskId) !== operation || operation.abortController.signal.aborted) {
      throw failure("OPENBOT_SUBAGENT_CANCELLED");
    }
  }

  async #assertCurrent(operation) {
    if (this.#disposed || operation.disposed || operation.parent.disposed
      || this.#tasks.get(operation.taskId) !== operation || operation.abortController.signal.aborted) {
      throw failure("OPENBOT_SUBAGENT_CANCELLED");
    }
    let current;
    try { current = normalizeInferenceSelection(await this.#readSelection(operation.selection.botId)); }
    catch { throw failure("OPENBOT_SUBAGENT_STALE"); }
    if (this.#disposed || operation.disposed || operation.parent.disposed
      || this.#tasks.get(operation.taskId) !== operation || operation.abortController.signal.aborted) {
      throw failure("OPENBOT_SUBAGENT_CANCELLED");
    }
    if (!sameSelection(operation.selection, current)) throw failure("OPENBOT_SUBAGENT_STALE");
  }

  #disposeSession(session) {
    if (session.disposePromise) return session.disposePromise;
    session.disposed = true;
    const disposals = [];
    for (const taskId of [...session.tasks]) {
      const operation = this.#tasks.get(taskId);
      if (!operation) continue;
      operation.disposed = true;
      this.#cancelOperation(operation);
      disposals.push(this.#trackSessionCleanup(session, this.#cancelToolOpen(operation)));
      disposals.push(this.#disposeToolSession(operation));
      this.#tasks.delete(taskId);
    }
    session.tasks.clear();
    disposals.push(...session.cleanups);
    session.disposePromise = Promise.allSettled(disposals).then(() => {
      session.cleanups.clear();
      this.#sessions.delete(session);
    });
    return session.disposePromise;
  }

  #available() {
    if (this.#disposed) throw failure("OPENBOT_SUBAGENT_CANCELLED");
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    const disposals = [...this.#sessions].map((session) => this.#disposeSession(session));
    this.#disposePromise = Promise.allSettled(disposals).then(() => {
      this.#issuedTaskIds.clear();
      this.#issuedConversationIds.clear();
      this.#issuedInvocationIds.clear();
    });
    return this.#disposePromise;
  }
}

module.exports = {
  SPAWN_SUBAGENT_TOOL,
  StandaloneSubagentError,
  StandaloneSubagentRunner,
};
