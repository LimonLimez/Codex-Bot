"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("node:test");

const boundaryPath = path.join(__dirname, "..", "src", "local", "local-computer-boundary.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CURSOR_A = "cursor-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GRANT_A = "grant-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUIDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];

function computer(overrides = {}) {
  return {
    mode: "not-now",
    generation: 0,
    localProfileId: null,
    nativeAgentId: null,
    state: "unconfigured",
    lastConfirmedAt: null,
    lastErrorCode: null,
    ...overrides,
  };
}

function bot(overrides = {}) {
  return {
    botId: BOT_A,
    name: "New Bot",
    computer: computer(),
    ...overrides,
  };
}

function fixture(overrides = {}) {
  let current = overrides.current ? structuredClone(overrides.current) : bot();
  let uuidIndex = 0;
  const writes = [];
  const store = {
    read: mock.fn(async (botId) => botId === BOT_A ? structuredClone(current) : null),
    updateComputer: mock.fn(async (botId, next) => {
      assert.equal(botId, BOT_A);
      writes.push(structuredClone(next));
      current = bot({ computer: structuredClone(next) });
      return structuredClone(current);
    }),
  };
  const manager = new EventEmitter();
  manager.open = mock.fn(async (value) => Object.freeze({
    botId: value.botId,
    targetId: value.computer.localProfileId,
    targetGeneration: value.computer.generation,
    partition: "persist:openbot-local-private",
    workspaceId: "workspace-private",
    state: "ready",
  }));
  manager.close = mock.fn(async () => {});
  manager.dispose = mock.fn();
  const broker = new EventEmitter();
  broker.decide = mock.fn(async () => "private-helper-result");
  broker.list = mock.fn(async () => [Object.freeze({
    grantId: GRANT_A,
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "workspace",
    resourceLabel: "OpenBot Workspace",
    scope: "always",
    createdAt: "2026-08-15T12:00:00.000Z",
  })]);
  broker.listPending = mock.fn(async () => [Object.freeze({
    requestId: "permission-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    capability: "filesystem.read",
    resourceLabel: "OpenBot Workspace",
    reason: "Read a selected file",
  })]);
  broker.revoke = mock.fn(async () => {});
  broker.cancelBot = mock.fn();
  broker.dispose = mock.fn();
  Object.assign(store, overrides.store || {});
  Object.assign(manager, overrides.manager || {});
  Object.assign(broker, overrides.broker || {});
  const { LocalComputerBoundary } = require(boundaryPath);
  const boundary = new LocalComputerBoundary({
    store,
    manager,
    broker,
    now: () => "2026-08-15T12:34:56.000Z",
    randomUUID: () => UUIDS[uuidIndex++],
  });
  return { boundary, broker, manager, store, writes, current: () => structuredClone(current) };
}

test("local mode durably publishes starting then ready with one stable private identity", async () => {
  const { boundary, manager, writes, current } = fixture();
  const changed = [];
  boundary.on("changed", (value) => changed.push(value));

  const selected = await boundary.selectMode({ botId: BOT_A, mode: "local" });
  assert.deepEqual(writes.map((entry) => [entry.mode, entry.state, entry.generation]), [
    ["local", "starting", 1],
    ["local", "ready", 1],
  ]);
  assert.equal(writes[0].localProfileId, LOCAL_A);
  assert.equal(writes[0].nativeAgentId, null);
  assert.equal(writes[1].lastConfirmedAt, "2026-08-15T12:34:56.000Z");
  assert.equal(manager.open.mock.callCount(), 1);
  assert.deepEqual(manager.open.mock.calls[0].arguments[0].computer, writes[1]);
  assert.deepEqual(selected, { botId: BOT_A, computer: writes[1] });
  assert.deepEqual(current().computer, writes[1]);
  assert.deepEqual(changed, [
    { botId: BOT_A, computer: writes[0] },
    { botId: BOT_A, computer: writes[1] },
  ]);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.computer), true);
});

test("failed local start remains fail closed and can switch to cursor then not-now", async () => {
  const startError = Object.assign(new Error("/Users/private token"), { code: "PRIVATE_FAILURE" });
  const { boundary, manager, writes } = fixture({
    manager: { open: mock.fn(async () => { throw startError; }) },
  });
  await assert.rejects(
    boundary.selectMode({ botId: BOT_A, mode: "local" }),
    (error) => error?.code === "OPENBOT_COMPUTER_START_FAILED"
      && !/Users|private|token/i.test(error.message),
  );
  assert.equal(writes.at(-1).state, "unavailable");
  assert.equal(writes.at(-1).lastErrorCode, "OPENBOT_LOCAL_DESKTOP_START_FAILED");

  const cursor = await boundary.selectMode({ botId: BOT_A, mode: "cursor" });
  assert.deepEqual(cursor.computer, computer({
    mode: "cursor",
    generation: 2,
    localProfileId: LOCAL_A,
    nativeAgentId: CURSOR_A,
    state: "unavailable",
    lastErrorCode: "CURSOR_ACCOUNT_REQUIRED",
  }));
  assert.equal(manager.close.mock.callCount(), 1);

  const skipped = await boundary.selectMode({ botId: BOT_A, mode: "not-now" });
  assert.deepEqual(skipped.computer, computer({
    generation: 3,
    localProfileId: LOCAL_A,
    nativeAgentId: CURSOR_A,
  }));
  assert.equal(manager.close.mock.callCount(), 2);
});

test("permission prompts and decisions expose metadata only and disposal is exact", async () => {
  const { boundary, broker, manager } = fixture();
  const prompts = [];
  boundary.on("permission-requested", (value) => prompts.push(value));
  const prompt = Object.freeze({
    requestId: "permission-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    capability: "filesystem.read",
    resourceLabel: "OpenBot Workspace",
    reason: "Read a selected file",
  });
  broker.emit("request", prompt);
  assert.deepEqual(prompts, [prompt]);
  assert.notEqual(prompts[0], prompt);
  assert.equal(Object.isFrozen(prompts[0]), true);

  const permissions = await boundary.decidePermission({
    requestId: prompt.requestId,
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    decision: "always",
  });
  assert.equal(broker.decide.mock.callCount(), 1);
  assert.deepEqual(permissions, { botId: BOT_A, permissions: await broker.list(BOT_A) });
  assert.doesNotMatch(JSON.stringify(permissions), /private-helper-result|bookmark|Users/i);

  assert.deepEqual(await boundary.listPermissions(BOT_A), permissions);
  const pending = await boundary.listPermissionRequests(BOT_A);
  assert.deepEqual(pending, { botId: BOT_A, requests: await broker.listPending(BOT_A) });
  assert.equal(Object.isFrozen(pending), true);
  assert.equal(Object.isFrozen(pending.requests), true);
  assert.deepEqual(await boundary.revokePermission({ botId: BOT_A, grantId: GRANT_A }), permissions);
  assert.deepEqual(broker.revoke.mock.calls[0].arguments, [{ botId: BOT_A, grantId: GRANT_A }]);

  boundary.dispose();
  boundary.dispose();
  assert.equal(manager.dispose.mock.callCount(), 1);
  assert.equal(broker.dispose.mock.callCount(), 1);
  broker.emit("request", prompt);
  assert.equal(prompts.length, 1);
  await assert.rejects(boundary.read(BOT_A), /disposed/i);
});

test("permission request publication is bounded to the broker's per-bot capacity", async () => {
  const prompt = (index) => Object.freeze({
    requestId: `permission-${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    capability: "filesystem.read",
    resourceLabel: `Folder ${index}`,
    reason: "Read a selected file",
  });
  const { boundary, broker } = fixture({
    broker: { listPending: mock.fn(async () => Array.from({ length: 32 }, (_, index) => prompt(index))) },
  });
  assert.equal((await boundary.listPermissionRequests(BOT_A)).requests.length, 32);
  broker.listPending.mock.mockImplementation(async () => Array.from({ length: 33 }, (_, index) => prompt(index)));
  await assert.rejects(boundary.listPermissionRequests(BOT_A), {
    code: "OPENBOT_COMPUTER_RESULT_INVALID",
  });
  boundary.dispose();
});

test("same-bot mode selections serialize and hostile input reaches no dependency", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const open = mock.fn(async () => held);
  const { boundary, manager, store } = fixture({ manager: { open } });
  const first = boundary.selectMode({ botId: BOT_A, mode: "local" });
  while (open.mock.callCount() === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = boundary.selectMode({ botId: BOT_A, mode: "not-now" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.close.mock.callCount(), 0);
  release({ state: "ready" });
  await first;
  await second;
  assert.equal(manager.close.mock.callCount(), 1);

  const callsBefore = store.read.mock.callCount();
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("private-token"); } });
  await assert.rejects(boundary.selectMode(hostile), (error) => (
    /plain|request/i.test(error?.message) && !/private-token/i.test(error?.message)
  ));
  assert.equal(store.read.mock.callCount(), callsBefore);
});

test("persistence failures close new helpers and restore an authoritative old local session", async () => {
  const first = fixture();
  const firstWrite = first.store.updateComputer;
  first.store.updateComputer = mock.fn(async (botId, next) => {
    if (next.state === "ready") throw new Error("disk /Users/private token");
    return firstWrite(botId, next);
  });
  await assert.rejects(first.boundary.selectMode({ botId: BOT_A, mode: "local" }), {
    code: "OPENBOT_COMPUTER_START_FAILED",
  });
  assert.equal(first.manager.close.mock.callCount(), 1);
  assert.equal(first.current().computer.state, "unavailable");

  const previous = bot({ computer: computer({
    mode: "local",
    generation: 4,
    localProfileId: LOCAL_A,
    state: "ready",
    lastConfirmedAt: "2026-08-15T11:00:00.000Z",
  }) });
  const second = fixture({ current: previous });
  second.store.updateComputer = mock.fn(async () => { throw new Error("write failed"); });
  await assert.rejects(second.boundary.selectMode({ botId: BOT_A, mode: "cursor" }), {
    code: "OPENBOT_COMPUTER_PERSIST_FAILED",
  });
  assert.equal(second.manager.close.mock.callCount(), 1);
  assert.equal(second.manager.open.mock.callCount(), 1);
  assert.deepEqual(second.manager.open.mock.calls[0].arguments[0], previous);
});
