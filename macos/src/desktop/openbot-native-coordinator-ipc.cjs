"use strict";

const OPENBOT_NATIVE_COORDINATOR_CHANNELS = Object.freeze({
  request: "openbot:coordinator-port-request",
  deliver: "openbot:coordinator-port",
});

function failure() {
  const error = new Error("OpenBot native coordinator operation failed.");
  error.code = "OPENBOT_NATIVE_COORDINATOR_OPERATION_FAILED";
  Object.defineProperty(error, "stack", {
    value: "Error: OpenBot native coordinator operation failed.",
  });
  return error;
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

function installOpenBotNativeCoordinatorIpc({
  electron,
  coordinator,
  localDesktopManager = null,
  ready = null,
} = {}) {
  if (!electron?.ipcMain || typeof electron.ipcMain.handle !== "function"
    || typeof electron.ipcMain.removeHandler !== "function"
    || typeof electron.MessageChannelMain !== "function"
    || !electron.BrowserWindow || typeof electron.BrowserWindow.fromWebContents !== "function"
    || !coordinator || typeof coordinator.bindPort !== "function"
    || typeof coordinator.dispose !== "function"
    || (ready !== null && (!ready || typeof ready.then !== "function"))
    || (localDesktopManager !== null && typeof localDesktopManager?.ownsWindow !== "function")) {
    throw failure();
  }

  const readiness = ready === null ? Promise.resolve() : Promise.resolve(ready);
  let disposed = false;
  let disposePromise = null;
  const sessions = new Map();
  const teardownEffects = new Set();

  function isLocalDesktopWindow(window) {
    if (!localDesktopManager) return false;
    try { return Boolean(localDesktopManager.ownsWindow(window)); }
    catch { return true; }
  }

  function currentSender(event) {
    try {
      const sender = event?.sender;
      const senderFrame = event?.senderFrame;
      if (!sender || !senderFrame || typeof sender.isDestroyed !== "function"
        || sender.isDestroyed() || typeof sender.once !== "function" || typeof sender.off !== "function"
        || typeof senderFrame.isDestroyed !== "function" || senderFrame.isDestroyed()
        || typeof senderFrame.postMessage !== "function"
        || !sameFrame(sender.mainFrame, senderFrame)) return null;
      const window = electron.BrowserWindow.fromWebContents(sender);
      if (!window || typeof window.isDestroyed !== "function" || window.isDestroyed()
        || window.webContents !== sender || isLocalDesktopWindow(window)) return null;
      return Object.freeze({ sender, senderFrame });
    } catch { return null; }
  }

  function captureEffect(effect) {
    const promise = Promise.resolve(effect).catch(() => undefined);
    teardownEffects.add(promise);
    void promise.finally(() => teardownEffects.delete(promise));
    return promise;
  }

  function closeSession(session) {
    if (!session || session.closed) return session?.teardown || Promise.resolve();
    session.closed = true;
    if (sessions.get(session.sender) === session) sessions.delete(session.sender);
    try { session.sender.off("destroyed", session.onDestroyed); } catch {}
    let effect;
    try { effect = session.disposePort(); }
    catch { effect = undefined; }
    session.teardown = captureEffect(effect);
    return session.teardown;
  }

  async function onRequest(event) {
    if (disposed) throw failure();
    const view = currentSender(event);
    if (!view) throw failure();
    try { await readiness; } catch { throw failure(); }
    if (disposed) throw failure();
    const readyView = currentSender(event);
    if (!readyView || readyView.sender !== view.sender
      || !sameFrame(readyView.senderFrame, view.senderFrame)) throw failure();

    const previous = sessions.get(view.sender);
    if (previous) closeSession(previous);

    let channel;
    let disposePort;
    try {
      channel = new electron.MessageChannelMain();
      if (!channel?.port1 || !channel?.port2) throw failure();
      disposePort = coordinator.bindPort(channel.port1);
      if (typeof disposePort !== "function") throw failure();
    } catch {
      try { channel?.port1?.close?.(); } catch {}
      try { channel?.port2?.close?.(); } catch {}
      throw failure();
    }

    const session = {
      sender: view.sender,
      senderFrame: view.senderFrame,
      disposePort,
      closed: false,
      teardown: null,
      onDestroyed: null,
    };
    session.onDestroyed = () => { closeSession(session); };
    sessions.set(view.sender, session);
    try { view.sender.once("destroyed", session.onDestroyed); }
    catch {
      closeSession(session);
      try { channel.port2.close?.(); } catch {}
      throw failure();
    }

    const current = currentSender(event);
    if (!current || current.sender !== view.sender || !sameFrame(current.senderFrame, view.senderFrame)
      || sessions.get(view.sender) !== session) {
      closeSession(session);
      try { channel.port2.close?.(); } catch {}
      throw failure();
    }
    try {
      view.senderFrame.postMessage(
        OPENBOT_NATIVE_COORDINATOR_CHANNELS.deliver,
        null,
        [channel.port2],
      );
    } catch {
      closeSession(session);
      try { channel.port2.close?.(); } catch {}
      throw failure();
    }
    return null;
  }

  electron.ipcMain.handle(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request, onRequest);

  return Object.freeze({
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      try { electron.ipcMain.removeHandler(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request); } catch {}
      const effects = [...sessions.values()].map(closeSession);
      try { effects.push(Promise.resolve(coordinator.dispose())); }
      catch { effects.push(Promise.resolve()); }
      disposePromise = Promise.allSettled([...effects, ...teardownEffects]).then(() => undefined);
      return disposePromise;
    },
  });
}

module.exports = {
  OPENBOT_NATIVE_COORDINATOR_CHANNELS,
  installOpenBotNativeCoordinatorIpc,
};
