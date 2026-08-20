"use strict";

const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  OpenBotMachineIdStore,
  OpenBotMachineIdStoreError,
} = require("../src/desktop/openbot-machine-id.cjs");

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

async function fixture(t, { mode = 0o700 } = {}) {
  const userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openbot-machine-id-")));
  await fs.chmod(userData, mode);
  const directory = path.join(userData, "codex-bot");
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const filePath = path.join(directory, "openbot-machine-id.v1.json");
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  return { userData, directory, filePath };
}

function storeFor(filePath, randomUUID = () => UUID_A) {
  return new OpenBotMachineIdStore({
    filePath,
    randomUUID,
    currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
  });
}

test("machine id read creates the exact private compact record once", async (t) => {
  const { directory, filePath } = await fixture(t);
  const store = storeFor(filePath);

  assert.equal(await store.read(), UUID_A);
  assert.equal(await store.read(), UUID_A);
  assert.equal(await fs.readFile(filePath, "utf8"),
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n');
  const stat = await fs.lstat(filePath, { bigint: true });
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o7777n, 0o600n);
  assert.equal(stat.nlink, 1n);
  assert.deepEqual(await fs.readdir(directory), ["openbot-machine-id.v1.json"]);
});

test("concurrent machine id reads coalesce to one durable winner", async (t) => {
  const { filePath } = await fixture(t);
  let generated = 0;
  const store = storeFor(filePath, () => {
    generated += 1;
    return UUID_A;
  });

  const values = await Promise.all(Array.from({ length: 32 }, () => store.read()));
  assert.deepEqual(new Set(values), new Set([UUID_A]));
  assert.equal(generated, 1);
});

test("machine id flights never cross store authority boundaries", async (t) => {
  const { filePath } = await fixture(t);
  const first = storeFor(filePath, () => UUID_A);
  const wrongUid = new OpenBotMachineIdStore({
    filePath,
    currentUid: process.getuid() + 1,
    randomUUID: () => UUID_B,
  });

  const firstRead = first.read();
  const wrongRead = wrongUid.read();
  assert.notEqual(firstRead, wrongRead);
  const [firstResult, wrongResult] = await Promise.allSettled([firstRead, wrongRead]);
  assert.deepEqual(firstResult, { status: "fulfilled", value: UUID_A });
  assert.equal(wrongResult.status, "rejected");
  assert.equal(wrongResult.reason instanceof OpenBotMachineIdStoreError, true);
});

test("two stores reopen the hard-link publication winner instead of replacing it", async (t) => {
  const { filePath } = await fixture(t);
  const first = storeFor(filePath, () => UUID_A);
  const second = storeFor(filePath, () => UUID_B);

  const values = await Promise.all([first.read(), second.read()]);
  assert.equal(values[0], values[1]);
  assert.equal([UUID_A, UUID_B].includes(values[0]), true);
  assert.equal(await first.read(), values[0]);
  assert.equal(await second.read(), values[0]);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 1n);
});

test("machine id refuses an unsafe existing record without overwriting it", async (t) => {
  const { filePath } = await fixture(t);
  const unsafe = "not-a-machine-id\n";
  await fs.writeFile(filePath, unsafe, { mode: 0o600 });
  await fs.chmod(filePath, 0o644);

  const store = storeFor(filePath, () => UUID_B);
  await assert.rejects(store.read(), (error) => {
    assert.equal(error instanceof OpenBotMachineIdStoreError, true);
    assert.equal(error.code, "OPENBOT_MACHINE_ID_FAILED");
    return true;
  });
  assert.equal(await fs.readFile(filePath, "utf8"), unsafe);
  assert.equal((await fs.lstat(filePath)).mode & 0o7777, 0o644);
});

test("machine id refuses a symlink target and leaves the target untouched", async (t) => {
  const { userData, filePath } = await fixture(t);
  const outside = path.join(userData, "outside.json");
  await fs.writeFile(outside, "outside\n", { mode: 0o600 });
  await fs.symlink(outside, filePath);

  const store = storeFor(filePath);
  await assert.rejects(store.read(), OpenBotMachineIdStoreError);
  assert.equal((await fs.lstat(filePath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
});

test("machine id refuses a non-private canonical parent", async (t) => {
  const { directory, filePath } = await fixture(t);
  await fs.chmod(directory, 0o755);

  await assert.rejects(storeFor(filePath).read(), OpenBotMachineIdStoreError);
  assert.equal(fsSync.lstatSync(directory).mode & 0o7777, 0o755);
});

test("machine id refuses an existing hard-linked target", async (t) => {
  const { directory, filePath, userData } = await fixture(t);
  const source = path.join(userData, "machine-id-copy.json");
  const sourceBytes = '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n';
  await fs.writeFile(source, sourceBytes, { mode: 0o600 });
  await fs.link(source, filePath);

  await assert.rejects(storeFor(filePath).read(), OpenBotMachineIdStoreError);
  assert.equal(await fs.readFile(source, "utf8"), sourceBytes);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 2n);
});

test("machine id rejects oversized records before parsing", async (t) => {
  const { filePath } = await fixture(t);
  await fs.writeFile(filePath, `${"x".repeat(257)}\n`, { mode: 0o600 });

  await assert.rejects(storeFor(filePath).read(), OpenBotMachineIdStoreError);
});

test("machine id accepts only the exact schema, field set, version, and lowercase v4", async (t) => {
  const records = [
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111","extra":true}\n',
    '{"schemaVersion":1}\n',
    '{"schemaVersion":2,"machineId":"11111111-1111-4111-8111-111111111111"}\n',
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-11111111111"}\n',
    '{"schemaVersion":1,"machineId":"ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF"}\n',
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n\n',
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}',
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\r\n',
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}',
  ];
  for (const [index, record] of records.entries()) {
    const { filePath } = await fixture(t);
    await fs.writeFile(filePath, record, { mode: 0o600 });
    await assert.rejects(storeFor(filePath).read(), OpenBotMachineIdStoreError, `record ${index}`);
  }

  const { filePath } = await fixture(t);
  await fs.writeFile(filePath,
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n',
    { mode: 0o600 });
  assert.equal(await storeFor(filePath, () => UUID_B).read(), UUID_A);
});

test("machine id rejects a symlinked canonical ancestor and parent", async (t) => {
  const first = await fixture(t);
  const heldUserData = `${first.userData}-held`;
  await fs.rename(first.userData, heldUserData);
  await fs.symlink(heldUserData, first.userData, "dir");
  t.after(async () => {
    await fs.rm(first.userData, { recursive: true, force: true });
    await fs.rename(heldUserData, first.userData).catch(() => {});
  });
  await assert.rejects(storeFor(first.filePath).read(), OpenBotMachineIdStoreError);

  const second = await fixture(t);
  const heldParent = `${second.directory}-held`;
  await fs.rename(second.directory, heldParent);
  await fs.symlink(heldParent, second.directory, "dir");
  t.after(async () => {
    await fs.rm(second.directory, { recursive: true, force: true });
    await fs.rename(heldParent, second.directory).catch(() => {});
  });
  await assert.rejects(storeFor(second.filePath).read(), OpenBotMachineIdStoreError);
});

test("machine id cannot redirect missing-parent creation through a swapped user-data path", async (t) => {
  const userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openbot-machine-parent-")));
  await fs.chmod(userData, 0o700);
  const held = `${userData}-held`;
  const replacement = `${userData}-replacement`;
  await fs.mkdir(replacement, { mode: 0o700 });
  await fs.chmod(replacement, 0o700);
  const filePath = path.join(userData, "codex-bot", "openbot-machine-id.v1.json");
  let parentStats = 0;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "lstat") return target[key];
      return async (candidate, options) => {
        const stat = await target.lstat(candidate, options);
        if (candidate === userData && ++parentStats === 2) {
          await target.rename(userData, held);
          await target.rename(replacement, userData);
        }
        return stat;
      };
    },
  });
  t.after(async () => {
    await fs.rm(userData, { recursive: true, force: true });
    await fs.rename(held, userData).catch(() => {});
    await fs.rm(replacement, { recursive: true, force: true });
    await fs.rm(userData, { recursive: true, force: true });
  });

  await assert.rejects(new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_A,
  }).read(), OpenBotMachineIdStoreError);
  assert.equal(fsSync.existsSync(path.join(userData, "codex-bot")), false);
});

test("machine id rejects an existing state directory swapped after initial inspection", async (t) => {
  const { directory, filePath, userData } = await fixture(t);
  const held = `${directory}-held`;
  const replacement = `${directory}-replacement`;
  await fs.writeFile(filePath,
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n',
    { mode: 0o600 });
  await fs.mkdir(replacement, { mode: 0o700 });
  await fs.writeFile(path.join(replacement, "openbot-machine-id.v1.json"),
    '{"schemaVersion":1,"machineId":"22222222-2222-4222-8222-222222222222"}\n',
    { mode: 0o600 });
  let swapped = false;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "lstat") return target[key];
      return async (candidate, options) => {
        const stat = await target.lstat(candidate, options);
        if (!swapped && candidate === directory) {
          swapped = true;
          await target.rename(directory, held);
          await target.rename(replacement, directory);
        }
        return stat;
      };
    },
  });
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(held, directory).catch(() => {});
    await fs.rm(replacement, { recursive: true, force: true });
    await fs.rm(userData, { recursive: true, force: true });
  });

  await assert.rejects(new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_A,
  }).read(), OpenBotMachineIdStoreError);
  assert.equal(await fs.readFile(path.join(held, "openbot-machine-id.v1.json"), "utf8"),
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n');
});

test("machine id fails closed when its canonical parent is replaced during a read", async (t) => {
  const { directory, filePath, userData } = await fixture(t);
  await fs.writeFile(filePath,
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n',
    { mode: 0o600 });
  const held = `${directory}-held`;
  const replacement = `${directory}-replacement`;
  await fs.mkdir(replacement, { mode: 0o700 });
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "open") return target[key];
      return async (candidate, ...args) => {
        const handle = await target.open(candidate, ...args);
        if (candidate === directory) {
          await target.rename(directory, held);
          await target.rename(replacement, directory);
        }
        return handle;
      };
    },
  });
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(held, directory).catch(() => {});
    await fs.rm(replacement, { recursive: true, force: true });
    await fs.rm(userData, { recursive: true, force: true });
  });
  await assert.rejects(new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_B,
  }).read(), OpenBotMachineIdStoreError);
  assert.equal(await fs.readFile(path.join(held, "openbot-machine-id.v1.json"), "utf8"),
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n');
});

test("machine id rejects an inode or metadata replacement during read", async (t) => {
  const { filePath, userData } = await fixture(t);
  const original = '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n';
  await fs.writeFile(filePath, original, { mode: 0o600 });
  const stable = (() => {
    const stat = fsSync.lstatSync(path.dirname(filePath), { bigint: true });
    return `/.vol/${stat.dev}/${stat.ino}/${path.basename(filePath)}`;
  })();
  const held = path.join(userData, "machine-id-held.json");
  const outside = path.join(userData, "replacement.json");
  await fs.writeFile(outside, "replacement\n", { mode: 0o600 });
  let swapped = false;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "lstat") return target[key];
      return async (candidate, options) => {
        const result = await target.lstat(candidate, options);
        if (!swapped && candidate === stable) {
          swapped = true;
          await target.rename(stable, held);
          await target.symlink(outside, stable);
        }
        return result;
      };
    },
  });
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  await assert.rejects(new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
  }).read(), OpenBotMachineIdStoreError);
  assert.equal(await fs.readFile(held, "utf8"), original);
  assert.equal(await fs.readFile(outside, "utf8"), "replacement\n");
});

test("machine id rejects a target reported with the wrong owner or device", async (t) => {
  for (const field of ["uid", "dev"]) {
    const { filePath } = await fixture(t);
    await fs.writeFile(filePath,
      '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n',
      { mode: 0o600 });
    const directoryStat = fsSync.lstatSync(path.dirname(filePath), { bigint: true });
    const stable = `/.vol/${directoryStat.dev}/${directoryStat.ino}/${path.basename(filePath)}`;
    const fsApi = new Proxy(fs, {
      get(target, key) {
        if (key !== "lstat") return target[key];
        return async (candidate, options) => {
          const stat = await target.lstat(candidate, options);
          if (candidate !== stable) return stat;
          return new Proxy(stat, {
            get(inner, property) {
              if (property === field) return BigInt(inner[property]) + 1n;
              const value = inner[property];
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      },
    });
    await assert.rejects(new OpenBotMachineIdStore({
      filePath,
      fsApi,
      currentUid: process.getuid(),
    }).read(), OpenBotMachineIdStoreError, field);
  }
});

test("machine id reopens a valid EEXIST publication winner and cleans only its temp", async (t) => {
  const { filePath, userData } = await fixture(t);
  const winner = '{"schemaVersion":1,"machineId":"22222222-2222-4222-8222-222222222222"}\n';
  const winnerSource = path.join(userData, "winner-source.json");
  await fs.writeFile(winnerSource, winner, { mode: 0o600 });
  let raced = false;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "link") return target[key];
      return async (from, to) => {
        if (!raced) {
          raced = true;
          await target.link(winnerSource, to);
          await target.unlink(winnerSource);
          const error = new Error("winner already published");
          error.code = "EEXIST";
          throw error;
        }
        return target.link(from, to);
      };
    },
  });
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const value = await new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_A,
  }).read();
  assert.equal(value, UUID_B);
  assert.deepEqual(await fs.readdir(path.dirname(filePath)), ["openbot-machine-id.v1.json"]);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 1n);
});

test("machine id preserves an attacker replacement at its temp path", async (t) => {
  const { filePath, userData } = await fixture(t);
  const directoryStat = fsSync.lstatSync(path.dirname(filePath), { bigint: true });
  const stableDirectory = `/.vol/${directoryStat.dev}/${directoryStat.ino}`;
  const temporary = path.join(stableDirectory, `.openbot-machine-id.v1.json.${UUID_A}.tmp`);
  const held = path.join(userData, "owned-temp-held.json");
  const attacker = "attacker-temp\n";
  let replaced = false;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "open") return target[key];
      return async (candidate, ...args) => {
        const handle = await target.open(candidate, ...args);
        if (candidate !== temporary) return handle;
        const originalSync = handle.sync.bind(handle);
        return new Proxy(handle, {
          get(inner, property) {
            if (property !== "sync") return typeof inner[property] === "function"
              ? inner[property].bind(inner) : inner[property];
            return async () => {
              await originalSync();
              if (!replaced) {
                replaced = true;
                await target.rename(temporary, held);
                await target.writeFile(temporary, attacker, { mode: 0o600 });
              }
            };
          },
        });
      };
    },
  });
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  await assert.rejects(new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_A,
  }).read(), OpenBotMachineIdStoreError);
  assert.equal(await fs.readFile(held, "utf8"),
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n');
  assert.equal(await fs.readFile(temporary, "utf8"), attacker);
  assert.equal(fsSync.existsSync(filePath), false);
});

test("machine id recovers a link when the first directory sync is uncertain", async (t) => {
  const { directory, filePath } = await fixture(t);
  let failOnce = true;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "open") return target[key];
      return async (candidate, ...args) => {
        const handle = await target.open(candidate, ...args);
        if (candidate !== directory) return handle;
        return new Proxy(handle, {
          get(inner, property) {
            if (property !== "sync") return typeof inner[property] === "function"
              ? inner[property].bind(inner) : inner[property];
            return async () => {
              if (failOnce) {
                failOnce = false;
                throw new Error("directory sync acknowledgement lost");
              }
              return inner.sync();
            };
          },
        });
      };
    },
  });
  const value = await new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_A,
  }).read();
  assert.equal(value, UUID_A);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 1n);
  assert.deepEqual(await fs.readdir(directory), ["openbot-machine-id.v1.json"]);
  t.after(() => fs.rm(path.dirname(directory), { recursive: true, force: true }));
});

test("machine id reconciles a link that committed before its promise rejected", async (t) => {
  const { directory, filePath } = await fixture(t);
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "link") return target[key];
      return async (from, to) => {
        await target.link(from, to);
        throw new Error("link acknowledgement lost");
      };
    },
  });

  assert.equal(await new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_A,
  }).read(), UUID_A);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 1n);
  assert.deepEqual(await fs.readdir(directory), ["openbot-machine-id.v1.json"]);
});

test("machine id recovers an exact crash-left hard-link transaction", async (t) => {
  const { directory, filePath } = await fixture(t);
  const temporary = path.join(directory, `.openbot-machine-id.v1.json.${UUID_A}.tmp`);
  const source = '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n';
  await fs.writeFile(temporary, source, { mode: 0o600 });
  await fs.link(temporary, filePath);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 2n);

  assert.equal(await storeFor(filePath, () => UUID_B).read(), UUID_A);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 1n);
  assert.deepEqual(await fs.readdir(directory), ["openbot-machine-id.v1.json"]);
});

test("machine id accepts the same target inode finalized between snapshot and recovery", async (t) => {
  const { directory, filePath } = await fixture(t);
  const temporary = path.join(directory, `.openbot-machine-id.v1.json.${UUID_A}.tmp`);
  const source = '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n';
  await fs.writeFile(temporary, source, { mode: 0o600 });
  await fs.link(temporary, filePath);
  const directoryStat = await fs.lstat(directory, { bigint: true });
  const stableTarget = `/.vol/${directoryStat.dev}/${directoryStat.ino}/openbot-machine-id.v1.json`;
  const stableTemporary = `/.vol/${directoryStat.dev}/${directoryStat.ino}/${path.basename(temporary)}`;
  let finalized = false;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "lstat") return target[key];
      return async (candidate, options) => {
        const stat = await target.lstat(candidate, options);
        if (!finalized && candidate === stableTarget) {
          finalized = true;
          await target.unlink(stableTemporary);
        }
        return stat;
      };
    },
  });

  assert.equal(await new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_B,
  }).read(), UUID_A);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 1n);
  assert.deepEqual(await fs.readdir(directory), ["openbot-machine-id.v1.json"]);
});

test("machine id accepts same-inode finalization after recovery resnapshots nlink two", async (t) => {
  const { directory, filePath } = await fixture(t);
  const temporary = path.join(directory, `.openbot-machine-id.v1.json.${UUID_A}.tmp`);
  const source = '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n';
  await fs.writeFile(temporary, source, { mode: 0o600 });
  await fs.link(temporary, filePath);
  const directoryStat = await fs.lstat(directory, { bigint: true });
  const stableTarget = `/.vol/${directoryStat.dev}/${directoryStat.ino}/openbot-machine-id.v1.json`;
  const stableTemporary = `/.vol/${directoryStat.dev}/${directoryStat.ino}/${path.basename(temporary)}`;
  let targetStats = 0;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "lstat") return target[key];
      return async (candidate, options) => {
        const stat = await target.lstat(candidate, options);
        if (candidate === stableTarget && ++targetStats === 2) {
          await target.unlink(stableTemporary);
        }
        return stat;
      };
    },
  });

  assert.equal(await new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_B,
  }).read(), UUID_A);
  assert.equal((await fs.lstat(filePath, { bigint: true })).nlink, 1n);
  assert.deepEqual(await fs.readdir(directory), ["openbot-machine-id.v1.json"]);
});

test("machine id never returns a stale UUID after recovery target replacement", async (t) => {
  const { directory, filePath, userData } = await fixture(t);
  const temporary = path.join(directory, `.openbot-machine-id.v1.json.${UUID_A}.tmp`);
  const held = path.join(userData, "recovered-a.json");
  const replacement = path.join(userData, "replacement-b.json");
  await fs.writeFile(temporary,
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n',
    { mode: 0o600 });
  await fs.link(temporary, filePath);
  await fs.writeFile(replacement,
    '{"schemaVersion":1,"machineId":"22222222-2222-4222-8222-222222222222"}\n',
    { mode: 0o600 });
  const directoryStat = await fs.lstat(directory, { bigint: true });
  const stableTarget = `/.vol/${directoryStat.dev}/${directoryStat.ino}/openbot-machine-id.v1.json`;
  let targetStats = 0;
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key !== "lstat") return target[key];
      return async (candidate, options) => {
        if (candidate === stableTarget && ++targetStats === 7) {
          await target.rename(stableTarget, held);
          await target.rename(replacement, stableTarget);
        }
        return target.lstat(candidate, options);
      };
    },
  });

  await assert.rejects(new OpenBotMachineIdStore({
    filePath,
    fsApi,
    currentUid: process.getuid(),
    randomUUID: () => UUID_A,
  }).read(), OpenBotMachineIdStoreError);
  assert.equal(await fs.readFile(filePath, "utf8"),
    '{"schemaVersion":1,"machineId":"22222222-2222-4222-8222-222222222222"}\n');
  assert.equal(await fs.readFile(held, "utf8"),
    '{"schemaVersion":1,"machineId":"11111111-1111-4111-8111-111111111111"}\n');
});
