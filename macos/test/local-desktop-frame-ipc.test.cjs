"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const frameIpcPath = "../src/desktop/local-desktop-frame-ipc.cjs";
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function computer(botId, targetId, generation = 1, state = "ready", mode = "local") {
  return Object.freeze({
    botId,
    computer: Object.freeze({
      mode,
      generation,
      localProfileId: targetId,
      nativeAgentId: null,
      state,
      lastConfirmedAt: "2026-08-16T12:00:00.000Z",
      lastErrorCode: null,
    }),
  });
}

function ipcEvent(sender, senderFrame = sender.mainFrame) {
  return { sender, senderFrame };
}

function frame(botId, targetId, generation, frameId, byte = 1) {
  return Object.freeze({
    botId,
    targetId,
    targetGeneration: generation,
    frameId,
    width: 640,
    height: 400,
    mimeType: "image/png",
    bytes: Uint8Array.from([byte, byte + 1, byte + 2]),
  });
}

function frameEvents(value) {
  return value.first.sent.filter((entry) => entry.channel === "openbot-local-frame:frame");
}

function statusEvents(value) {
  return value.first.sent.filter((entry) => entry.channel === "openbot-local-frame:status");
}

function fixture({ captureDisplayFrame, read } = {}) {
  const handlers = new Map();
  const timers = [];
  const windows = [];
  function makeWindow() {
    const sent = [];
    const sender = new EventEmitter();
    sender.destroyed = false;
    sender.isDestroyed = () => sender.destroyed;
    sender.mainFrame = {
      destroyed: false,
      isDestroyed() { return this.destroyed; },
    };
    sender.send = (channel, value) => sent.push({ channel, value });
    const window = {
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      webContents: sender,
    };
    windows.push(window);
    return { sender, sent, window };
  }
  const first = makeWindow();
  const second = makeWindow();
  const electron = {
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(sender) { return windows.find((entry) => entry.webContents === sender) ?? null; },
    },
  };
  const states = new Map([
    [BOT_A, computer(BOT_A, LOCAL_A)],
    [BOT_B, computer(BOT_B, LOCAL_B)],
  ]);
  const readCalls = [];
  class Boundary extends EventEmitter {
    async read(botId) {
      readCalls.push(botId);
      return read ? read(botId, readCalls.length) : states.get(botId);
    }
  }
  const computerBoundary = new Boundary();
  const manager = {
    ownedWindows: new Set(),
    openCalls: [],
    captureCalls: [],
    ownsWindow(window) { return this.ownedWindows.has(window); },
    async open(record) { this.openCalls.push(record); },
    async captureDisplayFrame(identity) {
      this.captureCalls.push(identity);
      if (captureDisplayFrame) return captureDisplayFrame(identity, this.captureCalls.length);
      return frame(identity.botId, identity.targetId, identity.targetGeneration, `frame-${this.captureCalls.length}`);
    },
  };
  function setIntervalFn(callback, milliseconds) {
    const timer = { callback, milliseconds, cleared: false };
    timers.push(timer);
    return timer;
  }
  function clearIntervalFn(timer) { timer.cleared = true; }
  return {
    computerBoundary,
    electron,
    first,
    handlers,
    manager,
    readCalls,
    second,
    states,
    timers,
    setIntervalFn,
    clearIntervalFn,
  };
}

test("sender-scoped selection drops an old bot frame before awaiting and sends exact bounded data only to its window", async () => {
  const aFrame = deferred();
  const value = fixture({
    captureDisplayFrame(identity) {
      if (identity.botId === BOT_A) return aFrame.promise;
      return frame(BOT_B, LOCAL_B, 1, "frame-b", 7);
    },
  });
  const {
    LOCAL_DESKTOP_FRAME_CHANNELS,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);

  const firstSelection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
    ipcEvent(value.first.sender),
    { botId: BOT_A, viewGeneration: 1 },
  );
  await tick();
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
    ipcEvent(value.first.sender),
    { botId: BOT_B, viewGeneration: 2 },
  );
  await tick();
  aFrame.resolve(frame(BOT_A, LOCAL_A, 1, "frame-a", 3));
  await tick();
  await firstSelection;

  assert.equal(value.second.sent.length, 0);
  assert.equal(frameEvents(value).length, 1);
  assert.equal(frameEvents(value)[0].channel, LOCAL_DESKTOP_FRAME_EVENT_CHANNEL);
  const event = frameEvents(value)[0].value;
  assert.deepEqual(Object.keys(event).sort(), [
    "botId", "bytes", "height", "mimeType", "sequence", "targetGeneration", "targetId", "viewGeneration", "width",
  ]);
  assert.equal(event.botId, BOT_B);
  assert.equal(event.targetId, LOCAL_B);
  assert.equal(event.viewGeneration, 2);
  assert.equal(event.sequence, 1);
  assert.equal(event.bytes instanceof Uint8Array, true);
  assert.doesNotMatch(JSON.stringify({ ...event, bytes: [...event.bytes] }), /https|youtube|Users|partition|workspace|query|token/i);

  await assert.rejects(
    value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
      { sender: {} },
      { botId: BOT_A, viewGeneration: 3 },
    ),
    { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" },
  );
  installed.dispose();
});

test("selection awaits first capture and reports sanitized unavailable status", async () => {
  const held = deferred();
  const value = fixture({ captureDisplayFrame: () => held.promise });
  const {
    LOCAL_DESKTOP_FRAME_CHANNELS,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const pending = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
    ipcEvent(value.first.sender),
    { botId: BOT_A, viewGeneration: 1 },
  );
  assert.equal(
    await Promise.race([pending.then(() => "settled"), tick().then(() => "pending")]),
    "pending",
  );
  const error = Object.assign(new Error("/Users/private token=secret"), {
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  held.reject(error);
  const result = await pending;
  assert.deepEqual(result, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "unavailable",
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  assert.equal(value.first.sent.at(-1).channel, LOCAL_DESKTOP_STATUS_EVENT_CHANNEL);
  assert.deepEqual(value.first.sent.at(-1).value, result);
  assert.doesNotMatch(JSON.stringify(value.first.sent), /Users|token|secret/);
  installed.dispose();
});

test("retry invalidates the old timer and cannot publish its late frame", async () => {
  const first = deferred();
  const value = fixture({
    captureDisplayFrame(identity, call) {
      if (call === 1) return first.promise;
      return frame(identity.botId, identity.targetId, identity.targetGeneration, "frame-fresh", 9);
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const select = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select);
  const retry = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry);
  const selected = select(ipcEvent(value.first.sender), { botId: BOT_A, viewGeneration: 1 });
  await tick();
  const retried = retry(ipcEvent(value.first.sender), { botId: BOT_A, viewGeneration: 2 });
  first.resolve(frame(BOT_A, LOCAL_A, 1, "stale", 1));
  await Promise.allSettled([selected, retried]);
  assert.equal(value.first.sent.some(({ channel, value: sent }) =>
    channel === "openbot-local-frame:frame" && sent.viewGeneration === 1), false);
  assert.equal(value.first.sent.some(({ channel, value: sent }) =>
    channel === "openbot-local-frame:frame" && sent.viewGeneration === 2), true);
  installed.dispose();
});

test("synchronous duplicate select and retry calls share the exact Promise", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const select = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select);
  const retry = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry);
  const selected = select(event, { botId: BOT_A, viewGeneration: 1 });
  const duplicateSelection = select(event, { botId: BOT_A, viewGeneration: 1 });
  assert.strictEqual(duplicateSelection, selected);
  await selected;
  const retried = retry(event, { botId: BOT_A, viewGeneration: 2 });
  const duplicateRetry = retry(event, { botId: BOT_A, viewGeneration: 2 });
  assert.strictEqual(duplicateRetry, retried);
  await retried;
  installed.dispose();
});

test("connecting, retrying, and terminal status events precede their awaited returns", async () => {
  const first = deferred();
  const value = fixture({ captureDisplayFrame: (_identity, call) => call === 1 ? first.promise : frame(BOT_A, LOCAL_A, 1, "frame-retry", 7) });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const selected = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  await tick();
  assert.deepEqual(statusEvents(value).map((entry) => entry.value.state), ["connecting"]);
  first.reject(Object.assign(new Error("private token"), { code: "OPENBOT_LOCAL_CAPTURE_FAILED" }));
  const unavailable = await selected;
  assert.equal(unavailable.state, "unavailable");
  const retried = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry)(event, { botId: BOT_A, viewGeneration: 2 });
  await retried;
  assert.deepEqual(statusEvents(value).map((entry) => entry.value.state), ["connecting", "unavailable", "retrying", "live"]);
  installed.dispose();
});

test("capture completion racing retry or clear cannot publish a late frame or status", async () => {
  const held = deferred();
  const value = fixture({ captureDisplayFrame: (_identity, call) => call === 1 ? held.promise : frame(BOT_A, LOCAL_A, 1, "frame-fresh", 8) });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const selected = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  await tick();
  const cleared = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(event, { viewGeneration: 2 });
  held.resolve(frame(BOT_A, LOCAL_A, 1, "frame-stale", 3));
  await Promise.all([selected, cleared]);
  assert.equal(frameEvents(value).some((entry) => entry.value.viewGeneration === 1), false);
  assert.equal(statusEvents(value).some((entry) => entry.value.viewGeneration === 1 && entry.value.state === "unavailable"), false);
  installed.dispose();
});

test("equal clear wins over a retry and adjacent retry remains isolated", async () => {
  const held = deferred();
  const value = fixture({ captureDisplayFrame: (_identity, call) => call === 1 ? frame(BOT_A, LOCAL_A, 1, "frame-first", 1) : held.promise });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  const retry = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry)(event, { botId: BOT_A, viewGeneration: 2 });
  const clear = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(event, { viewGeneration: 2 });
  held.resolve(frame(BOT_A, LOCAL_A, 1, "frame-stale-retry", 2));
  await Promise.allSettled([retry, clear]);
  assert.equal(frameEvents(value).some((entry) => entry.value.viewGeneration === 2), false);
  const adjacentRetry = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry)(event, { botId: BOT_A, viewGeneration: 3 });
  await adjacentRetry;
  assert.equal(frameEvents(value).some((entry) => entry.value.viewGeneration === 3), true);
  installed.dispose();
});

test("a held timer capture is silent after invalidation", async () => {
  const held = deferred();
  const value = fixture({ captureDisplayFrame: (_identity, call) => call === 1 ? frame(BOT_A, LOCAL_A, 1, "frame-first", 1) : held.promise });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  value.timers[0].callback();
  await tick();
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(event, { viewGeneration: 2 });
  held.resolve(frame(BOT_A, LOCAL_A, 1, "frame-late", 9));
  await tick();
  assert.equal(value.timers[0].cleared, true);
  assert.equal(frameEvents(value).some((entry) => entry.value.frameId === "frame-late"), false);
  assert.equal(statusEvents(value).some((entry) => entry.value.state === "unavailable"), false);
  installed.dispose();
});

test("dispose before readiness suppresses pending status and frame publication", async () => {
  const readiness = deferred();
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc({ ...value, ready: readiness.promise });
  const pending = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
    ipcEvent(value.first.sender),
    { botId: BOT_A, viewGeneration: 1 },
  );
  installed.dispose();
  readiness.resolve();
  await assert.rejects(pending, { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" });
  assert.equal(value.first.sent.length, 0);
});

test("deletion errors fence a pending capture without publishing terminal status", async () => {
  const held = deferred();
  const value = fixture({ captureDisplayFrame: () => held.promise });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const selected = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  await tick();
  value.computerBoundary.read = async (botId) => {
    value.readCalls.push(botId);
    const error = new Error("private /Users/token");
    error.code = "OPENBOT_COMPUTER_BOT_DELETING";
    throw error;
  };
  held.resolve(frame(BOT_A, LOCAL_A, 1, "frame-before-delete", 4));
  await selected;
  assert.equal(frameEvents(value).some((entry) => entry.value.frameId === "frame-before-delete"), false);
  assert.equal(statusEvents(value).some((entry) => entry.value.state === "unavailable"), false);
  installed.dispose();
});

test("sender view-generation high-water rejects stale or conflicting selects without replacing the current bot", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const select = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select);
  const clear = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear);
  const event = ipcEvent(value.first.sender);

  await select(event, { botId: BOT_B, viewGeneration: 3 });
  await tick();
  assert.equal(value.first.sent.every((entry) => entry.value.botId === BOT_B), true);
  const bTimer = value.timers[0];
  const effectsBeforeStale = value.readCalls.length;

  for (const request of [
    { botId: BOT_A, viewGeneration: 2 },
    { botId: BOT_A, viewGeneration: 3 },
  ]) {
    await assert.rejects(select(event, request), {
      code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED",
      message: "OpenBot Local Desktop frame operation failed.",
    });
  }
  await tick();
  assert.equal(value.readCalls.length, effectsBeforeStale);
  assert.equal(value.timers.length, 1);
  assert.equal(bTimer.cleared, false);
  assert.equal(value.manager.openCalls.every((record) => record.botId === BOT_B), true);
  assert.equal(value.manager.captureCalls.every((identity) => identity.botId === BOT_B), true);
  assert.equal(value.first.sent.every((entry) => entry.value.botId === BOT_B), true);

  await clear(event, { viewGeneration: 4 });
  assert.equal(bTimer.cleared, true);
  const readsAfterClear = value.readCalls.length;
  await assert.rejects(select(event, { botId: BOT_A, viewGeneration: 3 }), {
    code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED",
  });
  assert.equal(value.readCalls.length, readsAfterClear);
  assert.equal(value.timers.length, 1);
  installed.dispose();
});

test("non-local or not-ready selection returns one fixed unavailable failure before timers or manager effects", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const select = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select);
  const event = ipcEvent(value.first.sender);

  for (const unavailable of [
    { generation: 5, record: computer(BOT_A, LOCAL_A, 1, "not-ready") },
    { generation: 6, record: computer(BOT_A, LOCAL_A, 2, "unconfigured", "not-now") },
  ]) {
    value.states.set(BOT_A, unavailable.record);
    await assert.rejects(
      select(event, { botId: BOT_A, viewGeneration: unavailable.generation }),
      (error) => {
        assert.equal(error.code, "OPENBOT_LOCAL_FRAME_OPERATION_FAILED");
        assert.equal(error.message, "OpenBot Local Desktop frame operation failed.");
        assert.doesNotMatch(String(error.stack), /not-now|Users|private|target/i);
        return true;
      },
    );
  }
  await tick();
  assert.deepEqual(value.readCalls, [BOT_A, BOT_A]);
  assert.equal(value.timers.length, 0);
  assert.equal(value.manager.openCalls.length, 0);
  assert.equal(value.manager.captureCalls.length, 0);
  assert.equal(frameEvents(value).length, 0);

  value.states.set(BOT_A, computer(BOT_A, LOCAL_A));
  await assert.rejects(select(event, { botId: BOT_A, viewGeneration: 4 }), {
    code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED",
  });
  assert.deepEqual(value.readCalls, [BOT_A, BOT_A]);
  installed.dispose();
});

test("hostile destroyed senders and non-main frames fail closed before boundary effects", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const select = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select);
  const request = { botId: BOT_A, viewGeneration: 1 };

  value.first.sender.isDestroyed = () => { throw new Error("private /Users/person token"); };
  await assert.rejects(
    select(ipcEvent(value.first.sender), request),
    (error) => {
      assert.equal(error.code, "OPENBOT_LOCAL_FRAME_OPERATION_FAILED");
      assert.equal(error.message, "OpenBot Local Desktop frame operation failed.");
      assert.doesNotMatch(String(error.stack), /private|Users|token/);
      return true;
    },
  );
  assert.equal(value.readCalls.length, 0);
  value.first.sender.isDestroyed = () => false;

  await assert.rejects(
    select(ipcEvent(value.first.sender, value.second.sender.mainFrame), request),
    { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" },
  );
  assert.equal(value.readCalls.length, 0);

  value.first.sender.mainFrame.destroyed = true;
  await assert.rejects(select(ipcEvent(value.first.sender), request), {
    code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED",
  });
  assert.equal(value.readCalls.length, 0);
  assert.equal(value.timers.length, 0);
  installed.dispose();
});

test("distinct Electron wrappers for one main frame pass while different frame IDs fail closed", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const select = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select);
  const frameWrapper = (routingId) => ({
    processId: 71,
    routingId,
    isDestroyed() { return false; },
  });
  Object.defineProperty(value.first.sender, "mainFrame", {
    configurable: true,
    get() { return frameWrapper(19); },
  });
  const senderFrame = frameWrapper(19);
  assert.notEqual(value.first.sender.mainFrame, senderFrame);

  await select(
    ipcEvent(value.first.sender, senderFrame),
    { botId: BOT_A, viewGeneration: 1 },
  );
  await tick();
  assert.equal(value.timers.length, 1);
  assert.equal(value.timers[0].cleared, false);
  assert.equal(value.readCalls.length > 0, true);
  assert.equal(value.manager.openCalls.length, 1);

  const readsBeforeChild = value.readCalls.length;
  await assert.rejects(
    select(
      ipcEvent(value.first.sender, frameWrapper(20)),
      { botId: BOT_B, viewGeneration: 2 },
    ),
    { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" },
  );
  assert.equal(value.readCalls.length, readsBeforeChild);
  assert.equal(value.timers.length, 1);
  assert.equal(value.timers[0].cleared, false);
  installed.dispose();
});

test("manager-owned hidden Local Desktop windows cannot subscribe to frame bytes", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const select = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select);
  value.manager.ownedWindows.add(value.first.window);

  await assert.rejects(
    select(ipcEvent(value.first.sender), { botId: BOT_A, viewGeneration: 1 }),
    {
      code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED",
      message: "OpenBot Local Desktop frame operation failed.",
    },
  );
  await tick();
  assert.equal(value.readCalls.length, 0);
  assert.equal(value.timers.length, 0);
  assert.equal(value.manager.openCalls.length, 0);
  assert.equal(value.manager.captureCalls.length, 0);
  assert.equal(frameEvents(value).length, 0);

  await select(ipcEvent(value.second.sender), { botId: BOT_B, viewGeneration: 1 });
  await tick();
  assert.equal(value.second.sent.every((entry) => entry.value.botId === BOT_B), true);
  installed.dispose();
});

test("frame bridge captures immediately then throttles without overlap and suppresses duplicate hashes", async () => {
  const secondCapture = deferred();
  const value = fixture({
    captureDisplayFrame(identity, call) {
      if (call === 1) return frame(identity.botId, identity.targetId, 1, "frame-same", 1);
      if (call === 2) return secondCapture.promise;
      return frame(identity.botId, identity.targetId, 1, "frame-changed", 9);
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
    ipcEvent(value.first.sender),
    { botId: BOT_A, viewGeneration: 1 },
  );
  await tick();
  assert.equal(value.manager.captureCalls.length, 1);
  assert.equal(frameEvents(value).length, 1);
  assert.equal(value.timers.length, 1);
  assert.equal(value.timers[0].milliseconds, 1000);

  value.timers[0].callback();
  value.timers[0].callback();
  await tick();
  assert.equal(value.manager.captureCalls.length, 2);
  secondCapture.resolve(frame(BOT_A, LOCAL_A, 1, "frame-same", 1));
  await tick();
  assert.equal(frameEvents(value).length, 1);

  value.timers[0].callback();
  await tick();
  assert.equal(value.manager.captureCalls.length, 3);
  assert.equal(frameEvents(value).length, 2);
  assert.deepEqual(frameEvents(value).map((entry) => entry.value.sequence), [1, 2]);

  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(
    ipcEvent(value.first.sender),
    { viewGeneration: 2 },
  );
  assert.equal(value.timers[0].cleared, true);
  const captures = value.manager.captureCalls.length;
  value.timers[0].callback();
  await tick();
  assert.equal(value.manager.captureCalls.length, captures);

  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
    ipcEvent(value.first.sender),
    { botId: BOT_A, viewGeneration: 3 },
  );
  await tick();
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(
    ipcEvent(value.first.sender),
    { viewGeneration: 2 },
  );
  assert.equal(value.timers[1].cleared, false);
  installed.dispose();
  assert.equal(value.timers[1].cleared, true);
});

test("computer generation changes and renderer destruction invalidate in-flight frames and cleanup every timer", async () => {
  const waiting = deferred();
  const value = fixture({ captureDisplayFrame() { return waiting.promise; } });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const selection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(
    ipcEvent(value.first.sender),
    { botId: BOT_A, viewGeneration: 1 },
  );
  await tick();
  value.states.set(BOT_A, computer(BOT_A, LOCAL_A, 2));
  value.computerBoundary.emit("changed", value.states.get(BOT_A));
  waiting.resolve(frame(BOT_A, LOCAL_A, 1, "stale", 2));
  await tick();
  await selection;
  assert.equal(frameEvents(value).length, 0);
  assert.equal(value.timers.every((timer) => timer.cleared), true);

  value.first.sender.destroyed = true;
  value.first.sender.emit("destroyed");
  installed.dispose();
  assert.equal(value.handlers.size, 0);
  assert.equal(value.computerBoundary.listenerCount("changed"), 0);
});
