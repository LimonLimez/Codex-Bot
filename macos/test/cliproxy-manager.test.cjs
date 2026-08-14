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
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit("exit", 0, null); return true; };
  if (exitImmediately) process.nextTick(() => { child.exitCode = 0; child.emit("exit", 0, null); });
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
    return true;
  };
  let spawnCount = 0;
  const manager = new CLIProxyManager({
    binaryPath,
    stateRoot: path.join(root, "state"),
    randomBytes: () => Buffer.alloc(32, 0x12),
    randomInt: () => 54324,
    spawnImpl() { spawnCount += 1; return spawnCount === 1 ? serverChild : loginChild; },
    probeImpl: async () => true,
  });
  await manager.start();
  const first = manager.connectProvider("codex");
  const second = manager.connectProvider("codex");
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawnCount, 2);
  manager.stop();
  assert.equal(loginChild.killed, true);
  await assert.rejects(first, { code: "CLIPROXY_PROVIDER_FAILED" });
});
