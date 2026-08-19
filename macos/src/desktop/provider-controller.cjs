"use strict";

const { EventEmitter } = require("node:events");
const { types } = require("node:util");
const {
  PROVIDER_IDS,
  providerDescriptor,
} = require("../provider-descriptors.cjs");
const { OpenAICompatibleProvider } = require("./openai-compatible-provider.cjs");
const { normalizeState } = require("./provider-state-store.cjs");

const PROVIDER_SET = new Set(PROVIDER_IDS);
const REQUEST_FIELDS = new Set(["providerId", "authMode", "baseUrl", "apiKey", "sourcePath", "signal"]);
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MODEL_INPUT_FIELDS = new Set([
  "provider", "providerLabel", "model", "id", "label", "displayName", "description",
  "efforts", "reasoningEfforts", "supportedReasoningEfforts", "serviceTiers", "defaultReasoningEffort",
  "defaultServiceTier", "catalogGeneration", "isDefault", "inputModalities", "supportsPersonality",
]);

class ProviderControllerError extends Error {
  constructor(message = "OpenBot provider operation failed.", code = "OPENBOT_PROVIDER_FAILED") {
    super(message);
    this.name = "ProviderControllerError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function invalid() {
  return new ProviderControllerError("OpenBot provider request is invalid.", "OPENBOT_PROVIDER_INVALID");
}

function unavailable(code = "OPENBOT_PROVIDER_UNAVAILABLE") {
  return new ProviderControllerError(
    code === "OPENBOT_PROVIDER_CANCELLED"
      ? "OpenBot provider connection was cancelled."
      : code === "OPENBOT_PROVIDER_NOT_READY"
        ? "OpenBot provider is not ready."
        : "OpenBot provider is unavailable.",
    code,
  );
}

function ownData(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw invalid(); }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]))
    || required.some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function safeSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (!signal || typeof signal !== "object" || types.isProxy(signal)
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function") throw invalid();
  return signal;
}

function publicModel(providerId, value, catalogGenerationOverride = undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || keys.some((key) => typeof key !== "string" || !MODEL_INPUT_FIELDS.has(key)
      || !("value" in descriptors[key]))) throw invalid();
  const raw = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  if (raw.provider !== undefined && raw.provider !== providerId) throw invalid();
  let modelId = raw.model;
  if (modelId === undefined) modelId = raw.id;
  if (typeof modelId !== "string" || !MODEL_ID.test(modelId)) throw invalid();
  const descriptor = providerDescriptor(providerId);
  const rawEfforts = raw.efforts || raw.reasoningEfforts || raw.supportedReasoningEfforts;
  if (rawEfforts !== undefined && types.isProxy(rawEfforts)) throw invalid();
  let efforts = Array.isArray(rawEfforts)
    ? rawEfforts.map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || types.isProxy(entry)) throw invalid();
      const entryDescriptors = Object.getOwnPropertyDescriptors(entry);
      if (Reflect.ownKeys(entryDescriptors).some((key) => key !== "reasoningEffort"
        || !("value" in entryDescriptors[key]))) throw invalid();
      return entryDescriptors.reasoningEffort?.value;
    })
    : [...descriptor.reasoningEfforts];
  if (efforts.some((entry) => typeof entry !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry))) throw invalid();
  efforts = [...new Set(efforts)];
  const rawTiers = raw.serviceTiers === undefined ? [] : raw.serviceTiers;
  if (!Array.isArray(rawTiers) || types.isProxy(rawTiers) || rawTiers.length > 16) throw invalid();
  const serviceTiers = rawTiers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || types.isProxy(entry)) throw invalid();
    const entryDescriptors = Object.getOwnPropertyDescriptors(entry);
    const entryKeys = Reflect.ownKeys(entryDescriptors);
    if (entryKeys.some((key) => typeof key !== "string" || !new Set(["id", "name", "description"]).has(key)
      || !("value" in entryDescriptors[key]))) throw invalid();
    const id = entryDescriptors.id?.value;
    const name = entryDescriptors.name?.value;
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(id)
      || typeof name !== "string" || name.length < 1 || name.length > 160) throw invalid();
    return { id, name };
  });
  if (new Set(serviceTiers.map(({ id }) => id)).size !== serviceTiers.length) throw invalid();
  const defaultReasoningEffort = raw.defaultReasoningEffort || efforts[0] || descriptor.defaultModel;
  if (typeof defaultReasoningEffort !== "string" || !efforts.includes(defaultReasoningEffort)) throw invalid();
  const defaultServiceTier = raw.defaultServiceTier ?? null;
  if (defaultServiceTier !== null && !serviceTiers.some(({ id }) => id === defaultServiceTier)) throw invalid();
  const result = {
    provider: providerId,
    providerLabel: descriptor.label,
    model: modelId,
    label: modelId,
    efforts,
    serviceTiers,
    defaultReasoningEffort,
    defaultServiceTier,
    catalogGeneration: Number.isSafeInteger(catalogGenerationOverride) && catalogGenerationOverride >= 0
      ? catalogGenerationOverride
      : Number.isSafeInteger(raw.catalogGeneration) && raw.catalogGeneration >= 0 ? raw.catalogGeneration : 0,
    isDefault: raw.isDefault === true,
  };
  if (typeof raw.label === "string" && raw.label.length > 0 && raw.label.length <= 160) result.label = raw.label;
  if (typeof raw.displayName === "string" && raw.displayName.length > 0 && raw.displayName.length <= 160) {
    result.label = raw.displayName;
  }
  return Object.freeze(result);
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freeze(nested)])));
}

class ProviderController extends EventEmitter {
  #stateStore;
  #keychain;
  #openai;
  #cliproxy;
  #account;
  #now;
  #flights = new Map();
  #providerTails = new Map();
  #flightRejectors = new Map();
  #errors = new Map();
  #disposed = false;
  #lifecycleEpoch = 0;

  constructor(rawOptions = {}) {
    super();
    const options = ownData(rawOptions, new Set([
      "stateStore", "keychain", "openai", "cliproxy", "account", "now",
    ]), ["stateStore"]);
    if (!options.stateStore || typeof options.stateStore !== "object" || types.isProxy(options.stateStore)
      || typeof options.stateStore.read !== "function"
      || typeof options.stateStore.commitConnection !== "function"
      || typeof options.stateStore.removeConnection !== "function"
      || typeof options.stateStore.removeConnectionAndOnboarding !== "function"
      || typeof options.stateStore.writeOnboarding !== "function"
      || typeof options.stateStore.clearOnboardingFor !== "function") throw invalid();
    if (options.keychain !== undefined && (!options.keychain || typeof options.keychain !== "object"
      || types.isProxy(options.keychain) || typeof options.keychain.set !== "function"
      || typeof options.keychain.delete !== "function" || typeof options.keychain.read !== "function")) throw invalid();
    if (options.openai !== undefined && (!options.openai || typeof options.openai !== "object"
      || types.isProxy(options.openai) || typeof options.openai.discover !== "function"
      || typeof options.openai.streamConfiguration !== "function")) throw invalid();
    if (options.cliproxy !== undefined && (!options.cliproxy || typeof options.cliproxy !== "object"
      || types.isProxy(options.cliproxy) || typeof options.cliproxy.connectProvider !== "function"
      || typeof options.cliproxy.importVertex !== "function"
      || typeof options.cliproxy.disconnectProvider !== "function"
      || typeof options.cliproxy.listModels !== "function"
      || typeof options.cliproxy.connectionStatus !== "function")) throw invalid();
    if (options.account !== undefined && (!options.account || typeof options.account !== "object"
      || types.isProxy(options.account) || typeof options.account.start !== "function"
      || typeof options.account.accountState !== "function" || typeof options.account.catalogState !== "function")) throw invalid();
    if (options.now !== undefined && typeof options.now !== "function") throw invalid();
    this.#stateStore = options.stateStore;
    this.#keychain = options.keychain || null;
    this.#openai = options.openai || new OpenAICompatibleProvider();
    this.#cliproxy = options.cliproxy || null;
    this.#account = options.account || null;
    this.#now = options.now || (() => new Date().toISOString());
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try { void Promise.resolve(listener.call(this, ...args)).catch(() => {}); } catch { /* observers are isolated */ }
    }
    return true;
  }

  async listConnections() {
    const state = await this.#readState();
    const byProvider = new Map(state.connections.map((connection) => [connection.providerId, connection]));
    return freeze(PROVIDER_IDS.map((providerId) => {
      const descriptor = providerDescriptor(providerId);
      const current = byProvider.get(providerId);
      const errorCode = this.#errors.get(providerId) || current?.errorCode || null;
      return {
        providerId,
        label: descriptor.label,
        loginKind: descriptor.loginKind,
        state: current?.state || (errorCode ? "unavailable" : "disconnected"),
        generation: current?.generation || 0,
        capabilities: {
          reasoning: descriptor.reasoningEfforts.length > 1,
          fast: descriptor.fastModeSupported === true,
        },
        errorCode,
      };
    }));
  }

  async catalog() {
    const state = await this.#readState();
    const models = [];
    let generation = 0;
    for (const connection of state.connections) {
      if (connection.state !== "connected") continue;
      generation = Math.max(generation, connection.generation);
      for (const model of connection.models) models.push(model);
    }
    return freeze({
      generation,
      status: models.length > 0 ? "ready" : "unavailable",
      models,
    });
  }

  connect(rawRequest) {
    if (this.#disposed) return Promise.reject(unavailable("OPENBOT_PROVIDER_DISPOSED"));
    let request;
    try {
      request = ownData(rawRequest, REQUEST_FIELDS, ["providerId"]);
      const descriptor = providerDescriptor(request.providerId);
      if (descriptor.providerId !== request.providerId || !PROVIDER_SET.has(request.providerId)) throw invalid();
      request.signal = safeSignal(request.signal);
      const allowed = request.providerId === "openai-codex"
        ? new Set(["providerId", "authMode", "signal"])
        : descriptor.loginKind === "api-key"
          ? new Set(["providerId", "apiKey", "signal"])
          : descriptor.loginKind === "local"
            ? new Set(["providerId", "baseUrl", "apiKey", "signal"])
            : descriptor.loginKind === "service-account"
              ? new Set(["providerId", "sourcePath", "signal"])
              : new Set(["providerId", "signal"]);
      if (Object.keys(request).some((key) => !allowed.has(key))) throw invalid();
      if (request.authMode !== undefined && !new Set(["browser", "device-code"]).has(request.authMode)) throw invalid();
      if (request.sourcePath !== undefined
        && (typeof request.sourcePath !== "string" || !request.sourcePath.startsWith("/"))) throw invalid();
    } catch (error) {
      return Promise.reject(error instanceof ProviderControllerError ? error : invalid());
    }
    const providerId = request.providerId;
    if (request.signal?.aborted) return Promise.reject(unavailable("OPENBOT_PROVIDER_CANCELLED"));
    return this.#schedule(providerId, "connect", (epoch) => this.#connect(request, epoch));
  }

  disconnect(rawProviderId) {
    const providerId = this.#canonical(rawProviderId);
    if (this.#disposed) return Promise.reject(unavailable("OPENBOT_PROVIDER_DISPOSED"));
    return this.#schedule(providerId, "disconnect", (epoch) => this.#disconnect(providerId, epoch));
  }

  async #disconnect(providerId, epoch) {
    this.#assertLive(epoch);
    const state = await this.#readState();
    this.#assertLive(epoch);
    const connection = state.connections.find(({ providerId: current }) => current === providerId);
    const descriptor = providerDescriptor(providerId);
    let previousSecret = null;
    let secretDeleted = false;
    let externalRollback = null;
    let durableCommitted = false;
    try {
      if (descriptor.loginKind === "api-key" || descriptor.loginKind === "local") {
        if (this.#keychain && connection?.secretRef) {
          previousSecret = await this.#keychain.read(providerId);
          this.#assertLive(epoch);
          await this.#keychain.delete(providerId);
          secretDeleted = true;
        }
      } else if (this.#cliproxy) {
        const result = await this.#cliproxy.disconnectProvider(providerId);
        if (result && typeof result.rollback === "function") externalRollback = result.rollback;
      }
      this.#assertLive(epoch);
      await this.#stateStore.removeConnectionAndOnboarding(providerId);
      durableCommitted = true;
    } catch (error) {
      if (!durableCommitted && secretDeleted && this.#keychain) {
        try {
          if (previousSecret === null || previousSecret === undefined) await this.#keychain.delete(providerId);
          else await this.#keychain.set(providerId, previousSecret);
        } catch { /* preserve the stable public failure */ }
      }
      if (!durableCommitted && externalRollback) { try { await externalRollback(); } catch { /* best effort */ } }
      throw this.#publicError(error, "OPENBOT_PROVIDER_DISCONNECT_FAILED");
    }
    this.#errors.delete(providerId);
    try {
      this.#assertLive(epoch);
      await this.#publish();
    } catch {
      // The durable mutation is authoritative; publication/readback failures
      // cannot turn a committed disconnect into a retryable failure.
    }
    return undefined;
  }

  async readOnboarding() {
    return (await this.#readState()).onboarding;
  }

  completeOnboarding(rawProviderId) {
    const providerId = this.#canonical(rawProviderId);
    if (this.#disposed) return Promise.reject(unavailable("OPENBOT_PROVIDER_DISPOSED"));
    return this.#schedule(providerId, "onboarding", (epoch) => this.#completeOnboarding(providerId, epoch));
  }

  async #completeOnboarding(providerId, epoch) {
    const stateBefore = await this.#readState();
    this.#assertLive(epoch);
    const connectionBefore = stateBefore.connections.find(({ providerId: current }) => current === providerId);
    if (!connectionBefore || connectionBefore.state !== "connected") throw unavailable("OPENBOT_PROVIDER_NOT_READY");
    const catalogBefore = await this.catalog();
    this.#assertLive(epoch);
    const state = await this.#readState();
    this.#assertLive(epoch);
    const connection = state.connections.find(({ providerId: current }) => current === providerId);
    if (!connection || connection.state !== "connected" || connection.generation !== connectionBefore.generation) {
      throw unavailable("OPENBOT_PROVIDER_NOT_READY");
    }
    const catalogAfter = await this.catalog();
    this.#assertLive(epoch);
    if (catalogAfter.generation !== catalogBefore.generation) throw unavailable("OPENBOT_PROVIDER_CATALOG_STALE");
    const models = catalogAfter.models.filter((model) => model.provider === providerId);
    if (models.length === 0) throw unavailable("OPENBOT_PROVIDER_NOT_READY");
    const completedAt = this.#now();
    if (typeof completedAt !== "string") throw unavailable();
    const receipt = {
      schemaVersion: 1,
      providerId,
      connectionGeneration: connection.generation,
      catalogGeneration: catalogAfter.generation,
      completedAt,
    };
    try {
      const result = await this.#stateStore.writeOnboarding(receipt);
      this.emit("connections-changed", await this.listConnections());
      this.emit("catalog-changed", await this.catalog());
      return result;
    } catch (error) {
      throw this.#publicError(error, "OPENBOT_PROVIDER_ONBOARDING_FAILED");
    }
  }

  async #connect(request, epoch) {
    const providerId = request.providerId;
    const descriptor = providerDescriptor(providerId);
    this.#assertLive(epoch);
    const previousState = await this.#readState();
    this.#assertLive(epoch);
    const previous = previousState.connections.find(({ providerId: current }) => current === providerId);
    let models;
    let connectionDetails = {};
    let previousSecret = null;
    let secretMutated = false;
    let externalRollback = null;
    let committed = false;
    try {
      this.#assertSignal(request.signal);
      if (providerId === "openai-codex") {
        if (!this.#account) throw unavailable();
        await this.#account.start();
        this.#assertSignal(request.signal);
        const account = this.#account.accountState();
        const catalog = this.#account.catalogState();
        if (!account || account.status !== "ready" || !catalog || catalog.status !== "ready") {
          throw unavailable("OPENBOT_PROVIDER_NOT_READY");
        }
        models = (catalog.models || []).map((model) => publicModel(providerId, model, catalog.generation));
        if (models.length === 0) throw unavailable("OPENBOT_PROVIDER_NOT_READY");
        connectionDetails.authType = account.authMode || descriptor.loginKind;
      } else if (descriptor.loginKind === "api-key" || descriptor.loginKind === "local") {
        if (!this.#openai) throw unavailable();
        const discovered = await this.#openai.discover({
          providerId,
          baseUrl: request.baseUrl,
          apiKey: request.apiKey,
          signal: request.signal,
        });
        this.#assertSignal(request.signal);
        if (!discovered || typeof discovered !== "object" || !Array.isArray(discovered.models)
          || discovered.models.length === 0) throw unavailable("OPENBOT_PROVIDER_NOT_READY");
        models = discovered.models.map((model) => publicModel(providerId, model));
        const configuration = this.#openai.streamConfiguration(providerId);
        if (configuration.baseUrl) connectionDetails.baseUrl = configuration.baseUrl;
        const apiKey = configuration.apiKey;
        if (apiKey !== null && apiKey !== undefined) {
        if (!this.#keychain) throw unavailable();
          previousSecret = await this.#keychain.read(providerId);
          this.#assertLive(epoch);
          await this.#keychain.set(providerId, apiKey);
          secretMutated = true;
          this.#assertSignal(request.signal);
          this.#assertLive(epoch);
          connectionDetails.secretRef = `keychain:${providerId}`;
        }
        connectionDetails.authType = descriptor.loginKind;
      } else {
        if (!this.#cliproxy) throw unavailable();
        const externalResult = descriptor.loginKind === "service-account"
          ? await this.#cliproxy.importVertex(request.sourcePath)
          : await this.#cliproxy.connectProvider(providerId);
        if (externalResult && typeof externalResult.rollback === "function") externalRollback = externalResult.rollback;
        this.#assertSignal(request.signal);
        this.#assertLive(epoch);
        const status = await this.#cliproxy.connectionStatus(providerId);
        if (!status || status.state !== "connected") throw unavailable("OPENBOT_PROVIDER_NOT_READY");
        const listed = await this.#cliproxy.listModels(providerId);
        models = (Array.isArray(listed) ? listed : listed?.models).map((model) => publicModel(providerId, model));
        if (!models || models.length === 0) throw unavailable("OPENBOT_PROVIDER_NOT_READY");
        connectionDetails.authType = descriptor.loginKind;
      }
      this.#assertSignal(request.signal);
      const generation = (previous?.generation || 0) + 1;
      if (!Number.isSafeInteger(generation)) throw unavailable();
      const connection = {
        providerId,
        generation,
        state: "connected",
        models,
        ...connectionDetails,
        connectedAt: this.#now(),
      };
      await this.#stateStore.commitConnection(connection);
      committed = true;
      this.#assertLive(epoch);
      this.#errors.delete(providerId);
      await this.#publish();
      return (await this.listConnections()).find(({ providerId: current }) => current === providerId);
    } catch (error) {
      const publicError = this.#publicError(error,
        error?.code === "OPENBOT_PROVIDER_CANCELLED" || /CANCELLED$/i.test(String(error?.code || ""))
          ? "OPENBOT_PROVIDER_CANCELLED" : "OPENBOT_PROVIDER_FAILED");
      this.#errors.set(providerId, publicError.code);
      if (secretMutated && this.#keychain) {
        try {
          if (previousSecret === null || previousSecret === undefined) await this.#keychain.delete(providerId);
          else await this.#keychain.set(providerId, previousSecret);
        } catch { /* preserve the durable prior state and report the stable failure */ }
      }
      if (externalRollback) {
        try { await externalRollback(); } catch { /* provider cleanup is best effort */ }
      }
      if (committed) {
        try {
          if (previous) await this.#stateStore.commitConnection(previous);
          else await this.#stateStore.removeConnection(providerId);
        } catch { /* state store remains authoritative for the next explicit retry */ }
      }
      try { await this.#publish(); } catch { /* publication cannot expose provider details */ }
      // A failed flight never replaces the prior good connection or creates a
      // receipt. State writes occur only after every external check succeeds.
      if (previous) {
        // Keep the explicit branch to document the durable preservation fence;
        // no write is intentionally performed here.
      }
      throw publicError;
    }
  }

  #schedule(providerId, kind, operation) {
    const key = `${kind}:${providerId}`;
    const existing = this.#flights.get(key);
    if (existing) return existing;
    const epoch = this.#lifecycleEpoch;
    const previous = this.#providerTails.get(providerId) || Promise.resolve();
    let rejectFlight;
    const cancellation = new Promise((_resolve, reject) => { rejectFlight = reject; });
    const operationPromise = previous.catch(() => {}).then(() => operation(epoch));
    let promise;
    promise = Promise.race([operationPromise, cancellation]).finally(() => {
      if (this.#flights.get(key) === promise) this.#flights.delete(key);
      if (this.#flightRejectors.get(key) === rejectFlight) this.#flightRejectors.delete(key);
      if (this.#providerTails.get(providerId) === promise) this.#providerTails.delete(providerId);
    });
    this.#flights.set(key, promise);
    this.#flightRejectors.set(key, rejectFlight);
    this.#providerTails.set(providerId, promise);
    return promise;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycleEpoch += 1;
    const rejectors = [...this.#flightRejectors.values()];
    this.#flightRejectors.clear();
    this.#flights.clear();
    this.#providerTails.clear();
    for (const reject of rejectors) {
      try { reject(unavailable("OPENBOT_PROVIDER_DISPOSED")); } catch {}
    }
    this.removeAllListeners();
  }

  async #publish() {
    this.emit("connections-changed", await this.listConnections());
    this.emit("catalog-changed", await this.catalog());
  }

  async #readState() {
    let state;
    try { state = await this.#stateStore.read(); } catch (error) { throw this.#publicError(error); }
    try { return normalizeState(state); } catch { throw unavailable(); }
  }

  #canonical(rawProviderId) {
    if (typeof rawProviderId !== "string" || !PROVIDER_SET.has(rawProviderId)) throw invalid();
    try { return providerDescriptor(rawProviderId).providerId; } catch { throw invalid(); }
  }

  #assertSignal(signal) {
    if (signal?.aborted) throw unavailable("OPENBOT_PROVIDER_CANCELLED");
  }

  #assertLive(epoch) {
    if (this.#disposed) throw unavailable("OPENBOT_PROVIDER_DISPOSED");
    if (epoch !== this.#lifecycleEpoch) throw unavailable("OPENBOT_PROVIDER_SUPERSEDED");
  }

  #publicError(error, fallback = "OPENBOT_PROVIDER_FAILED") {
    if (error instanceof ProviderControllerError) return error;
    const externalCode = typeof error?.code === "string" ? error.code : "";
    const code = /CANCELLED$/i.test(externalCode)
      ? "OPENBOT_PROVIDER_CANCELLED"
      : externalCode === "CLIPROXY_PROVIDER_NOT_READY"
        ? "OPENBOT_PROVIDER_NOT_READY"
        : fallback;
    return unavailable(code);
  }
}

module.exports = {
  ProviderController,
  ProviderControllerError,
};
