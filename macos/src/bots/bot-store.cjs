"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

// Bot records remain schema v3. Only the enclosing durable Store advances to
// v4 so renderer/controller consumers keep the existing public bot contract.
const SCHEMA_VERSION = 3;
const STORE_SCHEMA_VERSION = 4;
const LEGACY_SCHEMA_VERSION = 1;
const PREVIOUS_SCHEMA_VERSION = 2;
const MAX_BOTS = 4096;
const MAX_PENDING_DELETIONS = MAX_BOTS;
const MAX_CLEANUP_IDS = MAX_BOTS * 3;
const MAX_DELETED_LEGACY_IMPORTS = 65_536;
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
const SETUP_STAGES = new Set(["profile-model", "computer", "complete"]);
const CREATION_SETUP_STAGES = new Set(["profile-model", "complete"]);
const SETUP_TRANSITION_FIELDS = new Set(["expectedStage", "nextStage"]);
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
  "setupStage",
]);
const PREVIOUS_BOT_FIELDS = new Set([...BOT_FIELDS].filter((field) => field !== "setupStage"));
const LEGACY_BOT_FIELDS = new Set([...PREVIOUS_BOT_FIELDS].filter((field) => field !== "computer"));
const PREVIOUS_STORE_FIELDS = new Set(["schemaVersion", "bots", "legacyImports"]);
const STORE_FIELDS = new Set([
  "schemaVersion",
  "bots",
  "legacyImports",
  "deletedLegacyImports",
  "pendingDeletions",
]);
const LEGACY_FIELDS = new Set(["migrationKey", "name", "appearance", "notifications", "conversations"]);
const LEGACY_IMPORT_FIELDS = new Set(["botId", "fingerprint"]);
const DELETED_LEGACY_IMPORT_FIELDS = new Set(["fingerprint"]);
const PENDING_DELETION_FIELDS = new Set([
  "deletionId",
  "createdAt",
  "botIds",
  "remoteRuntimes",
  "localProfiles",
]);
const REMOTE_CLEANUP_FIELDS = new Set(["botId", "runtimeId"]);
const LOCAL_CLEANUP_FIELDS = new Set(["botId", "profileId"]);
const DELETE_OPTIONS_FIELDS = new Set(["preferredActiveBotId", "extraRemoteRuntimes"]);
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
  if (value === undefined) {
    return {
      appearance: { ...DEFAULT_APPEARANCE },
      notifications: true,
      setupStage: "profile-model",
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Create input must be an object.");
  }
  const appearanceField = selectedOwnDataField(value, "appearance", "Create input");
  const notificationsField = selectedOwnDataField(value, "notifications", "Create input");
  const setupStageField = selectedOwnDataField(value, "setupStage", "Create input");
  const notifications = notificationsField.present ? notificationsField.value : true;
  const setupStage = setupStageField.present ? setupStageField.value : "profile-model";
  if (typeof notifications !== "boolean") throw new Error("Bot notifications must be boolean.");
  if (!CREATION_SETUP_STAGES.has(setupStage)) {
    throw new Error("Bot creation setup stage is invalid.");
  }
  return {
    appearance: appearanceField.present ? normalizeCreateAppearance(appearanceField.value) : { ...DEFAULT_APPEARANCE },
    notifications,
    setupStage,
  };
}

function normalizeCreateCommitOptions(value) {
  if (value === undefined) return null;
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("Bot create commit options must be a plain object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || prototype !== Object.prototype) {
    throw new TypeError("Bot create commit options must be a plain object.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== "commitFence"
    || !descriptors.commitFence || !("value" in descriptors.commitFence)
    || typeof descriptors.commitFence.value !== "function") {
    throw new TypeError("Bot create commit options require a commit fence.");
  }
  return descriptors.commitFence.value;
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
  if (normalized.mode === "cursor" && normalized.state === "unconfigured") {
    throw new Error("Cursor Computer mode cannot remain unconfigured.");
  }
  if (normalized.mode === "cursor"
    && ["starting", "ready", "reconnecting"].includes(normalized.state)
    && normalized.nativeAgentId === null) {
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

function normalizeSetupStage(value) {
  if (typeof value !== "string" || !SETUP_STAGES.has(value)) {
    throw new Error("Bot setup stage is invalid.");
  }
  return value;
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
    setupStage: normalizeSetupStage(record.setupStage),
  };
}

function migrateStore(value) {
  const store = assertPlainObject(value, "Store");
  assertExactKeys(store, PREVIOUS_STORE_FIELDS, "Store");
  if (store.schemaVersion !== LEGACY_SCHEMA_VERSION
    && store.schemaVersion !== PREVIOUS_SCHEMA_VERSION
    && store.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("Unsupported bot store schema version.");
  }
  if (!Array.isArray(store.bots) || store.bots.length > MAX_BOTS) {
    throw new Error("Bot store bots are invalid or oversized.");
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    bots: store.bots.map((rawBot) => {
      const bot = assertPlainObject(rawBot, "Bot");
      const expectedFields = store.schemaVersion === LEGACY_SCHEMA_VERSION
        ? LEGACY_BOT_FIELDS
        : (store.schemaVersion === PREVIOUS_SCHEMA_VERSION ? PREVIOUS_BOT_FIELDS : BOT_FIELDS);
      assertExactKeys(bot, expectedFields, "Bot");
      if (bot.schemaVersion !== store.schemaVersion) {
        throw new Error("Bot schema version is unsupported.");
      }
      if (store.schemaVersion === SCHEMA_VERSION) return bot;
      return {
        ...bot,
        schemaVersion: SCHEMA_VERSION,
        ...(store.schemaVersion === LEGACY_SCHEMA_VERSION
          ? { computer: { ...DEFAULT_COMPUTER } }
          : {}),
        setupStage: "complete",
      };
    }),
    legacyImports: store.legacyImports,
    deletedLegacyImports: Object.create(null),
    pendingDeletions: [],
  };
}

function normalizeLoadedStore(value) {
  if (value?.schemaVersion === LEGACY_SCHEMA_VERSION
    || value?.schemaVersion === PREVIOUS_SCHEMA_VERSION
    || value?.schemaVersion === SCHEMA_VERSION) {
    return normalizeStore(migrateStore(value));
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

function normalizeDeletionId(value) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Deletion ID is invalid.");
  }
  return value.toLowerCase();
}

function normalizeLocalProfileId(value) {
  const normalized = normalizeIdentifier(value, "Local profile ID");
  if (!/^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error("Local profile ID is invalid.");
  }
  return normalized.toLowerCase();
}

function normalizePendingDeletion(value) {
  const deletion = assertPlainObject(value, "Pending deletion");
  assertExactKeys(deletion, PENDING_DELETION_FIELDS, "Pending deletion");
  if (!Array.isArray(deletion.botIds) || deletion.botIds.length === 0
    || deletion.botIds.length > MAX_BOTS) {
    throw new Error("Pending deletion bot IDs are invalid or oversized.");
  }
  const botIds = deletion.botIds.map(normalizeBotId);
  if (new Set(botIds).size !== botIds.length) {
    throw new Error("Pending deletion contains duplicate bot IDs.");
  }
  const members = new Set(botIds);

  if (!Array.isArray(deletion.remoteRuntimes)
    || deletion.remoteRuntimes.length > MAX_CLEANUP_IDS) {
    throw new Error("Pending deletion remote runtimes are invalid or oversized.");
  }
  const remoteRuntimes = [];
  const runtimeIds = new Set();
  for (const rawEntry of deletion.remoteRuntimes) {
    const entry = assertPlainObject(rawEntry, "Remote cleanup");
    assertExactKeys(entry, REMOTE_CLEANUP_FIELDS, "Remote cleanup");
    const botId = normalizeBotId(entry.botId);
    if (!members.has(botId)) throw new Error("Remote cleanup references a bot outside its deletion.");
    const runtimeId = normalizeIdentifier(entry.runtimeId, "Remote runtime ID");
    if (runtimeIds.has(runtimeId)) throw new Error("Pending deletion contains a duplicate remote runtime ID.");
    runtimeIds.add(runtimeId);
    remoteRuntimes.push({ botId, runtimeId });
  }

  if (!Array.isArray(deletion.localProfiles)
    || deletion.localProfiles.length > deletion.botIds.length) {
    throw new Error("Pending deletion local profiles are invalid or oversized.");
  }
  const localProfiles = [];
  const profileIds = new Set();
  for (const rawEntry of deletion.localProfiles) {
    const entry = assertPlainObject(rawEntry, "Local cleanup");
    assertExactKeys(entry, LOCAL_CLEANUP_FIELDS, "Local cleanup");
    const botId = normalizeBotId(entry.botId);
    if (!members.has(botId)) throw new Error("Local cleanup references a bot outside its deletion.");
    const profileId = normalizeLocalProfileId(entry.profileId);
    if (profileIds.has(profileId)) throw new Error("Pending deletion contains a duplicate local profile ID.");
    profileIds.add(profileId);
    localProfiles.push({ botId, profileId });
  }

  return {
    deletionId: normalizeDeletionId(deletion.deletionId),
    createdAt: normalizeTimestamp(deletion.createdAt, "Pending deletion createdAt"),
    botIds,
    remoteRuntimes,
    localProfiles,
  };
}

function normalizeStore(value) {
  const store = assertPlainObject(value, "Store");
  assertExactKeys(store, STORE_FIELDS, "Store");
  if (store.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error("Unsupported bot store schema version.");
  if (!Array.isArray(store.bots) || store.bots.length > MAX_BOTS) throw new Error("Bot store bots are invalid or oversized.");
  const bots = store.bots.map(normalizeBotRecord);
  const botIds = new Set();
  const runtimeOwners = new Map();
  const localProfileOwners = new Map();
  const conversationOwners = new Map();
  for (const bot of bots) {
    if (botIds.has(bot.botId)) throw new Error("Bot store contains duplicate bot IDs.");
    botIds.add(bot.botId);
    if (bot.runtime.remoteRuntimeId) {
      if (runtimeOwners.has(bot.runtime.remoteRuntimeId)) throw new Error("Bot store contains duplicate remote runtime IDs.");
      runtimeOwners.set(bot.runtime.remoteRuntimeId, bot.botId);
    }
    if (bot.computer.localProfileId) {
      if (localProfileOwners.has(bot.computer.localProfileId)) {
        throw new Error("Bot store contains duplicate local profile IDs.");
      }
      localProfileOwners.set(bot.computer.localProfileId, bot.botId);
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
  const deletedImports = assertPlainObject(store.deletedLegacyImports, "Deleted legacy imports");
  const deletedLegacyImports = Object.create(null);
  const deletedImportEntries = Object.entries(deletedImports);
  if (deletedImportEntries.length > MAX_DELETED_LEGACY_IMPORTS) {
    throw new Error("Deleted legacy imports are oversized.");
  }
  for (const [migrationKey, rawEntry] of deletedImportEntries) {
    normalizeMigrationKey(migrationKey);
    if (hasOwn(legacyImports, migrationKey)) {
      throw new Error("A legacy import cannot be both active and deleted.");
    }
    const entry = assertPlainObject(rawEntry, "Deleted legacy import");
    assertExactKeys(entry, DELETED_LEGACY_IMPORT_FIELDS, "Deleted legacy import");
    if (typeof entry.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
      throw new Error("Deleted legacy import fingerprint is invalid.");
    }
    deletedLegacyImports[migrationKey] = { fingerprint: entry.fingerprint };
  }

  if (!Array.isArray(store.pendingDeletions)
    || store.pendingDeletions.length > MAX_PENDING_DELETIONS) {
    throw new Error("Pending deletions are invalid or oversized.");
  }
  const pendingDeletions = [];
  const deletionIds = new Set();
  const deletedBotIds = new Set();
  const pendingRuntimeIds = new Set();
  const pendingProfileIds = new Set();
  let cleanupIdCount = 0;
  for (const rawDeletion of store.pendingDeletions) {
    const deletion = normalizePendingDeletion(rawDeletion);
    if (deletionIds.has(deletion.deletionId)) {
      throw new Error("Bot store contains duplicate deletion IDs.");
    }
    deletionIds.add(deletion.deletionId);
    for (const botId of deletion.botIds) {
      if (botIds.has(botId)) throw new Error("A pending deletion still references a visible bot.");
      if (deletedBotIds.has(botId)) throw new Error("A bot cannot belong to multiple pending deletions.");
      deletedBotIds.add(botId);
    }
    for (const entry of deletion.remoteRuntimes) {
      if (runtimeOwners.has(entry.runtimeId)) {
        throw new Error("A pending deletion runtime is owned by a visible bot.");
      }
      if (pendingRuntimeIds.has(entry.runtimeId)) {
        throw new Error("A remote runtime cannot belong to multiple pending deletions.");
      }
      pendingRuntimeIds.add(entry.runtimeId);
    }
    for (const entry of deletion.localProfiles) {
      if (localProfileOwners.has(entry.profileId)) {
        throw new Error("A pending deletion local profile is owned by a visible bot.");
      }
      if (pendingProfileIds.has(entry.profileId)) {
        throw new Error("A local profile cannot belong to multiple pending deletions.");
      }
      pendingProfileIds.add(entry.profileId);
    }
    cleanupIdCount += deletion.botIds.length
      + deletion.remoteRuntimes.length
      + deletion.localProfiles.length;
    if (cleanupIdCount > MAX_CLEANUP_IDS) throw new Error("Pending deletion cleanup IDs are oversized.");
    pendingDeletions.push(deletion);
  }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    bots,
    legacyImports,
    deletedLegacyImports,
    pendingDeletions,
  };
}

function emptyStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    bots: [],
    legacyImports: Object.create(null),
    deletedLegacyImports: Object.create(null),
    pendingDeletions: [],
  };
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

function unsafeDeletionInspectionError() {
  return new TypeError("Bot deletion request could not be inspected safely.");
}

function inspectDeletionRecord(value, allowed, label, { exact = false } = {}) {
  let array;
  try {
    array = Array.isArray(value);
  } catch {
    throw unsafeDeletionInspectionError();
  }
  if (!value || typeof value !== "object" || array) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw unsafeDeletionInspectionError();
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} cannot contain symbol fields.`);
  }
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError(`${label} contains a forbidden prototype field.`);
    if (!allowed.has(key)) {
      throw new Error(`${label} contains an unsupported ${label.toLowerCase()} field: ${key}.`);
    }
  }
  if (exact) {
    for (const key of allowed) {
      if (!hasOwn(descriptors, key)) throw new Error(`${label} is missing ${key}.`);
    }
  }
  const inspected = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw new TypeError(`${label} ${key} must be plain data, not an accessor.`);
    }
    inspected[key] = descriptor.value;
  }
  return inspected;
}

function inspectDeletionArray(value, label, maximum, { nonEmpty = false } = {}) {
  let array;
  let prototype;
  let lengthDescriptor;
  try {
    array = Array.isArray(value);
    if (array) {
      prototype = Object.getPrototypeOf(value);
      lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    }
  } catch {
    throw unsafeDeletionInspectionError();
  }
  if (!array || prototype !== Array.prototype || !lengthDescriptor || !("value" in lengthDescriptor)) {
    throw new TypeError(`${label} must be a dense plain array.`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || (nonEmpty && length === 0)) {
    throw new Error(`${label} are invalid or oversized.`);
  }

  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw unsafeDeletionInspectionError();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} cannot contain symbol fields.`);
  }
  const elementKeys = keys.filter((key) => key !== "length");
  if (elementKeys.length !== length
    || elementKeys.some((key, index) => key !== String(index))) {
    throw new TypeError(`${label} must be a dense plain array.`);
  }
  const inspected = [];
  for (const key of elementKeys) {
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) {
      throw new TypeError(`${label} ${key} must be plain data, not an accessor.`);
    }
    inspected.push(descriptor.value);
  }
  return inspected;
}

function normalizeDeleteRequest(value, options = undefined) {
  const botIds = inspectDeletionArray(value, "Bot deletion IDs", MAX_BOTS, { nonEmpty: true });
  const normalizedBotIds = botIds.map(normalizeBotId);
  if (new Set(normalizedBotIds).size !== normalizedBotIds.length) {
    throw new Error("Bot deletion IDs must be unique.");
  }
  const normalizedOptions = options === undefined
    ? {}
    : inspectDeletionRecord(options, DELETE_OPTIONS_FIELDS, "Bot deletion options");
  const preferredActiveBotId = hasOwn(normalizedOptions, "preferredActiveBotId")
    && normalizedOptions.preferredActiveBotId !== null
    ? normalizeBotId(normalizedOptions.preferredActiveBotId)
    : null;
  const rawExtraRuntimes = inspectDeletionArray(
    hasOwn(normalizedOptions, "extraRemoteRuntimes")
      ? normalizedOptions.extraRemoteRuntimes
      : [],
    "Extra remote runtimes",
    MAX_CLEANUP_IDS,
  );
  const members = new Set(normalizedBotIds);
  const runtimeIds = new Set();
  const extraRemoteRuntimes = rawExtraRuntimes.map((rawEntry) => {
    const entry = inspectDeletionRecord(
      rawEntry,
      REMOTE_CLEANUP_FIELDS,
      "Extra remote runtime",
      { exact: true },
    );
    const botId = normalizeBotId(entry.botId);
    if (!members.has(botId)) throw new Error("Extra remote runtime references a bot outside the deletion.");
    const runtimeId = normalizeIdentifier(entry.runtimeId, "Remote runtime ID");
    if (runtimeIds.has(runtimeId)) throw new Error("Extra remote runtime IDs must be unique.");
    runtimeIds.add(runtimeId);
    return { botId, runtimeId };
  });
  return { botIds: normalizedBotIds, preferredActiveBotId, extraRemoteRuntimes };
}

function sameBotIdSet(first, second) {
  if (first.length !== second.length) return false;
  const expected = new Set(first);
  return second.every((botId) => expected.has(botId));
}

function deletionOutcome(deletion, bots, preferredActiveBotId) {
  const survivingBotIds = bots.map((bot) => bot.botId);
  const activeBotId = preferredActiveBotId && survivingBotIds.includes(preferredActiveBotId)
    ? preferredActiveBotId
    : (survivingBotIds[0] || null);
  return publicSnapshot({
    deletionId: deletion.deletionId,
    deletedBotIds: deletion.botIds,
    survivingBotIds,
    activeBotId,
    cleanup: {
      botIds: deletion.botIds,
      remoteRuntimes: deletion.remoteRuntimes,
      localProfiles: deletion.localProfiles,
    },
  });
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
  const committedBotIds = new Set(committed.bots.map((bot) => bot.botId));
  for (const botId of previousBots.keys()) {
    if (!committedBotIds.has(botId)) {
      pathRevisions.set(botId, (pathRevisions.get(botId) || 0) + 1);
    }
  }
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

function normalizedSetupTransition(value) {
  let transition;
  try {
    transition = assertPlainObject(cloneData(value), "Setup transition");
  } catch {
    throw new TypeError("Setup transition must contain plain data values only.");
  }
  assertExactKeys(transition, SETUP_TRANSITION_FIELDS, "Setup transition");
  const expectedStage = normalizeSetupStage(transition.expectedStage);
  const nextStage = normalizeSetupStage(transition.nextStage);
  const valid = (expectedStage === "profile-model" && nextStage === "computer")
    || (expectedStage === "computer" && nextStage === "complete");
  if (!valid) throw new Error("Bot setup transition must be monotonic.");
  return Object.freeze({ expectedStage, nextStage });
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

  async listPendingDeletions() {
    return this.#enqueue(() => this.#withPathLock(async () => {
      const state = await this.#readFile();
      return publicSnapshot(state.pendingDeletions);
    }));
  }

  async deleteBots(botIds, options = undefined) {
    const request = normalizeDeleteRequest(botIds, options);
    return this.#enqueue(() => this.#withPathLock(async () => {
      const current = await this.#readFile();
      if (request.preferredActiveBotId
        && !request.botIds.includes(request.preferredActiveBotId)
        && !current.bots.some((bot) => bot.botId === request.preferredActiveBotId)) {
        throw new Error("Preferred active bot was not found.");
      }
      const retry = current.pendingDeletions.find((deletion) => (
        sameBotIdSet(deletion.botIds, request.botIds)
      ));
      if (retry) {
        const cleanupMatches = request.extraRemoteRuntimes.every((requested) => (
          retry.remoteRuntimes.some((retained) => (
            retained.botId === requested.botId && retained.runtimeId === requested.runtimeId
          ))
        ));
        if (!cleanupMatches) {
          throw new Error("Bot deletion retry cleanup does not match the pending deletion.");
        }
        return deletionOutcome(retry, current.bots, request.preferredActiveBotId);
      }

      const deleted = request.botIds.map((botId) => this.#requiredBot(current, botId));
      const remoteRuntimes = [];
      const runtimeOwners = new Map();
      for (const bot of deleted) {
        if (!bot.runtime.remoteRuntimeId) continue;
        runtimeOwners.set(bot.runtime.remoteRuntimeId, bot.botId);
        remoteRuntimes.push({ botId: bot.botId, runtimeId: bot.runtime.remoteRuntimeId });
      }
      for (const entry of request.extraRemoteRuntimes) {
        const owner = runtimeOwners.get(entry.runtimeId);
        if (owner && owner !== entry.botId) {
          throw new Error("Remote runtime cleanup ownership conflicts with the stored bot.");
        }
        if (owner) continue;
        runtimeOwners.set(entry.runtimeId, entry.botId);
        remoteRuntimes.push(entry);
      }
      const localProfiles = deleted
        .filter((bot) => bot.computer.localProfileId)
        .map((bot) => ({ botId: bot.botId, profileId: bot.computer.localProfileId }));
      const deletion = {
        deletionId: safeUUID(this.#randomUUID),
        createdAt: safeNow(this.#now),
        botIds: [...request.botIds],
        remoteRuntimes,
        localProfiles,
      };
      const deletedIds = new Set(request.botIds);
      const next = cloneData(current);
      next.bots = next.bots.filter((bot) => !deletedIds.has(bot.botId));
      for (const [migrationKey, entry] of Object.entries(next.legacyImports)) {
        if (!deletedIds.has(entry.botId)) continue;
        next.deletedLegacyImports[migrationKey] = { fingerprint: entry.fingerprint };
        delete next.legacyImports[migrationKey];
      }
      next.pendingDeletions.push(deletion);
      const validated = normalizeStore(next);
      const committedDeletion = validated.pendingDeletions.find((entry) => (
        entry.deletionId === deletion.deletionId
      ));
      try {
        await this.#commitState(current, validated);
      } catch (error) {
        if (error?.committed !== true) throw error;
        try {
          const reloaded = await this.#readFile();
          const durableDeletion = reloaded.pendingDeletions.find((entry) => (
            entry.deletionId === deletion.deletionId
          ));
          const allAbsent = request.botIds.every((botId) => (
            !reloaded.bots.some((bot) => bot.botId === botId)
          ));
          if (durableDeletion && allAbsent
            && JSON.stringify(durableDeletion) === JSON.stringify(committedDeletion)) {
            return deletionOutcome(durableDeletion, reloaded.bots, request.preferredActiveBotId);
          }
        } catch {
          // Preserve the committed-uncertain error unless the exact durable receipt is readable.
        }
        throw error;
      }
      return deletionOutcome(committedDeletion, validated.bots, request.preferredActiveBotId);
    }));
  }

  async completeDeletion(deletionId) {
    const normalizedDeletionId = normalizeDeletionId(deletionId);
    return this.#enqueue(() => this.#withPathLock(async () => {
      const current = await this.#readFile();
      const index = current.pendingDeletions.findIndex((entry) => (
        entry.deletionId === normalizedDeletionId
      ));
      if (index < 0) return false;
      const next = cloneData(current);
      next.pendingDeletions.splice(index, 1);
      const validated = normalizeStore(next);
      try {
        await this.#commitState(current, validated);
      } catch (error) {
        if (error?.committed !== true) throw error;
        try {
          const reloaded = await this.#readFile();
          if (!reloaded.pendingDeletions.some((entry) => (
            entry.deletionId === normalizedDeletionId
          ))) return true;
        } catch {
          // Preserve the committed-uncertain error unless exact completion is readable.
        }
        throw error;
      }
      return true;
    }));
  }

  async create(input = undefined, options = undefined) {
    const { appearance, notifications, setupStage } = normalizeCreateInput(input);
    const commitFence = normalizeCreateCommitOptions(options);

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
        setupStage,
      };
      next.bots.push(record);
      return record.botId;
    }, commitFence);
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
      if (hasOwn(next.deletedLegacyImports, legacy.migrationKey)) {
        const deletedImport = next.deletedLegacyImports[legacy.migrationKey];
        if (deletedImport.fingerprint !== fingerprint) {
          throw new Error("Conflicting previously deleted legacy import rejected.");
        }
        throw new Error("Legacy import was previously deleted.");
      }
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
        setupStage: "complete",
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

  async advanceSetup(botId, value, commitFence = undefined) {
    const normalizedBotId = normalizeBotId(botId);
    const transition = normalizedSetupTransition(value);
    if (commitFence !== undefined && typeof commitFence !== "function") {
      throw new TypeError("Setup commit fence must be a function.");
    }
    return this.#mutate((next) => {
      const bot = this.#requiredBot(next, normalizedBotId);
      if (bot.setupStage !== transition.expectedStage) {
        throw new Error("Bot setup stage changed; transition is stale.");
      }
      if (commitFence) {
        const result = commitFence(publicSnapshot(bot));
        if (result && typeof result.then === "function") {
          throw new TypeError("Setup commit fence must be synchronous.");
        }
      }
      bot.setupStage = transition.nextStage;
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

  async #mutate(operation, commitFence = null) {
    return this.#enqueue(() => this.#withPathLock(async () => {
      const current = await this.#readFile();
      const next = cloneData(current);
      const outcome = operation(next);
      if (outcome && typeof outcome === "object" && outcome.unchanged === true) {
        return publicSnapshot(this.#requiredBot(current, outcome.botId));
      }
      const botId = typeof outcome === "string" ? outcome : outcome.botId;
      const validated = normalizeStore(next);
      await this.#commitState(current, validated, commitFence);
      return publicSnapshot(this.#requiredBot(validated, botId));
    }));
  }

  async #commitState(current, committed, commitFence = null) {
    if (commitFence !== null) {
      let valid = false;
      try { valid = commitFence() === true; } catch { valid = false; }
      if (!valid) {
        const error = new Error("Bot create provider authority is stale.");
        error.code = "BOT_STORE_PROVIDER_AUTHORITY_STALE";
        throw error;
      }
    }
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
