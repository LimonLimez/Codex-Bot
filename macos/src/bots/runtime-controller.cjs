"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { providerContractVersion, validateProvider } = require("./runtime-provider.cjs");

const REQUIRED_CAPABILITIES = Object.freeze([
  "provision",
  "reconcile",
  "retire",
  "remoteAppServer",
  "computerFrames",
]);
const TERMINAL_RUNTIME_STATES = new Set(["detached", "retired"]);
const SAFE_EVENT_STATES = new Set([
  "ready",
  "reconnecting",
  "disconnected",
  "failed",
  "unavailable",
  "detached",
  "retired",
]);
const OPERATION_MARKER_PREFIX = "RUNTIME_OPERATION.";
const PROVIDER_EVENT_RETRY_BASE_MS = 2;
const PROVIDER_EVENT_RETRY_MAX_MS = 32;
const RUNTIME_TRANSACTION_LOCK_ERRORS = new Set([
  "BOT_STORE_RUNTIME_TRANSACTION_BUSY",
  "BOT_STORE_RUNTIME_TRANSACTION_REENTRANT",
]);
const MAX_DELETE_BOTS = 4096;
const MAX_RETIREMENT_RUNTIMES = 4096;
const RETIREMENT_READBACK_ATTEMPTS = 3;
const BOT_ID_PATTERN = /^bot-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const ISSUANCE_KEY_PATTERN = /^issuance-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETIREMENT_KEY_PATTERN = /^retire-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELETE_OPTION_FIELDS = new Set(["preferredActiveBotId"]);
const RETIREMENT_REQUEST_FIELDS = new Set([
  "deletionId", "createdAt", "botIds", "remoteRuntimes", "localProfiles", "survivingBotIds",
]);
const RETIREMENT_ENTRY_FIELDS = new Set(["botId", "runtimeId", "issuanceKey", "retirementKey"]);
const SESSION_LEASES = new WeakMap();
const SESSION_ISSUANCES = new WeakMap();

class ControllerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BotRuntimeError";
    this.code = code;
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function copyRuntime(runtime) {
  return {
    provider: runtime.provider,
    remoteRuntimeId: runtime.remoteRuntimeId,
    state: runtime.state,
    lastConfirmedAt: runtime.lastConfirmedAt,
    lastErrorCode: runtime.lastErrorCode,
  };
}

function operationMarker() {
  return `${OPERATION_MARKER_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

function isOperationMarker(value) {
  return typeof value === "string" && value.startsWith(OPERATION_MARKER_PREFIX);
}

function publicRuntime(runtime) {
  const snapshot = copyRuntime(runtime);
  if (isOperationMarker(snapshot.lastErrorCode)) snapshot.lastErrorCode = null;
  return snapshot;
}

function publicBot(bot) {
  if (!bot || !isOperationMarker(bot.runtime?.lastErrorCode)) return bot;
  return deepFreeze({
    ...bot,
    runtime: publicRuntime(bot.runtime),
  });
}

function privateSession(result, generation, leaseMarker = null) {
  const session = {
    provider: result.provider,
    runtimeId: result.runtimeId,
    generation,
  };
  Object.defineProperties(session, {
    endpoint: {
      value: result.endpoint,
      enumerable: false,
      configurable: false,
      writable: false,
    },
    authToken: {
      value: result.authToken,
      enumerable: false,
      configurable: false,
      writable: false,
    },
  });
  Object.freeze(session);
  SESSION_LEASES.set(session, leaseMarker);
  SESSION_ISSUANCES.set(session, Object.freeze({
    issuanceKey: result.issuanceKey,
    retirementKey: result.retirementKey,
  }));
  return session;
}

function sessionLease(session) {
  return session ? SESSION_LEASES.get(session) : null;
}

function sessionIssuance(session) {
  return session ? SESSION_ISSUANCES.get(session) : null;
}

function mapEntry(map, key) {
  return { present: map.has(key), value: map.get(key) };
}

function restoreMapEntry(map, key, entry) {
  if (entry.present) map.set(key, entry.value);
  else map.delete(key);
}

function sanitizedRuntimeEvent(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const sanitized = Array.isArray(value) ? [] : {};
  seen.set(value, sanitized);
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.includes("endpoint")
      || normalized === "authtoken"
      || normalized === "issuancekey"
      || normalized.includes("diagnostic")) continue;
    sanitized[key] = sanitizedRuntimeEvent(nested, seen);
  }
  return Object.freeze(sanitized);
}

function unavailableCapabilities(capabilities) {
  return !capabilities || REQUIRED_CAPABILITIES.some((name) => capabilities[name] !== true);
}

function persistedState(providerState) {
  if (providerState === "provisioning") return "provisioning";
  if (providerState === "reconnecting" || providerState === "disconnected") return "reconnecting";
  if (providerState === "unavailable") return "unavailable";
  if (providerState === "detached") return "detached";
  if (providerState === "retired") return "retired";
  return "failed";
}

function stateErrorCode(state) {
  if (state === "unavailable") return "REMOTE_PROVIDER_UNAVAILABLE";
  if (state === "failed") return "RUNTIME_NOT_READY";
  return null;
}

function safeFailure(error, fallbackCode = "RUNTIME_PROVISION_FAILED") {
  if (error instanceof ControllerError) return error;
  const message = typeof error?.message === "string" ? error.message : "";
  if (/mismatched owner|ownerbotid/i.test(message)) {
    return new ControllerError("Remote runtime owner mismatch.", "RUNTIME_OWNER_MISMATCH");
  }
  if (/already belongs|duplicate remote runtime|visible bot/i.test(message)) {
    return new ControllerError("Remote runtime already belongs to another bot.", "RUNTIME_ALREADY_OWNED");
  }
  if (/unavailable/i.test(message)) {
    return new ControllerError("Remote computer unavailable.", "REMOTE_PROVIDER_UNAVAILABLE");
  }
  return new ControllerError("Remote runtime provider failed.", fallbackCode);
}

function isCommittedDurabilityUncertain(error) {
  return error?.code === "BOT_STORE_DURABILITY_UNCERTAIN" && error?.committed === true;
}

function providerEventRetryDelay(attempt) {
  return Math.min(
    PROVIDER_EVENT_RETRY_BASE_MS * (2 ** Math.min(attempt, 4)),
    PROVIDER_EVENT_RETRY_MAX_MS,
  );
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) {
    throw new Error("Bot ID is invalid.");
  }
  return value.toLowerCase();
}

function normalizeDeleteBotIds(value) {
  let array;
  let prototype;
  let descriptors;
  try {
    array = Array.isArray(value);
    if (array) {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    }
  } catch {
    throw new TypeError("Bot deletion IDs could not be inspected safely.");
  }
  if (!array || prototype !== Array.prototype) {
    throw new TypeError("Bot deletion IDs must be a dense plain array.");
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_DELETE_BOTS) {
    throw new Error("Bot deletion IDs are invalid or oversized.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Bot deletion IDs cannot contain symbol fields.");
  }
  const elementKeys = keys.filter((key) => key !== "length");
  if (elementKeys.length !== length
    || elementKeys.some((key, index) => key !== String(index))) {
    throw new TypeError("Bot deletion IDs must be a dense plain array.");
  }
  const botIds = elementKeys.map((key) => {
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw new TypeError("Bot deletion IDs must contain plain data values only.");
    }
    return normalizeBotId(descriptor.value);
  });
  if (new Set(botIds).size !== botIds.length) {
    throw new Error("Bot deletion IDs must be unique.");
  }
  return botIds;
}

function normalizeDeleteOptions(value) {
  if (value === undefined) return { preferredActiveBotId: null };
  let array;
  let prototype;
  let descriptors;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("Bot deletion options could not be inspected safely.");
  }
  if (!value || typeof value !== "object" || array
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Bot deletion options must be a plain object.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Bot deletion options cannot contain symbol fields.");
  }
  for (const key of keys) {
    if (!DELETE_OPTION_FIELDS.has(key)) {
      throw new Error(`Bot deletion options contain an unsupported field: ${key}.`);
    }
    if (!("value" in descriptors[key])) {
      throw new TypeError(`Bot deletion option ${key} must be plain data, not an accessor.`);
    }
  }
  const preferred = descriptors.preferredActiveBotId?.value;
  return {
    preferredActiveBotId: preferred === undefined || preferred === null
      ? null
      : normalizeBotId(preferred),
  };
}

function normalizeRetirementRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !RETIREMENT_REQUEST_FIELDS.has(key)
    || !("value" in descriptors[key]))) {
    throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
  }
  const rawEntries = descriptors.remoteRuntimes?.value;
  if (!Array.isArray(rawEntries) || rawEntries.length > MAX_RETIREMENT_RUNTIMES) {
    throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
  }
  const entries = rawEntries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
    }
    let entryDescriptors;
    try { entryDescriptors = Object.getOwnPropertyDescriptors(entry); } catch {
      throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
    }
    const entryKeys = Reflect.ownKeys(entryDescriptors);
    if (entryKeys.length !== RETIREMENT_ENTRY_FIELDS.size
      || entryKeys.some((key) => typeof key !== "string"
        || !RETIREMENT_ENTRY_FIELDS.has(key) || !("value" in entryDescriptors[key]))) {
      throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
    }
    const raw = Object.fromEntries(entryKeys.map((key) => [key, entryDescriptors[key].value]));
    if (typeof raw.botId !== "string"
      || typeof raw.runtimeId !== "string"
      || typeof raw.issuanceKey !== "string"
      || typeof raw.retirementKey !== "string"
      || raw.runtimeId.length < 1 || raw.runtimeId.length > 512
      || !ISSUANCE_KEY_PATTERN.test(raw.issuanceKey)
      || !RETIREMENT_KEY_PATTERN.test(raw.retirementKey)) {
      throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
    }
    return Object.freeze({
      botId: normalizeBotId(raw.botId),
      runtimeId: raw.runtimeId,
      issuanceKey: raw.issuanceKey,
      retirementKey: raw.retirementKey,
    });
  });
  const rawBotIds = descriptors.botIds?.value;
  const normalizeRetirementBotIds = (raw, allowEmpty = false) => {
    if (allowEmpty && Array.isArray(raw) && raw.length === 0) return [];
    return normalizeDeleteBotIds(raw);
  };
  const botIds = rawBotIds === undefined
    ? entries.map((entry) => entry.botId)
    : normalizeRetirementBotIds(rawBotIds);
  const rawSurvivors = descriptors.survivingBotIds?.value;
  const survivingBotIds = rawSurvivors === undefined
    ? []
    : normalizeRetirementBotIds(rawSurvivors, true);
  const deleted = new Set(botIds);
  if (new Set(entries.map((entry) => entry.runtimeId)).size !== entries.length
    || new Set(botIds).size !== botIds.length
    || new Set(survivingBotIds).size !== survivingBotIds.length
    || entries.some((entry) => !deleted.has(entry.botId))
    || survivingBotIds.some((botId) => deleted.has(botId))) {
    throw new ControllerError("Remote runtime retirement request is invalid.", "RUNTIME_RETIREMENT_INVALID");
  }
  return Object.freeze({
    deletionId: typeof descriptors.deletionId?.value === "string" ? descriptors.deletionId.value : null,
    botIds: Object.freeze(botIds),
    survivingBotIds: Object.freeze(survivingBotIds),
    remoteRuntimes: Object.freeze(entries),
  });
}



function retirementWorkKey(request) {
  const botIds = [...request.botIds].sort().join("\0");
  const runtimes = request.remoteRuntimes
    .map((entry) => `${entry.botId}\0${entry.runtimeId}\0${entry.issuanceKey}\0${entry.retirementKey}`)
    .sort()
    .join("\0");
  const successors = request.survivingBotIds ? [...request.survivingBotIds].sort().join("\0") : "";
  return `${request.deletionId || ""}\0${botIds}\0${successors}\0${runtimes}`;
}

function deletingBotError() {
  return new ControllerError(
    "Remote runtime bot is being deleted.",
    "RUNTIME_BOT_DELETING",
  );
}

class BotRuntimeController extends EventEmitter {
  #store;
  #provider;
  #providerContractVersion;
  #now;
  #sessions = new Map();
  #candidates = new Map();
  #provisions = new Map();
  #v2OperationIssuances = new Map();
  #botQueues = new Map();
  #generations = new Map();
  #runtimeOwners = new Map();
  #runtimeFingerprints = new Map();
  #runtimeEpochs = new Map();
  #candidateOwners = new Map();
  #candidateFingerprints = new Map();
  #retirementOperations = new Map();
  #retirementRuntimeClaims = new Map();
  #supersededBots = new Set();
  #deletingBots = new Map();
  #unsubscribe = null;
  #disposed = false;
  #lifecycleEpoch = 0;
  #disposeSignal;
  #resolveDisposeSignal;

  constructor({ store, provider, now = () => new Date().toISOString() } = {}) {
    super();
    if (!store
      || typeof store.create !== "function"
      || typeof store.advanceSetup !== "function"
      || typeof store.updateRuntime !== "function"
      || typeof store.deleteBots !== "function"
      || typeof store.runtimeTransaction !== "function"
      || typeof store.isCurrentRuntimeCommit !== "function"
      || typeof store.readRuntimeIssuances !== "function"
      || typeof store.beginRuntimeIssuance !== "function"
      || typeof store.issueRuntimeIssuance !== "function"
      || typeof store.promoteRuntimeIssuance !== "function"
      || typeof store.confirmRuntimeIssuance !== "function"
      || typeof store.completeRuntimeIssuance !== "function"
      || typeof store.revertRuntimePromotion !== "function"
      || typeof store.abortRuntimeIssuance !== "function") {
      throw new TypeError("Bot runtime controller requires a BotStore.");
    }
    if (!provider || typeof provider.subscribe !== "function") {
      throw new TypeError("Bot runtime controller requires a remote runtime provider.");
    }
    if (typeof now !== "function") throw new TypeError("Bot runtime controller now must be a function.");
    if (providerContractVersion(provider) === null) {
      try {
        provider = validateProvider(provider);
      } catch {
        throw new TypeError("Bot runtime controller requires a validated remote runtime provider.");
      }
    }
    this.#store = store;
    this.#provider = provider;
    this.#providerContractVersion = providerContractVersion(provider);
    this.#now = now;
    this.#disposeSignal = new Promise((resolve) => {
      this.#resolveDisposeSignal = resolve;
    });
    this.#unsubscribe = provider.subscribe((event) => this.#receiveProviderEvent(event));
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;

    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Main-process observers, including EventEmitter meta observers, cannot
        // change controller or persistence outcomes.
      }
    }
    return true;
  }

  async createBot(input, options = undefined) {
    let validOptions = options === undefined;
    if (!validOptions) {
      try {
        validOptions = Boolean(options && typeof options === "object" && !Array.isArray(options)
          && Object.getPrototypeOf(options) === Object.prototype
          && Object.keys(options).length === 1
          && typeof options.commitFence === "function");
      } catch { validOptions = false; }
    }
    if (!validOptions) {
      throw new ControllerError("Bot create commit options are invalid.", "RUNTIME_CREATE_OPTIONS_INVALID");
    }
    const created = await this.#store.create(input, options);
    this.#publishBot(created);
    try {
      return publicBot(await this.ensureRuntime(created.botId));
    } catch (error) {
      if (error?.code === "RUNTIME_CONTROLLER_DISPOSED") throw error;
      return publicBot(await this.#store.read(created.botId));
    }
  }

  async listBots() {
    return (await this.#store.list()).map(publicBot);
  }

  async readBot(botId) {
    const normalizedBotId = this.#assertBotNotDeleting(botId);
    const bot = await this.#store.read(normalizedBotId);
    this.#assertBotNotDeleting(normalizedBotId);
    return publicBot(bot);
  }

  deleteBots(botIds, options = undefined) {
    let request;
    let transactionEpoch;
    try {
      request = {
        botIds: normalizeDeleteBotIds(botIds),
        ...normalizeDeleteOptions(options),
      };
      transactionEpoch = this.#lifecycleEpoch;
      this.#assertActive(transactionEpoch);
      if (request.botIds.some((botId) => this.#deletingBots.has(botId))) {
        throw deletingBotError();
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const deletionToken = Object.freeze({ botIds: Object.freeze([...request.botIds]) });
    for (const botId of request.botIds) this.#deletingBots.set(botId, deletionToken);
    const olderOperations = new Set();
    for (const botId of request.botIds) {
      const queue = this.#botQueues.get(botId);
      const provision = this.#provisions.get(botId);
      if (queue) olderOperations.add(queue);
      if (provision) olderOperations.add(provision);
    }

    return this.#deleteBotsTransaction(
      request,
      deletionToken,
      [...olderOperations],
      transactionEpoch,
    ).finally(() => {
      for (const botId of request.botIds) {
        if (this.#deletingBots.get(botId) === deletionToken) this.#deletingBots.delete(botId);
      }
    });
  }

  async renameBot(botId, name) {
    const normalizedBotId = this.#assertBotNotDeleting(botId);
    const bot = await this.#store.rename(normalizedBotId, name);
    this.#assertBotNotDeleting(normalizedBotId);
    this.#publishBot(bot);
    return publicBot(bot);
  }

  async updateProfile(botId, profile) {
    const normalizedBotId = this.#assertBotNotDeleting(botId);
    const bot = await this.#store.updateProfile(normalizedBotId, profile);
    this.#assertBotNotDeleting(normalizedBotId);
    this.#publishBot(bot);
    return publicBot(bot);
  }

  async advanceSetup(botId, transition, commitFence = undefined) {
    const normalizedBotId = this.#assertBotNotDeleting(botId);
    let expectedNextStage = null;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(transition, "nextStage");
      if (descriptor && "value" in descriptor
        && new Set(["computer", "complete"]).has(descriptor.value)) {
        expectedNextStage = descriptor.value;
      }
    } catch {}
    let bot;
    try {
      bot = await this.#store.advanceSetup(normalizedBotId, transition, commitFence);
    } catch (error) {
      if (!isCommittedDurabilityUncertain(error) || expectedNextStage === null) throw error;
      bot = await this.#store.read(normalizedBotId);
      if (!bot || bot.setupStage !== expectedNextStage) throw error;
    }
    this.#assertBotNotDeleting(normalizedBotId);
    this.#publishBot(bot);
    return publicBot(bot);
  }

  ensureRuntime(botId) {
    return this.#runtimeOperation(botId, false).then(publicBot);
  }

  retryRuntime(botId) {
    return this.#runtimeOperation(botId, true).then(publicBot);
  }

  retireDeletedRuntimes(value) {
    let request;
    let transactionEpoch;
    try {
      request = normalizeRetirementRequest(value);
      transactionEpoch = this.#lifecycleEpoch;
      this.#assertActive(transactionEpoch);
      if (this.#providerContractVersion !== 2) {
        throw new ControllerError("Remote issuance retirement is unavailable.", "RUNTIME_RETIREMENT_UNAVAILABLE");
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const workKey = retirementWorkKey(request);
    const existing = this.#retirementOperations.get(workKey);
    if (existing) return existing;
    for (const entry of request.remoteRuntimes) {
      const claim = this.#retirementRuntimeClaims.get(entry.runtimeId);
      if (claim && claim !== workKey) {
        return Promise.reject(new ControllerError(
          "Remote runtime retirement is already in progress.",
          "RUNTIME_RETIREMENT_CONFLICT",
        ));
      }
    }
    for (const entry of request.remoteRuntimes) {
      this.#retirementRuntimeClaims.set(entry.runtimeId, workKey);
    }
    const operation = this.#retireDeletedRuntimesTransaction(request, transactionEpoch)
      .finally(() => {
        if (this.#retirementOperations.get(workKey) === operation) {
          this.#retirementOperations.delete(workKey);
        }
        for (const entry of request.remoteRuntimes) {
          if (this.#retirementRuntimeClaims.get(entry.runtimeId) === workKey) {
            this.#retirementRuntimeClaims.delete(entry.runtimeId);
          }
        }
      });
    this.#retirementOperations.set(workKey, operation);
    return operation;
  }

  async runtimeSession(botId) {
    if (this.#disposed) return null;
    const normalizedBotId = this.#assertBotNotDeleting(botId);
    const transactionEpoch = this.#lifecycleEpoch;
    const bot = await this.#store.read(normalizedBotId);
    this.#assertActive(transactionEpoch);
    this.#assertBotNotDeleting(normalizedBotId);
    if (!bot || this.#supersededBots.has(bot.botId) || bot.runtime.state !== "ready") return null;
    const captured = this.#sessions.get(bot.botId);
    if (!captured) {
      return this.#enqueueBot(bot.botId, async () => {
        this.#assertActive(transactionEpoch);
        const current = await this.#store.read(bot.botId);
        this.#assertActive(transactionEpoch);
        if (current?.runtime.state === "ready" && !this.#sessions.has(bot.botId)) {
          await this.#persistRuntime(bot.botId, {
            state: "reconnecting",
            lastErrorCode: "RUNTIME_SESSION_MISSING",
          }, transactionEpoch);
        }
        this.#assertActive(transactionEpoch);
        return null;
      });
    }
    let inspected;
    let inspectionFailure = null;
    try {
      inspected = await this.#inspectActiveSession(captured, bot.botId, transactionEpoch);
    } catch (error) {
      this.#assertActive(transactionEpoch);
      inspectionFailure = safeFailure(error, "RUNTIME_INSPECTION_FAILED");
    }

    return this.#enqueueBot(bot.botId, async () => {
      this.#assertActive(transactionEpoch);
      const current = await this.#store.read(bot.botId);
      this.#assertActive(transactionEpoch);
      const currentSession = this.#sessions.get(bot.botId);
      if (!current
        || current.runtime.state !== "ready"
        || currentSession !== captured
        || currentSession.runtimeId !== current.runtime.remoteRuntimeId
        || currentSession.provider !== current.runtime.provider
        || currentSession.generation !== captured.generation
        || this.#runtimeOwners.get(currentSession.runtimeId) !== bot.botId
        || this.#runtimeEpochs.get(currentSession.runtimeId) !== captured.generation) {
        return null;
      }
      if (inspectionFailure) {
        this.#sessions.delete(bot.botId);
        const failurePatch = {
          state: inspectionFailure.code === "REMOTE_PROVIDER_UNAVAILABLE" ? "unavailable" : "reconnecting",
          lastErrorCode: inspectionFailure.code,
        };
        if (this.#providerContractVersion === 2 && sessionIssuance(captured)?.issuanceKey) {
          try {
            await this.#persistV2Failure(
              bot.botId,
              failurePatch,
              sessionIssuance(captured).issuanceKey,
              transactionEpoch,
            );
          } catch {
            // A successor issuance already owns the exact Store identity.
          }
        } else {
          await this.#persistRuntime(bot.botId, failurePatch, transactionEpoch);
        }
        return null;
      }
      const identity = sessionIssuance(currentSession);
      const issuanceMismatch = this.#providerContractVersion === 2
        && (!inspected?.matched
          || inspected.ownerBotId !== bot.botId
          || inspected.issuanceKey !== identity?.issuanceKey);
      if (issuanceMismatch || inspected.ownerBotId !== bot.botId) {
        this.#sessions.delete(bot.botId);
        const mismatchPatch = {
          state: "failed",
          lastErrorCode: issuanceMismatch ? "RUNTIME_ISSUANCE_MISMATCH" : "RUNTIME_OWNER_MISMATCH",
        };
        if (this.#providerContractVersion === 2 && identity?.issuanceKey) {
          try {
            await this.#persistV2Failure(bot.botId, mismatchPatch, identity.issuanceKey, transactionEpoch);
          } catch {
            // Do not overwrite a successor's exact active issuance.
          }
        } else {
          await this.#persistRuntime(bot.botId, mismatchPatch, transactionEpoch);
        }
        return null;
      }
      if (inspected.runtimeId !== captured.runtimeId || inspected.state !== "ready") {
        this.#sessions.delete(bot.botId);
        const state = persistedState(inspected.state);
        const statePatch = {
          state,
          lastErrorCode: stateErrorCode(state),
        };
        if (this.#providerContractVersion === 2 && identity?.issuanceKey) {
          try {
            await this.#persistV2Failure(bot.botId, statePatch, identity.issuanceKey, transactionEpoch);
          } catch {
            // Do not overwrite a successor's exact active issuance.
          }
        } else {
          await this.#persistRuntime(bot.botId, statePatch, transactionEpoch);
        }
        return null;
      }
      if (this.#providerContractVersion === 2) {
        let exactCurrent = false;
        const fenced = await this.#store.runtimeTransaction(
          bot.botId,
          { expectedActiveIssuanceKey: identity.issuanceKey },
          ({ bot: fencedBot }) => {
            exactCurrent = Boolean(
              fencedBot.runtime.provider === captured.provider
              && fencedBot.runtime.remoteRuntimeId === captured.runtimeId
              && fencedBot.runtime.state === "ready"
              && this.#sessions.get(bot.botId) === captured
              && this.#runtimeOwners.get(captured.runtimeId) === bot.botId
              && this.#runtimeEpochs.get(captured.runtimeId) === captured.generation,
            );
          },
        );
        if (!fenced.matched || !exactCurrent) return null;
      }
      return currentSession;
    });
  }

  async reconcile() {
    const transactionEpoch = this.#lifecycleEpoch;
    this.#assertActive(transactionEpoch);
    const bots = await this.#store.list();
    this.#assertActive(transactionEpoch);
    for (const bot of bots) {
      if (TERMINAL_RUNTIME_STATES.has(bot.runtime.state)) {
        const activeIssuance = this.#providerContractVersion === 2
          ? (await this.#store.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active")
          : null;
        if (activeIssuance) {
          try {
            const inspected = await this.#provider.inspectIssuance({
              runtimeId: activeIssuance.runtimeId,
              ownerBotId: bot.botId,
              issuanceKey: activeIssuance.issuanceKey,
            });
            if (inspected.matched && TERMINAL_RUNTIME_STATES.has(inspected.state)) {
              await this.#store.completeRuntimeIssuance(bot.botId, {
                issuanceKey: activeIssuance.issuanceKey,
                provider: activeIssuance.provider,
                runtimeId: activeIssuance.runtimeId,
                state: bot.runtime.state,
                lastErrorCode: bot.runtime.lastErrorCode,
              });
              continue;
            }
          } catch {
            // Leave the exact active issuance durable until authoritative terminal
            // inspection succeeds.
          }
        }
        if (!activeIssuance && (bot.runtime.remoteRuntimeId || bot.runtime.provider)) {
          await this.#persistRuntime(bot.botId, {
            provider: null,
            remoteRuntimeId: null,
            lastConfirmedAt: null,
          }, transactionEpoch);
        }
      }
    }
    await Promise.all(bots.map(async (bot) => {
      if (TERMINAL_RUNTIME_STATES.has(bot.runtime.state)) return;
      try {
        await this.ensureRuntime(bot.botId);
      } catch {
        // The operation has already persisted a sanitized fail-closed state.
      }
    }));
    this.#assertActive(transactionEpoch);
    const reconciled = await this.#store.list();
    this.#assertActive(transactionEpoch);
    return reconciled.map(publicBot);
  }

  dispose() {
    if (this.#disposed) return;
    this.#lifecycleEpoch += 1;
    this.#disposed = true;
    this.#resolveDisposeSignal();
    this.#resolveDisposeSignal = null;
    this.#sessions.clear();
    this.#candidates.clear();
    this.#provisions.clear();
    this.#v2OperationIssuances.clear();
    this.#botQueues.clear();
    this.#generations.clear();
    this.#runtimeOwners.clear();
    this.#runtimeFingerprints.clear();
    this.#runtimeEpochs.clear();
    this.#candidateOwners.clear();
    this.#candidateFingerprints.clear();
    this.#retirementOperations.clear();
    this.#retirementRuntimeClaims.clear();
    this.#supersededBots.clear();
    this.#deletingBots.clear();
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (typeof unsubscribe === "function") {
      try {
        unsubscribe();
      } catch {
        // Disposal is fail-closed and never republishes provider diagnostics.
      }
    }
  }

  async #deleteBotsTransaction(request, deletionToken, olderOperations, transactionEpoch) {
    await Promise.allSettled(olderOperations);
    this.#assertActive(transactionEpoch);
    if (request.botIds.some((botId) => this.#deletingBots.get(botId) !== deletionToken)) {
      throw deletingBotError();
    }
    const extraRemoteRuntimes = this.#candidateCleanupIds(request.botIds);
    const outcome = await this.#store.deleteBots([...request.botIds], {
      preferredActiveBotId: request.preferredActiveBotId,
      extraRemoteRuntimes,
    });
    this.#assertActive(transactionEpoch);
    if (request.botIds.some((botId) => this.#deletingBots.get(botId) !== deletionToken)) {
      throw deletingBotError();
    }
    const survivingBotIds = Array.isArray(outcome?.survivingBotIds)
      ? outcome.survivingBotIds.map(normalizeBotId)
      : [];
    const activeBotId = outcome?.activeBotId === null
      ? null
      : normalizeBotId(outcome?.activeBotId);
    if (activeBotId !== null && !survivingBotIds.includes(activeBotId)) {
      throw new ControllerError("Bot deletion result is invalid.", "RUNTIME_DELETE_FAILED");
    }
    for (const botId of request.botIds) this.#clearBotPrivateState(botId);
    const result = deepFreeze({
      deletedBotIds: [...request.botIds],
      survivingBotIds,
      activeBotId,
    });
    if (!this.#disposed && transactionEpoch === this.#lifecycleEpoch) {
      this.emit("bots-deleted", deepFreeze({
        botIds: [...request.botIds],
        activeBotId,
      }));
    }
    return result;
  }

  async #retireDeletedRuntimesTransaction(request, transactionEpoch) {
    const retiredRuntimeIds = [];
    for (const entry of request.remoteRuntimes) {
      await this.#retireDeletedRuntime(request, entry, transactionEpoch);
      retiredRuntimeIds.push(entry.runtimeId);
    }
    this.#assertActive(transactionEpoch);
    return deepFreeze({ retiredRuntimeIds });
  }

  async #retireDeletedRuntime(request, entry, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    await this.#assertRetirementVisibility(request, entry, transactionEpoch);
    const issuance = {
      botId: entry.botId,
      runtimeId: entry.runtimeId,
      issuanceKey: entry.issuanceKey,
      retirementKey: entry.retirementKey,
    };
    if (!await this.#retireIssuanceExact(issuance, transactionEpoch)) {
      throw new ControllerError("Remote runtime retirement remains pending.", "RUNTIME_RETIRE_PENDING");
    }
    await this.#assertRetirementVisibility(request, entry, transactionEpoch);
  }

  async #assertRetirementVisibility(request, entry, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    let bots;
    try {
      bots = await this.#store.list();
      this.#assertActive(transactionEpoch);
    } catch {
      this.#assertActive(transactionEpoch);
      throw new ControllerError(
        "Remote runtime deletion visibility is unavailable.",
        "RUNTIME_RETIREMENT_VISIBILITY_FAILED",
      );
    }
    try {
      if (!Array.isArray(bots)) throw new Error("Bot list is invalid.");
      const deletedBotIds = new Set(request.botIds);
      if (bots.some((bot) => deletedBotIds.has(bot?.botId))) {
        throw new ControllerError("Deleted bot is still visible.", "RUNTIME_RETIREMENT_BOT_VISIBLE");
      }
      if (request.survivingBotIds.some((botId) => !bots.some((bot) => bot?.botId === botId))) {
        throw new ControllerError(
          "Remote runtime deletion successor is unavailable.",
          "RUNTIME_RETIREMENT_SUCCESSOR_MISMATCH",
        );
      }
      if (bots.some((bot) => bot?.runtime?.remoteRuntimeId === entry.runtimeId)) {
        throw new ControllerError(
          "Remote runtime is owned by a visible successor.",
          "RUNTIME_RETIREMENT_SUCCESSOR_MISMATCH",
        );
      }
    } catch (error) {
      if (error instanceof ControllerError) throw error;
      throw new ControllerError(
        "Remote runtime deletion visibility is unavailable.",
        "RUNTIME_RETIREMENT_VISIBILITY_FAILED",
      );
    }
  }

  #candidateCleanupIds(botIds) {
    const cleanup = [];
    for (const botId of botIds) {
      const candidate = this.#candidates.get(botId);
      if (!candidate) continue;
      const runtimeId = candidate.runtimeId;
      const fingerprint = this.#candidateFingerprints.get(runtimeId);
      if (this.#candidateOwners.get(runtimeId) !== botId
        || fingerprint?.botId !== botId
        || fingerprint.provider !== candidate.provider
        || fingerprint.endpoint !== candidate.endpoint) continue;
      const identity = sessionIssuance(candidate);
      if (!identity?.issuanceKey || !identity.retirementKey) continue;
      cleanup.push(Object.freeze({
        botId,
        runtimeId,
        issuanceKey: identity.issuanceKey,
        retirementKey: identity.retirementKey,
      }));
    }
    return Object.freeze(cleanup);
  }

  #clearBotPrivateState(botId) {
    this.#sessions.delete(botId);
    this.#candidates.delete(botId);
    this.#provisions.delete(botId);
    this.#botQueues.delete(botId);
    this.#generations.delete(botId);
    this.#supersededBots.delete(botId);
    for (const [runtimeId, ownerBotId] of this.#runtimeOwners) {
      if (ownerBotId !== botId) continue;
      this.#runtimeOwners.delete(runtimeId);
      this.#runtimeFingerprints.delete(runtimeId);
      this.#runtimeEpochs.delete(runtimeId);
    }
    for (const [runtimeId, ownerBotId] of this.#candidateOwners) {
      if (ownerBotId !== botId) continue;
      this.#candidateOwners.delete(runtimeId);
      this.#candidateFingerprints.delete(runtimeId);
    }
    for (const [runtimeId, fingerprint] of this.#runtimeFingerprints) {
      if (fingerprint?.botId !== botId) continue;
      this.#runtimeFingerprints.delete(runtimeId);
      this.#runtimeEpochs.delete(runtimeId);
    }
    for (const [runtimeId, fingerprint] of this.#candidateFingerprints) {
      if (fingerprint?.botId === botId) this.#candidateFingerprints.delete(runtimeId);
    }
  }

  #enqueueBot(botId, operation) {
    if (this.#deletingBots.has(botId)) return Promise.reject(deletingBotError());
    const previous = this.#botQueues.get(botId) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#botQueues.set(botId, tail);
    void tail.then(() => {
      if (this.#botQueues.get(botId) === tail) this.#botQueues.delete(botId);
    });
    return result;
  }

  async #acquireOperationLease(botId, state, leaseMarker, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    const outcome = await this.#store.runtimeTransaction(botId, {}, ({ updateRuntime }) => {
      updateRuntime({
        state,
        lastErrorCode: leaseMarker,
      });
    });
    this.#assertActive(transactionEpoch);
    this.#supersededBots.delete(botId);
    this.#publishRuntime(outcome.bot);
    return outcome.bot;
  }

  async #operationLeaseMatches(botId, leaseMarker) {
    if (!leaseMarker) return false;
    try {
      const outcome = await this.#store.runtimeTransaction(
        botId,
        { expectedLastErrorCode: leaseMarker },
        () => {},
      );
      return outcome.matched;
    } catch {
      return false;
    }
  }

  async #assertOperationLease(botId, leaseMarker, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    if (!await this.#operationLeaseMatches(botId, leaseMarker)) {
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    this.#assertActive(transactionEpoch);
  }

  async #persistLeasedRuntime(
    botId,
    patch,
    leaseMarker,
    transactionEpoch = this.#lifecycleEpoch,
  ) {
    this.#assertActive(transactionEpoch);
    const outcome = await this.#store.runtimeTransaction(
      botId,
      { expectedLastErrorCode: leaseMarker },
      ({ updateRuntime }) => updateRuntime(patch),
    );
    this.#assertActive(transactionEpoch);
    if (!outcome.matched) {
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    this.#publishRuntime(outcome.bot);
    return outcome.bot;
  }

  #assertActive(transactionEpoch) {
    if (this.#disposed || transactionEpoch !== this.#lifecycleEpoch) {
      throw new ControllerError(
        "Remote runtime controller is unavailable.",
        "RUNTIME_CONTROLLER_DISPOSED",
      );
    }
  }

  #assertBotNotDeleting(botId) {
    const normalizedBotId = normalizeBotId(botId);
    if (this.#deletingBots.has(normalizedBotId)) throw deletingBotError();
    return normalizedBotId;
  }

  async #runtimeOperation(botId, force) {
    const transactionEpoch = this.#lifecycleEpoch;
    this.#assertActive(transactionEpoch);
    const normalizedBotId = this.#assertBotNotDeleting(botId);
    const bot = await this.#store.read(normalizedBotId);
    this.#assertActive(transactionEpoch);
    this.#assertBotNotDeleting(normalizedBotId);
    if (!bot) throw new Error(`Bot not found: ${normalizedBotId}.`);
    const existing = this.#provisions.get(bot.botId);
    if (existing) return existing;
    const leaseMarker = operationMarker();
    const promise = this.#enqueueBot(bot.botId, async () => {
      this.#assertActive(transactionEpoch);
      return this.#provision(bot.botId, force, transactionEpoch, leaseMarker);
    }).finally(() => {
      if (this.#provisions.get(bot.botId) === promise) this.#provisions.delete(bot.botId);
    });
    this.#provisions.set(bot.botId, promise);
    return promise;
  }

  #newIssuanceIdentity(botId, active = null) {
    return {
      idempotencyKey: active ? `codex-bot:${botId}:${randomUUID()}` : `codex-bot:${botId}`,
      issuanceKey: `issuance-${randomUUID()}`,
      retirementKey: `retire-${randomUUID()}`,
    };
  }

  async #inspectIssuance(result, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    const inspected = await this.#provider.inspectIssuance({
      runtimeId: result.runtimeId,
      ownerBotId: result.ownerBotId,
      issuanceKey: result.issuanceKey,
    });
    this.#assertActive(transactionEpoch);
    return inspected;
  }

  async #inspectActiveSession(session, botId, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    const identity = sessionIssuance(session);
    if (this.#providerContractVersion === 2) {
      if (!identity?.issuanceKey) return { matched: false, state: "superseded" };
      const inspected = await this.#provider.inspectIssuance({
        runtimeId: session.runtimeId,
        ownerBotId: botId,
        issuanceKey: identity.issuanceKey,
      });
      this.#assertActive(transactionEpoch);
      return inspected;
    }
    const inspected = await this.#provider.inspect({ runtimeId: session.runtimeId });
    this.#assertActive(transactionEpoch);
    return {
      matched: inspected.ownerBotId === botId,
      runtimeId: inspected.runtimeId,
      ownerBotId: inspected.ownerBotId,
      state: inspected.state,
    };
  }

  async #retireIssuanceExact(issuance, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    const inspected = await this.#provider.inspectIssuance({
      runtimeId: issuance.runtimeId,
      ownerBotId: issuance.botId,
      issuanceKey: issuance.issuanceKey,
    });
    this.#assertActive(transactionEpoch);
    if (!inspected.matched || inspected.ownerBotId !== issuance.botId
      || inspected.issuanceKey !== issuance.issuanceKey) return false;
    if (!TERMINAL_RUNTIME_STATES.has(inspected.state)) {
      const retireInput = {
        runtimeId: issuance.runtimeId,
        ownerBotId: issuance.botId,
        issuanceKey: issuance.issuanceKey,
        retirementKey: issuance.retirementKey,
      };
      let retired;
      try {
        retired = await this.#provider.retireIssuance(retireInput);
      } catch (error) {
        try {
          retired = await this.#provider.retireIssuance(retireInput);
        } catch (retryError) {
          const terminalAfterRetry = await this.#provider.inspectIssuance({
            runtimeId: issuance.runtimeId,
            ownerBotId: issuance.botId,
            issuanceKey: issuance.issuanceKey,
          });
          this.#assertActive(transactionEpoch);
          if (terminalAfterRetry.matched
            && terminalAfterRetry.ownerBotId === issuance.botId
            && terminalAfterRetry.issuanceKey === issuance.issuanceKey
            && TERMINAL_RUNTIME_STATES.has(terminalAfterRetry.state)) return true;
          throw retryError;
        }
      }
      this.#assertActive(transactionEpoch);
      if (!retired.matched || retired.ownerBotId !== issuance.botId
        || retired.issuanceKey !== issuance.issuanceKey) return false;
    }
    for (let attempt = 0; attempt < RETIREMENT_READBACK_ATTEMPTS; attempt += 1) {
      const terminal = await this.#provider.inspectIssuance({
        runtimeId: issuance.runtimeId,
        ownerBotId: issuance.botId,
        issuanceKey: issuance.issuanceKey,
      });
      this.#assertActive(transactionEpoch);
      if (!terminal.matched || terminal.ownerBotId !== issuance.botId
        || terminal.issuanceKey !== issuance.issuanceKey) return false;
      if (TERMINAL_RUNTIME_STATES.has(terminal.state)) return true;
      if (attempt + 1 < RETIREMENT_READBACK_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, providerEventRetryDelay(attempt)));
        this.#assertActive(transactionEpoch);
      }
    }
    return false;
  }

  #installV2Session(botId, result, retirementKey) {
    const generation = (this.#generations.get(botId) || 0) + 1;
    const sessionResult = { ...result, retirementKey };
    Object.defineProperty(sessionResult, "authToken", {
      value: result.authToken,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    const session = privateSession(sessionResult, generation, null);
    this.#sessions.set(botId, session);
    this.#generations.set(botId, generation);
    this.#runtimeOwners.set(result.runtimeId, botId);
    this.#runtimeEpochs.set(result.runtimeId, generation);
    this.#runtimeFingerprints.set(result.runtimeId, {
      botId, provider: result.provider, endpoint: result.endpoint, issuanceKey: result.issuanceKey,
    });
    return session;
  }

  async #persistV2Failure(botId, patch, issuanceKey, transactionEpoch, options = undefined) {
    const protectReady = options?.protectReady === true;
    let updated = null;
    let authoritativeReady = false;
    const outcome = await this.#store.runtimeTransaction(
      botId,
      { expectedRuntimeIssuanceKey: issuanceKey },
      ({ bot: current, runtimeIssuances, updateRuntime }) => {
        const active = runtimeIssuances.find((entry) => (
          entry.botId === botId && entry.issuanceKey === issuanceKey && entry.phase === "active"
        ));
        if (protectReady
          && active
          && options?.operationIssuanceKey === issuanceKey
          && current.runtime.state === "ready"
          && current.runtime.provider === active.provider
          && current.runtime.remoteRuntimeId === active.runtimeId) {
          authoritativeReady = true;
          return;
        }
        updated = updateRuntime(patch);
      },
    );
    this.#assertActive(transactionEpoch);
    if (authoritativeReady) {
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    if (!outcome.matched || !updated) {
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    this.#publishRuntime(updated);
    return updated;
  }

  async #provisionV2(botId, force, transactionEpoch, leaseMarker) {
    const bot = await this.#store.read(botId);
    this.#assertActive(transactionEpoch);
    const initialIssuances = await this.#store.readRuntimeIssuances(botId);
    this.#assertActive(transactionEpoch);
    const initialActive = initialIssuances.find((entry) => entry.phase === "active") || null;
    const initialPending = initialIssuances.find((entry) => entry.phase === "pending" || entry.phase === "issued") || null;
    const initialIssuanceKey = (initialActive || initialPending)?.issuanceKey || null;
    this.#v2OperationIssuances.set(botId, {
      issuanceKey: initialIssuanceKey,
      previousActiveIssuanceKey: null,
    });
    let capabilities;
    try {
      capabilities = await this.#provider.capabilities();
      this.#assertActive(transactionEpoch);
    } catch {
      return this.#persistV2Failure(
        botId,
        { state: "unavailable", lastErrorCode: "REMOTE_PROVIDER_UNAVAILABLE" },
        initialIssuanceKey,
        transactionEpoch,
      );
    }
    if (unavailableCapabilities(capabilities) || capabilities.issuanceFencedRetire !== true) {
      return this.#persistV2Failure(
        botId,
        { state: "unavailable", lastErrorCode: "REMOTE_PROVIDER_UNAVAILABLE" },
        initialIssuanceKey,
        transactionEpoch,
      );
    }
    const issuances = await this.#store.readRuntimeIssuances(botId);
    this.#assertActive(transactionEpoch);
    const active = issuances.find((entry) => entry.phase === "active") || null;
    let pending = issuances.find((entry) => entry.phase === "pending" || entry.phase === "issued") || null;
    if (!active && !pending && bot.runtime.remoteRuntimeId) {
      return this.#persistRuntime(botId, {
        state: "unavailable",
        lastErrorCode: "RUNTIME_LEGACY_UNFENCED",
      }, transactionEpoch);
    }
    if (!force && active && bot.runtime.state === "ready" && this.#sessions.has(botId)) {
      const inspected = await this.#inspectIssuance({
        runtimeId: active.runtimeId,
        ownerBotId: botId,
        issuanceKey: active.issuanceKey,
      }, transactionEpoch);
      if (inspected.matched && inspected.state === "ready") return bot;
      this.#sessions.delete(botId);
    }
    if (!force && active && !pending) {
      const recovered = await this.#provider.provision({
        botId,
        idempotencyKey: active.idempotencyKey,
        issuanceKey: active.issuanceKey,
      });
      this.#assertActive(transactionEpoch);
      if (recovered.ownerBotId !== botId
        || recovered.issuanceKey !== active.issuanceKey
        || recovered.provider !== active.provider
        || recovered.runtimeId !== active.runtimeId) {
        throw new ControllerError("Remote runtime issuance mismatch.", "RUNTIME_ISSUANCE_MISMATCH");
      }
      const inspected = await this.#inspectIssuance(recovered, transactionEpoch);
      if (!inspected.matched || inspected.state !== "ready") {
        throw new ControllerError("Remote runtime is not ready.", "RUNTIME_NOT_READY");
      }
      const confirmed = await this.#store.confirmRuntimeIssuance(botId, {
        issuanceKey: active.issuanceKey,
        provider: active.provider,
        runtimeId: active.runtimeId,
        lastConfirmedAt: this.#now(),
      });
      this.#assertActive(transactionEpoch);
      if (!confirmed.matched) {
        throw new ControllerError("Remote runtime issuance was superseded.", "RUNTIME_OPERATION_SUPERSEDED");
      }
      this.#installV2Session(botId, recovered, active.retirementKey);
      this.#publishRuntime(confirmed.bot);
      return confirmed.bot;
    }
    if (!pending) {
      const begun = await this.#store.beginRuntimeIssuance(botId, this.#newIssuanceIdentity(botId, active));
      this.#assertActive(transactionEpoch);
      if (!begun.matched) throw new ControllerError("Remote runtime issuance was superseded.", "RUNTIME_OPERATION_SUPERSEDED");
      pending = begun.issuance;
      this.#v2OperationIssuances.set(botId, {
        issuanceKey: pending.issuanceKey,
        previousActiveIssuanceKey: initialActive?.issuanceKey || null,
      });
    }
    const result = await this.#provider.provision({
      botId,
      idempotencyKey: pending.idempotencyKey,
      issuanceKey: pending.issuanceKey,
    });
    this.#assertActive(transactionEpoch);
    if (result.ownerBotId !== botId || result.issuanceKey !== pending.issuanceKey) {
      throw new ControllerError("Remote runtime issuance mismatch.", "RUNTIME_ISSUANCE_MISMATCH");
    }
    if (pending.phase === "issued"
      && (result.provider !== pending.provider || result.runtimeId !== pending.runtimeId)) {
      throw new ControllerError("Remote runtime issuance mismatch.", "RUNTIME_ISSUANCE_MISMATCH");
    }
    if (pending.phase === "pending") {
      const issued = await this.#store.issueRuntimeIssuance(botId, {
        issuanceKey: pending.issuanceKey,
        provider: result.provider,
        runtimeId: result.runtimeId,
      });
      this.#assertActive(transactionEpoch);
      if (!issued.matched) throw new ControllerError("Remote runtime issuance was superseded.", "RUNTIME_OPERATION_SUPERSEDED");
      pending = issued.issuance;
    }
    const inspected = await this.#inspectIssuance(result, transactionEpoch);
    if (!inspected.matched || inspected.ownerBotId !== botId || inspected.issuanceKey !== pending.issuanceKey) {
      throw new ControllerError("Remote runtime issuance mismatch.", "RUNTIME_ISSUANCE_MISMATCH");
    }
    if (inspected.state !== "ready" || result.state !== "ready") {
      if (!this.#disposed && transactionEpoch === this.#lifecycleEpoch
        && await this.#retireIssuanceExact(pending, transactionEpoch)) {
        await this.#store.abortRuntimeIssuance(botId, { issuanceKey: pending.issuanceKey });
      }
      throw new ControllerError("Remote runtime was not ready.", "RUNTIME_NOT_READY");
    }
    if (active && active.runtimeId === result.runtimeId && active.issuanceKey !== pending.issuanceKey) {
      let previousInspection;
      try {
        previousInspection = await this.#provider.inspectIssuance({
          runtimeId: active.runtimeId,
          ownerBotId: botId,
          issuanceKey: active.issuanceKey,
        });
        this.#assertActive(transactionEpoch);
      } catch {
        throw new ControllerError("Previous remote runtime issuance could not be rechecked.", "RUNTIME_RETIRE_FAILED");
      }
      if (previousInspection.matched && !TERMINAL_RUNTIME_STATES.has(previousInspection.state)) {
        const freshIssuances = await this.#store.readRuntimeIssuances(botId);
        this.#assertActive(transactionEpoch);
        const freshPending = freshIssuances.find((entry) => (
          entry.phase === "issued" && entry.issuanceKey === pending.issuanceKey
        ));
        if (freshPending && await this.#retireIssuanceExact(freshPending, transactionEpoch)) {
          await this.#store.abortRuntimeIssuance(botId, { issuanceKey: pending.issuanceKey });
        }
        throw new ControllerError("Remote runtime issuance collision.", "RUNTIME_ISSUANCE_COLLISION");
      }
    }
    if (active && active.issuanceKey !== pending.issuanceKey
      && active.runtimeId !== result.runtimeId) {
      let oldRetirementError = null;
      let oldRetired = false;
      try {
        oldRetired = await this.#retireIssuanceExact(active, transactionEpoch);
      } catch (error) {
        oldRetirementError = error;
      }
      if (!oldRetired) {
        try {
          if (await this.#retireIssuanceExact(pending, transactionEpoch)) {
            await this.#store.abortRuntimeIssuance(botId, { issuanceKey: pending.issuanceKey });
          }
        } catch {
          // Keep the original rotation failure; the issued candidate remains durable if
          // its exact ownership cannot be proven for retirement.
        }
        if (oldRetirementError) throw oldRetirementError;
        throw new ControllerError("Previous remote runtime retirement failed.", "RUNTIME_RETIRE_FAILED");
      }
    }
    let promoted;
    try {
      promoted = await this.#store.promoteRuntimeIssuance(botId, {
        issuanceKey: pending.issuanceKey,
        provider: result.provider,
        runtimeId: result.runtimeId,
        state: "ready",
        lastConfirmedAt: this.#now(),
        expectedPreviousIssuanceKey: active?.issuanceKey || null,
      });
      this.#assertActive(transactionEpoch);
    } catch (error) {
      let durableSuccessor = false;
      if (isCommittedDurabilityUncertain(error)) {
        try {
          const durableBot = await this.#store.read(botId);
          const durableIssuances = await this.#store.readRuntimeIssuances(botId);
          const durableActive = durableIssuances.find((entry) => (
            entry.phase === "active"
            && entry.issuanceKey === pending.issuanceKey
            && entry.provider === result.provider
            && entry.runtimeId === result.runtimeId
          ));
          if (durableActive
            && durableBot?.runtime.provider === result.provider
            && durableBot.runtime.remoteRuntimeId === result.runtimeId
            && durableBot.runtime.state === "ready") {
            promoted = { matched: true, bot: durableBot };
          } else {
            durableSuccessor = durableIssuances.some((entry) => (
              entry.phase === "active" && entry.issuanceKey !== pending.issuanceKey
            ));
          }
        } catch {
          // Preserve the original uncertainty when authoritative readback fails.
        }
      }
      if (promoted?.matched && isCommittedDurabilityUncertain(error)) {
        // The exact active issuance and ready bot snapshot prove that the
        // promotion committed despite the lost response. Continue activation
        // with that durable result and never provision a replacement.
      } else {
      if (durableSuccessor) {
        throw new ControllerError(
          "Remote runtime issuance was superseded.",
          "RUNTIME_OPERATION_SUPERSEDED",
        );
      }
      if (error?.code === "RUNTIME_CONTROLLER_DISPOSED"
        || this.#disposed || transactionEpoch !== this.#lifecycleEpoch) {
        try {
          await this.#store.revertRuntimePromotion(botId, {
            issuanceKey: pending.issuanceKey,
            provider: result.provider,
            runtimeId: result.runtimeId,
          });
        } catch {
          // Keep the exact issued identity durable if reversion cannot be committed.
        }
      }
      if (await this.#retireIssuanceExact(pending, transactionEpoch)) {
        await this.#store.abortRuntimeIssuance(botId, { issuanceKey: pending.issuanceKey });
      }
      throw error;
      }
    }
    if (!promoted?.matched) {
      const durableBot = await this.#store.read(botId);
      const durableIssuances = await this.#store.readRuntimeIssuances(botId);
      const durableActive = durableIssuances.find((entry) => entry.phase === "active");
      if (durableActive?.issuanceKey === pending.issuanceKey
        && durableActive.provider === result.provider
        && durableActive.runtimeId === result.runtimeId
        && durableBot?.runtime.state === "ready"
        && durableBot.runtime.remoteRuntimeId === result.runtimeId) {
        promoted = { matched: true, bot: durableBot };
      } else if (!durableActive) {
        const durableIssued = durableIssuances.find((entry) => (
          entry.phase === "issued"
          && entry.issuanceKey === pending.issuanceKey
          && entry.provider === result.provider
          && entry.runtimeId === result.runtimeId
        ));
        if (durableIssued) {
          const rechecked = await this.#inspectIssuance({
            runtimeId: durableIssued.runtimeId,
            ownerBotId: botId,
            issuanceKey: durableIssued.issuanceKey,
          }, transactionEpoch);
          if (rechecked.matched && rechecked.state === "ready") {
            promoted = await this.#store.promoteRuntimeIssuance(botId, {
              issuanceKey: durableIssued.issuanceKey,
              provider: durableIssued.provider,
              runtimeId: durableIssued.runtimeId,
              state: "ready",
              lastConfirmedAt: this.#now(),
              expectedPreviousIssuanceKey: null,
            });
          }
        }
      }
      if (!promoted?.matched) {
        throw new ControllerError("Remote runtime issuance was superseded.", "RUNTIME_OPERATION_SUPERSEDED");
      }
    }
    const session = this.#installV2Session(botId, result, pending.retirementKey);
    this.#publishRuntime(promoted.bot);
    return promoted.bot;
  }

  async #provision(botId, force, transactionEpoch, leaseMarker) {
    let bot = null;
    let previous = null;
    let oldRuntimeId = null;
    let oldProvider = null;
    let result = null;
    let candidateClaimed = false;
    let candidateSafeToRetire = false;
    let runtimeMutationStarted = false;
    let operationLeaseAcquired = false;
    const rotationProgress = { oldRuntimeRetired: false };

    try {
      bot = await this.#store.read(botId);
      this.#assertActive(transactionEpoch);
      if (!bot) throw new Error(`Bot not found: ${botId}.`);

      if (this.#providerContractVersion !== 2) {
        this.#sessions.delete(bot.botId);
        return await this.#persistRuntime(bot.botId, {
          state: "unavailable",
          lastErrorCode: "REMOTE_PROVIDER_UNAVAILABLE",
        }, transactionEpoch);
      }
      return await this.#provisionV2(botId, force, transactionEpoch, leaseMarker);

      if (!force && bot.runtime.state === "ready" && this.#sessions.has(bot.botId)) {
        await this.#inspectActiveSessionWithinOperation(bot, transactionEpoch);
        this.#assertActive(transactionEpoch);
        const current = await this.#store.read(bot.botId);
        this.#assertActive(transactionEpoch);
        return current;
      }

      const capabilities = await this.#provider.capabilities();
      this.#assertActive(transactionEpoch);
      if (unavailableCapabilities(capabilities)) {
        this.#sessions.delete(bot.botId);
        const unavailable = await this.#persistRuntime(bot.botId, {
          state: "unavailable",
          lastErrorCode: "REMOTE_PROVIDER_UNAVAILABLE",
        }, transactionEpoch);
        this.#assertActive(transactionEpoch);
        return unavailable;
      }

      previous = await this.#store.read(bot.botId);
      this.#assertActive(transactionEpoch);
      oldRuntimeId = previous.runtime.remoteRuntimeId;
      oldProvider = previous.runtime.provider;
      if (force) this.#sessions.delete(bot.botId);
      runtimeMutationStarted = true;
      await this.#acquireOperationLease(
        bot.botId,
        oldRuntimeId ? "reconnecting" : "provisioning",
        leaseMarker,
        transactionEpoch,
      );
      operationLeaseAcquired = true;
      this.#assertActive(transactionEpoch);

      result = await this.#provider.provision({
        botId: bot.botId,
        idempotencyKey: `codex-bot:${bot.botId}`,
      });
      this.#assertActive(transactionEpoch);
      await this.#assertOperationLease(bot.botId, leaseMarker, transactionEpoch);
      if (result.ownerBotId !== bot.botId) {
        throw new ControllerError("Remote runtime owner mismatch.", "RUNTIME_OWNER_MISMATCH");
      }
      await this.#claimCandidate(bot.botId, result, transactionEpoch, leaseMarker);
      this.#assertActive(transactionEpoch);
      candidateClaimed = true;
      candidateSafeToRetire = result.runtimeId !== oldRuntimeId;
      if (oldProvider && result.provider !== oldProvider) {
        throw new ControllerError("Remote runtime provider/session mismatch.", "RUNTIME_PROVIDER_MISMATCH");
      }

      const inspected = await this.#provider.inspect({ runtimeId: result.runtimeId });
      this.#assertActive(transactionEpoch);
      await this.#assertOperationLease(bot.botId, leaseMarker, transactionEpoch);
      if (inspected.runtimeId !== result.runtimeId || inspected.ownerBotId !== bot.botId) {
        this.#discardCandidate(bot.botId, result.runtimeId);
        candidateClaimed = false;
        candidateSafeToRetire = false;
        throw new ControllerError("Remote runtime owner mismatch.", "RUNTIME_OWNER_MISMATCH");
      }
      if (inspected.state !== "ready" || result.state !== "ready") {
        const state = persistedState(inspected.state !== "ready" ? inspected.state : result.state);
        this.#sessions.delete(bot.botId);
        if (oldRuntimeId && oldRuntimeId !== result.runtimeId) {
          const retired = await this.#retireCandidate(bot.botId, result.runtimeId, transactionEpoch);
          this.#assertActive(transactionEpoch);
          candidateClaimed = false;
          candidateSafeToRetire = false;
          if (!retired) {
            throw new ControllerError("Remote runtime cleanup failed.", "RUNTIME_CANDIDATE_RETIRE_FAILED");
          }
          const pendingOld = await this.#persistLeasedRuntime(bot.botId, {
            provider: previous.runtime.provider,
            remoteRuntimeId: oldRuntimeId,
            state: "reconnecting",
            lastErrorCode: "RUNTIME_REPLACEMENT_NOT_READY",
          }, leaseMarker, transactionEpoch);
          this.#assertActive(transactionEpoch);
          return pendingOld;
        }
        const pending = await this.#persistLeasedRuntime(bot.botId, {
          provider: result.provider,
          remoteRuntimeId: result.runtimeId,
          state,
          lastConfirmedAt: null,
          lastErrorCode: leaseMarker,
        }, leaseMarker, transactionEpoch);
        this.#assertActive(transactionEpoch);
        return pending;
      }

      if (oldRuntimeId && oldRuntimeId !== result.runtimeId) {
        await this.#retireBeforeRotation(
          bot.botId,
          previous,
          result,
          transactionEpoch,
          rotationProgress,
          leaseMarker,
        );
        this.#assertActive(transactionEpoch);
      }
      const activated = await this.#activate(
        bot.botId,
        result,
        transactionEpoch,
        leaseMarker,
      );
      this.#assertActive(transactionEpoch);
      return activated;
    } catch (error) {
      let failure = this.#disposed || transactionEpoch !== this.#lifecycleEpoch
        ? new ControllerError(
          "Remote runtime controller is unavailable.",
          "RUNTIME_CONTROLLER_DISPOSED",
        )
        : safeFailure(error);
      if (failure.code === "RUNTIME_CONTROLLER_DISPOSED") {
        await this.#abortDisposedOperation({
          botId: bot?.botId || botId,
          previous,
          oldRuntimeId,
          result,
          candidateClaimed,
          candidateSafeToRetire,
          runtimeMutationStarted,
          operationLeaseAcquired,
          leaseMarker,
          oldRuntimeRetired: rotationProgress.oldRuntimeRetired,
        });
        throw failure;
      }
      if (failure.code === "RUNTIME_OPERATION_SUPERSEDED") {
        if (bot) this.#sessions.delete(bot.botId);
        throw failure;
      }
      if (bot) this.#sessions.delete(bot.botId);
      if (operationLeaseAcquired
        && !await this.#operationLeaseMatches(bot.botId, leaseMarker)) {
        this.#markBotSuperseded(bot.botId);
        this.#discardCandidate(bot.botId, result?.runtimeId);
        throw failure.code === "RUNTIME_OPERATION_SUPERSEDED"
          ? failure
          : new ControllerError(
            "Remote runtime operation was superseded.",
            "RUNTIME_OPERATION_SUPERSEDED",
          );
      }
      if (candidateClaimed
        && candidateSafeToRetire
        && ![
          "RUNTIME_RETIRE_FAILED",
          "RUNTIME_CANDIDATE_RETIRE_FAILED",
          "RUNTIME_OWNER_MISMATCH",
        ].includes(failure.code)) {
        const retired = await this.#retireCandidate(bot.botId, result.runtimeId, transactionEpoch);
        candidateClaimed = false;
        candidateSafeToRetire = false;
        if (!retired) {
          failure = new ControllerError("Remote runtime cleanup failed.", "RUNTIME_CANDIDATE_RETIRE_FAILED");
        }
      }
      if (bot) {
        if (this.#providerContractVersion === 2) {
          const currentIssuances = await this.#store.readRuntimeIssuances(bot.botId);
          const activeIssuance = currentIssuances.find((entry) => entry.phase === "active") || null;
          const operationFence = this.#v2OperationIssuances.get(bot.botId) || null;
          const operationIssuanceKey = typeof operationFence === "string"
            ? operationFence
            : operationFence?.issuanceKey || null;
          const previousActiveIssuanceKey = typeof operationFence === "string"
            ? null
            : operationFence?.previousActiveIssuanceKey || null;
          if (activeIssuance
            && (!operationIssuanceKey
              || (activeIssuance.issuanceKey !== operationIssuanceKey
                && activeIssuance.issuanceKey !== previousActiveIssuanceKey))) {
            throw new ControllerError(
              "Remote runtime operation was superseded.",
              "RUNTIME_OPERATION_SUPERSEDED",
            );
          }
          const failureIssuance = currentIssuances.find((entry) => (
            entry.issuanceKey === operationIssuanceKey
            || entry.issuanceKey === previousActiveIssuanceKey
          ))
            || null;
          const activeReadyForOperation = Boolean(
            activeIssuance
              && activeIssuance.issuanceKey === operationIssuanceKey
              && bot.runtime.state === "ready"
              && bot.runtime.provider === activeIssuance.provider
              && bot.runtime.remoteRuntimeId === activeIssuance.runtimeId,
          );
          if (activeReadyForOperation
            && !["RUNTIME_PROVISION_FAILED", "REMOTE_PROVIDER_UNAVAILABLE"].includes(failure.code)) {
            throw failure;
          }
          await this.#persistV2Failure(
            bot.botId,
            { state: failure.code === "REMOTE_PROVIDER_UNAVAILABLE" ? "unavailable" : "failed", lastErrorCode: failure.code },
            failureIssuance?.issuanceKey || null,
            transactionEpoch,
            { protectReady: true, operationIssuanceKey },
          );
        } else {
          await this.#persistFailure(
            bot.botId,
            failure,
            transactionEpoch,
            operationLeaseAcquired ? leaseMarker : null,
          );
        }
      }
      throw failure;
    }
  }

  async #abortDisposedOperation({
    botId,
    previous,
    oldRuntimeId,
    result,
    candidateClaimed,
    candidateSafeToRetire,
    runtimeMutationStarted,
    operationLeaseAcquired,
    leaseMarker,
    oldRuntimeRetired = false,
  }) {
    if (!runtimeMutationStarted || !operationLeaseAcquired || !leaseMarker) return;
    try {
      const outcome = await this.#store.runtimeTransaction(
        botId,
        { expectedLastErrorCode: leaseMarker },
        async ({ bots, updateRuntime }) => {
          if (result?.ownerBotId === botId && result.runtimeId !== oldRuntimeId) {
            let safelyOwned = candidateClaimed && candidateSafeToRetire;
            if (!safelyOwned) {
              safelyOwned = !bots.some((bot) => (
                bot.botId !== botId && bot.runtime.remoteRuntimeId === result.runtimeId
              ));
            }
            if (safelyOwned) {
              try {
                const inspected = await this.#provider.inspect({ runtimeId: result.runtimeId });
                const expectedProvider = !previous?.runtime.provider
                  || previous.runtime.provider === result.provider;
                void expectedProvider;
                void inspected;
              } catch {
                // Without current authoritative ownership and lease proof, disposal never retires.
              }
            }
            this.#discardCandidate(botId, result.runtimeId);
          }

          if (previous?.runtime.remoteRuntimeId) {
            if (oldRuntimeRetired) {
              updateRuntime({
                provider: null,
                remoteRuntimeId: null,
                state: "detached",
                lastConfirmedAt: null,
                lastErrorCode: "RUNTIME_CONTROLLER_DISPOSED",
              });
              return;
            }
            updateRuntime(copyRuntime(previous.runtime));
            return;
          }
          updateRuntime({
            provider: null,
            remoteRuntimeId: null,
            state: "failed",
            lastConfirmedAt: null,
            lastErrorCode: "RUNTIME_CONTROLLER_DISPOSED",
          });
        },
      );
      if (!outcome.matched) this.#discardCandidate(botId, result?.runtimeId);
    } catch {
      // A disposal rollback never republishes store/provider diagnostics.
    }
  }

  async #inspectActiveSessionWithinOperation(bot, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    const session = this.#sessions.get(bot.botId);
    if (!session) {
      await this.#persistRuntime(bot.botId, {
        state: "reconnecting",
        lastErrorCode: "RUNTIME_SESSION_MISSING",
      }, transactionEpoch);
      return null;
    }
    if (session.runtimeId !== bot.runtime.remoteRuntimeId
      || session.provider !== bot.runtime.provider
      || this.#runtimeOwners.get(session.runtimeId) !== bot.botId
      || this.#runtimeEpochs.get(session.runtimeId) !== session.generation) {
      this.#sessions.delete(bot.botId);
      await this.#persistRuntime(bot.botId, {
        state: "failed",
        lastErrorCode: "RUNTIME_SESSION_MISMATCH",
      }, transactionEpoch);
      return null;
    }
    let inspected;
    try {
      inspected = await this.#provider.inspect({ runtimeId: session.runtimeId });
      this.#assertActive(transactionEpoch);
    } catch (error) {
      this.#assertActive(transactionEpoch);
      this.#sessions.delete(bot.botId);
      const failure = safeFailure(error, "RUNTIME_INSPECTION_FAILED");
      await this.#persistRuntime(bot.botId, {
        state: failure.code === "REMOTE_PROVIDER_UNAVAILABLE" ? "unavailable" : "reconnecting",
        lastErrorCode: failure.code,
      }, transactionEpoch);
      return null;
    }
    this.#assertActive(transactionEpoch);
    if (this.#sessions.get(bot.botId) !== session) return null;
    if (inspected.ownerBotId !== bot.botId) {
      this.#sessions.delete(bot.botId);
      await this.#persistRuntime(bot.botId, {
        state: "failed",
        lastErrorCode: "RUNTIME_OWNER_MISMATCH",
      }, transactionEpoch);
      return null;
    }
    if (inspected.runtimeId !== session.runtimeId || inspected.state !== "ready") {
      this.#sessions.delete(bot.botId);
      const state = persistedState(inspected.state);
      await this.#persistRuntime(bot.botId, {
        state,
        lastErrorCode: stateErrorCode(state),
      }, transactionEpoch);
      return null;
    }
    return session;
  }

  async #claimCandidate(botId, result, transactionEpoch, leaseMarker) {
    this.#assertActive(transactionEpoch);
    const runtimeId = result.runtimeId;
    if (this.#retirementRuntimeClaims.has(runtimeId)) {
      throw new ControllerError(
        "Remote runtime retirement is already in progress.",
        "RUNTIME_RETIREMENT_CONFLICT",
      );
    }
    const inMemoryOwner = this.#runtimeOwners.get(runtimeId);
    if (inMemoryOwner && inMemoryOwner !== botId) {
      throw new ControllerError("Remote runtime already belongs to another bot.", "RUNTIME_ALREADY_OWNED");
    }
    const candidateOwner = this.#candidateOwners.get(runtimeId);
    if (candidateOwner && candidateOwner !== botId) {
      throw new ControllerError("Remote runtime already belongs to another bot.", "RUNTIME_ALREADY_OWNED");
    }
    const persistedBots = await this.#store.list();
    this.#assertActive(transactionEpoch);
    const persistedOwner = persistedBots.find((candidate) => (
      candidate.botId !== botId && candidate.runtime.remoteRuntimeId === runtimeId
    ));
    if (persistedOwner) {
      throw new ControllerError("Remote runtime already belongs to another bot.", "RUNTIME_ALREADY_OWNED");
    }
    if ((this.#runtimeOwners.get(runtimeId) && this.#runtimeOwners.get(runtimeId) !== botId)
      || (this.#candidateOwners.get(runtimeId) && this.#candidateOwners.get(runtimeId) !== botId)) {
      throw new ControllerError("Remote runtime already belongs to another bot.", "RUNTIME_ALREADY_OWNED");
    }
    const fingerprint = this.#runtimeFingerprints.get(runtimeId)
      || this.#candidateFingerprints.get(runtimeId);
    if (fingerprint && (fingerprint.botId !== botId
      || fingerprint.provider !== result.provider
      || fingerprint.endpoint !== result.endpoint)) {
      throw new ControllerError("Remote runtime endpoint/session mismatch.", "RUNTIME_ENDPOINT_MISMATCH");
    }
    const generation = Math.max(
      this.#generations.get(botId) || 0,
      this.#candidates.get(botId)?.generation || 0,
    ) + 1;
    this.#assertActive(transactionEpoch);
    this.#candidateOwners.set(runtimeId, botId);
    this.#candidateFingerprints.set(runtimeId, {
      botId,
      provider: result.provider,
      endpoint: result.endpoint,
    });
    this.#candidates.set(botId, privateSession(result, generation, leaseMarker));
  }

  #discardCandidate(botId, runtimeId) {
    const candidate = this.#candidates.get(botId);
    if (candidate?.runtimeId === runtimeId) this.#candidates.delete(botId);
    if (this.#candidateOwners.get(runtimeId) === botId) this.#candidateOwners.delete(runtimeId);
    if (this.#candidateFingerprints.get(runtimeId)?.botId === botId) {
      this.#candidateFingerprints.delete(runtimeId);
    }
  }

  async #retireCandidate(
    botId,
    runtimeId,
    transactionEpoch = this.#lifecycleEpoch,
  ) {
    this.#assertActive(transactionEpoch);
    const candidate = this.#candidates.get(botId);
    const fingerprint = this.#candidateFingerprints.get(runtimeId);
    if (!candidate || candidate.runtimeId !== runtimeId
      || this.#candidateOwners.get(runtimeId) !== botId
      || fingerprint?.botId !== botId
      || fingerprint.provider !== candidate.provider
      || fingerprint.endpoint !== candidate.endpoint
      || (this.#runtimeOwners.has(runtimeId) && this.#runtimeOwners.get(runtimeId) !== botId)) {
      return false;
    }
    let retirementFailed = false;
    const outcome = await this.#store.runtimeTransaction(
      botId,
      { expectedLastErrorCode: sessionLease(candidate) },
      async () => {
        let inspected = null;
        try {
          inspected = await this.#provider.inspect({ runtimeId });
          this.#assertActive(transactionEpoch);
        } catch (error) {
          this.#assertActive(transactionEpoch);
        }
        if (!inspected || inspected.runtimeId !== runtimeId || inspected.ownerBotId !== botId) {
          return;
        }
        retirementFailed = true;
      },
    );
    this.#assertActive(transactionEpoch);
    if (!outcome.matched) {
      this.#discardCandidate(botId, runtimeId);
      return false;
    }
    if (retirementFailed) {
      this.#candidates.delete(botId);
      return false;
    }
    this.#discardCandidate(botId, runtimeId);
    return true;
  }

  async #retireBeforeRotation(
    botId,
    previous,
    replacement,
    transactionEpoch,
    rotationProgress,
    leaseMarker,
  ) {
    this.#assertActive(transactionEpoch);
    const oldRuntimeId = previous.runtime.remoteRuntimeId;
    try {
      const outcome = await this.#store.runtimeTransaction(
        botId,
        { expectedLastErrorCode: leaseMarker },
        async ({ updateRuntime }) => {
          const inspected = await this.#provider.inspect({ runtimeId: oldRuntimeId });
          this.#assertActive(transactionEpoch);
          if (inspected.runtimeId !== oldRuntimeId || inspected.ownerBotId !== botId) {
            throw new ControllerError("Remote runtime owner mismatch.", "RUNTIME_OWNER_MISMATCH");
          }
          throw new ControllerError("Issuance-fenced retirement is required.", "RUNTIME_RETIRE_FAILED");
          rotationProgress.oldRuntimeRetired = true;
          this.#assertActive(transactionEpoch);
          updateRuntime({
            provider: previous.runtime.provider,
            remoteRuntimeId: oldRuntimeId,
            state: "detached",
            lastErrorCode: leaseMarker,
          });
        },
      );
      this.#assertActive(transactionEpoch);
      if (!outcome.matched) {
        throw new ControllerError(
          "Remote runtime operation was superseded.",
          "RUNTIME_OPERATION_SUPERSEDED",
        );
      }
      this.#publishRuntime(outcome.bot);
    } catch (error) {
      this.#assertActive(transactionEpoch);
      await this.#retireCandidate(botId, replacement.runtimeId, transactionEpoch);
      this.#sessions.delete(botId);
      const failure = error instanceof ControllerError
        ? error
        : new ControllerError("Remote runtime retirement failed.", "RUNTIME_RETIRE_FAILED");
      const ownerMismatch = failure.code === "RUNTIME_OWNER_MISMATCH";
      if (ownerMismatch) {
        this.#runtimeOwners.delete(oldRuntimeId);
        this.#runtimeFingerprints.delete(oldRuntimeId);
        this.#runtimeEpochs.delete(oldRuntimeId);
        this.#discardCandidate(botId, oldRuntimeId);
      }
      await this.#persistLeasedRuntime(botId, {
        provider: ownerMismatch ? null : previous.runtime.provider,
        remoteRuntimeId: ownerMismatch ? null : oldRuntimeId,
        ...(ownerMismatch ? { lastConfirmedAt: null } : {}),
        state: "failed",
        lastErrorCode: leaseMarker,
      }, leaseMarker, transactionEpoch);
      throw failure;
    }

    this.#discardCandidate(botId, oldRuntimeId);
    this.#runtimeOwners.delete(oldRuntimeId);
    this.#runtimeFingerprints.delete(oldRuntimeId);
    this.#runtimeEpochs.delete(oldRuntimeId);
  }

  async #activate(
    botId,
    result,
    transactionEpoch = this.#lifecycleEpoch,
    leaseMarker = null,
  ) {
    this.#assertActive(transactionEpoch);
    const candidate = this.#candidates.get(botId);
    const generation = candidate?.runtimeId === result.runtimeId
      ? candidate.generation
      : (this.#generations.get(botId) || 0) + 1;
    const session = candidate?.runtimeId === result.runtimeId
      ? candidate
      : privateSession(result, generation, leaseMarker);
    let stagedBot = null;
    let staged;
    try {
      staged = await this.#store.runtimeTransaction(
        botId,
        { expectedLastErrorCode: leaseMarker },
        ({ updateRuntime }) => {
          stagedBot = updateRuntime({
            provider: result.provider,
            remoteRuntimeId: result.runtimeId,
            state: "ready",
            lastConfirmedAt: this.#now(),
            lastErrorCode: leaseMarker,
          });
        },
      );
    } catch (error) {
      if (!isCommittedDurabilityUncertain(error)) throw error;
      this.#assertActive(transactionEpoch);
      if (!await this.#operationLeaseMatches(botId, leaseMarker)) {
        this.#markBotSuperseded(botId);
        throw new ControllerError(
          "Remote runtime operation was superseded.",
          "RUNTIME_OPERATION_SUPERSEDED",
        );
      }
      this.#assertActive(transactionEpoch);
      staged = { matched: true, bot: stagedBot };
    }
    this.#assertActive(transactionEpoch);
    if (!staged.matched) {
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    let committed;
    let privateActivation = null;
    let activatedBot = null;
    try {
      committed = await this.#store.runtimeTransaction(
        botId,
        { expectedLastErrorCode: leaseMarker },
        ({ updateRuntime }) => {
          privateActivation = this.#stagePrivateActivation({
            botId,
            result,
            transactionEpoch,
            leaseMarker,
            candidate,
            generation,
            session,
          });
          activatedBot = updateRuntime({ lastErrorCode: null });
        },
      );
    } catch (error) {
      if (!isCommittedDurabilityUncertain(error)) {
        this.#rollbackPrivateActivation(privateActivation, transactionEpoch);
        throw error;
      }
      const currentCommit = privateActivation
        && this.#store.isCurrentRuntimeCommit(error, botId);
      if (!currentCommit) {
        this.#rollbackPrivateActivation(privateActivation, transactionEpoch);
        this.#markBotSuperseded(botId);
        throw new ControllerError(
          "Remote runtime operation was superseded.",
          "RUNTIME_OPERATION_SUPERSEDED",
        );
      }
      return this.#finalizePrivateActivation(privateActivation, activatedBot, transactionEpoch);
    }
    try {
      this.#assertActive(transactionEpoch);
    } catch (error) {
      this.#rollbackPrivateActivation(privateActivation, transactionEpoch);
      throw error;
    }
    if (!committed.matched) {
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    if (!privateActivation
      || !this.#store.isCurrentRuntimeCommit(committed, botId)) {
      this.#rollbackPrivateActivation(privateActivation, transactionEpoch);
      this.#markBotSuperseded(botId);
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    return this.#finalizePrivateActivation(privateActivation, committed.bot, transactionEpoch);
  }

  #activationCandidateMatches(botId, result, candidate, session, leaseMarker) {
    const fingerprint = this.#candidateFingerprints.get(result.runtimeId);
    return Boolean(candidate
      && session === candidate
      && this.#candidates.get(botId) === candidate
      && this.#candidateOwners.get(result.runtimeId) === botId
      && fingerprint?.botId === botId
      && fingerprint.provider === result.provider
      && fingerprint.endpoint === result.endpoint
      && candidate.runtimeId === result.runtimeId
      && candidate.provider === result.provider
      && candidate.generation > 0
      && sessionLease(candidate) === leaseMarker);
  }

  #stagePrivateActivation({
    botId,
    result,
    transactionEpoch,
    leaseMarker,
    candidate,
    generation,
    session,
  }) {
    this.#assertActive(transactionEpoch);
    if (!this.#activationCandidateMatches(botId, result, candidate, session, leaseMarker)) {
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    const fingerprint = {
      botId,
      provider: result.provider,
      endpoint: result.endpoint,
    };
    const staged = {
      botId,
      runtimeId: result.runtimeId,
      candidate,
      session,
      generation,
      fingerprint,
      previous: {
        generation: mapEntry(this.#generations, botId),
        session: mapEntry(this.#sessions, botId),
        owner: mapEntry(this.#runtimeOwners, result.runtimeId),
        fingerprint: mapEntry(this.#runtimeFingerprints, result.runtimeId),
        epoch: mapEntry(this.#runtimeEpochs, result.runtimeId),
      },
    };
    this.#generations.set(botId, generation);
    this.#runtimeOwners.set(result.runtimeId, botId);
    this.#runtimeFingerprints.set(result.runtimeId, fingerprint);
    this.#runtimeEpochs.set(result.runtimeId, generation);
    this.#sessions.set(botId, session);
    return staged;
  }

  #privateActivationInstalled(staged) {
    return Boolean(staged
      && this.#sessions.get(staged.botId) === staged.session
      && this.#generations.get(staged.botId) === staged.generation
      && this.#runtimeOwners.get(staged.runtimeId) === staged.botId
      && this.#runtimeFingerprints.get(staged.runtimeId) === staged.fingerprint
      && this.#runtimeEpochs.get(staged.runtimeId) === staged.generation);
  }

  #markBotSuperseded(botId) {
    this.#supersededBots.add(botId);
    this.#sessions.delete(botId);
    const candidate = this.#candidates.get(botId);
    if (candidate) this.#discardCandidate(botId, candidate.runtimeId);
    for (const [runtimeId, ownerBotId] of this.#runtimeOwners) {
      if (ownerBotId !== botId) continue;
      this.#runtimeOwners.delete(runtimeId);
      this.#runtimeFingerprints.delete(runtimeId);
      this.#runtimeEpochs.delete(runtimeId);
    }
  }

  #rollbackPrivateActivation(staged, transactionEpoch) {
    if (!staged || this.#disposed || transactionEpoch !== this.#lifecycleEpoch) return;
    if (this.#sessions.get(staged.botId) === staged.session) {
      restoreMapEntry(this.#sessions, staged.botId, staged.previous.session);
    }
    if (this.#generations.get(staged.botId) === staged.generation) {
      restoreMapEntry(this.#generations, staged.botId, staged.previous.generation);
    }
    if (this.#runtimeOwners.get(staged.runtimeId) === staged.botId) {
      restoreMapEntry(this.#runtimeOwners, staged.runtimeId, staged.previous.owner);
    }
    if (this.#runtimeFingerprints.get(staged.runtimeId) === staged.fingerprint) {
      restoreMapEntry(this.#runtimeFingerprints, staged.runtimeId, staged.previous.fingerprint);
    }
    if (this.#runtimeEpochs.get(staged.runtimeId) === staged.generation) {
      restoreMapEntry(this.#runtimeEpochs, staged.runtimeId, staged.previous.epoch);
    }
  }

  #finalizePrivateActivation(staged, bot, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    if (!this.#privateActivationInstalled(staged)
      || this.#candidates.get(staged.botId) !== staged.candidate) {
      this.#rollbackPrivateActivation(staged, transactionEpoch);
      throw new ControllerError(
        "Remote runtime operation was superseded.",
        "RUNTIME_OPERATION_SUPERSEDED",
      );
    }
    this.#discardCandidate(staged.botId, staged.runtimeId);
    this.#publishRuntime(bot);
    return bot;
  }

  async #persistFailure(
    botId,
    failure,
    transactionEpoch = this.#lifecycleEpoch,
    leaseMarker = null,
  ) {
    this.#assertActive(transactionEpoch);
    const bot = await this.#store.read(botId);
    this.#assertActive(transactionEpoch);
    if (!bot) throw failure;
    const state = failure.code === "REMOTE_PROVIDER_UNAVAILABLE" ? "unavailable" : "failed";
    const patch = { state, lastErrorCode: failure.code };
    return leaseMarker
      ? this.#persistLeasedRuntime(botId, patch, leaseMarker, transactionEpoch)
      : this.#persistRuntime(botId, patch, transactionEpoch);
  }

  async #persistRuntime(botId, patch, transactionEpoch = this.#lifecycleEpoch) {
    this.#assertActive(transactionEpoch);
    const bot = await this.#store.updateRuntime(botId, patch);
    this.#assertActive(transactionEpoch);
    this.#publishRuntime(bot);
    return bot;
  }

  #publishBot(bot) {
    if (this.#disposed) return;
    this.emit("bot-changed", deepFreeze({ botId: bot.botId, bot: publicBot(bot) }));
  }

  #publishRuntime(bot) {
    if (this.#disposed) return;
    this.emit("runtime-changed", deepFreeze({
      botId: bot.botId,
      runtime: publicRuntime(bot.runtime),
      generation: this.#generations.get(bot.botId) || 0,
    }));
  }

  #publishRuntimeEvent(bot, event, generation) {
    if (this.#disposed) return;
    this.emit("runtime-event", deepFreeze({
      botId: bot.botId,
      runtime: publicRuntime(bot.runtime),
      generation,
      event: sanitizedRuntimeEvent(event),
    }));
  }

  async #terminateCandidateFromEvent(
    botId,
    candidate,
    state,
    lastErrorCode,
    transactionEpoch,
    ownershipInspection = undefined,
  ) {
    this.#assertActive(transactionEpoch);
    if (this.#candidates.get(botId) !== candidate
      || this.#candidateOwners.get(candidate.runtimeId) !== botId) return;
    let invalidIdentity = false;
    const outcome = await this.#store.runtimeTransaction(
      botId,
      { expectedLastErrorCode: sessionLease(candidate) },
      async ({ bot: current, updateRuntime }) => {
        if (!current
          || current.runtime.remoteRuntimeId !== candidate.runtimeId
          || current.runtime.provider !== candidate.provider) {
          invalidIdentity = true;
          return;
        }
        if (!TERMINAL_RUNTIME_STATES.has(state)) {
          const canInspectForRetirement = ownershipInspection === undefined
            || (ownershipInspection
              && ownershipInspection.runtimeId === candidate.runtimeId
              && ownershipInspection.ownerBotId === botId);
          let inspected = null;
          if (canInspectForRetirement) {
            try {
              inspected = await this.#provider.inspect({ runtimeId: candidate.runtimeId });
              this.#assertActive(transactionEpoch);
            } catch (error) {
              this.#assertActive(transactionEpoch);
              inspected = null;
            }
          }
          if (inspected
            && inspected.runtimeId === candidate.runtimeId
            && inspected.ownerBotId === botId) {
            // Legacy provider retirement is deliberately unavailable.
          }
        }
        updateRuntime({
          provider: null,
          remoteRuntimeId: null,
          state,
          lastConfirmedAt: null,
          lastErrorCode,
        });
      },
    );
    this.#assertActive(transactionEpoch);
    if (!outcome.matched || invalidIdentity) {
      this.#discardCandidate(botId, candidate.runtimeId);
      return;
    }
    this.#discardCandidate(botId, candidate.runtimeId);
    const currentGeneration = this.#generations.get(botId) || 0;
    if (currentGeneration <= candidate.generation) {
      this.#generations.set(botId, candidate.generation + 1);
    }
    this.#publishRuntime(outcome.bot);
  }

  async #handleCandidateProviderEvent(botId, event, candidate, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    if (this.#candidates.get(botId) !== candidate
      || candidate.runtimeId !== event.runtimeId
      || this.#candidateOwners.get(event.runtimeId) !== botId) return;
    if (event.state === undefined || !SAFE_EVENT_STATES.has(event.state)) return;

    if (event.state === "ready") {
      const previous = await this.#store.read(botId);
      this.#assertActive(transactionEpoch);
      if (!previous
        || previous.runtime.remoteRuntimeId !== event.runtimeId
        || previous.runtime.provider !== candidate.provider
        || previous.runtime.lastErrorCode !== sessionLease(candidate)
        || this.#candidates.get(botId) !== candidate
        || this.#candidateOwners.get(event.runtimeId) !== botId) return;
      let inspected;
      try {
        inspected = await this.#provider.inspect({ runtimeId: event.runtimeId });
        this.#assertActive(transactionEpoch);
      } catch (error) {
        this.#assertActive(transactionEpoch);
        const failure = safeFailure(error, "RUNTIME_INSPECTION_FAILED");
        await this.#terminateCandidateFromEvent(
          botId,
          candidate,
          failure.code === "REMOTE_PROVIDER_UNAVAILABLE" ? "unavailable" : "failed",
          failure.code,
          transactionEpoch,
          null,
        );
        return;
      }
      if (this.#candidates.get(botId) !== candidate
        || this.#candidateOwners.get(event.runtimeId) !== botId) return;
      await this.#assertOperationLease(botId, sessionLease(candidate), transactionEpoch);
      if (inspected.runtimeId !== event.runtimeId || inspected.ownerBotId !== botId) {
        await this.#terminateCandidateFromEvent(
          botId,
          candidate,
          "failed",
          "RUNTIME_OWNER_MISMATCH",
          transactionEpoch,
          inspected,
        );
        return;
      }
      if (inspected.state !== "ready") {
        const state = persistedState(inspected.state);
        if (state === "failed" || state === "unavailable" || TERMINAL_RUNTIME_STATES.has(state)) {
          await this.#terminateCandidateFromEvent(
            botId,
            candidate,
            state,
            stateErrorCode(state),
            transactionEpoch,
            inspected,
          );
        }
        return;
      }
      const result = {
        provider: candidate.provider,
        runtimeId: candidate.runtimeId,
        ownerBotId: botId,
        endpoint: candidate.endpoint,
        authToken: candidate.authToken,
        state: "ready",
      };
      try {
        await this.#activate(botId, result, transactionEpoch, sessionLease(candidate));
        this.#assertActive(transactionEpoch);
      } catch (error) {
        const failure = this.#disposed || transactionEpoch !== this.#lifecycleEpoch
          ? new ControllerError(
            "Remote runtime controller is unavailable.",
            "RUNTIME_CONTROLLER_DISPOSED",
          )
          : safeFailure(error);
        if (failure.code === "RUNTIME_CONTROLLER_DISPOSED") {
          await this.#abortDisposedOperation({
            botId,
            previous,
            oldRuntimeId: previous.runtime.remoteRuntimeId,
            result,
            candidateClaimed: true,
            candidateSafeToRetire: false,
            runtimeMutationStarted: true,
            operationLeaseAcquired: true,
            leaseMarker: sessionLease(candidate),
          });
        }
        throw failure;
      }
      return;
    }

    const state = persistedState(event.state);
    if (state === "failed" || state === "unavailable" || TERMINAL_RUNTIME_STATES.has(state)) {
      await this.#terminateCandidateFromEvent(
        botId,
        candidate,
        state,
        state === "unavailable"
          ? "REMOTE_PROVIDER_UNAVAILABLE"
          : (state === "failed" ? "RUNTIME_PROVIDER_EVENT" : null),
        transactionEpoch,
      );
      return;
    }
    await this.#persistLeasedRuntime(botId, {
      state,
      lastErrorCode: sessionLease(candidate),
    }, sessionLease(candidate), transactionEpoch);
  }

  #activeProviderReceiptCurrent(botId, runtimeId, runtimeEpoch, session = null) {
    return this.#runtimeOwners.get(runtimeId) === botId
      && this.#runtimeEpochs.get(runtimeId) === runtimeEpoch
      && (!session || this.#sessions.get(botId) === session);
  }

  #invalidateActiveProviderReceipt(botId, runtimeId, runtimeEpoch, session, superseded = false) {
    if (this.#sessions.get(botId) === session) this.#sessions.delete(botId);
    if (this.#runtimeOwners.get(runtimeId) === botId
      && this.#runtimeEpochs.get(runtimeId) === runtimeEpoch) {
      this.#runtimeOwners.delete(runtimeId);
      this.#runtimeFingerprints.delete(runtimeId);
      this.#runtimeEpochs.delete(runtimeId);
    }
    if (this.#candidates.get(botId) === session) this.#discardCandidate(botId, runtimeId);
    const currentGeneration = this.#generations.get(botId) || 0;
    if (currentGeneration <= runtimeEpoch) {
      this.#generations.set(botId, runtimeEpoch + 1);
    }
    if (superseded) this.#supersededBots.add(botId);
  }

  async #handleActiveTerminalProviderEvent(
    botId,
    event,
    runtimeEpoch,
    transactionEpoch,
    initialBot,
    session,
    state,
  ) {
    const terminalMarker = operationMarker();
    const finalizationMarker = operationMarker();
    const finalErrorCode = state === "unavailable"
      ? "REMOTE_PROVIDER_UNAVAILABLE"
      : (state === "failed" ? "RUNTIME_PROVIDER_EVENT" : null);
    const terminalIssuanceKey = this.#providerContractVersion === 2
      ? sessionIssuance(session)?.issuanceKey || null
      : null;
    const receiptCurrent = () => this.#activeProviderReceiptCurrent(
      botId,
      event.runtimeId,
      runtimeEpoch,
      session,
    );
    let operationCurrent = true;
    const invalidate = (superseded = false) => {
      this.#invalidateActiveProviderReceipt(
        botId,
        event.runtimeId,
        runtimeEpoch,
        session,
        superseded,
      );
      if (superseded) operationCurrent = false;
    };
    const stagedIdentityMatches = (bot) => Boolean(bot
      && bot.runtime.provider === initialBot.runtime.provider
      && bot.runtime.remoteRuntimeId === event.runtimeId
      && bot.runtime.state === state
      && bot.runtime.lastErrorCode === terminalMarker);
    const clearedIdentityMatches = (bot) => Boolean(bot
      && bot.runtime.provider === null
      && bot.runtime.remoteRuntimeId === null
      && bot.runtime.state === state
      && bot.runtime.lastErrorCode === finalizationMarker);
    if (this.#providerContractVersion === 2 && TERMINAL_RUNTIME_STATES.has(state)) {
      let currentInspection;
      try {
        currentInspection = await this.#inspectActiveSession(session, botId, transactionEpoch);
      } catch {
        invalidate(true);
        return;
      }
      const currentIdentity = sessionIssuance(session);
      if (!currentInspection?.matched
        || currentInspection.runtimeId !== event.runtimeId
        || currentInspection.ownerBotId !== botId
        || currentInspection.issuanceKey !== currentIdentity?.issuanceKey
        || !TERMINAL_RUNTIME_STATES.has(currentInspection.state)) {
        return;
      }
    }
    let stagedBot = null;
    let stagedCommit = null;
    try {
      const staged = await this.#retryProviderEventStoreOperation(async () => {
        stagedBot = null;
        return this.#store.runtimeTransaction(
          botId,
          this.#providerContractVersion === 2
            ? { expectedActiveIssuanceKey: terminalIssuanceKey }
            : {},
          ({ bot: current, updateRuntime }) => {
          if (!receiptCurrent()
            || current.runtime.provider !== initialBot.runtime.provider
            || current.runtime.remoteRuntimeId !== event.runtimeId
            || current.runtime.state !== initialBot.runtime.state
            || current.runtime.lastErrorCode !== initialBot.runtime.lastErrorCode) return;
          stagedBot = updateRuntime({
            state,
            lastErrorCode: terminalMarker,
          });
          },
        );
      }, receiptCurrent, transactionEpoch);
      if (!staged.current || !stagedBot) return;
      stagedCommit = staged.value;
      if (!this.#store.isCurrentRuntimeCommit(stagedCommit, botId)) {
        invalidate(true);
        return;
      }
    } catch (error) {
      if (!isCommittedDurabilityUncertain(error)
        || !this.#store.isCurrentRuntimeCommit(error, botId)) {
        invalidate(true);
        if (isCommittedDurabilityUncertain(error)) return;
        throw error;
      }
      // The commit receipt proves the terminal stage is authoritative. Drop
      // this exact private session before any further fallible fresh read.
      invalidate(false);
      let fresh;
      try {
        fresh = await this.#retryProviderEventStoreOperation(
          () => this.#store.read(botId),
          () => operationCurrent,
          transactionEpoch,
        );
      } catch (freshError) {
        invalidate(true);
        throw freshError;
      }
      if (!fresh.current || !stagedIdentityMatches(fresh.value)) {
        invalidate(true);
        return;
      }
      stagedBot = fresh.value;
      stagedCommit = error;
    }
    if (!stagedCommit || !stagedIdentityMatches(stagedBot)) {
      invalidate(true);
      return;
    }

    // Once the fail-closed terminal stage is authoritative, token-bearing state
    // from this exact receipt can no longer be used, even if another controller
    // later reuses the same provider runtime ID.
    invalidate(false);

    const expectedIdentity = session
      && session.runtimeId === event.runtimeId
      && session.provider === initialBot.runtime.provider
      && session.generation === runtimeEpoch;
    let ownershipInspection = null;
    try {
      ownershipInspection = this.#providerContractVersion === 2
        ? await this.#inspectActiveSession(session, botId, transactionEpoch)
        : await this.#provider.inspect({ runtimeId: event.runtimeId });
      this.#assertActive(transactionEpoch);
    } catch {
      invalidate(true);
      return;
    }
    const ownershipIdentity = sessionIssuance(session);
    if (ownershipInspection?.runtimeId !== event.runtimeId
      || ownershipInspection.ownerBotId !== botId
      || (this.#providerContractVersion === 2
        && (!ownershipInspection.matched
          || ownershipInspection.issuanceKey !== ownershipIdentity?.issuanceKey))) {
      invalidate(true);
      return;
    }
    if (this.#providerContractVersion === 2
      && TERMINAL_RUNTIME_STATES.has(state)
      && !TERMINAL_RUNTIME_STATES.has(ownershipInspection.state)) {
      // The provider changed back to a nonterminal state between the first
      // event inspection and this latest readback. Undo only our terminal
      // marker under the same exact issuance fence; never complete it.
      await this.#retryProviderEventStoreOperation(
        () => this.#store.runtimeTransaction(
          botId,
          {
            expectedLastErrorCode: terminalMarker,
            expectedActiveIssuanceKey: terminalIssuanceKey,
          },
          ({ bot: current, updateRuntime }) => {
            if (current.runtime.provider !== initialBot.runtime.provider
              || current.runtime.remoteRuntimeId !== event.runtimeId
              || current.runtime.state !== state) return;
            updateRuntime({
              state: initialBot.runtime.state,
              lastConfirmedAt: initialBot.runtime.lastConfirmedAt,
              lastErrorCode: initialBot.runtime.lastErrorCode,
            });
          },
        ),
        () => operationCurrent,
        transactionEpoch,
      );
      return;
    }
    let retirementAuthorized = false;
    let terminalRuntimeCleared = TERMINAL_RUNTIME_STATES.has(state);
    const retirementProof = await this.#retryProviderEventStoreOperation(async () => {
      retirementAuthorized = false;
      const outcome = await this.#store.runtimeTransaction(
        botId,
        {
          expectedLastErrorCode: terminalMarker,
          ...(this.#providerContractVersion === 2
            ? { expectedActiveIssuanceKey: terminalIssuanceKey }
            : {}),
        },
        async ({ bot: current }) => {
          retirementAuthorized = operationCurrent
            && current.runtime.provider === initialBot.runtime.provider
            && current.runtime.remoteRuntimeId === event.runtimeId
            && current.runtime.state === state
            && ownershipInspection?.runtimeId === event.runtimeId
            && ownershipInspection.ownerBotId === botId;
          if (!retirementAuthorized
            || !expectedIdentity
            || (state !== "failed" && state !== "unavailable")) return;
        },
      );
      if (!outcome.matched) retirementAuthorized = false;
      return outcome;
    }, () => operationCurrent, transactionEpoch);
    if (!retirementProof.current || !retirementAuthorized) {
      invalidate(true);
      return;
    }
    let completionState = state;
    if (!TERMINAL_RUNTIME_STATES.has(state) && this.#providerContractVersion === 2) {
      const identity = sessionIssuance(session);
      if (!identity?.issuanceKey || !identity.retirementKey) {
        invalidate(true);
        return;
      }
      try {
        if (await this.#retireIssuanceExact({
          botId,
          runtimeId: event.runtimeId,
          issuanceKey: identity.issuanceKey,
          retirementKey: identity.retirementKey,
        }, transactionEpoch)) {
          completionState = "retired";
          terminalRuntimeCleared = true;
        }
      } catch {
        // Keep the exact active issuance durable when terminal retirement cannot
        // be proven; the next reconcile retries the same identity.
      }
    }
    if (!TERMINAL_RUNTIME_STATES.has(completionState)) {
      this.#supersededBots.add(botId);
      return;
    }
    if (!terminalRuntimeCleared) {
      this.#supersededBots.add(botId);
      return;
    }

    if (this.#providerContractVersion === 2) {
      const identity = sessionIssuance(session);
      if (!identity?.issuanceKey) {
        invalidate(true);
        return;
      }
      let completed;
      try {
        completed = await this.#retryProviderEventStoreOperation(
          () => this.#store.completeRuntimeIssuance(botId, {
            issuanceKey: identity.issuanceKey,
            provider: initialBot.runtime.provider,
            runtimeId: event.runtimeId,
            state: completionState,
            runtimeState: state,
            lastErrorCode: finalErrorCode,
          }),
          () => operationCurrent,
          transactionEpoch,
        );
      } catch (error) {
        if (!isCommittedDurabilityUncertain(error)) throw error;
        const freshBot = await this.#store.read(botId);
        const remaining = await this.#store.readRuntimeIssuances(botId);
        const exactActive = remaining.some((entry) => (
          entry.phase === "active"
          && entry.issuanceKey === identity.issuanceKey
          && entry.provider === initialBot.runtime.provider
          && entry.runtimeId === event.runtimeId
        ));
        if (exactActive || !freshBot
          || freshBot.runtime.remoteRuntimeId !== null
          || freshBot.runtime.provider !== null
          || freshBot.runtime.state !== state) throw error;
        completed = { current: true, value: { matched: true, bot: freshBot } };
      }
      if (!completed.current || !completed.value?.matched) {
        invalidate(true);
        return;
      }
      // A different exact issuance may win immediately after this completion
      // commits (for example, a same-runtime successor replay). Never publish
      // the stale completion snapshot over that newer durable authority.
      const currentBot = await this.#store.read(botId);
      const currentIssuances = await this.#store.readRuntimeIssuances(botId);
      const reassigned = (await this.#store.list()).some((candidate) => (
        candidate.botId !== botId
        && candidate.runtime.remoteRuntimeId === event.runtimeId
      ));
      const successorActive = currentIssuances.some((entry) => (
        entry.phase === "active"
        && entry.issuanceKey !== identity.issuanceKey
      ));
      if (reassigned
        || successorActive
        || currentBot?.runtime.remoteRuntimeId !== null
        || currentBot?.runtime.provider !== null
        || currentBot?.runtime.state !== state) {
        invalidate(true);
        return;
      }
      this.#publishRuntime(completed.value.bot);
      return;
    }

    let clearedBot = null;
    let clearedCommit = null;
    try {
      const cleared = await this.#retryProviderEventStoreOperation(async () => {
        clearedBot = null;
        const outcome = await this.#store.runtimeTransaction(
          botId,
          { expectedLastErrorCode: terminalMarker },
          ({ bot: current, updateRuntime }) => {
            if (!operationCurrent
              || current.runtime.provider !== initialBot.runtime.provider
              || current.runtime.remoteRuntimeId !== event.runtimeId
              || current.runtime.state !== state) return;
            clearedBot = updateRuntime({
              provider: null,
              remoteRuntimeId: null,
              state,
              lastConfirmedAt: null,
              lastErrorCode: finalizationMarker,
            });
          },
        );
        if (!outcome.matched) clearedBot = null;
        return outcome;
      }, () => operationCurrent, transactionEpoch);
      if (!cleared.current || !clearedBot) {
        invalidate(true);
        return;
      }
      clearedCommit = cleared.value;
      if (!this.#store.isCurrentRuntimeCommit(clearedCommit, botId)) {
        invalidate(true);
        return;
      }
    } catch (error) {
      if (!isCommittedDurabilityUncertain(error)
        || !this.#store.isCurrentRuntimeCommit(error, botId)) {
        invalidate(true);
        if (isCommittedDurabilityUncertain(error)) return;
        throw error;
      }
      let fresh;
      try {
        fresh = await this.#retryProviderEventStoreOperation(
          () => this.#store.read(botId),
          () => operationCurrent,
          transactionEpoch,
        );
      } catch (freshError) {
        invalidate(true);
        throw freshError;
      }
      if (!fresh.current || !clearedIdentityMatches(fresh.value)) {
        invalidate(true);
        return;
      }
      clearedBot = fresh.value;
      clearedCommit = error;
    }
    if (!clearedCommit || !clearedIdentityMatches(clearedBot)) {
      invalidate(true);
      return;
    }

    let finalizedBot = null;
    let finalizationApplied = false;
    let finalizationCommit = null;
    try {
      const finalized = await this.#retryProviderEventStoreOperation(async () => {
        finalizedBot = null;
        finalizationApplied = false;
        const outcome = await this.#store.runtimeTransaction(
          botId,
          {
            expectedLastErrorCode: finalizationMarker,
            afterCommit: () => {
              if (finalizationApplied || !finalizedBot) return;
              if (this.#disposed || transactionEpoch !== this.#lifecycleEpoch) {
                finalizationApplied = true;
                return;
              }
              this.#invalidateActiveProviderReceipt(
                botId,
                event.runtimeId,
                runtimeEpoch,
                session,
                true,
              );
              finalizationApplied = true;
              this.#publishRuntime(finalizedBot);
            },
          },
          ({ bot: current, bots, updateRuntime }) => {
            const reassigned = bots.some((candidate) => (
              candidate.botId !== botId
              && candidate.runtime.remoteRuntimeId === event.runtimeId
            ));
            if (!operationCurrent || !clearedIdentityMatches(current) || reassigned) return;
            finalizedBot = updateRuntime({ lastErrorCode: finalErrorCode });
          },
        );
        return outcome;
      }, () => operationCurrent, transactionEpoch);
      if (!finalized.current || !finalizedBot || !finalizationApplied) {
        invalidate(true);
        return;
      }
      finalizationCommit = finalized.value;
      if (!this.#store.isCurrentRuntimeCommit(finalizationCommit, botId)) {
        invalidate(true);
      }
    } catch (error) {
      if (!finalizationApplied) {
        invalidate(true);
        if (isCommittedDurabilityUncertain(error)) return;
        throw error;
      }
      if (isCommittedDurabilityUncertain(error)) {
        if (!this.#store.isCurrentRuntimeCommit(error, botId)) invalidate(true);
        return;
      }
      // The public runtime was already fail-closed with the exact finalization
      // receipt. Private cleanup and its single event are not replayed.
      return;
    }
  }

  async #publishActiveProviderFrame(botId, event, runtimeEpoch, transactionEpoch, session, issuanceKey) {
    let frameBot = null;
    let published = false;
    const outcome = await this.#retryProviderEventStoreOperation(
      () => this.#store.runtimeTransaction(
        botId,
        {
          expectedActiveIssuanceKey: issuanceKey,
        },
        ({ bot: current }) => {
          if (!this.#activeProviderReceiptCurrent(botId, event.runtimeId, runtimeEpoch, session)
            || current.runtime.provider !== session.provider
            || current.runtime.remoteRuntimeId !== event.runtimeId
            || current.runtime.state !== "ready") return;
          frameBot = current;
          published = true;
          this.#publishRuntimeEvent(frameBot, event, runtimeEpoch);
        },
      ),
      () => this.#activeProviderReceiptCurrent(botId, event.runtimeId, runtimeEpoch, session),
      transactionEpoch,
    );
    return Boolean(outcome.current && outcome.value?.matched && published);
  }

  async #persistActiveProviderState(
    botId,
    event,
    runtimeEpoch,
    transactionEpoch,
    session,
    issuanceKey,
    expectedState,
    patch,
  ) {
    let updated = null;
    let published = false;
    const outcome = await this.#retryProviderEventStoreOperation(
      () => this.#store.runtimeTransaction(
        botId,
        {
          expectedActiveIssuanceKey: issuanceKey,
          afterCommit: () => {
            if (published || !updated) return;
            published = true;
            this.#publishRuntime(updated);
          },
        },
        ({ bot: current, updateRuntime }) => {
          if (!this.#activeProviderReceiptCurrent(botId, event.runtimeId, runtimeEpoch, session)
            || current.runtime.provider !== session.provider
            || current.runtime.remoteRuntimeId !== event.runtimeId
            || current.runtime.state !== expectedState) return;
          updated = updateRuntime(patch);
        },
      ),
      () => this.#activeProviderReceiptCurrent(botId, event.runtimeId, runtimeEpoch, session),
      transactionEpoch,
    );
    return Boolean(outcome.current && outcome.value?.matched && updated && published);
  }

  async #handleActiveProviderEvent(botId, event, runtimeEpoch, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    if (this.#runtimeOwners.get(event.runtimeId) !== botId
      || this.#runtimeEpochs.get(event.runtimeId) !== runtimeEpoch) return;
    const bot = await this.#store.read(botId);
    this.#assertActive(transactionEpoch);
    if (!bot || bot.runtime.remoteRuntimeId !== event.runtimeId) return;
    const session = this.#sessions.get(botId);
    if (this.#providerContractVersion === 2) {
      let issuanceInspection;
      try {
        issuanceInspection = await this.#inspectActiveSession(session, botId, transactionEpoch);
      } catch {
        this.#invalidateActiveProviderReceipt(botId, event.runtimeId, runtimeEpoch, session, true);
        return;
      }
      const identity = sessionIssuance(session);
      if (!issuanceInspection?.matched
        || issuanceInspection.runtimeId !== event.runtimeId
        || issuanceInspection.ownerBotId !== botId
        || issuanceInspection.issuanceKey !== identity?.issuanceKey) {
        this.#invalidateActiveProviderReceipt(botId, event.runtimeId, runtimeEpoch, session, true);
        return;
      }
      if (TERMINAL_RUNTIME_STATES.has(event.state)
        && !TERMINAL_RUNTIME_STATES.has(issuanceInspection.state)) {
        // A terminal-looking event is advisory. Do not stage or clear the
        // durable issuance until the authoritative exact readback is terminal.
        return;
      }
    }
    if (event.state === undefined) {
      if (!session
        || bot.runtime.state !== "ready"
        || session.runtimeId !== event.runtimeId
        || session.generation !== runtimeEpoch) return;
      const identity = sessionIssuance(session);
      if (!identity?.issuanceKey || !await this.#publishActiveProviderFrame(
        botId,
        event,
        runtimeEpoch,
        transactionEpoch,
        session,
        identity.issuanceKey,
      )) return;
      return;
    }
    if (!SAFE_EVENT_STATES.has(event.state)) return;
    if (event.state === "ready") {
      if (!session || session.runtimeId !== event.runtimeId || session.generation !== runtimeEpoch) return;
      const identity = sessionIssuance(session);
      if (!identity?.issuanceKey || !await this.#persistActiveProviderState(
        botId,
        event,
        runtimeEpoch,
        transactionEpoch,
        session,
        identity.issuanceKey,
        bot.runtime.state,
        {
        state: "ready",
        lastConfirmedAt: this.#now(),
        lastErrorCode: null,
        },
      )) return;
      return;
    }
    const state = persistedState(event.state);
    if (state === "failed" || state === "unavailable" || TERMINAL_RUNTIME_STATES.has(state)) {
      await this.#handleActiveTerminalProviderEvent(
        botId,
        event,
        runtimeEpoch,
        transactionEpoch,
        bot,
        session,
        state,
      );
      return;
    }
    const identity = sessionIssuance(session);
    if (!identity?.issuanceKey || !await this.#persistActiveProviderState(
      botId,
      event,
      runtimeEpoch,
      transactionEpoch,
      session,
      identity.issuanceKey,
      bot.runtime.state,
      { state, lastErrorCode: null },
    )) return;
    if (this.#sessions.get(botId) === session) this.#sessions.delete(botId);
  }

  async #dispatchProviderEvent(receipt, event, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    if (this.#providerContractVersion === 2) {
      const expected = receipt.kind === "active"
        ? sessionIssuance(this.#sessions.get(receipt.botId))?.issuanceKey
        : sessionIssuance(receipt.candidate)?.issuanceKey;
      if (typeof event?.issuanceKey !== "string" || event.issuanceKey !== expected) return;
    }
    if (receipt.kind === "active") {
      if (this.#runtimeOwners.get(event.runtimeId) !== receipt.botId
        || this.#runtimeEpochs.get(event.runtimeId) !== receipt.runtimeEpoch) return;
      await this.#handleActiveProviderEvent(
        receipt.botId,
        event,
        receipt.runtimeEpoch,
        transactionEpoch,
      );
      return;
    }
    if (this.#candidateOwners.get(event.runtimeId) === receipt.botId
      && this.#candidates.get(receipt.botId) === receipt.candidate
      && receipt.candidate.generation === receipt.generation) {
      await this.#handleCandidateProviderEvent(
        receipt.botId,
        event,
        receipt.candidate,
        transactionEpoch,
      );
      return;
    }
    const activeSession = this.#sessions.get(receipt.botId);
    if (this.#runtimeOwners.get(event.runtimeId) === receipt.botId
      && this.#runtimeEpochs.get(event.runtimeId) === receipt.generation
      && activeSession === receipt.candidate
      && activeSession.generation === receipt.generation) {
      await this.#handleActiveProviderEvent(
        receipt.botId,
        event,
        receipt.generation,
        transactionEpoch,
      );
    }
  }

  async #delayProviderEventRetry(attempt, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    let timer = null;
    const delayed = new Promise((resolve) => {
      timer = setTimeout(resolve, providerEventRetryDelay(attempt));
    });
    try {
      await Promise.race([delayed, this.#disposeSignal]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    this.#assertActive(transactionEpoch);
  }

  async #retryProviderEventStoreOperation(operation, isCurrent, transactionEpoch) {
    let attempt = 0;
    for (;;) {
      this.#assertActive(transactionEpoch);
      if (!isCurrent()) return { current: false, value: null };
      try {
        return { current: true, value: await operation() };
      } catch (error) {
        if (!RUNTIME_TRANSACTION_LOCK_ERRORS.has(error?.code)) throw error;
        await this.#delayProviderEventRetry(attempt, transactionEpoch);
        attempt += 1;
      }
    }
  }

  async #dispatchProviderEventWithLockRetry(receipt, event, transactionEpoch) {
    let attempt = 0;
    for (;;) {
      try {
        await this.#dispatchProviderEvent(receipt, event, transactionEpoch);
        return;
      } catch (error) {
        if (!RUNTIME_TRANSACTION_LOCK_ERRORS.has(error?.code)) throw error;
        await this.#delayProviderEventRetry(attempt, transactionEpoch);
        attempt += 1;
      }
    }
  }

  #receiveProviderEvent(event) {
    if (this.#disposed || !event || typeof event !== "object") return;
    const activeBotId = this.#runtimeOwners.get(event.runtimeId);
    const activeEpoch = this.#runtimeEpochs.get(event.runtimeId);
    const candidateBotId = this.#candidateOwners.get(event.runtimeId);
    const candidate = candidateBotId ? this.#candidates.get(candidateBotId) : null;
    let receipt = null;
    if (activeBotId && activeEpoch !== undefined) {
      receipt = {
        kind: "active",
        botId: activeBotId,
        runtimeEpoch: activeEpoch,
      };
    } else if (candidateBotId
      && candidate?.runtimeId === event.runtimeId) {
      receipt = {
        kind: "candidate",
        botId: candidateBotId,
        candidate,
        generation: candidate.generation,
      };
    }
    if (!receipt) return;
    const transactionEpoch = this.#lifecycleEpoch;
    void this.#enqueueBot(receipt.botId, () => (
      this.#dispatchProviderEventWithLockRetry(receipt, event, transactionEpoch)
    )).catch(() => {
      // Provider callbacks never surface diagnostics or become unhandled rejections.
    });
  }
}

module.exports = {
  BotRuntimeController,
};
