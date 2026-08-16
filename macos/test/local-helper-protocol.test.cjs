"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const path = require("node:path");

const protocolPath = path.join(__dirname, "..", "src", "local", "local-helper-protocol.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const TARGET_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQUEST_A = "request-11111111-1111-4111-8111-111111111111";

function request(overrides = {}) {
  return {
    requestId: REQUEST_A,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 4,
    taskId: "task-a",
    capability: "shell.execute",
    operation: "shell.execute",
    arguments: { command: "pwd" },
    ...overrides,
  };
}

function current(generation = 4) {
  return {
    botId: BOT_A,
    computer: {
      mode: "local",
      generation,
      localProfileId: TARGET_A,
      state: "ready",
    },
  };
}

class FakeTransport {
  messages = [];
  cancellations = [];
  disposed = false;
  #messageListeners = new Set();
  #exitListeners = new Set();

  send = mock.fn(async (message) => {
    this.messages.push(message);
  });

  cancel = mock.fn(async (requestId) => {
    this.cancellations.push(requestId);
  });

  onMessage(listener) {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onExit(listener) {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  reply(message) {
    for (const listener of [...this.#messageListeners]) listener(message);
  }

  exit() {
    for (const listener of [...this.#exitListeners]) listener();
  }

  dispose() {
    this.disposed = true;
  }
}

function fixture(overrides = {}) {
  let active = overrides.current || current();
  const transport = overrides.transport || new FakeTransport();
  const { LocalHelperProtocol } = require(protocolPath);
  const protocol = new LocalHelperProtocol({
    transport,
    readCurrentComputer: async () => active,
    timeoutMs: overrides.timeoutMs || 100,
    ...(overrides.setTimer ? { setTimer: overrides.setTimer } : {}),
    ...(overrides.clearTimer ? { clearTimer: overrides.clearTimer } : {}),
  });
  return {
    protocol,
    transport,
    setCurrent(value) { active = value; },
  };
}

test("helper requests are exact bounded current and correlated", async () => {
  const { protocol, transport } = fixture();
  const pending = protocol.run(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.messages, [request()]);
  assert.equal(Object.isFrozen(transport.messages[0]), true);

  transport.reply({
    requestId: REQUEST_A,
    ok: true,
    value: { exitCode: 0, stdout: "workspace", stderr: "" },
  });
  const value = await pending;
  assert.deepEqual(value, { exitCode: 0, stdout: "workspace", stderr: "" });
  assert.equal(Object.isFrozen(value), true);
  protocol.dispose();
});

test("stale helper replies and oversized or secret payloads fail closed", async () => {
  const { protocol, setCurrent, transport } = fixture();
  const pending = protocol.run(request());
  const outcome = pending.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  setCurrent(current(5));
  transport.reply({
    requestId: REQUEST_A,
    ok: true,
    value: { output: "token=/Users/private" },
  });
  const failure = await outcome;
  assert.match(failure.message, /stale|failed/i);
  assert.doesNotMatch(JSON.stringify(failure), /Users|token|private/);

  const nextFixture = fixture({ current: current(5) });
  const next = nextFixture.protocol.run(request({ requestId: "request-22222222-2222-4222-8222-222222222222", targetGeneration: 5 }));
  const nextOutcome = next.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  nextFixture.transport.reply({
    requestId: "request-22222222-2222-4222-8222-222222222222",
    ok: true,
    value: { output: "x".repeat(300 * 1024) },
  });
  assert.match((await nextOutcome).message, /failed|invalid|oversized/i);
  protocol.dispose();
  nextFixture.protocol.dispose();
});

test("unknown replies helper exit timeout and disposal settle pending work once", async () => {
  const transport = new FakeTransport();
  const { protocol } = fixture({ transport, timeoutMs: 20 });
  const first = protocol.run(request());
  const firstOutcome = first.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  transport.reply({ requestId: "request-33333333-3333-4333-8333-333333333333", ok: true, value: null });
  assert.match((await firstOutcome).message, /failed|invalid/i);
  assert.equal(transport.disposed, true);
  await assert.rejects(protocol.run(request({
    requestId: "request-44444444-4444-4444-8444-444444444444",
  })), /disposed|terminated/i);

  const secondTransport = new FakeTransport();
  const secondFixture = fixture({ transport: secondTransport, timeoutMs: 20 });
  const timed = secondFixture.protocol.run(request()).catch((error) => error);
  assert.match((await timed).message, /timed out/i);
  assert.equal(secondTransport.disposed, true);

  const thirdTransport = new FakeTransport();
  const thirdFixture = fixture({ transport: thirdTransport });
  const exited = thirdFixture.protocol.run(request()).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  thirdTransport.exit();
  assert.match((await exited).message, /exited|failed/i);

  const fourthTransport = new FakeTransport();
  const fourthFixture = fixture({ transport: fourthTransport });
  const disposed = fourthFixture.protocol.run(request()).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const fourthDisposal = fourthFixture.protocol.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  fourthTransport.reply({ requestId: REQUEST_A, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" });
  await fourthDisposal;
  assert.equal((await disposed).code, "OPENBOT_LOCAL_CANCELLED");
  assert.equal(fourthTransport.disposed, true);
});

test("task cancellation sends exact request cancellation and leaves sibling work usable", async () => {
  const { protocol, transport } = fixture();
  const taskA = protocol.run(request());
  const taskAOutcome = taskA.catch((error) => error);
  const taskBRequest = request({
    requestId: "request-22222222-2222-4222-8222-222222222222",
    taskId: "task-b",
  });
  const taskB = protocol.run(taskBRequest);
  await new Promise((resolve) => setImmediate(resolve));

  const cancellation = protocol.cancelTask("task-a");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.cancellations, [REQUEST_A]);
  transport.reply({ requestId: REQUEST_A, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" });
  await cancellation;
  assert.equal((await taskAOutcome).code, "OPENBOT_LOCAL_CANCELLED");
  transport.reply({
    requestId: taskBRequest.requestId,
    ok: true,
    value: { exitCode: 0, stdout: "", stderr: "" },
  });
  assert.deepEqual(await taskB, { exitCode: 0, stdout: "", stderr: "" });
  assert.equal(transport.disposed, false);
  protocol.dispose();
});

test("task cancellation waits for the correlated child reply and permits a later task reuse", async () => {
  const { protocol, transport } = fixture();
  const first = protocol.run(request());
  const firstOutcome = first.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));

  let cancellationSettled = false;
  const cancellation = protocol.cancelTask("task-a").then(() => {
    cancellationSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellationSettled, false, "cancellation must wait for the child process-group acknowledgement");
  assert.deepEqual(transport.cancellations, [REQUEST_A]);

  transport.reply({ requestId: REQUEST_A, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" });
  await cancellation;
  assert.equal((await firstOutcome).code, "OPENBOT_LOCAL_CANCELLED");

  const nextRequest = request({
    requestId: "request-22222222-2222-4222-8222-222222222222",
  });
  const next = protocol.run(nextRequest);
  await new Promise((resolve) => setImmediate(resolve));
  transport.reply({
    requestId: nextRequest.requestId,
    ok: true,
    value: { exitCode: 0, stdout: "next", stderr: "" },
  });
  assert.deepEqual(await next, { exitCode: 0, stdout: "next", stderr: "" });
  protocol.dispose();
});

test("correlated shell replies preserve bounded hostile output for the metadata reducer only", async () => {
  const { protocol, transport } = fixture();
  const rawOutput = "/Users/person/project sk-proj-private -----BEGIN OPENSSH PRIVATE KEY-----";
  const pending = protocol.run(request());
  await new Promise((resolve) => setImmediate(resolve));
  transport.reply({
    requestId: REQUEST_A,
    ok: true,
    value: { exitCode: 0, stdout: rawOutput, stderr: "parser token tests passed" },
  });
  assert.deepEqual(await pending, {
    exitCode: 0,
    stdout: rawOutput,
    stderr: "parser token tests passed",
  });

  const generic = protocol.run(request({
    requestId: "request-22222222-2222-4222-8222-222222222222",
    capability: "filesystem.read",
    operation: "filesystem.read",
    arguments: { relativePath: "notes.txt" },
  }));
  const genericOutcome = generic.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  transport.reply({
    requestId: "request-22222222-2222-4222-8222-222222222222",
    ok: true,
    value: { content: "/Users/person/private" },
  });
  assert.equal((await genericOutcome).code, "OPENBOT_LOCAL_HELPER_PROTOCOL_FAILED");
});

test("protocol disposal waits for every active child cancellation acknowledgement", async () => {
  const { protocol, transport } = fixture();
  const secondRequest = request({
    requestId: "request-22222222-2222-4222-8222-222222222222",
    taskId: "task-b",
  });
  const first = protocol.run(request()).catch((error) => error);
  const second = protocol.run(secondRequest).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));

  let disposalSettled = false;
  const disposal = Promise.resolve(protocol.dispose()).then(() => {
    disposalSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposalSettled, false);
  assert.equal(transport.disposed, false);
  assert.deepEqual(transport.cancellations, [REQUEST_A, secondRequest.requestId]);

  transport.reply({ requestId: secondRequest.requestId, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposalSettled, false);
  assert.equal(transport.disposed, false);
  transport.reply({ requestId: REQUEST_A, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" });
  await disposal;
  assert.equal((await first).code, "OPENBOT_LOCAL_CANCELLED");
  assert.equal((await second).code, "OPENBOT_LOCAL_CANCELLED");
  assert.equal(transport.disposed, true);
});

test("hostile request and reply objects never execute accessors or expose diagnostics", async () => {
  const { protocol, transport } = fixture();
  await assert.rejects(protocol.run(new Proxy({}, {
    ownKeys() { throw new Error("secret-path-token"); },
  })), /plain data/i);

  const pending = protocol.run(request());
  const outcome = pending.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  transport.reply(new Proxy({}, {
    ownKeys() { throw new Error("secret-path-token"); },
  }));
  const failure = await outcome;
  assert.match(failure.message, /failed|invalid/i);
  assert.doesNotMatch(failure.message, /secret|path|token/i);
});
