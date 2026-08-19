"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const storePath = path.join(__dirname, "..", "src", "desktop", "keychain-secret-store.cjs");

function childFor(calls, args, { stdout = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdin = { end(value) { child.secret = value; } };
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => { child.killed = true; };
  calls.push(args);
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", code, null);
  });
  return child;
}

test("startup state never invokes Keychain and explicit actions use one stable service", async () => {
  const { KeychainSecretStore } = require(storePath);
  const calls = [];
  const secrets = new KeychainSecretStore({
    service: "com.limonlimez.openbot.providers",
    spawn: (executable, args) => childFor(calls, [executable, ...args]),
  });
  assert.deepEqual(calls, []);
  await secrets.set("openai-api-key", "sk-private");
  assert.deepEqual(calls[0].slice(0, 5), [
    "/usr/bin/security", "add-generic-password", "-U", "-s", "com.limonlimez.openbot.providers",
  ]);
  assert.equal(calls[0].at(-1), "-w");
  assert.doesNotMatch(JSON.stringify(calls), /sk-private/);
});

test("Keychain rejects hostile accessors, non-canonical accounts, and unsafe secret values", async () => {
  const { KeychainSecretStore } = require(storePath);
  const secrets = new KeychainSecretStore({
    service: "com.limonlimez.openbot.providers",
    spawn: () => { throw new Error("must not spawn"); },
  });
  await assert.rejects(secrets.set("local", "secret"), /invalid/i);
  await assert.rejects(secrets.set("openai-api-key", "line\nfeed"), /invalid/i);
  await assert.rejects(secrets.set("openai-api-key", "\0"), /invalid/i);
  await assert.rejects(secrets.set("openai-api-key", "x".repeat(16 * 1024 + 1)), /invalid/i);
  const hostile = {};
  Object.defineProperty(hostile, "toString", { get() { throw new Error("getter"); } });
  await assert.rejects(secrets.read(hostile), /invalid/i);
});

test("Keychain read returns only bounded secret output and delete uses explicit action", async () => {
  const { KeychainSecretStore } = require(storePath);
  const calls = [];
  const secrets = new KeychainSecretStore({
    service: "com.limonlimez.openbot.providers",
    spawn: (executable, args) => childFor(calls, [executable, ...args], {
      stdout: args[0] === "find-generic-password" ? "sk-read\n" : "",
    }),
  });
  assert.equal(await secrets.read("openai-api-key"), "sk-read");
  await secrets.delete("openai-api-key");
  assert.deepEqual(calls.map((entry) => entry.slice(1, 4)), [
    ["find-generic-password", "-s", "com.limonlimez.openbot.providers"],
    ["delete-generic-password", "-s", "com.limonlimez.openbot.providers"],
  ]);
});

test("Keychain waits for close and drained stdout after exit", async () => {
  const { KeychainSecretStore } = require(storePath);
  const child = new EventEmitter();
  child.stdin = { end() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const secrets = new KeychainSecretStore({
    service: "com.limonlimez.openbot.providers",
    spawn: () => {
      process.nextTick(() => {
        child.emit("exit", 0, null);
        setImmediate(() => child.stdout.emit("data", Buffer.from("late-secret\n")));
        setTimeout(() => child.emit("close", 0, null), 10);
      });
      return child;
    },
  });
  assert.equal(await secrets.read("openai-api-key"), "late-secret");
});
