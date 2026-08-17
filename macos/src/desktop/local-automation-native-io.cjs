"use strict";

const nodeFs = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPTION_FIELDS = new Set([
  "filePath", "fs", "randomUUID", "currentUid",
  "lstatSync", "openSync", "fstatSync", "closeSync", "realpathSync",
]);

class LocalAutomationNativeIOError extends Error {
  constructor() {
    super("OpenBot local Routine storage IO failed.");
    this.name = "LocalAutomationNativeIOError";
    this.code = "OPENBOT_LOCAL_AUTOMATION_IO_FAILED";
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: "LocalAutomationNativeIOError: OpenBot local Routine storage IO failed.",
      writable: true,
    });
  }
}

function fail() { throw new LocalAutomationNativeIOError(); }

function options(value) {
  if (value === undefined) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail(); }
  if (prototype !== Object.prototype && prototype !== null
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !OPTION_FIELDS.has(key) || !("value" in descriptors[key]))) fail();
  return Object.fromEntries(Object.entries(descriptors)
    .map(([key, descriptor]) => [key, descriptor.value]));
}

function safeComponent(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

function timeNs(stat, field) {
  const nanoseconds = stat[`${field}Ns`];
  if (typeof nanoseconds === "bigint") return nanoseconds;
  const milliseconds = stat[`${field}Ms`];
  if (typeof milliseconds === "bigint") return milliseconds * 1_000_000n;
  if (Number.isFinite(milliseconds)) return BigInt(Math.trunc(milliseconds * 1_000_000));
  fail();
}

function directoryIdentity(stat, currentUid) {
  if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()
    || typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()
    || (BigInt(stat.mode) & 0o7777n) !== 0o700n
    || BigInt(stat.uid) !== BigInt(currentUid)) fail();
  return Object.freeze({
    dev: BigInt(stat.dev),
    ino: BigInt(stat.ino),
    uid: BigInt(stat.uid),
    mode: BigInt(stat.mode),
    birthtimeNs: timeNs(stat, "birthtime"),
  });
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.birthtimeNs === right.birthtimeNs;
}

function fileIdentity(stat, directory, maximum = MAX_STATE_BYTES) {
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()
    || typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()
    || BigInt(stat.dev) !== directory.dev || BigInt(stat.uid) !== directory.uid
    || (BigInt(stat.mode) & 0o7777n) !== 0o600n || BigInt(stat.nlink) !== 1n
    || BigInt(stat.size) < 0n || BigInt(stat.size) > BigInt(maximum)) fail();
  return Object.freeze({
    dev: BigInt(stat.dev),
    ino: BigInt(stat.ino),
    uid: BigInt(stat.uid),
    mode: BigInt(stat.mode),
    nlink: BigInt(stat.nlink),
    size: BigInt(stat.size),
    birthtimeNs: timeNs(stat, "birthtime"),
    mtimeNs: timeNs(stat, "mtime"),
    ctimeNs: timeNs(stat, "ctime"),
  });
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
    && left.birthtimeNs === right.birthtimeNs && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function stableDirectoryPath(identity) {
  return `/.vol/${identity.dev}/${identity.ino}`;
}

function missing(error) { return error?.code === "ENOENT"; }

class LocalAutomationNativeIO {
  #directory;
  #stableDirectory;
  #fileName;
  #target;
  #fs;
  #makeId;
  #currentUid;
  #expectedDirectory;
  #realpathSync;

  constructor(rawOptions) {
    const raw = options(rawOptions);
    const fsApi = raw.fs ?? fs;
    const makeId = raw.randomUUID ?? randomUUID;
    const currentUid = raw.currentUid
      ?? (typeof process.getuid === "function" ? process.getuid() : -1);
    const lstatSync = raw.lstatSync ?? nodeFs.lstatSync;
    const openSync = raw.openSync ?? nodeFs.openSync;
    const fstatSync = raw.fstatSync ?? nodeFs.fstatSync;
    const closeSync = raw.closeSync ?? nodeFs.closeSync;
    const realpathSync = raw.realpathSync ?? nodeFs.realpathSync.native;
    const fileName = typeof raw.filePath === "string" ? path.basename(raw.filePath) : null;
    if (typeof raw.filePath !== "string" || !path.isAbsolute(raw.filePath)
      || path.normalize(raw.filePath) !== raw.filePath || !safeComponent(fileName)
      || !fsApi || typeof fsApi.open !== "function" || typeof fsApi.lstat !== "function"
      || typeof fsApi.rename !== "function" || typeof fsApi.unlink !== "function"
      || typeof makeId !== "function" || !Number.isSafeInteger(currentUid) || currentUid < 0
      || typeof lstatSync !== "function" || typeof openSync !== "function"
      || typeof fstatSync !== "function" || typeof closeSync !== "function"
      || typeof realpathSync !== "function") fail();

    let descriptor;
    try {
      const requestedDirectory = path.dirname(raw.filePath);
      const directory = realpathSync(requestedDirectory);
      if (typeof directory !== "string" || !path.isAbsolute(directory)
        || path.normalize(directory) !== directory || directory !== requestedDirectory) fail();
      const named = directoryIdentity(lstatSync(directory, { bigint: true }), currentUid);
      descriptor = openSync(directory,
        nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY
          | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC);
      const opened = directoryIdentity(fstatSync(descriptor, { bigint: true }), currentUid);
      const stableDirectory = stableDirectoryPath(opened);
      const stable = directoryIdentity(lstatSync(stableDirectory, { bigint: true }), currentUid);
      if (!sameDirectory(named, opened) || !sameDirectory(opened, stable)) fail();
      this.#directory = directory;
      this.#stableDirectory = stableDirectory;
      this.#fileName = fileName;
      this.#target = `${stableDirectory}/${fileName}`;
      this.#fs = fsApi;
      this.#makeId = makeId;
      this.#currentUid = currentUid;
      this.#expectedDirectory = opened;
      this.#realpathSync = realpathSync;
    } catch { fail(); }
    finally {
      try { if (descriptor !== undefined) closeSync(descriptor); } catch {}
    }
  }

  read() {
    return this.#sanitize(() => this.#withDirectory(async () => {
      const result = await this.#readTarget();
      return result.missing ? null : result.source;
    }));
  }

  write(source) {
    return this.#sanitize(async () => {
      if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) fail();
      const bytes = Buffer.from(source, "utf8");
      return this.#withDirectory(async (directoryHandle) => {
        const targetBefore = await this.#targetSnapshot();
        const uuid = this.#newUuid();
        const temporaryName = `.${this.#fileName}.${uuid}.tmp`;
        if (!safeComponent(temporaryName) || temporaryName.length > 255) fail();
        const temporary = `${this.#stableDirectory}/${temporaryName}`;
        let temporaryHandle;
        let temporarySnapshot = null;
        let cleanupAllowed = true;
        try {
          temporaryHandle = await this.#fs.open(temporary,
            nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL
              | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC,
            0o600);
          const createdHandle = fileIdentity(await temporaryHandle.stat({ bigint: true }),
            this.#expectedDirectory);
          const createdPath = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }),
            this.#expectedDirectory);
          if (!sameFile(createdHandle, createdPath) || createdHandle.size !== 0n) fail();
          temporarySnapshot = createdPath;
          await this.#writeExact(temporaryHandle, bytes);
          await temporaryHandle.sync();
          const syncedHandle = fileIdentity(await temporaryHandle.stat({ bigint: true }),
            this.#expectedDirectory);
          const syncedPath = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }),
            this.#expectedDirectory);
          if (!sameFile(syncedHandle, syncedPath) || syncedHandle.size !== BigInt(bytes.length)) fail();
          temporarySnapshot = syncedPath;
          await temporaryHandle.close();
          temporaryHandle = undefined;
          await this.#assertTargetUnchanged(targetBefore);
          const ready = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }),
            this.#expectedDirectory);
          if (!sameFile(syncedPath, ready)) fail();

          cleanupAllowed = false;
          let renameResult;
          try {
            renameResult = this.#fs.rename(temporary, this.#target);
          } catch {
            await this.#recoverRenameFailure(
              directoryHandle, temporary, temporarySnapshot, source);
            return undefined;
          }
          try {
            await renameResult;
          } catch {
            await this.#recoverRenameFailure(
              directoryHandle, temporary, temporarySnapshot, source);
            return undefined;
          }
          try {
            await directoryHandle.sync();
          } catch {
            await this.#verifyUncertainCommit(directoryHandle, source);
            return undefined;
          }
          const committed = await this.#readTarget();
          if (committed.missing || committed.source !== source) fail();
          return undefined;
        } finally {
          if (cleanupAllowed) {
            await this.#cleanupOwnedTemporary(temporary, temporaryHandle, temporarySnapshot);
          }
          try { await temporaryHandle?.close(); } catch {}
        }
      });
    });
  }

  #sanitize(operation) {
    return Promise.resolve().then(operation)
      .catch(() => { throw new LocalAutomationNativeIOError(); });
  }

  #newUuid() {
    let value;
    try { value = this.#makeId(); } catch { fail(); }
    if (typeof value !== "string" || !UUID.test(value)) fail();
    return value;
  }

  async #assertDirectory(handle) {
    let canonical;
    try { canonical = this.#realpathSync(this.#directory); } catch { fail(); }
    if (canonical !== this.#directory) fail();
    const opened = directoryIdentity(await handle.stat({ bigint: true }), this.#currentUid);
    const named = directoryIdentity(await this.#fs.lstat(this.#directory, { bigint: true }),
      this.#currentUid);
    const stable = directoryIdentity(await this.#fs.lstat(this.#stableDirectory, { bigint: true }),
      this.#currentUid);
    if (!sameDirectory(this.#expectedDirectory, opened)
      || !sameDirectory(opened, named) || !sameDirectory(opened, stable)) fail();
  }

  async #withDirectory(operation) {
    let handle;
    try {
      handle = await this.#fs.open(this.#directory,
        nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY
          | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC);
      await this.#assertDirectory(handle);
      const result = await operation(handle);
      await this.#assertDirectory(handle);
      return result;
    } catch { fail(); }
    finally {
      try { await handle?.close(); } catch {}
    }
  }

  async #targetSnapshot() {
    try {
      return fileIdentity(await this.#fs.lstat(this.#target, { bigint: true }),
        this.#expectedDirectory);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async #assertTargetUnchanged(before) {
    const after = await this.#targetSnapshot();
    if (before === null ? after !== null : after === null || !sameFile(before, after)) fail();
  }

  async #readTarget() {
    let before;
    try {
      before = fileIdentity(await this.#fs.lstat(this.#target, { bigint: true }),
        this.#expectedDirectory);
    } catch (error) {
      if (missing(error)) return { missing: true };
      throw error;
    }
    let handle;
    try {
      handle = await this.#fs.open(this.#target,
        nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_CLOEXEC);
      const opened = fileIdentity(await handle.stat({ bigint: true }), this.#expectedDirectory);
      if (!sameFile(before, opened)) fail();
      const bytes = await this.#readBounded(handle);
      const finished = fileIdentity(await handle.stat({ bigint: true }), this.#expectedDirectory);
      const named = fileIdentity(await this.#fs.lstat(this.#target, { bigint: true }),
        this.#expectedDirectory);
      if (!sameFile(before, finished) || !sameFile(before, named)
        || BigInt(bytes.length) !== before.size) fail();
      const source = bytes.toString("utf8");
      if (!Buffer.from(source, "utf8").equals(bytes)) fail();
      return { missing: false, source };
    } finally {
      try { await handle?.close(); } catch {}
    }
  }

  async #readBounded(handle) {
    const chunks = [];
    let total = 0;
    while (true) {
      const room = MAX_STATE_BYTES + 1 - total;
      if (room <= 0) fail();
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, room));
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0
        || result.bytesRead > buffer.length) fail();
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > MAX_STATE_BYTES) fail();
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, total);
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

  async #verifyUncertainCommit(directoryHandle, source) {
    await this.#assertDirectory(directoryHandle);
    const first = await this.#readTarget();
    if (first.missing || first.source !== source) fail();
    await directoryHandle.sync();
    const second = await this.#readTarget();
    if (second.missing || second.source !== source) fail();
  }

  async #temporaryDisposition(temporary, snapshot) {
    try {
      const named = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }),
        this.#expectedDirectory);
      return snapshot && sameFile(snapshot, named) ? "owned" : "foreign";
    } catch (error) {
      return missing(error) ? "missing" : "foreign";
    }
  }

  async #recoverRenameFailure(directoryHandle, temporary, snapshot, source) {
    await this.#assertDirectory(directoryHandle);
    const disposition = await this.#temporaryDisposition(temporary, snapshot);
    if (disposition === "owned") {
      await this.#fs.unlink(temporary);
      fail();
    }
    if (disposition !== "missing") fail();
    await this.#verifyUncertainCommit(directoryHandle, source);
  }

  async #cleanupOwnedTemporary(temporary, handle, snapshot) {
    if (!temporary || (!handle && !snapshot)) return;
    try {
      const opened = handle
        ? fileIdentity(await handle.stat({ bigint: true }), this.#expectedDirectory)
        : snapshot;
      const named = fileIdentity(await this.#fs.lstat(temporary, { bigint: true }),
        this.#expectedDirectory);
      if (!sameFile(opened, named)) return;
      await this.#fs.unlink(temporary);
    } catch {}
  }
}

module.exports = {
  LocalAutomationNativeIO,
  LocalAutomationNativeIOError,
};
