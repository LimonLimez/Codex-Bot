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
const DIRECT_PROVIDER_ID = "openai-codex";
const DIRECT_DISCONNECT_PENDING = "OPENBOT_PROVIDER_DISCONNECT_PENDING";
const DIRECT_ACCOUNT_UNAVAILABLE = "OPENBOT_PROVIDER_ACCOUNT_UNAVAILABLE";
const DIRECT_CATALOG_UNAVAILABLE = "OPENBOT_PROVIDER_CATALOG_UNAVAILABLE";
const INTERNAL_CONTEXT_FIELDS = new Set(["openExternal", "onLoginPrompt", "isCurrent"]);
const REQUEST_FIELDS = new Set(["providerId", "authMode", "baseUrl", "apiKey", "sourcePath", "signal"]);
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const LOGIN_USER_CODE = /^[A-Z0-9]{3,16}(?:-[A-Z0-9]{2,16})?$/;
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

function safeInternalContext(value) {
  if (value === undefined || value === null) return null;
  const context = ownData(value, INTERNAL_CONTEXT_FIELDS);
  for (const field of INTERNAL_CONTEXT_FIELDS) {
    if (context[field] !== undefined && typeof context[field] !== "function") throw invalid();
  }
  return Object.freeze(context);
}

function publicLoginPrompt(value, generation) {
  const raw = ownData(value, new Set(["mode", "verificationUrl", "userCode"]), [
    "mode", "verificationUrl", "userCode",
  ]);
  if (raw.mode !== "device-code"
    || typeof raw.verificationUrl !== "string"
    || raw.verificationUrl !== "https://auth.openai.com/codex/device"
    || typeof raw.userCode !== "string" || !LOGIN_USER_CODE.test(raw.userCode)
    || !Number.isSafeInteger(generation) || generation < 1) throw invalid();
  return Object.freeze({
    schemaVersion: 1,
    providerId: DIRECT_PROVIDER_ID,
    generation,
    mode: raw.mode,
    verificationUrl: raw.verificationUrl,
    userCode: raw.userCode,
  });
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

function projectConnections(state, errors = null, directPresentation = null) {
  const byProvider = new Map(state.connections.map((connection) => [connection.providerId, connection]));
  return PROVIDER_IDS.map((providerId) => {
    const descriptor = providerDescriptor(providerId);
    const current = byProvider.get(providerId);
    const errorCode = errors?.get(providerId) || current?.errorCode || null;
    const override = providerId === DIRECT_PROVIDER_ID ? directPresentation : null;
    return {
      providerId,
      label: descriptor.label,
      loginKind: descriptor.loginKind,
      state: override?.state || (current?.state === "error"
        ? "unavailable"
        : current?.state || (errorCode ? "unavailable" : "disconnected")),
      generation: override && override.generation > 0
        ? override.generation
        : current?.generation ?? 0,
      capabilities: {
        reasoning: descriptor.reasoningEfforts.length > 1,
        fast: descriptor.fastModeSupported === true,
      },
      errorCode: override?.errorCode || errorCode,
    };
  });
}

function projectCatalog(state, directPresentation = null) {
  const models = [];
  let generation = 0;
  for (const connection of state.connections) {
    if (connection.state !== "connected") continue;
    if (connection.providerId === DIRECT_PROVIDER_ID && directPresentation
      && directPresentation.state !== "connected") continue;
    generation = Math.max(generation, connection.generation);
    for (const model of connection.models) models.push(model);
  }
  return {
    generation,
    status: models.length > 0 ? "ready" : "unavailable",
    models,
  };
}

function projectOnboarding(state) {
  return state.onboarding;
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
  #directPresentation = null;
  #directAuthorityEpoch = 0;
  #directCeremonyGeneration = 0;
  #directCeremonyEpoch = 0;
  #directConnectActive = false;
  #directDisconnectPending = false;
  #directWaiters = new Set();
  #directReconcileFlight = null;
  #directReconcileQueued = false;
  #directLoginCancelFlight = null;
  #onAccountChanged = null;
  #onCatalogChanged = null;
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
    if (this.#account && typeof this.#account.on === "function"
      && typeof this.#account.removeListener === "function") {
      this.#onAccountChanged = (value) => this.#handleAccountChanged(value);
      this.#onCatalogChanged = (value) => this.#handleCatalogChanged(value);
      this.#account.on("account-changed", this.#onAccountChanged);
      this.#account.on("catalog-changed", this.#onCatalogChanged);
    }
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
    const authorityEpoch = this.#directAuthorityEpoch;
    const state = await this.#readState();
    this.#assertDirectAuthority(authorityEpoch);
    return freeze(projectConnections(state, this.#errors, this.#directPresentation));
  }

  async catalog() {
    const authorityEpoch = this.#directAuthorityEpoch;
    const state = await this.#readState();
    this.#assertDirectAuthority(authorityEpoch);
    return freeze(projectCatalog(state, this.#directPresentation));
  }

  async readAuthoritySnapshot() {
    const epoch = this.#lifecycleEpoch;
    const authorityEpoch = this.#directAuthorityEpoch;
    this.#assertLive(epoch);
    let state;
    try {
      state = await this.#readState();
    } catch (error) {
      if (this.#disposed || epoch !== this.#lifecycleEpoch) {
        throw unavailable("OPENBOT_PROVIDER_DISPOSED");
      }
      throw error;
    }
    this.#assertLive(epoch);
    this.#assertDirectAuthority(authorityEpoch);
    return freeze({
      schemaVersion: 1,
      connections: projectConnections(state, this.#errors, this.#directPresentation),
      catalog: projectCatalog(state, this.#directPresentation),
      onboarding: projectOnboarding(state),
    });
  }

  connect(rawRequest, rawContext = undefined) {
    if (this.#disposed) return Promise.reject(unavailable("OPENBOT_PROVIDER_DISPOSED"));
    let request;
    let context;
    try {
      request = ownData(rawRequest, REQUEST_FIELDS, ["providerId"]);
      context = safeInternalContext(rawContext);
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
    return this.#schedule(providerId, "connect", (epoch) => this.#connect(request, context, epoch));
  }

  disconnect(rawProviderId) {
    const providerId = this.#canonical(rawProviderId);
    if (this.#disposed) return Promise.reject(unavailable("OPENBOT_PROVIDER_DISPOSED"));
    if (providerId === DIRECT_PROVIDER_ID) this.#requestDirectCancellation(DIRECT_DISCONNECT_PENDING);
    return this.#schedule(providerId, "disconnect", (epoch) => this.#disconnect(providerId, epoch));
  }

  async #disconnect(providerId, epoch) {
    if (providerId === DIRECT_PROVIDER_ID) return this.#disconnectDirect(epoch);
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
    return projectOnboarding(await this.#readState());
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
    let result;
    try {
      result = await this.#stateStore.writeOnboarding(receipt);
    } catch (error) {
      throw this.#publicError(error, "OPENBOT_PROVIDER_ONBOARDING_FAILED");
    }
    try { this.emit("connections-changed", await this.listConnections()); } catch { /* committed receipt remains authoritative */ }
    try { this.emit("catalog-changed", await this.catalog()); } catch { /* committed receipt remains authoritative */ }
    return result;
  }

  async #connect(request, context, epoch) {
    const providerId = request.providerId;
    this.#assertLive(epoch);
    const previousState = await this.#readState();
    this.#assertLive(epoch);
    const previous = previousState.connections.find(({ providerId: current }) => current === providerId);
    if (providerId === DIRECT_PROVIDER_ID) return this.#connectDirect(request, context, epoch, previous);
    return this.#connectNonDirect(request, epoch, previous);
  }

  async #connectDirect(request, context, epoch, previous) {
    if (!this.#account || typeof this.#account.start !== "function"
      || typeof this.#account.accountState !== "function"
      || typeof this.#account.catalogState !== "function") throw unavailable();
    this.#directConnectActive = true;
    this.#directDisconnectPending = false;
    const ceremonyEpoch = ++this.#directCeremonyEpoch;
    let loginStarted = false;
    let committed = false;
    try {
      this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
      await this.#account.start();
      this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
      let readiness = this.#directReadiness();
      if (readiness.ready) {
        const current = await this.#readState();
        this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
        const existing = current.connections.find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
        const result = await this.#commitDirectReady(existing, readiness, epoch, ceremonyEpoch, request.signal);
        committed = true;
        return result;
      }
      if (!request.authMode || readiness.account.status !== "signed-out") {
        const current = await this.#readState();
        this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
        previous = current.connections.find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
        await this.#commitDirectUnavailable(previous,
          readiness.account.status === "ready" ? DIRECT_CATALOG_UNAVAILABLE : DIRECT_ACCOUNT_UNAVAILABLE,
          epoch,
          request.signal);
        throw unavailable(readiness.account.status === "ready"
          ? "OPENBOT_PROVIDER_CATALOG_UNAVAILABLE" : "OPENBOT_PROVIDER_NOT_READY");
      }
      if (typeof this.#account.login !== "function") throw unavailable("OPENBOT_PROVIDER_NOT_READY");
      this.#setDirectPresentation({
        state: "connecting",
        generation: previous?.generation ?? 0,
        errorCode: null,
      });
      try { await this.#publish(); } catch { /* connecting is also represented by the presentation epoch */ }
      const current = await this.#readState();
      this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
      previous = current.connections.find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
      await this.#commitDirectUnavailable(previous, DIRECT_ACCOUNT_UNAVAILABLE, epoch, request.signal);
      this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
      const login = await this.#account.login(request.authMode);
      loginStarted = true;
      this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
      await this.#presentDirectLogin(login, context, epoch, ceremonyEpoch, request.signal);
      readiness = await this.#waitForDirectReadiness(request, epoch, ceremonyEpoch);
      const latest = await this.#readState();
      this.#assertDirectFences(epoch, ceremonyEpoch, request.signal);
      previous = latest.connections.find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
      const result = await this.#commitDirectReady(previous, readiness, epoch, ceremonyEpoch, request.signal);
      committed = true;
      return result;
    } catch (error) {
      if (loginStarted) {
        await this.#cancelDirectLogin();
        await this.#awaitDirectLoginCancellation();
      }
      const publicError = this.#publicError(error,
        error?.code === "OPENBOT_PROVIDER_CANCELLED" || /CANCELLED|SUPERSEDED$/i.test(String(error?.code || ""))
          ? "OPENBOT_PROVIDER_CANCELLED" : "OPENBOT_PROVIDER_FAILED");
      if (!committed && !this.#directDisconnectPending) {
        this.#errors.set(DIRECT_PROVIDER_ID, publicError.code);
        this.#setDirectPresentation({
          state: "unavailable",
          generation: previous?.generation ?? 0,
          errorCode: publicError.code,
        });
        try { await this.#publish(); } catch { /* failed ceremony stays fail-closed */ }
      }
      throw publicError;
    } finally {
      this.#directConnectActive = false;
      this.#notifyDirectWaiters();
    }
  }

  #directReadiness() {
    let account;
    let catalog;
    try {
      account = this.#account.accountState();
      catalog = this.#account.catalogState();
    } catch {
      throw unavailable("OPENBOT_PROVIDER_ACCOUNT_UNAVAILABLE");
    }
    if (!account || typeof account !== "object" || Array.isArray(account)
      || !catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
      throw unavailable("OPENBOT_PROVIDER_ACCOUNT_UNAVAILABLE");
    }
    const rawModels = catalog.models;
    if (!Array.isArray(rawModels)) throw unavailable("OPENBOT_PROVIDER_CATALOG_UNAVAILABLE");
    let models;
    try { models = rawModels.map((model) => publicModel(DIRECT_PROVIDER_ID, model, catalog.generation)); }
    catch { throw unavailable("OPENBOT_PROVIDER_CATALOG_UNAVAILABLE"); }
    return {
      ready: account.status === "ready" && typeof account.authMode === "string"
        && catalog.status === "ready" && models.length > 0,
      account,
      catalog,
      models,
    };
  }

  async #commitDirectReady(previous, readiness, epoch, ceremonyEpoch, signal) {
    this.#assertDirectFences(epoch, ceremonyEpoch, signal);
    const generation = previous?.generation || 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw unavailable();
    const connection = {
      providerId: DIRECT_PROVIDER_ID,
      generation,
      state: "connected",
      models: readiness.models,
      authType: readiness.account.authMode,
      connectedAt: previous?.connectedAt || this.#now(),
    };
    const presentationEpoch = this.#directAuthorityEpoch;
    await this.#stateStore.commitConnection(connection);
    if (!this.#disposed && presentationEpoch === this.#directAuthorityEpoch) {
      this.#errors.delete(DIRECT_PROVIDER_ID);
      this.#setDirectPresentation(null);
    }
    try { await this.#publish(); } catch { /* committed connection remains authoritative */ }
    try {
      const connections = await this.listConnections();
      return connections.find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
    } catch {
      return projectConnections({ connections: [connection] }, this.#errors, this.#directPresentation)
        .find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
    }
  }

  async #presentDirectLogin(login, context, epoch, ceremonyEpoch, signal) {
    if (!login || typeof login !== "object" || Array.isArray(login)) throw unavailable("OPENBOT_PROVIDER_LOGIN_FAILED");
    const openUrlDescriptor = Object.getOwnPropertyDescriptor(login, "openUrl");
    const openUrl = openUrlDescriptor?.value;
    if (openUrl !== undefined) {
      if (!openUrlDescriptor || openUrlDescriptor.enumerable || typeof openUrl !== "string"
        || typeof context?.openExternal !== "function") throw unavailable("OPENBOT_PROVIDER_LOGIN_FAILED");
      if (context.isCurrent && !context.isCurrent()) throw unavailable("OPENBOT_PROVIDER_CANCELLED");
      try { await context.openExternal(openUrl); }
      catch { throw unavailable("OPENBOT_PROVIDER_LOGIN_FAILED"); }
      if (context.isCurrent && !context.isCurrent()) throw unavailable("OPENBOT_PROVIDER_CANCELLED");
      return;
    }
    const prompt = login.state?.login;
    const generation = ++this.#directCeremonyGeneration;
    let publicPrompt;
    try { publicPrompt = publicLoginPrompt(prompt, generation); }
    catch { throw unavailable("OPENBOT_PROVIDER_LOGIN_FAILED"); }
    if (typeof context?.onLoginPrompt !== "function") throw unavailable("OPENBOT_PROVIDER_LOGIN_FAILED");
    if (context.isCurrent && !context.isCurrent()) throw unavailable("OPENBOT_PROVIDER_CANCELLED");
    this.#assertDirectFences(epoch, ceremonyEpoch, signal);
    try { await context.onLoginPrompt(publicPrompt); }
    catch { throw unavailable("OPENBOT_PROVIDER_LOGIN_FAILED"); }
    this.#assertDirectFences(epoch, ceremonyEpoch, signal);
  }

  async #waitForDirectReadiness(request, epoch, ceremonyEpoch) {
    let wake;
    const waiter = () => { if (wake) { const resolve = wake; wake = null; resolve(); } };
    this.#directWaiters.add(waiter);
    const signal = request.signal;
    if (signal) {
      try { signal.addEventListener("abort", waiter, { once: true }); } catch { /* safeSignal checked the method */ }
    }
    try {
      while (true) {
        this.#assertDirectFences(epoch, ceremonyEpoch, signal);
        const readiness = this.#directReadiness();
        if (readiness.ready) return readiness;
        if (readiness.account.status === "offline") throw unavailable("OPENBOT_PROVIDER_ACCOUNT_UNAVAILABLE");
        if (readiness.account.status === "signed-out" && !readiness.account.login) {
          throw unavailable("OPENBOT_PROVIDER_NOT_READY");
        }
        if (readiness.account.status === "ready"
          && (readiness.catalog.status !== "ready" || readiness.models.length === 0)) {
          throw unavailable("OPENBOT_PROVIDER_CATALOG_UNAVAILABLE");
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    } finally {
      this.#directWaiters.delete(waiter);
      if (signal) {
        try { signal.removeEventListener("abort", waiter); } catch { /* best effort */ }
      }
    }
  }

  async #commitDirectUnavailable(previous, errorCode, epoch, signal) {
    if (!previous) return;
    if (previous.state === "unavailable" && previous.models.length === 0 && previous.errorCode === errorCode) {
      this.#errors.set(DIRECT_PROVIDER_ID, errorCode);
      return;
    }
    const generation = Math.max(1, previous.generation + 1);
    const marker = {
      ...previous,
      providerId: DIRECT_PROVIDER_ID,
      generation,
      state: "unavailable",
      models: [],
      errorCode,
    };
    await this.#stateStore.commitConnection(marker);
    this.#assertLive(epoch);
    if (signal?.aborted) throw unavailable("OPENBOT_PROVIDER_CANCELLED");
    this.#errors.set(DIRECT_PROVIDER_ID, errorCode);
    try { await this.#publish(); } catch { /* durable suppression is authoritative */ }
  }

  async #disconnectDirect(epoch) {
    this.#assertLive(epoch);
    const state = await this.#readState();
    this.#assertLive(epoch);
    const previous = state.connections.find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
    const account = this.#account;
    const accountAvailable = account && typeof account.logout === "function";
    const marker = previous || {
      providerId: DIRECT_PROVIDER_ID,
      generation: 0,
      state: "disconnected",
      models: [],
    };
    const markerGeneration = Math.max(1, marker.generation + (marker.state === "unavailable" ? 0 : 1));
    const staged = {
      ...marker,
      providerId: DIRECT_PROVIDER_ID,
      generation: markerGeneration,
      state: "unavailable",
      models: [],
      errorCode: DIRECT_DISCONNECT_PENDING,
    };
    try {
      await this.#stateStore.commitConnection(staged);
      this.#assertLive(epoch);
      this.#errors.set(DIRECT_PROVIDER_ID, DIRECT_DISCONNECT_PENDING);
      this.#setDirectPresentation({
        state: "unavailable",
        generation: markerGeneration,
        errorCode: DIRECT_DISCONNECT_PENDING,
      });
      try { await this.#publish(); } catch { /* staged marker remains authoritative */ }
      if (!accountAvailable) throw unavailable("OPENBOT_PROVIDER_DISCONNECT_FAILED");
      await account.logout();
      this.#assertLive(epoch);
      await this.#stateStore.removeConnectionAndOnboarding(DIRECT_PROVIDER_ID);
    } catch (error) {
      this.#errors.set(DIRECT_PROVIDER_ID, DIRECT_DISCONNECT_PENDING);
      this.#setDirectPresentation({
        state: "unavailable",
        generation: markerGeneration,
        errorCode: DIRECT_DISCONNECT_PENDING,
      });
      try { await this.#publish(); } catch { /* retry marker remains durable */ }
      throw this.#publicError(error, "OPENBOT_PROVIDER_DISCONNECT_FAILED");
    }
    this.#errors.delete(DIRECT_PROVIDER_ID);
    this.#directDisconnectPending = false;
    this.#setDirectPresentation(null);
    try { await this.#publish(); } catch { /* removal is authoritative */ }
    return undefined;
  }

  #handleAccountChanged(value) {
    if (this.#disposed) return;
    if (this.#directDisconnectPending) {
      this.#notifyDirectWaiters();
      return;
    }
    let status;
    try { status = value?.status; } catch { status = "offline"; }
    if (this.#directConnectActive && this.#directPresentation?.state === "connecting") {
      this.#notifyDirectWaiters();
      return;
    }
    if (status !== "ready") {
      this.#setDirectPresentation({ state: "unavailable", generation: 0, errorCode: DIRECT_ACCOUNT_UNAVAILABLE });
      this.#queueDirectReconcile();
      return;
    }
    if (!this.#directDisconnectPending) this.#queueDirectReconcile();
    this.#notifyDirectWaiters();
  }

  #handleCatalogChanged(value) {
    if (this.#disposed) return;
    if (this.#directDisconnectPending) {
      this.#notifyDirectWaiters();
      return;
    }
    let ready = false;
    try { ready = value?.status === "ready" && Array.isArray(value?.models) && value.models.length > 0; } catch { /* fail closed */ }
    if (this.#directConnectActive && this.#directPresentation?.state === "connecting") {
      this.#notifyDirectWaiters();
      return;
    }
    if (!ready) {
      this.#setDirectPresentation({ state: "unavailable", generation: 0, errorCode: DIRECT_CATALOG_UNAVAILABLE });
      this.#queueDirectReconcile();
      return;
    }
    if (!this.#directDisconnectPending) this.#queueDirectReconcile();
    this.#notifyDirectWaiters();
  }

  #queueDirectReconcile() {
    if (this.#disposed || this.#directConnectActive || this.#directDisconnectPending) return;
    if (this.#directReconcileFlight) {
      this.#directReconcileQueued = true;
      return;
    }
    const run = async () => {
      do {
        this.#directReconcileQueued = false;
        await this.#reconcileDirectLifecycle();
      } while (this.#directReconcileQueued && !this.#disposed);
    };
    const flight = run().catch(() => {}).finally(() => {
      if (this.#directReconcileFlight === flight) this.#directReconcileFlight = null;
    });
    this.#directReconcileFlight = flight;
  }

  async #reconcileDirectLifecycle() {
    if (this.#disposed || this.#directConnectActive || this.#directDisconnectPending) return;
    const lifecycleEpoch = this.#lifecycleEpoch;
    let readiness;
    try { readiness = this.#directReadiness(); }
    catch { readiness = { ready: false, account: { status: "offline" }, catalog: { status: "unavailable" }, models: [] }; }
    const state = await this.#readState();
    this.#assertLive(lifecycleEpoch);
    const previous = state.connections.find(({ providerId }) => providerId === DIRECT_PROVIDER_ID);
    if (readiness.ready) {
      if (!previous || previous.errorCode === DIRECT_DISCONNECT_PENDING) {
        if (!previous) {
          this.#errors.delete(DIRECT_PROVIDER_ID);
          this.#setDirectPresentation(null);
        }
        return;
      }
      await this.#stateStore.commitConnection({
        ...previous,
        providerId: DIRECT_PROVIDER_ID,
        generation: previous.generation,
        state: "connected",
        models: readiness.models,
        authType: readiness.account.authMode,
      });
      this.#assertLive(lifecycleEpoch);
      this.#errors.delete(DIRECT_PROVIDER_ID);
      this.#setDirectPresentation(null);
      try { await this.#publish(); } catch { /* durable refresh remains authoritative */ }
      return;
    }
    if (previous && previous.errorCode !== DIRECT_DISCONNECT_PENDING) {
      const invalidationCode = readiness.account?.status !== "ready"
        ? DIRECT_ACCOUNT_UNAVAILABLE
        : readiness.catalog?.status === "unavailable" ? DIRECT_CATALOG_UNAVAILABLE : DIRECT_ACCOUNT_UNAVAILABLE;
      await this.#commitDirectUnavailable(previous,
        invalidationCode,
        lifecycleEpoch,
        null);
    }
  }

  #setDirectPresentation(value) {
    const next = value ? {
      state: value.state,
      generation: Number.isSafeInteger(value.generation) && value.generation >= 0 ? value.generation : 0,
      errorCode: value.errorCode || null,
    } : null;
    const previous = this.#directPresentation;
    if (previous?.state === next?.state && previous?.generation === next?.generation
      && previous?.errorCode === next?.errorCode) return;
    this.#directPresentation = next;
    this.#directAuthorityEpoch += 1;
    this.#notifyDirectWaiters();
  }

  #notifyDirectWaiters() {
    for (const waiter of [...this.#directWaiters]) {
      try { waiter(); } catch { /* waiter isolation */ }
    }
  }

  #assertDirectAuthority(epoch) {
    if (epoch !== this.#directAuthorityEpoch) throw unavailable("OPENBOT_PROVIDER_SUPERSEDED");
  }

  #assertDirectFences(epoch, ceremonyEpoch, signal) {
    this.#assertLive(epoch);
    if (ceremonyEpoch !== this.#directCeremonyEpoch) throw unavailable("OPENBOT_PROVIDER_SUPERSEDED");
    this.#assertSignal(signal);
  }

  #requestDirectCancellation(errorCode) {
    this.#directDisconnectPending = errorCode === DIRECT_DISCONNECT_PENDING;
    this.#directCeremonyEpoch += 1;
    this.#setDirectPresentation({ state: "unavailable", generation: 0, errorCode });
    this.#notifyDirectWaiters();
    let loginPending = false;
    try { loginPending = this.#account?.accountState?.()?.status === "signing-in"; } catch { /* fail closed */ }
    if (this.#directConnectActive || loginPending) void this.#cancelDirectLogin();
  }

  #cancelDirectLogin() {
    if (this.#directLoginCancelFlight) return this.#directLoginCancelFlight;
    if (!this.#account || typeof this.#account.cancelLogin !== "function") return Promise.resolve();
    const flight = Promise.resolve().then(() => this.#account.cancelLogin()).catch(() => {}).finally(() => {
      if (this.#directLoginCancelFlight === flight) this.#directLoginCancelFlight = null;
    });
    this.#directLoginCancelFlight = flight;
    return flight;
  }

  async #awaitDirectLoginCancellation() {
    if (this.#directLoginCancelFlight) await this.#directLoginCancelFlight;
  }

  async #connectNonDirect(request, epoch, previous) {
    const providerId = request.providerId;
    const descriptor = providerDescriptor(providerId);
    let models;
    let connectionDetails = {};
    let previousSecret = null;
    let secretMutated = false;
    let externalRollback = null;
    let committed = false;
    try {
      this.#assertSignal(request.signal);
      if (descriptor.loginKind === "api-key" || descriptor.loginKind === "local") {
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
    const clearTail = () => {
      if (this.#providerTails.get(providerId) === operationPromise) this.#providerTails.delete(providerId);
    };
    void operationPromise.then(clearTail, clearTail);
    let promise;
    promise = Promise.race([operationPromise, cancellation]).finally(() => {
      if (this.#flights.get(key) === promise) this.#flights.delete(key);
      if (this.#flightRejectors.get(key) === rejectFlight) this.#flightRejectors.delete(key);
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
    this.#directCeremonyEpoch += 1;
    this.#directAuthorityEpoch += 1;
    if (this.#directConnectActive) void this.#cancelDirectLogin();
    this.#notifyDirectWaiters();
    if (this.#account && this.#onAccountChanged && typeof this.#account.removeListener === "function") {
      this.#account.removeListener("account-changed", this.#onAccountChanged);
      this.#account.removeListener("catalog-changed", this.#onCatalogChanged);
    }
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
