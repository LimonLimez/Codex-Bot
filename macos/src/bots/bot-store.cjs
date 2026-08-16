"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const MAX_BOTS = 4096;
const MAX_CONVERSATIONS = 2048;
const MAX_NAME_LENGTH = 160;
const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_AVATAR_DATA_LENGTH = 2_000_000;
const MAX_AVATAR_URL_LENGTH = 2048;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PROTOTYPE_SENSITIVE_MIGRATION_KEYS = new Set([
  ...DANGEROUS_KEYS,
  "toString",
  "hasOwnProperty",
]);
const APPEARANCE_FIELDS = new Set(["shape", "color", "image", "title", "description"]);
const PROFILE_FIELDS = new Set(["appearance", "notifications"]);
const RUNTIME_FIELDS = new Set(["provider", "remoteRuntimeId", "state", "lastConfirmedAt", "lastErrorCode"]);
const RUNTIME_TRANSACTION_FIELDS = new Set(["expectedLastErrorCode", "afterCommit"]);
const COMPUTER_FIELDS = new Set([
  "mode",
  "generation",
  "localProfileId",
  "nativeAgentId",
  "state",
  "lastConfirmedAt",
  "lastErrorCode",
]);
const COMPUTER_MODES = new Set(["not-now", "local", "cursor"]);
const COMPUTER_STATES = new Set(["unconfigured", "starting", "ready", "reconnecting", "unavailable"]);
const BOT_FIELDS = new Set([
  "schemaVersion",
  "botId",
  "name",
  "appearance",
  "notifications",
  "createdAt",
  "updatedAt",
  "conversations",
  "runtime",
  "computer",
]);
const LEGACY_BOT_FIELDS = new Set([...BOT_FIELDS].filter((field) => field !== "computer"));
const STORE_FIELDS = new Set(["schemaVersion", "bots", "legacyImports"]);
const LEGACY_FIELDS = new Set(["migrationKey", "name", "appearance", "notifications", "conversations"]);
const LEGACY_IMPORT_FIELDS = new Set(["botId", "fingerprint"]);
const RUNTIME_STATES = new Set([
  "unprovisioned",
  "provisioning",
  "ready",
  "reconnecting",
  "failed",
  "unavailable",
  "detached",
  "retired",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOT_ID_PATTERN = /^bot-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_APPEARANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MIGRATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATH_QUEUES = new Map();
const PATH_RUNTIME_REVISIONS = new Map();
const ACTIVE_RUNTIME_TRANSACTIONS = new Map();
const RUNTIME_TRANSACTION_CONTEXT = new AsyncLocalStorage();
const RUNTIME_COMMIT_RECEIPTS = new WeakMap();

const DEFAULT_APPEARANCE = Object.freeze({
  shape: "blob",
  color: "red",
  image: null,
  title: "",
  description: "",
});

const DEFAULT_RUNTIME = Object.freeze({
  provider: null,
  remoteRuntimeId: null,
  state: "unprovisioned",
  lastConfirmedAt: null,
  lastErrorCode: null,
});

const DEFAULT_COMPUTER = Object.freeze({
  mode: "not-now",
  generation: 0,
  localProfileId: null,
  nativeAgentId: null,
  state: "unconfigured",
  lastConfirmedAt: null,
  lastErrorCode: null,
});

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function cloneData(value, seen = new Map()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") throw new TypeError("Bot data must contain plain data values only.");
  if (seen.has(value)) throw new TypeError("Bot data cannot contain cycles.");

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Bot data must use plain objects and arrays without custom prototypes.");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("Bot data cannot contain symbol fields.");
  }
  for (const key of ownKeys) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError("Bot data contains a forbidden prototype field.");
    if (!("value" in descriptors[key])) throw new TypeError("Bot data must not contain accessors.");
  }

  if (array) {
    const elementKeys = ownKeys.filter((key) => key !== "length");
    if (elementKeys.length !== value.length
      || elementKeys.some((key, index) => key !== String(index))) {
      throw new TypeError("Bot data arrays must be dense plain arrays.");
    }
  }

  const clone = array ? [] : (prototype === null ? Object.create(null) : {});
  seen.set(value, clone);
  for (const key of ownKeys) {
    if (array && key === "length") continue;
    clone[key] = cloneData(descriptors[key].value, seen);
  }
  seen.delete(value);
  return clone;
}

function publicSnapshot(value) {
  return deepFreeze(cloneData(value));
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) throw new Error(`${label} contains a forbidden prototype field.`);
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported ${label.toLowerCase()} field: ${key}.`);
  }
}

function assertExactKeys(value, allowed, label) {
  assertAllowedKeys(value, allowed, label);
  for (const key of allowed) {
    if (!hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function normalizeTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!validTimestamp(value)) throw new Error(`${label} must be a valid timestamp.`);
  return value;
}

function normalizeText(value, label, maximum, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0)
    || value.includes("\0")) {
    throw new Error(`${label} is invalid or exceeds ${maximum} characters.`);
  }
  return value;
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) {
    throw new Error("Bot ID is invalid.");
  }
  return value.toLowerCase();
}

function normalizeIdentifier(value, label, { nullable = false, errorCode = false } = {}) {
  if (nullable && value === null) return null;
  const pattern = errorCode ? ERROR_CODE_PATTERN : SAFE_IDENTIFIER_PATTERN;
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function normalizeAvatarImage(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Avatar image must be null, an HTTPS URL, or an image data URL.");
  if (value.startsWith("data:")) {
    if (value.length > MAX_AVATAR_DATA_LENGTH
      || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error("Avatar image data URL is invalid or oversized.");
    }
    const encoded = value.slice(value.indexOf(",") + 1);
    if (encoded.length % 4 !== 0) throw new Error("Avatar image data URL is invalid.");
    return value;
  }
  if (value.length > MAX_AVATAR_URL_LENGTH) throw new Error("Avatar image HTTPS URL is oversized.");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Avatar image must use a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Avatar image must use a credential-free HTTPS URL.");
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(?:token|auth|credential|password|secret|signature|api.?key)/i.test(key)) {
      throw new Error("Avatar image HTTPS URL cannot contain credential material.");
    }
  }
  return value;
}

function normalizeAppearance(value, { partial = false } = {}) {
  const appearance = assertPlainObject(value, "Appearance");
  assertAllowedKeys(appearance, APPEARANCE_FIELDS, "Appearance");
  const normalized = partial ? {} : { ...DEFAULT_APPEARANCE };
  if (hasOwn(appearance, "shape")) {
    if (typeof appearance.shape !== "string" || !SAFE_APPEARANCE_ID_PATTERN.test(appearance.shape)) {
      throw new Error("Appearance shape is invalid.");
    }
    normalized.shape = appearance.shape;
  }
  if (hasOwn(appearance, "color")) {
    if (typeof appearance.color !== "string" || !SAFE_APPEARANCE_ID_PATTERN.test(appearance.color)) {
      throw new Error("Appearance color is invalid.");
    }
    normalized.color = appearance.color;
  }
  if (hasOwn(appearance, "image")) normalized.image = normalizeAvatarImage(appearance.image);
  if (hasOwn(appearance, "title")) normalized.title = normalizeText(appearance.title, "Appearance title", MAX_TITLE_LENGTH);
  if (hasOwn(appearance, "description")) {
    normalized.description = normalizeText(appearance.description, "Appearance description", MAX_DESCRIPTION_LENGTH);
  }
  return normalized;
}

function selectedOwnDataField(value, key, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError(`${label} could not safely inspect ${key}.`);
  }
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor)) throw new TypeError(`${label} ${key} must be plain data, not an accessor.`);
  return { present: true, value: descriptor.value };
}

function normalizeRuntimeTransactionOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Runtime transaction options must be a plain object.");
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("Runtime transaction options could not be inspected safely.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Runtime transaction options must be a plain object.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Runtime transaction options cannot contain symbol fields.");
  }
  const normalized = {};
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new TypeError("Runtime transaction options contain a forbidden prototype field.");
    }
    if (!RUNTIME_TRANSACTION_FIELDS.has(key)) {
      throw new Error(`Runtime transaction options contain an unsupported runtime transaction options field: ${key}.`);
    }
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw new TypeError(`Runtime transaction options ${key} must be plain data, not an accessor.`);
    }
    normalized[key] = descriptor.value;
  }
  if (hasOwn(normalized, "afterCommit") && typeof normalized.afterCommit !== "function") {
    throw new TypeError("Runtime transaction afterCommit must be a function.");
  }
  return normalized;
}

function invokeAfterCommit(afterCommit) {
  if (typeof afterCommit !== "function") return;
  try {
    const result = afterCommit();
    void Promise.resolve(result).catch(() => {});
  } catch {
    // A post-commit observer cannot change durable state or retain the path lock.
  }
}

function normalizeCreateAppearance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Create appearance must be an object.");
  }
  const selected = {};
  for (const key of APPEARANCE_FIELDS) {
    const field = selectedOwnDataField(value, key, "Create appearance");
    if (field.present) selected[key] = field.value;
  }
  return normalizeAppearance(selected);
}

function normalizeCreateInput(value) {
  if (value === undefined) return { appearance: { ...DEFAULT_APPEARANCE }, notifications: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Create input must be an object.");
  }
  const appearanceField = selectedOwnDataField(value, "appearance", "Create input");
  const notificationsField = selectedOwnDataField(value, "notifications", "Create input");
  const notifications = notificationsField.present ? notificationsField.value : true;
  if (typeof notifications !== "boolean") throw new Error("Bot notifications must be boolean.");
  return {
    appearance: appearanceField.present ? normalizeCreateAppearance(appearanceField.value) : { ...DEFAULT_APPEARANCE },
    notifications,
  };
}

function normalizeConversationRef(value) {
  const ref = assertPlainObject(value, "Conversation reference");
  if (ref.source === "chatgpt") {
    assertExactKeys(ref, new Set(["source", "conversationId"]), "Conversation");
    return {
      source: "chatgpt",
      conversationId: normalizeIdentifier(ref.conversationId, "ChatGPT conversation ID"),
    };
  }
  if (ref.source === "codex") {
    assertExactKeys(ref, new Set(["source", "threadId"]), "Conversation");
    return {
      source: "codex",
      threadId: normalizeIdentifier(ref.threadId, "Codex thread ID"),
    };
  }
  throw new Error("Conversation reference must be canonical ChatGPT or Codex data.");
}

function conversationKey(ref) {
  return ref.source === "chatgpt" ? `chatgpt:${ref.conversationId}` : `codex:${ref.threadId}`;
}

function normalizeRuntime(value) {
  const runtime = assertPlainObject(value, "Runtime");
  assertExactKeys(runtime, RUNTIME_FIELDS, "Runtime");
  const normalized = {
    provider: normalizeIdentifier(runtime.provider, "Runtime provider", { nullable: true }),
    remoteRuntimeId: normalizeIdentifier(runtime.remoteRuntimeId, "Remote runtime ID", { nullable: true }),
    state: runtime.state,
    lastConfirmedAt: normalizeTimestamp(runtime.lastConfirmedAt, "Runtime confirmation", { nullable: true }),
    lastErrorCode: normalizeIdentifier(runtime.lastErrorCode, "Runtime error code", { nullable: true, errorCode: true }),
  };
  if (!RUNTIME_STATES.has(normalized.state)) throw new Error("Runtime state is invalid.");
  if (normalized.remoteRuntimeId && !normalized.provider) throw new Error("A remote runtime ID requires a provider.");
  if (normalized.state === "ready" && (!normalized.provider || !normalized.remoteRuntimeId)) {
    throw new Error("A ready runtime requires provider ownership and a remote runtime ID.");
  }
  if (normalized.state === "unprovisioned"
    && (normalized.provider !== null || normalized.remoteRuntimeId !== null
      || normalized.lastConfirmedAt !== null || normalized.lastErrorCode !== null)) {
    throw new Error("An unprovisioned runtime cannot contain remote metadata.");
  }
  return normalized;
}

function normalizeComputer(value) {
  const computer = assertPlainObject(value, "Computer");
  assertExactKeys(computer, COMPUTER_FIELDS, "Computer");
  if (!COMPUTER_MODES.has(computer.mode)) throw new Error("Computer mode is invalid.");
  if (!Number.isSafeInteger(computer.generation) || computer.generation < 0) {
    throw new Error("Computer generation is invalid.");
  }
  const localProfileId = computer.localProfileId === null
    ? null
    : normalizeIdentifier(computer.localProfileId, "Local profile ID");
  if (localProfileId !== null && !/^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localProfileId)) {
    throw new Error("Local profile ID is invalid.");
  }
  const nativeAgentId = normalizeIdentifier(computer.nativeAgentId, "Native agent ID", { nullable: true });
  if (!COMPUTER_STATES.has(computer.state)) throw new Error("Computer state is invalid.");
  const normalized = {
    mode: computer.mode,
    generation: computer.generation,
    localProfileId: localProfileId?.toLowerCase() ?? null,
    nativeAgentId,
    state: computer.state,
    lastConfirmedAt: normalizeTimestamp(computer.lastConfirmedAt, "Computer confirmation", { nullable: true }),
    lastErrorCode: normalizeIdentifier(computer.lastErrorCode, "Computer error code", { nullable: true, errorCode: true }),
  };
  if (normalized.mode === "local" && normalized.localProfileId === null) {
    throw new Error("Local Computer mode requires a local profile ID.");
  }
  if (normalized.mode === "cursor" && normalized.nativeAgentId === null) {
    throw new Error("Cursor Computer mode requires a native agent ID.");
  }
  if (normalized.mode === "not-now" && normalized.state !== "unconfigured") {
    throw new Error("Not-now Computer mode must remain unconfigured.");
  }
  if (normalized.state === "ready" && normalized.lastConfirmedAt === null) {
    throw new Error("A ready Computer target requires confirmation.");
  }
  if (normalized.state === "unconfigured"
    && (normalized.lastConfirmedAt !== null || normalized.lastErrorCode !== null)) {
    throw new Error("An unconfigured Computer target cannot contain status metadata.");
  }
  return normalized;
}

function normalizeBotRecord(value) {
  const record = assertPlainObject(value, "Bot");
  assertExactKeys(record, BOT_FIELDS, "Bot");
  if (record.schemaVersion !== SCHEMA_VERSION) throw new Error("Bot schema version is unsupported.");
  if (typeof record.notifications !== "boolean") throw new Error("Bot notifications must be boolean.");
  if (!Array.isArray(record.conversations) || record.conversations.length > MAX_CONVERSATIONS) {
    throw new Error("Bot conversations are invalid or oversized.");
  }
  const createdAt = normalizeTimestamp(record.createdAt, "Bot createdAt");
  const updatedAt = normalizeTimestamp(record.updatedAt, "Bot updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Bot updatedAt cannot precede createdAt timestamp.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    botId: normalizeBotId(record.botId),
    name: normalizeText(record.name, "Bot name", MAX_NAME_LENGTH, { allowEmpty: false }),
    appearance: normalizeAppearance(record.appearance),
    notifications: record.notifications,
    createdAt,
    updatedAt,
    conversations: record.conversations.map(normalizeConversationRef),
    runtime: normalizeRuntime(record.runtime),
    computer: normalizeComputer(record.computer),
  };
}

function migrateLegacyStore(value) {
  const store = assertPlainObject(value, "Store");
  assertExactKeys(store, STORE_FIELDS, "Store");
  if (store.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    throw new Error("Unsupported bot store schema version.");
  }
  if (!Array.isArray(store.bots) || store.bots.length > MAX_BOTS) {
    throw new Error("Bot store bots are invalid or oversized.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    bots: store.bots.map((rawBot) => {
      const bot = assertPlainObject(rawBot, "Bot");
      assertExactKeys(bot, LEGACY_BOT_FIELDS, "Bot");
      if (bot.schemaVersion !== LEGACY_SCHEMA_VERSION) {
        throw new Error("Bot schema version is unsupported.");
      }
      return {
        ...bot,
        schemaVersion: SCHEMA_VERSION,
        computer: { ...DEFAULT_COMPUTER },
      };
    }),
    legacyImports: store.legacyImports,
  };
}

function normalizeLoadedStore(value) {
  if (value?.schemaVersion === LEGACY_SCHEMA_VERSION) {
    return normalizeStore(migrateLegacyStore(value));
  }
  return normalizeStore(value);
}

function normalizeMigrationKey(value) {
  if (typeof value !== "string" || !MIGRATION_KEY_PATTERN.test(value)
    || PROTOTYPE_SENSITIVE_MIGRATION_KEYS.has(value)) {
    throw new Error("Legacy migration key is invalid.");
  }
  return value;
}

function normalizeStore(value) {
  const store = assertPlainObject(value, "Store");
  assertExactKeys(store, STORE_FIELDS, "Store");
  if (store.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported bot store schema version.");
  if (!Array.isArray(store.bots) || store.bots.length > MAX_BOTS) throw new Error("Bot store bots are invalid or oversized.");
  const bots = store.bots.map(normalizeBotRecord);
  const botIds = new Set();
  const runtimeOwners = new Map();
  const conversationOwners = new Map();
  for (const bot of bots) {
    if (botIds.has(bot.botId)) throw new Error("Bot store contains duplicate bot IDs.");
    botIds.add(bot.botId);
    if (bot.runtime.remoteRuntimeId) {
      if (runtimeOwners.has(bot.runtime.remoteRuntimeId)) throw new Error("Bot store contains duplicate remote runtime IDs.");
      runtimeOwners.set(bot.runtime.remoteRuntimeId, bot.botId);
    }
    for (const ref of bot.conversations) {
      const key = conversationKey(ref);
      if (conversationOwners.has(key)) {
        const owner = conversationOwners.get(key);
        if (owner === bot.botId) throw new Error("Bot store contains a duplicate conversation reference.");
        throw new Error("A conversation is already owned by another bot.");
      }
      conversationOwners.set(key, bot.botId);
    }
  }

  const imports = assertPlainObject(store.legacyImports, "Legacy imports");
  const legacyImports = Object.create(null);
  const importedBots = new Set();
  for (const [migrationKey, rawEntry] of Object.entries(imports)) {
    normalizeMigrationKey(migrationKey);
    const entry = assertPlainObject(rawEntry, "Legacy import");
    assertExactKeys(entry, LEGACY_IMPORT_FIELDS, "Legacy import");
    const botId = normalizeBotId(entry.botId);
    if (!botIds.has(botId)) throw new Error("Legacy import references an unknown bot ID.");
    if (importedBots.has(botId)) throw new Error("A bot cannot own multiple legacy imports.");
    if (typeof entry.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
      throw new Error("Legacy import fingerprint is invalid.");
    }
    importedBots.add(botId);
    legacyImports[migrationKey] = { botId, fingerprint: entry.fingerprint };
  }
  return { schemaVersion: SCHEMA_VERSION, bots, legacyImports };
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, bots: [], legacyImports: Object.create(null) };
}

function legacyFingerprint(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function normalizeLegacyRecord(value) {
  const record = assertPlainObject(cloneData(value), "Legacy record");
  assertExactKeys(record, LEGACY_FIELDS, "Legacy");
  if (typeof record.notifications !== "boolean") throw new Error("Legacy notifications must be boolean.");
  if (!Array.isArray(record.conversations) || record.conversations.length > MAX_CONVERSATIONS) {
    throw new Error("Legacy conversations are invalid or oversized.");
  }
  return {
    migrationKey: normalizeMigrationKey(record.migrationKey),
    name: normalizeText(record.name, "Legacy bot name", MAX_NAME_LENGTH, { allowEmpty: false }),
    appearance: normalizeAppearance(record.appearance),
    notifications: record.notifications,
    conversations: record.conversations.map(normalizeConversationRef),
  };
}

function normalizeLegacyInput(value) {
  const record = assertPlainObject(cloneData(value), "Legacy record");
  assertAllowedKeys(record, LEGACY_FIELDS, "Legacy");
  if (!hasOwn(record, "migrationKey") || !hasOwn(record, "name")) {
    throw new Error("Legacy record requires migrationKey and name.");
  }
  return normalizeLegacyRecord({
    migrationKey: record.migrationKey,
    name: record.name,
    appearance: hasOwn(record, "appearance") ? record.appearance : { ...DEFAULT_APPEARANCE },
    notifications: hasOwn(record, "notifications") ? record.notifications : true,
    conversations: hasOwn(record, "conversations") ? record.conversations : [],
  });
}

function safeNow(now) {
  const value = now();
  return normalizeTimestamp(value, "Current time");
}

function safeUUID(makeUUID) {
  const value = makeUUID();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Generated UUID is invalid.");
  return value.toLowerCase();
}

function isUnsupportedSyncError(error) {
  return ["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code);
}

function isUnsupportedDirectoryOpenError(error) {
  return isUnsupportedSyncError(error) || error?.code === "EISDIR";
}

function uncertainDurabilityError() {
  const error = new Error("Bot store directory sync failed after commit; durability is uncertain.");
  error.code = "BOT_STORE_DURABILITY_UNCERTAIN";
  Object.defineProperty(error, "committed", { value: true });
  return error;
}

function runtimeTransactionReentryError() {
  const error = new Error("Bot store same-path operation is not allowed inside a runtime transaction.");
  error.code = "BOT_STORE_RUNTIME_TRANSACTION_REENTRANT";
  return error;
}

function runtimeTransactionBusyError() {
  const error = new Error("Bot store path is busy with an active runtime transaction.");
  error.code = "BOT_STORE_RUNTIME_TRANSACTION_BUSY";
  return error;
}

function runtimeTransactionContext(filePath) {
  const inherited = RUNTIME_TRANSACTION_CONTEXT.getStore()?.tokens || [];
  const token = { filePath, active: true };
  return {
    token,
    context: Object.freeze({
      tokens: Object.freeze([...inherited, token]),
    }),
  };
}

function hasActiveRuntimeTransaction(filePath) {
  const tokens = RUNTIME_TRANSACTION_CONTEXT.getStore()?.tokens || [];
  return tokens.some((token) => token.active && token.filePath === filePath);
}

function sameRuntime(first, second) {
  return [...RUNTIME_FIELDS].every((field) => first?.[field] === second?.[field]);
}

function recordRuntimeCommits(filePath, current, committed) {
  let pathRevisions = PATH_RUNTIME_REVISIONS.get(filePath);
  if (!pathRevisions) {
    pathRevisions = new Map();
    PATH_RUNTIME_REVISIONS.set(filePath, pathRevisions);
  }
  const previousBots = new Map(current.bots.map((bot) => [bot.botId, bot]));
  const receipts = new Map();
  for (const bot of committed.bots) {
    if (sameRuntime(previousBots.get(bot.botId)?.runtime, bot.runtime)) continue;
    const revision = (pathRevisions.get(bot.botId) || 0) + 1;
    pathRevisions.set(bot.botId, revision);
    receipts.set(bot.botId, revision);
  }
  return receipts;
}

function isCurrentRuntimeCommit(filePath, botId, receipt) {
  return receipt !== undefined
    && PATH_RUNTIME_REVISIONS.get(filePath)?.get(botId) === receipt;
}

function retainRuntimeCommitReceipt(target, filePath, receipts) {
  RUNTIME_COMMIT_RECEIPTS.set(target, { filePath, receipts });
  return target;
}

function enqueuePath(filePath, operation) {
  const previous = PATH_QUEUES.get(filePath) || Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  PATH_QUEUES.set(filePath, tail);
  void tail.then(() => {
    if (PATH_QUEUES.get(filePath) === tail) PATH_QUEUES.delete(filePath);
  });
  return result;
}

function normalizedRuntimePatch(value) {
  const patch = assertPlainObject(cloneData(value), "Runtime");
  assertAllowedKeys(patch, RUNTIME_FIELDS, "Runtime");
  if (!Object.keys(patch).length) throw new Error("Runtime patch is empty.");
  return patch;
}

function normalizedComputerPatch(value) {
  let patch;
  try {
    patch = assertPlainObject(cloneData(value), "Computer patch");
  } catch {
    throw new TypeError("Computer patch must contain plain data values only.");
  }
  assertAllowedKeys(patch, COMPUTER_FIELDS, "Computer patch");
  if (!Object.keys(patch).length) throw new Error("Computer patch is empty.");
  return patch;
}

class BotStore {
  #filePath;
  #fs;
  #now;
  #randomUUID;
  #queue = Promise.resolve();

  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)
      || typeof options.filePath !== "string" || !options.filePath) {
      throw new Error("Bot store requires a filePath.");
    }
    this.#filePath = path.resolve(options.filePath);
    this.#fs = options.fs || fs;
    this.#now = options.now || (() => new Date().toISOString());
    this.#randomUUID = options.randomUUID || randomUUID;
  }

  async load() {
    return this.#enqueue(() => this.#withPathLock(async () => {
      const state = await this.#readFile();
      return publicSnapshot(state.bots);
    }));
  }

  async list() {
    return this.#enqueue(() => this.#withPathLock(async () => {
      const state = await this.#readFile();
      return publicSnapshot(state.bots);
    }));
  }

  async read(botId) {
    const normalizedBotId = normalizeBotId(botId);
    return this.#enqueue(() => this.#withPathLock(async () => {
      const state = await this.#readFile();
      const record = state.bots.find((bot) => bot.botId === normalizedBotId);
      return record ? publicSnapshot(record) : null;
    }));
  }

  async create(input = undefined) {
    const { appearance, notifications } = normalizeCreateInput(input);

    return this.#mutate((next) => {
      const timestamp = safeNow(this.#now);
      const record = {
        schemaVersion: SCHEMA_VERSION,
        botId: `bot-${safeUUID(this.#randomUUID)}`,
        name: "New Bot",
        appearance,
        notifications,
        createdAt: timestamp,
        updatedAt: timestamp,
        conversations: [],
        runtime: { ...DEFAULT_RUNTIME },
        computer: { ...DEFAULT_COMPUTER },
      };
      next.bots.push(record);
      return record.botId;
    });
  }

  async adoptLegacy(value) {
    const legacy = normalizeLegacyInput(value);
    const canonical = {
      name: legacy.name,
      appearance: legacy.appearance,
      notifications: legacy.notifications,
      conversations: legacy.conversations,
    };
    const fingerprint = legacyFingerprint(canonical);

    return this.#mutate((next) => {
      const hasExistingImport = hasOwn(next.legacyImports, legacy.migrationKey);
      if (hasExistingImport) {
        const existingImport = next.legacyImports[legacy.migrationKey];
        if (existingImport.fingerprint !== fingerprint) throw new Error("Conflicting legacy import retry rejected.");
        const existingBot = next.bots.find((bot) => bot.botId === existingImport.botId);
        if (!existingBot) throw new Error("Legacy import references a missing bot.");
        return { botId: existingBot.botId, unchanged: true };
      }
      const timestamp = safeNow(this.#now);
      const botId = `bot-${safeUUID(this.#randomUUID)}`;
      next.bots.push({
        schemaVersion: SCHEMA_VERSION,
        botId,
        ...canonical,
        createdAt: timestamp,
        updatedAt: timestamp,
        runtime: { ...DEFAULT_RUNTIME },
        computer: { ...DEFAULT_COMPUTER },
      });
      next.legacyImports[legacy.migrationKey] = { botId, fingerprint };
      return { botId, unchanged: false };
    });
  }

  async rename(botId, name) {
    const normalizedBotId = normalizeBotId(botId);
    const normalizedName = normalizeText(name, "Bot name", MAX_NAME_LENGTH, { allowEmpty: false });
    return this.#mutate((next) => {
      const bot = this.#requiredBot(next, normalizedBotId);
      bot.name = normalizedName;
      bot.updatedAt = safeNow(this.#now);
      return bot.botId;
    });
  }

  async updateProfile(botId, value) {
    const normalizedBotId = normalizeBotId(botId);
    const patch = assertPlainObject(cloneData(value), "Profile");
    assertAllowedKeys(patch, PROFILE_FIELDS, "Profile");
    if (!Object.keys(patch).length) throw new Error("Profile patch is empty.");
    const appearancePatch = hasOwn(patch, "appearance")
      ? normalizeAppearance(patch.appearance, { partial: true })
      : null;
    if (hasOwn(patch, "notifications") && typeof patch.notifications !== "boolean") {
      throw new Error("Bot notifications must be boolean.");
    }
    return this.#mutate((next) => {
      const bot = this.#requiredBot(next, normalizedBotId);
      if (appearancePatch) bot.appearance = { ...bot.appearance, ...appearancePatch };
      if (hasOwn(patch, "notifications")) bot.notifications = patch.notifications;
      bot.updatedAt = safeNow(this.#now);
      return bot.botId;
    });
  }

  async updateRuntime(botId, value) {
    const normalizedBotId = normalizeBotId(botId);
    const patch = normalizedRuntimePatch(value);
    return this.#mutate((next) => {
      const bot = this.#requiredBot(next, normalizedBotId);
      bot.runtime = normalizeRuntime({ ...bot.runtime, ...patch });
      bot.updatedAt = safeNow(this.#now);
      return bot.botId;
    });
  }

  async updateComputer(botId, value) {
    const normalizedBotId = normalizeBotId(botId);
    const patch = normalizedComputerPatch(value);
    return this.#mutate((next) => {
      const bot = this.#requiredBot(next, normalizedBotId);
      if (Object.hasOwn(patch, "generation") && patch.generation < bot.computer.generation) {
        throw new Error("Computer generation is stale.");
      }
      bot.computer = normalizeComputer({ ...bot.computer, ...patch });
      bot.updatedAt = safeNow(this.#now);
      return bot.botId;
    });
  }

  async runtimeTransaction(botId, options, operation) {
    const normalizedBotId = normalizeBotId(botId);
    const normalizedOptions = normalizeRuntimeTransactionOptions(options);
    if (typeof operation !== "function") throw new TypeError("Runtime transaction operation must be a function.");
    const comparesLease = hasOwn(normalizedOptions, "expectedLastErrorCode");
    const expectedLastErrorCode = comparesLease
      ? normalizeIdentifier(
        normalizedOptions.expectedLastErrorCode,
        "Expected runtime error code",
        { nullable: true, errorCode: true },
      )
      : undefined;
    const afterCommit = normalizedOptions.afterCommit || null;

    if (hasActiveRuntimeTransaction(this.#filePath)) {
      throw runtimeTransactionReentryError();
    }
    if (ACTIVE_RUNTIME_TRANSACTIONS.has(this.#filePath)) {
      throw runtimeTransactionBusyError();
    }
    const transactionOwner = Object.freeze({ filePath: this.#filePath });
    ACTIVE_RUNTIME_TRANSACTIONS.set(this.#filePath, transactionOwner);
    try {
      return await this.#enqueue(() => this.#withPathLock(async () => {
        const current = await this.#readFile();
        const currentBot = this.#requiredBot(current, normalizedBotId);
        if (comparesLease && currentBot.runtime.lastErrorCode !== expectedLastErrorCode) {
          return deepFreeze({
            matched: false,
            bot: publicSnapshot(currentBot),
          });
        }

        const next = cloneData(current);
        let changed = false;
        const updateRuntime = (value) => {
          const patch = normalizedRuntimePatch(value);
          const bot = this.#requiredBot(next, normalizedBotId);
          bot.runtime = normalizeRuntime({ ...bot.runtime, ...patch });
          bot.updatedAt = safeNow(this.#now);
          changed = true;
          return publicSnapshot(bot);
        };
        const context = Object.freeze({
          bot: publicSnapshot(currentBot),
          bots: publicSnapshot(current.bots),
          updateRuntime,
        });
        const transactionContext = runtimeTransactionContext(this.#filePath);
        try {
          await RUNTIME_TRANSACTION_CONTEXT.run(
            transactionContext.context,
            () => operation(context),
          );
        } finally {
          transactionContext.token.active = false;
        }
        if (!changed) {
          return deepFreeze({
            matched: true,
            bot: publicSnapshot(currentBot),
          });
        }

        const validated = normalizeStore(next);
        let receipts;
        try {
          receipts = await this.#commitState(current, validated);
        } catch (error) {
          if (error?.committed === true) invokeAfterCommit(afterCommit);
          throw error;
        }
        const outcome = deepFreeze(retainRuntimeCommitReceipt({
          matched: true,
          bot: publicSnapshot(this.#requiredBot(validated, normalizedBotId)),
        }, this.#filePath, receipts));
        invokeAfterCommit(afterCommit);
        return outcome;
      }), transactionOwner);
    } finally {
      if (ACTIVE_RUNTIME_TRANSACTIONS.get(this.#filePath) === transactionOwner) {
        ACTIVE_RUNTIME_TRANSACTIONS.delete(this.#filePath);
      }
    }
  }

  async attachConversation(botId, value) {
    const normalizedBotId = normalizeBotId(botId);
    const ref = normalizeConversationRef(assertPlainObject(cloneData(value), "Conversation reference"));
    const key = conversationKey(ref);
    return this.#mutate((next) => {
      const bot = this.#requiredBot(next, normalizedBotId);
      for (const owner of next.bots) {
        if (!owner.conversations.some((candidate) => conversationKey(candidate) === key)) continue;
        if (owner.botId === bot.botId) throw new Error("Bot already owns this duplicate conversation reference.");
        throw new Error("Conversation is already owned by another bot.");
      }
      bot.conversations.push(ref);
      bot.updatedAt = safeNow(this.#now);
      return { botId: bot.botId, unchanged: false };
    });
  }

  isCurrentRuntimeCommit(commit, botId) {
    const normalizedBotId = normalizeBotId(botId);
    const retained = commit && typeof commit === "object"
      ? RUNTIME_COMMIT_RECEIPTS.get(commit)
      : null;
    return Boolean(retained
      && retained.filePath === this.#filePath
      && isCurrentRuntimeCommit(
        this.#filePath,
        normalizedBotId,
        retained.receipts.get(normalizedBotId),
      ));
  }

  #requiredBot(state, botId) {
    const bot = state.bots.find((record) => record.botId === botId);
    if (!bot) throw new Error(`Bot not found: ${botId}.`);
    return bot;
  }

  #enqueue(operation, transactionOwner = null) {
    if (hasActiveRuntimeTransaction(this.#filePath)) {
      throw runtimeTransactionReentryError();
    }
    const activeTransaction = ACTIVE_RUNTIME_TRANSACTIONS.get(this.#filePath);
    if (activeTransaction && activeTransaction !== transactionOwner) {
      throw runtimeTransactionBusyError();
    }
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #withPathLock(operation) {
    // The app process is the writer boundary: an old controller cannot execute
    // after process exit. This coordinates every live same-path Store instance,
    // rather than pretending to provide an inter-process/IPC lock.
    return enqueuePath(this.#filePath, operation);
  }

  async #mutate(operation) {
    return this.#enqueue(() => this.#withPathLock(async () => {
      const current = await this.#readFile();
      const next = cloneData(current);
      const outcome = operation(next);
      if (outcome && typeof outcome === "object" && outcome.unchanged === true) {
        return publicSnapshot(this.#requiredBot(current, outcome.botId));
      }
      const botId = typeof outcome === "string" ? outcome : outcome.botId;
      const validated = normalizeStore(next);
      await this.#commitState(current, validated);
      return publicSnapshot(this.#requiredBot(validated, botId));
    }));
  }

  async #commitState(current, committed) {
    try {
      await this.#writeFile(committed);
    } catch (error) {
      if (error?.committed !== true) throw error;
      const receipts = recordRuntimeCommits(this.#filePath, current, committed);
      retainRuntimeCommitReceipt(error, this.#filePath, receipts);
      throw error;
    }
    return recordRuntimeCommits(this.#filePath, current, committed);
  }

  async #readFile() {
    let parsed;
    try {
      parsed = JSON.parse(await this.#fs.readFile(this.#filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyStore();
      if (error instanceof SyntaxError) throw new Error("Bot store is malformed.");
      throw error;
    }
    return normalizeLoadedStore(cloneData(parsed));
  }

  async #writeFile(state) {
    const directory = path.dirname(this.#filePath);
    const temporary = path.join(directory, `.${path.basename(this.#filePath)}.${safeUUID(this.#randomUUID)}.tmp`);
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    let handle = null;
    let ownsTemporary = false;
    let renamed = false;
    try {
      await this.#fs.mkdir(directory, { recursive: true });
      handle = await this.#fs.open(temporary, "wx", 0o600);
      ownsTemporary = true;
      await handle.writeFile(contents, { encoding: "utf8" });
      if (typeof handle.sync === "function") {
        try {
          await handle.sync();
        } catch (error) {
          if (!isUnsupportedSyncError(error)) throw error;
        }
      }
      await handle.close();
      handle = null;
      await this.#fs.rename(temporary, this.#filePath);
      renamed = true;
      ownsTemporary = false;
      await this.#syncDirectory(directory);
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Preserve the operation error while still attempting exact-temp cleanup.
        }
      }
      if (ownsTemporary && !renamed) {
        try {
          await this.#fs.rm(temporary, { force: true });
        } catch {
          // Never delete any broader path or obscure the original persistence failure.
        }
      }
      throw error;
    }
  }

  async #syncDirectory(directory) {
    let handle;
    try {
      handle = await this.#fs.open(directory, "r");
    } catch (error) {
      if (isUnsupportedDirectoryOpenError(error)) return;
      throw uncertainDurabilityError();
    }

    let failure = null;
    if (typeof handle.sync === "function") {
      try {
        await handle.sync();
      } catch (error) {
        if (!isUnsupportedSyncError(error)) failure = error;
      }
    }
    try {
      await handle.close();
    } catch (error) {
      if (!failure) failure = error;
    }
    if (failure) throw uncertainDurabilityError();
  }
}

module.exports = {
  BotStore,
  SCHEMA_VERSION,
};
