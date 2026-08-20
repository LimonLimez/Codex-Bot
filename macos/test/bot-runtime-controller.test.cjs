"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AsyncResource } = require("node:async_hooks");

const { BotStore } = require("../src/bots/bot-store.cjs");
const {
  validateProvider,
  unavailableProvider,
} = require("../src/bots/runtime-provider.cjs");
const { BotRuntimeController } = require("../src/bots/runtime-controller.cjs");

const NOW = "2026-08-14T12:34:56.000Z";
const TEST_ISSUANCE_A = "issuance-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_RETIREMENT_A = "retire-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_ISSUANCE_B = "issuance-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEST_RETIREMENT_B = "retire-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAPABILITIES = Object.freeze({
  provision: true,
  reconcile: true,
  retire: true,
  remoteAppServer: true,
  computerFrames: true,
  issuanceFencedRetire: true,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

async function readAfterRuntimeTransaction(store, botId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await store.read(botId);
    } catch (error) {
      if (error?.code !== "BOT_STORE_RUNTIME_TRANSACTION_BUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  assert.fail("runtime transaction did not release before read");
}

async function waitForStoreBot(store, botId, predicate, message = "store state was not reached") {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const bot = await store.read(botId);
      if (predicate(bot)) {
        await new Promise((resolve) => setImmediate(resolve));
        try {
          const stable = await store.read(botId);
          if (predicate(stable)) return stable;
        } catch (error) {
          if (error?.code !== "BOT_STORE_RUNTIME_TRANSACTION_BUSY") throw error;
        }
      }
    } catch (error) {
      if (error?.code !== "BOT_STORE_RUNTIME_TRANSACTION_BUSY") throw error;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-runtime-controller-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new BotStore({
    filePath: path.join(directory, "bots.json"),
    now: () => NOW,
  });
  Object.defineProperty(store, "filePath", { value: path.join(directory, "bots.json") });
  return store;
}

function forwardingStore(store, overrides = {}) {
  return {
    load: (...args) => store.load(...args),
    list: (...args) => store.list(...args),
    listPendingDeletions: (...args) => store.listPendingDeletions(...args),
    readRuntimeIssuances: (...args) => store.readRuntimeIssuances(...args),
    beginRuntimeIssuance: (...args) => store.beginRuntimeIssuance(...args),
    issueRuntimeIssuance: (...args) => store.issueRuntimeIssuance(...args),
    promoteRuntimeIssuance: (...args) => store.promoteRuntimeIssuance(...args),
    confirmRuntimeIssuance: (...args) => store.confirmRuntimeIssuance(...args),
    completeRuntimeIssuance: (...args) => store.completeRuntimeIssuance(...args),
    revertRuntimePromotion: (...args) => store.revertRuntimePromotion(...args),
    abortRuntimeIssuance: (...args) => store.abortRuntimeIssuance(...args),
    read: (...args) => store.read(...args),
    create: (...args) => store.create(...args),
    rename: (...args) => store.rename(...args),
    updateProfile: (...args) => store.updateProfile(...args),
    advanceSetup: (...args) => store.advanceSetup(...args),
    updateRuntime: (...args) => store.updateRuntime(...args),
    deleteBots: (...args) => store.deleteBots(...args),
    runtimeTransaction: (...args) => store.runtimeTransaction(...args),
    isCurrentRuntimeCommit: (...args) => store.isCurrentRuntimeCommit(...args),
    ...overrides,
  };
}

function controllableDirectorySyncFailure(directory) {
  let armed = false;
  let failures = 0;
  return {
    fs: {
      ...fs,
      open: async (...args) => {
        const handle = await fs.open(...args);
        const target = path.resolve(String(args[0]));
        return {
          writeFile: (...writeArgs) => handle.writeFile(...writeArgs),
          sync: async () => {
            if (target === path.resolve(directory) && armed) {
              armed = false;
              failures += 1;
              const failure = new Error("injected terminal directory sync failure");
              failure.code = "EIO";
              throw failure;
            }
            return handle.sync();
          },
          close: (...closeArgs) => handle.close(...closeArgs),
        };
      },
    },
    arm() {
      armed = true;
    },
    failures() {
      return failures;
    },
  };
}

function controllableRenameFailure() {
  let armed = false;
  let failures = 0;
  return {
    fs: {
      ...fs,
      rename: async (...args) => {
        if (!armed) return fs.rename(...args);
        armed = false;
        failures += 1;
        const failure = new Error("injected terminal precommit rename failure");
        failure.code = "EIO";
        throw failure;
      },
    },
    arm() {
      armed = true;
    },
    failures() {
      return failures;
    },
  };
}

function interceptRuntimeUpdates(store, intercept) {
  const runtimeTransaction = store.runtimeTransaction.bind(store);
  return (botId, options, operation) => runtimeTransaction(
    botId,
    options,
    (transaction) => operation(Object.freeze({
      ...transaction,
      updateRuntime: (patch) => intercept({
        botId,
        patch,
        update: () => transaction.updateRuntime(patch),
      }),
    })),
  );
}

function runtimeResult(botId, overrides = {}) {
  const suffix = botId.slice(-12);
  return {
    provider: "authorized-test-provider",
    runtimeId: `runtime-${suffix}`,
    ownerBotId: botId,
    endpoint: `wss://${suffix}.runtime.example.test/app-server`,
    authToken: `private-token-${suffix}`,
    state: "ready",
    ...overrides,
  };
}

async function installIssuedSuccessor(store, harness, botId, {
  previousIssuanceKey,
  issuanceKey,
  retirementKey,
  runtimeId,
  state = "ready",
}) {
  await store.beginRuntimeIssuance(botId, {
    idempotencyKey: `codex-bot:${botId}:successor:${issuanceKey}`,
    issuanceKey,
    retirementKey,
  });
  await store.issueRuntimeIssuance(botId, {
    issuanceKey,
    provider: "authorized-test-provider",
    runtimeId,
  });
  harness.runtimes.set(runtimeId, {
    runtimeId,
    ownerBotId: botId,
    provider: "authorized-test-provider",
    issuanceKey,
    state,
  });
  const promoted = await store.promoteRuntimeIssuance(botId, {
    issuanceKey,
    provider: "authorized-test-provider",
    runtimeId,
    state,
    lastConfirmedAt: state === "ready" ? NOW : null,
    expectedPreviousIssuanceKey: previousIssuanceKey,
  });
  assert.equal(promoted.matched, true);
  return promoted;
}

class ProviderHarness {
  constructor() {
    this.provisionCalls = [];
    this.inspectCalls = [];
    this.retireCalls = [];
    this.order = [];
    this.provisionQueues = new Map();
    this.issuedResults = new Map();
    this.runtimes = new Map();
    this.subscribers = new Set();
    this.retainedSubscribers = [];
    this.inspectHook = null;
    this.retireHook = null;
    this.provisionHook = null;
  }

  queueProvision(botId, ...results) {
    this.provisionQueues.set(botId, [...results]);
  }

  adapter() {
    return {
      capabilities: async () => ({ ...CAPABILITIES }),
      provision: async (input) => {
        this.provisionCalls.push({ ...input });
        if (this.provisionHook) await this.provisionHook({ ...input });
        const queued = this.provisionQueues.get(input.botId);
        const replayKey = `${input.botId}\0${input.idempotencyKey}\0${input.issuanceKey}`;
        let result = queued?.length
          ? queued.shift()
          : (this.issuedResults.get(replayKey) || runtimeResult(input.botId));
        if (typeof result === "function") result = result(input);
        result = await result;
        if (result instanceof Error) throw result;
        result = { ...result, issuanceKey: result.issuanceKey || input.issuanceKey };
        this.issuedResults.set(replayKey, { ...result });
        this.order.push(`provision:${result.runtimeId}`);
        this.runtimes.set(result.runtimeId, {
          runtimeId: result.runtimeId,
          ownerBotId: result.ownerBotId,
          provider: result.provider,
          issuanceKey: result.issuanceKey,
          state: result.state,
        });
        return result;
      },
      inspect: async ({ runtimeId }) => {
        this.inspectCalls.push({ runtimeId });
        this.order.push(`inspect:${runtimeId}`);
        if (this.inspectHook) return this.inspectHook({ runtimeId });
        const runtime = this.runtimes.get(runtimeId);
        if (!runtime) return { runtimeId, ownerBotId: "bot-unknown", state: "retired" };
        return { ...runtime };
      },
      retire: async ({ runtimeId }) => {
        this.retireCalls.push({ runtimeId });
        this.order.push(`retire:${runtimeId}`);
        if (this.retireHook) return this.retireHook({ runtimeId });
        const runtime = this.runtimes.get(runtimeId);
        if (runtime) runtime.state = "retired";
        return { runtimeId, state: "retired" };
      },
      inspectIssuance: async ({ runtimeId, ownerBotId, issuanceKey }) => {
        this.inspectCalls.push({ runtimeId });
        this.order.push(`inspect:${runtimeId}`);
        let runtime = this.runtimes.get(runtimeId);
        if (!runtime || runtime.ownerBotId !== ownerBotId
          || (runtime.issuanceKey !== undefined && runtime.issuanceKey !== issuanceKey)) {
          return { matched: false, runtimeId, state: "superseded" };
        }
        const inspected = this.inspectHook
          ? await this.inspectHook({ runtimeId })
          : { runtimeId, ownerBotId: runtime.ownerBotId, state: runtime.state };
        runtime = this.runtimes.get(runtimeId);
        if (inspected.runtimeId !== runtimeId || inspected.ownerBotId !== ownerBotId
          || !runtime || runtime.ownerBotId !== ownerBotId
          || (runtime.issuanceKey !== undefined && runtime.issuanceKey !== issuanceKey)) {
          return { matched: false, runtimeId, state: "superseded" };
        }
        return {
          matched: true,
          runtimeId,
          ownerBotId,
          issuanceKey,
          state: inspected.state,
        };
      },
      retireIssuance: async ({ runtimeId, ownerBotId, issuanceKey, retirementKey }) => {
        this.retireCalls.push({ runtimeId });
        this.order.push(`retire:${runtimeId}`);
        const runtime = this.runtimes.get(runtimeId);
        if (!runtime || runtime.ownerBotId !== ownerBotId
          || (runtime.issuanceKey !== undefined && runtime.issuanceKey !== issuanceKey)) {
          return { matched: false, runtimeId, state: "superseded" };
        }
        if (this.retireHook) {
          const hooked = await this.retireHook({ runtimeId, ownerBotId, issuanceKey, retirementKey });
          if (hooked?.state) runtime.state = hooked.state;
          return {
            matched: true,
            runtimeId,
            ownerBotId,
            issuanceKey,
            state: runtime.state,
          };
        }
        runtime.state = "retired";
        return { matched: true, runtimeId, ownerBotId, issuanceKey, state: "retired" };
      },
      subscribe: (callback) => {
        this.subscribers.add(callback);
        this.retainedSubscribers.push(callback);
        return () => this.subscribers.delete(callback);
      },
    };
  }

  provider() {
    return validateProvider(this.adapter());
  }

  emit(event) {
    const runtime = this.runtimes.get(event?.runtimeId);
    const enriched = event?.issuanceKey || !runtime
      ? event
      : { ...event, issuanceKey: runtime.issuanceKey };
    for (const callback of [...this.subscribers]) callback(enriched);
  }
}

async function fencedDeletionFixture(t) {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await controller.ensureRuntime(bot.botId);
  await controller.deleteBots([bot.botId]);
  const [receipt] = await store.listPendingDeletions();
  return { store, bot, harness, controller, receipt };
}

test("bot facade preserves literal New Bot identity and publishes frozen sanitized snapshots", async (t) => {
  const store = await temporaryStore(t);
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  const botEvents = [];
  const runtimeEvents = [];
  controller.on("bot-changed", (event) => botEvents.push(event));
  controller.on("runtime-changed", (event) => runtimeEvents.push(event));
  const input = {
    name: "Caller cannot rename",
    appearance: { shape: "gem", color: "blue" },
    notifications: false,
    runtime: {
      endpoint: "wss://secret.example.test/app-server",
      authToken: "must-not-persist",
    },
  };

  const created = await controller.createBot(input);
  assert.equal(created.name, "New Bot");
  assert.deepEqual(created.appearance, {
    shape: "gem",
    color: "blue",
    image: null,
    title: "",
    description: "",
  });
  assert.equal(created.notifications, false);
  assert.deepEqual(created.runtime, {
    provider: null,
    remoteRuntimeId: null,
    state: "unavailable",
    lastConfirmedAt: null,
    lastErrorCode: "REMOTE_PROVIDER_UNAVAILABLE",
  });

  input.appearance.shape = "mutated";
  const renamed = await controller.renameBot(created.botId, "Nova");
  const profiled = await controller.updateProfile(created.botId, {
    appearance: { title: "Builder" },
    notifications: true,
  });
  assert.equal(renamed.name, "Nova");
  assert.equal(profiled.name, "Nova");
  assert.equal(profiled.appearance.shape, "gem");
  assert.equal(profiled.appearance.title, "Builder");
  assert.equal(profiled.notifications, true);
  assert.deepEqual(await controller.listBots(), [await controller.readBot(created.botId)]);

  assert.ok(botEvents.length >= 3);
  assert.ok(runtimeEvents.length >= 1);
  for (const event of [...botEvents, ...runtimeEvents]) {
    assertDeepFrozen(event);
    assert.doesNotMatch(JSON.stringify(event), /endpoint|authToken|must-not-persist|secret\.example/i);
  }
  assert.throws(() => { botEvents[0].bot.name = "forged"; }, TypeError);
  assert.equal((await controller.readBot(created.botId)).name, "Nova");
});

test("bot facade publishes only exact monotonic setup-stage transactions", async (t) => {
  const store = await temporaryStore(t);
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  const botEvents = [];
  controller.on("bot-changed", (event) => botEvents.push(event.bot));

  const created = await controller.createBot();
  assert.equal(created.setupStage, "profile-model");
  const computer = await controller.advanceSetup(created.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  });
  assert.equal(computer.setupStage, "computer");
  await assert.rejects(controller.advanceSetup(created.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  }), /changed|stale/i);
  const complete = await controller.advanceSetup(created.botId, {
    expectedStage: "computer",
    nextStage: "complete",
  });
  assert.equal(complete.setupStage, "complete");
  assert.equal(botEvents.at(-1).setupStage, "complete");
  assertDeepFrozen(botEvents.at(-1));
});

test("bot facade preserves trusted native setup-stage transactions", async (t) => {
  const store = await temporaryStore(t);
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  const botEvents = [];
  controller.on("bot-changed", (event) => botEvents.push(event.bot));

  const ordinary = await controller.createBot();
  const native = await controller.createBot({ setupStage: "complete" });

  assert.equal(ordinary.setupStage, "profile-model");
  assert.equal(native.setupStage, "complete");
  assert.equal(botEvents.findLast(({ botId }) => botId === native.botId).setupStage, "complete");
  assertDeepFrozen(botEvents.findLast(({ botId }) => botId === native.botId));
});

test("bot controller passes the provider authority fence to the durable create commit", async (t) => {
  const store = await temporaryStore(t);
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  await assert.rejects(
    controller.createBot({ setupStage: "complete" }, { commitFence: () => false }),
    { code: "BOT_STORE_PROVIDER_AUTHORITY_STALE" },
  );
  assert.deepEqual(await store.list(), []);
});

test("a committed-uncertain setup stage is reread and published only at its exact successor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-setup-stage-controller-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const syncFailure = controllableDirectorySyncFailure(directory);
  const store = new BotStore({
    filePath: path.join(directory, "bots.json"),
    fs: syncFailure.fs,
    now: () => NOW,
  });
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  const created = await controller.createBot();
  const events = [];
  controller.on("bot-changed", (event) => events.push(event.bot));

  syncFailure.arm();
  const recovered = await controller.advanceSetup(created.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  });
  assert.equal(syncFailure.failures(), 1);
  assert.equal(recovered.setupStage, "computer");
  assert.equal(events.length, 1);
  assert.equal(events[0].setupStage, "computer");
  assertDeepFrozen(events[0]);
});

test("the bot controller carries an authoritative setup fence into the store transaction", async (t) => {
  const base = await temporaryStore(t);
  const current = await base.create();
  const calls = [];
  const store = forwardingStore(base, {
    async advanceSetup(botId, transition, fence) {
      calls.push([botId, transition, fence]);
      fence(current);
      return base.advanceSetup(botId, transition);
    },
  });
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  let fenced = 0;
  const result = await controller.advanceSetup(current.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  }, (bot) => {
    fenced += 1;
    assert.equal(bot, current);
  });
  assert.equal(result.setupStage, "computer");
  assert.equal(fenced, 1);
  assert.equal(calls.length, 1);
});

test("false provider capabilities fail closed without calling provision or local transport", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const calls = { provision: 0, inspect: 0, retire: 0 };
  const provider = {
    async capabilities() {
      return {
        provision: false,
        reconcile: false,
        retire: false,
        remoteAppServer: false,
        computerFrames: false,
      };
    },
    async provision() { calls.provision += 1; throw new Error("local fallback was called"); },
    async inspect() { calls.inspect += 1; throw new Error("local fallback was called"); },
    async retire() { calls.retire += 1; throw new Error("local fallback was called"); },
    subscribe() { return () => {}; },
  };
  const controller = new BotRuntimeController({ store, provider, now: () => NOW });
  t.after(() => controller.dispose());

  const ensured = await controller.ensureRuntime(bot.botId);
  const retried = await controller.retryRuntime(bot.botId);

  assert.equal(ensured.runtime.state, "unavailable");
  assert.equal(retried.runtime.state, "unavailable");
  assert.equal(retried.runtime.lastErrorCode, "REMOTE_PROVIDER_UNAVAILABLE");
  assert.deepEqual(calls, { provision: 0, inspect: 0, retire: 0 });
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("concurrent ensure and retry share exactly one provision with the bot idempotency key", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const gate = deferred();
  harness.queueProvision(bot.botId, async () => {
    await gate.promise;
    return runtimeResult(bot.botId);
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  const first = controller.ensureRuntime(bot.botId);
  const second = controller.ensureRuntime(bot.botId);
  const retry = controller.retryRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === 1, "provision did not begin");
  assert.equal(harness.provisionCalls.length, 1);
  gate.resolve();
  const [a, b, c] = await Promise.all([first, second, retry]);

  assert.equal(harness.provisionCalls.length, 1);
  assert.deepEqual(harness.provisionCalls[0], {
    botId: bot.botId,
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: harness.provisionCalls[0].issuanceKey,
  });
  assert.match(harness.provisionCalls[0].issuanceKey, /^issuance-/);
  assert.equal(a.runtime.remoteRuntimeId, b.runtime.remoteRuntimeId);
  assert.equal(b.runtime.remoteRuntimeId, c.runtime.remoteRuntimeId);
  assert.equal(a.runtime.state, "ready");
});

test("runtimeSession is fresh-inspected, private, deeply immutable, and not JSON-serializable with credentials", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  const ready = await controller.ensureRuntime(bot.botId);
  const session = await controller.runtimeSession(bot.botId);

  assert.deepEqual(Reflect.ownKeys(session).sort(), [
    "authToken",
    "endpoint",
    "generation",
    "provider",
    "runtimeId",
  ]);
  assert.equal(session.provider, "authorized-test-provider");
  assert.equal(session.runtimeId, ready.runtime.remoteRuntimeId);
  assert.match(session.endpoint, /^wss:\/\//);
  assert.match(session.authToken, /^private-token-/);
  assert.equal(session.generation, 1);
  assertDeepFrozen(session);
  assert.throws(() => { session.endpoint = "wss://forged.example.test"; }, TypeError);
  assert.throws(() => { session.generation = 999; }, TypeError);
  assert.doesNotMatch(JSON.stringify(session), /endpoint|authToken|private-token|wss:/i);
  assert.doesNotMatch(JSON.stringify(ready), /endpoint|authToken|private-token|wss:/i);
  assert.ok(harness.inspectCalls.length >= 2, "activation and access must both inspect ownership");

  harness.runtimes.set(session.runtimeId, {
    runtimeId: session.runtimeId,
    ownerBotId: bot.botId,
    provider: session.provider,
    issuanceKey: "issuance-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "ready",
  });
  assert.equal(await controller.runtimeSession(bot.botId), null);
  assert.equal((await store.read(bot.botId)).runtime.lastErrorCode, "RUNTIME_ISSUANCE_MISMATCH");
});

test("rejects cross-bot runtime reuse before activation and leaves the first owner ready", async (t) => {
  const store = await temporaryStore(t);
  const botA = await store.create();
  const botB = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const first = await controller.ensureRuntime(botA.botId);
  const shared = first.runtime.remoteRuntimeId;
  harness.queueProvision(botB.botId, runtimeResult(botB.botId, {
    runtimeId: shared,
    endpoint: "wss://other.runtime.example.test/app-server",
  }));
  harness.inspectHook = ({ runtimeId }) => ({ runtimeId, ownerBotId: botB.botId, state: "ready" });

  await assert.rejects(
    () => controller.ensureRuntime(botB.botId),
    /already belongs to another bot/i,
  );

  assert.equal((await controller.readBot(botA.botId)).runtime.state, "ready");
  const rejected = await controller.readBot(botB.botId);
  assert.equal(rejected.runtime.state, "failed");
  assert.equal(rejected.runtime.remoteRuntimeId, null);
  assert.equal(rejected.runtime.lastErrorCode, "RUNTIME_ALREADY_OWNED");
  assert.equal(await controller.runtimeSession(botB.botId), null);
});

test("rejects owner, endpoint, and stale-inspection mismatches without exposing a session", async (t) => {
  await t.test("provider owner mismatch", async (t) => {
    const store = await temporaryStore(t);
    const bot = await store.create();
    const harness = new ProviderHarness();
    harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
      ownerBotId: "bot-wrong-owner",
      authToken: "private-owner-mismatch-token",
    }));
    const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
    t.after(() => controller.dispose());

    const error = await controller.ensureRuntime(bot.botId).then(() => null, (failure) => failure);
    assert.ok(error instanceof Error);
    assert.match(error.message, /owner|provider/i);
    assert.doesNotMatch(error.message, /private-owner|wss:/i);
    const failed = await controller.readBot(bot.botId);
    assert.equal(failed.runtime.state, "failed");
    assert.equal(await controller.runtimeSession(bot.botId), null);
  });

  await t.test("same-runtime successor is fenced by issuance identity", async (t) => {
    const store = await temporaryStore(t);
    const bot = await store.create();
    const harness = new ProviderHarness();
    const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
    t.after(() => controller.dispose());
    const first = await controller.ensureRuntime(bot.botId);
    harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
      runtimeId: first.runtime.remoteRuntimeId,
      endpoint: "wss://changed.runtime.example.test/app-server",
      authToken: "private-rotated-token",
    }));

    const rotated = await controller.retryRuntime(bot.botId);
    assert.equal(rotated.runtime.remoteRuntimeId, first.runtime.remoteRuntimeId);
    assert.equal(rotated.runtime.state, "ready");
    assert.notEqual(harness.provisionCalls.at(-1).issuanceKey, harness.provisionCalls[0].issuanceKey);
    const session = await controller.runtimeSession(bot.botId);
    assert.equal(session.authToken, "private-rotated-token");
  });

  await t.test("inspection is not ready", async (t) => {
    const store = await temporaryStore(t);
    const bot = await store.create();
    const harness = new ProviderHarness();
    harness.inspectHook = ({ runtimeId }) => ({ runtimeId, ownerBotId: bot.botId, state: "reconnecting" });
    const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
    t.after(() => controller.dispose());

    await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
    assert.deepEqual(harness.retireCalls, [{ runtimeId: runtimeResult(bot.botId).runtimeId }]);
    const pending = await controller.readBot(bot.botId);
    assert.equal(pending.runtime.state, "failed");
    assert.equal(pending.runtime.remoteRuntimeId, null);
    assert.equal(await controller.runtimeSession(bot.botId), null);
  });
});

test("runtimeSession clears stale ownership and transitions the persisted record before emitting", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await controller.ensureRuntime(bot.botId);
  const events = [];
  controller.on("runtime-changed", (event) => events.push(event));
  harness.inspectHook = ({ runtimeId }) => ({ runtimeId, ownerBotId: "bot-someone-else", state: "ready" });

  assert.equal(await controller.runtimeSession(bot.botId), null);

  const persisted = await controller.readBot(bot.botId);
  assert.equal(persisted.runtime.state, "failed");
  assert.equal(persisted.runtime.lastErrorCode, "RUNTIME_ISSUANCE_MISMATCH");
  assert.equal(events.at(-1).runtime.state, "failed");
  assert.deepEqual(events.at(-1).runtime, persisted.runtime);
  assert.doesNotMatch(JSON.stringify(events.at(-1)), /endpoint|authToken|diagnostic/i);
});

test("retry rotates only after retiring the old runtime and suppresses old-runtime events", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const initial = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = initial.runtime.remoteRuntimeId;
  const newRuntime = runtimeResult(bot.botId, {
    runtimeId: `rotated-${bot.botId.slice(-12)}`,
    endpoint: "wss://rotated.runtime.example.test/app-server",
    authToken: "private-rotated-token",
  });
  harness.queueProvision(bot.botId, newRuntime);
  harness.order.length = 0;
  const runtimeEvents = [];
  controller.on("runtime-changed", (event) => runtimeEvents.push(event));

  const rotated = await controller.retryRuntime(bot.botId);

  assert.equal(rotated.runtime.remoteRuntimeId, newRuntime.runtimeId);
  assert.deepEqual(harness.order, [
    `provision:${newRuntime.runtimeId}`,
    `inspect:${newRuntime.runtimeId}`,
    `inspect:${oldRuntimeId}`,
    `retire:${oldRuntimeId}`,
    `inspect:${oldRuntimeId}`,
  ]);
  const detachedIndex = runtimeEvents.findIndex((event) => (
    event.runtime.remoteRuntimeId === oldRuntimeId && event.runtime.state === "detached"
  ));
  const readyIndex = runtimeEvents.findIndex((event) => (
    event.runtime.remoteRuntimeId === newRuntime.runtimeId && event.runtime.state === "ready"
  ));
  assert.equal(detachedIndex, -1);
  assert.ok(readyIndex >= 0);
  const beforeStale = runtimeEvents.length;
  harness.emit({ runtimeId: oldRuntimeId, state: "reconnecting", providerDiagnostic: "must-not-leak" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeEvents.length, beforeStale);
  assert.equal((await controller.runtimeSession(bot.botId)).runtimeId, newRuntime.runtimeId);
});

test("rotation retirement failure activates neither replacement and attempts replacement cleanup", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const initial = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = initial.runtime.remoteRuntimeId;
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `replacement-${bot.botId.slice(-12)}`,
    endpoint: "wss://replacement.runtime.example.test/app-server",
    authToken: "private-replacement-token",
  });
  harness.queueProvision(bot.botId, replacement);
  harness.order.length = 0;
  harness.retireHook = ({ runtimeId }) => {
    if (runtimeId === oldRuntimeId) throw new Error("private retirement diagnostic");
    return { runtimeId, state: "retired" };
  };

  const error = await controller.retryRuntime(bot.botId).then(() => null, (failure) => failure);

  assert.ok(error instanceof Error);
  assert.match(error.message, /failed|retire/i);
  assert.doesNotMatch(error.message, /private retirement|private-replacement|wss:/i);
  assert.deepEqual(harness.order, [
    `provision:${replacement.runtimeId}`,
    `inspect:${replacement.runtimeId}`,
    `inspect:${oldRuntimeId}`,
    `retire:${oldRuntimeId}`,
    `retire:${oldRuntimeId}`,
    `inspect:${oldRuntimeId}`,
    `inspect:${replacement.runtimeId}`,
    `retire:${replacement.runtimeId}`,
    `inspect:${replacement.runtimeId}`,
  ]);
  const failed = await controller.readBot(bot.botId);
  assert.equal(failed.runtime.remoteRuntimeId, oldRuntimeId);
  assert.equal(failed.runtime.state, "failed");
  assert.equal(failed.runtime.lastErrorCode, "RUNTIME_PROVISION_FAILED");
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("restart reconcile keeps legacy unfenced runtime unavailable without provider calls", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const persistedRuntime = runtimeResult(bot.botId);
  await store.updateRuntime(bot.botId, {
    provider: persistedRuntime.provider,
    remoteRuntimeId: persistedRuntime.runtimeId,
    state: "ready",
    lastConfirmedAt: NOW,
    lastErrorCode: null,
  });
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  const reconciled = await controller.reconcile();
  const session = await controller.runtimeSession(bot.botId);

  assert.equal(reconciled[0].runtime.state, "unavailable");
  assert.equal(reconciled[0].runtime.lastErrorCode, "RUNTIME_LEGACY_UNFENCED");
  assert.equal(session, null);
  assert.deepEqual(harness.provisionCalls, []);
  assert.doesNotMatch(JSON.stringify(reconciled), /endpoint|authToken|private-token|wss:/i);
});

test("restart reconcile stays unavailable when private session recovery is not authorized", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  await store.updateRuntime(bot.botId, {
    provider: "authorized-test-provider",
    remoteRuntimeId: `runtime-${bot.botId.slice(-12)}`,
    state: "ready",
    lastConfirmedAt: NOW,
    lastErrorCode: null,
  });
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());

  const reconciled = await controller.reconcile();

  assert.equal(reconciled[0].runtime.state, "unavailable");
  assert.equal(reconciled[0].runtime.lastErrorCode, "REMOTE_PROVIDER_UNAVAILABLE");
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("provider state events are scoped, persisted before emission, sanitized, and stopped on dispose", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  const events = [];
  controller.on("runtime-changed", async (event) => {
    const record = { event, persisted: null };
    events.push(record);
    await new Promise((resolve) => setImmediate(resolve));
    record.persisted = await store.read(event.botId);
  });

  harness.emit({
    runtimeId,
    state: "reconnecting",
    providerDiagnostic: "private provider stack",
    endpoint: "not-a-session-field",
  });
  await waitFor(() => events.length === 1 && events[0].persisted, "current runtime event was not emitted");

  assert.equal(events[0].event.botId, bot.botId);
  assert.equal(events[0].event.runtime.state, "reconnecting");
  assert.equal(events[0].persisted.runtime.state, "reconnecting");
  assert.equal(events[0].event.generation, 1);
  assertDeepFrozen(events[0].event);
  assert.doesNotMatch(JSON.stringify(events[0].event), /providerDiagnostic|private provider|endpoint|authToken|issuanceKey/i);
  assert.equal(await controller.runtimeSession(bot.botId), null);

  const retained = harness.retainedSubscribers[0];
  controller.dispose();
  retained({ runtimeId, state: "failed", authToken: "late-secret-must-not-be-read" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal((await controller.readBot(bot.botId)).runtime.state, "reconnecting");
  assert.doesNotThrow(() => controller.dispose());
});

test("same-index concurrent retries cannot rotate twice and session generations increase only on activation", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  let inspectCount = 0;
  harness.inspectHook = ({ runtimeId }) => {
    inspectCount += 1;
    if (inspectCount === 1) return { runtimeId, ownerBotId: bot.botId, state: "reconnecting" };
    const runtime = harness.runtimes.get(runtimeId);
    return { runtimeId, ownerBotId: bot.botId, state: runtime?.state || "retired" };
  };
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  const gate = deferred();
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `second-${bot.botId.slice(-12)}`,
    endpoint: "wss://second.runtime.example.test/app-server",
    authToken: "private-second-token",
  });
  harness.queueProvision(bot.botId, async () => {
    await gate.promise;
    return replacement;
  });
  const before = harness.provisionCalls.length;
  const firstRetry = controller.retryRuntime(bot.botId);
  const secondRetry = controller.retryRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === before + 1, "retry provision did not begin");
  gate.resolve();
  const [a, b] = await Promise.all([firstRetry, secondRetry]);

  assert.equal(harness.provisionCalls.length, before + 1);
  assert.equal(a.runtime.remoteRuntimeId, replacement.runtimeId);
  assert.deepEqual(a, b);
  const session = await controller.runtimeSession(bot.botId);
  assert.equal(session.generation, 1);
});

test("case-variant bot IDs share the same in-flight provision boundary", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const gate = deferred();
  harness.queueProvision(bot.botId, async () => {
    await gate.promise;
    return runtimeResult(bot.botId);
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const uppercaseBotId = bot.botId.toUpperCase();
  const upper = controller.ensureRuntime(uppercaseBotId);
  const lower = controller.ensureRuntime(bot.botId);

  await waitFor(() => harness.provisionCalls.length >= 1, "provision did not begin");
  await new Promise((resolve) => setTimeout(resolve, 25));
  const callsWhileBlocked = harness.provisionCalls.length;
  gate.resolve();
  const settled = await Promise.allSettled([upper, lower]);
  assert.equal(callsWhileBlocked, 1);
  assert.equal(settled[0].status, "fulfilled");
  assert.equal(settled[1].status, "fulfilled");
  const [a, b] = settled.map(({ value }) => value);
  assert.deepEqual(a, b);
  assert.equal(harness.provisionCalls.length, 1);
});

test("persisted ready metadata without a private session transitions fail-closed", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const persisted = runtimeResult(bot.botId);
  await store.updateRuntime(bot.botId, {
    provider: persisted.provider,
    remoteRuntimeId: persisted.runtimeId,
    state: "ready",
    lastConfirmedAt: NOW,
    lastErrorCode: null,
  });
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const events = [];
  controller.on("runtime-changed", (event) => events.push(event));

  assert.equal(await controller.runtimeSession(bot.botId), null);

  const current = await controller.readBot(bot.botId);
  assert.equal(current.runtime.state, "reconnecting");
  assert.equal(current.runtime.lastErrorCode, "RUNTIME_SESSION_MISSING");
  assert.equal(events.at(-1).runtime.state, "reconnecting");
});

test("ensure does not provision a replacement after inspection reports reconnecting", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  let inspectCount = 0;
  harness.inspectHook = ({ runtimeId }) => {
    inspectCount += 1;
    if (inspectCount % 2 === 1) return { runtimeId, ownerBotId: bot.botId, state: "reconnecting" };
    const runtime = harness.runtimes.get(runtimeId);
    return { runtimeId, ownerBotId: bot.botId, state: runtime?.state || "retired" };
  };
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  const provisionCount = harness.provisionCalls.length;
  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });

  assert.equal(harness.provisionCalls.length, provisionCount + 1);
  assert.equal((await store.readRuntimeIssuances(bot.botId)).length, 0);
  const current = await controller.readBot(bot.botId);
  assert.equal(current.runtime.state, "failed");
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("runtimeSession cannot return a captured session after a concurrent rotation", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const initial = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = initial.runtime.remoteRuntimeId;
  const oldInspection = deferred();
  let oldInspectionBlocked = false;
  harness.inspectHook = ({ runtimeId }) => {
    if (runtimeId === oldRuntimeId && !oldInspectionBlocked) {
      oldInspectionBlocked = true;
      return oldInspection.promise;
    }
    return { ...harness.runtimes.get(runtimeId) };
  };
  const capturedSession = controller.runtimeSession(bot.botId);
  await waitFor(() => oldInspectionBlocked, "stale session inspection did not begin");
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `race-replacement-${bot.botId.slice(-12)}`,
    endpoint: "wss://race-replacement.runtime.example.test/app-server",
    authToken: "private-race-replacement-token",
  });
  harness.queueProvision(bot.botId, replacement);

  const rotated = await controller.retryRuntime(bot.botId);
  oldInspection.resolve({ runtimeId: oldRuntimeId, ownerBotId: bot.botId, state: "ready" });

  assert.equal(await capturedSession, null);
  const current = await controller.runtimeSession(bot.botId);
  assert.equal(current.runtimeId, rotated.runtime.remoteRuntimeId);
  assert.equal(current.generation, 2);
});

test("non-ready rotation retires only the replacement and preserves the old disabled record", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const initial = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = initial.runtime.remoteRuntimeId;
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `pending-replacement-${bot.botId.slice(-12)}`,
    endpoint: "wss://pending-replacement.runtime.example.test/app-server",
    authToken: "private-pending-replacement-token",
    state: "provisioning",
  });
  harness.queueProvision(bot.botId, replacement);
  harness.retireCalls.length = 0;

  await assert.rejects(() => controller.retryRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });

  assert.deepEqual(harness.retireCalls, [{ runtimeId: replacement.runtimeId }]);
  const pending = await controller.readBot(bot.botId);
  assert.equal(pending.runtime.remoteRuntimeId, oldRuntimeId);
  assert.equal(pending.runtime.state, "failed");
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("a first-ever non-ready issuance retires exactly and a retry creates a new issuance", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    state: "provisioning",
    authToken: "private-candidate-first-token",
  });
  harness.queueProvision(bot.botId, candidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  const pending = await controller.readBot(bot.botId);
  assert.equal(pending.runtime.remoteRuntimeId, null);
  assert.equal(pending.runtime.state, "failed");
  assert.equal(await controller.runtimeSession(bot.botId), null);
  assert.deepEqual(harness.retireCalls, [{ runtimeId: candidate.runtimeId }]);
  assert.deepEqual(await store.readRuntimeIssuances(bot.botId), []);
  assert.doesNotMatch(JSON.stringify(pending), /private-candidate|endpoint|authToken|wss:/i);

  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId: candidate.runtimeId,
    endpoint: candidate.endpoint,
    authToken: "private-candidate-recovered-token",
  }));
  const recovered = await controller.ensureRuntime(bot.botId);
  const session = await controller.runtimeSession(bot.botId);

  assert.equal(recovered.runtime.state, "ready");
  assert.equal(session.runtimeId, candidate.runtimeId);
  assert.equal(session.authToken, "private-candidate-recovered-token");
  assert.notEqual(harness.provisionCalls[0].issuanceKey, harness.provisionCalls[1].issuanceKey);
  assert.deepEqual(harness.provisionCalls.map(({ idempotencyKey }) => idempotencyKey), [
    `codex-bot:${bot.botId}`,
    `codex-bot:${bot.botId}`,
  ]);
});

test("post-provision failures clean only safely owned distinct candidates", async (t) => {
  await t.test("inspection failure does not retire a replacement without authoritative ownership proof", async (t) => {
    const store = await temporaryStore(t);
    const bot = await store.create();
    const harness = new ProviderHarness();
    const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
    t.after(() => controller.dispose());
    const initial = await controller.ensureRuntime(bot.botId);
    const oldRuntimeId = initial.runtime.remoteRuntimeId;
    const replacement = runtimeResult(bot.botId, {
      runtimeId: `inspect-failure-${bot.botId.slice(-12)}`,
      endpoint: "wss://inspect-failure.runtime.example.test/app-server",
      authToken: "private-inspect-failure-token",
    });
    harness.queueProvision(bot.botId, replacement);
    harness.inspectHook = ({ runtimeId }) => {
      if (runtimeId === replacement.runtimeId) throw new Error("private inspect failure");
      return { ...harness.runtimes.get(runtimeId) };
    };
    harness.retireCalls.length = 0;

    await assert.rejects(() => controller.retryRuntime(bot.botId), /provider failed/i);

    assert.deepEqual(harness.retireCalls, []);
    const failed = await controller.readBot(bot.botId);
    assert.equal(failed.runtime.remoteRuntimeId, oldRuntimeId);
    assert.equal(failed.runtime.state, "failed");
    assert.equal(await controller.runtimeSession(bot.botId), null);
  });

  await t.test("owner mismatch never retires a possibly other-bot runtime", async (t) => {
    const store = await temporaryStore(t);
    const bot = await store.create();
    const harness = new ProviderHarness();
    const foreign = runtimeResult(bot.botId, {
      runtimeId: `foreign-${bot.botId.slice(-12)}`,
      ownerBotId: "bot-foreign-owner",
      authToken: "private-foreign-token",
    });
    harness.queueProvision(bot.botId, foreign);
    const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
    t.after(() => controller.dispose());

    await assert.rejects(() => controller.ensureRuntime(bot.botId), /owner|provider/i);

    assert.deepEqual(harness.retireCalls, []);
  });

  await t.test("activation-store failure retires replacement after old runtime retirement", async (t) => {
    const realStore = await temporaryStore(t);
    const bot = await realStore.create();
    let replacementRuntimeId = null;
    let failActivation = false;
    const store = forwardingStore(realStore, {
      runtimeTransaction: interceptRuntimeUpdates(realStore, ({ patch, update }) => {
        if (failActivation && patch.state === "ready" && patch.remoteRuntimeId === replacementRuntimeId) {
          throw new Error("forced activation store failure");
        }
        return update();
      }),
      promoteRuntimeIssuance: async (botId, input) => {
        if (failActivation && input.runtimeId === replacementRuntimeId) {
          throw new Error("forced activation store failure");
        }
        return realStore.promoteRuntimeIssuance(botId, input);
      },
    });
    const harness = new ProviderHarness();
    const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
    t.after(() => controller.dispose());
    const initial = await controller.ensureRuntime(bot.botId);
    const oldRuntimeId = initial.runtime.remoteRuntimeId;
    const replacement = runtimeResult(bot.botId, {
      runtimeId: `activation-failure-${bot.botId.slice(-12)}`,
      endpoint: "wss://activation-failure.runtime.example.test/app-server",
      authToken: "private-activation-failure-token",
    });
    replacementRuntimeId = replacement.runtimeId;
    harness.queueProvision(bot.botId, replacement);
    harness.retireCalls.length = 0;
    failActivation = true;

    await assert.rejects(() => controller.retryRuntime(bot.botId), /provider failed/i);

    assert.deepEqual(harness.retireCalls, [
      { runtimeId: oldRuntimeId },
      { runtimeId: replacement.runtimeId },
    ]);
    const failed = await controller.readBot(bot.botId);
    assert.equal(failed.runtime.remoteRuntimeId, oldRuntimeId);
    assert.equal(failed.runtime.state, "failed");
    assert.equal(await controller.runtimeSession(bot.botId), null);
  });
});

test("rotation never retires an old runtime whose current inspection reports a foreign owner", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const initial = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = initial.runtime.remoteRuntimeId;
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `foreign-old-rotation-${bot.botId.slice(-12)}`,
    endpoint: "wss://foreign-old-rotation.runtime.example.test/app-server",
    authToken: "private-foreign-old-rotation-token",
  });
  harness.queueProvision(bot.botId, replacement);
  harness.inspectHook = ({ runtimeId }) => {
    if (runtimeId === oldRuntimeId) {
      return { runtimeId, ownerBotId: "bot-authoritative-foreign-owner", state: "ready" };
    }
    return { runtimeId, ownerBotId: bot.botId, state: "ready" };
  };
  harness.retireCalls.length = 0;

  await assert.rejects(
    () => controller.retryRuntime(bot.botId),
    (error) => error?.code === "RUNTIME_RETIRE_FAILED",
  );

  assert.deepEqual(harness.retireCalls, [{ runtimeId: replacement.runtimeId }]);
  const failed = await store.read(bot.botId);
  assert.equal(failed.runtime.provider, "authorized-test-provider");
  assert.equal(failed.runtime.remoteRuntimeId, oldRuntimeId);
  assert.equal(failed.runtime.state, "failed");
  assert.equal(failed.runtime.lastErrorCode, "RUNTIME_RETIRE_FAILED");
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("candidate cleanup re-inspects ownership immediately before retirement", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  let replacementRuntimeId = null;
  let failActivation = false;
  const store = forwardingStore(realStore, {
    runtimeTransaction: interceptRuntimeUpdates(realStore, ({ patch, update }) => {
      if (failActivation && patch.state === "ready" && patch.remoteRuntimeId === replacementRuntimeId) {
        throw new Error("forced activation store failure");
      }
      return update();
    }),
  });
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const initial = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = initial.runtime.remoteRuntimeId;
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `stale-cleanup-${bot.botId.slice(-12)}`,
    endpoint: "wss://stale-cleanup.runtime.example.test/app-server",
    authToken: "private-stale-cleanup-token",
  });
  replacementRuntimeId = replacement.runtimeId;
  harness.queueProvision(bot.botId, replacement);
  let replacementInspections = 0;
  harness.inspectHook = ({ runtimeId }) => {
    if (runtimeId === replacement.runtimeId) {
      replacementInspections += 1;
      return {
        runtimeId,
        ownerBotId: replacementInspections === 1
          ? bot.botId
          : "bot-authoritative-foreign-owner",
        state: "ready",
      };
    }
    return { runtimeId, ownerBotId: bot.botId, state: "ready" };
  };
  harness.retireCalls.length = 0;
  failActivation = true;

  await assert.rejects(() => controller.retryRuntime(bot.botId), /provider failed|previous remote runtime retirement failed/i);

  assert.equal(replacementInspections, 2);
  assert.deepEqual(harness.retireCalls, [{ runtimeId: oldRuntimeId }]);
  const failed = await realStore.read(bot.botId);
  assert.equal(failed.runtime.remoteRuntimeId, oldRuntimeId);
  assert.equal(failed.runtime.state, "failed");
});

test("provider events queue behind active work and expose every current frame in order", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  const inspectionGate = deferred();
  let blocked = false;
  harness.inspectHook = async ({ runtimeId: inspectedRuntimeId }) => {
    if (inspectedRuntimeId === runtimeId && !blocked) {
      blocked = true;
      await inspectionGate.promise;
    }
    return { ...harness.runtimes.get(inspectedRuntimeId) };
  };
  const events = [];
  controller.on("runtime-event", (event) => events.push(event));
  const activeEnsure = controller.ensureRuntime(bot.botId);
  await waitFor(() => blocked, "active ownership inspection did not block");

  harness.emit({
    runtimeId,
    type: "computer/frame",
    sequence: 1,
    endpoint: "wss://must-not-forward.example.test/app-server",
    payload: { frame: "one" },
  });
  harness.emit({
    runtimeId,
    type: "computer/frame",
    sequence: 2,
    payload: { frame: "two" },
  });
  inspectionGate.resolve();
  await activeEnsure;
  await waitFor(() => events.length === 2, "queued runtime events were not delivered");

  assert.deepEqual(events.map(({ event }) => event.sequence), [1, 2]);
  for (const event of events) {
    assert.equal(event.botId, bot.botId);
    assert.equal(event.runtime.remoteRuntimeId, runtimeId);
    assert.equal(event.runtime.state, "ready");
    assert.equal(event.generation, 1);
    assertDeepFrozen(event);
    assert.doesNotMatch(JSON.stringify(event), /endpoint|authToken|must-not-forward|private-token|wss:/i);
  }
});

test("bot events back off through consecutive other-bot transactions then deliver frames and failure once in order", async (t) => {
  const realStore = await temporaryStore(t);
  const botA = await realStore.create();
  const botB = await realStore.create();
  const harness = new ProviderHarness();
  const originalRead = realStore.read.bind(realStore);
  let countEventReads = false;
  let eventReadAttempts = 0;
  realStore.read = (...args) => {
    if (countEventReads && String(args[0]).toLowerCase() === botB.botId) eventReadAttempts += 1;
    return originalRead(...args);
  };
  const controller = new BotRuntimeController({ store: realStore, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await controller.ensureRuntime(botA.botId);
  const readyB = await controller.ensureRuntime(botB.botId);
  const runtimeIdB = readyB.runtime.remoteRuntimeId;
  const frames = [];
  const changed = [];
  const deliveryOrder = [];
  controller.on("runtime-event", (event) => {
    frames.push(event);
    deliveryOrder.push(`frame:${event.event.sequence}`);
  });
  controller.on("runtime-changed", (event) => {
    if (event.botId !== botB.botId) return;
    changed.push(event);
    if (event.runtime.state === "failed") deliveryOrder.push("state:failed");
  });
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const firstTransaction = realStore.runtimeTransaction(botA.botId, {}, async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;
  countEventReads = true;

  harness.emit({
    runtimeId: runtimeIdB,
    type: "computer/frame",
    sequence: 801,
    payload: {
      frame: "first-after-busy",
      providerDiagnostic: "private-busy-frame-diagnostic",
    },
  });
  harness.emit({
    runtimeId: runtimeIdB,
    type: "computer/frame",
    sequence: 802,
    payload: { frame: "second-after-busy" },
  });
  harness.emit({
    runtimeId: runtimeIdB,
    type: "runtime/state",
    state: "failed",
    providerDiagnostics: { stack: "private-terminal-provider-stack" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(frames, []);
  assert.deepEqual(changed, []);

  await waitFor(() => eventReadAttempts >= 3, "event did not retry the first active transaction with backoff");
  const firstOwnerAttempts = eventReadAttempts;
  assert.ok(firstOwnerAttempts <= 10, `event retry spun ${firstOwnerAttempts} times on one owner`);
  releaseFirst.resolve();
  await firstTransaction;
  const secondEntered = deferred();
  const releaseSecond = deferred();
  const secondTransaction = realStore.runtimeTransaction(botA.botId, {}, async () => {
    secondEntered.resolve();
    await releaseSecond.promise;
  });
  await secondEntered.promise;
  await waitFor(
    () => eventReadAttempts >= firstOwnerAttempts + 2,
    "event did not retry the consecutive transaction with backoff",
  );
  assert.ok(
    eventReadAttempts <= firstOwnerAttempts + 8,
    `event retry spun ${eventReadAttempts - firstOwnerAttempts} times on the second owner`,
  );
  assert.deepEqual(frames, []);
  releaseSecond.resolve();
  await secondTransaction;
  await waitFor(
    () => changed.some((event) => event.runtime.state === "failed"),
    "terminal event was not replayed after both transactions released",
  );

  assert.deepEqual(frames.map(({ event }) => event.sequence), [801, 802]);
  assert.deepEqual(deliveryOrder, ["frame:801", "frame:802", "state:failed"]);
  assert.deepEqual(harness.retireCalls, [{ runtimeId: runtimeIdB }]);
  assert.equal(changed.filter((event) => event.runtime.state === "failed").length, 1);
  const failed = await readAfterRuntimeTransaction(realStore, botB.botId);
  assert.equal(failed.runtime.provider, null);
  assert.equal(failed.runtime.remoteRuntimeId, null);
  assert.equal(failed.runtime.state, "failed");
  assert.equal(failed.runtime.lastErrorCode, "RUNTIME_PROVIDER_EVENT");
  assert.equal(await controller.runtimeSession(botB.botId), null);
  assert.doesNotMatch(
    JSON.stringify({ frames, changed }),
    /BOT_STORE_|bots\.json|endpoint|authToken|provider.?diagnostic|private-busy|private-terminal/i,
  );

  harness.emit({ runtimeId: runtimeIdB, type: "computer/frame", sequence: 803 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(frames.map(({ event }) => event.sequence), [801, 802]);
});

test("provider-originated cross-bot frames inherited from a transaction retry once the transaction exits", async (t) => {
  const store = await temporaryStore(t);
  const botA = await store.create();
  const botB = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const readyA = await controller.ensureRuntime(botA.botId);
  const readyB = await controller.ensureRuntime(botB.botId);
  const replacementA = runtimeResult(botA.botId, {
    runtimeId: `provider-origin-replacement-${botA.botId.slice(-12)}`,
    endpoint: "wss://provider-origin-replacement.runtime.example.test/app-server",
    authToken: "private-provider-origin-replacement-token",
  });
  harness.queueProvision(botA.botId, replacementA);
  const frames = [];
  controller.on("runtime-event", (event) => frames.push(event));
  let emitted = false;
  harness.inspectHook = ({ runtimeId }) => {
    if (!emitted && runtimeId === readyA.runtime.remoteRuntimeId) {
      emitted = true;
      harness.emit({
        runtimeId: readyB.runtime.remoteRuntimeId,
        type: "computer/frame",
        sequence: 901,
        payload: {
          frame: "provider-originated-frame",
          providerDiagnostic: "private-provider-origin-diagnostic",
        },
      });
    }
    return { ...harness.runtimes.get(runtimeId) };
  };

  const rotated = await controller.retryRuntime(botA.botId);
  await waitFor(() => frames.length === 1, "provider-originated cross-bot frame was swallowed");

  assert.equal(emitted, true);
  assert.equal(rotated.runtime.remoteRuntimeId, replacementA.runtimeId);
  assert.deepEqual(frames.map(({ event }) => event.sequence), [901]);
  assert.equal(frames[0].botId, botB.botId);
  assert.doesNotMatch(JSON.stringify(frames), /provider.?diagnostic|private-provider-origin|endpoint|authToken/i);
});

test("failed events stage before retirement and clear after a retire-triggered other-bot transaction", async (t) => {
  const realStore = await temporaryStore(t);
  const botA = await realStore.create();
  const botB = await realStore.create();
  const harness = new ProviderHarness();
  const blockerEntered = deferred();
  const releaseBlocker = deferred();
  let retireFinished = false;
  let blockerTransaction = null;
  const store = forwardingStore(realStore, {
    runtimeTransaction: async (...args) => {
      if (retireFinished && !blockerTransaction) {
        blockerTransaction = realStore.runtimeTransaction(botA.botId, {}, async () => {
          blockerEntered.resolve();
          await releaseBlocker.promise;
        });
        await blockerEntered.promise;
      }
      return realStore.runtimeTransaction(...args);
    },
    completeRuntimeIssuance: async (...args) => {
      if (retireFinished && !blockerTransaction) {
        blockerTransaction = realStore.runtimeTransaction(botA.botId, {}, async () => {
          blockerEntered.resolve();
          await releaseBlocker.promise;
        });
        await blockerEntered.promise;
      }
      return realStore.completeRuntimeIssuance(...args);
    },
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await controller.ensureRuntime(botA.botId);
  const readyB = await controller.ensureRuntime(botB.botId);
  const runtimeIdB = readyB.runtime.remoteRuntimeId;
  const changed = [];
  controller.on("runtime-changed", (event) => {
    if (event.botId === botB.botId) changed.push(event);
  });
  harness.retireHook = async ({ runtimeId }) => {
    if (runtimeId !== runtimeIdB) return { runtimeId, state: "retired" };
    const runtime = harness.runtimes.get(runtimeId);
    if (runtime) runtime.state = "retired";
    retireFinished = true;
    return { runtimeId, state: "retired" };
  };

  harness.emit({
    runtimeId: runtimeIdB,
    type: "runtime/state",
    state: "failed",
    providerDiagnostic: "private-terminal-diagnostic",
  });
  await blockerEntered.promise;
  assert.deepEqual(harness.retireCalls, [{ runtimeId: runtimeIdB }]);
  assert.deepEqual(changed, []);
  releaseBlocker.resolve();
  await blockerTransaction;
  await waitFor(
    () => changed.some((event) => event.runtime.state === "failed"),
    "staged terminal event did not clear after the blocking transaction",
  );

  const failed = await readAfterRuntimeTransaction(realStore, botB.botId);
  assert.equal(failed.runtime.provider, null);
  assert.equal(failed.runtime.remoteRuntimeId, null);
  assert.equal(failed.runtime.state, "failed");
  assert.equal(failed.runtime.lastErrorCode, "RUNTIME_PROVIDER_EVENT");
  assert.equal(await controller.runtimeSession(botB.botId), null);
  assert.deepEqual(harness.retireCalls, [{ runtimeId: runtimeIdB }]);
  assert.equal(changed.filter((event) => event.runtime.state === "failed").length, 1);
  assert.equal(changed.some((event) => (
    event.runtime.state === "ready" && event.runtime.remoteRuntimeId === null
  )), false);
  assert.doesNotMatch(
    JSON.stringify(changed),
    /BOT_STORE_|bots\.json|provider.?diagnostic|private-terminal|endpoint|authToken/i,
  );
});

test("a successor injected before terminal retirement proof prevents retirement and every successor write", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const successorRuntimeId = `terminal-successor-${bot.botId.slice(-12)}`;
  let injectionStarted = false;
  const injectionComplete = deferred();
  let inspectCount = 0;
  harness.inspectHook = async ({ runtimeId }) => {
    inspectCount += 1;
    if (!injectionStarted && inspectCount === 3) {
      injectionStarted = true;
      try {
        const active = (await realStore.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active");
        await installIssuedSuccessor(realStore, harness, bot.botId, {
          previousIssuanceKey: active.issuanceKey,
          issuanceKey: TEST_ISSUANCE_B,
          retirementKey: TEST_RETIREMENT_B,
          runtimeId: successorRuntimeId,
        });
        await new Promise((resolve) => setImmediate(resolve));
        injectionComplete.resolve();
      } catch (error) {
        injectionComplete.reject(error);
        throw error;
      }
    }
    return { runtimeId, ownerBotId: bot.botId, state: "ready" };
  };
  const store = realStore;
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = ready.runtime.remoteRuntimeId;
  harness.retireCalls.length = 0;

  harness.emit({ runtimeId: oldRuntimeId, type: "runtime/state", state: "failed" });
  await injectionComplete.promise;
  const persisted = await waitForStoreBot(
    realStore,
    bot.botId,
    (current) => current?.runtime.remoteRuntimeId === successorRuntimeId
      && current.runtime.state === "ready",
    "durable successor was not visible after the terminal race",
  );
  assert.deepEqual(harness.retireCalls, []);
  assert.equal(persisted.runtime.provider, "authorized-test-provider");
  assert.equal(persisted.runtime.remoteRuntimeId, successorRuntimeId);
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.lastErrorCode, null);
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("a fresh same-ID successor between terminal proof and clear invalidates the predecessor token", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-proof-successor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const realStore = new BotStore({ filePath, now: () => NOW });
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const runtimeId = `terminal-proof-successor-${bot.botId.slice(-12)}`;
  const endpoint = "wss://terminal-proof-successor.runtime.example.test/app-server";
  harness.queueProvision(
    bot.botId,
    runtimeResult(bot.botId, {
      runtimeId,
      endpoint,
      authToken: "private-terminal-proof-token-one",
    }),
    runtimeResult(bot.botId, {
      runtimeId,
      endpoint,
      authToken: "private-terminal-proof-token-two",
    }),
  );
  let interceptTerminal = false;
  let expectedMarkerTransactions = 0;
  let successor = null;
  let successorReady = null;
  const predecessorStore = forwardingStore(realStore, {
    runtimeTransaction: async (botId, options, operation) => {
      const outcome = await realStore.runtimeTransaction(botId, options, operation);
      if (interceptTerminal
        && typeof options?.expectedLastErrorCode === "string"
        && options.expectedLastErrorCode.startsWith("RUNTIME_OPERATION.")
        && ++expectedMarkerTransactions === 1) {
        successorReady = await successor.retryRuntime(bot.botId);
      }
      return outcome;
    },
  });
  const predecessor = new BotRuntimeController({
    store: predecessorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  successor = new BotRuntimeController({
    store: new BotStore({ filePath, now: () => NOW }),
    provider: harness.provider(),
    now: () => NOW,
  });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());
  await predecessor.ensureRuntime(bot.botId);
  const predecessorEvents = [];
  predecessor.on("runtime-changed", (event) => predecessorEvents.push(event));
  interceptTerminal = true;

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(() => successorReady !== null, "same-ID successor was not installed after terminal proof");
  await new Promise((resolve) => setTimeout(resolve, 40));

  const predecessorSession = await predecessor.runtimeSession(bot.botId);
  const successorSession = await successor.runtimeSession(bot.botId);
  const persisted = await new BotStore({ filePath }).read(bot.botId);
  assert.equal(successorReady.runtime.state, "ready");
  assert.equal(successorReady.runtime.remoteRuntimeId, runtimeId);
  assert.equal(predecessorSession, null);
  assert.equal(successorSession.authToken, "private-terminal-proof-token-two");
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, runtimeId);
  assert.deepEqual(harness.retireCalls, []);
  assert.equal(predecessorEvents.some((event) => event.runtime.state === "failed"), false);
});

test("a committed-uncertain terminal stage cannot preserve token one after a same-ID successor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-stage-uncertain-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const syncFailure = controllableDirectorySyncFailure(directory);
  const realStore = new BotStore({ filePath, fs: syncFailure.fs, now: () => NOW });
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const runtimeId = `terminal-stage-uncertain-${bot.botId.slice(-12)}`;
  const endpoint = "wss://terminal-stage-uncertain.runtime.example.test/app-server";
  harness.queueProvision(
    bot.botId,
    runtimeResult(bot.botId, {
      runtimeId,
      endpoint,
      authToken: "private-terminal-stage-token-one",
    }),
    runtimeResult(bot.botId, {
      runtimeId,
      endpoint,
      authToken: "private-terminal-stage-token-two",
    }),
  );
  let successor = null;
  let successorReady = null;
  let injectSuccessor = false;
  const predecessorStore = forwardingStore(realStore, {
    runtimeTransaction: async (...args) => {
      try {
        return await realStore.runtimeTransaction(...args);
      } catch (error) {
        if (injectSuccessor
          && !successorReady
          && error?.code === "BOT_STORE_DURABILITY_UNCERTAIN"
          && error?.committed === true) {
          successorReady = await successor.retryRuntime(bot.botId);
        }
        throw error;
      }
    },
  });
  const predecessor = new BotRuntimeController({
    store: predecessorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  successor = new BotRuntimeController({
    store: new BotStore({ filePath, now: () => NOW }),
    provider: harness.provider(),
    now: () => NOW,
  });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());
  await predecessor.ensureRuntime(bot.botId);
  const predecessorEvents = [];
  predecessor.on("runtime-changed", (event) => predecessorEvents.push(event));
  injectSuccessor = true;
  syncFailure.arm();

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(() => successorReady !== null, "same-ID successor was not installed after uncertain stage");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(syncFailure.failures(), 1);
  assert.equal(await predecessor.runtimeSession(bot.botId), null);
  assert.equal((await successor.runtimeSession(bot.botId)).authToken, "private-terminal-stage-token-two");
  assert.equal((await new BotStore({ filePath }).read(bot.botId)).runtime.state, "ready");
  assert.deepEqual(harness.retireCalls, []);
  assert.equal(predecessorEvents.some((event) => event.runtime.state === "failed"), false);
});

test("a current committed-uncertain terminal stage proceeds through its exact marker", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-stage-current-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const syncFailure = controllableDirectorySyncFailure(directory);
  const store = new BotStore({ filePath, fs: syncFailure.fs, now: () => NOW });
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  const changed = [];
  controller.on("runtime-changed", (event) => changed.push(event));
  const originalTransaction = store.runtimeTransaction.bind(store);
  store.runtimeTransaction = (botId, options, operation) => originalTransaction(
    botId,
    options,
    (transaction) => operation(Object.freeze({
      ...transaction,
      updateRuntime: (patch) => {
        if (patch.provider === undefined
          && patch.state === "failed"
          && typeof patch.lastErrorCode === "string"
          && patch.lastErrorCode.startsWith("RUNTIME_OPERATION.")) syncFailure.arm();
        return transaction.updateRuntime(patch);
      },
    })),
  );

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(
    () => changed.some((event) => event.runtime.state === "failed"),
    "committed-uncertain terminal stage did not reach finalization",
  );

  const persisted = await readAfterRuntimeTransaction(new BotStore({ filePath }), bot.botId);
  assert.equal(syncFailure.failures(), 1);
  assert.equal(persisted.runtime.provider, null);
  assert.equal(persisted.runtime.remoteRuntimeId, null);
  assert.equal(persisted.runtime.lastErrorCode, "RUNTIME_PROVIDER_EVENT");
  assert.equal(await controller.runtimeSession(bot.botId), null);
  assert.deepEqual(harness.retireCalls, [{ runtimeId }]);
  assert.equal(changed.filter((event) => event.runtime.state === "failed").length, 1);
});

test("a committed-uncertain terminal clear finalizes exactly once without losing private cleanup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-clear-uncertain-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const syncFailure = controllableDirectorySyncFailure(directory);
  const realStore = new BotStore({ filePath, fs: syncFailure.fs, now: () => NOW });
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store: realStore, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  const changed = [];
  controller.on("runtime-changed", (event) => changed.push(event));
  const originalComplete = realStore.completeRuntimeIssuance.bind(realStore);
  realStore.completeRuntimeIssuance = async (...args) => {
    syncFailure.arm();
    return originalComplete(...args);
  };

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(
    () => changed.some((event) => event.runtime.state === "failed"),
    "committed-uncertain terminal clear did not publish its final state",
  );

  const persisted = await readAfterRuntimeTransaction(new BotStore({ filePath }), bot.botId);
  assert.equal(syncFailure.failures(), 1);
  assert.equal(persisted.runtime.provider, null);
  assert.equal(persisted.runtime.remoteRuntimeId, null);
  assert.equal(persisted.runtime.state, "failed");
  assert.equal(persisted.runtime.lastErrorCode, "RUNTIME_PROVIDER_EVENT");
  assert.equal(await controller.runtimeSession(bot.botId), null);
  assert.deepEqual(harness.retireCalls, [{ runtimeId }]);
  assert.equal(changed.filter((event) => event.runtime.state === "failed").length, 1);
});

test("a same-ID successor after committed-uncertain clear suppresses the predecessor receipt", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-clear-successor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const syncFailure = controllableDirectorySyncFailure(directory);
  const realStore = new BotStore({ filePath, fs: syncFailure.fs, now: () => NOW });
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const runtimeId = `terminal-clear-successor-${bot.botId.slice(-12)}`;
  const endpoint = "wss://terminal-clear-successor.runtime.example.test/app-server";
  harness.queueProvision(
    bot.botId,
    runtimeResult(bot.botId, { runtimeId, endpoint, authToken: "private-terminal-clear-token-one" }),
    runtimeResult(bot.botId, { runtimeId, endpoint, authToken: "private-terminal-clear-token-two" }),
  );
  let successor = null;
  let successorReady = null;
  const predecessorStore = forwardingStore(realStore, {
    completeRuntimeIssuance: async (...args) => {
      syncFailure.arm();
      try {
        return await realStore.completeRuntimeIssuance(...args);
      } catch (error) {
        if (!successorReady
          && error?.code === "BOT_STORE_DURABILITY_UNCERTAIN"
          && error?.committed === true) {
          successorReady = await successor.retryRuntime(bot.botId);
        }
        throw error;
      }
    },
  });
  const predecessor = new BotRuntimeController({
    store: predecessorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  successor = new BotRuntimeController({
    store: new BotStore({ filePath, now: () => NOW }),
    provider: harness.provider(),
    now: () => NOW,
  });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());
  await predecessor.ensureRuntime(bot.botId);
  const predecessorEvents = [];
  predecessor.on("runtime-changed", (event) => predecessorEvents.push(event));

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(() => successorReady !== null, "same-ID successor was not installed after clear commit");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(syncFailure.failures(), 1);
  assert.equal(await predecessor.runtimeSession(bot.botId), null);
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId,
    endpoint,
    authToken: "private-terminal-clear-token-two",
  }));
  await successor.ensureRuntime(bot.botId);
  const successorSession = await successor.runtimeSession(bot.botId);
  assert.equal(successorSession.authToken, "private-terminal-clear-token-two");
  assert.equal((await new BotStore({ filePath }).read(bot.botId)).runtime.state, "ready");
  assert.deepEqual(harness.retireCalls, [{ runtimeId }]);
  assert.equal(predecessorEvents.some((event) => event.runtime.state === "failed"), false);
});

test("old runtime reassignment to another bot suppresses predecessor terminal publication", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-reassignment-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const realStore = new BotStore({ filePath, now: () => NOW });
  const botA = await realStore.create();
  const botB = await realStore.create();
  const harness = new ProviderHarness();
  const runtimeId = `terminal-reassignment-${botA.botId.slice(-12)}`;
  harness.queueProvision(botA.botId, runtimeResult(botA.botId, {
    runtimeId,
    endpoint: "wss://terminal-reassignment.runtime.example.test/app-server",
    authToken: "private-terminal-reassignment-token-one",
  }));
  harness.queueProvision(botB.botId, runtimeResult(botB.botId, {
    runtimeId,
    endpoint: "wss://terminal-reassignment.runtime.example.test/app-server",
    authToken: "private-terminal-reassignment-token-two",
  }));
  let successor = null;
  let successorReady = null;
  let interceptTerminal = false;
  const predecessorStore = forwardingStore(realStore, {
    completeRuntimeIssuance: async (...args) => {
      const outcome = await realStore.completeRuntimeIssuance(...args);
      if (interceptTerminal && !successorReady) {
        successorReady = await successor.retryRuntime(botB.botId);
      }
      return outcome;
    },
  });
  const predecessor = new BotRuntimeController({
    store: predecessorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  successor = new BotRuntimeController({
    store: new BotStore({ filePath, now: () => NOW }),
    provider: harness.provider(),
    now: () => NOW,
  });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());
  await predecessor.ensureRuntime(botA.botId);
  const predecessorEvents = [];
  predecessor.on("runtime-changed", (event) => predecessorEvents.push(event));
  interceptTerminal = true;

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(() => successorReady !== null, "old runtime was not reassigned to bot B");
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(successorReady.runtime.remoteRuntimeId, runtimeId);
  assert.equal((await successor.runtimeSession(botB.botId)).authToken, "private-terminal-reassignment-token-two");
  assert.equal(await predecessor.runtimeSession(botA.botId), null);
  assert.deepEqual(harness.retireCalls, [{ runtimeId }]);
  assert.equal(predecessorEvents.some((event) => event.runtime.state === "failed"), false);
});

test("throwing once runtime listeners cannot abort terminal commit or later listeners", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  let throwingCalls = 0;
  const delivered = [];
  controller.once("runtime-changed", () => {
    throwingCalls += 1;
    throw new Error("injected runtime listener failure");
  });
  controller.on("runtime-changed", (event) => delivered.push(event));

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(
    () => delivered.some((event) => event.runtime.state === "failed"),
    "later runtime listener did not receive the committed terminal event",
  );

  const persisted = await readAfterRuntimeTransaction(store, bot.botId);
  assert.equal(throwingCalls, 1);
  assert.equal(controller.listenerCount("runtime-changed"), 1);
  assert.equal(delivered.filter((event) => event.runtime.state === "failed").length, 1);
  assert.equal(persisted.runtime.provider, null);
  assert.equal(persisted.runtime.remoteRuntimeId, null);
  assert.equal(persisted.runtime.state, "failed");
  assert.equal(persisted.runtime.lastErrorCode, "RUNTIME_PROVIDER_EVENT");
  assert.doesNotMatch(JSON.stringify(delivered), /RUNTIME_OPERATION\.|endpoint|authToken|private-/i);
});

test("throwing once runtime-event listeners do not block later sanitized frame listeners", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  let throwingCalls = 0;
  const delivered = [];
  controller.once("runtime-event", () => {
    throwingCalls += 1;
    throw new Error("injected frame listener failure");
  });
  controller.on("runtime-event", (event) => delivered.push(event));

  harness.emit({
    runtimeId: ready.runtime.remoteRuntimeId,
    type: "computer/frame",
    sequence: 1201,
    payload: {
      frame: "safe-frame",
      providerDiagnostic: "private-listener-diagnostic",
      endpoint: "wss://private-listener.runtime.example.test/app-server",
    },
  });
  await waitFor(() => delivered.length === 1, "later frame listener was blocked by a throwing listener");

  assert.equal(throwingCalls, 1);
  assert.equal(controller.listenerCount("runtime-event"), 1);
  assert.equal(delivered[0].event.sequence, 1201);
  assertDeepFrozen(delivered[0]);
  assert.doesNotMatch(JSON.stringify(delivered), /provider.?diagnostic|endpoint|authToken|private-listener/i);
});

test("throwing removeListener meta observers cannot interrupt once targets or later listeners", async (t) => {
  const store = await temporaryStore(t);
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  const order = [];
  let onceTargetCalls = 0;
  controller.once("removeListener", (removedEvent, removedListener) => {
    order.push(`remove:${String(removedEvent)}`);
    assert.equal(typeof removedListener, "function");
    throw new Error("private-token-remove-meta-observer");
  });
  controller.once("runtime-changed", () => {
    onceTargetCalls += 1;
    order.push("once-target");
  });
  controller.on("runtime-changed", () => order.push("later-listener"));

  let firstResult = null;
  assert.doesNotThrow(() => {
    firstResult = controller.emit("runtime-changed", Object.freeze({ state: "first" }));
  });
  const secondResult = controller.emit("runtime-changed", Object.freeze({ state: "second" }));

  assert.equal(firstResult, true);
  assert.equal(secondResult, true);
  assert.equal(onceTargetCalls, 1);
  assert.equal(controller.listenerCount("runtime-changed"), 1);
  assert.equal(controller.listenerCount("removeListener"), 0);
  assert.deepEqual(order, [
    "remove:runtime-changed",
    "once-target",
    "later-listener",
    "later-listener",
  ]);
  assert.doesNotMatch(JSON.stringify(order), /private-token|endpoint|authToken|diagnostic/i);
});

test("async rejecting meta observers and throwing thenables produce no unhandled rejection", async (t) => {
  const store = await temporaryStore(t);
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason?.message || reason));
  process.prependListener("unhandledRejection", onUnhandled);
  t.after(() => process.removeListener("unhandledRejection", onUnhandled));
  let rejectingCalls = 0;
  const rejectingObserver = async () => {
    rejectingCalls += 1;
    throw new Error("private-endpoint-meta-rejection");
  };
  controller.on("removeListener", rejectingObserver);
  const removable = () => {};
  controller.on("runtime-event", removable);
  controller.removeListener("runtime-event", removable);
  controller.removeListener("removeListener", rejectingObserver);

  let thenGetterCalls = 0;
  let newListenerCalls = 0;
  controller.once("newListener", () => {
    newListenerCalls += 1;
    return {
      get then() {
        thenGetterCalls += 1;
        throw new Error("private-diagnostic-then-getter");
      },
    };
  });
  controller.on("runtime-changed", () => {});
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(rejectingCalls, 1);
  assert.equal(newListenerCalls, 1);
  assert.equal(thenGetterCalls, 1);
  assert.equal(controller.listenerCount("newListener"), 0);
  assert.deepEqual(unhandled, []);
  assert.doesNotMatch(JSON.stringify(unhandled), /private-|endpoint|authToken|diagnostic/i);
});

test("safe emit preserves prepend snapshots self-mutation and fail-safe error semantics", async (t) => {
  const store = await temporaryStore(t);
  const controller = new BotRuntimeController({ store, provider: unavailableProvider(), now: () => NOW });
  t.after(() => controller.dispose());
  const order = [];
  const added = () => order.push("added");
  const later = () => order.push("later");
  const first = () => {
    order.push("first");
    controller.removeListener("custom-event", later);
    controller.on("custom-event", added);
  };
  controller.on("custom-event", later);
  controller.prependListener("custom-event", first);

  assert.equal(controller.emit("custom-event"), true);
  assert.deepEqual(order, ["first", "later"]);
  order.length = 0;
  assert.equal(controller.emit("custom-event"), true);
  assert.deepEqual(order, ["first", "added"]);
  assert.equal(controller.emit("missing-event"), false);

  const errorOrder = [];
  assert.doesNotThrow(() => {
    assert.equal(controller.emit("error", new Error("private-unhandled-controller-error")), false);
  });
  controller.on("error", () => {
    errorOrder.push("throwing-error-listener");
    throw new Error("private-error-listener-failure");
  });
  controller.on("error", async () => {
    errorOrder.push("async-error-listener");
    throw new Error("private-async-error-listener-failure");
  });
  assert.equal(controller.emit("error", new Error("private-listened-controller-error")), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errorOrder, ["throwing-error-listener", "async-error-listener"]);
  assert.doesNotMatch(JSON.stringify(errorOrder), /private-|endpoint|authToken|diagnostic/i);
});

test("final terminal precommit failure emits nothing and retains the masked finalization receipt", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-precommit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const renameFailure = controllableRenameFailure();
  const realStore = new BotStore({ filePath, fs: renameFailure.fs, now: () => NOW });
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const store = forwardingStore(realStore, {
    runtimeTransaction: (botId, options, operation) => realStore.runtimeTransaction(
      botId,
      options,
      (transaction) => operation(Object.freeze({
        ...transaction,
        updateRuntime: (patch) => {
          if (patch.lastErrorCode === "RUNTIME_PROVIDER_EVENT"
            && Object.keys(patch).length === 1) renameFailure.arm();
          return transaction.updateRuntime(patch);
        },
      })),
    ),
    completeRuntimeIssuance: async (...args) => {
      renameFailure.arm();
      return realStore.completeRuntimeIssuance(...args);
    },
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  const changed = [];
  controller.on("runtime-changed", (event) => changed.push(event));

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(() => renameFailure.failures() === 1, "final terminal write did not reach precommit failure");
  await new Promise((resolve) => setTimeout(resolve, 40));

  const persisted = await readAfterRuntimeTransaction(new BotStore({ filePath }), bot.botId);
  const publicBot = await controller.readBot(bot.botId);
  assert.equal(changed.some((event) => event.runtime.state === "failed"), false);
  assert.equal(persisted.runtime.provider, "authorized-test-provider");
  assert.equal(persisted.runtime.remoteRuntimeId, runtimeId);
  assert.equal(persisted.runtime.state, "failed");
  assert.match(persisted.runtime.lastErrorCode, /^RUNTIME_OPERATION\./);
  assert.equal((await new BotStore({ filePath }).readRuntimeIssuances(bot.botId)).some((entry) => entry.phase === "active"), true);
  assert.equal(publicBot.runtime.lastErrorCode, null);
  assert.equal(await controller.runtimeSession(bot.botId), null);
  assert.deepEqual(harness.retireCalls, [{ runtimeId }]);
  assert.doesNotMatch(JSON.stringify({ changed, publicBot }), /RUNTIME_OPERATION\.|endpoint|authToken|private-/i);
  assert.equal((await realStore.rename(bot.botId, "Precommit terminal released")).name, "Precommit terminal released");
});

test("committed-uncertain final terminal write invokes the publish hook exactly once", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-final-uncertain-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const syncFailure = controllableDirectorySyncFailure(directory);
  const realStore = new BotStore({ filePath, fs: syncFailure.fs, now: () => NOW });
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  let completionBoundaryObserved = false;
  const store = forwardingStore(realStore, {
    completeRuntimeIssuance: async (...args) => {
      completionBoundaryObserved = true;
      syncFailure.arm();
      return realStore.completeRuntimeIssuance(...args);
    },
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  const changed = [];
  controller.on("runtime-changed", (event) => changed.push(event));

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(
    () => changed.some((event) => event.runtime.state === "failed"),
    "committed-uncertain final write did not invoke its publish hook",
  );

  const persisted = await readAfterRuntimeTransaction(new BotStore({ filePath }), bot.botId);
  assert.equal(completionBoundaryObserved, true);
  assert.equal(syncFailure.failures(), 1);
  assert.equal(changed.filter((event) => event.runtime.state === "failed").length, 1);
  assert.equal(persisted.runtime.provider, null);
  assert.equal(persisted.runtime.remoteRuntimeId, null);
  assert.equal(persisted.runtime.state, "failed");
  assert.equal(persisted.runtime.lastErrorCode, "RUNTIME_PROVIDER_EVENT");
  assert.equal(await controller.runtimeSession(bot.botId), null);
  assert.deepEqual(harness.retireCalls, [{ runtimeId }]);
  assert.doesNotMatch(JSON.stringify(changed), /RUNTIME_OPERATION\.|endpoint|authToken|private-/i);
});

test("terminal afterCommit publishes before a later same-ID successor becomes ready", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-terminal-postcommit-successor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const realStore = new BotStore({ filePath, now: () => NOW });
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const runtimeId = `terminal-postcommit-successor-${bot.botId.slice(-12)}`;
  const endpoint = "wss://terminal-postcommit-successor.runtime.example.test/app-server";
  harness.queueProvision(
    bot.botId,
    runtimeResult(bot.botId, { runtimeId, endpoint, authToken: "private-postcommit-token-one" }),
    runtimeResult(bot.botId, { runtimeId, endpoint, authToken: "private-postcommit-token-two" }),
  );
  const order = [];
  let completionObserved = false;
  let successor = null;
  let successorReady = null;
  const predecessorStore = forwardingStore(realStore, {
    completeRuntimeIssuance: async (...args) => {
      completionObserved = true;
      return realStore.completeRuntimeIssuance(...args);
    },
  });
  const predecessor = new BotRuntimeController({
    store: predecessorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  successor = new BotRuntimeController({
    store: new BotStore({ filePath, now: () => NOW }),
    provider: harness.provider(),
    now: () => NOW,
  });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());
  await predecessor.ensureRuntime(bot.botId);
  const predecessorEvents = [];
  predecessor.on("runtime-changed", (event) => {
    if (event.runtime.state !== "failed") return;
    predecessorEvents.push(event);
    order.push("predecessor-failed");
    if (!successorReady) {
      successorReady = successor.retryRuntime(bot.botId).then((value) => {
        order.push("successor-ready");
        return value;
      });
    }
  });

  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  await waitFor(() => successorReady !== null, "successor was not installed after terminal commit");
  await successorReady;

  assert.equal(completionObserved, true);
  assert.deepEqual(order, ["predecessor-failed", "successor-ready"]);
  assert.equal(predecessorEvents.length, 1);
  assert.equal((await predecessor.runtimeSession(bot.botId)), null);
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId,
    endpoint,
    authToken: "private-postcommit-token-two",
  }));
  await successor.ensureRuntime(bot.botId);
  assert.equal((await successor.runtimeSession(bot.botId)).authToken, "private-postcommit-token-two");
  assert.equal((await new BotStore({ filePath }).read(bot.botId)).runtime.state, "ready");
  assert.doesNotMatch(JSON.stringify(predecessorEvents), /RUNTIME_OPERATION\.|endpoint|authToken|private-/i);
});

test("disposing during a lock-cycle retry cancels delayed event work", async (t) => {
  const store = await temporaryStore(t);
  const botA = await store.create();
  const botB = await store.create();
  const harness = new ProviderHarness();
  const originalRead = store.read.bind(store);
  let countEventReads = false;
  let eventReadAttempts = 0;
  store.read = (...args) => {
    if (countEventReads && String(args[0]).toLowerCase() === botB.botId) eventReadAttempts += 1;
    return originalRead(...args);
  };
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const readyB = await controller.ensureRuntime(botB.botId);
  const entered = deferred();
  const release = deferred();
  const transaction = store.runtimeTransaction(botA.botId, {}, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  countEventReads = true;
  const frames = [];
  controller.on("runtime-event", (event) => frames.push(event));
  harness.emit({ runtimeId: readyB.runtime.remoteRuntimeId, type: "computer/frame", sequence: 951 });
  await waitFor(() => eventReadAttempts >= 1, "provider event did not encounter the active transaction");

  controller.dispose();
  const attemptsAtDispose = eventReadAttempts;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(eventReadAttempts, attemptsAtDispose);
  assert.deepEqual(frames, []);
  release.resolve();
  await transaction;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(eventReadAttempts, attemptsAtDispose);
  assert.deepEqual(frames, []);
});

test("terminal provider events invalidate generation, release ownership, and suppress late frames", async (t) => {
  const store = await temporaryStore(t);
  const botA = await store.create();
  const botB = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const readyA = await controller.ensureRuntime(botA.botId);
  const runtimeId = readyA.runtime.remoteRuntimeId;
  const stateEvents = [];
  const runtimeEvents = [];
  controller.on("runtime-changed", (event) => stateEvents.push(event));
  controller.on("runtime-event", (event) => runtimeEvents.push(event));

  harness.emit({ runtimeId, type: "computer/frame", sequence: 1, payload: { frame: "before" } });
  await waitFor(() => runtimeEvents.length === 1, "pre-terminal frame was not delivered");
  harness.runtimes.get(runtimeId).state = "detached";
  harness.emit({ runtimeId, state: "detached", type: "runtime/state" });
  await waitFor(
    () => stateEvents.some((event) => event.runtime.state === "detached"),
    "terminal state was not persisted",
  );
  const terminal = stateEvents.find((event) => event.runtime.state === "detached");
  assert.ok(terminal.generation > runtimeEvents[0].generation);

  harness.emit({ runtimeId, type: "computer/frame", sequence: 2, payload: { frame: "late" } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(runtimeEvents.map(({ event }) => event.sequence), [1]);
  assert.equal(await controller.runtimeSession(botA.botId), null);

  harness.queueProvision(botB.botId, runtimeResult(botB.botId, {
    runtimeId,
    endpoint: "wss://reassigned.runtime.example.test/app-server",
    authToken: "private-reassigned-token",
  }));
  harness.inspectHook = ({ runtimeId: inspectedRuntimeId }) => ({
    runtimeId: inspectedRuntimeId,
    ownerBotId: botB.botId,
    state: "ready",
  });
  const readyB = await controller.ensureRuntime(botB.botId);
  assert.equal(readyB.runtime.remoteRuntimeId, runtimeId);
  assert.equal(readyB.runtime.state, "ready");
});

test("runtime-event preserves Task1-detached cyclic data while removing nested endpoints", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const events = [];
  controller.on("runtime-event", (event) => events.push(event));
  const payload = { frame: "cyclic", optional: undefined };
  payload.self = payload;
  payload.nested = { endpoint: "wss://private.runtime.example.test", keep: true };

  harness.emit({
    runtimeId: ready.runtime.remoteRuntimeId,
    type: "computer/frame",
    payload,
  });
  await waitFor(() => events.length === 1, "cyclic runtime event was not delivered");

  assert.equal(events[0].event.payload.self, events[0].event.payload);
  assert.equal(events[0].event.payload.optional, undefined);
  assert.deepEqual(events[0].event.payload.nested, { keep: true });
  assertDeepFrozen(events[0]);
});

test("dispose is a hard boundary for in-flight provision and retires only the new candidate", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const provisionGate = deferred();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `disposed-provision-${bot.botId.slice(-12)}`,
    endpoint: "wss://disposed-provision.runtime.example.test/app-server",
    authToken: "private-disposed-provision-token",
  });
  harness.queueProvision(bot.botId, async () => {
    await provisionGate.promise;
    return candidate;
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const events = [];
  controller.on("runtime-changed", (event) => events.push(event));

  const pending = controller.ensureRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === 1, "provision did not begin");
  const eventCountBeforeDispose = events.length;
  controller.dispose();
  provisionGate.resolve();

  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "BotRuntimeError");
    assert.equal(error.code, "RUNTIME_CONTROLLER_DISPOSED");
    assert.doesNotMatch(String(error), /endpoint|authToken|private-|wss:/i);
    return true;
  });
  assert.deepEqual(harness.retireCalls, []);
  assert.equal((await store.readRuntimeIssuances(bot.botId)).some((entry) => entry.phase === "pending"), true);
  const current = await store.read(bot.botId);
  assert.notEqual(current.runtime.state, "ready");
  assert.notEqual(current.runtime.remoteRuntimeId, candidate.runtimeId);
  assert.equal(events.length, eventCountBeforeDispose);
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("dispose rejects an in-flight active inspection without retiring the persisted current runtime", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const ready = await controller.ensureRuntime(bot.botId);
  const runtimeId = ready.runtime.remoteRuntimeId;
  const inspectionGate = deferred();
  let inspectionBlocked = false;
  harness.inspectHook = async ({ runtimeId: inspectedRuntimeId }) => {
    if (inspectedRuntimeId === runtimeId && !inspectionBlocked) {
      inspectionBlocked = true;
      await inspectionGate.promise;
    }
    return { ...harness.runtimes.get(inspectedRuntimeId) };
  };
  harness.retireCalls.length = 0;

  const pending = controller.ensureRuntime(bot.botId);
  await waitFor(() => inspectionBlocked, "active inspection did not begin");
  controller.dispose();
  inspectionGate.resolve();

  await assert.rejects(pending, (error) => error?.code === "RUNTIME_CONTROLLER_DISPOSED");
  assert.deepEqual(harness.retireCalls, []);
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.remoteRuntimeId, runtimeId);
  assert.equal(persisted.runtime.state, "ready");
});

test("dispose during activation rolls back ready persistence and rejects the transaction", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  const activationEntered = deferred();
  const activationWritten = deferred();
  const activationGate = deferred();
  let candidateRuntimeId = null;
  const store = forwardingStore(realStore, {
    runtimeTransaction: async (...args) => {
      const outcome = await realStore.runtimeTransaction(...args);
      if (outcome.bot.runtime.state === "ready"
        && outcome.bot.runtime.remoteRuntimeId === candidateRuntimeId
        && outcome.bot.runtime.lastErrorCode?.startsWith("RUNTIME_OPERATION.")) {
        activationEntered.resolve();
        activationWritten.resolve();
        await activationGate.promise;
      }
      return outcome;
    },
    promoteRuntimeIssuance: async (botId, input) => {
      const outcome = await realStore.promoteRuntimeIssuance(botId, input);
      if (outcome.bot.runtime.state === "ready" && outcome.bot.runtime.remoteRuntimeId === candidateRuntimeId) {
        activationEntered.resolve();
        activationWritten.resolve();
        await activationGate.promise;
      }
      return outcome;
    },
  });
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `disposed-activation-${bot.botId.slice(-12)}`,
    endpoint: "wss://disposed-activation.runtime.example.test/app-server",
    authToken: "private-disposed-activation-token",
  });
  candidateRuntimeId = candidate.runtimeId;
  harness.queueProvision(bot.botId, candidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });

  const pending = controller.ensureRuntime(bot.botId);
  await activationEntered.promise;
  await activationWritten.promise;
  controller.dispose();
  activationGate.resolve();

  await assert.rejects(pending, (error) => error?.code === "RUNTIME_CONTROLLER_DISPOSED");
  assert.deepEqual(harness.retireCalls, []);
  const persisted = await realStore.read(bot.botId);
  assert.notEqual(persisted.runtime.state, "ready");
  assert.notEqual(persisted.runtime.remoteRuntimeId, candidate.runtimeId);
  assert.equal(persisted.runtime.lastErrorCode, "RUNTIME_CONTROLLER_DISPOSED");
});

test("dispose after rotation retirement never restores the retired old runtime as ready", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  let replacementRuntimeId = null;
  let gateReplacementActivation = false;
  const activationEntered = deferred();
  const activationGate = deferred();
  const store = forwardingStore(realStore, {
    runtimeTransaction: async (...args) => {
      const outcome = await realStore.runtimeTransaction(...args);
      if (gateReplacementActivation
        && outcome.bot.runtime.state === "ready"
        && outcome.bot.runtime.remoteRuntimeId === replacementRuntimeId
        && outcome.bot.runtime.lastErrorCode?.startsWith("RUNTIME_OPERATION.")) {
        activationEntered.resolve();
        await activationGate.promise;
      }
      return outcome;
    },
    promoteRuntimeIssuance: async (botId, input) => {
      const outcome = await realStore.promoteRuntimeIssuance(botId, input);
      if (gateReplacementActivation && outcome.bot.runtime.remoteRuntimeId === replacementRuntimeId) {
        activationEntered.resolve();
        await activationGate.promise;
      }
      return outcome;
    },
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const initial = await controller.ensureRuntime(bot.botId);
  const oldRuntimeId = initial.runtime.remoteRuntimeId;
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `disposed-rotation-${bot.botId.slice(-12)}`,
    endpoint: "wss://disposed-rotation.runtime.example.test/app-server",
    authToken: "private-disposed-rotation-token",
  });
  replacementRuntimeId = replacement.runtimeId;
  gateReplacementActivation = true;
  harness.queueProvision(bot.botId, replacement);
  harness.retireCalls.length = 0;

  const pending = controller.retryRuntime(bot.botId);
  await activationEntered.promise;
  controller.dispose();
  activationGate.resolve();

  await assert.rejects(pending, (error) => error?.code === "RUNTIME_CONTROLLER_DISPOSED");
  assert.deepEqual(harness.retireCalls, [{ runtimeId: oldRuntimeId }]);
  const persisted = await realStore.read(bot.botId);
  assert.notEqual(persisted.runtime.state, "ready");
  assert.notEqual(persisted.runtime.remoteRuntimeId, replacement.runtimeId);
  assert.equal(persisted.runtime.lastErrorCode, "RUNTIME_CONTROLLER_DISPOSED");
});

test("rotating a first pending candidate releases its private ownership for another bot", async (t) => {
  const store = await temporaryStore(t);
  const firstBot = await store.create();
  const secondBot = await store.create();
  const harness = new ProviderHarness();
  const pendingCandidate = runtimeResult(firstBot.botId, {
    runtimeId: `released-pending-${firstBot.botId.slice(-12)}`,
    endpoint: "wss://released-pending.runtime.example.test/app-server",
    authToken: "private-released-pending-token",
    state: "provisioning",
  });
  const replacement = runtimeResult(firstBot.botId, {
    runtimeId: `ready-replacement-${firstBot.botId.slice(-12)}`,
    endpoint: "wss://ready-replacement.runtime.example.test/app-server",
    authToken: "private-ready-replacement-token",
  });
  harness.queueProvision(firstBot.botId, pendingCandidate, replacement);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  await assert.rejects(() => controller.ensureRuntime(firstBot.botId), { code: "RUNTIME_NOT_READY" });
  const pending = await store.read(firstBot.botId);
  assert.equal(pending.runtime.remoteRuntimeId, null);
  assert.equal(pending.runtime.state, "failed");
  assert.deepEqual(harness.retireCalls, [{ runtimeId: pendingCandidate.runtimeId }]);
  const ready = await controller.ensureRuntime(firstBot.botId);
  assert.equal(ready.runtime.remoteRuntimeId, replacement.runtimeId);

  harness.queueProvision(secondBot.botId, runtimeResult(secondBot.botId, {
    runtimeId: pendingCandidate.runtimeId,
    endpoint: "wss://authorized-reassignment.runtime.example.test/app-server",
    authToken: "private-authorized-reassignment-token",
  }));
  const reassigned = await controller.ensureRuntime(secondBot.botId);
  assert.equal(reassigned.runtime.remoteRuntimeId, pendingCandidate.runtimeId);
  assert.equal(reassigned.runtime.state, "ready");
});

test("reconcile releases persisted terminal runtime IDs for later authorized assignment", async (t) => {
  const store = await temporaryStore(t);
  const terminalBot = await store.create();
  const runtimeId = `terminal-reassign-${terminalBot.botId.slice(-12)}`;
  await store.updateRuntime(terminalBot.botId, {
    provider: "authorized-test-provider",
    remoteRuntimeId: runtimeId,
    state: "detached",
    lastConfirmedAt: null,
    lastErrorCode: null,
  });
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  await controller.reconcile();
  const released = await store.read(terminalBot.botId);
  assert.equal(released.runtime.state, "detached");
  assert.equal(released.runtime.provider, null);
  assert.equal(released.runtime.remoteRuntimeId, null);

  const nextBot = await store.create();
  harness.queueProvision(nextBot.botId, runtimeResult(nextBot.botId, {
    runtimeId,
    endpoint: "wss://terminal-reassignment.runtime.example.test/app-server",
    authToken: "private-terminal-reassignment-token",
  }));
  const assigned = await controller.ensureRuntime(nextBot.botId);
  assert.equal(assigned.runtime.remoteRuntimeId, runtimeId);
  assert.equal(assigned.runtime.state, "ready");
});

test("runtime-event recursively strips provider diagnostics while preserving ordinary frame data", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(bot.botId);
  const events = [];
  controller.on("runtime-event", (event) => events.push(event));
  const payload = {
    frame: { pixels: "ordinary-computer-frame", width: 1280, height: 720 },
    inputSequence: 41,
    providerDiagnostic: "private provider stack",
    nested: {
      providerDiagnostics: ["secret one", "secret two"],
      provider_diagnostic: { trace: "private trace" },
      diagnostic: "private generic diagnostic",
      diagnostics: { raw: "private generic diagnostics" },
      keep: { pointer: [17, 23] },
    },
  };
  payload.self = payload;

  harness.emit({
    runtimeId: ready.runtime.remoteRuntimeId,
    type: "computer/frame",
    payload,
  });
  await waitFor(() => events.length === 1, "sanitized frame was not emitted");

  const event = events[0];
  assert.equal(event.event.payload.self, event.event.payload);
  assert.deepEqual(event.event.payload.frame, {
    pixels: "ordinary-computer-frame",
    width: 1280,
    height: 720,
  });
  assert.deepEqual(event.event.payload.nested.keep, { pointer: [17, 23] });
  assertDeepFrozen(event);
  const serialized = JSON.stringify(event, (key, value) => key === "self" ? undefined : value);
  assert.doesNotMatch(serialized, /provider.?diagnostic|private provider|private trace|private generic|secret one/i);
});

test("a ready lifecycle event activates the retained first candidate without reprovisioning", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `event-ready-${bot.botId.slice(-12)}`,
    endpoint: "wss://event-ready.runtime.example.test/app-server",
    authToken: "private-event-ready-token",
    state: "provisioning",
  });
  harness.queueProvision(bot.botId, candidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const runtimeEvents = [];
  const changed = [];
  controller.on("runtime-event", (event) => runtimeEvents.push(event));
  controller.on("runtime-changed", (event) => changed.push(event));

  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  const pending = await store.read(bot.botId);
  assert.equal(pending.runtime.state, "failed");
  harness.emit({
    runtimeId: candidate.runtimeId,
    type: "computer/frame",
    payload: { frame: "must-not-forward-before-ready" },
  });
  harness.runtimes.set(candidate.runtimeId, {
    runtimeId: candidate.runtimeId,
    ownerBotId: bot.botId,
    issuanceKey: "issuance-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "ready",
  });
  harness.emit({ runtimeId: candidate.runtimeId, type: "runtime/state", state: "ready" });
  const ready = await store.read(bot.botId);
  const session = await controller.runtimeSession(bot.botId);
  assert.equal(ready.runtime.remoteRuntimeId, null);
  assert.equal(ready.runtime.state, "failed");
  assert.equal(session, null);
  assert.equal(harness.provisionCalls.length, 1);
  assert.equal(harness.provisionCalls[0].idempotencyKey, `codex-bot:${bot.botId}`);
  assert.equal(harness.retireCalls.length, 1);
  assert.deepEqual(runtimeEvents, []);
});

test("failed and unavailable lifecycle events terminate retained candidates without leaking ownership", async (t) => {
  for (const providerState of ["failed", "unavailable"]) {
    await t.test(providerState, async (t) => {
      const store = await temporaryStore(t);
      const firstBot = await store.create();
      const secondBot = await store.create();
      const harness = new ProviderHarness();
      const candidate = runtimeResult(firstBot.botId, {
        runtimeId: `${providerState}-candidate-${firstBot.botId.slice(-12)}`,
        endpoint: `wss://${providerState}-candidate.runtime.example.test/app-server`,
        authToken: `private-${providerState}-candidate-token`,
        state: "provisioning",
      });
      harness.queueProvision(firstBot.botId, candidate);
      const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
      t.after(() => controller.dispose());
      const runtimeEvents = [];
      const changed = [];
      controller.on("runtime-event", (event) => runtimeEvents.push(event));
      controller.on("runtime-changed", (event) => changed.push(event));

      await assert.rejects(() => controller.ensureRuntime(firstBot.botId), { code: "RUNTIME_NOT_READY" });
      harness.emit({
        runtimeId: candidate.runtimeId,
        type: "computer/frame",
        payload: { frame: "must-not-forward-before-terminal" },
      });
      const terminated = await store.read(firstBot.botId);
      assert.equal(terminated.runtime.state, "failed");
      assert.equal(terminated.runtime.provider, null);
      assert.equal(terminated.runtime.remoteRuntimeId, null);
      assert.equal(terminated.runtime.lastErrorCode, "RUNTIME_NOT_READY");
      assert.deepEqual(runtimeEvents, []);
      assert.deepEqual(harness.retireCalls, [{ runtimeId: candidate.runtimeId }]);
      assert.equal(harness.provisionCalls.length, 1);

      harness.queueProvision(secondBot.botId, runtimeResult(secondBot.botId, {
        runtimeId: candidate.runtimeId,
        endpoint: `wss://${providerState}-reassigned.runtime.example.test/app-server`,
        authToken: `private-${providerState}-reassigned-token`,
      }));
      const reassigned = await controller.ensureRuntime(secondBot.botId);
      assert.equal(reassigned.runtime.remoteRuntimeId, candidate.runtimeId);
      assert.equal(reassigned.runtime.state, "ready");
    });
  }
});

test("dispose cleanup never retires a provision result authoritatively owned by another bot", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const provisionGate = deferred();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `foreign-dispose-${bot.botId.slice(-12)}`,
    endpoint: "wss://foreign-dispose.runtime.example.test/app-server",
    authToken: "private-foreign-dispose-token",
  });
  harness.queueProvision(bot.botId, async () => {
    await provisionGate.promise;
    return candidate;
  });
  harness.inspectHook = ({ runtimeId }) => ({
    runtimeId,
    ownerBotId: "bot-authoritative-foreign-owner",
    state: "ready",
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });

  const pending = controller.ensureRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === 1, "foreign candidate provision did not begin");
  controller.dispose();
  provisionGate.resolve();

  await assert.rejects(pending, (error) => error?.code === "RUNTIME_CONTROLLER_DISPOSED");
  assert.deepEqual(harness.retireCalls, []);
  const failed = await readAfterRuntimeTransaction(store, bot.botId);
  assert.equal(failed.runtime.provider, null);
  assert.equal(failed.runtime.remoteRuntimeId, null);
  assert.equal(failed.runtime.state, "unprovisioned");
  assert.equal(failed.runtime.lastErrorCode, null);
});

test("candidate ready owner mismatch clears only local claims and never retires the foreign runtime", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `foreign-ready-${bot.botId.slice(-12)}`,
    endpoint: "wss://foreign-ready.runtime.example.test/app-server",
    authToken: "private-foreign-ready-token",
    state: "provisioning",
  });
  harness.queueProvision(bot.botId, candidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const changed = [];
  controller.on("runtime-changed", (event) => changed.push(event));

  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  harness.inspectHook = ({ runtimeId }) => ({
    runtimeId,
    ownerBotId: "bot-authoritative-foreign-owner",
    state: "ready",
  });
  harness.emit({ runtimeId: candidate.runtimeId, type: "runtime/state", state: "ready" });
  const failed = await store.read(bot.botId);
  assert.equal(failed.runtime.provider, null);
  assert.equal(failed.runtime.remoteRuntimeId, null);
  assert.equal(failed.runtime.state, "failed");
  assert.equal(failed.runtime.lastErrorCode, "RUNTIME_NOT_READY");
  assert.deepEqual(harness.retireCalls, [{ runtimeId: candidate.runtimeId }]);
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("queued candidate events reclassify at dequeue after ready activation", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `dequeue-events-${bot.botId.slice(-12)}`,
    endpoint: "wss://dequeue-events.runtime.example.test/app-server",
    authToken: "private-dequeue-events-token",
    state: "provisioning",
  });
  harness.queueProvision(bot.botId, candidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const changed = [];
  const frames = [];
  controller.on("runtime-changed", (event) => changed.push(event));
  controller.on("runtime-event", (event) => frames.push(event));

  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  assert.deepEqual(frames, []);
  assert.deepEqual(harness.retireCalls, [{ runtimeId: candidate.runtimeId }]);
  const failed = await store.read(bot.botId);
  assert.equal(failed.runtime.provider, null);
  assert.equal(failed.runtime.remoteRuntimeId, null);
  assert.equal(failed.runtime.state, "failed");
  assert.equal(failed.runtime.lastErrorCode, "RUNTIME_NOT_READY");
  assert.equal(await controller.runtimeSession(bot.botId), null);
});

test("restart reconcile restores an active issuance and atomically confirms ready state", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const runtimeId = `restart-pending-${bot.botId.slice(-12)}`;
  await store.updateRuntime(bot.botId, {
    provider: "authorized-test-provider",
    remoteRuntimeId: runtimeId,
    state: "failed",
    lastConfirmedAt: null,
    lastErrorCode: "RUNTIME_NOT_READY",
  });
  await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: TEST_ISSUANCE_A,
    retirementKey: TEST_RETIREMENT_A,
  });
  await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: TEST_ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId,
  });
  await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: TEST_ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId,
    state: "failed",
    lastConfirmedAt: null,
    expectedPreviousIssuanceKey: null,
  });
  const harness = new ProviderHarness();
  const recoveredCandidate = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: "wss://restart-pending.runtime.example.test/app-server",
    authToken: "private-restart-pending-token",
    state: "ready",
  });
  harness.queueProvision(bot.botId, recoveredCandidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const reconciled = await controller.reconcile();
  assert.equal(reconciled[0].runtime.remoteRuntimeId, runtimeId);
  assert.equal(reconciled[0].runtime.state, "ready");
  assert.deepEqual(harness.provisionCalls, [{
    botId: bot.botId,
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: TEST_ISSUANCE_A,
  }]);

  const ready = await store.read(bot.botId);
  const session = await controller.runtimeSession(bot.botId);
  assert.equal(ready.runtime.remoteRuntimeId, runtimeId);
  assert.equal(ready.runtime.state, "ready");
  assert.equal(session.runtimeId, runtimeId);
  assert.equal(session.authToken, "private-restart-pending-token");
  assert.equal(harness.provisionCalls.length, 1);
});

test("same-runtime retry suppresses stale active-generation events queued during reprovision", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const initial = await controller.ensureRuntime(bot.botId);
  const runtimeId = initial.runtime.remoteRuntimeId;
  const initialSession = await controller.runtimeSession(bot.botId);
  const provisionGate = deferred();
  const replacement = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: initialSession.endpoint,
    authToken: "private-same-runtime-generation-two-token",
  });
  harness.queueProvision(bot.botId, async () => {
    await provisionGate.promise;
    return replacement;
  });
  harness.retireCalls.length = 0;
  const mutations = [];
  store.runtimeTransaction = interceptRuntimeUpdates(store, ({ patch, update }) => {
    mutations.push({ ...patch });
    return update();
  });
  const frames = [];
  controller.on("runtime-event", (event) => frames.push(event));
  const provisionCount = harness.provisionCalls.length;

  const retry = controller.retryRuntime(bot.botId);
  await waitFor(
    () => harness.provisionCalls.length === provisionCount + 1,
    "same-runtime retry did not begin",
  );
  harness.emit({
    runtimeId,
    type: "computer/frame",
    sequence: 201,
    payload: { frame: "stale-active-generation-frame" },
  });
  harness.emit({ runtimeId, type: "runtime/state", state: "failed" });
  provisionGate.resolve();
  const ready = await retry;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const session = await controller.runtimeSession(bot.botId);
  assert.deepEqual(frames, []);
  assert.equal(ready.runtime.state, "ready");
  assert.equal(session.runtimeId, runtimeId);
  assert.equal(session.generation, 2);
  assert.equal(session.authToken, "private-same-runtime-generation-two-token");
  assert.equal(harness.retireCalls.length, 0);
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, runtimeId);
});

test("same-runtime retry suppresses stale candidate-generation events queued during recovery", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const firstCandidate = runtimeResult(bot.botId, {
    runtimeId: `same-candidate-generation-${bot.botId.slice(-12)}`,
    endpoint: "wss://same-candidate-generation.runtime.example.test/app-server",
    authToken: "private-same-candidate-generation-one-token",
    state: "provisioning",
  });
  harness.queueProvision(bot.botId, firstCandidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  const provisionGate = deferred();
  const replacement = runtimeResult(bot.botId, {
    runtimeId: firstCandidate.runtimeId,
    endpoint: firstCandidate.endpoint,
    authToken: "private-same-candidate-generation-two-token",
  });
  harness.queueProvision(bot.botId, async () => {
    await provisionGate.promise;
    return replacement;
  });
  harness.retireCalls.length = 0;
  const mutations = [];
  store.runtimeTransaction = interceptRuntimeUpdates(store, ({ patch, update }) => {
    mutations.push({ ...patch });
    return update();
  });
  const frames = [];
  controller.on("runtime-event", (event) => frames.push(event));
  const provisionCount = harness.provisionCalls.length;

  const retry = controller.retryRuntime(bot.botId);
  await waitFor(
    () => harness.provisionCalls.length === provisionCount + 1,
    "same-candidate retry did not begin",
  );
  harness.emit({
    runtimeId: firstCandidate.runtimeId,
    type: "computer/frame",
    sequence: 301,
    payload: { frame: "stale-candidate-generation-frame" },
  });
  harness.emit({
    runtimeId: firstCandidate.runtimeId,
    type: "runtime/state",
    state: "failed",
  });
  provisionGate.resolve();

  const ready = await retry;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const session = await controller.runtimeSession(bot.botId);
  assert.equal(ready.runtime.remoteRuntimeId, firstCandidate.runtimeId);
  assert.equal(ready.runtime.state, "ready");
  assert.equal(session.runtimeId, firstCandidate.runtimeId);
  assert.equal(session.generation, 1);
  assert.equal(session.authToken, "private-same-candidate-generation-two-token");
  assert.deepEqual(frames, []);
  assert.equal(harness.retireCalls.length, 0);
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, firstCandidate.runtimeId);
});

test("disposed predecessor cannot retire or overwrite a successor controller using the same runtime", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const predecessorGate = deferred();
  const runtimeId = `successor-runtime-${bot.botId.slice(-12)}`;
  const predecessorResult = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: "wss://successor-runtime.runtime.example.test/app-server",
    authToken: "private-predecessor-token",
  });
  const successorResult = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: predecessorResult.endpoint,
    authToken: "private-successor-token",
  });
  harness.queueProvision(
    bot.botId,
    async () => {
      await predecessorGate.promise;
      return predecessorResult;
    },
    successorResult,
  );
  const predecessor = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const predecessorEvents = [];
  predecessor.on("runtime-changed", (event) => predecessorEvents.push(event));
  const predecessorOperation = predecessor.ensureRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === 1, "predecessor provision did not begin");
  const leasedRecord = await store.read(bot.botId);
  assert.equal(leasedRecord.runtime.lastErrorCode, null);
  assert.equal((await store.readRuntimeIssuances(bot.botId)).some((entry) => entry.phase === "pending"), true);
  assert.equal((await predecessor.readBot(bot.botId)).runtime.lastErrorCode, null);
  assert.deepEqual(predecessorEvents, []);
  predecessor.dispose();

  const successor = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => successor.dispose());
  const successorReady = await successor.ensureRuntime(bot.botId);
  const successorSessionBeforeRelease = await successor.runtimeSession(bot.botId);
  assert.equal(successorReady.runtime.state, "ready");
  assert.equal(successorReady.runtime.remoteRuntimeId, runtimeId);
  assert.equal(successorSessionBeforeRelease.authToken, "private-successor-token");
  harness.retireCalls.length = 0;

  predecessorGate.resolve();
  await assert.rejects(
    predecessorOperation,
    (error) => error?.code === "RUNTIME_CONTROLLER_DISPOSED",
  );

  assert.deepEqual(harness.retireCalls, []);
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, runtimeId);
  const successorSession = await successor.runtimeSession(bot.botId);
  assert.equal(successorSession.runtimeId, runtimeId);
  assert.equal(successorSession.authToken, "private-successor-token");
});

test("disposed predecessor with a stale Store instance cannot retire or overwrite a fresh-Store successor", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-runtime-cross-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const predecessorStore = new BotStore({ filePath, now: () => NOW });
  const bot = await predecessorStore.create();
  const harness = new ProviderHarness();
  const predecessorGate = deferred();
  const runtimeId = `fresh-store-successor-${bot.botId.slice(-12)}`;
  const predecessorResult = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: "wss://fresh-store-successor.runtime.example.test/app-server",
    authToken: "private-stale-store-predecessor-token",
  });
  const successorResult = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: predecessorResult.endpoint,
    authToken: "private-fresh-store-successor-token",
  });
  harness.queueProvision(
    bot.botId,
    async () => {
      await predecessorGate.promise;
      return predecessorResult;
    },
    successorResult,
  );
  const predecessor = new BotRuntimeController({
    store: predecessorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  const predecessorOperation = predecessor.ensureRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === 1, "stale-Store predecessor did not begin");
  predecessor.dispose();

  const successorStore = new BotStore({ filePath, now: () => NOW });
  const successor = new BotRuntimeController({
    store: successorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  t.after(() => successor.dispose());
  const successorReady = await successor.ensureRuntime(bot.botId);
  assert.equal(successorReady.runtime.state, "ready");
  assert.equal(successorReady.runtime.remoteRuntimeId, runtimeId);
  assert.equal((await successor.runtimeSession(bot.botId)).authToken, "private-fresh-store-successor-token");
  harness.retireCalls.length = 0;

  predecessorGate.resolve();
  await assert.rejects(
    predecessorOperation,
    (error) => error?.code === "RUNTIME_CONTROLLER_DISPOSED",
  );

  assert.deepEqual(harness.retireCalls, []);
  const successorPersisted = await successorStore.read(bot.botId);
  assert.equal(successorPersisted.runtime.state, "ready");
  assert.equal(successorPersisted.runtime.remoteRuntimeId, runtimeId);
  const diskPersisted = await new BotStore({ filePath }).read(bot.botId);
  assert.equal(diskPersisted.runtime.state, "ready");
  assert.equal(diskPersisted.runtime.remoteRuntimeId, runtimeId);
  const successorSession = await successor.runtimeSession(bot.botId);
  assert.equal(successorSession.runtimeId, runtimeId);
  assert.equal(successorSession.authToken, "private-fresh-store-successor-token");
});

test("committed-uncertain ready activation recovers the exact private candidate session", async (t) => {
  const realStore = await temporaryStore(t);
  let injected = false;
  const store = forwardingStore(realStore, {
    promoteRuntimeIssuance: async (...args) => {
      const outcome = await realStore.promoteRuntimeIssuance(...args);
      if (!injected) {
        injected = true;
        const failure = new Error("injected committed promotion uncertainty");
        failure.code = "BOT_STORE_DURABILITY_UNCERTAIN";
        failure.committed = true;
        throw failure;
      }
      return outcome;
    },
  });
  const bot = await store.create();
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `uncertain-ready-${bot.botId.slice(-12)}`,
    endpoint: "wss://uncertain-ready.runtime.example.test/app-server",
    authToken: "private-uncertain-ready-token",
  });
  harness.queueProvision(bot.botId, candidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const events = [];
  controller.on("runtime-changed", (event) => events.push(event));

  const ready = await controller.ensureRuntime(bot.botId);
  const session = await controller.runtimeSession(bot.botId);
  const persisted = await realStore.read(bot.botId);

  assert.equal(injected, true);
  assert.equal(ready.runtime.state, "ready");
  assert.equal(ready.runtime.remoteRuntimeId, candidate.runtimeId);
  assert.equal(session.runtimeId, candidate.runtimeId);
  assert.equal(session.authToken, "private-uncertain-ready-token");
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, candidate.runtimeId);
  assert.equal(persisted.runtime.lastErrorCode, null);
  assert.equal(harness.provisionCalls.length, 1);
  assert.deepEqual(harness.retireCalls, []);
  assert.equal(events.filter((event) => event.runtime.state === "ready").length, 1);
  assert.doesNotMatch(JSON.stringify({ ready, persisted, events }), /RUNTIME_OPERATION\.|endpoint|authToken|private-uncertain/i);
});

test("a committed-uncertain phase-one receipt proceeds only through its exact durable marker", async (t) => {
  const realStore = await temporaryStore(t);
  let injected = false;
  const store = forwardingStore(realStore, {
    issueRuntimeIssuance: async (...args) => {
      const outcome = await realStore.issueRuntimeIssuance(...args);
      if (!injected) {
        injected = true;
        const failure = new Error("injected committed phase-one uncertainty");
        failure.code = "BOT_STORE_DURABILITY_UNCERTAIN";
        failure.committed = true;
        throw failure;
      }
      return outcome;
    },
  });
  const bot = await store.create();
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `uncertain-receipt-${bot.botId.slice(-12)}`,
    endpoint: "wss://uncertain-receipt.runtime.example.test/app-server",
    authToken: "private-uncertain-receipt-token",
  });
  harness.queueProvision(bot.botId, candidate, candidate);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const events = [];
  controller.on("runtime-changed", (event) => events.push(event));

  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_PROVISION_FAILED" });
  const firstKey = harness.provisionCalls[0].issuanceKey;
  const ready = await controller.retryRuntime(bot.botId);
  const session = await controller.runtimeSession(bot.botId);
  const persisted = await realStore.read(bot.botId);

  assert.equal(injected, true);
  assert.equal(ready.runtime.state, "ready");
  assert.equal(session.runtimeId, candidate.runtimeId);
  assert.equal(session.authToken, "private-uncertain-receipt-token");
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.lastErrorCode, null);
  assert.equal(harness.provisionCalls.length, 2);
  assert.equal(harness.provisionCalls[1].issuanceKey, firstKey);
  assert.deepEqual(harness.retireCalls, []);
  assert.equal(events.filter((event) => event.runtime.state === "ready").length, 1);
  assert.doesNotMatch(JSON.stringify({ ready, persisted, events }), /RUNTIME_OPERATION\.|endpoint|authToken|private-uncertain/i);
});

test("committed-uncertain activation never recovers stale credentials after a same-ID successor", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  const successorStore = new BotStore({ filePath: realStore.filePath, now: () => NOW });
  const harness = new ProviderHarness();
  const runtimeId = `uncertain-same-id-${bot.botId.slice(-12)}`;
  const predecessorResult = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: "wss://uncertain-same-id.runtime.example.test/app-server",
    authToken: "private-uncertain-predecessor-token",
  });
  const successorResult = runtimeResult(bot.botId, {
    runtimeId,
    endpoint: predecessorResult.endpoint,
    authToken: "private-uncertain-successor-token",
  });
  harness.queueProvision(bot.botId, predecessorResult, successorResult);
  let successor;
  let successorReady = null;
  let injected = false;
  const predecessorStore = forwardingStore(realStore, {
    promoteRuntimeIssuance: async (...args) => {
      const outcome = await realStore.promoteRuntimeIssuance(...args);
      if (!injected) {
        injected = true;
        successorReady = successor.retryRuntime(bot.botId);
        await successorReady;
        const failure = new Error("injected committed promotion uncertainty");
        failure.code = "BOT_STORE_DURABILITY_UNCERTAIN";
        failure.committed = true;
        throw failure;
      }
      return outcome;
    },
  });
  const predecessor = new BotRuntimeController({
    store: predecessorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  successor = new BotRuntimeController({
    store: successorStore,
    provider: harness.provider(),
    now: () => NOW,
  });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());

  await assert.rejects(
    predecessor.ensureRuntime(bot.botId),
    (error) => error?.code === "RUNTIME_OPERATION_SUPERSEDED",
  );
  const persisted = await new BotStore({ filePath: realStore.filePath }).read(bot.botId);
  const predecessorSession = await predecessor.runtimeSession(bot.botId);

  assert.equal(injected, true);
  const successorOutcome = await successorReady;
  assert.equal(successorOutcome.runtime.state, "ready");
  assert.equal(successorOutcome.runtime.remoteRuntimeId, runtimeId);
  assert.equal(predecessorSession, null);
  harness.queueProvision(bot.botId, successorResult);
  await successor.ensureRuntime(bot.botId);
  const recoveredSuccessorSession = await successor.runtimeSession(bot.botId);
  assert.equal(recoveredSuccessorSession.runtimeId, runtimeId);
  assert.equal(recoveredSuccessorSession.authToken, "private-uncertain-successor-token");
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, runtimeId);
  assert.equal(harness.provisionCalls.length, 3);
  assert.equal(harness.provisionCalls[2].issuanceKey, harness.provisionCalls[1].issuanceKey);
  assert.deepEqual(harness.retireCalls, []);
});

test("committed-uncertain activation never overwrites a different authoritative successor", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  const successorStore = new BotStore({ filePath: realStore.filePath, now: () => NOW });
  const successorRuntimeId = `authoritative-successor-${bot.botId.slice(-12)}`;
  let successorInstalled = false;
  const harness = new ProviderHarness();
  const candidate = runtimeResult(bot.botId, {
    runtimeId: `uncertain-predecessor-${bot.botId.slice(-12)}`,
    endpoint: "wss://uncertain-predecessor.runtime.example.test/app-server",
    authToken: "private-uncertain-predecessor-token",
  });
  harness.queueProvision(bot.botId, candidate);
  const store = forwardingStore(realStore, {
    promoteRuntimeIssuance: async (...args) => {
      const outcome = await realStore.promoteRuntimeIssuance(...args);
      if (!successorInstalled) {
        successorInstalled = true;
        const active = (await successorStore.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active");
        await installIssuedSuccessor(successorStore, harness, bot.botId, {
          previousIssuanceKey: active.issuanceKey,
          issuanceKey: TEST_ISSUANCE_B,
          retirementKey: TEST_RETIREMENT_B,
          runtimeId: successorRuntimeId,
        });
        const failure = new Error("injected committed promotion uncertainty");
        failure.code = "BOT_STORE_DURABILITY_UNCERTAIN";
        failure.committed = true;
        throw failure;
      }
      return outcome;
    },
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  await assert.rejects(
    controller.ensureRuntime(bot.botId),
    (error) => error?.code === "RUNTIME_OPERATION_SUPERSEDED",
  );

  const persisted = await new BotStore({ filePath: realStore.filePath }).read(bot.botId);
  assert.equal(successorInstalled, true);
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, successorRuntimeId);
  assert.equal(persisted.runtime.lastErrorCode, null);
  assert.equal(harness.provisionCalls.length, 1);
  assert.deepEqual(harness.retireCalls, []);
});

test("provider callbacks cannot deadlock on same-path Store access inside runtime transactions", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const original = runtimeResult(bot.botId, {
    runtimeId: `callback-original-${bot.botId.slice(-12)}`,
    endpoint: "wss://callback-original.runtime.example.test/app-server",
    authToken: "private-callback-original-token",
  });
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `callback-replacement-${bot.botId.slice(-12)}`,
    endpoint: "wss://callback-replacement.runtime.example.test/app-server",
    authToken: "private-callback-replacement-token",
  });
  harness.queueProvision(bot.botId, original, replacement);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await controller.ensureRuntime(bot.botId);
  harness.inspectHook = async ({ runtimeId }) => {
    if (runtimeId === original.runtimeId) return store.read(bot.botId);
    return { ...harness.runtimes.get(runtimeId) };
  };
  let timeout;
  const retry = controller.retryRuntime(bot.botId);
  const boundedRetry = Promise.race([
    retry,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("provider callback Store access deadlocked")), 250);
    }),
  ]);

  try {
    await assert.rejects(
      boundedRetry,
      (error) => error?.code === "RUNTIME_RETIRE_FAILED",
    );
  } finally {
    clearTimeout(timeout);
  }
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.remoteRuntimeId, original.runtimeId);
  assert.equal(persisted.runtime.state, "failed");
  assert.deepEqual(harness.retireCalls, [{ runtimeId: replacement.runtimeId }]);
});

test("provider callbacks from a pre-existing AsyncResource fail closed instead of deadlocking", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const escapedResource = new AsyncResource("pre-existing-provider-callback");
  t.after(() => escapedResource.emitDestroy());
  const original = runtimeResult(bot.botId, {
    runtimeId: `escaped-callback-original-${bot.botId.slice(-12)}`,
    endpoint: "wss://escaped-callback-original.runtime.example.test/app-server",
    authToken: "private-escaped-callback-original-token",
  });
  const replacement = runtimeResult(bot.botId, {
    runtimeId: `escaped-callback-replacement-${bot.botId.slice(-12)}`,
    endpoint: "wss://escaped-callback-replacement.runtime.example.test/app-server",
    authToken: "private-escaped-callback-replacement-token",
  });
  harness.queueProvision(bot.botId, original, replacement);
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await controller.ensureRuntime(bot.botId);
  harness.inspectHook = ({ runtimeId }) => {
    if (runtimeId !== original.runtimeId) return { ...harness.runtimes.get(runtimeId) };
    return new Promise((resolve, reject) => {
      escapedResource.runInAsyncScope(() => {
        store.read(bot.botId).then(resolve, reject);
      });
    });
  };
  let timeout;
  const retry = controller.retryRuntime(bot.botId);
  const boundedRetry = Promise.race([
    retry,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("escaped provider callback Store access deadlocked")), 250);
    }),
  ]);

  let rejection;
  try {
    await assert.rejects(
      boundedRetry,
      (error) => {
        rejection = error;
        return error?.code === "RUNTIME_RETIRE_FAILED";
      },
    );
  } finally {
    clearTimeout(timeout);
  }
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.remoteRuntimeId, original.runtimeId);
  assert.equal(persisted.runtime.state, "failed");
  assert.deepEqual(harness.retireCalls, [{ runtimeId: replacement.runtimeId }]);
  assert.doesNotMatch(
    JSON.stringify({ code: rejection?.code, message: rejection?.message }),
    /BOT_STORE_|bots\.json|codex-bot-runtime-controller-|endpoint|authToken|private-escaped/i,
  );
  assert.equal((await store.rename(bot.botId, "Lock recovered")).name, "Lock recovered");
});

test("deleteBots synchronously fences one atomic batch and emits one sanitized deletion", async (t) => {
  const realStore = await temporaryStore(t);
  const first = await realStore.create();
  const second = await realStore.create();
  const survivor = await realStore.create();
  const entered = deferred();
  const release = deferred();
  const deleteCalls = [];
  let fencedReads = 0;
  let fencedRenames = 0;
  const store = forwardingStore(realStore, {
    read: (...args) => {
      fencedReads += 1;
      return realStore.read(...args);
    },
    rename: (...args) => {
      fencedRenames += 1;
      return realStore.rename(...args);
    },
    deleteBots: async (...args) => {
      deleteCalls.push(args);
      entered.resolve();
      await release.promise;
      return realStore.deleteBots(...args);
    },
  });
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const events = [];
  controller.on("bots-deleted", (event) => events.push(event));

  const deletion = controller.deleteBots([first.botId, second.botId], {
    preferredActiveBotId: survivor.botId,
  });
  await entered.promise;
  await assert.rejects(
    controller.ensureRuntime(first.botId),
    (error) => error?.code === "RUNTIME_BOT_DELETING",
  );
  await assert.rejects(
    controller.renameBot(second.botId, "Must stay fenced"),
    (error) => error?.code === "RUNTIME_BOT_DELETING",
  );
  assert.equal(fencedReads, 0);
  assert.equal(fencedRenames, 0);
  release.resolve();

  assert.deepEqual(await deletion, {
    deletedBotIds: [first.botId, second.botId],
    survivingBotIds: [survivor.botId],
    activeBotId: survivor.botId,
  });
  assert.deepEqual(deleteCalls, [[
    [first.botId, second.botId],
    { preferredActiveBotId: survivor.botId, extraRemoteRuntimes: [] },
  ]]);
  assert.deepEqual(events, [{
    botIds: [first.botId, second.botId],
    activeBotId: survivor.botId,
  }]);
  assertDeepFrozen(events[0]);
  assert.deepEqual(harness.retireCalls, []);
  assert.deepEqual(await controller.listBots(), [survivor]);
  await assert.rejects(controller.ensureRuntime(first.botId), /not found/i);
});

test("deleteBots rejects after disposal during its durable store commit without rolling it back", async (t) => {
  const realStore = await temporaryStore(t);
  const deleted = await realStore.create();
  const survivor = await realStore.create();
  const entered = deferred();
  const release = deferred();
  const store = forwardingStore(realStore, {
    deleteBots: async (...args) => {
      entered.resolve();
      await release.promise;
      return realStore.deleteBots(...args);
    },
  });
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const events = [];
  controller.on("bots-deleted", (event) => events.push(event));

  const deletion = controller.deleteBots([deleted.botId], {
    preferredActiveBotId: survivor.botId,
  });
  await entered.promise;
  controller.dispose();
  release.resolve();

  await assert.rejects(
    deletion,
    (error) => error?.code === "RUNTIME_CONTROLLER_DISPOSED",
  );
  assert.deepEqual(events, []);
  assert.equal(await realStore.read(deleted.botId), null);
  const [receipt] = await realStore.listPendingDeletions();
  assert.deepEqual(receipt.botIds, [deleted.botId]);
});

test("deleteBots awaits an older issuance and clears only after exact cleanup", async (t) => {
  const realStore = await temporaryStore(t);
  const deleted = await realStore.create();
  const survivor = await realStore.create();
  const provisionGate = deferred();
  const candidate = runtimeResult(deleted.botId, {
    runtimeId: `delete-candidate-${deleted.botId.slice(-12)}`,
    endpoint: "wss://delete-candidate.runtime.example.test/app-server",
    authToken: "private-delete-candidate-token",
    state: "provisioning",
  });
  const harness = new ProviderHarness();
  harness.queueProvision(deleted.botId, async () => {
    await provisionGate.promise;
    return candidate;
  });
  const deleteCalls = [];
  const store = forwardingStore(realStore, {
    deleteBots: (...args) => {
      deleteCalls.push(args);
      return realStore.deleteBots(...args);
    },
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  const provisioning = controller.ensureRuntime(deleted.botId);
  await waitFor(() => harness.provisionCalls.length === 1, "older provision did not begin");
  const deletion = controller.deleteBots([deleted.botId], {
    preferredActiveBotId: survivor.botId,
  });
  await Promise.resolve();
  assert.equal(deleteCalls.length, 0);
  await assert.rejects(
    controller.runtimeSession(deleted.botId),
    (error) => error?.code === "RUNTIME_BOT_DELETING",
  );

  provisionGate.resolve();
  await assert.rejects(provisioning, { code: "RUNTIME_NOT_READY" });
  await deletion;
  assert.deepEqual(deleteCalls, [[
    [deleted.botId],
    {
      preferredActiveBotId: survivor.botId,
      extraRemoteRuntimes: [],
    },
  ]]);
  assert.deepEqual(harness.retireCalls, [{ runtimeId: candidate.runtimeId }]);
  const [receipt] = await realStore.listPendingDeletions();
  assert.deepEqual(receipt.remoteRuntimes, []);

  await realStore.completeDeletion(receipt.deletionId);
  harness.queueProvision(survivor.botId, runtimeResult(survivor.botId, {
    runtimeId: candidate.runtimeId,
    endpoint: "wss://reassigned-delete-candidate.runtime.example.test/app-server",
    authToken: "private-reassigned-delete-candidate-token",
  }));
  const reassigned = await controller.ensureRuntime(survivor.botId);
  assert.equal(reassigned.runtime.remoteRuntimeId, candidate.runtimeId);
  assert.equal(reassigned.runtime.state, "ready");
});

test("deleteBots waits an older provider event and drops every event after its fence", async (t) => {
  const realStore = await temporaryStore(t);
  const deleted = await realStore.create();
  const survivor = await realStore.create();
  const harness = new ProviderHarness();
  let blockReads = false;
  const eventReadEntered = deferred();
  const releaseEventRead = deferred();
  let deleteCalls = 0;
  const store = forwardingStore(realStore, {
    read: async (...args) => {
      if (blockReads && args[0] === deleted.botId) {
        eventReadEntered.resolve();
        await releaseEventRead.promise;
      }
      return realStore.read(...args);
    },
    deleteBots: (...args) => {
      deleteCalls += 1;
      return realStore.deleteBots(...args);
    },
  });
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(deleted.botId);
  const frames = [];
  controller.on("runtime-event", (event) => frames.push(event.event.sequence));

  blockReads = true;
  harness.emit({
    runtimeId: ready.runtime.remoteRuntimeId,
    type: "computer/frame",
    sequence: 1,
  });
  await eventReadEntered.promise;
  const deletion = controller.deleteBots([deleted.botId], {
    preferredActiveBotId: survivor.botId,
  });
  harness.emit({
    runtimeId: ready.runtime.remoteRuntimeId,
    type: "computer/frame",
    sequence: 2,
  });
  await Promise.resolve();
  assert.equal(deleteCalls, 0);

  blockReads = false;
  releaseEventRead.resolve();
  await deletion;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteCalls, 1);
  assert.deepEqual(frames, [1]);
  assert.deepEqual(harness.retireCalls, []);
});

test("an unknown bot makes controller deletion all-or-none without clearing private state", async (t) => {
  const store = await temporaryStore(t);
  const retained = await store.create();
  const other = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const ready = await controller.ensureRuntime(retained.botId);
  const events = [];
  controller.on("bots-deleted", (event) => events.push(event));
  const unknownBotId = "bot-44444444-4444-4444-8444-444444444444";

  await assert.rejects(
    controller.deleteBots([retained.botId, unknownBotId]),
    /not found/i,
  );
  assert.deepEqual((await controller.listBots()).map(({ botId }) => botId), [
    retained.botId,
    other.botId,
  ]);
  const session = await controller.runtimeSession(retained.botId);
  assert.equal(session.runtimeId, ready.runtime.remoteRuntimeId);
  assert.deepEqual(events, []);
  assert.deepEqual(harness.retireCalls, []);
});

test("v1 provider remains unavailable with zero provision and retirement effects", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  let provisions = 0;
  let retires = 0;
  const provider = validateProvider({
    capabilities: async () => ({
      provision: true, reconcile: true, retire: true, remoteAppServer: true, computerFrames: true,
    }),
    provision: async () => { provisions += 1; throw new Error("legacy provision"); },
    inspect: async ({ runtimeId }) => ({ runtimeId, ownerBotId: bot.botId, state: "ready" }),
    retire: async () => { retires += 1; throw new Error("legacy retire"); },
    subscribe: () => () => {},
  });
  const controller = new BotRuntimeController({ store, provider, now: () => NOW });
  t.after(() => controller.dispose());
  const result = await controller.ensureRuntime(bot.botId);
  assert.equal(result.runtime.state, "unavailable");
  assert.equal(provisions, 0);
  assert.equal(retires, 0);
});

test("v2 persists the issuance intent before the first provider call", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  let pendingAtProvider = null;
  harness.provisionHook = async () => { pendingAtProvider = await store.readRuntimeIssuances(bot.botId); };
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await controller.ensureRuntime(bot.botId);
  assert.equal(pendingAtProvider?.length, 1);
  assert.equal(pendingAtProvider[0].phase, "pending");
  assert.equal(pendingAtProvider[0].runtimeId, null);
});

test("v2 replays an exact issuance after its issued commit fails", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  let failed = false;
  const store = forwardingStore(realStore, {
    issueRuntimeIssuance: async (...args) => {
      if (!failed) { failed = true; throw new Error("injected issue commit failure"); }
      return realStore.issueRuntimeIssuance(...args);
    },
  });
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await assert.rejects(() => controller.ensureRuntime(bot.botId));
  const pending = (await realStore.readRuntimeIssuances(bot.botId))[0];
  await controller.ensureRuntime(bot.botId);
  assert.equal(harness.provisionCalls[0].issuanceKey, pending.issuanceKey);
  assert.equal(harness.provisionCalls[1].issuanceKey, pending.issuanceKey);
});

test("v2 same-runtime successor promotes only after the predecessor is superseded", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const first = await controller.ensureRuntime(bot.botId);
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, { runtimeId: first.runtime.remoteRuntimeId }));
  const promoted = await controller.retryRuntime(bot.botId);
  assert.equal(promoted.runtime.state, "ready");
  assert.equal(promoted.runtime.remoteRuntimeId, first.runtime.remoteRuntimeId);
  assert.equal(harness.retireCalls.length, 0);
});

test("v2 non-ready issuance uses exact fenced retirement and leaves no active identity", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, { state: "provisioning" }));
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  await assert.rejects(() => controller.ensureRuntime(bot.botId), { code: "RUNTIME_NOT_READY" });
  assert.equal(harness.retireCalls.length, 1);
  assert.deepEqual(await store.readRuntimeIssuances(bot.botId), []);
});

test("v2 deletion persists only owner, runtime, issuance, and retirement identity", async (t) => {
  const value = await fencedDeletionFixture(t);
  const [entry] = value.receipt.remoteRuntimes;
  assert.deepEqual(Object.keys(entry).sort(), ["botId", "issuanceKey", "retirementKey", "runtimeId"]);
  assert.doesNotMatch(JSON.stringify(value.receipt), /provider|endpoint|authToken|idempotencyKey/i);
});

test("v2 matched-false reassignment never retires a reused runtime", async (t) => {
  const value = await fencedDeletionFixture(t);
  const [entry] = value.receipt.remoteRuntimes;
  value.harness.runtimes.set(entry.runtimeId, {
    runtimeId: entry.runtimeId,
    ownerBotId: entry.botId,
    issuanceKey: "issuance-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "ready",
  });
  await assert.rejects(() => value.controller.retireDeletedRuntimes(value.receipt), { code: "RUNTIME_RETIRE_PENDING" });
  assert.equal(value.harness.retireCalls.length, 0);
  assert.equal((await value.store.listPendingDeletions()).length, 1);
});

test("v2 terminal readback failure leaves a receipt pending and retries its retirement key", async (t) => {
  const value = await fencedDeletionFixture(t);
  const [entry] = value.receipt.remoteRuntimes;
  const keys = [];
  let first = true;
  value.harness.retireHook = ({ runtimeId, ownerBotId, issuanceKey, retirementKey }) => {
    keys.push({ runtimeId, ownerBotId, issuanceKey, retirementKey });
    if (first) { first = false; return { runtimeId, state: "retiring" }; }
    value.harness.runtimes.get(runtimeId).state = "retired";
    return { runtimeId, state: "retired" };
  };
  await assert.rejects(() => value.controller.retireDeletedRuntimes(value.receipt), { code: "RUNTIME_RETIRE_PENDING" });
  await value.controller.retireDeletedRuntimes(value.receipt);
  assert.deepEqual(keys, [
    { runtimeId: entry.runtimeId, ownerBotId: entry.botId, issuanceKey: entry.issuanceKey, retirementKey: entry.retirementKey },
    { runtimeId: entry.runtimeId, ownerBotId: entry.botId, issuanceKey: entry.issuanceKey, retirementKey: entry.retirementKey },
  ]);
});

test("v2 lost retirement response replays the same retirement key", async (t) => {
  const value = await fencedDeletionFixture(t);
  const [entry] = value.receipt.remoteRuntimes;
  let first = true;
  const keys = [];
  value.harness.retireHook = ({ runtimeId, ownerBotId, issuanceKey, retirementKey }) => {
    keys.push({ runtimeId, ownerBotId, issuanceKey, retirementKey });
    if (first) {
      first = false;
      value.harness.runtimes.get(runtimeId).state = "retired";
      throw new Error("lost response");
    }
    value.harness.runtimes.get(runtimeId).state = "retired";
    return { runtimeId, state: "retired" };
  };
  await value.controller.retireDeletedRuntimes(value.receipt);
  assert.deepEqual(keys, [
    { runtimeId: entry.runtimeId, ownerBotId: entry.botId, issuanceKey: entry.issuanceKey, retirementKey: entry.retirementKey },
    { runtimeId: entry.runtimeId, ownerBotId: entry.botId, issuanceKey: entry.issuanceKey, retirementKey: entry.retirementKey },
  ]);
});

test("v2 disposal leaves a pending issuance replayable by a successor controller", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const gate = deferred();
  harness.provisionHook = () => gate.promise;
  const first = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const operation = first.ensureRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === 1);
  const pending = (await store.readRuntimeIssuances(bot.botId))[0];
  first.dispose();
  gate.resolve();
  await assert.rejects(operation, { code: "RUNTIME_CONTROLLER_DISPOSED" });
  harness.provisionHook = null;
  const second = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => second.dispose());
  await second.ensureRuntime(bot.botId);
  assert.equal(harness.provisionCalls.at(-1).issuanceKey, pending.issuanceKey);
});

test("controller deletion cannot erase an unresolved issuance intent", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const gate = deferred();
  harness.provisionHook = () => gate.promise;
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());
  const provisioning = controller.ensureRuntime(bot.botId);
  await waitFor(() => harness.provisionCalls.length === 1);
  const pending = (await store.readRuntimeIssuances(bot.botId))[0];
  const deletion = controller.deleteBots([bot.botId]);
  gate.reject(new Error("provider response lost"));
  await assert.rejects(provisioning);
  await assert.rejects(deletion, { code: "BOT_STORE_RUNTIME_ISSUANCE_PENDING" });
  assert.equal((await store.readRuntimeIssuances(bot.botId))[0].issuanceKey, pending.issuanceKey);
  assert.notEqual(await store.read(bot.botId), null);
});

test("v2 replay rejects a changed provider before activation or deletion", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const first = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const ready = await first.ensureRuntime(bot.botId);
  first.dispose();
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    provider: "changed-display-provider",
    runtimeId: ready.runtime.remoteRuntimeId,
  }));
  const successor = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => successor.dispose());
  await assert.rejects(() => successor.ensureRuntime(bot.botId), { code: "RUNTIME_ISSUANCE_MISMATCH" });
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.remoteRuntimeId, ready.runtime.remoteRuntimeId);
  assert.equal((await store.listPendingDeletions()).length, 0);
});

test("v2 drops a late same-runtime predecessor event without invalidating the successor", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  const first = await controller.ensureRuntime(bot.botId);
  const runtimeId = first.runtime.remoteRuntimeId;
  const firstIssuanceKey = harness.provisionCalls[0].issuanceKey;
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId,
    endpoint: "wss://same-runtime-successor.runtime.example.test/app-server",
    authToken: "private-successor-token",
  }));
  const successor = await controller.retryRuntime(bot.botId);
  const secondIssuanceKey = harness.provisionCalls.at(-1).issuanceKey;
  assert.notEqual(secondIssuanceKey, firstIssuanceKey);
  assert.equal(successor.runtime.remoteRuntimeId, runtimeId);
  const before = await controller.runtimeSession(bot.botId);
  assert.equal(before.authToken, "private-successor-token");

  harness.emit({ runtimeId, issuanceKey: firstIssuanceKey, state: "failed" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const after = await controller.runtimeSession(bot.botId);
  assert.equal(after.authToken, "private-successor-token");
  assert.equal((await controller.readBot(bot.botId)).runtime.state, "ready");
  assert.equal(harness.retireCalls.length, 0);
});

test("v2 terminal-looking event requires authoritative terminal issuance state", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  const ready = await controller.ensureRuntime(bot.botId);
  const changed = [];
  controller.on("runtime-changed", (event) => changed.push(event));
  harness.emit({
    runtimeId: ready.runtime.remoteRuntimeId,
    issuanceKey: harness.provisionCalls[0].issuanceKey,
    state: "retired",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const persisted = await waitForStoreBot(store, bot.botId, () => true);
  const active = (await store.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active");
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, ready.runtime.remoteRuntimeId);
  assert.equal(active?.issuanceKey, harness.provisionCalls[0].issuanceKey);
  assert.equal(changed.some((event) => ["detached", "retired"].includes(event.runtime.state)), false);
});

test("v2 terminal completion rechecks the latest exact issuance state", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const controller = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => controller.dispose());

  const ready = await controller.ensureRuntime(bot.botId);
  let inspectionCount = 0;
  harness.inspectHook = ({ runtimeId }) => {
    inspectionCount += 1;
    return {
      runtimeId,
      ownerBotId: bot.botId,
      state: inspectionCount === 1 ? "detached" : "ready",
    };
  };
  harness.emit({ runtimeId: ready.runtime.remoteRuntimeId, state: "detached" });
  await waitForStoreBot(store, bot.botId, () => inspectionCount >= 2);

  const persisted = await store.read(bot.botId);
  const active = (await store.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active");
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, ready.runtime.remoteRuntimeId);
  assert.equal(active?.issuanceKey, harness.provisionCalls[0].issuanceKey);
});

test("v2 stale reconnecting cannot overwrite a same-runtime successor", async (t) => {
  const realStore = await temporaryStore(t);
  const bot = await realStore.create();
  const harness = new ProviderHarness();
  const entered = deferred();
  const release = deferred();
  let eventPaused = false;
  const staleStore = forwardingStore(realStore, {
    runtimeTransaction: async (botId, options, operation) => {
      if (options?.expectedActiveIssuanceKey && !eventPaused) {
        eventPaused = true;
        entered.resolve();
        await release.promise;
      }
      return realStore.runtimeTransaction(botId, options, operation);
    },
  });
  const predecessor = new BotRuntimeController({ store: staleStore, provider: harness.provider(), now: () => NOW });
  const successor = new BotRuntimeController({ store: realStore, provider: harness.provider(), now: () => NOW });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());

  const first = await predecessor.ensureRuntime(bot.botId);
  const issuanceA = harness.provisionCalls[0].issuanceKey;
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId: first.runtime.remoteRuntimeId,
    authToken: "private-stale-reconnect-successor-token",
  }));
  harness.emit({ runtimeId: first.runtime.remoteRuntimeId, issuanceKey: issuanceA, state: "reconnecting" });
  await entered.promise;
  const second = await successor.retryRuntime(bot.botId);
  release.resolve();

  const persisted = await waitForStoreBot(
    realStore,
    bot.botId,
    (current) => current?.runtime.state === "ready"
      && current.runtime.remoteRuntimeId === second.runtime.remoteRuntimeId,
    "successor ready state was overwritten by stale reconnecting",
  );
  assert.equal(persisted.runtime.state, "ready");
  assert.equal((await realStore.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active")?.issuanceKey,
    harness.provisionCalls.at(-1).issuanceKey);
});

test("v2 stale frame is suppressed after a same-runtime successor wins during inspect", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const baseProvider = harness.provider();
  let predecessor;
  let successor;
  let eventPending = false;
  let successorReady = null;
  let issuanceA = null;
  const predecessorProvider = validateProvider({
    capabilities: (...args) => baseProvider.capabilities(...args),
    provision: (...args) => baseProvider.provision(...args),
    inspect: (...args) => baseProvider.inspect(...args),
    retire: (...args) => baseProvider.retire(...args),
    inspectIssuance: async (input) => {
      const inspected = await baseProvider.inspectIssuance(input);
      if (eventPending && input.issuanceKey === issuanceA && !successorReady) {
        successorReady = successor.retryRuntime(bot.botId);
        await successorReady;
      }
      return inspected;
    },
    retireIssuance: (...args) => baseProvider.retireIssuance(...args),
    subscribe: (callback) => baseProvider.subscribe(callback),
  });
  predecessor = new BotRuntimeController({ store, provider: predecessorProvider, now: () => NOW });
  successor = new BotRuntimeController({ store, provider: baseProvider, now: () => NOW });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());

  const ready = await predecessor.ensureRuntime(bot.botId);
  issuanceA = harness.provisionCalls[0].issuanceKey;
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId: ready.runtime.remoteRuntimeId,
    authToken: "private-stale-frame-successor-token",
  }));
  const frames = [];
  predecessor.on("runtime-event", (event) => frames.push(event));
  eventPending = true;
  harness.emit({ runtimeId: ready.runtime.remoteRuntimeId, issuanceKey: issuanceA, type: "computer/frame", sequence: 7001 });
  await successorReady;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(frames, []);
  assert.equal((await store.read(bot.botId)).runtime.state, "ready");
  assert.equal((await store.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active")?.issuanceKey,
    harness.provisionCalls.at(-1).issuanceKey);
});

test("v2 runtimeSession drops an inspected predecessor after a same-runtime successor wins", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const baseProvider = harness.provider();
  const inspectionEntered = deferred();
  const releaseInspection = deferred();
  let blockInspection = false;
  const predecessorProvider = validateProvider({
    capabilities: (...args) => baseProvider.capabilities(...args),
    provision: (...args) => baseProvider.provision(...args),
    inspect: (...args) => baseProvider.inspect(...args),
    retire: (...args) => baseProvider.retire(...args),
    inspectIssuance: async (input) => {
      const inspected = await baseProvider.inspectIssuance(input);
      if (blockInspection) {
        blockInspection = false;
        inspectionEntered.resolve();
        await releaseInspection.promise;
      }
      return inspected;
    },
    retireIssuance: (...args) => baseProvider.retireIssuance(...args),
    subscribe: (callback) => baseProvider.subscribe(callback),
  });
  const predecessor = new BotRuntimeController({ store, provider: predecessorProvider, now: () => NOW });
  const successor = new BotRuntimeController({ store, provider: baseProvider, now: () => NOW });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());

  const first = await predecessor.ensureRuntime(bot.botId);
  const firstSession = await predecessor.runtimeSession(bot.botId);
  blockInspection = true;
  const pendingSession = predecessor.runtimeSession(bot.botId);
  await inspectionEntered.promise;
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId: first.runtime.remoteRuntimeId,
    authToken: "private-runtime-session-successor-token",
  }));
  await successor.retryRuntime(bot.botId);
  releaseInspection.resolve();

  const inspectedSession = await pendingSession;
  assert.equal(firstSession.authToken.startsWith("private-token-"), true);
  assert.equal(inspectedSession, null);
  assert.equal((await store.read(bot.botId)).runtime.state, "ready");
  assert.equal((await successor.runtimeSession(bot.botId)).authToken, "private-runtime-session-successor-token");
});

test("v2 older capability failure cannot overwrite a newer ready issuance", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const baseProvider = harness.provider();
  const capabilityEntered = deferred();
  const releaseCapability = deferred();
  let blockCapabilities = false;
  let failProvision = false;
  const predecessorProvider = validateProvider({
    capabilities: async () => {
      if (blockCapabilities) {
        blockCapabilities = false;
        capabilityEntered.resolve();
        await releaseCapability.promise;
      }
      return baseProvider.capabilities();
    },
    provision: async (...args) => {
      if (failProvision) throw new Error("older provision failed after successor activation");
      return baseProvider.provision(...args);
    },
    inspect: (...args) => baseProvider.inspect(...args),
    retire: (...args) => baseProvider.retire(...args),
    inspectIssuance: (...args) => baseProvider.inspectIssuance(...args),
    retireIssuance: (...args) => baseProvider.retireIssuance(...args),
    subscribe: (callback) => baseProvider.subscribe(callback),
  });
  const predecessor = new BotRuntimeController({ store, provider: predecessorProvider, now: () => NOW });
  const successor = new BotRuntimeController({ store, provider: baseProvider, now: () => NOW });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());

  const first = await predecessor.ensureRuntime(bot.botId);
  blockCapabilities = true;
  failProvision = true;
  const olderFailure = predecessor.retryRuntime(bot.botId);
  await capabilityEntered.promise;
  harness.queueProvision(bot.botId, runtimeResult(bot.botId, {
    runtimeId: first.runtime.remoteRuntimeId,
    authToken: "private-capability-successor-token",
  }));
  const newer = await successor.retryRuntime(bot.botId);
  releaseCapability.resolve();
  await assert.rejects(olderFailure, { code: "RUNTIME_OPERATION_SUPERSEDED" });

  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, newer.runtime.remoteRuntimeId);
  assert.equal((await successor.runtimeSession(bot.botId)).authToken, "private-capability-successor-token");
});

test("v2 same-issuance older rejection cannot overwrite a replayed ready owner", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const firstProvisionEntered = deferred();
  const releaseFirstProvision = deferred();
  let provisionCount = 0;
  harness.provisionHook = async () => {
    provisionCount += 1;
    if (provisionCount !== 1) return;
    firstProvisionEntered.resolve();
    await releaseFirstProvision.promise;
    throw new Error("older same-issuance provision failed");
  };
  const predecessor = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const successor = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => predecessor.dispose());
  t.after(() => successor.dispose());

  const olderFailure = predecessor.ensureRuntime(bot.botId);
  await firstProvisionEntered.promise;
  const replayed = await successor.ensureRuntime(bot.botId);
  releaseFirstProvision.resolve();

  await assert.rejects(olderFailure, { code: "RUNTIME_OPERATION_SUPERSEDED" });
  const persisted = await store.read(bot.botId);
  assert.equal(persisted.runtime.state, "ready");
  assert.equal(persisted.runtime.remoteRuntimeId, replayed.runtime.remoteRuntimeId);
  assert.equal((await successor.runtimeSession(bot.botId)).authToken.startsWith("private-token-"), true);
  assert.equal((await store.readRuntimeIssuances(bot.botId)).find((entry) => entry.phase === "active")?.issuanceKey,
    harness.provisionCalls[0].issuanceKey);
});

test("v2 restart clears active issuance only after exact terminal inspection", async (t) => {
  const store = await temporaryStore(t);
  const bot = await store.create();
  const harness = new ProviderHarness();
  const first = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  const ready = await first.ensureRuntime(bot.botId);
  const issuance = (await store.readRuntimeIssuances(bot.botId))[0];
  harness.runtimes.get(ready.runtime.remoteRuntimeId).state = "retired";
  await store.updateRuntime(bot.botId, {
    state: "retired",
    lastConfirmedAt: null,
    lastErrorCode: null,
  });
  first.dispose();
  const successor = new BotRuntimeController({ store, provider: harness.provider(), now: () => NOW });
  t.after(() => successor.dispose());
  await successor.reconcile();
  assert.deepEqual(await store.readRuntimeIssuances(bot.botId), []);
  const cleared = await store.read(bot.botId);
  assert.equal(cleared.runtime.remoteRuntimeId, null);
  assert.equal(cleared.runtime.state, "retired");
  assert.equal(issuance.phase, "active");
});
