"use strict";

const { types } = require("node:util");

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_ID = /^message-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL_CODES = new Set(["OPENBOT_CONVERSATION_STALE", "OPENBOT_CONVERSATION_OPERATION_FAILED"]);
const STANDALONE_IPC_CHANNELS = Object.freeze({
  list: "openbot-conversation:list",
  create: "openbot-conversation:create",
  read: "openbot-conversation:read",
  send: "openbot-conversation:send",
  cancel: "openbot-conversation:cancel",
});
const STANDALONE_CHANGE_CHANNEL = "openbot-conversation:changed";
const STANDALONE_EVENT_CHANNEL = "openbot-conversation:event";

function failure() {
  const error = new Error("OpenBot conversation operation failed.");
  error.code = "OPENBOT_CONVERSATION_OPERATION_FAILED";
  Object.defineProperty(error, "stack", { value: "Error: OpenBot conversation operation failed." });
  return error;
}

function ownData(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw failure();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw failure(); }
  if (prototype !== Object.prototype && prototype !== null) throw failure();
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !fields.has(key)
    || !("value" in descriptors[key])) || [...required].some((key) => !descriptors[key])) throw failure();
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value)) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw failure();
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)) throw failure();
    output.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
    || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) throw failure();
  return output;
}

function botId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) throw failure();
  return value;
}

function conversationId(value) {
  if (typeof value !== "string" || !CONVERSATION_ID.test(value)) throw failure();
  return value;
}

function invocationId(value) {
  if (typeof value !== "string" || !INVOCATION_ID.test(value)) throw failure();
  return value;
}

function timestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) throw failure();
  return value;
}

function text(value, maximum = 64 * 1024, { empty = true } = {}) {
  if (typeof value !== "string" || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximum || (!empty && value.trim().length === 0)) throw failure();
  return value;
}

function summaryPublic(value) {
  const record = ownData(value, new Set([
    "botId", "conversationId", "createdAt", "updatedAt", "status", "preview", "messageCount",
  ]));
  if (!new Set(["idle", "streaming"]).has(record.status)
    || !Number.isSafeInteger(record.messageCount) || record.messageCount < 0 || record.messageCount > 512) throw failure();
  return Object.freeze({
    botId: botId(record.botId),
    conversationId: conversationId(record.conversationId),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
    status: record.status,
    preview: text(record.preview, 160),
    messageCount: record.messageCount,
  });
}

function messagePublic(value) {
  const message = ownData(value, new Set(["messageId", "role", "text", "createdAt"]));
  if (typeof message.messageId !== "string" || !MESSAGE_ID.test(message.messageId)
    || !new Set(["user", "assistant"]).has(message.role)) throw failure();
  return Object.freeze({
    messageId: message.messageId,
    role: message.role,
    text: text(message.text),
    createdAt: timestamp(message.createdAt),
  });
}

function conversationPublic(value) {
  const record = ownData(value, new Set([
    "botId", "conversationId", "createdAt", "updatedAt", "status", "preview", "messages",
  ]));
  if (!new Set(["idle", "streaming"]).has(record.status)) throw failure();
  return Object.freeze({
    botId: botId(record.botId),
    conversationId: conversationId(record.conversationId),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
    status: record.status,
    preview: text(record.preview, 160),
    messages: Object.freeze(denseArray(record.messages, 512).map(messagePublic)),
  });
}

function operationPublic(value) {
  const operation = ownData(value, new Set([
    "botId", "conversationId", "invocationId", "generation", "status",
  ]));
  if (!Number.isSafeInteger(operation.generation) || operation.generation < 0
    || !new Set(["streaming", "cancelled"]).has(operation.status)) throw failure();
  return Object.freeze({
    botId: botId(operation.botId),
    conversationId: conversationId(operation.conversationId),
    invocationId: invocationId(operation.invocationId),
    generation: operation.generation,
    status: operation.status,
  });
}

function eventPublic(value) {
  const base = new Set(["type", "botId", "conversationId", "invocationId", "generation"]);
  let type;
  try { type = ownData(value, new Set([...base, "text", "code"]), base).type; }
  catch { throw failure(); }
  const fields = type === "text-delta" ? new Set([...base, "text"])
    : type === "failed" ? new Set([...base, "code"])
      : new Set(base);
  const event = ownData(value, fields);
  if (!new Set(["text-delta", "completed", "cancelled", "failed"]).has(event.type)
    || !Number.isSafeInteger(event.generation) || event.generation < 0) throw failure();
  const result = {
    type: event.type,
    botId: botId(event.botId),
    conversationId: conversationId(event.conversationId),
    invocationId: invocationId(event.invocationId),
    generation: event.generation,
  };
  if (event.type === "text-delta") result.text = text(event.text);
  if (event.type === "failed") {
    if (!TERMINAL_CODES.has(event.code)) throw failure();
    result.code = event.code;
  }
  return Object.freeze(result);
}

function createRequest(value) {
  const request = ownData(value, new Set(["botId"]));
  return Object.freeze({ botId: botId(request.botId) });
}

function readRequest(value) {
  const request = ownData(value, new Set(["botId", "conversationId"]));
  return Object.freeze({ botId: botId(request.botId), conversationId: conversationId(request.conversationId) });
}

function sendRequest(value) {
  const request = ownData(value, new Set(["botId", "conversationId", "text"]));
  return Object.freeze({
    botId: botId(request.botId),
    conversationId: conversationId(request.conversationId),
    text: text(request.text, 64 * 1024, { empty: false }),
  });
}

function cancelRequest(value) {
  const request = ownData(value, new Set(["botId", "conversationId", "invocationId"]));
  return Object.freeze({
    botId: botId(request.botId),
    conversationId: conversationId(request.conversationId),
    invocationId: invocationId(request.invocationId),
  });
}

function sameFrame(left, right) {
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

function installStandaloneConversationIpc({ electron, controller, ready = null } = {}) {
  if (!electron?.ipcMain || !electron?.BrowserWindow || !controller || types.isProxy(controller)
    || ["list", "create", "read", "send", "cancel", "on", "off"].some((name) => typeof controller[name] !== "function")
    || (ready !== null && (!ready || typeof ready.then !== "function"))) throw failure();
  const readiness = ready === null ? Promise.resolve() : Promise.resolve(ready);
  let disposed = false;
  const registered = [];
  const subscriptions = new Map();
  const invocationOwners = new Map();
  const pendingSends = new Map();
  const trackedSenders = new WeakSet();
  const senderTeardowns = new WeakMap();
  const activeTeardowns = new Set();
  let disposePromise = null;
  function currentSender(event) {
    if (!event?.sender || typeof event.sender.isDestroyed !== "function"
      || typeof electron.BrowserWindow.fromWebContents !== "function") return null;
    try {
      const window = electron.BrowserWindow.fromWebContents(event.sender);
      return window && !window.isDestroyed() && window.webContents === event.sender
        && !event.sender.isDestroyed() ? event.sender : null;
    } catch { return null; }
  }
  function currentMainFrame(event, sender) {
    try {
      const senderFrame = event?.senderFrame;
      if (!senderFrame || !sameFrame(sender?.mainFrame, senderFrame)
        || typeof senderFrame.isDestroyed !== "function" || senderFrame.isDestroyed()) return null;
      return senderFrame;
    } catch { return null; }
  }
  function cancelOwnedInvocation(invocation, owner, detach = true) {
    if (owner.cancelPromise) return owner.cancelPromise;
    if (detach && invocationOwners.get(invocation) === owner) invocationOwners.delete(invocation);
    const request = Object.freeze({
      botId: owner.botId,
      conversationId: owner.conversationId,
      invocationId: invocation,
    });
    try { owner.cancelPromise = Promise.resolve(controller.cancel(request)); }
    catch (error) { owner.cancelPromise = Promise.reject(error); }
    return owner.cancelPromise;
  }
  function cleanupSender(sender) {
    const existing = senderTeardowns.get(sender);
    if (existing) return existing;
    subscriptions.delete(sender);
    const effects = [];
    for (const [id, owner] of invocationOwners) {
      if (owner.sender !== sender) continue;
      effects.push(cancelOwnedInvocation(id, owner));
    }
    for (const [key, pending] of pendingSends) {
      if (pending.sender !== sender) continue;
      pending.cancelRequested = true;
      if (pendingSends.get(key) === pending) pendingSends.delete(key);
      effects.push(pending.done);
    }
    const teardown = Promise.allSettled(effects).then(() => undefined);
    senderTeardowns.set(sender, teardown);
    activeTeardowns.add(teardown);
    void teardown.finally(() => {
      activeTeardowns.delete(teardown);
      if (senderTeardowns.get(sender) === teardown) senderTeardowns.delete(sender);
    });
    return teardown;
  }
  function trackSender(sender) {
    if (trackedSenders.has(sender)) return;
    trackedSenders.add(sender);
    try { sender.once?.("destroyed", () => { void cleanupSender(sender); }); } catch {}
  }
  function subscribe(sender, owner, senderFrame) {
    trackSender(sender);
    const generation = (subscriptions.get(sender)?.subscriptionGeneration ?? 0) + 1;
    const subscription = Object.freeze({
      botId: owner,
      senderFrame,
      subscriptionGeneration: generation,
    });
    subscriptions.set(sender, subscription);
    return subscription;
  }
  function alive(sender) {
    try { return !sender.isDestroyed(); } catch { return false; }
  }
  function frameAlive(sender, senderFrame) {
    if (!alive(sender)) return false;
    if (senderFrame === null) return true;
    try {
      return typeof senderFrame?.isDestroyed === "function" && !senderFrame.isDestroyed()
        && sameFrame(sender.mainFrame, senderFrame);
    } catch { return false; }
  }
  function sameOwnedFrame(left, right) {
    return left === null ? right === null : right !== null && sameFrame(left, right);
  }
  function publish(sender, channel, value) {
    if (!alive(sender)) {
      void cleanupSender(sender);
      return;
    }
    try { sender.send(channel, value); } catch { void cleanupSender(sender); }
  }
  function handle(channel, operation) {
    electron.ipcMain.handle(channel, async (event, value) => {
      const sender = currentSender(event);
      if (disposed || !sender) throw failure();
      const senderFrame = ready === null ? null : currentMainFrame(event, sender);
      if (ready !== null && !senderFrame) throw failure();
      let frameInvalidated = false;
      let rejectFrameInvalidation = null;
      let navigationListener = null;
      const frameInvalidation = senderFrame === null ? null : new Promise((resolve, reject) => {
        rejectFrameInvalidation = reject;
      });
      void frameInvalidation?.catch(() => {});
      const context = {
        senderFrame,
        onInvalidate: null,
        onStale: null,
        current() {
          return !frameInvalidated && !disposed
            && currentSender(event) === sender && frameAlive(sender, senderFrame);
        },
      };
      const invalidateFrame = () => {
        if (frameInvalidated) return;
        frameInvalidated = true;
        try { context.onInvalidate?.(); } catch {}
        if (typeof context.onStale === "function") {
          try { void Promise.resolve(context.onStale()).catch(() => {}); } catch {}
        }
        rejectFrameInvalidation?.(failure());
      };
      if (senderFrame !== null && typeof sender.on === "function") {
        navigationListener = (_navigationEvent, _url, _isInPlace, isMainFrame) => {
          if (isMainFrame === true) invalidateFrame();
        };
        try { sender.on("did-start-navigation", navigationListener); }
        catch { navigationListener = null; }
      }
      const whileCurrent = (promise) => frameInvalidation === null
        ? promise
        : Promise.race([promise, frameInvalidation]);
      try {
        await whileCurrent(readiness);
        if (!context.current()) throw failure();
        const result = await whileCurrent(Promise.resolve().then(() => operation(sender, value, context)));
        if (!context.current()) {
          if (typeof context.onStale === "function") {
            try { await context.onStale(); } catch {}
          }
          throw failure();
        }
        return result;
      } catch { throw failure(); }
      finally {
        if (navigationListener !== null) {
          try { sender.off?.("did-start-navigation", navigationListener); }
          catch {
            try { sender.removeListener?.("did-start-navigation", navigationListener); } catch {}
          }
        }
      }
    });
    registered.push(channel);
  }
  handle(STANDALONE_IPC_CHANNELS.list, async (sender, value, context) => {
    const owner = botId(value);
    subscribe(sender, owner, context.senderFrame);
    const records = Object.freeze(denseArray(await controller.list(owner), 256).map(summaryPublic));
    if (records.some((record) => record.botId !== owner)) throw failure();
    return records;
  });
  handle(STANDALONE_IPC_CHANNELS.create, async (sender, value, context) => {
    const request = createRequest(value);
    subscribe(sender, request.botId, context.senderFrame);
    const record = summaryPublic(await controller.create(request));
    if (record.botId !== request.botId) throw failure();
    return record;
  });
  handle(STANDALONE_IPC_CHANNELS.read, async (sender, value, context) => {
    const request = readRequest(value);
    subscribe(sender, request.botId, context.senderFrame);
    const record = conversationPublic(await controller.read(request));
    if (record.botId !== request.botId || record.conversationId !== request.conversationId) throw failure();
    return record;
  });
  handle(STANDALONE_IPC_CHANNELS.send, async (sender, value, context) => {
    const request = sendRequest(value);
    const key = `${request.botId}\0${request.conversationId}`;
    if (pendingSends.has(key)) throw failure();
    subscribe(sender, request.botId, context.senderFrame);
    let settlePending;
    const pending = {
      sender,
      senderFrame: context.senderFrame,
      botId: request.botId,
      conversationId: request.conversationId,
      events: [],
      bytes: 0,
      cancelRequested: false,
      done: new Promise((resolve) => { settlePending = resolve; }),
    };
    pendingSends.set(key, pending);
    context.onInvalidate = () => {
      pending.cancelRequested = true;
      pending.events.length = 0;
      pending.bytes = 0;
      if (pendingSends.get(key) === pending) pendingSends.delete(key);
    };
    try {
      const operation = operationPublic(await controller.send(request));
      if (operation.botId !== request.botId || operation.conversationId !== request.conversationId) throw failure();
      const owner = {
        sender, senderFrame: context.senderFrame,
        botId: operation.botId, conversationId: operation.conversationId,
        generation: operation.generation, cancelPromise: null,
      };
      context.onStale = () => cancelOwnedInvocation(operation.invocationId, owner);
      if (pending.cancelRequested || disposed || !frameAlive(sender, context.senderFrame)) {
        await Promise.allSettled([cancelOwnedInvocation(operation.invocationId, owner)]);
        throw failure();
      }
      invocationOwners.set(operation.invocationId, owner);
      pendingSends.delete(key);
      for (const event of pending.events) {
        if (!frameAlive(sender, context.senderFrame)) {
          await Promise.allSettled([cancelOwnedInvocation(operation.invocationId, owner)]);
          throw failure();
        }
        if (event.invocationId === operation.invocationId
          && event.generation === operation.generation) {
          publish(sender, STANDALONE_EVENT_CHANNEL, event);
          if (event.type !== "text-delta") invocationOwners.delete(operation.invocationId);
        }
      }
      return operation;
    } finally {
      if (pendingSends.get(key) === pending) pendingSends.delete(key);
      settlePending();
    }
  });
  handle(STANDALONE_IPC_CHANNELS.cancel, async (sender, value, context) => {
    const request = cancelRequest(value);
    const owner = invocationOwners.get(request.invocationId);
    if (!owner || owner.sender !== sender || owner.botId !== request.botId
      || owner.conversationId !== request.conversationId) throw failure();
    if (!sameOwnedFrame(owner.senderFrame, context.senderFrame)
      || !frameAlive(owner.sender, owner.senderFrame)) {
      await Promise.allSettled([cancelOwnedInvocation(request.invocationId, owner)]);
      throw failure();
    }
    let operation;
    try {
      operation = operationPublic(await cancelOwnedInvocation(request.invocationId, owner, false));
      if (operation.botId !== request.botId || operation.conversationId !== request.conversationId
        || operation.invocationId !== request.invocationId || operation.generation !== owner.generation
        || operation.status !== "cancelled") throw failure();
    } catch {
      if (invocationOwners.get(request.invocationId) === owner) owner.cancelPromise = null;
      throw failure();
    }
    if (invocationOwners.get(request.invocationId) === owner) invocationOwners.delete(request.invocationId);
    return operation;
  });

  const onChanged = (value) => {
    if (disposed) return;
    let record;
    try { record = summaryPublic(value); } catch { return; }
    for (const [sender, subscription] of subscriptions) {
      if (!frameAlive(sender, subscription.senderFrame)) {
        if (subscriptions.get(sender) === subscription) subscriptions.delete(sender);
        continue;
      }
      if (subscription.botId === record.botId) publish(sender, STANDALONE_CHANGE_CHANNEL, record);
    }
  };
  const onEvent = (value) => {
    if (disposed) return;
    let event;
    try { event = eventPublic(value); } catch { return; }
    const owner = invocationOwners.get(event.invocationId);
    if (owner && owner.botId === event.botId && owner.conversationId === event.conversationId
      && owner.generation === event.generation) {
      if (!frameAlive(owner.sender, owner.senderFrame)) {
        void cancelOwnedInvocation(event.invocationId, owner).catch(() => {});
        return;
      }
      publish(owner.sender, STANDALONE_EVENT_CHANNEL, event);
      if (event.type !== "text-delta") invocationOwners.delete(event.invocationId);
      return;
    }
    const pending = pendingSends.get(`${event.botId}\0${event.conversationId}`);
    if (!pending) return;
    if (!frameAlive(pending.sender, pending.senderFrame)) {
      pending.cancelRequested = true;
      pending.events.length = 0;
      pending.bytes = 0;
      return;
    }
    const bytes = event.type === "text-delta" ? Buffer.byteLength(event.text, "utf8") : 0;
    if (pending.events.length >= 65_536 || pending.bytes + bytes > 64 * 1024) return;
    pending.events.push(event);
    pending.bytes += bytes;
  };
  controller.on("changed", onChanged);
  controller.on("event", onEvent);
  return Object.freeze({
    dispose() {
      if (disposePromise) return disposePromise;
      if (disposed) return Promise.resolve();
      disposed = true;
      controller.off("changed", onChanged);
      controller.off("event", onEvent);
      for (const channel of registered) electron.ipcMain.removeHandler(channel);
      const senders = new Set(subscriptions.keys());
      for (const owner of invocationOwners.values()) senders.add(owner.sender);
      for (const pending of pendingSends.values()) senders.add(pending.sender);
      const teardowns = [...senders].map((sender) => cleanupSender(sender));
      teardowns.push(...activeTeardowns);
      disposePromise = Promise.allSettled(teardowns).then(() => {
        subscriptions.clear();
        invocationOwners.clear();
        pendingSends.clear();
      });
      return disposePromise;
    },
  });
}

module.exports = {
  STANDALONE_CHANGE_CHANNEL,
  STANDALONE_EVENT_CHANNEL,
  STANDALONE_IPC_CHANNELS,
  installStandaloneConversationIpc,
};
