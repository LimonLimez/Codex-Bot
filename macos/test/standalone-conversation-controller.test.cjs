"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const controllerPath = "../src/desktop/standalone-conversation-controller.cjs";
const { InferenceProviderRouter } = require("../src/desktop/inference-provider-router.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const UUIDS = Object.freeze([
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  "ffffffff-ffff-4fff-8fff-ffffffffffff",
]);

function selection(overrides = {}) {
  return Object.freeze({
    botId: BOT_A,
    generation: 7,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    ...overrides,
  });
}

function ids() {
  const values = [...UUIDS];
  return () => {
    const value = values.shift();
    if (!value) throw new Error("test exhausted deterministic IDs");
    return value;
  };
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, reject, resolve });
}

function memoryStore(seed = []) {
  const values = new Map(seed.map((entry) => [entry.conversationId, structuredClone(entry)]));
  const snapshot = (value) => Object.freeze(structuredClone(value));
  return {
    async list(botId) { return Object.freeze([...values.values()].filter((entry) => entry.botId === botId).map(snapshot)); },
    async read(botId, conversationId) {
      const value = values.get(conversationId);
      return value?.botId === botId ? snapshot(value) : null;
    },
    async create(value) {
      if (values.has(value.conversationId)) throw new Error("duplicate");
      values.set(value.conversationId, structuredClone(value));
      return snapshot(value);
    },
    async replace(value) {
      const current = values.get(value.conversationId);
      if (!current || current.botId !== value.botId) throw new Error("missing");
      values.set(value.conversationId, structuredClone(value));
      return snapshot(value);
    },
    async deleteBots({ botIds }) {
      const targets = new Set(botIds);
      const deletedConversationIds = [...values.values()]
        .filter((entry) => targets.has(entry.botId))
        .map((entry) => entry.conversationId);
      for (const conversationId of deletedConversationIds) values.delete(conversationId);
      return Object.freeze({ deletedConversationIds: Object.freeze(deletedConversationIds) });
    },
  };
}

function directResult(request, values = [
  { type: "text-delta", textDelta: "Hello " },
  { type: "text-delta", textDelta: "there." },
  { type: "finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
]) {
  return Object.freeze({
    fullStream: (async function* () {
      for (const value of values) {
        await request.assertCurrent?.();
        yield Object.freeze(value);
      }
    })(),
    usage: Promise.resolve({ promptTokens: 1, completionTokens: 2, totalTokens: 3 }),
    extendedUsage: Promise.resolve({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }),
    providerMetadata: Promise.resolve({ provider: "direct" }),
    invocationId: Promise.resolve(request.invocationId),
    response: Promise.resolve({}),
  });
}

function reviewedToolSession(identity, dispatch, dispose = async () => {}) {
  return Object.freeze({
    ...identity,
    definitions: Object.freeze([Object.freeze({
      type: "function",
      name: "browser_navigate",
      description: "Navigate the current OpenBot browser.",
      parameters: Object.freeze({ type: "object" }),
    })]),
    dispatch,
    dispose,
  });
}

async function terminalEvent(controller, send) {
  const terminal = new Promise((resolve) => controller.on("event", function listener(event) {
    if (["completed", "cancelled", "failed"].includes(event.type)) {
      controller.off("event", listener);
      resolve(event);
    }
  }));
  const accepted = await send();
  return { accepted, event: await terminal };
}

test("standalone conversations use the shared direct Codex router without starting CLIProxy", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let current = selection();
  const directCalls = [];
  let optionalCreates = 0;
  const router = new InferenceProviderRouter({
    async readSelection() { return current; },
    directTransport: Object.freeze({
      stream(request) {
        directCalls.push(request);
        return directResult(request);
      },
    }),
    async createOptionalTransport() {
      optionalCreates += 1;
      throw new Error("CLIProxy must remain lazy for direct Codex");
    },
  });
  const controller = new StandaloneConversationController({
    router,
    async readSelection() { return current; },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const changed = [];
  const events = [];
  controller.on("changed", (value) => changed.push(value));
  controller.on("event", (value) => events.push(value));

  const created = controller.create({ botId: BOT_A });
  assert.deepEqual(created, {
    botId: BOT_A,
    conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z",
    status: "idle",
    preview: "",
    messageCount: 0,
  });
  assert.equal(Object.isFrozen(created), true);
  assert.deepEqual(controller.list(BOT_A), [created]);

  const completed = once(controller, "event").then(async ([first]) => {
    if (first.type === "completed") return first;
    for (;;) {
      const [next] = await once(controller, "event");
      if (next.type === "completed") return next;
    }
  });
  const accepted = await controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Say hello.",
  });
  assert.deepEqual(accepted, {
    botId: BOT_A,
    conversationId: created.conversationId,
    invocationId: "invocation-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    generation: 7,
    status: "streaming",
  });
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal((await completed).type, "completed");

  assert.equal(optionalCreates, 0);
  assert.equal(directCalls.length, 1);
  assert.deepEqual(directCalls[0].selection, current);
  assert.deepEqual(directCalls[0].messages, [{ role: "user", content: "Say hello." }]);
  assert.deepEqual(directCalls[0].tools, []);
  assert.equal(directCalls[0].toolChoice, "none");
  const read = controller.read({ botId: BOT_A, conversationId: created.conversationId });
  assert.deepEqual(read.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Say hello." },
    { role: "assistant", text: "Hello there." },
  ]);
  assert.equal(read.status, "idle");
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Object.isFrozen(read.messages), true);
  assert.equal(events.filter((event) => event.type === "text-delta").length, 2);
  assert.equal(changed.at(-1).messageCount, 2);
  assert.doesNotMatch(JSON.stringify({ changed, events, read }), /CLIProxy|endpoint|token|Users|credential/);
  controller.dispose();
  router.dispose();
});

test("standalone cancellation aborts one exact stream and suppresses every late generation", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let release;
  let signal;
  const router = {
    async stream(request) {
      signal = request.signal;
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Before" };
          await new Promise((resolve) => { release = resolve; });
          yield { type: "text-delta", textDelta: " private /Users/person token" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        })(),
      };
    },
  };
  const controller = new StandaloneConversationController({
    router,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const events = [];
  controller.on("event", (value) => events.push(value));
  const created = controller.create({ botId: BOT_A });
  const accepted = await controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Wait." });
  while (!events.some((event) => event.type === "text-delta")) await new Promise((resolve) => setImmediate(resolve));
  const cancelled = await controller.cancel({
    botId: BOT_A,
    conversationId: created.conversationId,
    invocationId: accepted.invocationId,
  });
  assert.deepEqual(cancelled, { ...accepted, status: "cancelled" });
  assert.equal(signal.aborted, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["text-delta", "cancelled"]);
  assert.doesNotMatch(JSON.stringify(events), /private|Users|token/);
  const read = controller.read({ botId: BOT_A, conversationId: created.conversationId });
  assert.equal(read.status, "idle");
  assert.deepEqual(read.messages.map(({ role }) => role), ["user"]);
  await assert.rejects(controller.cancel({
    botId: BOT_B,
    conversationId: created.conversationId,
    invocationId: accepted.invocationId,
  }), /operation failed/i);
  controller.dispose();
});

test("selection changes fence streaming publication and disposal makes late work inert", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let current = selection();
  let release;
  const router = {
    async stream() {
      return {
        fullStream: (async function* () {
          yield { type: "text-delta", textDelta: "Current" };
          await new Promise((resolve) => { release = resolve; });
          yield { type: "text-delta", textDelta: "stale secret" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        })(),
      };
    },
  };
  const controller = new StandaloneConversationController({
    router,
    async readSelection() { return current; },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const events = [];
  controller.on("event", (value) => events.push(value));
  const created = controller.create({ botId: BOT_A });
  await controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Fence this." });
  while (!events.length) await new Promise((resolve) => setImmediate(resolve));
  current = selection({ generation: 8 });
  release();
  while (!events.some((event) => event.type === "failed")) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["text-delta", "failed"]);
  assert.equal(events.at(-1).code, "OPENBOT_CONVERSATION_STALE");
  assert.doesNotMatch(JSON.stringify(events), /stale secret/);

  const beforeDispose = controller.read({ botId: BOT_A, conversationId: created.conversationId });
  controller.dispose();
  controller.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => controller.list(BOT_A), /operation failed/i);
  assert.throws(() => controller.read({ botId: BOT_A, conversationId: created.conversationId }), /operation failed/i);
  assert.deepEqual(beforeDispose.messages.map(({ role }) => role), ["user"]);
});

test("standalone controller rejects hostile and cross-bot DTOs without invoking accessors", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let reads = 0;
  const controller = new StandaloneConversationController({
    router: { async stream() { throw new Error("must not run"); } },
    async readSelection() { reads += 1; return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  let accessorReads = 0;
  const accessor = Object.defineProperty({ botId: BOT_A, conversationId: created.conversationId }, "text", {
    enumerable: true,
    get() { accessorReads += 1; return "private"; },
  });
  for (const value of [
    new Proxy({}, { ownKeys() { throw new Error("private /Users/person token"); } }),
    accessor,
    { botId: BOT_B, conversationId: created.conversationId, text: "cross bot" },
    { botId: BOT_A, conversationId: created.conversationId, text: "ok", endpoint: "private" },
    { botId: BOT_A, conversationId: created.conversationId, text: "ok", attachments: [] },
  ]) {
    await assert.rejects(controller.send(value), (error) => {
      assert.equal(error.code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
      assert.doesNotMatch(String(error.stack), /private|Users|token|endpoint/);
      return true;
    });
  }
  assert.equal(accessorReads, 0);
  assert.equal(reads, 0);
  controller.dispose();
});

test("durable text transcripts survive a fresh controller without storing stream state", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const store = memoryStore();
  const direct = {
    async stream(request) {
      return directResult(request, [
        { type: "text-delta", textDelta: "Durable reply." },
        { type: "finish", finishReason: "stop", usage: {} },
      ]);
    },
  };
  const first = new StandaloneConversationController({
    router: direct,
    store,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await first.create({ botId: BOT_A });
  const terminal = new Promise((resolve) => first.on("event", (event) => {
    if (event.type === "completed") resolve(event);
  }));
  await first.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Remember this.",
    clientNonce: "native-nonce-123",
    inputDigest: "1".repeat(64),
  });
  await terminal;
  first.dispose();

  const second = new StandaloneConversationController({
    router: direct,
    store,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:01:00.000Z",
  });
  assert.deepEqual((await second.list(BOT_A)).map(({ conversationId }) => conversationId), [created.conversationId]);
  const restored = await second.read({ botId: BOT_A, conversationId: created.conversationId });
  assert.equal(restored.status, "idle");
  assert.deepEqual(restored.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Remember this." },
    { role: "assistant", text: "Durable reply." },
  ]);
  assert.equal(restored.messages[0].clientNonce, "native-nonce-123");
  assert.equal(restored.messages[0].inputDigest, "1".repeat(64));
  assert.equal(Object.hasOwn(restored.messages[1], "clientNonce"), false);
  second.dispose();
});

test("terminal tool cleanup failure does not suppress a durable assistant completion", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const store = memoryStore();
  const cleanup = deferred();
  let signalDisposeEntered;
  const disposeEntered = new Promise((resolve) => { signalDisposeEntered = resolve; });
  let disposeCalls = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        return directResult(request, [
          { type: "text-delta", textDelta: "Local reply." },
          { type: "finish", finishReason: "stop", usage: {} },
        ]);
      },
    },
    store,
    toolBridge: {
      async open(identity) {
        return reviewedToolSession(identity, async () => ({}), async () => {
          disposeCalls += 1;
          signalDisposeEntered();
          await cleanup.promise;
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  const events = [];
  const terminal = new Promise((resolve) => {
    const listener = (event) => {
      events.push(event);
      if (["completed", "cancelled", "failed"].includes(event.type)) {
        controller.off("event", listener);
        resolve(event);
      }
    };
    controller.on("event", listener);
  });
  const accepted = await controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Use the local desktop.",
  });

  assert.equal(accepted.status, "streaming");
  await disposeEntered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposeCalls, 1);
  assert.deepEqual(events.map(({ type }) => type), ["text-delta"]);
  const pending = await store.read(BOT_A, created.conversationId);
  assert.deepEqual(pending.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Use the local desktop." },
  ]);

  cleanup.reject(new Error("desktop cleanup unavailable"));
  const result = await terminal;
  assert.equal(result.type, "completed");
  assert.equal(disposeCalls, 1);
  const durable = await store.read(BOT_A, created.conversationId);
  assert.deepEqual(durable.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Use the local desktop." },
    { role: "assistant", text: "Local reply." },
  ]);
  const readable = await controller.read({ botId: BOT_A, conversationId: created.conversationId });
  assert.deepEqual(readable.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Use the local desktop." },
    { role: "assistant", text: "Local reply." },
  ]);
  controller.dispose();
});

test("cancellation fences a terminal durable replace after rejecting cleanup", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  let signalAssistantReplaceEntered;
  const assistantReplaceEntered = new Promise((resolve) => {
    signalAssistantReplaceEntered = resolve;
  });
  let releaseAssistantReplace;
  const assistantReplaceGate = new Promise((resolve) => {
    releaseAssistantReplace = resolve;
  });
  const store = {
    ...base,
    async replace(value) {
      if (value.messages.some(({ role }) => role === "assistant")) {
        signalAssistantReplaceEntered();
        await assistantReplaceGate;
      }
      return base.replace(value);
    },
  };
  let disposeCalls = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        return directResult(request, [
          { type: "text-delta", textDelta: "Cancelled reply." },
          { type: "finish", finishReason: "stop", usage: {} },
        ]);
      },
    },
    store,
    toolBridge: {
      async open(identity) {
        return reviewedToolSession(identity, async () => ({}), async () => {
          disposeCalls += 1;
          throw new Error("desktop cleanup unavailable");
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  const events = [];
  controller.on("event", (event) => events.push(event));
  const accepted = await controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Cancel the local desktop reply.",
  });
  await assistantReplaceEntered;

  const cancellation = controller.cancel({
    botId: BOT_A,
    conversationId: created.conversationId,
    invocationId: accepted.invocationId,
  });
  assert.equal(await Promise.race([
    cancellation.then(() => "settled", (error) => `rejected:${error.code}`),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");

  releaseAssistantReplace();
  const cancelled = await cancellation;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(disposeCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["text-delta", "cancelled"]);
  const durable = await store.read(BOT_A, created.conversationId);
  assert.deepEqual(durable.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Cancel the local desktop reply." },
  ]);
  const readable = await controller.read({ botId: BOT_A, conversationId: created.conversationId });
  assert.deepEqual(readable.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Cancel the local desktop reply." },
  ]);
  controller.dispose();
});

test("batch delete rejects hostile non-canonical bot sets before fencing or durable effects", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  let deleteCalls = 0;
  const controller = new StandaloneConversationController({
    router: { async stream(request) { return directResult(request); } },
    store: {
      ...base,
      async deleteBots(request) {
        deleteCalls += 1;
        return base.deleteBots(request);
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  const sparse = [];
  sparse.length = 1;
  let accessorReads = 0;
  const accessor = Object.defineProperty({}, "botIds", {
    enumerable: true,
    get() { accessorReads += 1; return [BOT_A]; },
  });
  for (const request of [
    { botIds: [] },
    { botIds: [BOT_A, BOT_A] },
    { botIds: sparse },
    { botIds: [BOT_A.toUpperCase()] },
    { botIds: [BOT_A], extra: true },
    accessor,
    new Proxy({}, { ownKeys() { throw new Error("private /Users/person token"); } }),
  ]) {
    assert.throws(() => controller.deleteBots(request), (error) => {
      assert.equal(error.code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
      assert.doesNotMatch(String(error.stack), /private|Users|token/);
      return true;
    });
  }
  assert.equal(accessorReads, 0);
  assert.equal(deleteCalls, 0);

  const terminal = await terminalEvent(controller, () => controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Invalid deletion did not fence this bot.",
  }));
  assert.equal(terminal.event.type, "completed");
  assert.equal(deleteCalls, 0);
  await controller.dispose();
});

test("batch delete fences before its first await and queues behind every target durable replace", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  const firstReplace = deferred();
  const firstReplaceEntered = deferred();
  const order = [];
  let replaceCount = 0;
  let deleteCalls = 0;
  const store = {
    ...base,
    async replace(value) {
      replaceCount += 1;
      const call = replaceCount;
      order.push(`replace-${call}-start`);
      if (call === 1) {
        firstReplaceEntered.resolve();
        await firstReplace.promise;
      }
      const result = await base.replace(value);
      order.push(`replace-${call}-end`);
      return result;
    },
    async deleteBots(request) {
      deleteCalls += 1;
      order.push("delete");
      return base.deleteBots(request);
    },
  };
  const controller = new StandaloneConversationController({
    router: { async stream() { throw new Error("fenced reservation must not stream"); } },
    store,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  const sending = controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Fence this pending durable replace.",
  });
  await firstReplaceEntered.promise;

  const deleting = controller.deleteBots({ botIds: [BOT_A] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteCalls, 0);
  firstReplace.resolve();

  await assert.rejects(sending, { code: "OPENBOT_CONVERSATION_STALE" });
  const deleted = await deleting;
  assert.deepEqual(deleted, { deletedConversationIds: [created.conversationId] });
  assert.equal(Object.isFrozen(deleted), true);
  assert.equal(Object.isFrozen(deleted.deletedConversationIds), true);
  assert.deepEqual(order, [
    "replace-1-start",
    "replace-1-end",
    "replace-2-start",
    "replace-2-end",
    "delete",
  ]);
  assert.equal(deleteCalls, 1);
  assert.throws(
    () => controller.read({ botId: BOT_A, conversationId: created.conversationId }),
    { code: "OPENBOT_CONVERSATION_STALE" },
  );
  await assert.rejects(controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Deleted bots stay fenced.",
  }), { code: "OPENBOT_CONVERSATION_STALE" });
  await controller.dispose();
});

test("batch delete suppresses a terminal result behind an already-started durable replace", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  const terminalReplaceEntered = deferred();
  const terminalReplaceGate = deferred();
  const terminalEvents = [];
  let replaceCalls = 0;
  let deleteCalls = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        return directResult(request, [
          { type: "text-delta", textDelta: "terminal text" },
          { type: "finish", finishReason: "stop", usage: {} },
        ]);
      },
    },
    store: {
      ...base,
      async replace(value) {
        replaceCalls += 1;
        if (replaceCalls === 2) {
          terminalReplaceEntered.resolve();
          await terminalReplaceGate.promise;
        }
        return base.replace(value);
      },
      async deleteBots(request) {
        deleteCalls += 1;
        return base.deleteBots(request);
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  controller.on("event", (event) => {
    if (new Set(["cancelled", "completed", "failed"]).has(event.type)) {
      terminalEvents.push(event.type);
    }
  });
  const created = await controller.create({ botId: BOT_A });
  await controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Delete while completion is becoming durable.",
  });
  await terminalReplaceEntered.promise;

  const deleting = controller.deleteBots({ botIds: [BOT_A] });
  assert.deepEqual(terminalEvents, []);
  terminalReplaceGate.resolve();
  assert.deepEqual(await deleting, { deletedConversationIds: [created.conversationId] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(terminalEvents, ["cancelled"]);
  assert.equal(deleteCalls, 1);
  await controller.dispose();
});

test("batch delete waits for initial-stream failure tool teardown before durable deletion", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  const disposeEntered = deferred();
  const disposeGate = deferred();
  const order = [];
  const terminalEvents = [];
  let disposeCalls = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream() { throw new Error("initial stream failed"); },
    },
    store: {
      ...base,
      async deleteBots(request) {
        order.push("delete");
        return base.deleteBots(request);
      },
    },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() {
            disposeCalls += 1;
            order.push("dispose-start");
            disposeEntered.resolve();
            await disposeGate.promise;
            order.push("dispose-end");
          },
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  controller.on("event", (event) => {
    if (new Set(["cancelled", "completed", "failed"]).has(event.type)) {
      terminalEvents.push(event.type);
    }
  });
  const created = await controller.create({ botId: BOT_A });
  const sending = controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Fail the initial stream while tools close.",
  });
  void sending.catch(() => {});
  await disposeEntered.promise;

  let deletionSettled = false;
  const deleting = controller.deleteBots({ botIds: [BOT_A] })
    .then((value) => { deletionSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeDisposal = deletionSettled;
  disposeGate.resolve();

  await assert.rejects(sending, { code: "OPENBOT_CONVERSATION_CANCELLED" });
  assert.deepEqual(await deleting, { deletedConversationIds: [created.conversationId] });
  assert.equal(settledBeforeDisposal, false);
  assert.equal(disposeCalls, 1);
  assert.deepEqual(terminalEvents, ["cancelled"]);
  assert.ok(order.indexOf("dispose-end") < order.indexOf("delete"));
  await controller.dispose();
});

test("batch delete awaits target stream, tool, and subagent cancellation while another bot continues", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  const streamGates = new Map([[BOT_A, deferred()], [BOT_B, deferred()]]);
  const toolDisposeGates = new Map([[BOT_A, deferred()], [BOT_B, deferred()]]);
  const signals = new Map();
  const disposeStarted = [];
  const disposed = [];
  const events = [];
  let deleteCalls = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        const botId = request.selection.botId;
        signals.set(botId, request.signal);
        return {
          fullStream: (async function* () {
            await streamGates.get(botId).promise;
            yield { type: "text-delta", textDelta: `late-${botId}` };
            yield { type: "finish", finishReason: "stop", usage: {} };
          })(),
        };
      },
    },
    store: {
      ...base,
      async deleteBots(request) {
        deleteCalls += 1;
        assert.deepEqual(disposed, [`subagent:${BOT_A}`, `tool:${BOT_A}`]);
        return base.deleteBots(request);
      },
    },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() {
            disposeStarted.push(`tool:${identity.botId}`);
            await toolDisposeGates.get(identity.botId).promise;
            disposed.push(`tool:${identity.botId}`);
          },
        });
      },
    },
    subagentRunner: {
      async open(identity) {
        return Object.freeze({
          botId: identity.botId,
          conversationId: identity.conversationId,
          taskId: identity.taskId,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() { disposed.push(`subagent:${identity.botId}`); },
        });
      },
      async dispose() {},
    },
    async readSelection(botId) { return selection({ botId }); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  controller.on("event", (event) => events.push(event));
  const a = await controller.create({ botId: BOT_A });
  const b = await controller.create({ botId: BOT_B });
  const acceptedA = await controller.send({ botId: BOT_A, conversationId: a.conversationId, text: "A" });
  const acceptedB = await controller.send({ botId: BOT_B, conversationId: b.conversationId, text: "B" });

  let deletionSettled = false;
  const deleting = controller.deleteBots({ botIds: [BOT_A] })
    .then((value) => { deletionSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.get(BOT_A).aborted, true);
  assert.equal(signals.get(BOT_B).aborted, false);
  assert.deepEqual(disposeStarted, [`tool:${BOT_A}`]);
  assert.deepEqual(disposed, [`subagent:${BOT_A}`]);
  assert.equal(deletionSettled, false);
  assert.equal(deleteCalls, 0);

  toolDisposeGates.get(BOT_A).resolve();
  assert.deepEqual(await deleting, { deletedConversationIds: [a.conversationId] });
  assert.equal(deleteCalls, 1);
  assert.equal((await controller.read({ botId: BOT_B, conversationId: b.conversationId })).status, "streaming");

  streamGates.get(BOT_A).resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter(({ botId }) => botId === BOT_A).map(({ type }) => type), ["cancelled"]);
  assert.doesNotMatch(JSON.stringify(events), /late-bot-11111111/);

  const cancelB = controller.cancel({
    botId: BOT_B,
    conversationId: b.conversationId,
    invocationId: acceptedB.invocationId,
  });
  toolDisposeGates.get(BOT_B).resolve();
  await cancelB;
  streamGates.get(BOT_B).resolve();
  assert.equal(signals.get(BOT_B).aborted, true);
  assert.equal(acceptedA.status, "streaming");
  await controller.dispose();
});

test("failed batch delete keeps a late opening session fenced and exact retry converges", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  const openEntered = deferred();
  const openGate = deferred();
  const order = [];
  let deleteCalls = 0;
  let openSignal = null;
  let streams = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream() {
        streams += 1;
        throw new Error("deleted opening reservation must not stream");
      },
    },
    store: {
      ...base,
      async deleteBots(request) {
        deleteCalls += 1;
        order.push(`delete-${deleteCalls}`);
        const result = await base.deleteBots(request);
        if (deleteCalls === 1) throw new Error("post-commit durability uncertain");
        return result;
      },
    },
    toolBridge: {
      async open(identity, signal) {
        openSignal = signal;
        openEntered.resolve();
        await openGate.promise;
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("unused"); },
          async dispose() { order.push("dispose-late-open"); },
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  const sending = controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Open is still pending.",
  });
  await openEntered.promise;

  const firstDelete = controller.deleteBots({ botIds: [BOT_A] });
  assert.equal(controller.deleteBots({ botIds: [BOT_A] }), firstDelete);
  assert.equal(openSignal.aborted, true);
  openGate.resolve();
  await assert.rejects(sending, { code: "OPENBOT_CONVERSATION_STALE" });
  await assert.rejects(firstDelete, { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  assert.deepEqual(order, ["dispose-late-open", "delete-1"]);
  assert.equal(streams, 0);
  await assert.rejects(controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Failure must not reopen the fence.",
  }), { code: "OPENBOT_CONVERSATION_STALE" });
  assert.throws(
    () => controller.deleteBots({ botIds: [BOT_A, BOT_B] }),
    { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" },
  );
  assert.equal(deleteCalls, 1);

  assert.deepEqual(await controller.deleteBots({ botIds: [BOT_A] }), {
    deletedConversationIds: [],
  });
  assert.equal(deleteCalls, 2);
  assert.throws(
    () => controller.read({ botId: BOT_A, conversationId: created.conversationId }),
    { code: "OPENBOT_CONVERSATION_STALE" },
  );
  assert.equal(order.filter((entry) => entry === "dispose-late-open").length, 1);
  await controller.dispose();
});

test("batch delete rejects pre-delete durable list and read results that arrive after purge", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  const listEntered = deferred();
  const readEntered = deferred();
  const releaseReads = deferred();
  let holdReads = false;
  const store = {
    ...base,
    async list(botId) {
      const snapshot = await base.list(botId);
      if (holdReads) {
        listEntered.resolve();
        await releaseReads.promise;
      }
      return snapshot;
    },
    async read(botId, conversationId) {
      const snapshot = await base.read(botId, conversationId);
      if (holdReads) {
        readEntered.resolve();
        await releaseReads.promise;
      }
      return snapshot;
    },
  };
  const controller = new StandaloneConversationController({
    router: { async stream(request) { return directResult(request); } },
    store,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  holdReads = true;
  const listing = controller.list(BOT_A).catch((error) => error);
  const reading = controller.read({
    botId: BOT_A,
    conversationId: created.conversationId,
  }).catch((error) => error);
  await Promise.all([listEntered.promise, readEntered.promise]);

  assert.deepEqual(await controller.deleteBots({ botIds: [BOT_A] }), {
    deletedConversationIds: [created.conversationId],
  });
  releaseReads.resolve();
  assert.equal((await listing).code, "OPENBOT_CONVERSATION_STALE");
  assert.equal((await reading).code, "OPENBOT_CONVERSATION_STALE");
  holdReads = false;
  assert.equal(await base.read(BOT_A, created.conversationId), null);
  assert.throws(
    () => controller.read({ botId: BOT_A, conversationId: created.conversationId }),
    { code: "OPENBOT_CONVERSATION_STALE" },
  );
  await controller.dispose();
});

test("batch delete drains a pre-delete durable create and suppresses its late cache and event", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  const createEntered = deferred();
  const releaseCreate = deferred();
  const changed = [];
  const store = {
    ...base,
    async create(value) {
      createEntered.resolve();
      await releaseCreate.promise;
      return base.create(value);
    },
  };
  const controller = new StandaloneConversationController({
    router: { async stream(request) { return directResult(request); } },
    store,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  controller.on("changed", (value) => changed.push(value));
  const creating = controller.create({ botId: BOT_A });
  await createEntered.promise;

  let deletionSettled = false;
  const deleting = controller.deleteBots({ botIds: [BOT_A] })
    .then((value) => { deletionSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeCreate = deletionSettled;
  releaseCreate.resolve();

  await assert.rejects(creating, { code: "OPENBOT_CONVERSATION_STALE" });
  const deleted = await deleting;
  assert.equal(settledBeforeCreate, false);
  assert.equal(deleted.deletedConversationIds.length, 1);
  assert.deepEqual(changed, []);
  assert.deepEqual(await base.list(BOT_A), []);
  assert.throws(
    () => controller.list(BOT_A),
    { code: "OPENBOT_CONVERSATION_STALE" },
  );
  await controller.dispose();
});

test("reviewed tools execute one bounded loop and the exact catalog survives every inference round", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const store = memoryStore();
  const definitions = Object.freeze([Object.freeze({
    type: "function",
    function: Object.freeze({
      name: "browser_navigate",
      description: "Navigate the current OpenBot browser.",
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze({ url: Object.freeze({ type: "string" }) }),
        required: Object.freeze(["url"]),
        additionalProperties: false,
      }),
    }),
  })]);
  const requests = [];
  const dispatches = [];
  const router = {
    async stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        return directResult(request, [
          { type: "tool-call-streaming-start", toolCallId: "call-1", toolName: "browser_navigate" },
          { type: "tool-call", toolCallId: "call-1", toolName: "browser_navigate", args: { url: "https://www.youtube.com/" } },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      }
      return directResult(request, [
        { type: "text-delta", textDelta: "YouTube is open." },
        { type: "finish", finishReason: "stop", usage: {} },
      ]);
    },
  };
  const toolBridge = {
    async open(value) {
      assert.deepEqual(value, {
        botId: BOT_A,
        conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        taskId: "standalone-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      });
      return Object.freeze({
        botId: BOT_A,
        conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        taskId: value.taskId,
        definitions,
        async dispatch(call) {
          dispatches.push(call);
          return Object.freeze({ state: "ready" });
        },
      });
    },
  };
  const controller = new StandaloneConversationController({
    router,
    store,
    toolBridge,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  const terminal = new Promise((resolve) => controller.on("event", (event) => {
    if (event.type === "completed") resolve(event);
  }));
  await controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Open YouTube." });
  await terminal;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools, definitions);
  assert.deepEqual(requests[1].tools, definitions);
  assert.equal(requests[0].toolChoice, "auto");
  assert.equal(requests[1].toolChoice, "auto");
  assert.equal(requests[1].messages.at(-2).role, "assistant");
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.deepEqual(dispatches, [{
    botId: BOT_A,
    conversationId: created.conversationId,
    taskId: "standalone-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    invocationId: "invocation-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    toolCallId: "call-1",
    toolName: "browser_navigate",
    args: { url: "https://www.youtube.com/" },
  }]);
  assert.equal((await controller.read({ botId: BOT_A, conversationId: created.conversationId })).messages.at(-1).text, "YouTube is open.");
  controller.dispose();
});

test("main tool sessions use a fresh invocation-scoped task identity after normal completion", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const opened = [];
  const disposed = [];
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        return directResult(request, [{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    },
    toolBridge: {
      async open(identity) {
        opened.push(identity);
        return reviewedToolSession(identity, async () => ({}), async () => { disposed.push(identity.taskId); });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  await terminalEvent(controller, () => controller.send({
    botId: BOT_A, conversationId: created.conversationId, text: "First.",
  }));
  await terminalEvent(controller, () => controller.send({
    botId: BOT_A, conversationId: created.conversationId, text: "Second.",
  }));

  assert.deepEqual(opened.map(({ taskId }) => taskId), [
    "standalone-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "standalone-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  ]);
  assert.deepEqual(disposed, opened.map(({ taskId }) => taskId));
  assert.notEqual(opened[0].taskId, opened[1].taskId);
  await controller.dispose();
});

test("simultaneous same-bot conversations cancel only their exact awaited tool task", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const opened = [];
  const disposeGates = new Map();
  const disposed = [];
  const controller = new StandaloneConversationController({
    router: {
      async stream() {
        return { fullStream: (async function* () { await new Promise(() => {}); })() };
      },
    },
    toolBridge: {
      async open(identity) {
        opened.push(identity);
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        disposeGates.set(identity.taskId, release);
        return reviewedToolSession(identity, async () => ({}), async () => {
          await gate;
          disposed.push(identity.taskId);
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const first = controller.create({ botId: BOT_A });
  const second = controller.create({ botId: BOT_A });
  const acceptedFirst = await controller.send({ botId: BOT_A, conversationId: first.conversationId, text: "First." });
  const acceptedSecond = await controller.send({ botId: BOT_A, conversationId: second.conversationId, text: "Second." });
  assert.deepEqual(opened.map(({ taskId }) => taskId), [
    "standalone-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "standalone-ffffffff-ffff-4fff-8fff-ffffffffffff",
  ]);

  const events = [];
  controller.on("event", (event) => events.push(event));
  let firstSettled = false;
  const firstCancel = controller.cancel({
    botId: BOT_A, conversationId: first.conversationId, invocationId: acceptedFirst.invocationId,
  }).then((value) => { firstSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false);
  assert.deepEqual(disposed, []);
  assert.deepEqual(events, []);
  disposeGates.get(opened[0].taskId)();
  assert.equal((await firstCancel).status, "cancelled");
  assert.deepEqual(disposed, [opened[0].taskId]);
  assert.equal(events.filter(({ conversationId }) => conversationId === second.conversationId).length, 0);

  const secondCancel = controller.cancel({
    botId: BOT_A, conversationId: second.conversationId, invocationId: acceptedSecond.invocationId,
  });
  disposeGates.get(opened[1].taskId)();
  await secondCancel;
  assert.deepEqual(disposed, opened.map(({ taskId }) => taskId));
  await controller.dispose();
});

test("model selection mutation cancels and awaits every same-bot task before publish while another bot keeps running", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const disposeGates = new Map();
  const disposeStarted = [];
  const disposed = [];
  const signals = new Map();
  const events = [];
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        signals.set(request.selection.botId, request.signal);
        return { fullStream: (async function* () { await new Promise(() => {}); })() };
      },
    },
    toolBridge: {
      async open(identity) {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        disposeGates.set(identity.taskId, release);
        return reviewedToolSession(identity, async () => ({}), async () => {
          disposeStarted.push(identity.taskId);
          await gate;
          disposed.push(identity.taskId);
        });
      },
    },
    async readSelection(botId) { return selection({ botId }); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  controller.on("event", (event) => events.push(event));
  const a = controller.create({ botId: BOT_A });
  const b = controller.create({ botId: BOT_B });
  const acceptedA = await controller.send({ botId: BOT_A, conversationId: a.conversationId, text: "A" });
  const acceptedB = await controller.send({ botId: BOT_B, conversationId: b.conversationId, text: "B" });
  const order = [];
  let mutationSettled = false;
  const mutation = controller.withModelSelectionMutation(BOT_A, async () => {
    order.push("publish-generation");
    return "selected";
  }).then((value) => { mutationSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(signals.get(BOT_A).aborted, true);
  assert.equal(signals.get(BOT_B).aborted, false);
  assert.deepEqual(disposeStarted, [acceptedA.invocationId.replace("invocation-", "standalone-")]);
  assert.deepEqual(disposed, []);
  assert.deepEqual(order, []);
  assert.equal(mutationSettled, false);

  disposeGates.get(acceptedA.invocationId.replace("invocation-", "standalone-"))();
  assert.equal(await mutation, "selected");
  assert.deepEqual(order, ["publish-generation"]);
  assert.deepEqual(disposed, [acceptedA.invocationId.replace("invocation-", "standalone-")]);
  assert.deepEqual(events.filter(({ type }) => type === "cancelled").map(({ botId }) => botId), [BOT_A]);
  assert.equal(controller.read({ botId: BOT_A, conversationId: a.conversationId }).status, "idle");
  assert.equal(controller.read({ botId: BOT_B, conversationId: b.conversationId }).status, "streaming");

  const cancelB = controller.cancel({
    botId: BOT_B, conversationId: b.conversationId, invocationId: acceptedB.invocationId,
  });
  disposeGates.get(acceptedB.invocationId.replace("invocation-", "standalone-"))();
  await cancelB;
  await controller.dispose();
});

test("model selection mutation fences an opening same-bot reservation until its exact session is disposed", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let current = selection();
  let releaseOpen;
  let enteredOpen;
  const opened = new Promise((resolve) => { enteredOpen = resolve; });
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const order = [];
  const controller = new StandaloneConversationController({
    router: { async stream() { throw new Error("stale reservation must not stream"); } },
    toolBridge: {
      async open(identity) {
        enteredOpen();
        await openGate;
        return reviewedToolSession(identity, async () => ({}), async () => { order.push("dispose-session"); });
      },
    },
    async readSelection() { return current; },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  const sending = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Old model" });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_STALE" });
  await opened;
  const mutation = controller.withModelSelectionMutation(BOT_A, async () => {
    order.push("publish-generation");
    current = selection({ generation: 8 });
    return current;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  releaseOpen();
  await rejectedSending;
  assert.equal((await mutation).generation, 8);
  assert.deepEqual(order, ["dispose-session", "publish-generation"]);
  assert.equal(controller.read({ botId: BOT_A, conversationId: created.conversationId }).status, "idle");
  await controller.dispose();
});

test("a permanently hung main tool open cannot hold model mutation past the bounded cleanup acknowledgement", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const cleanupClock = manualCleanupClock();
  let enterOpen;
  let openSignal = null;
  let streams = 0;
  const openEntered = new Promise((resolve) => { enterOpen = resolve; });
  const controller = new StandaloneConversationController({
    router: {
      async stream() {
        streams += 1;
        return directResult({}, [{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    },
    toolBridge: {
      async open(_identity, signal) {
        openSignal = signal;
        enterOpen();
        return new Promise(() => {});
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
    ...cleanupClock.options,
  });
  const created = controller.create({ botId: BOT_A });
  const sending = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Hung open" });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_STALE" });
  await openEntered;
  const mutation = controller.withModelSelectionMutation(BOT_A, async () => selection({ generation: 8 }));
  assert.equal(await Promise.race([
    mutation.then(() => "settled"),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");
  assert.equal(openSignal instanceof AbortSignal, true);
  assert.equal(openSignal.aborted, true);
  assert.equal(cleanupClock.delay(), 250);
  assert.equal(cleanupClock.pending(), true);
  cleanupClock.fire();
  assert.equal((await mutation).generation, 8);
  await rejectedSending;
  assert.equal(streams, 0);
  await controller.dispose();
});

test("controller shutdown cancels a permanently hung main tool open and awaits the bounded acknowledgement", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const cleanupClock = manualCleanupClock();
  let enterOpen;
  let openSignal = null;
  let streams = 0;
  const openEntered = new Promise((resolve) => { enterOpen = resolve; });
  const controller = new StandaloneConversationController({
    router: {
      async stream() {
        streams += 1;
        return directResult({}, [{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    },
    toolBridge: {
      async open(_identity, signal) {
        openSignal = signal;
        enterOpen();
        return new Promise(() => {});
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
    ...cleanupClock.options,
  });
  const created = controller.create({ botId: BOT_A });
  const sending = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Shutdown" });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_CANCELLED" });
  await openEntered;
  const disposal = controller.dispose();
  assert.equal(await Promise.race([
    disposal.then(() => "settled"),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");
  assert.equal(openSignal instanceof AbortSignal, true);
  assert.equal(openSignal.aborted, true);
  assert.equal(cleanupClock.delay(), 250);
  assert.equal(cleanupClock.pending(), true);
  cleanupClock.fire();
  await disposal;
  await rejectedSending;
  assert.equal(streams, 0);
});

test("a cooperative late main tool session is disposed exactly once before mutation acknowledgement", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const cleanupClock = manualCleanupClock();
  let enterOpen;
  let releaseOpen;
  let enterDisposal;
  let releaseDisposal;
  let openSignal = null;
  let disposals = 0;
  let dispatches = 0;
  let streams = 0;
  const openEntered = new Promise((resolve) => { enterOpen = resolve; });
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const disposalEntered = new Promise((resolve) => { enterDisposal = resolve; });
  const disposalGate = new Promise((resolve) => { releaseDisposal = resolve; });
  const controller = new StandaloneConversationController({
    router: {
      async stream() {
        streams += 1;
        return directResult({}, [{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    },
    toolBridge: {
      async open(identity, signal) {
        openSignal = signal;
        enterOpen();
        await openGate;
        return reviewedToolSession(identity, async () => { dispatches += 1; return {}; }, async () => {
          disposals += 1;
          enterDisposal();
          await disposalGate;
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
    ...cleanupClock.options,
  });
  const created = controller.create({ botId: BOT_A });
  const sending = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Late session" });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_STALE" });
  await openEntered;
  let mutationSettled = false;
  const mutation = controller.withModelSelectionMutation(
    BOT_A,
    async () => selection({ generation: 8 }),
  ).then((value) => { mutationSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openSignal instanceof AbortSignal, true);
  assert.equal(openSignal.aborted, true);
  releaseOpen();
  await disposalEntered;
  assert.equal(disposals, 1);
  assert.equal(mutationSettled, false);
  assert.equal(cleanupClock.pending(), false);
  releaseDisposal();
  assert.equal((await mutation).generation, 8);
  await rejectedSending;
  assert.equal(disposals, 1);
  assert.equal(dispatches, 0);
  assert.equal(streams, 0);
  await controller.dispose();
});

test("a partial merged open disposes every adopted source while a later source stays noncooperative", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const cleanupClock = manualCleanupClock();
  let enterRunnerOpen;
  let releaseRunnerOpen;
  let enterToolDisposal;
  let releaseToolDisposal;
  let enterRunnerDisposal;
  const runnerOpenEntered = new Promise((resolve) => { enterRunnerOpen = resolve; });
  const runnerOpenGate = new Promise((resolve) => { releaseRunnerOpen = resolve; });
  const toolDisposalEntered = new Promise((resolve) => { enterToolDisposal = resolve; });
  const toolDisposalGate = new Promise((resolve) => { releaseToolDisposal = resolve; });
  const runnerDisposalEntered = new Promise((resolve) => { enterRunnerDisposal = resolve; });
  let toolDisposals = 0;
  let runnerDisposals = 0;
  let streams = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream() {
        streams += 1;
        return directResult({}, [{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    },
    toolBridge: {
      async open(identity) {
        return reviewedToolSession(identity, async () => ({}), async () => {
          toolDisposals += 1;
          enterToolDisposal();
          await toolDisposalGate;
        });
      },
    },
    subagentRunner: {
      async open(identity) {
        enterRunnerOpen();
        await runnerOpenGate;
        return Object.freeze({
          botId: identity.botId,
          conversationId: identity.conversationId,
          taskId: identity.taskId,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("cancelled source must not dispatch"); },
          async dispose() {
            runnerDisposals += 1;
            enterRunnerDisposal();
          },
        });
      },
      async dispose() {},
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
    ...cleanupClock.options,
  });
  const created = controller.create({ botId: BOT_A });
  const sending = controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Cancel partial merged open",
  });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_STALE" });
  await runnerOpenEntered;
  let mutationSettled = false;
  const mutation = controller.withModelSelectionMutation(
    BOT_A,
    async () => selection({ generation: 8 }),
  ).then((value) => { mutationSettled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toolDisposals, 1);
  assert.equal(cleanupClock.delay(), 250);
  assert.equal(cleanupClock.pending(), true);
  cleanupClock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutationSettled, false);
  releaseToolDisposal();
  await toolDisposalEntered;
  assert.equal((await mutation).generation, 8);
  await rejectedSending;
  assert.equal(toolDisposals, 1);
  assert.equal(runnerDisposals, 0);
  assert.equal(streams, 0);

  releaseRunnerOpen();
  await runnerDisposalEntered;
  assert.equal(toolDisposals, 1);
  assert.equal(runnerDisposals, 1);
  assert.equal(streams, 0);
  await controller.dispose();
  assert.equal(toolDisposals, 1);
  assert.equal(runnerDisposals, 1);
});

test("model selection mutation does not wait for a cancelled initial stream and emits no late failed terminal", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let current = selection();
  let enterStream;
  let releaseStream;
  const streamEntered = new Promise((resolve) => { enterStream = resolve; });
  const streamGate = new Promise((resolve) => { releaseStream = resolve; });
  const order = [];
  const events = [];
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        enterStream();
        await streamGate;
        return directResult(request, [{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    },
    toolBridge: {
      async open(identity) {
        return reviewedToolSession(identity, async () => ({}), async () => { order.push("dispose-session"); });
      },
    },
    async readSelection() { return current; },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  controller.on("event", (event) => events.push(event));
  const created = controller.create({ botId: BOT_A });
  const sending = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Old stream" });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_CANCELLED" });
  await streamEntered;
  const mutation = controller.withModelSelectionMutation(BOT_A, async () => {
    order.push("publish-generation");
    current = selection({ generation: 8 });
    return current;
  });
  const mutated = await Promise.race([
    mutation,
    new Promise((_, reject) => setTimeout(() => reject(new Error("mutation waited for cancelled initial stream")), 100)),
  ]);
  assert.equal(mutated.generation, 8);
  assert.deepEqual(order, ["dispose-session", "publish-generation"]);
  assert.deepEqual(events.map(({ type }) => type), ["cancelled"]);

  releaseStream();
  await rejectedSending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["cancelled"]);
  await controller.dispose();
});

test("controller disposal waits for every simultaneous tool session exactly once", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const gates = [];
  const disposals = [];
  const controller = new StandaloneConversationController({
    router: {
      async stream() { return { fullStream: (async function* () { await new Promise(() => {}); })() }; },
    },
    toolBridge: {
      async open(identity) {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        gates.push(release);
        return reviewedToolSession(identity, async () => ({}), async () => {
          await gate;
          disposals.push(identity.taskId);
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const first = controller.create({ botId: BOT_A });
  const second = controller.create({ botId: BOT_A });
  await controller.send({ botId: BOT_A, conversationId: first.conversationId, text: "First." });
  await controller.send({ botId: BOT_A, conversationId: second.conversationId, text: "Second." });

  let settled = false;
  const disposal = controller.dispose().then(() => { settled = true; });
  assert.equal(controller.dispose(), controller.dispose());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  gates[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(disposals.length, 1);
  gates[0]();
  await disposal;
  assert.deepEqual(disposals.sort(), [
    "standalone-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "standalone-ffffffff-ffff-4fff-8fff-ffffffffffff",
  ]);
});

test("a tool session owned by another bot fails before dispatch or publication", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let dispatches = 0;
  let disposals = 0;
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        return directResult(request, [
          { type: "tool-call-streaming-start", toolCallId: "call-1", toolName: "browser_navigate" },
          { type: "tool-call", toolCallId: "call-1", toolName: "browser_navigate", args: { url: "https://www.youtube.com/" } },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      },
    },
    store: memoryStore(),
    toolBridge: {
      async open(value) {
        return Object.freeze({
          ...value,
          botId: BOT_B,
          definitions: Object.freeze([Object.freeze({
            type: "function",
            name: "browser_navigate",
            description: "Navigate the current OpenBot browser.",
            parameters: Object.freeze({ type: "object" }),
          })]),
          async dispatch() { dispatches += 1; return { state: "ready" }; },
          async dispose() { disposals += 1; },
        });
      },
    },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  await assert.rejects(controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Open YouTube.",
  }), { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  assert.equal(dispatches, 0);
  assert.equal(disposals, 1);
  assert.deepEqual((await controller.read({ botId: BOT_A, conversationId: created.conversationId })).messages, [{
    messageId: "message-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    role: "user",
    text: "Open YouTube.",
    createdAt: "2026-08-16T12:00:00.000Z",
  }]);
  controller.dispose();
});

test("a conversation is reserved synchronously across durable senders and every failed reservation rolls back", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const base = memoryStore();
  let reads = 0;
  const releaseReads = [];
  let rejectFirstRead = true;
  const store = {
    ...base,
    async read(...args) {
      reads += 1;
      await new Promise((resolve) => { releaseReads.push(resolve); });
      if (rejectFirstRead) {
        rejectFirstRead = false;
        throw new Error("private read failure");
      }
      return base.read(...args);
    },
  };
  const controller = new StandaloneConversationController({
    router: { async stream(request) { return directResult(request); } },
    store,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await controller.create({ botId: BOT_A });
  const first = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "First." });
  const second = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Second." });
  const simultaneous = Promise.allSettled([first, second]);
  await new Promise((resolve) => setImmediate(resolve));
  const simultaneousReads = reads;
  for (const release of releaseReads.splice(0)) release();
  const [firstResult, secondResult] = await simultaneous;
  assert.equal(simultaneousReads, 1);
  assert.equal(firstResult.status, "rejected");
  assert.equal(secondResult.status, "rejected");

  const retry = controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Retry." });
  await new Promise((resolve) => setImmediate(resolve));
  for (const release of releaseReads.splice(0)) release();
  const accepted = await retry;
  assert.equal(accepted.status, "streaming");
  controller.dispose();
});

test("not-now Computer availability exposes no tools and still permits direct Chat", async () => {
  const { createStandaloneComputerToolBridge, StandaloneConversationController } = require(controllerPath);
  const requests = [];
  const toolBridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve() {
        const error = new Error("Computer is not configured.");
        error.code = "OPENBOT_COMPUTER_NOT_CONFIGURED";
        throw error;
      },
      async run() { throw new Error("must not run"); },
      async disposeTask() { throw new Error("must not dispose unopened target"); },
    },
  });
  const controller = new StandaloneConversationController({
    router: { async stream(request) { requests.push(request); return directResult(request); } },
    toolBridge,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  const terminal = terminalEvent(controller, () => controller.send({
    botId: BOT_A, conversationId: created.conversationId, text: "Answer directly.",
  }));
  assert.equal((await terminal).event.type, "completed");
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].toolChoice, "none");
  controller.dispose();
});

test("unavailable Cursor Computer exposes no tools and still permits direct Chat", async () => {
  const { createStandaloneComputerToolBridge, StandaloneConversationController } = require(controllerPath);
  const requests = [];
  const toolBridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve() {
        const error = new Error("Cursor Remote Computer is unavailable.");
        error.code = "OPENBOT_CURSOR_COMPUTER_UNAVAILABLE";
        throw error;
      },
      async run() { throw new Error("must not run"); },
      async disposeTask() { throw new Error("must not dispose unopened target"); },
    },
  });
  const controller = new StandaloneConversationController({
    router: { async stream(request) { requests.push(request); return directResult(request); } },
    toolBridge,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  const terminal = terminalEvent(controller, () => controller.send({
    botId: BOT_A, conversationId: created.conversationId, text: "Answer directly.",
  }));
  assert.equal((await terminal).event.type, "completed");
  assert.deepEqual(requests[0].tools, []);
  assert.equal(requests[0].toolChoice, "none");
  controller.dispose();
});

test("opened tool sessions dispose exactly once on initial stream failure and a cancelled hung dispatch", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let initialDisposals = 0;
  const initial = new StandaloneConversationController({
    router: { async stream() { throw new Error("initial failure"); } },
    toolBridge: { async open(identity) {
      return reviewedToolSession(identity, async () => ({}), async () => { initialDisposals += 1; });
    } },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const initialCreated = initial.create({ botId: BOT_A });
  await assert.rejects(initial.send({
    botId: BOT_A, conversationId: initialCreated.conversationId, text: "Fail now.",
  }), { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  await initial.dispose();
  assert.equal(initialDisposals, 1);

  let entered = false;
  let hungDisposals = 0;
  let hungStreams = 0;
  const hung = new StandaloneConversationController({
    router: { async stream(request) {
      hungStreams += 1;
      if (hungStreams > 1) return directResult(request);
      return directResult(request, [
        { type: "tool-call-streaming-start", toolCallId: "call-hung", toolName: "browser_navigate" },
        { type: "tool-call", toolCallId: "call-hung", toolName: "browser_navigate", args: { url: "https://example.com/" } },
        { type: "finish", finishReason: "tool-calls", usage: {} },
      ]);
    } },
    toolBridge: { async open(identity) {
      return reviewedToolSession(identity, async () => {
        entered = true;
        return new Promise(() => {});
      }, async () => { hungDisposals += 1; });
    } },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const hungCreated = hung.create({ botId: BOT_A });
  const accepted = await hung.send({ botId: BOT_A, conversationId: hungCreated.conversationId, text: "Hang." });
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  await hung.cancel({ botId: BOT_A, conversationId: hungCreated.conversationId, invocationId: accepted.invocationId });
  const retried = await hung.send({ botId: BOT_A, conversationId: hungCreated.conversationId, text: "Retry." });
  assert.equal(retried.status, "streaming");
  const hungDisposal = hung.dispose();
  assert.equal(hung.dispose(), hungDisposal);
  await hungDisposal;
  assert.equal(hungDisposals, 2);
});

test("tool argument deltas have one aggregate UTF-8 byte bound per call and round", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  let dispatches = 0;
  const chunks = Array.from({ length: 1001 }, () => ({
    type: "tool-call-delta", toolCallId: "call-many", toolName: "browser_navigate", argsTextDelta: "界".repeat(334),
  }));
  const controller = new StandaloneConversationController({
    router: { async stream(request) { return directResult(request, [
      { type: "tool-call-streaming-start", toolCallId: "call-many", toolName: "browser_navigate" },
      ...chunks,
      { type: "tool-call", toolCallId: "call-many", toolName: "browser_navigate", args: { url: "https://example.com/" } },
      { type: "finish", finishReason: "tool-calls", usage: {} },
    ]); } },
    toolBridge: { async open(identity) { return reviewedToolSession(identity, async () => { dispatches += 1; return {}; }); } },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  const terminal = await terminalEvent(controller, () => controller.send({ botId: BOT_A, conversationId: created.conversationId, text: "Oversize." }));
  assert.equal(terminal.event.type, "failed");
  assert.equal(dispatches, 0);
  controller.dispose();
});

test("conversation previews share one valid UTF-8 prefix bounded to 160 bytes", async () => {
  const { StandaloneConversationController } = require(controllerPath);
  const changed = [];
  const controller = new StandaloneConversationController({
    router: { async stream() { return { fullStream: (async function* () { await new Promise(() => {}); })() }; } },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  controller.on("changed", (value) => changed.push(value));
  const created = controller.create({ botId: BOT_A });
  const text = `${"😀".repeat(50)}${"界".repeat(20)}`;
  const accepted = await controller.send({ botId: BOT_A, conversationId: created.conversationId, text });
  const listed = controller.list(BOT_A)[0];
  assert.equal(Buffer.byteLength(listed.preview, "utf8") <= 160, true);
  assert.equal(listed.preview.includes("�"), false);
  assert.equal(text.startsWith(listed.preview), true);
  assert.equal(changed.at(-1).preview, listed.preview);
  controller.cancel({ botId: BOT_A, conversationId: created.conversationId, invocationId: accepted.invocationId });
  controller.dispose();
});

test("computer tool bridge maps only reviewed browser calls to one exact target task", async () => {
  const { createStandaloneComputerToolBridge } = require(controllerPath);
  const resolved = [];
  const runs = [];
  const disposed = [];
  const bridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve(value) {
        resolved.push(value);
        return Object.freeze({
          mode: "local",
          botId: BOT_A,
          targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          targetGeneration: 4,
          workspaceId: `workspace-${"a".repeat(64)}`,
          tools: Object.freeze(["browser.navigate", "browser.capture"]),
        });
      },
      async run(value) { runs.push(value); return Object.freeze({ state: "ready" }); },
      async disposeTask(value) { disposed.push(value); },
    },
  });
  const identity = { botId: BOT_A, conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", taskId: "parent" };
  const session = await bridge.open(identity);
  assert.deepEqual(resolved, [identity]);
  assert.deepEqual(session.definitions.map(({ name }) => name), ["browser_navigate", "browser_capture"]);
  assert.equal(session.botId, BOT_A);
  assert.equal(session.conversationId, identity.conversationId);
  assert.equal(session.taskId, "parent");
  await session.dispatch({
    ...identity,
    invocationId: "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolCallId: "call-1",
    toolName: "browser_navigate",
    args: { url: "https://www.youtube.com/" },
  });
  assert.deepEqual(runs, [{
    mode: "local",
    botId: BOT_A,
    conversationId: identity.conversationId,
    taskId: "parent",
    targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetGeneration: 4,
    workspaceId: `workspace-${"a".repeat(64)}`,
    capability: "browser.navigate",
    operation: "browser.navigate",
    arguments: { url: "https://www.youtube.com/" },
    resourceId: "browser",
    resourceLabel: "OpenBot Browser",
    reason: "Open a page in this bot's browser",
  }]);
  await assert.rejects(session.dispatch({
    ...identity,
    botId: BOT_B,
    invocationId: "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolCallId: "call-2",
    toolName: "browser_capture",
    args: {},
  }), /failed/i);
  assert.equal(runs.length, 1);
  await session.dispose();
  await session.dispose();
  assert.deepEqual(disposed, [{ botId: BOT_A, taskId: "parent" }]);
});

test("computer tool bridge advertises reviewed shell only for a capable target and routes one exact task-workspace DTO", async () => {
  const { createStandaloneComputerToolBridge } = require(controllerPath);
  const identity = {
    botId: BOT_A,
    conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    taskId: "parent",
  };
  const target = Object.freeze({
    mode: "local",
    botId: BOT_A,
    targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetGeneration: 4,
    workspaceId: `workspace-${"a".repeat(64)}`,
  });
  let targetTools = Object.freeze(["browser.navigate", "browser.capture"]);
  const runs = [];
  const router = {
    async resolve() { return Object.freeze({ ...target, tools: targetTools }); },
    async run(value) {
      runs.push(value);
      return Object.freeze({ exitCode: 0, stdout: "openbot-ok", stderr: "" });
    },
    async disposeTask() {},
  };
  const withoutShell = await createStandaloneComputerToolBridge({ computerTargetRouter: router }).open(identity);
  assert.deepEqual(withoutShell.definitions.map(({ name }) => name), ["browser_navigate", "browser_capture"]);
  await assert.rejects(withoutShell.dispatch({
    ...identity,
    invocationId: "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolCallId: "call-shell-denied",
    toolName: "shell_execute",
    args: { command: "printf openbot-ok" },
  }), /failed/i);
  assert.equal(runs.length, 0);

  targetTools = Object.freeze(["browser.navigate", "browser.capture", "shell.execute"]);
  const withShell = await createStandaloneComputerToolBridge({ computerTargetRouter: router }).open(identity);
  assert.deepEqual(withShell.definitions.at(-1), {
    type: "function",
    name: "shell_execute",
    description: "Run one bounded full-host command after explicit permission. Output is returned only as metadata.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", maxLength: 8192 } },
      required: ["command"],
      additionalProperties: false,
    },
  });
  const result = await withShell.dispatch({
    ...identity,
    invocationId: "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolCallId: "call-shell",
    toolName: "shell_execute",
    args: { command: "printf openbot-ok" },
  });
  assert.deepEqual(result, {
    exitCode: 0,
    stdout: { bytes: 10, sha256: "73e7d16cbb4ab8015676c79cd235f33ac6849028f6f4e6392477bbc8926302d9" },
    stderr: { bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(runs, [{
    mode: "local",
    botId: BOT_A,
    conversationId: identity.conversationId,
    taskId: "parent",
    targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetGeneration: 4,
    workspaceId: `workspace-${"a".repeat(64)}`,
    capability: "shell.execute",
    operation: "shell.execute",
    arguments: { command: "printf openbot-ok" },
    resourceId: "full-host-shell",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
  }]);
  assert.deepEqual(Object.keys(runs[0]).sort(), [
    "arguments", "botId", "capability", "conversationId", "mode", "operation", "reason",
    "resourceId", "resourceLabel", "targetGeneration", "targetId", "taskId", "workspaceId",
  ]);
  assert.doesNotMatch(JSON.stringify(runs[0]), /"(?:cwd|env|HOME|CODEX_HOME|bookmark|path)"/);
});

test("reviewed shell rejects hostile commands and returns only deterministic output metadata", async () => {
  const { createStandaloneComputerToolBridge } = require(controllerPath);
  const identity = {
    botId: BOT_A,
    conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    taskId: "parent",
  };
  let rawResult = { exitCode: 0, stdout: "safe", stderr: "" };
  let runs = 0;
  const session = await createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve() {
        return {
          mode: "local",
          botId: BOT_A,
          targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          targetGeneration: 4,
          workspaceId: `workspace-${"a".repeat(64)}`,
          tools: ["browser.navigate", "browser.capture", "shell.execute"],
        };
      },
      async run() { runs += 1; return rawResult; },
      async disposeTask() {},
    },
  }).open(identity);
  const dispatch = (args) => session.dispatch({
    ...identity,
    invocationId: "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolCallId: "call-shell",
    toolName: "shell_execute",
    args,
  });
  let accessorReads = 0;
  const accessor = Object.defineProperty({}, "command", {
    enumerable: true,
    get() { accessorReads += 1; return "private /Users/person"; },
  });
  let proxyTraps = 0;
  const proxy = new Proxy({ command: "private" }, {
    ownKeys() { proxyTraps += 1; throw new Error("private /Users/person token"); },
  });
  for (const args of [
    {},
    { command: "" },
    { command: "x\0y" },
    { command: "x".repeat(8193) },
    { command: 7 },
    { command: "true", cwd: "/Users/person" },
    Object.assign(Object.create({ inherited: true }), { command: "true" }),
    accessor,
    proxy,
  ]) {
    await assert.rejects(dispatch(args), { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  }
  assert.equal(accessorReads, 0);
  assert.equal(proxyTraps, 0);
  assert.equal(runs, 0);
  assert.deepEqual(await dispatch({ command: `${"界".repeat(2730)}xx` }), {
    exitCode: 0,
    stdout: { bytes: 4, sha256: "8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860" },
    stderr: { bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  });
  assert.equal(runs, 1);

  let resultAccessorReads = 0;
  const resultAccessor = Object.defineProperty({ exitCode: 0, stderr: "" }, "stdout", {
    enumerable: true,
    get() { resultAccessorReads += 1; return "/Users/person token"; },
  });
  let resultProxyTraps = 0;
  const resultProxy = new Proxy({ exitCode: 0, stdout: "private", stderr: "" }, {
    ownKeys() { resultProxyTraps += 1; throw new Error("private /Users/person token"); },
  });
  for (const value of [
    { exitCode: 0, stdout: "safe", stderr: "", path: "/Users/person" },
    { exitCode: 1.5, stdout: "safe", stderr: "" },
    { exitCode: 0, stdout: "x".repeat(128 * 1024 + 1), stderr: "" },
    resultAccessor,
    resultProxy,
  ]) {
    rawResult = value;
    const error = await dispatch({ command: "printf safe" }).catch((caught) => caught);
    assert.equal(error.code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
    assert.doesNotMatch(String(error.stack), /Users|private|token|HOME|path/);
  }
  assert.equal(resultAccessorReads, 0);
  assert.equal(resultProxyTraps, 0);

  for (const stdout of [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "sk-proj-abcdefghijklmnopqrstuvwxyz",
    "/Users/person/project /private/var/folders/private /Volumes/Personal",
    "local account harlin",
    Buffer.from("HOME=/Users/person").toString("base64"),
    "parser token tests passed",
  ]) {
    rawResult = { exitCode: 0, stdout, stderr: "" };
    const descriptor = await dispatch({ command: "printf safe" });
    assert.equal(descriptor.stdout.bytes, Buffer.byteLength(stdout, "utf8"));
    assert.match(descriptor.stdout.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(descriptor), /OPENSSH|sk-proj|Users|private|Volumes|harlin|HOME|parser|token/);
  }
});

test("real helper path and secret output reaches inference only as deterministic metadata", async (t) => {
  const { ComputerTargetRouter } = require("../src/computer/computer-target-router.cjs");
  const { installParentPort } = require("../src/local/local-helper-child.cjs");
  const { LocalHelperProtocol } = require("../src/local/local-helper-protocol.cjs");
  const { createStandaloneComputerToolBridge, StandaloneConversationController } = require(controllerPath);
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-shell-chain-"));
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }));
  const messageListeners = new Set();
  const exitListeners = new Set();
  const childFrames = [];
  const parentFrames = [];
  class Port extends EventEmitter {
    postMessage(message) {
      if (message?.type === "ready" || message?.type === "startup-ack") {
        childFrames.push(structuredClone(message));
      } else if (message?.type === "fatal") {
        for (const listener of [...exitListeners]) listener();
      } else if (message?.type === "reply") {
        for (const listener of [...messageListeners]) listener(message.reply);
      }
    }
  }
  const port = new Port();
  installParentPort(port, workspacePath);
  const sendToChild = async (message) => {
    parentFrames.push(structuredClone(message));
    return port.listeners("message")[0]({ data: message });
  };
  assert.deepEqual(childFrames, [{ type: "ready" }]);
  assert.deepEqual(parentFrames, []);
  const startupNonce = "e".repeat(64);
  await sendToChild({ type: "startup-challenge", nonce: startupNonce });
  assert.deepEqual(childFrames, [
    { type: "ready" },
    { type: "startup-ack", nonce: startupNonce },
  ]);
  assert.match(childFrames[1].nonce, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(childFrames[1]).sort(), ["nonce", "type"]);
  assert.deepEqual(parentFrames.map(({ type }) => type), ["startup-challenge"]);
  assert.equal(parentFrames.some(({ type }) => type === "run" || type === "cancel"), false);
  const transport = {
    async send(request) { await sendToChild({ type: "run", request }); },
    async cancel(requestId) { await sendToChild({ type: "cancel", requestId }); },
    onMessage(listener) { messageListeners.add(listener); return () => messageListeners.delete(listener); },
    onExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
    dispose() { messageListeners.clear(); exitListeners.clear(); },
  };
  const record = Object.freeze({
    botId: BOT_A,
    computer: Object.freeze({
      mode: "local",
      generation: 4,
      localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nativeAgentId: null,
      state: "ready",
      lastConfirmedAt: "2026-08-16T12:00:00.000Z",
      lastErrorCode: null,
    }),
  });
  const protocol = new LocalHelperProtocol({
    transport,
    async readCurrentComputer() { return record; },
  });
  let requestNumber = 0;
  const localManager = {
    async open(value) {
      return Object.freeze({
        botId: value.botId,
        targetId: value.computer.localProfileId,
        targetGeneration: value.computer.generation,
        state: "ready",
      });
    },
    async run(action) {
      requestNumber += 1;
      return protocol.run({
        requestId: `request-${String(requestNumber).padStart(8, "0")}-1111-4111-8111-111111111111`,
        botId: action.botId,
        targetId: action.targetId,
        targetGeneration: action.targetGeneration,
        taskId: action.taskId,
        capability: action.capability,
        operation: action.operation,
        arguments: action.arguments,
      });
    },
    async navigate() { throw new Error("unused"); },
    async capture() { throw new Error("unused"); },
    async disposeTask({ taskId }) { await protocol.cancelTask(taskId); },
  };
  const targetRouter = new ComputerTargetRouter({
    store: { async read(botId) { return botId === BOT_A ? record : null; } },
    localManager,
  });
  const shellTool = createStandaloneComputerToolBridge({ computerTargetRouter: targetRouter });
  const stdout = "/Users/person/private API_TOKEN=secret\n";
  const stderr = "password=hunter2\n";
  const requests = [];
  const controller = new StandaloneConversationController({
    router: {
      async stream(request) {
        requests.push(request);
        if (requests.length === 1) return directResult(request, [
          { type: "tool-call-streaming-start", toolCallId: "call-shell", toolName: "shell_execute" },
          {
            type: "tool-call",
            toolCallId: "call-shell",
            toolName: "shell_execute",
            args: {
              command: "printf '\\057Users/person/private API_TOKEN=secret\\n'; printf 'pass%s=hunter2\\n' word >&2",
            },
          },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
        return directResult(request, [{ type: "finish", finishReason: "stop", usage: {} }]);
      },
    },
    toolBridge: shellTool,
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = controller.create({ botId: BOT_A });
  const terminal = await terminalEvent(controller, () => controller.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Run the reviewed command.",
  }));
  assert.equal(terminal.event.type, "completed");
  const resultText = requests[1].messages.at(-1).content[0].result.content[0].text;
  assert.deepEqual(JSON.parse(resultText), {
    exitCode: 0,
    stdout: { bytes: Buffer.byteLength(stdout), sha256: createHash("sha256").update(stdout).digest("hex") },
    stderr: { bytes: Buffer.byteLength(stderr), sha256: createHash("sha256").update(stderr).digest("hex") },
  });
  assert.doesNotMatch(resultText, /Users|API_TOKEN|secret|password|hunter2/);
  await controller.dispose();
  await protocol.dispose();
  targetRouter.dispose();
});

test("direct Codex and reviewed optional providers receive the same shell tool schema", async () => {
  const { createStandaloneComputerToolBridge, StandaloneConversationController } = require(controllerPath);
  const toolBridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve({ botId }) {
        return {
          mode: "local",
          botId,
          targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          targetGeneration: 4,
          workspaceId: `workspace-${"a".repeat(64)}`,
          tools: ["browser.navigate", "browser.capture", "shell.execute"],
        };
      },
      async run() { throw new Error("must not run"); },
      async disposeTask() {},
    },
  });
  async function toolsFor(selected) {
    let captured = null;
    const transport = Object.freeze({
      stream(request) { captured = request.tools; return directResult(request); },
    });
    const providerRouter = new InferenceProviderRouter({
      async readSelection() { return selected; },
      directTransport: transport,
      async createOptionalTransport() { return transport; },
    });
    const controller = new StandaloneConversationController({
      router: providerRouter,
      toolBridge,
      async readSelection() { return selected; },
      makeId: ids(),
      now: () => "2026-08-16T12:00:00.000Z",
    });
    const created = controller.create({ botId: BOT_A });
    const terminal = await terminalEvent(controller, () => controller.send({
      botId: BOT_A,
      conversationId: created.conversationId,
      text: "Answer without a tool.",
    }));
    assert.equal(terminal.event.type, "completed");
    controller.dispose();
    providerRouter.dispose();
    return captured;
  }
  const directTools = await toolsFor(selection());
  const optionalTools = await toolsFor(selection({
    generation: 8,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
  }));
  assert.deepEqual(directTools, optionalTools);
  assert.deepEqual(directTools.map(({ name }) => name), ["browser_navigate", "browser_capture", "shell_execute"]);
});

test("reviewed shell remains behind deny and one-shot decisions and forbids remembered access", async () => {
  const { LocalPermissionBroker } = require("../src/local/local-permission-broker.cjs");
  const { createStandaloneComputerToolBridge } = require(controllerPath);
  const identity = {
    botId: BOT_A,
    conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    taskId: "parent",
  };
  let effects = 0;
  let authorizations = 0;
  const store = {
    async authorize() {
      authorizations += 1;
      return Object.freeze({ allowed: false });
    },
    async remember() { throw new Error("shell access must not be remembered"); },
    async revoke() { throw new Error("no shell grant exists"); },
    async deleteBot() {},
    async listPublic() { return Object.freeze([]); },
  };
  const requestIds = [...UUIDS, "99999999-9999-4999-8999-999999999999"];
  const broker = new LocalPermissionBroker({
    store,
    async readCurrentComputer() {
      return {
        botId: BOT_A,
        computer: {
          mode: "local",
          generation: 4,
          localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          state: "ready",
        },
      };
    },
    async chooseResource() { return Buffer.from("workspace-bookmark"); },
    tcc: { async ensure() { return true; } },
    randomUUID() {
      const value = requestIds.shift();
      if (!value) throw new Error("UUID sequence exhausted");
      return value;
    },
  });
  const bridge = createStandaloneComputerToolBridge({
    computerTargetRouter: {
      async resolve() {
        return {
          mode: "local",
          botId: BOT_A,
          targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          targetGeneration: 4,
          workspaceId: `workspace-${"a".repeat(64)}`,
          tools: ["browser.navigate", "browser.capture", "shell.execute"],
        };
      },
      async run(action) {
        return broker.request({
          botId: action.botId,
          targetId: action.targetId,
          targetGeneration: action.targetGeneration,
          capability: action.capability,
          resourceId: action.resourceId,
          resourceLabel: action.resourceLabel,
          reason: action.reason,
          command: action.arguments.command,
        }, async () => {
          effects += 1;
          return { exitCode: 0, stdout: `effect-${effects}`, stderr: "" };
        });
      },
      async disposeTask() {},
    },
  });
  const session = await bridge.open(identity);
  let call = 0;
  const dispatch = () => session.dispatch({
    ...identity,
    invocationId: "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolCallId: `call-${++call}`,
    toolName: "shell_execute",
    args: { command: "printf safe" },
  });
  async function prompted() {
    const seen = once(broker, "request");
    const pending = dispatch();
    const [prompt] = await seen;
    return { pending, prompt };
  }
  const decision = (prompt, value) => ({
    requestId: prompt.requestId,
    botId: prompt.botId,
    targetId: prompt.targetId,
    targetGeneration: prompt.targetGeneration,
    decision: value,
  });

  const denied = await prompted();
  const deniedOutcome = denied.pending.catch((error) => error);
  assert.equal(effects, 0);
  await assert.rejects(broker.decide(decision(denied.prompt, "deny")), /denied/i);
  assert.equal((await deniedOutcome).code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
  assert.equal(effects, 0);

  const onceOnly = await prompted();
  await broker.decide(decision(onceOnly.prompt, "once"));
  assert.equal((await onceOnly.pending).exitCode, 0);
  assert.equal(effects, 1);
  const afterOnce = await prompted();
  assert.equal(effects, 1);
  await assert.rejects(broker.decide(decision(afterOnce.prompt, "always")), /unavailable|one command/i);
  assert.equal(effects, 1);
  await broker.decide(decision(afterOnce.prompt, "once"));
  assert.equal((await afterOnce.pending).exitCode, 0);
  assert.equal(effects, 2);
  const stillNotRemembered = await prompted();
  assert.equal(effects, 2);
  const finalOutcome = stillNotRemembered.pending.catch((error) => error);
  await assert.rejects(broker.decide(decision(stillNotRemembered.prompt, "deny")), /denied/i);
  assert.equal((await finalOutcome).code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
  assert.equal(effects, 2);
  assert.equal(authorizations, 0);
  broker.dispose();
});

test("duplicate and denied reviewed tool calls fail closed without assistant persistence", async () => {
  for (const mode of ["duplicate", "denied"]) {
    let dispatches = 0;
    const controller = new (require(controllerPath).StandaloneConversationController)({
      router: {
        async stream(request) {
          const call = { type: "tool-call", toolCallId: "call-1", toolName: "browser_navigate", args: { url: "https://www.youtube.com/" } };
          return directResult(request, [
            { type: "tool-call-streaming-start", toolCallId: "call-1", toolName: "browser_navigate" },
            call,
            ...(mode === "duplicate" ? [call] : []),
            { type: "finish", finishReason: "tool-calls", usage: {} },
          ]);
        },
      },
      store: memoryStore(),
      toolBridge: {
        async open(identity) {
          return reviewedToolSession(identity, async () => {
            dispatches += 1;
            if (mode === "denied") throw new Error("denied /Users/private token");
            return { state: "ready" };
          });
        },
      },
      async readSelection() { return selection(); },
      makeId: ids(),
      now: () => "2026-08-16T12:00:00.000Z",
    });
    const created = await controller.create({ botId: BOT_A });
    const terminal = await terminalEvent(controller, () => controller.send({
      botId: BOT_A, conversationId: created.conversationId, text: "Open YouTube.",
    }));
    assert.equal(terminal.event.type, "failed");
    assert.equal(terminal.event.code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
    assert.equal(dispatches, mode === "denied" ? 1 : 0);
    assert.deepEqual((await controller.read({ botId: BOT_A, conversationId: created.conversationId }))
      .messages.map(({ role }) => role), ["user"]);
    assert.doesNotMatch(JSON.stringify(terminal), /Users|private|token|denied/);
    controller.dispose();
  }
});

test("tool rounds stop at the exact bound and cancellation suppresses a late tool result", async () => {
  let rounds = 0;
  let dispatches = 0;
  const bounded = new (require(controllerPath).StandaloneConversationController)({
    router: {
      async stream(request) {
        rounds += 1;
        const id = `call-${rounds}`;
        return directResult(request, [
          { type: "tool-call-streaming-start", toolCallId: id, toolName: "browser_navigate" },
          { type: "tool-call", toolCallId: id, toolName: "browser_navigate", args: { url: "https://www.youtube.com/" } },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      },
    },
    store: memoryStore(),
    toolBridge: { async open(identity) { return reviewedToolSession(identity, async () => { dispatches += 1; return { state: "ready" }; }); } },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const created = await bounded.create({ botId: BOT_A });
  const terminal = await terminalEvent(bounded, () => bounded.send({ botId: BOT_A, conversationId: created.conversationId, text: "Loop." }));
  assert.equal(terminal.event.type, "failed");
  assert.equal(rounds, 9);
  assert.equal(dispatches, 8);
  bounded.dispose();

  let release;
  let entered = false;
  const events = [];
  const cancelled = new (require(controllerPath).StandaloneConversationController)({
    router: {
      async stream(request) {
        return directResult(request, [
          { type: "tool-call-streaming-start", toolCallId: "call-1", toolName: "browser_navigate" },
          { type: "tool-call", toolCallId: "call-1", toolName: "browser_navigate", args: { url: "https://www.youtube.com/" } },
          { type: "finish", finishReason: "tool-calls", usage: {} },
        ]);
      },
    },
    store: memoryStore(),
    toolBridge: { async open(identity) { return reviewedToolSession(identity, async () => { entered = true; return new Promise((resolve) => { release = resolve; }); }); } },
    async readSelection() { return selection(); },
    makeId: ids(),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  cancelled.on("event", (event) => events.push(event));
  const createdCancelled = await cancelled.create({ botId: BOT_A });
  const accepted = await cancelled.send({ botId: BOT_A, conversationId: createdCancelled.conversationId, text: "Wait." });
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  cancelled.cancel({ botId: BOT_A, conversationId: createdCancelled.conversationId, invocationId: accepted.invocationId });
  release({ state: "private late result" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["cancelled"]);
  assert.doesNotMatch(JSON.stringify(events), /private|late result/);
  cancelled.dispose();
});
