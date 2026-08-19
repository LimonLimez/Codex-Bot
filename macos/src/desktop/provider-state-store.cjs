"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");
const { PROVIDER_IDS } = require("../provider-descriptors.cjs");

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = PROVIDER_IDS.length;
const MAX_MODELS = 200;
const PROVIDERS = new Set(PROVIDER_IDS);
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_.-]{0,63}$/;
const SAFE_REF = /^keychain:[a-z0-9][a-z0-9._-]{0,127}$/;
const BASE_URL = /^https?:\/\/[^\s\0\r\n]+$/;
const CONNECTION_STATES = new Set(["connected", "connecting", "disconnected", "unavailable", "error"]);
const CONNECTION_FIELDS = new Set([
  "providerId", "generation", "state", "models", "baseUrl", "secretRef", "authType", "connectedAt", "errorCode",
]);
const MODEL_FIELDS = new Set([
  "provider", "providerLabel", "model", "id", "label", "displayName", "description",
  "efforts", "reasoningEfforts", "supportedReasoningEfforts", "serviceTiers", "defaultReasoningEffort",
  "defaultServiceTier", "catalogGeneration", "inputModalities", "supportsPersonality", "isDefault",
]);
const RECEIPT_FIELDS = new Set(["schemaVersion", "providerId", "connectionGeneration", "completedAt"]);
const STATE_FIELDS = new Set(["schemaVersion", "connections", "onboarding"]);

class ProviderStateStoreError extends Error {
  constructor(message = "OpenBot provider state is invalid.", code = "OPENBOT_PROVIDER_STATE_FAILED") {
    super(message);
    this.name = "ProviderStateStoreError";
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
  return new ProviderStateStoreError("OpenBot provider state is invalid.", "OPENBOT_PROVIDER_STATE_INVALID");
}

function fail() { throw new ProviderStateStoreError(); }

function ownData(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalid();
  }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]))
    || required.some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value)) throw invalid();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw invalid(); }
  const length = descriptors.length?.value;
  const keys = Reflect.ownKeys(descriptors);
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || keys.length !== length + 1
    || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key)))) throw invalid();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) throw invalid();
    result.push(descriptor.value);
  }
  return result;
}

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw invalid();
  return value;
}

function safeText(value, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
    || /[\0\r\n]/.test(value)) throw invalid();
  return value;
}

function normalizeReasoningEfforts(value) {
  const values = denseArray(value, 32);
  const result = [];
  const seen = new Set();
  for (const entry of values) {
    const effort = safeText(entry, 32);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(effort) || seen.has(effort)) throw invalid();
    seen.add(effort);
    result.push(effort);
  }
  return Object.freeze(result);
}

function normalizeModel(value) {
  const raw = ownData(value, MODEL_FIELDS, ["provider", "model"]);
  if (!PROVIDERS.has(raw.provider) || typeof raw.model !== "string" || !MODEL_ID.test(raw.model)) throw invalid();
  if (raw.id !== undefined && (typeof raw.id !== "string" || raw.id !== raw.model)) throw invalid();
  const result = { provider: raw.provider };
  if (raw.providerLabel !== undefined) result.providerLabel = safeText(raw.providerLabel, 160);
  const label = raw.label ?? raw.displayName ?? raw.model;
  result.model = raw.model;
  result.label = safeText(label, 160);
  let efforts = raw.efforts ?? raw.reasoningEfforts ?? raw.supportedReasoningEfforts;
  if (efforts !== undefined) {
    if (!Array.isArray(efforts) || types.isProxy(efforts)) throw invalid();
    if (efforts.some((entry) => entry && typeof entry === "object")) {
      efforts = efforts.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || types.isProxy(entry)) throw invalid();
        const descriptors = Object.getOwnPropertyDescriptors(entry);
        if (Reflect.ownKeys(descriptors).some((key) => key !== "reasoningEffort"
          || !("value" in descriptors[key]))) throw invalid();
        return descriptors.reasoningEffort?.value;
      });
    }
    result.efforts = normalizeReasoningEfforts(efforts);
  } else {
    result.efforts = Object.freeze([]);
  }
  if (raw.serviceTiers !== undefined) {
    const tiers = denseArray(raw.serviceTiers, 16).map((entry) => {
      const tier = ownData(entry, new Set(["id", "name", "description"]), ["id", "name"]);
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(tier.id)) throw invalid();
      return Object.freeze({
        id: tier.id,
        name: safeText(tier.name, 160),
      });
    });
    if (new Set(tiers.map(({ id }) => id)).size !== tiers.length) throw invalid();
    result.serviceTiers = Object.freeze(tiers);
  } else result.serviceTiers = Object.freeze([]);
  const defaultReasoningEffort = raw.defaultReasoningEffort ?? result.efforts[0] ?? "none";
  if (typeof defaultReasoningEffort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(defaultReasoningEffort)) throw invalid();
  if (result.efforts.length > 0 && !result.efforts.includes(defaultReasoningEffort)) throw invalid();
  result.defaultReasoningEffort = defaultReasoningEffort;
  const defaultServiceTier = raw.defaultServiceTier ?? null;
  if (!(defaultServiceTier === null || (typeof defaultServiceTier === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(defaultServiceTier)))) throw invalid();
  if (defaultServiceTier !== null && !result.serviceTiers.some(({ id }) => id === defaultServiceTier)) throw invalid();
  result.defaultServiceTier = defaultServiceTier;
  const catalogGeneration = raw.catalogGeneration ?? 0;
  if (!Number.isSafeInteger(catalogGeneration) || catalogGeneration < 0) throw invalid();
  result.catalogGeneration = catalogGeneration;
  if (raw.isDefault !== undefined && typeof raw.isDefault !== "boolean") throw invalid();
  result.isDefault = raw.isDefault ?? false;
  return Object.freeze(result);
}

function normalizeConnection(value) {
  const raw = ownData(value, CONNECTION_FIELDS, ["providerId", "generation", "state", "models"]);
  if (!PROVIDERS.has(raw.providerId) || !Number.isSafeInteger(raw.generation) || raw.generation < 0
    || !CONNECTION_STATES.has(raw.state)) throw invalid();
  const models = denseArray(raw.models, MAX_MODELS).map(normalizeModel);
  const result = {
    providerId: raw.providerId,
    generation: raw.generation,
    state: raw.state,
    models: Object.freeze(models),
  };
  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== "string" || !BASE_URL.test(raw.baseUrl)) throw invalid();
    const url = new URL(raw.baseUrl);
    if (url.username || url.password || url.search || url.hash) throw invalid();
    result.baseUrl = url.href.replace(/\/$/, "");
  }
  if (raw.secretRef !== undefined) {
    if (typeof raw.secretRef !== "string" || !SAFE_REF.test(raw.secretRef)) throw invalid();
    result.secretRef = raw.secretRef;
  }
  if (raw.authType !== undefined) result.authType = safeText(raw.authType, 64);
  if (raw.connectedAt !== undefined) result.connectedAt = timestamp(raw.connectedAt);
  if (raw.errorCode !== undefined) {
    if (typeof raw.errorCode !== "string" || !SAFE_CODE.test(raw.errorCode)) throw invalid();
    result.errorCode = raw.errorCode;
  }
  return Object.freeze(result);
}

function normalizeReceipt(value) {
  const raw = ownData(value, RECEIPT_FIELDS, ["schemaVersion", "providerId", "connectionGeneration", "completedAt"]);
  if (raw.schemaVersion !== SCHEMA_VERSION || !PROVIDERS.has(raw.providerId)
    || !Number.isSafeInteger(raw.connectionGeneration) || raw.connectionGeneration < 0) throw invalid();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    providerId: raw.providerId,
    connectionGeneration: raw.connectionGeneration,
    completedAt: timestamp(raw.completedAt),
  });
}

function normalizeState(value) {
  const raw = ownData(value, STATE_FIELDS, ["schemaVersion", "connections", "onboarding"]);
  if (raw.schemaVersion !== SCHEMA_VERSION) throw invalid();
  const connections = denseArray(raw.connections, MAX_CONNECTIONS).map(normalizeConnection);
  const seen = new Set();
  for (const connection of connections) {
    if (seen.has(connection.providerId)) throw invalid();
    seen.add(connection.providerId);
  }
  const onboarding = raw.onboarding === null ? null : normalizeReceipt(raw.onboarding);
  if (onboarding) {
    const connection = connections.find(({ providerId }) => providerId === onboarding.providerId);
    if (!connection || connection.state !== "connected"
      || connection.generation !== onboarding.connectionGeneration) throw invalid();
  }
  connections.sort((left, right) => PROVIDER_IDS.indexOf(left.providerId) - PROVIDER_IDS.indexOf(right.providerId));
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, connections: Object.freeze(connections), onboarding });
}

function emptyState() {
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, connections: Object.freeze([]), onboarding: null });
}

function cloneState(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneState));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneState(nested)])));
}

class ProviderStateStore {
  #filePath;
  #fs;
  #randomUUID;
  #queue = Promise.resolve();

  constructor(rawOptions = {}) {
    const options = ownData(rawOptions, new Set(["filePath", "fs", "randomUUID"]), ["filePath"]);
    if (typeof options.filePath !== "string" || !path.isAbsolute(options.filePath)
      || (options.fs !== undefined && (!options.fs || typeof options.fs.lstat !== "function"
        || typeof options.fs.readFile !== "function" || typeof options.fs.mkdir !== "function"
        || typeof options.fs.open !== "function"))
      || (options.randomUUID !== undefined && typeof options.randomUUID !== "function")) throw invalid();
    this.#filePath = options.filePath;
    this.#fs = options.fs || fs;
    this.#randomUUID = options.randomUUID || randomUUID;
  }

  read() {
    return this.#enqueue(async () => cloneState(await this.#readState()));
  }

  commitConnection(rawValue) {
    let value;
    try { value = normalizeConnection(rawValue); } catch { return Promise.reject(invalid()); }
    return this.#mutate((state) => {
      const next = state.connections.filter(({ providerId }) => providerId !== value.providerId);
      next.push(value);
      state.connections = next;
      if (state.onboarding && state.onboarding.providerId === value.providerId
        && (value.state !== "connected" || value.generation !== state.onboarding.connectionGeneration)) {
        state.onboarding = null;
      }
      return value;
    });
  }

  removeConnection(rawProviderId) {
    if (typeof rawProviderId !== "string" || !PROVIDERS.has(rawProviderId)) return Promise.reject(invalid());
    return this.#mutate((state) => {
      state.connections = state.connections.filter(({ providerId }) => providerId !== rawProviderId);
      if (state.onboarding?.providerId === rawProviderId) state.onboarding = null;
      return null;
    });
  }

  writeOnboarding(rawReceipt) {
    let receipt;
    try { receipt = normalizeReceipt(rawReceipt); } catch { return Promise.reject(invalid()); }
    return this.#mutate((state) => {
      const connection = state.connections.find(({ providerId }) => providerId === receipt.providerId);
      if (!connection || connection.state !== "connected"
        || connection.generation !== receipt.connectionGeneration) throw invalid();
      state.onboarding = receipt;
      return receipt;
    });
  }

  clearOnboardingFor(rawProviderId) {
    if (typeof rawProviderId !== "string" || !PROVIDERS.has(rawProviderId)) return Promise.reject(invalid());
    return this.#mutate((state) => {
      if (state.onboarding?.providerId === rawProviderId) state.onboarding = null;
      return null;
    });
  }

  #enqueue(operation) {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #mutate(operation) {
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const mutable = {
        schemaVersion: state.schemaVersion,
        connections: [...state.connections],
        onboarding: state.onboarding,
      };
      const result = operation(mutable);
      const normalized = normalizeState(mutable);
      await this.#writeState(normalized);
      return cloneState(result);
    });
  }

  async #readState() {
    let stat;
    try { stat = await this.#fs.lstat(this.#filePath); }
    catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw new ProviderStateStoreError();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES
      || (stat.mode & 0o777) !== 0o600) throw new ProviderStateStoreError();
    let source;
    try { source = await this.#fs.readFile(this.#filePath, "utf8"); }
    catch { throw new ProviderStateStoreError(); }
    if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) throw new ProviderStateStoreError();
    try { return normalizeState(JSON.parse(source)); } catch { throw new ProviderStateStoreError(); }
  }

  async #writeState(state) {
    const directory = path.dirname(this.#filePath);
    try {
      await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 });
      let directoryStat = await this.#fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("unsafe directory");
      await this.#fs.chmod(directory, 0o700);
      directoryStat = await this.#fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (directoryStat.mode & 0o777) !== 0o700) throw new Error("unsafe directory");
    } catch { throw new ProviderStateStoreError(); }
    let id;
    try { id = this.#randomUUID(); } catch { throw new ProviderStateStoreError(); }
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new ProviderStateStoreError();
    const temporary = path.join(directory, `.${path.basename(this.#filePath)}.${id}.tmp`);
    let handle = null;
    try {
      handle = await this.#fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#fs.rename(temporary, this.#filePath);
      await this.#fs.chmod(this.#filePath, 0o600);
      const stat = await this.#fs.lstat(this.#filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("unsafe file");
    } catch {
      try { await handle?.close(); } catch { /* best effort */ }
      try { await this.#fs.rm(temporary, { force: true }); } catch { /* best effort */ }
      throw new ProviderStateStoreError();
    }
  }
}

module.exports = {
  PROVIDER_STATE_SCHEMA_VERSION: SCHEMA_VERSION,
  ProviderStateStore,
  ProviderStateStoreError,
  normalizeConnection,
  normalizeState,
};
