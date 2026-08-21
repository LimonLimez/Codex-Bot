"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^request-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BOOKMARK_BYTES = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;

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
    || !Number.isSafeInteger(value.targetGeneration) || value.targetGeneration < 0
    || (value.startupTimeoutMs !== undefined
      && (!Number.isSafeInteger(value.startupTimeoutMs) || value.startupTimeoutMs < 1
        || value.startupTimeoutMs > 120_000))) {
    throw new TypeError("Local helper transport options are invalid.");
  }
  return {
    spawnHelper: value.spawnHelper,
    childPath: path.resolve(value.childPath),
    workspacePath: path.resolve(value.workspacePath),
    startupTimeoutMs: value.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
  };
}

function plainObject(value) {
  try {
    const prototype = Object.getPrototypeOf(value);
    return Boolean(value && typeof value === "object" && !Array.isArray(value)
      && (prototype === Object.prototype || prototype === null));
  } catch {
    return false;
  }
}

function exactControlFrame(value, type) {
  if (!plainObject(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === 1 && keys[0] === "type"
      && Boolean(descriptors.type) && "value" in descriptors.type
      && descriptors.type.value === type;
  } catch {
    return false;
  }
}

function exactStartupAck(value, nonce) {
  if (!plainObject(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    return keys.length === 2 && keys.includes("type") && keys.includes("nonce")
      && "value" in descriptors.type && descriptors.type.value === "startup-ack"
      && "value" in descriptors.nonce && descriptors.nonce.value === nonce;
  } catch {
    return false;
  }
}

function replyFrame(value) {
  if (!plainObject(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 2 || !keys.includes("type") || !keys.includes("reply")
      || !("value" in descriptors.type) || descriptors.type.value !== "reply"
      || !("value" in descriptors.reply) || !plainObject(descriptors.reply.value)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function messageValue(first, second, hasSecond) {
  if (hasSecond) return second;
  try {
    return first && typeof first === "object" && Object.prototype.hasOwnProperty.call(first, "data")
      ? first.data
      : first;
  } catch {
    return null;
  }
}

async function createLocalHelperTransport(options) {
  const input = normalizeOptions(options);
  let startupNonce;
  try { startupNonce = crypto.randomBytes(32).toString("hex"); } catch {
    throw transportError("Local helper failed to start.", "OPENBOT_LOCAL_HELPER_START_FAILED");
  }
  let child;
  try {
    child = input.spawnHelper(input.childPath, [input.workspacePath], {
      env: Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }),
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
  let ready = false;
  let acknowledged = false;
  let startupTimer = null;
  let resolveStartup;
  let rejectStartup;
  let startupSettled = false;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });

  const clearStartupTimer = () => {
    if (startupTimer !== null) clearTimeout(startupTimer);
    startupTimer = null;
  };

  const removeChildListeners = () => {
    try { child.removeListener?.("message", onMessage); } catch {}
    try { child.removeListener?.("exit", onExit); } catch {}
  };

  const close = (failure, notifyExit = true) => {
    if (closed) return;
    closed = true;
    clearStartupTimer();
    removeChildListeners();
    try { child.kill(); } catch {}
    if (!startupSettled) {
      startupSettled = true;
      rejectStartup(failure);
    }
    if (notifyExit) {
      for (const listener of [...exitListeners]) {
        try { listener(); } catch {}
      }
    }
    messageListeners.clear();
    exitListeners.clear();
  };

  const startupFailure = () => transportError(
    "Local helper failed to start.",
    "OPENBOT_LOCAL_HELPER_START_FAILED",
  );

  const emitExit = () => close(
    transportError("Local helper exited.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE"),
  );

  function onExit() {
    close(acknowledged
      ? transportError("Local helper exited.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE")
      : startupFailure());
  }

  function onMessage(first, second) {
    if (closed) return;
    const message = messageValue(first, second, arguments.length > 1);
    if (!ready) {
      if (exactControlFrame(message, "ready")) {
        ready = true;
        try {
          child.postMessage({ type: "startup-challenge", nonce: startupNonce });
        } catch {
          close(startupFailure());
        }
        return;
      }
      close(startupFailure());
      return;
    }
    if (!acknowledged) {
      if (exactStartupAck(message, startupNonce)) {
        acknowledged = true;
        clearStartupTimer();
        if (!startupSettled) {
          startupSettled = true;
          resolveStartup();
        }
        return;
      }
      close(startupFailure());
      return;
    }
    if (!replyFrame(message)) {
      close(transportError("Local helper protocol failed.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE"));
      return;
    }
    const reply = message.reply;
    for (const listener of [...messageListeners]) {
      try { listener(reply); } catch {}
    }
  }

  try {
    child.on("message", onMessage);
    child.on("exit", onExit);
  } catch {
    close(startupFailure(), false);
  }

  startupTimer = setTimeout(() => close(startupFailure()), input.startupTimeoutMs);
  startupTimer.unref?.();

  const transport = Object.freeze({
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
    isClosed: () => closed,
    dispose: () => close(
      transportError("Local helper is closed.", "OPENBOT_LOCAL_HELPER_UNAVAILABLE"),
    ),
  });

  await startup;
  if (closed) throw startupFailure();
  return transport;
}

module.exports = {
  LocalHelperTransportError,
  createLocalHelperTransport,
};
