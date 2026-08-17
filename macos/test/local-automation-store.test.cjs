"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LocalAutomationStore,
  LocalAutomationStoreError,
} = require("../src/desktop/local-automation-store.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const BOT_C = "bot-33333333-3333-4333-8333-333333333333";
const AUTOMATION_A = "morning-summary";
const NOW_1 = "2026-08-17T12:00:00.000Z";
const NOW_2 = "2026-08-17T12:05:00.000Z";
const NOW_1_MS = 1_786_968_000_000;
const NOW_2_MS = 1_786_968_300_000;
const RUN_A = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_A = "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVOCATION_A = "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function automation(overrides = {}) {
  return {
    name: "Morning summary",
    prompt: "Summarize the project.",
    trigger: { type: "cron", schedule: "0 9 * * 1-5" },
    triggerDescription: "At 9:00 AM, Monday through Friday",
    isEnabled: true,
    nextRunAt: 1_786_971_600_000,
    ...overrides,
  };
}

function uuidSequence(start = 0x101) {
  let value = start;
  return () => `00000000-0000-4000-8000-${(value++).toString(16).padStart(12, "0")}`;
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-local-automation-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "private", "local-automations.v1.json");
  await fs.mkdir(path.dirname(filePath), { mode: 0o700 });
  return {
    filePath,
    root,
    store: new LocalAutomationStore({
      stateIO: fileStateIO(filePath),
      randomUUID: uuidSequence(),
      now: () => NOW_1,
      ...overrides,
    }),
  };
}

function fileStateIO(filePath, overrides = {}) {
  return {
    async read() {
      try { return await fs.readFile(filePath, "utf8"); }
      catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    },
    async write(source) {
      await fs.writeFile(filePath, source, { mode: 0o600 });
    },
    ...overrides,
  };
}

function localStore({ filePath, stateIO = fileStateIO(filePath), ...options }) {
  return new LocalAutomationStore({ stateIO, ...options });
}

function assertDeepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

test("schema-v1 CRUD persists exact private records and returns deeply frozen bot snapshots", async (t) => {
  const { filePath, store } = await fixture(t);
  const created = await store.create({ botId: BOT_A, automation: automation() });

  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    botId: BOT_A,
    id: AUTOMATION_A,
    name: "Morning summary",
    prompt: "Summarize the project.",
    trigger: { type: "cron", schedule: "0 9 * * 1-5" },
    triggerDescription: "At 9:00 AM, Monday through Friday",
    isEnabled: true,
    provenance: "local",
    createdAt: NOW_1_MS,
    updatedAt: NOW_1_MS,
    lastRunAt: null,
    nextRunAt: 1_786_971_600_000,
    runs: [],
    revision: 1,
    conversationId: null,
  });
  assertDeepFrozen(created);
  assert.deepEqual(await localStore({ filePath }).list(BOT_A), created);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), {
    schemaVersion: 1,
    automations: [created[0]],
  });

  const updatedStore = localStore({ filePath, now: () => NOW_2 });
  const replaced = await updatedStore.replace({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    expectedRevision: 1,
    automation: automation({ name: "Updated summary", isEnabled: false, nextRunAt: null }),
  });
  assert.equal(replaced[0].name, "Updated summary");
  assert.equal(replaced[0].revision, 2);
  assert.equal(replaced[0].createdAt, NOW_1_MS);
  assert.equal(replaced[0].updatedAt, NOW_2_MS);
  assert.deepEqual(await updatedStore.delete({
    botId: BOT_A, automationId: AUTOMATION_A, expectedRevision: 2,
  }), []);
  assert.deepEqual(await updatedStore.list(BOT_A), []);
});

test("lists use deterministic next-run then created ordering with exact bot isolation", async (t) => {
  const { filePath } = await fixture(t);
  const times = [
    "2026-08-17T12:00:03.000Z",
    "2026-08-17T12:00:01.000Z",
    "2026-08-17T12:00:02.000Z",
    "2026-08-17T12:00:04.000Z",
  ];
  let time = 0;
  const store = localStore({
    filePath,
    randomUUID: uuidSequence(0x201),
    now: () => times[time++],
  });
  await store.create({ botId: BOT_A, automation: automation({ name: "later", nextRunAt: 200 }) });
  await store.create({ botId: BOT_A, automation: automation({ name: "first tie", nextRunAt: 100 }) });
  await store.create({ botId: BOT_A, automation: automation({ name: "second tie", nextRunAt: 100 }) });
  await store.create({ botId: BOT_B, automation: automation({ name: "other bot", nextRunAt: 1 }) });

  assert.deepEqual((await store.list(BOT_A)).map((entry) => entry.name), [
    "first tie", "second tie", "later",
  ]);
  assert.deepEqual((await store.list(BOT_B)).map((entry) => entry.name), ["other bot"]);
  assert.deepEqual((await store.listAll()).map((entry) => entry.name), [
    "other bot", "first tie", "second tie", "later",
  ]);
});

test("enforces unique safe ids and bounded config fields before durable mutation", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create({ botId: BOT_A, automation: automation({
    name: "n".repeat(80), prompt: "p".repeat(65_536),
  }) });
  const before = await fs.readFile(filePath);

  for (const request of [
    { botId: BOT_A, automation: automation({ name: "n".repeat(81) }) },
    { botId: BOT_A, automation: automation({ prompt: "p".repeat(65_537) }) },
    { botId: BOT_A, automation: automation({ trigger: { type: "cron", schedule: "x".repeat(513) } }) },
    { botId: BOT_A, automation: automation({ trigger: { type: "cron", schedule: "61 * * * *" } }) },
  ]) {
    await assert.rejects(store.create(request), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
  }
  assert.deepEqual(await fs.readFile(filePath), before);
  assert.throws(() => new LocalAutomationStore({ stateIO: null }), LocalAutomationStoreError);
});

test("creation derives Grok-compatible slug collision and empty-slug fallback ids", async (t) => {
  const { store } = await fixture(t);
  assert.equal((await store.create({
    botId: BOT_A, automation: automation({ name: "Release Notes" }),
  }))[0].id, "release-notes");
  assert.equal((await store.create({
    botId: BOT_B, automation: automation({ name: "Release Notes" }),
  }))[0].id, "release-notes");
  assert.equal((await store.create({
    botId: BOT_A, automation: automation({ name: "Release---Notes" }),
  }))[1].id, "release-notes-2");
  assert.equal((await store.create({
    botId: BOT_A, automation: automation({ name: "!!!" }),
  })).find((entry) => entry.name === "!!!").id, "automation-1786968000000");
  assert.deepEqual(await store.deleteBots({ botIds: [BOT_A, BOT_B] }), {
    deletedAutomationIds: ["release-notes", "release-notes", "release-notes-2",
      "automation-1786968000000"],
  });
});

test("persisted and requested automation ids accept only opaque safe directory segments", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create({ botId: BOT_A, automation: automation() });
  const state = JSON.parse(await fs.readFile(filePath, "utf8"));
  state.automations[0].id = "legacy.safe_id";
  await fs.writeFile(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  assert.equal((await localStore({ filePath }).list(BOT_A))[0].id, "legacy.safe_id");

  for (const id of ["", ".", "..", "a/b", "a\\b", "nul\0id"] ) {
    await assert.rejects(localStore({ filePath }).delete({
      botId: BOT_A, automationId: id, expectedRevision: 1,
    }), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
  }
});

test("enforces fifty per bot and one hundred aggregate records", async (t) => {
  const { store } = await fixture(t);
  for (let index = 0; index < 50; index += 1) {
    await store.create({ botId: BOT_A, automation: automation({ name: `A${index}` }) });
    await store.create({ botId: BOT_B, automation: automation({ name: `B${index}` }) });
  }
  assert.equal((await store.list(BOT_A)).length, 50);
  assert.equal((await store.listAll()).length, 100);
  await assert.rejects(store.create({ botId: BOT_A, automation: automation({ name: "A50" }) }), {
    code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED",
  });
  await assert.rejects(store.create({ botId: BOT_C, automation: automation({ name: "C0" }) }), {
    code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED",
  });
});

test("revision claims isolate bots and serialize config conversation and run mutations", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create({ botId: BOT_A, automation: automation() });
  await store.create({ botId: BOT_B, automation: automation({ name: "Bot B" }) });

  await assert.rejects(store.replace({
    botId: BOT_B,
    automationId: AUTOMATION_A,
    expectedRevision: 1,
    automation: automation({ name: "Cross-bot overwrite" }),
  }), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
  const bound = await store.bindConversation({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    expectedRevision: 1,
    conversationId: CONVERSATION_A,
  });
  assert.equal(bound.conversationId, CONVERSATION_A);
  assert.equal(bound.revision, 2);

  const stale = await store.claimRun({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    expectedRevision: 1,
    run: {
      id: RUN_A,
      trigger: "schedule",
      startedAt: NOW_1_MS,
      finishedAt: null,
      status: "running",
    },
    nextRunAt: 1_786_975_200_000,
  });
  assert.deepEqual(stale, { claimed: false, automation: bound });
  assertDeepFrozen(stale);

  const claimed = await store.claimRun({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    expectedRevision: 2,
    run: {
      id: RUN_A,
      trigger: "schedule",
      startedAt: NOW_1_MS,
      finishedAt: null,
      status: "running",
      event: "timer",
      coalescedRunIds: ["held-1", "held-2"],
    },
    nextRunAt: 1_786_975_200_000,
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.automation.revision, 3);
  assert.equal(claimed.automation.lastRunAt, NOW_1_MS);
  assert.deepEqual(claimed.automation.runs[0], {
    id: RUN_A,
    trigger: "schedule",
    startedAt: NOW_1_MS,
    finishedAt: null,
    status: "running",
    event: "timer",
    coalescedRunIds: ["held-1", "held-2"],
  });
  assert.equal(Object.hasOwn(claimed.automation.runs[0], "invocationId"), false);

  const accepted = await store.acceptRun({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    runId: RUN_A,
    invocationId: INVOCATION_A,
    conversationId: CONVERSATION_A,
  });
  assert.equal(accepted.revision, 4);
  assert.equal(Object.hasOwn(accepted.runs[0], "invocationId"), false);
  const persistedAccepted = JSON.parse(await fs.readFile(filePath, "utf8"))
    .automations[0].runs[0];
  assert.equal(persistedAccepted.invocationId, INVOCATION_A);

  const finished = await store.finishRun({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    runId: RUN_A,
    finishedAt: NOW_2_MS,
    status: "ok",
    detail: "Summary completed",
    errorKind: undefined,
  });
  assert.equal(finished.revision, 5);
  assert.deepEqual(finished.runs[0], {
    id: RUN_A,
    trigger: "schedule",
    startedAt: NOW_1_MS,
    finishedAt: NOW_2_MS,
    status: "ok",
    detail: "Summary completed",
    event: "timer",
    coalescedRunIds: ["held-1", "held-2"],
  });
  assert.deepEqual((await store.list(BOT_B)).map((entry) => entry.name), ["Bot B"]);
});

test("newest-first run history truncates to twenty terminal runs", async (t) => {
  const { store } = await fixture(t);
  let current = (await store.create({ botId: BOT_A, automation: automation() }))[0];
  for (let index = 1; index <= 21; index += 1) {
    const id = `run-${String(index).padStart(2, "0")}`;
    const claimed = await store.claimRun({
      botId: BOT_A,
      automationId: AUTOMATION_A,
      expectedRevision: current.revision,
      run: {
        id,
        trigger: "manual",
        startedAt: NOW_1_MS + index,
        finishedAt: null,
        status: "running",
      },
      nextRunAt: null,
    });
    current = await store.finishRun({
      botId: BOT_A,
      automationId: AUTOMATION_A,
      runId: id,
      finishedAt: NOW_2_MS + index,
      status: "ok",
      detail: undefined,
      errorKind: undefined,
    });
    assert.equal(claimed.claimed, true);
  }
  assert.equal(current.runs.length, 20);
  assert.deepEqual(current.runs.map((run) => run.id), [
    "run-21", "run-20", "run-19", "run-18", "run-17", "run-16", "run-15",
    "run-14", "run-13", "run-12", "run-11", "run-10", "run-09", "run-08",
    "run-07", "run-06", "run-05", "run-04", "run-03", "run-02",
  ]);
});

test("restart recovery terminals running records before exact bot deletion and retry", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create({ botId: BOT_A, automation: automation() });
  await store.claimRun({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    expectedRevision: 1,
    run: {
      id: RUN_A,
      trigger: "schedule",
      startedAt: NOW_1_MS,
      finishedAt: null,
      status: "running",
    },
    nextRunAt: 1_786_975_200_000,
  });
  const restarted = localStore({ filePath });
  const recovered = await restarted.recoverRunning({ finishedAt: NOW_2_MS });
  assert.equal(recovered[0].runs[0].status, "error");
  assert.equal(recovered[0].runs[0].finishedAt, NOW_2_MS);
  assert.equal(recovered[0].runs[0].errorKind, "interrupted");
  assert.equal(recovered[0].revision, 3);
  assert.deepEqual(await restarted.deleteBots({ botIds: [BOT_A] }), {
    deletedAutomationIds: [AUTOMATION_A],
  });
  assert.deepEqual(await restarted.deleteBots({ botIds: [BOT_A] }), {
    deletedAutomationIds: [],
  });
});

test("mutations delegate one exact schema source to injected state IO", async () => {
  let durable = null;
  const writes = [];
  const stateIO = {
    async read() { return durable; },
    async write(source) { writes.push(source); durable = source; },
  };
  const store = new LocalAutomationStore({ stateIO, now: () => NOW_1 });
  await store.create({ botId: BOT_A, automation: automation() });
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]), {
    schemaVersion: 1,
    automations: [(await store.list(BOT_A))[0]],
  });
});

test("state IO write success is authoritative and reopen reads its committed source", async () => {
  let durable = null;
  const stateIO = {
    async read() { return durable; },
    async write(source) { durable = source; },
  };
  const store = new LocalAutomationStore({ stateIO, now: () => NOW_1 });
  const result = await store.create({ botId: BOT_A, automation: automation() });
  assert.equal(result[0].revision, 1);
  assert.equal((await new LocalAutomationStore({ stateIO }).list(BOT_A))[0].id, AUTOMATION_A);
});

test("state IO failure preserves durable source and store errors stay sanitized", async () => {
  let durable = null;
  const initialIO = {
    async read() { return durable; },
    async write(source) { durable = source; },
  };
  await new LocalAutomationStore({ stateIO: initialIO, now: () => NOW_1 })
    .create({ botId: BOT_A, automation: automation() });
  const before = durable;
  const failed = new LocalAutomationStore({
    stateIO: {
      async read() { return durable; },
      async write() { throw new Error("ENOSPC /Users/person/private"); },
    },
  });
  await assert.rejects(failed.deleteBots({ botIds: [BOT_A] }), (error) => {
    assert.equal(error.code, "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED");
    assert.doesNotMatch(String(error.stack), /ENOSPC|Users|private/);
    return true;
  });
  assert.equal(durable, before);
});

test("state IO read failures and oversized sources fail before persisted traversal", async () => {
  await assert.rejects(new LocalAutomationStore({
    stateIO: {
      async read() { throw new Error("private replacement content"); },
      async write() {},
    },
  }).listAll(), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
  await assert.rejects(new LocalAutomationStore({
    stateIO: {
      async read() { return "x".repeat(17 * 1024 * 1024); },
      async write() {},
    },
  }).listAll(), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
});

test("hostile DTOs fail descriptor-first without accessor traversal or durable mutation", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create({ botId: BOT_A, automation: automation() });
  const before = await fs.readFile(filePath);
  let accessorReads = 0;
  const accessor = Object.defineProperty({ botId: BOT_A }, "automation", {
    enumerable: true,
    get() { accessorReads += 1; throw new Error("private token"); },
  });
  const cycle = automation();
  cycle.trigger.owner = cycle;
  const sparse = [];
  sparse.length = 1;
  const oversized = automation();
  for (let index = 0; index < 1_000; index += 1) {
    Object.defineProperty(oversized, `unknown${index}`, {
      enumerable: true,
      get() { accessorReads += 1; throw new Error("must not traverse"); },
    });
  }
  for (const request of [
    accessor,
    new Proxy({ botId: BOT_A, automation: automation() }, {}),
    { botId: BOT_A, automation: cycle },
    { botId: BOT_A, automation: automation(), unknown: true },
    { botId: BOT_A, automation: oversized },
  ]) {
    await assert.rejects(store.create(request), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
  }
  for (const request of [
    { botIds: sparse },
    { botIds: [BOT_A, BOT_A] },
    { botIds: [BOT_A], unknown: true },
    new Proxy({ botIds: [BOT_A] }, {}),
  ]) {
    await assert.rejects(store.deleteBots(request), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
  }
  await assert.rejects(store.claimRun({
    botId: BOT_A,
    automationId: AUTOMATION_A,
    expectedRevision: 1,
    run: {
      id: RUN_A,
      trigger: "event",
      startedAt: NOW_1_MS,
      finishedAt: null,
      status: "running",
      coalescedRunIds: sparse,
    },
    nextRunAt: null,
  }), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
  assert.equal(accessorReads, 0);
  assert.deepEqual(await fs.readFile(filePath), before);
});

test("malformed persisted records reject unknown keys sparse runs and private-field leaks", async (t) => {
  const { filePath, store } = await fixture(t);
  const [created] = await store.create({ botId: BOT_A, automation: automation() });
  const valid = JSON.parse(await fs.readFile(filePath, "utf8"));
  const malformedStates = [
    { ...valid, unknown: true },
    { ...valid, automations: Object.assign([], { length: 101 }) },
    { ...valid, automations: [{ ...created, unknown: true }] },
    { ...valid, automations: [{ ...created, provenance: "remote" }] },
    { ...valid, automations: [{ ...created, runs: Object.assign([], { length: 1 }) }] },
    { ...valid, automations: [{ ...created, trigger: { type: "cron", schedule: "", extra: true } }] },
  ];
  for (const state of malformedStates) {
    await fs.writeFile(filePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await assert.rejects(localStore({ filePath }).listAll(), {
      code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED",
    });
  }
});

test("stored names normalize whitespace and preserve Grok slug boundary hyphens", async (t) => {
  const { store } = await fixture(t);
  const normalized = await store.create({
    botId: BOT_A,
    automation: automation({ name: "  Daily   Report  " }),
  });
  assert.equal(normalized[0].name, "Daily Report");
  assert.equal(normalized[0].id, "daily-report");

  const first = await store.create({
    botId: BOT_A,
    automation: automation({ name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b" }),
  });
  assert.equal(first.find((entry) => entry.name
    === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b").id,
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-");
  const second = await store.create({
    botId: BOT_A,
    automation: automation({ name: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b" }),
  });
  assert.equal(second.find((entry) => entry.id
    === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa--2").name,
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b");
});

test("dense arrays reject hostile prototypes and extra maximum-index accessors", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create({ botId: BOT_A, automation: automation() });
  const before = await fs.readFile(filePath);
  let accessorReads = 0;
  const extra = [BOT_A];
  Object.defineProperty(extra, "4294967295", {
    get() { accessorReads += 1; throw new Error("must not read"); },
  });
  const hostilePrototype = [BOT_A];
  Object.setPrototypeOf(hostilePrototype, { inherited: BOT_B });

  await assert.rejects(store.deleteBots({ botIds: extra }), {
    code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED",
  });
  await assert.rejects(store.deleteBots({ botIds: hostilePrototype }), {
    code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED",
  });
  assert.equal(accessorReads, 0);
  assert.deepEqual(await fs.readFile(filePath), before);
});

test("persisted routines reject multiple running records before load accept or finish", async (t) => {
  const { filePath, store } = await fixture(t);
  const [created] = await store.create({ botId: BOT_A, automation: automation() });
  const malformed = {
    schemaVersion: 1,
    automations: [{
      ...created,
      lastRunAt: NOW_1_MS + 2,
      runs: [{
        id: "running-newest",
        trigger: "schedule",
        startedAt: NOW_1_MS + 2,
        finishedAt: null,
        status: "running",
        invocationId: null,
      }, {
        id: "running-older",
        trigger: "manual",
        startedAt: NOW_1_MS + 1,
        finishedAt: null,
        status: "running",
        invocationId: null,
      }],
    }],
  };

  for (const [name, operation] of [
    ["load", (reopened) => reopened.listAll()],
    ["accept", (reopened) => reopened.acceptRun({
      botId: BOT_A,
      automationId: AUTOMATION_A,
      runId: "running-newest",
      invocationId: INVOCATION_A,
      conversationId: CONVERSATION_A,
    })],
    ["finish", (reopened) => reopened.finishRun({
      botId: BOT_A,
      automationId: AUTOMATION_A,
      runId: "running-newest",
      finishedAt: NOW_2_MS,
      status: "error",
      detail: undefined,
      errorKind: "interrupted",
    })],
  ]) {
    await t.test(name, async () => {
      await fs.writeFile(filePath, `${JSON.stringify(malformed)}\n`, { mode: 0o600 });
      const before = await fs.readFile(filePath);
      await assert.rejects(operation(localStore({ filePath })), {
        code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED",
      });
      assert.deepEqual(await fs.readFile(filePath), before);
    });
  }
});
