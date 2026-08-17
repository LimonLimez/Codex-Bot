"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { types } = require("node:util");
const { normalizeInferenceSelection } = require("./inference-provider-router.cjs");

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CONVERSATIONS = 256;
const MAX_DELETE_BOTS = 256;
const MAX_MESSAGES = 512;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS = 16;
const MAX_TOOL_ARGS_BYTES = 1_000_000;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_SHELL_COMMAND_BYTES = 8192;
const MAX_SHELL_OUTPUT_BYTES = 128 * 1024;
const OPEN_CLEANUP_ACK_MS = 250;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const STANDALONE_TASK_ID = /^(?:parent|(?:standalone|subagent)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

class StandaloneConversationError extends Error {
  constructor(code = "OPENBOT_CONVERSATION_OPERATION_FAILED", message = "OpenBot conversation operation failed.") {
    super(message);
    this.name = "StandaloneConversationError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function failure(code = "OPENBOT_CONVERSATION_OPERATION_FAILED") {
  const message = code === "OPENBOT_CONVERSATION_STALE"
    ? "OpenBot conversation selection changed."
    : code === "OPENBOT_CONVERSATION_CANCELLED"
      ? "OpenBot conversation was cancelled."
      : "OpenBot conversation operation failed.";
  return new StandaloneConversationError(code, message);
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
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
    || !("value" in descriptors[key]))) throw failure();
  if ([...required].some((key) => !Object.hasOwn(descriptors, key))) throw failure();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function normalizedBotId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) throw failure();
  return value;
}

function normalizedConversationId(value) {
  if (typeof value !== "string" || !CONVERSATION_ID.test(value)) throw failure();
  return value;
}

function normalizedInvocationId(value) {
  if (typeof value !== "string" || !INVOCATION_ID.test(value)) throw failure();
  return value;
}

function boundedText(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) throw failure();
  return value;
}

function normalizedClientNonce(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 512) throw failure();
  return value;
}

function normalizedInputDigest(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw failure();
  return value;
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

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw failure();
  return value;
}

function persistedMessage(value) {
  const message = ownData(
    value,
    new Set(["messageId", "role", "text", "createdAt", "clientNonce", "inputDigest"]),
    new Set(["messageId", "role", "text", "createdAt"]),
  );
  if (typeof message.messageId !== "string"
    || !/^message-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.messageId)
    || !new Set(["user", "assistant"]).has(message.role)
    || typeof message.text !== "string" || message.text.includes("\0")
    || Buffer.byteLength(message.text, "utf8") > MAX_TEXT_BYTES) throw failure();
  const clientNonce = normalizedClientNonce(message.clientNonce);
  const inputDigest = normalizedInputDigest(message.inputDigest);
  if ((clientNonce === undefined) !== (inputDigest === undefined)
    || clientNonce !== undefined && message.role !== "user") throw failure();
  return publicValue({
    messageId: message.messageId,
    role: message.role,
    text: message.text,
    createdAt: timestamp(message.createdAt),
    ...(clientNonce === undefined ? {} : { clientNonce, inputDigest }),
  });
}

function persistedRecord(value) {
  const record = ownData(value, new Set([
    "botId", "conversationId", "createdAt", "updatedAt", "messages",
  ]));
  const createdAt = timestamp(record.createdAt);
  const updatedAt = timestamp(record.updatedAt);
  if (updatedAt < createdAt) throw failure();
  return {
    botId: normalizedBotId(record.botId),
    conversationId: normalizedConversationId(record.conversationId),
    createdAt,
    updatedAt,
    status: "idle",
    messages: denseArray(record.messages, MAX_MESSAGES).map(persistedMessage),
  };
}

function durableValue(record) {
  return publicValue({
    botId: record.botId,
    conversationId: record.conversationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messages: record.messages,
  });
}

function cloneJson(value, state = { seen: new Set(), bytes: 0, nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 4096 || depth > 12 || state.bytes > MAX_TOOL_RESULT_BYTES) throw failure();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw failure();
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > MAX_TOOL_RESULT_BYTES) throw failure();
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
  return publicValue(output);
}

function toolDefinitions(value) {
  const definitions = denseArray(value, 64);
  const names = new Set();
  for (const definition of definitions) {
    const raw = ownData(definition, new Set(["type", "name", "description", "parameters", "function"]), new Set());
    const nested = raw.function === undefined ? raw : ownData(
      raw.function,
      new Set(["name", "description", "parameters"]),
      new Set(["name", "parameters"]),
    );
    const name = nested.name;
    if ((raw.type !== undefined && raw.type !== "function") || typeof name !== "string"
      || !TOOL_NAME.test(name) || names.has(name)) throw failure();
    names.add(name);
    cloneJson(nested.parameters);
    if (nested.description !== undefined && typeof nested.description !== "string") throw failure();
  }
  return Object.freeze({ definitions: publicValue(definitions), names });
}

function toolResultContent(value) {
  const cloned = cloneJson(value);
  let text;
  try { text = JSON.stringify(cloned); } catch { throw failure(); }
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_RESULT_BYTES) throw failure();
  return publicValue({ content: [{ type: "text", text }] });
}

function reviewedShellResult(value) {
  const result = ownData(value, new Set(["exitCode", "stdout", "stderr"]));
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
    || typeof result.stdout !== "string" || typeof result.stderr !== "string"
    || result.stdout.includes("\0") || result.stderr.includes("\0")
    || Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > MAX_SHELL_OUTPUT_BYTES) {
    throw failure();
  }
  const descriptor = (text) => Object.freeze({
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
  return publicValue({
    exitCode: result.exitCode,
    stdout: descriptor(result.stdout),
    stderr: descriptor(result.stderr),
  });
}

const REVIEWED_COMPUTER_TOOLS = Object.freeze([
  Object.freeze({
    type: "function",
    name: "browser_navigate",
    description: "Open a public HTTPS page in this bot's Local Desktop browser.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({ url: Object.freeze({ type: "string", format: "uri" }) }),
      required: Object.freeze(["url"]),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    type: "function",
    name: "browser_capture",
    description: "Inspect metadata for this bot's current Local Desktop browser frame.",
    parameters: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
  }),
]);

const REVIEWED_SHELL_TOOL = Object.freeze({
  type: "function",
  name: "shell_execute",
  description: "Run one bounded full-host command after explicit permission. Output is returned only as metadata.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      command: Object.freeze({ type: "string", maxLength: MAX_SHELL_COMMAND_BYTES }),
    }),
    required: Object.freeze(["command"]),
    additionalProperties: false,
  }),
});

function createStandaloneComputerToolBridge({ computerTargetRouter } = {}) {
  if (!computerTargetRouter || typeof computerTargetRouter !== "object" || types.isProxy(computerTargetRouter)
    || ["resolve", "run", "disposeTask"].some((name) => typeof computerTargetRouter[name] !== "function")) {
    throw failure();
  }
  return Object.freeze({
    async open(rawIdentity, rawSignal = null) {
      let validSignal = rawSignal === null;
      try { validSignal ||= rawSignal instanceof AbortSignal; } catch { throw failure(); }
      if (!validSignal) throw failure();
      const identity = ownData(rawIdentity, new Set(["botId", "conversationId", "taskId"]));
      identity.botId = normalizedBotId(identity.botId);
      identity.conversationId = normalizedConversationId(identity.conversationId);
      if (typeof identity.taskId !== "string" || !STANDALONE_TASK_ID.test(identity.taskId)) throw failure();
      let rawTarget;
      try { rawTarget = await computerTargetRouter.resolve(Object.freeze({ ...identity }), rawSignal); }
      catch (error) {
        if (new Set([
          "OPENBOT_COMPUTER_NOT_CONFIGURED",
          "OPENBOT_COMPUTER_TARGET_UNAVAILABLE",
          "OPENBOT_CURSOR_COMPUTER_UNAVAILABLE",
          "OPENBOT_LOCAL_DESKTOP_START_FAILED",
          "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE",
        ]).has(error?.code)) {
          return Object.freeze({
            ...identity,
            definitions: Object.freeze([]),
            async dispatch() { throw failure(); },
            async dispose() {},
          });
        }
        throw failure();
      }
      const target = ownData(rawTarget, new Set([
        "mode", "botId", "targetId", "targetGeneration", "workspaceId", "tools",
      ]));
      const supported = new Set(denseArray(target.tools, 32));
      if (target.mode !== "local" || target.botId !== identity.botId
        || typeof target.targetId !== "string"
        || !/^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.targetId)
        || !Number.isSafeInteger(target.targetGeneration) || target.targetGeneration < 0
        || typeof target.workspaceId !== "string" || !/^workspace-[a-f0-9]{64}$/.test(target.workspaceId)
        || !supported.has("browser.navigate") || !supported.has("browser.capture")) throw failure();
      const supportsShell = supported.has("shell.execute");
      const subagentTask = identity.taskId.startsWith("subagent-");
      if (subagentTask && typeof computerTargetRouter.assertTaskCurrent !== "function") throw failure();
      const definitions = supportsShell
        ? Object.freeze([...REVIEWED_COMPUTER_TOOLS, REVIEWED_SHELL_TOOL])
        : REVIEWED_COMPUTER_TOOLS;
      let disposed = false;
      return Object.freeze({
        ...identity,
        definitions,
        ...(subagentTask ? {
          async assertCurrent() {
            if (disposed) throw failure();
            try {
              await computerTargetRouter.assertTaskCurrent(Object.freeze({
                mode: target.mode,
                botId: identity.botId,
                taskId: identity.taskId,
                targetId: target.targetId,
                targetGeneration: target.targetGeneration,
                workspaceId: target.workspaceId,
              }));
            } catch { throw failure(); }
          },
        } : {}),
        async dispatch(rawCall) {
          if (disposed) throw failure();
          const call = ownData(rawCall, new Set([
            "botId", "conversationId", "taskId", "invocationId", "toolCallId", "toolName", "args",
          ]));
          if (call.botId !== identity.botId || call.conversationId !== identity.conversationId
            || call.taskId !== identity.taskId || typeof call.invocationId !== "string"
            || !INVOCATION_ID.test(call.invocationId) || typeof call.toolCallId !== "string"
            || !TOOL_CALL_ID.test(call.toolCallId)
            || !new Set([
              "browser_navigate",
              "browser_capture",
              ...(supportsShell ? ["shell_execute"] : []),
            ]).has(call.toolName)) throw failure();
          let operation;
          let argumentsValue;
          if (call.toolName === "browser_navigate") {
            const args = ownData(call.args, new Set(["url"]));
            if (typeof args.url !== "string" || args.url.length === 0
              || Buffer.byteLength(args.url, "utf8") > 4096 || args.url.includes("\0")) throw failure();
            operation = "browser.navigate";
            argumentsValue = Object.freeze({ url: args.url });
          } else if (call.toolName === "browser_capture") {
            ownData(call.args, new Set(), new Set());
            operation = "browser.capture";
            argumentsValue = Object.freeze({});
          } else {
            const args = ownData(call.args, new Set(["command"]));
            if (typeof args.command !== "string" || args.command.length === 0
              || args.command.includes("\0")
              || Buffer.byteLength(args.command, "utf8") > MAX_SHELL_COMMAND_BYTES) throw failure();
            operation = "shell.execute";
            argumentsValue = Object.freeze({ command: args.command });
          }
          try {
            const result = await computerTargetRouter.run(Object.freeze({
              mode: target.mode,
              botId: identity.botId,
              conversationId: identity.conversationId,
              taskId: identity.taskId,
              targetId: target.targetId,
              targetGeneration: target.targetGeneration,
              workspaceId: target.workspaceId,
              capability: operation,
              operation,
              arguments: argumentsValue,
              resourceId: operation === "shell.execute" ? "full-host-shell" : "browser",
              resourceLabel: operation === "shell.execute" ? "Full host shell" : "OpenBot Browser",
              reason: operation === "browser.navigate"
                ? "Open a page in this bot's browser"
                : operation === "browser.capture"
                  ? "Capture this bot's current browser frame"
                  : "Full host shell as your macOS user, not confined to this workspace",
            }));
            return operation === "shell.execute" ? reviewedShellResult(result) : result;
          } catch { throw failure(); }
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          try { await computerTargetRouter.disposeTask(Object.freeze({ botId: identity.botId, taskId: identity.taskId })); }
          catch { throw failure(); }
        },
      });
    },
  });
}

function publicValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(publicValue));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, publicValue(nested)]),
  ));
}

function sameSelection(left, right) {
  return left.botId === right.botId
    && left.generation === right.generation
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
    && left.serviceTier === right.serviceTier;
}

function safeId(makeId, prefix) {
  let value;
  try { value = makeId(); } catch { throw failure(); }
  if (typeof value !== "string" || !UUID.test(value)) throw failure();
  return `${prefix}-${value}`;
}

function utf8Preview(value, maximum = 160) {
  if (typeof value !== "string" || maximum <= 0) return "";
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maximum) break;
    output += character;
    bytes += next;
  }
  return output;
}

function summary(record) {
  return publicValue({
    botId: record.botId,
    conversationId: record.conversationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    preview: utf8Preview(record.messages.at(-1)?.text ?? ""),
    messageCount: record.messages.length,
  });
}

function fullConversation(record) {
  return publicValue({
    botId: record.botId,
    conversationId: record.conversationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    status: record.status,
    preview: utf8Preview(record.messages.at(-1)?.text ?? ""),
    messages: record.messages,
  });
}

function deletedConversationResult(value) {
  const result = ownData(value, new Set(["deletedConversationIds"]));
  const deletedConversationIds = denseArray(
    result.deletedConversationIds,
    MAX_CONVERSATIONS,
  ).map(normalizedConversationId);
  if (new Set(deletedConversationIds).size !== deletedConversationIds.length) throw failure();
  return publicValue({ deletedConversationIds });
}

function disposeMergedSource(session) {
  if (!session.fulfilled) return Promise.resolve();
  if (!session.disposePromise) {
    session.disposePromise = Promise.resolve().then(async () => {
      const operation = session.raw
        && Object.getOwnPropertyDescriptor(session.raw, "dispose")?.value;
      if (typeof operation === "function") await operation.call(session.raw);
    });
  }
  return session.disposePromise;
}

async function openMergedToolSession({
  identity, selection, toolBridge, subagentRunner, signal, sourceRecords,
}) {
  const sources = [];
  if (toolBridge) sources.push(Object.freeze({ bridge: toolBridge, identity }));
  if (subagentRunner) sources.push(Object.freeze({
    bridge: subagentRunner,
    identity: Object.freeze({ ...identity, selection }),
  }));
  const sessions = [];
  const routes = new Map();
  const definitions = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    let failed = false;
    for (const session of [...sessions].reverse()) {
      try { await disposeMergedSource(session); } catch { failed = true; }
    }
    if (failed) throw failure();
  };
  try {
    for (const source of sources) {
      const session = {
        cleanupPromise: null,
        dispatch: null,
        disposePromise: null,
        fulfilled: false,
        promise: null,
        raw: null,
        settled: false,
      };
      session.promise = Promise.resolve().then(
        () => source.bridge.open(source.identity, signal),
      ).then(
        (opened) => {
          session.fulfilled = true;
          session.raw = opened;
          session.settled = true;
          return opened;
        },
        (error) => {
          session.settled = true;
          throw error;
        },
      );
      sessions.push(session);
      sourceRecords.push(session);
      const opened = await session.promise;
      if (signal.aborted) throw failure("OPENBOT_CONVERSATION_CANCELLED");
      const normalizedSession = ownData(
        opened,
        new Set(["botId", "conversationId", "taskId", "definitions", "dispatch", "dispose"]),
        new Set(["botId", "conversationId", "taskId", "definitions", "dispatch"]),
      );
      if (normalizedSession.botId !== identity.botId
        || normalizedSession.conversationId !== identity.conversationId
        || normalizedSession.taskId !== identity.taskId
        || typeof normalizedSession.dispatch !== "function"
        || (normalizedSession.dispose !== undefined && typeof normalizedSession.dispose !== "function")) throw failure();
      const catalog = toolDefinitions(normalizedSession.definitions);
      if ([...catalog.names].some((name) => routes.has(name))) throw failure();
      session.dispatch = normalizedSession.dispatch;
      definitions.push(...catalog.definitions);
      for (const name of catalog.names) routes.set(name, session);
    }
    return Object.freeze({
      ...identity,
      definitions: Object.freeze(definitions),
      async dispatch(rawCall) {
        if (disposed) throw failure();
        const call = ownData(rawCall, new Set([
          "botId", "conversationId", "taskId", "invocationId", "toolCallId", "toolName", "args",
        ]));
        if (call.botId !== identity.botId || call.conversationId !== identity.conversationId
          || call.taskId !== identity.taskId || typeof call.toolName !== "string") throw failure();
        const session = routes.get(call.toolName);
        if (!session) throw failure();
        return session.dispatch.call(session.raw, rawCall);
      },
      dispose,
    });
  } catch {
    try { await dispose(); } catch {}
    throw failure();
  }
}

class StandaloneConversationController extends EventEmitter {
  #router;
  #readSelection;
  #store;
  #toolBridge;
  #subagentRunner;
  #makeId;
  #now;
  #setCleanupTimeout;
  #clearCleanupTimeout;
  #conversations = new Map();
  #active = new Map();
  #reservations = new Set();
  #reservationCompletions = new Map();
  #selectionMutations = new Map();
  #botEpochs = new Map();
  #deleteClaims = new Map();
  #deleteOperations = new Map();
  #durableMutationTails = new Map();
  #disposePromise = null;
  #disposed = false;

  constructor(rawOptions = {}) {
    super();
    const options = ownData(
      rawOptions,
      new Set([
        "router", "readSelection", "store", "toolBridge", "subagentRunner", "makeId", "now",
        "setCleanupTimeout", "clearCleanupTimeout",
      ]),
      new Set(["router", "readSelection"]),
    );
    if (!options.router || typeof options.router !== "object" || types.isProxy(options.router)
      || typeof options.router.stream !== "function" || typeof options.readSelection !== "function"
      || (options.store !== undefined && (!options.store || typeof options.store !== "object"
        || types.isProxy(options.store) || ["list", "read", "create", "replace", "deleteBots"]
          .some((name) => typeof options.store[name] !== "function")))
      || (options.toolBridge !== undefined && (!options.toolBridge || typeof options.toolBridge !== "object"
        || types.isProxy(options.toolBridge) || typeof options.toolBridge.open !== "function"))
      || (options.subagentRunner !== undefined && (!options.subagentRunner
        || typeof options.subagentRunner !== "object" || types.isProxy(options.subagentRunner)
        || typeof options.subagentRunner.open !== "function" || typeof options.subagentRunner.dispose !== "function"))
      || (options.makeId !== undefined && typeof options.makeId !== "function")
      || (options.now !== undefined && typeof options.now !== "function")
      || (options.setCleanupTimeout !== undefined && typeof options.setCleanupTimeout !== "function")
      || (options.clearCleanupTimeout !== undefined && typeof options.clearCleanupTimeout !== "function")
      || ((options.setCleanupTimeout === undefined) !== (options.clearCleanupTimeout === undefined))) throw failure();
    this.#router = options.router;
    this.#readSelection = options.readSelection;
    this.#store = options.store || null;
    this.#toolBridge = options.toolBridge || null;
    this.#subagentRunner = options.subagentRunner || null;
    this.#makeId = options.makeId || randomUUID;
    this.#now = options.now || (() => new Date().toISOString());
    this.#setCleanupTimeout = options.setCleanupTimeout || setTimeout;
    this.#clearCleanupTimeout = options.clearCleanupTimeout || clearTimeout;
  }

  emit(eventName, ...args) {
    for (const listener of this.rawListeners(eventName)) {
      try { void Promise.resolve(listener.call(this, ...args)).catch(() => {}); } catch {}
    }
    return this.listenerCount(eventName) > 0;
  }

  list(rawBotId) {
    this.#available();
    const botId = normalizedBotId(rawBotId);
    const botEpoch = this.#botEpochs.get(botId) ?? 0;
    if (this.#store) {
      this.#assertBotFence(botId, botEpoch);
      return this.#listDurable(botId, botEpoch);
    }
    return Object.freeze([...this.#conversations.values()]
      .filter((record) => record.botId === botId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(summary));
  }

  create(rawRequest) {
    this.#available();
    const request = ownData(rawRequest, new Set(["botId"]));
    const botId = normalizedBotId(request.botId);
    if (this.#deleteClaims.has(botId)) throw failure("OPENBOT_CONVERSATION_STALE");
    const botEpoch = this.#botEpochs.get(botId) ?? 0;
    if (this.#conversations.size >= MAX_CONVERSATIONS) throw failure();
    const timestamp = this.#timestamp();
    const conversationId = safeId(this.#makeId, "conversation");
    const record = {
      botId,
      conversationId,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "idle",
      messages: [],
    };
    if (this.#store) return this.#createDurable(record, botEpoch);
    this.#conversations.set(conversationId, record);
    const value = summary(record);
    this.emit("changed", value);
    return value;
  }

  read(rawRequest) {
    this.#available();
    const request = ownData(rawRequest, new Set(["botId", "conversationId"]));
    if (this.#store) {
      const botId = normalizedBotId(request.botId);
      const conversationId = normalizedConversationId(request.conversationId);
      const botEpoch = this.#botEpochs.get(botId) ?? 0;
      this.#assertBotFence(botId, botEpoch);
      return this.#readDurable({ botId, conversationId }, botEpoch);
    }
    return fullConversation(this.#record(request));
  }

  deleteBots(rawRequest) {
    this.#available();
    if (!this.#store) throw failure();
    const request = ownData(rawRequest, new Set(["botIds"]));
    const botIds = denseArray(request.botIds, MAX_DELETE_BOTS).map(normalizedBotId);
    if (botIds.length === 0 || new Set(botIds).size !== botIds.length) throw failure();
    const operationKey = botIds.join("\0");
    const existing = this.#deleteOperations.get(operationKey);
    if (existing) return existing;
    for (const botId of botIds) {
      const owner = this.#deleteClaims.get(botId);
      if (owner !== undefined && owner !== operationKey) throw failure();
    }
    for (const botId of botIds) {
      if (this.#deleteClaims.has(botId)) continue;
      this.#deleteClaims.set(botId, operationKey);
      this.#botEpochs.set(botId, (this.#botEpochs.get(botId) ?? 0) + 1);
    }

    let resolveOperation;
    let rejectOperation;
    const operation = new Promise((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.#deleteOperations.set(operationKey, operation);
    void this.#performDeleteBots(botIds).then(
      resolveOperation,
      () => {
        if (this.#deleteOperations.get(operationKey) === operation) {
          this.#deleteOperations.delete(operationKey);
        }
        rejectOperation(failure());
      },
    );
    return operation;
  }

  async send(rawRequest) {
    this.#available();
    const request = ownData(
      rawRequest,
      new Set(["botId", "conversationId", "text", "attachments", "clientNonce", "inputDigest"]),
      new Set(["botId", "conversationId", "text"]),
    );
    if (request.attachments !== undefined) throw failure();
    const owner = normalizedBotId(request.botId);
    const conversationId = normalizedConversationId(request.conversationId);
    const text = boundedText(request.text);
    const clientNonce = normalizedClientNonce(request.clientNonce);
    const inputDigest = normalizedInputDigest(request.inputDigest);
    if ((clientNonce === undefined) !== (inputDigest === undefined)) throw failure();
    const reservationKey = `${owner}\0${conversationId}`;
    if (this.#selectionMutations.has(owner) || this.#deleteClaims.has(owner)) {
      throw failure("OPENBOT_CONVERSATION_STALE");
    }
    if (this.#reservations.has(reservationKey) || this.#active.has(conversationId)) throw failure();
    const botEpoch = this.#botEpochs.get(owner) ?? 0;
    let settleReservation;
    let rejectReservationCancellation;
    const reservationCancellation = new Promise((resolve, reject) => {
      rejectReservationCancellation = reject;
    });
    void reservationCancellation.catch(() => {});
    const reservation = {
      abortController: new AbortController(),
      botId: owner,
      cancellation: reservationCancellation,
      cancellationError: null,
      cancellationSettled: false,
      cleanupAckPromise: null,
      cleanupPromise: null,
      disposePromise: null,
      done: new Promise((resolve) => { settleReservation = resolve; }),
      openPromise: null,
      openSources: [],
      rejectCancellation: rejectReservationCancellation,
    };
    this.#reservations.add(reservationKey);
    this.#reservationCompletions.set(reservationKey, reservation);
    let transferred = false;
    try {
    let record = this.#store
      ? await this.#requiredDurableRecord({ botId: owner, conversationId }, botEpoch)
      : this.#record({ botId: owner, conversationId });
    this.#assertBotFence(owner, botEpoch);
    if (record.messages.length >= MAX_MESSAGES - 1) throw failure();
    let selected;
    try { selected = normalizeInferenceSelection(await this.#readSelection(record.botId)); }
    catch { throw failure(); }
    this.#assertBotFence(owner, botEpoch);
    if (selected.botId !== record.botId) throw failure("OPENBOT_CONVERSATION_STALE");
    const createdAt = this.#timestamp();
    const user = publicValue({
      messageId: safeId(this.#makeId, "message"),
      role: "user",
      text,
      createdAt,
      ...(clientNonce === undefined ? {} : { clientNonce, inputDigest }),
    });
    const invocationId = safeId(this.#makeId, "invocation");
    const taskId = `standalone-${invocationId.slice("invocation-".length)}`;
    const abortController = reservation.abortController;
    const nextRecord = {
      ...record,
      updatedAt: createdAt,
      status: "streaming",
      messages: [...record.messages, user],
    };
    if (this.#store) {
      try { await this.#replaceDurable(nextRecord); } catch { throw failure(); }
      try {
        this.#assertBotFence(owner, botEpoch);
      } catch (error) {
        const idleRecord = { ...nextRecord, status: "idle", updatedAt: this.#timestamp() };
        try { await this.#replaceDurable(idleRecord); } catch { throw failure(); }
        this.#conversations.set(idleRecord.conversationId, idleRecord);
        throw error;
      }
    }
    record = nextRecord;
    this.#conversations.set(record.conversationId, record);
    let toolSession = null;
    let rawToolSession = null;
    const disposeToolSession = async () => {
      if (!rawToolSession) return;
      return this.#disposeOpeningSession(reservation, rawToolSession);
    };
    let tools = Object.freeze([]);
    let toolNames = new Set();
    if (this.#toolBridge || this.#subagentRunner) {
      try {
        const identity = Object.freeze({
          botId: record.botId,
          conversationId: record.conversationId,
          taskId,
        });
        reservation.openPromise = openMergedToolSession({
          identity,
          selection: selected,
          toolBridge: this.#toolBridge,
          subagentRunner: this.#subagentRunner,
          signal: reservation.abortController.signal,
          sourceRecords: reservation.openSources,
        });
        const opened = await Promise.race([reservation.openPromise, reservation.cancellation]);
        rawToolSession = opened;
        if (reservation.cancellationSettled) throw reservation.cancellationError;
        this.#assertBotFence(owner, botEpoch);
        toolSession = ownData(
          opened,
          new Set(["botId", "conversationId", "taskId", "definitions", "dispatch", "dispose"]),
          new Set(["botId", "conversationId", "taskId", "definitions", "dispatch"]),
        );
        if (toolSession.botId !== identity.botId
          || toolSession.conversationId !== identity.conversationId
          || toolSession.taskId !== identity.taskId
          || typeof toolSession.dispatch !== "function"
          || (toolSession.dispose !== undefined && typeof toolSession.dispose !== "function")) throw failure();
        const normalized = toolDefinitions(toolSession.definitions);
        tools = normalized.definitions;
        toolNames = normalized.names;
      } catch (error) {
        try { await disposeToolSession(); } catch {}
        record.status = "idle";
        record.updatedAt = this.#timestamp();
        if (this.#store) {
          try { await this.#replaceDurable(record); } catch { throw failure(); }
        }
        this.#conversations.set(record.conversationId, record);
        if (error?.code === "OPENBOT_CONVERSATION_STALE"
          || error?.code === "OPENBOT_CONVERSATION_CANCELLED") throw error;
        throw failure();
      }
    }
    this.#assertBotFence(owner, botEpoch);
    const operation = {
      abortController,
      botEpoch,
      cancelled: false,
      cancelPromise: null,
      conversationId: record.conversationId,
      invocationId,
      record,
      selection: selected,
      context: record.messages.map((message) => publicValue({ role: message.role, content: message.text })),
      round: 0,
      seenToolCalls: new Set(),
      text: "",
      toolNames,
      tools,
      toolSession,
      disposeToolSession,
    };
    this.#active.set(record.conversationId, operation);
    this.#reservations.delete(reservationKey);
    if (this.#reservationCompletions.get(reservationKey) === reservation) {
      this.#reservationCompletions.delete(reservationKey);
    }
    settleReservation();
    transferred = true;
    this.emit("changed", summary(record));
    let result;
    try {
      result = await this.#startRound(operation);
    } catch (error) {
      try { await disposeToolSession(); } catch {}
      if (this.#active.get(record.conversationId) === operation) {
        this.#active.delete(record.conversationId);
      }
      if (operation.cancelled) throw failure("OPENBOT_CONVERSATION_CANCELLED");
      record.status = "idle";
      record.updatedAt = this.#timestamp();
      this.emit("changed", summary(record));
      const normalized = error?.code === "OPENBOT_CONVERSATION_STALE"
        ? failure("OPENBOT_CONVERSATION_STALE") : failure();
      this.emit("event", publicValue({
        type: "failed", botId: record.botId, conversationId: record.conversationId,
        invocationId, generation: selected.generation, code: normalized.code,
      }));
      throw normalized;
    }
    void this.#consume(operation, result);
    return publicValue({
      botId: record.botId,
      conversationId: record.conversationId,
      invocationId,
      generation: selected.generation,
      status: "streaming",
    });
    } finally {
      if (!transferred) this.#reservations.delete(reservationKey);
      if (this.#reservationCompletions.get(reservationKey) === reservation) {
        this.#reservationCompletions.delete(reservationKey);
      }
      settleReservation();
    }
  }

  withModelSelectionMutation(rawBotId, operation) {
    this.#available();
    const botId = normalizedBotId(rawBotId);
    if (typeof operation !== "function" || types.isProxy(operation)) throw failure();
    if (this.#deleteClaims.has(botId)) throw failure("OPENBOT_CONVERSATION_STALE");
    this.#botEpochs.set(botId, (this.#botEpochs.get(botId) ?? 0) + 1);
    const previous = this.#selectionMutations.get(botId) ?? Promise.resolve();
    const result = previous.then(async () => {
      this.#available();
      const active = [...this.#active.values()]
        .filter((candidate) => candidate.record.botId === botId);
      const reservations = [...this.#reservationCompletions.values()]
        .filter((candidate) => candidate.botId === botId);
      await Promise.all([
        ...active.map((candidate) => this.#cancelActiveOperation(candidate)),
        ...reservations.map((candidate) => this.#cancelOpeningReservation(
          candidate,
          "OPENBOT_CONVERSATION_STALE",
        )),
      ]);
      this.#available();
      return operation();
    });
    const tail = result.then(() => undefined, () => undefined);
    this.#selectionMutations.set(botId, tail);
    void tail.then(() => {
      if (this.#selectionMutations.get(botId) === tail) this.#selectionMutations.delete(botId);
    });
    return result;
  }

  async cancel(rawRequest) {
    this.#available();
    const request = ownData(rawRequest, new Set(["botId", "conversationId", "invocationId"]));
    const record = this.#record(request);
    const invocationId = normalizedInvocationId(request.invocationId);
    const operation = this.#active.get(record.conversationId);
    if (!operation || operation.invocationId !== invocationId || operation.cancelled) throw failure();
    return this.#cancelActiveOperation(operation);
  }

  #cancelActiveOperation(operation) {
    if (operation.cancelPromise) return operation.cancelPromise;
    operation.cancelled = true;
    try { operation.abortController.abort(failure("OPENBOT_CONVERSATION_CANCELLED")); } catch {}
    operation.cancelPromise = (async () => {
      try { await operation.disposeToolSession(); } catch {
        if (this.#active.get(operation.record.conversationId) === operation) {
          this.#active.delete(operation.record.conversationId);
        }
        operation.record.status = "idle";
        operation.record.updatedAt = this.#timestamp();
        this.#conversations.set(operation.record.conversationId, operation.record);
        this.emit("changed", summary(operation.record));
        throw failure();
      }
      if (this.#active.get(operation.record.conversationId) === operation) {
        this.#active.delete(operation.record.conversationId);
      }
      operation.record.status = "idle";
      operation.record.updatedAt = this.#timestamp();
      if (this.#store) {
        try { await this.#replaceDurable(operation.record); } catch { throw failure(); }
      }
      this.#conversations.set(operation.record.conversationId, operation.record);
      this.emit("changed", summary(operation.record));
      const value = publicValue({
        botId: operation.record.botId,
        conversationId: operation.record.conversationId,
        invocationId: operation.invocationId,
        generation: operation.selection.generation,
        status: "cancelled",
      });
      this.emit("event", publicValue({
        type: "cancelled",
        botId: value.botId,
        conversationId: value.conversationId,
        invocationId: value.invocationId,
        generation: value.generation,
      }));
      return value;
    })();
    return operation.cancelPromise;
  }

  #disposeOpeningSession(reservation, rawSession) {
    if (reservation.disposePromise) return reservation.disposePromise;
    reservation.disposePromise = Promise.resolve().then(async () => {
      const dispose = rawSession && Object.getOwnPropertyDescriptor(rawSession, "dispose")?.value;
      if (typeof dispose === "function") await dispose.call(rawSession);
    });
    return reservation.disposePromise;
  }

  #cancelOpeningReservation(reservation, code) {
    if (!reservation.cancellationSettled) {
      reservation.cancellationSettled = true;
      const error = failure(code);
      reservation.cancellationError = error;
      try { reservation.abortController.abort(error); } catch {}
      reservation.rejectCancellation(error);
    }
    if (!reservation.openPromise) return reservation.done;
    if (!reservation.cleanupPromise) {
      reservation.cleanupPromise = reservation.openPromise.then(
        (opened) => this.#disposeOpeningSession(reservation, opened).catch(() => {}),
        () => undefined,
      );
    }
    for (const source of reservation.openSources) {
      if (source.cleanupPromise) continue;
      source.cleanupPromise = source.promise.then(
        () => disposeMergedSource(source).catch(() => {}),
        () => undefined,
      );
    }
    if (!reservation.cleanupAckPromise) {
      const sourceAcks = reservation.openSources.map(
        (source) => this.#pendingSourceCleanupAck(source),
      );
      reservation.cleanupAckPromise = Promise.all([
        ...sourceAcks,
        reservation.done,
      ]).then(() => undefined);
    }
    return reservation.cleanupAckPromise;
  }

  #pendingSourceCleanupAck(source) {
    if (source.settled) {
      return source.fulfilled
        ? disposeMergedSource(source).then(() => undefined, () => undefined)
        : Promise.resolve();
    }
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
      source.promise.then(
        () => {
          if (acknowledged) return;
          openArrived = true;
          clear();
          disposeMergedSource(source).then(finish, finish);
        },
        () => {
          openArrived = true;
          finish();
        },
      );
    });
  }

  async #consume(operation, result) {
    try {
      let currentResult = result;
      for (;;) {
        const round = await this.#consumeRound(operation, currentResult);
        if (round.finishReason === "stop") break;
        if (round.finishReason !== "tool-calls" || round.calls.length === 0
          || !operation.toolSession || operation.round >= MAX_TOOL_ROUNDS) throw failure();
        const assistantContent = [];
        if (round.text) assistantContent.push(publicValue({ type: "text", text: round.text }));
        assistantContent.push(...round.calls.map((call) => publicValue({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.args,
        })));
        operation.context.push(publicValue({ role: "assistant", content: assistantContent }));
        const results = [];
        for (const call of round.calls) {
          await this.#assertCurrent(operation);
          let value;
          try {
            value = await operation.toolSession.dispatch(Object.freeze({
              botId: operation.record.botId,
              conversationId: operation.conversationId,
              taskId: operation.toolSession.taskId,
              invocationId: operation.invocationId,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              args: call.args,
            }));
          } catch { throw failure(); }
          await this.#assertCurrent(operation);
          results.push(publicValue({
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            result: toolResultContent(value),
            isError: false,
          }));
        }
        operation.context.push(publicValue({ role: "tool", content: results }));
        operation.round += 1;
        currentResult = await this.#startRound(operation);
      }
      await this.#assertCurrent(operation);
      if (this.#disposed || operation.cancelled) return;
      await operation.disposeToolSession();
      await this.#assertCurrent(operation);
      if (this.#disposed || operation.cancelled) return;
      let completedRecord = operation.record;
      if (operation.text.length > 0) {
        const assistant = publicValue({
          messageId: safeId(this.#makeId, "message"),
          role: "assistant",
          text: operation.text,
          createdAt: this.#timestamp(),
        });
        completedRecord = {
          ...completedRecord,
          messages: [...completedRecord.messages, assistant],
        };
      }
      completedRecord.status = "idle";
      completedRecord.updatedAt = this.#timestamp();
      if (this.#store) {
        try { await this.#replaceDurable(completedRecord); } catch { throw failure(); }
        this.#assertBotFence(completedRecord.botId, operation.botEpoch);
      }
      operation.record = completedRecord;
      this.#conversations.set(completedRecord.conversationId, completedRecord);
      if (this.#active.get(operation.conversationId) === operation) {
        this.#active.delete(operation.conversationId);
      }
      this.emit("changed", summary(completedRecord));
      this.emit("event", publicValue({
        type: "completed",
        botId: completedRecord.botId,
        conversationId: operation.conversationId,
        invocationId: operation.invocationId,
        generation: operation.selection.generation,
      }));
    } catch (error) {
      if (this.#disposed || operation.cancelled) return;
      const code = error?.code === "OPENBOT_CONVERSATION_STALE"
        || error?.code === "CODEX_INFERENCE_STALE"
        ? "OPENBOT_CONVERSATION_STALE"
        : "OPENBOT_CONVERSATION_OPERATION_FAILED";
      try { operation.abortController.abort(failure(code)); } catch {}
      operation.record.status = "idle";
      operation.record.updatedAt = this.#timestamp();
      this.#conversations.set(operation.record.conversationId, operation.record);
      this.emit("changed", summary(operation.record));
      this.emit("event", publicValue({
        type: "failed",
        botId: operation.record.botId,
        conversationId: operation.conversationId,
        invocationId: operation.invocationId,
        generation: operation.selection.generation,
        code,
      }));
    } finally {
      try { await operation.disposeToolSession(); } catch {}
      if (this.#active.get(operation.conversationId) === operation) {
        this.#active.delete(operation.conversationId);
      }
    }
  }

  async #startRound(operation) {
    await this.#assertCurrent(operation);
    let result;
    try {
      result = await this.#router.stream(Object.freeze({
        selection: operation.selection,
        conversationId: operation.conversationId,
        messages: Object.freeze([...operation.context]),
        tools: operation.tools,
        toolChoice: operation.tools.length > 0 ? "auto" : "none",
        invocationId: operation.invocationId,
        signal: operation.abortController.signal,
      }));
    } catch (error) {
      if (error?.code === "CODEX_INFERENCE_STALE") throw failure("OPENBOT_CONVERSATION_STALE");
      throw failure();
    }
    await this.#assertCurrent(operation);
    if (!result || typeof result !== "object" || types.isProxy(result)
      || !result.fullStream || typeof result.fullStream[Symbol.asyncIterator] !== "function") throw failure();
    return result;
  }

  async #consumeRound(operation, result) {
    let finishReason = null;
    let roundText = "";
    const started = new Map();
    const argumentBytes = new Map();
    let roundArgumentBytes = 0;
    const calls = [];
    for await (const rawEvent of result.fullStream) {
      if (this.#disposed || operation.cancelled) throw failure("OPENBOT_CONVERSATION_CANCELLED");
      await this.#assertCurrent(operation);
      const event = ownData(rawEvent, new Set([
        "type", "textDelta", "toolCallId", "toolName", "argsTextDelta", "args",
        "finishReason", "usage",
      ]), new Set(["type"]));
      if (event.type === "text-delta") {
        if (finishReason !== null || typeof event.textDelta !== "string" || event.textDelta.includes("\0")) throw failure();
        if (Buffer.byteLength(operation.text + event.textDelta, "utf8") > MAX_TEXT_BYTES) throw failure();
        operation.text += event.textDelta;
        roundText += event.textDelta;
        this.emit("event", publicValue({
          type: "text-delta",
          botId: operation.record.botId,
          conversationId: operation.conversationId,
          invocationId: operation.invocationId,
          generation: operation.selection.generation,
          text: event.textDelta,
        }));
        continue;
      }
      if (event.type === "tool-call-streaming-start") {
        if (finishReason !== null || !operation.toolSession
          || typeof event.toolCallId !== "string" || !TOOL_CALL_ID.test(event.toolCallId)
          || typeof event.toolName !== "string" || !operation.toolNames.has(event.toolName)
          || started.has(event.toolCallId) || operation.seenToolCalls.has(event.toolCallId)) throw failure();
        started.set(event.toolCallId, event.toolName);
        continue;
      }
      if (event.type === "tool-call-delta") {
        if (finishReason !== null || typeof event.argsTextDelta !== "string"
          || event.argsTextDelta.includes("\0")
          || started.get(event.toolCallId) !== event.toolName) throw failure();
        const bytes = Buffer.byteLength(event.argsTextDelta, "utf8");
        const callBytes = (argumentBytes.get(event.toolCallId) ?? 0) + bytes;
        roundArgumentBytes += bytes;
        if (callBytes > MAX_TOOL_ARGS_BYTES || roundArgumentBytes > MAX_TOOL_ARGS_BYTES) throw failure();
        argumentBytes.set(event.toolCallId, callBytes);
        continue;
      }
      if (event.type === "tool-call") {
        if (finishReason !== null || calls.length >= MAX_TOOL_CALLS
          || started.get(event.toolCallId) !== event.toolName
          || operation.seenToolCalls.has(event.toolCallId)) throw failure();
        const args = cloneJson(event.args);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw failure();
        operation.seenToolCalls.add(event.toolCallId);
        calls.push(publicValue({ toolCallId: event.toolCallId, toolName: event.toolName, args }));
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
    return { calls, finishReason, text: roundText };
  }

  async #assertCurrent(operation) {
    if (this.#disposed || operation.cancelled) throw failure("OPENBOT_CONVERSATION_CANCELLED");
    this.#assertBotFence(operation.record.botId, operation.botEpoch);
    let current;
    try { current = normalizeInferenceSelection(await this.#readSelection(operation.record.botId)); }
    catch { throw failure("OPENBOT_CONVERSATION_STALE"); }
    if (this.#disposed || operation.cancelled) throw failure("OPENBOT_CONVERSATION_CANCELLED");
    this.#assertBotFence(operation.record.botId, operation.botEpoch);
    if (!sameSelection(operation.selection, current)) throw failure("OPENBOT_CONVERSATION_STALE");
  }

  #assertBotFence(botId, epoch) {
    this.#available();
    if (this.#selectionMutations.has(botId) || this.#deleteClaims.has(botId)
      || (this.#botEpochs.get(botId) ?? 0) !== epoch) {
      throw failure("OPENBOT_CONVERSATION_STALE");
    }
  }

  async #performDeleteBots(botIds) {
    const targets = new Set(botIds);
    const active = [...this.#active.values()]
      .filter((candidate) => targets.has(candidate.record.botId));
    const reservations = [...this.#reservationCompletions.values()]
      .filter((candidate) => targets.has(candidate.botId));
    await Promise.all([
      ...active.map((candidate) => this.#cancelActiveOperation(candidate)),
      ...reservations.map((candidate) => this.#cancelOpeningReservation(
        candidate,
        "OPENBOT_CONVERSATION_STALE",
      )),
    ]);
    await Promise.all(botIds.map(
      (botId) => this.#durableMutationTails.get(botId) ?? Promise.resolve(),
    ));
    this.#available();
    let result;
    try {
      result = deletedConversationResult(await this.#store.deleteBots(publicValue({ botIds })));
    } catch { throw failure(); }
    this.#available();
    for (const [conversationId, record] of this.#conversations) {
      if (targets.has(record.botId)) this.#conversations.delete(conversationId);
    }
    return result;
  }

  #replaceDurable(record) {
    return this.#mutateDurable(
      record.botId,
      () => this.#store.replace(durableValue(record)),
    );
  }

  #mutateDurable(botId, mutation) {
    const previous = this.#durableMutationTails.get(botId) ?? Promise.resolve();
    const result = previous.then(mutation);
    const tail = result.then(() => undefined, () => undefined);
    this.#durableMutationTails.set(botId, tail);
    void tail.then(() => {
      if (this.#durableMutationTails.get(botId) === tail) {
        this.#durableMutationTails.delete(botId);
      }
    });
    return result;
  }

  async #listDurable(botId, botEpoch) {
    let values;
    try { values = denseArray(await this.#store.list(botId), MAX_CONVERSATIONS); }
    catch { throw failure(); }
    this.#assertBotFence(botId, botEpoch);
    const records = values.map(persistedRecord);
    if (records.some((record) => record.botId !== botId)) throw failure();
    for (const record of records) this.#conversations.set(record.conversationId, record);
    return Object.freeze(records
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(summary));
  }

  async #createDurable(record, botEpoch) {
    try {
      await this.#mutateDurable(
        record.botId,
        () => this.#store.create(durableValue(record)),
      );
    } catch { throw failure(); }
    this.#assertBotFence(record.botId, botEpoch);
    this.#conversations.set(record.conversationId, record);
    const value = summary(record);
    this.emit("changed", value);
    return value;
  }

  async #readDurable(request, botEpoch) {
    const record = await this.#requiredDurableRecord(request, botEpoch);
    return fullConversation(record);
  }

  async #requiredDurableRecord(rawRequest, botEpoch) {
    const owner = normalizedBotId(rawRequest.botId);
    const conversationId = normalizedConversationId(rawRequest.conversationId);
    let value;
    try { value = await this.#store.read(owner, conversationId); } catch { throw failure(); }
    this.#assertBotFence(owner, botEpoch);
    if (value == null) throw failure();
    const record = persistedRecord(value);
    if (record.botId !== owner || record.conversationId !== conversationId) throw failure();
    const active = this.#active.get(conversationId);
    if (active) return active.record;
    this.#conversations.set(conversationId, record);
    return record;
  }

  #record(rawRequest) {
    const botId = normalizedBotId(rawRequest.botId);
    const conversationId = normalizedConversationId(rawRequest.conversationId);
    const record = this.#conversations.get(conversationId);
    if (!record || record.botId !== botId) throw failure();
    return record;
  }

  #timestamp() {
    let value;
    try { value = this.#now(); } catch { throw failure(); }
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) throw failure();
    return value;
  }

  #available() {
    if (this.#disposed) throw failure();
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    let settleDispose;
    this.#disposePromise = new Promise((resolve) => { settleDispose = resolve; });
    this.#disposed = true;
    const operations = [...this.#active.values()];
    const reservations = [...this.#reservationCompletions.values()];
    for (const operation of operations) {
      operation.cancelled = true;
      try { operation.abortController.abort(failure("OPENBOT_CONVERSATION_CANCELLED")); } catch {}
    }
    const reservationDisposals = reservations.map((reservation) => this.#cancelOpeningReservation(
      reservation,
      "OPENBOT_CONVERSATION_CANCELLED",
    ));
    this.#reservations.clear();
    this.#selectionMutations.clear();
    this.removeAllListeners();
    const teardown = (async () => {
      await Promise.all([
        ...operations.map(async (operation) => {
          try { await operation.disposeToolSession(); } catch {}
        }),
        ...reservationDisposals,
      ]);
      this.#active.clear();
      try { await this.#subagentRunner?.dispose(); } catch {}
    })();
    void teardown.then(settleDispose, settleDispose);
    return this.#disposePromise;
  }
}

module.exports = {
  createStandaloneComputerToolBridge,
  StandaloneConversationController,
  StandaloneConversationError,
};
