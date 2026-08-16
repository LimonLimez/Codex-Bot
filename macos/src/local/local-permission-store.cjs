"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MAX_GRANTS = 8192;
const MAX_BOOKMARK_BYTES = 64 * 1024;
const MAX_LABEL_BYTES = 320;
const PATH_QUEUES = new Map();

const STORE_FIELDS = new Set(["schemaVersion", "grants"]);
const GRANT_FIELDS = new Set([
  "grantId",
  "botId",
  "targetId",
  "targetGeneration",
  "capability",
  "resourceId",
  "resourceLabel",
  "scope",
  "createdAt",
  "bookmark",
]);
const REQUEST_FIELDS = new Set([
  "botId",
  "targetId",
  "targetGeneration",
  "capability",
  "resourceId",
  "resourceLabel",
]);
const TARGET_FILTER_FIELDS = new Set(["targetId", "targetGeneration"]);
const CAPABILITIES = new Set([
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_ID_PATTERN = /^grant-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneData(value, seen = new Set()) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value !== "object") throw new TypeError("Permission data must contain plain data values only.");
  if (seen.has(value)) throw new TypeError("Permission data cannot contain cycles.");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Permission data must use plain objects and arrays.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Permission data cannot contain symbol fields.");
  }
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError("Permission data contains a forbidden field.");
    if (!("value" in descriptors[key])) throw new TypeError("Permission data must not contain accessors.");
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw new TypeError("Permission data arrays must be dense.");
    }
  }
  seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = cloneData(descriptors[key].value, seen);
  }
  seen.delete(value);
  return copy;
}

function cloneRequest(value) {
  try {
    return cloneData(value);
  } catch {
    throw new TypeError("Permission request must contain plain data values only.");
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key) || !allowed.has(key)) {
      throw new Error(`${label} contains an unsupported field.`);
    }
  }
  for (const key of allowed) {
    if (!hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) throw new Error("Bot ID is invalid.");
  return value.toLowerCase();
}

function normalizeTargetId(value) {
  if (typeof value !== "string" || !TARGET_ID_PATTERN.test(value)) {
    throw new Error("Local target ID is invalid.");
  }
  return value.toLowerCase();
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Target generation is invalid.");
  return value;
}

function normalizeCapability(value) {
  if (typeof value !== "string" || !CAPABILITIES.has(value)) {
    throw new Error("Permission capability is invalid.");
  }
  return value;
}

function normalizeResourceId(value) {
  if (typeof value !== "string" || !RESOURCE_ID_PATTERN.test(value)
    || value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw new Error("Permission resource ID is invalid.");
  }
  return value;
}

function normalizeResourceLabel(value) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_LABEL_BYTES
    || /[\0-\x1f\x7f]/.test(value)
    || /[\\/]/.test(value)
    || /(?:^|\s)~(?:\/|\s|$)/.test(value)
    || /(?:^|\s)(?:file:|\/Users\/)/i.test(value)) {
    throw new Error("Permission resource label is invalid or contains a path.");
  }
  return value;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string") throw new Error("Grant timestamp is invalid.");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("Grant timestamp is invalid.");
  }
  return value;
}

function normalizeTargetFilter(value) {
  const input = assertPlainObject(cloneRequest(value), "Permission target");
  assertExactKeys(input, TARGET_FILTER_FIELDS, "Permission target");
  return {
    targetId: normalizeTargetId(input.targetId),
    targetGeneration: normalizeGeneration(input.targetGeneration),
  };
}

function normalizeGrantId(value) {
  if (typeof value !== "string" || !GRANT_ID_PATTERN.test(value)) throw new Error("Grant ID is invalid.");
  return value.toLowerCase();
}

function safeUUID(makeUUID) {
  const value = makeUUID();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Generated UUID is invalid.");
  return value.toLowerCase();
}

function normalizeRequest(value) {
  const request = assertPlainObject(cloneRequest(value), "Permission request");
  assertExactKeys(request, REQUEST_FIELDS, "Permission request");
  return {
    botId: normalizeBotId(request.botId),
    targetId: normalizeTargetId(request.targetId),
    targetGeneration: normalizeGeneration(request.targetGeneration),
    capability: normalizeCapability(request.capability),
    resourceId: normalizeResourceId(request.resourceId),
    resourceLabel: normalizeResourceLabel(request.resourceLabel),
  };
}

function normalizeBookmark(value) {
  let bookmark;
  if (Buffer.isBuffer(value)) bookmark = Buffer.from(value);
  else if (value instanceof Uint8Array) bookmark = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else throw new TypeError("Permission bookmark must contain platform bookmark bytes.");
  if (bookmark.length === 0 || bookmark.length > MAX_BOOKMARK_BYTES) {
    throw new Error("Permission bookmark is empty or oversized.");
  }
  return bookmark;
}

function decodeBookmark(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_BOOKMARK_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Stored permission bookmark is malformed.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.length > MAX_BOOKMARK_BYTES || decoded.toString("base64") !== value) {
    throw new Error("Stored permission bookmark is malformed.");
  }
  return decoded;
}

function normalizeGrant(value) {
  const grant = assertPlainObject(value, "Grant");
  assertExactKeys(grant, GRANT_FIELDS, "Grant");
  if (grant.scope !== "always") throw new Error("Grant scope is invalid.");
  const normalized = {
    grantId: normalizeGrantId(grant.grantId),
    botId: normalizeBotId(grant.botId),
    targetId: normalizeTargetId(grant.targetId),
    targetGeneration: normalizeGeneration(grant.targetGeneration),
    capability: normalizeCapability(grant.capability),
    resourceId: normalizeResourceId(grant.resourceId),
    resourceLabel: normalizeResourceLabel(grant.resourceLabel),
    scope: "always",
    createdAt: normalizeTimestamp(grant.createdAt),
    bookmark: grant.bookmark,
  };
  decodeBookmark(normalized.bookmark);
  return normalized;
}

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, grants: [] };
}

function normalizeStore(value) {
  const store = assertPlainObject(value, "Permission store");
  assertExactKeys(store, STORE_FIELDS, "Permission store");
  if (store.schemaVersion !== SCHEMA_VERSION) throw new Error("Permission store schema is unsupported.");
  if (!Array.isArray(store.grants) || store.grants.length > MAX_GRANTS) {
    throw new Error("Permission store grants are malformed or oversized.");
  }
  const grants = store.grants.map(normalizeGrant);
  const ids = new Set();
  const tuples = new Set();
  for (const grant of grants) {
    const tuple = grantTuple(grant);
    if (ids.has(grant.grantId)) throw new Error("Permission store contains a duplicate grant ID.");
    if (tuples.has(tuple)) throw new Error("Permission store contains a duplicate grant.");
    ids.add(grant.grantId);
    tuples.add(tuple);
  }
  return { schemaVersion: SCHEMA_VERSION, grants };
}

function grantTuple(value) {
  return [
    value.botId,
    value.targetId,
    value.targetGeneration,
    value.capability,
    value.resourceId,
    value.resourceLabel,
  ].join("\0");
}

function publicGrant(grant) {
  return deepFreeze({
    grantId: grant.grantId,
    botId: grant.botId,
    capability: grant.capability,
    resourceId: grant.resourceId,
    resourceLabel: grant.resourceLabel,
    scope: "always",
    createdAt: grant.createdAt,
  });
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

function unsupportedSync(error) {
  return ["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code);
}

class LocalPermissionStore {
  #filePath;
  #fs;
  #now;
  #randomUUID;

  constructor({ filePath, fs: fsApi = fs, now = () => new Date().toISOString(), randomUUID = crypto.randomUUID } = {}) {
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
      throw new TypeError("Permission store file path is required.");
    }
    if (!fsApi || typeof fsApi.readFile !== "function" || typeof fsApi.open !== "function") {
      throw new TypeError("Permission store filesystem is invalid.");
    }
    if (typeof now !== "function" || typeof randomUUID !== "function") {
      throw new TypeError("Permission store clocks are invalid.");
    }
    this.#filePath = path.resolve(filePath);
    this.#fs = fsApi;
    this.#now = now;
    this.#randomUUID = randomUUID;
  }

  async authorize(value) {
    const request = normalizeRequest(value);
    return enqueuePath(this.#filePath, async () => {
      const state = await this.#readFile();
      const grant = state.grants.find((candidate) => grantTuple(candidate) === grantTuple(request));
      if (!grant) return Object.freeze({ allowed: false });
      return Object.freeze({
        allowed: true,
        grant: publicGrant(grant),
        privateBookmark: decodeBookmark(grant.bookmark),
      });
    });
  }

  async remember(value, rawBookmark) {
    const request = normalizeRequest(value);
    const bookmark = normalizeBookmark(rawBookmark).toString("base64");
    return enqueuePath(this.#filePath, async () => {
      const state = await this.#readFile();
      const existing = state.grants.find((candidate) => grantTuple(candidate) === grantTuple(request));
      if (existing) return publicGrant(existing);
      const grant = normalizeGrant({
        grantId: `grant-${safeUUID(this.#randomUUID)}`,
        ...request,
        scope: "always",
        createdAt: normalizeTimestamp(this.#now()),
        bookmark,
      });
      state.grants.push(grant);
      await this.#writeFile(normalizeStore(state));
      return publicGrant(grant);
    });
  }

  async revoke(botId, grantId) {
    const normalizedBotId = normalizeBotId(botId);
    const normalizedGrantId = normalizeGrantId(grantId);
    return enqueuePath(this.#filePath, async () => {
      const state = await this.#readFile();
      const index = state.grants.findIndex((grant) => (
        grant.botId === normalizedBotId && grant.grantId === normalizedGrantId
      ));
      if (index === -1) throw new Error("Permission grant was not found or is unavailable.");
      state.grants.splice(index, 1);
      await this.#writeFile(normalizeStore(state));
    });
  }

  async deleteBot(botId) {
    const normalizedBotId = normalizeBotId(botId);
    return enqueuePath(this.#filePath, async () => {
      const state = await this.#readFile();
      const grants = state.grants.filter((grant) => grant.botId !== normalizedBotId);
      if (grants.length === state.grants.length) return;
      await this.#writeFile(normalizeStore({ ...state, grants }));
    });
  }

  async listPublic(botId, target = null) {
    const normalizedBotId = normalizeBotId(botId);
    const normalizedTarget = target === null ? null : normalizeTargetFilter(target);
    return enqueuePath(this.#filePath, async () => {
      const state = await this.#readFile();
      return deepFreeze(state.grants
        .filter((grant) => grant.botId === normalizedBotId
          && (normalizedTarget === null || (grant.targetId === normalizedTarget.targetId
            && grant.targetGeneration === normalizedTarget.targetGeneration)))
        .map(publicGrant));
    });
  }

  async #readFile() {
    let handle;
    try {
      handle = await this.#fs.open(
        this.#filePath,
        nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return emptyStore();
      if (error?.code === "ELOOP") throw new Error("Permission store must be a private real file, not a symbolic link.");
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.isSymbolicLink?.() || (stat.mode & 0o077) !== 0) {
        throw new Error("Permission store must be a private real file.");
      }
      let parsed;
      try {
        parsed = JSON.parse(await handle.readFile("utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("Permission store is malformed.");
        throw error;
      }
      return normalizeStore(cloneData(parsed));
    } finally {
      await handle.close();
    }
  }

  async #writeFile(state) {
    const directory = path.dirname(this.#filePath);
    await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await this.#fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Permission store parent must be a private real directory.");
    }
    await this.#fs.chmod?.(directory, 0o700);

    const temporary = path.join(
      directory,
      `.${path.basename(this.#filePath)}.${safeUUID(this.#randomUUID)}.tmp`,
    );
    const contents = `${JSON.stringify(state, null, 2)}\n`;
    let handle;
    let ownsTemporary = false;
    try {
      handle = await this.#fs.open(
        temporary,
        nodeFs.constants.O_WRONLY
          | nodeFs.constants.O_CREAT
          | nodeFs.constants.O_EXCL
          | (nodeFs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      ownsTemporary = true;
      await handle.writeFile(contents, "utf8");
      if (typeof handle.sync === "function") {
        try {
          await handle.sync();
        } catch (error) {
          if (!unsupportedSync(error)) throw error;
        }
      }
      await handle.close();
      handle = null;
      await this.#fs.rename(temporary, this.#filePath);
      ownsTemporary = false;
      await this.#fs.chmod?.(this.#filePath, 0o600);
      await this.#syncDirectory(directory);
    } catch (error) {
      if (handle) {
        try { await handle.close(); } catch {}
      }
      if (ownsTemporary) {
        try { await this.#fs.rm(temporary, { force: true }); } catch {}
      }
      throw error;
    }
  }

  async #syncDirectory(directory) {
    let handle;
    try {
      handle = await this.#fs.open(directory, nodeFs.constants.O_RDONLY);
    } catch (error) {
      if (unsupportedSync(error) || error?.code === "EISDIR") return;
      throw error;
    }
    try {
      if (typeof handle.sync === "function") {
        try {
          await handle.sync();
        } catch (error) {
          if (!unsupportedSync(error)) throw error;
        }
      }
    } finally {
      await handle.close();
    }
  }
}

module.exports = {
  CAPABILITIES,
  LocalPermissionStore,
  SCHEMA_VERSION,
};
