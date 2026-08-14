"use strict";

const crypto = require("node:crypto");
const {
  cloneJsonValue,
  encodeMessages,
  encodeToolChoice,
  encodeTools,
} = require("./message-codec.cjs");
const { sanitizeError } = require("./redaction.cjs");

const MAX_SSE_LINE_BYTES = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

class BridgeProtocolError extends Error {
  constructor() {
    super("Codex bridge response is invalid.");
    this.name = "BridgeProtocolError";
    this.code = "CODEX_BRIDGE_PROTOCOL_INVALID";
  }
}

class BridgeStaleError extends Error {
  constructor() {
    super("Codex bridge generation changed.");
    this.name = "BridgeStaleError";
    this.code = "CODEX_BRIDGE_STALE";
  }
}

class BridgeDisposedError extends Error {
  constructor() {
    super("Codex bridge is disposed.");
    this.name = "BridgeDisposedError";
    this.code = "CODEX_BRIDGE_DISPOSED";
  }
}

class BridgeTimeoutError extends Error {
  constructor() {
    super("Codex bridge request timed out.");
    this.name = "BridgeTimeoutError";
    this.code = "CODEX_BRIDGE_TIMEOUT";
  }
}

class BridgeCancelledError extends Error {
  constructor() {
    super("Codex bridge request was cancelled.");
    this.name = "BridgeCancelledError";
    this.code = "CODEX_BRIDGE_CANCELLED";
  }
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

function protocol() {
  throw new BridgeProtocolError();
}

function stableError(error) {
  if (
    error &&
    typeof error === "object" &&
    typeof error.code === "string" &&
    error.code.startsWith("CODEX_BRIDGE_")
  ) {
    return error;
  }
  return sanitizeError(error);
}

function parseSseLine(line) {
  if (line === "" || line.startsWith(":")) return null;
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (data === "" || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    protocol();
  }
}

async function* sseEvents(body) {
  if (body == null || typeof body[Symbol.asyncIterator] !== "function") protocol();
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) protocol();
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      if (
        newline > MAX_SSE_LINE_BYTES ||
        Buffer.byteLength(buffer.slice(0, newline), "utf8") > MAX_SSE_LINE_BYTES
      ) {
        protocol();
      }
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      const event = parseSseLine(line);
      if (event != null) yield event;
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_LINE_BYTES) protocol();
  }
  buffer += decoder.decode();
  if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_LINE_BYTES) protocol();
  const event = parseSseLine(buffer.replace(/\r$/, ""));
  if (event != null) yield event;
}

function usageFromEvent(value) {
  if (value == null) return null;
  if (
    typeof value !== "object" ||
    !Number.isSafeInteger(value.prompt_tokens ?? 0) ||
    !Number.isSafeInteger(value.completion_tokens ?? 0) ||
    !Number.isSafeInteger(value.total_tokens ?? 0)
  ) {
    protocol();
  }
  const usage = {
    promptTokens: value.prompt_tokens ?? 0,
    completionTokens: value.completion_tokens ?? 0,
    totalTokens: value.total_tokens ?? 0,
  };
  if (Object.values(usage).some((number) => number < 0)) protocol();
  return Object.freeze(usage);
}

class CodexClient {
  #config;
  #fetch;
  #isCurrent;
  #requestTimeoutMs;
  #disposed = false;
  #operations = new Set();

  constructor({
    config,
    fetchImpl = globalThis.fetch,
    isCurrent = () => true,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }) {
    if (
      config == null ||
      typeof config !== "object" ||
      typeof config.endpoint !== "string" ||
      typeof config.credential !== "string" ||
      typeof fetchImpl !== "function" ||
      typeof isCurrent !== "function" ||
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > 600_000
    ) {
      throw sanitizeError();
    }
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#isCurrent = isCurrent;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  #assertUsable() {
    if (this.#disposed) throw new BridgeDisposedError();
    let current;
    try {
      current = this.#isCurrent(this.#config);
    } catch {
      current = false;
    }
    if (current !== true) throw new BridgeStaleError();
  }

  stream({ messages, tools = [], toolChoice, invocationId, signal } = {}) {
    this.#assertUsable();
    const convertedMessages = encodeMessages(messages);
    const convertedTools = encodeTools(tools);
    const toolNames = new Set(
      convertedTools.map((tool) => tool.function.name),
    );
    const convertedToolChoice = encodeToolChoice(toolChoice, toolNames);
    const resolvedInvocationId =
      typeof invocationId === "string" && invocationId.length > 0
        ? invocationId
        : crypto.randomUUID();
    const usage = deferred();
    const extendedUsage = deferred();
    const providerMetadata = deferred();
    const response = deferred();
    const controller = new AbortController();
    const operation = {
      controller,
      settled: false,
      rejectAll(error) {
        if (this.settled) return;
        this.settled = true;
        usage.reject(error);
        extendedUsage.reject(error);
        providerMetadata.reject(error);
        response.reject(error);
      },
    };
    this.#operations.add(operation);
    const abortFromCaller = () => {
      const error =
        signal?.reason instanceof Error ? stableError(signal.reason) : new BridgeCancelledError();
      controller.abort(error);
      operation.rejectAll(error);
    };
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener?.("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      const error = new BridgeTimeoutError();
      controller.abort(error);
      operation.rejectAll(error);
    }, this.#requestTimeoutMs);
    timeout.unref?.();

    const source = this.#run({
      controller,
      convertedMessages,
      convertedToolChoice,
      convertedTools,
      toolNames,
      resolvedInvocationId,
      usage,
      extendedUsage,
      providerMetadata,
      response,
      operation,
    });
    const operations = this.#operations;
    const fullStream = (async function* () {
      try {
        yield* source;
      } finally {
        if (!operation.settled) {
          const error = new BridgeCancelledError();
          controller.abort(error);
          operation.rejectAll(error);
        }
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", abortFromCaller);
        operations.delete(operation);
      }
    })();

    return {
      fullStream,
      usage: usage.promise,
      extendedUsage: extendedUsage.promise,
      providerMetadata: providerMetadata.promise,
      invocationId: Promise.resolve(resolvedInvocationId),
      response: response.promise,
    };
  }

  async *#run({
    controller,
    convertedMessages,
    convertedToolChoice,
    convertedTools,
    toolNames,
    resolvedInvocationId,
    usage,
    extendedUsage,
    providerMetadata,
    response,
    operation,
  }) {
    try {
      this.#assertUsable();
      if (controller.signal.aborted) throw controller.signal.reason;
      const payload = {
        model: this.#config.model,
        messages: convertedMessages,
        stream: true,
        stream_options: { include_usage: true },
        tool_choice: convertedToolChoice,
        parallel_tool_calls: true,
        reasoning_effort: this.#config.reasoningEffort,
      };
      if (convertedTools.length > 0) payload.tools = convertedTools;
      const httpResponse = await this.#fetch(
        `${this.#config.endpoint}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#config.credential}`,
            "Content-Type": "application/json",
            "X-Codex-Bot-Bridge": "1",
            "X-Codex-Bot-Id": this.#config.botId,
            "X-Codex-Runtime-Generation": String(this.#config.generation),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      this.#assertUsable();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (httpResponse == null || typeof httpResponse !== "object") protocol();
      if (httpResponse.ok !== true) {
        if (typeof httpResponse.text === "function") {
          try {
            await httpResponse.text();
          } catch {}
        }
        throw sanitizeError();
      }

      const textParts = [];
      const calls = new Map();
      const callIds = new Map();
      let responseId = resolvedInvocationId;
      let finalUsage = Object.freeze({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
      for await (const event of sseEvents(httpResponse.body)) {
        this.#assertUsable();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (event == null || typeof event !== "object" || Array.isArray(event)) {
          protocol();
        }
        if (event.id != null) {
          if (typeof event.id !== "string" || event.id.length > 256) protocol();
          responseId = event.id;
        }
        if (event.usage != null) finalUsage = usageFromEvent(event.usage);
        if (event.choices == null) continue;
        if (!Array.isArray(event.choices)) protocol();
        if (event.choices.length > 1) protocol();
        const choice = event.choices[0];
        if (choice == null) continue;
        if (typeof choice !== "object" || Array.isArray(choice)) protocol();
        const delta = choice.delta ?? {};
        if (typeof delta !== "object" || delta == null || Array.isArray(delta)) {
          protocol();
        }
        if (delta.content != null) {
          if (typeof delta.content !== "string") protocol();
          if (delta.content !== "") {
            textParts.push(delta.content);
            yield Object.freeze({ type: "text-delta", textDelta: delta.content });
          }
        }
        const toolDeltas = delta.tool_calls ?? [];
        if (!Array.isArray(toolDeltas)) protocol();
        for (const toolDelta of toolDeltas) {
          if (toolDelta == null || typeof toolDelta !== "object") protocol();
          const index = toolDelta.index ?? 0;
          if (!Number.isSafeInteger(index) || index < 0 || index > 1_000) protocol();
          let call = calls.get(index);
          if (!call) {
            const id = toolDelta.id;
            const name = toolDelta.function?.name;
            if (
              typeof id !== "string" ||
              id.length < 1 ||
              id.length > 256 ||
              callIds.has(id) ||
              typeof name !== "string" ||
              !toolNames.has(name)
            ) {
              protocol();
            }
            call = { id, name, args: "" };
            calls.set(index, call);
            callIds.set(id, index);
            yield Object.freeze({
              type: "tool-call-streaming-start",
              toolCallId: id,
              toolName: name,
            });
          } else {
            if (toolDelta.id != null && toolDelta.id !== call.id) protocol();
            if (
              toolDelta.function?.name != null &&
              toolDelta.function.name !== call.name
            ) {
              protocol();
            }
          }
          const args = toolDelta.function?.arguments;
          if (args != null) {
            if (typeof args !== "string" || call.args.length + args.length > 1_000_000) {
              protocol();
            }
            call.args += args;
            if (args !== "") {
              yield Object.freeze({
                type: "tool-call-delta",
                toolCallId: call.id,
                toolName: call.name,
                argsTextDelta: args,
              });
            }
          }
        }
      }

      this.#assertUsable();
      const assistantContent = [];
      if (textParts.length > 0) {
        assistantContent.push(
          Object.freeze({ type: "text", text: textParts.join("") }),
        );
      }
      for (const call of [...calls.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1])) {
        let args;
        try {
          args = cloneJsonValue(JSON.parse(call.args || "{}"));
        } catch {
          protocol();
        }
        if (args == null || typeof args !== "object" || Array.isArray(args)) protocol();
        const content = Object.freeze({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          args,
        });
        assistantContent.push(content);
        yield content;
      }
      yield Object.freeze({
        type: "finish",
        finishReason: calls.size > 0 ? "tool-calls" : "stop",
        usage: finalUsage,
      });

      const extended = Object.freeze({
        inputTokens: finalUsage.promptTokens,
        outputTokens: finalUsage.completionTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        maxTokens: 0,
      });
      const metadata = Object.freeze({
        codex: Object.freeze({
          botId: this.#config.botId,
          generation: this.#config.generation,
          model: this.#config.model,
          reasoningEffort: this.#config.reasoningEffort,
        }),
      });
      const responseValue = Object.freeze({
        id: responseId,
        timestamp: new Date(),
        modelId: this.#config.model,
        messages: Object.freeze([
          Object.freeze({
            id: responseId,
            role: "assistant",
            content: Object.freeze(assistantContent),
          }),
        ]),
      });
      operation.settled = true;
      usage.resolve(finalUsage);
      extendedUsage.resolve(extended);
      providerMetadata.resolve(metadata);
      response.resolve(responseValue);
    } catch (error) {
      const normalized = stableError(error);
      operation.rejectAll(normalized);
      throw normalized;
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new BridgeDisposedError();
    for (const operation of this.#operations) {
      operation.controller.abort(error);
      operation.rejectAll(error);
    }
    this.#operations.clear();
  }
}

module.exports = {
  BridgeCancelledError,
  BridgeDisposedError,
  BridgeProtocolError,
  BridgeStaleError,
  CodexClient,
  MAX_SSE_LINE_BYTES,
  sseEvents,
};
