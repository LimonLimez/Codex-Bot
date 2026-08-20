"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} = require("node:worker_threads");

const { REVIEWED_ADAPTER_WORKER_SOURCE } = require("./reviewed-adapter-worker-source.cjs");

const MAX_ADAPTER_MODULE_BYTES = 1_048_576;
const MAX_ADAPTER_PENDING_OPERATIONS = 64;
const MAX_ADAPTER_EVENTS = 256;
const ADAPTER_START_TIMEOUT_MS = 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class ReviewedAdapterLoaderError extends Error {
  constructor() {
    super("Remote provider verification is not configured.");
    this.name = "ReviewedAdapterLoaderError";
    this.code = "REMOTE_PROVIDER_GATE_BLOCKED";
  }
}

function loaderError() {
  return new ReviewedAdapterLoaderError();
}

function permissionWorkerSupported(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 13);
}

function permissionWorkerArguments(version = process.versions.node) {
  const major = Number(version.split(".", 1)[0]);
  return major >= 25 ? ["--permission", "--allow-net"] : ["--permission"];
}

function readReviewedModuleSource(modulePath, expectedSha256) {
  let descriptor = null;
  try {
    if (typeof modulePath !== "string"
      || !path.isAbsolute(modulePath)
      || typeof expectedSha256 !== "string"
      || !SHA256_PATTERN.test(expectedSha256)) {
      throw loaderError();
    }
    const pathStat = fs.lstatSync(modulePath);
    if (!pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1
      || (pathStat.mode & 0o077) !== 0
      || pathStat.size < 1
      || pathStat.size > MAX_ADAPTER_MODULE_BYTES) throw loaderError();
    descriptor = fs.openSync(
      modulePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const initial = fs.fstatSync(descriptor);
    if (initial.dev !== pathStat.dev
      || initial.ino !== pathStat.ino
      || !initial.isFile()
      || initial.nlink !== 1
      || (initial.mode & 0o077) !== 0
      || initial.size < 1
      || initial.size > MAX_ADAPTER_MODULE_BYTES
      || initial.size !== pathStat.size) throw loaderError();
    const bytes = fs.readFileSync(descriptor);
    const final = fs.fstatSync(descriptor);
    if (final.dev !== initial.dev
      || final.ino !== initial.ino
      || !final.isFile()
      || final.nlink !== 1
      || (final.mode & 0o077) !== 0
      || final.size !== initial.size
      || bytes.length !== initial.size
      || bytes.length !== final.size
      || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      throw loaderError();
    }
    return bytes.toString("utf8");
  } catch {
    throw loaderError();
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function adapterWorkerFailure() {
  return new Error("Reviewed adapter worker failed.");
}

function isReviewedAdapterEnvelope(message) {
  return message !== null && typeof message === "object" && !Array.isArray(message);
}

function intrinsicObjectPrototype(prototype) {
  if (prototype === null || prototype === Object.prototype) return true;
  try {
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const actual = Object.getOwnPropertyDescriptors(prototype);
    const expected = Object.getOwnPropertyDescriptors(Object.prototype);
    const actualKeys = Reflect.ownKeys(actual);
    const expectedKeys = Reflect.ownKeys(expected);
    if (actualKeys.length !== expectedKeys.length
      || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(actual, key))) return false;
    return expectedKeys.every((key) => {
      const left = actual[key];
      const right = expected[key];
      if (left.enumerable !== right.enumerable || left.configurable !== right.configurable) return false;
      if ("value" in right) {
        if (!("value" in left) || left.writable !== right.writable) return false;
        if (typeof right.value === "function") {
          return typeof left.value === "function"
            && Function.prototype.toString.call(left.value) === Function.prototype.toString.call(right.value);
        }
        return left.value === right.value;
      }
      return !("value" in left)
        && Function.prototype.toString.call(left.get) === Function.prototype.toString.call(right.get)
        && Function.prototype.toString.call(left.set) === Function.prototype.toString.call(right.set);
    });
  } catch {
    return false;
  }
}

function adapterInput(value) {
  if (value === undefined) return Object.freeze({ input: undefined, signal: undefined });
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !intrinsicObjectPrototype(Object.getPrototypeOf(value))) {
    throw adapterWorkerFailure();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw adapterWorkerFailure();
  }
  const input = Object.create(null);
  let signal;
  for (const key of keys) {
    if (key === "signal") {
      signal = descriptors[key].value;
      continue;
    }
    if (descriptors[key].enumerable) input[key] = descriptors[key].value;
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw adapterWorkerFailure();
  return Object.freeze({ input, signal });
}

function createWorkerFromSource({
  modulePath,
  source,
  factoryName,
  adapterKind,
  maxEvents = MAX_ADAPTER_EVENTS,
} = {}) {
  if (!permissionWorkerSupported()
    || typeof modulePath !== "string"
    || !path.isAbsolute(modulePath)
    || typeof source !== "string"
    || !Number.isSafeInteger(maxEvents)
    || maxEvents < 1
    || maxEvents > MAX_ADAPTER_EVENTS) throw loaderError();
  const handshakeBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const handshake = new Int32Array(handshakeBuffer);
  const { port1, port2 } = new MessageChannel();
  let worker;
  try {
    worker = new Worker(REVIEWED_ADAPTER_WORKER_SOURCE, {
      eval: true,
      execArgv: permissionWorkerArguments(),
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 2,
      },
      workerData: {
        adapterKind,
        factoryName,
        handshake: handshakeBuffer,
        maxEvents,
        moduleDirectory: path.dirname(modulePath),
        modulePath,
        port: port2,
        source,
      },
      transferList: [port2],
    });
  } catch {
    port1.close();
    throw loaderError();
  }

  worker.on("error", () => {});
  worker.unref();
  port1.unref();
  if (Atomics.load(handshake, 0) === 0) {
    Atomics.wait(handshake, 0, 0, ADAPTER_START_TIMEOUT_MS);
  }
  const envelope = receiveMessageOnPort(port1);
  if (Atomics.load(handshake, 0) !== 1
    || !envelope
    || !isReviewedAdapterEnvelope(envelope.message)
    || envelope.message.type !== "ready"
    || !Array.isArray(envelope.message.events)
    || envelope.message.events.length > maxEvents) {
    port1.close();
    void worker.terminate();
    throw loaderError();
  }

  let closed = false;
  let nextId = 1;
  let subscriber = null;
  const earlyEvents = [...envelope.message.events];
  const pending = new Map();

  const rejectPending = () => {
    for (const operation of pending.values()) {
      operation.signal?.removeEventListener("abort", operation.onAbort);
      operation.reject(adapterWorkerFailure());
    }
    pending.clear();
  };
  const shutdown = () => {
    if (closed) return;
    closed = true;
    subscriber = null;
    earlyEvents.length = 0;
    rejectPending();
    try { port1.postMessage({ type: "shutdown" }); } catch {}
    const force = setTimeout(() => void worker.terminate(), 100);
    force.unref();
  };
  const fail = () => {
    if (closed) return;
    closed = true;
    subscriber = null;
    earlyEvents.length = 0;
    rejectPending();
    port1.close();
    void worker.terminate();
  };
  const settle = (message) => {
    if (!isReviewedAdapterEnvelope(message)) {
      fail();
      return;
    }
    if (message.type === "stopped") {
      if (!closed) fail();
      else {
        port1.close();
        void worker.terminate();
      }
      return;
    }
    if (closed) return;
    if (message.type === "event" && adapterKind === "provider") {
      if (subscriber) {
        try { subscriber(message.value); } catch { fail(); }
      } else if (earlyEvents.length < maxEvents) {
        earlyEvents.push(message.value);
      } else {
        fail();
      }
      return;
    }
    if (message.type !== "result"
      || !Number.isSafeInteger(message.id)
      || message.id < 1
      || !pending.has(message.id)
      || (message.ok !== true && message.ok !== false)) {
      fail();
      return;
    }
    const operation = pending.get(message.id);
    pending.delete(message.id);
    operation.signal?.removeEventListener("abort", operation.onAbort);
    if (message.ok) operation.resolve(message.value);
    else operation.reject(adapterWorkerFailure());
  };
  port1.on("message", settle);
  port1.on("close", () => {
    if (!closed) fail();
  });
  worker.on("error", fail);
  worker.on("exit", () => {
    if (!closed) fail();
  });
  port1.unref();

  const request = (method, value) => {
    if (closed || pending.size >= MAX_ADAPTER_PENDING_OPERATIONS || typeof method !== "string") {
      return Promise.reject(adapterWorkerFailure());
    }
    let normalized;
    try {
      normalized = adapterInput(value);
    } catch {
      return Promise.reject(adapterWorkerFailure());
    }
    const id = nextId;
    nextId = nextId === Number.MAX_SAFE_INTEGER ? 1 : nextId + 1;
    if (pending.has(id)) return Promise.reject(adapterWorkerFailure());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        try { port1.postMessage({ type: "abort", id }); } catch { fail(); }
      };
      pending.set(id, { onAbort, reject, resolve, signal: normalized.signal });
      normalized.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        port1.postMessage({
          type: "operation",
          id,
          method,
          input: normalized.input,
          abortable: normalized.signal !== undefined,
        });
        if (normalized.signal?.aborted) onAbort();
      } catch {
        pending.delete(id);
        normalized.signal?.removeEventListener("abort", onAbort);
        reject(adapterWorkerFailure());
        fail();
      }
    });
  };
  const subscribe = (callback) => {
    if (closed || adapterKind !== "provider" || subscriber || typeof callback !== "function") {
      throw adapterWorkerFailure();
    }
    subscriber = callback;
    try {
      for (const event of earlyEvents.splice(0)) subscriber(event);
    } catch {
      fail();
      throw adapterWorkerFailure();
    }
    let active = true;
    return () => {
      if (!active) return undefined;
      active = false;
      shutdown();
      return undefined;
    };
  };

  return Object.freeze({ request, shutdown, subscribe });
}

function createReviewedAdapterWorker({ modulePath, moduleSha256, ...options } = {}) {
  const source = readReviewedModuleSource(modulePath, moduleSha256);
  return createWorkerFromSource({ modulePath, source, ...options });
}

function loadReviewedAdapter(options) {
  return createReviewedAdapterWorker(options);
}

module.exports = Object.freeze({
  MAX_ADAPTER_EVENTS,
  MAX_ADAPTER_MODULE_BYTES,
  ReviewedAdapterLoaderError,
  createReviewedAdapterWorker,
  isReviewedAdapterEnvelope,
  loadReviewedAdapter,
  permissionWorkerArguments,
  permissionWorkerSupported,
  readReviewedModuleSource,
});
