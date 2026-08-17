"use strict";

const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LocalAutomationNativeIO,
  LocalAutomationNativeIOError,
} = require("../src/desktop/local-automation-native-io.cjs");

const SOURCE = '{"schemaVersion":1,"automations":[]}\n';
const OTHER_SOURCE = '{"schemaVersion":1,"automations":[{"id":"other"}]}\n';
const UUID = "00000000-0000-4000-8000-000000000901";
const MAX_STATE_BYTES = 16 * 1024 * 1024;

function fsWith(overrides) {
  return new Proxy(fs, {
    get(target, key) {
      return Object.hasOwn(overrides, key) ? overrides[key] : target[key];
    },
  });
}

function handleWith(handle, overrides) {
  return new Proxy(handle, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function fixture(t, { source, directoryMode = 0o700, ioOptions = {} } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openbot-native-io-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "private");
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, directoryMode);
  const filePath = path.join(directory, "local-automations.v1.json");
  if (source !== undefined) await fs.writeFile(filePath, source, { mode: 0o600 });
  return {
    directory,
    filePath,
    root,
    io: () => new LocalAutomationNativeIO({
      filePath,
      randomUUID: () => UUID,
      ...ioOptions,
    }),
  };
}

function stableDirectoryFor(directory) {
  const stat = fsSync.lstatSync(directory, { bigint: true });
  return `/.vol/${stat.dev}/${stat.ino}`;
}

test("native IO round-trips only through the verified VolFS parent with private durable flags", async (t) => {
  const opened = [];
  const renamed = [];
  let directorySyncs = 0;
  const { directory, filePath } = await fixture(t);
  const stableDirectory = stableDirectoryFor(directory);
  const tracedFs = fsWith({
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      opened.push({ target, flags, mode });
      if (target === directory) {
        return handleWith(handle, {
          async sync() {
            directorySyncs += 1;
            return handle.sync();
          },
        });
      }
      return handle;
    },
    async rename(from, to) {
      renamed.push([from, to]);
      return fs.rename(from, to);
    },
  });
  const io = new LocalAutomationNativeIO({
    filePath,
    fs: tracedFs,
    randomUUID: () => UUID,
  });

  assert.equal(await io.read(), null);
  await io.write(SOURCE);
  assert.equal(await io.read(), SOURCE);
  assert.equal((await fs.lstat(filePath)).mode & 0o7777, 0o600);
  assert.deepEqual(renamed, [[
    `${stableDirectory}/.local-automations.v1.json.${UUID}.tmp`,
    `${stableDirectory}/local-automations.v1.json`,
  ]]);
  const temporaryOpen = opened.find((entry) => entry.target.endsWith(`.${UUID}.tmp`));
  assert.equal((temporaryOpen.flags & fsSync.constants.O_WRONLY) !== 0, true);
  assert.equal((temporaryOpen.flags & fsSync.constants.O_CREAT) !== 0, true);
  assert.equal((temporaryOpen.flags & fsSync.constants.O_EXCL) !== 0, true);
  assert.equal((temporaryOpen.flags & fsSync.constants.O_NOFOLLOW) !== 0, true);
  assert.equal(temporaryOpen.mode, 0o600);
  assert.equal(opened.filter((entry) => entry.target.endsWith("local-automations.v1.json"))
    .every((entry) => entry.target.startsWith(`${stableDirectory}/`)), true);
  assert.equal(directorySyncs, 1);
});

test("native IO rejects canonical parent replacement during a stable-parent write", async (t) => {
  const { directory, filePath, root } = await fixture(t);
  const held = path.join(root, "held-private");
  let swapped = false;
  const racingFs = fsWith({
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      if (!swapped && target.endsWith(`.${UUID}.tmp`)) {
        swapped = true;
        await fs.rename(directory, held);
        await fs.mkdir(directory, { mode: 0o700 });
      }
      return handle;
    },
  });
  const io = new LocalAutomationNativeIO({
    filePath,
    fs: racingFs,
    randomUUID: () => UUID,
  });

  await assert.rejects(io.write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal((await fs.lstat(held)).isDirectory(), true);
});

test("native IO rejects an ancestor replaced by a symlink back to the held tree", async (t) => {
  const { directory, filePath, root } = await fixture(t);
  const heldRoot = `${root}-held`;
  t.after(() => fs.rm(heldRoot, { recursive: true, force: true }));
  const io = new LocalAutomationNativeIO({
    filePath,
    randomUUID: () => UUID,
  });
  await fs.rename(root, heldRoot);
  await fs.symlink(heldRoot, root, "dir");

  await assert.rejects(io.write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal((await fs.lstat(root)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readdir(path.join(heldRoot, path.basename(directory))), []);
});

test("native IO file substitution after open never exposes replacement content", async (t) => {
  const { directory, filePath, root } = await fixture(t, { source: SOURCE });
  const stableTarget = `${stableDirectoryFor(directory)}/local-automations.v1.json`;
  const held = path.join(directory, "state-held");
  const replacement = path.join(root, "replacement.json");
  await fs.writeFile(replacement, "replacement-private", { mode: 0o600 });
  let swapped = false;
  const racingFs = fsWith({
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      if (!swapped && target === stableTarget && (flags & 0o3) === fsSync.constants.O_RDONLY) {
        swapped = true;
        await fs.rename(filePath, held);
        await fs.symlink(replacement, filePath);
      }
      return handle;
    },
  });
  const io = new LocalAutomationNativeIO({ filePath, fs: racingFs });

  await assert.rejects(io.read(), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal(await fs.readFile(replacement, "utf8"), "replacement-private");
  assert.equal(await fs.readFile(held, "utf8"), SOURCE);
});

test("native IO refuses unsupported or mismatched VolFS identities at construction", async (t) => {
  const { directory, filePath, root } = await fixture(t);
  const other = path.join(root, "other-private");
  await fs.mkdir(other, { mode: 0o700 });
  const realLstatSync = fsSync.lstatSync;

  assert.throws(() => new LocalAutomationNativeIO({
    filePath,
    lstatSync(target, options) {
      if (target.startsWith("/.vol/")) {
        const error = new Error("unsupported");
        error.code = "ENOENT";
        throw error;
      }
      return realLstatSync(target, options);
    },
  }), LocalAutomationNativeIOError);

  assert.throws(() => new LocalAutomationNativeIO({
    filePath,
    lstatSync(target, options) {
      if (target.startsWith("/.vol/")) return realLstatSync(other, options);
      return realLstatSync(target, options);
    },
  }), LocalAutomationNativeIOError);
  assert.equal((await fs.lstat(directory)).mode & 0o7777, 0o700);
});

test("native IO refuses a symlinked parent instead of canonicalizing through it", async (t) => {
  const { directory, root } = await fixture(t);
  const linked = path.join(root, "linked-private");
  await fs.symlink(directory, linked, "dir");

  assert.throws(() => new LocalAutomationNativeIO({
    filePath: path.join(linked, "local-automations.v1.json"),
  }), LocalAutomationNativeIOError);
});

test("native IO exact-read-back accepts only a matching uncertain rename", async (t) => {
  const matching = await fixture(t);
  let matchingRename = 0;
  let committed = false;
  let readbacks = 0;
  const order = [];
  const matchingStableTarget = `${stableDirectoryFor(matching.directory)}/local-automations.v1.json`;
  const matchingFs = fsWith({
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      if (target === matching.directory) {
        return handleWith(handle, {
          async sync() {
            order.push("directory-sync");
            return handle.sync();
          },
        });
      }
      if (committed && target === matchingStableTarget
        && (flags & 0o3) === fsSync.constants.O_RDONLY) {
        readbacks += 1;
        order.push(`read-${readbacks}`);
      }
      return handle;
    },
    async rename(from, to) {
      matchingRename += 1;
      await fs.rename(from, to);
      committed = true;
      order.push("rename");
      throw new Error("rename acknowledgement lost");
    },
  });
  const matchingIO = new LocalAutomationNativeIO({
    filePath: matching.filePath,
    fs: matchingFs,
    randomUUID: () => UUID,
  });
  await matchingIO.write(SOURCE);
  assert.equal(matchingRename, 1);
  assert.equal(readbacks, 2);
  assert.deepEqual(order, ["rename", "read-1", "directory-sync", "read-2"]);
  assert.equal(await fs.readFile(matching.filePath, "utf8"), SOURCE);
  assert.deepEqual(await fs.readdir(matching.directory), ["local-automations.v1.json"]);

  const mismatching = await fixture(t);
  const mismatchingFs = fsWith({
    async rename(from, to) {
      await fs.rename(from, to);
      await fs.writeFile(to, OTHER_SOURCE);
      throw new Error("rename acknowledgement lost after corruption");
    },
  });
  const mismatchingIO = new LocalAutomationNativeIO({
    filePath: mismatching.filePath,
    fs: mismatchingFs,
    randomUUID: () => UUID,
  });
  await assert.rejects(mismatchingIO.write(SOURCE), {
    code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED",
  });
  assert.equal(await fs.readFile(mismatching.filePath, "utf8"), OTHER_SOURCE);
  assert.deepEqual(await fs.readdir(mismatching.directory), ["local-automations.v1.json"]);

  const synchronous = await fixture(t);
  const synchronousIO = new LocalAutomationNativeIO({
    filePath: synchronous.filePath,
    fs: fsWith({
      rename(from, to) {
        fsSync.renameSync(from, to);
        throw new Error("synchronous acknowledgement loss after commit");
      },
    }),
    randomUUID: () => UUID,
  });
  await synchronousIO.write(SOURCE);
  assert.equal(await fs.readFile(synchronous.filePath, "utf8"), SOURCE);
  assert.deepEqual(await fs.readdir(synchronous.directory), ["local-automations.v1.json"]);
});

test("native IO cleans a synchronous precommit rename failure without read-back", async (t) => {
  const { directory, filePath } = await fixture(t, { source: SOURCE });
  let renameCalls = 0;
  let renameFailed = false;
  let readsAfterFailure = 0;
  const stableTarget = `${stableDirectoryFor(directory)}/local-automations.v1.json`;
  const failingFs = fsWith({
    async open(target, flags, mode) {
      if (renameFailed && target === stableTarget && (flags & 0o3) === fsSync.constants.O_RDONLY) {
        readsAfterFailure += 1;
      }
      return fs.open(target, flags, mode);
    },
    rename() {
      renameCalls += 1;
      renameFailed = true;
      throw new Error("rename refused before commit");
    },
  });
  const io = new LocalAutomationNativeIO({
    filePath,
    fs: failingFs,
    randomUUID: () => UUID,
  });

  await assert.rejects(io.write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal(renameCalls, 1);
  assert.equal(readsAfterFailure, 0);
  assert.equal(await fs.readFile(filePath, "utf8"), SOURCE);
  assert.deepEqual(await fs.readdir(directory), ["local-automations.v1.json"]);
});

test("native IO cleans a retained owned temp after asynchronous rename rejection", async (t) => {
  const { directory, filePath } = await fixture(t, { source: SOURCE });
  const io = new LocalAutomationNativeIO({
    filePath,
    fs: fsWith({
      async rename() { throw new Error("rename rejected without mutation"); },
    }),
    randomUUID: () => UUID,
  });

  await assert.rejects(io.write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal(await fs.readFile(filePath, "utf8"), SOURCE);
  assert.deepEqual(await fs.readdir(directory), ["local-automations.v1.json"]);

  const foreign = await fixture(t, { source: SOURCE });
  const foreignStable = stableDirectoryFor(foreign.directory);
  const temporary = `${foreignStable}/.local-automations.v1.json.${UUID}.tmp`;
  const held = `${foreignStable}/held-owned-temp`;
  const foreignIO = new LocalAutomationNativeIO({
    filePath: foreign.filePath,
    fs: fsWith({
      async rename(from) {
        await fs.rename(from, held);
        await fs.writeFile(temporary, "foreign-temp", { mode: 0o600 });
        throw new Error("rename rejected after foreign substitution");
      },
    }),
    randomUUID: () => UUID,
  });
  await assert.rejects(foreignIO.write(SOURCE), {
    code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED",
  });
  assert.equal(await fs.readFile(path.join(foreign.directory,
    `.local-automations.v1.json.${UUID}.tmp`), "utf8"), "foreign-temp");
  assert.equal((await fs.lstat(path.join(foreign.directory, "held-owned-temp"))).isFile(), true);
});

test("native IO verifies exact committed bytes after a successful rename", async (t) => {
  const { filePath } = await fixture(t);
  const io = new LocalAutomationNativeIO({
    filePath,
    fs: fsWith({
      async rename(from, to) {
        await fs.rename(from, to);
        await fs.writeFile(to, OTHER_SOURCE);
      },
    }),
    randomUUID: () => UUID,
  });

  await assert.rejects(io.write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal(await fs.readFile(filePath, "utf8"), OTHER_SOURCE);
});

test("native IO cleans a still-owned temp before rename but never unlinks an unknown replacement", async (t) => {
  const owned = await fixture(t);
  const ownedStableTemp = `${stableDirectoryFor(owned.directory)}/.local-automations.v1.json.${UUID}.tmp`;
  const ownedFs = fsWith({
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      if (target !== ownedStableTemp) return handle;
      const refuse = async () => { throw new Error("write refused"); };
      return handleWith(handle, { write: refuse, writeFile: refuse });
    },
  });
  await assert.rejects(new LocalAutomationNativeIO({
    filePath: owned.filePath,
    fs: ownedFs,
    randomUUID: () => UUID,
  }).write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.deepEqual(await fs.readdir(owned.directory), []);

  const closed = await fixture(t);
  const closedStable = stableDirectoryFor(closed.directory);
  const closedTarget = `${closedStable}/local-automations.v1.json`;
  let targetChecks = 0;
  const closedFs = fsWith({
    async lstat(target, options) {
      if (target === closedTarget) {
        targetChecks += 1;
        if (targetChecks === 2) await fs.writeFile(target, OTHER_SOURCE, { mode: 0o600 });
      }
      return fs.lstat(target, options);
    },
  });
  await assert.rejects(new LocalAutomationNativeIO({
    filePath: closed.filePath,
    fs: closedFs,
    randomUUID: () => UUID,
  }).write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal(await fs.readFile(closed.filePath, "utf8"), OTHER_SOURCE);
  assert.deepEqual(await fs.readdir(closed.directory), ["local-automations.v1.json"]);

  const replaced = await fixture(t);
  const replacedStable = stableDirectoryFor(replaced.directory);
  const replacedStableTemp = `${replacedStable}/.local-automations.v1.json.${UUID}.tmp`;
  const heldTemp = `${replacedStable}/held-original-temp`;
  let substituted = false;
  const replacedFs = fsWith({
    async open(target, flags, mode) {
      const handle = await fs.open(target, flags, mode);
      if (target !== replacedStableTemp) return handle;
      const substitute = async () => {
        if (!substituted) {
          substituted = true;
          await fs.rename(replacedStableTemp, heldTemp);
          await fs.writeFile(replacedStableTemp, "unknown-temp", { mode: 0o600 });
        }
        throw new Error("write failed after temp substitution");
      };
      return handleWith(handle, { write: substitute, writeFile: substitute });
    },
  });
  await assert.rejects(new LocalAutomationNativeIO({
    filePath: replaced.filePath,
    fs: replacedFs,
    randomUUID: () => UUID,
  }).write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal(await fs.readFile(path.join(replaced.directory,
    `.local-automations.v1.json.${UUID}.tmp`), "utf8"), "unknown-temp");
  assert.equal((await fs.lstat(path.join(replaced.directory, "held-original-temp"))).isFile(), true);
});

test("native IO refuses non-private parent and target modes without repair", async (t) => {
  for (const mode of [0o755, 0o1700]) {
    await t.test(`parent ${mode.toString(8)}`, async (t) => {
      const { directory, filePath } = await fixture(t, { directoryMode: mode });
      assert.throws(() => new LocalAutomationNativeIO({ filePath }), LocalAutomationNativeIOError);
      assert.equal((await fs.lstat(directory)).mode & 0o7777, mode);
    });
  }
  for (const mode of [0o644, 0o4600]) {
    await t.test(`target ${mode.toString(8)}`, async (t) => {
      const { filePath, io } = await fixture(t, { source: SOURCE });
      await fs.chmod(filePath, mode);
      await assert.rejects(io().read(), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
      await assert.rejects(io().write(OTHER_SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
      assert.equal((await fs.lstat(filePath)).mode & 0o7777, mode);
      assert.equal(await fs.readFile(filePath, "utf8"), SOURCE);
    });
  }
});

test("native IO rejects symlink targets without reading or overwriting referents", async (t) => {
  const { filePath, root, io } = await fixture(t);
  const replacement = path.join(root, "replacement.json");
  await fs.writeFile(replacement, "replacement-private", { mode: 0o600 });
  await fs.symlink(replacement, filePath);

  await assert.rejects(io().read(), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  await assert.rejects(io().write(SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal(await fs.readFile(replacement, "utf8"), "replacement-private");
  assert.equal((await fs.lstat(filePath)).isSymbolicLink(), true);
});

test("native IO refuses multiply-linked state files", async (t) => {
  const { directory, filePath, io } = await fixture(t, { source: SOURCE });
  const linked = path.join(directory, "linked-state.json");
  await fs.link(filePath, linked);

  await assert.rejects(io().read(), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  await assert.rejects(io().write(OTHER_SOURCE), { code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED" });
  assert.equal((await fs.lstat(filePath)).nlink, 2);
  assert.equal(await fs.readFile(linked, "utf8"), SOURCE);
});

test("native IO bounds sources and persisted bytes before mutation", async (t) => {
  const writeFixture = await fixture(t);
  await assert.rejects(writeFixture.io().write("x".repeat(MAX_STATE_BYTES + 1)), {
    code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED",
  });
  assert.deepEqual(await fs.readdir(writeFixture.directory), []);

  const readFixture = await fixture(t, { source: "x" });
  await fs.truncate(readFixture.filePath, MAX_STATE_BYTES + 1);
  await assert.rejects(readFixture.io().read(), {
    code: "OPENBOT_LOCAL_AUTOMATION_IO_FAILED",
  });
});

test("native IO API has no helper child-process or timeout seam", async (t) => {
  const { filePath } = await fixture(t);
  for (const extra of [
    { helperPath: "/bin/echo" },
    { spawn() { throw new Error("must not run"); } },
    { timeoutMs: 25 },
  ]) {
    assert.throws(() => new LocalAutomationNativeIO({ filePath, ...extra }),
      LocalAutomationNativeIOError);
  }
});
