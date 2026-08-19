"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const managerPath = path.join(__dirname, "..", "src", "desktop", "cliproxy-manager.cjs");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-cliproxy-manager-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeChild({ exitImmediately = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); return true; };
  if (exitImmediately) process.nextTick(() => { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); });
  return child;
}

test("CLIProxy manager writes a private loopback-only config and starts one pinned sidecar flight", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  const spawns = [];
  const child = fakeChild();
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0xab),
    randomInt: () => 54321,
    spawnImpl(executable, args, options) { spawns.push({ executable, args, options }); return child; },
    probeImpl: async () => true,
  });
  const [first, second] = await Promise.all([manager.start(), manager.start()]);
  assert.equal(first, second);
  assert.deepEqual(Object.keys(first), ["endpoint"]);
  assert.equal(first.endpoint, "http://127.0.0.1:54321/v1");
  assert.equal(first.credential, "ab".repeat(32));
  assert.equal(Object.getOwnPropertyDescriptor(first, "credential").enumerable, false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(-1), ["-local-model"]);
  assert.deepEqual(spawns[0].options.stdio, ["ignore", "ignore", "ignore"]);
  const configPath = spawns[0].args[1];
  const config = fs.readFileSync(configPath, "utf8");
  assert.match(config, /host: "127\.0\.0\.1"/);
  assert.match(config, /port: 54321/);
  assert.match(config, /disable-control-panel: true/);
  assert.match(config, /logging-to-file: false/);
  assert.match(config, /usage-statistics-enabled: false/);
  assert.match(config, new RegExp(`api-keys:\\n  - "${"ab".repeat(32)}"`));
  assert.equal(fs.statSync(configPath).mode & 0o077, 0);
  assert.equal(fs.statSync(path.dirname(configPath)).mode & 0o077, 0);
  manager.stop();
  assert.equal(child.killed, true);
});

test("CLIProxy provider connection accepts only fixed OAuth modes and never forwards caller arguments", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  const spawns = [];
  const serverChild = fakeChild();
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0xcd),
    randomInt: () => 54322,
    spawnImpl(executable, args, options) {
      spawns.push({ executable, args, options });
      if (args.includes("-claude-login")) {
        fs.mkdirSync(path.join(root, "state", "auth"), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(root, "state", "auth", "claude-fixture.json"), "{}", { mode: 0o600 });
      }
      return spawns.length === 1 ? serverChild : fakeChild({ exitImmediately: true });
    },
    probeImpl: async () => true,
  });
  await manager.start();
  await manager.connectProvider("claude");
  assert.deepEqual(spawns[1].args.slice(2), ["-claude-login"]);
  await assert.rejects(() => manager.connectProvider("../../bin/sh"), /provider/i);
  assert.equal(spawns.length, 2);
  manager.stop();
});

test("CLIProxy startup owns early child failures and rejects without resurrecting a stopped sidecar", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);

  let child = fakeChild();
  let releaseProbe;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0xef),
    randomInt: () => 54323,
    spawnImpl() { return child; },
    probeImpl: () => new Promise((resolve) => { releaseProbe = resolve; }),
  });
  const starting = manager.start();
  assert.equal(child.listenerCount("error") > 0, true);
  manager.stop();
  releaseProbe(true);
  await assert.rejects(starting, { code: "CLIPROXY_UNAVAILABLE" });

  child = fakeChild();
  const failing = manager.start();
  process.nextTick(() => child.emit("error", new Error("private host path")));
  await assert.rejects(failing, (error) => {
    assert.equal(error.code, "CLIPROXY_UNAVAILABLE");
    assert.doesNotMatch(String(error), /private host path|\/Users\//);
    return true;
  });
  manager.stop();
});

test("CLIProxy production integrity expectations reject a changed executable before spawn", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "changed");
  fs.chmodSync(binaryPath, 0o755);
  let spawned = false;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    expectedBinaryBytes: 8,
    expectedBinarySha256: "0".repeat(64),
    spawnImpl() { spawned = true; return fakeChild(); },
    probeImpl: async () => true,
  });
  await assert.rejects(manager.start(), { code: "CLIPROXY_INTEGRITY_FAILED" });
  assert.equal(spawned, false);
});

test("CLIProxy provider login is one-flight and every login child is stopped with the manager", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  const serverChild = fakeChild();
  const loginChild = fakeChild();
  loginChild.kill = () => {
    loginChild.killed = true;
    loginChild.emit("exit", null, "SIGTERM");
    loginChild.emit("close", null, "SIGTERM");
    return true;
  };
  let spawnCount = 0;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0x12),
    randomInt: () => 54324,
    spawnImpl(executable, args) {
      spawnCount += 1;
      if (args.includes("-xai-login")) {
        fs.mkdirSync(path.join(root, "state", "auth"), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(root, "state", "auth", "xai-fixture.json"), "{}", { mode: 0o600 });
      }
      return spawnCount === 1 ? serverChild : loginChild;
    },
    probeImpl: async () => true,
  });
  await manager.start();
  const first = manager.connectProvider("xai");
  const second = manager.connectProvider("xai");
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCount, 2);
  manager.stop();
  assert.equal(loginChild.killed, true);
  await assert.rejects(first, (error) => /CLIPROXY_PROVIDER_(FAILED|SUPERSEDED)/.test(error.code));
});

test("CLIProxy canonical provider flows wait for an exact credential file and reject service accounts", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  const serverChild = fakeChild();
  const spawns = [];
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0x31),
    randomInt: () => 54325,
    spawnImpl(executable, args, options) {
      spawns.push({ executable, args, options });
      if (args.includes("-xai-login")) {
        fs.writeFileSync(path.join(root, "state", "auth", "xai-fixture.json"), "{}", { mode: 0o600 });
      }
      return spawns.length === 1 ? serverChild : fakeChild({ exitImmediately: true });
    },
    probeImpl: async () => true,
  });
  await manager.start();
  await manager.connectProvider("xai");
  assert.deepEqual(spawns[1].args.slice(2), ["-xai-login"]);
  await assert.rejects(manager.connectProvider("google-vertex-ai"), { code: "CLIPROXY_PROVIDER_INVALID" });
  manager.stop();
});

test("Vertex import removes the exact private temporary and disconnect removes only real matching auth files", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  const sourcePath = path.join(root, "service-account.json");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  fs.writeFileSync(sourcePath, JSON.stringify({ type: "service_account", private_key: "private" }));
  const serverChild = fakeChild();
  const spawns = [];
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0x41),
    randomInt: () => 54326,
    spawnImpl(executable, args, options) {
      spawns.push({ executable, args, options });
      if (args.includes("-vertex-import")) {
        fs.writeFileSync(path.join(root, "state", "auth", "vertex-imported.json"), "{}", { mode: 0o600 });
      }
      return spawns.length === 1 ? serverChild : fakeChild({ exitImmediately: true });
    },
    probeImpl: async () => true,
  });
  await manager.start();
  await manager.importVertex(sourcePath);
  const temporary = spawns[1].args[spawns[1].args.indexOf("-vertex-import") + 1];
  assert.equal(fs.existsSync(temporary), false);
  assert.doesNotMatch(JSON.stringify(spawns), /private/);
  await manager.disconnectProvider("google-vertex-ai");
  assert.equal(fs.existsSync(path.join(root, "state", "auth", "vertex-imported.json")), false);
  manager.stop();
});

test("CLIProxy rejects symlinked auth directories and never disconnects outside the private root", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  const outside = path.join(root, "outside");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, "xai-outside.json"), "outside", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(stateRoot, "auth"), "dir");
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot,
    spawnImpl() { throw new Error("must not spawn"); },
    probeImpl: async () => true,
  });
  await assert.rejects(manager.start(), /unavailable|private|unsafe/i);
  await assert.rejects(manager.disconnectProvider("xai"), /failed|unsafe|provider/i);
  assert.equal(fs.existsSync(path.join(outside, "xai-outside.json")), true);
});

test("CLIProxy provider settlement waits for close after exit and drained auth readiness", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  const serverChild = fakeChild();
  const loginChild = new EventEmitter();
  loginChild.exitCode = null;
  loginChild.kill = () => {};
  let closeObserved = false;
  let count = 0;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0x55),
    randomInt: () => 54327,
    spawnImpl(executable, args) {
      count += 1;
      if (count === 1) return serverChild;
      process.nextTick(() => {
        loginChild.exitCode = 0;
        loginChild.emit("exit", 0, null);
        setTimeout(() => {
          fs.writeFileSync(path.join(root, "state", "auth", "xai-close.json"), "{}", { mode: 0o600 });
        }, 5);
        setTimeout(() => { closeObserved = true; loginChild.emit("close", 0, null); }, 100);
      });
      return loginChild;
    },
    probeImpl: async () => true,
  });
  await manager.start();
  await manager.connectProvider("xai");
  assert.equal(closeObserved, true);
  manager.stop();
});

test("CLIProxy stop fences and settles a provider flight before a later generation", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  const serverChildren = [fakeChild(), fakeChild()];
  const loginChild = new EventEmitter();
  loginChild.exitCode = null;
  loginChild.kill = () => { loginChild.killed = true; };
  let count = 0;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0x66),
    randomInt: () => 54328,
    spawnImpl(executable, args) {
      count += 1;
      if (args.includes("-local-model")) return serverChildren[Math.min(count - 1, 1)];
      return loginChild;
    },
    probeImpl: async () => true,
  });
  await manager.start();
  const pending = manager.connectProvider("xai");
  await new Promise((resolve) => setImmediate(resolve));
  manager.stop();
  const firstOutcome = await Promise.race([
    pending.then(() => "resolved", (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);
  assert.notEqual(firstOutcome, "timeout");
  assert.match(String(firstOutcome), /CLIPROXY/);
  assert.equal(loginChild.killed, true);
  const next = manager.connectProvider("xai");
  manager.stop();
  const nextOutcome = await Promise.race([
    next.then(() => "resolved", (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);
  assert.notEqual(nextOutcome, "timeout");
  assert.match(String(nextOutcome), /CLIPROXY/);
});

test("Vertex import copies from a held no-follow source despite a pathname replacement race", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  const sourcePath = path.join(root, "service-account.json");
  const heldPath = path.join(root, "service-account-held.json");
  const outsidePath = path.join(root, "outside-provider.json");
  const original = JSON.stringify({ type: "service_account", private_key: "original" });
  const outside = JSON.stringify({ type: "service_account", private_key: "outside" });
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  fs.writeFileSync(sourcePath, original, { mode: 0o600 });
  fs.writeFileSync(outsidePath, outside, { mode: 0o600 });
  const serverChild = fakeChild();
  let copied;
  let count = 0;
  const realCopy = fs.copyFileSync;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0x77),
    randomInt: () => 54329,
    spawnImpl(executable, args) {
      count += 1;
      if (args.includes("-vertex-import")) {
        const temporary = args[args.indexOf("-vertex-import") + 1];
        copied = fs.readFileSync(temporary, "utf8");
        fs.writeFileSync(path.join(root, "state", "auth", "vertex-race.json"), "{}", { mode: 0o600 });
        return fakeChild({ exitImmediately: true });
      }
      return serverChild;
    },
    probeImpl: async () => true,
  });
  fs.copyFileSync = (from, to, flags) => {
    if (from === sourcePath) {
      fs.renameSync(sourcePath, heldPath);
      fs.symlinkSync(outsidePath, sourcePath, "file");
    }
    return realCopy(from, to, flags);
  };
  try {
    await manager.importVertex(sourcePath);
  } finally {
    fs.copyFileSync = realCopy;
  }
  assert.equal(copied, original);
  manager.stop();
});

test("CLIProxy disconnect quarantines the expected inode and never removes a replacement at the same pathname", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  const stateRoot = path.join(root, "state");
  const target = path.join(stateRoot, "auth", "xai-race.json");
  const held = path.join(root, "xai-original.json");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, "original", { mode: 0o600 });
  let targetChecks = 0;
  const realLstat = fs.lstatSync;
  const realRename = fs.renameSync;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot,
    spawnImpl() { return fakeChild(); },
    probeImpl: async () => true,
  });
  await manager.start();
  const originalLstat = fs.lstatSync;
  fs.lstatSync = (value, ...args) => {
    const stat = originalLstat(value, ...args);
    if (value === target) {
      targetChecks += 1;
      if (targetChecks === 2) {
        realRename(target, held);
        fs.writeFileSync(target, "replacement", { mode: 0o600 });
      }
    }
    return stat;
  };
  try {
    await assert.rejects(manager.disconnectProvider("xai"), /unsafe|failed|provider/i);
  } finally {
    fs.lstatSync = realLstat;
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(target, "utf8"), "replacement");
});

test("CLIProxy config writes reject a run-directory swap instead of writing outside the held run identity", async (t) => {
  const { CLIProxyManager } = require(managerPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "cli-proxy-api");
  const stateRoot = path.join(root, "state");
  const run = path.join(stateRoot, "run");
  const held = path.join(root, "run-held");
  const outside = path.join(root, "outside");
  fs.writeFileSync(binaryPath, "fixture");
  fs.chmodSync(binaryPath, 0o755);
  fs.mkdirSync(outside, { mode: 0o700 });
  let swapped = false;
  const realRename = fs.renameSync;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot,
    randomBytes: () => Buffer.alloc(32, 0x88),
    randomInt: () => 54330,
    spawnImpl() { throw new Error("must not spawn after run swap"); },
    probeImpl: async () => true,
  });
  fs.renameSync = (from, to) => {
    if (!swapped && from.includes(".config.") && from.endsWith(".tmp")) {
      swapped = true;
      realRename(run, held);
      fs.symlinkSync(outside, run, "dir");
    }
    return realRename(from, to);
  };
  try {
    await assert.rejects(manager.start(), /private|unsafe|unavailable|ENOENT/i);
  } finally { fs.renameSync = realRename; }
  assert.equal(fs.existsSync(path.join(outside, "config.yaml")), false);
});
