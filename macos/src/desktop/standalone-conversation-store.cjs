"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const MAX_CONVERSATIONS = 256;
const MAX_MESSAGES = 512;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_ID = /^message-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_FIELDS = new Set(["botId", "conversationId", "createdAt", "updatedAt", "messages"]);
const MESSAGE_FIELDS = new Set(["messageId", "role", "text", "createdAt", "clientNonce", "inputDigest"]);
const LEGACY_MESSAGE_FIELDS = new Set(["messageId", "role", "text", "createdAt"]);

class StandaloneConversationStoreError extends Error {
  constructor() {
    super("OpenBot conversation storage failed.");
    this.name = "StandaloneConversationStoreError";
    this.code = "OPENBOT_CONVERSATION_STORE_FAILED";
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: "StandaloneConversationStoreError: OpenBot conversation storage failed.",
      writable: true,
    });
  }
}

function fail() { throw new StandaloneConversationStoreError(); }

function ownData(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail(); }
  if (prototype !== Object.prototype && prototype !== null
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !fields.has(key)
      || !("value" in descriptors[key]))
    || [...required].some((key) => !descriptors[key])) fail();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value)) fail();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail();
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
    || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) fail();
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)) fail();
    values.push(descriptor.value);
  }
  return values;
}

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) fail();
  return value;
}

function message(value, { legacy = false } = {}) {
  const raw = ownData(value, legacy ? LEGACY_MESSAGE_FIELDS : MESSAGE_FIELDS, LEGACY_MESSAGE_FIELDS);
  if (typeof raw.messageId !== "string" || !MESSAGE_ID.test(raw.messageId)
    || !new Set(["user", "assistant"]).has(raw.role)
    || typeof raw.text !== "string" || raw.text.includes("\0")
    || Buffer.byteLength(raw.text, "utf8") > MAX_TEXT_BYTES) fail();
  if ((raw.clientNonce === undefined) !== (raw.inputDigest === undefined)) fail();
  if (raw.clientNonce !== undefined
    && (raw.role !== "user" || typeof raw.clientNonce !== "string"
      || raw.clientNonce.trim().length === 0 || raw.clientNonce.includes("\0")
      || Buffer.byteLength(raw.clientNonce, "utf8") > 512
      || typeof raw.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(raw.inputDigest))) fail();
  return {
    messageId: raw.messageId,
    role: raw.role,
    text: raw.text,
    createdAt: timestamp(raw.createdAt),
    ...(raw.clientNonce === undefined ? {} : {
      clientNonce: raw.clientNonce,
      inputDigest: raw.inputDigest,
    }),
  };
}

function record(value, { legacy = false } = {}) {
  const raw = ownData(value, RECORD_FIELDS);
  if (typeof raw.botId !== "string" || !BOT_ID.test(raw.botId)
    || typeof raw.conversationId !== "string" || !CONVERSATION_ID.test(raw.conversationId)) fail();
  const createdAt = timestamp(raw.createdAt);
  const updatedAt = timestamp(raw.updatedAt);
  if (updatedAt < createdAt) fail();
  const messages = denseArray(raw.messages, MAX_MESSAGES).map((entry) => message(entry, { legacy }));
  return { botId: raw.botId, conversationId: raw.conversationId, createdAt, updatedAt, messages };
}

function publicValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(publicValue));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, publicValue(nested)]),
  ));
}

function botId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) fail();
  return value;
}

function conversationId(value) {
  if (typeof value !== "string" || !CONVERSATION_ID.test(value)) fail();
  return value;
}

function normalizeState(value) {
  const state = ownData(value, new Set(["schemaVersion", "conversations"]));
  if (state.schemaVersion !== SCHEMA_VERSION && state.schemaVersion !== LEGACY_SCHEMA_VERSION) fail();
  const legacy = state.schemaVersion === LEGACY_SCHEMA_VERSION;
  const conversations = denseArray(state.conversations, MAX_CONVERSATIONS)
    .map((entry) => record(entry, { legacy }));
  const owners = new Set();
  for (const entry of conversations) {
    if (owners.has(entry.conversationId)) fail();
    owners.add(entry.conversationId);
  }
  return { schemaVersion: SCHEMA_VERSION, conversations };
}

class StandaloneConversationStore {
  #filePath;
  #fs;
  #makeId;
  #queue = Promise.resolve();

  constructor({ filePath, fs: fsApi = fs, randomUUID: makeId = randomUUID } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)
      || !fsApi || typeof fsApi.readFile !== "function" || typeof fsApi.open !== "function"
      || typeof makeId !== "function") fail();
    this.#filePath = filePath;
    this.#fs = fsApi;
    this.#makeId = makeId;
  }

  list(rawBotId) {
    return this.#enqueue(async () => {
      const owner = botId(rawBotId);
      const state = await this.#readState();
      return publicValue(state.conversations
        .filter((entry) => entry.botId === owner)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    });
  }

  read(rawBotId, rawConversationId) {
    return this.#enqueue(async () => {
      const owner = botId(rawBotId);
      const id = conversationId(rawConversationId);
      const state = await this.#readState();
      const found = state.conversations.find((entry) => entry.botId === owner
        && entry.conversationId === id);
      return found ? publicValue(found) : null;
    });
  }

  create(value) {
    let normalized;
    try { normalized = record(value); } catch { return Promise.reject(new StandaloneConversationStoreError()); }
    return this.#mutate((state) => {
      if (state.conversations.length >= MAX_CONVERSATIONS
        || state.conversations.some((entry) => entry.conversationId === normalized.conversationId)) fail();
      state.conversations.push(normalized);
      return normalized;
    });
  }

  replace(value) {
    let normalized;
    try { normalized = record(value); } catch { return Promise.reject(new StandaloneConversationStoreError()); }
    return this.#mutate((state) => {
      const index = state.conversations.findIndex((entry) => entry.conversationId === normalized.conversationId);
      if (index < 0 || state.conversations[index].botId !== normalized.botId
        || state.conversations[index].createdAt !== normalized.createdAt) fail();
      state.conversations[index] = normalized;
      return normalized;
    });
  }

  #enqueue(operation) {
    const next = this.#queue.then(operation, operation).catch(() => { throw new StandaloneConversationStoreError(); });
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #mutate(operation) {
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const result = operation(state);
      await this.#writeState(state);
      return publicValue(result);
    });
  }

  async #readState() {
    let stat;
    try { stat = await this.#fs.lstat(this.#filePath); }
    catch (error) {
      if (error?.code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, conversations: [] };
      fail();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail();
    if ((stat.mode & 0o777) !== 0o600) {
      try {
        await this.#fs.chmod(this.#filePath, 0o600);
        stat = await this.#fs.lstat(this.#filePath);
      } catch { fail(); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES
        || (stat.mode & 0o777) !== 0o600) fail();
    }
    let source;
    try { source = await this.#fs.readFile(this.#filePath, "utf8"); } catch { fail(); }
    if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) fail();
    try { return normalizeState(JSON.parse(source)); } catch { fail(); }
  }

  async #writeState(state) {
    let source;
    try { source = `${JSON.stringify(normalizeState(state), null, 2)}\n`; } catch { fail(); }
    if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) fail();
    const directory = path.dirname(this.#filePath);
    let temporary;
    let handle = null;
    try {
      await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await this.#fs.chmod(directory, 0o700);
      const directoryStat = await this.#fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail();
      const uuid = this.#makeId();
      if (typeof uuid !== "string" || !/^[0-9a-f-]{36}$/i.test(uuid)) fail();
      temporary = path.join(directory, `.${path.basename(this.#filePath)}.${uuid}.tmp`);
      handle = await this.#fs.open(temporary, "wx", 0o600);
      await handle.writeFile(source, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#fs.rename(temporary, this.#filePath);
      temporary = null;
      await this.#fs.chmod(this.#filePath, 0o600);
      try {
        const directoryHandle = await this.#fs.open(directory, "r");
        await directoryHandle.sync();
        await directoryHandle.close();
      } catch {}
    } catch {
      try { await handle?.close(); } catch {}
      if (temporary) {
        try { await this.#fs.rm(temporary, { force: true }); } catch {}
      }
      fail();
    }
  }
}

module.exports = {
  StandaloneConversationStore,
  StandaloneConversationStoreError,
};
