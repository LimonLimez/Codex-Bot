"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const { types } = require("node:util");
const { cloneJsonValue } = require("./message-codec.cjs");
const {
  canonicalProviderId,
  providerDescriptor,
} = require("../provider-descriptors.cjs");

const MAX_FRAME_BYTES = 1_250_000;
const MAX_QUEUED_FRAMES = 2_048;
const MAX_QUEUED_FRAME_BYTES = 2_500_000;
const BOT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

class InferenceSocketError extends Error {
  constructor(code = "CODEX_BRIDGE_UNAVAILABLE", message = "Codex bridge is unavailable.") {
    super(message);
    this.name = "InferenceSocketError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function socketError(code, message) { return new InferenceSocketError(code, message); }

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

function endpoint(value) {
  if (typeof value !== "string") throw socketError();
  let parsed;
  try { parsed = new URL(value); } catch { throw socketError(); }
  if (parsed.protocol !== "tcp:" || parsed.hostname !== "127.0.0.1" || parsed.username !== ""
    || parsed.password !== "" || parsed.pathname !== "" || parsed.search !== "" || parsed.hash !== ""
    || !/^\d+$/.test(parsed.port)) throw socketError();
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || value !== `tcp://127.0.0.1:${port}`) throw socketError();
  return port;
}

function safeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw socketError();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw socketError(); }
  const read = (key) => descriptors[key] && "value" in descriptors[key] ? descriptors[key].value : undefined;
  const result = {
    botId: read("botId"),
    generation: read("generation"),
    provider: read("provider"),
    model: read("model"),
    reasoningEffort: read("reasoningEffort"),
    serviceTier: read("serviceTier"),
    endpoint: read("endpoint"),
    credential: read("credential"),
  };
  let provider;
  try { provider = canonicalProviderId(result.provider); } catch { throw socketError(); }
  let descriptor;
  try { descriptor = providerDescriptor(provider); } catch { throw socketError(); }
  const dynamic = new Set(["openai-codex", "openai-api-key", "local-openai-compatible"]).has(provider);
  const modelKnown = dynamic || descriptor.models.some(({ id }) => id === result.model);
  const reasoningKnown = descriptor.reasoningEfforts.includes(result.reasoningEffort)
    || (provider === "openai-codex" && result.reasoningEffort === "ultra")
    || (provider === "openai-api-key" && result.reasoningEffort === "ultra")
    || (provider === "anthropic-claude" && result.reasoningEffort === "ultra-code");
  if (!BOT_UUID.test(result.botId) || !Number.isSafeInteger(result.generation) || result.generation < 0
    || typeof result.model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(result.model) || !modelKnown
    || typeof result.reasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(result.reasoningEffort)
    || !reasoningKnown
    || (result.reasoningEffort === "ultra-code" && provider !== "anthropic-claude")
    || !(result.serviceTier === null || (typeof result.serviceTier === "string"
      && /^[a-z][a-z0-9_-]{0,31}$/.test(result.serviceTier)))
    || (result.serviceTier !== null && descriptor.fastModeSupported !== true)
    || !CAPABILITY.test(result.credential)) throw socketError();
  result.provider = provider;
  result.port = endpoint(result.endpoint);
  return Object.freeze(result);
}

function normalizePublicError(code) {
  if (code === "CODEX_BRIDGE_CANCELLED") return socketError(code, "Codex bridge request was cancelled.");
  if (code === "CODEX_BRIDGE_DISPOSED") return socketError(code, "Codex bridge is disposed.");
  if (code === "CODEX_BRIDGE_STALE") return socketError(code, "Codex bridge generation changed.");
  if (code === "CODEX_BRIDGE_TIMEOUT") return socketError(code, "Codex bridge request timed out.");
  return socketError();
}

function taskProof(capability, botId, conversationId, taskId) {
  return crypto.createHmac("sha256", capability)
    .update("openbot-native-task\0", "utf8")
    .update(botId, "utf8")
    .update("\0", "utf8")
    .update(conversationId, "utf8")
    .update("\0", "utf8")
    .update(taskId, "utf8")
    .digest("hex");
}

class FrameQueue {
  #values = [];
  #waiter = null;
  #error = null;
  #bytes = 0;
  push(value) {
    if (this.#error) return false;
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(value), "utf8"); }
    catch { this.fail(socketError()); return false; }
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter.resolve(value);
      return true;
    }
    if (this.#values.length >= MAX_QUEUED_FRAMES
      || this.#bytes + bytes > MAX_QUEUED_FRAME_BYTES) {
      this.fail(socketError());
      return false;
    }
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
    return true;
  }
  fail(error) {
    if (this.#error) return;
    this.#error = error;
    this.#values = [];
    this.#bytes = 0;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter.reject(error);
    }
  }
  next() {
    if (this.#values.length > 0) {
      const entry = this.#values.shift();
      this.#bytes -= entry.bytes;
      return Promise.resolve(entry.value);
    }
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => { this.#waiter = { resolve, reject }; });
  }
}

class InferenceSocketClient {
  #config;
  #conversationId;
  #taskId;
  #isCurrent;
  #net;
  #disposed = false;
  #operations = new Set();

  constructor({ config, conversationId, taskId, isCurrent = () => true, netImpl = net } = {}) {
    this.#config = safeConfig(config);
    if (typeof conversationId !== "string" || !ID.test(conversationId)
      || conversationId.includes("..")
      || typeof taskId !== "string" || !ID.test(taskId) || taskId.includes("..")
      || typeof isCurrent !== "function" || !netImpl || typeof netImpl.createConnection !== "function") {
      throw socketError();
    }
    this.#conversationId = conversationId;
    this.#taskId = taskId;
    this.#isCurrent = isCurrent;
    this.#net = netImpl;
  }

  #assertCurrent() {
    if (this.#disposed) throw socketError("CODEX_BRIDGE_DISPOSED", "Codex bridge is disposed.");
    let current = false;
    try { current = this.#isCurrent(this.#config); } catch {}
    if (current !== true) throw socketError("CODEX_BRIDGE_STALE", "Codex bridge generation changed.");
  }

  stream({ messages, tools = [], toolChoice, invocationId, signal } = {}) {
    this.#assertCurrent();
    let safeMessages;
    let safeTools;
    let safeToolChoice;
    try {
      safeMessages = cloneJsonValue(messages);
      safeTools = cloneJsonValue(tools);
      safeToolChoice = toolChoice === undefined ? undefined : cloneJsonValue(toolChoice);
    } catch { throw socketError(); }
    if (!Array.isArray(safeMessages) || !Array.isArray(safeTools)
      || typeof invocationId !== "string" || !ID.test(invocationId)) throw socketError();
    const usage = deferred();
    const extendedUsage = deferred();
    const providerMetadata = deferred();
    const response = deferred();
    const operation = {
      usage, extendedUsage, providerMetadata, response,
      socket: null,
      started: false,
      cancelled: false,
      settled: false,
      completed: false,
      queue: new FrameQueue(),
    };
    this.#operations.add(operation);
    const request = {
      selection: {
        botId: `bot-${this.#config.botId}`,
        generation: this.#config.generation,
        provider: this.#config.provider,
        model: this.#config.model,
        reasoningEffort: this.#config.reasoningEffort,
        serviceTier: this.#config.serviceTier,
      },
      conversationId: this.#conversationId,
      taskId: this.#taskId,
      taskProof: taskProof(
        this.#config.credential,
        `bot-${this.#config.botId}`,
        this.#conversationId,
        this.#taskId,
      ),
      messages: safeMessages,
      tools: safeTools,
      invocationId,
    };
    if (safeToolChoice !== undefined) request.toolChoice = safeToolChoice;
    const source = this.#run(operation, request, signal);
    const owner = this;
    const fullStream = (async function* () {
      try { yield* source; }
      finally { owner.#finish(operation); }
    })();
    return Object.freeze({
      fullStream,
      usage: usage.promise,
      extendedUsage: extendedUsage.promise,
      providerMetadata: providerMetadata.promise,
      invocationId: Promise.resolve(invocationId),
      response: response.promise,
    });
  }

  async *#run(operation, request, signal) {
    let buffer = Buffer.alloc(0);
    let onAbort = null;
    try {
      this.#assertCurrent();
      if (signal !== undefined && (!signal || typeof signal !== "object"
        || typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function")) throw socketError();
      if (signal?.aborted) {
        throw socketError("CODEX_BRIDGE_CANCELLED", "Codex bridge request was cancelled.");
      }
      const socket = this.#net.createConnection({ host: "127.0.0.1", port: this.#config.port });
      operation.socket = socket;
      onAbort = () => {
        const error = socketError("CODEX_BRIDGE_CANCELLED", "Codex bridge request was cancelled.");
        operation.queue.fail(error);
        operation.rejectConnection?.(error);
        if (operation.started && typeof socket.end === "function") {
          operation.cancelled = true;
          try { socket.end(`${JSON.stringify({ type: "cancel" })}\n`); }
          catch { try { socket.destroy(); } catch {} }
        } else {
          try { socket.destroy(); } catch {}
        }
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
      socket.on("data", (rawChunk) => {
        const failSocket = () => {
          operation.queue.fail(socketError());
          try { socket.destroy(); } catch {}
        };
        let chunk;
        try { chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk); }
        catch { failSocket(); return; }
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        while (true) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          if (newline === 0 || newline > MAX_FRAME_BYTES) { failSocket(); return; }
          let frame;
          try { frame = JSON.parse(buffer.subarray(0, newline).toString("utf8")); }
          catch { failSocket(); return; }
          buffer = buffer.subarray(newline + 1);
          if (!operation.queue.push(frame)) { failSocket(); return; }
        }
        if (buffer.length > MAX_FRAME_BYTES) failSocket();
      });
      socket.on("error", () => operation.queue.fail(socketError()));
      socket.on("close", () => {
        if (!operation.completed) operation.queue.fail(socketError());
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback(value);
        };
        const connected = () => finish(resolve);
        const failed = () => finish(reject, socketError());
        const closed = () => {
          const error = this.#disposed
            ? socketError("CODEX_BRIDGE_DISPOSED", "Codex bridge is disposed.")
            : signal?.aborted
              ? socketError("CODEX_BRIDGE_CANCELLED", "Codex bridge request was cancelled.")
              : socketError();
          finish(reject, error);
        };
        const rejectConnection = (error) => finish(reject, error);
        const cleanup = () => {
          socket.off("connect", connected);
          socket.off("error", failed);
          socket.off("close", closed);
          if (operation.rejectConnection === rejectConnection) operation.rejectConnection = null;
        };
        operation.rejectConnection = rejectConnection;
        socket.once("connect", connected);
        socket.once("error", failed);
        socket.once("close", closed);
        if (this.#disposed) {
          rejectConnection(socketError("CODEX_BRIDGE_DISPOSED", "Codex bridge is disposed."));
        } else if (signal?.aborted) {
          rejectConnection(socketError("CODEX_BRIDGE_CANCELLED", "Codex bridge request was cancelled."));
        }
      });
      this.#assertCurrent();
      if (signal?.aborted) throw socketError("CODEX_BRIDGE_CANCELLED", "Codex bridge request was cancelled.");
      const serialized = `${JSON.stringify({
        type: "start",
        capability: this.#config.credential,
        request,
      })}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_FRAME_BYTES) throw socketError();
      operation.started = true;
      await new Promise((resolve, reject) => {
        try { socket.write(serialized, (error) => error ? reject(socketError()) : resolve()); }
        catch { reject(socketError()); }
      });
      while (true) {
        const frame = await operation.queue.next();
        this.#assertCurrent();
        if (!frame || typeof frame !== "object" || Array.isArray(frame) || types.isProxy(frame)) throw socketError();
        if (frame.type === "event") {
          const value = cloneJsonValue(frame.value);
          yield value;
          continue;
        }
        if (frame.type === "error") throw normalizePublicError(frame.code);
        if (frame.type !== "done") throw socketError();
        const finishedUsage = cloneJsonValue(frame.usage);
        const finishedExtended = cloneJsonValue(frame.extendedUsage);
        const finishedMetadata = cloneJsonValue(frame.providerMetadata);
        const finishedResponse = cloneJsonValue(frame.response);
        if (!finishedResponse || typeof finishedResponse !== "object"
          || typeof finishedResponse.timestamp !== "string") throw socketError();
        const timestamp = new Date(finishedResponse.timestamp);
        if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== finishedResponse.timestamp) throw socketError();
        const responseValue = Object.freeze({ ...finishedResponse, timestamp });
        operation.completed = true;
        operation.settled = true;
        operation.usage.resolve(finishedUsage);
        operation.extendedUsage.resolve(finishedExtended);
        operation.providerMetadata.resolve(finishedMetadata);
        operation.response.resolve(responseValue);
        return;
      }
    } catch (error) {
      const normalized = error instanceof InferenceSocketError ? error : socketError();
      this.#reject(operation, normalized);
      throw normalized;
    } finally {
      if (signal !== undefined && onAbort) {
        try { signal.removeEventListener("abort", onAbort); } catch {}
      }
    }
  }

  #reject(operation, error) {
    if (operation.settled) return;
    operation.settled = true;
    operation.usage.reject(error);
    operation.extendedUsage.reject(error);
    operation.providerMetadata.reject(error);
    operation.response.reject(error);
  }

  #finish(operation) {
    if (!operation.completed && !operation.settled) {
      this.#reject(operation, socketError("CODEX_BRIDGE_CANCELLED", "Codex bridge request was cancelled."));
    }
    if (operation.cancelled) {
      try { operation.socket?.destroySoon?.(); } catch {}
    } else {
      try { operation.socket?.destroy?.(); } catch {}
    }
    this.#operations.delete(operation);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = socketError("CODEX_BRIDGE_DISPOSED", "Codex bridge is disposed.");
    for (const operation of this.#operations) {
      operation.queue.fail(error);
      this.#reject(operation, error);
      operation.rejectConnection?.(error);
      try { operation.socket?.destroy?.(); } catch {}
    }
  }
}

module.exports = {
  InferenceSocketClient,
  InferenceSocketError,
  MAX_FRAME_BYTES,
  MAX_QUEUED_FRAMES,
};
