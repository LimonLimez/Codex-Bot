"use strict";

const { types } = require("node:util");

const MAX_ADAPTER_DATA_DEPTH = 24;
const MAX_ADAPTER_DATA_FIELDS = 256;
const MAX_ADAPTER_DATA_NODES = 4_096;
const MAX_ADAPTER_STRING_BYTES = 65_536;
const MAX_ADAPTER_TOTAL_STRING_BYTES = 262_144;

function assertBoundedAdapterData(
  value,
  seen = new Set(),
  budget = { nodes: 0, stringBytes: 0 },
  depth = 0,
) {
  if (value && typeof value === "object") {
    if (types.isProxy(value)) throw new TypeError("Reviewed adapter data cannot contain proxies.");
    if (seen.has(value)) return value;
    seen.add(value);
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_ADAPTER_DATA_NODES || depth > MAX_ADAPTER_DATA_DEPTH) {
    throw new TypeError("Reviewed adapter data exceeds bounded complexity.");
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    budget.stringBytes += bytes;
    if (bytes > MAX_ADAPTER_STRING_BYTES
      || budget.stringBytes > MAX_ADAPTER_TOTAL_STRING_BYTES) {
      throw new TypeError("Reviewed adapter data exceeds bounded size.");
    }
    return value;
  }
  if (value === null || ["undefined", "number", "boolean", "bigint"].includes(typeof value)) {
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Reviewed adapter data must contain values only.");
  }
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Reviewed adapter data must use plain objects and arrays.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_ADAPTER_DATA_FIELDS
    || (array && descriptors.length?.value > MAX_ADAPTER_DATA_FIELDS)
    || keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Reviewed adapter data exceeds bounded complexity.");
  }
  for (const key of keys) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    budget.stringBytes += keyBytes;
    if (keyBytes > MAX_ADAPTER_STRING_BYTES
      || budget.stringBytes > MAX_ADAPTER_TOTAL_STRING_BYTES) {
      throw new TypeError("Reviewed adapter data exceeds bounded size.");
    }
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw new TypeError("Reviewed adapter data cannot contain accessors.");
    }
    if (!array || key !== "length") {
      assertBoundedAdapterData(descriptor.value, seen, budget, depth + 1);
    }
  }
  return value;
}

const REVIEWED_ADAPTER_WORKER_SOURCE = String.raw`
"use strict";

const Module = require("node:module");
const { types } = require("node:util");
const vm = require("node:vm");
const { workerData } = require("node:worker_threads");

const MAX_ADAPTER_DATA_DEPTH = ${MAX_ADAPTER_DATA_DEPTH};
const MAX_ADAPTER_DATA_FIELDS = ${MAX_ADAPTER_DATA_FIELDS};
const MAX_ADAPTER_DATA_NODES = ${MAX_ADAPTER_DATA_NODES};
const MAX_ADAPTER_STRING_BYTES = ${MAX_ADAPTER_STRING_BYTES};
const MAX_ADAPTER_TOTAL_STRING_BYTES = ${MAX_ADAPTER_TOTAL_STRING_BYTES};

${assertBoundedAdapterData.toString()}

const port = workerData.port;
const handshake = new Int32Array(workerData.handshake);
const operations = new Map();
let adapter = null;
let unsubscribe = null;
let ready = false;
let stopped = false;
const earlyEvents = [];

function signalHandshake(message) {
  try {
    port.postMessage(message);
  } finally {
    Atomics.store(handshake, 0, 1);
    Atomics.notify(handshake, 0);
  }
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(label + " must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + " must be a plain object.");
  }
  return value;
}

function exactFunctions(value, label, expectedKeys) {
  plainObject(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    throw new TypeError(label + " has invalid fields.");
  }
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError(label + " has invalid methods.");
    }
  }
  return value;
}

function restrictedRequire() {
  throw new Error("Module imports are unavailable.");
}

function evaluateReviewedModule() {
  const moduleRecord = Object.create(null);
  moduleRecord.exports = Object.create(null);
  moduleRecord.filename = workerData.modulePath;
  moduleRecord.require = restrictedRequire;
  const wrapper = new vm.Script(Module.wrap(workerData.source), {
    filename: workerData.modulePath,
    displayErrors: false,
  }).runInThisContext({ timeout: 1_000 });
  wrapper.call(
    moduleRecord.exports,
    moduleRecord.exports,
    restrictedRequire,
    moduleRecord,
    workerData.modulePath,
    workerData.moduleDirectory,
  );
  const exportsObject = plainObject(moduleRecord.exports, "Reviewed adapter module");
  const descriptors = Object.getOwnPropertyDescriptors(exportsObject);
  const exportKeys = Reflect.ownKeys(descriptors);
  if (exportKeys.length !== 1 || exportKeys[0] !== workerData.factoryName
    || !("value" in descriptors[workerData.factoryName])
    || typeof descriptors[workerData.factoryName].value !== "function") {
    throw new TypeError("Reviewed adapter module has invalid exports.");
  }
  return descriptors[workerData.factoryName].value.call(exportsObject);
}

function postEvent(value) {
  if (stopped) return;
  assertBoundedAdapterData(value);
  if (!ready) {
    if (earlyEvents.length >= workerData.maxEvents) {
      throw new Error("Reviewed adapter event limit exceeded.");
    }
    earlyEvents.push(structuredClone(value));
    return;
  }
  port.postMessage({ type: "event", value });
}

function initializeAdapter() {
  const created = evaluateReviewedModule();
  if (workerData.adapterKind === "provider") {
    adapter = exactFunctions(created, "Reviewed provider", [
      "capabilities",
      "provision",
      "inspect",
      "retire",
      "subscribe",
    ]);
    unsubscribe = adapter.subscribe.call(adapter, postEvent);
    if (typeof unsubscribe !== "function") {
      throw new TypeError("Reviewed provider subscription is invalid.");
    }
  } else if (workerData.adapterKind === "exercise") {
    adapter = exactFunctions(created, "Reviewed exercise", ["openRemoteUrl", "dispose"]);
  } else {
    throw new TypeError("Reviewed adapter kind is invalid.");
  }
}

function operationInput(fields, controller) {
  if (fields === undefined) {
    if (!controller) return undefined;
    fields = Object.create(null);
  }
  plainObject(fields, "Reviewed adapter operation input");
  const input = Object.assign(Object.create(null), fields);
  if (controller) {
    Object.defineProperty(input, "signal", {
      value: controller.signal,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(input);
}

async function performOperation(message) {
  const controller = message.abortable ? new AbortController() : null;
  if (controller) operations.set(message.id, controller);
  try {
    const value = await adapter[message.method].call(
      adapter,
      operationInput(message.input, controller),
    );
    assertBoundedAdapterData(value);
    port.postMessage({ type: "result", id: message.id, ok: true, value });
  } catch {
    try {
      port.postMessage({ type: "result", id: message.id, ok: false });
    } catch {}
  } finally {
    operations.delete(message.id);
  }
}

function stop() {
  if (stopped) return;
  stopped = true;
  for (const controller of operations.values()) controller.abort();
  operations.clear();
  if (typeof unsubscribe === "function") {
    const close = unsubscribe;
    unsubscribe = null;
    try { close(); } catch {}
  }
  try { port.postMessage({ type: "stopped" }); } catch {}
  port.close();
}

port.on("message", (message) => {
  if (stopped || !message || typeof message !== "object") return;
  if (message.type === "operation") {
    if (!Number.isSafeInteger(message.id) || message.id < 1
      || operations.has(message.id)
      || !Object.prototype.hasOwnProperty.call(adapter, message.method)
      || typeof adapter[message.method] !== "function") {
      stop();
      return;
    }
    void performOperation(message);
    return;
  }
  if (message.type === "abort") {
    operations.get(message.id)?.abort();
    return;
  }
  if (message.type === "shutdown") stop();
});

try {
  initializeAdapter();
  signalHandshake({ type: "ready", events: earlyEvents.splice(0) });
  ready = true;
} catch {
  signalHandshake({ type: "error" });
  stop();
}
`;

module.exports = Object.freeze({
  REVIEWED_ADAPTER_WORKER_SOURCE,
  assertBoundedAdapterData,
});
