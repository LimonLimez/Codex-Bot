"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const MODULE_PATH = "../src/desktop/openbot-native-coordinator.cjs";
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";

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
    const created = structuredClone(bot(BOT_B, {
      name: "New Bot",
      appearance: {
        shape: input?.appearance?.shape ?? "blob",
        color: input?.appearance?.color ?? "blue",
        image: null,
        title: input?.appearance?.title ?? "",
        description: input?.appearance?.description ?? "",
      },
      setupStage: "profile-model",
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

test("protocol v1 hello becomes ready and proactively publishes exact native agent rows", async (t) => {
  const OpenBotNativeCoordinator = loadCoordinator();
  assert.equal(typeof OpenBotNativeCoordinator, "function", "OpenBot native coordinator must exist");
  const bots = new BotControllerHarness();
  const conversations = new ConversationHarness();
  const coordinator = new OpenBotNativeCoordinator({
    botRuntimeController: bots,
    conversationController: conversations,
    deleteBots: async (ids) => bots.remove(ids),
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
    deleteBots: async (ids) => bots.remove(ids),
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
  const unsupported = await request(port, "r-unsupported", "getTrays");
  assert.deepEqual(unsupported, {
    kind: "reply",
    requestId: "r-unsupported",
    outcome: {
      status: "failed",
      failure: {
        code: "source/capability-unavailable",
        message: "unknown gateway method: getTrays",
      },
    },
  });
  assert.equal(port.closed, 0);

  for (const [requestId, method, args] of [
    ["r-delete-unavailable", "deleteAgents", { ids: [BOT_A] }],
    ["r-template-unavailable", "createAgent", {
      name: "Template Bot", description: "", templateId: "vendor-template",
    }],
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
