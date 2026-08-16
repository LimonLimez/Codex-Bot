"use strict";

const path = require("node:path");

const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^request-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BOOKMARK_BYTES = 64 * 1024;

class LocalHelperTransportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalHelperTransportError";
    this.code = code;
  }
}

function transportError(message, code) {
  return new LocalHelperTransportError(message, code);
}

function normalizeOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.spawnHelper !== "function"
    || typeof value.childPath !== "string" || !path.isAbsolute(value.childPath)
    || typeof value.workspacePath !== "string" || !path.isAbsolute(value.workspacePath)
    || typeof value.botId !== "string" || !BOT_ID_PATTERN.test(value.botId)
    || typeof value.targetId !== "string" || !TARGET_ID_PATTERN.test(value.targetId)
    || !Number.isSafeInteger(value.targetGeneration) || value.targetGeneration < 0) {
    throw new TypeError("Local helper transport options are invalid.");
  }
  return {
    spawnHelper: value.spawnHelper,
    childPath: path.resolve(value.childPath),
    workspacePath: path.resolve(value.workspacePath),
  };
}

function createLocalHelperTransport(options) {
  const input = normalizeOptions(options);
  let child;
  try {
    child = input.spawnHelper(input.childPath, [input.workspacePath], {
      env: Object.freeze({
        ELECTRON_RUN_AS_NODE: "1",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      }),
      serviceName: "OpenBot Local Helper",
      stdio: "ignore",
    });
  } catch {
    throw transportError("Local helper is unavailable.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
  }
  if (!child || typeof child.postMessage !== "function" || typeof child.on !== "function"
    || typeof child.kill !== "function") {
    try { child?.kill?.(); } catch {}
    throw transportError("Local helper is unavailable.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
  }
  const messageListeners = new Set();
  const exitListeners = new Set();
  let closed = false;

  function emitExit() {
    if (closed) return;
    closed = true;
    try { child.kill(); } catch {}
    for (const listener of [...exitListeners]) {
      try { listener(); } catch {}
    }
    messageListeners.clear();
    exitListeners.clear();
  }

  child.on("message", (message) => {
    if (closed) return;
    if (!message || typeof message !== "object" || Array.isArray(message)
      || message.type !== "reply" || !message.reply || typeof message.reply !== "object") {
      emitExit();
      return;
    }
    for (const listener of [...messageListeners]) {
      try { listener(message.reply); } catch {}
    }
  });
  child.on("exit", emitExit);

  return Object.freeze({
    async send(request) {
      if (closed) throw transportError("Local helper is closed.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
      try { child.postMessage({ type: "run", request }); } catch {
        emitExit();
        throw transportError("Local helper is unavailable.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
      }
    },
    async cancel(requestId) {
      if (closed) throw transportError("Local helper is closed.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
      if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
        throw transportError("Local helper cancellation is invalid.", "OPENBOT_LOCAL_HELPER_CANCEL_FAILED");
      }
      const normalized = requestId.toLowerCase();
      try { child.postMessage({ type: "cancel", requestId: normalized }); } catch {
        emitExit();
        throw transportError("Local helper is unavailable.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
      }
    },
    async authorizeResource(requestId, bookmark) {
      if (closed) throw transportError("Local helper is closed.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
      const bytes = Buffer.isBuffer(bookmark)
        ? Buffer.from(bookmark)
        : bookmark instanceof Uint8Array
          ? Buffer.from(bookmark.buffer, bookmark.byteOffset, bookmark.byteLength)
          : null;
      if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)
        || !bytes || bytes.length === 0 || bytes.length > MAX_BOOKMARK_BYTES) {
        throw transportError("Local resource authorization is invalid.", "OPENBOT_LOCAL_RESOURCE_UNAVAILABLE");
      }
      try { child.postMessage({ type: "authorize", requestId: requestId.toLowerCase(), bookmark: bytes.toString("base64") }); } catch {
        emitExit();
        throw transportError("Local helper is unavailable.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE");
      }
    },
    onMessage(listener) {
      if (typeof listener !== "function") throw new TypeError("Local helper message listener is invalid.");
      if (closed) return () => {};
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onExit(listener) {
      if (typeof listener !== "function") throw new TypeError("Local helper exit listener is invalid.");
      if (closed) {
        queueMicrotask(() => { try { listener(); } catch {} });
        return () => {};
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    dispose: emitExit,
  });
}

module.exports = {
  LocalHelperTransportError,
  createLocalHelperTransport,
};
