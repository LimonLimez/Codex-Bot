"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const MODULE_PATH = "../src/desktop/openbot-native-coordinator.cjs";
const { ADDED_AVATAR_SHAPES } = require("../src/bots/avatar-catalog.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const BOT_C = "bot-33333333-3333-4333-8333-333333333333";
const AUTOMATION_A_ID = "morning-summary";
const AUTOMATION_B_ID = "daily-brief";
const AUTOMATION_CREATED_AT = Date.parse("2026-08-17T12:00:00.000Z");
const AUTOMATION_NEXT_RUN_AT = Date.parse("2026-08-18T13:00:00.000Z");

const AUTOMATION_SPEC = Object.freeze({
  name: "Morning summary",
  prompt: "Summarize the current project status.",
  trigger: Object.freeze({
    type: "cron",
    schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
  }),
  isEnabled: true,
});

function automation(botId = BOT_A, overrides = {}) {
  const id = botId === BOT_A ? AUTOMATION_A_ID : AUTOMATION_B_ID;
  const name = botId === BOT_A ? "Morning summary" : "Daily brief";
  const prompt = botId === BOT_A
    ? "Summarize the current project status."
    : "Summarize Bot B without waiting for Bot A.";
  return Object.freeze({
    id,
    name,
    prompt,
    trigger: Object.freeze({
      type: "cron",
      schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
    }),
    schedule: "TZ=America/Indiana/Indianapolis 0 9 * * 1-5",
    triggerDescription: "Weekdays at 9:00 AM (America/Indiana/Indianapolis)",
    isEnabled: true,
    provenance: "local",
    createdAt: AUTOMATION_CREATED_AT,
    lastRunAt: AUTOMATION_CREATED_AT,
    nextRunAt: AUTOMATION_NEXT_RUN_AT,
    runs: Object.freeze([Object.freeze({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      trigger: "manual",
      startedAt: AUTOMATION_CREATED_AT,
      finishedAt: AUTOMATION_CREATED_AT + 1_000,
      status: "error",
      detail: "OpenBot local Routine run failed.",
      errorKind: "opaque_wire_failure",
      event: "manual",
      coalescedRunIds: Object.freeze(["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]),
    })]),
    filePath: `openbot-local-routine:${botId}:${id}`,
    ...overrides,
  });
}

function workflow(botId = BOT_A, overrides = {}) {
  const routine = automation(botId);
  return Object.freeze({
    id: routine.id,
    name: routine.name,
    description: "",
    body: routine.prompt,
    trigger: Object.freeze({
      schedule: routine.schedule,
      isEnabled: routine.isEnabled,
    }),
    source: "automation",
    sourceRef: null,
    pluginId: null,
    publishedByCurrentUser: false,
    isEnabledForAgent: true,
    scheduleDescription: routine.triggerDescription,
    createdAt: routine.createdAt,
    lastRunAt: routine.lastRunAt,
    nextRunAt: routine.nextRunAt,
    helperScripts: Object.freeze([]),
    runs: routine.runs,
    filePath: routine.filePath,
    ...overrides,
  });
}

function workflowForAutomation(row) {
  const separator = row.filePath.indexOf(":", "openbot-local-routine:".length);
  const botId = row.filePath.slice("openbot-local-routine:".length, separator);
  return workflow(botId, {
    id: row.id,
    name: row.name,
    body: row.prompt,
    trigger: Object.freeze({ schedule: row.schedule, isEnabled: row.isEnabled }),
    scheduleDescription: row.triggerDescription,
    createdAt: row.createdAt,
    lastRunAt: row.lastRunAt,
    nextRunAt: row.nextRunAt,
    runs: row.runs,
    filePath: row.filePath,
  });
}

function bot(botId = BOT_A, overrides = {}) {
  return Object.freeze({
    botId,
    name: botId === BOT_A ? "Alpha" : "Beta",
    appearance: Object.freeze({
      shape: "blob",
      color: "blue",
      image: null,
      title: "",
      description: "A direct Codex bot.",
    }),
    notifications: true,
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:01:00.000Z",
    conversations: Object.freeze([]),
    runtime: Object.freeze({ state: "ready" }),
    computer: Object.freeze({ state: "ready" }),
    setupStage: "complete",
    ...overrides,
  });
}

class BotControllerHarness extends EventEmitter {
  constructor(seed = [bot()]) {
    super();
    this.bots = new Map(seed.map((entry) => [entry.botId, structuredClone(entry)]));
    this.calls = [];
  }

  async listBots() {
    this.calls.push(["listBots"]);
    return [...this.bots.values()].map((entry) => structuredClone(entry));
  }

  async createBot(input) {
    this.calls.push(["createBot", structuredClone(input)]);
    const shape = Object.hasOwn(input?.appearance ?? {}, "shape")
      ? input.appearance.shape
      : "blob";
    const color = Object.hasOwn(input?.appearance ?? {}, "color")
      ? input.appearance.color
      : "blue";
    const created = structuredClone(bot(BOT_B, {
      name: "New Bot",
      appearance: {
        shape,
        color,
        image: null,
        title: input?.appearance?.title ?? "",
        description: input?.appearance?.description ?? "",
      },
      setupStage: input?.setupStage ?? "profile-model",
    }));
    this.bots.set(created.botId, created);
    this.emit("bot-changed", { botId: created.botId, bot: structuredClone(created) });
    return structuredClone(created);
  }

  async renameBot(botId, name) {
    this.calls.push(["renameBot", botId, name]);
    const current = this.bots.get(botId);
    current.name = name;
    current.updatedAt = "2026-08-16T12:02:00.000Z";
    this.emit("bot-changed", { botId, bot: structuredClone(current) });
    return structuredClone(current);
  }

  async updateProfile(botId, profile) {
    this.calls.push(["updateProfile", botId, structuredClone(profile)]);
    const current = this.bots.get(botId);
    current.appearance = { ...current.appearance, ...(profile.appearance || {}) };
    if (profile.notifications !== undefined) current.notifications = profile.notifications;
    current.updatedAt = "2026-08-16T12:03:00.000Z";
    this.emit("bot-changed", { botId, bot: structuredClone(current) });
    return structuredClone(current);
  }

  remove(ids) {
    this.calls.push(["deleteBots", [...ids]]);
    for (const id of ids) this.bots.delete(id);
  }
}

class ConversationHarness extends EventEmitter {
  constructor() {
    super();
    this.records = new Map();
    this.calls = [];
    this.sequence = 0;
  }

  async list(botId) {
    this.calls.push(["list", botId]);
    return [...this.records.values()]
      .filter((entry) => entry.botId === botId)
      .map((entry) => this.#summary(entry));
  }

  async create({ botId }) {
    this.calls.push(["create", botId]);
    this.sequence += 1;
    const conversationId = `conversation-${String(this.sequence).padStart(8, "0")}-1111-4111-8111-111111111111`;
    const record = {
      botId,
      conversationId,
      createdAt: "2026-08-16T12:00:00.000Z",
      updatedAt: "2026-08-16T12:00:00.000Z",
      status: "idle",
      messages: [],
    };
    this.records.set(conversationId, record);
    return this.#summary(record);
  }

  async read({ botId, conversationId }) {
    this.calls.push(["read", botId, conversationId]);
    const record = this.records.get(conversationId);
    if (!record || record.botId !== botId) throw new Error("missing conversation");
    return structuredClone(record);
  }

  async send({ botId, conversationId, text, clientNonce, inputDigest }) {
    this.calls.push(["send", botId, conversationId, text, clientNonce, inputDigest]);
    const record = this.records.get(conversationId);
    record.messages.push({
      messageId: `message-user-${String(record.messages.length + 1).padStart(4, "0")}`,
      role: "user",
      text,
      createdAt: "2026-08-16T12:04:00.000Z",
      ...(clientNonce === undefined ? {} : { clientNonce, inputDigest }),
    });
    record.updatedAt = "2026-08-16T12:04:00.000Z";
    record.status = "streaming";
    return {
      botId,
      conversationId,
      invocationId: "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 7,
      status: "streaming",
    };
  }

  complete(conversationId, text) {
    const record = this.records.get(conversationId);
    record.messages.push({
      messageId: `message-assistant-${String(record.messages.length + 1).padStart(4, "0")}`,
      role: "assistant",
      text,
      createdAt: "2026-08-16T12:05:00.000Z",
    });
    record.updatedAt = "2026-08-16T12:05:00.000Z";
    record.status = "idle";
    this.emit("event", {
      type: "completed",
      botId: record.botId,
      conversationId,
      invocationId: "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      generation: 7,
    });
  }

  #summary(record) {
    return {
      botId: record.botId,
      conversationId: record.conversationId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      status: record.status,
      preview: record.messages.at(-1)?.text ?? "",
      messageCount: record.messages.length,
    };
  }
}

class PortHarness extends EventEmitter {
  constructor(trace = []) {
    super();
    this.frames = [];
    this.trace = trace;
    this.started = 0;
    this.closed = 0;
  }

  postMessage(frame) {
    const cloned = structuredClone(frame);
    this.frames.push(cloned);
    this.trace.push(["post", cloned]);
  }

  start() {
    this.started += 1;
  }

  close() {
    this.closed += 1;
  }

  receive(frame) {
    this.emit("message", { data: frame });
  }
}

async function waitFor(predicate, message = "condition was not reached") {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class AutomationControllerHarness extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.responses = new Map([
      ["getAgentAutomations", ({ id }) => [automation(id)]],
      ["listAllAutomations", () => [
        { agentId: BOT_B, automation: automation(BOT_B) },
        { agentId: BOT_A, automation: automation(BOT_A) },
      ]],
      ["createAgentAutomation", ({ id }) => [automation(id)]],
      ["updateAgentAutomation", ({ id }) => [automation(id, { name: "Updated summary" })]],
      ["setAgentAutomationEnabled", ({ id }) => [automation(id, { isEnabled: false, nextRunAt: null })]],
      ["deleteAgentAutomation", () => []],
      ["runAgentAutomationNow", () => undefined],
    ]);
    this.gates = new Map();
  }

  hold(method, id = "*") {
    const key = `${method}\0${id}`;
    assert.equal(this.gates.has(key), false);
    const entered = deferred();
    const release = deferred();
    this.gates.set(key, { entered, release });
    return Object.freeze({ entered: entered.promise, release: release.resolve });
  }

  setResponse(method, response) {
    this.responses.set(method, response);
  }

  setFailure(method, error) {
    this.responses.set(method, () => { throw error; });
  }

  async #perform(method, args) {
    this.calls.push([method, structuredClone(args)]);
    const key = `${method}\0${args?.id ?? "*"}`;
    const gate = this.gates.get(key) ?? this.gates.get(`${method}\0*`);
    if (gate) {
      this.gates.delete(key);
      this.gates.delete(`${method}\0*`);
      gate.entered.resolve();
      await gate.release.promise;
    }
    const response = this.responses.get(method);
    return typeof response === "function" ? response(args) : response;
  }

  getAgentAutomations(args) { return this.#perform("getAgentAutomations", args); }
  listAllAutomations(args) { return this.#perform("listAllAutomations", args); }
  createAgentAutomation(args) { return this.#perform("createAgentAutomation", args); }
  updateAgentAutomation(args) { return this.#perform("updateAgentAutomation", args); }
  setAgentAutomationEnabled(args) { return this.#perform("setAgentAutomationEnabled", args); }
  deleteAgentAutomation(args) { return this.#perform("deleteAgentAutomation", args); }
  runAgentAutomationNow(args) { return this.#perform("runAgentAutomationNow", args); }
}

async function request(port, requestId, method, args = {}) {
  port.receive({ kind: "request", requestId, method, args });
  await waitFor(() => port.frames.some((frame) => frame.kind === "reply" && frame.requestId === requestId));
  return port.frames.find((frame) => frame.kind === "reply" && frame.requestId === requestId);
}

function loadCoordinator() {
  try {
    return require(MODULE_PATH).OpenBotNativeCoordinator;
  } catch {
    return undefined;
  }
}

test("native model RPCs delegate through the exact Grok desktop contract", async (t) => {
  const OpenBotNativeCoordinator = loadCoordinator();
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const selection = Object.freeze({
    modelId: "gpt-5.6-sol",
    maxMode: true,
    parameters: Object.freeze([
      Object.freeze({ id: "effort", value: "medium" }),
      Object.freeze({ id: "speed", value: "standard" }),
    ]),
  });
  const available = Object.freeze({
    models: Object.freeze([Object.freeze({ name: "gpt-5.6-sol", defaultOn: true })]),
    modelNames: Object.freeze(["gpt-5.6-sol"]),
    useModelParameters: true,
  });
  const calls = [];
  const modelController = {
    async getAvailableModels() { calls.push(["getAvailableModels"]); return available; },
    async getAgentDefaultModel() { calls.push(["getAgentDefaultModel"]); return selection; },
    async setAgentDefaultModel(model) {
      if (model.modelId === "gpt-invalid-variant") {
        const error = new Error("private native validation detail");
        error.code = "CODEX_BOT_INVALID_NATIVE_MODEL_SELECTION";
        throw error;
      }
      if (model.modelId === "gpt-controller-offline") throw new Error("private persistence endpoint");
      calls.push(["setAgentDefaultModel", structuredClone(model)]);
      return model;
    },
    async getComputerUseModel() { calls.push(["getComputerUseModel"]); return selection; },
    async setComputerUseModel(model) { calls.push(["setComputerUseModel", structuredClone(model)]); return model; },
  };
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    modelController,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.kind === "lifecycle" && frame.phase === "ready"));

  assert.deepEqual((await request(port, "model-catalog", "getAvailableModels", {})).outcome, {
    status: "ok", value: available,
  });
  assert.deepEqual((await request(port, "model-default", "getAgentDefaultModel", {})).outcome, {
    status: "ok", value: selection,
  });
  assert.deepEqual((await request(port, "model-set", "setAgentDefaultModel", { model: selection })).outcome, {
    status: "ok", value: selection,
  });
  assert.deepEqual((await request(port, "computer-model", "getComputerUseModel", {})).outcome, {
    status: "ok", value: selection,
  });
  assert.deepEqual((await request(port, "computer-model-set", "setComputerUseModel", { model: selection })).outcome, {
    status: "ok", value: selection,
  });
  assert.deepEqual(calls, [
    ["getAvailableModels"],
    ["getAgentDefaultModel"],
    ["setAgentDefaultModel", selection],
    ["getComputerUseModel"],
    ["setComputerUseModel", selection],
  ]);

  const malformed = await request(port, "model-malformed", "setAgentDefaultModel", {
    model: selection,
    provider: "raw-provider-select-is-forbidden",
  });
  assert.equal(malformed.outcome.status, "failed");
  assert.equal(malformed.outcome.failure.code, "source/malformed-request");
  const callsBeforeNestedRejections = calls.length;
  for (const [requestId, model] of [
    ["model-false-max", { ...selection, maxMode: false }],
    ["model-fast-alias", {
      ...selection,
      parameters: [{ id: "effort", value: "medium" }, { id: "fast", value: "true" }],
    }],
    ["model-service-tier-alias", {
      ...selection,
      parameters: [{ id: "effort", value: "medium" }, { id: "serviceTier", value: "priority" }],
    }],
    ["model-nested-extra", {
      ...selection,
      parameters: [{ id: "effort", value: "medium", authToken: "private" }],
    }],
  ]) {
    const rejected = await request(port, requestId, "setAgentDefaultModel", { model });
    assert.equal(rejected.outcome.status, "failed");
    assert.equal(rejected.outcome.failure.code, "source/malformed-request");
    assert.doesNotMatch(JSON.stringify(rejected), /authToken|private/);
  }
  assert.equal(calls.length, callsBeforeNestedRejections, "malformed nested models must not reach persistence");

  const invalidVariant = await request(port, "model-invalid-variant", "setAgentDefaultModel", {
    model: {
      modelId: "gpt-invalid-variant",
      maxMode: true,
      parameters: [{ id: "effort", value: "medium" }],
    },
  });
  assert.equal(invalidVariant.outcome.status, "failed");
  assert.equal(invalidVariant.outcome.failure.code, "source/malformed-request");
  assert.doesNotMatch(JSON.stringify(invalidVariant), /private|validation/);

  const controllerFailure = await request(port, "model-controller-failure", "setAgentDefaultModel", {
    model: {
      modelId: "gpt-controller-offline",
      maxMode: true,
      parameters: [{ id: "effort", value: "medium" }],
    },
  });
  assert.equal(controllerFailure.outcome.status, "failed");
  assert.equal(controllerFailure.outcome.failure.code, "source/transport-failure");
  assert.doesNotMatch(JSON.stringify(controllerFailure), /private|persistence|endpoint/);
  assert.equal(calls.length, callsBeforeNestedRejections, "failed validation and persistence must not commit");
});

test("protocol v1 hello becomes ready and proactively publishes exact native agent rows", async (t) => {
  const OpenBotNativeCoordinator = loadCoordinator();
  assert.equal(typeof OpenBotNativeCoordinator, "function", "OpenBot native coordinator must exist");
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    canCreateAgent: async () => true,
    deleteBots: async (ids) => {
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([...bots.bots.keys()]),
        activeBotId: bots.bots.has(BOT_A) ? BOT_A : null,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);

  assert.equal(port.started, 1);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.kind === "event" && frame.family === "agents"));

  assert.deepEqual(port.frames[0], { kind: "lifecycle", phase: "ready", protocolVersion: 1 });
  assert.deepEqual(port.frames[1], {
    kind: "event",
    family: "agents",
    payload: {
      agents: [{
        id: BOT_A,
        name: "Alpha",
        description: "A direct Codex bot.",
        title: "",
        avatarShape: "blob",
        avatarColor: "blue",
        avatarVersion: "2026-08-16T12:01:00.000Z",
        createdAt: Date.parse("2026-08-16T12:00:00.000Z"),
        updatedAt: Date.parse("2026-08-16T12:01:00.000Z"),
        path: "",
        lastEntry: null,
        lastMessageId: null,
        newestEntryId: null,
        hasUnread: false,
        unreadCount: 0,
        lastViewedAt: null,
        lastActivityAt: Date.parse("2026-08-16T12:01:00.000Z"),
        awaitingUserResponse: null,
        notificationsEnabled: true,
        notifyOnUpdatesEnabled: true,
        isHiddenFromSidebar: false,
        isActive: true,
        origin: "user",
        purpose: null,
        isGroup: false,
        memberIds: [],
        isSharedRoom: false,
        sharedRoomId: null,
        conversationPartnerIds: [],
      }],
      activeAgentId: BOT_A,
    },
  });
  assert.equal(port.closed, 0);
});

test("native startup restores the durable selected agent instead of selecting the first roster row", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness([bot(BOT_A), bot(BOT_B), bot(BOT_C)]),
    conversationController: new ConversationHarness(),
    async readActiveAgentId() { return BOT_C; },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const roster = port.frames.find((frame) => frame.family === "agents").payload;
  assert.equal(roster.activeAgentId, BOT_C);
  assert.deepEqual(roster.agents.map((entry) => [entry.id, entry.isActive]), [
    [BOT_A, false],
    [BOT_B, false],
    [BOT_C, true],
  ]);
});

test("native cancel suppresses only its exact in-flight reply and keeps the coordinator session alive", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const originalList = bots.listBots.bind(bots);
  let releaseHeldList;
  const heldList = new Promise((resolve) => { releaseHeldList = resolve; });
  let listCalls = 0;
  bots.listBots = async () => {
    listCalls += 1;
    if (listCalls === 2) await heldList;
    return originalList();
  };
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  port.receive({ kind: "request", requestId: "r-held", method: "listAgents", args: {} });
  await waitFor(() => listCalls === 2);
  port.receive({ kind: "cancel", requestId: "r-held" });
  await waitFor(() => port.frames.some((frame) => frame.kind === "reply" && frame.requestId === "r-held"));
  assert.deepEqual(port.frames.find((frame) => frame.kind === "reply" && frame.requestId === "r-held"), {
    kind: "reply",
    requestId: "r-held",
    outcome: {
      status: "failed",
      failure: { code: "cancelled", message: "OpenBot native request was cancelled." },
    },
  });
  port.receive({ kind: "cancel", requestId: "r-unknown" });
  assert.equal(port.closed, 0);
  releaseHeldList();
  await waitFor(() => listCalls >= 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.frames.filter((frame) => frame.kind === "reply" && frame.requestId === "r-held").length, 1);
  assert.equal((await request(port, "r-after-cancel", "countAgents")).outcome.value, 1);
  port.receive({ kind: "cancel", requestId: "r-after-cancel" });
  assert.equal(port.closed, 0);
});

test("native roster requests preserve correlation and route create, rename, profile, unread, and delete", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    canCreateAgent: async () => true,
    deleteBots: async (ids) => {
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([...bots.bots.keys()]),
        activeBotId: bots.bots.has(BOT_A) ? BOT_A : null,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const listed = await request(port, "r-list", "listAgents");
  assert.equal(listed.outcome.status, "ok");
  assert.deepEqual(listed.outcome.value.map((entry) => entry.id), [BOT_A]);
  assert.deepEqual(await request(port, "r-count", "countAgents"), {
    kind: "reply",
    requestId: "r-count",
    outcome: { status: "ok", value: 1 },
  });

  const created = await request(port, "r-create", "createAgent", {
    name: "Builder",
    description: "Build with Direct Codex.",
    origin: "user",
    isKickstartRequested: true,
    templateId: "coding",
    avatarShape: "gem",
    avatarColor: "purple",
  });
  assert.equal(created.outcome.status, "ok");
  assert.equal(created.outcome.value.agent.id, BOT_B);
  assert.equal(created.outcome.value.agent.name, "Builder");
  assert.deepEqual(created.outcome.value.transcript, []);
  const afterCreate = await request(port, "r-list-active", "listAgents");
  assert.deepEqual(afterCreate.outcome.value.map((entry) => [entry.id, entry.isActive]), [
    [BOT_A, false],
    [BOT_B, true],
  ]);
  assert.deepEqual(await request(port, "r-kickstart", "kickstartAgent", { id: BOT_B }), {
    kind: "reply",
    requestId: "r-kickstart",
    outcome: { status: "ok", value: { isIntroductionInFlight: false } },
  });
  assert.deepEqual(bots.calls.filter(([name]) => name === "createBot" || name === "renameBot"), [
    ["createBot", {
      appearance: {
        shape: "gem",
        color: "purple",
        title: "",
        description: "Build with Direct Codex.",
      },
      notifications: true,
      setupStage: "complete",
    }],
    ["renameBot", BOT_B, "Builder"],
  ]);

  const updated = await request(port, "r-update", "updateAgent", {
    id: BOT_B,
    profile: {
      name: "Builder 2",
      description: "Updated description.",
      title: "Engineer",
      avatarShape: "spark",
      avatarColor: "blue",
    },
  });
  assert.equal(updated.outcome.status, "ok");
  assert.equal(updated.outcome.value.name, "Builder 2");
  assert.equal(updated.outcome.value.title, "Engineer");

  assert.deepEqual(await request(port, "r-unread", "setAgentUnread", {
    id: BOT_B,
    isUnread: true,
  }), {
    kind: "reply",
    requestId: "r-unread",
    outcome: { status: "ok", value: undefined },
  });
  const afterUnread = await request(port, "r-list-2", "listAgents");
  assert.equal(afterUnread.outcome.value.find((entry) => entry.id === BOT_B).hasUnread, true);

  assert.deepEqual(await request(port, "r-delete", "deleteAgents", { ids: [BOT_B] }), {
    kind: "reply",
    requestId: "r-delete",
    outcome: { status: "ok", value: { transcript: [] } },
  });
  assert.deepEqual((await request(port, "r-list-3", "listAgents")).outcome.value.map((entry) => entry.id), [BOT_A]);
  assert.equal((await request(port, "r-list-4", "listAgents")).outcome.value[0].isActive, true);
});

test("native create forwards explicit appearance only and leaves omitted defaults to BotStore", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    canCreateAgent: async () => true,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const reply = await request(port, "create-derived-avatar", "createAgent", {
    name: "Derived", description: "No explicit character.",
  });
  assert.equal(reply.outcome.status, "ok");
  assert.deepEqual(bots.calls.find(([name]) => name === "createBot")[1], {
    appearance: { title: "", description: "No explicit character." },
    notifications: true,
    setupStage: "complete",
  });
});

test("every added shape round-trips through native create roster avatar and Character edit", async (t) => {
  for (const shape of ADDED_AVATAR_SHAPES) {
    await t.test(shape, async () => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const bots = new BotControllerHarness();
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: bots,
        conversationController: new ConversationHarness(),
        canCreateAgent: async () => true,
      });
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      const created = await request(port, `create-${shape}`, "createAgent", {
        name: shape, description: "catalog", avatarShape: shape, avatarColor: "cyan",
      });
      assert.equal(created.outcome.value.agent.avatarShape, shape);
      assert.equal(created.outcome.value.agent.avatarColor, "cyan");
      const edited = await request(port, `edit-${shape}`, "updateAgent", {
        id: created.outcome.value.agent.id,
        profile: { avatarShape: shape, avatarColor: "violet" },
      });
      assert.equal(edited.outcome.value.avatarShape, shape);
      assert.equal(edited.outcome.value.avatarColor, "violet");
      assert.equal(edited.outcome.value.avatarVersion, "2026-08-16T12:03:00.000Z");
      coordinator.dispose();
    });
  }
});

test("native create requires a current provider onboarding receipt before mutating the bot store", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    canCreateAgent: async () => false,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const reply = await request(port, "create-gated", "createAgent", {
    name: "Blocked", description: "Provider is unavailable.",
  });
  assert.equal(reply.outcome.status, "failed");
  assert.deepEqual(bots.calls.filter(([name]) => name === "createBot"), []);
});

test("native coordinator construction without a provider gate fails closed", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const reply = await request(port, "create-no-gate", "createAgent", {
    name: "Blocked", description: "No provider gate was supplied.",
  });
  assert.equal(reply.outcome.status, "failed");
  assert.deepEqual(bots.calls.filter(([name]) => name === "createBot"), []);
});

test("native deletion adopts the authoritative active bot for background, active, and last-bot removal", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const scenarios = [
    {
      name: "background",
      seed: [bot(BOT_A), bot(BOT_B)],
      select: BOT_B,
      deleted: BOT_A,
      activeBotId: BOT_B,
      expected: [[BOT_B, true]],
    },
    {
      name: "active",
      seed: [bot(BOT_A), bot(BOT_B), bot(BOT_C)],
      select: BOT_B,
      deleted: BOT_B,
      activeBotId: BOT_C,
      expected: [[BOT_A, false], [BOT_C, true]],
    },
    {
      name: "last",
      seed: [bot(BOT_A)],
      select: BOT_A,
      deleted: BOT_A,
      activeBotId: null,
      expected: [],
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const bots = new BotControllerHarness(scenario.seed);
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: bots,
        conversationController: new ConversationHarness(),
        async onSelectAgent() {},
        async deleteBots(ids) {
          bots.remove(ids);
          return Object.freeze({
            deletedBotIds: Object.freeze([...ids]),
            survivingBotIds: Object.freeze([...bots.bots.keys()]),
            activeBotId: scenario.activeBotId,
          });
        },
      });
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      await request(port, `select-${scenario.name}`, "openAgentTail", { id: scenario.select, limit: 1 });
      assert.equal((await request(port, `delete-${scenario.name}`, "deleteAgents", {
        ids: [scenario.deleted],
      })).outcome.status, "ok");
      const listed = await request(port, `list-${scenario.name}`, "listAgents");
      assert.deepEqual(listed.outcome.value.map((entry) => [entry.id, entry.isActive]), scenario.expected);
      coordinator.dispose();
    });
  }
});

test("native deletion rejects a non-authoritative cleanup outcome before mutating its selection", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    async deleteBots() {
      return Object.freeze({
        deletedBotIds: Object.freeze([BOT_A]),
        survivingBotIds: Object.freeze([BOT_A, BOT_B]),
        activeBotId: BOT_A,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const reply = await request(port, "delete-invalid-outcome", "deleteAgents", { ids: [BOT_A] });
  assert.deepEqual(reply.outcome, {
    status: "failed",
    failure: {
      code: "source/transport-failure",
      message: "OpenBot native deleteAgents failed.",
    },
  });
  const listed = await request(port, "list-after-invalid-outcome", "listAgents");
  assert.deepEqual(listed.outcome.value.map((entry) => [entry.id, entry.isActive]), [
    [BOT_A, true],
    [BOT_B, false],
  ]);
});

test("a rejected deletion restores the durable active bot after a transient claimed-roster fallback", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    async readActiveAgentId() { return BOT_A; },
    async deleteBots() {
      deleteEntered.resolve();
      await releaseDelete.promise;
      throw new Error("durable deletion rejected");
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const deleting = request(port, "delete-rejected-active", "deleteAgents", { ids: [BOT_A] });
  await deleteEntered.promise;
  const duringDeletion = await request(port, "list-claimed-active", "listAgents");
  assert.deepEqual(duringDeletion.outcome.value.map((entry) => [entry.id, entry.isActive]), [
    [BOT_B, true],
  ]);
  releaseDelete.resolve();
  assert.equal((await deleting).outcome.status, "failed");

  const afterRollback = await request(port, "list-restored-active", "listAgents");
  assert.deepEqual(afterRollback.outcome.value.map((entry) => [entry.id, entry.isActive]), [
    [BOT_A, true],
    [BOT_B, false],
  ]);
});

test("a newer durable cross-bot selection wins when an older deletion is rejected", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  let durableActiveBotId = BOT_A;
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    async readActiveAgentId() { return durableActiveBotId; },
    async onSelectAgent(botId) { durableActiveBotId = botId; },
    async deleteBots() {
      deleteEntered.resolve();
      await releaseDelete.promise;
      throw new Error("durable deletion rejected");
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const deleting = request(port, "delete-rejected-before-new-selection", "deleteAgents", {
    ids: [BOT_A],
  });
  await deleteEntered.promise;
  assert.equal((await request(port, "open-newer-selection-before-rejection", "openAgentTail", {
    id: BOT_B,
    limit: 1,
  })).outcome.status, "ok");
  assert.equal(durableActiveBotId, BOT_B);
  releaseDelete.resolve();
  assert.equal((await deleting).outcome.status, "failed");

  const listed = await request(port, "list-newer-selection-after-rejection", "listAgents");
  assert.deepEqual(listed.outcome.value.map((entry) => [entry.id, entry.isActive]), [
    [BOT_A, false],
    [BOT_B, true],
  ]);
});

test("native deletion purges deleted-bot prompt acceptance and ignores its late operation events", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const conversations = new ConversationHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    async deleteBots(ids) {
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([BOT_B]),
        activeBotId: BOT_B,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  assert.equal((await request(port, "send-before-delete", "sendPrompt", {
    agentId: BOT_A,
    prompt: "Delete this bot after the durable echo.",
    clientNonce: "nonce-delete-purge",
    directAddressedAcceptance: true,
  })).outcome.status, "ok");
  assert.equal((await request(port, "acceptance-before-delete", "promptAcceptanceStatus", {
    accountSlot: "host",
    clientNonce: "nonce-delete-purge",
  })).outcome.value.outcome, "found");
  assert.equal((await request(port, "delete-after-send", "deleteAgents", {
    ids: [BOT_A],
  })).outcome.status, "ok");
  assert.deepEqual((await request(port, "acceptance-after-delete", "promptAcceptanceStatus", {
    accountSlot: "host",
    clientNonce: "nonce-delete-purge",
  })).outcome.value, { outcome: "not-found" });

  const transcriptFrames = () => port.frames.filter((frame) => frame.kind === "event"
    && frame.family === "transcript").length;
  const beforeLateEvent = transcriptFrames();
  const [conversationId] = conversations.records.keys();
  conversations.emit("event", {
    type: "text-delta",
    botId: BOT_A,
    conversationId,
    invocationId: "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 7,
    text: "late deleted output",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transcriptFrames(), beforeLateEvent);
});

test("native deletion fences a terminal read already in flight before it can publish a deleted transcript", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const conversations = new ConversationHarness();
  const finishReadEntered = deferred();
  const releaseFinishRead = deferred();
  const originalRead = conversations.read.bind(conversations);
  let holdFinishRead = false;
  conversations.read = async (requestValue) => {
    if (holdFinishRead && requestValue.botId === BOT_A) {
      holdFinishRead = false;
      finishReadEntered.resolve();
      await releaseFinishRead.promise;
    }
    return originalRead(requestValue);
  };
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    async deleteBots(ids) {
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([BOT_B]),
        activeBotId: BOT_B,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  assert.equal((await request(port, "finish-send", "sendPrompt", {
    agentId: BOT_A,
    prompt: "Finish after deletion.",
    clientNonce: "nonce-held-finish",
    directAddressedAcceptance: true,
  })).outcome.status, "ok");
  const [conversationId] = conversations.records.keys();
  holdFinishRead = true;
  conversations.complete(conversationId, "must never publish after deletion");
  await finishReadEntered.promise;
  assert.equal((await request(port, "finish-delete", "deleteAgents", { ids: [BOT_A] })).outcome.status, "ok");
  const transcriptsAfterDelete = port.frames.filter((frame) => frame.family === "transcript").length;
  releaseFinishRead.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.frames.filter((frame) => frame.family === "transcript").length, transcriptsAfterDelete);
});

test("native deletion invalidates a held stale roster publication without blocking a current roster", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const staleListEntered = deferred();
  const releaseStaleList = deferred();
  const originalList = bots.listBots.bind(bots);
  let listCalls = 0;
  bots.listBots = async () => {
    listCalls += 1;
    if (listCalls !== 1) return originalList();
    const stale = await originalList();
    staleListEntered.resolve();
    await releaseStaleList.promise;
    return stale;
  };
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    async deleteBots(ids) {
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([BOT_B]),
        activeBotId: BOT_B,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await staleListEntered.promise;
  assert.equal((await request(port, "stale-list-delete", "deleteAgents", { ids: [BOT_A] })).outcome.status, "ok");
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"
    && frame.payload.agents.length === 1 && frame.payload.agents[0].id === BOT_B));
  const afterCurrentRoster = port.frames.length;
  releaseStaleList.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const lateRosters = port.frames.slice(afterCurrentRoster).filter((frame) => frame.family === "agents");
  assert.equal(lateRosters.some((frame) => frame.payload.agents.some((agent) => agent.id === BOT_A)), false);
});

test("native deletion synchronously fences a held send while preserving cross-bot work", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const conversations = new ConversationHarness();
  const sendEntered = deferred();
  const releaseSend = deferred();
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const originalSend = conversations.send.bind(conversations);
  conversations.send = async (requestValue) => {
    if (requestValue.botId === BOT_A) {
      sendEntered.resolve();
      await releaseSend.promise;
    }
    return originalSend(requestValue);
  };
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    async deleteBots(ids) {
      deleteEntered.resolve();
      await releaseDelete.promise;
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([BOT_B]),
        activeBotId: BOT_B,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const heldSend = request(port, "held-send-a", "sendPrompt", {
    agentId: BOT_A,
    prompt: "Do not survive deletion.",
    clientNonce: "nonce-held-send-a",
    directAddressedAcceptance: true,
  });
  await sendEntered.promise;
  const heldDelete = request(port, "held-delete-a", "deleteAgents", { ids: [BOT_A] });
  await deleteEntered.promise;
  assert.equal((await request(port, "cross-bot-send", "sendPrompt", {
    agentId: BOT_B,
    prompt: "Cross-bot work stays live.",
    clientNonce: "nonce-cross-bot-send",
    directAddressedAcceptance: true,
  })).outcome.status, "ok");
  releaseSend.resolve();
  const heldSendReply = await heldSend;
  releaseDelete.resolve();
  assert.equal((await heldDelete).outcome.status, "ok");
  assert.equal(heldSendReply.outcome.status, "failed");
  assert.deepEqual((await request(port, "held-send-status", "promptAcceptanceStatus", {
    accountSlot: "host",
    clientNonce: "nonce-held-send-a",
  })).outcome.value, { outcome: "not-found" });
});

test("a rejected deletion drops only invalidated target streams from subsequent transcript tails", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const conversations = new ConversationHarness();
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    async deleteBots() {
      deleteEntered.resolve();
      await releaseDelete.promise;
      throw new Error("durable deletion rejected");
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  assert.equal((await request(port, "stream-a-send", "sendPrompt", {
    agentId: BOT_A,
    prompt: "Keep the durable A prompt only.",
    clientNonce: "nonce-rejected-delete-a",
    directAddressedAcceptance: true,
  })).outcome.status, "ok");
  assert.equal((await request(port, "stream-b-send", "sendPrompt", {
    agentId: BOT_B,
    prompt: "Keep the live B stream.",
    clientNonce: "nonce-rejected-delete-b",
    directAddressedAcceptance: true,
  })).outcome.status, "ok");
  const recordA = [...conversations.records.values()].find((record) => record.botId === BOT_A);
  const recordB = [...conversations.records.values()].find((record) => record.botId === BOT_B);
  conversations.emit("event", {
    type: "text-delta",
    botId: BOT_A,
    conversationId: recordA.conversationId,
    invocationId: "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 7,
    text: "stale A stream",
  });
  conversations.emit("event", {
    type: "text-delta",
    botId: BOT_B,
    conversationId: recordB.conversationId,
    invocationId: "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 7,
    text: "current B stream",
  });
  await waitFor(() => port.frames.some((frame) => frame.family === "transcript"
    && frame.payload.entry?.content === "current B stream"));

  const deleting = request(port, "stream-delete-rejected", "deleteAgents", { ids: [BOT_A] });
  await deleteEntered.promise;
  releaseDelete.resolve();
  assert.equal((await deleting).outcome.status, "failed");

  const tailA = await request(port, "stream-tail-a-after-rollback", "getAgentTranscriptTail", {
    id: BOT_A,
    limit: 500,
  });
  assert.deepEqual(tailA.outcome.value.entries.map((entry) => [
    entry.role,
    entry.content,
    entry.isStreaming,
  ]), [["user", "Keep the durable A prompt only.", false]]);
  const tailB = await request(port, "stream-tail-b-after-rollback", "getAgentTranscriptTail", {
    id: BOT_B,
    limit: 500,
  });
  assert.deepEqual(tailB.outcome.value.entries.map((entry) => [
    entry.role,
    entry.content,
    entry.isStreaming,
  ]), [
    ["user", "Keep the live B stream.", false],
    ["assistant", "current B stream", true],
  ]);
});

test("a newer cross-bot native selection wins over a stale deletion successor", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B), bot(BOT_C)]);
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const selected = [];
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    async readActiveAgentId() { return BOT_C; },
    async onSelectAgent(id) { selected.push(id); },
    async deleteBots(ids) {
      deleteEntered.resolve();
      await releaseDelete.promise;
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([BOT_B, BOT_C]),
        activeBotId: BOT_C,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const deleting = request(port, "newer-selection-delete", "deleteAgents", { ids: [BOT_A] });
  await deleteEntered.promise;
  assert.equal((await request(port, "newer-selection-open", "openAgentTail", {
    id: BOT_B,
    limit: 1,
  })).outcome.status, "ok");
  assert.deepEqual(selected, [BOT_B]);
  releaseDelete.resolve();
  assert.equal((await deleting).outcome.status, "ok");
  const listed = await request(port, "newer-selection-list", "listAgents");
  assert.deepEqual(listed.outcome.value.map((entry) => [entry.id, entry.isActive]), [
    [BOT_B, true],
    [BOT_C, false],
  ]);
});

test("a cross-bot send during deletion cannot override the durable active successor", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B), bot(BOT_C)]);
  const deleteEntered = deferred();
  const releaseDelete = deferred();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    async readActiveAgentId() { return BOT_C; },
    async deleteBots(ids) {
      deleteEntered.resolve();
      await releaseDelete.promise;
      bots.remove(ids);
      return Object.freeze({
        deletedBotIds: Object.freeze([...ids]),
        survivingBotIds: Object.freeze([BOT_B, BOT_C]),
        activeBotId: BOT_C,
      });
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const deleting = request(port, "send-race-delete", "deleteAgents", { ids: [BOT_A] });
  await deleteEntered.promise;
  assert.equal((await request(port, "send-race-prompt", "sendPrompt", {
    agentId: BOT_B,
    prompt: "Background work must not select this bot.",
    clientNonce: "nonce-send-during-delete",
    directAddressedAcceptance: true,
  })).outcome.status, "ok");
  releaseDelete.resolve();
  assert.equal((await deleting).outcome.status, "ok");

  const listed = await request(port, "send-race-list", "listAgents");
  assert.deepEqual(listed.outcome.value.map((entry) => [entry.id, entry.isActive]), [
    [BOT_B, false],
    [BOT_C, true],
  ]);
});

test("one durable conversation per bot backs native tails, nonce echo, streaming deltas, and terminal snapshots", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const trace = [];
  const selections = [];
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const conversations = new ConversationHarness();
  const originalRead = conversations.read.bind(conversations);
  conversations.read = async (...args) => {
    trace.push(["authoritative-read", structuredClone(args[0])]);
    return originalRead(...args);
  };
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    now: () => Date.parse("2026-08-16T12:04:30.000Z"),
    async onSelectAgent(id) {
      selections.push(id);
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness(trace);
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const opened = await request(port, "r-open", "openAgentTail", { id: BOT_A, limit: 500 });
  assert.deepEqual(opened.outcome, {
    status: "ok",
    value: { entries: [], nextBeforeSeq: null },
  });
  assert.deepEqual(selections, [BOT_A]);
  const conversationId = conversations.calls.find(([name]) => name === "create");
  assert.deepEqual(conversationId, ["create", BOT_A]);

  const sent = await request(port, "r-send", "sendPrompt", {
    agentId: BOT_A,
    prompt: "Say hello.",
    clientNonce: "nonce-123",
    directAddressedAcceptance: true,
    richText: '{"type":"doc","content":[{"type":"paragraph"}]}',
    composedAtMs: Date.parse("2026-08-16T12:03:59.000Z"),
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    enterEpochMs: Date.parse("2026-08-16T12:04:00.000Z"),
  });
  assert.deepEqual(sent.outcome, { status: "ok", value: { accepted: true } });
  await waitFor(() => port.frames.some((frame) => frame.family === "transcript"
    && frame.payload.type === "appended" && frame.payload.entry.role === "user"));
  const userEvent = port.frames.find((frame) => frame.family === "transcript"
    && frame.payload.type === "appended" && frame.payload.entry.role === "user");
  assert.deepEqual(userEvent.payload, {
    type: "appended",
    agentId: BOT_A,
    entry: {
      kind: "message",
      id: "message-user-0001",
      role: "user",
      content: "Say hello.",
      isStreaming: false,
      clientNonce: "nonce-123",
      timestampMs: Date.parse("2026-08-16T12:04:00.000Z"),
    },
  });
  const userPostIndex = trace.findIndex(([kind, frame]) => kind === "post" && frame === userEvent);
  const authoritativeReadIndex = trace.findIndex(([kind]) => kind === "authoritative-read");
  assert.ok(authoritativeReadIndex >= 0 && authoritativeReadIndex < userPostIndex,
    "the authoritative transcript must be read before any non-ordered echo event");

  const acceptance = await request(port, "r-acceptance", "promptAcceptanceStatus", {
    accountSlot: "host",
    clientNonce: "nonce-123",
  });
  assert.match(acceptance.outcome.value.record.inputDigest, /^[0-9a-f]{64}$/);
  const acceptanceWithoutDigest = structuredClone(acceptance.outcome);
  delete acceptanceWithoutDigest.value.record.inputDigest;
  assert.deepEqual(acceptanceWithoutDigest, {
    status: "ok",
    value: {
      outcome: "found",
      record: {
        accountSlot: "host",
        clientNonce: "nonce-123",
        status: "accepted",
        acceptedAtMs: Date.parse("2026-08-16T12:04:00.000Z"),
        agentId: BOT_A,
        echoEntryId: "message-user-0001",
        rejectionCode: null,
      },
    },
  });

  const duplicate = await request(port, "r-send-duplicate", "sendPrompt", {
    agentId: BOT_A,
    prompt: "Say hello.",
    clientNonce: "nonce-123",
    directAddressedAcceptance: true,
    richText: '{"type":"doc","content":[{"type":"paragraph"}]}',
    composedAtMs: Date.parse("2026-08-16T12:03:59.000Z"),
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    enterEpochMs: Date.parse("2026-08-16T12:04:00.000Z"),
  });
  assert.deepEqual(duplicate.outcome, { status: "ok", value: { accepted: true } });
  assert.equal(conversations.calls.filter(([name]) => name === "send").length, 1,
    "a matching native nonce replay must not submit a duplicate prompt");

  const mismatched = await request(port, "r-send-mismatch", "sendPrompt", {
    agentId: BOT_A,
    prompt: "Different prompt.",
    clientNonce: "nonce-123",
    directAddressedAcceptance: true,
    richText: '{"type":"doc","content":[{"type":"paragraph"}]}',
    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    enterEpochMs: Date.parse("2026-08-16T12:04:00.000Z"),
  });
  assert.equal(mismatched.outcome.status, "failed");
  assert.equal(mismatched.outcome.failure.code, "send/nonce-digest-mismatch");

  const accepted = conversations.records.values().next().value;
  conversations.emit("event", {
    type: "text-delta",
    botId: BOT_A,
    conversationId: accepted.conversationId,
    invocationId: "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 7,
    text: "Hello ",
  });
  conversations.emit("event", {
    type: "text-delta",
    botId: BOT_A,
    conversationId: accepted.conversationId,
    invocationId: "invocation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 7,
    text: "there.",
  });
  await waitFor(() => port.frames.some((frame) => frame.family === "transcript"
    && frame.payload.type === "updated" && frame.payload.entry.content === "Hello there."));
  const assistantEvents = port.frames.filter((frame) => frame.family === "transcript"
    && ["appended", "updated"].includes(frame.payload.type)
    && frame.payload.entry.role === "assistant");
  assert.deepEqual(assistantEvents.map((frame) => [
    frame.payload.type,
    frame.payload.entry.content,
    frame.payload.entry.isStreaming,
  ]), [
    ["appended", "Hello ", true],
    ["updated", "Hello there.", true],
  ]);

  const streamingTail = await request(port, "r-streaming-tail", "getAgentTranscriptTail", {
    id: BOT_A,
    limit: 500,
  });
  assert.deepEqual(streamingTail.outcome.value.entries.map((entry) => [
    entry.role,
    entry.content,
    entry.isStreaming,
  ]), [
    ["user", "Say hello.", false],
    ["assistant", "Hello there.", true],
  ], "the authoritative tail refetched after an unordered native delta must include the live assistant");

  conversations.complete(accepted.conversationId, "Hello there.");
  await waitFor(() => port.frames.some((frame) => frame.family === "transcript"
    && frame.payload.type === "snapshot" && frame.payload.entries.length === 2));
  const terminal = port.frames.findLast((frame) => frame.family === "transcript"
    && frame.payload.type === "snapshot");
  assert.equal(terminal.payload.activeAgentId, BOT_A);
  assert.deepEqual(terminal.payload.entries.map((entry) => [entry.role, entry.content, entry.isStreaming]), [
    ["user", "Say hello.", false],
    ["assistant", "Hello there.", false],
  ]);
  assert.equal(terminal.payload.entries[0].clientNonce, "nonce-123");

  await request(port, "r-tail", "getAgentTranscriptTail", { id: BOT_A, limit: 1 });
  await request(port, "r-background-tail", "getAgentTranscriptTail", { id: BOT_B, limit: 200 });
  assert.deepEqual(selections, [BOT_A],
    "background and resync transcript reads must not move the selected native bot");
  assert.equal(conversations.calls.filter(([name, botId]) => name === "create" && botId === BOT_A).length, 1,
    "open, send, and tail must reuse one durable conversation");
});

test("native prompt acceptance and nonce mismatch remain durable across coordinator restart", async () => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const first = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    now: () => Date.parse("2026-08-16T12:04:30.000Z"),
  });
  const firstPort = new PortHarness();
  first.bindPort(firstPort);
  firstPort.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => firstPort.frames.some((frame) => frame.family === "agents"));
  await request(firstPort, "open", "openAgentTail", { id: BOT_A, limit: 500 });
  const nativeInput = {
    agentId: BOT_A,
    prompt: "Persist this nonce.",
    clientNonce: "restart-nonce-123",
    directAddressedAcceptance: true,
    richText: '{"type":"doc"}',
  };
  assert.deepEqual((await request(firstPort, "send", "sendPrompt", nativeInput)).outcome, {
    status: "ok",
    value: { accepted: true },
  });
  first.dispose();

  const second = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
  });
  const secondPort = new PortHarness();
  second.bindPort(secondPort);
  secondPort.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => secondPort.frames.some((frame) => frame.family === "agents"));
  const status = await request(secondPort, "status", "promptAcceptanceStatus", {
    accountSlot: "host",
    clientNonce: "restart-nonce-123",
  });
  assert.equal(status.outcome.status, "ok");
  assert.equal(status.outcome.value.outcome, "found");
  assert.equal(status.outcome.value.record.status, "accepted");
  assert.equal(status.outcome.value.record.echoEntryId, "message-user-0001");
  assert.equal(status.outcome.value.record.acceptedAtMs, Date.parse("2026-08-16T12:04:00.000Z"));

  assert.deepEqual((await request(secondPort, "duplicate", "sendPrompt", nativeInput)).outcome, {
    status: "ok",
    value: { accepted: true },
  });
  assert.equal(conversations.calls.filter(([name]) => name === "send").length, 1);
  const mismatch = await request(secondPort, "mismatch", "sendPrompt", {
    ...nativeInput,
    prompt: "Do not duplicate this.",
  });
  assert.equal(mismatch.outcome.failure.code, "send/nonce-digest-mismatch");
  second.dispose();
});

test("a durable native prompt echo stays accepted when inference startup fails before streaming", async () => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const originalSend = conversations.send.bind(conversations);
  let sendCalls = 0;
  conversations.send = async (request) => {
    sendCalls += 1;
    await originalSend(request);
    throw new Error("provider start failed after durable input");
  };
  const input = {
    agentId: BOT_A,
    prompt: "Keep this durable prompt.",
    clientNonce: "nonce-durable-start-failure",
    directAddressedAcceptance: true,
  };

  const first = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
  });
  const firstPort = new PortHarness();
  first.bindPort(firstPort);
  firstPort.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => firstPort.frames.some((frame) => frame.family === "agents"));
  assert.deepEqual((await request(firstPort, "send", "sendPrompt", input)).outcome, {
    status: "ok",
    value: { accepted: true },
  });
  const sameProcess = await request(firstPort, "status", "promptAcceptanceStatus", {
    accountSlot: "host",
    clientNonce: input.clientNonce,
  });
  assert.equal(sameProcess.outcome.value.record.status, "accepted");
  assert.equal(sameProcess.outcome.value.record.echoEntryId, "message-user-0001");
  assert.equal(firstPort.frames.some((frame) => frame.family === "transcript"
    && frame.payload.type === "appended" && frame.payload.entry.clientNonce === input.clientNonce), true);
  first.dispose();

  const second = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
  });
  const secondPort = new PortHarness();
  second.bindPort(secondPort);
  secondPort.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => secondPort.frames.some((frame) => frame.family === "agents"));
  const afterRestart = await request(secondPort, "status-restart", "promptAcceptanceStatus", {
    accountSlot: "host",
    clientNonce: input.clientNonce,
  });
  assert.equal(afterRestart.outcome.value.record.status, "accepted");
  assert.equal(afterRestart.outcome.value.record.echoEntryId, "message-user-0001");
  assert.deepEqual((await request(secondPort, "send-replay", "sendPrompt", input)).outcome, {
    status: "ok",
    value: { accepted: true },
  });
  assert.equal(sendCalls, 1);
  second.dispose();
});

test("signed-out native local reads return exact Grok 0.20 absence shapes", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const avatarDataUrl = "data:image/png;base64,AA==";
  const bots = new BotControllerHarness([bot(BOT_A, {
    appearance: Object.freeze({
      shape: "blob",
      color: "blue",
      image: avatarDataUrl,
      title: "",
      description: "A direct Codex bot.",
    }),
  })]);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const objectReads = [
    ["searchAgents", { query: "Alpha" }, []],
    ["searchMedia", { query: "" }, []],
    ["getAgentAvatar", { id: BOT_A }, {
      dataUrl: avatarDataUrl,
      version: "2026-08-16T12:01:00.000Z",
    }],
    ["getConversationOutline", { id: BOT_A }, []],
    ["getCloudAgentInfo", { bcId: "cloud-agent-1", includeFiles: false }, null],
    ["getForeverBoxStatus", { id: BOT_A }, null],
    ["getAgentChannels", { id: BOT_A }, { manifests: [], connections: [] }],
    ["getAgentWorkflows", { id: BOT_A }, []],
    ["getSubagents", { id: BOT_A }, []],
    ["getAsyncTasks", { id: BOT_A }, []],
  ];
  for (const [index, [method, args, value]] of objectReads.entries()) {
    const requestId = `r-local-object-${index}`;
    assert.deepEqual(await request(port, requestId, method, args), {
      kind: "reply",
      requestId,
      outcome: { status: "ok", value },
    });
  }

  const noArgumentReads = [
    ["getTeachRecordingStatus", {
      state: "idle",
      agentId: null,
      startedAtMs: null,
      maxDurationMs: 600_000,
    }],
    ["getTrays", []],
    ["getBoxSecretsStatus", { keys: [], isApplied: false, lastAppliedAtMs: null }],
    ["getSharingState", {
      isEnabled: false,
      selfAuthId: null,
      pendingJoinRequests: [],
      rooms: [],
      typingUsers: [],
    }],
    ["skillsCatalog", []],
    ["syncPluginSkills", []],
    ["isAgentNetworkEnabled", false],
    ["isGlobalSearchEnabled", false],
    ["isEgressTunnelAvailable", false],
  ];
  for (const [index, [method, value]] of noArgumentReads.entries()) {
    const requestId = `r-local-none-${index}`;
    assert.deepEqual(await request(port, requestId, method), {
      kind: "reply",
      requestId,
      outcome: { status: "ok", value },
    });
  }
});

test("signed-out local reads reject malformed arguments while remote mutations stay unavailable", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  for (const [requestId, method, args] of [
    ["r-search-malformed", "searchAgents", { query: 7 }],
    ["r-agent-read-malformed", "getAgentWorkflows", {}],
    ["r-none-malformed", "skillsCatalog", { unexpected: true }],
    ["r-cloud-malformed", "getCloudAgentInfo", { bcId: "cloud-agent-1", includeFiles: "no" }],
  ]) {
    assert.deepEqual((await request(port, requestId, method, args)).outcome, {
      status: "failed",
      failure: {
        code: "source/malformed-request",
        message: "Malformed OpenBot native request.",
      },
    });
  }

  for (const [requestId, method, args] of [
    ["r-ensure-box", "ensureForeverBox", { id: BOT_A }],
    ["r-connect-channel", "connectChannel", { id: BOT_A, manifestId: "slack" }],
    ["r-create-room", "createRoomFromAgent", { id: BOT_A }],
  ]) {
    assert.deepEqual((await request(port, requestId, method, args)).outcome, {
      status: "failed",
      failure: {
        code: "source/capability-unavailable",
        message: `unknown gateway method: ${method}`,
      },
    });
  }
});

test("native automation delegates all seven exact Grok methods and sanitizes controller failures", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness([bot(BOT_A), bot(BOT_B)]),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const cases = [
    ["getAgentAutomations", { id: BOT_A }, [automation(BOT_A)]],
    ["listAllAutomations", {}, [
      { agentId: BOT_B, automation: automation(BOT_B) },
      { agentId: BOT_A, automation: automation(BOT_A) },
    ]],
    ["createAgentAutomation", { id: BOT_A, spec: AUTOMATION_SPEC }, [automation(BOT_A)]],
    ["updateAgentAutomation", {
      id: BOT_A,
      automationId: AUTOMATION_A_ID,
      spec: AUTOMATION_SPEC,
    }, [automation(BOT_A, { name: "Updated summary" })]],
    ["setAgentAutomationEnabled", {
      id: BOT_A,
      automationId: AUTOMATION_A_ID,
      isEnabled: false,
    }, [automation(BOT_A, { isEnabled: false, nextRunAt: null })]],
    ["deleteAgentAutomation", {
      id: BOT_A,
      automationId: AUTOMATION_A_ID,
    }, []],
    ["runAgentAutomationNow", {
      id: BOT_A,
      automationId: AUTOMATION_A_ID,
    }, undefined],
  ];
  for (const [index, [method, args, expectedValue]] of cases.entries()) {
    const requestId = `native-automation-exact-${index}`;
    assert.deepEqual(await request(port, requestId, method, args), {
      kind: "reply",
      requestId,
      outcome: { status: "ok", value: expectedValue },
    });
  }
  assert.deepEqual(automations.calls, cases.map(([method, args]) => [method, structuredClone(args)]));
  assert.deepEqual(Object.keys(port.frames.find((frame) => frame.requestId === "native-automation-exact-0")
    .outcome.value[0]).sort(), [
    "createdAt", "filePath", "id", "isEnabled", "lastRunAt", "name", "nextRunAt",
    "prompt", "provenance", "runs", "schedule", "trigger", "triggerDescription",
  ]);

  const privateFailure = new Error("private controller storage path: /Users/private/state.json");
  privateFailure.code = "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED";
  automations.setFailure("getAgentAutomations", privateFailure);
  assert.deepEqual((await request(port, "native-automation-private-failure", "getAgentAutomations", {
    id: BOT_A,
  })).outcome, {
    status: "failed",
    failure: {
      code: "source/transport-failure",
      message: "OpenBot native getAgentAutomations failed.",
    },
  });
  assert.equal(port.closed, 0);
});

test("native automation is explicitly unavailable without a controller instead of returning fake empty reads", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const cases = [
    ["getAgentAutomations", { id: BOT_A }],
    ["listAllAutomations", {}],
    ["createAgentAutomation", { id: BOT_A, spec: AUTOMATION_SPEC }],
    ["updateAgentAutomation", { id: BOT_A, automationId: AUTOMATION_A_ID, spec: AUTOMATION_SPEC }],
    ["setAgentAutomationEnabled", { id: BOT_A, automationId: AUTOMATION_A_ID, isEnabled: true }],
    ["deleteAgentAutomation", { id: BOT_A, automationId: AUTOMATION_A_ID }],
    ["runAgentAutomationNow", { id: BOT_A, automationId: AUTOMATION_A_ID }],
  ];
  for (const [index, [method, args]] of cases.entries()) {
    assert.deepEqual((await request(port, `native-automation-unavailable-${index}`, method, args)).outcome, {
      status: "failed",
      failure: {
        code: "source/capability-unavailable",
        message: `unknown gateway method: ${method}`,
      },
    });
  }
  assert.equal(port.closed, 0);
  assert.equal((await request(port, "native-automation-unavailable-alive", "countAgents")).outcome.value, 1);
});

test("native automation rejects hostile arguments before controller access and keeps the port alive", async (t) => {
  const cases = [];
  cases.push(["extra", "getAgentAutomations", { id: BOT_A, privatePath: "/private" }, () => 0]);
  cases.push(["missing", "updateAgentAutomation", {
    id: BOT_A,
    automationId: AUTOMATION_A_ID,
  }, () => 0]);
  let accessorTouches = 0;
  const accessorSpec = {
    name: AUTOMATION_SPEC.name,
    prompt: AUTOMATION_SPEC.prompt,
    trigger: { type: "cron" },
    isEnabled: true,
  };
  Object.defineProperty(accessorSpec.trigger, "schedule", {
    enumerable: true,
    get() { accessorTouches += 1; throw new Error("must not read schedule accessor"); },
  });
  cases.push(["accessor", "createAgentAutomation", { id: BOT_A, spec: accessorSpec }, () => accessorTouches]);
  let proxyTouches = 0;
  const proxyArgs = new Proxy({ id: BOT_A }, {
    get(target, key, receiver) {
      proxyTouches += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  cases.push(["proxy", "getAgentAutomations", proxyArgs, () => proxyTouches]);
  cases.push(["invalid-id", "runAgentAutomationNow", {
    id: BOT_A,
    automationId: "../private-state",
  }, () => 0]);

  for (const [name, method, args, touches] of cases) {
    await t.test(name, async (st) => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const automations = new AutomationControllerHarness();
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: new BotControllerHarness(),
        conversationController: new ConversationHarness(),
        automationController: automations,
      });
      st.after(() => coordinator.dispose());
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      const reply = await request(port, `native-automation-hostile-args-${name}`, method, args);
      assert.deepEqual(reply.outcome, {
        status: "failed",
        failure: {
          code: "source/malformed-request",
          message: "Malformed OpenBot native request.",
        },
      });
      assert.equal(touches(), 0);
      assert.equal(automations.calls.length, 0);
      assert.equal(port.closed, 0);
      assert.equal((await request(port, `native-automation-hostile-args-alive-${name}`, "countAgents"))
        .outcome.value, 1);
    });
  }
});

test("native automation rejects hostile controller results without leaking private fields or paths", async (t) => {
  const privateRow = { ...automation(BOT_A), conversationId: "conversation-private" };
  const sparseRows = [automation(BOT_A)];
  sparseRows.length = 2;
  let accessorTouches = 0;
  const accessorRow = { ...automation(BOT_A) };
  Object.defineProperty(accessorRow, "prompt", {
    enumerable: true,
    get() { accessorTouches += 1; throw new Error("must not read result accessor"); },
  });
  let proxyTouches = 0;
  const proxyRow = new Proxy({ ...automation(BOT_A) }, {
    get(target, key, receiver) {
      proxyTouches += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const cases = [
    ["private-field", [privateRow], () => 0],
    ["filesystem-path", [automation(BOT_A, { filePath: "/Users/private/local-automations.v1.json" })], () => 0],
    ["sparse-array", sparseRows, () => 0],
    ["accessor", [accessorRow], () => accessorTouches],
    ["proxy", [proxyRow], () => proxyTouches],
  ];

  for (const [name, hostile, touches] of cases) {
    await t.test(name, async (st) => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const automations = new AutomationControllerHarness();
      automations.setResponse("getAgentAutomations", hostile);
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: new BotControllerHarness(),
        conversationController: new ConversationHarness(),
        automationController: automations,
      });
      st.after(() => coordinator.dispose());
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      assert.deepEqual((await request(port, `native-automation-hostile-result-${name}`,
        "getAgentAutomations", { id: BOT_A })).outcome, {
        status: "failed",
        failure: {
          code: "source/transport-failure",
          message: "OpenBot native getAgentAutomations failed.",
        },
      });
      assert.equal(touches(), 0);
      assert.equal(port.closed, 0);
      assert.equal((await request(port, `native-automation-hostile-result-alive-${name}`,
        "countAgents")).outcome.value, 1);
    });
  }
});

test("native automation changed publishes exact automation and workflow snapshots and detaches once", async () => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  assert.equal(automations.listenerCount("changed"), 1);
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  automations.emit("changed", {
    agentId: BOT_A,
    automations: [automation(BOT_A)],
    workflows: [workflow(BOT_A)],
  });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents-workflow"));
  assert.deepEqual(port.frames.filter((frame) => frame.family === "agents-automation"), [{
    kind: "event",
    family: "agents-automation",
    payload: { agentId: BOT_A, automations: [automation(BOT_A)] },
  }]);
  assert.deepEqual(port.frames.filter((frame) => frame.family === "agents-workflow"), [{
    kind: "event",
    family: "agents-workflow",
    payload: { agentId: BOT_A, workflows: [workflow(BOT_A)] },
  }]);
  coordinator.dispose();
  assert.equal(automations.listenerCount("changed"), 0);
});

test("native automation drops hostile changed events without touching accessors or closing ports", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  let touches = 0;
  const accessorEvent = {};
  Object.defineProperty(accessorEvent, "agentId", {
    enumerable: true,
    get() { touches += 1; throw new Error("must not read event accessor"); },
  });
  Object.defineProperty(accessorEvent, "automations", { enumerable: true, value: [automation(BOT_A)] });
  Object.defineProperty(accessorEvent, "workflows", { enumerable: true, value: [workflow(BOT_A)] });
  const sparse = [automation(BOT_A)];
  sparse.length = 2;
  for (const event of [
    accessorEvent,
    new Proxy({ agentId: BOT_A, automations: [automation(BOT_A)], workflows: [workflow(BOT_A)] }, {}),
    { agentId: BOT_A, automations: sparse, workflows: [workflow(BOT_A)] },
    {
      agentId: BOT_A,
      automations: [{ ...automation(BOT_A), updatedAt: AUTOMATION_CREATED_AT }],
      workflows: [workflow(BOT_A)],
    },
    {
      agentId: BOT_A,
      automations: [automation(BOT_A)],
      workflows: [workflow(BOT_A, { filePath: "/private/routine.md" })],
    },
  ]) automations.emit("changed", event);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(touches, 0);
  assert.equal(port.frames.some((frame) => frame.family === "agents-automation"), false);
  assert.equal(port.frames.some((frame) => frame.family === "agents-workflow"), false);
  assert.equal(port.closed, 0);
});

test("native automation fences held same-bot reads mutations and run-now across deletion", async (t) => {
  const cases = [
    ["getAgentAutomations", { id: BOT_A }],
    ["createAgentAutomation", { id: BOT_A, spec: AUTOMATION_SPEC }],
    ["runAgentAutomationNow", { id: BOT_A, automationId: AUTOMATION_A_ID }],
  ];
  for (const [method, args] of cases) {
    await t.test(method, async (st) => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
      const automations = new AutomationControllerHarness();
      const gate = automations.hold(method, BOT_A);
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: bots,
        conversationController: new ConversationHarness(),
        automationController: automations,
        deleteBots: async (ids) => {
          bots.remove(ids);
          return {
            deletedBotIds: [...ids],
            survivingBotIds: [...bots.bots.keys()],
            activeBotId: BOT_B,
          };
        },
      });
      st.after(() => coordinator.dispose());
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      const held = request(port, `native-automation-held-${method}`, method, args);
      await waitFor(() => automations.calls.some(([name]) => name === method));
      assert.equal((await request(port, `native-automation-delete-${method}`, "deleteAgents", {
        ids: [BOT_A],
      })).outcome.status, "ok");
      assert.deepEqual((await request(port, `native-automation-b-${method}`, "getAgentAutomations", {
        id: BOT_B,
      })).outcome.value, [automation(BOT_B)]);
      gate.release();
      assert.deepEqual((await held).outcome, {
        status: "failed",
        failure: {
          code: "source/transport-failure",
          message: `OpenBot native ${method} failed.`,
        },
      });
      assert.equal(port.closed, 0);
    });
  }
});

test("native automation aggregate reads filter a bot deleted while the controller snapshot is held", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const automations = new AutomationControllerHarness();
  const gate = automations.hold("listAllAutomations");
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    automationController: automations,
    deleteBots: async (ids) => {
      bots.remove(ids);
      return {
        deletedBotIds: [...ids],
        survivingBotIds: [...bots.bots.keys()],
        activeBotId: BOT_B,
      };
    },
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const held = request(port, "native-automation-aggregate-held", "listAllAutomations", {});
  await waitFor(() => automations.calls.some(([method]) => method === "listAllAutomations"));
  assert.equal((await request(port, "native-automation-aggregate-delete", "deleteAgents", {
    ids: [BOT_A],
  })).outcome.status, "ok");
  gate.release();
  assert.deepEqual((await held).outcome, {
    status: "ok",
    value: [{ agentId: BOT_B, automation: automation(BOT_B) }],
  });
});

test("native automation held reads cannot return a Routine removed by a newer changed revision", async (t) => {
  for (const method of ["getAgentAutomations", "listAllAutomations"]) {
    await t.test(method, async (st) => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const automations = new AutomationControllerHarness();
      const gate = automations.hold(method, method === "getAgentAutomations" ? BOT_A : "*");
      automations.setResponse("deleteAgentAutomation", () => {
        automations.emit("changed", { agentId: BOT_A, automations: [], workflows: [] });
        return [];
      });
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: new BotControllerHarness(),
        conversationController: new ConversationHarness(),
        automationController: automations,
      });
      st.after(() => coordinator.dispose());
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      const args = method === "getAgentAutomations" ? { id: BOT_A } : {};
      const held = request(port, `native-automation-stale-${method}`, method, args);
      await waitFor(() => automations.calls.some(([called]) => called === method));
      assert.equal((await request(port, `native-automation-newer-delete-${method}`,
        "deleteAgentAutomation", { id: BOT_A, automationId: AUTOMATION_A_ID })).outcome.status, "ok");
      await waitFor(() => port.frames.some((frame) => frame.family === "agents-automation"
        && frame.payload.agentId === BOT_A && frame.payload.automations.length === 0));
      gate.release();
      assert.deepEqual((await held).outcome, {
        status: "failed",
        failure: {
          code: "source/transport-failure",
          message: `OpenBot native ${method} failed.`,
        },
      });
    });
  }
});

test("native automation verifies bot membership and filters orphaned aggregate rows", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  automations.setResponse("listAllAutomations", [
    { agentId: BOT_C, automation: automation(BOT_C) },
    { agentId: BOT_A, automation: automation(BOT_A) },
  ]);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  assert.deepEqual((await request(port, "native-automation-orphan-get", "getAgentAutomations", {
    id: BOT_C,
  })).outcome, {
    status: "failed",
    failure: {
      code: "source/transport-failure",
      message: "OpenBot native getAgentAutomations failed.",
    },
  });
  assert.equal(automations.calls.some(([method]) => method === "getAgentAutomations"), false);
  assert.deepEqual((await request(port, "native-automation-orphan-list", "listAllAutomations", {}))
    .outcome.value, [{ agentId: BOT_A, automation: automation(BOT_A) }]);
});

test("native automation mutation failures stay sanitized and do not close the ready port", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  automations.setFailure("createAgentAutomation", new Error("private mutation failure"));
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  assert.deepEqual((await request(port, "native-automation-mutation-failure", "createAgentAutomation", {
    id: BOT_A,
    spec: AUTOMATION_SPEC,
  })).outcome, {
    status: "failed",
    failure: {
      code: "source/transport-failure",
      message: "OpenBot native createAgentAutomation failed.",
    },
  });
  assert.equal(port.closed, 0);
  assert.equal((await request(port, "native-automation-mutation-failure-alive", "countAgents"))
    .outcome.value, 1);
});

test("native automation returns a valid complete snapshot larger than the inbound frame ceiling", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const large = Array.from({ length: 5 }, (_, index) => automation(BOT_A, {
    id: `large-routine-${index}`,
    name: `Large Routine ${index}`,
    prompt: `${index}${"x".repeat(60 * 1024)}`,
    filePath: `openbot-local-routine:${BOT_A}:large-routine-${index}`,
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(large), "utf8") > 256 * 1024);
  automations.setResponse("getAgentAutomations", large);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const reply = await request(port, "native-automation-large-complete", "getAgentAutomations", { id: BOT_A });
  assert.equal(reply.outcome.status, "ok");
  assert.deepEqual(reply.outcome.value.map((entry) => [entry.id, entry.prompt.length]), [
    ["large-routine-0", 61_441],
    ["large-routine-1", 61_441],
    ["large-routine-2", 61_441],
    ["large-routine-3", 61_441],
    ["large-routine-4", 61_441],
  ]);
});

test("native automation cancellation replies once and suppresses its late controller completion", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const gate = automations.hold("getAgentAutomations", BOT_A);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness([bot(BOT_A), bot(BOT_B)]),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  port.receive({
    kind: "request",
    requestId: "native-automation-cancelled",
    method: "getAgentAutomations",
    args: { id: BOT_A },
  });
  await waitFor(() => automations.calls.some(([method]) => method === "getAgentAutomations"));
  port.receive({ kind: "cancel", requestId: "native-automation-cancelled" });
  await waitFor(() => port.frames.some((frame) => frame.requestId === "native-automation-cancelled"));
  assert.deepEqual(port.frames.find((frame) => frame.requestId === "native-automation-cancelled"), {
    kind: "reply",
    requestId: "native-automation-cancelled",
    outcome: {
      status: "failed",
      failure: { code: "cancelled", message: "OpenBot native request was cancelled." },
    },
  });
  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.frames.filter((frame) => frame.requestId === "native-automation-cancelled").length, 1);
  assert.deepEqual((await request(port, "native-automation-after-cancel", "getAgentAutomations", {
    id: BOT_B,
  })).outcome.value, [automation(BOT_B)]);
  assert.equal(port.closed, 0);
});

test("native automation port close and coordinator disposal suppress late replies and events", async (t) => {
  for (const mode of ["port-close", "coordinator-dispose"]) {
    await t.test(mode, async () => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const automations = new AutomationControllerHarness();
      const gate = automations.hold("getAgentAutomations", BOT_A);
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: new BotControllerHarness(),
        conversationController: new ConversationHarness(),
        automationController: automations,
      });
      const port = new PortHarness();
      const unbind = coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      port.receive({
        kind: "request",
        requestId: `native-automation-late-${mode}`,
        method: "getAgentAutomations",
        args: { id: BOT_A },
      });
      await waitFor(() => automations.calls.some(([method]) => method === "getAgentAutomations"));
      if (mode === "port-close") unbind();
      else coordinator.dispose();
      gate.release();
      automations.emit("changed", {
        agentId: BOT_A,
        automations: [automation(BOT_A)],
        workflows: [workflow(BOT_A)],
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(port.frames.some((frame) => frame.requestId === `native-automation-late-${mode}`), false);
      assert.equal(port.frames.some((frame) => frame.family === "agents-automation"), false);
      assert.equal(port.frames.some((frame) => frame.family === "agents-workflow"), false);
      assert.equal(port.closed, 1);
      coordinator.dispose();
    });
  }
});

test("native automation remote port close detaches ingress and suppresses late completion", async () => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const gate = automations.hold("getAgentAutomations", BOT_A);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  port.receive({
    kind: "request",
    requestId: "native-automation-remote-close",
    method: "getAgentAutomations",
    args: { id: BOT_A },
  });
  await waitFor(() => automations.calls.some(([method]) => method === "getAgentAutomations"));
  port.emit("close");
  gate.release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.frames.some((frame) => frame.requestId === "native-automation-remote-close"), false);
  assert.equal(port.listenerCount("message"), 0);
  assert.equal(port.listenerCount("close"), 0);
  assert.equal(port.closed, 1);
  coordinator.dispose();
});

test("native automation changed events are revision-fenced and Bot B publishes during Bot A deletion", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const automations = new AutomationControllerHarness();
  const deletionEntered = deferred();
  const deletionRelease = deferred();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    automationController: automations,
    deleteBots: async (ids) => {
      deletionEntered.resolve();
      await deletionRelease.promise;
      bots.remove(ids);
      return {
        deletedBotIds: [...ids],
        survivingBotIds: [...bots.bots.keys()],
        activeBotId: BOT_B,
      };
    },
  });
  t.after(() => {
    deletionRelease.resolve();
    coordinator.dispose();
  });
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const deleting = request(port, "native-automation-event-delete-a", "deleteAgents", { ids: [BOT_A] });
  await deletionEntered.promise;
  automations.emit("changed", {
    agentId: BOT_A,
    automations: [automation(BOT_A)],
    workflows: [workflow(BOT_A)],
  });
  automations.emit("changed", {
    agentId: BOT_B,
    automations: [automation(BOT_B)],
    workflows: [workflow(BOT_B)],
  });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents-automation"
    && frame.payload.agentId === BOT_B));
  assert.equal(port.frames.some((frame) => frame.family === "agents-automation"
    && frame.payload.agentId === BOT_A), false);
  deletionRelease.resolve();
  assert.equal((await deleting).outcome.status, "ok");
});

test("native automation drops an older held changed publication after a newer same-bot revision", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const automations = new AutomationControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const originalList = bots.listBots.bind(bots);
  const firstEntered = deferred();
  const firstRelease = deferred();
  t.after(() => firstRelease.resolve());
  let eventListCalls = 0;
  bots.listBots = async () => {
    eventListCalls += 1;
    if (eventListCalls === 1) {
      firstEntered.resolve();
      await firstRelease.promise;
    }
    return originalList();
  };
  automations.emit("changed", {
    agentId: BOT_A,
    automations: [automation(BOT_A, { name: "Older snapshot" })],
    workflows: [workflow(BOT_A, { name: "Older snapshot" })],
  });
  await waitFor(() => eventListCalls === 1);
  automations.emit("changed", {
    agentId: BOT_A,
    automations: [automation(BOT_A, { name: "Newer snapshot" })],
    workflows: [workflow(BOT_A, { name: "Newer snapshot" })],
  });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents-automation"
    && frame.payload.automations[0].name === "Newer snapshot"));
  firstRelease.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(port.frames.filter((frame) => frame.family === "agents-automation")
    .map((frame) => frame.payload.automations[0].name), ["Newer snapshot"]);
  assert.deepEqual(port.frames.filter((frame) => frame.family === "agents-workflow")
    .map((frame) => frame.payload.workflows[0].name), ["Newer snapshot"]);
});

test("native automation committed mutations stay successful when a newer scheduler snapshot publishes", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const committed = automation(BOT_A, { name: "Committed reply" });
  const newer = automation(BOT_A, { name: "Scheduler newer" });
  automations.setResponse("createAgentAutomation", () => {
    automations.emit("changed", {
      agentId: BOT_A,
      automations: [newer],
      workflows: [workflowForAutomation(newer)],
    });
    return [committed];
  });
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  assert.deepEqual((await request(port, "native-automation-newer-than-mutation",
    "createAgentAutomation", { id: BOT_A, spec: AUTOMATION_SPEC })).outcome, {
    status: "ok",
    value: [newer],
  });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents-automation"));
  assert.deepEqual(port.frames.filter((frame) => frame.family === "agents-automation").at(-1).payload, {
    agentId: BOT_A,
    automations: [newer],
  });
});

test("native automation permanently rejects a hostile frame even if caller data is rehabilitated", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const automations = new AutomationControllerHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: new BotControllerHarness(),
    conversationController: new ConversationHarness(),
    automationController: automations,
  });
  t.after(() => coordinator.dispose());
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  let getterTouches = 0;
  const trigger = { type: "cron" };
  Object.defineProperty(trigger, "schedule", {
    configurable: true,
    enumerable: true,
    get() { getterTouches += 1; return "0 1 * * *"; },
  });
  port.receive({
    kind: "request",
    requestId: "native-automation-rehabilitated-hostile-frame",
    method: "createAgentAutomation",
    args: { id: BOT_A, spec: { ...AUTOMATION_SPEC, trigger } },
  });
  Object.defineProperty(trigger, "schedule", {
    configurable: true,
    enumerable: true,
    value: "0 9 * * *",
  });

  await waitFor(() => port.frames.some((frame) => frame.requestId
    === "native-automation-rehabilitated-hostile-frame"));
  assert.deepEqual(port.frames.find((frame) => frame.requestId
    === "native-automation-rehabilitated-hostile-frame").outcome, {
    status: "failed",
    failure: {
      code: "source/malformed-request",
      message: "Malformed OpenBot native request.",
    },
  });
  assert.equal(getterTouches, 0);
  assert.equal(automations.calls.length, 0);
  assert.equal(port.closed, 0);
});

test("native automation failed bot deletion restores a committed mutation reply and authoritative events", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const automations = new AutomationControllerHarness();
  const createGate = automations.hold("createAgentAutomation", BOT_A);
  const deletionEntered = deferred();
  const deletionRelease = deferred();
  const committed = automation(BOT_A, { name: "Committed during failed deletion" });
  automations.setResponse("createAgentAutomation", () => {
    automations.emit("changed", {
      agentId: BOT_A,
      automations: [committed],
      workflows: [workflowForAutomation(committed)],
    });
    return [committed];
  });
  automations.setResponse("getAgentAutomations", ({ id }) => id === BOT_A
    ? [committed] : [automation(id)]);
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    automationController: automations,
    deleteBots: async () => {
      deletionEntered.resolve();
      await deletionRelease.promise;
      throw new Error("private deletion backend failed");
    },
  });
  t.after(() => {
    createGate.release();
    deletionRelease.resolve();
    coordinator.dispose();
  });
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const creating = request(port, "native-automation-create-during-failed-delete",
    "createAgentAutomation", { id: BOT_A, spec: AUTOMATION_SPEC });
  await createGate.entered;
  const deleting = request(port, "native-automation-failed-delete", "deleteAgents", { ids: [BOT_A] });
  await deletionEntered.promise;
  createGate.release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const repliedBeforeDeletionSettled = port.frames.some((frame) => frame.requestId
    === "native-automation-create-during-failed-delete");

  deletionRelease.resolve();
  const deletionReply = await deleting;
  const createReply = await creating;
  assert.equal(repliedBeforeDeletionSettled, false,
    "a committed mutation must wait for the active deletion claim to resolve");
  assert.deepEqual(deletionReply.outcome, {
    status: "failed",
    failure: {
      code: "source/transport-failure",
      message: "OpenBot native deleteAgents failed.",
    },
  });
  assert.deepEqual(createReply.outcome, { status: "ok", value: [committed] });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents-automation"
    && frame.payload.agentId === BOT_A));
  assert.deepEqual(port.frames.filter((frame) => frame.family === "agents-automation"), [{
    kind: "event",
    family: "agents-automation",
    payload: { agentId: BOT_A, automations: [committed] },
  }]);
  assert.deepEqual(port.frames.filter((frame) => frame.family === "agents-workflow"), [{
    kind: "event",
    family: "agents-workflow",
    payload: { agentId: BOT_A, workflows: [workflowForAutomation(committed)] },
  }]);
  assert.ok(automations.calls.some(([method, args]) => method === "getAgentAutomations"
    && args.id === BOT_A), "rollback must reconcile from the authoritative controller");
  assert.equal(port.closed, 0);
});

test("native automation follows two reentrant failed deletion claims before returning a committed mutation", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
  const automations = new AutomationControllerHarness();
  const createGate = automations.hold("createAgentAutomation", BOT_A);
  const firstRollbackGate = automations.hold("getAgentAutomations", BOT_A);
  const deletionEntered = [deferred(), deferred()];
  const deletionRelease = [deferred(), deferred()];
  const committed = automation(BOT_A, { name: "Committed across two failed deletions" });
  automations.setResponse("createAgentAutomation", () => {
    automations.emit("changed", {
      agentId: BOT_A,
      automations: [committed],
      workflows: [workflowForAutomation(committed)],
    });
    return [committed];
  });
  automations.setResponse("getAgentAutomations", ({ id }) => id === BOT_A
    ? [committed] : [automation(id)]);
  let deletionIndex = 0;
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: new ConversationHarness(),
    automationController: automations,
    deleteBots: async () => {
      const index = deletionIndex;
      deletionIndex += 1;
      deletionEntered[index].resolve();
      await deletionRelease[index].promise;
      throw new Error(`private deletion backend ${index} failed`);
    },
  });
  t.after(() => {
    createGate.release();
    firstRollbackGate.release();
    for (const gate of deletionRelease) gate.resolve();
    coordinator.dispose();
  });
  const port = new PortHarness();
  coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));

  const creating = request(port, "native-automation-create-across-two-failed-deletes",
    "createAgentAutomation", { id: BOT_A, spec: AUTOMATION_SPEC });
  await createGate.entered;
  const firstDeleting = request(port, "native-automation-first-failed-delete",
    "deleteAgents", { ids: [BOT_A] });
  await deletionEntered[0].promise;
  createGate.release();
  deletionRelease[0].resolve();
  await firstRollbackGate.entered;

  const secondDeleting = request(port, "native-automation-second-failed-delete",
    "deleteAgents", { ids: [BOT_A] });
  await deletionEntered[1].promise;
  firstRollbackGate.release();
  const crossBot = await request(port, "native-automation-cross-bot-during-claim-chain",
    "getAgentAutomations", { id: BOT_B });
  assert.deepEqual(crossBot.outcome, { status: "ok", value: [automation(BOT_B)] });
  await new Promise((resolve) => setImmediate(resolve));
  const repliedBeforeSecondSettled = port.frames.some((frame) => frame.requestId
    === "native-automation-create-across-two-failed-deletes");

  deletionRelease[1].resolve();
  assert.equal((await firstDeleting).outcome.status, "failed");
  assert.equal((await secondDeleting).outcome.status, "failed");
  const createReply = await creating;
  assert.equal(repliedBeforeSecondSettled, false,
    "the committed mutation must follow the newer deletion claim instead of failing early");
  assert.deepEqual(createReply.outcome, { status: "ok", value: [committed] });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents-automation"
    && frame.payload.agentId === BOT_A));
  assert.equal(port.closed, 0);
});

test("native automation remote triggers and stable controller failures keep exact sanitized classifications", async (t) => {
  await t.test("known remote triggers are unavailable before controller mutation", async (st) => {
    const { OpenBotNativeCoordinator } = require(MODULE_PATH);
    const automations = new AutomationControllerHarness();
    const coordinator = new OpenBotNativeCoordinator({
      botRuntimeController: new BotControllerHarness(),
      conversationController: new ConversationHarness(),
      automationController: automations,
    });
    st.after(() => coordinator.dispose());
    const port = new PortHarness();
    coordinator.bindPort(port);
    port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
    await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
    const triggers = [
      { type: "slack", channel: "*", match: { kind: "message" } },
      { type: "github" },
      { type: "microsoftTeams" },
      { type: "linear" },
      { type: "sentry" },
      { type: "pagerduty" },
      { type: "group", listeners: [{ type: "cron", schedule: "0 9 * * *" }] },
    ];
    for (const [index, trigger] of triggers.entries()) {
      const outcome = (await request(port, `native-automation-remote-trigger-${index}`,
        "createAgentAutomation", {
          id: BOT_A,
          spec: { ...AUTOMATION_SPEC, trigger },
        })).outcome;
      assert.deepEqual(outcome, {
        status: "failed",
        failure: {
          code: "source/capability-unavailable",
          message: "unknown gateway method: createAgentAutomation",
        },
      });
    }
    assert.deepEqual((await request(port, "native-automation-unknown-trigger",
      "createAgentAutomation", {
        id: BOT_A,
        spec: { ...AUTOMATION_SPEC, trigger: { type: "private-webhook" } },
      })).outcome, {
      status: "failed",
      failure: {
        code: "source/malformed-request",
        message: "Malformed OpenBot native request.",
      },
    });
    assert.equal(automations.calls.length, 0);
    assert.equal(port.closed, 0);
  });

  const mappings = [
    ["OPENBOT_LOCAL_AUTOMATION_INVALID", "source/malformed-request", "Malformed OpenBot native request."],
    ["OPENBOT_LOCAL_AUTOMATION_UNAVAILABLE", "source/capability-unavailable",
      "unknown gateway method: createAgentAutomation"],
    ["OPENBOT_LOCAL_AUTOMATION_STORE_FAILED", "source/transport-failure",
      "OpenBot native createAgentAutomation failed."],
    ["OPENBOT_LOCAL_AUTOMATION_FAILED", "source/transport-failure",
      "OpenBot native createAgentAutomation failed."],
    ["PRIVATE_CONTROLLER_ERROR", "source/transport-failure",
      "OpenBot native createAgentAutomation failed."],
    ["SPOOFED_COORDINATOR_ERROR", "source/transport-failure",
      "OpenBot native createAgentAutomation failed."],
  ];
  for (const [code, expectedCode, expectedMessage] of mappings) {
    await t.test(code, async (st) => {
      const { OpenBotNativeCoordinator, OpenBotNativeCoordinatorError } = require(MODULE_PATH);
      const automations = new AutomationControllerHarness();
      const failure = code === "SPOOFED_COORDINATOR_ERROR"
        ? new OpenBotNativeCoordinatorError(
          "source/malformed-request",
          "/Users/private/spoofed-coordinator-error.json",
        )
        : new Error(`/Users/private/${code}.json`);
      if (code !== "SPOOFED_COORDINATOR_ERROR") failure.code = code;
      automations.setFailure("createAgentAutomation", failure);
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: new BotControllerHarness(),
        conversationController: new ConversationHarness(),
        automationController: automations,
      });
      st.after(() => coordinator.dispose());
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      const outcome = (await request(port, `native-automation-controller-code-${code}`,
        "createAgentAutomation", { id: BOT_A, spec: AUTOMATION_SPEC })).outcome;
      assert.deepEqual(outcome, {
        status: "failed",
        failure: { code: expectedCode, message: expectedMessage },
      });
      assert.equal(JSON.stringify(outcome).includes("/Users/private"), false);
      assert.equal(port.closed, 0);
    });
  }
});

test("native automation rejects unsorted and over-cap snapshots while accepting the legal aggregate maximum", async (t) => {
  const earlier = automation(BOT_A, {
    id: "earlier",
    nextRunAt: AUTOMATION_NEXT_RUN_AT,
    filePath: `openbot-local-routine:${BOT_A}:earlier`,
  });
  const later = automation(BOT_A, {
    id: "later",
    nextRunAt: AUTOMATION_NEXT_RUN_AT + 1_000,
    filePath: `openbot-local-routine:${BOT_A}:later`,
  });

  for (const method of ["getAgentAutomations", "listAllAutomations", "changed"]) {
    await t.test(`unsorted ${method}`, async (st) => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const automations = new AutomationControllerHarness();
      if (method === "getAgentAutomations") {
        automations.setResponse(method, [later, earlier]);
      } else if (method === "listAllAutomations") {
        automations.setResponse(method, [later, earlier].map((routine) => ({
          agentId: BOT_A,
          automation: routine,
        })));
      }
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: new BotControllerHarness(),
        conversationController: new ConversationHarness(),
        automationController: automations,
      });
      st.after(() => coordinator.dispose());
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      if (method === "changed") {
        automations.emit("changed", {
          agentId: BOT_A,
          automations: [later, earlier],
          workflows: [workflowForAutomation(later), workflowForAutomation(earlier)],
        });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(port.frames.some((frame) => frame.family === "agents-automation"), false);
        assert.equal(port.frames.some((frame) => frame.family === "agents-workflow"), false);
      } else {
        const args = method === "getAgentAutomations" ? { id: BOT_A } : {};
        assert.deepEqual((await request(port, `native-automation-unsorted-${method}`,
          method, args)).outcome, {
          status: "failed",
          failure: {
            code: "source/transport-failure",
            message: `OpenBot native ${method} failed.`,
          },
        });
      }
      assert.equal(port.closed, 0);
    });
  }

  const comparatorEdges = [
    ["null next-run sorts last", [
      automation(BOT_A, {
        id: "disabled-first",
        nextRunAt: null,
        filePath: `openbot-local-routine:${BOT_A}:disabled-first`,
      }),
      automation(BOT_A, {
        id: "scheduled-second",
        nextRunAt: AUTOMATION_NEXT_RUN_AT,
        filePath: `openbot-local-routine:${BOT_A}:scheduled-second`,
      }),
    ]],
    ["created-at breaks equal next-run ties", [
      automation(BOT_A, {
        id: "created-later-first",
        createdAt: AUTOMATION_CREATED_AT + 1,
        filePath: `openbot-local-routine:${BOT_A}:created-later-first`,
      }),
      automation(BOT_A, {
        id: "created-earlier-second",
        createdAt: AUTOMATION_CREATED_AT,
        filePath: `openbot-local-routine:${BOT_A}:created-earlier-second`,
      }),
    ]],
    ["id breaks equal timestamp ties", [
      automation(BOT_A, {
        id: "zeta-first",
        filePath: `openbot-local-routine:${BOT_A}:zeta-first`,
      }),
      automation(BOT_A, {
        id: "alpha-second",
        filePath: `openbot-local-routine:${BOT_A}:alpha-second`,
      }),
    ]],
  ];
  for (const [name, rows] of comparatorEdges) {
    await t.test(name, async (st) => {
      const { OpenBotNativeCoordinator } = require(MODULE_PATH);
      const automations = new AutomationControllerHarness();
      automations.setResponse("getAgentAutomations", rows);
      const coordinator = new OpenBotNativeCoordinator({
        botRuntimeController: new BotControllerHarness(),
        conversationController: new ConversationHarness(),
        automationController: automations,
      });
      st.after(() => coordinator.dispose());
      const port = new PortHarness();
      coordinator.bindPort(port);
      port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
      await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
      assert.deepEqual((await request(port, `native-automation-order-${name}`,
        "getAgentAutomations", { id: BOT_A })).outcome, {
        status: "failed",
        failure: {
          code: "source/transport-failure",
          message: "OpenBot native getAgentAutomations failed.",
        },
      });
    });
  }

  await t.test("global aggregate order cannot place a later bot before an earlier bot", async (st) => {
    const { OpenBotNativeCoordinator } = require(MODULE_PATH);
    const automations = new AutomationControllerHarness();
    const earlierAcrossBots = automation(BOT_A, {
      id: "global-earlier",
      nextRunAt: AUTOMATION_NEXT_RUN_AT + 10,
      filePath: `openbot-local-routine:${BOT_A}:global-earlier`,
    });
    const laterAcrossBots = automation(BOT_B, {
      id: "global-later",
      nextRunAt: AUTOMATION_NEXT_RUN_AT + 20,
      filePath: `openbot-local-routine:${BOT_B}:global-later`,
    });
    automations.setResponse("listAllAutomations", [
      { agentId: BOT_B, automation: laterAcrossBots },
      { agentId: BOT_A, automation: earlierAcrossBots },
    ]);
    const coordinator = new OpenBotNativeCoordinator({
      botRuntimeController: new BotControllerHarness([bot(BOT_A), bot(BOT_B)]),
      conversationController: new ConversationHarness(),
      automationController: automations,
    });
    st.after(() => coordinator.dispose());
    const port = new PortHarness();
    coordinator.bindPort(port);
    port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
    await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
    assert.deepEqual((await request(port, "native-automation-global-aggregate-order",
      "listAllAutomations", {})).outcome, {
      status: "failed",
      failure: {
        code: "source/transport-failure",
        message: "OpenBot native listAllAutomations failed.",
      },
    });
  });

  await t.test("51 rows for one bot exceed the per-bot aggregate cap", async (st) => {
    const { OpenBotNativeCoordinator } = require(MODULE_PATH);
    const automations = new AutomationControllerHarness();
    const overCap = Array.from({ length: 51 }, (_, index) => {
      const id = `over-cap-${String(index).padStart(2, "0")}`;
      return {
        agentId: BOT_A,
        automation: automation(BOT_A, {
          id,
          nextRunAt: AUTOMATION_NEXT_RUN_AT + index,
          filePath: `openbot-local-routine:${BOT_A}:${id}`,
        }),
      };
    });
    automations.setResponse("listAllAutomations", overCap);
    const coordinator = new OpenBotNativeCoordinator({
      botRuntimeController: new BotControllerHarness(),
      conversationController: new ConversationHarness(),
      automationController: automations,
    });
    st.after(() => coordinator.dispose());
    const port = new PortHarness();
    coordinator.bindPort(port);
    port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
    await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
    assert.deepEqual((await request(port, "native-automation-over-cap-aggregate",
      "listAllAutomations", {})).outcome, {
      status: "failed",
      failure: {
        code: "source/transport-failure",
        message: "OpenBot native listAllAutomations failed.",
      },
    });
  });

  await t.test("50 rows each for two bots remains a valid complete aggregate", async (st) => {
    const { OpenBotNativeCoordinator } = require(MODULE_PATH);
    const automations = new AutomationControllerHarness();
    const legal = [BOT_A, BOT_B].flatMap((agentId, botIndex) => Array.from(
      { length: 50 },
      (_, index) => {
        const id = `legal-${botIndex}-${String(index).padStart(2, "0")}`;
        return {
          agentId,
          automation: automation(agentId, {
            id,
            nextRunAt: AUTOMATION_NEXT_RUN_AT + (botIndex * 50) + index,
            prompt: `${agentId}:${id}:${"x".repeat(60 * 1024)}`,
            filePath: `openbot-local-routine:${agentId}:${id}`,
          }),
        };
      },
    ));
    assert.ok(Buffer.byteLength(JSON.stringify(legal), "utf8") > 256 * 1024);
    automations.setResponse("listAllAutomations", legal);
    const coordinator = new OpenBotNativeCoordinator({
      botRuntimeController: new BotControllerHarness([bot(BOT_A), bot(BOT_B)]),
      conversationController: new ConversationHarness(),
      automationController: automations,
    });
    st.after(() => coordinator.dispose());
    const port = new PortHarness();
    coordinator.bindPort(port);
    port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
    await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
    const reply = await request(port, "native-automation-legal-aggregate-max",
      "listAllAutomations", {});
    assert.equal(reply.outcome.status, "ok");
    assert.equal(reply.outcome.value.length, 100);
    assert.deepEqual(reply.outcome.value.map(({ agentId }) => agentId).reduce((counts, agentId) => {
      counts[agentId] = (counts[agentId] ?? 0) + 1;
      return counts;
    }, {}), { [BOT_A]: 50, [BOT_B]: 50 });
  });
});

test("native automation orphan and deletion-claimed events cannot poison Bot B aggregate reads", async (t) => {
  await t.test("orphan event", async (st) => {
    const { OpenBotNativeCoordinator } = require(MODULE_PATH);
    const bots = new BotControllerHarness([bot(BOT_B)]);
    const automations = new AutomationControllerHarness();
    const aggregateGate = automations.hold("listAllAutomations");
    automations.setResponse("listAllAutomations", [{
      agentId: BOT_B,
      automation: automation(BOT_B),
    }]);
    const coordinator = new OpenBotNativeCoordinator({
      botRuntimeController: bots,
      conversationController: new ConversationHarness(),
      automationController: automations,
    });
    st.after(() => {
      aggregateGate.release();
      coordinator.dispose();
    });
    const port = new PortHarness();
    coordinator.bindPort(port);
    port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
    await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
    const held = request(port, "native-automation-orphan-does-not-poison", "listAllAutomations", {});
    await aggregateGate.entered;
    const listCallsBeforeEvent = bots.calls.filter(([method]) => method === "listBots").length;
    automations.emit("changed", {
      agentId: BOT_C,
      automations: [automation(BOT_C)],
      workflows: [workflow(BOT_C)],
    });
    await waitFor(() => bots.calls.filter(([method]) => method === "listBots").length
      > listCallsBeforeEvent);
    aggregateGate.release();
    assert.deepEqual((await held).outcome, {
      status: "ok",
      value: [{ agentId: BOT_B, automation: automation(BOT_B) }],
    });
    assert.equal(port.frames.some((frame) => frame.family === "agents-automation"
      && frame.payload.agentId === BOT_C), false);
  });

  await t.test("event while another bot is deletion-claimed", async (st) => {
    const { OpenBotNativeCoordinator } = require(MODULE_PATH);
    const bots = new BotControllerHarness([bot(BOT_A), bot(BOT_B)]);
    const automations = new AutomationControllerHarness();
    const aggregateGate = automations.hold("listAllAutomations");
    const deletionEntered = deferred();
    const deletionRelease = deferred();
    automations.setResponse("listAllAutomations", [{
      agentId: BOT_B,
      automation: automation(BOT_B),
    }]);
    const coordinator = new OpenBotNativeCoordinator({
      botRuntimeController: bots,
      conversationController: new ConversationHarness(),
      automationController: automations,
      deleteBots: async (ids) => {
        deletionEntered.resolve();
        await deletionRelease.promise;
        bots.remove(ids);
        return {
          deletedBotIds: [...ids],
          survivingBotIds: [...bots.bots.keys()],
          activeBotId: BOT_B,
        };
      },
    });
    st.after(() => {
      aggregateGate.release();
      deletionRelease.resolve();
      coordinator.dispose();
    });
    const port = new PortHarness();
    coordinator.bindPort(port);
    port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
    await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
    const held = request(port, "native-automation-claimed-event-does-not-poison",
      "listAllAutomations", {});
    await aggregateGate.entered;
    const deleting = request(port, "native-automation-claimed-event-delete",
      "deleteAgents", { ids: [BOT_A] });
    await deletionEntered.promise;
    automations.emit("changed", {
      agentId: BOT_A,
      automations: [automation(BOT_A)],
      workflows: [workflow(BOT_A)],
    });
    await new Promise((resolve) => setImmediate(resolve));
    aggregateGate.release();
    const aggregateReply = await held;
    deletionRelease.resolve();
    const deletionReply = await deleting;
    assert.deepEqual(aggregateReply.outcome, {
      status: "ok",
      value: [{ agentId: BOT_B, automation: automation(BOT_B) }],
    });
    assert.equal(deletionReply.outcome.status, "ok");
    assert.equal(port.frames.some((frame) => frame.family === "agents-automation"
      && frame.payload.agentId === BOT_A), false);
  });
});

test("malformed, duplicate, and oversized frames close only their port while unsupported methods fail explicitly", async (t) => {
  const { OpenBotNativeCoordinator } = require(MODULE_PATH);
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
  });
  t.after(() => coordinator.dispose());

  const premature = new PortHarness();
  coordinator.bindPort(premature);
  premature.receive({ kind: "request", requestId: "r-early", method: "listAgents", args: null });
  await waitFor(() => premature.closed === 1);
  assert.deepEqual(premature.frames, [{
    kind: "lifecycle",
    phase: "shutdown",
    reason: "protocol-error",
    detail: "hello-required",
  }]);

  const port = new PortHarness();
  const unbind = coordinator.bindPort(port);
  port.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => port.frames.some((frame) => frame.family === "agents"));
  const unsupported = await request(port, "r-unsupported", "ensureForeverBox", { id: BOT_A });
  assert.deepEqual(unsupported, {
    kind: "reply",
    requestId: "r-unsupported",
    outcome: {
      status: "failed",
      failure: {
        code: "source/capability-unavailable",
        message: "unknown gateway method: ensureForeverBox",
      },
    },
  });
  assert.equal(port.closed, 0);

  for (const [requestId, method, args] of [
    ["r-delete-unavailable", "deleteAgents", { ids: [BOT_A] }],
    ["r-attachment-unavailable", "sendPrompt", {
      agentId: BOT_A,
      prompt: "Use this attachment.",
      clientNonce: "nonce-attachment-unavailable",
      directAddressedAcceptance: true,
      attachmentPaths: ["/tmp/example.txt"],
      attachmentNames: ["example.txt"],
    }],
  ]) {
    assert.deepEqual((await request(port, requestId, method, args)).outcome, {
      status: "failed",
      failure: {
        code: "source/capability-unavailable",
        message: `unknown gateway method: ${method}`,
      },
    });
  }

  await request(port, "r-once", "countAgents");
  port.receive({ kind: "request", requestId: "r-once", method: "countAgents", args: null });
  await waitFor(() => port.closed === 1);
  assert.deepEqual(port.frames.at(-1), {
    kind: "lifecycle",
    phase: "shutdown",
    reason: "protocol-error",
    detail: "duplicate-request-id",
  });
  assert.equal(port.listenerCount("message"), 0);
  unbind();
  assert.equal(port.closed, 1, "the returned disposer must be idempotent");

  const oversized = new PortHarness();
  coordinator.bindPort(oversized);
  oversized.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => oversized.frames.some((frame) => frame.family === "agents"));
  oversized.receive({
    kind: "request",
    requestId: `r-${"x".repeat(4096)}`,
    method: "countAgents",
    args: null,
  });
  await waitFor(() => oversized.closed === 1);
  assert.equal(oversized.frames.at(-1).detail, "malformed-frame");

  const alive = new PortHarness();
  coordinator.bindPort(alive);
  alive.receive({ kind: "lifecycle", phase: "hello", protocolVersion: 1 });
  await waitFor(() => alive.frames.some((frame) => frame.family === "agents"));
  assert.equal((await request(alive, "r-alive", "countAgents")).outcome.value, 1,
    "one hostile connection must not dispose the coordinator or other ports");
  coordinator.dispose();
  assert.equal(alive.listenerCount("message"), 0);
  assert.equal(conversations.listenerCount("event"), 0);
  assert.equal(bots.listenerCount("bot-changed"), 0);
});
