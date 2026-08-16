"use strict";

const { types } = require("node:util");

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FRAME_ID = /^frame-[A-Za-z0-9._:-]{1,128}$/;
const MAX_FRAME_BYTES = 1_048_576;
const MAX_FRAME_WIDTH = 640;
const MAX_FRAME_HEIGHT = 400;
const FRAME_INTERVAL_MS = 1000;
const SELECT_FIELDS = new Set(["botId", "viewGeneration"]);
const CLEAR_FIELDS = new Set(["viewGeneration"]);
const COMPUTER_ENVELOPE_FIELDS = new Set(["botId", "computer"]);
const COMPUTER_STATE_FIELDS = new Set([
  "mode", "generation", "localProfileId", "nativeAgentId", "state", "lastConfirmedAt", "lastErrorCode",
]);
const FRAME_FIELDS = new Set([
  "botId", "targetId", "targetGeneration", "frameId", "width", "height", "mimeType", "bytes",
]);
const LOCAL_DESKTOP_FRAME_CHANNELS = Object.freeze({
  select: "openbot-local-frame:select",
  clear: "openbot-local-frame:clear",
});
const LOCAL_DESKTOP_FRAME_EVENT_CHANNEL = "openbot-local-frame:frame";

function failure() {
  const error = new Error("OpenBot Local Desktop frame operation failed.");
  error.code = "OPENBOT_LOCAL_FRAME_OPERATION_FAILED";
  Object.defineProperty(error, "stack", { value: "Error: OpenBot Local Desktop frame operation failed." });
  return error;
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw failure();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw failure(); }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== fields.size
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !fields.has(key)
      || !("value" in descriptors[key]))
    || [...fields].some((key) => !descriptors[key])) throw failure();
  return Object.fromEntries([...fields].map((key) => [key, descriptors[key].value]));
}

function botId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) throw failure();
  return value;
}

function viewGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure();
  return value;
}

function selectRequest(value) {
  const request = exactObject(value, SELECT_FIELDS);
  return Object.freeze({ botId: botId(request.botId), viewGeneration: viewGeneration(request.viewGeneration) });
}

function clearRequest(value) {
  const request = exactObject(value, CLEAR_FIELDS);
  return Object.freeze({ viewGeneration: viewGeneration(request.viewGeneration) });
}

function computerIdentity(value, expectedBotId) {
  const envelope = exactObject(value, COMPUTER_ENVELOPE_FIELDS);
  const computer = exactObject(envelope.computer, COMPUTER_STATE_FIELDS);
  if (envelope.botId !== expectedBotId || computer.mode !== "local" || computer.state !== "ready"
    || typeof computer.localProfileId !== "string" || !TARGET_ID.test(computer.localProfileId)
    || !Number.isSafeInteger(computer.generation) || computer.generation < 0
    || (computer.nativeAgentId !== null && typeof computer.nativeAgentId !== "string")
    || typeof computer.lastConfirmedAt !== "string" || computer.lastErrorCode !== null) throw failure();
  return Object.freeze({
    botId: expectedBotId,
    targetId: computer.localProfileId,
    targetGeneration: computer.generation,
  });
}

function sameIdentity(left, right) {
  return left.botId === right.botId && left.targetId === right.targetId
    && left.targetGeneration === right.targetGeneration;
}

function sameFrame(left, right) {
  if (left === right) return true;
  try {
    const leftProcessId = left?.processId;
    const leftRoutingId = left?.routingId;
    const rightProcessId = right?.processId;
    const rightRoutingId = right?.routingId;
    return Number.isSafeInteger(leftProcessId) && leftProcessId >= 0
      && Number.isSafeInteger(leftRoutingId) && leftRoutingId >= 0
      && Number.isSafeInteger(rightProcessId) && rightProcessId >= 0
      && Number.isSafeInteger(rightRoutingId) && rightRoutingId >= 0
      && leftProcessId === rightProcessId && leftRoutingId === rightRoutingId;
  } catch { return false; }
}

function displayFrame(value, identity) {
  const frame = exactObject(value, FRAME_FIELDS);
  if (frame.botId !== identity.botId || frame.targetId !== identity.targetId
    || frame.targetGeneration !== identity.targetGeneration
    || typeof frame.frameId !== "string" || !FRAME_ID.test(frame.frameId)
    || !Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > MAX_FRAME_WIDTH
    || !Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > MAX_FRAME_HEIGHT
    || frame.mimeType !== "image/png" || !(frame.bytes instanceof Uint8Array)
    || types.isProxy(frame.bytes) || frame.bytes.byteLength < 1 || frame.bytes.byteLength > MAX_FRAME_BYTES) throw failure();
  return Object.freeze({
    frameId: frame.frameId,
    width: frame.width,
    height: frame.height,
    bytes: Uint8Array.from(frame.bytes),
  });
}

function installLocalDesktopFrameIpc({
  electron,
  manager,
  computerBoundary,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!electron?.ipcMain || !electron?.BrowserWindow
    || typeof electron.ipcMain.handle !== "function" || typeof electron.ipcMain.removeHandler !== "function"
    || typeof electron.BrowserWindow.fromWebContents !== "function"
    || !manager || typeof manager.open !== "function" || typeof manager.captureDisplayFrame !== "function"
    || typeof manager.ownsWindow !== "function"
    || !computerBoundary || typeof computerBoundary.read !== "function"
    || typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") throw failure();
  let disposed = false;
  const subscriptions = new Map();
  const senderViews = new Map();
  const destroyListeners = new Map();
  const registered = [];

  function currentSender(event) {
    try {
      const sender = event?.sender;
      const senderFrame = event?.senderFrame;
      if (!sender || !senderFrame || typeof sender.isDestroyed !== "function" || sender.isDestroyed()
        || typeof sender.send !== "function" || typeof sender.once !== "function" || typeof sender.off !== "function"
        || !sameFrame(sender.mainFrame, senderFrame) || typeof senderFrame.isDestroyed !== "function"
        || senderFrame.isDestroyed()) return null;
      const window = electron.BrowserWindow.fromWebContents(sender);
      if (!window || typeof window.isDestroyed !== "function" || window.isDestroyed()
        || window.webContents !== sender || typeof window.webContents.isDestroyed !== "function"
        || window.webContents.isDestroyed() || manager.ownsWindow(window)) return null;
      return Object.freeze({ sender, senderFrame });
    } catch { return null; }
  }

  function currentView(view) {
    if (disposed || senderViews.get(view.sender) !== view) return false;
    try {
      if (view.sender.isDestroyed() || !sameFrame(view.sender.mainFrame, view.senderFrame)
        || view.senderFrame.isDestroyed()) return false;
      const window = electron.BrowserWindow.fromWebContents(view.sender);
      return Boolean(window && !window.isDestroyed() && window.webContents === view.sender
        && !window.webContents.isDestroyed() && !manager.ownsWindow(window));
    } catch { return false; }
  }

  function current(subscription) {
    return !disposed && subscriptions.get(subscription.sender) === subscription
      && currentView(subscription.view);
  }

  function invalidate(subscription) {
    if (subscriptions.get(subscription.sender) === subscription) subscriptions.delete(subscription.sender);
    try { clearIntervalFn(subscription.timer); } catch {}
  }

  function ensureDestroyListener(sender) {
    if (destroyListeners.has(sender)) return;
    const listener = () => {
      onDestroyed(sender);
      destroyListeners.delete(sender);
    };
    sender.once("destroyed", listener);
    destroyListeners.set(sender, listener);
  }

  async function capture(subscription) {
    if (!current(subscription) || subscription.inFlight) return;
    subscription.inFlight = true;
    try {
      const record = await computerBoundary.read(subscription.botId);
      if (!current(subscription)) return;
      const identity = computerIdentity(record, subscription.botId);
      await manager.open(record);
      if (!current(subscription)) return;
      const openedRecord = await computerBoundary.read(subscription.botId);
      if (!current(subscription)) return;
      const openedIdentity = computerIdentity(openedRecord, subscription.botId);
      if (!sameIdentity(identity, openedIdentity)) return;
      const rawFrame = await manager.captureDisplayFrame(identity);
      if (!current(subscription)) return;
      const finalRecord = await computerBoundary.read(subscription.botId);
      if (!current(subscription)) return;
      const finalIdentity = computerIdentity(finalRecord, subscription.botId);
      if (!sameIdentity(identity, finalIdentity)) return;
      const frame = displayFrame(rawFrame, identity);
      if (frame.frameId === subscription.lastFrameId) return;
      const sequence = subscription.sequence + 1;
      if (!Number.isSafeInteger(sequence)) return;
      subscription.sequence = sequence;
      subscription.lastFrameId = frame.frameId;
      subscription.sender.send(LOCAL_DESKTOP_FRAME_EVENT_CHANNEL, Object.freeze({
        botId: identity.botId,
        targetId: identity.targetId,
        targetGeneration: identity.targetGeneration,
        viewGeneration: subscription.viewGeneration,
        sequence,
        width: frame.width,
        height: frame.height,
        mimeType: "image/png",
        bytes: frame.bytes,
      }));
    } catch {}
    finally {
      if (current(subscription)) subscription.inFlight = false;
    }
  }

  function handle(channel, operation) {
    electron.ipcMain.handle(channel, async (event, value) => {
      try {
        if (disposed) throw failure();
        const sender = currentSender(event);
        if (!sender) throw failure();
        return await operation(sender, value);
      } catch { throw failure(); }
    });
    registered.push(channel);
  }

  handle(LOCAL_DESKTOP_FRAME_CHANNELS.select, async ({ sender, senderFrame }, value) => {
    const request = selectRequest(value);
    const previousView = senderViews.get(sender);
    if (previousView && request.viewGeneration <= previousView.viewGeneration) throw failure();
    const previous = subscriptions.get(sender);
    if (previous) invalidate(previous);
    const view = Object.freeze({
      botId: request.botId,
      sender,
      senderFrame,
      viewGeneration: request.viewGeneration,
    });
    senderViews.set(sender, view);
    ensureDestroyListener(sender);
    const record = await computerBoundary.read(request.botId);
    if (!currentView(view)) throw failure();
    const identity = computerIdentity(record, request.botId);
    const currentRecord = await computerBoundary.read(request.botId);
    if (!currentView(view)) throw failure();
    const currentIdentity = computerIdentity(currentRecord, request.botId);
    if (!sameIdentity(identity, currentIdentity)) throw failure();
    const subscription = {
      botId: request.botId,
      inFlight: false,
      lastFrameId: null,
      sender,
      sequence: 0,
      senderFrame,
      timer: null,
      view,
      viewGeneration: request.viewGeneration,
    };
    subscriptions.set(sender, subscription);
    subscription.timer = setIntervalFn(() => { void capture(subscription); }, FRAME_INTERVAL_MS);
    subscription.timer?.unref?.();
    void capture(subscription);
    return request;
  });

  handle(LOCAL_DESKTOP_FRAME_CHANNELS.clear, async ({ sender, senderFrame }, value) => {
    const request = clearRequest(value);
    const previousView = senderViews.get(sender);
    if (previousView && request.viewGeneration < previousView.viewGeneration) return request;
    const view = Object.freeze({
      botId: null,
      sender,
      senderFrame,
      viewGeneration: request.viewGeneration,
    });
    senderViews.set(sender, view);
    ensureDestroyListener(sender);
    const subscription = subscriptions.get(sender);
    if (subscription && subscription.viewGeneration <= request.viewGeneration) invalidate(subscription);
    return request;
  });

  const onChanged = (value) => {
    if (disposed || !value || typeof value.botId !== "string") return;
    for (const subscription of [...subscriptions.values()]) {
      if (subscription.botId === value.botId) invalidate(subscription);
    }
  };
  computerBoundary.on?.("changed", onChanged);

  function onDestroyed(sender) {
    const subscription = subscriptions.get(sender);
    if (subscription) invalidate(subscription);
    senderViews.delete(sender);
  }

  return Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const subscription of [...subscriptions.values()]) invalidate(subscription);
      computerBoundary.off?.("changed", onChanged);
      for (const [sender, listener] of destroyListeners) sender.off?.("destroyed", listener);
      destroyListeners.clear();
      senderViews.clear();
      for (const channel of registered) electron.ipcMain.removeHandler(channel);
    },
  });
}

module.exports = {
  LOCAL_DESKTOP_FRAME_CHANNELS,
  LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
  installLocalDesktopFrameIpc,
};
