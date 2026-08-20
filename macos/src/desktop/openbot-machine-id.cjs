"use strict";

const nodeFs = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");

const SCHEMA_VERSION = 1;
const FILE_NAME = "openbot-machine-id.v1.json";
const PRIVATE_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 256;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPEN_DIRECTORY_FLAGS = nodeFs.constants.O_RDONLY
  | nodeFs.constants.O_DIRECTORY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC;
const OPEN_FILE_FLAGS = nodeFs.constants.O_RDONLY
  | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC;
const OPEN_TEMP_FLAGS = nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT
  | nodeFs.constants.O_EXCL | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC;

class OpenBotMachineIdStoreError extends Error {
  constructor() {
    super("OpenBot machine identity is unavailable.");
    this.name = "OpenBotMachineIdStoreError";
    this.code = "OPENBOT_MACHINE_ID_FAILED";
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function fail() {
  throw new OpenBotMachineIdStoreError();
}

function ownOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  const allowed = new Set(["filePath", "fsApi", "randomUUID", "currentUid"]);
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]))) {
    fail();
  }
  if (!descriptors.filePath || !("value" in descriptors.filePath)) fail();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function asBigInt(value) {
  try { return BigInt(value); } catch { fail(); }
}

function timeValue(stat, field) {
  return stat[field] === undefined ? null : asBigInt(stat[field]);
}

function directoryIdentity(stat, currentUid) {
  if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()
    || typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()
    || (asBigInt(stat.mode) & 0o7777n) !== BigInt(PRIVATE_MODE)
    || asBigInt(stat.uid) !== BigInt(currentUid)) fail();
  return Object.freeze({
    dev: asBigInt(stat.dev),
    ino: asBigInt(stat.ino),
    uid: asBigInt(stat.uid),
    mode: asBigInt(stat.mode),
    birthtimeNs: timeValue(stat, "birthtimeNs"),
  });
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}

function fileIdentity(stat, directory, currentUid, { allowLinked = false } = {}) {
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()
    || typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()
    || asBigInt(stat.dev) !== directory.dev || asBigInt(stat.uid) !== BigInt(currentUid)
    || (asBigInt(stat.mode) & 0o7777n) !== BigInt(FILE_MODE)
    || (!allowLinked && asBigInt(stat.nlink) !== 1n)
    || asBigInt(stat.size) < 0n || asBigInt(stat.size) > BigInt(MAX_FILE_BYTES)) fail();
  return Object.freeze({
    dev: asBigInt(stat.dev),
    ino: asBigInt(stat.ino),
    uid: asBigInt(stat.uid),
    mode: asBigInt(stat.mode),
    nlink: asBigInt(stat.nlink),
    size: asBigInt(stat.size),
    birthtimeNs: timeValue(stat, "birthtimeNs"),
    mtimeNs: timeValue(stat, "mtimeNs"),
    ctimeNs: timeValue(stat, "ctimeNs"),
  });
}

function sameFile(left, right, { includeNlink = true, includeTimes = true } = {}) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.size === right.size
    && (!includeNlink || left.nlink === right.nlink)
    && (!includeTimes || (left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs
      && left.ctimeNs === right.ctimeNs));
}

function canonicalDirectoryPath(directory) {
  let canonical;
  try { canonical = nodeFs.realpathSync.native(directory); } catch { fail(); }
  if (canonical !== directory || path.normalize(canonical) !== canonical) fail();
  return canonical;
}

function stableDirectoryPath(directory, identity) {
  try {
    const candidate = `/.vol/${identity.dev}/${identity.ino}`;
    const stat = nodeFs.lstatSync(candidate, { bigint: true });
    if (sameDirectory(identity, directoryIdentity(stat, identity.uid))) {
      return candidate;
    }
  } catch {
    // The machine-id store is macOS-only; a mutable named parent is not an acceptable fallback.
  }
  fail();
}

function validUuid(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

function canonicalSource(machineId) {
  if (!validUuid(machineId)) fail();
  return `{"schemaVersion":1,"machineId":"${machineId}"}\n`;
}

function parseSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) fail();
  let parsed;
  try { parsed = JSON.parse(source); } catch { fail(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  const keys = Reflect.ownKeys(descriptors);
  if (Object.getPrototypeOf(parsed) !== Object.prototype || keys.length !== 2
    || keys.some((key) => typeof key !== "string" || !new Set(["schemaVersion", "machineId"]).has(key)
      || !("value" in descriptors[key])) || parsed.schemaVersion !== SCHEMA_VERSION
    || !validUuid(parsed.machineId) || source !== canonicalSource(parsed.machineId)) fail();
  return parsed.machineId;
}

class OpenBotMachineIdStore {
  #filePath;
  #directory;
  #fileName;
  #fs;
  #randomUUID;
  #currentUid;
  #readFlight = null;

  constructor(rawOptions = {}) {
    const options = ownOptions(rawOptions);
    const filePath = options.filePath;
    const fsApi = options.fsApi || fs;
    const makeId = options.randomUUID || randomUUID;
    const currentUid = options.currentUid
      ?? (typeof process.getuid === "function" ? process.getuid() : -1);
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)
      || path.normalize(filePath) !== filePath || filePath.includes("\0")
      || path.basename(filePath) !== FILE_NAME || path.basename(path.dirname(filePath)) !== "codex-bot"
      || !fsApi || typeof fsApi.lstat !== "function" || typeof fsApi.open !== "function"
      || typeof fsApi.mkdir !== "function" || typeof fsApi.link !== "function"
      || typeof fsApi.unlink !== "function" || typeof makeId !== "function"
      || !Number.isSafeInteger(currentUid) || currentUid < 0) fail();
    this.#filePath = filePath;
    this.#directory = path.dirname(filePath);
    this.#fileName = FILE_NAME;
    this.#fs = fsApi;
    this.#randomUUID = makeId;
    this.#currentUid = currentUid;
  }

  read() {
    if (this.#readFlight) return this.#readFlight;
    const flight = Promise.resolve().then(() => this.#readOrCreate());
    const settled = flight.finally(() => {
      if (this.#readFlight === settled) this.#readFlight = null;
    });
    this.#readFlight = settled;
    return settled;
  }

  async #readOrCreate() {
    let context;
    try {
      context = await this.#openDirectory();
      const current = await this.#readPublishedTarget(context);
      if (!current.missing) return current.machineId;
      return await this.#createAndPublish(context);
    } catch (error) {
      if (error instanceof OpenBotMachineIdStoreError) throw error;
      throw new OpenBotMachineIdStoreError();
    } finally {
      try { await context?.handle?.close(); } catch {}
    }
  }

  async #ensureDirectory() {
    const userData = path.dirname(this.#directory);
    const canonicalParent = canonicalDirectoryPath(userData);
    const namedParent = directoryIdentity(
      await this.#fs.lstat(canonicalParent, { bigint: true }), this.#currentUid,
    );
    let parentHandle;
    try {
      parentHandle = await this.#fs.open(canonicalParent, OPEN_DIRECTORY_FLAGS);
      const openedParent = directoryIdentity(await parentHandle.stat({ bigint: true }), this.#currentUid);
      if (!sameDirectory(namedParent, openedParent)) fail();
      const stableParent = stableDirectoryPath(canonicalParent, openedParent);
      const stableParentIdentity = directoryIdentity(
        await this.#fs.lstat(stableParent, { bigint: true }), this.#currentUid,
      );
      if (!sameDirectory(openedParent, stableParentIdentity)) fail();
      const stableChild = path.join(stableParent, path.basename(this.#directory));
      let created = false;
      try {
        directoryIdentity(await this.#fs.lstat(stableChild, { bigint: true }), this.#currentUid);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        try {
          await this.#fs.mkdir(stableChild, { mode: PRIVATE_MODE });
          created = true;
        } catch (mkdirError) {
          if (mkdirError?.code !== "EEXIST") throw mkdirError;
        }
      }
      if (created) {
        if (typeof parentHandle.sync !== "function") fail();
        await parentHandle.sync();
      }
      const stableChildIdentity = directoryIdentity(
        await this.#fs.lstat(stableChild, { bigint: true }), this.#currentUid,
      );
      const canonicalChild = canonicalDirectoryPath(this.#directory);
      const namedChildIdentity = directoryIdentity(
        await this.#fs.lstat(canonicalChild, { bigint: true }), this.#currentUid,
      );
      const finalOpenedParent = directoryIdentity(await parentHandle.stat({ bigint: true }), this.#currentUid);
      const finalNamedParent = directoryIdentity(
        await this.#fs.lstat(canonicalParent, { bigint: true }), this.#currentUid,
      );
      const finalStableParent = directoryIdentity(
        await this.#fs.lstat(stableParent, { bigint: true }), this.#currentUid,
      );
      const finalCanonicalParent = canonicalDirectoryPath(userData);
      const finalCanonicalChild = canonicalDirectoryPath(this.#directory);
      const finalNamedChild = directoryIdentity(
        await this.#fs.lstat(finalCanonicalChild, { bigint: true }), this.#currentUid,
      );
      if (canonicalParent !== userData || canonicalChild !== this.#directory
        || finalCanonicalParent !== userData || finalCanonicalChild !== this.#directory
        || !sameDirectory(namedParent, finalOpenedParent)
        || !sameDirectory(finalOpenedParent, finalNamedParent)
        || !sameDirectory(finalOpenedParent, finalStableParent)
        || !sameDirectory(stableChildIdentity, namedChildIdentity)
        || !sameDirectory(stableChildIdentity, finalNamedChild)) fail();
    } finally {
      try { await parentHandle?.close(); } catch {}
    }
  }

  async #openDirectory() {
    await this.#ensureDirectory();
    const directory = canonicalDirectoryPath(this.#directory);
    const named = directoryIdentity(await this.#fs.lstat(directory, { bigint: true }), this.#currentUid);
    const handle = await this.#fs.open(directory, OPEN_DIRECTORY_FLAGS);
    try {
      const opened = directoryIdentity(await handle.stat({ bigint: true }), this.#currentUid);
      if (!sameDirectory(named, opened)) fail();
      return {
        directory,
        stableDirectory: stableDirectoryPath(directory, opened),
        handle,
        identity: opened,
      };
    } catch (error) {
      try { await handle.close(); } catch {}
      throw error;
    }
  }

  async #assertDirectory(context) {
    const canonical = canonicalDirectoryPath(context.directory);
    const opened = directoryIdentity(await context.handle.stat({ bigint: true }), this.#currentUid);
    const named = directoryIdentity(await this.#fs.lstat(canonical, { bigint: true }), this.#currentUid);
    const stable = directoryIdentity(await this.#fs.lstat(context.stableDirectory, { bigint: true }), this.#currentUid);
    if (canonical !== context.directory || !sameDirectory(context.identity, opened)
      || !sameDirectory(opened, named) || !sameDirectory(opened, stable)) fail();
  }

  async #readTarget(context, { allowLinked = false } = {}) {
    await this.#assertDirectory(context);
    const target = path.join(context.stableDirectory, this.#fileName);
    let before;
    try {
      before = fileIdentity(
        await this.#fs.lstat(target, { bigint: true }),
        context.identity,
        this.#currentUid,
        { allowLinked },
      );
    } catch (error) {
      if (error?.code === "ENOENT") return { missing: true };
      throw error;
    }
    let handle;
    try {
      handle = await this.#fs.open(target, OPEN_FILE_FLAGS);
      let opened;
      opened = fileIdentity(
        await handle.stat({ bigint: true }), context.identity, this.#currentUid, { allowLinked },
      );
      if (!sameFile(before, opened)) fail();
      const bytes = await this.#readBounded(handle);
      let finished;
      let named;
      finished = fileIdentity(
        await handle.stat({ bigint: true }), context.identity, this.#currentUid, { allowLinked },
      );
      named = fileIdentity(
        await this.#fs.lstat(target, { bigint: true }),
        context.identity,
        this.#currentUid,
        { allowLinked },
      );
      if (!sameFile(before, finished) || !sameFile(before, named) || BigInt(bytes.length) !== before.size) {
        fail();
      }
      const source = bytes.toString("utf8");
      if (!Buffer.from(source, "utf8").equals(bytes)) fail();
      return { missing: false, machineId: parseSource(source), identity: before };
    } finally {
      try { await handle?.close(); } catch {}
    }
  }

  async #readBounded(handle) {
    const chunks = [];
    let total = 0;
    while (true) {
      const room = MAX_FILE_BYTES + 1 - total;
      if (room <= 0) fail();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, room));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0
        || result.bytesRead > buffer.length) fail();
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > MAX_FILE_BYTES) fail();
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, total);
  }

  async #createAndPublish(context) {
    await this.#assertDirectory(context);
    const before = await this.#targetSnapshot(context, { allowLinked: true });
    if (before !== null) return (await this.#readPublishedTarget(context)).machineId;
    let machineId;
    try { machineId = this.#randomUUID(); } catch { fail(); }
    if (!validUuid(machineId)) fail();
    const source = canonicalSource(machineId);
    const bytes = Buffer.from(source, "utf8");
    const temporary = path.join(context.stableDirectory, `.${this.#fileName}.${machineId}.tmp`);
    let handle;
    let temporaryIdentity = null;
    let ownsTemporary = true;
    let linked = false;
    try {
      handle = await this.#fs.open(temporary, OPEN_TEMP_FLAGS, FILE_MODE);
      const createdHandle = fileIdentity(await handle.stat({ bigint: true }), context.identity, this.#currentUid);
      const createdPath = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }), context.identity, this.#currentUid);
      if (!sameFile(createdHandle, createdPath) || createdHandle.size !== 0n) fail();
      temporaryIdentity = createdPath;
      await this.#writeExact(handle, bytes);
      if (typeof handle.chmod !== "function" || typeof handle.sync !== "function") fail();
      await handle.chmod(FILE_MODE);
      await handle.sync();
      const syncedHandle = fileIdentity(await handle.stat({ bigint: true }), context.identity, this.#currentUid);
      const syncedPath = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }), context.identity, this.#currentUid);
      if (!sameFile(syncedHandle, syncedPath) || syncedHandle.size !== BigInt(bytes.length)) fail();
      temporaryIdentity = syncedPath;
      await handle.close();
      handle = undefined;
      await this.#assertDirectory(context);
      const targetBeforeLink = await this.#targetSnapshot(context, { allowLinked: true });
      if (targetBeforeLink !== null) {
        await this.#cleanupOwnedTemporary(context, temporary, temporaryIdentity, 1n);
        ownsTemporary = false;
        await context.handle.sync();
        return (await this.#readPublishedTarget(context)).machineId;
      }
      try {
        await this.#fs.link(temporary, path.join(context.stableDirectory, this.#fileName));
        linked = true;
      } catch (error) {
        const targetAfterLink = await this.#targetSnapshot(context, { allowLinked: true });
        const temporaryAfterLink = await this.#temporarySnapshot(context, temporary);
        if (targetAfterLink !== null && temporaryAfterLink !== null
          && targetAfterLink.nlink === 2n && temporaryAfterLink.nlink === 2n
          && sameFile(targetAfterLink, temporaryAfterLink, { includeNlink: false })) {
          linked = true;
          const recovered = await this.#recoverPublishedLink(context, targetAfterLink);
          ownsTemporary = false;
          return recovered.machineId;
        }
        if (error?.code !== "EEXIST" || targetAfterLink === null) throw error;
        await this.#cleanupOwnedTemporary(context, temporary, temporaryIdentity, 1n);
        ownsTemporary = false;
        await context.handle.sync();
        const winner = await this.#readPublishedTarget(context);
        if (winner.missing) fail();
        return winner.machineId;
      }
      const linkedTarget = fileIdentity(
        // The target and temporary link must be the same immutable inode.
        await this.#fs.lstat(path.join(context.stableDirectory, this.#fileName), { bigint: true }),
        context.identity,
        this.#currentUid,
        { allowLinked: true },
      );
      const linkedTemporary = fileIdentity(
        await this.#fs.lstat(temporary, { bigint: true }),
        context.identity,
        this.#currentUid,
        { allowLinked: true },
      );
      if (linkedTarget.nlink !== 2n || linkedTemporary.nlink !== 2n
        || !sameFile(linkedTarget, linkedTemporary, { includeNlink: false })) fail();
      await context.handle.sync();
      await this.#cleanupOwnedTemporary(context, temporary, temporaryIdentity, 2n);
      ownsTemporary = false;
      await context.handle.sync();
      const winner = await this.#readPublishedTarget(context);
      if (winner.missing) fail();
      return winner.machineId;
    } catch (error) {
      if (linked) {
        let recovered = null;
        try {
          await this.#cleanupOwnedTemporary(context, temporary, temporaryIdentity, 2n);
          ownsTemporary = false;
        } catch {}
        try { await context.handle.sync(); } catch {}
        try {
          const winner = await this.#readPublishedTarget(context);
          if (!winner.missing) recovered = winner.machineId;
        } catch {}
        if (recovered !== null) return recovered;
      }
      if (error instanceof OpenBotMachineIdStoreError) throw error;
      throw new OpenBotMachineIdStoreError();
    } finally {
      try { await handle?.close(); } catch {}
      if (ownsTemporary && temporaryIdentity !== null) {
        try {
          await this.#cleanupOwnedTemporary(context, temporary, temporaryIdentity, linked ? 2n : 1n);
        } catch {}
      }
    }
  }

  async #readPublishedTarget(context) {
    const snapshot = await this.#targetSnapshot(context, { allowLinked: true });
    if (snapshot === null) return { missing: true };
    if (snapshot.nlink === 1n) return this.#readTarget(context);
    if (snapshot.nlink === 2n) return this.#recoverPublishedLink(context, snapshot);
    fail();
  }

  async #recoverPublishedLink(context, expectedTarget) {
    const initialTarget = await this.#targetSnapshot(context, { allowLinked: true });
    if (initialTarget === null
      || !sameFile(expectedTarget, initialTarget, { includeNlink: false, includeTimes: false })) fail();
    if (initialTarget.nlink === 1n) {
      const finalized = await this.#readTarget(context);
      if (!sameFile(expectedTarget, finalized.identity, {
        includeNlink: false,
        includeTimes: false,
      })) fail();
      return finalized;
    }
    if (initialTarget.nlink !== 2n) fail();
    const linked = await this.#readTarget(context, { allowLinked: true });
    if (linked.identity.nlink === 1n
      && sameFile(expectedTarget, linked.identity, {
        includeNlink: false,
        includeTimes: false,
      })) return linked;
    if (!sameFile(expectedTarget, linked.identity)) fail();
    const temporary = path.join(
      context.stableDirectory, `.${this.#fileName}.${linked.machineId}.tmp`,
    );
    const currentTarget = await this.#targetSnapshot(context, { allowLinked: true });
    const currentTemporary = await this.#temporarySnapshot(context, temporary);
    if (currentTarget !== null && currentTarget.nlink === 1n && currentTemporary === null
      && sameFile(expectedTarget, currentTarget, { includeNlink: false, includeTimes: false })) {
      const finalized = await this.#readTarget(context);
      if (!sameFile(expectedTarget, finalized.identity, {
        includeNlink: false,
        includeTimes: false,
      })) fail();
      return finalized;
    }
    if (currentTarget === null || currentTemporary === null
      || currentTarget.nlink !== 2n || currentTemporary.nlink !== 2n
      || !sameFile(expectedTarget, currentTarget)
      || !sameFile(currentTarget, currentTemporary, { includeNlink: false })) fail();
    await this.#cleanupOwnedTemporary(context, temporary, currentTemporary, 2n);
    if (typeof context.handle.sync !== "function") fail();
    await context.handle.sync();
    const recovered = await this.#readTarget(context);
    const recoveredTarget = await this.#targetSnapshot(context);
    if (recoveredTarget === null || recoveredTarget.nlink !== 1n
      || !sameFile(recovered.identity, recoveredTarget)
      || !sameFile(expectedTarget, recoveredTarget, {
        includeNlink: false,
        includeTimes: false,
      })) fail();
    return recovered;
  }

  async #targetSnapshot(context, { allowLinked = false } = {}) {
    const target = path.join(context.stableDirectory, this.#fileName);
    try {
      const stat = await this.#fs.lstat(target, { bigint: true });
      return fileIdentity(stat, context.identity, this.#currentUid, { allowLinked });
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #temporarySnapshot(context, temporary) {
    try {
      return fileIdentity(
        await this.#fs.lstat(temporary, { bigint: true }),
        context.identity,
        this.#currentUid,
        { allowLinked: true },
      );
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async #cleanupOwnedTemporary(context, temporary, expected, expectedNlink) {
    let current;
    try {
      current = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }), context.identity, this.#currentUid,
        { allowLinked: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (current.nlink !== expectedNlink
      || !sameFile(current, expected, { includeNlink: false, includeTimes: false })) fail();
    await this.#fs.unlink(temporary);
  }

  async #writeExact(handle, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, null);
      if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0
        || result.bytesWritten > bytes.length - offset) fail();
      offset += result.bytesWritten;
    }
  }
}

module.exports = {
  FILE_NAME,
  MAX_FILE_BYTES,
  OpenBotMachineIdStore,
  OpenBotMachineIdStoreError,
  SCHEMA_VERSION,
  UUID_V4,
};
