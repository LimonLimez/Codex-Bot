"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const { types } = require("node:util");

const MAX_FRAME_BYTES = 1_250_000;
const MAX_CONNECTIONS = 32;
const AUTH_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 150_000;
const CAPABILITY = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_PROOF = /^[a-f0-9]{64}$/;
const LOCAL_TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKSPACE_ID = /^workspace-[a-f0-9]{64}$/;
const FRAME_ID = /^frame-[a-f0-9]{64}$/;
const COMPUTER_UNAVAILABLE_CODES = new Set([
  "OPENBOT_COMPUTER_NOT_CONFIGURED",
  "OPENBOT_CURSOR_COMPUTER_UNAVAILABLE",
  "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE",
]);
const LOCAL_TARGET_CAPABILITIES = new Set([
  "browser.navigate",
  "browser.capture",
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const TOOL_CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CHILD_TOOL_ROUNDS = 8;
const MAX_CHILD_TOOL_CALLS = 16;
const MAX_CHILD_TOOL_ARGUMENT_BYTES = 1_000_000;
const MAX_CHILD_TOOL_RESULT_BYTES = 256 * 1024;
const MAX_CHILD_TEXT_BYTES = 64 * 1024;
const MAX_SHELL_COMMAND_BYTES = 8192;
const MAX_SHELL_OUTPUT_BYTES = 128 * 1024;

const REVIEWED_COMPUTER_TOOLS = Object.freeze([
  Object.freeze({
    capability: "browser.navigate",
    definition: Object.freeze({
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
  }),
  Object.freeze({
    capability: "browser.capture",
    definition: Object.freeze({
      type: "function",
      name: "browser_capture",
      description: "Inspect metadata for this bot's current Local Desktop browser frame.",
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze({}),
        additionalProperties: false,
      }),
    }),
  }),
  Object.freeze({
    capability: "shell.execute",
    definition: Object.freeze({
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
    }),
  }),
]);

class InferenceBridgeServerError extends Error {
  constructor() {
    super("Codex inference bridge is unavailable.");
    this.name = "InferenceBridgeServerError";
    this.code = "CODEX_BRIDGE_UNAVAILABLE";
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function fail() { throw new InferenceBridgeServerError(); }

function safeOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail();
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !("value" in descriptors[key]))) fail();
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  } catch (error) {
    if (error instanceof InferenceBridgeServerError) throw error;
    fail();
  }
}

function cloneJsonNode(value, state, depth = 0) {
  state.nodes += 1;
  if (depth > 12 || state.nodes > 4096 || state.bytes > state.maximumBytes) fail();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8");
    if (state.bytes > state.maximumBytes) fail();
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.seen.has(value)) fail();
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch { fail(); }
  const array = Array.isArray(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)
      || !("value" in descriptors[key]))) fail();
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) fail();
  }
  state.seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > state.maximumBytes) fail();
    copy[key] = cloneJsonNode(descriptors[key].value, state, depth + 1);
  }
  state.seen.delete(value);
  return Object.freeze(copy);
}

function cloneJson(value, maximumBytes) {
  const copy = cloneJsonNode(value, {
    bytes: 0,
    maximumBytes,
    nodes: 0,
    seen: new Set(),
  });
  let serialized;
  try { serialized = JSON.stringify(copy); } catch { fail(); }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) fail();
  return copy;
}

function exactJsonObject(value, fields, maximumBytes = MAX_CHILD_TOOL_ARGUMENT_BYTES) {
  const copy = cloneJson(value, maximumBytes);
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) fail();
  const keys = Object.keys(copy);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))
    || [...fields].some((key) => !Object.hasOwn(copy, key))) fail();
  return copy;
}

function targetCapabilities(value) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 32) fail();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  const elements = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
  if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) fail();
  const seen = new Set();
  const capabilities = [];
  for (let index = 0; index < value.length; index += 1) {
    const capability = descriptors[index]?.value;
    if (typeof capability !== "string" || !LOCAL_TARGET_CAPABILITIES.has(capability)
      || seen.has(capability)) fail();
    seen.add(capability);
    capabilities.push(capability);
  }
  return Object.freeze(capabilities);
}

function reviewedToolCatalog(target) {
  const supported = new Set(target.tools);
  const selected = REVIEWED_COMPUTER_TOOLS.filter(({ capability }) => supported.has(capability));
  return Object.freeze({
    definitions: Object.freeze(selected.map(({ definition }) => definition)),
    names: new Set(selected.map(({ definition }) => definition.name)),
  });
}

function reviewedShellResult(value) {
  const result = exactJsonObject(value, new Set(["exitCode", "stdout", "stderr"]), MAX_SHELL_OUTPUT_BYTES + 1024);
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
    || typeof result.stdout !== "string" || typeof result.stderr !== "string"
    || result.stdout.includes("\0") || result.stderr.includes("\0")
    || Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > MAX_SHELL_OUTPUT_BYTES) fail();
  const descriptor = (text) => Object.freeze({
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
  });
  return Object.freeze({
    exitCode: result.exitCode,
    stdout: descriptor(result.stdout),
    stderr: descriptor(result.stderr),
  });
}

function reviewedNavigateResult(value) {
  const result = safeOptions(value);
  if (result.state !== "ready") fail();
  return Object.freeze({ state: "ready" });
}

function reviewedCaptureResult(value) {
  const result = safeOptions(value);
  if (typeof result.frameId !== "string" || !FRAME_ID.test(result.frameId)
    || !Number.isSafeInteger(result.width) || result.width < 1 || result.width > 8192
    || !Number.isSafeInteger(result.height) || result.height < 1 || result.height > 8192
    || result.mimeType !== "image/png") fail();
  return Object.freeze({
    frameId: result.frameId,
    width: result.width,
    height: result.height,
    mimeType: result.mimeType,
  });
}

function toolResultContent(value) {
  const copy = cloneJson(value, MAX_CHILD_TOOL_RESULT_BYTES);
  let text;
  try { text = JSON.stringify(copy); } catch { fail(); }
  if (Buffer.byteLength(text, "utf8") > MAX_CHILD_TOOL_RESULT_BYTES) fail();
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text", text })]),
  });
}

function safeCapability(value) {
  if (typeof value !== "string" || !CAPABILITY.test(value)) fail();
  return value;
}

function sameCapability(left, right) {
  try {
    const a = Buffer.from(left, "ascii");
    const b = Buffer.from(right, "ascii");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function safeRequest(value) {
  const request = safeOptions(value);
  const allowed = new Set([
    "selection", "conversationId", "taskId", "taskProof", "messages", "tools", "toolChoice", "invocationId",
  ]);
  if (Object.keys(request).some((key) => !allowed.has(key))) fail();
  return request;
}

function expectedTaskProof(capability, botId, conversationId, taskId) {
  return crypto.createHmac("sha256", capability)
    .update("openbot-native-task\0", "utf8")
    .update(botId, "utf8")
    .update("\0", "utf8")
    .update(conversationId, "utf8")
    .update("\0", "utf8")
    .update(taskId, "utf8")
    .digest("hex");
}

function sameProof(left, right) {
  try {
    const a = Buffer.from(left, "ascii");
    const b = Buffer.from(right, "ascii");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function nativeIdentity(request, capability) {
  if (typeof request.conversationId !== "string" || !SAFE_ID.test(request.conversationId)
    || request.conversationId.includes("..")
    || typeof request.taskId !== "string" || !SAFE_ID.test(request.taskId)
    || request.taskId.includes("..")) fail();
  const selection = safeOptions(request.selection);
  if (typeof selection.botId !== "string" || !BOT_ID.test(selection.botId)) fail();
  if (typeof request.taskProof !== "string" || !TASK_PROOF.test(request.taskProof)
    || !sameProof(
      request.taskProof,
      expectedTaskProof(capability, selection.botId, request.conversationId, request.taskId),
    )) fail();
  return Object.freeze({
    botId: selection.botId,
    conversationId: request.conversationId,
    taskId: request.taskId,
  });
}

function privateWorkspaceId(capability, identity) {
  const digest = crypto.createHmac("sha256", capability)
    .update("openbot-native-workspace\0", "utf8")
    .update(identity.botId, "utf8")
    .update("\0", "utf8")
    .update(identity.conversationId, "utf8")
    .update("\0", "utf8")
    .update(identity.taskId, "utf8")
    .digest("hex");
  return `workspace-${digest}`;
}

function computerUnavailable(error) {
  try { return COMPUTER_UNAVAILABLE_CODES.has(error?.code); } catch { return false; }
}

function childTarget(value, identity) {
  const target = safeOptions(value);
  const fields = ["botId", "mode", "targetGeneration", "targetId", "tools", "workspaceId"];
  if (Object.keys(target).sort().join(",") !== fields.sort().join(",")
    || target.mode !== "local" || target.botId !== identity.botId
    || typeof target.targetId !== "string" || !LOCAL_TARGET_ID.test(target.targetId)
    || !Number.isSafeInteger(target.targetGeneration) || target.targetGeneration < 0
    || typeof target.workspaceId !== "string" || !WORKSPACE_ID.test(target.workspaceId)) fail();
  return Object.freeze({
    botId: target.botId,
    mode: target.mode,
    targetGeneration: target.targetGeneration,
    targetId: target.targetId,
    tools: targetCapabilities(target.tools),
    workspaceId: target.workspaceId,
  });
}

function targetCurrentRequest(identity, target) {
  return Object.freeze({
    mode: target.mode,
    botId: identity.botId,
    taskId: identity.taskId,
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    workspaceId: target.workspaceId,
  });
}

function reviewedToolAction(identity, target, call) {
  let operation;
  let argumentsValue;
  if (call.toolName === "browser_navigate") {
    const args = exactJsonObject(call.args, new Set(["url"]));
    if (typeof args.url !== "string" || args.url.length === 0 || args.url.includes("\0")
      || Buffer.byteLength(args.url, "utf8") > 4096) fail();
    operation = "browser.navigate";
    argumentsValue = Object.freeze({ url: args.url });
  } else if (call.toolName === "browser_capture") {
    exactJsonObject(call.args, new Set());
    operation = "browser.capture";
    argumentsValue = Object.freeze({});
  } else if (call.toolName === "shell_execute") {
    const args = exactJsonObject(call.args, new Set(["command"]), MAX_SHELL_COMMAND_BYTES + 128);
    if (typeof args.command !== "string" || args.command.length === 0 || args.command.includes("\0")
      || Buffer.byteLength(args.command, "utf8") > MAX_SHELL_COMMAND_BYTES) fail();
    operation = "shell.execute";
    argumentsValue = Object.freeze({ command: args.command });
  } else fail();
  return Object.freeze({
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
  });
}

function reviewedToolResult(action, value) {
  if (action.operation === "browser.navigate") return reviewedNavigateResult(value);
  if (action.operation === "browser.capture") return reviewedCaptureResult(value);
  if (action.operation === "shell.execute") return reviewedShellResult(value);
  fail();
}

function childStreamEvent(value) {
  const event = safeOptions(value);
  const exact = (fields) => {
    const keys = Object.keys(event);
    if (keys.length !== fields.size || keys.some((key) => !fields.has(key))
      || [...fields].some((key) => !Object.hasOwn(event, key))) fail();
  };
  if (event.type === "text-delta") {
    exact(new Set(["type", "textDelta"]));
    if (typeof event.textDelta !== "string" || event.textDelta.includes("\0")) fail();
    return Object.freeze({ type: event.type, textDelta: event.textDelta });
  }
  if (event.type === "tool-call-streaming-start") {
    exact(new Set(["type", "toolCallId", "toolName"]));
    if (typeof event.toolCallId !== "string" || !TOOL_CALL_ID.test(event.toolCallId)
      || typeof event.toolName !== "string") fail();
    return Object.freeze({
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }
  if (event.type === "tool-call-delta") {
    exact(new Set(["type", "toolCallId", "toolName", "argsTextDelta"]));
    if (typeof event.toolCallId !== "string" || !TOOL_CALL_ID.test(event.toolCallId)
      || typeof event.toolName !== "string" || typeof event.argsTextDelta !== "string"
      || event.argsTextDelta.includes("\0")) fail();
    return Object.freeze({
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsTextDelta: event.argsTextDelta,
    });
  }
  if (event.type === "tool-call") {
    exact(new Set(["type", "toolCallId", "toolName", "args"]));
    if (typeof event.toolCallId !== "string" || !TOOL_CALL_ID.test(event.toolCallId)
      || typeof event.toolName !== "string") fail();
    const args = cloneJson(event.args, MAX_CHILD_TOOL_ARGUMENT_BYTES);
    if (!args || typeof args !== "object" || Array.isArray(args)) fail();
    return Object.freeze({
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args,
    });
  }
  if (event.type === "finish") {
    exact(new Set(["type", "finishReason", "usage"]));
    if (!new Set(["stop", "tool-calls"]).has(event.finishReason)) fail();
    return Object.freeze({
      type: event.type,
      finishReason: event.finishReason,
      usage: cloneJson(event.usage, 64 * 1024),
    });
  }
  fail();
}

function chatOnlyChildStreamEvent(value) {
  const event = childStreamEvent(value);
  if (event.type === "text-delta"
    || (event.type === "finish" && event.finishReason === "stop")) return event;
  fail();
}

function assertNotAborted(signal) {
  if (signal.aborted) fail();
}

function publicCode(error) {
  if (error?.code === "CODEX_INFERENCE_CANCELLED") return "CODEX_BRIDGE_CANCELLED";
  if (error?.code === "CODEX_INFERENCE_DISPOSED") return "CODEX_BRIDGE_DISPOSED";
  if (error?.code === "CODEX_INFERENCE_STALE") return "CODEX_BRIDGE_STALE";
  if (error?.code === "CODEX_INFERENCE_TIMEOUT") return "CODEX_BRIDGE_TIMEOUT";
  return "CODEX_BRIDGE_UNAVAILABLE";
}

class InferenceBridgeServer {
  #router;
  #computerTargetRouter;
  #capability;
  #net;
  #server = null;
  #starting = null;
  #cancelStart = null;
  #sockets = new Set();
  #activeTasks = new Map();
  #disposed = false;

  constructor(rawOptions = {}) {
    const options = safeOptions(rawOptions);
    if (Object.keys(options).some((key) => !["router", "computerTargetRouter", "capability", "netImpl"].includes(key))
      || !options.router || typeof options.router !== "object" || types.isProxy(options.router)
      || typeof options.router.stream !== "function"
      || !options.computerTargetRouter || typeof options.computerTargetRouter !== "object"
      || types.isProxy(options.computerTargetRouter)
      || typeof options.computerTargetRouter.resolve !== "function"
      || (options.netImpl !== undefined && (!options.netImpl || typeof options.netImpl.createServer !== "function"))) {
      fail();
    }
    this.#router = options.router;
    this.#computerTargetRouter = options.computerTargetRouter;
    this.#capability = safeCapability(options.capability);
    this.#net = options.netImpl || net;
  }

  start() {
    if (this.#disposed) return Promise.reject(new InferenceBridgeServerError());
    if (this.#server?.listening) return Promise.resolve(this.#session());
    if (this.#starting) return this.#starting;
    this.#starting = new Promise((resolve, reject) => {
      let server;
      try { server = this.#net.createServer((socket) => this.#accept(socket)); }
      catch { reject(new InferenceBridgeServerError()); return; }
      this.#server = server;
      let settled = false;
      const failStart = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.#server === server) this.#server = null;
        this.#starting = null;
        try { server.close(); } catch {}
        reject(new InferenceBridgeServerError());
      };
      const ready = () => {
        if (settled) return;
        if (this.#disposed) { failStart(); return; }
        settled = true;
        cleanup();
        this.#starting = null;
        resolve(this.#session());
      };
      const cleanup = () => {
        server.off("error", failStart);
        server.off("listening", ready);
        server.off("close", failStart);
        if (this.#cancelStart === failStart) this.#cancelStart = null;
      };
      this.#cancelStart = failStart;
      server.once("error", failStart);
      server.once("listening", ready);
      server.once("close", failStart);
      try { server.listen({ host: "127.0.0.1", port: 0, exclusive: true }); }
      catch { failStart(); }
    });
    return this.#starting;
  }

  #session() {
    const address = this.#server?.address?.();
    if (!address || typeof address !== "object" || address.address !== "127.0.0.1"
      || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) fail();
    const result = { endpoint: `tcp://127.0.0.1:${address.port}` };
    Object.defineProperty(result, "capability", {
      value: this.#capability,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return Object.freeze(result);
  }

  #accept(socket) {
    if (this.#disposed || this.#sockets.size >= MAX_CONNECTIONS
      || !socket || typeof socket.on !== "function") {
      try { socket?.destroy?.(); } catch {}
      return;
    }
    this.#sockets.add(socket);
    try { socket.setNoDelay?.(true); } catch {}
    try { socket.setTimeout?.(AUTH_TIMEOUT_MS); } catch {}
    let buffer = Buffer.alloc(0);
    let started = false;
    let terminal = false;
    const controller = new AbortController();
    const finish = () => {
      if (terminal) return false;
      terminal = true;
      this.#sockets.delete(socket);
      return true;
    };
    const close = () => {
      if (!finish()) return;
      try { controller.abort(new InferenceBridgeServerError()); } catch {}
    };
    const terminate = () => {
      close();
      try { socket.destroy(); } catch {}
    };
    const reject = (code = "CODEX_BRIDGE_UNAVAILABLE") => {
      if (terminal) return;
      void this.#write(socket, { type: "error", code }).catch(() => {}).finally(() => {
        finish();
        try { socket.end(); } catch { try { socket.destroy(); } catch {} }
      });
    };
    socket.on("error", terminate);
    socket.on("close", close);
    socket.on("timeout", terminate);
    socket.on("data", (rawChunk) => {
      if (terminal) return;
      let chunk;
      try { chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk); }
      catch { reject(); return; }
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { reject(); return; }
      while (!terminal) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        if (newline === 0 || newline > MAX_FRAME_BYTES) { reject(); return; }
        let message;
        try { message = safeOptions(JSON.parse(buffer.subarray(0, newline).toString("utf8"))); }
        catch { reject(); return; }
        buffer = buffer.subarray(newline + 1);
        if (started) {
          if (Object.keys(message).length !== 1 || message.type !== "cancel") {
            reject();
            return;
          }
          try { controller.abort(new InferenceBridgeServerError()); } catch {}
          if (finish()) {
            try { socket.end(); } catch { try { socket.destroy(); } catch {} }
          }
          return;
        }
        started = true;
        if (message.type !== "start" || !sameCapability(this.#capability, message.capability)) {
          reject();
          return;
        }
        try { socket.setTimeout?.(OPERATION_TIMEOUT_MS); } catch {}
        let request;
        try { request = safeRequest(message.request); }
        catch { reject(); return; }
        void this.#serve(socket, controller, request).then(() => {
          if (!finish()) return;
          try { socket.end(); } catch { try { socket.destroy(); } catch {} }
        }, (error) => reject(publicCode(error)));
      }
    });
  }

  async #serve(socket, controller, rawRequest) {
    const identity = nativeIdentity(rawRequest, this.#capability);
    assertNotAborted(controller.signal);
    const taskKey = `${identity.botId}\0${identity.conversationId}\0${identity.taskId}`;
    this.#activeTasks.set(taskKey, (this.#activeTasks.get(taskKey) ?? 0) + 1);
    try {
      const { taskId: _privateTaskId, taskProof: _privateTaskProof, ...providerFields } = rawRequest;
      if (identity.taskId === "parent") {
        await this.#serveSingle(socket, controller, Object.freeze({
          ...providerFields,
          signal: controller.signal,
        }));
        return;
      }

      let target;
      try {
        target = childTarget(
          await this.#computerTargetRouter.resolve(identity, controller.signal),
          identity,
        );
      } catch (error) {
        assertNotAborted(controller.signal);
        if (!computerUnavailable(error)) throw error;
        await this.#serveChatOnlyChild(socket, controller, Object.freeze({
          ...providerFields,
          tools: Object.freeze([]),
          toolChoice: "none",
          workspaceId: privateWorkspaceId(this.#capability, identity),
          signal: controller.signal,
        }));
        return;
      }
      const catalog = reviewedToolCatalog(target);
      if (typeof this.#computerTargetRouter.assertTaskCurrent !== "function"
        || typeof this.#computerTargetRouter.disposeTask !== "function"
        || (catalog.definitions.length > 0 && typeof this.#computerTargetRouter.run !== "function")) fail();
      let disposePromise = null;
      const disposeTarget = () => {
        if (!disposePromise) {
          disposePromise = Promise.resolve()
            .then(() => this.#computerTargetRouter.disposeTask(Object.freeze({
              botId: identity.botId,
              taskId: identity.taskId,
            })))
            .catch(() => { throw new InferenceBridgeServerError(); });
        }
        return disposePromise;
      };
      const onAbort = () => { void disposeTarget().catch(() => {}); };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      try {
        assertNotAborted(controller.signal);
        const done = await this.#serveTargetChild(
          socket,
          controller,
          providerFields,
          identity,
          target,
          catalog,
        );
        await disposeTarget();
        assertNotAborted(controller.signal);
        await this.#write(socket, done);
      } finally {
        try { controller.signal.removeEventListener("abort", onAbort); } catch {}
        try { await disposeTarget(); } catch {}
      }
    } finally {
      const retained = this.#activeTasks.get(taskKey) ?? 0;
      if (retained <= 1) this.#activeTasks.delete(taskKey);
      else this.#activeTasks.set(taskKey, retained - 1);
    }
  }

  async #serveSingle(socket, controller, request) {
    const result = await this.#startProvider(request);
    for await (const value of result.fullStream) {
      assertNotAborted(controller.signal);
      await this.#write(socket, { type: "event", value });
    }
    const metadata = await this.#resultMetadata(result);
    assertNotAborted(controller.signal);
    await this.#write(socket, { type: "done", ...metadata });
  }

  async #serveChatOnlyChild(socket, controller, request) {
    assertNotAborted(controller.signal);
    const result = await this.#startProvider(request);
    let finishEvent = null;
    let textBytes = 0;
    for await (const rawEvent of result.fullStream) {
      assertNotAborted(controller.signal);
      const event = chatOnlyChildStreamEvent(rawEvent);
      if (finishEvent !== null) fail();
      if (event.type === "text-delta") {
        textBytes += Buffer.byteLength(event.textDelta, "utf8");
        if (textBytes > MAX_CHILD_TEXT_BYTES) fail();
        await this.#write(socket, { type: "event", value: event });
      } else {
        finishEvent = event;
      }
    }
    if (finishEvent === null) fail();
    const metadata = await this.#resultMetadata(result);
    assertNotAborted(controller.signal);
    await this.#write(socket, { type: "event", value: finishEvent });
    await this.#write(socket, { type: "done", ...metadata });
  }

  async #serveTargetChild(socket, controller, providerFields, identity, target, catalog) {
    if (!Array.isArray(providerFields.messages) || types.isProxy(providerFields.messages)) fail();
    let messages = Object.freeze([...providerFields.messages]);
    const state = {
      rounds: 0,
      seenToolCalls: new Set(),
      totalTextBytes: 0,
    };
    for (;;) {
      await this.#assertTargetCurrent(identity, target, controller.signal);
      const result = await this.#startProvider(Object.freeze({
        ...providerFields,
        messages,
        tools: catalog.definitions,
        toolChoice: catalog.definitions.length > 0 ? "auto" : "none",
        workspaceId: target.workspaceId,
        signal: controller.signal,
      }));
      const round = await this.#consumeChildRound(
        socket,
        controller,
        result,
        identity,
        target,
        catalog,
        state,
      );
      const metadata = await this.#resultMetadata(result);
      assertNotAborted(controller.signal);
      await this.#assertTargetCurrent(identity, target, controller.signal);
      if (round.finishReason === "stop") return Object.freeze({ type: "done", ...metadata });
      if (state.rounds >= MAX_CHILD_TOOL_ROUNDS) fail();

      const assistantContent = [];
      if (round.text !== "") {
        assistantContent.push(Object.freeze({ type: "text", text: round.text }));
      }
      assistantContent.push(...round.calls.map((call) => Object.freeze({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args,
      })));
      const results = [];
      for (const call of round.calls) {
        assertNotAborted(controller.signal);
        await this.#assertTargetCurrent(identity, target, controller.signal);
        const action = reviewedToolAction(identity, target, call);
        let rawResult;
        try { rawResult = await this.#computerTargetRouter.run(action); }
        catch { fail(); }
        assertNotAborted(controller.signal);
        await this.#assertTargetCurrent(identity, target, controller.signal);
        const resultValue = reviewedToolResult(action, rawResult);
        results.push(Object.freeze({
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          result: toolResultContent(resultValue),
          isError: false,
        }));
      }
      messages = Object.freeze([
        ...messages,
        Object.freeze({ role: "assistant", content: Object.freeze(assistantContent) }),
        Object.freeze({ role: "tool", content: Object.freeze(results) }),
      ]);
      state.rounds += 1;
    }
  }

  async #consumeChildRound(socket, controller, result, identity, target, catalog, state) {
    let finishReason = null;
    let finishEvent = null;
    let text = "";
    let roundArgumentBytes = 0;
    const argumentBytes = new Map();
    const started = new Map();
    const calls = [];
    for await (const rawEvent of result.fullStream) {
      assertNotAborted(controller.signal);
      await this.#assertTargetCurrent(identity, target, controller.signal);
      const event = childStreamEvent(rawEvent);
      if (finishReason !== null) fail();
      if (event.type === "text-delta") {
        const bytes = Buffer.byteLength(event.textDelta, "utf8");
        if (state.totalTextBytes + bytes > MAX_CHILD_TEXT_BYTES) fail();
        state.totalTextBytes += bytes;
        text += event.textDelta;
        await this.#write(socket, { type: "event", value: event });
        continue;
      }
      if (event.type === "tool-call-streaming-start") {
        if (!catalog.names.has(event.toolName) || started.size >= MAX_CHILD_TOOL_CALLS
          || started.has(event.toolCallId) || state.seenToolCalls.has(event.toolCallId)) fail();
        started.set(event.toolCallId, event.toolName);
        continue;
      }
      if (event.type === "tool-call-delta") {
        if (started.get(event.toolCallId) !== event.toolName
          || state.seenToolCalls.has(event.toolCallId)) fail();
        const bytes = Buffer.byteLength(event.argsTextDelta, "utf8");
        const nextCallBytes = (argumentBytes.get(event.toolCallId) ?? 0) + bytes;
        roundArgumentBytes += bytes;
        if (nextCallBytes > MAX_CHILD_TOOL_ARGUMENT_BYTES
          || roundArgumentBytes > MAX_CHILD_TOOL_ARGUMENT_BYTES) fail();
        argumentBytes.set(event.toolCallId, nextCallBytes);
        continue;
      }
      if (event.type === "tool-call") {
        if (calls.length >= MAX_CHILD_TOOL_CALLS
          || started.get(event.toolCallId) !== event.toolName
          || state.seenToolCalls.has(event.toolCallId)) fail();
        state.seenToolCalls.add(event.toolCallId);
        calls.push(event);
        continue;
      }
      finishReason = event.finishReason;
      finishEvent = event;
    }
    if (finishReason === null || started.size !== calls.length
      || (finishReason === "stop" && calls.length !== 0)
      || (finishReason === "tool-calls" && calls.length === 0)) fail();
    if (finishReason === "stop") {
      await this.#assertTargetCurrent(identity, target, controller.signal);
      await this.#write(socket, { type: "event", value: finishEvent });
    }
    return Object.freeze({ calls: Object.freeze(calls), finishReason, text });
  }

  async #startProvider(request) {
    const result = await this.#router.stream(request);
    if (!result || typeof result !== "object" || types.isProxy(result)
      || !result.fullStream || typeof result.fullStream[Symbol.asyncIterator] !== "function") fail();
    return result;
  }

  async #resultMetadata(result) {
    const [usage, extendedUsage, providerMetadata, invocationId, response] = await Promise.all([
      result.usage,
      result.extendedUsage,
      result.providerMetadata,
      result.invocationId,
      result.response,
    ]);
    return Object.freeze({ usage, extendedUsage, providerMetadata, invocationId, response });
  }

  async #assertTargetCurrent(identity, expected, signal) {
    assertNotAborted(signal);
    try {
      await this.#computerTargetRouter.assertTaskCurrent(targetCurrentRequest(identity, expected));
    } catch { fail(); }
    assertNotAborted(signal);
  }

  #write(socket, value) {
    let serialized;
    try { serialized = `${JSON.stringify(value)}\n`; }
    catch { return Promise.reject(new InferenceBridgeServerError()); }
    if (Buffer.byteLength(serialized, "utf8") > MAX_FRAME_BYTES) {
      return Promise.reject(new InferenceBridgeServerError());
    }
    return new Promise((resolve, reject) => {
      try {
        socket.write(serialized, (error) => {
          if (error) reject(new InferenceBridgeServerError());
          else resolve();
        });
      } catch { reject(new InferenceBridgeServerError()); }
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelStart?.();
    for (const socket of this.#sockets) {
      try { socket.destroy(); } catch {}
    }
    this.#sockets.clear();
    this.#activeTasks.clear();
    try { this.#server?.close?.(); } catch {}
    this.#router.dispose?.();
  }
}

module.exports = {
  AUTH_TIMEOUT_MS,
  InferenceBridgeServer,
  InferenceBridgeServerError,
  MAX_CONNECTIONS,
  MAX_FRAME_BYTES,
  OPERATION_TIMEOUT_MS,
};
