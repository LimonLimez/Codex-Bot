"use strict";

const nodeFs = require("node:fs");
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
const RECEIPT_FIELDS = new Set(["schemaVersion", "providerId", "connectionGeneration", "catalogGeneration", "completedAt"]);
const STATE_FIELDS = new Set(["schemaVersion", "connections", "onboarding"]);
const PRIVATE_MODE = 0o700;
const FILE_MODE = 0o600;
const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : -1;
const OPEN_DIRECTORY_FLAGS = nodeFs.constants.O_RDONLY
  | nodeFs.constants.O_DIRECTORY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC;
const OPEN_FILE_FLAGS = nodeFs.constants.O_RDONLY
  | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC;

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
  if (models.some(({ provider }) => provider !== raw.providerId)) throw invalid();
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
  const raw = ownData(value, RECEIPT_FIELDS, ["schemaVersion", "providerId", "connectionGeneration", "catalogGeneration", "completedAt"]);
  if (raw.schemaVersion !== SCHEMA_VERSION || !PROVIDERS.has(raw.providerId)
    || !Number.isSafeInteger(raw.connectionGeneration) || raw.connectionGeneration < 0
    || !Number.isSafeInteger(raw.catalogGeneration) || raw.catalogGeneration < 0) throw invalid();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    providerId: raw.providerId,
    connectionGeneration: raw.connectionGeneration,
    catalogGeneration: raw.catalogGeneration,
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
    const catalogGeneration = connections
      .filter((connection) => connection.state === "connected")
      .reduce((highest, connection) => Math.max(highest, connection.generation), 0);
    if (!connection || connection.state !== "connected"
      || connection.generation !== onboarding.connectionGeneration
      || onboarding.catalogGeneration !== catalogGeneration) throw invalid();
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

function statTime(stat, field) {
  const ns = stat[`${field}Ns`];
  if (typeof ns === "bigint") return ns;
  const ms = stat[`${field}Ms`];
  if (typeof ms === "bigint") return ms * 1_000_000n;
  if (Number.isFinite(ms)) return BigInt(Math.trunc(ms * 1_000_000));
  throw new Error("stat time unavailable");
}

function privateDirectoryIdentity(stat) {
  const bad = !stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()
    || typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()
    || (BigInt(stat.mode) & 0o7777n) !== BigInt(PRIVATE_MODE)
    || CURRENT_UID < 0 || BigInt(stat.uid) !== BigInt(CURRENT_UID);
  if (bad) {
    throw invalid();
  }
  return Object.freeze({
    dev: BigInt(stat.dev), ino: BigInt(stat.ino), uid: BigInt(stat.uid),
    mode: BigInt(stat.mode), birthtime: statTime(stat, "birthtime"),
  });
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.birthtime === right.birthtime;
}

function regularFileIdentity(stat, directory, maximum = MAX_FILE_BYTES) {
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()
    || typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()
    || BigInt(stat.dev) !== directory.dev || BigInt(stat.uid) !== directory.uid
    || (BigInt(stat.mode) & 0o7777n) !== BigInt(FILE_MODE)
    || BigInt(stat.nlink) !== 1n || BigInt(stat.size) < 0n
    || BigInt(stat.size) > BigInt(maximum)) throw invalid();
  return Object.freeze({
    dev: BigInt(stat.dev), ino: BigInt(stat.ino), uid: BigInt(stat.uid), mode: BigInt(stat.mode),
    nlink: BigInt(stat.nlink), size: BigInt(stat.size), birthtime: statTime(stat, "birthtime"),
    mtime: statTime(stat, "mtime"), ctime: statTime(stat, "ctime"),
  });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.birthtime === right.birthtime && left.mtime === right.mtime && left.ctime === right.ctime;
}

function canonicalPathEquivalent(requested, canonical) {
  if (requested === canonical) return true;
  // macOS exposes /tmp and /var through the stable /private namespace. This
  // kernel-owned alias is not a user-controlled parent substitution.
  return (requested.startsWith("/var/") || requested.startsWith("/tmp/"))
    && canonical === `/private${requested}`;
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

  removeConnectionAndOnboarding(rawProviderId) {
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
      const catalogGeneration = state.connections
        .filter((entry) => entry.state === "connected")
        .reduce((highest, entry) => Math.max(highest, entry.generation), 0);
      if (!connection || connection.state !== "connected"
        || connection.generation !== receipt.connectionGeneration
        || receipt.catalogGeneration !== catalogGeneration) throw invalid();
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
    let directory;
    try { directory = await this.#openDirectory(); }
    catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw new ProviderStateStoreError();
    }
    try {
      await this.#assertDirectory(directory);
      const target = await this.#readTarget(directory);
      await this.#assertDirectory(directory);
      return target.missing ? emptyState() : normalizeState(JSON.parse(target.source));
    } catch (error) {
      if (error instanceof ProviderStateStoreError) throw error;
      throw new ProviderStateStoreError();
    } finally {
      try { await directory.handle.close(); } catch {}
    }
  }

  async #writeState(state) {
    const directory = path.dirname(this.#filePath);
    try { await this.#fs.mkdir(directory, { recursive: true, mode: PRIVATE_MODE }); }
    catch { throw new ProviderStateStoreError(); }
    let directoryContext;
    try { directoryContext = await this.#openDirectory(); }
    catch { throw new ProviderStateStoreError(); }
    const source = `${JSON.stringify(state)}\n`;
    const bytes = Buffer.from(source, "utf8");
    if (bytes.length > MAX_FILE_BYTES) {
      try { await directoryContext.handle.close(); } catch {}
      throw new ProviderStateStoreError();
    }
    let id;
    try { id = this.#randomUUID(); } catch { throw new ProviderStateStoreError(); }
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new ProviderStateStoreError();
    const temporary = path.join(directoryContext.stablePath, `.${path.basename(this.#filePath)}.${id}.tmp`);
    let handle = null;
    let renamed = false;
    try {
      await this.#assertDirectory(directoryContext);
      const before = await this.#targetSnapshot(directoryContext);
      handle = await this.#fs.open(temporary,
        nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL
          | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC,
        FILE_MODE);
      const created = regularFileIdentity(await handle.stat({ bigint: true }), directoryContext.identity);
      const namedCreated = regularFileIdentity(await this.#fs.lstat(temporary, { bigint: true }), directoryContext.identity);
      if (!sameFile(created, namedCreated) || created.size !== 0n) throw new Error("temporary identity");
      await this.#writeExact(handle, bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      const synced = regularFileIdentity(await this.#fs.lstat(temporary, { bigint: true }), directoryContext.identity);
      if (synced.size !== BigInt(bytes.length)) throw new Error("temporary size");
      await this.#assertTargetUnchanged(directoryContext, before);
      await this.#assertDirectory(directoryContext);
      try {
        await this.#fs.rename(temporary, path.join(directoryContext.stablePath, path.basename(this.#filePath)));
        renamed = true;
      } catch {
        const uncertain = await this.#readTarget(directoryContext);
        if (uncertain.missing || uncertain.source !== source) throw new Error("rename uncertain");
        renamed = true;
      }
      try { await directoryContext.handle.sync(); }
      catch {
        const uncertain = await this.#readTarget(directoryContext);
        if (uncertain.missing || uncertain.source !== source) throw new Error("commit uncertain");
      }
      const committed = await this.#readTarget(directoryContext);
      if (committed.missing || committed.source !== source) throw new Error("commit readback");
    } catch {
      try { await handle?.close(); } catch { /* best effort */ }
      if (renamed) {
        try {
          const committed = await this.#readTarget(directoryContext);
          if (!committed.missing && committed.source === source) {
            try { await directoryContext.handle.close(); } catch {}
            return;
          }
        } catch { /* preserve failure below */ }
      }
      try { await this.#unlinkOwnedTemporary(directoryContext, temporary); } catch { /* best effort */ }
      try { await directoryContext.handle.close(); } catch {}
      throw new ProviderStateStoreError();
    }
    try { await directoryContext.handle.close(); } catch {}
  }

  async #openDirectory() {
    const directoryPath = path.dirname(this.#filePath);
    let canonical;
    try { canonical = nodeFs.realpathSync.native(directoryPath); } catch (error) { throw error; }
    if (!canonicalPathEquivalent(directoryPath, canonical) || path.normalize(canonical) !== canonical) throw invalid();
    const named = privateDirectoryIdentity(await this.#fs.lstat(directoryPath, { bigint: true }));
    const handle = await this.#fs.open(directoryPath, OPEN_DIRECTORY_FLAGS);
    try {
      const opened = privateDirectoryIdentity(await handle.stat({ bigint: true }));
      if (!sameDirectory(named, opened)) throw new Error("directory identity");
      return { path: directoryPath, stablePath: this.#stableDirectoryPath(directoryPath, opened), handle, identity: opened };
    } catch (error) {
      try { await handle.close(); } catch {}
      throw error;
    }
  }

  async #assertDirectory(context) {
    const canonical = nodeFs.realpathSync.native(context.path);
    if (!canonicalPathEquivalent(context.path, canonical)) throw new Error("directory replaced");
    const opened = privateDirectoryIdentity(await context.handle.stat({ bigint: true }));
    const named = privateDirectoryIdentity(await this.#fs.lstat(context.path, { bigint: true }));
    const stable = privateDirectoryIdentity(await this.#fs.lstat(context.stablePath, { bigint: true }));
    if (!sameDirectory(context.identity, opened) || !sameDirectory(opened, named)
      || !sameDirectory(opened, stable)) throw new Error("directory identity");
  }

  #stableDirectoryPath(directoryPath, identity) {
    try {
      const candidate = `/.vol/${identity.dev}/${identity.ino}`;
      const stat = nodeFs.lstatSync(candidate, { bigint: true });
      nodeFs.realpathSync.native(candidate);
      if (sameDirectory(identity, privateDirectoryIdentity(stat))) return candidate;
    } catch { /* non-macOS hosts use the verified canonical path */ }
    return directoryPath;
  }

  async #readTarget(context) {
    let before;
    const target = path.join(context.stablePath, path.basename(this.#filePath));
    try { before = regularFileIdentity(await this.#fs.lstat(target, { bigint: true }), context.identity); }
    catch (error) { if (error?.code === "ENOENT") return { missing: true }; throw error; }
    let handle;
    try {
      handle = await this.#fs.open(target, OPEN_FILE_FLAGS);
      const opened = regularFileIdentity(await handle.stat({ bigint: true }), context.identity);
      if (!sameFile(before, opened)) throw new Error("file identity");
      const bytes = await this.#readBounded(handle);
      const finished = regularFileIdentity(await handle.stat({ bigint: true }), context.identity);
      const named = regularFileIdentity(await this.#fs.lstat(target, { bigint: true }), context.identity);
      if (!sameFile(before, finished) || !sameFile(before, named) || BigInt(bytes.length) !== before.size) throw new Error("file changed");
      const source = bytes.toString("utf8");
      if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("invalid utf8");
      return { missing: false, source };
    } finally { try { await handle?.close(); } catch {} }
  }

  async #readBounded(handle) {
    const chunks = [];
    let total = 0;
    while (true) {
      const room = MAX_FILE_BYTES + 1 - total;
      if (room <= 0) throw new Error("state too large");
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, room));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > buffer.length) throw new Error("read");
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > MAX_FILE_BYTES) throw new Error("state too large");
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, total);
  }

  async #writeExact(handle, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, null);
      if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0
        || result.bytesWritten > bytes.length - offset) throw new Error("write");
      offset += result.bytesWritten;
    }
  }

  async #targetSnapshot(context) {
    const target = path.join(context.stablePath, path.basename(this.#filePath));
    try { return regularFileIdentity(await this.#fs.lstat(target, { bigint: true }), context.identity); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async #assertTargetUnchanged(context, before) {
    const after = await this.#targetSnapshot(context);
    if (before === null ? after !== null : after === null || !sameFile(before, after)) throw new Error("target changed");
  }

  async #unlinkOwnedTemporary(context, temporary) {
    try {
      const stat = regularFileIdentity(await this.#fs.lstat(temporary, { bigint: true }), context.identity);
      if (stat.nlink !== 1n) return;
      await this.#fs.rm(temporary, { force: true });
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

module.exports = {
  PROVIDER_STATE_SCHEMA_VERSION: SCHEMA_VERSION,
  ProviderStateStore,
  ProviderStateStoreError,
  normalizeConnection,
  normalizeState,
};
