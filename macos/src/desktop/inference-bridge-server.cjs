"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const { types } = require("node:util");

const MAX_FRAME_BYTES = 1_250_000;
const MAX_CONNECTIONS = 32;
const AUTH_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 150_000;
const CAPABILITY = /^[a-f0-9]{64}$/;

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
    "selection", "conversationId", "messages", "tools", "toolChoice", "invocationId",
  ]);
  if (Object.keys(request).some((key) => !allowed.has(key))) fail();
  return request;
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
  #capability;
  #net;
  #server = null;
  #starting = null;
  #cancelStart = null;
  #sockets = new Set();
  #disposed = false;

  constructor(rawOptions = {}) {
    const options = safeOptions(rawOptions);
    if (Object.keys(options).some((key) => !["router", "capability", "netImpl"].includes(key))
      || !options.router || typeof options.router !== "object" || types.isProxy(options.router)
      || typeof options.router.stream !== "function"
      || (options.netImpl !== undefined && (!options.netImpl || typeof options.netImpl.createServer !== "function"))) {
      fail();
    }
    this.#router = options.router;
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
      void this.#write(socket, { type: "error", code }).finally(() => {
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
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (started || newline === 0 || newline !== buffer.length - 1) { reject(); return; }
      started = true;
      let message;
      try { message = safeOptions(JSON.parse(buffer.subarray(0, newline).toString("utf8"))); }
      catch { reject(); return; }
      buffer = Buffer.alloc(0);
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
    });
  }

  async #serve(socket, controller, rawRequest) {
    const request = Object.freeze({ ...rawRequest, signal: controller.signal });
    const result = await this.#router.stream(request);
    if (!result || typeof result !== "object" || types.isProxy(result)
      || !result.fullStream || typeof result.fullStream[Symbol.asyncIterator] !== "function") fail();
    for await (const value of result.fullStream) {
      if (controller.signal.aborted) throw new InferenceBridgeServerError();
      await this.#write(socket, { type: "event", value });
    }
    const [usage, extendedUsage, providerMetadata, invocationId, response] = await Promise.all([
      result.usage,
      result.extendedUsage,
      result.providerMetadata,
      result.invocationId,
      result.response,
    ]);
    if (controller.signal.aborted) throw new InferenceBridgeServerError();
    await this.#write(socket, {
      type: "done",
      usage,
      extendedUsage,
      providerMetadata,
      invocationId,
      response,
    });
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
