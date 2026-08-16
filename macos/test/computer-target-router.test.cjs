"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const { ComputerTargetRouter } = require("../src/computer/computer-target-router.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function bot(botId, computer) {
  return Object.freeze({ botId, computer: Object.freeze({
    mode: "not-now",
    generation: 0,
    localProfileId: null,
    nativeAgentId: null,
    state: "unconfigured",
    lastConfirmedAt: null,
    lastErrorCode: null,
    ...computer,
  }) });
}

function localBot(botId = BOT_A, targetId = LOCAL_A, generation = 4) {
  return bot(botId, {
    mode: "local",
    generation,
    localProfileId: targetId,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:00:00.000Z",
  });
}

function fixture(initial = [localBot()]) {
  const records = new Map(initial.map((record) => [record.botId, record]));
  const openCalls = [];
  const effects = [];
  const navigations = [];
  const captures = [];
  const disposed = [];
  let releaseRun = null;
  let readCount = 0;
  let pauseReadAt = null;
  let releaseRead = null;
  const manager = {
    async open(record) {
      openCalls.push(record);
      return Object.freeze({
        botId: record.botId,
        targetId: record.computer.localProfileId,
        targetGeneration: record.computer.generation,
        partition: `persist:${record.computer.localProfileId}`,
        workspaceId: `workspace-${record.computer.localProfileId.slice("local-".length)}`,
        state: "ready",
      });
    },
    async run(action) {
      effects.push(action);
      if (releaseRun) await new Promise((resolve) => { releaseRun = resolve; });
      return Object.freeze({ exitCode: 0 });
    },
    async navigate(value) {
      navigations.push(value);
      return Object.freeze({ state: "ready" });
    },
    async capture(value) {
      captures.push(value);
      return Object.freeze({ frameId: "frame-a" });
    },
    async disposeTask(value) { disposed.push(value); },
  };
  const store = {
    async read(botId) {
      readCount += 1;
      if (readCount === pauseReadAt) await new Promise((resolve) => { releaseRead = resolve; });
      return records.get(botId) ?? null;
    },
  };
  const router = new ComputerTargetRouter({ store, localManager: manager });
  return {
    captures,
    effects,
    navigations,
    openCalls,
    records,
    disposed,
    router,
    pauseNextRun() { releaseRun = () => {}; },
    releaseRun() { releaseRun?.(); },
    pauseReadAt(value) { pauseReadAt = value; },
    releaseRead() { releaseRead?.(); },
  };
}

function resolveInput(taskId = "parent") {
  return { botId: BOT_A, conversationId: "thread-a", taskId };
}

function action(target, overrides = {}) {
  return {
    mode: target.mode,
    botId: target.botId,
    conversationId: "thread-a",
    taskId: "parent",
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    workspaceId: target.workspaceId,
    capability: "shell.execute",
    operation: "shell.execute",
    arguments: { command: "pwd" },
    resourceId: "workspace",
    resourceLabel: "OpenBot Workspace",
    reason: "Run an approved command for this task",
    ...overrides,
  };
}

test("local Work and subagents share one bot target with isolated stable task workspaces", async () => {
  const { router, openCalls } = fixture();

  const parent = await router.resolve(resolveInput("parent"));
  const child = await router.resolve(resolveInput("child-1"));
  const childAgain = await router.resolve(resolveInput("child-1"));
  const childFromAnotherConversation = await router.resolve({
    botId: BOT_A,
    conversationId: "thread-b",
    taskId: "child-1",
  });

  assert.equal(parent.mode, "local");
  assert.equal(parent.botId, BOT_A);
  assert.equal(parent.targetId, LOCAL_A);
  assert.equal(parent.targetGeneration, 4);
  assert.notEqual(parent.workspaceId, child.workspaceId);
  assert.equal(child.workspaceId, childAgain.workspaceId);
  assert.equal(child.workspaceId, childFromAnotherConversation.workspaceId);
  assert.match(parent.workspaceId, /^workspace-[a-f0-9]{64}$/);
  assert.deepEqual(parent.tools, [
    "browser.navigate",
    "browser.capture",
    "filesystem.read",
    "filesystem.write",
    "shell.execute",
    "application.open",
    "application.automate",
    "screen.capture",
  ]);
  assert.equal(Object.isFrozen(parent), true);
  assert.equal(Object.isFrozen(parent.tools), true);
  assert.equal(openCalls.length, 1);
});

test("a read-only task-current fence rejects target drift without opening a replacement target", async () => {
  const fixtureValue = fixture();
  const taskId = "subagent-11111111-1111-4111-8111-111111111111";
  const target = await fixtureValue.router.resolve(resolveInput(taskId));
  const expected = {
    mode: target.mode,
    botId: target.botId,
    taskId,
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    workspaceId: target.workspaceId,
  };

  await fixtureValue.router.assertTaskCurrent(expected);
  fixtureValue.records.set(BOT_A, localBot(BOT_A, LOCAL_A, 5));
  await assert.rejects(fixtureValue.router.assertTaskCurrent(expected), /changed|stale|current/i);

  assert.equal(fixtureValue.openCalls.length, 1);
  assert.equal(fixtureValue.effects.length, 0);
});

test("aborting a held target open invalidates the task immediately and never registers its late workspace", async () => {
  let enteredOpen = false;
  let releaseOpen = null;
  const current = localBot();
  const manager = {
    async open(record) {
      enteredOpen = true;
      await new Promise((resolve) => { releaseOpen = resolve; });
      return Object.freeze({
        botId: record.botId,
        targetId: record.computer.localProfileId,
        targetGeneration: record.computer.generation,
        state: "ready",
      });
    },
    async run() { throw new Error("unused"); },
    async navigate() { throw new Error("unused"); },
    async capture() { throw new Error("unused"); },
  };
  const router = new ComputerTargetRouter({
    store: { async read(botId) { return botId === BOT_A ? current : null; } },
    localManager: manager,
  });
  const taskId = "subagent-11111111-1111-4111-8111-111111111111";
  const workspaceId = `workspace-${createHash("sha256")
    .update("local")
    .update("\0")
    .update(BOT_A)
    .update("\0")
    .update(LOCAL_A)
    .update("\0")
    .update("4")
    .update("\0")
    .update(taskId)
    .digest("hex")}`;
  const expected = {
    mode: "local",
    botId: BOT_A,
    taskId,
    targetId: LOCAL_A,
    targetGeneration: 4,
    workspaceId,
  };
  const controller = new AbortController();
  const pending = router.resolve(resolveInput(taskId), controller.signal).then(
    () => Object.freeze({ state: "resolved" }),
    (error) => Object.freeze({ state: "rejected", error }),
  );
  while (!enteredOpen) await new Promise((resolve) => setImmediate(resolve));

  controller.abort();
  const immediate = await Promise.race([
    pending,
    new Promise((resolve) => setImmediate(() => resolve(Object.freeze({ state: "pending" })))),
  ]);
  try {
    assert.equal(immediate.state, "rejected");
    assert.equal(immediate.error.code, "OPENBOT_COMPUTER_TASK_DISPOSED");
    await assert.rejects(router.assertTaskCurrent(expected), /changed|stale|current/i);
  } finally {
    releaseOpen();
    await pending;
  }

  await assert.rejects(router.assertTaskCurrent(expected), /changed|stale|current/i);
  router.dispose();
});

test("owned-browser tools route through the local manager without a permission-broker action", async () => {
  const fixtureValue = fixture();
  const target = await fixtureValue.router.resolve(resolveInput());
  const navigated = await fixtureValue.router.run(action(target, {
    capability: "browser.navigate",
    operation: "browser.navigate",
    arguments: { url: "https://www.youtube.com/" },
    resourceId: "browser",
    resourceLabel: "OpenBot Browser",
    reason: "Open a page in this bot's browser",
  }));
  const captured = await fixtureValue.router.run(action(target, {
    capability: "browser.capture",
    operation: "browser.capture",
    arguments: {},
    resourceId: "browser",
    resourceLabel: "OpenBot Browser",
    reason: "Capture this bot's current browser frame",
  }));

  assert.deepEqual(fixtureValue.navigations, [{
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 4,
    url: "https://www.youtube.com/",
  }]);
  assert.deepEqual(fixtureValue.captures, [{
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 4,
  }]);
  assert.equal(fixtureValue.effects.length, 0);
  assert.deepEqual(navigated, { state: "ready" });
  assert.deepEqual(captured, { frameId: "frame-a" });
});

test("oversized or hostile actions reject before target or manager effects", async () => {
  const fixtureValue = fixture();
  const target = await fixtureValue.router.resolve(resolveInput());
  let traps = 0;
  const hostile = new Proxy({}, {
    ownKeys() { traps += 1; throw new Error("private-path-token"); },
  });

  await assert.rejects(fixtureValue.router.run(hostile), /invalid/i);
  await assert.rejects(fixtureValue.router.run(action(target, {
    arguments: { command: "x".repeat(300_000) },
  })), /invalid|oversized/i);
  assert.equal(traps, 1);
  assert.equal(fixtureValue.effects.length, 0);
});

test("not-now, Cursor, and wrong-target actions fail before any local effect", async () => {
  const notNow = bot(BOT_B, {});
  const { router, records, effects, openCalls } = fixture([localBot(), notNow]);

  await assert.rejects(
    router.resolve({ botId: BOT_B, conversationId: "thread-b", taskId: "parent" }),
    /not configured/i,
  );
  records.set(BOT_B, bot(BOT_B, {
    mode: "cursor",
    generation: 2,
    nativeAgentId: "cursor-agent-b",
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:00:00.000Z",
  }));
  await assert.rejects(
    router.resolve({ botId: BOT_B, conversationId: "thread-b", taskId: "parent" }),
    /Cursor Remote Computer is unavailable/i,
  );
  const target = await router.resolve(resolveInput());
  await assert.rejects(router.run(action(target, { targetId: LOCAL_B })), /changed|stale|mismatch/i);
  assert.equal(effects.length, 0);
  assert.equal(openCalls.length, 1);
});

test("local actions go only through the current manager target and stale results are suppressed", async () => {
  const fixtureValue = fixture();
  const target = await fixtureValue.router.resolve(resolveInput());
  fixtureValue.pauseNextRun();
  const pending = fixtureValue.router.run(action(target));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureValue.effects.length, 1);
  assert.deepEqual(fixtureValue.effects[0], {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 4,
    taskId: "parent",
    capability: "shell.execute",
    operation: "shell.execute",
    arguments: { command: "pwd" },
    resourceId: "workspace",
    resourceLabel: "OpenBot Workspace",
    reason: "Run an approved command for this task",
  });
  fixtureValue.records.set(BOT_A, localBot(BOT_A, LOCAL_A, 5));
  fixtureValue.releaseRun();
  await assert.rejects(pending, /changed|stale/i);
});

test("a stale reviewed action cannot open or register the replacement target before rejection", async () => {
  const fixtureValue = fixture();
  const target = await fixtureValue.router.resolve(resolveInput());
  fixtureValue.records.set(BOT_A, localBot(BOT_A, LOCAL_A, 5));

  await assert.rejects(fixtureValue.router.run(action(target)), /changed|stale|mismatch/i);

  assert.deepEqual(fixtureValue.openCalls.map((record) => record.computer.generation), [4]);
  assert.equal(fixtureValue.effects.length, 0);
});

test("disposing a subagent task invalidates its pending result without closing the shared target", async () => {
  const fixtureValue = fixture();
  const target = await fixtureValue.router.resolve(resolveInput("child-1"));
  fixtureValue.pauseNextRun();
  const pending = fixtureValue.router.run(action(target, { taskId: "child-1" }));
  await new Promise((resolve) => setImmediate(resolve));

  await fixtureValue.router.disposeTask({ botId: BOT_A, taskId: "child-1" });
  fixtureValue.releaseRun();

  await assert.rejects(pending, /disposed|changed|stale/i);
  assert.deepEqual(fixtureValue.disposed, [{ botId: BOT_A, taskId: "child-1" }]);
  const parent = await fixtureValue.router.resolve(resolveInput("parent"));
  assert.equal(parent.targetId, LOCAL_A);
  assert.equal(fixtureValue.openCalls.length, 1);
});

test("task disposal during the final current-target read suppresses the completed local effect", async () => {
  const fixtureValue = fixture();
  const target = await fixtureValue.router.resolve(resolveInput("child-2"));
  fixtureValue.pauseReadAt(4);
  const pending = fixtureValue.router.run(action(target, { taskId: "child-2" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureValue.effects.length, 1);

  await fixtureValue.router.disposeTask({ botId: BOT_A, taskId: "child-2" });
  fixtureValue.releaseRead();

  await assert.rejects(pending, /disposed|changed|stale/i);
});
