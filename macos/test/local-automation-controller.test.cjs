"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  LocalAutomationController,
} = require("../src/desktop/local-automation-controller.cjs");
const { LocalAutomationStore } = require("../src/desktop/local-automation-store.cjs");

const BOT_A = "bot-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOT_B = "bot-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOT_C = "bot-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSATION_A = "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_A_2 = "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const CONVERSATION_B = "conversation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVOCATION_A = "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVOCATION_A_2 = "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const INVOCATION_B = "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const MAX_TIMER_DELAY = 2_147_483_647;

const BASE_SPEC = Object.freeze({
  name: "Morning summary",
  prompt: "Summarize the current project status.",
  trigger: Object.freeze({
    type: "cron",
    schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
  }),
  isEnabled: true,
});

class MemoryStateIO {
  source = null;
  reads = 0;
  writes = 0;

  async read() { this.reads += 1; return this.source; }

  async write(source) {
    this.source = source;
    this.writes += 1;
  }
}

class ConversationDouble extends EventEmitter {
  async list() { return Object.freeze([]); }
  async create() { throw new Error("not used by CRUD tests"); }
  async read() { throw new Error("not used by CRUD tests"); }
  async send() { throw new Error("not used by CRUD tests"); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class GatedStateIO extends MemoryStateIO {
  #writeGate = null;

  gateNextWrite() {
    assert.equal(this.#writeGate, null);
    const entered = deferred();
    const release = deferred();
    this.#writeGate = { entered, release };
    return Object.freeze({ entered: entered.promise, release: release.resolve });
  }

  async write(source) {
    const gate = this.#writeGate;
    if (gate) {
      this.#writeGate = null;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return super.write(source);
  }
}

class FaultingStateIO extends MemoryStateIO {
  writeFailures = 0;

  async write(source) {
    if (this.writeFailures > 0) {
      this.writeFailures -= 1;
      throw new Error("private injected state write failure");
    }
    return super.write(source);
  }
}

async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}

class ManualTimers {
  #clock;
  #nextId = 1;
  #timers = new Map();
  calls = [];
  clears = [];
  callbacks = new Map();

  constructor(clock) { this.#clock = clock; }

  set = (callback, delay) => {
    const token = this.#nextId++;
    this.calls.push({ delay, token });
    this.callbacks.set(token, callback);
    this.#timers.set(token, {
      callback,
      dueAt: this.#clock.value + delay,
    });
    return token;
  };

  clear = (token) => {
    this.clears.push(token);
    this.#timers.delete(token);
  };

  get active() {
    return [...this.#timers.entries()].map(([token, value]) => ({ token, ...value }));
  }

  async invoke(token) {
    const callback = this.callbacks.get(token);
    assert.equal(typeof callback, "function");
    await callback();
    await turn();
  }

  async fire(token) {
    const callback = this.callbacks.get(token);
    assert.equal(typeof callback, "function");
    this.#timers.delete(token);
    await callback();
    await turn();
  }

  jumpTo(epochMs) {
    assert.ok(epochMs >= this.#clock.value);
    this.#clock.value = epochMs;
  }

  async advanceTo(epochMs) {
    assert.ok(epochMs >= this.#clock.value);
    this.#clock.value = epochMs;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, value]) => value.dueAt <= epochMs)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      await due[1].callback();
      await turn();
    }
  }
}

class SchedulerConversations extends EventEmitter {
  records = new Map();
  reads = [];
  creates = [];
  sends = [];
  beforeRead = null;
  beforeCreate = null;
  beforeSend = null;
  failSendFor = new Set();
  sendFailureCodes = new Map();
  failRead = false;
  terminalBeforeReturn = null;
  terminalCode = null;
  rejectAfterEarlyTerminal = false;
  rejectAfterEarlyTerminalCode = null;

  async list(botId) {
    return Object.freeze([...this.records.values()].filter((entry) => entry.botId === botId));
  }

  async read(request) {
    this.reads.push(request);
    if (this.beforeRead) await this.beforeRead(request);
    if (this.failRead) throw new Error("private read failure");
    const value = this.records.get(request.conversationId);
    if (!value || value.botId !== request.botId) {
      const error = new Error("missing");
      error.code = "OPENBOT_CONVERSATION_OPERATION_FAILED";
      throw error;
    }
    return Object.freeze({ ...value });
  }

  async create({ botId }) {
    if (this.beforeCreate) await this.beforeCreate({ botId });
    const sameBotCount = this.creates.filter((entry) => entry.botId === botId).length;
    const conversationId = botId === BOT_A
      ? (sameBotCount === 0 ? CONVERSATION_A : CONVERSATION_A_2)
      : CONVERSATION_B;
    const value = Object.freeze({ botId, conversationId, status: "idle" });
    this.creates.push({ botId });
    this.records.set(conversationId, value);
    return value;
  }

  async send(request) {
    this.sends.push(request);
    if (this.beforeSend) await this.beforeSend(request);
    if (this.failSendFor.has(request.botId)) {
      const error = new Error("private provider detail");
      const code = this.sendFailureCodes.get(request.botId);
      if (code !== undefined) error.code = code;
      throw error;
    }
    const sameBotSendCount = this.sends.filter((entry) => entry.botId === request.botId).length;
    const accepted = Object.freeze({
      botId: request.botId,
      conversationId: request.conversationId,
      invocationId: request.botId === BOT_A
        ? (sameBotSendCount === 1 ? INVOCATION_A : INVOCATION_A_2)
        : INVOCATION_B,
      generation: request.botId === BOT_A ? 7 : 8,
      status: "streaming",
    });
    if (this.terminalBeforeReturn) {
      this.emit("event", {
        type: this.terminalBeforeReturn,
        botId: accepted.botId,
        conversationId: accepted.conversationId,
        invocationId: accepted.invocationId,
        generation: accepted.generation,
        ...(this.terminalBeforeReturn === "failed"
          ? { code: this.terminalCode || "OPENBOT_CONVERSATION_OPERATION_FAILED" }
          : {}),
      });
      if (this.rejectAfterEarlyTerminal) {
        const error = new Error("private post-event rejection");
        if (this.rejectAfterEarlyTerminalCode !== null) {
          error.code = this.rejectAfterEarlyTerminalCode;
        }
        throw error;
      }
    }
    return accepted;
  }
}

function delegatedStore(store, overrides = {}) {
  return Object.fromEntries([
    "list", "listAll", "create", "replace", "delete", "claimRun", "acceptRun",
    "finishRun", "bindConversation", "recoverRunning", "deleteBots",
  ].map((name) => [name, overrides[name] || ((...args) => store[name](...args))]));
}

function privateStoreFailure() {
  const error = new Error("private durable source detail");
  error.code = "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED";
  return error;
}

function schedulerHarness({
  stateIO = new MemoryStateIO(),
  conversations = new SchedulerConversations(),
  suppliedStore = null,
} = {}) {
  const clock = { value: NOW, now: () => clock.value };
  const timers = new ManualTimers(clock);
  const store = suppliedStore || new LocalAutomationStore({
    stateIO,
    now: () => new Date(clock.value).toISOString(),
  });
  let sequence = 0;
  const controller = new LocalAutomationController({
    store,
    conversations,
    randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: clock.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const events = [];
  controller.on("changed", (event) => events.push(event));
  return { clock, controller, conversations, events, stateIO, store, timers };
}

function harness() {
  const stateIO = new MemoryStateIO();
  const clock = { value: NOW, now: () => clock.value };
  const store = new LocalAutomationStore({
    stateIO,
    now: () => new Date(clock.value).toISOString(),
  });
  const conversations = new ConversationDouble();
  const controller = new LocalAutomationController({
    store,
    conversations,
    now: clock.now,
  });
  const events = [];
  controller.on("changed", (event) => events.push(event));
  return { clock, controller, events, stateIO, store };
}

async function create(controller, spec = BASE_SPEC) {
  return controller.createAgentAutomation({ id: BOT_A, spec });
}

test("automation creates a native local Routine and publishes its complete snapshots", async () => {
  const { controller, events } = harness();

  const rows = await create(controller);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: "morning-summary",
    name: "Morning summary",
    prompt: "Summarize the current project status.",
    trigger: {
      type: "cron",
      schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
    },
    schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
    triggerDescription: "Weekdays at 9:00 AM (America/Indiana/Indianapolis)",
    isEnabled: true,
    provenance: "local",
    createdAt: NOW,
    lastRunAt: null,
    nextRunAt: Date.parse("2026-08-17T13:00:00.000Z"),
    runs: [],
    filePath: `openbot-local-routine:${BOT_A}:morning-summary`,
  });
  assert.deepEqual(events, [{
    agentId: BOT_A,
    automations: rows,
    workflows: [{
      id: "morning-summary",
      name: "Morning summary",
      description: "",
      body: "Summarize the current project status.",
      trigger: {
        schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
        isEnabled: true,
      },
      source: "automation",
      sourceRef: null,
      pluginId: null,
      publishedByCurrentUser: false,
      isEnabledForAgent: true,
      scheduleDescription: "Weekdays at 9:00 AM (America/Indiana/Indianapolis)",
      createdAt: NOW,
      lastRunAt: null,
      nextRunAt: Date.parse("2026-08-17T13:00:00.000Z"),
      helperScripts: [],
      runs: [],
      filePath: `openbot-local-routine:${BOT_A}:morning-summary`,
    }],
  }]);
  assert.equal(Object.isFrozen(rows), true);
  assert.equal(Object.isFrozen(rows[0]), true);
  assert.deepEqual(await controller.listAllAutomations({}), [{
    agentId: BOT_A,
    automation: rows[0],
  }]);
});

test("automation descriptions cover interval aliases timezone and complex fallback", async () => {
  const { controller } = harness();
  const fixtures = [
    ["Interval", "@every 15m", "Every 15 minutes"],
    ["Hourly", "@hourly", "Every hour"],
    ["Daily", "@daily", "Every day at 12:00 AM"],
    ["Hour window", "0 9-17 * * *", "Every hour, 9:00 AM – 5:00 PM"],
    ["Multiple times", "0 9,12,17 * * *", "Every day at 9:00 AM, 12:00 PM, and 5:00 PM"],
    ["Weekday range", "0 9 * * 1-4", "Mon–Thu at 9:00 AM"],
    ["Monthly date", "0 9 15 * *", "On the 15th of every month at 9:00 AM"],
    ["Annual date", "0 9 15 8 *", "Every August 15 at 9:00 AM"],
    [
      "Weekday zone",
      "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
      "Weekdays at 9:00 AM (America/Indiana/Indianapolis)",
    ],
    ["Complex", "5 4 1 * 1", "5 4 1 * 1"],
  ];

  for (const [name, schedule, expected] of fixtures) {
    const rows = await controller.createAgentAutomation({
      id: BOT_A,
      spec: { ...BASE_SPEC, name, trigger: { type: "cron", schedule } },
    });
    assert.equal(rows.find((row) => row.name === name).triggerDescription, expected);
  }
});

test("automation updates return the complete current sorted array", async () => {
  const { controller, events } = harness();
  const [original] = await create(controller);

  const rows = await controller.updateAgentAutomation({
    id: BOT_A,
    automationId: original.id,
    spec: {
      name: "Evening summary",
      prompt: "Summarize completed work.",
      trigger: { type: "cron", schedule: "0 18 * * *" },
      isEnabled: true,
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Evening summary");
  assert.equal(rows[0].schedule, "0 18 * * *");
  assert.equal(rows[0].triggerDescription, "Every day at 6:00 PM");
  assert.equal(rows[0].nextRunAt, Date.parse("2026-08-17T18:00:00.000Z"));
  assert.deepEqual(events.at(-1).automations, rows);
});

test("a committed update response cannot resurrect a concurrently deleted Routine", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const replaceCommitted = deferred();
  const releaseReplace = deferred();
  const deleteCommitted = deferred();
  let holdReplace = false;
  const raceStore = delegatedStore(baseStore, {
    async replace(...args) {
      const result = await baseStore.replace(...args);
      if (holdReplace) {
        replaceCommitted.resolve();
        await releaseReplace.promise;
      }
      return result;
    },
    async delete(...args) {
      const result = await baseStore.delete(...args);
      deleteCommitted.resolve();
      return result;
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: raceStore });
  const [automation] = await create(h.controller);
  holdReplace = true;

  const updating = h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
    spec: { ...BASE_SPEC, name: "Committed then deleted" },
  });
  await replaceCommitted.promise;
  const deleting = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
  });
  await Promise.race([
    deleteCommitted.promise,
    (async () => { await turn(); await turn(); })(),
  ]);
  releaseReplace.resolve();

  await Promise.all([updating, deleting]);
  const firstEmpty = h.events.findIndex((event) => event.automations.length === 0);
  assert.ok(firstEmpty >= 0);
  assert.equal(h.events.slice(firstEmpty).some((event) => event.automations.length !== 0), false);
  assert.deepEqual(h.events.at(-1).automations, []);
  assert.deepEqual(await h.controller.getAgentAutomations({ id: BOT_A }), []);
});

test("an update started after delete intent cannot supersede or resurrect that delete", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const deleteReadEntered = deferred();
  const releaseDeleteRead = deferred();
  const releaseUpdateResponse = deferred();
  let holdNextList = false;
  let heldList = false;
  let holdUpdateResponse = false;
  const raceStore = delegatedStore(baseStore, {
    async list(...args) {
      if (holdNextList && !heldList) {
        heldList = true;
        deleteReadEntered.resolve();
        await releaseDeleteRead.promise;
      }
      return baseStore.list(...args);
    },
    async replace(...args) {
      const result = await baseStore.replace(...args);
      if (holdUpdateResponse) await releaseUpdateResponse.promise;
      return result;
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: raceStore });
  const [automation] = await create(h.controller);
  holdNextList = true;
  holdUpdateResponse = true;

  const deleting = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
  });
  await deleteReadEntered.promise;
  const updating = h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
    spec: { ...BASE_SPEC, name: "Must not outlive delete intent" },
  });
  await turn();
  await turn();
  releaseDeleteRead.resolve();
  assert.deepEqual(await deleting, []);
  const deletionEventCount = h.events.length;
  releaseUpdateResponse.resolve();

  assert.deepEqual(await updating, []);
  assert.equal(h.events.length, deletionEventCount);
  assert.deepEqual(await h.controller.getAgentAutomations({ id: BOT_A }), []);
});

test("a response-held committed create cannot publish after its Routine is deleted", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const createCommitted = deferred();
  const releaseCreateResponse = deferred();
  const deleteCommitted = deferred();
  const raceStore = delegatedStore(baseStore, {
    async create(...args) {
      const result = await baseStore.create(...args);
      createCommitted.resolve();
      await releaseCreateResponse.promise;
      return result;
    },
    async delete(...args) {
      const result = await baseStore.delete(...args);
      deleteCommitted.resolve();
      return result;
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: raceStore });

  const creating = create(h.controller);
  await createCommitted.promise;
  const deleting = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: "morning-summary",
  });
  await Promise.race([
    deleteCommitted.promise,
    (async () => { await turn(); await turn(); })(),
  ]);
  releaseCreateResponse.resolve();
  await Promise.all([creating, deleting]);

  const firstEmpty = h.events.findIndex((event) => event.automations.length === 0);
  assert.ok(firstEmpty >= 0);
  assert.equal(h.events.slice(firstEmpty).some((event) => event.automations.length !== 0), false);
  assert.deepEqual(h.events.at(-1).automations, []);
  assert.deepEqual(await h.controller.getAgentAutomations({ id: BOT_A }), []);
});

test("same-bot creates serialize through authoritative complete replies and events", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const firstCreateEntered = deferred();
  const releaseFirstCreate = deferred();
  let createCalls = 0;
  let secondEnteredBeforeRelease = false;
  let firstReleased = false;
  const queuedStore = delegatedStore(baseStore, {
    async create(...args) {
      createCalls += 1;
      if (createCalls === 1) {
        firstCreateEntered.resolve();
        await releaseFirstCreate.promise;
      } else if (!firstReleased) {
        secondEnteredBeforeRelease = true;
      }
      return baseStore.create(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: queuedStore });

  const first = h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "First queued" },
  });
  await firstCreateEntered.promise;
  const second = h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Second queued" },
  });
  await turn();
  await turn();
  firstReleased = true;
  releaseFirstCreate.resolve();

  const [firstReply, secondReply] = await Promise.all([first, second]);
  assert.equal(secondEnteredBeforeRelease, false);
  assert.deepEqual(firstReply.map((entry) => entry.name), ["First queued"]);
  assert.deepEqual(secondReply.map((entry) => entry.name), ["First queued", "Second queued"]);
  assert.deepEqual(h.events.map((event) => event.automations.map((entry) => entry.name)), [
    ["First queued"],
    ["First queued", "Second queued"],
  ]);
  assert.deepEqual((await baseStore.list(BOT_A)).map((entry) => entry.name), [
    "First queued",
    "Second queued",
  ]);
});

test("same-bot Routine mutations serialize without globally blocking another bot", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const firstReplaceEntered = deferred();
  const releaseFirstReplace = deferred();
  let firstAutomationId = null;
  let secondAutomationId = null;
  let holdFirstReplace = false;
  let firstReleased = false;
  let secondSameBotEnteredBeforeRelease = false;
  let unrelatedBotEntered = false;
  const queuedStore = delegatedStore(baseStore, {
    async replace(request) {
      if (holdFirstReplace && request.botId === BOT_A
        && request.automationId === firstAutomationId) {
        firstReplaceEntered.resolve();
        await releaseFirstReplace.promise;
      } else if (holdFirstReplace && request.botId === BOT_A
        && request.automationId === secondAutomationId && !firstReleased) {
        secondSameBotEnteredBeforeRelease = true;
      } else if (holdFirstReplace && request.botId === BOT_B) {
        unrelatedBotEntered = true;
      }
      return baseStore.replace(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: queuedStore });
  let rows = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "First Routine" },
  });
  rows = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Second Routine" },
  });
  firstAutomationId = rows.find((entry) => entry.name === "First Routine").id;
  secondAutomationId = rows.find((entry) => entry.name === "Second Routine").id;
  const [otherAutomation] = await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "Other bot Routine" },
  });
  h.events.length = 0;
  holdFirstReplace = true;

  const first = h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: firstAutomationId,
    spec: { ...BASE_SPEC, name: "First updated" },
  });
  const firstOutcome = first.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  await firstReplaceEntered.promise;
  const second = h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: secondAutomationId,
    spec: { ...BASE_SPEC, name: "Second updated" },
  });
  const secondOutcome = second.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const unrelated = h.controller.updateAgentAutomation({
    id: BOT_B,
    automationId: otherAutomation.id,
    spec: { ...BASE_SPEC, name: "Other bot updated" },
  });
  const unrelatedOutcome = unrelated.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  await turn();
  await turn();
  const unrelatedBeforeRelease = await Promise.race([
    unrelatedOutcome,
    turn().then(() => ({ status: "timeout" })),
  ]);
  firstReleased = true;
  releaseFirstReplace.resolve();

  const [firstResult, secondResult] = await Promise.all([firstOutcome, secondOutcome]);
  assert.equal(secondSameBotEnteredBeforeRelease, false);
  assert.equal(unrelatedBotEntered, true);
  assert.equal(unrelatedBeforeRelease.status, "fulfilled");
  assert.equal(firstResult.status, "fulfilled");
  assert.equal(secondResult.status, "fulfilled");
  assert.deepEqual(firstResult.value.map((entry) => entry.name), [
    "First updated",
    "Second Routine",
  ]);
  assert.deepEqual(secondResult.value.map((entry) => entry.name), [
    "First updated",
    "Second updated",
  ]);
  assert.deepEqual(h.events.filter((event) => event.agentId === BOT_A)
    .map((event) => event.automations.map((entry) => entry.name)), [
    ["First updated", "Second Routine"],
    ["First updated", "Second updated"],
  ]);
  assert.deepEqual((await baseStore.list(BOT_A)).map((entry) => entry.name), [
    "First updated",
    "Second updated",
  ]);
  assert.deepEqual((await baseStore.list(BOT_B)).map((entry) => entry.name), ["Other bot updated"]);
});

test("automation enables and disables without losing its native fields", async () => {
  const { controller, events } = harness();
  const [created] = await create(controller);

  const disabled = await controller.setAgentAutomationEnabled({
    id: BOT_A,
    automationId: created.id,
    isEnabled: false,
  });
  const enabled = await controller.setAgentAutomationEnabled({
    id: BOT_A,
    automationId: created.id,
    isEnabled: true,
  });

  assert.equal(disabled[0].isEnabled, false);
  assert.equal(disabled[0].nextRunAt, null);
  assert.equal(events[1].workflows[0].trigger.isEnabled, false);
  assert.equal(events[1].workflows[0].isEnabledForAgent, true);
  assert.equal(enabled[0].isEnabled, true);
  assert.equal(enabled[0].nextRunAt, Date.parse("2026-08-17T13:00:00.000Z"));
  assert.equal(events.length, 3);
});

test("automation deletes return and publish the complete remaining array", async () => {
  const { controller, events } = harness();
  const [created] = await create(controller);

  const rows = await controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: created.id,
  });

  assert.deepEqual(rows, []);
  assert.deepEqual(events.at(-1), {
    agentId: BOT_A,
    automations: [],
    workflows: [],
  });
  assert.deepEqual(await controller.getAgentAutomations({ id: BOT_A }), []);
  assert.deepEqual(await controller.listAllAutomations({}), []);
});

test("duplicate same-Routine deletes serialize as authoritative native no-ops", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const firstDeleteEntered = deferred();
  const releaseFirstDelete = deferred();
  let holdDelete = false;
  let deleteCalls = 0;
  const queuedStore = delegatedStore(baseStore, {
    async delete(request) {
      deleteCalls += 1;
      if (holdDelete && deleteCalls === 1) {
        firstDeleteEntered.resolve();
        await releaseFirstDelete.promise;
      }
      return baseStore.delete(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: queuedStore });
  const [automation] = await create(h.controller);
  h.events.length = 0;
  holdDelete = true;

  const first = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
  });
  const firstOutcome = first.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  await firstDeleteEntered.promise;
  let secondSettled = false;
  const second = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
  });
  const secondOutcome = second.then(
    (value) => {
      secondSettled = true;
      return { status: "fulfilled", value };
    },
    (reason) => {
      secondSettled = true;
      return { status: "rejected", reason };
    },
  );
  await turn();
  await turn();
  const secondSettledBeforeRelease = secondSettled;
  releaseFirstDelete.resolve();

  const [firstResult, secondResult] = await Promise.all([firstOutcome, secondOutcome]);
  assert.equal(secondSettledBeforeRelease, false);
  assert.deepEqual(firstResult, { status: "fulfilled", value: [] });
  assert.deepEqual(secondResult, { status: "fulfilled", value: [] });
  assert.equal(deleteCalls, 1);
  assert.deepEqual(h.events, [{ agentId: BOT_A, automations: [], workflows: [] }]);
  assert.deepEqual(await baseStore.list(BOT_A), []);
});

test("missing update enable and delete IDs are native no-ops with unchanged arrays", async () => {
  const { controller, events, stateIO } = harness();
  const current = await create(controller);
  const writes = stateIO.writes;

  assert.deepEqual(await controller.updateAgentAutomation({
    id: BOT_A,
    automationId: "missing-routine",
    spec: { ...BASE_SPEC, name: "Ignored" },
  }), current);
  assert.deepEqual(await controller.setAgentAutomationEnabled({
    id: BOT_A,
    automationId: "missing-routine",
    isEnabled: false,
  }), current);
  assert.deepEqual(await controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: "missing-routine",
  }), current);

  assert.equal(stateIO.writes, writes);
  assert.equal(events.length, 1);
});

test("automation rejects remote triggers as unavailable without mutating storage", async () => {
  const { controller, events, stateIO } = harness();
  const triggers = [
    { type: "slack" },
    { type: "github" },
    { type: "microsoftTeams" },
    { type: "linear" },
    { type: "sentry" },
    { type: "pagerduty" },
    { type: "group", listeners: [{ type: "cron", schedule: "0 9 * * *" }] },
  ];

  for (const trigger of triggers) {
    await assert.rejects(
      controller.createAgentAutomation({
        id: BOT_A,
        spec: { ...BASE_SPEC, trigger },
      }),
      (error) => error?.code === "OPENBOT_LOCAL_AUTOMATION_UNAVAILABLE"
        && !error.message.includes(trigger.type),
    );
  }

  assert.equal(stateIO.writes, 0);
  assert.deepEqual(events, []);
});

test("scheduler owns exactly one earliest timer and bounds platform-sized delays", async () => {
  const { controller, timers } = schedulerHarness();
  await controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Later", trigger: { type: "cron", schedule: "0 14 * * *" } },
  });
  await controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Sooner", trigger: { type: "cron", schedule: "30 12 * * *" } },
  });

  await Promise.all([controller.start(), controller.start()]);

  assert.equal(timers.active.length, 1);
  assert.equal(timers.active[0].dueAt, Date.parse("2026-08-17T12:30:00.000Z"));

  const long = schedulerHarness();
  await long.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "TZ=UTC 0 0 1 1 *" } },
  });
  await long.controller.start();
  assert.equal(long.timers.active.length, 1);
  assert.equal(long.timers.calls.at(-1).delay, MAX_TIMER_DELAY);

  await long.timers.advanceTo(NOW + MAX_TIMER_DELAY);
  assert.equal(long.timers.active.length, 1);
  assert.equal(
    long.timers.calls.at(-1).delay,
    Math.min(MAX_TIMER_DELAY, Date.UTC(2027, 0, 1) - NOW - MAX_TIMER_DELAY),
  );
  assert.equal(long.conversations.sends.length, 0);
});

test("a transient initial arm read fails start truthfully and caller retry restores one timer", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  let failNextArmRead = true;
  const transientStore = delegatedStore(baseStore, {
    async listAll(...args) {
      if (failNextArmRead) {
        failNextArmRead = false;
        throw privateStoreFailure();
      }
      return baseStore.listAll(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: transientStore });
  await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "30 12 * * *" } },
  });

  await assert.rejects(h.controller.start(), {
    code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED",
  });
  assert.equal(h.timers.active.length, 0);
  await turn();
  await h.controller.start();

  assert.equal(h.timers.active.length, 1);
  assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:30:00.000Z"));
});

test("started CRUD uses its committed snapshot across one transient rearm read failure", async (t) => {
  async function armedHarness({ withDisabled = false } = {}) {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    let failNextListAll = false;
    const transientStore = delegatedStore(baseStore, {
      async listAll(...args) {
        if (failNextListAll) {
          failNextListAll = false;
          throw privateStoreFailure();
        }
        return baseStore.listAll(...args);
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: transientStore });
    const [baseline] = await h.controller.createAgentAutomation({
      id: BOT_A,
      spec: { ...BASE_SPEC, name: "Baseline", trigger: { type: "cron", schedule: "30 12 * * *" } },
    });
    let disabled = null;
    if (withDisabled) {
      const rows = await h.controller.createAgentAutomation({
        id: BOT_A,
        spec: { ...BASE_SPEC, name: "Disabled", isEnabled: false },
      });
      disabled = rows.find((row) => row.name === "Disabled");
    }
    await h.controller.start();
    return {
      baseline,
      disabled,
      failRearm() { failNextListAll = true; },
      h,
    };
  }

  async function assertCommittedTimer(harness, expectedDueAt, operation) {
    const original = harness.h.timers.active[0];
    assert.ok(original);
    harness.failRearm();
    await operation(harness);
    assert.equal(harness.h.timers.active.length, 1);
    assert.notEqual(harness.h.timers.active[0].token, original.token);
    assert.equal(harness.h.timers.active[0].dueAt, expectedDueAt);
  }

  await t.test("create", async () => {
    const h = await armedHarness();
    await assertCommittedTimer(h, Date.parse("2026-08-17T12:30:00.000Z"), ({ h: current }) => current.controller.createAgentAutomation({
      id: BOT_A,
      spec: { ...BASE_SPEC, name: "Created while started" },
    }));
  });

  await t.test("update", async () => {
    const h = await armedHarness();
    await assertCommittedTimer(h, Date.parse("2026-08-17T13:00:00.000Z"), ({ h: current, baseline }) => current.controller.updateAgentAutomation({
      id: BOT_A,
      automationId: baseline.id,
      spec: { ...BASE_SPEC, name: "Updated while started" },
    }));
  });

  await t.test("enable", async () => {
    const h = await armedHarness({ withDisabled: true });
    await assertCommittedTimer(h, Date.parse("2026-08-17T12:30:00.000Z"), ({ h: current, disabled }) => current.controller.setAgentAutomationEnabled({
      id: BOT_A,
      automationId: disabled.id,
      isEnabled: true,
    }));
  });

  await t.test("delete", async () => {
    const h = await armedHarness();
    const original = h.h.timers.active[0];
    h.failRearm();
    await h.h.controller.deleteAgentAutomation({
      id: BOT_A,
      automationId: h.baseline.id,
    });
    assert.deepEqual(h.h.timers.clears, [original.token]);
    assert.equal(h.h.timers.active.length, 1);
    assert.equal(h.h.timers.active[0].dueAt, NOW + 1_000);
    await h.h.timers.advanceTo(NOW + 1_000);
    assert.equal(h.h.timers.active.length, 0);
  });
});

test("an empty started scheduler trusts an exact first committed snapshot when rearm read fails", async (t) => {
  async function emptyStartedHarness({ seedDisabled = false } = {}) {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    let failNextListAll = false;
    const transientStore = delegatedStore(baseStore, {
      async listAll(...args) {
        if (failNextListAll) {
          failNextListAll = false;
          throw privateStoreFailure();
        }
        return baseStore.listAll(...args);
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: transientStore });
    let disabled = null;
    if (seedDisabled) {
      const rows = await h.controller.createAgentAutomation({
        id: BOT_A,
        spec: {
          ...BASE_SPEC,
          name: "Initially disabled",
          trigger: { type: "cron", schedule: "30 12 * * *" },
          isEnabled: false,
        },
      });
      disabled = rows[0];
    }
    await h.controller.start();
    assert.equal(h.timers.active.length, 0);
    return {
      disabled,
      failNextArm() { failNextListAll = true; },
      h,
    };
  }

  async function assertCommittedEarliest(harness, operation) {
    harness.failNextArm();
    await operation(harness);
    assert.equal(harness.h.timers.active.length, 1);
    assert.equal(harness.h.timers.active[0].dueAt, Date.parse("2026-08-17T12:30:00.000Z"));
  }

  await t.test("first enabled create", async () => {
    const h = await emptyStartedHarness();
    await assertCommittedEarliest(h, ({ h: current }) => (
      current.controller.createAgentAutomation({
        id: BOT_A,
        spec: {
          ...BASE_SPEC,
          name: "First enabled",
          trigger: { type: "cron", schedule: "30 12 * * *" },
        },
      })
    ));
  });

  await t.test("first enable", async () => {
    const h = await emptyStartedHarness({ seedDisabled: true });
    await assertCommittedEarliest(h, ({ disabled, h: current }) => (
      current.controller.setAgentAutomationEnabled({
        id: BOT_A,
        automationId: disabled.id,
        isEnabled: true,
      })
    ));
  });
});

test("an ordinary due timer claims one scheduled run and rearms before inference completes", async () => {
  const h = schedulerHarness();
  const [automation] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.start();

  await h.timers.advanceTo(Date.parse("2026-08-17T12:01:00.000Z"));
  for (let attempt = 0; attempt < 10 && h.conversations.sends.length === 0; attempt += 1) await turn();

  const running = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
  assert.equal(running.id, automation.id);
  assert.equal(running.runs[0].trigger, "schedule");
  assert.equal(running.runs[0].status, "running");
  assert.equal(running.nextRunAt, Date.parse("2026-08-18T12:01:00.000Z"));
  assert.equal(h.conversations.sends.length, 1);
  assert.equal(h.timers.active.length, 1);
  assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-18T12:01:00.000Z"));

  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A,
    generation: 7,
  });
  await turn();
});

test("a cleared but already queued stale timer callback cannot launch an enabled due run", async () => {
  const h = schedulerHarness();
  const [automation] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.start();
  const staleToken = h.timers.active[0].token;

  await h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
    spec: {
      ...BASE_SPEC,
      prompt: "Updated without changing the due schedule.",
      trigger: { type: "cron", schedule: "1 12 * * *" },
    },
  });
  const authoritativeToken = h.timers.active[0].token;
  assert.notEqual(authoritativeToken, staleToken);
  h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
  await h.timers.invoke(staleToken);

  assert.equal(h.conversations.sends.length, 0);
  assert.equal((await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs.length, 0);
  assert.deepEqual(h.timers.active.map((timer) => timer.token), [authoritativeToken]);
});

test("timer replacement cannot publish a new token after reentrant disposal", async () => {
  const stateIO = new MemoryStateIO();
  const clock = { value: NOW, now: () => clock.value };
  const timers = new ManualTimers(clock);
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(clock.value).toISOString(),
  });
  const conversations = new SchedulerConversations();
  let controller = null;
  let reenterOnClear = false;
  let didReenter = false;
  let disposeFromClear = null;
  const clearedTokens = [];
  const clearTimer = (token) => {
    clearedTokens.push(token);
    timers.clear(token);
    if (reenterOnClear && !didReenter) {
      didReenter = true;
      disposeFromClear = controller.dispose();
    }
  };
  controller = new LocalAutomationController({
    store: baseStore,
    conversations,
    now: clock.now,
    setTimer: timers.set,
    clearTimer,
  });
  const [automation] = await controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "30 12 * * *" } },
  });
  await controller.start();
  const firstToken = timers.active[0].token;
  reenterOnClear = true;

  const updating = controller.updateAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
    spec: {
      ...BASE_SPEC,
      prompt: "Committed before timer-clear disposal.",
      trigger: { type: "cron", schedule: "30 12 * * *" },
    },
  });
  const updateOutcome = updating.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const updateResult = await updateOutcome;
  await disposeFromClear;
  const replacementToken = timers.calls.at(-1).token;

  assert.equal(updateResult.status, "rejected");
  assert.equal(updateResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_FAILED");
  assert.notEqual(replacementToken, firstToken);
  assert.deepEqual(clearedTokens, [firstToken, replacementToken]);
  assert.equal(timers.active.length, 0);
  assert.strictEqual(controller.dispose(), disposeFromClear);
});

test("a held Routine delete fence immediately keeps another bot's timer runnable", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const heldStore = delegatedStore(baseStore, {
    async delete(request) {
      deleteEntered.resolve();
      await releaseDelete.promise;
      return baseStore.delete(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: heldStore });
  const [automationA] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A due first", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B remains runnable", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  await h.controller.start();
  const staleAToken = h.timers.active[0].token;
  let deleteSettled = false;
  const deleting = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: automationA.id,
  });
  const deleteOutcome = deleting.then(
    (value) => { deleteSettled = true; return { status: "fulfilled", value }; },
    (reason) => { deleteSettled = true; return { status: "rejected", reason }; },
  );

  try {
    await deleteEntered.promise;
    assert.equal(deleteSettled, false);
    assert.equal(h.timers.active.length, 1);
    assert.notEqual(h.timers.active[0].token, staleAToken);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));

    h.timers.jumpTo(Date.parse("2026-08-17T12:02:00.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    for (let attempt = 0; attempt < 20 && h.conversations.sends.length === 0; attempt += 1) await turn();
    assert.equal(deleteSettled, false);
    assert.deepEqual(h.conversations.sends.map((request) => request.botId), [BOT_B]);
    h.conversations.emit("event", {
      type: "completed",
      botId: BOT_B,
      conversationId: CONVERSATION_B,
      invocationId: INVOCATION_B,
      generation: 8,
    });
    await turn();
  } finally {
    releaseDelete.resolve();
    const outcome = await deleteOutcome;
    if (outcome.status === "fulfilled") {
      assert.deepEqual(outcome.value.map((entry) => entry.name), []);
    }
    await h.controller.dispose();
  }
});

test("startup during a held due delete fence arms the unaffected future bot", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const heldStore = delegatedStore(baseStore, {
    async delete(request) {
      deleteEntered.resolve();
      await releaseDelete.promise;
      return baseStore.delete(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: heldStore });
  const [automationA] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A due while fenced", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B after startup", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
  const deleting = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: automationA.id,
  });
  const deleteOutcome = deleting.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

  try {
    await deleteEntered.promise;
    await h.controller.start();
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
    assert.equal(h.conversations.sends.length, 0);
  } finally {
    releaseDelete.resolve();
    await deleteOutcome;
    await h.controller.dispose();
  }
});

test("a real store write gate cannot hide the unaffected bot's replacement timer", async () => {
  const stateIO = new GatedStateIO();
  const h = schedulerHarness({ stateIO });
  const [automationA] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A durable delete", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B survives durable gate", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  await h.controller.start();
  const staleAToken = h.timers.active[0].token;
  const gate = stateIO.gateNextWrite();
  const deleting = h.controller.deleteAgentAutomation({
    id: BOT_A,
    automationId: automationA.id,
  });
  const deleteOutcome = deleting.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

  try {
    await gate.entered;
    assert.equal(h.timers.active.length, 1);
    assert.notEqual(h.timers.active[0].token, staleAToken);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
    await h.timers.invoke(staleAToken);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
  } finally {
    gate.release();
    const outcome = await deleteOutcome;
    if (outcome.status === "fulfilled") {
      assert.deepEqual(outcome.value.map((entry) => entry.name), []);
    }
    await h.controller.dispose();
  }
});

test("duplicate failing delete intents exclude once and restore only after the last fence clears", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const entered = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  let deleteCalls = 0;
  const failingStore = delegatedStore(baseStore, {
    async delete() {
      const index = deleteCalls++;
      entered[index].resolve();
      await release[index].promise;
      throw privateStoreFailure();
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  const [automationA] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A restored", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B while fenced", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  await h.controller.start();
  const first = h.controller.deleteAgentAutomation({ id: BOT_A, automationId: automationA.id });
  const second = h.controller.deleteAgentAutomation({ id: BOT_A, automationId: automationA.id });
  const firstOutcome = first.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const secondOutcome = second.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

  try {
    await entered[0].promise;
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
    assert.equal(h.timers.calls.length, 2);

    release[0].resolve();
    const firstResult = await firstOutcome;
    assert.equal(firstResult.status, "rejected");
    assert.equal(firstResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED");
    await entered[1].promise;
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
    assert.equal(h.timers.calls.length, 2);

    release[1].resolve();
    const secondResult = await secondOutcome;
    assert.equal(secondResult.status, "rejected");
    assert.equal(secondResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED");
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:01:00.000Z"));
    assert.equal(h.timers.calls.length, 3);
  } finally {
    release[0].resolve();
    release[1].resolve();
    await Promise.all([firstOutcome, secondOutcome]);
    await h.controller.dispose();
  }
});

test("a failed delete restores its cached due Routine when the authoritative rearm read also fails", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  let failNextListAll = false;
  const failingStore = delegatedStore(baseStore, {
    async delete() {
      failNextListAll = true;
      throw privateStoreFailure();
    },
    listAll(...args) {
      if (failNextListAll) {
        failNextListAll = false;
        return Promise.reject(privateStoreFailure());
      }
      return baseStore.listAll(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  const [automationA] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A must be restored", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B remains later", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  await h.controller.start();

  try {
    await assert.rejects(h.controller.deleteAgentAutomation({
      id: BOT_A,
      automationId: automationA.id,
    }), { code: "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED" });
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:01:00.000Z"));
  } finally {
    await h.controller.dispose();
  }
});

test("persistent scheduled claim failures back off exponentially and cap without a zero-delay loop", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  let claimCalls = 0;
  const failingStore = delegatedStore(baseStore, {
    async claimRun() {
      claimCalls += 1;
      throw privateStoreFailure();
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  await h.controller.start();
  const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];

  try {
    for (const expectedDelay of expectedDelays) {
      const current = h.timers.active[0];
      assert.ok(current);
      h.timers.jumpTo(current.dueAt);
      await h.timers.fire(current.token);
      for (let attempt = 0; attempt < 20 && h.timers.active.length === 0; attempt += 1) await turn();
      assert.equal(h.timers.active.length, 1);
      assert.equal(h.timers.active[0].dueAt - h.clock.value, expectedDelay);
      assert.ok(h.timers.active[0].dueAt > h.clock.value);
    }
    assert.equal(claimCalls, expectedDelays.length);
  } finally {
    await h.controller.dispose();
  }
});

test("a real store claim write failure backs off without changing the durable due record", async () => {
  const stateIO = new FaultingStateIO();
  const h = schedulerHarness({ stateIO });
  const [automation] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  await h.controller.start();
  stateIO.writeFailures = 1;

  try {
    h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:01:01.000Z"));
    const unchanged = (await h.store.list(BOT_A)).find((entry) => entry.id === automation.id);
    assert.equal(unchanged.nextRunAt, Date.parse("2026-08-17T12:01:00.000Z"));
    assert.deepEqual(unchanged.runs, []);

    h.timers.jumpTo(Date.parse("2026-08-17T12:01:01.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    for (let attempt = 0; attempt < 20 && h.conversations.sends.length === 0; attempt += 1) await turn();
    assert.equal(h.conversations.sends.length, 1);
    const claimed = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
    assert.equal(claimed.runs[0].status, "running");
    assert.equal(claimed.nextRunAt, Date.parse("2026-08-17T12:02:00.000Z"));
    h.conversations.emit("event", {
      type: "completed",
      botId: BOT_A,
      conversationId: CONVERSATION_A,
      invocationId: INVOCATION_A,
      generation: 7,
    });
    await turn();
  } finally {
    await h.controller.dispose();
  }
});

test("an unaffected bot due before a failed Routine's retry wins the sole timer", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  await baseStore.create({
    botId: BOT_A,
    automation: {
      name: "A pre-claim fails",
      prompt: BASE_SPEC.prompt,
      trigger: { type: "cron", schedule: "* * * * *" },
      triggerDescription: "Every minute",
      isEnabled: true,
      nextRunAt: NOW + 1_000,
    },
  });
  await baseStore.create({
    botId: BOT_B,
    automation: {
      name: "B is earlier than retry",
      prompt: BASE_SPEC.prompt,
      trigger: { type: "cron", schedule: "* * * * *" },
      triggerDescription: "Every minute",
      isEnabled: true,
      nextRunAt: NOW + 1_500,
    },
  });
  const failingStore = delegatedStore(baseStore, {
    claimRun(request) {
      if (request.botId === BOT_A) return Promise.reject(privateStoreFailure());
      return baseStore.claimRun(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  await h.controller.start();

  try {
    h.timers.jumpTo(NOW + 1_000);
    await h.timers.fire(h.timers.active[0].token);
    for (let attempt = 0; attempt < 20 && h.timers.active.length === 0; attempt += 1) await turn();
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, NOW + 1_500);

    h.timers.jumpTo(NOW + 1_500);
    await h.timers.fire(h.timers.active[0].token);
    for (let attempt = 0; attempt < 20 && h.conversations.sends.length === 0; attempt += 1) await turn();
    assert.deepEqual(h.conversations.sends.map((request) => request.botId), [BOT_B]);
    h.conversations.emit("event", {
      type: "completed",
      botId: BOT_B,
      conversationId: CONVERSATION_B,
      invocationId: INVOCATION_B,
      generation: 8,
    });
    await turn();
  } finally {
    await h.controller.dispose();
  }
});

test("a successful scheduled retry resets the next failure to the base backoff", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  let failuresRemaining = 2;
  const recoveringStore = delegatedStore(baseStore, {
    claimRun(request) {
      if (request.botId === BOT_A && failuresRemaining > 0) {
        failuresRemaining -= 1;
        return Promise.reject(privateStoreFailure());
      }
      return baseStore.claimRun(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: recoveringStore });
  await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  await h.controller.start();

  try {
    h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:01:01.000Z"));

    h.timers.jumpTo(Date.parse("2026-08-17T12:01:01.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:01:03.000Z"));

    h.timers.jumpTo(Date.parse("2026-08-17T12:01:03.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    for (let attempt = 0; attempt < 20 && h.conversations.sends.length === 0; attempt += 1) await turn();
    assert.equal(h.conversations.sends.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
    h.conversations.emit("event", {
      type: "completed",
      botId: BOT_A,
      conversationId: CONVERSATION_A,
      invocationId: INVOCATION_A,
      generation: 7,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await h.controller.getAgentAutomations({ id: BOT_A });
      if (rows[0].runs[0]?.status === "ok") break;
      await turn();
    }

    failuresRemaining = 1;
    h.timers.jumpTo(Date.parse("2026-08-17T12:02:00.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:01.000Z"));
  } finally {
    await h.controller.dispose();
  }
});

test("a committed configuration change clears scheduled failure history", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const failingStore = delegatedStore(baseStore, {
    claimRun: async () => { throw privateStoreFailure(); },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  const [automation] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  await h.controller.start();

  try {
    h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:01:01.000Z"));

    await h.controller.updateAgentAutomation({
      id: BOT_A,
      automationId: automation.id,
      spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "2 12 * * *" } },
    });
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));

    h.timers.jumpTo(Date.parse("2026-08-17T12:02:00.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:01.000Z"));
  } finally {
    await h.controller.dispose();
  }
});

test("a committed configuration snapshot supersedes an earlier backoff when rearm storage fails", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const [seeded] = await baseStore.create({
    botId: BOT_A,
    automation: {
      name: BASE_SPEC.name,
      prompt: BASE_SPEC.prompt,
      trigger: { type: "cron", schedule: "* * * * *" },
      triggerDescription: "Every minute",
      isEnabled: true,
      nextRunAt: NOW + 59_500,
    },
  });
  let failNextListAll = false;
  const failingStore = delegatedStore(baseStore, {
    claimRun: async () => { throw privateStoreFailure(); },
    listAll(...args) {
      if (failNextListAll) {
        failNextListAll = false;
        return Promise.reject(privateStoreFailure());
      }
      return baseStore.listAll(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  await h.controller.start();

  try {
    h.timers.jumpTo(NOW + 59_500);
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(h.timers.active[0].dueAt, NOW + 60_500);

    failNextListAll = true;
    await h.controller.updateAgentAutomation({
      id: BOT_A,
      automationId: seeded.id,
      spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "1 12 * * *" } },
    });
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, NOW + 60_000);
  } finally {
    await h.controller.dispose();
  }
});

test("deleting and recreating the same Routine clears backoff and fences its stale callback", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const failingStore = delegatedStore(baseStore, {
    claimRun: async () => { throw privateStoreFailure(); },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  const [automation] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  await h.controller.start();

  try {
    h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
    await h.timers.fire(h.timers.active[0].token);
    const staleRetry = h.timers.active[0];
    assert.equal(staleRetry.dueAt, Date.parse("2026-08-17T12:01:01.000Z"));

    assert.deepEqual(await h.controller.deleteAgentAutomation({
      id: BOT_A,
      automationId: automation.id,
    }), []);
    assert.equal(h.timers.active.length, 0);

    const [recreated] = await h.controller.createAgentAutomation({
      id: BOT_A,
      spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
    });
    assert.equal(recreated.id, automation.id);
    const recreatedTimer = h.timers.active[0];
    assert.equal(recreatedTimer.dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
    await h.timers.invoke(staleRetry.token);
    assert.deepEqual(h.timers.active.map((timer) => timer.token), [recreatedTimer.token]);

    h.timers.jumpTo(Date.parse("2026-08-17T12:02:00.000Z"));
    await h.timers.fire(recreatedTimer.token);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:01.000Z"));
  } finally {
    await h.controller.dispose();
  }
});

test("disposing a controller makes an already queued backoff callback inert", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const failingStore = delegatedStore(baseStore, {
    claimRun: async () => { throw privateStoreFailure(); },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  await h.controller.start();
  h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
  await h.timers.fire(h.timers.active[0].token);
  const staleRetry = h.timers.active[0];
  assert.equal(staleRetry.dueAt, Date.parse("2026-08-17T12:01:01.000Z"));
  const timerCallCount = h.timers.calls.length;

  await h.controller.dispose();
  assert.equal(h.timers.active.length, 0);
  h.timers.jumpTo(staleRetry.dueAt);
  await h.timers.invoke(staleRetry.token);

  assert.equal(h.timers.active.length, 0);
  assert.equal(h.timers.calls.length, timerCallCount);
  assert.equal(h.conversations.sends.length, 0);
});

test("deleteBots synchronously replaces a real-store gated bot timer with the unaffected bot", async () => {
  const stateIO = new GatedStateIO();
  const h = schedulerHarness({ stateIO });
  const [automationA] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A purged behind a write", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B remains armed", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  await h.controller.start();
  const staleAToken = h.timers.active[0].token;
  const gate = stateIO.gateNextWrite();
  const deleting = h.controller.deleteBots({ botIds: [BOT_A] });
  assert.strictEqual(h.controller.deleteBots({ botIds: [BOT_A] }), deleting);
  const deleteOutcome = deleting.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  let staleSettled = false;
  let staleInvocation = null;

  try {
    await gate.entered;
    assert.equal(h.timers.active.length, 1);
    assert.notEqual(h.timers.active[0].token, staleAToken);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));

    staleInvocation = h.timers.invoke(staleAToken).then(() => { staleSettled = true; });
    await turn();
    await turn();
    assert.equal(staleSettled, true);
    assert.deepEqual(h.timers.active.map((timer) => timer.dueAt), [
      Date.parse("2026-08-17T12:02:00.000Z"),
    ]);
    await assert.rejects(h.controller.createAgentAutomation({
      id: BOT_A,
      spec: { ...BASE_SPEC, name: "Rejected after bot fence" },
    }), { code: "OPENBOT_LOCAL_AUTOMATION_FAILED" });
  } finally {
    gate.release();
    if (staleInvocation) await staleInvocation;
    const outcome = await deleteOutcome;
    if (outcome.status === "fulfilled") {
      assert.deepEqual(outcome.value, { deletedAutomationIds: [automationA.id] });
    }
    await h.controller.dispose();
  }
});

test("deleteBots is canonically admitted before timer cleanup can synchronously reenter", async () => {
  const stateIO = new MemoryStateIO();
  const clock = { value: NOW, now: () => clock.value };
  const timers = new ManualTimers(clock);
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(clock.value).toISOString(),
  });
  let purgeCalls = 0;
  const store = delegatedStore(baseStore, {
    deleteBots(request) {
      purgeCalls += 1;
      return baseStore.deleteBots(request);
    },
  });
  const conversations = new SchedulerConversations();
  let controller = null;
  let reenterOnClear = false;
  let didReenter = false;
  let nestedDelete = null;
  const clearTimer = (token) => {
    timers.clear(token);
    if (reenterOnClear && !didReenter) {
      didReenter = true;
      nestedDelete = controller.deleteBots({ botIds: [BOT_A] });
    }
  };
  controller = new LocalAutomationController({
    store,
    conversations,
    now: clock.now,
    setTimer: timers.set,
    clearTimer,
  });
  const [automationA] = await controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A removed", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B remains", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  await controller.start();
  reenterOnClear = true;

  const outerDelete = controller.deleteBots({ botIds: [BOT_A] });
  const laterDelete = controller.deleteBots({ botIds: [BOT_A] });
  const expected = { deletedAutomationIds: [automationA.id] };

  try {
    assert.equal(didReenter, true);
    assert.strictEqual(nestedDelete, outerDelete);
    assert.strictEqual(laterDelete, outerDelete);
    assert.deepEqual(await outerDelete, expected);
    assert.deepEqual(await nestedDelete, expected);
    assert.deepEqual(await laterDelete, expected);
    assert.equal(purgeCalls, 1);
    assert.equal(timers.active.length, 1);
    assert.equal(timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
  } finally {
    await Promise.allSettled([outerDelete, nestedDelete, laterDelete].filter(Boolean));
    await controller.dispose();
  }
});

test("a failed bot purge remains permanently fenced and a retry leaves the other bot armed", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const purgeEntered = deferred();
  const releasePurge = deferred();
  let purgeCalls = 0;
  const failingStore = delegatedStore(baseStore, {
    async deleteBots(request) {
      purgeCalls += 1;
      if (purgeCalls === 1) {
        purgeEntered.resolve();
        await releasePurge.promise;
        throw privateStoreFailure();
      }
      return baseStore.deleteBots(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: failingStore });
  await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A purge fails", trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B survives failed purge", trigger: { type: "cron", schedule: "2 12 * * *" } },
  });
  await h.controller.start();
  const deleting = h.controller.deleteBots({ botIds: [BOT_A] });
  assert.strictEqual(h.controller.deleteBots({ botIds: [BOT_A] }), deleting);
  const deleteOutcome = deleting.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

  try {
    await purgeEntered.promise;
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
    releasePurge.resolve();
    const failed = await deleteOutcome;
    assert.equal(failed.status, "rejected");
    assert.equal(failed.reason.code, "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED");
    await assert.rejects(h.controller.getAgentAutomations({ id: BOT_A }), {
      code: "OPENBOT_LOCAL_AUTOMATION_FAILED",
    });
    assert.equal((await baseStore.list(BOT_A)).length, 1);
    assert.deepEqual((await h.controller.getAgentAutomations({ id: BOT_B })).map((row) => row.name), [
      "B survives failed purge",
    ]);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));

    const retried = await h.controller.deleteBots({ botIds: [BOT_A] });
    assert.equal(purgeCalls, 2);
    assert.equal(retried.deletedAutomationIds.length, 1);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:02:00.000Z"));
  } finally {
    releasePurge.resolve();
    await deleteOutcome;
    await h.controller.dispose();
  }
});

test("committed create update and enable synchronously replace a later timer before rearm read failure", async (t) => {
  async function committedHarness(setup) {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    let failNextListAll = false;
    const store = delegatedStore(baseStore, {
      async listAll(...args) {
        if (failNextListAll) {
          failNextListAll = false;
          throw privateStoreFailure();
        }
        return baseStore.listAll(...args);
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: store });
    const state = await setup(h.controller);
    await h.controller.start();
    return {
      failRearm() { failNextListAll = true; },
      h,
      state,
    };
  }

  async function assertCommittedEarlier(harness, operation) {
    const original = harness.h.timers.active[0];
    assert.equal(original.dueAt, Date.parse("2026-08-17T13:00:00.000Z"));
    harness.failRearm();
    try {
      await operation(harness);
      assert.equal(harness.h.timers.active.length, 1);
      assert.notEqual(harness.h.timers.active[0].token, original.token);
      assert.equal(harness.h.timers.active[0].dueAt, Date.parse("2026-08-17T12:30:00.000Z"));
    } finally {
      await harness.h.controller.dispose();
    }
  }

  await t.test("create", async () => {
    const harness = await committedHarness(async (controller) => {
      await controller.createAgentAutomation({
        id: BOT_B,
        spec: { ...BASE_SPEC, name: "Existing 13:00", trigger: { type: "cron", schedule: "0 13 * * *" } },
      });
      return {};
    });
    await assertCommittedEarlier(harness, ({ h }) => h.controller.createAgentAutomation({
      id: BOT_A,
      spec: { ...BASE_SPEC, name: "Committed 12:30", trigger: { type: "cron", schedule: "30 12 * * *" } },
    }));
  });

  await t.test("update", async () => {
    const harness = await committedHarness(async (controller) => {
      const [automation] = await controller.createAgentAutomation({
        id: BOT_A,
        spec: { ...BASE_SPEC, name: "A initially 14:00", trigger: { type: "cron", schedule: "0 14 * * *" } },
      });
      await controller.createAgentAutomation({
        id: BOT_B,
        spec: { ...BASE_SPEC, name: "Existing 13:00", trigger: { type: "cron", schedule: "0 13 * * *" } },
      });
      return { automation };
    });
    await assertCommittedEarlier(harness, ({ h, state }) => h.controller.updateAgentAutomation({
      id: BOT_A,
      automationId: state.automation.id,
      spec: { ...BASE_SPEC, name: "A committed 12:30", trigger: { type: "cron", schedule: "30 12 * * *" } },
    }));
  });

  await t.test("enable", async () => {
    const harness = await committedHarness(async (controller) => {
      const [automation] = await controller.createAgentAutomation({
        id: BOT_A,
        spec: {
          ...BASE_SPEC,
          name: "A disabled 12:30",
          trigger: { type: "cron", schedule: "30 12 * * *" },
          isEnabled: false,
        },
      });
      await controller.createAgentAutomation({
        id: BOT_B,
        spec: { ...BASE_SPEC, name: "Existing 13:00", trigger: { type: "cron", schedule: "0 13 * * *" } },
      });
      return { automation };
    });
    await assertCommittedEarlier(harness, ({ h, state }) => h.controller.setAgentAutomationEnabled({
      id: BOT_A,
      automationId: state.automation.id,
      isEnabled: true,
    }));
  });
});

test("a newer committed snapshot beats an older held schedule read and a newer failed read", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const staleReadEntered = deferred();
  const releaseStaleRead = deferred();
  let adversarialReads = false;
  let adversarialReadCount = 0;
  const store = delegatedStore(baseStore, {
    async listAll(...args) {
      if (!adversarialReads) return baseStore.listAll(...args);
      adversarialReadCount += 1;
      if (adversarialReadCount === 1) {
        const stale = await baseStore.listAll(...args);
        staleReadEntered.resolve();
        await releaseStaleRead.promise;
        return stale;
      }
      if (adversarialReadCount === 2) throw privateStoreFailure();
      return baseStore.listAll(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: store });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "Existing 13:00", trigger: { type: "cron", schedule: "0 13 * * *" } },
  });
  await h.controller.start();
  adversarialReads = true;
  const creatingA = h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Held read 12:45", trigger: { type: "cron", schedule: "45 12 * * *" } },
  });
  let creatingC = null;

  try {
    await staleReadEntered.promise;
    creatingC = h.controller.createAgentAutomation({
      id: BOT_C,
      spec: { ...BASE_SPEC, name: "Newest committed 12:30", trigger: { type: "cron", schedule: "30 12 * * *" } },
    });
    await creatingC;
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:30:00.000Z"));

    releaseStaleRead.resolve();
    await creatingA;
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:30:00.000Z"));
  } finally {
    releaseStaleRead.resolve();
    await Promise.allSettled([creatingA, ...(creatingC ? [creatingC] : [])]);
    await h.controller.dispose();
  }
});

test("an exhausted claimed-false schedule advance backs off while an earlier unaffected bot wins", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const [automationA] = await baseStore.create({
    botId: BOT_A,
    automation: {
      name: "A cannot advance",
      prompt: BASE_SPEC.prompt,
      trigger: { type: "cron", schedule: "* * * * *" },
      triggerDescription: "Every minute",
      isEnabled: true,
      nextRunAt: NOW + 1_000,
    },
  });
  await baseStore.create({
    botId: BOT_B,
    automation: {
      name: "B should win",
      prompt: BASE_SPEC.prompt,
      trigger: { type: "cron", schedule: "* * * * *" },
      triggerDescription: "Every minute",
      isEnabled: true,
      nextRunAt: NOW + 1_500,
    },
  });
  let failedReplacements = 0;
  const store = delegatedStore(baseStore, {
    async claimRun(request) {
      if (request.botId !== BOT_A) return baseStore.claimRun(request);
      const current = (await baseStore.list(BOT_A))
        .find((record) => record.id === request.automationId);
      return Object.freeze({ claimed: false, automation: current });
    },
    async replace(request) {
      if (request.botId === BOT_A) {
        failedReplacements += 1;
        throw privateStoreFailure();
      }
      return baseStore.replace(request);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: store });
  await h.controller.start();

  try {
    h.timers.jumpTo(NOW + 1_000);
    await h.timers.fire(h.timers.active[0].token);
    assert.equal(failedReplacements, 3);
    assert.equal(h.timers.active.length, 1);
    assert.equal(h.timers.active[0].dueAt, NOW + 1_500);
    assert.notEqual(h.timers.calls.at(-1).delay, 0);

    h.timers.jumpTo(NOW + 1_500);
    await h.timers.fire(h.timers.active[0].token);
    for (let attempt = 0; attempt < 20 && h.conversations.sends.length === 0; attempt += 1) await turn();
    assert.deepEqual(h.conversations.sends.map((request) => request.botId), [BOT_B]);
    assert.equal((await baseStore.list(BOT_A))[0].id, automationA.id);
    h.conversations.emit("event", {
      type: "completed",
      botId: BOT_B,
      conversationId: CONVERSATION_B,
      invocationId: INVOCATION_B,
      generation: 8,
    });
    await turn();
  } finally {
    await h.controller.dispose();
  }
});

test("arm reads retry repeatedly with bounded exponential delays reset and stale disposal safety", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  let failuresRemaining = 0;
  const store = delegatedStore(baseStore, {
    async listAll(...args) {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw privateStoreFailure();
      }
      return baseStore.listAll(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: store });
  await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "* * * * *" } },
  });
  await h.controller.start();

  h.timers.jumpTo(Date.parse("2026-08-17T12:01:00.000Z"));
  failuresRemaining = 4;
  await h.timers.fire(h.timers.active[0].token);
  assert.equal(h.timers.active.length, 1);
  const firstRetry = h.timers.active[0];
  assert.equal(firstRetry.dueAt, Date.parse("2026-08-17T12:01:01.000Z"));

  h.timers.jumpTo(firstRetry.dueAt);
  await h.timers.fire(firstRetry.token);
  assert.equal(h.timers.active.length, 1);
  const secondRetry = h.timers.active[0];
  assert.equal(secondRetry.dueAt, Date.parse("2026-08-17T12:01:03.000Z"));

  h.timers.jumpTo(secondRetry.dueAt);
  await h.timers.fire(secondRetry.token);
  assert.equal(h.timers.active.length, 1);
  const thirdRetry = h.timers.active[0];
  assert.equal(thirdRetry.dueAt, Date.parse("2026-08-17T12:01:07.000Z"));

  h.timers.jumpTo(thirdRetry.dueAt);
  await h.timers.fire(thirdRetry.token);
  assert.equal(failuresRemaining, 0);
  assert.equal(h.timers.active.length, 1);
  const recoveredSchedule = h.timers.active[0];
  assert.equal(recoveredSchedule.dueAt, thirdRetry.dueAt);
  await h.timers.invoke(firstRetry.token);
  assert.deepEqual(h.timers.active.map((timer) => timer.token), [recoveredSchedule.token]);

  failuresRemaining = 2;
  await h.timers.fire(recoveredSchedule.token);
  assert.equal(h.timers.active.length, 1);
  const resetRetry = h.timers.active[0];
  assert.equal(resetRetry.dueAt, h.clock.value + 1_000);
  const timerCallCount = h.timers.calls.length;

  await h.controller.dispose();
  assert.equal(h.timers.active.length, 0);
  h.timers.jumpTo(resetRetry.dueAt);
  await h.timers.invoke(resetRetry.token);
  assert.equal(h.timers.active.length, 0);
  assert.equal(h.timers.calls.length, timerCallCount);
});

test("a saturated safe-integer run backoff still arms a nonzero retry delay", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  await baseStore.create({
    botId: BOT_A,
    automation: {
      name: "Safe integer ceiling",
      prompt: BASE_SPEC.prompt,
      trigger: { type: "cron", schedule: "* * * * *" },
      triggerDescription: "Every minute",
      isEnabled: true,
      nextRunAt: Number.MAX_SAFE_INTEGER,
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: baseStore });
  h.clock.value = Number.MAX_SAFE_INTEGER - 1;
  await h.controller.start();
  assert.equal(h.timers.active.length, 1);
  assert.equal(h.timers.calls.at(-1).delay, 1);

  h.timers.jumpTo(Number.MAX_SAFE_INTEGER);
  await h.timers.fire(h.timers.active[0].token);
  assert.equal(h.timers.active.length, 1);
  assert.equal(h.timers.calls.at(-1).delay, 1_000);
  assert.ok(h.timers.calls.at(-1).delay > 0);

  await h.controller.dispose();
});

test("terminal run persists running before send and waits for the exact conversation event", async () => {
  const h = schedulerHarness();
  const enteredSend = deferred();
  const releaseSend = deferred();
  h.conversations.beforeSend = async () => {
    enteredSend.resolve();
    await releaseSend.promise;
  };
  const [automation] = await create(h.controller);
  let runSettled = false;

  const running = h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: automation.id,
  });
  void running.then(() => { runSettled = true; });
  await enteredSend.promise;

  const claimed = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
  assert.equal(claimed.runs[0].status, "running");
  assert.equal(claimed.runs[0].trigger, "manual");
  assert.equal(claimed.runs[0].id, "00000000-0000-4000-8000-000000000001");
  assert.equal(runSettled, false);
  assert.equal(h.events.at(-1).automations[0].runs[0].status, "running");

  releaseSend.resolve();
  await turn();
  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_B,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A,
    generation: 7,
  });
  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_A,
    conversationId: CONVERSATION_B,
    invocationId: INVOCATION_A,
    generation: 7,
  });
  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_B,
    generation: 7,
  });
  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A,
    generation: 8,
  });
  await turn();
  assert.equal(runSettled, false);

  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A,
    generation: 7,
  });
  assert.equal(await running, undefined);

  const finished = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
  assert.equal(finished.runs[0].status, "ok");
  assert.equal(finished.runs[0].finishedAt, NOW);
  assert.equal(Object.hasOwn(finished, "conversationId"), false);
  assert.equal(Object.hasOwn(finished.runs[0], "invocationId"), false);
  assert.equal(h.events.at(-1).automations[0].runs[0].status, "ok");
  const eventCount = h.events.length;
  h.conversations.emit("event", {
    type: "failed",
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A,
    generation: 7,
    code: "private duplicate detail",
  });
  await turn();
  assert.equal((await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0].status, "ok");
  assert.equal(h.events.length, eventCount);
});

test("a synchronous terminal event before send returns is reconciled by exact identity", async () => {
  const h = schedulerHarness();
  h.conversations.terminalBeforeReturn = "completed";
  const [automation] = await create(h.controller);

  assert.equal(await h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: automation.id,
  }), undefined);
  assert.equal((await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0].status, "ok");

  const rejected = schedulerHarness();
  rejected.conversations.terminalBeforeReturn = "failed";
  rejected.conversations.rejectAfterEarlyTerminal = true;
  const [rejectedAutomation] = await create(rejected.controller);
  assert.equal(await rejected.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: rejectedAutomation.id,
  }), undefined);
  const rejectedRun = (await rejected.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0];
  assert.equal(rejectedRun.status, "error");
  assert.equal(rejectedRun.detail, "OpenBot local Routine run failed.");
});

test("terminal events map only exact stable codes to bounded Grok error kinds", async () => {
  for (const [terminalType, code, errorKind] of [
    ["failed", "OPENBOT_CONVERSATION_OPERATION_FAILED", "opaque_wire_failure"],
    ["failed", "OPENBOT_CONVERSATION_STALE", "interrupted"],
    ["failed", "hostile provider text must not classify", "opaque_wire_failure"],
    ["cancelled", null, "cancelled"],
  ]) {
    const h = schedulerHarness();
    h.conversations.terminalBeforeReturn = terminalType;
    h.conversations.terminalCode = code;
    const [automation] = await create(h.controller);

    assert.equal(await h.controller.runAgentAutomationNow({
      id: BOT_A,
      automationId: automation.id,
    }), undefined);
    const run = (await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0];
    assert.equal(run.status, "error");
    assert.equal(run.detail, "OpenBot local Routine run failed.");
    assert.equal(run.errorKind, errorKind);
    assert.equal(JSON.stringify(run).includes("private provider detail"), false);
    assert.equal(JSON.stringify(run).includes("hostile provider text"), false);
  }
});

test("model failure becomes a sanitized terminal error and run-now still resolves undefined", async () => {
  const h = schedulerHarness();
  h.conversations.failSendFor.add(BOT_A);
  const [automation] = await create(h.controller);

  assert.equal(await h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: automation.id,
  }), undefined);

  const finished = (await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0];
  assert.equal(finished.status, "error");
  assert.equal(finished.errorKind, "opaque_wire_failure");
  assert.equal(finished.detail, "OpenBot local Routine run failed.");
  assert.equal(JSON.stringify(finished).includes("private provider detail"), false);
  assert.equal(h.events.at(-1).automations[0].runs[0].status, "error");
});

test("claimed send rejection maps exact conversation codes and wins over an early event", async () => {
  for (const [code, errorKind] of [
    ["OPENBOT_CONVERSATION_STALE", "interrupted"],
    ["OPENBOT_CONVERSATION_CANCELLED", "cancelled"],
    ["OPENBOT_CONVERSATION_OPERATION_FAILED", "opaque_wire_failure"],
    ["hostile unknown provider code", "opaque_wire_failure"],
  ]) {
    const h = schedulerHarness();
    h.conversations.failSendFor.add(BOT_A);
    h.conversations.sendFailureCodes.set(BOT_A, code);
    const [automation] = await create(h.controller);

    assert.equal(await h.controller.runAgentAutomationNow({
      id: BOT_A,
      automationId: automation.id,
    }), undefined);
    const run = (await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0];
    assert.equal(run.errorKind, errorKind);
    assert.equal(JSON.stringify(run).includes(code), false);
  }

  const early = schedulerHarness();
  early.conversations.terminalBeforeReturn = "failed";
  early.conversations.terminalCode = "OPENBOT_CONVERSATION_OPERATION_FAILED";
  early.conversations.rejectAfterEarlyTerminal = true;
  early.conversations.rejectAfterEarlyTerminalCode = "OPENBOT_CONVERSATION_STALE";
  const [automation] = await create(early.controller);

  assert.equal(await early.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: automation.id,
  }), undefined);
  const run = (await early.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0];
  assert.equal(run.errorKind, "interrupted");
});

test("store failures preserve their stable code at read claim and terminal finish boundaries", async () => {
  async function seeded(overrides) {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const [automation] = await baseStore.create({
      botId: BOT_A,
      automation: {
        name: BASE_SPEC.name,
        prompt: BASE_SPEC.prompt,
        trigger: BASE_SPEC.trigger,
        triggerDescription: "Weekdays at 9:00 AM (America/Indiana/Indianapolis)",
        isEnabled: true,
        nextRunAt: Date.parse("2026-08-17T13:00:00.000Z"),
      },
    });
    return {
      automation,
      h: schedulerHarness({
        stateIO,
        suppliedStore: delegatedStore(baseStore, overrides(baseStore)),
      }),
    };
  }

  const preRead = await seeded(() => ({
    list: async () => { throw privateStoreFailure(); },
  }));
  await assert.rejects(preRead.h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: preRead.automation.id,
  }), (error) => error?.code === "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED"
    && !error.message.includes("private durable source detail"));

  const preClaim = await seeded(() => ({
    claimRun: async () => { throw privateStoreFailure(); },
  }));
  await assert.rejects(preClaim.h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: preClaim.automation.id,
  }), (error) => error?.code === "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED"
    && !error.message.includes("private durable source detail"));

  const terminalFinish = await seeded(() => ({
    finishRun: async () => { throw privateStoreFailure(); },
  }));
  terminalFinish.h.conversations.terminalBeforeReturn = "completed";
  await assert.rejects(terminalFinish.h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: terminalFinish.automation.id,
  }), (error) => error?.code === "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED"
    && !error.message.includes("private durable source detail"));
});

test("generic durable conversation read failure does not create a replacement", async () => {
  const h = schedulerHarness();
  const [automation] = await create(h.controller);
  const privateRecord = (await h.store.list(BOT_A))[0];
  await h.store.bindConversation({
    botId: BOT_A,
    automationId: automation.id,
    expectedRevision: privateRecord.revision,
    conversationId: CONVERSATION_A,
  });
  h.conversations.records.set(CONVERSATION_A, {
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    status: "idle",
  });
  h.conversations.failRead = true;

  assert.equal(await h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: automation.id,
  }), undefined);

  assert.equal(h.conversations.creates.length, 0);
  assert.equal(h.conversations.sends.length, 0);
  assert.equal((await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0].status, "error");
});

test("successive runs reuse the exact durable conversation", async () => {
  const h = schedulerHarness();
  const [automation] = await create(h.controller);
  h.conversations.terminalBeforeReturn = "completed";

  await h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automation.id });
  await h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automation.id });

  assert.deepEqual(h.conversations.creates, [{ botId: BOT_A }]);
  assert.deepEqual(h.conversations.reads, [{
    botId: BOT_A,
    conversationId: CONVERSATION_A,
  }]);
  assert.deepEqual(h.conversations.sends.map((request) => request.conversationId), [
    CONVERSATION_A,
    CONVERSATION_A,
  ]);
});

test("manual duplicate and scheduled overlap coalesce into one run and advance the schedule", async () => {
  const h = schedulerHarness();
  const [automation] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, trigger: { type: "cron", schedule: "1 12 * * *" } },
  });
  await h.controller.start();

  const first = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automation.id });
  const duplicate = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automation.id });
  for (let attempt = 0; attempt < 10 && h.conversations.sends.length === 0; attempt += 1) await turn();
  assert.equal(h.conversations.sends.length, 1);

  await h.timers.advanceTo(Date.parse("2026-08-17T12:01:00.000Z"));
  const coalesced = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
  assert.equal(coalesced.runs.length, 1);
  assert.equal(coalesced.runs[0].trigger, "manual");
  assert.equal(coalesced.nextRunAt, Date.parse("2026-08-18T12:01:00.000Z"));
  assert.equal(h.conversations.sends.length, 1);

  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A,
    generation: 7,
  });
  assert.deepEqual(await Promise.all([first, duplicate]), [undefined, undefined]);
});

test("a synchronously reentrant same-Routine run shares one admitted terminal owner", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  let controller = null;
  let automationId = null;
  let reenterRun = false;
  let nestedRun = null;
  let claimCalls = 0;
  let acceptCalls = 0;
  let finishCalls = 0;
  const reentrantStore = delegatedStore(baseStore, {
    list(botId) {
      if (reenterRun) {
        reenterRun = false;
        nestedRun = controller.runAgentAutomationNow({ id: BOT_A, automationId });
      }
      return baseStore.list(botId);
    },
    claimRun(...args) {
      claimCalls += 1;
      return baseStore.claimRun(...args);
    },
    acceptRun(...args) {
      acceptCalls += 1;
      return baseStore.acceptRun(...args);
    },
    finishRun(...args) {
      finishCalls += 1;
      return baseStore.finishRun(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: reentrantStore });
  controller = h.controller;
  const [automation] = await create(controller);
  automationId = automation.id;
  const sendEntered = deferred();
  const releaseSend = deferred();
  h.conversations.beforeSend = async () => {
    sendEntered.resolve();
    await releaseSend.promise;
  };
  reenterRun = true;

  const outerRun = controller.runAgentAutomationNow({ id: BOT_A, automationId });
  const outerOutcome = outerRun.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const nestedOutcome = nestedRun.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const sharedTerminalPromise = nestedRun === outerRun;
  await sendEntered.promise;

  const remaining = await controller.deleteAgentAutomation({ id: BOT_A, automationId });
  let terminalSettledBeforeRelease = false;
  outerRun.then(() => { terminalSettledBeforeRelease = true; }, () => {
    terminalSettledBeforeRelease = true;
  });
  await turn();
  const eventCountAfterDelete = h.events.length;
  const settledBeforeRelease = terminalSettledBeforeRelease;
  releaseSend.resolve();
  const [outerResult, nestedResult] = await Promise.all([outerOutcome, nestedOutcome]);
  await turn();

  assert.equal(sharedTerminalPromise, true);
  assert.equal(settledBeforeRelease, true);
  assert.deepEqual(remaining, []);
  assert.deepEqual(outerResult, { status: "fulfilled", value: undefined });
  assert.deepEqual(nestedResult, { status: "fulfilled", value: undefined });
  assert.equal(claimCalls, 1);
  assert.equal(h.conversations.sends.length, 1);
  assert.equal(acceptCalls, 0);
  assert.equal(finishCalls, 0);
  assert.equal(h.events.length, eventCountAfterDelete);
  assert.deepEqual(await baseStore.list(BOT_A), []);
});

test("manual run works while disabled and keeps the durable next run null", async () => {
  const h = schedulerHarness();
  const [automation] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, isEnabled: false },
  });
  h.conversations.terminalBeforeReturn = "completed";

  assert.equal(await h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: automation.id,
  }), undefined);
  const finished = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
  assert.equal(finished.isEnabled, false);
  assert.equal(finished.nextRunAt, null);
  assert.equal(finished.runs[0].status, "ok");
});

test("a concurrent CRUD revision wins cleanly over a stale run claim", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const created = await baseStore.create({
    botId: BOT_A,
    automation: {
      name: BASE_SPEC.name,
      prompt: BASE_SPEC.prompt,
      trigger: BASE_SPEC.trigger,
      triggerDescription: "Weekdays at 9:00 AM (America/Indiana/Indianapolis)",
      isEnabled: true,
      nextRunAt: Date.parse("2026-08-17T13:00:00.000Z"),
    },
  });
  const claimEntered = deferred();
  const releaseClaim = deferred();
  const raceStore = {
    list: (...args) => baseStore.list(...args),
    listAll: (...args) => baseStore.listAll(...args),
    create: (...args) => baseStore.create(...args),
    replace: (...args) => baseStore.replace(...args),
    delete: (...args) => baseStore.delete(...args),
    bindConversation: (...args) => baseStore.bindConversation(...args),
    async claimRun(...args) {
      claimEntered.resolve();
      await releaseClaim.promise;
      return baseStore.claimRun(...args);
    },
    acceptRun: (...args) => baseStore.acceptRun(...args),
    finishRun: (...args) => baseStore.finishRun(...args),
    recoverRunning: (...args) => baseStore.recoverRunning(...args),
    deleteBots: (...args) => baseStore.deleteBots(...args),
  };
  const h = schedulerHarness({ stateIO, suppliedStore: raceStore });
  const running = h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: created[0].id,
  });
  await claimEntered.promise;

  const updated = await h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: created[0].id,
    spec: { ...BASE_SPEC, name: "CRUD wins" },
  });
  releaseClaim.resolve();
  assert.equal(await running, undefined);

  assert.equal(updated[0].name, "CRUD wins");
  assert.equal((await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs.length, 0);
  assert.equal(h.conversations.sends.length, 0);
});

test("a claimed run survives update-before-bind and sends its captured prompt", async () => {
  const h = schedulerHarness();
  const enteredCreate = deferred();
  const releaseCreate = deferred();
  h.conversations.beforeCreate = async () => {
    enteredCreate.resolve();
    await releaseCreate.promise;
  };
  h.conversations.terminalBeforeReturn = "completed";
  const [automation] = await create(h.controller);
  const running = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automation.id });
  await enteredCreate.promise;

  await h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
    spec: { ...BASE_SPEC, prompt: "A newer prompt for the next run." },
  });
  releaseCreate.resolve();
  assert.equal(await running, undefined);

  assert.deepEqual(h.conversations.sends, [{
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    text: BASE_SPEC.prompt,
  }]);
  const final = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
  assert.equal(final.prompt, "A newer prompt for the next run.");
  assert.equal(final.runs[0].status, "ok");
});

test("restart recovers an interrupted run and performs at most one missed-run catch-up", async () => {
  const stateIO = new MemoryStateIO();
  const seedTime = NOW - 2 * 24 * 60 * 60 * 1000;
  const seedStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(seedTime).toISOString(),
  });
  const created = await seedStore.create({
    botId: BOT_A,
    automation: {
      name: BASE_SPEC.name,
      prompt: BASE_SPEC.prompt,
      trigger: { type: "cron", schedule: "0 9 * * *" },
      triggerDescription: "Every day at 9:00 AM",
      isEnabled: true,
      nextRunAt: NOW - 24 * 60 * 60 * 1000,
    },
  });
  await seedStore.claimRun({
    botId: BOT_A,
    automationId: created[0].id,
    expectedRevision: created[0].revision,
    run: {
      id: "seed-running",
      trigger: "schedule",
      startedAt: seedTime,
      finishedAt: null,
      status: "running",
    },
    nextRunAt: NOW - 24 * 60 * 60 * 1000,
  });

  const h = schedulerHarness({ stateIO });
  await h.controller.start();
  for (let attempt = 0; attempt < 10 && h.conversations.sends.length === 0; attempt += 1) await turn();

  const recovered = (await h.controller.getAgentAutomations({ id: BOT_A }))[0];
  assert.equal(recovered.runs.length, 2);
  assert.equal(recovered.runs[0].trigger, "schedule");
  assert.equal(recovered.runs[0].status, "running");
  assert.equal(recovered.runs[1].status, "error");
  assert.equal(recovered.runs[1].errorKind, "interrupted");
  assert.ok(recovered.nextRunAt > NOW);
  assert.equal(h.conversations.sends.length, 1);
  const recoveredEventIndex = h.events.findIndex((event) => event.automations[0]?.runs.length === 1
    && event.automations[0].runs[0].errorKind === "interrupted");
  const catchUpEventIndex = h.events.findIndex((event) => event.automations[0]?.runs[0]?.status === "running");
  assert.ok(recoveredEventIndex >= 0);
  assert.ok(catchUpEventIndex > recoveredEventIndex);

  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A,
    generation: 7,
  });
  await turn();
  await h.timers.advanceTo(NOW);
  assert.equal(h.conversations.sends.length, 1);
});

test("deleteBots fences and drains a held create before durable bot deletion", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const createEntered = deferred();
  const releaseCreate = deferred();
  let holdCreate = true;
  let deleteBotsCalled = false;
  const createRequests = [];
  const drainingStore = delegatedStore(baseStore, {
    async create(request) {
      createRequests.push(request);
      if (request.botId === BOT_A && holdCreate) {
        holdCreate = false;
        createEntered.resolve();
        await releaseCreate.promise;
      }
      return baseStore.create(request);
    },
    async deleteBots(...args) {
      deleteBotsCalled = true;
      return baseStore.deleteBots(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: drainingStore });

  const creating = h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Held create" },
  });
  const createOutcome = creating.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  await createEntered.promise;
  const deleting = h.controller.deleteBots({ botIds: [BOT_A] });
  const fencedCreate = h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Must never reach storage" },
  });
  await assert.rejects(fencedCreate, { code: "OPENBOT_LOCAL_AUTOMATION_FAILED" });
  let unrelatedSettled = false;
  const unrelated = h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "Unrelated survives" },
  }).then((value) => {
    unrelatedSettled = true;
    return value;
  });
  await turn();
  await turn();
  const deleteCalledBeforeRelease = deleteBotsCalled;
  const unrelatedSettledBeforeRelease = unrelatedSettled;
  releaseCreate.resolve();

  const [createResult, deleteResult, unrelatedResult] = await Promise.all([
    createOutcome,
    deleting,
    unrelated,
  ]);
  assert.equal(deleteCalledBeforeRelease, false);
  assert.equal(unrelatedSettledBeforeRelease, true);
  assert.equal(createResult.status, "rejected");
  assert.equal(createResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_FAILED");
  assert.deepEqual(deleteResult, { deletedAutomationIds: ["held-create"] });
  assert.deepEqual(unrelatedResult.map((entry) => entry.name), ["Unrelated survives"]);
  assert.equal(createRequests.filter((request) => request.botId === BOT_A).length, 1);
  assert.deepEqual(h.events.filter((event) => event.agentId === BOT_A), []);
  assert.deepEqual(await baseStore.list(BOT_A), []);
  assert.deepEqual((await baseStore.list(BOT_B)).map((entry) => entry.name), ["Unrelated survives"]);
});

test("deleteBots fences and drains a held update before durable bot deletion", async () => {
  const stateIO = new MemoryStateIO();
  const baseStore = new LocalAutomationStore({
    stateIO,
    now: () => new Date(NOW).toISOString(),
  });
  const replaceEntered = deferred();
  const releaseReplace = deferred();
  let holdReplace = false;
  let replaceCalls = 0;
  let deleteBotsCalled = false;
  const drainingStore = delegatedStore(baseStore, {
    async replace(request) {
      replaceCalls += 1;
      if (holdReplace && request.botId === BOT_A) {
        replaceEntered.resolve();
        await releaseReplace.promise;
      }
      return baseStore.replace(request);
    },
    async deleteBots(...args) {
      deleteBotsCalled = true;
      return baseStore.deleteBots(...args);
    },
  });
  const h = schedulerHarness({ stateIO, suppliedStore: drainingStore });
  const [automation] = await create(h.controller);
  h.events.length = 0;
  holdReplace = true;

  const updating = h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
    spec: { ...BASE_SPEC, name: "Held update" },
  });
  const updateOutcome = updating.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  await replaceEntered.promise;
  const deleting = h.controller.deleteBots({ botIds: [BOT_A] });
  const fencedUpdate = h.controller.updateAgentAutomation({
    id: BOT_A,
    automationId: automation.id,
    spec: { ...BASE_SPEC, name: "Must never replace" },
  });
  await assert.rejects(fencedUpdate, { code: "OPENBOT_LOCAL_AUTOMATION_FAILED" });
  await turn();
  await turn();
  const deleteCalledBeforeRelease = deleteBotsCalled;
  releaseReplace.resolve();

  const [updateResult, deleteResult] = await Promise.all([updateOutcome, deleting]);
  assert.equal(deleteCalledBeforeRelease, false);
  assert.equal(updateResult.status, "rejected");
  assert.equal(updateResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_FAILED");
  assert.deepEqual(deleteResult, { deletedAutomationIds: [automation.id] });
  assert.equal(replaceCalls, 1);
  assert.deepEqual(h.events, []);
  assert.deepEqual(await baseStore.list(BOT_A), []);
});

test("bot deletion fences a held read and suppresses every late continuation", async () => {
  const h = schedulerHarness();
  const [automation] = await create(h.controller);
  const privateRecord = (await h.store.list(BOT_A))[0];
  await h.store.bindConversation({
    botId: BOT_A,
    automationId: automation.id,
    expectedRevision: privateRecord.revision,
    conversationId: CONVERSATION_A,
  });
  h.conversations.records.set(CONVERSATION_A, {
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    status: "idle",
  });
  const enteredRead = deferred();
  const releaseRead = deferred();
  h.conversations.beforeRead = async () => {
    enteredRead.resolve();
    await releaseRead.promise;
  };
  const running = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automation.id });
  await enteredRead.promise;
  h.events.length = 0;

  assert.deepEqual(await h.controller.deleteBots({ botIds: [BOT_A] }), {
    deletedAutomationIds: [automation.id],
  });
  assert.equal(await running, undefined);
  releaseRead.resolve();
  await turn();

  assert.equal(h.conversations.sends.length, 0);
  assert.deepEqual(h.events, []);
  assert.deepEqual(await h.store.list(BOT_A), []);
});

test("deleting one bot rearms the unrelated bot's live timer", async () => {
  const h = schedulerHarness();
  const [automationA] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "A earlier", trigger: { type: "cron", schedule: "30 12 * * *" } },
  });
  await h.controller.createAgentAutomation({
    id: BOT_B,
    spec: { ...BASE_SPEC, name: "B later", trigger: { type: "cron", schedule: "0 13 * * *" } },
  });
  await h.controller.start();
  assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T12:30:00.000Z"));

  assert.deepEqual(await h.controller.deleteBots({ botIds: [BOT_A] }), {
    deletedAutomationIds: [automationA.id],
  });
  for (let attempt = 0; attempt < 10
    && h.timers.active[0]?.dueAt !== Date.parse("2026-08-17T13:00:00.000Z"); attempt += 1) await turn();
  assert.equal(h.timers.active.length, 1);
  assert.equal(h.timers.active[0].dueAt, Date.parse("2026-08-17T13:00:00.000Z"));

  await h.timers.advanceTo(Date.parse("2026-08-17T13:00:00.000Z"));
  for (let attempt = 0; attempt < 10 && h.conversations.sends.length === 0; attempt += 1) await turn();
  assert.equal(h.conversations.sends.length, 1);
  assert.equal(h.conversations.sends[0].botId, BOT_B);
});

test("dispose cancels its timer and held run bookkeeping without late publication", async () => {
  const h = schedulerHarness();
  const [automation] = await create(h.controller);
  const privateRecord = (await h.store.list(BOT_A))[0];
  await h.store.bindConversation({
    botId: BOT_A,
    automationId: automation.id,
    expectedRevision: privateRecord.revision,
    conversationId: CONVERSATION_A,
  });
  h.conversations.records.set(CONVERSATION_A, {
    botId: BOT_A,
    conversationId: CONVERSATION_A,
    status: "idle",
  });
  const enteredRead = deferred();
  const releaseRead = deferred();
  h.conversations.beforeRead = async () => {
    enteredRead.resolve();
    await releaseRead.promise;
  };
  await h.controller.start();
  const running = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automation.id });
  await enteredRead.promise;
  h.events.length = 0;

  await h.controller.dispose();
  assert.equal(await running, undefined);
  assert.equal(h.timers.active.length, 0);
  releaseRead.resolve();
  await turn();

  assert.equal(h.conversations.sends.length, 0);
  assert.deepEqual(h.events, []);
});

test("dispose drains every admitted owner operation before it resolves", async (t) => {
  await t.test("held create mutation", async () => {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const createEntered = deferred();
    const releaseCreate = deferred();
    const order = [];
    let ownerTeardownCalls = 0;
    const drainingStore = delegatedStore(baseStore, {
      async create(request) {
        createEntered.resolve();
        await releaseCreate.promise;
        const result = await baseStore.create(request);
        order.push("commit");
        return result;
      },
    });
    drainingStore.dispose = () => { ownerTeardownCalls += 1; };
    const h = schedulerHarness({ stateIO, suppliedStore: drainingStore });
    h.conversations.dispose = () => { ownerTeardownCalls += 1; };

    const creating = h.controller.createAgentAutomation({
      id: BOT_A,
      spec: { ...BASE_SPEC, name: "Committed before disposed" },
    });
    const createOutcome = creating.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    await createEntered.promise;
    let disposeSettled = false;
    const disposing = h.controller.dispose().then(() => {
      disposeSettled = true;
      order.push("dispose");
    });
    await turn();
    await turn();
    const disposeSettledBeforeRelease = disposeSettled;
    releaseCreate.resolve();

    const [createResult] = await Promise.all([createOutcome, disposing]);
    assert.equal(disposeSettledBeforeRelease, false);
    assert.equal(createResult.status, "rejected");
    assert.equal(createResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_FAILED");
    assert.deepEqual(order, ["commit", "dispose"]);
    assert.equal(ownerTeardownCalls, 0);
    assert.deepEqual(h.events, []);
    assert.deepEqual((await baseStore.list(BOT_A)).map((entry) => entry.name), [
      "Committed before disposed",
    ]);
  });

  await t.test("held update mutation", async () => {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const replaceEntered = deferred();
    const releaseReplace = deferred();
    const order = [];
    let holdReplace = false;
    const drainingStore = delegatedStore(baseStore, {
      async replace(request) {
        if (holdReplace) {
          replaceEntered.resolve();
          await releaseReplace.promise;
        }
        const result = await baseStore.replace(request);
        if (holdReplace) order.push("commit");
        return result;
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: drainingStore });
    const [automation] = await create(h.controller);
    h.events.length = 0;
    holdReplace = true;

    const updating = h.controller.updateAgentAutomation({
      id: BOT_A,
      automationId: automation.id,
      spec: { ...BASE_SPEC, name: "Updated before disposed" },
    });
    const updateOutcome = updating.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    await replaceEntered.promise;
    let disposeSettled = false;
    const disposing = h.controller.dispose().then(() => {
      disposeSettled = true;
      order.push("dispose");
    });
    await turn();
    await turn();
    const disposeSettledBeforeRelease = disposeSettled;
    releaseReplace.resolve();

    const [updateResult] = await Promise.all([updateOutcome, disposing]);
    assert.equal(disposeSettledBeforeRelease, false);
    assert.equal(updateResult.status, "rejected");
    assert.equal(updateResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_FAILED");
    assert.deepEqual(order, ["commit", "dispose"]);
    assert.deepEqual(h.events, []);
    assert.deepEqual((await baseStore.list(BOT_A)).map((entry) => entry.name), [
      "Updated before disposed",
    ]);
  });

  await t.test("held bot deletion", async () => {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    const order = [];
    let holdDelete = false;
    let ownerTeardownCalls = 0;
    const drainingStore = delegatedStore(baseStore, {
      async deleteBots(request) {
        if (holdDelete) {
          deleteEntered.resolve();
          await releaseDelete.promise;
        }
        const result = await baseStore.deleteBots(request);
        if (holdDelete) order.push("commit");
        return result;
      },
    });
    drainingStore.dispose = () => { ownerTeardownCalls += 1; };
    const h = schedulerHarness({ stateIO, suppliedStore: drainingStore });
    h.conversations.dispose = () => { ownerTeardownCalls += 1; };
    const [automation] = await create(h.controller);
    h.events.length = 0;
    holdDelete = true;

    const deleting = h.controller.deleteBots({ botIds: [BOT_A] });
    await deleteEntered.promise;
    let disposeSettled = false;
    const disposing = h.controller.dispose().then(() => {
      disposeSettled = true;
      order.push("dispose");
    });
    await turn();
    await turn();
    const disposeSettledBeforeRelease = disposeSettled;
    releaseDelete.resolve();

    const [deleteResult] = await Promise.all([deleting, disposing]);
    assert.equal(disposeSettledBeforeRelease, false);
    assert.deepEqual(deleteResult, { deletedAutomationIds: [automation.id] });
    assert.deepEqual(order, ["commit", "dispose"]);
    assert.equal(ownerTeardownCalls, 0);
    assert.deepEqual(h.events, []);
    assert.deepEqual(await baseStore.list(BOT_A), []);
  });

  await t.test("start held in recovery", async () => {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const recoverEntered = deferred();
    const releaseRecover = deferred();
    const order = [];
    const drainingStore = delegatedStore(baseStore, {
      async recoverRunning(request) {
        recoverEntered.resolve();
        await releaseRecover.promise;
        const result = await baseStore.recoverRunning(request);
        order.push("recover");
        return result;
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: drainingStore });

    const starting = h.controller.start();
    const startOutcome = starting.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    await recoverEntered.promise;
    let disposeSettled = false;
    const disposing = h.controller.dispose().then(() => {
      disposeSettled = true;
      order.push("dispose");
    });
    await turn();
    await turn();
    const disposeSettledBeforeRelease = disposeSettled;
    releaseRecover.resolve();

    const [startResult] = await Promise.all([startOutcome, disposing]);
    assert.equal(disposeSettledBeforeRelease, false);
    assert.equal(startResult.status, "rejected");
    assert.equal(startResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_FAILED");
    assert.deepEqual(order, ["recover", "dispose"]);
    assert.equal(h.timers.active.length, 0);
  });

  await t.test("start held while arming its empty schedule", async () => {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const listEntered = deferred();
    const releaseList = deferred();
    const order = [];
    let holdList = true;
    const drainingStore = delegatedStore(baseStore, {
      async listAll(...args) {
        if (holdList) {
          holdList = false;
          listEntered.resolve();
          await releaseList.promise;
        }
        const result = await baseStore.listAll(...args);
        order.push("list");
        return result;
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: drainingStore });

    const starting = h.controller.start();
    const startOutcome = starting.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    await listEntered.promise;
    let disposeSettled = false;
    const disposing = h.controller.dispose().then(() => {
      disposeSettled = true;
      order.push("dispose");
    });
    await turn();
    await turn();
    const disposeSettledBeforeRelease = disposeSettled;
    releaseList.resolve();

    const [startResult] = await Promise.all([startOutcome, disposing]);
    assert.equal(disposeSettledBeforeRelease, false);
    assert.deepEqual(startResult, { status: "fulfilled", value: undefined });
    assert.deepEqual(order, ["list", "dispose"]);
    assert.equal(h.timers.active.length, 0);
  });
});

test("dispose is synchronously reentrancy-safe across external cleanup callbacks", async (t) => {
  await t.test("conversation listener removal reentry", async () => {
    const h = schedulerHarness();
    const originalRemoveListener = h.conversations.removeListener.bind(h.conversations);
    let removeCalls = 0;
    let nestedDispose = null;
    let fencedIngress = null;
    h.conversations.removeListener = (...args) => {
      removeCalls += 1;
      if (removeCalls === 1) {
        fencedIngress = h.controller.createAgentAutomation({
          id: BOT_A,
          spec: { ...BASE_SPEC, name: "Must stay fenced during listener cleanup" },
        });
        nestedDispose = h.controller.dispose();
      }
      return originalRemoveListener(...args);
    };

    const outerDispose = h.controller.dispose();
    const laterDispose = h.controller.dispose();
    await assert.rejects(fencedIngress, { code: "OPENBOT_LOCAL_AUTOMATION_FAILED" });
    await Promise.all([outerDispose, nestedDispose, laterDispose]);

    assert.strictEqual(nestedDispose, outerDispose);
    assert.strictEqual(laterDispose, outerDispose);
    assert.equal(removeCalls, 1);
    assert.equal(h.stateIO.reads, 0);
    assert.equal(h.stateIO.writes, 0);
  });

  await t.test("armed timer cleanup reentry", async () => {
    const stateIO = new MemoryStateIO();
    const clock = { value: NOW, now: () => clock.value };
    const timers = new ManualTimers(clock);
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(clock.value).toISOString(),
    });
    let storeCreateCalls = 0;
    const store = delegatedStore(baseStore, {
      create(...args) {
        storeCreateCalls += 1;
        return baseStore.create(...args);
      },
    });
    const conversations = new SchedulerConversations();
    const originalRemoveListener = conversations.removeListener.bind(conversations);
    let removeCalls = 0;
    conversations.removeListener = (...args) => {
      removeCalls += 1;
      return originalRemoveListener(...args);
    };
    let controller = null;
    let clearCalls = 0;
    let nestedDispose = null;
    let fencedIngress = null;
    const clearTimer = (token) => {
      clearCalls += 1;
      if (clearCalls === 1) {
        fencedIngress = controller.createAgentAutomation({
          id: BOT_A,
          spec: { ...BASE_SPEC, name: "Must stay fenced during timer cleanup" },
        });
        nestedDispose = controller.dispose();
      }
      timers.clear(token);
    };
    controller = new LocalAutomationController({
      store,
      conversations,
      now: clock.now,
      setTimer: timers.set,
      clearTimer,
    });
    await create(controller);
    await controller.start();
    assert.equal(timers.active.length, 1);
    assert.equal(storeCreateCalls, 1);

    const outerDispose = controller.dispose();
    const laterDispose = controller.dispose();
    await assert.rejects(fencedIngress, { code: "OPENBOT_LOCAL_AUTOMATION_FAILED" });
    await Promise.all([outerDispose, nestedDispose, laterDispose]);

    assert.strictEqual(nestedDispose, outerDispose);
    assert.strictEqual(laterDispose, outerDispose);
    assert.equal(clearCalls, 1);
    assert.equal(removeCalls, 1);
    assert.equal(storeCreateCalls, 1);
    assert.equal(timers.active.length, 0);
  });
});

test("start is synchronously admitted before injected recovery can reenter", async (t) => {
  await t.test("recovery-triggered dispose drains the admitted start", async () => {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const releaseRecovery = deferred();
    const order = [];
    let controller = null;
    let nestedDispose = null;
    let recoverCalls = 0;
    const reentrantStore = delegatedStore(baseStore, {
      recoverRunning(request) {
        recoverCalls += 1;
        nestedDispose = controller.dispose();
        return releaseRecovery.promise.then(async () => {
          const result = await baseStore.recoverRunning(request);
          order.push("recover");
          return result;
        });
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: reentrantStore });
    controller = h.controller;

    const starting = controller.start();
    const startOutcome = starting.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    let disposeSettled = false;
    const disposing = nestedDispose.then(() => {
      disposeSettled = true;
      order.push("dispose");
    });
    const laterDispose = controller.dispose();
    await turn();
    await turn();
    const disposeSettledBeforeRelease = disposeSettled;
    releaseRecovery.resolve();

    const [startResult] = await Promise.all([startOutcome, disposing, laterDispose]);
    assert.equal(disposeSettledBeforeRelease, false);
    assert.equal(recoverCalls, 1);
    assert.strictEqual(laterDispose, nestedDispose);
    assert.equal(startResult.status, "rejected");
    assert.equal(startResult.reason.code, "OPENBOT_LOCAL_AUTOMATION_FAILED");
    assert.deepEqual(order, ["recover", "dispose"]);
  });

  await t.test("recovery-triggered start shares one canonical operation", async () => {
    const stateIO = new MemoryStateIO();
    const baseStore = new LocalAutomationStore({
      stateIO,
      now: () => new Date(NOW).toISOString(),
    });
    const releaseRecovery = deferred();
    let controller = null;
    let nestedStart = null;
    let recoverCalls = 0;
    const reentrantStore = delegatedStore(baseStore, {
      recoverRunning(request) {
        recoverCalls += 1;
        if (recoverCalls === 1) nestedStart = controller.start();
        return releaseRecovery.promise.then(() => baseStore.recoverRunning(request));
      },
    });
    const h = schedulerHarness({ stateIO, suppliedStore: reentrantStore });
    controller = h.controller;

    const outerStart = controller.start();
    const laterStart = controller.start();
    releaseRecovery.resolve();
    await Promise.all([outerStart, nestedStart, laterStart]);

    assert.strictEqual(nestedStart, outerStart);
    assert.strictEqual(laterStart, outerStart);
    assert.equal(recoverCalls, 1);
    assert.equal(h.timers.active.length, 0);
  });
});

test("a failing bot does not block another bot's terminal run", async () => {
  const h = schedulerHarness();
  const [automationA] = await create(h.controller);
  const [automationB] = await h.controller.createAgentAutomation({ id: BOT_B, spec: BASE_SPEC });
  h.conversations.failSendFor.add(BOT_A);

  const runningA = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: automationA.id });
  const runningB = h.controller.runAgentAutomationNow({ id: BOT_B, automationId: automationB.id });
  for (let attempt = 0; attempt < 10 && h.conversations.sends.length < 2; attempt += 1) await turn();
  h.conversations.emit("event", {
    type: "completed",
    botId: BOT_B,
    conversationId: CONVERSATION_B,
    invocationId: INVOCATION_B,
    generation: 8,
  });
  await Promise.all([runningA, runningB]);

  assert.equal((await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0].status, "error");
  assert.equal((await h.controller.getAgentAutomations({ id: BOT_B }))[0].runs[0].status, "ok");
});

test("two same-bot Routines run independently with separate durable conversations", async () => {
  const h = schedulerHarness();
  const [first] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "First Routine" },
  });
  const rows = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Second Routine" },
  });
  const second = rows.find((row) => row.name === "Second Routine");

  const runningFirst = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: first.id });
  const runningSecond = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: second.id });
  for (let attempt = 0; attempt < 10 && h.conversations.sends.length < 2; attempt += 1) await turn();
  h.conversations.emit("event", {
    type: "completed", botId: BOT_A, conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A, generation: 7,
  });
  h.conversations.emit("event", {
    type: "completed", botId: BOT_A, conversationId: CONVERSATION_A_2,
    invocationId: INVOCATION_A_2, generation: 7,
  });
  await Promise.all([runningFirst, runningSecond]);

  const finished = await h.controller.getAgentAutomations({ id: BOT_A });
  assert.equal(finished.find((row) => row.id === first.id).runs[0].status, "ok");
  assert.equal(finished.find((row) => row.id === second.id).runs[0].status, "ok");
  assert.deepEqual(h.conversations.sends.map((request) => request.conversationId).sort(), [
    CONVERSATION_A,
    CONVERSATION_A_2,
  ]);
});

test("deleting one accepted Routine fences its late terminal without touching its sibling", async () => {
  const h = schedulerHarness();
  const [first] = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Delete me" },
  });
  const rows = await h.controller.createAgentAutomation({
    id: BOT_A,
    spec: { ...BASE_SPEC, name: "Keep me" },
  });
  const kept = rows.find((row) => row.name === "Keep me");
  const running = h.controller.runAgentAutomationNow({ id: BOT_A, automationId: first.id });
  for (let attempt = 0; attempt < 10 && h.conversations.sends.length === 0; attempt += 1) await turn();
  await turn();

  const remaining = await h.controller.deleteAgentAutomation({ id: BOT_A, automationId: first.id });
  assert.equal(await running, undefined);
  const eventCount = h.events.length;
  h.conversations.emit("event", {
    type: "completed", botId: BOT_A, conversationId: CONVERSATION_A,
    invocationId: INVOCATION_A, generation: 7,
  });
  await turn();

  assert.deepEqual(remaining.map((row) => row.id), [kept.id]);
  assert.equal(h.events.length, eventCount);
  assert.deepEqual((await h.controller.getAgentAutomations({ id: BOT_A })).map((row) => row.id), [kept.id]);
});

test("missing run-now is a native no-op and throwing change listeners are isolated", async () => {
  const h = schedulerHarness();
  h.controller.on("changed", () => { throw new Error("listener detail"); });
  h.controller.on("changed", async () => { throw new Error("observer rejection detail"); });

  assert.equal(await h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: "missing-routine",
  }), undefined);
  const [automation] = await create(h.controller);
  h.conversations.terminalBeforeReturn = "completed";
  assert.equal(await h.controller.runAgentAutomationNow({
    id: BOT_A,
    automationId: automation.id,
  }), undefined);
  assert.equal((await h.controller.getAgentAutomations({ id: BOT_A }))[0].runs[0].status, "ok");
});

test("controller validates exact own-data DTOs before touching dependencies", async () => {
  const h = schedulerHarness();
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get() { getterCalls += 1; return BOT_A; },
  });

  for (const { call, value } of [
    { call: (input) => h.controller.getAgentAutomations(input), value: accessor },
    {
      call: (input) => h.controller.getAgentAutomations(input),
      value: new Proxy({ id: BOT_A }, {}),
    },
    {
      call: (input) => h.controller.getAgentAutomations(input),
      value: { id: BOT_A, extra: "private sentinel" },
    },
    {
      call: (input) => h.controller.createAgentAutomation(input),
      value: { id: BOT_A, spec: { ...BASE_SPEC, extra: "private sentinel" } },
    },
  ]) {
    await assert.rejects(
      call(value),
      (error) => error?.code === "OPENBOT_LOCAL_AUTOMATION_INVALID"
        && !error.message.includes("private sentinel"),
    );
  }

  assert.equal(getterCalls, 0);
  assert.equal(h.stateIO.reads, 0);
  assert.equal(h.stateIO.writes, 0);
  assert.equal(h.conversations.reads.length, 0);
  assert.equal(h.conversations.sends.length, 0);
});
