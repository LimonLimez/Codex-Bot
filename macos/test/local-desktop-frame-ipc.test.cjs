"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { types } = require("node:util");

const frameIpcPath = "../src/desktop/local-desktop-frame-ipc.cjs";
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SELECTION_RESULT_FIELDS = Object.freeze([
  "botId", "code", "frameId", "frameSequence", "inputSequence", "pageGeneration", "presentation",
  "sessionGeneration", "state", "targetGeneration", "targetId", "viewGeneration",
]);

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

function handled(promise) {
  void promise.catch(() => {});
  return promise;
}

function assertSelectionResult(value, expected) {
  assert.equal(types.isProxy(value), false);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Object.keys(value).sort(), SELECTION_RESULT_FIELDS);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.equal(Reflect.ownKeys(descriptors).every((key) => "value" in descriptors[key]
    && descriptors[key].get === undefined && descriptors[key].set === undefined), true);
  assert.deepEqual(value, expected);
  assert.deepEqual(structuredClone(value), expected);
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
  const manager = new EventEmitter();
  Object.assign(manager, {
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
  });
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

function publicSession(record, sessionGeneration = 4, pageGeneration = 2) {
  return Object.freeze({
    botId: record.botId,
    targetId: record.computer.localProfileId,
    targetGeneration: record.computer.generation,
    sessionGeneration,
    pageGeneration,
    partition: `persist:openbot-local-${record.computer.localProfileId.slice(6)}`,
    workspaceId: `workspace-${record.computer.localProfileId.slice(6)}`,
    surface: Object.freeze({ cssWidth: 1280, cssHeight: 800 }),
    presentations: Object.freeze({
      preview: Object.freeze({ width: 640, height: 400, fps: 1 }),
      interactive: Object.freeze({ width: 960, height: 600 }),
    }),
    state: "ready",
  });
}

function richFrame(identity, {
  frameId = "frame-rich",
  frameSequence = 1,
  sessionGeneration = 4,
  pageGeneration = 2,
  presentation = "preview",
  byte = 1,
} = {}) {
  return Object.freeze({
    botId: identity.botId,
    targetId: identity.targetId,
    targetGeneration: identity.targetGeneration,
    sessionGeneration,
    pageGeneration,
    frameId,
    frameSequence,
    presentation,
    width: presentation === "interactive" ? 960 : 640,
    height: presentation === "interactive" ? 600 : 400,
    mimeType: "image/png",
    bytes: Uint8Array.from([byte, byte + 1, byte + 2]),
  });
}

function enableInteractive(value, overrides = {}) {
  const state = {
    closeCalls: [],
    dispatchCalls: [],
    frameSequences: new Map(),
    interactiveCalls: 0,
    pages: new Map([[BOT_A, 2], [BOT_B, 2]]),
    previewCalls: 0,
  };
  const nextSequence = (botId) => {
    const next = (state.frameSequences.get(botId) || 0) + 1;
    state.frameSequences.set(botId, next);
    return next;
  };
  value.manager.open = async (record) => overrides.open?.(record, state)
    ?? publicSession(record, 4, state.pages.get(record.botId) || 2);
  value.manager.retry = async (record) => overrides.retry?.(record, state)
    ?? publicSession(record, 5, state.pages.get(record.botId) || 2);
  value.manager.capturePreviewFrame = async (identity) => {
    state.previewCalls += 1;
    if (overrides.capturePreviewFrame) return overrides.capturePreviewFrame(identity, state.previewCalls, state);
    const sequence = nextSequence(identity.botId);
    return richFrame(identity, {
      frameId: `frame-preview-${sequence}`,
      frameSequence: sequence,
      pageGeneration: state.pages.get(identity.botId) || 2,
      presentation: "preview",
      byte: sequence,
    });
  };
  value.manager.captureInteractiveFrame = async (identity) => {
    state.interactiveCalls += 1;
    if (overrides.captureInteractiveFrame) {
      return overrides.captureInteractiveFrame(identity, state.interactiveCalls, state);
    }
    const sequence = nextSequence(identity.botId);
    return richFrame(identity, {
      frameId: `frame-interactive-${sequence}`,
      frameSequence: sequence,
      pageGeneration: state.pages.get(identity.botId) || 2,
      presentation: "interactive",
      byte: sequence,
    });
  };
  value.manager.dispatchMouseEvent = async (input) => {
    state.dispatchCalls.push(input);
    if (overrides.dispatchMouseEvent) return overrides.dispatchMouseEvent(input, state);
    return Object.freeze({
      botId: input.botId,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
      sessionGeneration: input.sessionGeneration,
      pageGeneration: input.pageGeneration,
      frameId: input.frameId,
      frameSequence: input.frameSequence,
      inputSequence: input.inputSequence,
    });
  };
  value.manager.dispatchKeyEvent = async (input) => {
    state.dispatchCalls.push(input);
    if (overrides.dispatchKeyEvent) return overrides.dispatchKeyEvent(input, state);
    return value.manager.dispatchMouseEvent(input);
  };
  value.manager.insertText = async (input) => {
    state.dispatchCalls.push(input);
    if (overrides.insertText) return overrides.insertText(input, state);
    return value.manager.dispatchMouseEvent(input);
  };
  value.manager.imeSetComposition = async (input) => {
    state.dispatchCalls.push(input);
    if (overrides.imeSetComposition) return overrides.imeSetComposition(input, state);
    return value.manager.dispatchMouseEvent(input);
  };
  value.manager.close = async (botId) => {
    state.closeCalls.push(botId);
    return overrides.close?.(botId, state);
  };
  return state;
}

async function prepareInteractive(value, sender = value.first.sender, botId = BOT_A, viewGeneration = 1) {
  const { LOCAL_DESKTOP_FRAME_CHANNELS } = require(frameIpcPath);
  const record = value.states.get(botId);
  const event = ipcEvent(sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId, viewGeneration });
  const request = Object.freeze({
    botId,
    targetId: record.computer.localProfileId,
    targetGeneration: record.computer.generation,
    sessionGeneration: 4,
    pageGeneration: 2,
    viewGeneration,
  });
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(event, {
    ...request,
    presentation: "interactive",
  });
  const frameValue = sender === value.first.sender
    ? frameEvents(value).at(-1).value
    : value.second.sent.filter((entry) => entry.channel === "openbot-local-frame:frame").at(-1).value;
  const lease = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(event, request);
  return { event, frame: frameValue, lease, request };
}

function holdFirstManagerOpen(value, { reject = false } = {}) {
  const entered = deferred();
  const release = deferred();
  const firstSettled = deferred();
  const active = new Set();
  const openCalls = [];
  const sessionGenerations = new Map();
  let count = 0;
  const interactiveState = enableInteractive(value, {
    async open(record) {
      count += 1;
      const call = count;
      const token = `${record.botId}:${record.computer.generation}`;
      openCalls.push(token);
      if (call === 1) {
        entered.resolve();
        await release.promise;
        if (reject) {
          firstSettled.resolve();
          throw Object.assign(new Error("held open rejected"), { code: "OPENBOT_LOCAL_BROWSER_UNAVAILABLE" });
        }
      }
      const sessionGeneration = (sessionGenerations.get(record.botId) || 3) + 1;
      sessionGenerations.set(record.botId, sessionGeneration);
      active.add(token);
      if (call === 1) firstSettled.resolve();
      return publicSession(record, sessionGeneration, 2);
    },
    async close(botId) {
      await firstSettled.promise;
      for (const token of [...active]) {
        if (token.startsWith(`${botId}:`)) active.delete(token);
      }
    },
    capturePreviewFrame(identity, call) {
      return richFrame(identity, {
        frameId: `frame-held-open-${call}`,
        frameSequence: call,
        sessionGeneration: sessionGenerations.get(identity.botId) || 4,
      });
    },
  });
  return { active, entered, interactiveState, openCalls, release };
}

function holdManagerOpenCalls(value, { heldCalls = [1, 2], rejectedCalls = [] } = {}) {
  const gates = new Map();
  const active = new Map();
  const openCalls = [];
  let count = 0;
  const gate = (call) => {
    if (!gates.has(call)) gates.set(call, { entered: deferred(), release: deferred() });
    return gates.get(call);
  };
  const interactiveState = enableInteractive(value, {
    async open(record) {
      count += 1;
      const call = count;
      openCalls.push(`${record.botId}:${record.computer.generation}:${call}`);
      if (heldCalls.includes(call)) {
        gate(call).entered.resolve();
        await gate(call).release.promise;
      }
      if (rejectedCalls.includes(call)) {
        throw Object.assign(new Error("held sibling open rejected"), { code: "OPENBOT_LOCAL_BROWSER_UNAVAILABLE" });
      }
      active.set(call, record.botId);
      return publicSession(record, 4, 2);
    },
    close(botId) {
      for (const [call, activeBotId] of active) {
        if (activeBotId === botId) active.delete(call);
      }
    },
    capturePreviewFrame(identity, call) {
      return richFrame(identity, {
        frameId: `frame-sibling-open-${call}`,
        frameSequence: call,
        sessionGeneration: 4,
      });
    },
  });
  return {
    activeBots: () => [...active.values()].sort(),
    entered: (call) => gate(call).entered.promise,
    interactiveState,
    openCalls,
    release: (call) => gate(call).release.resolve(),
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
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.deepEqual(Object.keys(result).sort(), [
    "botId", "code", "state", "targetGeneration", "targetId", "viewGeneration",
  ]);
  assert.equal("sessionGeneration" in result, false);
  assert.equal("pageGeneration" in result, false);
  assert.equal("presentation" in result, false);
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

test("interactive frame IPC exposes rich generations, owns one control lease, and coalesces input capture", async () => {
  const { LOCAL_DESKTOP_FRAME_CHANNELS, LOCAL_DESKTOP_FRAME_EVENT_CHANNEL, LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const handlers = new Map();
  const sent = [];
  const sender = new EventEmitter();
  const senderFrame = { processId: 31, routingId: 47, isDestroyed: () => false };
  sender.mainFrame = senderFrame;
  sender.isDestroyed = () => false;
  sender.send = (channel, value) => sent.push({ channel, value });
  const window = { isDestroyed: () => false, webContents: sender };
  const computerRecord = computer(BOT_A, LOCAL_A, 7);
  let captureCalls = 0;
  let currentPageGeneration = 2;
  const manager = {
    ownsWindow() { return false; },
    async open() {
      return {
        botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
        sessionGeneration: 4, pageGeneration: currentPageGeneration,
        partition: "persist:openbot-local-private", workspaceId: "workspace-private",
        surface: { cssWidth: 1280, cssHeight: 800 },
        presentations: {
          preview: { width: 640, height: 400, fps: 1 },
          interactive: { width: 960, height: 600 },
        },
      };
    },
    async captureInteractiveFrame() {
      captureCalls += 1;
      return {
        botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
        sessionGeneration: 4, pageGeneration: currentPageGeneration,
        frameId: `frame-rich-${captureCalls}`, frameSequence: 9 + captureCalls,
        presentation: "interactive", width: 960, height: 600,
        mimeType: "image/png", bytes: Uint8Array.from([captureCalls]),
      };
    },
    async capturePreviewFrame() {
      return {
        botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
        sessionGeneration: 4, pageGeneration: currentPageGeneration,
        frameId: "frame-preview", frameSequence: 9,
        presentation: "preview", width: 640, height: 400,
        mimeType: "image/png", bytes: Uint8Array.from([9]),
      };
    },
    async dispatchMouseEvent(value) {
      return { ...value, sessionGeneration: 4, pageGeneration: 2, frameId: value.frameId,
        frameSequence: value.frameSequence, inputSequence: value.inputSequence };
    },
    async navigate(value) {
      assert.equal(value.sessionGeneration, 4);
      currentPageGeneration = 3;
      return {
        botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
        sessionGeneration: 4, pageGeneration: currentPageGeneration,
      };
    },
    async goBack(value) {
      assert.equal(value.sessionGeneration, 4);
      assert.equal(value.pageGeneration, 3);
      currentPageGeneration = 4;
      return { ...value, pageGeneration: 4 };
    },
  };
  const boundary = new EventEmitter();
  boundary.read = async () => computerRecord;
  const electron = {
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { fromWebContents(value) { return value === sender ? window : null; } },
  };
  const installed = installLocalDesktopFrameIpc({ electron, manager, computerBoundary: boundary });
  const event = { sender, senderFrame };

  await handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  const frame = sent.find((entry) => entry.channel === LOCAL_DESKTOP_FRAME_EVENT_CHANNEL).value;
  assert.deepEqual(Object.keys(frame).sort(), [
    "botId", "bytes", "height", "mimeType", "sequence", "targetGeneration", "targetId", "viewGeneration", "width",
  ]);
  assert.equal(frame.sequence, 1);

  await handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(event, {
    botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
    sessionGeneration: 4, pageGeneration: 2, viewGeneration: 1, presentation: "interactive",
  });
  const interactive = sent.filter((entry) => entry.channel === LOCAL_DESKTOP_FRAME_EVENT_CHANNEL).at(-1).value;
  let lease;
  try {
    lease = await handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(event, {
      botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
      sessionGeneration: 4, pageGeneration: 2, viewGeneration: 1,
    });
  } catch (error) {
    throw error;
  }
  assert.equal(lease.controlGeneration, 1);
  const input = {
    botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
    sessionGeneration: 4, pageGeneration: 2, viewGeneration: 1,
    frameId: interactive.frameId, frameSequence: interactive.frameSequence,
    inputSequence: 1, controlGeneration: lease.controlGeneration,
    type: "mouseMoved", x: 10, y: 20,
  };
  await handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(event, input);
  assert.equal(captureCalls >= 2, true);
  assert.equal(sent.filter((entry) => entry.channel === LOCAL_DESKTOP_STATUS_EVENT_CHANNEL).at(-1).value.inputSequence, 1);
  await handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.releaseControl)(event, {
    botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
    sessionGeneration: 4, pageGeneration: 2, viewGeneration: 1,
    controlGeneration: lease.controlGeneration,
  });

  const navigation = await handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.navigate)(event, {
    botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
    sessionGeneration: 4, pageGeneration: 2, viewGeneration: 1,
    url: "https://example.com/next",
  });
  assert.equal(navigation.pageGeneration, 3);
  assert.equal(sent.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), true);
  await handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.goBack)(event, {
    botId: BOT_A, targetId: LOCAL_A, targetGeneration: 7,
    sessionGeneration: 4, pageGeneration: 3, viewGeneration: 1,
  });

  installed.dispose();
});

test("retry uses the manager retry lifecycle when the interactive core provides it", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  let retryCalls = 0;
  value.manager.retry = async (record) => {
    retryCalls += 1;
    assert.equal(record.botId, BOT_A);
  };
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry)(event, { botId: BOT_A, viewGeneration: 2 });
  assert.equal(retryCalls, 1);
  installed.dispose();
});

test("external manager frame and navigation events fence stale control and republish the current presentation", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_CHANNELS,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const oldFrame = current.frame;
  const oldLease = current.lease.controlGeneration;

  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    frameId: "frame-external",
    frameSequence: oldFrame.frameSequence + 1,
  });
  await assert.rejects(
    value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
      ...current.request,
      frameId: oldFrame.frameId,
      frameSequence: oldFrame.frameSequence,
      inputSequence: 1,
      controlGeneration: oldLease,
      type: "mouseMoved",
      x: 4,
      y: 5,
    }),
    { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" },
  );
  await tick();
  const refreshed = frameEvents(value).at(-1).value;
  assert.equal(refreshed.frameSequence > oldFrame.frameSequence, true);
  assert.equal(refreshed.pageGeneration, 2);
  const refreshedRequest = { ...current.request, pageGeneration: 2 };
  const replacementLease = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(current.event, refreshedRequest);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
    ...refreshedRequest,
    frameId: refreshed.frameId,
    frameSequence: refreshed.frameSequence,
    inputSequence: 1,
    controlGeneration: replacementLease.controlGeneration,
    type: "mouseMoved",
    x: 6,
    y: 7,
  });

  interactiveState.pages.set(BOT_A, 3);
  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/external",
  });
  await assert.rejects(
    value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
      ...refreshedRequest,
      frameId: refreshed.frameId,
      frameSequence: refreshed.frameSequence,
      inputSequence: 2,
      controlGeneration: replacementLease.controlGeneration,
      type: "mouseMoved",
      x: 8,
      y: 9,
    }),
    { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" },
  );
  await tick();
  const navigatedFrame = frameEvents(value).at(-1).value;
  const navigation = value.first.sent
    .filter((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL)
    .at(-1).value;
  assert.equal(navigatedFrame.pageGeneration, 3);
  assert.equal(navigation.action, "navigate");
  assert.equal(navigation.url, "https://example.com/external");
  const navigatedRequest = { ...current.request, pageGeneration: 3 };
  const navigatedLease = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(current.event, navigatedRequest);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
    ...navigatedRequest,
    frameId: navigatedFrame.frameId,
    frameSequence: navigatedFrame.frameSequence,
    inputSequence: 1,
    controlGeneration: navigatedLease.controlGeneration,
    type: "mouseMoved",
    x: 10,
    y: 11,
  });
  installed.dispose();
});

test("external navigation publishes a reset navigation DTO before its current frame", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await prepareInteractive(value);
  interactiveState.pages.set(BOT_A, 3);

  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/latest",
  });
  await tick();

  const outputs = value.first.sent;
  const navigationIndex = outputs.findIndex((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL);
  const frameIndex = outputs.findIndex((entry, index) => index > navigationIndex
    && entry.channel === LOCAL_DESKTOP_FRAME_EVENT_CHANNEL);
  assert.equal(navigationIndex >= 0, true);
  assert.equal(frameIndex > navigationIndex, true);
  const navigation = outputs[navigationIndex].value;
  assert.equal(navigation.frameId, null);
  assert.equal(navigation.frameSequence, 0);
  assert.equal(navigation.action, "navigate");
  assert.equal(navigation.url, "https://example.com/latest");
  await installed.dispose();
});

test("IPC-owned manager command notification is suppressed while its returned navigation publishes once", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_CHANNELS,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  value.manager.navigate = async (record, options) => {
    assert.equal(options.internal, true);
    interactiveState.pages.set(BOT_A, 3);
    value.manager.emit("navigation-changed", {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 3,
      action: "navigate",
      url: record.url,
    });
    return publicSession(value.states.get(BOT_A), 4, 3);
  };
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.navigate)(current.event, {
    ...current.request,
    url: "https://example.com/command",
  });
  await tick();

  const navigations = value.first.sent.filter((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL);
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].value.url, "https://example.com/command");
  assert.equal(navigations[0].value.pageGeneration, 3);
  await installed.dispose();
});

test("external manager events are exact-bot, exact-session, coalesced, and detached on dispose", async () => {
  const held = deferred();
  let holdRefresh = false;
  const value = fixture();
  const interactiveState = enableInteractive(value, {
    captureInteractiveFrame(identity, call, state) {
      if (holdRefresh && call === 2) return held.promise;
      return richFrame(identity, {
        frameId: `frame-event-${call}`,
        frameSequence: call + 2,
        sessionGeneration: 4,
        pageGeneration: state.pages.get(identity.botId) || 2,
        presentation: "interactive",
        byte: call,
      });
    },
  });
  const { installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await prepareInteractive(value);
  holdRefresh = true;
  assert.equal(value.manager.listenerCount("frame-changed"), 1);
  assert.equal(value.manager.listenerCount("navigation-changed"), 1);
  assert.equal(value.manager.listenerCount("session-changed"), 1);

  value.manager.emit("frame-changed", {
    botId: BOT_B,
    targetId: LOCAL_B,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    frameId: "frame-other-bot",
    frameSequence: 99,
  });
  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 999,
    pageGeneration: 2,
    frameId: "frame-wrong-session",
    frameSequence: 100,
  });
  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    frameId: "frame-coalesced-one",
    frameSequence: 4,
  });
  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    frameId: "frame-coalesced-two",
    frameSequence: 5,
  });
  await tick();
  assert.equal(interactiveState.interactiveCalls, 2);
  held.resolve(richFrame({ botId: BOT_A, targetId: LOCAL_A, targetGeneration: 1 }, {
    frameId: "frame-event-final", frameSequence: 6, presentation: "interactive", byte: 8,
  }));
  await tick();
  await tick();
  assert.equal(interactiveState.interactiveCalls, 2);

  await installed.dispose();
  assert.equal(value.manager.listenerCount("frame-changed"), 0);
  assert.equal(value.manager.listenerCount("navigation-changed"), 0);
  assert.equal(value.manager.listenerCount("session-changed"), 0);
  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    frameId: "frame-after-dispose",
    frameSequence: 4,
  });
  assert.equal(interactiveState.interactiveCalls, 2);
});

test("a newer-page external frame cannot strand the presentation when navigation metadata races", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const oldFrame = current.frame;
  interactiveState.pages.set(BOT_A, 3);

  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    frameId: "frame-page-ahead",
    frameSequence: oldFrame.frameSequence + 1,
  });
  await tick();

  const refreshed = frameEvents(value).at(-1).value;
  assert.equal(refreshed.pageGeneration, 3);
  const lease = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(current.event, {
    ...current.request,
    pageGeneration: 3,
  });
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
    ...current.request,
    pageGeneration: 3,
    frameId: refreshed.frameId,
    frameSequence: refreshed.frameSequence,
    inputSequence: 1,
    controlGeneration: lease.controlGeneration,
    type: "mouseMoved",
    x: 12,
    y: 13,
  });
  assert.equal(interactiveState.interactiveCalls >= 2, true);
  await installed.dispose();
});

test("a page-ahead frame followed by its paired navigation still publishes the navigation DTO", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  interactiveState.pages.set(BOT_A, 3);
  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    frameId: "frame-page-ahead-paired",
    frameSequence: current.frame.frameSequence + 1,
  });
  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/paired",
  });
  await tick();

  const navigations = value.first.sent.filter((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL);
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].value.pageGeneration, 3);
  assert.equal(navigations[0].value.url, "https://example.com/paired");
  await installed.dispose();
});

test("same-stack navigation followed by its frame publishes one renderer transaction in order", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const start = value.first.sent.length;
  const callsBefore = interactiveState.interactiveCalls;
  interactiveState.pages.set(BOT_A, 3);

  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/order-nav-first",
  });
  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    frameId: "frame-order-nav-first",
    frameSequence: current.frame.frameSequence + 1,
  });
  await tick();

  const outputs = value.first.sent.slice(start);
  assert.deepEqual(outputs.map((entry) => entry.channel), [
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  ]);
  assert.equal(outputs[0].value.url, "https://example.com/order-nav-first");
  assert.equal(interactiveState.interactiveCalls, callsBefore + 1);
  await installed.dispose();
});

test("same-stack frame followed by its navigation still publishes navigation before one frame", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const start = value.first.sent.length;
  const callsBefore = interactiveState.interactiveCalls;
  interactiveState.pages.set(BOT_A, 3);

  value.manager.emit("frame-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    frameId: "frame-order-frame-first",
    frameSequence: current.frame.frameSequence + 1,
  });
  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/order-frame-first",
  });
  await tick();

  const outputs = value.first.sent.slice(start);
  assert.deepEqual(outputs.map((entry) => entry.channel), [
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  ]);
  assert.equal(outputs[0].value.url, "https://example.com/order-frame-first");
  assert.equal(interactiveState.interactiveCalls, callsBefore + 1);
  await installed.dispose();
});

test("same-stack session and frame events in either order publish one frame and status without navigation", async () => {
  for (const order of ["session-first", "frame-first"]) {
    const value = fixture();
    let activeSession = 4;
    const interactiveState = enableInteractive(value, {
      captureInteractiveFrame(identity, call, state) {
        return richFrame(identity, {
          frameId: `frame-order-${order}-${call}`,
          frameSequence: call + 1,
          sessionGeneration: activeSession,
          pageGeneration: state.pages.get(identity.botId) || 2,
          presentation: "interactive",
          byte: call,
        });
      },
    });
    const {
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
      installLocalDesktopFrameIpc,
    } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    const current = await prepareInteractive(value);
    const start = value.first.sent.length;
    const callsBefore = interactiveState.interactiveCalls;
    activeSession = 5;
    interactiveState.pages.set(BOT_A, 3);
    const sessionChanged = {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 5,
      pageGeneration: 3,
    };
    const frameChanged = {
      ...sessionChanged,
      frameId: `frame-order-${order}`,
      frameSequence: current.frame.frameSequence + 1,
    };
    if (order === "session-first") {
      value.manager.emit("session-changed", sessionChanged);
      value.manager.emit("frame-changed", frameChanged);
    } else {
      value.manager.emit("frame-changed", frameChanged);
      value.manager.emit("session-changed", sessionChanged);
    }
    await tick();

    const outputs = value.first.sent.slice(start);
    assert.deepEqual(outputs.map((entry) => entry.channel), [
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    ], order);
    assert.equal(outputs[0].value.sessionGeneration, 5, order);
    assert.equal(outputs[0].value.pageGeneration, 3, order);
    assert.equal(outputs.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false, order);
    assert.equal(interactiveState.interactiveCalls, callsBefore + 1, order);
    await installed.dispose();
  }
});

test("Round5 nav/session permutations publish only the dominant session frame", async () => {
  for (const order of ["navigation-first", "session-first"]) {
    const value = fixture();
    let activeSession = 4;
    const interactiveState = enableInteractive(value, {
      captureInteractiveFrame(identity, call, state) {
        return richFrame(identity, {
          frameId: `frame-round5-nav-session-${order}-${call}`,
          frameSequence: 20 + call,
          sessionGeneration: activeSession,
          pageGeneration: state.pages.get(identity.botId) || 2,
          presentation: "interactive",
          byte: call,
        });
      },
    });
    const {
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
      installLocalDesktopFrameIpc,
    } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    await prepareInteractive(value);
    const start = value.first.sent.length;
    const callsBefore = interactiveState.interactiveCalls;
    activeSession = 5;
    const events = {
      navigation: {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 4,
        pageGeneration: 3,
        action: "navigate",
        url: `https://example.com/round5-nav-session-${order}`,
      },
      session: {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 5,
        pageGeneration: 2,
      },
    };
    const kinds = order === "navigation-first" ? ["navigation", "session"] : ["session", "navigation"];
    for (const kind of kinds) value.manager.emit(`${kind}-changed`, events[kind]);
    await tick();

    const outputs = value.first.sent.slice(start);
    assert.deepEqual(outputs.map((entry) => entry.channel), [
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    ], order);
    assert.equal(outputs.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false, order);
    assert.equal(outputs[0].value.sessionGeneration, 5, order);
    assert.equal(outputs[0].value.pageGeneration, 2, order);
    assert.equal(interactiveState.interactiveCalls, callsBefore + 1, order);
    await installed.dispose();
  }
});

test("Round5 nav/frame permutations drop navigation below the dominant page", async () => {
  for (const order of ["navigation-first", "frame-first"]) {
    const value = fixture();
    let latestFrameSequence = 8;
    const interactiveState = enableInteractive(value, {
      captureInteractiveFrame(identity, call, state) {
        return richFrame(identity, {
          frameId: `frame-round5-nav-frame-${order}-${call}`,
          frameSequence: latestFrameSequence + 1,
          sessionGeneration: 4,
          pageGeneration: state.pages.get(identity.botId) || 2,
          presentation: "interactive",
          byte: call,
        });
      },
    });
    const {
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
      installLocalDesktopFrameIpc,
    } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    const current = await prepareInteractive(value);
    const start = value.first.sent.length;
    const callsBefore = interactiveState.interactiveCalls;
    interactiveState.pages.set(BOT_A, 4);
    const events = {
      navigation: {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 4,
        pageGeneration: 3,
        action: "navigate",
        url: `https://example.com/round5-nav-frame-${order}`,
      },
      frame: {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 4,
        pageGeneration: 4,
        frameId: `frame-round5-authoritative-${order}`,
        frameSequence: latestFrameSequence,
      },
    };
    const kinds = order === "navigation-first" ? ["navigation", "frame"] : ["frame", "navigation"];
    for (const kind of kinds) value.manager.emit(`${kind}-changed`, events[kind]);
    await tick();

    const outputs = value.first.sent.slice(start);
    assert.deepEqual(outputs.map((entry) => entry.channel), [
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    ], order);
    assert.equal(outputs.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false, order);
    assert.equal(outputs[0].value.sessionGeneration, 4, order);
    assert.equal(outputs[0].value.pageGeneration, 4, order);
    assert.equal(interactiveState.interactiveCalls, callsBefore + 1, order);
    assert.equal(current.frame.pageGeneration, 2, order);
    await installed.dispose();
  }
});

test("Round5 session/frame permutations publish one current frame without navigation", async () => {
  for (const order of ["session-first", "frame-first"]) {
    const value = fixture();
    let activeSession = 4;
    let latestFrameSequence = 8;
    const interactiveState = enableInteractive(value, {
      captureInteractiveFrame(identity, call, state) {
        return richFrame(identity, {
          frameId: `frame-round5-session-frame-${order}-${call}`,
          frameSequence: latestFrameSequence + 1,
          sessionGeneration: activeSession,
          pageGeneration: state.pages.get(identity.botId) || 2,
          presentation: "interactive",
          byte: call,
        });
      },
    });
    const {
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
      installLocalDesktopFrameIpc,
    } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    await prepareInteractive(value);
    const start = value.first.sent.length;
    const callsBefore = interactiveState.interactiveCalls;
    activeSession = 5;
    const session = {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 5,
      pageGeneration: 2,
    };
    const frame = {
      ...session,
      frameId: `frame-round5-session-frame-authoritative-${order}`,
      frameSequence: latestFrameSequence,
    };
    const kinds = order === "session-first" ? ["session", "frame"] : ["frame", "session"];
    for (const kind of kinds) value.manager.emit(`${kind}-changed`, kind === "session" ? session : frame);
    await tick();

    const outputs = value.first.sent.slice(start);
    assert.deepEqual(outputs.map((entry) => entry.channel), [
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    ], order);
    assert.equal(outputs.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false, order);
    assert.equal(outputs[0].value.sessionGeneration, 5, order);
    assert.equal(outputs[0].value.pageGeneration, 2, order);
    assert.equal(interactiveState.interactiveCalls, callsBefore + 1, order);
    await installed.dispose();
  }
});

test("Round5 three-way permutations keep only the highest session/page token", async () => {
  const permutations = [
    ["navigation", "frame", "session"],
    ["navigation", "session", "frame"],
    ["frame", "navigation", "session"],
    ["frame", "session", "navigation"],
    ["session", "navigation", "frame"],
    ["session", "frame", "navigation"],
  ];
  for (const order of permutations) {
    const value = fixture();
    let activeSession = 4;
    let latestFrameSequence = 8;
    const interactiveState = enableInteractive(value, {
      captureInteractiveFrame(identity, call, state) {
        return richFrame(identity, {
          frameId: `frame-round5-three-way-${order.join("-")}-${call}`,
          frameSequence: latestFrameSequence + 1,
          sessionGeneration: activeSession,
          pageGeneration: state.pages.get(identity.botId) || 2,
          presentation: "interactive",
          byte: call,
        });
      },
    });
    const {
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
      installLocalDesktopFrameIpc,
    } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    await prepareInteractive(value);
    const start = value.first.sent.length;
    activeSession = 5;
    const events = {
      navigation: {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 4,
        pageGeneration: 3,
        action: "navigate",
        url: `https://example.com/round5-three-way-${order.join("-")}`,
      },
      frame: {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 4,
        pageGeneration: 4,
        frameId: `frame-round5-three-way-authoritative-${order.join("-")}`,
        frameSequence: latestFrameSequence,
      },
      session: {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 5,
        pageGeneration: 2,
      },
    };
    interactiveState.pages.set(BOT_A, 2);
    for (const kind of order) value.manager.emit(`${kind}-changed`, events[kind]);
    await tick();

    const outputs = value.first.sent.slice(start);
    assert.deepEqual(outputs.map((entry) => entry.channel), [
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    ], order.join(","));
    assert.equal(outputs.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false, order.join(","));
    assert.equal(outputs[0].value.sessionGeneration, 5, order.join(","));
    assert.equal(outputs[0].value.pageGeneration, 2, order.join(","));
    await installed.dispose();
  }
});

test("Round5 equal-token navigation keeps the latest address while sharing one capture", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await prepareInteractive(value);
  const start = value.first.sent.length;
  const callsBefore = interactiveState.interactiveCalls;
  interactiveState.pages.set(BOT_A, 3);
  const base = {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
  };
  value.manager.emit("navigation-changed", { ...base, url: "https://example.com/round5-old" });
  value.manager.emit("frame-changed", {
    ...base,
    frameId: "frame-round5-equal-token",
    frameSequence: 8,
  });
  value.manager.emit("navigation-changed", { ...base, url: "https://example.com/round5-latest" });
  await tick();

  const outputs = value.first.sent.slice(start);
  assert.deepEqual(outputs.map((entry) => entry.channel), [
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  ]);
  assert.equal(outputs[0].value.url, "https://example.com/round5-latest");
  assert.equal(outputs[0].value.sessionGeneration, 4);
  assert.equal(outputs[0].value.pageGeneration, 3);
  assert.equal(interactiveState.interactiveCalls, callsBefore + 1);
  await installed.dispose();
});

test("Round5 newer cross-kind events during an awaited capture suppress stale navigation", async () => {
  const held = deferred();
  const value = fixture();
  let activeSession = 4;
  const interactiveState = enableInteractive(value, {
    captureInteractiveFrame(identity, call, state) {
      if (call === 2) return held.promise;
      return richFrame(identity, {
        frameId: `frame-round5-await-${call}`,
        frameSequence: 20 + call,
        sessionGeneration: activeSession,
        pageGeneration: state.pages.get(identity.botId) || 2,
        presentation: "interactive",
        byte: call,
      });
    },
  });
  const {
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    LOCAL_DESKTOP_FRAME_CHANNELS,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const start = value.first.sent.length;
  const pendingPresentation = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(current.event, {
    ...current.request,
    presentation: "interactive",
  });
  await Promise.resolve();
  activeSession = 5;
  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/round5-await-stale",
  });
  value.manager.emit("session-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 5,
    pageGeneration: 2,
  });
  held.resolve(richFrame({ botId: BOT_A, targetId: LOCAL_A, targetGeneration: 1 }, {
    frameId: "frame-round5-await-held",
    frameSequence: 30,
    sessionGeneration: 5,
    pageGeneration: 2,
    presentation: "interactive",
    byte: 30,
  }));
  await pendingPresentation;
  await tick();

  const outputs = value.first.sent.slice(start);
  assert.deepEqual(outputs.map((entry) => entry.channel), [
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  ]);
  assert.equal(outputs.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false);
  assert.equal(outputs[0].value.sessionGeneration, 5);
  assert.equal(outputs[0].value.pageGeneration, 2);
  assert.equal(interactiveState.interactiveCalls, 3);
  await installed.dispose();
});

test("adjudicated manager refresh merges session or frame arrivals after its snapshot", async () => {
  for (const newerType of ["session", "frame"]) {
    const held = deferred();
    const value = fixture();
    let activeSession = 4;
    const interactiveState = enableInteractive(value, {
      captureInteractiveFrame(identity, call, state) {
        if (call === 2) return held.promise;
        return richFrame(identity, {
          frameId: `frame-adjudicated-${newerType}-${call}`,
          frameSequence: 200 + call,
          sessionGeneration: activeSession,
          pageGeneration: state.pages.get(identity.botId) || 2,
          presentation: "interactive",
          byte: call,
        });
      },
    });
    const {
      LOCAL_DESKTOP_FRAME_CHANNELS,
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
      installLocalDesktopFrameIpc,
    } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    const current = await prepareInteractive(value);
    const start = value.first.sent.length;
    const callsBefore = interactiveState.interactiveCalls;
    const pendingPresentation = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(current.event, {
      ...current.request,
      presentation: "interactive",
    });
    await Promise.resolve();

    value.manager.emit("navigation-changed", {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 3,
      action: "navigate",
      url: `https://example.com/adjudicated-${newerType}-stale`,
    });
    await tick();

    // Equal-token and lower-token notifications must not manufacture a
    // second transaction while the first one is waiting on its capture.
    value.manager.emit("navigation-changed", {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 3,
      action: "navigate",
      url: `https://example.com/adjudicated-${newerType}-equal`,
    });
    value.manager.emit("frame-changed", {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 2,
      frameId: `frame-adjudicated-${newerType}-lower`,
      frameSequence: current.frame.frameSequence + 100,
    });

    if (newerType === "session") {
      activeSession = 5;
      value.manager.emit("session-changed", {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 5,
        pageGeneration: 2,
      });
      value.manager.emit("frame-changed", {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 5,
        pageGeneration: 2,
        frameId: "frame-adjudicated-session-current",
        frameSequence: 100,
      });
    } else {
      interactiveState.pages.set(BOT_A, 4);
      value.manager.emit("frame-changed", {
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        sessionGeneration: 4,
        pageGeneration: 4,
        frameId: "frame-adjudicated-frame-current",
        frameSequence: 100,
      });
    }

    held.resolve(richFrame({ botId: BOT_A, targetId: LOCAL_A, targetGeneration: 1 }, {
      frameId: `frame-adjudicated-${newerType}-held`,
      frameSequence: 50,
      sessionGeneration: newerType === "session" ? 5 : 4,
      pageGeneration: newerType === "session" ? 2 : 4,
      presentation: "interactive",
      byte: 50,
    }));
    await pendingPresentation;
    for (let settle = 0; settle < 5; settle += 1) await tick();

    const firstOutputs = value.first.sent.slice(start);
    assert.deepEqual(firstOutputs.map((entry) => entry.channel), [
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    ], newerType);
    assert.equal(firstOutputs.some((entry) => entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false, newerType);
    assert.equal(firstOutputs[0].value.sessionGeneration, newerType === "session" ? 5 : 4, newerType);
    assert.equal(firstOutputs[0].value.pageGeneration, newerType === "session" ? 2 : 4, newerType);
    assert.equal(firstOutputs[1].value.sessionGeneration, newerType === "session" ? 5 : 4, newerType);
    assert.equal(firstOutputs[1].value.pageGeneration, newerType === "session" ? 2 : 4, newerType);
    assert.equal(interactiveState.interactiveCalls, callsBefore + 2, newerType);

    const laterPage = newerType === "session" ? 3 : 5;
    interactiveState.pages.set(BOT_A, laterPage);
    value.manager.emit("navigation-changed", {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: newerType === "session" ? 5 : 4,
      pageGeneration: laterPage,
      action: "navigate",
      url: `https://example.com/adjudicated-${newerType}-later`,
    });
    for (let settle = 0; settle < 5; settle += 1) await tick();

    const allOutputs = value.first.sent.slice(start);
    const laterOutputs = allOutputs.slice(2);
    assert.deepEqual(laterOutputs.map((entry) => entry.channel), [
      LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
      LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
      LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    ], newerType);
    assert.equal(laterOutputs[0].value.pageGeneration, laterPage, newerType);
    assert.equal(interactiveState.interactiveCalls, callsBefore + 3, newerType);
    await installed.dispose();
  }
});

test("adjudicated manager refresh stays bot-scoped and detaches a disposed sibling", async () => {
  const held = deferred();
  const value = fixture();
  const interactiveState = enableInteractive(value, {
    captureInteractiveFrame(identity, call, state) {
      if (identity.botId === BOT_A && call === 3) return held.promise;
      return richFrame(identity, {
        frameId: `frame-adjudicated-sibling-${identity.botId}-${call}`,
        frameSequence: 60 + call,
        sessionGeneration: 4,
        pageGeneration: state.pages.get(identity.botId) || 2,
        presentation: "interactive",
        byte: call,
      });
    },
  });
  const {
    LOCAL_DESKTOP_FRAME_CHANNELS,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const currentA = await prepareInteractive(value, value.first.sender, BOT_A, 1);
  const currentB = await prepareInteractive(value, value.second.sender, BOT_B, 1);
  const startA = value.first.sent.length;
  const startB = value.second.sent.length;
  const pendingPresentation = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(currentA.event, {
    ...currentA.request,
    presentation: "interactive",
  });
  await Promise.resolve();
  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/adjudicated-sibling-stale",
  });
  await tick();
  value.manager.emit("session-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 5,
    pageGeneration: 2,
  });
  value.manager.emit("navigation-changed", {
    botId: BOT_B,
    targetId: LOCAL_B,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/adjudicated-sibling-b",
  });
  await installed.dispose();
  held.resolve(richFrame({ botId: BOT_A, targetId: LOCAL_A, targetGeneration: 1 }, {
    frameId: "frame-adjudicated-sibling-held",
    frameSequence: 70,
    sessionGeneration: 5,
    pageGeneration: 2,
    presentation: "interactive",
    byte: 70,
  }));
  await Promise.allSettled([pendingPresentation]);
  await tick();

  assert.equal(value.manager.listenerCount("frame-changed"), 0);
  assert.equal(value.manager.listenerCount("navigation-changed"), 0);
  assert.equal(value.manager.listenerCount("session-changed"), 0);
  assert.equal(value.first.sent.slice(startA).some((entry) =>
    entry.channel === LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL), false);
  assert.equal(value.first.sent.slice(startA).some((entry) =>
    entry.channel === LOCAL_DESKTOP_FRAME_EVENT_CHANNEL || entry.channel === LOCAL_DESKTOP_STATUS_EVENT_CHANNEL), false);
  assert.equal(value.second.sent.slice(startB).length, 0);
  assert.equal(interactiveState.interactiveCalls, 3);
});

test("Round5 manager refresh remains bot-scoped and detaches on dispose", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await prepareInteractive(value, value.first.sender, BOT_A, 1);
  await prepareInteractive(value, value.second.sender, BOT_B, 1);
  const startA = value.first.sent.length;
  const startB = value.second.sent.length;
  interactiveState.pages.set(BOT_A, 3);
  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    action: "navigate",
    url: "https://example.com/round5-bot-a",
  });
  await tick();
  const outputsA = value.first.sent.slice(startA);
  const outputsB = value.second.sent.slice(startB);
  assert.deepEqual(outputsA.map((entry) => entry.channel), [
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  ]);
  assert.equal(outputsA[0].value.botId, BOT_A);
  assert.equal(outputsB.length, 0);
  const callsAfterA = interactiveState.interactiveCalls;
  await installed.dispose();
  assert.equal(value.manager.listenerCount("frame-changed"), 0);
  assert.equal(value.manager.listenerCount("navigation-changed"), 0);
  assert.equal(value.manager.listenerCount("session-changed"), 0);
  value.manager.emit("navigation-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 4,
    action: "navigate",
    url: "https://example.com/round5-after-dispose",
  });
  value.manager.emit("frame-changed", {
    botId: BOT_B,
    targetId: LOCAL_B,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 3,
    frameId: "frame-round5-after-dispose",
    frameSequence: 8,
  });
  await tick();
  assert.equal(interactiveState.interactiveCalls, callsAfterA);
});

test("a same-stack frame storm coalesces to one authoritative renderer frame and status", async () => {
  const value = fixture();
  let latestEventFrameSequence = 2;
  const interactiveState = enableInteractive(value, {
    captureInteractiveFrame(identity, call, state) {
      return richFrame(identity, {
        frameId: `frame-storm-capture-${call}`,
        frameSequence: latestEventFrameSequence > 2 ? latestEventFrameSequence + 1 : call + 1,
        pageGeneration: state.pages.get(identity.botId) || 2,
        presentation: "interactive",
        byte: call,
      });
    },
  });
  const {
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const start = value.first.sent.length;
  const callsBefore = interactiveState.interactiveCalls;
  for (let offset = 1; offset <= 4; offset += 1) {
    latestEventFrameSequence = current.frame.frameSequence + offset;
    value.manager.emit("frame-changed", {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 2,
      frameId: `frame-storm-${offset}`,
      frameSequence: latestEventFrameSequence,
    });
  }
  await tick();

  const outputs = value.first.sent.slice(start);
  assert.deepEqual(outputs.map((entry) => entry.channel), [
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  ]);
  assert.equal(interactiveState.interactiveCalls, callsBefore + 1);
  await installed.dispose();
});

test("a same-stack navigation storm publishes only the latest navigation before one frame", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await prepareInteractive(value);
  const start = value.first.sent.length;
  const callsBefore = interactiveState.interactiveCalls;
  for (let pageGeneration = 3; pageGeneration <= 5; pageGeneration += 1) {
    interactiveState.pages.set(BOT_A, pageGeneration);
    value.manager.emit("navigation-changed", {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration,
      action: "navigate",
      url: `https://example.com/order-nav-${pageGeneration}`,
    });
  }
  await tick();

  const outputs = value.first.sent.slice(start);
  assert.deepEqual(outputs.map((entry) => entry.channel), [
    LOCAL_DESKTOP_NAVIGATION_EVENT_CHANNEL,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  ]);
  assert.equal(outputs[0].value.pageGeneration, 5);
  assert.equal(outputs[0].value.url, "https://example.com/order-nav-5");
  assert.equal(interactiveState.interactiveCalls, callsBefore + 1);
  await installed.dispose();
});

test("external manager session replacement fences old tokens and republishes the new session", async () => {
  const value = fixture();
  let sessionGeneration = 4;
  enableInteractive(value, {
    open(record) { return publicSession(record, sessionGeneration, 2); },
    captureInteractiveFrame(identity, call) {
      return richFrame(identity, {
        frameId: `frame-session-${call}`,
        frameSequence: call + 1,
        sessionGeneration,
        pageGeneration: 2,
        presentation: "interactive",
        byte: call,
      });
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const oldFrame = current.frame;
  const oldLease = current.lease.controlGeneration;
  sessionGeneration = 5;
  value.manager.emit("session-changed", {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 5,
    pageGeneration: 2,
  });
  await assert.rejects(
    value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
      ...current.request,
      frameId: oldFrame.frameId,
      frameSequence: oldFrame.frameSequence,
      inputSequence: 1,
      controlGeneration: oldLease,
      type: "mouseMoved",
      x: 1,
      y: 2,
    }),
    { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" },
  );
  await tick();
  const refreshed = frameEvents(value).at(-1).value;
  assert.equal(refreshed.sessionGeneration, 5);
  assert.equal(value.first.sent.filter((entry) => entry.channel === "openbot-local-frame:navigation").length, 0);
  const request = { ...current.request, sessionGeneration: 5, pageGeneration: 2 };
  const lease = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(current.event, request);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
    ...request,
    frameId: refreshed.frameId,
    frameSequence: refreshed.frameSequence,
    inputSequence: 1,
    controlGeneration: lease.controlGeneration,
    type: "mouseMoved",
    x: 3,
    y: 4,
  });
  await installed.dispose();
});

test("successful select returns one exact rich preview bootstrap while preview events stay legacy", async () => {
  const value = fixture();
  enableInteractive(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const result = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  });

  assertSelectionResult(result, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    viewGeneration: 1,
    frameId: "frame-preview-1",
    frameSequence: 1,
    inputSequence: 0,
    presentation: "preview",
    state: "live",
    code: null,
  });
  assert.deepEqual(Object.keys(frameEvents(value).at(-1).value).sort(), [
    "botId", "bytes", "height", "mimeType", "sequence", "targetGeneration", "targetId", "viewGeneration", "width",
  ]);
  assert.deepEqual(Object.keys(statusEvents(value).at(-1).value).sort(), [
    "botId", "code", "state", "targetGeneration", "targetId", "viewGeneration",
  ]);

  const interactive = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(event, {
    botId: result.botId,
    targetId: result.targetId,
    targetGeneration: result.targetGeneration,
    sessionGeneration: result.sessionGeneration,
    pageGeneration: result.pageGeneration,
    viewGeneration: result.viewGeneration,
    presentation: "interactive",
  });
  assert.equal(interactive.presentation, "interactive");
  assert.equal(interactive.state, "live");
  await installed.dispose();
});

test("successful retry returns the exact current replacement preview bootstrap", async () => {
  const value = fixture();
  enableInteractive(value, {
    capturePreviewFrame(identity, call) {
      return richFrame(identity, {
        frameId: `frame-retry-bootstrap-${call}`,
        frameSequence: call,
        sessionGeneration: call === 1 ? 4 : 5,
        presentation: "preview",
      });
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  const result = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry)(event, {
    botId: BOT_A,
    viewGeneration: 2,
  });

  assertSelectionResult(result, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 5,
    pageGeneration: 2,
    viewGeneration: 2,
    frameId: "frame-retry-bootstrap-2",
    frameSequence: 2,
    inputSequence: 0,
    presentation: "preview",
    state: "live",
    code: null,
  });
  assert.deepEqual(Object.keys(statusEvents(value).at(-1).value).sort(), [
    "botId", "code", "state", "targetGeneration", "targetId", "viewGeneration",
  ]);
  await installed.dispose();
});

test("held preview work never returns a usable bootstrap after invalidation", async (t) => {
  await t.test("switch", async () => {
    const held = deferred();
    const value = fixture({
      captureDisplayFrame(identity) {
        return identity.botId === BOT_A
          ? held.promise
          : frame(BOT_B, LOCAL_B, 1, "frame-current-b", 8);
      },
    });
    const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    const event = ipcEvent(value.first.sender);
    const stale = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
      botId: BOT_A,
      viewGeneration: 1,
    });
    await tick();
    await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
      botId: BOT_B,
      viewGeneration: 2,
    });
    held.resolve(frame(BOT_A, LOCAL_A, 1, "frame-stale-a", 1));
    assert.equal(await stale, null);
    await installed.dispose();
  });

  await t.test("clear", async () => {
    const held = deferred();
    const value = fixture({ captureDisplayFrame: () => held.promise });
    const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    const event = ipcEvent(value.first.sender);
    const stale = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
      botId: BOT_A,
      viewGeneration: 1,
    });
    await tick();
    const cleared = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(event, { viewGeneration: 2 });
    held.resolve(frame(BOT_A, LOCAL_A, 1, "frame-cleared", 2));
    const [result] = await Promise.all([stale, cleared]);
    assert.equal(result, null);
    await installed.dispose();
  });

  await t.test("authority generation change", async () => {
    const held = deferred();
    const value = fixture({ captureDisplayFrame: () => held.promise });
    const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc(value);
    const stale = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(ipcEvent(value.first.sender), {
      botId: BOT_A,
      viewGeneration: 1,
    });
    await tick();
    value.states.set(BOT_A, computer(BOT_A, LOCAL_A, 2));
    value.computerBoundary.emit("changed", value.states.get(BOT_A));
    held.resolve(frame(BOT_A, LOCAL_A, 1, "frame-old-generation", 3));
    assert.equal(await stale, null);
    await installed.dispose();
  });

  await t.test("dispose", async () => {
    const readiness = deferred();
    const value = fixture();
    const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
    const installed = installLocalDesktopFrameIpc({ ...value, ready: readiness.promise });
    const stale = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(ipcEvent(value.first.sender), {
      botId: BOT_A,
      viewGeneration: 1,
    }));
    const disposed = installed.dispose();
    readiness.resolve();
    const outcome = await stale.then(() => "resolved", () => "rejected");
    await disposed;
    assert.equal(outcome, "rejected");
  });
});

test("real-manager rich preview is projected to the exact legacy DTO consumed by the shipping renderer", async () => {
  const value = fixture();
  enableInteractive(value);
  const {
    LOCAL_DESKTOP_FRAME_CHANNELS,
    LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
    LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
    installLocalDesktopFrameIpc,
  } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  let frameListener = null;
  let selectionResult = null;
  let statusListener = null;
  const draws = [];
  const context = {
    clearRect() {},
    drawImage(...args) { draws.push(args); },
  };
  function element(tagName) {
    return {
      tagName: tagName.toUpperCase(),
      children: [],
      attributes: {},
      className: "",
      hidden: false,
      width: 0,
      height: 0,
      append(...children) { this.children.push(...children); },
      setAttribute(name, fieldValue) { this.attributes[name] = String(fieldValue); },
      addEventListener() {},
      getContext(kind) { return tagName === "canvas" && kind === "2d" ? context : null; },
      remove() { this.removed = true; },
    };
  }
  const facade = {
    select: (request) => value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(ipcEvent(value.first.sender), request)
      .then((result) => { selectionResult = result; return result; }),
    retry: (request) => value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.retry)(ipcEvent(value.first.sender), request),
    clear: (request) => value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(ipcEvent(value.first.sender), request),
    onFrame(callback) { frameListener = callback; return () => { frameListener = null; }; },
    onStatus(callback) { statusListener = callback; return () => { statusListener = null; }; },
  };
  value.first.sender.send = (channel, payload) => {
    value.first.sent.push({ channel, value: payload });
    if (channel === LOCAL_DESKTOP_FRAME_EVENT_CHANNEL) void frameListener?.(payload);
    if (channel === LOCAL_DESKTOP_STATUS_EVENT_CHANNEL) statusListener?.(payload);
  };
  const documentRef = { createElement: element };
  const container = element("div");
  const windowRef = {
    Blob,
    openbotLocalDesktop: facade,
    async createImageBitmap() { return { close() {} }; },
  };
  const { createLocalDesktopView } = require("../src/renderer/openbot-local-desktop-view.js");
  const mounted = createLocalDesktopView({ documentRef, windowRef, container });
  mounted.selectBot(BOT_A);
  await tick();

  const publishedFrame = frameEvents(value).at(-1).value;
  const publishedStatus = statusEvents(value).at(-1).value;
  assert.deepEqual(Object.keys(publishedFrame).sort(), [
    "botId", "bytes", "height", "mimeType", "sequence", "targetGeneration", "targetId", "viewGeneration", "width",
  ]);
  assert.deepEqual(Object.keys(publishedStatus).sort(), [
    "botId", "code", "state", "targetGeneration", "targetId", "viewGeneration",
  ]);
  assertSelectionResult(selectionResult, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    viewGeneration: 1,
    frameId: "frame-preview-1",
    frameSequence: 1,
    inputSequence: 0,
    presentation: "preview",
    state: "live",
    code: null,
  });
  assert.equal(draws.length, 1, "the exact production preview must be accepted by the current renderer validator");
  mounted.dispose();
  await tick();
  installed.dispose();
});

test("legacy display-only managers cannot enable the interactive presentation stage", async () => {
  const value = fixture();
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, { botId: BOT_A, viewGeneration: 1 });
  const result = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(event, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 1,
    pageGeneration: 1,
    viewGeneration: 1,
    presentation: "interactive",
  });
  assert.deepEqual(result, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "unavailable",
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  assert.equal(frameEvents(value).some((entry) => entry.value.presentation === "interactive"), false);
  installed.dispose();
});

test("an interactive presentation request cannot be satisfied by a held preview capture", async () => {
  const preview = deferred();
  const value = fixture();
  const interactiveState = enableInteractive(value, {
    capturePreviewFrame() { return preview.promise; },
    captureInteractiveFrame(identity) {
      return richFrame(identity, {
        frameId: "frame-interactive-current",
        frameSequence: 2,
        presentation: "interactive",
        byte: 9,
      });
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const selected = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  await tick();
  const switched = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.presentation)(event, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    viewGeneration: 1,
    presentation: "interactive",
  });
  preview.resolve(richFrame({ botId: BOT_A, targetId: LOCAL_A, targetGeneration: 1 }, {
    frameId: "frame-preview-late",
    frameSequence: 1,
    presentation: "preview",
  }));
  await Promise.allSettled([selected, switched]);
  assert.equal(interactiveState.interactiveCalls, 1);
  assert.equal(frameEvents(value).at(-1)?.value.presentation, "interactive");
  assert.equal(frameEvents(value).some((entry) => entry.value.frameId === "frame-preview-late"), false);
  installed.dispose();
});

test("one exact target session grants control to only one renderer sender", async () => {
  const value = fixture();
  enableInteractive(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, { botId: BOT_A, viewGeneration: 1 });
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, { botId: BOT_A, viewGeneration: 1 });
  const request = {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    viewGeneration: 1,
  };
  const firstLease = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(firstEvent, request);
  let secondLease = null;
  const firstAttempt = await Promise.resolve()
    .then(() => value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(secondEvent, request))
    .then((lease) => { secondLease = lease; return "resolved"; }, () => "rejected");
  if (secondLease) {
    await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.releaseControl)(secondEvent, {
      ...request,
      controlGeneration: secondLease.controlGeneration,
    });
  }
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.releaseControl)(firstEvent, {
    ...request,
    controlGeneration: firstLease.controlGeneration,
  });
  const transferred = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(secondEvent, request);
  assert.equal(firstAttempt, "rejected");
  assert.notEqual(transferred.controlGeneration, firstLease.controlGeneration);
  installed.dispose();
});

test("coordinate-only mouse input reaches the manager through the exact supported form", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const result = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
    ...current.request,
    frameId: current.frame.frameId,
    frameSequence: current.frame.frameSequence,
    inputSequence: 1,
    controlGeneration: current.lease.controlGeneration,
    type: "mouseMoved",
    coordinate: { x: 12, y: 34 },
    coordinateSpace: "css-dip",
    deviceScaleFactor: 1,
  });
  assert.equal(result.inputSequence, 1);
  assert.equal(interactiveState.dispatchCalls.length, 1);
  assert.deepEqual(interactiveState.dispatchCalls[0].coordinate, { x: 12, y: 34 });
  installed.dispose();
});

test("clear and bot switch fence a held input at the manager session before it can take effect", async (t) => {
  for (const scenario of ["clear", "switch"]) {
    await t.test(scenario, async () => {
      const entered = deferred();
      const release = deferred();
      let closed = false;
      let effects = 0;
      const value = fixture();
      const interactiveState = enableInteractive(value, {
        async dispatchMouseEvent(input) {
          entered.resolve();
          await release.promise;
          if (closed) throw Object.assign(new Error("closed"), { code: "OPENBOT_LOCAL_INPUT_STALE" });
          effects += 1;
          return input;
        },
        close() { closed = true; },
      });
      const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
      const installed = installLocalDesktopFrameIpc(value);
      const current = await prepareInteractive(value);
      const pending = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
        ...current.request,
        frameId: current.frame.frameId,
        frameSequence: current.frame.frameSequence,
        inputSequence: 1,
        controlGeneration: current.lease.controlGeneration,
        type: "mousePressed",
        x: 12,
        y: 34,
        button: "left",
      }).then(() => "resolved", () => "rejected");
      await entered.promise;
      if (scenario === "clear") {
        await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(current.event, { viewGeneration: 2 });
      } else {
        await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(current.event, {
          botId: BOT_B,
          viewGeneration: 2,
        });
      }
      const closedBeforeRelease = interactiveState.closeCalls.includes(BOT_A) && closed;
      release.resolve();
      const outcome = await pending;
      assert.equal(closedBeforeRelease, true);
      assert.equal(effects, 0);
      assert.equal(outcome, "rejected");
      installed.dispose();
    });
  }
});

test("a frame page-generation advance releases the old control lease before publication", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value, {
    captureInteractiveFrame(identity, call) {
      return richFrame(identity, {
        frameId: `frame-page-${call + 1}`,
        frameSequence: call + 1,
        pageGeneration: call === 1 ? 2 : 3,
        presentation: "interactive",
        byte: call + 1,
      });
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  value.timers[0].callback();
  await tick();
  const advanced = frameEvents(value).at(-1).value;
  assert.equal(advanced.pageGeneration, 3);
  const outcome = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, {
    ...current.request,
    pageGeneration: 3,
    frameId: advanced.frameId,
    frameSequence: advanced.frameSequence,
    inputSequence: 1,
    controlGeneration: current.lease.controlGeneration,
    type: "mouseMoved",
    x: 4,
    y: 5,
  }).then(() => "resolved", () => "rejected");
  const replacement = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(current.event, {
    ...current.request,
    pageGeneration: 3,
  });
  assert.equal(outcome, "rejected");
  assert.equal(interactiveState.dispatchCalls.length, 0);
  assert.notEqual(replacement.controlGeneration, current.lease.controlGeneration);
  installed.dispose();
});

test("sender destruction removes every exact navigation and lifecycle listener immediately", async () => {
  const value = fixture();
  enableInteractive(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(ipcEvent(value.first.sender), {
    botId: BOT_A,
    viewGeneration: 1,
  });
  const names = [
    "did-start-loading", "did-start-navigation", "did-navigate", "did-frame-navigate", "will-navigate",
    "destroyed", "render-process-gone",
  ];
  assert.equal(names.every((name) => value.first.sender.listenerCount(name) === 1), true);
  value.first.sender.destroyed = true;
  value.first.sender.emit("destroyed");
  assert.deepEqual(names.map((name) => value.first.sender.listenerCount(name)), [0, 0, 0, 0, 0, 0, 0]);
  installed.dispose();
});

test("sender lifecycle classification keeps exact state for subframes and malformed frame events", async (t) => {
  const cases = [
    ["did-start-navigation positional subframe", "did-start-navigation", [{}, "https://example.com/frame", false, false]],
    ["did-start-navigation details subframe", "did-start-navigation", [{ isMainFrame: false }]],
    ["did-frame-navigate positional subframe", "did-frame-navigate", [{}, "https://example.com/frame", 200, "OK", false]],
    ["did-frame-navigate details subframe", "did-frame-navigate", [{ isMainFrame: false }]],
    ["did-navigate-in-page positional subframe", "did-navigate-in-page", [{}, "https://example.com/#frame", false]],
    ["did-navigate-in-page details subframe", "did-navigate-in-page", [{ isMainFrame: false }]],
    ["did-frame-navigate malformed", "did-frame-navigate", [{}, "https://example.com/ambiguous", 200, "OK"]],
  ];
  for (const [label, eventName, args] of cases) {
    await t.test(label, async () => {
      const value = fixture();
      enableInteractive(value);
      const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
      const installed = installLocalDesktopFrameIpc(value);
      const current = await prepareInteractive(value);
      value.first.sender.emit(eventName, ...args);
      const lease = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(current.event, current.request);
      assert.equal(lease.controlGeneration, current.lease.controlGeneration);
      installed.dispose();
    });
  }
});

test("sender lifecycle classification invalidates only known main or terminal events", async (t) => {
  const cases = [
    ["did-start-navigation positional main", "did-start-navigation", [{}, "https://example.com/main", false, true]],
    ["did-start-navigation details main", "did-start-navigation", [{ isMainFrame: true }]],
    ["did-frame-navigate positional main", "did-frame-navigate", [{}, "https://example.com/main", 200, "OK", true]],
    ["did-frame-navigate details main", "did-frame-navigate", [{ isMainFrame: true }]],
    ["did-navigate-in-page positional main", "did-navigate-in-page", [{}, "https://example.com/#main", true]],
    ["did-navigate-in-page details main", "did-navigate-in-page", [{ isMainFrame: true }]],
    ["will-navigate is main-only", "will-navigate", [{}]],
    ["did-navigate is main-only", "did-navigate", [{}]],
    ["render-process-gone is terminal", "render-process-gone", [{}]],
  ];
  for (const [label, eventName, args] of cases) {
    await t.test(label, async () => {
      const value = fixture();
      enableInteractive(value);
      const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
      const installed = installLocalDesktopFrameIpc(value);
      const current = await prepareInteractive(value);
      value.first.sender.emit(eventName, ...args);
      await assert.rejects(
        Promise.resolve().then(() => value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(current.event, current.request)),
        { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" },
      );
      await installed.dispose();
    });
  }
});

test("a distinct rich frame must strictly increase manager frameSequence", async () => {
  const value = fixture();
  enableInteractive(value, {
    capturePreviewFrame(identity, call) {
      return richFrame(identity, {
        frameId: call === 1 ? "frame-sequence-one" : "frame-sequence-conflict",
        frameSequence: 1,
        presentation: "preview",
        byte: call,
      });
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(ipcEvent(value.first.sender), {
    botId: BOT_A,
    viewGeneration: 1,
  });
  value.timers[0].callback();
  await tick();
  assert.equal(frameEvents(value).length, 1);
  assert.equal(frameEvents(value)[0].value.sequence, 1);
  installed.dispose();
});

test("all optional input fields are validated locally before any manager effect", async (t) => {
  const cases = [
    ["mouse buttons", (base) => ({ ...base, type: "mouseMoved", x: 1, y: 2, buttons: 32 })],
    ["mouse click count", (base) => ({ ...base, type: "mouseMoved", x: 1, y: 2, clickCount: 33 })],
    ["mouse modifiers", (base) => ({ ...base, type: "mouseMoved", x: 1, y: 2, modifiers: 16 })],
    ["mouse delta", (base) => ({ ...base, type: "mouseWheel", x: 1, y: 2, deltaX: 1_000_001 })],
    ["coordinate space", (base) => ({ ...base, type: "mouseMoved", coordinate: { x: 1, y: 2 }, coordinateSpace: "physical" })],
    ["device scale", (base) => ({ ...base, type: "mouseMoved", coordinate: { x: 1, y: 2 }, deviceScaleFactor: 2 })],
    ["route field smuggling", (base) => ({ ...base, type: "mouseMoved", x: 1, y: 2, key: "a" })],
    ["key bytes", (base) => ({ ...base, type: "keyDown", key: "a".repeat(129), code: "KeyA" })],
    ["key boolean", (base) => ({ ...base, type: "keyDown", key: "a", code: "KeyA", autoRepeat: "yes" })],
    ["virtual key code", (base) => ({ ...base, type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65_536 })],
    ["key location", (base) => ({ ...base, type: "keyDown", key: "a", code: "KeyA", location: 4 })],
    ["IME replacement pair", (base) => ({
      ...base,
      type: "imeSetComposition",
      text: "a",
      selectionStart: 0,
      selectionEnd: 1,
      replacementStart: 0,
    })],
  ];
  for (const [label, makeInput] of cases) {
    await t.test(label, async () => {
      const value = fixture();
      const interactiveState = enableInteractive(value);
      const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
      const installed = installLocalDesktopFrameIpc(value);
      const current = await prepareInteractive(value);
      const base = {
        ...current.request,
        frameId: current.frame.frameId,
        frameSequence: current.frame.frameSequence,
        inputSequence: 1,
        controlGeneration: current.lease.controlGeneration,
      };
      const outcome = await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, makeInput(base))
        .then(() => "resolved", () => "rejected");
      assert.equal(outcome, "rejected");
      assert.equal(interactiveState.dispatchCalls.length, 0);
      installed.dispose();
    });
  }
});

test("input accessors and proxies fail before the manager boundary", async () => {
  const value = fixture();
  const interactiveState = enableInteractive(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const current = await prepareInteractive(value);
  const base = {
    ...current.request,
    frameId: current.frame.frameId,
    frameSequence: current.frame.frameSequence,
    inputSequence: 1,
    controlGeneration: current.lease.controlGeneration,
    type: "mouseMoved",
    x: 1,
    y: 2,
  };
  const accessor = { ...base };
  Object.defineProperty(accessor, "modifiers", { enumerable: true, get() { throw new Error("private accessor"); } });
  for (const hostile of [new Proxy(base, {}), accessor]) {
    await assert.rejects(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.sendInput)(current.event, hostile), {
      code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED",
    });
  }
  assert.equal(interactiveState.dispatchCalls.length, 0);
  installed.dispose();
});

test("switch owns and drains a held pre-publication open without closing the replacement bot", async () => {
  const value = fixture();
  const held = holdFirstManagerOpen(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const firstSelection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  await held.entered.promise;
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_B,
    viewGeneration: 2,
  });
  const eventCount = value.first.sent.length;
  held.release.resolve();
  await firstSelection;
  await tick();
  const activeBeforeDispose = [...held.active].sort();
  const noLatePublication = value.first.sent.length === eventCount;
  const closeCalls = [...held.interactiveState.closeCalls];
  await installed.dispose();

  assert.deepEqual(closeCalls, [BOT_A]);
  assert.deepEqual(activeBeforeDispose, [`${BOT_B}:1`]);
  assert.equal(noLatePublication, true);
});

test("clear disposal and sender destruction own a held pre-publication open", async (t) => {
  for (const scenario of ["clear", "dispose", "sender destruction"]) {
    await t.test(scenario, async () => {
      const value = fixture();
      const held = holdFirstManagerOpen(value);
      const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
      const installed = installLocalDesktopFrameIpc(value);
      const event = ipcEvent(value.first.sender);
      const selection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
        botId: BOT_A,
        viewGeneration: 1,
      });
      await held.entered.promise;
      const eventCount = value.first.sent.length;
      let cleanup;
      if (scenario === "clear") {
        cleanup = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(event, { viewGeneration: 2 });
      } else if (scenario === "dispose") {
        cleanup = installed.dispose();
      } else {
        value.first.sender.destroyed = true;
        value.first.sender.emit("destroyed");
        cleanup = null;
      }
      let cleanupSettled = false;
      void Promise.resolve(cleanup).then(() => { cleanupSettled = true; }, () => { cleanupSettled = true; });
      await tick();
      const drainedCleanupStayedPending = scenario === "sender destruction" || !cleanupSettled;
      held.release.resolve();
      await Promise.allSettled([selection, cleanup]);
      await tick();
      if (scenario === "sender destruction") await installed.dispose();
      const activeAfterCleanup = [...held.active];
      const closeCalls = [...held.interactiveState.closeCalls];
      const noLatePublication = value.first.sent.length === eventCount;

      assert.equal(drainedCleanupStayedPending, true);
      assert.deepEqual(closeCalls, [BOT_A]);
      assert.deepEqual(activeAfterCleanup, []);
      assert.equal(noLatePublication, true);
    });
  }
});

test("same-bot generation replacement waits for held-open cleanup before reopening", async () => {
  const value = fixture();
  const held = holdFirstManagerOpen(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const firstSelection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  await held.entered.promise;
  value.states.set(BOT_A, computer(BOT_A, LOCAL_A, 2));
  const replacement = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 2,
  });
  await tick();
  const openCallsBeforeRelease = [...held.openCalls];
  held.release.resolve();
  await Promise.all([firstSelection, replacement]);
  const activeBeforeDispose = [...held.active].sort();
  const closeCalls = [...held.interactiveState.closeCalls];
  const publishedGenerations = frameEvents(value).map((entry) => entry.value.targetGeneration);
  await installed.dispose();

  assert.deepEqual(openCallsBeforeRelease, [`${BOT_A}:1`]);
  assert.deepEqual(closeCalls, [BOT_A]);
  assert.deepEqual(activeBeforeDispose, [`${BOT_A}:2`]);
  assert.deepEqual(publishedGenerations, [2]);
});

test("rejected held open drains its cleanup owner before same-bot replacement", async () => {
  const value = fixture();
  const held = holdFirstManagerOpen(value, { reject: true });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  const firstSelection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  await held.entered.promise;
  value.states.set(BOT_A, computer(BOT_A, LOCAL_A, 2));
  const replacement = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 2,
  });
  await tick();
  const openCallsBeforeRelease = [...held.openCalls];
  held.release.resolve();
  await Promise.all([firstSelection, replacement]);
  const activeBeforeDispose = [...held.active].sort();
  const closeCalls = [...held.interactiveState.closeCalls];
  await installed.dispose();

  assert.deepEqual(openCallsBeforeRelease, [`${BOT_A}:1`]);
  assert.deepEqual(closeCalls, []);
  assert.deepEqual(activeBeforeDispose, [`${BOT_A}:2`]);
});

test("clearing one sender adopts every same-bot sibling open and blocks late control", async () => {
  const value = fixture();
  const held = holdManagerOpenCalls(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);
  const firstSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  const secondSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await Promise.all([held.entered(1), held.entered(2)]);
  const firstEventCount = value.first.sent.length;
  const secondEventCount = value.second.sent.length;
  const cleared = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(firstEvent, { viewGeneration: 2 }));
  held.release(1);
  await tick();
  held.release(2);
  await Promise.allSettled([firstSelection, secondSelection, cleared]);
  await tick();
  const activeBeforeDispose = held.activeBots();
  const closeCalls = [...held.interactiveState.closeCalls];
  const noLatePublication = value.first.sent.length === firstEventCount
    && value.second.sent.length === secondEventCount;
  const controlOutcome = await Promise.resolve().then(() => (
    value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(secondEvent, {
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 2,
      viewGeneration: 1,
    })
  )).then(() => "resolved", () => "rejected");
  await installed.dispose();

  assert.deepEqual(closeCalls, [BOT_A]);
  assert.deepEqual(activeBeforeDispose, []);
  assert.equal(noLatePublication, true);
  assert.equal(controlOutcome, "rejected");
});

test("same-bot sibling cleanup leaves a different-bot replacement active", async () => {
  const value = fixture();
  const held = holdManagerOpenCalls(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);
  const firstSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  const secondSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await Promise.all([held.entered(1), held.entered(2)]);
  const cleared = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(firstEvent, { viewGeneration: 2 });
  const botBSelection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_B,
    viewGeneration: 3,
  });
  await botBSelection;
  held.release(1);
  await tick();
  held.release(2);
  await Promise.allSettled([firstSelection, secondSelection, cleared]);
  await tick();
  const activeBeforeDispose = held.activeBots();
  const closeCalls = [...held.interactiveState.closeCalls];
  const firstFrames = frameEvents(value).map((entry) => entry.value.botId);
  const secondFrames = value.second.sent
    .filter((entry) => entry.channel === "openbot-local-frame:frame")
    .map((entry) => entry.value.botId);
  await installed.dispose();

  assert.deepEqual(closeCalls, [BOT_A]);
  assert.deepEqual(activeBeforeDispose, [BOT_B]);
  assert.deepEqual(firstFrames, [BOT_B]);
  assert.deepEqual(secondFrames, []);
});

test("simultaneous clear sender destruction and disposal converge on one sibling cleanup", async () => {
  const value = fixture();
  const held = holdManagerOpenCalls(value);
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);
  const firstSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  const secondSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await Promise.all([held.entered(1), held.entered(2)]);
  const cleared = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(firstEvent, { viewGeneration: 2 }));
  value.second.sender.destroyed = true;
  value.second.sender.emit("destroyed");
  const disposed = installed.dispose();
  held.release(1);
  await tick();
  held.release(2);
  await Promise.allSettled([firstSelection, secondSelection, cleared, disposed]);

  assert.deepEqual(held.interactiveState.closeCalls, [BOT_A]);
  assert.deepEqual(held.activeBots(), []);
  assert.equal(value.first.sent.filter((entry) => entry.channel === "openbot-local-frame:frame").length, 0);
  assert.equal(value.second.sent.filter((entry) => entry.channel === "openbot-local-frame:frame").length, 0);
});

test("one rejected sibling and one successful sibling still close exactly once without publication", async () => {
  const value = fixture();
  const held = holdManagerOpenCalls(value, { rejectedCalls: [1] });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);
  const firstSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  const secondSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await Promise.all([held.entered(1), held.entered(2)]);
  const secondEventCount = value.second.sent.length;
  const cleared = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(firstEvent, { viewGeneration: 2 });
  held.release(1);
  await tick();
  held.release(2);
  await Promise.allSettled([firstSelection, secondSelection, cleared]);
  await tick();
  const activeBeforeDispose = held.activeBots();
  const noSiblingPublication = value.second.sent.length === secondEventCount;
  const closeCalls = [...held.interactiveState.closeCalls];
  await installed.dispose();

  assert.deepEqual(closeCalls, [BOT_A]);
  assert.deepEqual(activeBeforeDispose, []);
  assert.equal(noSiblingPublication, true);
});

test("established-session cleanup adopts a same-bot pending sibling before closing", async () => {
  const value = fixture();
  const held = holdManagerOpenCalls(value, { heldCalls: [2] });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  const secondSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await held.entered(2);
  const secondEventCount = value.second.sent.length;
  const cleared = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(firstEvent, { viewGeneration: 2 });
  await tick();
  const closeCallsBeforeRelease = [...held.interactiveState.closeCalls];
  held.release(2);
  await Promise.allSettled([secondSelection, cleared]);
  await tick();
  const activeBeforeDispose = held.activeBots();
  const closeCalls = [...held.interactiveState.closeCalls];
  const noSiblingPublication = value.second.sent.length === secondEventCount;
  await installed.dispose();

  assert.deepEqual(closeCallsBeforeRelease, []);
  assert.deepEqual(closeCalls, [BOT_A]);
  assert.deepEqual(activeBeforeDispose, []);
  assert.equal(noSiblingPublication, true);
});

test("an established sibling forces close when a rejected pending sibling starts cleanup", async () => {
  const value = fixture();
  const held = holdManagerOpenCalls(value, { heldCalls: [2], rejectedCalls: [2] });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);

  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  const secondSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await held.entered(2);
  const firstEventCount = value.first.sent.length;
  const secondEventCount = value.second.sent.length;
  const pendingClear = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(secondEvent, {
    viewGeneration: 2,
  }));
  await tick();
  const establishedClear = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(firstEvent, {
    viewGeneration: 2,
  }));
  held.release(2);
  await Promise.allSettled([secondSelection, pendingClear, establishedClear]);
  await tick();

  assert.deepEqual(held.openCalls, [`${BOT_A}:1:1`, `${BOT_A}:1:2`]);
  assert.deepEqual(held.interactiveState.closeCalls, [BOT_A]);
  assert.deepEqual(held.activeBots(), []);
  assert.equal(value.first.sent.length, firstEventCount);
  assert.equal(value.second.sent.length, secondEventCount);
  await installed.dispose();
});

test("an established cleanup fences a same-bot sibling held before manager open", async () => {
  const readEntered = deferred();
  const readGate = deferred();
  let holdSecondRead = false;
  let value;
  value = fixture({
    read(botId, call) {
      if (holdSecondRead && botId === BOT_A) {
        readEntered.resolve();
        return readGate.promise;
      }
      return value.states.get(botId);
    },
  });
  const held = holdManagerOpenCalls(value, { heldCalls: [] });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc(value);
  const firstEvent = ipcEvent(value.first.sender);
  const secondEvent = ipcEvent(value.second.sender);

  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  holdSecondRead = true;
  const secondSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await readEntered.promise;
  assert.equal(held.openCalls.length, 1);

  const secondEventCount = value.second.sent.length;
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(firstEvent, { viewGeneration: 2 });
  readGate.resolve(value.states.get(BOT_A));
  await Promise.allSettled([secondSelection]);
  await tick();

  assert.deepEqual(held.openCalls, [`${BOT_A}:1:1`]);
  assert.deepEqual(held.interactiveState.closeCalls, [BOT_A]);
  assert.equal(value.second.sent.length, secondEventCount);
  await assert.rejects(Promise.resolve().then(() => value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.acquireControl)(secondEvent, {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    viewGeneration: 1,
  })), { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" });

  holdSecondRead = false;
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(secondEvent, {
    botId: BOT_A,
    viewGeneration: 2,
  });
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(firstEvent, {
    botId: BOT_B,
    viewGeneration: 3,
  });
  assert.deepEqual(held.openCalls, [
    `${BOT_A}:1:1`, `${BOT_A}:1:2`, `${BOT_B}:1:3`,
  ]);
  assert.deepEqual(held.interactiveState.closeCalls, [BOT_A]);
  await installed.dispose();
});

test("readiness-held same-bot admissions are fenced while a post-cleanup generation may replace them", async () => {
  const readiness = deferred();
  const value = fixture();
  let openCalls = 0;
  const interactiveState = enableInteractive(value, {
    open(record) {
      openCalls += 1;
      return publicSession(record, 4, 2);
    },
  });
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const installed = installLocalDesktopFrameIpc({ ...value, ready: readiness.promise });
  const event = ipcEvent(value.first.sender);
  const firstSelection = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  }));
  await tick();
  const cleared = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(event, {
    viewGeneration: 2,
  }));
  const replacement = handled(value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 3,
  }));
  assert.equal(openCalls, 0);
  readiness.resolve();
  await Promise.allSettled([firstSelection, cleared, replacement]);
  await tick();

  assert.equal(openCalls, 1);
  assert.deepEqual(interactiveState.closeCalls, []);
  assert.deepEqual(frameEvents(value).map((entry) => entry.value.viewGeneration), [3]);
  assert.deepEqual(statusEvents(value).map((entry) => entry.value.viewGeneration), [3, 3]);
  await installed.dispose();
});

test("synchronous manager-close reentrancy queues a same-bot replacement behind one cleanup", async () => {
  const value = fixture();
  let openCalls = 0;
  let installed;
  let reentrantSelection = null;
  const { LOCAL_DESKTOP_FRAME_CHANNELS, installLocalDesktopFrameIpc } = require(frameIpcPath);
  const interactiveState = enableInteractive(value, {
    open(record) {
      openCalls += 1;
      return publicSession(record, 4, 2);
    },
    close(botId) {
      reentrantSelection = value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(ipcEvent(value.first.sender), {
        botId,
        viewGeneration: 3,
      });
      void reentrantSelection.catch(() => {});
    },
  });
  installed = installLocalDesktopFrameIpc(value);
  const event = ipcEvent(value.first.sender);
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(event, {
    botId: BOT_A,
    viewGeneration: 1,
  });
  const framesBeforeClear = frameEvents(value).length;
  await value.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.clear)(event, { viewGeneration: 2 });
  await reentrantSelection;
  await tick();

  assert.deepEqual(interactiveState.closeCalls, [BOT_A]);
  assert.equal(openCalls, 2);
  assert.equal(frameEvents(value).length, framesBeforeClear + 1);
  assert.equal(frameEvents(value).at(-1).value.viewGeneration, 3);
  await installed.dispose();
});
