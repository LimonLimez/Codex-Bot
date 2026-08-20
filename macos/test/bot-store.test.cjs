"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AsyncResource } = require("node:async_hooks");

const { BotStore } = require("../src/bots/bot-store.cjs");
const { defaultAvatarIdentity } = require("../src/bots/avatar-catalog.cjs");

const BOT_A_UUID = "11111111-1111-4111-8111-111111111111";
const BOT_B_UUID = "22222222-2222-4222-8222-222222222222";
const BOT_C_UUID = "33333333-3333-4333-8333-333333333333";
const BOT_CASE_UUID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const TEMP_A_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEMP_B_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEMP_C_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = "2026-08-14T12:34:56.000Z";
const ISSUANCE_A = "issuance-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUANCE_B = "issuance-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RETIREMENT_A = "retire-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sequence(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, "test UUID sequence was exhausted");
    return values[index++];
  };
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

async function temporaryStore(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  return {
    directory,
    filePath,
    store: new BotStore({
      filePath,
      now: () => NOW,
      randomUUID: sequence(options.uuids || [BOT_A_UUID, TEMP_A_UUID, BOT_B_UUID, TEMP_B_UUID, BOT_C_UUID, TEMP_C_UUID]),
      ...(options.fs ? { fs: options.fs } : {}),
    }),
  };
}

function expectedBot(overrides = {}) {
  const botId = overrides.botId ?? `bot-${BOT_A_UUID}`;
  const defaults = defaultAvatarIdentity(botId.toLowerCase());
  const base = {
    schemaVersion: 3,
    botId,
    name: "New Bot",
    appearance: {
      ...defaults,
      image: null,
      title: "",
      description: "",
    },
    notifications: true,
    createdAt: NOW,
    updatedAt: NOW,
    conversations: [],
    runtime: {
      provider: null,
      remoteRuntimeId: null,
      state: "unprovisioned",
      lastConfirmedAt: null,
      lastErrorCode: null,
    },
    computer: expectedComputer(),
    setupStage: "profile-model",
  };
  return {
    ...base,
    ...overrides,
    botId,
    appearance: { ...base.appearance, ...(overrides.appearance || {}) },
    runtime: { ...base.runtime, ...(overrides.runtime || {}) },
    computer: { ...base.computer, ...(overrides.computer || {}) },
  };
}

function validStoreDocument(
  bots = [],
  legacyImports = {},
  deletedLegacyImports = {},
  pendingDeletions = [],
) {
  return {
    schemaVersion: 4,
    bots,
    legacyImports,
    deletedLegacyImports,
    pendingDeletions,
  };
}

function validV5StoreDocument(
  bots = [],
  legacyImports = {},
  deletedLegacyImports = {},
  pendingDeletions = [],
  runtimeIssuances = [],
) {
  return {
    schemaVersion: 5,
    bots,
    legacyImports,
    deletedLegacyImports,
    pendingDeletions,
    runtimeIssuances,
  };
}

function validV3StoreDocument(bots = [], legacyImports = {}) {
  return { schemaVersion: 3, bots, legacyImports };
}

function expectedComputer(overrides = {}) {
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

function expectedV1Bot(overrides = {}) {
  const { computer: _computer, setupStage: _setupStage, ...bot } = expectedBot(overrides);
  return { ...bot, schemaVersion: 1 };
}

function expectedV2Bot(overrides = {}) {
  const { setupStage: _setupStage, ...bot } = expectedBot(overrides);
  return { ...bot, schemaVersion: 2 };
}

function validV1StoreDocument(bots = [], legacyImports = {}) {
  return { schemaVersion: 1, bots, legacyImports };
}

function validV2StoreDocument(bots = [], legacyImports = {}) {
  return { schemaVersion: 2, bots, legacyImports };
}

async function writeDocument(filePath, document) {
  await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

async function outcomeWithin(promise, timeoutMs = 75) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ status: "fulfilled", value }),
        (error) => ({ status: "rejected", error }),
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertRuntimeTransactionReentry(outcome) {
  assert.equal(outcome.status, "rejected", "same-path Store operation must reject without deadlocking");
  assert.equal(outcome.error?.code, "BOT_STORE_RUNTIME_TRANSACTION_REENTRANT");
  assert.equal(
    outcome.error?.message,
    "Bot store same-path operation is not allowed inside a runtime transaction.",
  );
  assert.doesNotMatch(JSON.stringify({
    code: outcome.error?.code,
    message: outcome.error?.message,
  }), /bots\.json|codex-bot-store-|endpoint|authToken|secret/i);
}

function assertRuntimeTransactionBusy(outcome) {
  assert.equal(outcome.status, "rejected", "active same-path transaction access must reject without queueing");
  assert.equal(outcome.error?.code, "BOT_STORE_RUNTIME_TRANSACTION_BUSY");
  assert.equal(
    outcome.error?.message,
    "Bot store path is busy with an active runtime transaction.",
  );
  assert.doesNotMatch(JSON.stringify({
    code: outcome.error?.code,
    message: outcome.error?.message,
  }), /bots\.json|codex-bot-store-|endpoint|authToken|secret/i);
}

test("schema v1 migrates to an explicit not-now Computer target", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  await writeDocument(filePath, validV1StoreDocument([expectedV1Bot()]));

  const bot = await store.read(`bot-${BOT_A_UUID}`);
  assert.deepEqual(bot.computer, expectedComputer());
  assert.equal((JSON.parse(await fs.readFile(filePath, "utf8"))).schemaVersion, 1);

  const renamed = await store.rename(bot.botId, "Migrated Bot");
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(renamed.name, "Migrated Bot");
  assert.equal(persisted.schemaVersion, 5);
  assert.deepEqual(persisted.bots[0].computer, expectedComputer());
  assert.equal(persisted.bots[0].setupStage, "complete");
});

test("setup stage distinguishes fresh setup from migrated and adopted existing bots", async (t) => {
  const v1 = await temporaryStore(t);
  await writeDocument(v1.filePath, validV1StoreDocument([expectedV1Bot()]));
  assert.equal((await v1.store.read(`bot-${BOT_A_UUID}`)).setupStage, "complete");

  const v2 = await temporaryStore(t);
  await writeDocument(v2.filePath, validV2StoreDocument([expectedV2Bot()]));
  assert.equal((await v2.store.read(`bot-${BOT_A_UUID}`)).setupStage, "complete");

  const fresh = await temporaryStore(t);
  assert.equal((await fresh.store.create()).setupStage, "profile-model");
  const adopted = await fresh.store.adoptLegacy({
    migrationKey: "existing-profile",
    name: "Existing Bot",
    appearance: { shape: "gem", color: "blue" },
    notifications: true,
    conversations: [],
  });
  assert.equal(adopted.setupStage, "complete");
});

test("trusted native creation may start complete while ordinary creation remains profile-model", async (t) => {
  const { store } = await temporaryStore(t);
  const ordinary = await store.create();
  const native = await store.create({ setupStage: "complete" });

  assert.equal(ordinary.setupStage, "profile-model");
  assert.equal(native.setupStage, "complete");
  await assert.rejects(
    store.create({ setupStage: "computer" }),
    /creation setup stage/i,
  );
});

test("provider authority fences the durable create commit immediately before the store write", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  let checks = 0;
  await assert.rejects(
    store.create({ setupStage: "complete" }, {
      commitFence: () => {
        checks += 1;
        return false;
      },
    }),
    { code: "BOT_STORE_PROVIDER_AUTHORITY_STALE" },
  );
  assert.equal(checks, 1);
  assert.deepEqual(await store.list(), []);
  assert.equal(await fs.stat(filePath).then(() => true, () => false), false);
});

test("setup stage advances only through exact monotonic expected-stage transactions", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const created = await store.create();
  assert.equal(created.setupStage, "profile-model");

  const computer = await store.advanceSetup(created.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  });
  assert.equal(computer.setupStage, "computer");
  await assert.rejects(store.advanceSetup(created.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  }), /setup stage.*changed|stale/i);
  await assert.rejects(store.advanceSetup(created.botId, {
    expectedStage: "computer",
    nextStage: "profile-model",
  }), /monotonic|transition/i);
  await assert.rejects(store.advanceSetup(created.botId, {
    expectedStage: "computer",
    nextStage: "computer",
  }), /monotonic|transition/i);

  const competing = new BotStore({ filePath, now: () => NOW, randomUUID: sequence([TEMP_C_UUID]) });
  const outcomes = await Promise.allSettled([
    store.advanceSetup(created.botId, { expectedStage: "computer", nextStage: "complete" }),
    competing.advanceSetup(created.botId, { expectedStage: "computer", nextStage: "complete" }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await store.read(created.botId)).setupStage, "complete");

  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error("/Users/private token=secret"); },
  });
  await assert.rejects(store.advanceSetup(created.botId, hostile), (error) => (
    /plain data|setup transition/i.test(error?.message)
      && !/Users|token|secret/i.test(error?.message)
  ));
});

test("a failed setup-stage commit rolls back without changing the durable stage", async (t) => {
  const base = await temporaryStore(t);
  const created = await base.store.create();
  const failingFs = {
    ...fs,
    rename: async () => {
      const error = new Error("forced setup transaction rename failure");
      error.code = "EIO";
      throw error;
    },
  };
  const failing = new BotStore({
    filePath: base.filePath,
    fs: failingFs,
    now: () => NOW,
    randomUUID: sequence([TEMP_C_UUID]),
  });
  await assert.rejects(failing.advanceSetup(created.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  }), /forced setup transaction rename failure/);
  assert.equal((await base.store.read(created.botId)).setupStage, "profile-model");
});

test("a setup-stage commit fence rejects inside the serialized transition without advancing", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create();
  let inspected = null;
  await assert.rejects(store.advanceSetup(created.botId, {
    expectedStage: "profile-model",
    nextStage: "computer",
  }, (current) => {
    inspected = current;
    throw new Error("authoritative setup receipt changed");
  }), /authoritative setup receipt changed/);
  assert.equal(inspected.botId, created.botId);
  assert.equal(inspected.setupStage, "profile-model");
  assert.equal((await store.read(created.botId)).setupStage, "profile-model");
});

test("Computer selection is exact monotonic and rejects hostile patches", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create();
  assert.deepEqual(created.computer, expectedComputer());

  const selected = await store.updateComputer(created.botId, {
    mode: "local",
    generation: 1,
    localProfileId: "local-11111111-1111-4111-8111-111111111111",
    nativeAgentId: null,
    state: "starting",
    lastConfirmedAt: null,
    lastErrorCode: null,
  });
  assert.deepEqual(selected.computer, expectedComputer({
    mode: "local",
    generation: 1,
    localProfileId: "local-11111111-1111-4111-8111-111111111111",
    state: "starting",
  }));

  await assert.rejects(store.updateComputer(created.botId, {
    mode: "not-now",
    generation: 0,
  }), /generation.*stale/i);

  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error("secret-path-token"); },
  });
  await assert.rejects(
    store.updateComputer(created.botId, hostile),
    (error) => /plain data|computer patch/i.test(error?.message)
      && !/secret-path-token/i.test(error?.message),
  );
  assert.deepEqual((await store.read(created.botId)).computer, selected.computer);
});

test("Cursor may persist explicit unavailable state without a native agent, but lifecycle states require one", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create();

  const unavailable = await store.updateComputer(created.botId, {
    mode: "cursor",
    generation: 1,
    state: "unavailable",
    lastErrorCode: "CURSOR_ACCOUNT_REQUIRED",
  });
  assert.equal(unavailable.computer.nativeAgentId, null);
  assert.equal(unavailable.computer.state, "unavailable");

  await assert.rejects(store.updateComputer(created.botId, {
    generation: 2,
    state: "starting",
    lastErrorCode: null,
  }), /native agent ID/i);
});

test("Computer local profile ownership is unique across bot updates and failed mutation is atomic", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const first = await store.create();
  const second = await store.create();
  const localProfileId = "local-11111111-1111-4111-8111-111111111111";
  await store.updateComputer(first.botId, {
    mode: "local",
    generation: 1,
    localProfileId,
    nativeAgentId: null,
    state: "starting",
    lastConfirmedAt: null,
    lastErrorCode: null,
  });
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(store.updateComputer(second.botId, {
    mode: "local",
    generation: 1,
    localProfileId: localProfileId.toUpperCase(),
    nativeAgentId: null,
    state: "starting",
    lastConfirmedAt: null,
    lastErrorCode: null,
  }), /duplicate local profile/i);
  assert.equal(await fs.readFile(filePath, "utf8"), before);
  assert.deepEqual((await store.read(second.botId)).computer, expectedComputer());
});

test("create stores a stable literal New Bot and ignores caller-owned identity", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const input = {
    botId: "bot-forged",
    name: "Search text must not become a name",
    appearance: { shape: "pebble", color: "blue" },
    notifications: false,
    runtime: { provider: "forged", remoteRuntimeId: "shared-runtime", state: "ready" },
    conversations: [{ source: "chatgpt", conversationId: "forged-chat" }],
    endpoint: "wss://private.example.test/app-server",
    authToken: "secret",
    unknown: "ignored",
  };

  const created = await store.create(input);
  assert.deepEqual(created, expectedBot({
    appearance: { shape: "pebble", color: "blue" },
    notifications: false,
  }));
  assert.equal(created.name, "New Bot");
  assert.match(created.botId, /^bot-[0-9a-f-]{36}$/);
  assert.deepEqual(created.runtime, {
    provider: null,
    remoteRuntimeId: null,
    state: "unprovisioned",
    lastConfirmedAt: null,
    lastErrorCode: null,
  });
  assert.deepEqual(created.conversations, []);

  input.appearance.shape = "gem";
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(persisted, validV5StoreDocument([expectedBot({
    appearance: { shape: "pebble", color: "blue" },
    notifications: false,
  })]));
  assert.doesNotMatch(JSON.stringify(persisted), /forged|private\.example|secret|unknown/);
});

test("create derives only omitted appearance fields in the first durable write", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const automatic = await store.create({ appearance: { description: "Automatic" } });
  assert.deepEqual(
    { shape: automatic.appearance.shape, color: automatic.appearance.color },
    defaultAvatarIdentity(automatic.botId),
  );
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8")).bots[0];
  assert.deepEqual(persisted.appearance, automatic.appearance);

  const explicitShape = await store.create({ appearance: { shape: "cat" } });
  assert.equal(explicitShape.appearance.shape, "cat");
  assert.equal(explicitShape.appearance.color, defaultAvatarIdentity(explicitShape.botId).color);

  const explicitColor = await store.create({ appearance: { color: "violet" } });
  assert.equal(explicitColor.appearance.shape, defaultAvatarIdentity(explicitColor.botId).shape);
  assert.equal(explicitColor.appearance.color, "violet");
});

test("existing appearance survives load restart edit and deletion without reassignment", async (t) => {
  const { filePath } = await temporaryStore(t);
  const existing = expectedBot({ appearance: { shape: "gem", color: "blue" } });
  await writeDocument(filePath, validV5StoreDocument([existing]));
  const restarted = new BotStore({ filePath, now: () => NOW });
  assert.deepEqual((await restarted.read(existing.botId)).appearance, existing.appearance);
  const edited = await restarted.updateProfile(existing.botId, { appearance: { shape: "wolf" } });
  assert.equal(edited.appearance.shape, "wolf");
  assert.equal(edited.appearance.color, "blue");
  await restarted.deleteBots([existing.botId]);
  assert.equal(await restarted.read(existing.botId), null);
});

test("create inspects only supported fields and never traverses ignored getters or proxy traps", async (t) => {
  const { store } = await temporaryStore(t);
  let ignoredGetterCalls = 0;
  let appearanceGetterCalls = 0;
  const appearance = { shape: "gem", color: "blue" };
  Object.defineProperty(appearance, "secret", {
    enumerable: true,
    get() {
      appearanceGetterCalls += 1;
      throw new Error("ignored appearance getter ran");
    },
  });
  const input = { appearance, notifications: false };
  Object.defineProperty(input, "runtime", {
    enumerable: true,
    get() {
      ignoredGetterCalls += 1;
      throw new Error("ignored runtime getter ran");
    },
  });

  const created = await store.create(input);
  assert.equal(created.appearance.shape, "gem");
  assert.equal(created.appearance.color, "blue");
  assert.equal(created.notifications, false);
  assert.equal(ignoredGetterCalls, 0);
  assert.equal(appearanceGetterCalls, 0);

  const trapCalls = { ownKeys: 0, get: 0, getPrototypeOf: 0 };
  const proxy = new Proxy({}, {
    ownKeys() {
      trapCalls.ownKeys += 1;
      throw new Error("ignored ownKeys trap ran");
    },
    get() {
      trapCalls.get += 1;
      throw new Error("ignored get trap ran");
    },
    getPrototypeOf() {
      trapCalls.getPrototypeOf += 1;
      throw new Error("ignored getPrototypeOf trap ran");
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === "appearance") return { configurable: true, enumerable: true, writable: true, value: { shape: "egg" } };
      if (key === "notifications") return { configurable: true, enumerable: true, writable: true, value: true };
      return undefined;
    },
  });
  const proxied = await store.create(proxy);
  assert.equal(proxied.appearance.shape, "egg");
  assert.equal(proxied.notifications, true);
  assert.deepEqual(trapCalls, { ownKeys: 0, get: 0, getPrototypeOf: 0 });

  let selectedGetterCalls = 0;
  const selectedAccessor = {};
  Object.defineProperty(selectedAccessor, "notifications", {
    enumerable: true,
    get() {
      selectedGetterCalls += 1;
      return false;
    },
  });
  await assert.rejects(store.create(selectedAccessor), /accessor|plain data/i);
  assert.equal(selectedGetterCalls, 0);
});

test("rename is the only naming path and profile updates are strictly scoped", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create({ name: "Not a name" });
  const renamed = await store.rename(created.botId, "Nova");
  assert.equal(renamed.name, "Nova");

  const updated = await store.updateProfile(created.botId, {
    appearance: {
      shape: "gem",
      color: "violet",
      image: "data:image/png;base64,aGVsbG8=",
      title: "Builder",
      description: "Ships code",
    },
    notifications: false,
  });
  assert.deepEqual(updated.appearance, {
    shape: "gem",
    color: "violet",
    image: "data:image/png;base64,aGVsbG8=",
    title: "Builder",
    description: "Ships code",
  });
  assert.equal(updated.notifications, false);
  assert.equal(updated.name, "Nova");
  assert.equal(updated.botId, created.botId);
  assert.deepEqual(updated.runtime, created.runtime);
  assert.deepEqual(updated.conversations, []);

  await assert.rejects(store.updateProfile(created.botId, { name: "Profile rename" }), /unsupported profile field/i);
  await assert.rejects(store.updateProfile(created.botId, { runtime: { state: "ready" } }), /unsupported profile field/i);
  await assert.rejects(store.updateProfile(created.botId, { appearance: { source: "image" } }), /appearance field/i);
  await assert.rejects(store.rename(created.botId, ""), /name/i);
  await assert.rejects(store.rename(created.botId, "n".repeat(161)), /name/i);
  assert.equal((await store.read(created.botId)).name, "Nova");
});

test("public values are detached deeply frozen snapshots", async (t) => {
  const { store } = await temporaryStore(t);
  const input = { appearance: { shape: "pebble", color: "blue" } };
  const created = await store.create(input);
  const listed = await store.list();
  const read = await store.read(created.botId);

  assert.notEqual(created, listed[0]);
  assert.notEqual(listed[0], read);
  assert.notEqual(created.appearance, read.appearance);
  assertDeepFrozen(created);
  assertDeepFrozen(listed);
  assertDeepFrozen(read);
  assert.throws(() => { created.name = "Mutated"; }, TypeError);
  assert.throws(() => { listed[0].appearance.shape = "gem"; }, TypeError);
  assert.throws(() => { read.conversations.push({ source: "chatgpt", conversationId: "chat-forged" }); }, TypeError);
  input.appearance.shape = "egg";
  assert.equal((await store.read(created.botId)).appearance.shape, "pebble");
  assert.equal((await store.read(created.botId)).name, "New Bot");
});

test("serializes overlapping creates without losing either identity", async (t) => {
  const { filePath, store } = await temporaryStore(t, {
    uuids: [BOT_A_UUID, TEMP_A_UUID, BOT_B_UUID, TEMP_B_UUID],
  });
  const [first, second] = await Promise.all([store.create(), store.create()]);
  assert.notEqual(first.botId, second.botId);
  assert.equal((await store.list()).length, 2);
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(new Set(persisted.bots.map(({ botId }) => botId)), new Set([first.botId, second.botId]));
});

test("fresh Store instances see authoritative same-path mutations", async (t) => {
  const { filePath, store: firstStore } = await temporaryStore(t);
  const created = await firstStore.create();
  const secondStore = new BotStore({ filePath, now: () => NOW });
  await secondStore.load();

  await firstStore.rename(created.botId, "Visible from disk");

  assert.equal((await secondStore.read(created.botId)).name, "Visible from disk");
});

test("runtime transaction busy rejection preserves a later stale CAS mismatch", async (t) => {
  const { filePath, store: firstStore } = await temporaryStore(t);
  const created = await firstStore.create();
  await firstStore.updateRuntime(created.botId, {
    state: "provisioning",
    lastErrorCode: "RUNTIME_OPERATION.seed",
  });
  const secondStore = new BotStore({ filePath, now: () => NOW });
  let staleCallbackCalls = 0;
  const entered = deferred();
  const release = deferred();

  const winnerPromise = firstStore.runtimeTransaction(
    created.botId,
    { expectedLastErrorCode: "RUNTIME_OPERATION.seed" },
    async ({ updateRuntime }) => {
      entered.resolve();
      await release.promise;
      updateRuntime({ lastErrorCode: "RUNTIME_OPERATION.winner" });
    },
  );
  await entered.promise;
  const busy = await outcomeWithin(secondStore.runtimeTransaction(
    created.botId,
    { expectedLastErrorCode: "RUNTIME_OPERATION.seed" },
    () => { staleCallbackCalls += 1; },
  ));
  assertRuntimeTransactionBusy(busy);
  assert.equal(staleCallbackCalls, 0);
  release.resolve();
  const winner = await winnerPromise;
  const stale = await secondStore.runtimeTransaction(
    created.botId,
    { expectedLastErrorCode: "RUNTIME_OPERATION.seed" },
    () => { staleCallbackCalls += 1; },
  );

  assert.equal(winner.matched, true);
  assert.equal(winner.bot.runtime.lastErrorCode, "RUNTIME_OPERATION.winner");
  assert.equal(stale.matched, false);
  assert.equal(stale.bot.runtime.lastErrorCode, "RUNTIME_OPERATION.winner");
  assert.equal(staleCallbackCalls, 0);
  assertDeepFrozen(winner);
  assertDeepFrozen(stale);
});

test("a busy unrelated-bot update can retry after the runtime transaction without data loss", async (t) => {
  const { filePath, store: firstStore } = await temporaryStore(t, {
    uuids: [BOT_A_UUID, TEMP_A_UUID, BOT_B_UUID, TEMP_B_UUID, TEMP_C_UUID],
  });
  const first = await firstStore.create();
  const second = await firstStore.create();
  const secondStore = new BotStore({ filePath, now: () => NOW });
  const entered = deferred();
  const release = deferred();

  const runtimeWrite = firstStore.runtimeTransaction(first.botId, {}, async ({ updateRuntime }) => {
    entered.resolve();
    await release.promise;
    updateRuntime({
      provider: "openai",
      remoteRuntimeId: "runtime-cross-instance",
      state: "ready",
      lastConfirmedAt: NOW,
      lastErrorCode: null,
    });
  });
  await entered.promise;
  const busyRename = await outcomeWithin(secondStore.rename(second.botId, "Must not queue"));
  assertRuntimeTransactionBusy(busyRename);
  release.resolve();
  await runtimeWrite;
  await secondStore.rename(second.botId, "Preserved rename");

  const authoritative = await new BotStore({ filePath }).list();
  assert.equal(authoritative.find(({ botId }) => botId === first.botId).runtime.remoteRuntimeId, "runtime-cross-instance");
  assert.equal(authoritative.find(({ botId }) => botId === second.botId).name, "Preserved rename");
});

test("a thrown runtime transaction releases the same-path lock without committing", async (t) => {
  const { filePath, store: firstStore } = await temporaryStore(t);
  const created = await firstStore.create();
  const secondStore = new BotStore({ filePath, now: () => NOW });

  await assert.rejects(firstStore.runtimeTransaction(created.botId, {}, ({ updateRuntime }) => {
    updateRuntime({ state: "provisioning", lastErrorCode: "RUNTIME_OPERATION.discarded" });
    throw new Error("transaction aborted");
  }), /transaction aborted/);
  const renamed = await secondStore.rename(created.botId, "Lock released");

  assert.equal(renamed.name, "Lock released");
  assert.equal(renamed.runtime.state, "unprovisioned");
  assert.equal(renamed.runtime.lastErrorCode, null);
});

test("runtime transactions promptly reject same-path reads through the same or another Store", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const created = await store.create();
  const otherStore = new BotStore({ filePath, now: () => NOW });
  let sameStoreRead;
  let otherStoreRead;

  await store.runtimeTransaction(created.botId, {}, async () => {
    [sameStoreRead, otherStoreRead] = await Promise.all([
      outcomeWithin(store.read(created.botId)),
      outcomeWithin(otherStore.read(created.botId)),
    ]);
  });

  const later = await otherStore.rename(created.botId, "Lock still usable");
  assertRuntimeTransactionReentry(sameStoreRead);
  assertRuntimeTransactionReentry(otherStoreRead);
  assert.equal(later.name, "Lock still usable");
});

test("runtime transactions promptly reject nested transactions and mutations then release the lock", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const created = await store.create();
  const otherStore = new BotStore({ filePath, now: () => NOW });
  let nestedTransaction;
  let sameStoreMutation;
  let otherStoreMutation;

  await store.runtimeTransaction(created.botId, {}, async () => {
    [nestedTransaction, sameStoreMutation, otherStoreMutation] = await Promise.all([
      outcomeWithin(store.runtimeTransaction(created.botId, {}, () => {})),
      outcomeWithin(store.updateRuntime(created.botId, { state: "provisioning" })),
      outcomeWithin(otherStore.rename(created.botId, "Must not run from transaction")),
    ]);
  });

  const later = await otherStore.rename(created.botId, "Ordinary later mutation");
  assertRuntimeTransactionReentry(nestedTransaction);
  assertRuntimeTransactionReentry(sameStoreMutation);
  assertRuntimeTransactionReentry(otherStoreMutation);
  assert.equal(later.name, "Ordinary later mutation");
  assert.equal(later.runtime.state, "unprovisioned");
});

test("nested path transactions reject an outer-path reentry instead of forgetting the outer lock", async (t) => {
  const first = await temporaryStore(t);
  const second = await temporaryStore(t);
  const firstBot = await first.store.create();
  const secondBot = await second.store.create();
  let outerPathRead;

  await first.store.runtimeTransaction(firstBot.botId, {}, async () => {
    await second.store.runtimeTransaction(secondBot.botId, {}, async ({ updateRuntime }) => {
      outerPathRead = await outcomeWithin(first.store.read(firstBot.botId));
      updateRuntime({ state: "provisioning" });
    });
  });

  const laterFirst = await first.store.rename(firstBot.botId, "Outer lock released");
  const laterSecond = await second.store.read(secondBot.botId);
  assertRuntimeTransactionReentry(outerPathRead);
  assert.equal(laterFirst.name, "Outer lock released");
  assert.equal(laterSecond.runtime.state, "provisioning");
});

test("inverse runtime transactions reject cross-path access instead of deadlocking", async (t) => {
  const first = await temporaryStore(t);
  const second = await temporaryStore(t);
  const firstBot = await first.store.create();
  const secondBot = await second.store.create();
  const firstEntered = deferred();
  const secondEntered = deferred();
  let firstCrossRead;
  let secondCrossRead;

  const firstTransaction = first.store.runtimeTransaction(firstBot.botId, {}, async () => {
    firstEntered.resolve();
    await secondEntered.promise;
    firstCrossRead = await outcomeWithin(second.store.read(secondBot.botId));
  });
  const secondTransaction = second.store.runtimeTransaction(secondBot.botId, {}, async () => {
    secondEntered.resolve();
    await firstEntered.promise;
    secondCrossRead = await outcomeWithin(first.store.read(firstBot.botId));
  });
  await Promise.all([firstTransaction, secondTransaction]);

  assertRuntimeTransactionBusy(firstCrossRead);
  assertRuntimeTransactionBusy(secondCrossRead);
  assert.equal((await first.store.rename(firstBot.botId, "First lock recovered")).name, "First lock recovered");
  assert.equal((await second.store.rename(secondBot.botId, "Second lock recovered")).name, "Second lock recovered");
});

test("outside same-path reads mutations and transactions reject while a runtime transaction is active", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const created = await store.create();
  const readingStore = new BotStore({ filePath, now: () => NOW });
  const mutatingStore = new BotStore({ filePath, now: () => NOW });
  const transactionStore = new BotStore({ filePath, now: () => NOW });
  const entered = deferred();
  const release = deferred();

  const activeTransaction = store.runtimeTransaction(created.botId, {}, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const [readOutcome, mutationOutcome, transactionOutcome] = await Promise.all([
    outcomeWithin(readingStore.read(created.botId)),
    outcomeWithin(mutatingStore.rename(created.botId, "Must not queue")),
    outcomeWithin(transactionStore.runtimeTransaction(created.botId, {}, () => {})),
  ]);
  release.resolve();
  await activeTransaction;

  assertRuntimeTransactionBusy(readOutcome);
  assertRuntimeTransactionBusy(mutationOutcome);
  assertRuntimeTransactionBusy(transactionOutcome);
  assert.equal((await readingStore.read(created.botId)).name, "New Bot");
  assert.equal((await mutatingStore.rename(created.botId, "Lock released")).name, "Lock released");
  const laterTransaction = await transactionStore.runtimeTransaction(created.botId, {}, ({ updateRuntime }) => {
    updateRuntime({ state: "provisioning" });
  });
  assert.equal(laterTransaction.bot.runtime.state, "provisioning");
});

test("escaped provider callbacks cannot await the Store's active runtime transaction owner", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create();
  const escapedResource = new AsyncResource("escaped-store-owner-wait");
  t.after(() => escapedResource.emitDestroy());
  let escapedOutcome;

  await store.runtimeTransaction(created.botId, {}, async () => {
    escapedOutcome = await outcomeWithin(
      Promise.resolve().then(() => escapedResource.runInAsyncScope(() => (
        store.waitForRuntimeTransaction()
      ))),
    );
  });

  assert.equal(escapedOutcome.status, "rejected", "escaped callback must reject instead of awaiting its owner");
  assert.equal(typeof store.waitForRuntimeTransaction, "undefined");
  assert.doesNotMatch(JSON.stringify({
    code: escapedOutcome.error?.code,
    message: escapedOutcome.error?.message,
  }), /bots\.json|codex-bot-store-|endpoint|authToken|secret/i);
  assert.equal((await store.rename(created.botId, "Owner wait removed")).name, "Owner wait removed");
});

test("detached setImmediate and promise descendants become inactive after transaction completion", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create();
  const releasePromise = deferred();
  let immediateRead;
  let promiseMutation;

  await store.runtimeTransaction(created.botId, {}, () => {
    immediateRead = new Promise((resolve, reject) => {
      setImmediate(() => store.read(created.botId).then(resolve, reject));
    });
    promiseMutation = releasePromise.promise.then(() => store.rename(created.botId, "Detached mutation"));
  });
  releasePromise.resolve();

  const [readOutcome, mutationOutcome] = await Promise.all([
    outcomeWithin(immediateRead),
    outcomeWithin(promiseMutation),
  ]);
  assert.equal(readOutcome.status, "fulfilled");
  assert.equal(readOutcome.value.botId, created.botId);
  assert.equal(mutationOutcome.status, "fulfilled");
  assert.equal(mutationOutcome.value.name, "Detached mutation");
});

test("a thrown nested transaction deactivates every retained path token", async (t) => {
  const first = await temporaryStore(t);
  const second = await temporaryStore(t);
  const firstBot = await first.store.create();
  const secondBot = await second.store.create();
  const releaseDetached = deferred();
  let retainedOuterRead;
  let retainedInnerMutation;

  await assert.rejects(
    first.store.runtimeTransaction(firstBot.botId, {}, async () => {
      await second.store.runtimeTransaction(secondBot.botId, {}, () => {
        retainedOuterRead = releaseDetached.promise.then(() => first.store.read(firstBot.botId));
        retainedInnerMutation = releaseDetached.promise.then(() => (
          second.store.rename(secondBot.botId, "Nested token released")
        ));
        throw new Error("nested transaction aborted");
      });
    }),
    /nested transaction aborted/,
  );
  releaseDetached.resolve();

  const [outerOutcome, innerOutcome] = await Promise.all([
    outcomeWithin(retainedOuterRead),
    outcomeWithin(retainedInnerMutation),
  ]);
  assert.equal(outerOutcome.status, "fulfilled");
  assert.equal(innerOutcome.status, "fulfilled");
  assert.equal(innerOutcome.value.name, "Nested token released");
  assert.equal((await first.store.rename(firstBot.botId, "Ordinary outer mutation")).name, "Ordinary outer mutation");
  assert.equal((await second.store.read(secondBot.botId)).name, "Nested token released");
});

test("runtime transactions expose frozen sanitized snapshots and preserve durable write ordering", async (t) => {
  const calls = [];
  const instrumentedFs = {
    ...fs,
    mkdir: async (...args) => { calls.push(["mkdir", args[0]]); return fs.mkdir(...args); },
    open: async (...args) => {
      calls.push(["open", args[0], args[1], args[2]]);
      const handle = await fs.open(...args);
      return {
        writeFile: async (...writeArgs) => { calls.push(["writeFile", args[0]]); return handle.writeFile(...writeArgs); },
        sync: async () => { calls.push(["sync", args[0]]); return handle.sync(); },
        close: async () => { calls.push(["close", args[0]]); return handle.close(); },
      };
    },
    rename: async (...args) => { calls.push(["rename", ...args]); return fs.rename(...args); },
  };
  const { directory, filePath, store } = await temporaryStore(t, {
    fs: instrumentedFs,
    uuids: [BOT_A_UUID, TEMP_A_UUID, TEMP_B_UUID],
  });
  const created = await store.create();
  calls.length = 0;
  let transactionSnapshot = null;
  let updatedSnapshot = null;

  const outcome = await store.runtimeTransaction(created.botId, {}, (transaction) => {
    transactionSnapshot = transaction;
    assert.throws(() => { transaction.bot.name = "forged"; }, TypeError);
    assert.throws(() => { transaction.bots.push({}); }, TypeError);
    updatedSnapshot = transaction.updateRuntime({
      state: "provisioning",
      lastErrorCode: "RUNTIME_OPERATION.durable",
    });
  });

  assertDeepFrozen(transactionSnapshot);
  assertDeepFrozen(updatedSnapshot);
  assertDeepFrozen(outcome);
  assert.deepEqual(Reflect.ownKeys(outcome), ["matched", "bot"]);
  assert.equal(outcome.isCurrentRuntimeCommit, undefined);
  assert.equal(store.isCurrentRuntimeCommit(outcome, created.botId), true);
  assert.doesNotMatch(JSON.stringify({ transactionSnapshot, updatedSnapshot, outcome }), /endpoint|authToken|credential|secret/i);
  assert.equal(outcome.bot.runtime.lastErrorCode, "RUNTIME_OPERATION.durable");
  const opened = calls.find(([operation]) => operation === "open");
  const renamed = calls.find(([operation]) => operation === "rename");
  assert.equal(path.dirname(opened[1]), directory);
  assert.deepEqual(renamed, ["rename", opened[1], filePath]);
  assert.deepEqual(calls.map(([operation]) => operation), [
    "mkdir", "open", "writeFile", "sync", "close", "rename", "open", "sync", "close",
  ]);
});

test("runtime transaction afterCommit runs after durability and isolates hook exceptions", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const created = await store.create();
  const calls = [];

  const outcome = await store.runtimeTransaction(
    created.botId,
    {
      afterCommit: (...args) => {
        calls.push({ args, persisted: JSON.parse(require("node:fs").readFileSync(filePath, "utf8")) });
        throw new Error("isolated afterCommit failure");
      },
    },
    ({ updateRuntime }) => updateRuntime({
      state: "provisioning",
      lastErrorCode: "RUNTIME_OPERATION.after-commit",
    }),
  );

  assert.equal(outcome.matched, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].persisted.bots[0].runtime.state, "provisioning");
  assert.equal(calls[0].persisted.bots[0].runtime.lastErrorCode, "RUNTIME_OPERATION.after-commit");
  assert.equal((await store.read(created.botId)).runtime.state, "provisioning");
  assert.equal((await store.rename(created.botId, "Hook lock released")).name, "Hook lock released");
});

test("runtime transaction afterCommit accepts only an own plain callable", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create();
  await assert.rejects(
    store.runtimeTransaction(created.botId, { afterCommit: true }, () => {}),
    /afterCommit must be a function/i,
  );
  let getterCalls = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, "afterCommit", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return () => {};
    },
  });
  await assert.rejects(
    store.runtimeTransaction(created.botId, accessorOptions, () => {}),
    /plain data|accessor/i,
  );
  assert.equal(getterCalls, 0);
  assert.equal((await store.read(created.botId)).runtime.state, "unprovisioned");
});

test("runtime transaction afterCommit skips stale CAS and precommit failure", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-store-after-commit-precommit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  let failRename = false;
  const failingFs = {
    ...fs,
    rename: async (...args) => {
      if (!failRename) return fs.rename(...args);
      failRename = false;
      const error = new Error("forced precommit rename failure");
      error.code = "EIO";
      throw error;
    },
  };
  const store = new BotStore({
    filePath,
    fs: failingFs,
    now: () => NOW,
    randomUUID: sequence([BOT_A_UUID, TEMP_A_UUID, TEMP_B_UUID, TEMP_C_UUID]),
  });
  const created = await store.create();
  let hooks = 0;

  const mismatch = await store.runtimeTransaction(
    created.botId,
    { expectedLastErrorCode: "RUNTIME_OPERATION.not-current", afterCommit: () => { hooks += 1; } },
    ({ updateRuntime }) => updateRuntime({ state: "failed", lastErrorCode: "NOT_CURRENT" }),
  );
  assert.equal(mismatch.matched, false);
  assert.equal(hooks, 0);

  failRename = true;
  await assert.rejects(
    store.runtimeTransaction(
      created.botId,
      { afterCommit: () => { hooks += 1; } },
      ({ updateRuntime }) => updateRuntime({
        state: "provisioning",
        lastErrorCode: "RUNTIME_OPERATION.precommit",
      }),
    ),
    /forced precommit rename failure/,
  );
  assert.equal(hooks, 0);
  assert.equal((await store.read(created.botId)).runtime.state, "unprovisioned");
  assert.equal((await store.rename(created.botId, "Precommit lock released")).name, "Precommit lock released");
});

test("committed-uncertain runtime transaction invokes afterCommit exactly once", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-store-after-commit-uncertain-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  let failDirectorySync = false;
  const uncertainFs = {
    ...fs,
    open: async (target, ...args) => {
      const handle = await fs.open(target, ...args);
      if (path.resolve(String(target)) !== path.resolve(directory)) return handle;
      return {
        sync: async () => {
          if (failDirectorySync) {
            failDirectorySync = false;
            const error = new Error("forced committed directory sync failure");
            error.code = "EIO";
            throw error;
          }
          return handle.sync();
        },
        close: (...closeArgs) => handle.close(...closeArgs),
      };
    },
  };
  const store = new BotStore({
    filePath,
    fs: uncertainFs,
    now: () => NOW,
    randomUUID: sequence([BOT_A_UUID, TEMP_A_UUID, TEMP_B_UUID, TEMP_C_UUID]),
  });
  const created = await store.create();
  let hooks = 0;
  failDirectorySync = true;

  let committedError = null;
  await assert.rejects(
    store.runtimeTransaction(
      created.botId,
      { afterCommit: () => { hooks += 1; } },
      ({ updateRuntime }) => updateRuntime({
        state: "provisioning",
        lastErrorCode: "RUNTIME_OPERATION.uncertain-hook",
      }),
    ),
    (error) => {
      committedError = error;
      return error?.code === "BOT_STORE_DURABILITY_UNCERTAIN" && error?.committed === true;
    },
  );

  assert.equal(hooks, 1);
  assert.equal(store.isCurrentRuntimeCommit(committedError, created.botId), true);
  assert.equal((await store.read(created.botId)).runtime.lastErrorCode, "RUNTIME_OPERATION.uncertain-hook");
  assert.equal((await store.rename(created.botId, "Uncertain hook released")).name, "Uncertain hook released");
});

test("writes through a synced same-directory temporary file before atomic rename", async (t) => {
  const calls = [];
  const instrumentedFs = {
    ...fs,
    mkdir: async (...args) => { calls.push(["mkdir", args[0]]); return fs.mkdir(...args); },
    open: async (...args) => {
      calls.push(["open", args[0], args[1], args[2]]);
      const handle = await fs.open(...args);
      return {
        writeFile: async (...writeArgs) => { calls.push(["writeFile", args[0]]); return handle.writeFile(...writeArgs); },
        sync: async () => { calls.push(["sync", args[0]]); return handle.sync(); },
        close: async () => { calls.push(["close", args[0]]); return handle.close(); },
      };
    },
    rename: async (...args) => { calls.push(["rename", ...args]); return fs.rename(...args); },
  };
  const { directory, filePath, store } = await temporaryStore(t, { fs: instrumentedFs });
  await store.create();

  const opened = calls.find(([operation]) => operation === "open");
  const renamed = calls.find(([operation]) => operation === "rename");
  assert.equal(path.dirname(opened[1]), directory);
  assert.match(path.basename(opened[1]), /^\.bots\.json\.[0-9a-f-]{36}\.tmp$/);
  assert.deepEqual(opened.slice(2), ["wx", 0o600]);
  assert.deepEqual(renamed, ["rename", opened[1], filePath]);
  assert.deepEqual(calls.map(([operation]) => operation), [
    "mkdir", "open", "writeFile", "sync", "close", "rename", "open", "sync", "close",
  ]);
  const directoryOpen = calls[6];
  assert.deepEqual(directoryOpen, ["open", directory, "r", undefined]);
});

test("an unowned temp-name collision is never deleted when exclusive open fails", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const collision = path.join(directory, `.bots.json.${TEMP_A_UUID}.tmp`);
  await fs.writeFile(collision, "pre-existing collision", "utf8");

  await assert.rejects(store.create(), { code: "EEXIST" });
  assert.equal(await fs.readFile(collision, "utf8"), "pre-existing collision");
  assert.deepEqual(await store.list(), []);
});

test("post-rename directory sync failure reports uncertain durability but preserves committed state", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-store-directory-sync-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  const calls = [];
  const failingFs = {
    ...fs,
    open: async (target, ...args) => {
      if (target !== directory) return fs.open(target, ...args);
      calls.push(["directory-open", target, ...args]);
      return {
        sync: async () => {
          calls.push(["directory-sync"]);
          const error = new Error("forced directory sync failure");
          error.code = "EIO";
          throw error;
        },
        close: async () => { calls.push(["directory-close"]); },
      };
    },
    rm: async (target, options) => {
      calls.push(["rm", target]);
      return fs.rm(target, options);
    },
  };
  const store = new BotStore({
    filePath,
    fs: failingFs,
    now: () => NOW,
    randomUUID: sequence([BOT_A_UUID, TEMP_A_UUID]),
  });

  await assert.rejects(store.create(), /directory sync|durability/i);
  assert.deepEqual(calls.slice(0, 3), [
    ["directory-open", directory, "r"],
    ["directory-sync"],
    ["directory-close"],
  ]);
  assert.equal(calls.some(([operation, target]) => operation === "rm" && target === filePath), false);
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.bots[0].botId, `bot-${BOT_A_UUID}`);
  assert.equal((await store.read(`bot-${BOT_A_UUID}`)).name, "New Bot");
  const reloaded = new BotStore({ filePath });
  assert.equal((await reloaded.read(`bot-${BOT_A_UUID}`)).name, "New Bot");
});

test("failed atomic rename preserves the destination and cleans only its owned temp", async (t) => {
  const { directory, filePath } = await temporaryStore(t);
  const original = validStoreDocument([expectedBot()]);
  await writeDocument(filePath, original);
  const sentinel = path.join(directory, ".bots.json.keep.tmp");
  await fs.writeFile(sentinel, "keep", "utf8");
  let ownedTemporary = null;
  const failingFs = {
    ...fs,
    open: async (...args) => { ownedTemporary = args[0]; return fs.open(...args); },
    rename: async () => {
      const error = new Error("forced atomic rename failure");
      error.code = "EIO";
      throw error;
    },
  };
  const store = new BotStore({
    filePath,
    fs: failingFs,
    now: () => NOW,
    randomUUID: sequence([BOT_B_UUID, TEMP_B_UUID]),
  });
  await store.load();
  await assert.rejects(store.create(), /forced atomic rename failure/);

  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), original);
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep");
  await assert.rejects(fs.access(ownedTemporary), { code: "ENOENT" });
  assert.deepEqual((await store.list()).map(({ botId }) => botId), [`bot-${BOT_A_UUID}`]);
});

test("load rejects malformed versions, keys, timestamps, states, and polluted records", async (t) => {
  const { filePath } = await temporaryStore(t);
  const cases = [
    ["unsupported version", {
      schemaVersion: 6,
      bots: [],
      legacyImports: {},
      deletedLegacyImports: {},
      pendingDeletions: [],
    }, /schema version/i],
    ["unknown root key", { schemaVersion: 1, bots: [], legacyImports: {}, endpoint: "wss://private" }, /unsupported store field/i],
    ["duplicate bot ID", validStoreDocument([expectedBot(), expectedBot()]), /duplicate bot IDs/i],
    ["invalid timestamp", validStoreDocument([expectedBot({ updatedAt: "today" })]), /timestamp/i],
    ["reversed extended-year timestamps", validStoreDocument([expectedBot({
      createdAt: "+010000-01-01T00:00:00.000Z",
      updatedAt: NOW,
    })]), /precede|timestamp/i],
    ["invalid runtime state", validStoreDocument([expectedBot({ runtime: { state: "local-ready" } })]), /runtime state/i],
    ["secret runtime key", validStoreDocument([{
      ...expectedBot(),
      runtime: { ...expectedBot().runtime, endpoint: "wss://private", authToken: "secret" },
    }]), /runtime field/i],
    ["unknown record key", validStoreDocument([{ ...expectedBot(), filesystemPath: "/Users/example" }]), /bot field/i],
  ];

  for (const [label, document, pattern] of cases) {
    await t.test(label, async () => {
      await writeDocument(filePath, document);
      await assert.rejects(new BotStore({ filePath }).load(), pattern);
    });
  }

  await fs.writeFile(filePath, "{not-json", "utf8");
  await assert.rejects(new BotStore({ filePath }).load(), /malformed/i);
  await fs.writeFile(filePath, '{"schemaVersion":1,"bots":[],"legacyImports":{},"__proto__":{"polluted":true}}', "utf8");
  await assert.rejects(new BotStore({ filePath }).load(), /prototype|unsupported store field/i);
  assert.equal({}.polluted, undefined);
});

test("canonicalizes bot IDs to lowercase before duplicate and ownership checks", async (t) => {
  const { filePath } = await temporaryStore(t);
  const lowercase = expectedBot({ botId: `bot-${BOT_CASE_UUID}` });
  const uppercase = expectedBot({ botId: `bot-${BOT_CASE_UUID.toUpperCase()}` });
  await writeDocument(filePath, validStoreDocument([lowercase, uppercase]));
  await assert.rejects(new BotStore({ filePath }).load(), /duplicate bot IDs/i);

  await writeDocument(filePath, validStoreDocument([uppercase]));
  const store = new BotStore({ filePath });
  const loaded = await store.load();
  assert.equal(loaded[0].botId, `bot-${BOT_CASE_UUID}`);
  assert.equal((await store.read(`bot-${BOT_CASE_UUID.toUpperCase()}`)).botId, `bot-${BOT_CASE_UUID}`);
});

test("load rejects duplicate remote runtimes and conversation ownership", async (t) => {
  const { filePath } = await temporaryStore(t);
  const first = expectedBot({
    runtime: { provider: "openai", remoteRuntimeId: "runtime-shared", state: "ready", lastConfirmedAt: NOW },
    conversations: [
      { source: "chatgpt", conversationId: "chat-shared" },
      { source: "codex", threadId: "thread-a" },
    ],
  });
  const second = expectedBot({
    botId: `bot-${BOT_B_UUID}`,
    runtime: { provider: "openai", remoteRuntimeId: "runtime-shared", state: "ready", lastConfirmedAt: NOW },
    conversations: [{ source: "codex", threadId: "thread-b" }],
  });
  await writeDocument(filePath, validStoreDocument([first, second]));
  await assert.rejects(new BotStore({ filePath }).load(), /duplicate remote runtime/i);

  second.runtime = { ...expectedBot().runtime };
  second.conversations = [{ source: "chatgpt", conversationId: "chat-shared" }];
  await writeDocument(filePath, validStoreDocument([first, second]));
  await assert.rejects(new BotStore({ filePath }).load(), /conversation.*another bot|duplicate conversation/i);
});

test("load, v2 migration, and create reject duplicate non-null local profile ownership", async (t) => {
  const localProfileId = "local-11111111-1111-4111-8111-111111111111";
  const localComputer = expectedComputer({
    mode: "local",
    generation: 1,
    localProfileId,
    state: "starting",
  });
  const duplicateBots = [
    expectedBot({ botId: `bot-${BOT_A_UUID}`, computer: localComputer }),
    expectedBot({
      botId: `bot-${BOT_B_UUID}`,
      computer: { ...localComputer, localProfileId: localProfileId.toUpperCase() },
    }),
  ];

  const current = await temporaryStore(t);
  await writeDocument(current.filePath, validStoreDocument(duplicateBots));
  const beforeCreate = await fs.readFile(current.filePath, "utf8");
  await assert.rejects(current.store.load(), /duplicate local profile/i);
  await assert.rejects(current.store.create(), /duplicate local profile/i);
  assert.equal(await fs.readFile(current.filePath, "utf8"), beforeCreate);

  const previous = await temporaryStore(t);
  await writeDocument(previous.filePath, validV2StoreDocument(duplicateBots.map(expectedV2Bot)));
  await assert.rejects(previous.store.load(), /duplicate local profile/i);
  assert.equal((JSON.parse(await fs.readFile(previous.filePath, "utf8"))).schemaVersion, 2);
});

test("v4 migrates to schema v5 with a null legacy issuance fence and never invents retirement identity", async (t) => {
  const { filePath } = await temporaryStore(t);
  const active = expectedBot({
    runtime: {
      provider: "legacy-provider",
      remoteRuntimeId: "active-legacy-runtime",
      state: "ready",
      lastConfirmedAt: NOW,
    },
  });
  const deletedBot = expectedBot({ botId: `bot-${BOT_B_UUID}` });
  const legacyReceipt = {
    deletionId: TEMP_A_UUID,
    createdAt: NOW,
    botIds: [deletedBot.botId],
    remoteRuntimes: [{ botId: deletedBot.botId, runtimeId: "legacy-runtime" }],
    localProfiles: [],
  };
  await writeDocument(filePath, validStoreDocument([active], {}, {}, [legacyReceipt]));

  const store = new BotStore({ filePath, now: () => NOW });
  const pending = await store.listPendingDeletions();
  assert.deepEqual(pending[0].remoteRuntimes, [{
    botId: deletedBot.botId,
    runtimeId: "legacy-runtime",
    issuanceKey: null,
    retirementKey: null,
  }]);
  await store.rename(active.botId, "Migrated legacy bot");
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.schemaVersion, 5);
  assert.deepEqual(persisted.runtimeIssuances, []);
});

test("v5 begins a private issuance intent before issuing, and exact CAS transitions never persist endpoint or token", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const bot = await store.create();
  const begun = await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  });
  assert.equal(begun.matched, true);
  const beforeProvider = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(beforeProvider.schemaVersion, 5);
  assert.deepEqual(beforeProvider.runtimeIssuances, [{
    botId: bot.botId,
    phase: "pending",
    provider: null,
    runtimeId: null,
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  }]);
  assert.doesNotMatch(JSON.stringify(beforeProvider), /endpoint|authToken|private-token/i);

  const issued = await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-a",
  });
  assert.equal(issued.matched, true);
  const promoted = await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-a",
    state: "ready",
    lastConfirmedAt: NOW,
    expectedPreviousIssuanceKey: null,
  });
  assert.equal(promoted.matched, true);
  assert.deepEqual(await store.readRuntimeIssuances(bot.botId), [{
    botId: bot.botId,
    phase: "active",
    provider: "authorized-test-provider",
    runtimeId: "runtime-a",
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  }]);
  await assert.equal((await store.abortRuntimeIssuance(bot.botId, { issuanceKey: ISSUANCE_B })).matched, false);
});

test("v5 deletion moves the active issuance into a fenced receipt and removes the ledger atomically", async (t) => {
  const { filePath, store } = await temporaryStore(t, {
    uuids: Array(20).fill(TEMP_A_UUID),
  });
  const bot = await store.create();
  await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  });
  await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-fenced",
  });
  await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-fenced",
    state: "ready",
    lastConfirmedAt: NOW,
    expectedPreviousIssuanceKey: null,
  });

  await store.deleteBots([bot.botId]);
  const [receipt] = await store.listPendingDeletions();
  assert.deepEqual(receipt.remoteRuntimes, [{
    botId: bot.botId,
    runtimeId: "runtime-fenced",
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  }]);
  assert.equal(Object.hasOwn(receipt.remoteRuntimes[0], "idempotencyKey"), false);
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(persisted.runtimeIssuances, []);
  assert.doesNotMatch(JSON.stringify(persisted), /endpoint|authToken|private-token/i);
});

test("v5 deletion fails closed while a pending issuance intent is unresolved", async (t) => {
  const { filePath, store } = await temporaryStore(t);
  const bot = await store.create();
  await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  });

  await assert.rejects(
    () => store.deleteBots([bot.botId]),
    { code: "BOT_STORE_RUNTIME_ISSUANCE_PENDING" },
  );
  assert.equal(await store.read(bot.botId) !== null, true);
  assert.deepEqual((await store.readRuntimeIssuances(bot.botId)).map(({ issuanceKey, phase }) => ({ issuanceKey, phase })), [{
    issuanceKey: ISSUANCE_A,
    phase: "pending",
  }]);
  assert.doesNotMatch(await fs.readFile(filePath, "utf8"), /endpoint|authToken|private-token/i);
});

test("v5 issuance transitions are exact CAS and mismatches do not mutate the ledger", async (t) => {
  const { store } = await temporaryStore(t, { uuids: Array(20).fill(TEMP_A_UUID) });
  const bot = await store.create();
  assert.equal((await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  })).matched, true);
  assert.equal((await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_B,
    provider: "authorized-test-provider",
    runtimeId: "runtime-wrong",
  })).matched, false);
  assert.equal((await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_B,
    provider: "authorized-test-provider",
    runtimeId: "runtime-wrong",
    expectedPreviousIssuanceKey: null,
  })).matched, false);
  assert.equal((await store.abortRuntimeIssuance(bot.botId, { issuanceKey: ISSUANCE_B })).matched, false);
  assert.equal((await store.readRuntimeIssuances(bot.botId))[0].issuanceKey, ISSUANCE_A);
});

test("v5 issuance mutations reject accessors, proxies, symbols, and extra keys before effects", async (t) => {
  const { store } = await temporaryStore(t);
  const bot = await store.create();
  const validBegin = {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  };
  const accessor = {};
  Object.defineProperty(accessor, "issuanceKey", {
    get() { throw new Error("getter must not run"); },
    enumerable: true,
  });
  await assert.rejects(() => store.beginRuntimeIssuance(bot.botId, accessor));
  await assert.rejects(() => store.beginRuntimeIssuance(bot.botId, { ...validBegin, extra: true }));
  await assert.rejects(() => store.beginRuntimeIssuance(bot.botId, { ...validBegin, [Symbol("secret")]: true }));
  const revoked = Proxy.revocable({ ...validBegin }, {});
  revoked.revoke();
  await assert.rejects(() => store.beginRuntimeIssuance(bot.botId, revoked.proxy));
  assert.deepEqual(await store.readRuntimeIssuances(bot.botId), []);

  await store.beginRuntimeIssuance(bot.botId, validBegin);
  const mutationCases = [
    ["issue", () => store.issueRuntimeIssuance(bot.botId, accessor)],
    ["promote", () => store.promoteRuntimeIssuance(bot.botId, accessor)],
    ["confirm", () => store.confirmRuntimeIssuance(bot.botId, accessor)],
    ["abort", () => store.abortRuntimeIssuance(bot.botId, accessor)],
  ];
  for (const [name, operation] of mutationCases) {
    await assert.rejects(operation, undefined, `${name} accessor was accepted`);
  }
  const extraCases = [
    () => store.issueRuntimeIssuance(bot.botId, {
      issuanceKey: ISSUANCE_A, provider: "authorized-test-provider", runtimeId: "runtime-extra", extra: true,
    }),
    () => store.promoteRuntimeIssuance(bot.botId, {
      issuanceKey: ISSUANCE_A, provider: "authorized-test-provider", runtimeId: "runtime-extra", extra: true,
    }),
    () => store.confirmRuntimeIssuance(bot.botId, {
      issuanceKey: ISSUANCE_A, provider: "authorized-test-provider", runtimeId: "runtime-extra", lastConfirmedAt: NOW, extra: true,
    }),
    () => store.abortRuntimeIssuance(bot.botId, { issuanceKey: ISSUANCE_A, extra: true }),
  ];
  for (const operation of extraCases) await assert.rejects(operation);
  assert.equal((await store.readRuntimeIssuances(bot.botId))[0].phase, "pending");
});

test("v5 completion cannot discard an active issuance without provider-terminal state", async (t) => {
  const { store } = await temporaryStore(t);
  const bot = await store.create();
  await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  });
  await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-terminal-proof",
  });
  await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-terminal-proof",
    state: "failed",
    lastConfirmedAt: null,
    expectedPreviousIssuanceKey: null,
  });
  for (const state of ["failed", "unavailable"]) {
    await assert.rejects(() => store.completeRuntimeIssuance(bot.botId, {
      issuanceKey: ISSUANCE_A,
      provider: "authorized-test-provider",
      runtimeId: "runtime-terminal-proof",
      state,
      lastErrorCode: null,
    }));
  }
  assert.equal((await store.readRuntimeIssuances(bot.botId))[0].phase, "active");
  assert.equal((await store.read(bot.botId)).runtime.remoteRuntimeId, "runtime-terminal-proof");
});

test("v5 promotion requires an exact previous active issuance CAS", async (t) => {
  const { store } = await temporaryStore(t, { uuids: Array(32).fill(TEMP_A_UUID) });
  const bot = await store.create();
  await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  });
  await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-a",
  });
  await assert.rejects(() => store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-a",
  }), /previous issuance key/i);
  assert.equal((await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-a",
    expectedPreviousIssuanceKey: null,
  })).matched, true);
  await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}:rotation`,
    issuanceKey: ISSUANCE_B,
    retirementKey: "retire-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_B,
    provider: "authorized-test-provider",
    runtimeId: "runtime-b",
  });
  assert.equal((await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_B,
    provider: "authorized-test-provider",
    runtimeId: "runtime-b",
    expectedPreviousIssuanceKey: null,
  })).matched, false);
  assert.equal((await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_B,
    provider: "authorized-test-provider",
    runtimeId: "runtime-b",
    expectedPreviousIssuanceKey: ISSUANCE_A,
  })).matched, true);
});

test("v5 runtime transaction requires the exact active issuance fence", async (t) => {
  const { store } = await temporaryStore(t);
  const bot = await store.create();
  await store.beginRuntimeIssuance(bot.botId, {
    idempotencyKey: `codex-bot:${bot.botId}`,
    issuanceKey: ISSUANCE_A,
    retirementKey: RETIREMENT_A,
  });
  await store.issueRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-fence-a",
  });
  await store.promoteRuntimeIssuance(bot.botId, {
    issuanceKey: ISSUANCE_A,
    provider: "authorized-test-provider",
    runtimeId: "runtime-fence-a",
    expectedPreviousIssuanceKey: null,
  });
  const outcome = await store.runtimeTransaction(
    bot.botId,
    { expectedActiveIssuanceKey: ISSUANCE_B },
    ({ updateRuntime }) => updateRuntime({ state: "failed" }),
  );
  assert.equal(outcome.matched, false);
  assert.equal((await store.read(bot.botId)).runtime.state, "ready");
});

test("adoptLegacy is idempotent, preserves allowed data, and survives later profile changes", async (t) => {
  const { filePath, store } = await temporaryStore(t, {
    uuids: [BOT_A_UUID, TEMP_A_UUID, TEMP_B_UUID, TEMP_C_UUID],
  });
  const legacy = {
    migrationKey: "appearance:bot-legacy-1",
    name: "Existing Bot",
    appearance: {
      shape: "pebble",
      color: "blue",
      image: "https://images.example.test/avatar.png",
      title: "Research companion",
      description: "Finds exact sources",
    },
    notifications: false,
    conversations: [
      { source: "chatgpt", conversationId: "chat-1" },
      { source: "codex", threadId: "work-1" },
    ],
  };

  const first = await store.adoptLegacy(legacy);
  const repeated = await store.adoptLegacy({
    ...legacy,
    appearance: { ...legacy.appearance },
    conversations: legacy.conversations.map((ref) => ({ ...ref })),
  });
  assert.equal(repeated.botId, first.botId);
  assert.equal(repeated.name, "Existing Bot");
  assert.deepEqual(first.appearance, legacy.appearance);
  assert.equal(first.notifications, false);
  assert.deepEqual(first.conversations, legacy.conversations);
  assert.equal((await store.list()).length, 1);

  await store.rename(first.botId, "Renamed later");
  await store.updateProfile(first.botId, { appearance: { title: "Changed later" } });
  const afterChanges = await store.adoptLegacy(legacy);
  assert.equal(afterChanges.botId, first.botId);
  assert.equal(afterChanges.name, "Renamed later");
  assert.equal(afterChanges.appearance.title, "Changed later");

  const document = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(document.bots.length, 1);
  assert.equal(document.legacyImports[legacy.migrationKey].botId, first.botId);
  assert.match(document.legacyImports[legacy.migrationKey].fingerprint, /^[0-9a-f]{64}$/);

  const reloaded = new BotStore({ filePath });
  const restarted = await reloaded.adoptLegacy(legacy);
  assert.equal(restarted.botId, first.botId);
  assert.equal(restarted.name, "Renamed later");
  assert.equal((await reloaded.list()).length, 1);
});

test("rejects prototype-sensitive migration keys on adoption and reload", async (t) => {
  for (const migrationKey of ["toString", "hasOwnProperty", "constructor", "prototype"]) {
    await t.test(migrationKey, async (subtest) => {
      const { filePath, store } = await temporaryStore(subtest);
      const legacy = { migrationKey, name: "Existing Bot" };
      await assert.rejects(store.adoptLegacy(legacy), /migration key/i);
      assert.deepEqual(await store.list(), []);

      const poisonedImports = JSON.parse(`{"${migrationKey}":{"botId":"bot-${BOT_A_UUID}","fingerprint":"${"a".repeat(64)}"}}`);
      await writeDocument(filePath, validStoreDocument([expectedBot()], poisonedImports));
      await assert.rejects(new BotStore({ filePath }).load(), /migration key|prototype field/i);
    });
  }
});

test("adoptLegacy rejects conflicting retries without mutating the original", async (t) => {
  const { store } = await temporaryStore(t);
  const first = await store.adoptLegacy({
    migrationKey: "appearance:bot-legacy-1",
    name: "Existing Bot",
    appearance: { shape: "pebble", color: "blue" },
    conversations: [{ source: "chatgpt", conversationId: "chat-1" }],
  });
  await assert.rejects(store.adoptLegacy({
    migrationKey: "appearance:bot-legacy-1",
    name: "Different Bot",
    appearance: { shape: "pebble", color: "blue" },
    conversations: [{ source: "chatgpt", conversationId: "chat-1" }],
  }), /conflicting legacy import/i);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.read(first.botId)).name, "Existing Bot");
});

test("adoptLegacy rejects invalid keys, forged ownership, secrets, paths, and invalid avatars", async (t) => {
  const { store } = await temporaryStore(t);
  const base = {
    migrationKey: "appearance:bot-legacy-1",
    name: "Existing Bot",
    appearance: { shape: "pebble", color: "blue" },
    conversations: [{ source: "chatgpt", conversationId: "chat-1" }],
  };
  const invalid = [
    [{ ...base, migrationKey: "../Library/escape" }, /migration key/i],
    [{ ...base, runtime: { provider: "forged", remoteRuntimeId: "runtime-1" } }, /legacy field/i],
    [{ ...base, provider: "forged" }, /legacy field/i],
    [{ ...base, endpoint: "wss://private.example.test" }, /legacy field/i],
    [{ ...base, authToken: "secret" }, /legacy field/i],
    [{ ...base, filesystemPath: "/Users/example" }, /legacy field/i],
    [{ ...base, appearance: { ...base.appearance, unknown: true } }, /appearance field/i],
    [{ ...base, appearance: { ...base.appearance, image: "file:///tmp/avatar.png" } }, /avatar image/i],
    [{ ...base, appearance: { ...base.appearance, image: "http://images.example.test/avatar.png" } }, /avatar image/i],
    [{ ...base, appearance: { ...base.appearance, image: `data:image/png;base64,${"a".repeat(2_100_000)}` } }, /avatar image/i],
    [{ ...base, conversations: [{ source: "chatgpt", conversationId: "chat-1", botId: "forged" }] }, /conversation field/i],
  ];
  for (const [record, pattern] of invalid) await assert.rejects(store.adoptLegacy(record), pattern);

  const polluted = JSON.parse('{"migrationKey":"appearance:bot-legacy-1","name":"Existing Bot","appearance":{"shape":"pebble","color":"blue","__proto__":{"polluted":true}},"conversations":[]}');
  await assert.rejects(store.adoptLegacy(polluted), /prototype|appearance field/i);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(await store.list(), []);
});

test("adoptLegacy enforces unique conversation ownership and create remains New Bot", async (t) => {
  const { store } = await temporaryStore(t);
  const first = await store.adoptLegacy({
    migrationKey: "appearance:bot-legacy-1",
    name: "Existing Bot",
    conversations: [{ source: "chatgpt", conversationId: "chat-owned" }],
  });
  await assert.rejects(store.adoptLegacy({
    migrationKey: "appearance:bot-legacy-2",
    name: "Other Bot",
    conversations: [{ source: "chatgpt", conversationId: "chat-owned" }],
  }), /conversation.*another bot|duplicate conversation/i);
  assert.equal((await store.read(first.botId)).name, "Existing Bot");
  const created = await store.create({ name: "Still ignored" });
  assert.equal(created.name, "New Bot");
});

test("attachConversation accepts only canonical refs and uniquely owns them", async (t) => {
  const { store } = await temporaryStore(t);
  const first = await store.create();
  const second = await store.create();
  const chat = { source: "chatgpt", conversationId: "chat-1" };
  const work = { source: "codex", threadId: "thread-1" };

  assert.deepEqual((await store.attachConversation(first.botId, chat)).conversations, [chat]);
  assert.deepEqual((await store.attachConversation(first.botId, work)).conversations, [chat, work]);
  await assert.rejects(store.attachConversation(first.botId, { ...chat }), /duplicate conversation/i);
  await assert.rejects(store.attachConversation(second.botId, chat), /conversation.*another bot/i);
  await assert.rejects(store.attachConversation(first.botId, { source: "chatgpt", threadId: "wrong" }), /conversation field|canonical/i);
  await assert.rejects(store.attachConversation(first.botId, { source: "codex", conversationId: "wrong" }), /conversation field|canonical/i);
  await assert.rejects(store.attachConversation(first.botId, { source: "codex", threadId: "thread-2", endpoint: "wss://private" }), /conversation field/i);
  assert.equal((await store.read(second.botId)).conversations.length, 0);
});

test("updateRuntime persists sanitized metadata and rejects duplicate IDs or secret fields", async (t) => {
  const { store } = await temporaryStore(t);
  const first = await store.create();
  const second = await store.create();
  const ready = await store.updateRuntime(first.botId, {
    provider: "openai",
    remoteRuntimeId: "runtime-1",
    state: "ready",
    lastConfirmedAt: NOW,
    lastErrorCode: null,
  });
  assert.deepEqual(ready.runtime, {
    provider: "openai",
    remoteRuntimeId: "runtime-1",
    state: "ready",
    lastConfirmedAt: NOW,
    lastErrorCode: null,
  });
  await assert.rejects(store.updateRuntime(second.botId, {
    provider: "openai",
    remoteRuntimeId: "runtime-1",
    state: "ready",
    lastConfirmedAt: NOW,
  }), /remote runtime.*another bot|duplicate remote runtime/i);
  await assert.rejects(store.updateRuntime(first.botId, { endpoint: "wss://private.example.test" }), /runtime field/i);
  await assert.rejects(store.updateRuntime(first.botId, { authToken: "secret" }), /runtime field/i);
  await assert.rejects(store.updateRuntime(first.botId, { state: "local-ready" }), /runtime state/i);
  assert.equal((await store.read(second.botId)).runtime.remoteRuntimeId, null);
  assert.equal(JSON.stringify(await store.list()).includes("private.example"), false);
});

test("rejects hostile non-plain inputs and unknown bot reads", async (t) => {
  const { store } = await temporaryStore(t);
  const created = await store.create();
  const inherited = Object.create({ name: "Prototype rename" });
  inherited.notifications = false;
  await assert.rejects(store.updateProfile(created.botId, inherited), /plain object|prototype/i);
  const accessor = {};
  Object.defineProperty(accessor, "notifications", { enumerable: true, get() { throw new Error("secret getter"); } });
  await assert.rejects(store.updateProfile(created.botId, accessor), /accessor|plain data/i);
  const pollutedCreate = JSON.parse('{"appearance":{"shape":"blob","__proto__":{"polluted":true}}}');
  const ignoredPollution = await store.create(pollutedCreate);
  assert.equal(ignoredPollution.appearance.shape, "blob");
  await assert.rejects(store.read("bot-missing"), /bot ID/i);
  await assert.rejects(store.rename(`bot-${BOT_C_UUID}`, "Missing"), /not found/i);
  assert.equal({}.polluted, undefined);
});

test("deleteBots atomically removes an exact batch and records a durable cleanup receipt", async (t) => {
  const { filePath, store } = await temporaryStore(t, {
    uuids: [
      BOT_A_UUID, TEMP_A_UUID,
      BOT_B_UUID, TEMP_B_UUID,
      BOT_C_UUID, TEMP_C_UUID,
      TEMP_A_UUID, TEMP_B_UUID,
    ],
  });
  const first = await store.create();
  const second = await store.create();
  const survivor = await store.create();

  const result = await store.deleteBots([first.botId, second.botId], {
    preferredActiveBotId: first.botId,
  });

  assert.deepEqual(result, {
    deletionId: TEMP_A_UUID,
    deletedBotIds: [first.botId, second.botId],
    survivingBotIds: [survivor.botId],
    activeBotId: survivor.botId,
    cleanup: {
      botIds: [first.botId, second.botId],
      remoteRuntimes: [],
      localProfiles: [],
    },
  });
  assert.deepEqual(await store.list(), [survivor]);
  assert.deepEqual(await store.listPendingDeletions(), [{
    deletionId: TEMP_A_UUID,
    createdAt: NOW,
    botIds: [first.botId, second.botId],
    remoteRuntimes: [],
    localProfiles: [],
  }]);
  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.schemaVersion, 5);
  assert.deepEqual(persisted.bots, [survivor]);
});

test("deleting an adopted bot permanently suppresses its exact legacy import", async (t) => {
  const { filePath, store } = await temporaryStore(t, {
    uuids: [BOT_A_UUID, TEMP_A_UUID, TEMP_B_UUID, TEMP_C_UUID, TEMP_A_UUID],
  });
  const legacy = {
    migrationKey: "appearance:deleted-bot",
    name: "Imported Bot",
    appearance: { shape: "gem", color: "blue" },
    notifications: true,
    conversations: [],
  };
  const adopted = await store.adoptLegacy(legacy);
  const deletion = await store.deleteBots([adopted.botId]);
  assert.equal(await store.completeDeletion(deletion.deletionId), true);
  assert.equal(await store.completeDeletion(deletion.deletionId), false);
  assert.deepEqual(await store.listPendingDeletions(), []);

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.deepEqual(persisted.legacyImports, {});
  assert.deepEqual(Object.keys(persisted.deletedLegacyImports), ["appearance:deleted-bot"]);
  assert.deepEqual(Object.keys(persisted.deletedLegacyImports["appearance:deleted-bot"]), ["fingerprint"]);
  assert.match(
    persisted.deletedLegacyImports["appearance:deleted-bot"].fingerprint,
    /^[0-9a-f]{64}$/,
  );

  const restarted = new BotStore({ filePath, now: () => NOW });
  await assert.rejects(restarted.adoptLegacy(legacy), /previously deleted/i);
  assert.deepEqual(await restarted.list(), []);
});

test("deleting a bot fences every older runtime commit receipt", async (t) => {
  const { store } = await temporaryStore(t, {
    uuids: [
      BOT_A_UUID, TEMP_A_UUID,
      TEMP_B_UUID,
      TEMP_C_UUID, TEMP_A_UUID,
      TEMP_B_UUID,
      BOT_A_UUID, TEMP_C_UUID,
      TEMP_A_UUID,
    ],
  });
  const created = await store.create();
  const committed = await store.runtimeTransaction(created.botId, {}, ({ updateRuntime }) => {
    updateRuntime({
      provider: "openai",
      remoteRuntimeId: "runtime-deleted",
      state: "ready",
      lastConfirmedAt: NOW,
    });
  });
  assert.equal(store.isCurrentRuntimeCommit(committed, created.botId), true);

  const deletion = await store.deleteBots([created.botId]);
  assert.equal(store.isCurrentRuntimeCommit(committed, created.botId), false);

  await store.completeDeletion(deletion.deletionId);
  const replacement = await store.create();
  assert.equal(replacement.botId, created.botId);
  await store.runtimeTransaction(replacement.botId, {}, ({ updateRuntime }) => {
    updateRuntime({
      state: "provisioning",
      lastErrorCode: "RUNTIME_OPERATION.replacement",
    });
  });
  assert.equal(store.isCurrentRuntimeCommit(committed, created.botId), false);
});

test("schema v3 root migrates exactly to v5 without changing the public bot schema", async (t) => {
  const { filePath, store } = await temporaryStore(t, { uuids: [TEMP_A_UUID] });
  const bot = expectedBot({ setupStage: "complete" });
  await writeDocument(filePath, validV3StoreDocument([bot], {
    "appearance:v3-import": { botId: bot.botId, fingerprint: "a".repeat(64) },
  }));

  assert.deepEqual(await store.load(), [bot]);
  assert.equal((JSON.parse(await fs.readFile(filePath, "utf8"))).schemaVersion, 3);
  const renamed = await store.rename(bot.botId, "Migrated v3 Bot");
  assert.equal(renamed.schemaVersion, 3);

  const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(persisted.schemaVersion, 5);
  assert.equal(persisted.bots[0].schemaVersion, 3);
  assert.deepEqual(persisted.deletedLegacyImports, {});
  assert.deepEqual(persisted.pendingDeletions, []);
  assert.deepEqual(persisted.runtimeIssuances, []);
});

test("delete tombstones retain only bounded cleanup identifiers", async (t) => {
  const { filePath } = await temporaryStore(t);
  const localProfileId = "local-11111111-1111-4111-8111-111111111111";
  const first = expectedBot({
    name: "Private Display Name",
    appearance: { image: "https://images.example.test/private-avatar.png" },
    runtime: {
      provider: "openai",
      remoteRuntimeId: "runtime-stored",
      state: "ready",
      lastConfirmedAt: NOW,
    },
    computer: {
      mode: "local",
      generation: 1,
      localProfileId,
      state: "starting",
    },
  });
  const second = expectedBot({
    botId: `bot-${BOT_B_UUID}`,
    name: "Another Private Name",
    computer: {
      mode: "cursor",
      generation: 1,
      nativeAgentId: "native-agent-private",
      state: "starting",
    },
  });
  await writeDocument(filePath, validStoreDocument([first, second]));
  const store = new BotStore({
    filePath,
    now: () => NOW,
    randomUUID: sequence([TEMP_A_UUID, TEMP_B_UUID]),
  });

  await store.deleteBots([first.botId, second.botId], {
    extraRemoteRuntimes: [{ botId: second.botId, runtimeId: "runtime-candidate" }],
  });
  const [pending] = await store.listPendingDeletions();
  assert.deepEqual(Object.keys(pending), [
    "deletionId", "createdAt", "botIds", "remoteRuntimes", "localProfiles",
  ]);
  assert.deepEqual(pending.remoteRuntimes, [
    { botId: first.botId, runtimeId: "runtime-stored", issuanceKey: null, retirementKey: null },
    { botId: second.botId, runtimeId: "runtime-candidate", issuanceKey: null, retirementKey: null },
  ]);
  assert.deepEqual(pending.localProfiles, [{ botId: first.botId, profileId: localProfileId }]);
  assert.doesNotMatch(
    JSON.stringify(pending),
    /Private Display|Another Private|private-avatar|native-agent|endpoint|authToken|secret/i,
  );
});

test("deleteBots retries the exact pending batch without writing or losing cleanup IDs", async (t) => {
  const base = await temporaryStore(t, {
    uuids: [
      BOT_A_UUID, TEMP_A_UUID,
      BOT_B_UUID, TEMP_B_UUID,
      BOT_C_UUID, TEMP_C_UUID,
      TEMP_A_UUID, TEMP_B_UUID,
    ],
  });
  const first = await base.store.create();
  const second = await base.store.create();
  const survivor = await base.store.create();
  const initial = await base.store.deleteBots([first.botId, second.botId]);
  const beforeRetry = await fs.readFile(base.filePath, "utf8");
  const retrying = new BotStore({
    filePath: base.filePath,
    now: () => NOW,
    randomUUID: () => { throw new Error("retry must not allocate"); },
  });

  const retried = await retrying.deleteBots([second.botId, first.botId], {
    preferredActiveBotId: survivor.botId,
  });
  assert.equal(retried.deletionId, initial.deletionId);
  assert.deepEqual(retried.cleanup, initial.cleanup);
  assert.equal(retried.activeBotId, survivor.botId);
  assert.equal(await fs.readFile(base.filePath, "utf8"), beforeRetry);

  await assert.rejects(retrying.deleteBots([first.botId, second.botId], {
    extraRemoteRuntimes: [{ botId: first.botId, runtimeId: "runtime-not-in-receipt" }],
  }), /retry|cleanup|pending deletion/i);
  await assert.rejects(retrying.deleteBots([first.botId, second.botId], {
    preferredActiveBotId: `bot-${BOT_C_UUID.replace(/^3/, "4")}`,
  }), /preferred active bot.*not found/i);
  assert.equal(await fs.readFile(base.filePath, "utf8"), beforeRetry);
});

test("deleteBots rejects unknown, duplicate, sparse, accessor, and hostile requests atomically", async (t) => {
  const { filePath, store } = await temporaryStore(t, {
    uuids: [BOT_A_UUID, TEMP_A_UUID, BOT_B_UUID, TEMP_B_UUID],
  });
  const first = await store.create();
  const second = await store.create();
  const before = await fs.readFile(filePath, "utf8");

  await assert.rejects(store.deleteBots([first.botId, `bot-${BOT_C_UUID}`]), /not found/i);
  await assert.rejects(store.deleteBots([first.botId, first.botId]), /unique/i);
  const sparse = [first.botId, , second.botId];
  await assert.rejects(store.deleteBots(sparse), /plain data|dense|deletion request/i);
  let accessorCalls = 0;
  const accessor = [first.botId, second.botId];
  Object.defineProperty(accessor, "1", {
    enumerable: true,
    get() {
      accessorCalls += 1;
      return second.botId;
    },
  });
  await assert.rejects(store.deleteBots(accessor), /plain data|accessor|deletion request/i);
  assert.equal(accessorCalls, 0);
  const hostile = new Proxy({}, {
    ownKeys() { throw new Error("/Users/private authToken=secret"); },
  });
  await assert.rejects(store.deleteBots([first.botId], hostile), (error) => (
    /plain data|deletion request/i.test(error?.message)
      && !/Users|authToken|secret/i.test(error?.message)
  ));
  await assert.rejects(store.deleteBots([first.botId], {
    extraRemoteRuntimes: [{ botId: first.botId, runtimeId: "runtime-1", endpoint: "secret" }],
  }), /remote runtime field/i);

  assert.equal(await fs.readFile(filePath, "utf8"), before);
  assert.deepEqual(await store.list(), [first, second]);
  assert.deepEqual(await store.listPendingDeletions(), []);
});

test("delete request bounds and keys reject before traversing hostile nested values", async (t) => {
  const { store } = await temporaryStore(t);
  const botId = `bot-${BOT_A_UUID}`;

  let oversizedBotTraversal = 0;
  const hostileBotValue = new Proxy({}, {
    getPrototypeOf() {
      oversizedBotTraversal += 1;
      throw new Error("oversized bot value was traversed");
    },
  });
  await assert.rejects(
    store.deleteBots(Array(4097).fill(hostileBotValue)),
    /bot deletion IDs.*oversized/i,
  );
  assert.equal(oversizedBotTraversal, 0);

  let oversizedRuntimeTraversal = 0;
  const hostileRuntimeValue = new Proxy({}, {
    getPrototypeOf() {
      oversizedRuntimeTraversal += 1;
      throw new Error("oversized runtime value was traversed");
    },
  });
  await assert.rejects(store.deleteBots([botId], {
    extraRemoteRuntimes: Array(12_289).fill(hostileRuntimeValue),
  }), /extra remote runtimes.*oversized/i);
  assert.equal(oversizedRuntimeTraversal, 0);

  let unsupportedGetterCalls = 0;
  const options = {};
  Object.defineProperty(options, "endpoint", {
    enumerable: true,
    get() {
      unsupportedGetterCalls += 1;
      throw new Error("unsupported option getter was invoked");
    },
  });
  await assert.rejects(
    store.deleteBots([botId], options),
    /unsupported bot deletion options field: endpoint/i,
  );
  assert.equal(unsupportedGetterCalls, 0);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  await assert.rejects(store.deleteBots([botId], revoked.proxy), (error) => (
    /deletion request.*could not be inspected safely/i.test(error?.message)
      && !/revoked/i.test(error?.message)
  ));
});

test("delete and completion recover only after exact committed-uncertain readback", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-delete-uncertain-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  let failDirectorySync = false;
  let forcedFailures = 0;
  const uncertainFs = {
    ...fs,
    open: async (target, ...args) => {
      const handle = await fs.open(target, ...args);
      if (path.resolve(String(target)) !== path.resolve(directory)) return handle;
      return {
        sync: async () => {
          if (failDirectorySync) {
            failDirectorySync = false;
            forcedFailures += 1;
            const error = new Error("forced committed directory sync failure");
            error.code = "EIO";
            throw error;
          }
          return handle.sync();
        },
        close: (...closeArgs) => handle.close(...closeArgs),
      };
    },
  };
  const store = new BotStore({
    filePath,
    fs: uncertainFs,
    now: () => NOW,
    randomUUID: sequence([BOT_A_UUID, TEMP_A_UUID, TEMP_B_UUID, TEMP_C_UUID, TEMP_A_UUID]),
  });
  const created = await store.create();

  failDirectorySync = true;
  const deletion = await store.deleteBots([created.botId]);
  assert.deepEqual(await store.list(), []);
  assert.equal((await store.listPendingDeletions())[0].deletionId, deletion.deletionId);

  failDirectorySync = true;
  assert.equal(await store.completeDeletion(deletion.deletionId), true);
  assert.deepEqual(await store.listPendingDeletions(), []);
  assert.equal(forcedFailures, 2);
});

test("a precommit delete failure preserves every bot and creates no tombstone", async (t) => {
  const base = await temporaryStore(t, { uuids: [BOT_A_UUID, TEMP_A_UUID] });
  const created = await base.store.create();
  const before = await fs.readFile(base.filePath, "utf8");
  const failingFs = {
    ...fs,
    rename: async () => {
      const error = new Error("forced delete rename failure");
      error.code = "EIO";
      throw error;
    },
  };
  const failing = new BotStore({
    filePath: base.filePath,
    fs: failingFs,
    now: () => NOW,
    randomUUID: sequence([TEMP_B_UUID, TEMP_C_UUID]),
  });

  await assert.rejects(failing.deleteBots([created.botId]), /forced delete rename failure/);
  assert.equal(await fs.readFile(base.filePath, "utf8"), before);
  assert.deepEqual(await base.store.list(), [created]);
  assert.deepEqual(await base.store.listPendingDeletions(), []);
});

test("committed-uncertain delete remains an error when exact readback is unavailable", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-delete-unverified-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "bots.json");
  let failDirectorySync = false;
  let failNextRead = false;
  const uncertainFs = {
    ...fs,
    readFile: async (...args) => {
      if (failNextRead) {
        failNextRead = false;
        const error = new Error("forced exact readback failure");
        error.code = "EIO";
        throw error;
      }
      return fs.readFile(...args);
    },
    open: async (target, ...args) => {
      const handle = await fs.open(target, ...args);
      if (path.resolve(String(target)) !== path.resolve(directory)) return handle;
      return {
        sync: async () => {
          if (failDirectorySync) {
            failDirectorySync = false;
            failNextRead = true;
            const error = new Error("forced committed directory sync failure");
            error.code = "EIO";
            throw error;
          }
          return handle.sync();
        },
        close: (...closeArgs) => handle.close(...closeArgs),
      };
    },
  };
  const store = new BotStore({
    filePath,
    fs: uncertainFs,
    now: () => NOW,
    randomUUID: sequence([BOT_A_UUID, TEMP_A_UUID, TEMP_B_UUID, TEMP_C_UUID]),
  });
  const created = await store.create();
  failDirectorySync = true;

  await assert.rejects(store.deleteBots([created.botId]), (error) => (
    error?.code === "BOT_STORE_DURABILITY_UNCERTAIN" && error?.committed === true
  ));
  const durable = new BotStore({ filePath });
  assert.deepEqual(await durable.list(), []);
  assert.equal((await durable.listPendingDeletions()).length, 1);
});

test("schema v4 rejects malformed or oversized deletion metadata without exposing it", async (t) => {
  const { filePath } = await temporaryStore(t);
  const baseDeletion = {
    deletionId: TEMP_A_UUID,
    createdAt: NOW,
    botIds: [`bot-${BOT_A_UUID}`],
    remoteRuntimes: [],
    localProfiles: [],
  };
  const cases = [
    [{ ...baseDeletion, name: "Private Bot" }, /deletion field/i],
    [{
      ...baseDeletion,
      remoteRuntimes: [{ botId: `bot-${BOT_A_UUID}`, runtimeId: "/Users/private" }],
    }, /runtime ID/i],
    [{ ...baseDeletion, botIds: Array(4097).fill(`bot-${BOT_A_UUID}`) }, /oversized/i],
  ];
  for (const [pending, pattern] of cases) {
    await writeDocument(filePath, validStoreDocument([], {}, {}, [pending]));
    await assert.rejects(new BotStore({ filePath }).load(), (error) => (
      pattern.test(error?.message) && !/Private Bot|Users\/private/i.test(error?.message)
    ));
  }
});
