"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { types } = require("node:util");

const LEGACY_NAME = "Codex Bot";
const PRODUCT_NAME = "OpenBot";
const FAILURE_MESSAGE = "OpenBot could not migrate the existing profile safely.";
const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 96;
const ACCEPTANCE_APP_DATA_OPTION = "--openbot-acceptance-app-data";
const ACCEPTANCE_APP_DATA_FLAG = `${ACCEPTANCE_APP_DATA_OPTION}=`;

class OpenBotUserDataError extends Error {
  constructor() {
    super(FAILURE_MESSAGE);
    this.name = "OpenBotUserDataError";
    this.code = "OPENBOT_USER_DATA_MIGRATION_FAILED";
  }
}

function fail() {
  throw new OpenBotUserDataError();
}

function denseArguments(value) {
  if (!Array.isArray(value) || types.isProxy(value)) fail();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 4096
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) fail();
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
      || descriptor.value.length > 8192 || descriptor.value.includes("\0")) fail();
    output.push(descriptor.value);
  }
  return output;
}

function acceptanceAppDataIntent(value = process.argv) {
  const args = denseArguments(value);
  for (const argument of args) {
    if (argument.startsWith(ACCEPTANCE_APP_DATA_OPTION)) return true;
  }
  return false;
}

function directoryIdentity(fsApi, directory, currentUid) {
  let stat;
  let real;
  try {
    stat = fsApi.lstatSync(directory);
    real = fsApi.realpathSync(directory);
  } catch { fail(); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory
    || (stat.mode & 0o777) !== 0o700 || stat.uid !== currentUid) fail();
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode, uid: stat.uid });
}

function selectOpenBotAppData({
  argv = process.argv,
  appDataPath,
  fsApi = fs,
  tempDirectory = os.tmpdir(),
  currentUid = typeof process.getuid === "function" ? process.getuid() : -1,
} = {}) {
  try {
    const args = denseArguments(argv);
    if (!fsApi || typeof fsApi.lstatSync !== "function" || typeof fsApi.realpathSync !== "function"
      || typeof tempDirectory !== "string" || !path.isAbsolute(tempDirectory)
      || !Number.isSafeInteger(currentUid) || currentUid < 0) fail();
    const flags = args.filter((argument) => argument.startsWith(ACCEPTANCE_APP_DATA_OPTION));
    if (flags.length === 0) {
      if (typeof appDataPath !== "string" || !path.isAbsolute(appDataPath)
        || appDataPath.length > 4096 || appDataPath.includes("\0")) fail();
      return Object.freeze({ acceptance: false, appDataPath, identity: null });
    }
    if (flags.length !== 1 || !flags[0].startsWith(ACCEPTANCE_APP_DATA_FLAG)) fail();
    const selected = flags[0].slice(ACCEPTANCE_APP_DATA_FLAG.length);
    if (!selected || !path.isAbsolute(selected) || selected.length > 4096
      || selected.includes("\0") || path.normalize(selected) !== selected) fail();
    let tempRoot;
    try { tempRoot = fsApi.realpathSync(tempDirectory); } catch { fail(); }
    const relative = path.relative(tempRoot, selected);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) fail();
    const identity = directoryIdentity(fsApi, selected, currentUid);
    return Object.freeze({ acceptance: true, appDataPath: selected, identity });
  } catch (error) {
    if (error instanceof OpenBotUserDataError) throw error;
    fail();
  }
}

function verifySelectedOpenBotAppData(selection, { fsApi = fs, currentUid } = {}) {
  try {
    if (!selection || typeof selection !== "object" || selection.acceptance !== true
      || typeof selection.appDataPath !== "string" || !selection.identity) fail();
    const expectedUid = currentUid === undefined ? selection.identity.uid : currentUid;
    const current = directoryIdentity(fsApi, selection.appDataPath, expectedUid);
    if (current.dev !== selection.identity.dev || current.ino !== selection.identity.ino
      || current.mode !== selection.identity.mode || current.uid !== selection.identity.uid) fail();
    return true;
  } catch (error) {
    if (error instanceof OpenBotUserDataError) throw error;
    fail();
  }
}

function validOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail(); }
  const fields = ["appDataPath", "fsApi", "publisherPath", "spawnSync"];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !fields.includes(key) || !("value" in descriptors[key]))) fail();
  const options = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
  if (typeof options.appDataPath !== "string" || !path.isAbsolute(options.appDataPath)
    || options.appDataPath.length > 4096 || options.appDataPath.includes("\0")) fail();
  if (options.fsApi !== undefined && (!options.fsApi || typeof options.fsApi !== "object")) fail();
  if (options.publisherPath !== undefined && (typeof options.publisherPath !== "string"
    || !path.isAbsolute(options.publisherPath) || options.publisherPath.length > 4096
    || options.publisherPath.includes("\0"))) fail();
  if (options.spawnSync !== undefined && typeof options.spawnSync !== "function") fail();
  return options;
}

function lstatMaybe(fsApi, target) {
  try { return fsApi.lstatSync(target); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail();
  }
}

function statRecord(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function realDirectory(fsApi, directory) {
  const stat = lstatMaybe(fsApi, directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail();
  return stat;
}

function hashFileNoFollow(fsApi, file, expected) {
  const descriptor = fsApi.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = statRecord(fsApi.fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(expected, opened)) fail();
    for (;;) {
      const bytes = fsApi.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    const finished = statRecord(fsApi.fstatSync(descriptor, { bigint: true }));
    if (!sameIdentity(opened, finished)) fail();
  } finally {
    fsApi.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function snapshotTree(fsApi, root) {
  const entries = [];
  function visit(target, relative, depth) {
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) fail();
    const initialStat = fsApi.lstatSync(target, { bigint: true });
    if (initialStat.isSymbolicLink()) fail();
    const initial = statRecord(initialStat);
    if (initialStat.isDirectory()) {
      const names = fsApi.readdirSync(target).sort();
      if (names.some((name) => name === "." || name === ".." || name.includes("\0"))) fail();
      entries.push(Object.freeze({ path: relative, type: "directory", metadata: initial }));
      for (const name of names) visit(path.join(target, name), relative ? `${relative}/${name}` : name, depth + 1);
      const finalStat = fsApi.lstatSync(target, { bigint: true });
      if (!finalStat.isDirectory() || finalStat.isSymbolicLink()
        || !sameIdentity(initial, statRecord(finalStat))) fail();
      return;
    }
    if (!initialStat.isFile()) fail();
    const sha256 = hashFileNoFollow(fsApi, target, initial);
    const pathStat = fsApi.lstatSync(target, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink()
      || !sameIdentity(initial, statRecord(pathStat))) fail();
    entries.push(Object.freeze({ path: relative, type: "file", sha256, metadata: initial }));
  }
  visit(root, "", 0);
  return Object.freeze(entries);
}

function contentSnapshot(snapshot) {
  return snapshot.map((entry) => Object.freeze({
    path: entry.path,
    type: entry.type,
    ...(entry.sha256 === undefined ? {} : { sha256: entry.sha256 }),
  }));
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function syncPath(fsApi, target) {
  const descriptor = fsApi.openSync(target, "r");
  try { fsApi.fsyncSync(descriptor); } finally { fsApi.closeSync(descriptor); }
}

function hardenTree(fsApi, root) {
  const stat = fsApi.lstatSync(root);
  if (stat.isSymbolicLink()) fail();
  if (stat.isDirectory()) {
    for (const name of fsApi.readdirSync(root).sort()) hardenTree(fsApi, path.join(root, name));
    fsApi.chmodSync(root, 0o700);
    syncPath(fsApi, root);
    return;
  }
  if (!stat.isFile()) fail();
  fsApi.chmodSync(root, (stat.mode & 0o100) === 0 ? 0o600 : 0o700);
  syncPath(fsApi, root);
}

function publishExclusive(fsApi, options, staging, target) {
  if (typeof fsApi.renameExclusiveSync === "function") {
    fsApi.renameExclusiveSync(staging, target);
    return;
  }
  const publisher = options.publisherPath;
  if (!publisher) fail();
  const publisherStat = fsApi.lstatSync(publisher);
  if (!publisherStat.isFile() || publisherStat.isSymbolicLink() || (publisherStat.mode & 0o111) === 0) fail();
  const spawnSync = options.spawnSync || childProcess.spawnSync;
  const result = spawnSync(publisher, [staging, target], {
    encoding: "utf8",
    maxBuffer: 4096,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (result?.error || result?.status !== 0 || result?.signal != null) fail();
}

function receipt(userDataPath, migrated, legacyRetained) {
  return Object.freeze({ userDataPath, migrated, legacyRetained });
}

function prepareOpenBotUserData(rawOptions) {
  let options;
  let stagingRoot = null;
  try {
    options = validOptions(rawOptions);
    const fsApi = options.fsApi || fs;
    realDirectory(fsApi, options.appDataPath);
    const legacy = path.join(options.appDataPath, LEGACY_NAME);
    const target = path.join(options.appDataPath, PRODUCT_NAME);
    const targetStat = lstatMaybe(fsApi, target);
    const legacyStat = lstatMaybe(fsApi, legacy);

    if (targetStat) {
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) fail();
      fsApi.chmodSync(target, 0o700);
      if (legacyStat && (!legacyStat.isDirectory() || legacyStat.isSymbolicLink())) fail();
      return receipt(target, false, Boolean(legacyStat));
    }
    if (!legacyStat) {
      fsApi.mkdirSync(target, { mode: 0o700 });
      fsApi.chmodSync(target, 0o700);
      syncPath(fsApi, options.appDataPath);
      return receipt(target, false, false);
    }
    if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) fail();

    const before = snapshotTree(fsApi, legacy);
    stagingRoot = fsApi.mkdtempSync(path.join(options.appDataPath, ".OpenBot-migration-"));
    fsApi.chmodSync(stagingRoot, 0o700);
    const staging = path.join(stagingRoot, "profile");
    fsApi.cpSync(legacy, staging, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const copied = snapshotTree(fsApi, staging);
    const after = snapshotTree(fsApi, legacy);
    if (!snapshotsEqual(before, after)
      || !snapshotsEqual(contentSnapshot(before), contentSnapshot(copied))) fail();
    hardenTree(fsApi, staging);
    syncPath(fsApi, stagingRoot);
    publishExclusive(fsApi, options, staging, target);
    syncPath(fsApi, options.appDataPath);
    fsApi.rmdirSync(stagingRoot);
    stagingRoot = null;
    return receipt(target, true, true);
  } catch (error) {
    try {
      const fsApi = options?.fsApi || fs;
      if (stagingRoot && fsApi.existsSync(stagingRoot)) {
        fsApi.rmSync(stagingRoot, { recursive: true, force: true });
      }
    } catch {}
    if (error instanceof OpenBotUserDataError) throw error;
    throw new OpenBotUserDataError();
  }
}

module.exports = {
  ACCEPTANCE_APP_DATA_OPTION,
  ACCEPTANCE_APP_DATA_FLAG,
  LEGACY_NAME,
  OpenBotUserDataError,
  PRODUCT_NAME,
  acceptanceAppDataIntent,
  prepareOpenBotUserData,
  selectOpenBotAppData,
  verifySelectedOpenBotAppData,
};
