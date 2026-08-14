const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { ConversationRouter } = require("../src/bots/conversation-router.cjs");
const BOT_ID = "bot-00000000-0000-4000-8000-000000000001";

function recordingChatGPTTransport(responses = {}) {
  const transport = new EventEmitter();
  transport.calls = [];
  transport.request = async (method, params) => {
    transport.calls.push({ method, params });
    if (responses[method] instanceof Error) throw responses[method];
    if (responses[method]) return responses[method](params);
    if (method === "status/read") return { available: true };
    if (method === "model/list") return { models: [{ modelID: "chatgpt-medium" }] };
    if (method === "conversation/create") return { conversationID: "chat-1", snapshot: { conversationID: "chat-1", title: "", content: [], watermark: { streamID: "chat-1", sequence: 0 }, activeTurnID: null, modelID: params.modelID || null } };
    if (method === "conversation/snapshot") return { conversationID: params.conversationID, snapshot: { conversationID: params.conversationID, title: "", content: [], watermark: { streamID: params.conversationID, sequence: params.afterSequence || 0 }, activeTurnID: null, modelID: null } };
    if (method === "message/send") return { conversationID: params.conversationID, turnID: "turn-1" };
    if (method === "turn/cancel") return { conversationID: params.conversationID, turnID: params.turnID };
    if (method === "conversation/select-model") return { conversationID: params.conversationID, modelID: params.modelID };
    if (method === "watermarks/acknowledge") return { watermarks: params.watermarks };
    if (method === "requests/reconcile") return { reconciliations: params.requestIDs.map((requestID) => ({ requestID, status: "accepted", conversationID: "chat-1", turnID: "turn-1", sequence: 1 })) };
    throw new Error(`Unexpected ChatGPT method: ${method}`);
  };
  return transport;
}

function recordingCodexTransport(responses = {}) {
  const transport = new EventEmitter();
  transport.calls = [];
  transport.request = async (method, params, timeoutMs) => {
    transport.calls.push(timeoutMs === undefined ? { method, params } : { method, params, timeoutMs });
    if (responses[method] instanceof Error) throw responses[method];
    if (responses[method]) return responses[method](params);
    if (method === "account/read") return { account: { id: "account-1" } };
    if (method === "model/list") return { data: [{ id: "gpt-5.6" }] };
    if (method === "thread/list") return { data: [{ id: "work-1", name: "Native work" }] };
    if (method === "thread/start") return { thread: { id: "work-1" } };
    if (method === "thread/read") return { thread: { id: params.threadId } };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    if (method === "turn/interrupt") return { threadId: params.threadId, turnId: params.turnId };
    if (method === "thread/name/set") return { thread: { id: params.threadId, name: params.name } };
    throw new Error(`Unexpected Codex method: ${method}`);
  };
  return transport;
}

function rejectingTransport(message) {
  const transport = new EventEmitter();
  transport.calls = [];
  transport.request = async (method, params) => {
    transport.calls.push({ method, params });
    throw new Error(message);
  };
  return transport;
}

function memoryChatStore() {
  const records = new Map();
  return {
    list: async () => [...records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((entry) => ({ ...entry })),
    read: async (conversationId) => records.has(conversationId) ? { ...records.get(conversationId) } : null,
    upsert: async (record) => {
      const stored = { ...record };
      delete stored.source;
      records.set(stored.conversationId, stored);
      return { ...stored };
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleAsyncEvents() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("Chat send creates and sends only through ChatGPT", async () => {
  const chatgpt = recordingChatGPTTransport();
  const codex = rejectingTransport("Codex must not receive Chat sends");
  const ids = ["companion-1", "request-1"];
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => codex, chatStore: memoryChatStore(), makeId: () => ids.shift() });

  const sent = await router.send({
    mode: "chat",
    ref: null,
    text: "hello",
    selection: { modelID: "chatgpt-medium" },
    attachments: [],
  });

  assert.deepEqual(sent.ref, { source: "chatgpt", conversationId: "chat-1" });
  assert.deepEqual(chatgpt.calls.map(({ method }) => method), ["conversation/create", "message/send"]);
  assert.deepEqual(chatgpt.calls, [
    { method: "conversation/create", params: { companionChatID: "companion-1", modelID: "chatgpt-medium" } },
    { method: "message/send", params: { requestID: "request-1", conversationID: "chat-1", content: [{ type: "text", text: "hello" }], attachments: [] } },
  ]);
  assert.deepEqual(codex.calls, []);
});

test("Chat send persists a stable request ID, then terminal events durably advance and acknowledge its watermark", async () => {
  const chatgpt = recordingChatGPTTransport();
  const store = memoryChatStore();
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => rejectingTransport("Codex must remain untouched"), chatStore: store, makeId: () => "request-1" });
  await store.upsert({ conversationId: "chat-1", title: "", preview: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastWatermark: { streamID: "conversation:chat-1", sequence: 2 }, pendingRequests: [] });

  await router.send({ mode: "chat", ref: { source: "chatgpt", conversationId: "chat-1" }, text: "hello", attachments: [], selection: { modelID: "chatgpt-medium" } });
  assert.deepEqual((await store.read("chat-1")).pendingRequests, [{ requestID: "request-1", turnID: "turn-1" }]);

  chatgpt.emit("event", { type: "turnCompleted", eventID: "event-3", conversationID: "chat-1", turnID: "turn-1", sequence: 3, content: [] });
  await settleAsyncEvents();
  const saved = await store.read("chat-1");
  assert.deepEqual(saved.pendingRequests, []);
  assert.deepEqual(saved.lastWatermark, { streamID: "conversation:chat-1", sequence: 3 });
  assert.deepEqual(chatgpt.calls.at(-1), { method: "watermarks/acknowledge", params: { watermarks: [{ streamID: "conversation:chat-1", sequence: 3 }] } });
});

test("Chat restart reconciliation keeps active requests, clears terminal requests, and never calls Codex", async () => {
  const chatgpt = recordingChatGPTTransport({
    "requests/reconcile": (params) => ({ reconciliations: params.requestIDs.map((requestID) => requestID === "request-done"
      ? { requestID, status: "completed", conversationID: "chat-1", turnID: "turn-done", sequence: 8 }
      : { requestID, status: "accepted", conversationID: "chat-1", turnID: "turn-active", sequence: 7 }) }),
  });
  const codex = rejectingTransport("Codex must not receive Chat reconciliation");
  const store = memoryChatStore();
  await store.upsert({ conversationId: "chat-1", title: "", preview: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", pendingRequests: [{ requestID: "request-done", turnID: "turn-done" }, { requestID: "request-active" }] });
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => codex, chatStore: store });

  await router.reconcilePendingRequests();

  assert.deepEqual(chatgpt.calls, [{ method: "requests/reconcile", params: { requestIDs: ["request-done", "request-active"] } }]);
  assert.deepEqual((await store.read("chat-1")).pendingRequests, [{ requestID: "request-active", turnID: "turn-active" }]);
  assert.deepEqual(codex.calls, []);
});

test("drops duplicate or out-of-order Chat events before renderer publication or acknowledgement", async () => {
  const chatgpt = recordingChatGPTTransport();
  const store = memoryChatStore();
  await store.upsert({ conversationId: "chat-1", title: "", preview: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastWatermark: { streamID: "conversation:chat-1", sequence: 5 }, pendingRequests: [] });
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => recordingCodexTransport(), chatStore: store });
  const events = [];
  router.on("event", (event) => events.push(event));

  chatgpt.emit("event", { type: "responseDelta", eventID: "event-5", conversationID: "chat-1", turnID: "turn-1", sequence: 5, content: [{ type: "text", text: "duplicate" }] });
  chatgpt.emit("event", { type: "responseDelta", eventID: "event-4", conversationID: "chat-1", turnID: "turn-1", sequence: 4, content: [{ type: "text", text: "old" }] });
  await settleAsyncEvents();

  assert.deepEqual(events, []);
  assert.deepEqual(chatgpt.calls, []);
});

test("Work send creates a native task and starts only a Codex turn", async () => {
  const chatgpt = rejectingTransport("ChatGPT must not receive Work sends");
  const codex = recordingCodexTransport();
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => codex, chatStore: memoryChatStore() });

  const sent = await router.send({
    mode: "work",
    botId: BOT_ID,
    ref: null,
    text: "inspect this repo",
    attachments: [],
    selection: { modelID: "gpt-5.6" },
    workOptions: { cwd: "/project", approvalPolicy: "never" },
  });

  assert.deepEqual(sent.ref, { source: "codex", threadId: "work-1", botId: BOT_ID });
  assert.deepEqual(codex.calls.map(({ method }) => method), ["thread/start", "turn/start"]);
  assert.equal(codex.calls[0].timeoutMs, 120_000);
  assert.deepEqual(chatgpt.calls, []);
});

test("Chat unavailable fails closed without any Codex call", async () => {
  const codex = recordingCodexTransport();
  const router = new ConversationRouter({ chatgpt: null, codexForBot: async () => codex, chatStore: memoryChatStore() });

  await assert.rejects(router.send({ mode: "chat", ref: null, text: "hello", attachments: [] }), {
    message: "ChatGPT is unavailable",
  });
  assert.deepEqual(codex.calls, []);
});

test("cross-mode refs are rejected before either transport runs", async () => {
  const chatgpt = recordingChatGPTTransport();
  const codex = recordingCodexTransport();
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => codex, chatStore: memoryChatStore() });

  await assert.rejects(router.send({ mode: "work", botId: BOT_ID, ref: { source: "chatgpt", conversationId: "chat-1" }, text: "no", attachments: [] }), {
    message: "Open the Codex task before sending in Work mode.",
  });
  await assert.rejects(router.send({ mode: "chat", ref: { source: "codex", threadId: "work-1", botId: BOT_ID }, text: "no", attachments: [] }), {
    message: "Open the ChatGPT conversation before sending in Chat mode.",
  });
  assert.deepEqual(chatgpt.calls, []);
  assert.deepEqual(codex.calls, []);
});

test("immutable Chat references reject changed native IDs from snapshots, cancellation, and model selection", async () => {
  const chatgpt = recordingChatGPTTransport({
    "conversation/snapshot": () => ({ conversationID: "chat-evil", snapshot: { conversationID: "chat-evil", title: "", content: [], watermark: { streamID: "chat-evil", sequence: 0 }, activeTurnID: null, modelID: null } }),
    "turn/cancel": () => ({ conversationID: "chat-evil" }),
    "conversation/select-model": () => ({ conversationID: "chat-evil" }),
  });
  const store = memoryChatStore();
  await store.upsert({ conversationId: "chat-1", title: "Original", preview: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => recordingCodexTransport(), chatStore: store, makeId: () => "cancel-1" });
  const ref = { source: "chatgpt", conversationId: "chat-1" };

  await assert.rejects(router.read(ref), /changed its native conversation ID/);
  await assert.rejects(router.cancel(ref, "turn-1"), /changed its native conversation ID/);
  await assert.rejects(router.selectModel(ref, "chatgpt-medium"), /changed its native conversation ID/);
  const renamed = await router.rename(ref, "Renamed");
  assert.deepEqual(renamed.ref, ref);
  assert.equal((await store.read("chat-1")).conversationId, "chat-1");
});

test("canonicalizes a Work ref before a pending turn can observe caller mutation", async () => {
  const pendingTurn = deferred();
  const codex = new EventEmitter();
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "turn/start") return pendingTurn.promise;
    throw new Error(`Unexpected Codex method: ${method}`);
  };
  const callerRef = { source: "codex", threadId: "work-1", botId: BOT_ID };
  const router = new ConversationRouter({ chatgpt: rejectingTransport("ChatGPT must remain untouched"), codexForBot: async () => codex, chatStore: memoryChatStore() });

  const sending = router.send({ mode: "work", botId: BOT_ID, ref: callerRef, text: "keep original", attachments: [] });
  await new Promise((resolve) => setImmediate(resolve));
  callerRef.threadId = "work-mutated";
  pendingTurn.resolve({ turn: { id: "turn-1" } });

  const sent = await sending;
  assert.equal(calls[0].params.threadId, "work-1");
  assert.deepEqual(sent.ref, { source: "codex", threadId: "work-1", botId: BOT_ID });
});

test("rejects mismatched Work native IDs for read, send, rename, and cancel", async () => {
  const ref = { source: "codex", threadId: "work-1", botId: BOT_ID };
  const cases = [
    { action: (router) => router.read(ref), method: "thread/read", result: { thread: { id: "work-other" } } },
    { action: (router) => router.send({ mode: "work", botId: BOT_ID, ref, text: "hello", attachments: [] }), method: "turn/start", result: { threadId: "work-other", turn: { id: "turn-1" } } },
    { action: (router) => router.rename(ref, "Renamed"), method: "thread/name/set", result: { thread: { id: "work-other" } } },
    { action: (router) => router.cancel(ref, "turn-1"), method: "turn/interrupt", result: { threadId: "work-other" } },
  ];

  for (const entry of cases) {
    const codex = recordingCodexTransport({ [entry.method]: () => entry.result });
    const router = new ConversationRouter({ chatgpt: rejectingTransport("ChatGPT must remain untouched"), codexForBot: async () => codex, chatStore: memoryChatStore() });
    await assert.rejects(entry.action(router), /Codex changed its native thread ID/);
    assert.deepEqual(codex.calls.map(({ method }) => method), [entry.method]);
  }
});

test("normalizes Chat events and Codex notifications into attributed renderer events", async () => {
  const chatgpt = recordingChatGPTTransport();
  const codex = recordingCodexTransport();
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => codex, chatStore: memoryChatStore() });
  const chatEvent = once(router, "event");
  chatgpt.emit("event", { type: "responseDelta", eventID: "event-1", conversationID: "chat-1", turnID: "turn-1", sequence: 1, content: [{ type: "text", text: "hello" }] });
  assert.deepEqual(await chatEvent, [{
    source: "chatgpt", nativeId: "chat-1", ref: { source: "chatgpt", conversationId: "chat-1" }, type: "responseDelta", eventId: "event-1", turnId: "turn-1", sequence: 1, content: [{ type: "text", text: "hello" }], replacementRange: null, message: null,
  }]);

  const workEvent = once(router, "event");
  await router.status("work", { botId: BOT_ID });
  codex.calls.length = 0;
  codex.emit("notification", { method: "turn/completed", params: { threadId: "work-1", turn: { id: "turn-1", status: "completed" } } });
  assert.deepEqual(await workEvent, [{
    source: "codex", nativeId: "work-1", ref: { source: "codex", threadId: "work-1", botId: BOT_ID }, type: "turn/completed", eventId: null, turnId: "turn-1", sequence: null, content: null, message: { threadId: "work-1", turn: { id: "turn-1", status: "completed" } },
  }]);
});

test("facade status, models, lists, create, read, rename, cancel, and selection stay with their source", async () => {
  const chatgpt = recordingChatGPTTransport();
  const codex = recordingCodexTransport();
  const store = memoryChatStore();
  await store.upsert({ conversationId: "chat-1", title: "Saved Chat", preview: "Preview", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
  const router = new ConversationRouter({ chatgpt, codexForBot: async () => codex, chatStore: store });

  assert.deepEqual(await router.status("chat"), { available: true });
  assert.deepEqual(await router.models("chat"), { models: [{ modelID: "chatgpt-medium" }] });
  assert.deepEqual(await router.list("chat"), [{ conversationId: "chat-1", title: "Saved Chat", preview: "Preview", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" }]);
  assert.deepEqual(await router.list("work", { botId: BOT_ID }), { data: [{ id: "work-1", name: "Native work" }] });
  const chat = await router.create("chat", { modelID: "chatgpt-medium" });
  const work = await router.create("work", { botId: BOT_ID, model: "gpt-5.6" });
  assert.deepEqual(chat.ref, { source: "chatgpt", conversationId: "chat-1" });
  assert.deepEqual(work.ref, { source: "codex", threadId: "work-1", botId: BOT_ID });
  await router.read({ source: "chatgpt", conversationId: "chat-1" });
  await router.read({ source: "codex", threadId: "work-1", botId: BOT_ID });
  await router.rename({ source: "codex", threadId: "work-1", botId: BOT_ID }, "Native rename");
  await router.cancel({ source: "codex", threadId: "work-1", botId: BOT_ID }, "turn-1");
  assert.deepEqual(chatgpt.calls.map(({ method }) => method), ["status/read", "model/list", "conversation/create", "conversation/snapshot"]);
  assert.deepEqual(codex.calls.map(({ method }) => method), ["thread/list", "thread/start", "thread/read", "thread/name/set", "turn/interrupt"]);
});

test("Work catalog reads always send the app-server's required params object", async () => {
  const codex = recordingCodexTransport();
  const router = new ConversationRouter({
    chatgpt: rejectingTransport("ChatGPT must remain untouched"),
    codexForBot: async () => codex,
    chatStore: memoryChatStore(),
  });

  await router.status("work", { botId: BOT_ID });
  await router.models("work", { botId: BOT_ID });
  await router.list("work", { botId: BOT_ID });

  assert.deepEqual(codex.calls, [
    { method: "account/read", params: {} },
    { method: "model/list", params: {} },
    { method: "thread/list", params: { limit: 50, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true } },
  ]);
});

test("Work transcript reads request authoritative turns", async () => {
  const codex = recordingCodexTransport();
  const router = new ConversationRouter({ codexForBot: async () => codex });

  await router.read({ source: "codex", threadId: "work-1", botId: BOT_ID });

  assert.deepEqual(codex.calls, [{ method: "thread/read", params: { threadId: "work-1", includeTurns: true } }]);
});

test("bot-scoped Work operations keep equal thread IDs isolated through exact canonical refs", async () => {
  const botA = "bot-00000000-0000-4000-8000-00000000000a";
  const botB = "bot-00000000-0000-4000-8000-00000000000b";
  const codexA = recordingCodexTransport({
    "thread/start": () => ({ thread: { id: "shared-thread" } }),
  });
  const codexB = recordingCodexTransport({
    "thread/start": () => ({ thread: { id: "shared-thread" } }),
  });
  const lookups = [];
  const router = new ConversationRouter({
    chatgpt: rejectingTransport("ChatGPT must remain untouched"),
    codexForBot: async (botId) => {
      lookups.push(botId);
      return botId === botA ? codexA : botId === botB ? codexB : null;
    },
    chatStore: memoryChatStore(),
  });

  await router.status("work", { botId: botA });
  await router.models("work", { botId: botB });
  await router.list("work", { botId: botA });
  const createdA = await router.create("work", { botId: botA, model: "gpt-5.6" });
  const createdB = await router.create("work", { botId: botB, model: "gpt-5.6" });
  assert.deepEqual(createdA.ref, { source: "codex", threadId: "shared-thread", botId: botA });
  assert.deepEqual(createdB.ref, { source: "codex", threadId: "shared-thread", botId: botB });

  await router.read(createdA.ref);
  await router.read(createdB.ref);
  await router.send({
    mode: "work",
    botId: botA,
    ref: createdA.ref,
    text: "only A",
    attachments: [],
    selection: { modelID: "gpt-5.6" },
    workOptions: {},
  });
  await router.cancel(createdB.ref, "turn-b");

  assert.deepEqual(lookups, [botA, botB, botA, botA, botB, botA, botB, botA, botB]);
  assert.deepEqual(codexA.calls.map(({ method }) => method), [
    "account/read", "thread/list", "thread/start", "thread/read", "turn/start",
  ]);
  assert.deepEqual(codexB.calls.map(({ method }) => method), [
    "model/list", "thread/start", "thread/read", "turn/interrupt",
  ]);
  assert.equal(codexA.calls.at(-1).params.threadId, "shared-thread");
  assert.equal(codexB.calls.at(-1).params.threadId, "shared-thread");
});

test("every Work entry rejects missing unknown non-ready and mismatched bot ownership before transport", async () => {
  const botA = "bot-00000000-0000-4000-8000-00000000000a";
  const botB = "bot-00000000-0000-4000-8000-00000000000b";
  const transport = recordingCodexTransport();
  const lookupCalls = [];
  const router = new ConversationRouter({
    chatgpt: rejectingTransport("ChatGPT must remain untouched"),
    codexForBot: async (botId) => {
      lookupCalls.push(botId);
      if (botId === botA) return transport;
      throw new Error("Remote computer unavailable.");
    },
    chatStore: memoryChatStore(),
  });
  const refA = { source: "codex", threadId: "work-1", botId: botA };

  const missing = [
    () => router.status("work"),
    () => router.models("work", {}),
    () => router.list("work", { botId: "" }),
    () => router.create("work", { model: "gpt-5.6" }),
    () => router.read({ source: "codex", threadId: "work-1" }),
    () => router.send({ mode: "work", ref: refA, text: "x", attachments: [], selection: {}, workOptions: {} }),
    () => router.cancel({ source: "codex", threadId: "work-1" }, "turn-1"),
  ];
  for (const operation of missing) await assert.rejects(operation, /bot/i);
  assert.deepEqual(lookupCalls, []);
  assert.deepEqual(transport.calls, []);

  const unavailable = [
    () => router.status("work", { botId: botB }),
    () => router.models("work", { botId: botB }),
    () => router.list("work", { botId: botB }),
    () => router.create("work", { botId: botB, model: "gpt-5.6" }),
    () => router.read({ source: "codex", threadId: "work-1", botId: botB }),
    () => router.send({ mode: "work", botId: botB, ref: { source: "codex", threadId: "work-1", botId: botB }, text: "x", attachments: [], selection: {}, workOptions: {} }),
    () => router.cancel({ source: "codex", threadId: "work-1", botId: botB }, "turn-1"),
  ];
  for (const operation of unavailable) await assert.rejects(operation, /unavailable/i);
  assert.deepEqual(transport.calls, []);

  await assert.rejects(router.send({
    mode: "work",
    botId: botB,
    ref: refA,
    text: "cross route",
    attachments: [],
    selection: {},
    workOptions: {},
  }), /bot/i);
  assert.equal(lookupCalls.length, unavailable.length);
  assert.deepEqual(transport.calls, []);
});

test("router rejects noncanonical bot IDs before resolver or transport", async () => {
  const codex = recordingCodexTransport();
  let lookupCalls = 0;
  const router = new ConversationRouter({
    codexForBot: async () => { lookupCalls += 1; return codex; },
  });
  const invalidBotIds = ["bot-not-a-uuid", "bot-00000000-0000-0000-0000-000000000000", "BOT-00000000-0000-4000-8000-000000000001"];
  for (const botId of invalidBotIds) {
    await assert.rejects(router.status("work", { botId }), /bot/i);
    await assert.rejects(router.create("work", { botId, model: "gpt-5.6" }), /bot/i);
    await assert.rejects(router.read({ source: "codex", threadId: "work-1", botId }), /bot/i);
  }
  assert.equal(lookupCalls, 0);
  assert.deepEqual(codex.calls, []);
});

test("reserved runtime overrides reject before bot lookup and Chat never resolves a runtime", async () => {
  const botId = "bot-00000000-0000-4000-8000-00000000000a";
  const chatgpt = recordingChatGPTTransport();
  let lookupCalls = 0;
  const router = new ConversationRouter({
    chatgpt,
    codexForBot: async () => { lookupCalls += 1; return recordingCodexTransport(); },
    chatStore: memoryChatStore(),
    makeId: () => "request-1",
  });
  const forbidden = ["provider", "runtimeId", "generation", "endpoint", "authToken", "modulePath", "codexBinary", "localBinary"];

  for (const key of forbidden) {
    await assert.rejects(router.create("work", { botId, model: "gpt-5.6", [key]: "forged" }), /invalid|override/i);
    await assert.rejects(router.send({
      mode: "work",
      botId,
      ref: { source: "codex", threadId: "work-1", botId },
      text: "x",
      attachments: [],
      selection: {},
      workOptions: { [key]: "forged" },
    }), /invalid|override/i);
  }
  assert.equal(lookupCalls, 0);

  await assert.rejects(router.create("chat", { modelID: "chatgpt-medium", botId }), /invalid|bot|runtime/i);
  await assert.rejects(router.send({
    mode: "chat",
    botId,
    ref: null,
    text: "x",
    attachments: [],
    selection: { modelID: "chatgpt-medium" },
    workOptions: {},
  }), /invalid|bot|runtime/i);
  assert.equal(lookupCalls, 0);
  assert.deepEqual(chatgpt.calls, []);

  const sent = await router.send({
    mode: "chat",
    ref: null,
    text: "chat only",
    attachments: [],
    selection: { modelID: "chatgpt-medium" },
    workOptions: {},
  });
  assert.deepEqual(sent.ref, { source: "chatgpt", conversationId: "chat-1" });
  assert.equal(lookupCalls, 0);
});

test("every Work create field is schema-validated before bot lookup and transport", async () => {
  const codex = recordingCodexTransport();
  let lookupCalls = 0;
  const router = new ConversationRouter({
    codexForBot: async () => { lookupCalls += 1; return codex; },
  });
  const invalidOptions = [
    { botId: BOT_ID, clientUserMessageId: "x".repeat(257) },
    { botId: BOT_ID, cwd: {} },
    { botId: BOT_ID, cwd: "x".repeat(4_097) },
    { botId: BOT_ID, approvalPolicy: "always" },
    { botId: BOT_ID, model: "" },
    { botId: BOT_ID, serviceTier: [] },
    { botId: BOT_ID, effort: "x".repeat(129) },
    { botId: BOT_ID, sandbox: "root" },
    { botId: BOT_ID, serviceName: "" },
    { botId: BOT_ID, developerInstructions: "x".repeat(100_001) },
    { botId: BOT_ID, personality: "hostile" },
    { botId: BOT_ID, ephemeral: "yes" },
  ];
  for (const options of invalidOptions) await assert.rejects(router.create("work", options), /invalid/i);
  assert.equal(lookupCalls, 0);
  assert.deepEqual(codex.calls, []);

  await router.create("work", {
    botId: BOT_ID,
    clientUserMessageId: "client-1",
    cwd: null,
    approvalPolicy: "on-request",
    model: "gpt-5.6",
    serviceTier: "standard",
    effort: "high",
    sandbox: "workspace-write",
    serviceName: "codex-bot-work",
    developerInstructions: "Work safely.",
    personality: "friendly",
    ephemeral: false,
  });
  assert.equal(lookupCalls, 1);
  assert.deepEqual(codex.calls[0].params, {
    clientUserMessageId: "client-1",
    cwd: null,
    approvalPolicy: "on-request",
    model: "gpt-5.6",
    serviceTier: "standard",
    effort: "high",
    sandbox: "workspace-write",
    serviceName: "codex-bot-work",
    developerInstructions: "Work safely.",
    personality: "friendly",
    ephemeral: false,
  });
});

test("Work notifications retain bot ownership and stale client notifications stop after replacement", async () => {
  const botId = "bot-00000000-0000-4000-8000-00000000000a";
  const first = recordingCodexTransport();
  Object.defineProperties(first, { runtimeId: { value: "runtime-a" }, generation: { value: 1 } });
  const second = recordingCodexTransport();
  Object.defineProperties(second, { runtimeId: { value: "runtime-b" }, generation: { value: 2 } });
  let current = first;
  const router = new ConversationRouter({
    codexForBot: async () => current,
  });
  const events = [];
  router.on("event", (event) => events.push(event));

  await router.status("work", { botId });
  first.emit("notification", { method: "turn/started", params: { threadId: "shared", turn: { id: "one" } } });
  current = second;
  await router.status("work", { botId });
  first.emit("notification", { method: "turn/completed", params: { threadId: "shared", turn: { id: "stale" } } });
  second.emit("notification", { method: "turn/completed", params: { threadId: "shared", turn: { id: "two" } } });

  assert.deepEqual(events.map(({ ref, turnId }) => ({ ref, turnId })), [
    { ref: { source: "codex", threadId: "shared", botId }, turnId: "one" },
    { ref: { source: "codex", threadId: "shared", botId }, turnId: "two" },
  ]);
  assert.ok(events.every((event) => event.ref.botId === botId));
});

test("hostile router payload objects reject without invoking traps, bot lookup, or transport", async () => {
  const codex = recordingCodexTransport();
  let lookupCalls = 0;
  let getterHits = 0;
  let proxyTrapHits = 0;
  const router = new ConversationRouter({
    chatgpt: recordingChatGPTTransport(),
    codexForBot: async () => { lookupCalls += 1; return codex; },
    chatStore: memoryChatStore(),
  });
  const accessor = { botId: BOT_ID };
  Object.defineProperty(accessor, "provider", {
    enumerable: true,
    get() { getterHits += 1; return "forged"; },
  });
  const proxy = new Proxy({ botId: BOT_ID }, {
    get() { proxyTrapHits += 1; throw new Error("proxy trap must not run"); },
    ownKeys() { proxyTrapHits += 1; throw new Error("proxy trap must not run"); },
  });
  const symbolContext = { botId: BOT_ID };
  symbolContext[Symbol("runtime")] = "forged";
  const inherited = Object.create({ botId: BOT_ID });

  await assert.rejects(router.create("work", proxy), /invalid/i);
  await assert.rejects(router.create("work", accessor), /invalid/i);
  await assert.rejects(router.status("work", symbolContext), /invalid/i);
  await assert.rejects(router.models("work", inherited), /invalid/i);
  await assert.rejects(router.read(proxy), /invalid/i);

  assert.equal(proxyTrapHits, 0);
  assert.equal(getterHits, 0);
  assert.equal(lookupCalls, 0);
  assert.deepEqual(codex.calls, []);
});

test("router disposal detaches Chat and every bot notification listener exactly once", async () => {
  const chatgpt = recordingChatGPTTransport();
  const codexA = recordingCodexTransport();
  const codexB = recordingCodexTransport();
  const botB = "bot-00000000-0000-4000-8000-00000000000b";
  const router = new ConversationRouter({
    chatgpt,
    codexForBot: async (botId) => botId === BOT_ID ? codexA : codexB,
    chatStore: memoryChatStore(),
  });
  const events = [];
  router.on("event", (event) => events.push(event));
  await router.status("work", { botId: BOT_ID });
  await router.status("work", { botId: botB });
  assert.equal(chatgpt.listenerCount("event"), 1);
  assert.equal(codexA.listenerCount("notification"), 1);
  assert.equal(codexB.listenerCount("notification"), 1);

  router.dispose();
  router.dispose();
  assert.equal(chatgpt.listenerCount("event"), 0);
  assert.equal(codexA.listenerCount("notification"), 0);
  assert.equal(codexB.listenerCount("notification"), 0);
  codexA.emit("notification", { method: "turn/completed", params: { threadId: "stale" } });
  chatgpt.emit("event", { type: "responseDelta", conversationID: "stale", sequence: 1 });
  await settleAsyncEvents();
  assert.deepEqual(events, []);
  await assert.rejects(router.status("work", { botId: BOT_ID }), /unavailable/i);
  await assert.rejects(router.status("chat"), /unavailable/i);
});

test("exact client invalidation detaches only the stale bot binding", async () => {
  const first = recordingCodexTransport();
  const replacement = recordingCodexTransport();
  let current = first;
  const router = new ConversationRouter({ codexForBot: async () => current });
  const events = [];
  router.on("event", (event) => events.push(event));
  await router.status("work", { botId: BOT_ID });
  assert.equal(first.listenerCount("notification"), 1);

  router.invalidateWorkClient(BOT_ID, first);
  assert.equal(first.listenerCount("notification"), 0);
  first.emit("notification", { method: "turn/completed", params: { threadId: "stale" } });
  current = replacement;
  await router.status("work", { botId: BOT_ID });
  router.invalidateWorkClient(BOT_ID, first);
  replacement.emit("notification", { method: "turn/completed", params: { threadId: "current" } });

  assert.equal(replacement.listenerCount("notification"), 1);
  assert.deepEqual(events.map(({ ref }) => ref.threadId), ["current"]);
});
