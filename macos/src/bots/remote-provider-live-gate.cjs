"use strict";

const fs = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const dns = require("node:dns/promises");
const { isIP } = require("node:net");
const path = require("node:path");
const { types } = require("node:util");
const {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} = require("node:worker_threads");

const { BotStore } = require("./bot-store.cjs");
const { RemoteAppServerClient } = require("./remote-app-server-client.cjs");
const { REVIEWED_ADAPTER_WORKER_SOURCE } = require("./reviewed-adapter-worker-source.cjs");
const { BotRuntimeController } = require("./runtime-controller.cjs");
const { validateProvider } = require("./runtime-provider.cjs");

const BLOCKED_CODE = "REMOTE_PROVIDER_GATE_BLOCKED";
const BLOCKED_MESSAGE = "Remote provider verification is not configured.";
const FAILED_CODE = "REMOTE_PROVIDER_GATE_FAILED";
const FAILED_MESSAGE = "Remote provider verification failed.";
const YOUTUBE_URL = "https://www.youtube.com/";
const MAX_GATE_EVENTS = 256;
const MAX_ADAPTER_MODULE_BYTES = 1_048_576;
const MAX_ADAPTER_PENDING_OPERATIONS = 64;
const ADAPTER_START_TIMEOUT_MS = 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NON_PUBLIC_IPV4_CIDRS = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);

function publicError(code, message) {
  const error = new Error(message);
  error.name = "RemoteProviderGateError";
  error.code = code;
  error.stack = `${error.name}: ${message}`;
  return error;
}

function blockedError() {
  return publicError(BLOCKED_CODE, BLOCKED_MESSAGE);
}

function failedError() {
  return publicError(FAILED_CODE, FAILED_MESSAGE);
}

function ipv4Integer(hostname) {
  return hostname.split(".").reduce(
    (value, octet) => ((value << 8) | Number(octet)) >>> 0,
    0,
  );
}

function ipv4MatchesCidr(value, base, prefixLength) {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

function ipv6Integer(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...Array(missing).fill("0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6MatchesCidr(value, base, prefixLength) {
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (base >> shift);
}

function publicIpAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Integer(address);
    return !NON_PUBLIC_IPV4_CIDRS.some(([base, prefix]) => (
      ipv4MatchesCidr(value, ipv4Integer(base), prefix)
    ));
  }
  if (version === 6) {
    const value = ipv6Integer(address);
    if (value === null || (value >> 125n) !== 1n) return false;
    return !ipv6MatchesCidr(value, ipv6Integer("2001::"), 23)
      && !ipv6MatchesCidr(value, ipv6Integer("2001:db8::"), 32)
      && !ipv6MatchesCidr(value, ipv6Integer("3ffe::"), 16);
  }
  return false;
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

function objectDescriptors(value, label, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (!intrinsicObjectPrototype(prototype)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw new TypeError(`${label} must contain data fields only.`);
  }
  if (expectedKeys) {
    const actual = [...keys].sort().join(",");
    const expected = [...expectedKeys].sort().join(",");
    if (actual !== expected) throw new TypeError(`${label} has invalid fields.`);
  }
  return descriptors;
}

function reviewedModuleSource(value, expectedSha256) {
  let descriptor = null;
  try {
    if (typeof value !== "string" || !path.isAbsolute(value)
      || typeof expectedSha256 !== "string" || !SHA256_PATTERN.test(expectedSha256)) {
      throw blockedError();
    }
    descriptor = fs.openSync(value, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || stat.size < 1 || stat.size > MAX_ADAPTER_MODULE_BYTES) throw blockedError();
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== stat.size
      || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw blockedError();
    return bytes.toString("utf8");
  } catch {
    throw blockedError();
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

const reviewedAdapterChannels = new WeakMap();
const reviewedDependencyClosers = new WeakMap();

function adapterWorkerFailure() {
  return new Error("Reviewed adapter worker failed.");
}

function isReviewedAdapterEnvelope(message) {
  return message !== null && typeof message === "object" && !Array.isArray(message);
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

function adapterInput(value) {
  if (value === undefined) return Object.freeze({ input: undefined, signal: undefined });
  const descriptors = objectDescriptors(value, "Reviewed adapter input");
  const input = Object.create(null);
  let signal;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "signal") {
      signal = descriptors[key].value;
      continue;
    }
    if (descriptors[key].enumerable) input[key] = descriptors[key].value;
  }
  return Object.freeze({ input, signal });
}

function createReviewedAdapterWorker({ modulePath, source, factoryName, adapterKind }) {
  if (!permissionWorkerSupported()) throw blockedError();
  const handshakeBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const handshake = new Int32Array(handshakeBuffer);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(REVIEWED_ADAPTER_WORKER_SOURCE, {
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
      maxEvents: MAX_GATE_EVENTS,
      moduleDirectory: path.dirname(modulePath),
      modulePath,
      port: port2,
      source,
    },
    transferList: [port2],
  });
  worker.on("error", () => {});
  worker.unref();
  port1.unref();

  if (Atomics.load(handshake, 0) === 0) {
    Atomics.wait(handshake, 0, 0, ADAPTER_START_TIMEOUT_MS);
  }
  const envelope = receiveMessageOnPort(port1);
  if (Atomics.load(handshake, 0) !== 1
    || !envelope
    || !envelope.message
    || envelope.message.type !== "ready"
    || !Array.isArray(envelope.message.events)
    || envelope.message.events.length > MAX_GATE_EVENTS) {
    port1.close();
    void worker.terminate();
    throw blockedError();
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
      port1.close();
      void worker.terminate();
      return;
    }
    if (closed) return;
    if (message.type === "event" && adapterKind === "provider") {
      if (subscriber) {
        try {
          subscriber(message.value);
        } catch {
          fail();
        }
      } else if (earlyEvents.length < MAX_GATE_EVENTS) {
        earlyEvents.push(message.value);
      } else {
        fail();
      }
      return;
    }
    if (message.type !== "result" || !Number.isSafeInteger(message.id)
      || message.id < 1 || !pending.has(message.id)
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
  port1.unref();
  worker.on("error", fail);
  worker.on("exit", () => {
    if (!closed) fail();
  });

  const request = (method, value) => {
    if (closed || pending.size >= MAX_ADAPTER_PENDING_OPERATIONS) {
      return Promise.reject(adapterWorkerFailure());
    }
    const normalized = adapterInput(value);
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
    for (const event of earlyEvents.splice(0)) subscriber(event);
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

function closeReviewedAdapter(adapter) {
  try { reviewedAdapterChannels.get(adapter)?.shutdown(); } catch {}
}

function closeReviewedDependencies(...adapters) {
  for (const adapter of adapters) {
    const close = reviewedDependencyClosers.get(adapter);
    if (typeof close === "function") {
      close();
      return;
    }
  }
}

function disposeLiveGateDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return undefined;
  }
  closeReviewedDependencies(dependencies.provider, dependencies.exercise);
  return undefined;
}

function configuredModule(modulePath, expectedSha256, factoryName, adapterKind) {
  try {
    const channel = createReviewedAdapterWorker({
      modulePath,
      source: reviewedModuleSource(modulePath, expectedSha256),
      factoryName,
      adapterKind,
    });
    let adapter;
    if (adapterKind === "provider") {
      adapter = Object.freeze({
        capabilities: (input) => channel.request("capabilities", input),
        provision: (input) => channel.request("provision", input),
        inspect: (input) => channel.request("inspect", input),
        retire: (input) => channel.request("retire", input),
        subscribe: (callback) => channel.subscribe(callback),
      });
    } else {
      adapter = Object.freeze({
        openRemoteUrl: (input) => channel.request("openRemoteUrl", input),
        async dispose(input) {
          const signal = input === undefined
            ? undefined
            : Object.getOwnPropertyDescriptor(input, "signal")?.value;
          try {
            const operation = channel.request("dispose", input);
            if (!signal) return await operation;
            return await new Promise((resolve, reject) => {
              let settled = false;
              const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                callback(value);
              };
              const onAbort = () => {
                channel.shutdown();
                finish(reject, adapterWorkerFailure());
              };
              signal.addEventListener("abort", onAbort, { once: true });
              operation.then(
                (value) => finish(resolve, value),
                (error) => finish(reject, error),
              );
              if (signal.aborted) onAbort();
            });
          } finally {
            channel.shutdown();
          }
        },
      });
    }
    reviewedAdapterChannels.set(adapter, channel);
    return adapter;
  } catch {
    throw blockedError();
  }
}

function normalizedExerciseInput(value) {
  const descriptors = objectDescriptors(value, "Remote computer exercise input");
  const keys = Reflect.ownKeys(descriptors);
  const allowed = new Set(["actionId", "botId", "runtimeId", "generation", "url", "signal"]);
  if (keys.some((key) => !allowed.has(key))
    || ["actionId", "botId", "runtimeId", "generation", "url"].some((key) => !descriptors[key])) {
    throw failedError();
  }
  const actionId = descriptors.actionId.value;
  const botId = descriptors.botId.value;
  const runtimeId = descriptors.runtimeId.value;
  const generation = descriptors.generation.value;
  const url = descriptors.url.value;
  const signal = descriptors.signal?.value;
  if (typeof actionId !== "string" || !/^exercise-[0-9a-f-]{36}$/.test(actionId)) throw failedError();
  if (typeof botId !== "string" || !BOT_ID_PATTERN.test(botId)) throw failedError();
  if (typeof runtimeId !== "string" || !SAFE_IDENTIFIER_PATTERN.test(runtimeId)) throw failedError();
  if (!Number.isSafeInteger(generation) || generation < 1) throw failedError();
  if (url !== YOUTUBE_URL) throw failedError();
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw failedError();
  return operationInput({ actionId, botId: botId.toLowerCase(), runtimeId, generation, url }, signal);
}

function normalizedAcknowledgement(value, expected) {
  let descriptors;
  try {
    descriptors = objectDescriptors(value, "Remote computer exercise acknowledgement");
  } catch {
    throw failedError();
  }
  const required = ["accepted", "actionId", "botId", "runtimeId", "generation", "url"];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    throw failedError();
  }
  if (descriptors.accepted.value !== true
    || descriptors.actionId.value !== expected.actionId
    || descriptors.botId.value !== expected.botId
    || descriptors.runtimeId.value !== expected.runtimeId
    || descriptors.generation.value !== expected.generation
    || descriptors.url.value !== expected.url) {
    throw failedError();
  }
  return Object.freeze({ accepted: true, ...expected });
}

function validateComputerExercise(raw) {
  let descriptors;
  try {
    descriptors = objectDescriptors(
      raw,
      "Remote computer exercise",
      ["openRemoteUrl", "dispose"],
    );
  } catch {
    throw new TypeError("Remote computer exercise is invalid.");
  }
  const openRemoteUrl = descriptors.openRemoteUrl.value;
  const dispose = descriptors.dispose.value;
  if (typeof openRemoteUrl !== "function" || typeof dispose !== "function") {
    throw new TypeError("Remote computer exercise is invalid.");
  }

  let disposed = false;
  return Object.freeze({
    async openRemoteUrl(input) {
      if (disposed) throw failedError();
      let normalized;
      try {
        normalized = normalizedExerciseInput(input);
        const rawResult = await openRemoteUrl.call(raw, normalized);
        return normalizedAcknowledgement(rawResult, normalized);
      } catch (error) {
        if (error?.code === FAILED_CODE) throw error;
        throw failedError();
      }
    },

    async dispose(input) {
      if (disposed) return undefined;
      disposed = true;
      try {
        let signal;
        if (input !== undefined) {
          const inputDescriptors = objectDescriptors(input, "Remote computer exercise disposal", ["signal"]);
          signal = inputDescriptors.signal.value;
          if (!(signal instanceof AbortSignal)) throw failedError();
        }
        await dispose.call(raw, signal === undefined ? undefined : operationInput({}, signal));
        return undefined;
      } catch {
        throw failedError();
      }
    },
  });
}

function loadLiveGateDependencies(options) {
  let rawProvider;
  let rawExercise;
  try {
    const descriptors = objectDescriptors(
      options,
      "Remote provider gate configuration",
      [
        "providerModulePath",
        "providerModuleSha256",
        "exerciseModulePath",
        "exerciseModuleSha256",
      ],
    );
    rawProvider = configuredModule(
      descriptors.providerModulePath.value,
      descriptors.providerModuleSha256.value,
      "createProvider",
      "provider",
    );
    rawExercise = configuredModule(
      descriptors.exerciseModulePath.value,
      descriptors.exerciseModuleSha256.value,
      "createExercise",
      "exercise",
    );
    const provider = validateProvider(rawProvider);
    const validatedExercise = validateComputerExercise(rawExercise);
    const exercise = Object.freeze({
      openRemoteUrl: (input) => validatedExercise.openRemoteUrl(input),
      async dispose(input) {
        try {
          return await validatedExercise.dispose(input);
        } finally {
          closeReviewedAdapter(rawExercise);
        }
      },
    });
    let dependenciesClosed = false;
    const closeDependencies = () => {
      if (dependenciesClosed) return;
      dependenciesClosed = true;
      reviewedDependencyClosers.delete(provider);
      reviewedDependencyClosers.delete(exercise);
      closeReviewedAdapter(rawProvider);
      closeReviewedAdapter(rawExercise);
    };
    reviewedDependencyClosers.set(provider, closeDependencies);
    reviewedDependencyClosers.set(exercise, closeDependencies);
    return Object.freeze({ provider, exercise });
  } catch {
    closeReviewedAdapter(rawProvider);
    closeReviewedAdapter(rawExercise);
    throw blockedError();
  }
}

function operationInput(fields, signal) {
  const input = { ...fields };
  if (signal !== undefined) {
    Object.defineProperty(input, "signal", {
      value: signal,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(input);
}

function withCooperativeDeadline(start, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(failedError());
  const operationController = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const abort = () => {
      operationController.abort();
      finish(reject, failedError());
    };
    const onAbort = () => abort();
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => start(operationController.signal)).then(
      (value) => finish(resolve, value),
      () => finish(reject, failedError()),
    );
  });
}

function boundedEventLog() {
  return { items: [], overflow: false };
}

function appendBoundedEvent(log, event) {
  if (log.items.length >= MAX_GATE_EVENTS) {
    log.overflow = true;
    return;
  }
  log.items.push(event);
}

function cooperativeDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(failedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(failedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForTerminalInspection(provider, receipt, timeoutMs, signal) {
  return withCooperativeDeadline(async (operationSignal) => {
    while (true) {
      const inspected = await provider.inspect({
        runtimeId: receipt.runtimeId,
        signal: operationSignal,
      });
      if (inspected.runtimeId !== receipt.runtimeId
        || inspected.ownerBotId !== receipt.botId) throw failedError();
      if (inspected.state === "retired" || inspected.state === "detached") return inspected;
      await cooperativeDelay(10, operationSignal);
    }
  }, timeoutMs, signal);
}

function runtimeProviderRecorder(provider, receipts, ingressEvents, options) {
  let defaultSignal = options.signal;
  const inflight = new Set();
  const recordedProvisions = new Set();
  const recordProvision = (input, result) => {
    const key = `${input.botId}\0${input.idempotencyKey}`;
    if (recordedProvisions.has(key)) return;
    const receipt = {
      botId: input.botId,
      idempotencyKey: input.idempotencyKey,
      provider: result.provider,
      runtimeId: result.runtimeId,
      endpoint: result.endpoint,
    };
    Object.defineProperty(receipt, "authToken", {
      value: result.authToken,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    recordedProvisions.add(key);
    receipts.push(Object.freeze(receipt));
  };
  const invoke = (method, fields, signal = defaultSignal, onResolved) => withCooperativeDeadline(
    (operationSignal) => {
      const operation = Promise.resolve(provider[method](operationInput(fields, operationSignal))).then(
        (result) => {
          onResolved?.(result);
          return result;
        },
      );
      inflight.add(operation);
      void operation.finally(() => inflight.delete(operation)).catch(() => {});
      return operation;
    },
    options.timeoutMs,
    signal,
  );
  const adapter = Object.freeze({
    capabilities: () => invoke("capabilities", {}),
    async provision(input) {
      return invoke("provision", {
        botId: input.botId,
        idempotencyKey: input.idempotencyKey,
      }, input.signal ?? defaultSignal, input.recordReceipt === false
        ? undefined
        : (result) => recordProvision(input, result));
    },
    inspect: (input) => invoke("inspect", { runtimeId: input.runtimeId }, input.signal ?? defaultSignal),
    retire: (input) => invoke("retire", { runtimeId: input.runtimeId }, input.signal ?? defaultSignal),
    subscribe(callback) {
      return provider.subscribe((event) => {
        appendBoundedEvent(ingressEvents, Object.freeze({
          runtimeId: event.runtimeId,
          type: event.type,
          sequence: event.sequence,
        }));
        callback(event);
      });
    },
  });
  return Object.freeze({
    adapter,
    useSignal(signal) {
      defaultSignal = signal;
    },
    async settleInflight(signal, timeoutMs) {
      while (inflight.size > 0) {
        await withDeadline(Promise.allSettled([...inflight]), timeoutMs, signal);
      }
    },
  });
}

async function resolvedPublicAddresses(endpoint, lookup, timeoutMs, signal) {
  let hostname;
  try {
    hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw failedError();
  }
  const literalVersion = isIP(hostname);
  if (literalVersion) {
    if (!publicIpAddress(hostname)) throw failedError();
    return Object.freeze([hostname.toLowerCase()]);
  }

  let raw;
  try {
    raw = await withCooperativeDeadline(
      (operationSignal) => lookup(hostname, {
        all: true,
        verbatim: true,
        signal: operationSignal,
      }),
      timeoutMs,
      signal,
    );
  } catch {
    throw failedError();
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 16) throw failedError();
  const addresses = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || types.isProxy(entry)) {
      throw failedError();
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (!descriptors.address || !("value" in descriptors.address)
      || !descriptors.family || !("value" in descriptors.family)) throw failedError();
    const address = descriptors.address.value;
    const family = descriptors.family.value;
    if ((family !== 4 && family !== 6) || isIP(address) !== family || !publicIpAddress(address)) {
      throw failedError();
    }
    addresses.push(address.toLowerCase());
  }
  return Object.freeze([...new Set(addresses)].sort());
}

function sameAddresses(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalEndpoint(endpoint) {
  try {
    return new URL(endpoint).href;
  } catch {
    throw failedError();
  }
}

function pinnedTransport(endpoint, addresses) {
  let expectedHostname;
  try {
    expectedHostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    throw failedError();
  }
  const expectedRemoteAddresses = Object.freeze([...addresses]);
  const lookup = (hostname, rawOptions, rawCallback) => {
    const callback = typeof rawOptions === "function" ? rawOptions : rawCallback;
    const options = typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
    if (typeof callback !== "function" || String(hostname).toLowerCase() !== expectedHostname) {
      if (typeof callback === "function") callback(new Error("Remote DNS pin mismatch."));
      return;
    }
    const family = options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates = expectedRemoteAddresses
      .map((address) => ({ address, family: isIP(address) }))
      .filter((candidate) => family === 0 || candidate.family === family);
    if (candidates.length === 0) {
      callback(new Error("Remote DNS pin mismatch."));
      return;
    }
    if (options.all === true) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
  return Object.freeze({ lookup, expectedRemoteAddresses });
}

function withDeadline(promise, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(failedError());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, failedError());
    const timer = setTimeout(() => finish(reject, failedError()), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      () => finish(reject, failedError()),
    );
  });
}

async function readRemoteProtocol(client, { timeoutMs, signal }) {
  await withDeadline(client.start(), timeoutMs, signal);
  const account = await withDeadline(
    client.request("account/read", { refreshToken: false }, timeoutMs),
    timeoutMs,
    signal,
  );
  if (!account || typeof account !== "object" || Array.isArray(account)) throw failedError();

  let cursor = null;
  let modelCount = 0;
  const seenCursors = new Set();
  for (let page = 0; page < 16; page += 1) {
    const result = await withDeadline(
      client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      }, timeoutMs),
      timeoutMs,
      signal,
    );
    if (!result || typeof result !== "object" || Array.isArray(result)
      || !Array.isArray(result.data)) throw failedError();
    modelCount += result.data.length;
    if (modelCount > 4096) throw failedError();
    const next = result.nextCursor ?? null;
    if (next === null) {
      if (modelCount < 1) throw failedError();
      return Object.freeze({ accountReadable: true, modelCount });
    }
    if (typeof next !== "string" || next.length < 1 || next.length > 512
      || seenCursors.has(next)) throw failedError();
    seenCursors.add(next);
    cursor = next;
  }
  throw failedError();
}

async function readyBot(controller, provider) {
  const bot = await controller.createBot();
  if (!bot || bot.runtime?.state !== "ready") throw failedError();
  const session = await controller.runtimeSession(bot.botId);
  if (!session || session.runtimeId !== bot.runtime.remoteRuntimeId || session.generation < 1) {
    throw failedError();
  }
  const inspected = await provider.inspect({ runtimeId: session.runtimeId });
  if (inspected.runtimeId !== session.runtimeId
    || inspected.ownerBotId !== bot.botId
    || inspected.state !== "ready") throw failedError();
  return Object.freeze({ botId: bot.botId, session });
}

function frameDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== "string" || !("value" in descriptors[key])
  ))) return null;
  const width = descriptors.width?.value;
  const height = descriptors.height?.value;
  const digest = descriptors.digest?.value;
  if (!(Number.isSafeInteger(width) && width >= 320 && width <= 8192
    && Number.isSafeInteger(height) && height >= 240 && height <= 8192
    && typeof digest === "string"
    && /^sha256:[0-9a-f]{64}$/.test(digest))) return null;
  return Object.freeze({ width, height, digest });
}

function youtubeProofFromEvent(value, receipt, minimumSequence, actionId, priorDigests) {
  if (!value || typeof value !== "object"
    || value.botId !== receipt.botId
    || value.generation !== receipt.session.generation
    || value.runtime?.remoteRuntimeId !== receipt.session.runtimeId
    || value.runtime?.state !== "ready"
    || value.event?.runtimeId !== receipt.session.runtimeId
    || value.event?.type !== "computer/frame"
    || !Number.isSafeInteger(value.event.sequence)
    || value.event.sequence <= minimumSequence) throw failedError();

  const browser = value.event.payload?.browser;
  const frame = frameDescriptor(value.event.payload?.frame);
  let browserUrl;
  try {
    browserUrl = new URL(browser?.url);
  } catch {
    throw failedError();
  }
  if (value.event.payload?.actionId !== actionId
    || browser?.name !== "Google Chrome"
    || browserUrl.protocol !== "https:"
    || browserUrl.hostname !== "www.youtube.com"
    || browserUrl.username
    || browserUrl.password
    || typeof browser.title !== "string"
    || !browser.title.includes("YouTube")
    || !frame
    || priorDigests.has(frame.digest)) throw failedError();

  return Object.freeze({
    digest: frame.digest,
    sequence: value.event.sequence,
    public: Object.freeze({
      browser: "Google Chrome",
      host: "www.youtube.com",
      titleMarker: "YouTube",
      frameReceived: true,
    }),
  });
}

function computerFrameWaiter({
  controller,
  receipt,
  priorEvents,
  ingressEvents,
  ingressStart,
  timeoutMs,
  settleMs,
  signal,
  actionId,
}) {
  const priorSequence = priorEvents.reduce((maximum, value) => (
    value?.botId === receipt.botId
      && value?.event?.runtimeId === receipt.session.runtimeId
      && value?.event?.type === "computer/frame"
      && Number.isSafeInteger(value.event.sequence)
      ? Math.max(maximum, value.event.sequence)
      : maximum
  ), 0);
  const priorDigests = new Set(priorEvents.flatMap((value) => {
    if (value?.botId !== receipt.botId
      || value?.event?.runtimeId !== receipt.session.runtimeId
      || value?.event?.type !== "computer/frame") return [];
    const frame = frameDescriptor(value.event.payload?.frame);
    return frame ? [frame.digest] : [];
  }));
  let settled = false;
  let completed = false;
  let violated = false;
  let crossBotFrameCount = 0;
  let matched = null;
  let timeoutTimer = null;
  let settleTimer = null;
  let resolvePromise;
  let rejectPromise;
  const consumedIngress = new Set();
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const detach = () => {
    clearTimeout(timeoutTimer);
    clearTimeout(settleTimer);
    signal?.removeEventListener("abort", onAbort);
    controller.removeListener("runtime-event", onEvent);
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    detach();
    rejectPromise(failedError());
  };
  const complete = () => {
    if (settled || !matched) return;
    settled = true;
    completed = true;
    clearTimeout(timeoutTimer);
    clearTimeout(settleTimer);
    resolvePromise(matched.public);
  };
  const onAbort = () => fail();
  const consumeFreshIngress = (event) => {
    for (let index = ingressStart; index < ingressEvents.length; index += 1) {
      if (consumedIngress.has(index)) continue;
      const ingress = ingressEvents[index];
      if (ingress.runtimeId === event.event.runtimeId
        && ingress.type === event.event.type
        && ingress.sequence === event.event.sequence) {
        consumedIngress.add(index);
        return true;
      }
    }
    return false;
  };
  const onEvent = (event) => {
    if (event?.event?.type !== "computer/frame") return;
    if (event?.botId !== receipt.botId) crossBotFrameCount += 1;
    if (completed) {
      violated = true;
      return;
    }
    if (settled) return;
    if (!consumeFreshIngress(event)) {
      fail();
      return;
    }
    if (event.botId !== receipt.botId) {
      fail();
      return;
    }
    let proof;
    try {
      proof = youtubeProofFromEvent(event, receipt, priorSequence, actionId, priorDigests);
    } catch {
      fail();
      return;
    }
    if (matched) {
      if (proof.sequence <= matched.sequence) fail();
      else fail();
      return;
    }
    matched = proof;
    settleTimer = setTimeout(complete, settleMs);
  };

  controller.on("runtime-event", onEvent);
  signal?.addEventListener("abort", onAbort, { once: true });
  timeoutTimer = setTimeout(fail, timeoutMs);
  if (signal?.aborted) fail();

  return Object.freeze({
    promise,
    cancel: fail,
    finish() {
      detach();
      return Object.freeze({
        clean: completed && !violated && !signal?.aborted,
        crossBotFrameCount,
      });
    },
  });
}

async function waitForYouTubeFrame({
  controller,
  botA,
  botB,
  exercise,
  runtimeEvents,
  ingressEvents,
  timeoutMs,
  settleMs,
  signal,
}) {
  const actionId = `exercise-${randomUUID()}`;
  const ingressStart = ingressEvents.items.length;
  const waiter = computerFrameWaiter({
    controller,
    receipt: botA,
    priorEvents: runtimeEvents.items,
    ingressEvents: ingressEvents.items,
    ingressStart,
    timeoutMs,
    settleMs,
    signal,
    actionId,
  });
  void waiter.promise.catch(() => {});
  try {
    await withCooperativeDeadline(
      (operationSignal) => exercise.openRemoteUrl(operationInput({
        actionId,
        botId: botA.botId,
        runtimeId: botA.session.runtimeId,
        generation: botA.session.generation,
        url: YOUTUBE_URL,
      }, operationSignal)),
      timeoutMs,
      signal,
    );
    const proof = await waiter.promise;
    const currentA = await controller.runtimeSession(botA.botId);
    const currentB = await controller.runtimeSession(botB.botId);
    if (!currentA || currentA.runtimeId !== botA.session.runtimeId
      || currentA.generation !== botA.session.generation
      || !currentB || currentB.runtimeId !== botB.session.runtimeId
      || currentB.generation !== botB.session.generation) throw failedError();
    return Object.freeze({ proof, monitor: waiter });
  } catch (error) {
    waiter.cancel();
    throw error;
  }
}

async function minimalCleanup({
  clients,
  exercise,
  controller,
  provider,
  providerControl,
  receipts,
  readyReceipts,
  store,
  storeFilePath,
  operationTimeoutMs,
  cleanupTimeoutMs,
}) {
  let safe = true;
  let retiredRuntimeCount = 0;
  let terminalRuntimeCount = 0;
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(() => cleanupController.abort(), cleanupTimeoutMs);
  const cleanupSignal = cleanupController.signal;
  providerControl.useSignal(cleanupSignal);
  for (const client of clients) {
    try {
      client.stop();
    } catch {
      safe = false;
    }
  }
  try {
    await withCooperativeDeadline(
      (operationSignal) => exercise.dispose(operationInput({}, operationSignal)),
      operationTimeoutMs,
      cleanupSignal,
    );
  } catch {
    safe = false;
  }
  try {
    await providerControl.settleInflight(cleanupSignal, cleanupTimeoutMs);
  } catch {
    safe = false;
  }
  const retired = new Set();
  for (const receipt of [...receipts].reverse()) {
    if (retired.has(receipt.runtimeId)) continue;
    try {
      const readyReceipt = readyReceipts.get(receipt.runtimeId);
      let result;
      let terminal;
      const retireExactIssuance = async () => {
        const recovered = await provider.provision({
          botId: receipt.botId,
          idempotencyKey: receipt.idempotencyKey,
          recordReceipt: false,
        });
        if (recovered.provider !== receipt.provider
          || recovered.runtimeId !== receipt.runtimeId
          || recovered.ownerBotId !== receipt.botId
          || recovered.endpoint !== receipt.endpoint
          || recovered.authToken !== receipt.authToken) throw failedError();
        const inspected = await provider.inspect({ runtimeId: receipt.runtimeId });
        if (inspected.runtimeId !== receipt.runtimeId
          || inspected.ownerBotId !== receipt.botId) throw failedError();
        if (inspected.state === "retired" || inspected.state === "detached") {
          result = inspected;
          terminal = inspected;
        } else {
          result = await provider.retire({ runtimeId: receipt.runtimeId });
          terminal = await waitForTerminalInspection(
            provider,
            receipt,
            operationTimeoutMs,
            cleanupSignal,
          );
        }
      };

      if (readyReceipt) {
        const currentSession = await controller.runtimeSession(readyReceipt.botId);
        if (!currentSession
          || currentSession.provider !== readyReceipt.provider
          || currentSession.runtimeId !== readyReceipt.runtimeId
          || currentSession.generation !== readyReceipt.generation) throw failedError();
        await store.runtimeTransaction(readyReceipt.botId, {}, async ({ bot }) => {
          if (bot.runtime.provider !== readyReceipt.provider
            || bot.runtime.remoteRuntimeId !== readyReceipt.runtimeId
            || bot.runtime.state !== "ready") throw failedError();
          await retireExactIssuance();
        });
      } else {
        await retireExactIssuance();
      }

      if (result.runtimeId !== receipt.runtimeId
        || (result.state !== "retired" && result.state !== "detached")) safe = false;
      else {
        retired.add(receipt.runtimeId);
        retiredRuntimeCount += 1;
        if (terminal.runtimeId === receipt.runtimeId
          && terminal.ownerBotId === receipt.botId
          && (terminal.state === "retired" || terminal.state === "detached")) {
          terminalRuntimeCount += 1;
        } else {
          safe = false;
        }
      }
    } catch {
      safe = false;
    }
  }
  try {
    await providerControl.settleInflight(cleanupSignal, cleanupTimeoutMs);
  } catch {
    safe = false;
  }
  try {
    controller?.dispose();
  } catch {
    safe = false;
  }
  let storeRemoved = false;
  try {
    const stat = fs.lstatSync(storeFilePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failedError();
    fs.unlinkSync(storeFilePath);
    storeRemoved = true;
  } catch (error) {
    if (error?.code === "ENOENT") storeRemoved = true;
    else safe = false;
  }
  clearTimeout(cleanupTimer);
  safe = safe
    && retiredRuntimeCount === receipts.length
    && terminalRuntimeCount === receipts.length
    && storeRemoved;
  return Object.freeze({ safe, retiredRuntimeCount, terminalRuntimeCount, storeRemoved });
}

async function runRemoteProviderLiveGate(options) {
  let descriptors;
  try {
    descriptors = objectDescriptors(options, "Remote provider live gate options");
  } catch {
    throw failedError();
  }
  const provider = descriptors.provider?.value;
  const exercise = descriptors.exercise?.value;
  const workspacePath = descriptors.workspacePath?.value;
  const dependencies = descriptors.dependencies?.value ?? {};
  const signal = descriptors.signal?.value;
  if (!provider || typeof provider.capabilities !== "function"
    || !exercise || typeof exercise.dispose !== "function"
    || typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)
    || !dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)
    || (signal !== undefined && !(signal instanceof AbortSignal))) {
    closeReviewedDependencies(provider, exercise);
    throw failedError();
  }

  const clients = [];
  const receipts = [];
  const readyReceipts = new Map();
  let controller = null;
  let store = null;
  const runtimeEvents = boundedEventLog();
  const ingressEvents = boundedEventLog();
  const startedAt = new Date().toISOString();
  let result = null;
  let failure = null;
  let computerMonitor = null;
  const lookup = typeof dependencies.lookup === "function"
    ? dependencies.lookup
    : dns.lookup.bind(dns);
  const clientFactory = typeof dependencies.clientFactory === "function"
    ? dependencies.clientFactory
    : (session, transport) => new RemoteAppServerClient({ session, ...transport });
  const operationTimeoutMs = dependencies.operationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(operationTimeoutMs)
    || operationTimeoutMs < 10
    || operationTimeoutMs > 60_000) {
    closeReviewedDependencies(provider, exercise);
    throw failedError();
  }
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(cleanupTimeoutMs)
    || cleanupTimeoutMs < 50
    || cleanupTimeoutMs > 120_000) {
    closeReviewedDependencies(provider, exercise);
    throw failedError();
  }
  const computerTimeoutMs = dependencies.computerTimeoutMs ?? 30_000;
  const frameSettleMs = dependencies.frameSettleMs ?? 250;
  if (!Number.isSafeInteger(computerTimeoutMs)
    || computerTimeoutMs < 50
    || computerTimeoutMs > 60_000
    || !Number.isSafeInteger(frameSettleMs)
    || frameSettleMs < 10
    || frameSettleMs > 1_000
    || frameSettleMs >= computerTimeoutMs) {
    closeReviewedDependencies(provider, exercise);
    throw failedError();
  }
  const providerControl = runtimeProviderRecorder(provider, receipts, ingressEvents, {
    timeoutMs: operationTimeoutMs,
    signal,
  });
  const recordedProvider = providerControl.adapter;
  const storeFilePath = path.join(workspacePath, "bots.json");

  try {
    if (signal?.aborted) throw failedError();
    const stat = fs.lstatSync(workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failedError();
    const capabilities = await recordedProvider.capabilities();
    if (Object.values(capabilities).some((value) => value !== true)) throw failedError();

    try {
      fs.lstatSync(storeFilePath);
      throw failedError();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    store = new BotStore({ filePath: storeFilePath });
    controller = new BotRuntimeController({ store, provider: recordedProvider });
    controller.on("runtime-event", (event) => appendBoundedEvent(runtimeEvents, event));
    const botA = await readyBot(controller, recordedProvider);
    if (signal?.aborted) throw failedError();
    const botB = await readyBot(controller, recordedProvider);
    for (const bot of [botA, botB]) {
      const provisionReceipt = receipts.find((receipt) => (
        receipt.botId === bot.botId && receipt.runtimeId === bot.session.runtimeId
      ));
      if (!provisionReceipt) throw failedError();
      readyReceipts.set(bot.session.runtimeId, Object.freeze({
        botId: bot.botId,
        provider: bot.session.provider,
        runtimeId: bot.session.runtimeId,
        generation: bot.session.generation,
      }));
    }
    const receiptA = receipts.find((receipt) => (
      receipt.botId === botA.botId && receipt.runtimeId === botA.session.runtimeId
    ));
    const receiptB = receipts.find((receipt) => (
      receipt.botId === botB.botId && receipt.runtimeId === botB.session.runtimeId
    ));
    if (!receiptA || !receiptB
      || botA.session.runtimeId === botB.session.runtimeId
      || canonicalEndpoint(botA.session.endpoint) === canonicalEndpoint(botB.session.endpoint)
      || receiptA.provider !== receiptB.provider
      || receiptA.authToken === receiptB.authToken) throw failedError();

    const firstAddresses = await Promise.all([
      resolvedPublicAddresses(botA.session.endpoint, lookup, operationTimeoutMs, signal),
      resolvedPublicAddresses(botB.session.endpoint, lookup, operationTimeoutMs, signal),
    ]);
    const secondAddressesA = await resolvedPublicAddresses(
      botA.session.endpoint,
      lookup,
      operationTimeoutMs,
      signal,
    );
    if (!sameAddresses(firstAddresses[0], secondAddressesA)) throw failedError();
    const clientA = clientFactory(botA.session, pinnedTransport(botA.session.endpoint, secondAddressesA));
    if (clientA && typeof clientA.stop === "function") clients.push(clientA);
    if (!clientA || typeof clientA.start !== "function" || typeof clientA.request !== "function"
      || typeof clientA.stop !== "function"
      || clientA.provider !== botA.session.provider
      || clientA.runtimeId !== botA.session.runtimeId
      || clientA.generation !== botA.session.generation) throw failedError();
    const protocol = [];
    protocol.push(await readRemoteProtocol(clientA, { timeoutMs: operationTimeoutMs, signal }));

    const secondAddressesB = await resolvedPublicAddresses(
      botB.session.endpoint,
      lookup,
      operationTimeoutMs,
      signal,
    );
    if (!sameAddresses(firstAddresses[1], secondAddressesB)) throw failedError();
    const clientB = clientFactory(botB.session, pinnedTransport(botB.session.endpoint, secondAddressesB));
    if (clientB && typeof clientB.stop === "function") clients.push(clientB);
    if (!clientB || typeof clientB.start !== "function" || typeof clientB.request !== "function"
      || typeof clientB.stop !== "function" || clientA === clientB
      || clientB.provider !== botB.session.provider
      || clientB.runtimeId !== botB.session.runtimeId
      || clientB.generation !== botB.session.generation) throw failedError();
    protocol.push(await readRemoteProtocol(clientB, { timeoutMs: operationTimeoutMs, signal }));
    const computerResult = await waitForYouTubeFrame({
      controller,
      botA,
      botB,
      exercise,
      runtimeEvents,
      ingressEvents,
      timeoutMs: computerTimeoutMs,
      settleMs: frameSettleMs,
      signal,
    });
    computerMonitor = computerResult.monitor;
    result = Object.freeze({
      status: "PASS",
      startedAt,
      provider: receipts[0]?.provider,
      bots: Object.freeze([
        Object.freeze({ botId: botA.botId, runtimeId: botA.session.runtimeId, generation: botA.session.generation }),
        Object.freeze({ botId: botB.botId, runtimeId: botB.session.runtimeId, generation: botB.session.generation }),
      ]),
      capabilities,
      protocol: Object.freeze([
        Object.freeze({ botId: botA.botId, ...protocol[0] }),
        Object.freeze({ botId: botB.botId, ...protocol[1] }),
      ]),
      computer: computerResult.proof,
      isolation: Object.freeze({ crossBotFrameCount: 0, passed: true }),
    });
  } catch {
    failure = failedError();
  }

  let cleanup;
  try {
    cleanup = await minimalCleanup({
      clients,
      exercise,
      controller,
      provider: recordedProvider,
      providerControl,
      receipts,
      readyReceipts,
      store,
      storeFilePath,
      operationTimeoutMs,
      cleanupTimeoutMs,
    });
  } finally {
    closeReviewedDependencies(provider, exercise);
  }
  const monitored = computerMonitor?.finish() ?? Object.freeze({ clean: false, crossBotFrameCount: 0 });
  if (failure || !cleanup.safe || !result
    || runtimeEvents.overflow || ingressEvents.overflow
    || !monitored.clean || monitored.crossBotFrameCount !== 0) {
    throw failedError();
  }
  return Object.freeze({
    ...result,
    finishedAt: new Date().toISOString(),
    cleanup,
  });
}

module.exports = {
  disposeLiveGateDependencies,
  isReviewedAdapterEnvelope,
  loadLiveGateDependencies,
  runRemoteProviderLiveGate,
  validateComputerExercise,
};
