"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const ipcPath = "../src/desktop/standalone-conversation-ipc.cjs";
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const CONVERSATION = "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INVOCATION = "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function ownedWindowFixture() {
  const listeners = new Set();
  let destroyed = false;
  const sender = {
    isDestroyed: () => destroyed,
    send() {},
    once(name, listener) {
      assert.equal(name, "destroyed");
      listeners.add(listener);
    },
  };
  const window = { isDestroyed: () => destroyed, webContents: sender };
  return {
    sender,
    window,
    destroy() {
      destroyed = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("standalone IPC is exact, current-window-only, sanitized, and disposable", async () => {
  const {
    STANDALONE_CHANGE_CHANNEL,
    STANDALONE_EVENT_CHANNEL,
    STANDALONE_IPC_CHANNELS,
    installStandaloneConversationIpc,
  } = require(ipcPath);
  const handlers = new Map();
  const sends = [];
  const sender = { isDestroyed: () => false, send: (...args) => sends.push(args) };
  const window = { isDestroyed: () => false, webContents: sender };
  const electron = {
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(value) { return value === sender ? window : null; },
      getAllWindows() { return [window]; },
    },
  };
  const calls = [];
  class Controller extends EventEmitter {
    list(value) { calls.push(["list", value]); return []; }
    create(value) { calls.push(["create", value]); return { botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "", messageCount: 0 }; }
    read(value) { calls.push(["read", value]); return { botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "", messages: [] }; }
    send(value) { calls.push(["send", value]); return { botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION, generation: 7, status: "streaming" }; }
    cancel(value) { calls.push(["cancel", value]); return { botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION, generation: 7, status: "cancelled" }; }
  }
  const controller = new Controller();
  const installed = installStandaloneConversationIpc({ electron, controller });
  assert.equal(Object.isFrozen(installed), true);
  assert.deepEqual(Object.keys(STANDALONE_IPC_CHANNELS).sort(), ["cancel", "create", "list", "read", "send"]);
  assert.equal(handlers.size, 5);
  const event = { sender };
  assert.deepEqual(await handlers.get(STANDALONE_IPC_CHANNELS.list)(event, BOT_A), []);
  assert.equal((await handlers.get(STANDALONE_IPC_CHANNELS.create)(event, { botId: BOT_A })).conversationId, CONVERSATION);
  assert.equal((await handlers.get(STANDALONE_IPC_CHANNELS.read)(event, { botId: BOT_A, conversationId: CONVERSATION })).messages.length, 0);
  assert.equal((await handlers.get(STANDALONE_IPC_CHANNELS.send)(event, { botId: BOT_A, conversationId: CONVERSATION, text: "hello" })).status, "streaming");
  assert.equal((await handlers.get(STANDALONE_IPC_CHANNELS.cancel)(event, { botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION })).status, "cancelled");
  assert.equal(calls.length, 5);

  await assert.rejects(handlers.get(STANDALONE_IPC_CHANNELS.list)({ sender: {} }, BOT_A), (error) => {
    assert.equal(error.code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
    return true;
  });
  await assert.rejects(
    handlers.get(STANDALONE_IPC_CHANNELS.send)(event, new Proxy({}, {
      ownKeys() { throw new Error("private /Users/person token"); },
    })),
    (error) => {
      assert.equal(error.code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
      assert.doesNotMatch(String(error.stack), /private|Users|token/);
      return true;
    },
  );
  assert.equal(calls.length, 5);

  controller.emit("changed", { botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "hello", messageCount: 1 });
  controller.emit("event", { type: "text-delta", botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION, generation: 7, text: "hi" });
  assert.deepEqual(sends.map(([channel]) => channel), [STANDALONE_CHANGE_CHANNEL]);
  assert.doesNotMatch(JSON.stringify(sends), /endpoint|token|Users|credential/);

  installed.dispose();
  installed.dispose();
  assert.equal(handlers.size, 0);
  controller.emit("event", { type: "text-delta", botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION, generation: 7, text: "late" });
  assert.equal(sends.length, 1);
});

test("standalone IPC rejects hostile controller results before renderer publication", async () => {
  const { STANDALONE_IPC_CHANNELS, installStandaloneConversationIpc } = require(ipcPath);
  const handlers = new Map();
  const sender = { isDestroyed: () => false };
  const window = { isDestroyed: () => false, webContents: sender };
  class Controller extends EventEmitter {
    list() { return [{ botId: BOT_A, conversationId: CONVERSATION, endpoint: "private" }]; }
    create() {}
    read() {}
    send() {}
    cancel() {}
  }
  const installed = installStandaloneConversationIpc({
    controller: new Controller(),
    electron: {
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
      BrowserWindow: { fromWebContents: () => window, getAllWindows: () => [window] },
    },
  });
  await assert.rejects(handlers.get(STANDALONE_IPC_CHANNELS.list)({ sender }, BOT_A), (error) => {
    assert.equal(error.code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
    assert.doesNotMatch(String(error.stack), /private|endpoint/);
    return true;
  });
  installed.dispose();
});

test("standalone IPC rejects a request when its exact main frame navigates during readiness", async () => {
  const { STANDALONE_IPC_CHANNELS, installStandaloneConversationIpc } = require(ipcPath);
  const handlers = new Map();
  const readiness = deferred();
  let calls = 0;
  const originalFrame = {
    processId: 17,
    routingId: 1,
    isDestroyed: () => false,
  };
  const sender = {
    mainFrame: originalFrame,
    isDestroyed: () => false,
    send() {},
  };
  const window = { isDestroyed: () => false, webContents: sender };
  class Controller extends EventEmitter {
    list() { calls += 1; return []; }
    create() { calls += 1; throw new Error("must remain fenced"); }
    read() { calls += 1; throw new Error("must remain fenced"); }
    send() { calls += 1; throw new Error("must remain fenced"); }
    cancel() { calls += 1; throw new Error("must remain fenced"); }
  }
  const installed = installStandaloneConversationIpc({
    controller: new Controller(),
    ready: readiness.promise,
    electron: {
      ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
        removeHandler(channel) { handlers.delete(channel); },
      },
      BrowserWindow: { fromWebContents: () => window, getAllWindows: () => [window] },
    },
  });
  const event = { sender, senderFrame: originalFrame };
  const pending = handlers.get(STANDALONE_IPC_CHANNELS.list)(event, BOT_A);
  const rejected = assert.rejects(pending, { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  await new Promise((resolve) => setImmediate(resolve));
  sender.mainFrame = { processId: 17, routingId: 2, isDestroyed: () => false };
  readiness.resolve();
  await rejected;
  assert.equal(calls, 0);
  await installed.dispose();
});

test("standalone IPC cancels an in-flight send when its exact main frame navigates", async () => {
  const {
    STANDALONE_IPC_CHANNELS,
    installStandaloneConversationIpc,
  } = require(ipcPath);
  const handlers = new Map();
  const sendEntered = deferred();
  const sendGate = deferred();
  const sent = [];
  const cancels = [];
  const originalFrame = {
    processId: 17,
    routingId: 1,
    isDestroyed: () => false,
  };
  const sender = {
    mainFrame: originalFrame,
    isDestroyed: () => false,
    send: (...value) => sent.push(value),
    once() {},
  };
  const window = { isDestroyed: () => false, webContents: sender };
  class Controller extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    async send(value) {
      this.emit("event", {
        type: "text-delta",
        botId: value.botId,
        conversationId: value.conversationId,
        invocationId: INVOCATION,
        generation: 7,
        text: "must stay with the requesting frame",
      });
      sendEntered.resolve();
      await sendGate.promise;
      return {
        botId: value.botId,
        conversationId: value.conversationId,
        invocationId: INVOCATION,
        generation: 7,
        status: "streaming",
      };
    }
    cancel(value) {
      cancels.push(Object.freeze({ ...value }));
      return { ...value, generation: 7, status: "cancelled" };
    }
  }
  const controller = new Controller();
  const installed = installStandaloneConversationIpc({
    controller,
    ready: Promise.resolve(),
    electron: {
      ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
        removeHandler(channel) { handlers.delete(channel); },
      },
      BrowserWindow: { fromWebContents: () => window },
    },
  });
  const sending = handlers.get(STANDALONE_IPC_CHANNELS.send)(
    { sender, senderFrame: originalFrame },
    { botId: BOT_A, conversationId: CONVERSATION, text: "hello" },
  );
  const rejected = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  await sendEntered.promise;
  sender.mainFrame = { processId: 17, routingId: 2, isDestroyed: () => false };
  sendGate.resolve();
  await rejected;
  assert.deepEqual(cancels, [{
    botId: BOT_A,
    conversationId: CONVERSATION,
    invocationId: INVOCATION,
  }]);
  assert.deepEqual(sent, []);
  controller.emit("event", {
    type: "text-delta",
    botId: BOT_A,
    conversationId: CONVERSATION,
    invocationId: INVOCATION,
    generation: 7,
    text: "late",
  });
  assert.deepEqual(sent, []);
  await installed.dispose();
});

test("main-frame navigation releases a no-event hung send from its IPC reservation", async () => {
  const {
    STANDALONE_IPC_CHANNELS,
    installStandaloneConversationIpc,
  } = require(ipcPath);
  const handlers = new Map();
  const firstEntered = deferred();
  const originalFrame = {
    processId: 17,
    routingId: 1,
    isDestroyed: () => false,
  };
  const nextFrame = {
    processId: 17,
    routingId: 1,
    isDestroyed: () => false,
  };
  const sender = new EventEmitter();
  Object.assign(sender, {
    mainFrame: originalFrame,
    isDestroyed: () => false,
    send() {},
  });
  const window = { isDestroyed: () => false, webContents: sender };
  let sends = 0;
  class Controller extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    async send(value) {
      sends += 1;
      if (sends === 1) {
        firstEntered.resolve();
        await new Promise(() => {});
      }
      return {
        botId: value.botId,
        conversationId: value.conversationId,
        invocationId: INVOCATION,
        generation: 7,
        status: "streaming",
      };
    }
    cancel(value) { return { ...value, generation: 7, status: "cancelled" }; }
  }
  const installed = installStandaloneConversationIpc({
    controller: new Controller(),
    ready: Promise.resolve(),
    electron: {
      ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
        removeHandler(channel) { handlers.delete(channel); },
      },
      BrowserWindow: { fromWebContents: () => window },
    },
  });
  const first = handlers.get(STANDALONE_IPC_CHANNELS.send)(
    { sender, senderFrame: originalFrame },
    { botId: BOT_A, conversationId: CONVERSATION, text: "old document" },
  );
  const rejected = assert.rejects(first, { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  await firstEntered.promise;
  sender.mainFrame = nextFrame;
  sender.emit("did-start-navigation", {}, "file:///next", false, true, 17, 1);
  await rejected;

  const accepted = await handlers.get(STANDALONE_IPC_CHANNELS.send)(
    { sender, senderFrame: nextFrame },
    { botId: BOT_A, conversationId: CONVERSATION, text: "new document" },
  );
  assert.equal(accepted.status, "streaming");
  assert.equal(sends, 2);
  await installed.dispose();
});

test("destroying one sender awaits cancellation of only its exact owned invocation", async () => {
  const { STANDALONE_IPC_CHANNELS, installStandaloneConversationIpc } = require(ipcPath);
  const handlers = new Map();
  const a = ownedWindowFixture();
  const b = ownedWindowFixture();
  const windows = [a.window, b.window];
  const cancelGate = deferred();
  const calls = [];
  let nextInvocation = 1;
  class Controller extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    send(value) {
      const suffix = String(nextInvocation++).padStart(12, "0");
      return {
        botId: value.botId,
        conversationId: value.conversationId,
        invocationId: `invocation-bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
        generation: 7,
        status: "streaming",
      };
    }
    async cancel(value) {
      calls.push(Object.freeze({ ...value }));
      if (value.botId === BOT_A) await cancelGate.promise;
      return { ...value, generation: 7, status: "cancelled" };
    }
  }
  const controller = new Controller();
  const installed = installStandaloneConversationIpc({
    controller,
    electron: {
      ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
        removeHandler(channel) { handlers.delete(channel); },
      },
      BrowserWindow: {
        fromWebContents(sender) { return windows.find((entry) => entry.webContents === sender) ?? null; },
      },
    },
  });
  const operationA = await handlers.get(STANDALONE_IPC_CHANNELS.send)({ sender: a.sender }, {
    botId: BOT_A, conversationId: CONVERSATION, text: "A",
  });
  const conversationB = "conversation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const operationB = await handlers.get(STANDALONE_IPC_CHANNELS.send)({ sender: b.sender }, {
    botId: BOT_B, conversationId: conversationB, text: "B",
  });

  a.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    botId: BOT_A,
    conversationId: CONVERSATION,
    invocationId: operationA.invocationId,
  }]);
  let disposed = false;
  const teardown = installed.dispose().then(() => { disposed = true; });
  assert.deepEqual(calls.at(-1), {
    botId: BOT_B,
    conversationId: conversationB,
    invocationId: operationB.invocationId,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);
  cancelGate.resolve();
  await teardown;
  assert.equal(handlers.size, 0);
});

test("sender destruction fences a send accepted late and awaits its exact cancellation", async () => {
  const { STANDALONE_IPC_CHANNELS, installStandaloneConversationIpc } = require(ipcPath);
  const handlers = new Map();
  const owned = ownedWindowFixture();
  const sendGate = deferred();
  const cancelGate = deferred();
  const calls = [];
  class Controller extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    async send(value) {
      await sendGate.promise;
      return {
        botId: value.botId,
        conversationId: value.conversationId,
        invocationId: INVOCATION,
        generation: 9,
        status: "streaming",
      };
    }
    async cancel(value) {
      calls.push(Object.freeze({ ...value }));
      await cancelGate.promise;
      return { ...value, generation: 9, status: "cancelled" };
    }
  }
  const installed = installStandaloneConversationIpc({
    controller: new Controller(),
    electron: {
      ipcMain: {
        handle(channel, handler) { handlers.set(channel, handler); },
        removeHandler(channel) { handlers.delete(channel); },
      },
      BrowserWindow: { fromWebContents: () => owned.window },
    },
  });
  const sending = handlers.get(STANDALONE_IPC_CHANNELS.send)({ sender: owned.sender }, {
    botId: BOT_A, conversationId: CONVERSATION, text: "late",
  });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  await new Promise((resolve) => setImmediate(resolve));
  owned.destroy();
  const teardown = installed.dispose();
  sendGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    botId: BOT_A,
    conversationId: CONVERSATION,
    invocationId: INVOCATION,
  }]);
  let teardownDone = false;
  teardown.then(() => { teardownDone = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(teardownDone, false);
  cancelGate.resolve();
  await rejectedSending;
  await teardown;
});

test("IPC scopes bot changes and early invocation events to one exact live product window", async () => {
  const {
    STANDALONE_CHANGE_CHANNEL,
    STANDALONE_EVENT_CHANNEL,
    STANDALONE_IPC_CHANNELS,
    installStandaloneConversationIpc,
  } = require(ipcPath);
  const handlers = new Map();
  function windowFixture() {
    const sent = [];
    let destroyed = false;
    const destroyedListeners = [];
    const sender = {
      isDestroyed: () => destroyed,
      send: (...args) => sent.push(args),
      once(name, listener) { if (name === "destroyed") destroyedListeners.push(listener); },
    };
    const window = { isDestroyed: () => destroyed, webContents: sender };
    return {
      sent, sender, window,
      destroy() { destroyed = true; for (const listener of destroyedListeners) listener(); },
    };
  }
  const a = windowFixture();
  const b = windowFixture();
  const hidden = windowFixture();
  const windows = [a.window, b.window, hidden.window];
  const electron = {
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    BrowserWindow: {
      fromWebContents(value) { return windows.find((entry) => entry.webContents === value) ?? null; },
      getAllWindows() { return windows; },
    },
  };
  let releaseSend;
  let cancels = 0;
  class Controller extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    async send(value) {
      this.emit("event", {
        type: "text-delta", botId: value.botId, conversationId: value.conversationId,
        invocationId: INVOCATION, generation: 7, text: "first",
      });
      await new Promise((resolve) => { releaseSend = resolve; });
      return { botId: value.botId, conversationId: value.conversationId, invocationId: INVOCATION, generation: 7, status: "streaming" };
    }
    cancel(value) {
      cancels += 1;
      this.emit("event", { type: "cancelled", ...value, generation: 7 });
      return { ...value, generation: 7, status: "cancelled" };
    }
  }
  const controller = new Controller();
  const installed = installStandaloneConversationIpc({ electron, controller });
  await handlers.get(STANDALONE_IPC_CHANNELS.list)({ sender: a.sender }, BOT_A);
  await handlers.get(STANDALONE_IPC_CHANNELS.list)({ sender: b.sender }, BOT_B);
  const pending = handlers.get(STANDALONE_IPC_CHANNELS.send)({ sender: a.sender }, {
    botId: BOT_A, conversationId: CONVERSATION, text: "hello",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(handlers.get(STANDALONE_IPC_CHANNELS.send)({ sender: b.sender }, {
    botId: BOT_A, conversationId: CONVERSATION, text: "race",
  }), { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  controller.emit("changed", {
    botId: BOT_B, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "bot b", messageCount: 0,
  });
  assert.deepEqual(a.sent, []);
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0][0], STANDALONE_CHANGE_CHANNEL);
  assert.deepEqual(hidden.sent, []);
  b.sent.length = 0;
  releaseSend();
  await pending;
  assert.deepEqual(a.sent, [[STANDALONE_EVENT_CHANNEL, {
    type: "text-delta", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION, generation: 7, text: "first",
  }]]);
  assert.deepEqual(b.sent, []);
  assert.deepEqual(hidden.sent, []);

  controller.emit("changed", {
    botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z", status: "streaming", preview: "hello", messageCount: 1,
  });
  assert.equal(a.sent.at(-1)[0], STANDALONE_CHANGE_CHANNEL);
  assert.deepEqual(b.sent, []);
  assert.deepEqual(hidden.sent, []);
  await assert.rejects(handlers.get(STANDALONE_IPC_CHANNELS.cancel)({ sender: b.sender }, {
    botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION,
  }), { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  assert.equal(cancels, 0);
  await handlers.get(STANDALONE_IPC_CHANNELS.cancel)({ sender: a.sender }, {
    botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION,
  });
  assert.equal(cancels, 1);
  assert.equal(a.sent.at(-1)[1].type, "cancelled");

  a.destroy();
  const before = a.sent.length;
  controller.emit("changed", {
    botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:01:00.000Z", status: "idle", preview: "done", messageCount: 1,
  });
  assert.equal(a.sent.length, before);
  installed.dispose();
});

test("newer bot ingress wins when an older read completes late", async () => {
  const { STANDALONE_IPC_CHANNELS, installStandaloneConversationIpc } = require(ipcPath);
  const handlers = new Map();
  const sent = [];
  const sender = { isDestroyed: () => false, send: (...value) => sent.push(value), once() {} };
  const window = { isDestroyed: () => false, webContents: sender };
  let releaseA;
  class Controller extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    async read(value) {
      if (value.botId === BOT_A) await new Promise((resolve) => { releaseA = resolve; });
      return {
        botId: value.botId,
        conversationId: value.conversationId,
        createdAt: "2026-08-16T12:00:00.000Z",
        updatedAt: "2026-08-16T12:00:00.000Z",
        status: "idle",
        preview: "",
        messages: [],
      };
    }
    send() { throw new Error("unused"); }
    cancel() { throw new Error("unused"); }
  }
  const controller = new Controller();
  const installed = installStandaloneConversationIpc({
    controller,
    electron: {
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
      BrowserWindow: { fromWebContents: () => window, getAllWindows: () => [window] },
    },
  });
  const readA = handlers.get(STANDALONE_IPC_CHANNELS.read)({ sender }, { botId: BOT_A, conversationId: CONVERSATION });
  await new Promise((resolve) => setImmediate(resolve));
  await handlers.get(STANDALONE_IPC_CHANNELS.read)({ sender }, { botId: BOT_B, conversationId: CONVERSATION });
  releaseA();
  await readA;
  controller.emit("changed", {
    botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "A", messageCount: 0,
  });
  controller.emit("changed", {
    botId: BOT_B, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "B", messageCount: 0,
  });
  assert.deepEqual(sent.map(([, value]) => value.botId), [BOT_B]);
  installed.dispose();
});

test("IPC binds buffered live terminal and cancel publication to the returned generation", async () => {
  const {
    STANDALONE_EVENT_CHANNEL,
    STANDALONE_IPC_CHANNELS,
    installStandaloneConversationIpc,
  } = require(ipcPath);
  const handlers = new Map();
  const sent = [];
  const sender = { isDestroyed: () => false, send: (...value) => sent.push(value), once() {} };
  const window = { isDestroyed: () => false, webContents: sender };
  let releaseSend;
  let cancelGeneration = 8;
  class Controller extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    async send(value) {
      for (const generation of [6, 7]) this.emit("event", {
        type: "text-delta", botId: value.botId, conversationId: value.conversationId,
        invocationId: INVOCATION, generation, text: `early-${generation}`,
      });
      await new Promise((resolve) => { releaseSend = resolve; });
      return { botId: value.botId, conversationId: value.conversationId, invocationId: INVOCATION, generation: 7, status: "streaming" };
    }
    cancel(value) {
      this.emit("event", { type: "cancelled", ...value, generation: cancelGeneration });
      return { ...value, generation: cancelGeneration, status: "cancelled" };
    }
  }
  const controller = new Controller();
  const installed = installStandaloneConversationIpc({
    controller,
    electron: {
      ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
      BrowserWindow: { fromWebContents: () => window, getAllWindows: () => [window] },
    },
  });
  const pending = handlers.get(STANDALONE_IPC_CHANNELS.send)({ sender }, {
    botId: BOT_A, conversationId: CONVERSATION, text: "hello",
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseSend();
  await pending;
  assert.deepEqual(sent, [[STANDALONE_EVENT_CHANNEL, {
    type: "text-delta", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION, generation: 7, text: "early-7",
  }]]);
  controller.emit("event", {
    type: "text-delta", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION, generation: 8, text: "late-wrong",
  });
  controller.emit("event", {
    type: "completed", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION, generation: 8,
  });
  assert.equal(sent.length, 1);
  await assert.rejects(handlers.get(STANDALONE_IPC_CHANNELS.cancel)({ sender }, {
    botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION,
  }), { code: "OPENBOT_CONVERSATION_OPERATION_FAILED" });
  assert.equal(sent.length, 1);
  cancelGeneration = 7;
  await handlers.get(STANDALONE_IPC_CHANNELS.cancel)({ sender }, {
    botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION,
  });
  assert.equal(sent.at(-1)[1].generation, 7);
  assert.equal(sent.at(-1)[1].type, "cancelled");
  installed.dispose();
});
