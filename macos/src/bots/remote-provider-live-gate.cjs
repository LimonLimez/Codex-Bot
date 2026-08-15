"use strict";

const fs = require("node:fs");
const dns = require("node:dns/promises");
const { isIP } = require("node:net");
const path = require("node:path");
const { types } = require("node:util");

const { BotStore } = require("./bot-store.cjs");
const { RemoteAppServerClient } = require("./remote-app-server-client.cjs");
const { BotRuntimeController } = require("./runtime-controller.cjs");
const { validateProvider } = require("./runtime-provider.cjs");

const BLOCKED_CODE = "REMOTE_PROVIDER_GATE_BLOCKED";
const BLOCKED_MESSAGE = "Remote provider verification is not configured.";
const FAILED_CODE = "REMOTE_PROVIDER_GATE_FAILED";
const FAILED_MESSAGE = "Remote provider verification failed.";
const YOUTUBE_URL = "https://www.youtube.com/";
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

function objectDescriptors(value, label, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
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

function privateModulePath(value) {
  try {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw blockedError();
    const stat = fs.lstatSync(value);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw blockedError();
    return value;
  } catch {
    throw blockedError();
  }
}

function configuredModule(modulePath, factoryName) {
  try {
    const loaded = require(privateModulePath(modulePath));
    const descriptors = objectDescriptors(loaded, "Remote provider module", [factoryName]);
    const factory = descriptors[factoryName].value;
    if (typeof factory !== "function") throw blockedError();
    return factory.call(loaded);
  } catch {
    throw blockedError();
  }
}

function normalizedExerciseInput(value) {
  const descriptors = objectDescriptors(
    value,
    "Remote computer exercise input",
    ["botId", "runtimeId", "generation", "url"],
  );
  const botId = descriptors.botId.value;
  const runtimeId = descriptors.runtimeId.value;
  const generation = descriptors.generation.value;
  const url = descriptors.url.value;
  if (typeof botId !== "string" || !BOT_ID_PATTERN.test(botId)) throw failedError();
  if (typeof runtimeId !== "string" || !SAFE_IDENTIFIER_PATTERN.test(runtimeId)) throw failedError();
  if (!Number.isSafeInteger(generation) || generation < 1) throw failedError();
  if (url !== YOUTUBE_URL) throw failedError();
  return Object.freeze({ botId: botId.toLowerCase(), runtimeId, generation, url });
}

function normalizedAcknowledgement(value, expected) {
  let descriptors;
  try {
    descriptors = objectDescriptors(value, "Remote computer exercise acknowledgement");
  } catch {
    throw failedError();
  }
  const required = ["accepted", "botId", "runtimeId", "generation", "url"];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    throw failedError();
  }
  if (descriptors.accepted.value !== true
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

    async dispose() {
      if (disposed) return undefined;
      disposed = true;
      try {
        await dispose.call(raw);
        return undefined;
      } catch {
        throw failedError();
      }
    },
  });
}

function loadLiveGateDependencies(options) {
  try {
    const descriptors = objectDescriptors(
      options,
      "Remote provider gate configuration",
      ["providerModulePath", "exerciseModulePath"],
    );
    const rawProvider = configuredModule(descriptors.providerModulePath.value, "createProvider");
    const rawExercise = configuredModule(descriptors.exerciseModulePath.value, "createExercise");
    const provider = validateProvider(rawProvider);
    const exercise = validateComputerExercise(rawExercise);
    return Object.freeze({ provider, exercise });
  } catch {
    throw blockedError();
  }
}

function runtimeProviderRecorder(provider, receipts, ingressEvents) {
  return Object.freeze({
    capabilities: (...args) => provider.capabilities(...args),
    async provision(input) {
      const result = await provider.provision(input);
      receipts.push(Object.freeze({
        botId: input.botId,
        provider: result.provider,
        runtimeId: result.runtimeId,
        endpoint: result.endpoint,
        authToken: result.authToken,
      }));
      return result;
    },
    inspect: (...args) => provider.inspect(...args),
    retire: (...args) => provider.retire(...args),
    subscribe(callback) {
      return provider.subscribe((event) => {
        ingressEvents.push(Object.freeze({
          runtimeId: event.runtimeId,
          type: event.type,
          sequence: event.sequence,
        }));
        callback(event);
      });
    },
  });
}

async function resolvedPublicAddresses(endpoint, lookup) {
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
    raw = await lookup(hostname, { all: true, verbatim: true });
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
    if (next === null) return Object.freeze({ accountReadable: true, modelCount });
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

function validFrameDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== "string" || !("value" in descriptors[key])
  ))) return false;
  const width = descriptors.width?.value;
  const height = descriptors.height?.value;
  const digest = descriptors.digest?.value;
  return Number.isSafeInteger(width) && width >= 320 && width <= 8192
    && Number.isSafeInteger(height) && height >= 240 && height <= 8192
    && typeof digest === "string"
    && /^sha256:[A-Za-z0-9._:-]{8,128}$/.test(digest);
}

function youtubeProofFromEvent(value, receipt, minimumSequence) {
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
  let browserUrl;
  try {
    browserUrl = new URL(browser?.url);
  } catch {
    throw failedError();
  }
  if (browser?.name !== "Google Chrome"
    || browserUrl.protocol !== "https:"
    || browserUrl.hostname !== "www.youtube.com"
    || browserUrl.username
    || browserUrl.password
    || typeof browser.title !== "string"
    || !browser.title.includes("YouTube")
    || !validFrameDescriptor(value.event.payload?.frame)) throw failedError();

  return Object.freeze({
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
}) {
  const priorSequence = priorEvents.reduce((maximum, value) => (
    value?.botId === receipt.botId
      && value?.event?.runtimeId === receipt.session.runtimeId
      && value?.event?.type === "computer/frame"
      && Number.isSafeInteger(value.event.sequence)
      ? Math.max(maximum, value.event.sequence)
      : maximum
  ), 0);
  let settled = false;
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
    detach();
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
    if (settled || event?.event?.type !== "computer/frame") return;
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
      proof = youtubeProofFromEvent(event, receipt, priorSequence);
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
  const ingressStart = ingressEvents.length;
  const waiter = computerFrameWaiter({
    controller,
    receipt: botA,
    priorEvents: runtimeEvents,
    ingressEvents,
    ingressStart,
    timeoutMs,
    settleMs,
    signal,
  });
  void waiter.promise.catch(() => {});
  try {
    await withDeadline(exercise.openRemoteUrl(Object.freeze({
      botId: botA.botId,
      runtimeId: botA.session.runtimeId,
      generation: botA.session.generation,
      url: YOUTUBE_URL,
    })), timeoutMs, signal);
    const proof = await waiter.promise;
    const currentA = await controller.runtimeSession(botA.botId);
    const currentB = await controller.runtimeSession(botB.botId);
    if (!currentA || currentA.runtimeId !== botA.session.runtimeId
      || currentA.generation !== botA.session.generation
      || !currentB || currentB.runtimeId !== botB.session.runtimeId
      || currentB.generation !== botB.session.generation) throw failedError();
    return proof;
  } finally {
    waiter.cancel();
  }
}

async function minimalCleanup({ clients, exercise, controller, provider, receipts }) {
  let safe = true;
  for (const client of clients) {
    try {
      client.stop();
    } catch {
      safe = false;
    }
  }
  try {
    await exercise.dispose();
  } catch {
    safe = false;
  }
  const retired = new Set();
  for (const receipt of [...receipts].reverse()) {
    if (retired.has(receipt.runtimeId)) continue;
    try {
      const inspected = await provider.inspect({ runtimeId: receipt.runtimeId });
      if (inspected.ownerBotId !== receipt.botId) {
        safe = false;
        continue;
      }
      const result = await provider.retire({ runtimeId: receipt.runtimeId });
      if (result.runtimeId !== receipt.runtimeId
        || (result.state !== "retired" && result.state !== "detached")) safe = false;
      else retired.add(receipt.runtimeId);
    } catch {
      safe = false;
    }
  }
  try {
    controller?.dispose();
  } catch {
    safe = false;
  }
  return safe;
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
    || (signal !== undefined && !(signal instanceof AbortSignal))) throw failedError();

  const clients = [];
  const receipts = [];
  let controller = null;
  const runtimeEvents = [];
  const ingressEvents = [];
  let result = null;
  let failure = null;
  const lookup = typeof dependencies.lookup === "function"
    ? dependencies.lookup
    : dns.lookup.bind(dns);
  const clientFactory = typeof dependencies.clientFactory === "function"
    ? dependencies.clientFactory
    : (session) => new RemoteAppServerClient({ session });
  const operationTimeoutMs = dependencies.operationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(operationTimeoutMs)
    || operationTimeoutMs < 10
    || operationTimeoutMs > 60_000) throw failedError();
  const computerTimeoutMs = dependencies.computerTimeoutMs ?? 30_000;
  const frameSettleMs = dependencies.frameSettleMs ?? 250;
  if (!Number.isSafeInteger(computerTimeoutMs)
    || computerTimeoutMs < 50
    || computerTimeoutMs > 60_000
    || !Number.isSafeInteger(frameSettleMs)
    || frameSettleMs < 10
    || frameSettleMs > 1_000
    || frameSettleMs >= computerTimeoutMs) throw failedError();
  const recordedProvider = runtimeProviderRecorder(provider, receipts, ingressEvents);

  try {
    if (signal?.aborted) throw failedError();
    const stat = fs.lstatSync(workspacePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failedError();
    const capabilities = await recordedProvider.capabilities();
    if (Object.values(capabilities).some((value) => value !== true)) throw failedError();

    const store = new BotStore({ filePath: path.join(workspacePath, "bots.json") });
    controller = new BotRuntimeController({ store, provider: recordedProvider });
    controller.on("runtime-event", (event) => runtimeEvents.push(event));
    const botA = await readyBot(controller, recordedProvider);
    if (signal?.aborted) throw failedError();
    const botB = await readyBot(controller, recordedProvider);
    if (botA.session.runtimeId === botB.session.runtimeId
      || botA.session.endpoint === botB.session.endpoint) throw failedError();

    const firstAddresses = await Promise.all([
      resolvedPublicAddresses(botA.session.endpoint, lookup),
      resolvedPublicAddresses(botB.session.endpoint, lookup),
    ]);
    const clientA = clientFactory(botA.session);
    const clientB = clientFactory(botB.session);
    if (!clientA || typeof clientA.start !== "function" || typeof clientA.request !== "function"
      || typeof clientA.stop !== "function" || !clientB || typeof clientB.start !== "function"
      || typeof clientB.request !== "function" || typeof clientB.stop !== "function") throw failedError();
    clients.push(clientA, clientB);
    const secondAddresses = await Promise.all([
      resolvedPublicAddresses(botA.session.endpoint, lookup),
      resolvedPublicAddresses(botB.session.endpoint, lookup),
    ]);
    if (!sameAddresses(firstAddresses[0], secondAddresses[0])
      || !sameAddresses(firstAddresses[1], secondAddresses[1])) throw failedError();

    const protocol = [];
    protocol.push(await readRemoteProtocol(clientA, { timeoutMs: operationTimeoutMs, signal }));
    protocol.push(await readRemoteProtocol(clientB, { timeoutMs: operationTimeoutMs, signal }));
    const computer = await waitForYouTubeFrame({
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
    result = Object.freeze({
      status: "PASS",
      provider: receipts[0]?.provider,
      botCount: 2,
      capabilities,
      protocol: Object.freeze(protocol),
      computer,
      isolation: Object.freeze({ crossBotFrameCount: 0, passed: true }),
    });
  } catch {
    failure = failedError();
  }

  const cleanupSafe = await minimalCleanup({ clients, exercise, controller, provider, receipts });
  if (failure || !cleanupSafe || !result) throw failedError();
  return result;
}

module.exports = {
  loadLiveGateDependencies,
  runRemoteProviderLiveGate,
  validateComputerExercise,
};
