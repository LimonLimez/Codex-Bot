"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { types } = require("node:util");
const {
  cloneJsonValue,
  encodeMessages,
  encodeToolChoice,
  encodeTools,
} = require("../bridge/message-codec.cjs");
const { normalizeInferenceSelection } = require("./inference-provider-router.cjs");

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const MAX_QUEUED_NOTIFICATIONS = 2_048;
const MAX_QUEUED_NOTIFICATION_BYTES = 2_000_000;

class CodexDirectInferenceError extends Error {
  constructor(code = "CODEX_INFERENCE_UNAVAILABLE", message = "Codex inference is unavailable.") {
    super(message);
    this.name = "CodexDirectInferenceError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function directError(code, message) {
  return new CodexDirectInferenceError(code, message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function safeIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : null;
}

function safeData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !("value" in descriptors[key]))) return null;
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    );
  } catch {
    return null;
  }
}

function managerLike(value) {
  return value && typeof value === "object" && !types.isProxy(value)
    && typeof value.start === "function" && typeof value.request === "function"
    && typeof value.on === "function" && typeof value.off === "function";
}

function safeWorkspace(value) {
  return typeof value === "string" && path.isAbsolute(value) && value.length <= 4096
    && value.trim() === value;
}

function transcriptInput(messages) {
  const input = [Object.freeze({
    type: "text",
    text: "Conversation transcript (oldest to newest):",
  })];
  for (const message of messages) {
    if (message.role === "user" && Array.isArray(message.content)) {
      input.push(Object.freeze({ type: "text", text: "User message:" }));
      for (const part of message.content) {
        if (part.type === "text") {
          input.push(Object.freeze({ type: "text", text: part.text }));
          continue;
        }
        const url = part?.image_url?.url;
        if (part.type !== "image_url" || typeof url !== "string" || !url.startsWith("data:image/")) {
          throw directError("CODEX_INFERENCE_PAYLOAD_INVALID", "Codex inference payload is invalid.");
        }
        input.push(Object.freeze({ type: "image", url, detail: null }));
      }
      continue;
    }
    let serialized;
    try { serialized = JSON.stringify(message); }
    catch { throw directError("CODEX_INFERENCE_PAYLOAD_INVALID", "Codex inference payload is invalid."); }
    input.push(Object.freeze({ type: "text", text: serialized }));
  }
  input.push(Object.freeze({
    type: "text",
    text: "Respond to the latest user message in that transcript.",
  }));
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 1_000_000) {
    throw directError("CODEX_INFERENCE_PAYLOAD_INVALID", "Codex inference payload is invalid.");
  }
  return Object.freeze(input);
}

function normalizeRequest(rawRequest) {
  const request = safeData(rawRequest);
  if (!request || !safeIdentifier(request.conversationId)
    || !safeIdentifier(request.invocationId) || typeof request.assertCurrent !== "function") {
    throw directError("CODEX_INFERENCE_PAYLOAD_INVALID", "Codex inference payload is invalid.");
  }
  let selection;
  let messages;
  let tools;
  try {
    selection = normalizeInferenceSelection(request.selection);
    messages = encodeMessages(request.messages);
    tools = encodeTools(request.tools);
  } catch {
    throw directError("CODEX_INFERENCE_PAYLOAD_INVALID", "Codex inference payload is invalid.");
  }
  if (selection.provider !== "openai-codex") {
    throw directError("CODEX_INFERENCE_PROVIDER_INVALID", "Codex inference provider is unavailable.");
  }
  const toolNames = new Set(tools.map((tool) => tool.function.name));
  let toolChoice;
  try { toolChoice = encodeToolChoice(request.toolChoice, toolNames); }
  catch { throw directError("CODEX_INFERENCE_PAYLOAD_INVALID", "Codex inference payload is invalid."); }
  const selectedTools = toolChoice === "none"
    ? []
    : typeof toolChoice === "object"
      ? tools.filter((tool) => tool.function.name === toolChoice.function.name)
      : tools;
  const dynamicTools = Object.freeze(selectedTools.map((tool) => Object.freeze({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters,
  })));
  const selectedToolNames = Object.freeze(selectedTools.map((tool) => tool.function.name));
  const forcedToolName = typeof toolChoice === "object" ? toolChoice.function.name : null;
  const instructions = [];
  const transcript = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") instructions.push(message.content);
    else transcript.push(message);
  }
  const signal = request.signal;
  if (signal !== undefined && (!signal || typeof signal !== "object"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function")) {
    throw directError("CODEX_INFERENCE_PAYLOAD_INVALID", "Codex inference payload is invalid.");
  }
  return Object.freeze({
    assertCurrent: request.assertCurrent,
    conversationId: request.conversationId,
    developerInstructions: instructions.length > 0 ? instructions.join("\n\n") : null,
    dynamicTools,
    forcedToolName,
    input: transcriptInput(transcript),
    invocationId: request.invocationId,
    selection,
    signal,
    toolNames: selectedToolNames,
  });
}

function normalizeUsage(rawUsage) {
  const usage = safeData(rawUsage);
  const last = safeData(usage?.last);
  if (!usage || !last) return null;
  const names = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ];
  if (names.some((name) => !Number.isSafeInteger(last[name]) || last[name] < 0)) return null;
  if (!(usage.modelContextWindow === null || usage.modelContextWindow === undefined
    || (Number.isSafeInteger(usage.modelContextWindow) && usage.modelContextWindow >= 0))) return null;
  return Object.freeze({
    basic: Object.freeze({
      promptTokens: last.inputTokens,
      completionTokens: last.outputTokens,
      totalTokens: last.totalTokens,
    }),
    extended: Object.freeze({
      inputTokens: last.inputTokens,
      outputTokens: last.outputTokens,
      cacheReadTokens: last.cachedInputTokens,
      cacheWriteTokens: last.cacheWriteInputTokens,
      maxTokens: usage.modelContextWindow ?? 0,
    }),
  });
}

class NotificationQueue {
  #values = [];
  #waiter = null;
  #error = null;
  #closed = false;
  #bytes = 0;

  push(value) {
    if (this.#closed || this.#error) return;
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(value), "utf8"); }
    catch {
      this.fail(directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed."));
      return;
    }
    if (this.#values.length >= MAX_QUEUED_NOTIFICATIONS
      || this.#bytes + bytes > MAX_QUEUED_NOTIFICATION_BYTES) {
      this.fail(directError("CODEX_INFERENCE_CAPACITY", "Codex inference capacity was exceeded."));
      return;
    }
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter.resolve({ value, done: false });
      return;
    }
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
  }

  fail(error) {
    if (this.#closed || this.#error) return;
    this.#error = error;
    this.#values = [];
    this.#bytes = 0;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter.reject(error);
    }
  }

  close() {
    if (this.#closed || this.#error) return;
    this.#closed = true;
    this.#values = [];
    this.#bytes = 0;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  next() {
    if (this.#values.length > 0) {
      const entry = this.#values.shift();
      this.#bytes -= entry.bytes;
      return Promise.resolve({ value: entry.value, done: false });
    }
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    if (this.#waiter) {
      return Promise.reject(directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed."));
    }
    return new Promise((resolve, reject) => { this.#waiter = { resolve, reject }; });
  }

  [Symbol.asyncIterator]() { return this; }
}

function stableFailure(error, fallbackCode = "CODEX_INFERENCE_UNAVAILABLE") {
  if (error instanceof CodexDirectInferenceError) return error;
  if (error?.code === "CODEX_INFERENCE_STALE") {
    return directError("CODEX_INFERENCE_STALE", "Codex inference selection changed.");
  }
  return directError(fallbackCode, fallbackCode === "CODEX_INFERENCE_FAILED"
    ? "Codex inference failed."
    : "Codex inference is unavailable.");
}

class CodexDirectInferenceTransport {
  #manager;
  #workspacePath;
  #setTimeout;
  #clearTimeout;
  #operationTimeoutMs;
  #disposed = false;
  #operations = new Set();

  constructor(rawOptions = {}) {
    const options = safeData(rawOptions);
    if (!options || !managerLike(options.manager) || !safeWorkspace(options.workspacePath)
      || (options.setTimeout !== undefined && typeof options.setTimeout !== "function")
      || (options.clearTimeout !== undefined && typeof options.clearTimeout !== "function")
      || (options.operationTimeoutMs !== undefined
        && (!Number.isSafeInteger(options.operationTimeoutMs)
          || options.operationTimeoutMs < 1 || options.operationTimeoutMs > 600_000))) {
      throw directError("CODEX_INFERENCE_CONFIGURATION", "Codex inference configuration is invalid.");
    }
    this.#manager = options.manager;
    this.#workspacePath = options.workspacePath;
    this.#setTimeout = options.setTimeout || setTimeout;
    this.#clearTimeout = options.clearTimeout || clearTimeout;
    this.#operationTimeoutMs = options.operationTimeoutMs || DEFAULT_OPERATION_TIMEOUT_MS;
  }

  stream(rawRequest) {
    if (this.#disposed) {
      throw directError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    }
    const request = normalizeRequest(rawRequest);
    const usage = deferred();
    const extendedUsage = deferred();
    const providerMetadata = deferred();
    const response = deferred();
    const operation = {
      request,
      queue: new NotificationQueue(),
      usage,
      extendedUsage,
      providerMetadata,
      response,
      threadId: null,
      turnId: null,
      managerGeneration: null,
      detach: [],
      timer: null,
      settled: false,
      completed: false,
      text: [],
      toolCalls: [],
      finalUsage: Object.freeze({
        basic: Object.freeze({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
        extended: Object.freeze({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          maxTokens: 0,
        }),
      }),
    };
    this.#operations.add(operation);
    const source = this.#run(operation);
    const owner = this;
    const fullStream = (async function* () {
      try { yield* source; }
      finally { await owner.#finish(operation); }
    })();
    return Object.freeze({
      extendedUsage: extendedUsage.promise,
      fullStream,
      invocationId: Promise.resolve(request.invocationId),
      providerMetadata: providerMetadata.promise,
      response: response.promise,
      usage: usage.promise,
    });
  }

  async *#run(operation) {
    try {
      await this.#assertCurrent(operation);
      await this.#manager.start();
      await this.#assertCurrent(operation);
      operation.managerGeneration = this.#manager.generation;
      if (!Number.isSafeInteger(operation.managerGeneration) || operation.managerGeneration < 1) {
        throw directError("CODEX_INFERENCE_UNAVAILABLE", "Codex inference is unavailable.");
      }
      const onNotification = (notification) => operation.queue.push(notification);
      const onDynamicToolCall = (request) => operation.queue.push(request);
      const onOffline = () => operation.queue.fail(
        directError("CODEX_INFERENCE_UNAVAILABLE", "Codex inference is unavailable."),
      );
      this.#manager.on("notification", onNotification);
      if (operation.request.dynamicTools.length > 0) {
        if (typeof this.#manager.declineDynamicToolCall !== "function") {
          throw directError("CODEX_INFERENCE_UNAVAILABLE", "Codex inference is unavailable.");
        }
        this.#manager.on("dynamic-tool-call", onDynamicToolCall);
        operation.detach.push(() => this.#manager.off("dynamic-tool-call", onDynamicToolCall));
      }
      this.#manager.on("offline", onOffline);
      operation.detach.push(() => this.#manager.off("notification", onNotification));
      operation.detach.push(() => this.#manager.off("offline", onOffline));
      const onAbort = () => {
        operation.queue.fail(directError("CODEX_INFERENCE_CANCELLED", "Codex inference was cancelled."));
        void this.#interrupt(operation);
      };
      const signal = operation.request.signal;
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        operation.detach.push(() => signal.removeEventListener("abort", onAbort));
        if (signal.aborted) onAbort();
      }
      operation.timer = this.#setTimeout(() => {
        operation.queue.fail(directError("CODEX_INFERENCE_TIMEOUT", "Codex inference timed out."));
        void this.#interrupt(operation);
      }, this.#operationTimeoutMs);
      operation.timer?.unref?.();

      const threadParams = {
        approvalPolicy: "never",
        cwd: this.#workspacePath,
        developerInstructions: operation.request.developerInstructions,
        ephemeral: true,
        model: operation.request.selection.model,
        modelProvider: "openai",
        sandbox: "read-only",
        serviceName: "codex-bot",
        serviceTier: operation.request.selection.serviceTier,
      };
      if (operation.request.dynamicTools.length > 0) {
        threadParams.dynamicTools = operation.request.dynamicTools;
      }
      const threadResult = safeData(await this.#manager.request("thread/start", threadParams, { timeoutMs: 30_000 }));
      const thread = safeData(threadResult?.thread);
      operation.threadId = safeIdentifier(thread?.id);
      if (!operation.threadId) throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed.");
      await this.#assertCurrent(operation);

      const turnResult = safeData(await this.#manager.request("turn/start", {
        approvalPolicy: "never",
        effort: operation.request.selection.reasoningEffort,
        input: operation.request.input,
        model: operation.request.selection.model,
        serviceTier: operation.request.selection.serviceTier,
        threadId: operation.threadId,
      }, { timeoutMs: 30_000 }));
      const turn = safeData(turnResult?.turn);
      operation.turnId = safeIdentifier(turn?.id);
      if (!operation.turnId) throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed.");
      await this.#assertCurrent(operation);

      for await (const rawNotification of operation.queue) {
        await this.#assertCurrent(operation);
        const notification = safeData(rawNotification);
        const params = safeData(notification?.params);
        if (!notification || typeof notification.method !== "string" || !params) {
          throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed.");
        }
        if (params.threadId !== operation.threadId) continue;
        if (notification.method === "item/tool/call") {
          if (params.turnId !== operation.turnId
            || !Number.isSafeInteger(notification.id) || notification.id < 0
            || params.namespace !== null
            || !safeIdentifier(params.callId)
            || !safeIdentifier(params.tool)
            || !operation.request.toolNames.includes(params.tool)) {
            throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed.");
          }
          let args;
          try { args = cloneJsonValue(params.arguments); }
          catch { throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed."); }
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed.");
          }
          this.#manager.declineDynamicToolCall(notification.id);
          await this.#interrupt(operation);
          operation.completed = true;
          const toolCall = Object.freeze({
            type: "tool-call",
            toolCallId: params.callId,
            toolName: params.tool,
            args,
          });
          operation.toolCalls.push(toolCall);
          yield Object.freeze({
            type: "tool-call-streaming-start",
            toolCallId: params.callId,
            toolName: params.tool,
          });
          yield toolCall;
          yield Object.freeze({
            type: "finish",
            finishReason: "tool-calls",
            usage: operation.finalUsage.basic,
          });
          this.#resolve(operation);
          return;
        }
        if (notification.method === "item/agentMessage/delta") {
          if (params.turnId !== operation.turnId) continue;
          if (!safeIdentifier(params.itemId) || typeof params.delta !== "string") {
            throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed.");
          }
          if (params.delta !== "") {
            if (operation.request.forcedToolName !== null) continue;
            operation.text.push(params.delta);
            yield Object.freeze({ type: "text-delta", textDelta: params.delta });
          }
          continue;
        }
        if (notification.method === "thread/tokenUsage/updated") {
          if (params.turnId !== operation.turnId) continue;
          const normalized = normalizeUsage(params.tokenUsage);
          if (!normalized) throw directError("CODEX_INFERENCE_PROTOCOL", "Codex inference protocol failed.");
          operation.finalUsage = normalized;
          continue;
        }
        if (notification.method !== "turn/completed") continue;
        const completedTurn = safeData(params.turn);
        if (!completedTurn || completedTurn.id !== operation.turnId) continue;
        if (completedTurn.status !== "completed") {
          operation.completed = true;
          throw directError("CODEX_INFERENCE_FAILED", "Codex inference failed.");
        }
        operation.completed = true;
        if (operation.request.forcedToolName !== null && operation.toolCalls.length === 0) {
          throw directError("CODEX_INFERENCE_FAILED", "Codex inference failed.");
        }
        const finish = Object.freeze({
          type: "finish",
          finishReason: "stop",
          usage: operation.finalUsage.basic,
        });
        yield finish;
        this.#resolve(operation);
        return;
      }
      throw directError("CODEX_INFERENCE_UNAVAILABLE", "Codex inference is unavailable.");
    } catch (error) {
      const normalized = stableFailure(error, error?.code === "CODEX_INFERENCE_FAILED"
        ? "CODEX_INFERENCE_FAILED" : "CODEX_INFERENCE_UNAVAILABLE");
      this.#reject(operation, normalized);
      throw normalized;
    }
  }

  async #assertCurrent(operation) {
    if (this.#disposed) throw directError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    if (operation.request.signal?.aborted) {
      throw directError("CODEX_INFERENCE_CANCELLED", "Codex inference was cancelled.");
    }
    if (operation.managerGeneration !== null && this.#manager.generation !== operation.managerGeneration) {
      throw directError("CODEX_INFERENCE_STALE", "Codex inference selection changed.");
    }
    try { await operation.request.assertCurrent(); }
    catch { throw directError("CODEX_INFERENCE_STALE", "Codex inference selection changed."); }
    if (this.#disposed) throw directError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    if (operation.request.signal?.aborted) {
      throw directError("CODEX_INFERENCE_CANCELLED", "Codex inference was cancelled.");
    }
  }

  #resolve(operation) {
    if (operation.settled) return;
    operation.settled = true;
    const selection = operation.request.selection;
    const content = [];
    if (operation.text.length > 0) {
      content.push(Object.freeze({ type: "text", text: operation.text.join("") }));
    }
    content.push(...operation.toolCalls);
    operation.usage.resolve(operation.finalUsage.basic);
    operation.extendedUsage.resolve(operation.finalUsage.extended);
    operation.providerMetadata.resolve(Object.freeze({ codex: Object.freeze({
      botId: selection.botId,
      generation: selection.generation,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      serviceTier: selection.serviceTier,
    }) }));
    operation.response.resolve(Object.freeze({
      id: operation.request.invocationId,
      timestamp: new Date(),
      modelId: selection.model,
      messages: Object.freeze([Object.freeze({
        id: operation.request.invocationId,
        role: "assistant",
        content: Object.freeze(content),
      })]),
    }));
  }

  #reject(operation, error) {
    if (operation.settled) return;
    operation.settled = true;
    operation.usage.reject(error);
    operation.extendedUsage.reject(error);
    operation.providerMetadata.reject(error);
    operation.response.reject(error);
  }

  async #interrupt(operation) {
    if (!operation.threadId || !operation.turnId || operation.completed) return;
    try {
      await this.#manager.request("turn/interrupt", {
        threadId: operation.threadId,
        turnId: operation.turnId,
      }, { timeoutMs: 10_000 });
    } catch {
      // Interruption is best-effort after the public operation is already terminal.
    }
  }

  async #finish(operation) {
    if (operation.timer != null) {
      try { this.#clearTimeout(operation.timer); } catch {}
      operation.timer = null;
    }
    for (const detach of operation.detach.splice(0)) {
      try { detach(); } catch {}
    }
    operation.queue.close();
    if (!operation.completed) await this.#interrupt(operation);
    if (!operation.settled) {
      this.#reject(operation, directError("CODEX_INFERENCE_CANCELLED", "Codex inference was cancelled."));
    }
    this.#operations.delete(operation);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = directError("CODEX_INFERENCE_DISPOSED", "Codex inference was disposed.");
    for (const operation of this.#operations) {
      operation.queue.fail(error);
      this.#reject(operation, error);
      void this.#interrupt(operation);
    }
  }
}

module.exports = {
  CodexDirectInferenceError,
  CodexDirectInferenceTransport,
};
