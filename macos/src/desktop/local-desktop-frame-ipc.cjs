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
const STATUS_FIELDS = new Set([
  "botId", "targetId", "targetGeneration", "viewGeneration", "state", "code",
]);
const STATUS_STATES = new Set(["connecting", "live", "unavailable", "retrying"]);
const STATUS_CODES = new Set([null, "OPENBOT_LOCAL_CAPTURE_FAILED", "OPENBOT_LOCAL_DESKTOP_STALE"]);
const LOCAL_DESKTOP_FRAME_CHANNELS = Object.freeze({
  select: "openbot-local-frame:select",
  retry: "openbot-local-frame:retry",
  clear: "openbot-local-frame:clear",
});
const LOCAL_DESKTOP_FRAME_EVENT_CHANNEL = "openbot-local-frame:frame";
const LOCAL_DESKTOP_STATUS_EVENT_CHANNEL = "openbot-local-frame:status";
const LOCAL_DESKTOP_FRAME_STATUS_EVENT_CHANNEL = LOCAL_DESKTOP_STATUS_EVENT_CHANNEL;

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

const retryRequest = selectRequest;

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

function displayStatus(value, identity = null) {
  const status = exactObject(value, STATUS_FIELDS);
  if (identity && (status.botId !== identity.botId || status.targetId !== identity.targetId
    || status.targetGeneration !== identity.targetGeneration)) throw failure();
  if (typeof status.botId !== "string" || !BOT_ID.test(status.botId)
    || typeof status.targetId !== "string" || !TARGET_ID.test(status.targetId)
    || !Number.isSafeInteger(status.targetGeneration) || status.targetGeneration < 0
    || !Number.isSafeInteger(status.viewGeneration) || status.viewGeneration < 1
    || !STATUS_STATES.has(status.state) || !STATUS_CODES.has(status.code)) throw failure();
  if ((status.state === "live" || status.state === "connecting" || status.state === "retrying")
    && status.code !== null) throw failure();
  if (status.state === "unavailable" && status.code === null) throw failure();
  return Object.freeze({
    botId: status.botId,
    targetId: status.targetId,
    targetGeneration: status.targetGeneration,
    viewGeneration: status.viewGeneration,
    state: status.state,
    code: status.code,
  });
}

function installLocalDesktopFrameIpc({
  electron,
  manager,
  computerBoundary,
  ready = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!electron?.ipcMain || !electron?.BrowserWindow
    || typeof electron.ipcMain.handle !== "function" || typeof electron.ipcMain.removeHandler !== "function"
    || typeof electron.BrowserWindow.fromWebContents !== "function"
    || !manager || typeof manager.open !== "function" || typeof manager.captureDisplayFrame !== "function"
    || typeof manager.ownsWindow !== "function"
    || !computerBoundary || typeof computerBoundary.read !== "function"
    || (ready !== null && (!ready || typeof ready.then !== "function"))
    || typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") throw failure();
  const readiness = ready === null ? Promise.resolve() : Promise.resolve(ready);
  let disposed = false;
  const subscriptions = new Map();
  const senderViews = new Map();
  const flights = new Map();
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
    if (!subscription) return;
    subscription.invalidated = true;
    if (subscriptions.get(subscription.sender) === subscription) subscriptions.delete(subscription.sender);
    if (subscription.timer !== null) {
      try { clearIntervalFn(subscription.timer); } catch {}
      subscription.timer = null;
    }
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

  function status(subscription, state, code = null) {
    return displayStatus({
      botId: subscription.botId,
      targetId: subscription.targetId,
      targetGeneration: subscription.targetGeneration,
      viewGeneration: subscription.viewGeneration,
      state,
      code,
    });
  }

  function publishStatus(subscription, value) {
    if (!current(subscription)) return false;
    try {
      subscription.sender.send(LOCAL_DESKTOP_STATUS_EVENT_CHANNEL, displayStatus(value, subscription));
      return true;
    } catch { return false; }
  }

  function publishFrame(subscription, identity, frame) {
    if (!current(subscription)) return false;
    const sequence = subscription.sequence + 1;
    if (!Number.isSafeInteger(sequence)) return false;
    subscription.sequence = sequence;
    subscription.lastFrameId = frame.frameId;
    try {
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
      return true;
    } catch { return false; }
  }

  function staleError() {
    const error = failure();
    error.code = "OPENBOT_LOCAL_DESKTOP_STALE";
    return error;
  }

  function captureCode(error) {
    return error?.code === "OPENBOT_LOCAL_DESKTOP_STALE"
      ? "OPENBOT_LOCAL_DESKTOP_STALE"
      : "OPENBOT_LOCAL_CAPTURE_FAILED";
  }

  function isLifecycleFence(error) {
    return typeof error?.code === "string"
      && /(?:DELET|DISPOSE|BOT_DELETING)/i.test(error.code);
  }

  function armTimer(subscription) {
    if (!current(subscription) || subscription.timer !== null) return;
    subscription.timer = setIntervalFn(() => { void capture(subscription); }, FRAME_INTERVAL_MS);
    subscription.timer?.unref?.();
  }

  function capture(subscription) {
    if (!current(subscription)) return Promise.resolve(status(subscription, "unavailable", "OPENBOT_LOCAL_DESKTOP_STALE"));
    if (subscription.inFlight) return subscription.inFlight;
    const captureGeneration = subscription.captureGeneration + 1;
    subscription.captureGeneration = captureGeneration;
    const flight = (async () => {
      try {
        const record = await computerBoundary.read(subscription.botId);
        if (!current(subscription) || subscription.captureGeneration !== captureGeneration) throw staleError();
        const identity = computerIdentity(record, subscription.botId);
        if (!sameIdentity(identity, subscription)) throw staleError();
        await manager.open(record);
        if (!current(subscription) || subscription.captureGeneration !== captureGeneration) throw staleError();
        const openedRecord = await computerBoundary.read(subscription.botId);
        if (!current(subscription) || subscription.captureGeneration !== captureGeneration) throw staleError();
        const openedIdentity = computerIdentity(openedRecord, subscription.botId);
        if (!sameIdentity(identity, openedIdentity)) throw staleError();
        const rawFrame = await manager.captureDisplayFrame(identity);
        if (!current(subscription) || subscription.captureGeneration !== captureGeneration) throw staleError();
        const finalRecord = await computerBoundary.read(subscription.botId);
        if (!current(subscription) || subscription.captureGeneration !== captureGeneration) throw staleError();
        const finalIdentity = computerIdentity(finalRecord, subscription.botId);
        if (!sameIdentity(identity, finalIdentity)) throw staleError();
        const frame = displayFrame(rawFrame, identity);
        if (frame.frameId !== subscription.lastFrameId) publishFrame(subscription, identity, frame);
        const live = status(subscription, "live", null);
        if (current(subscription)) {
          publishStatus(subscription, live);
          armTimer(subscription);
        }
        return live;
      } catch (error) {
        if (isLifecycleFence(error)) {
          invalidate(subscription);
          return status(subscription, "unavailable", "OPENBOT_LOCAL_DESKTOP_STALE");
        }
        const unavailable = status(subscription, "unavailable", captureCode(error));
        if (current(subscription)) {
          if (subscription.timer !== null) {
            try { clearIntervalFn(subscription.timer); } catch {}
            subscription.timer = null;
          }
          publishStatus(subscription, unavailable);
        }
        return unavailable;
      }
    })();
    subscription.inFlight = flight;
    void flight.then(() => {
      if (subscription.inFlight === flight && !current(subscription)) subscription.inFlight = null;
      else if (subscription.inFlight === flight) subscription.inFlight = null;
    }, () => {
      if (subscription.inFlight === flight) subscription.inFlight = null;
    });
    return flight;
  }

  function prepareView({ sender, senderFrame }, request) {
    const previousView = senderViews.get(sender);
    const existing = flights.get(sender);
    if (existing && existing.botId === request.botId && existing.viewGeneration === request.viewGeneration
      && sameFrame(existing.senderFrame, senderFrame)) return { view: existing.view, promise: existing.promise };
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
    return { view, promise: null };
  }

  async function startSelection(view, request, initialState) {
    await readiness;
    if (disposed || !currentView(view)) throw failure();
    const record = await computerBoundary.read(request.botId);
    if (!currentView(view)) throw failure();
    const identity = computerIdentity(record, request.botId);
    const currentRecord = await computerBoundary.read(request.botId);
    if (!currentView(view)) throw failure();
    const currentIdentity = computerIdentity(currentRecord, request.botId);
    if (!sameIdentity(identity, currentIdentity)) throw staleError();
    const subscription = {
      botId: request.botId,
      targetId: identity.targetId,
      targetGeneration: identity.targetGeneration,
      inFlight: null,
      captureGeneration: 0,
      invalidated: false,
      lastFrameId: null,
      sender: view.sender,
      sequence: 0,
      senderFrame: view.senderFrame,
      timer: null,
      view,
      viewGeneration: request.viewGeneration,
    };
    subscriptions.set(view.sender, subscription);
    const initial = status(subscription, initialState, null);
    publishStatus(subscription, initial);
    return capture(subscription);
  }

  function selectOrRetry(event, value, initialState) {
    let request;
    let viewInfo;
    let checked;
    try {
      if (disposed) throw failure();
      checked = currentSender(event);
      if (!checked) throw failure();
      request = initialState === "retrying" ? retryRequest(value) : selectRequest(value);
      viewInfo = prepareView(checked, request);
      if (viewInfo.promise) return viewInfo.promise;
      const promise = startSelection(viewInfo.view, request, initialState).catch(() => { throw failure(); });
      const flight = {
        botId: request.botId,
        senderFrame: checked.senderFrame,
        view: viewInfo.view,
        viewGeneration: request.viewGeneration,
        promise,
      };
      flights.set(checked.sender, flight);
      void promise.then(() => {
        if (flights.get(checked.sender) === flight) flights.delete(checked.sender);
      }, () => {
        if (flights.get(checked.sender) === flight) flights.delete(checked.sender);
      });
      return promise;
    } catch { return Promise.reject(failure()); }
  }

  function clearSelection(event, value) {
    let request;
    let checked;
    try {
      if (disposed) throw failure();
      checked = currentSender(event);
      if (!checked) throw failure();
      request = clearRequest(value);
      const previousView = senderViews.get(checked.sender);
      if (previousView && request.viewGeneration < previousView.viewGeneration) return Promise.resolve(request);
      const previous = subscriptions.get(checked.sender);
      if (previous) invalidate(previous);
      const view = Object.freeze({ botId: null, sender: checked.sender, senderFrame: checked.senderFrame,
        viewGeneration: request.viewGeneration });
      senderViews.set(checked.sender, view);
      ensureDestroyListener(checked.sender);
      return readiness.then(() => {
        if (disposed || !currentView(view)) throw failure();
        return request;
      }).catch(() => { throw failure(); });
    } catch { return Promise.reject(failure()); }
  }

  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.select,
    (event, value) => selectOrRetry(event, value, "connecting"));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.retry,
    (event, value) => selectOrRetry(event, value, "retrying"));
  electron.ipcMain.handle(LOCAL_DESKTOP_FRAME_CHANNELS.clear, clearSelection);
  registered.push(...Object.values(LOCAL_DESKTOP_FRAME_CHANNELS));

  const onChanged = (value) => {
    if (disposed) return;
    let botId;
    try { botId = typeof value?.botId === "string" && BOT_ID.test(value.botId) ? value.botId : null; } catch { return; }
    if (!botId) return;
    for (const subscription of [...subscriptions.values()]) {
      if (subscription.botId === botId) invalidate(subscription);
    }
  };
  computerBoundary.on?.("changed", onChanged);

  function onDestroyed(sender) {
    const subscription = subscriptions.get(sender);
    if (subscription) invalidate(subscription);
    senderViews.delete(sender);
    flights.delete(sender);
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
      flights.clear();
      for (const channel of registered) electron.ipcMain.removeHandler(channel);
    },
  });
}

module.exports = {
  LOCAL_DESKTOP_FRAME_CHANNELS,
  LOCAL_DESKTOP_FRAME_EVENT_CHANNEL,
  LOCAL_DESKTOP_FRAME_STATUS_EVENT_CHANNEL,
  LOCAL_DESKTOP_STATUS_EVENT_CHANNEL,
  installLocalDesktopFrameIpc,
};
