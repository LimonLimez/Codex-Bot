"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");
const path = require("node:path");

const brokerPath = path.join(__dirname, "..", "src", "local", "local-permission-broker.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const BOT_C = "bot-33333333-3333-4333-8333-333333333333";
const TARGET_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_C = "local-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function request(botId = BOT_A, generation = 4, overrides = {}) {
  const targetId = botId === BOT_A ? TARGET_A : botId === BOT_B ? TARGET_B : TARGET_C;
  return {
    botId,
    targetId,
    targetGeneration: generation,
    capability: "filesystem.read",
    resourceId: "folder-a",
    resourceLabel: "Folder A",
    reason: "Read a file selected for this task",
    ...overrides,
  };
}

function computer(botId = BOT_A, generation = 4, overrides = {}) {
  const localProfileId = botId === BOT_A ? TARGET_A : botId === BOT_B ? TARGET_B : TARGET_C;
  return {
    botId,
    computer: {
      mode: "local",
      generation,
      localProfileId,
      nativeAgentId: null,
      state: "ready",
      lastConfirmedAt: "2026-08-15T12:34:56.000Z",
      lastErrorCode: null,
      ...overrides,
    },
  };
}

function identity(prompt) {
  return {
    requestId: prompt.requestId,
    botId: prompt.botId,
    targetId: prompt.targetId,
    targetGeneration: prompt.targetGeneration,
  };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function promptFor(broker, start) {
  const seen = deferred();
  const listener = (prompt) => seen.resolve(prompt);
  broker.once("request", listener);
  const pending = start();
  const prompt = await seen.promise;
  return { pending, prompt };
}

function fixture(overrides = {}) {
  const bookmark = Buffer.from("private-bookmark");
  const calls = { remembered: [], revoked: [], tcc: [], chosen: [] };
  let current = computer();
  const store = {
    authorize: mock.fn(async () => ({ allowed: false })),
    remember: mock.fn(async (input) => {
      calls.remembered.push(input);
      return Object.freeze({
        grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        botId: input.botId,
        capability: input.capability,
        resourceId: input.resourceId,
        resourceLabel: input.resourceLabel,
        scope: "always",
        createdAt: "2026-08-15T12:34:56.000Z",
      });
    }),
    revoke: mock.fn(async (botId, grantId) => calls.revoked.push({ botId, grantId })),
    deleteBot: mock.fn(async () => {}),
    listPublic: mock.fn(async () => []),
  };
  Object.assign(store, overrides.store || {});
  const defaultChooseResource = mock.fn(async (input) => {
    calls.chosen.push(input);
    return bookmark;
  });
  const chooseResource = overrides.chooseResource || defaultChooseResource;
  const tcc = {
    ensure: mock.fn(async (input) => calls.tcc.push(input)),
  };
  const readCurrentComputer = overrides.readCurrentComputer || mock.fn(async () => current);
  const { LocalPermissionBroker } = require(brokerPath);
  const broker = new LocalPermissionBroker({
    store,
    readCurrentComputer,
    chooseResource,
    tcc,
    randomUUID: overrides.randomUUID || (() => REQUEST_A),
  });
  return {
    bookmark,
    broker,
    calls,
    chooseResource,
    readCurrentComputer,
    setCurrent(value) { current = value; },
    store,
    tcc,
  };
}

test("broker applies one current per-bot Allow Once decision exactly once", async () => {
  const { broker, bookmark, chooseResource, tcc } = fixture();
  const effect = mock.fn(async (received) => {
    assert.deepEqual(received, bookmark);
    return "done";
  });
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  assert.deepEqual(prompt, {
    requestId: `permission-${REQUEST_A}`,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 4,
    capability: "filesystem.read",
    resourceLabel: "Folder A",
    reason: "Read a file selected for this task",
  });
  assertDeepFrozen(prompt);
  assert.equal(Object.hasOwn(prompt, "resourceId"), false);

  assert.equal(await broker.decide({ ...identity(prompt), decision: "once" }), "done");
  assert.equal(await pending, "done");
  await assert.rejects(
    broker.decide({ ...identity(prompt), decision: "once" }),
    /unavailable/i,
  );
  assert.equal(effect.mock.callCount(), 1);
  assert.equal(chooseResource.mock.callCount(), 1);
  assert.equal(tcc.ensure.mock.callCount(), 1);
});

test("shell consent exposes the exact command and full-host scope but never permits Always", async () => {
  const { broker, store } = fixture();
  const effect = mock.fn(async () => "done");
  const shell = request(BOT_A, 4, {
    capability: "shell.execute",
    resourceId: "full-host-shell",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
    command: "printf 'exact command' && /usr/bin/true",
  });
  const { pending, prompt } = await promptFor(broker, () => broker.request(shell, effect));
  assert.deepEqual(prompt, {
    requestId: `permission-${REQUEST_A}`,
    botId: BOT_A,
    targetId: TARGET_A,
    targetGeneration: 4,
    capability: "shell.execute",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
    command: "printf 'exact command' && /usr/bin/true",
    allowsAlways: false,
  });
  assert.equal(store.authorize.mock.callCount(), 0);
  assert.equal(effect.mock.callCount(), 0);
  await assert.rejects(
    broker.decide({ ...identity(prompt), decision: "always" }),
    /unavailable|one command/i,
  );
  assert.equal(effect.mock.callCount(), 0);
  assert.deepEqual(await broker.listPending(BOT_A), [prompt]);
  assert.equal(await broker.decide({ ...identity(prompt), decision: "once" }), "done");
  assert.equal(await pending, "done");
  assert.equal(effect.mock.callCount(), 1);
  assert.equal(store.remember.mock.callCount(), 0);
  broker.dispose();
});

test("task cancellation removes only the exact pending shell consent before any effect", async () => {
  let nextId = 0;
  const { broker } = fixture({
    randomUUID() {
      nextId += 1;
      return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
    },
  });
  const shell = request(BOT_A, 4, {
    capability: "shell.execute",
    resourceId: "full-host-shell",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
    command: "printf exact",
  });
  const firstEffect = mock.fn(async () => "must-not-run");
  const secondEffect = mock.fn(async () => "second");
  const first = await promptFor(broker, () => broker.request(shell, firstEffect, { taskId: "standalone-first" }));
  const firstOutcome = first.pending.catch((error) => error);
  const second = await promptFor(broker, () => broker.request(shell, secondEffect, { taskId: "standalone-second" }));
  const secondOutcome = second.pending.catch((error) => error);

  broker.cancelTask({ botId: BOT_A, taskId: "standalone-first" });
  assert.equal((await firstOutcome).code, "OPENBOT_PERMISSION_CANCELLED");
  assert.deepEqual(await broker.listPending(BOT_A), [second.prompt]);
  assert.equal(firstEffect.mock.callCount(), 0);
  await assert.rejects(
    broker.decide({ ...identity(first.prompt), decision: "once" }),
    /unavailable/i,
  );

  assert.equal(await broker.decide({ ...identity(second.prompt), decision: "once" }), "second");
  assert.equal(await secondOutcome, "second");
  assert.equal(secondEffect.mock.callCount(), 1);
  broker.dispose();
});

test("task cancellation during current-target lookup suppresses a late prompt and permits reuse", async (t) => {
  const lookup = deferred();
  let reads = 0;
  const { broker } = fixture({
    async readCurrentComputer() {
      reads += 1;
      if (reads === 1) await lookup.promise;
      return computer();
    },
  });
  t.after(() => broker.dispose());
  const prompts = [];
  broker.on("request", (prompt) => prompts.push(prompt));
  const shell = request(BOT_A, 4, {
    capability: "shell.execute",
    resourceId: "full-host-shell",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
    command: "printf exact",
  });
  const effect = mock.fn(async () => "done");
  const first = broker.request(shell, effect, { taskId: "standalone-reusable" }).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  broker.cancelTask({ botId: BOT_A, taskId: "standalone-reusable" });
  lookup.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await first).code, "OPENBOT_PERMISSION_CANCELLED");
  assert.deepEqual(prompts, []);
  assert.equal(effect.mock.callCount(), 0);

  const reused = await promptFor(broker, () => broker.request(
    shell,
    effect,
    { taskId: "standalone-reusable" },
  ));
  assert.equal(await broker.decide({ ...identity(reused.prompt), decision: "once" }), "done");
  assert.equal(await reused.pending, "done");
  assert.equal(effect.mock.callCount(), 1);
});

test("broker replays frozen bot-scoped pending requests until they settle", async () => {
  const { broker } = fixture();
  const effect = mock.fn(async () => "done");
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const rejected = pending.catch((error) => error);

  const replay = await broker.listPending(BOT_A);
  assert.deepEqual(replay, [prompt]);
  assert.notEqual(replay[0], prompt);
  assertDeepFrozen(replay);
  assert.deepEqual(await broker.listPending(BOT_B), []);

  await assert.rejects(
    broker.decide({ ...identity(prompt), decision: "deny" }),
    /denied/i,
  );
  assert.match((await rejected).message, /denied/i);
  assert.deepEqual(await broker.listPending(BOT_A), []);
});

test("broker lists grants only for the current local Computer identity", async () => {
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "folder-a",
    resourceLabel: "Folder A",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const listed = [];
  const { broker, setCurrent, store } = fixture({
    store: {
      listPublic: mock.fn(async (botId, target) => {
        listed.push({ botId, target });
        return target?.targetId === TARGET_A && target?.targetGeneration === 4 ? [grant] : [];
      }),
    },
  });
  assert.deepEqual(await broker.list(BOT_A), [grant]);
  assert.deepEqual(listed, [{
    botId: BOT_A,
    target: { targetId: TARGET_A, targetGeneration: 4 },
  }]);
  setCurrent(computer(BOT_A, 4, { localProfileId: TARGET_B }));
  assert.deepEqual(await broker.list(BOT_A), []);
  assert.deepEqual(listed.at(-1), {
    botId: BOT_A,
    target: { targetId: TARGET_B, targetGeneration: 4 },
  });
  setCurrent(computer(BOT_A, 5));
  assert.deepEqual(await broker.list(BOT_A), []);
  setCurrent(computer(BOT_A, 5, { mode: "not-now", state: "unconfigured", localProfileId: null }));
  assert.deepEqual(await broker.list(BOT_A), []);
  assert.equal(store.listPublic.mock.callCount(), 3, "non-local Computers must not expose old grants");
  broker.dispose();
});

test("broker suppresses a grant list that becomes stale while storage is pending", async () => {
  const held = deferred();
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "folder-a",
    resourceLabel: "Folder A",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const { broker, readCurrentComputer, setCurrent, store } = fixture({
    store: {
      listPublic: mock.fn(async () => held.promise),
    },
  });
  const listing = broker.list(BOT_A);
  while (store.listPublic.mock.callCount() === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  setCurrent(computer(BOT_A, 5));
  held.resolve([grant]);

  assert.deepEqual(await listing, []);
  assert.equal(readCurrentComputer.mock.callCount(), 2);
  broker.dispose();
});

test("broker bounds pending permission work per bot and globally", async (context) => {
  let nextId = 0;
  const { broker } = fixture({
    randomUUID() {
      nextId += 1;
      return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
    },
    readCurrentComputer: mock.fn(async (botId) => computer(botId)),
  });
  context.after(() => broker.dispose());
  const held = [];
  const pendingCounts = new Map();
  const addPending = async (botId) => {
    const promise = broker.request(request(botId), async () => "done");
    held.push(promise.catch((error) => error));
    const expected = (pendingCounts.get(botId) ?? 0) + 1;
    pendingCounts.set(botId, expected);
    while ((await broker.listPending(botId)).length < expected) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  for (let index = 0; index < 32; index += 1) await addPending(BOT_A);
  let perBotOutcome = null;
  const perBotOverflow = broker.request(request(BOT_A), async () => "overflow");
  void perBotOverflow.then(
    (value) => { perBotOutcome = { value }; },
    (error) => { perBotOutcome = { error }; },
  );
  for (let attempts = 0; attempts < 100 && perBotOutcome === null
    && (await broker.listPending(BOT_A)).length < 33; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await broker.listPending(BOT_A)).length, 32);
  assert.equal(perBotOutcome?.error?.code, "OPENBOT_PERMISSION_QUEUE_FULL");
  for (let index = 0; index < 32; index += 1) await addPending(BOT_B);
  let globalOutcome = null;
  const globalOverflow = broker.request(request(BOT_C), async () => "overflow");
  void globalOverflow.then(
    (value) => { globalOutcome = { value }; },
    (error) => { globalOutcome = { error }; },
  );
  for (let attempts = 0; attempts < 100 && globalOutcome === null
    && (await broker.listPending(BOT_C)).length < 1; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await broker.listPending(BOT_C)).length, 0);
  assert.equal(globalOutcome?.error?.code, "OPENBOT_PERMISSION_QUEUE_FULL");
  assert.equal((await broker.listPending(BOT_A)).length, 32);
  assert.equal((await broker.listPending(BOT_B)).length, 32);
  broker.cancelBot(BOT_A);
  broker.cancelBot(BOT_B);
  broker.cancelBot(BOT_C);
  const settled = await Promise.all(held);
  assert.equal(settled.every((error) => error?.code === "OPENBOT_PERMISSION_CANCELLED"), true);
});

test("bot switch and generation change suppress stale permission effects", async () => {
  const { broker, calls, setCurrent } = fixture();
  const effect = mock.fn();
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const rejected = pending.catch((error) => error);
  setCurrent(computer(BOT_B, 8));

  await assert.rejects(
    broker.decide({ ...identity(prompt), decision: "always" }),
    /stale|cancelled/i,
  );
  assert.match((await rejected).message, /stale|cancelled/i);
  assert.equal(effect.mock.callCount(), 0);
  assert.equal(calls.remembered.length, 0);
});

test("an Always decision revokes a just-created grant if currentness changes before effect", async () => {
  const { broker, calls, setCurrent, store } = fixture({
    store: {
      remember: mock.fn(async (input) => {
        setCurrent(computer(BOT_A, 5));
        calls.remembered.push(input);
        return Object.freeze({
          grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          botId: BOT_A,
          capability: input.capability,
          resourceId: input.resourceId,
          resourceLabel: input.resourceLabel,
          scope: "always",
          createdAt: "2026-08-15T12:34:56.000Z",
        });
      }),
    },
  });
  const effect = mock.fn();
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const rejected = pending.catch((error) => error);

  await assert.rejects(
    broker.decide({ ...identity(prompt), decision: "always" }),
    /stale|cancelled/i,
  );
  assert.match((await rejected).message, /stale|cancelled/i);
  assert.equal(effect.mock.callCount(), 0);
  assert.equal(store.revoke.mock.callCount(), 1);
});

test("remembered access remains current while denial cancellation and listeners fail safely", async () => {
  const rememberedBookmark = Buffer.from("remembered-private");
  const { broker, chooseResource, store, tcc } = fixture({
    store: {
      authorize: mock.fn(async () => Object.freeze({
        allowed: true,
        privateBookmark: rememberedBookmark,
      })),
    },
  });
  const effect = mock.fn(async (received) => {
    assert.deepEqual(received, rememberedBookmark);
    return "remembered";
  });
  assert.equal(await broker.request(request(), effect), "remembered");
  assert.equal(chooseResource.mock.callCount(), 0);
  assert.equal(tcc.ensure.mock.callCount(), 1);
  assert.equal(store.authorize.mock.callCount(), 1);

  store.authorize = mock.fn(async () => ({ allowed: false }));
  broker.on("request", () => { throw new Error("listener-secret"); });
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const denied = pending.catch((error) => error);
  await assert.rejects(
    broker.decide({ ...identity(prompt), decision: "deny" }),
    /denied/i,
  );
  assert.match((await denied).message, /denied/i);
  assert.equal(effect.mock.callCount(), 1);

  const next = await promptFor(broker, () => broker.request(request(), effect));
  const cancelled = next.pending.catch((error) => error);
  broker.cancelBot(BOT_A);
  assert.match((await cancelled).message, /cancelled/i);
  await assert.rejects(
    broker.request(new Proxy({}, { ownKeys() { throw new Error("path-token"); } }), effect),
    /plain data/i,
  );
  broker.dispose();
  await assert.rejects(broker.request(request(), effect), /disposed/i);
});

test("disposal while resource selection is pending prevents every later permission effect", async () => {
  const selection = deferred();
  const selectionStarted = deferred();
  const chooseResource = mock.fn(async () => {
    selectionStarted.resolve();
    return selection.promise;
  });
  const { bookmark, broker } = fixture({ chooseResource });
  const effect = mock.fn(async () => "must-not-run");
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const pendingOutcome = pending.catch((error) => error);
  const decisionOutcome = broker.decide({ ...identity(prompt), decision: "once" })
    .catch((error) => error);
  await selectionStarted.promise;
  broker.dispose();
  selection.resolve(bookmark);

  assert.match((await decisionOutcome).message, /disposed/i);
  assert.match((await pendingOutcome).message, /disposed/i);
  assert.equal(effect.mock.callCount(), 0);
});

test("deleteBot synchronously fences one bot, coalesces callers, and leaves another bot usable", async (t) => {
  const deletionEntered = deferred();
  const releaseDeletion = deferred();
  let nextId = 0;
  const { bookmark, broker, store } = fixture({
    randomUUID() {
      nextId += 1;
      return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
    },
    readCurrentComputer: mock.fn(async (botId) => computer(botId)),
    store: {
      deleteBot: mock.fn(async (botId) => {
        assert.equal(botId, BOT_A);
        deletionEntered.resolve();
        await releaseDeletion.promise;
      }),
    },
  });
  t.after(() => broker.dispose());
  const effectA = mock.fn(async () => "deleted-must-not-run");
  const effectB = mock.fn(async (received) => {
    assert.deepEqual(received, bookmark);
    return "other-bot-done";
  });
  const first = await promptFor(broker, () => broker.request(request(BOT_A), effectA));
  const firstOutcome = first.pending.catch((error) => error);

  const deletion = broker.deleteBot(BOT_A);
  const sameDeletion = broker.deleteBot(BOT_A);
  const blocked = broker.request(request(BOT_A), effectA).catch((error) => error);
  assert.equal((await blocked).code, "OPENBOT_PERMISSION_BOT_DELETING");
  assert.equal((await firstOutcome).code, "OPENBOT_PERMISSION_CANCELLED");
  await deletionEntered.promise;
  assert.equal(store.deleteBot.mock.callCount(), 1);
  assert.equal(effectA.mock.callCount(), 0);

  const other = await promptFor(broker, () => broker.request(request(BOT_B), effectB));
  assert.deepEqual(await broker.list(BOT_B), []);
  assert.equal(
    await broker.decide({ ...identity(other.prompt), decision: "once" }),
    "other-bot-done",
  );
  assert.equal(await other.pending, "other-bot-done");
  assert.equal(effectB.mock.callCount(), 1);
  releaseDeletion.resolve();
  await Promise.all([deletion, sameDeletion]);
  assert.equal(store.deleteBot.mock.callCount(), 1);
});

test("deleteBot waits for late remember cleanup and revokes the cancelled grant before deletion", async (t) => {
  const rememberEntered = deferred();
  const releaseRemember = deferred();
  const revokeEntered = deferred();
  const releaseRevoke = deferred();
  const deleteCalls = [];
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "folder-a",
    resourceLabel: "Folder A",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const { broker, store } = fixture({
    store: {
      remember: mock.fn(async () => {
        rememberEntered.resolve();
        await releaseRemember.promise;
        return grant;
      }),
      revoke: mock.fn(async (botId, grantId) => {
        assert.deepEqual({ botId, grantId }, { botId: BOT_A, grantId: grant.grantId });
        revokeEntered.resolve();
        await releaseRevoke.promise;
      }),
      deleteBot: mock.fn(async (botId) => deleteCalls.push(botId)),
    },
  });
  t.after(() => broker.dispose());
  const effect = mock.fn(async () => "must-not-run");
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const pendingOutcome = pending.catch((error) => error);
  const decisionOutcome = broker.decide({ ...identity(prompt), decision: "always" })
    .catch((error) => error);
  await rememberEntered.promise;

  const deletion = broker.deleteBot(BOT_A);
  assert.deepEqual(deleteCalls, []);
  releaseRemember.resolve();
  await revokeEntered.promise;
  assert.deepEqual(deleteCalls, []);
  assert.equal(effect.mock.callCount(), 0);
  releaseRevoke.resolve();

  assert.equal((await decisionOutcome).code, "OPENBOT_PERMISSION_CANCELLED");
  assert.equal((await pendingOutcome).code, "OPENBOT_PERMISSION_CANCELLED");
  await deletion;
  assert.deepEqual(deleteCalls, [BOT_A]);
  assert.equal(store.remember.mock.callCount(), 1);
  assert.equal(store.revoke.mock.callCount(), 1);
  assert.equal(store.deleteBot.mock.callCount(), 1);
});

test("deleteBot waits for an active effect and suppresses its late successful publication", async (t) => {
  const effectEntered = deferred();
  const releaseEffect = deferred();
  const deletionEntered = deferred();
  const { broker, store } = fixture({
    store: {
      deleteBot: mock.fn(async () => deletionEntered.resolve()),
    },
  });
  t.after(() => broker.dispose());
  const effect = mock.fn(async () => {
    effectEntered.resolve();
    await releaseEffect.promise;
    return "late-success";
  });
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const pendingOutcome = pending.catch((error) => error);
  const decisionOutcome = broker.decide({ ...identity(prompt), decision: "once" })
    .catch((error) => error);
  await effectEntered.promise;

  const deletion = broker.deleteBot(BOT_A);
  await Promise.resolve();
  assert.equal(store.deleteBot.mock.callCount(), 0);
  releaseEffect.resolve();
  assert.equal((await decisionOutcome).code, "OPENBOT_PERMISSION_CANCELLED");
  assert.equal((await pendingOutcome).code, "OPENBOT_PERMISSION_CANCELLED");
  await deletionEntered.promise;
  await deletion;
  assert.equal(effect.mock.callCount(), 1);
  assert.equal(store.deleteBot.mock.callCount(), 1);
});

test("deleteBot cancellation dominates a late private effect failure", async (t) => {
  const effectEntered = deferred();
  const releaseEffect = deferred();
  const { broker, store } = fixture();
  t.after(() => broker.dispose());
  const effect = mock.fn(async () => {
    effectEntered.resolve();
    await releaseEffect.promise;
  });
  const { pending, prompt } = await promptFor(broker, () => broker.request(request(), effect));
  const pendingOutcome = pending.catch((error) => error);
  const decisionOutcome = broker.decide({ ...identity(prompt), decision: "once" })
    .catch((error) => error);
  await effectEntered.promise;

  const deletion = broker.deleteBot(BOT_A);
  releaseEffect.reject(new Error("private-effect-failure"));
  const decisionFailure = await decisionOutcome;
  const pendingFailure = await pendingOutcome;
  assert.equal(decisionFailure.code, "OPENBOT_PERMISSION_CANCELLED");
  assert.equal(pendingFailure.code, "OPENBOT_PERMISSION_CANCELLED");
  assert.doesNotMatch(`${decisionFailure} ${pendingFailure}`, /private-effect-failure/);
  await deletion;
  assert.equal(store.deleteBot.mock.callCount(), 1);
});

test("a failed delete keeps the exact bot fenced and one safe retry converges", async (t) => {
  let attempts = 0;
  const { broker, store } = fixture({
    readCurrentComputer: mock.fn(async (botId) => computer(botId)),
    store: {
      deleteBot: mock.fn(async (botId) => {
        assert.equal(botId, BOT_A);
        attempts += 1;
        if (attempts === 1) throw new Error("private-store-path");
      }),
    },
  });
  t.after(() => broker.dispose());

  await assert.rejects(
    broker.deleteBot(BOT_A),
    (error) => error?.code === "OPENBOT_PERMISSION_DELETE_FAILED"
      && !/private-store-path/.test(String(error)),
  );
  await assert.rejects(
    broker.list(BOT_A),
    (error) => error?.code === "OPENBOT_PERMISSION_BOT_DELETING",
  );
  assert.deepEqual(await broker.list(BOT_B), []);
  await broker.deleteBot(BOT_A);
  await broker.deleteBot(BOT_A);
  assert.equal(store.deleteBot.mock.callCount(), 2, "completed retry must be idempotent");
});

test("broker disposal dominates a late permission-store deletion failure", async () => {
  const deletionEntered = deferred();
  const releaseDeletion = deferred();
  const { broker } = fixture({
    store: {
      deleteBot: mock.fn(async () => {
        deletionEntered.resolve();
        return releaseDeletion.promise;
      }),
    },
  });
  const deletion = broker.deleteBot(BOT_A);
  await deletionEntered.promise;
  broker.dispose();
  releaseDeletion.reject(new Error("private-store-path"));

  await assert.rejects(
    deletion,
    (error) => error?.code === "OPENBOT_PERMISSION_DISPOSED"
      && !/private-store-path/.test(String(error)),
  );
});

test("deleteBot requires exact store support and preserves hostile bot ID rejection", async (t) => {
  assert.throws(
    () => fixture({ store: { deleteBot: undefined } }),
    /permission store/i,
  );
  const { broker, store } = fixture();
  t.after(() => broker.dispose());
  await assert.rejects(broker.deleteBot("BOT-NOT-VALID"), /Bot ID/i);
  await assert.rejects(
    broker.deleteBot(new Proxy({}, { getPrototypeOf() { throw new Error("private-path"); } })),
    /Bot ID/i,
  );
  assert.equal(store.deleteBot.mock.callCount(), 0);
});
