"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const runnerPath = "../src/desktop/standalone-subagent-runner.cjs";

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const CONVERSATION_A = "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_INVOCATION = "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELECTION = Object.freeze({
  botId: BOT_A,
  generation: 7,
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  serviceTier: null,
});

function ids(...values) {
  return () => {
    const value = values.shift();
    if (!value) throw new Error("test exhausted deterministic IDs");
    return value;
  };
}

function result(events) {
  return Object.freeze({
    fullStream: (async function* () {
      for (const event of events) yield Object.freeze(event);
    })(),
  });
}

function parentIdentity(overrides = {}) {
  return Object.freeze({
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    taskId: "parent",
    selection: SELECTION,
    ...overrides,
  });
}

function spawnCall(overrides = {}) {
  return Object.freeze({
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    taskId: "parent",
    invocationId: PARENT_INVOCATION,
    toolCallId: "call-spawn-1",
    toolName: "spawn_subagent",
    args: Object.freeze({ task: "Check the current page title." }),
    ...overrides,
  });
}

function numberedUuid(value) {
  const hex = value.toString(16).padStart(12, "0");
  return `70000000-0000-4000-8000-${hex}`;
}

function manualCleanupClock() {
  let timer = null;
  return Object.freeze({
    options: Object.freeze({
      setCleanupTimeout(callback, milliseconds) {
        assert.equal(timer, null);
        timer = { callback, cleared: false, milliseconds };
        return timer;
      },
      clearCleanupTimeout(value) {
        assert.equal(value, timer);
        value.cleared = true;
      },
    }),
    delay() { return timer?.milliseconds ?? null; },
    pending() { return Boolean(timer && !timer.cleared); },
    fire() {
      assert.equal(this.pending(), true);
      timer.cleared = true;
      timer.callback();
    },
  });
}

test("standalone spawn_subagent performs real child inference with a main-owned identity and no recursive tools", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  const requests = [];
  const opened = [];
  const disposed = [];
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream(request) {
        requests.push(request);
        return result([
          { type: "text-delta", textDelta: "The title is YouTube." },
          { type: "finish", finishReason: "stop" },
        ]);
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        opened.push(identity);
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("child has no Computer tools"); },
          async dispose() { disposed.push({ botId: identity.botId, taskId: identity.taskId }); },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });

  const session = await runner.open(parentIdentity());
  assert.deepEqual(session.definitions.map(({ name }) => name), ["spawn_subagent"]);
  const response = await session.dispatch(spawnCall());

  assert.deepEqual(response, { status: "completed", output: "The title is YouTube." });
  assert.equal(Object.isFrozen(response), true);
  assert.deepEqual(opened, [{
    botId: BOT_A,
    conversationId: "conversation-22222222-2222-4222-8222-222222222222",
    taskId: "subagent-11111111-1111-4111-8111-111111111111",
  }]);
  assert.deepEqual(disposed, [{
    botId: BOT_A,
    taskId: "subagent-11111111-1111-4111-8111-111111111111",
  }]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].selection, SELECTION);
  assert.equal(Object.isFrozen(requests[0].selection), true);
  assert.equal(requests[0].conversationId, "conversation-22222222-2222-4222-8222-222222222222");
  assert.equal(requests[0].invocationId, "invocation-33333333-3333-4333-8333-333333333333");
  assert.deepEqual(requests[0].messages, [{ role: "user", content: "Check the current page title." }]);
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].toolChoice, "none");
  assert.equal(requests[0].signal instanceof AbortSignal, true);
  assert.doesNotMatch(JSON.stringify(requests[0].tools), /spawn_subagent|mcp/i);

  await session.dispose();
  runner.dispose();
});

test("a main-generated standalone invocation task can own the parent subagent session", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  const parentTaskId = "standalone-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { return result([
      { type: "text-delta", textDelta: "owned" },
      { type: "finish", finishReason: "stop" },
    ]); } },
    async readSelection() { return SELECTION; },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity({ taskId: parentTaskId }));
  assert.equal(session.taskId, parentTaskId);
  assert.deepEqual(await session.dispatch(spawnCall({ taskId: parentTaskId })), {
    status: "completed",
    output: "owned",
  });
  await session.dispose();
  runner.dispose();
});

test("child inference receives only its current Computer tools and each generated task keeps a distinct workspace", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  const requests = [];
  const childSessions = [];
  const dispatches = [];
  const disposals = [];
  const rounds = new Map();
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream(request) {
        requests.push(request);
        const round = (rounds.get(request.conversationId) ?? 0) + 1;
        rounds.set(request.conversationId, round);
        if (round === 1) {
          return result([
            { type: "tool-call-streaming-start", toolCallId: "call-child-capture", toolName: "browser_capture" },
            { type: "tool-call", toolCallId: "call-child-capture", toolName: "browser_capture", args: {} },
            { type: "finish", finishReason: "tool-calls" },
          ]);
        }
        return result([
          { type: "text-delta", textDelta: `completed-${request.conversationId.slice(13, 21)}` },
          { type: "finish", finishReason: "stop" },
        ]);
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        const workspaceId = `workspace-for-${identity.taskId}`;
        childSessions.push({ ...identity, workspaceId });
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([Object.freeze({
            type: "function",
            name: "browser_capture",
            description: "Inspect this child task's current browser frame.",
            parameters: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
          })]),
          async dispatch(call) {
            dispatches.push({ ...call, workspaceId });
            return Object.freeze({ state: "ready", workspaceId });
          },
          async dispose() { disposals.push({ botId: identity.botId, taskId: identity.taskId }); },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    ),
  });
  const session = await runner.open(parentIdentity());

  const first = await session.dispatch(spawnCall());
  const second = await session.dispatch(spawnCall({
    toolCallId: "call-spawn-2",
    args: Object.freeze({ task: "Capture it again independently." }),
  }));

  assert.match(first.output, /^completed-/);
  assert.match(second.output, /^completed-/);
  assert.equal(childSessions.length, 2);
  assert.notEqual(childSessions[0].taskId, childSessions[1].taskId);
  assert.notEqual(childSessions[0].conversationId, childSessions[1].conversationId);
  assert.notEqual(childSessions[0].workspaceId, childSessions[1].workspaceId);
  assert.deepEqual(dispatches.map(({ taskId, workspaceId, toolName }) => ({ taskId, workspaceId, toolName })), [
    {
      taskId: childSessions[0].taskId,
      workspaceId: childSessions[0].workspaceId,
      toolName: "browser_capture",
    },
    {
      taskId: childSessions[1].taskId,
      workspaceId: childSessions[1].workspaceId,
      toolName: "browser_capture",
    },
  ]);
  assert.deepEqual(disposals.map(({ taskId }) => taskId), childSessions.map(({ taskId }) => taskId));
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.deepEqual(request.selection, SELECTION);
    assert.deepEqual(request.tools.map(({ name }) => name), ["browser_capture"]);
    assert.doesNotMatch(JSON.stringify(request.tools), /spawn_subagent|mcp/i);
  }
  assert.deepEqual(requests[1].messages.map(({ role }) => role), ["user", "assistant", "tool"]);
  assert.match(JSON.stringify(requests[1].messages.at(-1)), /workspace-for-subagent-/);

  await session.dispose();
  runner.dispose();
});

test("a parent session caps active children before allocating another identity", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  const releases = [];
  const requests = [];
  let nextId = 1;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream(request) {
        requests.push(request);
        return Object.freeze({
          fullStream: (async function* () {
            await new Promise((resolve) => releases.push(resolve));
            yield Object.freeze({ type: "text-delta", textDelta: "done" });
            yield Object.freeze({ type: "finish", finishReason: "stop" });
          })(),
        });
      },
    },
    async readSelection() { return SELECTION; },
    makeId() { return numberedUuid(nextId++); },
  });
  const session = await runner.open(parentIdentity());
  const pending = Array.from({ length: 4 }, (_, index) => session.dispatch(spawnCall({
    toolCallId: `call-spawn-${index + 1}`,
    args: Object.freeze({ task: `Child ${index + 1}` }),
  }))).map((value) => value.catch((error) => error));
  while (requests.length < 4) await new Promise((resolve) => setImmediate(resolve));
  const allocatedBefore = nextId;
  const fifth = session.dispatch(spawnCall({
    toolCallId: "call-spawn-5",
    args: Object.freeze({ task: "Child 5" }),
  })).then(() => "resolved", () => "rejected");
  const fifthOutcome = await Promise.race([
    fifth,
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  try {
    assert.equal(fifthOutcome, "rejected");
    assert.equal(nextId, allocatedBefore);
    assert.equal(requests.length, 4);
  } finally {
    await session.dispose();
    for (const release of releases) release();
    await Promise.all(pending);
    runner.dispose();
  }
});

test("the child deadline aborts inference and disposes the exact registered Computer task once", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let deadline = null;
  let cleared = 0;
  let signal = null;
  let childIdentity = null;
  let disposals = 0;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream(request) {
        signal = request.signal;
        return Object.freeze({
          fullStream: (async function* () {
            await new Promise((resolve, reject) => {
              request.signal.addEventListener("abort", () => reject(new Error("late private child output")), { once: true });
            });
          })(),
        });
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        childIdentity = identity;
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() { disposals += 1; },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
    timeoutMs: 1000,
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 1000);
      deadline = callback;
      return Object.freeze({ unref() {} });
    },
    clearTimeout() { cleared += 1; },
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!deadline || !signal) await new Promise((resolve) => setImmediate(resolve));
  deadline();
  const error = await pending;

  assert.equal(error.code, "OPENBOT_SUBAGENT_CANCELLED");
  assert.equal(signal.aborted, true);
  assert.equal(childIdentity.taskId, "subagent-11111111-1111-4111-8111-111111111111");
  assert.equal(disposals, 1);
  assert.equal(cleared, 1);
  assert.doesNotMatch(String(error.stack), /private|output|Users|token/i);
  await session.dispose();
  runner.dispose();
});

test("the child deadline settles even when an inference transport ignores AbortSignal", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let deadline = null;
  let release = null;
  let entered = false;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        return Object.freeze({
          fullStream: (async function* () {
            entered = true;
            await new Promise((resolve) => { release = resolve; });
            yield Object.freeze({ type: "text-delta", textDelta: "late private output" });
            yield Object.freeze({ type: "finish", finishReason: "stop" });
          })(),
        });
      },
    },
    async readSelection() { return SELECTION; },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
    timeoutMs: 1000,
    setTimeout(callback) {
      deadline = callback;
      return Object.freeze({ unref() {} });
    },
    clearTimeout() {},
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).then(
    () => Object.freeze({ state: "resolved" }),
    (error) => Object.freeze({ state: "rejected", error }),
  );
  while (!deadline || !entered) await new Promise((resolve) => setImmediate(resolve));
  deadline();
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setImmediate(() => resolve(Object.freeze({ state: "pending" })))),
  ]);
  try {
    assert.equal(outcome.state, "rejected");
    assert.equal(outcome.error.code, "OPENBOT_SUBAGENT_CANCELLED");
    assert.doesNotMatch(String(outcome.error.stack), /late|private|output|Users|token/i);
  } finally {
    release();
    await pending;
    await session.dispose();
    runner.dispose();
  }
});

test("runner disposal cancels active children and acknowledges exact Computer teardown", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let enteredInference = false;
  let releaseInference = null;
  let enteredDisposal = false;
  let releaseDisposal = null;
  let disposals = 0;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        return Object.freeze({
          fullStream: (async function* () {
            enteredInference = true;
            await new Promise((resolve) => { releaseInference = resolve; });
            yield Object.freeze({ type: "text-delta", textDelta: "late private output" });
            yield Object.freeze({ type: "finish", finishReason: "stop" });
          })(),
        });
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() {
            disposals += 1;
            enteredDisposal = true;
            await new Promise((resolve) => { releaseDisposal = resolve; });
          },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!enteredInference) await new Promise((resolve) => setImmediate(resolve));

  const disposing = Promise.resolve(runner.dispose()).then(() => "disposed");
  while (!enteredDisposal) await new Promise((resolve) => setImmediate(resolve));
  const early = await Promise.race([
    disposing,
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(early, "pending");
  assert.equal(await Promise.race([
    pending.then(() => "settled"),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");
  assert.equal(disposals, 1);

  releaseDisposal();
  assert.equal((await pending).code, "OPENBOT_SUBAGENT_CANCELLED");
  assert.equal(await disposing, "disposed");
  assert.equal(await runner.dispose(), undefined);
  releaseInference();
});

test("session cancellation and runner disposal await a pending Computer open's exact late teardown", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let enteredOpen = false;
  let releaseOpen = null;
  let enteredDisposal = false;
  let releaseDisposal = null;
  let disposals = 0;
  const disposedIdentities = [];
  let inferenceCalls = 0;
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { inferenceCalls += 1; return result([]); } },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        enteredOpen = true;
        await new Promise((resolve) => { releaseOpen = resolve; });
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() {
            disposals += 1;
            disposedIdentities.push({
              botId: identity.botId,
              conversationId: identity.conversationId,
              taskId: identity.taskId,
            });
            enteredDisposal = true;
            await new Promise((resolve) => { releaseDisposal = resolve; });
          },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!enteredOpen) await new Promise((resolve) => setImmediate(resolve));

  const sessionDisposal = session.dispose().then(() => "session-disposed");
  const runnerDisposal = Promise.resolve(runner.dispose()).then(() => "runner-disposed");
  assert.equal((await pending).code, "OPENBOT_SUBAGENT_CANCELLED");
  assert.deepEqual(await Promise.race([
    Promise.all([sessionDisposal, runnerDisposal]),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");
  assert.equal(disposals, 0);
  assert.equal(inferenceCalls, 0);

  releaseOpen();
  while (!enteredDisposal) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await Promise.race([
    Promise.all([sessionDisposal, runnerDisposal]),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");
  assert.equal(disposals, 1);
  assert.deepEqual(disposedIdentities, [{
    botId: BOT_A,
    conversationId: "conversation-22222222-2222-4222-8222-222222222222",
    taskId: "subagent-11111111-1111-4111-8111-111111111111",
  }]);
  assert.equal(inferenceCalls, 0);

  releaseDisposal();
  assert.deepEqual(await Promise.all([sessionDisposal, runnerDisposal]), [
    "session-disposed",
    "runner-disposed",
  ]);
  assert.equal(disposals, 1);
  assert.equal(inferenceCalls, 0);
});

test("an open resolving on abort must await its held exact disposer beyond the open-only bound", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let enteredOpen = false;
  let enteredDisposal = false;
  let releaseDisposal = null;
  let disposals = 0;
  let inferenceCalls = 0;
  const cleanupClock = manualCleanupClock();
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { inferenceCalls += 1; return result([]); } },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity, signal) {
        enteredOpen = true;
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() {
            disposals += 1;
            enteredDisposal = true;
            await new Promise((release) => { releaseDisposal = release; });
          },
        })), { once: true }));
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
    ...cleanupClock.options,
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!enteredOpen) await new Promise((resolve) => setImmediate(resolve));

  const sessionDisposal = session.dispose().then(() => "session-disposed");
  const runnerDisposal = runner.dispose().then(() => "runner-disposed");
  while (!enteredDisposal) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupClock.delay(), 250);
  assert.equal(cleanupClock.pending(), false);
  const beforeRelease = await Promise.race([
    Promise.all([sessionDisposal, runnerDisposal]).then(() => "resolved"),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(beforeRelease, "pending");
  assert.equal(disposals, 1);
  assert.equal(inferenceCalls, 0);

  releaseDisposal();
  assert.deepEqual(await Promise.all([sessionDisposal, runnerDisposal]), [
    "session-disposed",
    "runner-disposed",
  ]);
  assert.equal((await pending).code, "OPENBOT_SUBAGENT_CANCELLED");
  assert.equal(disposals, 1);
  assert.equal(inferenceCalls, 0);
});

test("a permanently hung Computer open cannot hold cancellation or app disposal past the cleanup bound", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let enteredOpen = false;
  let openSignal = null;
  let inferenceCalls = 0;
  let disposals = 0;
  const cleanupClock = manualCleanupClock();
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { inferenceCalls += 1; return result([]); } },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(_identity, signal) {
        enteredOpen = true;
        openSignal = signal;
        return new Promise(() => {});
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
    ...cleanupClock.options,
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!enteredOpen) await new Promise((resolve) => setImmediate(resolve));

  const sessionDisposal = session.dispose();
  const runnerDisposal = runner.dispose();
  assert.equal((await pending).code, "OPENBOT_SUBAGENT_CANCELLED");
  assert.equal(await Promise.race([
    Promise.all([sessionDisposal, runnerDisposal]).then(() => "settled"),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");
  assert.equal(cleanupClock.delay(), 250);
  assert.equal(cleanupClock.pending(), true);

  cleanupClock.fire();
  await Promise.all([sessionDisposal, runnerDisposal]);
  assert.equal(openSignal instanceof AbortSignal, true);
  assert.equal(openSignal.aborted, true);
  assert.equal(inferenceCalls, 0);
  assert.equal(disposals, 0);
});

test("an open resolving after the cleanup bound is still disposed exactly once without late inference", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let enteredOpen = false;
  let releaseOpen = null;
  let inferenceCalls = 0;
  const disposed = [];
  const cleanupClock = manualCleanupClock();
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { inferenceCalls += 1; return result([]); } },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        enteredOpen = true;
        await new Promise((resolve) => { releaseOpen = resolve; });
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() { disposed.push(identity.taskId); },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
    ...cleanupClock.options,
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!enteredOpen) await new Promise((resolve) => setImmediate(resolve));

  const sessionDisposal = session.dispose();
  const runnerDisposal = runner.dispose();
  while (!cleanupClock.pending()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupClock.delay(), 250);
  cleanupClock.fire();
  await Promise.all([sessionDisposal, runnerDisposal]);
  assert.equal((await pending).code, "OPENBOT_SUBAGENT_CANCELLED");
  assert.deepEqual(disposed, []);
  assert.equal(inferenceCalls, 0);

  releaseOpen();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(disposed, ["subagent-11111111-1111-4111-8111-111111111111"]);
  assert.equal(inferenceCalls, 0);
});

test("the child deadline settles a hung Computer open and disposes the late session", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let deadline = null;
  let releaseOpen = null;
  let enteredOpen = false;
  let disposals = 0;
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { throw new Error("inference must not start"); } },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        enteredOpen = true;
        await new Promise((resolve) => { releaseOpen = resolve; });
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() { disposals += 1; },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
    timeoutMs: 1000,
    setTimeout(callback) {
      deadline = callback;
      return Object.freeze({ unref() {} });
    },
    clearTimeout() {},
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).then(
    () => Object.freeze({ state: "resolved" }),
    (error) => Object.freeze({ state: "rejected", error }),
  );
  while (!deadline || !enteredOpen) await new Promise((resolve) => setImmediate(resolve));
  deadline();
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setImmediate(() => resolve(Object.freeze({ state: "pending" })))),
  ]);
  try {
    assert.equal(outcome.state, "rejected");
    assert.equal(outcome.error.code, "OPENBOT_SUBAGENT_CANCELLED");
    assert.equal(disposals, 0);
  } finally {
    releaseOpen();
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposals, 1);
    await session.dispose();
    runner.dispose();
  }
});

test("generated standalone children use the actual Computer bridge task identity rather than the parent workspace", async () => {
  const { createStandaloneComputerToolBridge } = require("../src/desktop/standalone-conversation-controller.cjs");
  const { StandaloneSubagentRunner } = require(runnerPath);
  const resolved = [];
  const resolveSignals = [];
  const currentChecks = [];
  const disposed = [];
  const computerBridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve(identity, signal) {
        resolved.push(identity);
        resolveSignals.push(signal);
        return Object.freeze({
          mode: "local",
          botId: identity.botId,
          targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          targetGeneration: 4,
          workspaceId: `workspace-${identity.taskId === "parent" ? "a" : "b".repeat(64)}`,
          tools: Object.freeze(["browser.navigate", "browser.capture"]),
        });
      },
      async assertTaskCurrent(identity) { currentChecks.push(identity); },
      async run() { throw new Error("unused"); },
      async disposeTask(identity) { disposed.push(identity); },
    },
  });
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { return result([
      { type: "text-delta", textDelta: "child done" },
      { type: "finish", finishReason: "stop" },
    ]); } },
    async readSelection() { return SELECTION; },
    toolBridge: computerBridge,
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const value = await session.dispatch(spawnCall());

  assert.deepEqual(value, { status: "completed", output: "child done" });
  assert.deepEqual(resolved, [{
    botId: BOT_A,
    conversationId: "conversation-22222222-2222-4222-8222-222222222222",
    taskId: "subagent-11111111-1111-4111-8111-111111111111",
  }]);
  assert.equal(resolveSignals.length, 1);
  assert.equal(resolveSignals[0] instanceof AbortSignal, true);
  assert.deepEqual(disposed, [{
    botId: BOT_A,
    taskId: "subagent-11111111-1111-4111-8111-111111111111",
  }]);
  assert.equal(currentChecks.length, 2);
  assert.deepEqual(currentChecks[0], {
    mode: "local",
    botId: BOT_A,
    taskId: "subagent-11111111-1111-4111-8111-111111111111",
    targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetGeneration: 4,
    workspaceId: `workspace-${"b".repeat(64)}`,
  });
  await session.dispose();
  runner.dispose();
});

test("a hostile cross-bot child Computer session is disposed before inference and cannot leak its result", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let routerCalls = 0;
  let disposals = 0;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        routerCalls += 1;
        return result([
          { type: "text-delta", textDelta: "private cross-bot result" },
          { type: "finish", finishReason: "stop" },
        ]);
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          botId: "bot-22222222-2222-4222-8222-222222222222",
          definitions: Object.freeze([]),
          async dispatch() { return { private: true }; },
          async dispose() { disposals += 1; },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const error = await session.dispatch(spawnCall()).catch((caught) => caught);

  assert.equal(error.code, "OPENBOT_SUBAGENT_OPERATION_FAILED");
  assert.equal(routerCalls, 0);
  assert.equal(disposals, 1);
  assert.doesNotMatch(String(error.stack), /cross-bot|private|result|token|Users/i);
  await session.dispose();
  runner.dispose();
});

test("a hybrid tool definition cannot smuggle an unreviewed or MCP-shaped child tool", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let routerCalls = 0;
  let disposals = 0;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        routerCalls += 1;
        return result([
          { type: "text-delta", textDelta: "must not run" },
          { type: "finish", finishReason: "stop" },
        ]);
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([Object.freeze({
            type: "function",
            name: "mcp_private_escape",
            description: "Unreviewed top-level tool.",
            parameters: Object.freeze({ type: "object" }),
            function: Object.freeze({
              name: "browser_capture",
              parameters: Object.freeze({ type: "object" }),
            }),
          })]),
          async dispatch() { throw new Error("must not dispatch"); },
          async dispose() { disposals += 1; },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const error = await session.dispatch(spawnCall()).catch((caught) => caught);

  assert.equal(error.code, "OPENBOT_SUBAGENT_OPERATION_FAILED");
  assert.equal(routerCalls, 0);
  assert.equal(disposals, 1);
  await session.dispose();
  await runner.dispose();
});

test("a child stream has a hard event budget even when deltas contain zero bytes", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let emitted = 0;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        return Object.freeze({
          fullStream: (async function* () {
            for (let index = 0; index < 5000; index += 1) {
              emitted += 1;
              yield Object.freeze({ type: "text-delta", textDelta: "" });
            }
            yield Object.freeze({ type: "finish", finishReason: "stop" });
          })(),
        });
      },
    },
    async readSelection() { return SELECTION; },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const error = await session.dispatch(spawnCall()).catch((caught) => caught);

  assert.equal(error.code, "OPENBOT_SUBAGENT_OPERATION_FAILED");
  assert.ok(emitted < 5000);
  await session.dispose();
  await runner.dispose();
});

test("disposing a parent while child currentness is awaiting suppresses the late Computer effect", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let reads = 0;
  let releaseRead = null;
  let enteredRead = false;
  let effects = 0;
  let disposals = 0;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        return result([
          { type: "tool-call-streaming-start", toolCallId: "call-child", toolName: "browser_capture" },
          { type: "tool-call", toolCallId: "call-child", toolName: "browser_capture", args: {} },
          { type: "finish", finishReason: "tool-calls" },
        ]);
      },
    },
    async readSelection() {
      reads += 1;
      if (reads === 6) {
        enteredRead = true;
        await new Promise((resolve) => { releaseRead = resolve; });
      }
      return SELECTION;
    },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([Object.freeze({
            type: "function",
            name: "browser_capture",
            description: "Capture the current frame.",
            parameters: Object.freeze({ type: "object", properties: Object.freeze({}), additionalProperties: false }),
          })]),
          async dispatch() { effects += 1; return Object.freeze({ state: "late private" }); },
          async dispose() { disposals += 1; },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!enteredRead) await new Promise((resolve) => setImmediate(resolve));
  await session.dispose();
  releaseRead();
  const error = await pending;

  assert.equal(error.code, "OPENBOT_SUBAGENT_CANCELLED");
  assert.equal(effects, 0);
  assert.equal(disposals, 1);
  assert.doesNotMatch(String(error.stack), /late|private|Users|token/i);
  runner.dispose();
});

test("a completed child task identity can never be reused for another workspace", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let opens = 0;
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { return result([
      { type: "text-delta", textDelta: "done" },
      { type: "finish", finishReason: "stop" },
    ]); } },
    async readSelection() { return SELECTION; },
    toolBridge: {
      async open(identity) {
        opens += 1;
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() {},
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
      "44444444-4444-4444-8444-444444444444",
      "55555555-5555-4555-8555-555555555555",
    ),
  });
  const session = await runner.open(parentIdentity());
  assert.equal((await session.dispatch(spawnCall())).status, "completed");
  const error = await session.dispatch(spawnCall({ toolCallId: "call-spawn-2" })).catch((caught) => caught);

  assert.equal(error.code, "OPENBOT_SUBAGENT_OPERATION_FAILED");
  assert.equal(opens, 1);
  await session.dispose();
  runner.dispose();
});

test("child conversation and invocation identities cannot be reused across isolated transcripts", async (t) => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  for (const scenario of [
    {
      name: "conversation",
      values: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
        "22222222-2222-4222-8222-222222222222",
        "55555555-5555-4555-8555-555555555555",
      ],
    },
    {
      name: "invocation",
      values: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
        "55555555-5555-4555-8555-555555555555",
        "33333333-3333-4333-8333-333333333333",
      ],
    },
  ]) {
    await t.test(scenario.name, async () => {
      let routerCalls = 0;
      const runner = new StandaloneSubagentRunner({
        router: { async stream() { routerCalls += 1; return result([
          { type: "text-delta", textDelta: "done" },
          { type: "finish", finishReason: "stop" },
        ]); } },
        async readSelection() { return SELECTION; },
        makeId: ids(...scenario.values),
      });
      const session = await runner.open(parentIdentity());
      assert.equal((await session.dispatch(spawnCall())).status, "completed");
      const error = await session.dispatch(spawnCall({ toolCallId: "call-spawn-2" })).catch((caught) => caught);
      assert.equal(error.code, "OPENBOT_SUBAGENT_OPERATION_FAILED");
      assert.equal(routerCalls, 1);
      await session.dispose();
      runner.dispose();
    });
  }
});

test("selection drift suppresses every late child result and disposes its task", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let current = SELECTION;
  let entered = false;
  let release = null;
  let disposals = 0;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        return Object.freeze({
          fullStream: (async function* () {
            entered = true;
            await new Promise((resolve) => { release = resolve; });
            yield Object.freeze({ type: "text-delta", textDelta: "late private child output" });
            yield Object.freeze({ type: "finish", finishReason: "stop" });
          })(),
        });
      },
    },
    async readSelection() { return current; },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() { disposals += 1; },
        });
      },
    },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  current = Object.freeze({ ...SELECTION, generation: 8 });
  release();
  const error = await pending;

  assert.equal(error.code, "OPENBOT_SUBAGENT_STALE");
  assert.equal(disposals, 1);
  assert.doesNotMatch(String(error.stack), /late|private|child output|Users|token/i);
  await session.dispose();
  runner.dispose();
});

test("catalog generation drift suppresses every late child result", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  const initial = Object.freeze({ ...SELECTION, catalogGeneration: 21 });
  let current = initial;
  let entered = false;
  let release = null;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        return Object.freeze({
          fullStream: (async function* () {
            entered = true;
            await new Promise((resolve) => { release = resolve; });
            yield Object.freeze({ type: "text-delta", textDelta: "stale catalog child output" });
            yield Object.freeze({ type: "finish", finishReason: "stop" });
          })(),
        });
      },
    },
    async readSelection() { return current; },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity({ selection: initial }));
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  current = Object.freeze({ ...initial, catalogGeneration: 22 });
  release();
  const error = await pending;

  assert.equal(error.code, "OPENBOT_SUBAGENT_STALE");
  assert.doesNotMatch(String(error.stack), /stale|catalog|child output|Users|token/i);
  await session.dispose();
  await runner.dispose();
});

test("selection drift after the final stream event cannot publish a completed child result", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let current = SELECTION;
  let releaseDone = null;
  let awaitingDone = false;
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        let index = 0;
        return Object.freeze({
          fullStream: Object.freeze({
            [Symbol.asyncIterator]() { return this; },
            async next() {
              index += 1;
              if (index === 1) return { done: false, value: { type: "text-delta", textDelta: "apparently done" } };
              if (index === 2) return { done: false, value: { type: "finish", finishReason: "stop" } };
              awaitingDone = true;
              await new Promise((resolve) => { releaseDone = resolve; });
              return { done: true, value: undefined };
            },
          }),
        });
      },
    },
    async readSelection() { return current; },
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const pending = session.dispatch(spawnCall()).catch((error) => error);
  while (!awaitingDone) await new Promise((resolve) => setImmediate(resolve));
  current = Object.freeze({ ...SELECTION, generation: 8 });
  releaseDone();
  const error = await pending;

  assert.equal(error.code, "OPENBOT_SUBAGENT_STALE");
  assert.doesNotMatch(JSON.stringify(error), /apparently done/);
  await session.dispose();
  runner.dispose();
});

test("target drift after the final child event suppresses the late subagent result", async () => {
  const { createStandaloneComputerToolBridge } = require("../src/desktop/standalone-conversation-controller.cjs");
  const { StandaloneSubagentRunner } = require(runnerPath);
  let targetGeneration = 4;
  let routerCalls = 0;
  let currentChecks = 0;
  let disposals = 0;
  const taskTargets = new Map();
  const computerBridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve(identity) {
        const target = Object.freeze({
          mode: "local",
          botId: identity.botId,
          targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          targetGeneration,
          workspaceId: `workspace-${"b".repeat(64)}`,
          tools: Object.freeze(["browser.navigate", "browser.capture"]),
        });
        taskTargets.set(identity.taskId, target);
        return target;
      },
      async assertTaskCurrent(expected) {
        currentChecks += 1;
        const registered = taskTargets.get(expected.taskId);
        if (!registered || expected.targetGeneration !== targetGeneration
          || expected.targetId !== registered.targetId || expected.workspaceId !== registered.workspaceId) {
          const error = new Error("private stale target detail");
          error.code = "OPENBOT_COMPUTER_TARGET_STALE";
          throw error;
        }
      },
      async run() { throw new Error("unused"); },
      async disposeTask(identity) { taskTargets.delete(identity.taskId); disposals += 1; },
    },
  });
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream() {
        routerCalls += 1;
        return Object.freeze({
          fullStream: (async function* () {
            yield Object.freeze({ type: "text-delta", textDelta: "late target-bound output" });
            yield Object.freeze({ type: "finish", finishReason: "stop" });
            targetGeneration = 5;
          })(),
        });
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: computerBridge,
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  const error = await session.dispatch(spawnCall()).catch((caught) => caught);

  assert.equal(error.code, "OPENBOT_SUBAGENT_STALE");
  assert.equal(routerCalls, 1);
  assert.equal(currentChecks, 2);
  assert.equal(disposals, 1);
  assert.doesNotMatch(String(error.stack), /late|target-bound|private|detail|Users|token/i);
  await session.dispose();
  await runner.dispose();
});

test("hostile parent calls fail before IDs, inference, or child Computer state are touched", async () => {
  const { StandaloneSubagentRunner } = require(runnerPath);
  let idsAllocated = 0;
  let routerCalls = 0;
  let computerOpens = 0;
  const runner = new StandaloneSubagentRunner({
    router: { async stream() { routerCalls += 1; return result([]); } },
    async readSelection() { return SELECTION; },
    toolBridge: { async open() { computerOpens += 1; throw new Error("must not open"); } },
    makeId() { idsAllocated += 1; return numberedUuid(idsAllocated); },
  });
  let proxyTraps = 0;
  await assert.rejects(runner.open(new Proxy(parentIdentity(), {
    ownKeys() { proxyTraps += 1; throw new Error("private /Users/person token"); },
  })), { code: "OPENBOT_SUBAGENT_OPERATION_FAILED" });
  assert.equal(proxyTraps, 0);
  const session = await runner.open(parentIdentity());
  let accessorReads = 0;
  const accessorArgs = Object.defineProperty({}, "task", {
    enumerable: true,
    get() { accessorReads += 1; return "private /Users/person token"; },
  });
  for (const call of [
    spawnCall({ args: accessorArgs }),
    spawnCall({ args: { task: "valid", taskId: "forged-child" } }),
    spawnCall({ botId: "bot-22222222-2222-4222-8222-222222222222" }),
    spawnCall({ toolName: "mcp_call" }),
  ]) {
    await assert.rejects(session.dispatch(call), { code: "OPENBOT_SUBAGENT_OPERATION_FAILED" });
  }
  assert.equal(accessorReads, 0);
  assert.equal(idsAllocated, 0);
  assert.equal(routerCalls, 0);
  assert.equal(computerOpens, 0);
  await session.dispose();
  runner.dispose();
});

test("an unavailable Computer target gives the child Chat only and never fabricates Computer or MCP tools", async () => {
  const { createStandaloneComputerToolBridge } = require("../src/desktop/standalone-conversation-controller.cjs");
  const { StandaloneSubagentRunner } = require(runnerPath);
  let capturedTools = null;
  let runs = 0;
  let disposals = 0;
  const unavailable = new Error("private provider detail");
  unavailable.code = "OPENBOT_COMPUTER_NOT_CONFIGURED";
  const computerBridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve() { throw unavailable; },
      async run() { runs += 1; throw new Error("must not run"); },
      async disposeTask() { disposals += 1; },
    },
  });
  const runner = new StandaloneSubagentRunner({
    router: {
      async stream(request) {
        capturedTools = request.tools;
        return result([
          { type: "text-delta", textDelta: "chat-only child" },
          { type: "finish", finishReason: "stop" },
        ]);
      },
    },
    async readSelection() { return SELECTION; },
    toolBridge: computerBridge,
    makeId: ids(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ),
  });
  const session = await runner.open(parentIdentity());
  assert.deepEqual(await session.dispatch(spawnCall()), { status: "completed", output: "chat-only child" });
  assert.deepEqual(capturedTools, []);
  assert.equal(runs, 0);
  assert.equal(disposals, 0);
  assert.doesNotMatch(JSON.stringify(capturedTools), /computer|spawn_subagent|mcp/i);
  await session.dispose();
  runner.dispose();
});
