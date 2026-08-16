"use strict";

const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");

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
const SESSION_LEASES = new WeakMap();

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
  return session;
}

function sessionLease(session) {
  return session ? SESSION_LEASES.get(session) : null;
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

class BotRuntimeController extends EventEmitter {
  #store;
  #provider;
  #now;
  #sessions = new Map();
  #candidates = new Map();
  #provisions = new Map();
  #botQueues = new Map();
  #generations = new Map();
  #runtimeOwners = new Map();
  #runtimeFingerprints = new Map();
  #runtimeEpochs = new Map();
  #candidateOwners = new Map();
  #candidateFingerprints = new Map();
  #supersededBots = new Set();
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
      || typeof store.runtimeTransaction !== "function"
      || typeof store.isCurrentRuntimeCommit !== "function") {
      throw new TypeError("Bot runtime controller requires a BotStore.");
    }
    if (!provider || typeof provider.subscribe !== "function") {
      throw new TypeError("Bot runtime controller requires a remote runtime provider.");
    }
    if (typeof now !== "function") throw new TypeError("Bot runtime controller now must be a function.");
    this.#store = store;
    this.#provider = provider;
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

  async createBot(input) {
    const created = await this.#store.create(input);
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
    return publicBot(await this.#store.read(botId));
  }

  async renameBot(botId, name) {
    const bot = await this.#store.rename(botId, name);
    this.#publishBot(bot);
    return publicBot(bot);
  }

  async updateProfile(botId, profile) {
    const bot = await this.#store.updateProfile(botId, profile);
    this.#publishBot(bot);
    return publicBot(bot);
  }

  async advanceSetup(botId, transition, commitFence = undefined) {
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
      bot = await this.#store.advanceSetup(botId, transition, commitFence);
    } catch (error) {
      if (!isCommittedDurabilityUncertain(error) || expectedNextStage === null) throw error;
      bot = await this.#store.read(botId);
      if (!bot || bot.setupStage !== expectedNextStage) throw error;
    }
    this.#publishBot(bot);
    return publicBot(bot);
  }

  ensureRuntime(botId) {
    return this.#runtimeOperation(botId, false).then(publicBot);
  }

  retryRuntime(botId) {
    return this.#runtimeOperation(botId, true).then(publicBot);
  }

  async runtimeSession(botId) {
    if (this.#disposed) return null;
    const transactionEpoch = this.#lifecycleEpoch;
    const bot = await this.#store.read(botId);
    this.#assertActive(transactionEpoch);
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
      inspected = await this.#provider.inspect({ runtimeId: captured.runtimeId });
      this.#assertActive(transactionEpoch);
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
        await this.#persistRuntime(bot.botId, {
          state: inspectionFailure.code === "REMOTE_PROVIDER_UNAVAILABLE" ? "unavailable" : "reconnecting",
          lastErrorCode: inspectionFailure.code,
        }, transactionEpoch);
        return null;
      }
      if (inspected.ownerBotId !== bot.botId) {
        this.#sessions.delete(bot.botId);
        await this.#persistRuntime(bot.botId, {
          state: "failed",
          lastErrorCode: "RUNTIME_OWNER_MISMATCH",
        }, transactionEpoch);
        return null;
      }
      if (inspected.runtimeId !== captured.runtimeId || inspected.state !== "ready") {
        this.#sessions.delete(bot.botId);
        const state = persistedState(inspected.state);
        await this.#persistRuntime(bot.botId, {
          state,
          lastErrorCode: stateErrorCode(state),
        }, transactionEpoch);
        return null;
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
        if (bot.runtime.remoteRuntimeId || bot.runtime.provider) {
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
    this.#botQueues.clear();
    this.#generations.clear();
    this.#runtimeOwners.clear();
    this.#runtimeFingerprints.clear();
    this.#runtimeEpochs.clear();
    this.#candidateOwners.clear();
    this.#candidateFingerprints.clear();
    this.#supersededBots.clear();
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

  #enqueueBot(botId, operation) {
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

  async #runtimeOperation(botId, force) {
    const transactionEpoch = this.#lifecycleEpoch;
    this.#assertActive(transactionEpoch);
    const bot = await this.#store.read(botId);
    this.#assertActive(transactionEpoch);
    if (!bot) throw new Error(`Bot not found: ${botId}.`);
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
        await this.#persistFailure(
          bot.botId,
          failure,
          transactionEpoch,
          operationLeaseAcquired ? leaseMarker : null,
        );
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
                if (expectedProvider
                  && inspected.runtimeId === result.runtimeId
                  && inspected.ownerBotId === botId
                  && !TERMINAL_RUNTIME_STATES.has(inspected.state)) {
                  await this.#provider.retire({ runtimeId: result.runtimeId });
                }
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
        try {
          await this.#provider.retire({ runtimeId });
          this.#assertActive(transactionEpoch);
        } catch {
          this.#assertActive(transactionEpoch);
          retirementFailed = true;
        }
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
          await this.#provider.retire({ runtimeId: oldRuntimeId });
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
            try {
              await this.#provider.retire({ runtimeId: candidate.runtimeId });
              this.#assertActive(transactionEpoch);
            } catch (error) {
              this.#assertActive(transactionEpoch);
              // Provider event state remains authoritative and diagnostics remain private.
            }
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
    let stagedBot = null;
    let stagedCommit = null;
    try {
      const staged = await this.#retryProviderEventStoreOperation(async () => {
        stagedBot = null;
        return this.#store.runtimeTransaction(botId, {}, ({ bot: current, updateRuntime }) => {
          if (!receiptCurrent()
            || current.runtime.provider !== initialBot.runtime.provider
            || current.runtime.remoteRuntimeId !== event.runtimeId
            || current.runtime.state !== initialBot.runtime.state
            || current.runtime.lastErrorCode !== initialBot.runtime.lastErrorCode) return;
          stagedBot = updateRuntime({
            state,
            lastErrorCode: terminalMarker,
          });
        });
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
    let retirementAuthorized = false;
    let terminalRuntimeCleared = TERMINAL_RUNTIME_STATES.has(state);
    const retirementProof = await this.#retryProviderEventStoreOperation(async () => {
      retirementAuthorized = false;
      const outcome = await this.#store.runtimeTransaction(
        botId,
        { expectedLastErrorCode: terminalMarker },
        async ({ bot: current }) => {
          retirementAuthorized = operationCurrent
            && current.runtime.provider === initialBot.runtime.provider
            && current.runtime.remoteRuntimeId === event.runtimeId
            && current.runtime.state === state;
          if (!retirementAuthorized
            || !expectedIdentity
            || (state !== "failed" && state !== "unavailable")) return;
          let inspected = null;
          try {
            inspected = await this.#provider.inspect({ runtimeId: event.runtimeId });
            this.#assertActive(transactionEpoch);
          } catch (error) {
            this.#assertActive(transactionEpoch);
          }
          if (inspected?.runtimeId !== event.runtimeId
            || inspected.ownerBotId !== botId) return;
          try {
            await this.#provider.retire({ runtimeId: event.runtimeId });
            this.#assertActive(transactionEpoch);
            terminalRuntimeCleared = true;
          } catch (error) {
            this.#assertActive(transactionEpoch);
            // The staged identity remains available for a later safe recovery.
          }
        },
      );
      if (!outcome.matched) retirementAuthorized = false;
      return outcome;
    }, () => operationCurrent, transactionEpoch);
    if (!retirementProof.current || !retirementAuthorized) {
      invalidate(true);
      return;
    }
    if (!terminalRuntimeCleared) {
      this.#supersededBots.add(botId);
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

  async #handleActiveProviderEvent(botId, event, runtimeEpoch, transactionEpoch) {
    this.#assertActive(transactionEpoch);
    if (this.#runtimeOwners.get(event.runtimeId) !== botId
      || this.#runtimeEpochs.get(event.runtimeId) !== runtimeEpoch) return;
    const bot = await this.#store.read(botId);
    this.#assertActive(transactionEpoch);
    if (!bot || bot.runtime.remoteRuntimeId !== event.runtimeId) return;
    if (event.state === undefined) {
      const session = this.#sessions.get(botId);
      if (!session
        || bot.runtime.state !== "ready"
        || session.runtimeId !== event.runtimeId
        || session.generation !== runtimeEpoch) return;
      this.#publishRuntimeEvent(bot, event, runtimeEpoch);
      return;
    }
    if (!SAFE_EVENT_STATES.has(event.state)) return;
    if (event.state === "ready") {
      const session = this.#sessions.get(botId);
      if (!session || session.runtimeId !== event.runtimeId || session.generation !== runtimeEpoch) return;
      await this.#persistRuntime(botId, {
        state: "ready",
        lastConfirmedAt: this.#now(),
        lastErrorCode: null,
      }, transactionEpoch);
      return;
    }
    const state = persistedState(event.state);
    const session = this.#sessions.get(botId);
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
    await this.#persistRuntime(botId, {
      state,
      lastErrorCode: null,
    }, transactionEpoch);
    if (this.#sessions.get(botId) === session) this.#sessions.delete(botId);
  }

  async #dispatchProviderEvent(receipt, event, transactionEpoch) {
    this.#assertActive(transactionEpoch);
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
