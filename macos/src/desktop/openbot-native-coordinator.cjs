"use strict";

const { createHash } = require("node:crypto");
const { types } = require("node:util");

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_REQUEST_ID_BYTES = 256;
const MAX_METHOD_BYTES = 128;
const MAX_CLIENT_NONCE_BYTES = 512;
const MAX_AGENTS = 1024;
const MAX_AGENT_IDS = 256;
const MAX_CONVERSATIONS = 256;
const MAX_MESSAGES = 512;
const MAX_TAIL_LIMIT = 500;
const MAX_INFLIGHT_REQUESTS = 64;
const MAX_REQUESTS_PER_PORT = 4096;
const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const APPEARANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TERMINAL_EVENTS = new Set(["completed", "failed", "cancelled"]);
const EMPTY_AGENT_ARRAY_READ_METHODS = new Set([
  "getAgentWorkflows",
  "getConversationOutline",
  "getSubagents",
  "getAsyncTasks",
  "getAgentAutomations",
]);
const EMPTY_NONE_ARRAY_READ_METHODS = new Set([
  "skillsCatalog",
  "syncPluginSkills",
  "getTrays",
  "listAllAutomations",
]);
const FALSE_NONE_READ_METHODS = new Set([
  "isAgentNetworkEnabled",
  "isGlobalSearchEnabled",
  "isEgressTunnelAvailable",
]);
const SUPPORTED_METHODS = new Set([
  "listAgents",
  "countAgents",
  "searchAgents",
  "searchMedia",
  "createAgent",
  "updateAgent",
  "deleteAgents",
  "kickstartAgent",
  "getCloudAgentInfo",
  "getAgentAvatar",
  ...EMPTY_AGENT_ARRAY_READ_METHODS,
  ...EMPTY_NONE_ARRAY_READ_METHODS,
  "getForeverBoxStatus",
  "getTeachRecordingStatus",
  "getAgentChannels",
  "getBoxSecretsStatus",
  ...FALSE_NONE_READ_METHODS,
  "getSharingState",
  "openAgentTail",
  "getAgentTranscriptTail",
  "sendPrompt",
  "promptAcceptanceStatus",
  "setAgentUnread",
]);

class OpenBotNativeCoordinatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenBotNativeCoordinatorError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function coordinatorFailure(code, message) {
  return new OpenBotNativeCoordinatorError(code, message);
}

function capabilityUnavailable(method) {
  return coordinatorFailure("source/capability-unavailable", `unknown gateway method: ${method}`);
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function cloneFrameData(value, state = { bytes: 0, nodes: 0, seen: new Set() }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 8192 || depth > 16 || state.bytes > MAX_FRAME_BYTES) throw new TypeError("unsafe frame");
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("unsafe number");
    return value;
  }
  if (typeof value === "string") {
    const bytes = utf8Bytes(value);
    state.bytes += bytes;
    if (bytes > MAX_TEXT_BYTES || state.bytes > MAX_FRAME_BYTES) throw new TypeError("oversized string");
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value) || state.seen.has(value)) {
    throw new TypeError("unsafe object");
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("unsafe object");
  }
  const array = Array.isArray(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) throw new TypeError("unsafe prototype");
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || DANGEROUS_KEYS.has(key)
    || !("value" in descriptors[key]))) throw new TypeError("unsafe fields");
  if (array) {
    const length = descriptors.length?.value;
    const elementKeys = keys.filter((key) => key !== "length");
    if (!Number.isSafeInteger(length) || length < 0 || length > 4096
      || elementKeys.length !== length
      || elementKeys.some((key, index) => key !== String(index))) throw new TypeError("unsafe array");
  }
  state.seen.add(value);
  const output = array ? [] : (prototype === null ? Object.create(null) : {});
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === "length") continue;
    state.bytes += utf8Bytes(key);
    if (state.bytes > MAX_FRAME_BYTES) throw new TypeError("oversized frame");
    output[key] = cloneFrameData(descriptor.value, state, depth + 1);
  }
  state.seen.delete(value);
  return output;
}

function messageData(event) {
  if (!event || typeof event !== "object" || types.isProxy(event)) throw new TypeError("unsafe message event");
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(event, "data"); } catch { throw new TypeError("unsafe message event"); }
  if (!descriptor || !("value" in descriptor)) throw new TypeError("unsafe message event");
  return descriptor.value;
}

function exactRecord(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key)) || [...required].some((key) => !Object.hasOwn(value, key))) {
    throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
  }
  return value;
}

function boundedString(value, maximumBytes, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.includes("\0") || utf8Bytes(value) > maximumBytes
    || (!allowEmpty && value.trim().length === 0)) {
    throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
  }
  return value;
}

function optionalFiniteNumber(value) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
  }
  return value;
}

function promptInputDigest({
  agentId,
  prompt,
  richText,
  replyToId,
  isFork,
  attachmentPaths,
  attachmentNames,
}) {
  return createHash("sha256").update(JSON.stringify([
    agentId ?? null,
    prompt,
    richText ?? null,
    replyToId ?? null,
    isFork === true,
    [...(attachmentPaths ?? [])],
    [...(attachmentNames ?? [])],
  ])).digest("hex");
}

function botId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) {
    throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
  }
  return value;
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum
    || Object.keys(value).length !== value.length
    || Object.keys(value).some((key, index) => key !== String(index))) {
    throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
  }
  return [...value];
}

function deletionOutcome(rawValue, expectedBotIds) {
  const value = cloneFrameData(rawValue);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).sort().join(",") !== "activeBotId,deletedBotIds,survivingBotIds") {
    throw new TypeError("invalid deletion outcome");
  }
  const normalizeIds = (rawIds, maximum) => {
    const ids = denseArray(rawIds, maximum);
    if (ids.some((id) => typeof id !== "string" || !BOT_ID.test(id))
      || new Set(ids).size !== ids.length) throw new TypeError("invalid deletion outcome");
    return ids;
  };
  const deletedBotIds = normalizeIds(value.deletedBotIds, MAX_AGENT_IDS);
  const survivingBotIds = normalizeIds(value.survivingBotIds, MAX_AGENTS);
  const activeBotId = value.activeBotId;
  const deleted = new Set(deletedBotIds);
  if (deletedBotIds.length !== expectedBotIds.length
    || expectedBotIds.some((id) => !deleted.has(id))
    || survivingBotIds.some((id) => deleted.has(id))
    || (activeBotId !== null
      && (typeof activeBotId !== "string" || !BOT_ID.test(activeBotId)
        || !survivingBotIds.includes(activeBotId)))) {
    throw new TypeError("invalid deletion outcome");
  }
  return Object.freeze({
    deletedBotIds: Object.freeze(deletedBotIds),
    survivingBotIds: Object.freeze(survivingBotIds),
    activeBotId,
  });
}

function timestampMs(value) {
  if (typeof value !== "string") throw new TypeError("invalid timestamp");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new TypeError("invalid timestamp");
  return parsed;
}

function appearanceId(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !APPEARANCE_ID.test(value)) {
    throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
  }
  return value;
}

function cloneReplyValue(value) {
  if (value === undefined) return undefined;
  return cloneFrameData(value);
}

function failureOutcome(error, method) {
  if (error instanceof OpenBotNativeCoordinatorError) {
    return { status: "failed", failure: { code: error.code, message: error.message } };
  }
  return {
    status: "failed",
    failure: {
      code: "source/transport-failure",
      message: `OpenBot native ${method} failed.`,
    },
  };
}

function validateBot(bot) {
  if (!bot || typeof bot !== "object" || Array.isArray(bot) || !BOT_ID.test(bot.botId)
    || typeof bot.name !== "string" || bot.name.trim().length === 0 || utf8Bytes(bot.name) > 160
    || typeof bot.notifications !== "boolean" || !bot.appearance || typeof bot.appearance !== "object") {
    throw new TypeError("invalid bot record");
  }
  const appearance = bot.appearance;
  if (typeof appearance.shape !== "string" || typeof appearance.color !== "string"
    || typeof appearance.title !== "string" || typeof appearance.description !== "string") {
    throw new TypeError("invalid bot appearance");
  }
  timestampMs(bot.createdAt);
  timestampMs(bot.updatedAt);
  return bot;
}

function agentRow(rawBot, unread) {
  const bot = validateBot(rawBot);
  const createdAt = timestampMs(bot.createdAt);
  const updatedAt = timestampMs(bot.updatedAt);
  const row = {
    id: bot.botId,
    name: bot.name,
    description: bot.appearance.description,
    title: bot.appearance.title,
    avatarShape: bot.appearance.shape,
    avatarColor: bot.appearance.color,
    avatarVersion: bot.updatedAt,
    createdAt,
    updatedAt,
    path: "",
    lastEntry: null,
    lastMessageId: null,
    newestEntryId: null,
    hasUnread: unread === true,
    unreadCount: unread === true ? 1 : 0,
    lastViewedAt: null,
    lastActivityAt: updatedAt,
    awaitingUserResponse: null,
    notificationsEnabled: bot.notifications,
    notifyOnUpdatesEnabled: bot.notifications,
    isHiddenFromSidebar: false,
    isActive: false,
    origin: "user",
    purpose: null,
    isGroup: false,
    memberIds: [],
    isSharedRoom: false,
    sharedRoomId: null,
    conversationPartnerIds: [],
  };
  if (typeof bot.appearance.image === "string"
    && utf8Bytes(bot.appearance.image) <= Math.floor(MAX_FRAME_BYTES / 2)) {
    row.avatarDataUrl = bot.appearance.image;
  }
  return row;
}

function validateConversationSummary(value, expectedBotId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.botId !== expectedBotId || typeof value.conversationId !== "string"
    || !CONVERSATION_ID.test(value.conversationId)) throw new TypeError("invalid conversation summary");
  return value;
}

function validateConversationRecord(value, expectedBotId, expectedConversationId) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.botId !== expectedBotId || value.conversationId !== expectedConversationId
    || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) {
    throw new TypeError("invalid conversation record");
  }
  return value;
}

class OpenBotNativeCoordinator {
  #bots;
  #conversations;
  #deleteBots;
  #onSelectAgent;
  #readActiveAgentId;
  #now;
  #bindings = new Set();
  #conversationIds = new Map();
  #conversationPromises = new Map();
  #clientNonces = new Map();
  #acceptances = new Map();
  #operations = new Map();
  #pendingOperations = new Map();
  #unread = new Map();
  #botEpochs = new Map();
  #deletionClaims = new Map();
  #deletedBots = new Set();
  #rosterEpoch = 0;
  #activeAgentId = "";
  #activeRevision = 0;
  #activeAgentInitialized = false;
  #activeAgentPromise = null;
  #disposed = false;
  #botListener;
  #conversationListener;

  constructor({
    botRuntimeController,
    conversationController,
    deleteBots = null,
    onSelectAgent = null,
    readActiveAgentId = null,
    now = Date.now,
  } = {}) {
    if (!botRuntimeController
      || ["listBots", "createBot", "renameBot", "updateProfile"].some(
        (name) => typeof botRuntimeController[name] !== "function",
      )
      || typeof botRuntimeController.on !== "function"
      || (typeof botRuntimeController.off !== "function" && typeof botRuntimeController.removeListener !== "function")) {
      throw new TypeError("OpenBot native coordinator requires a BotRuntimeController-like dependency.");
    }
    if (!conversationController
      || ["list", "create", "read", "send"].some((name) => typeof conversationController[name] !== "function")
      || typeof conversationController.on !== "function"
      || (typeof conversationController.off !== "function"
        && typeof conversationController.removeListener !== "function")) {
      throw new TypeError("OpenBot native coordinator requires a StandaloneConversationController-like dependency.");
    }
    if (deleteBots !== null && typeof deleteBots !== "function") {
      throw new TypeError("OpenBot native coordinator deleteBots must be a function.");
    }
    if (onSelectAgent !== null && typeof onSelectAgent !== "function") {
      throw new TypeError("OpenBot native coordinator onSelectAgent must be a function.");
    }
    if (readActiveAgentId !== null && typeof readActiveAgentId !== "function") {
      throw new TypeError("OpenBot native coordinator readActiveAgentId must be a function.");
    }
    if (typeof now !== "function") throw new TypeError("OpenBot native coordinator now must be a function.");
    this.#bots = botRuntimeController;
    this.#conversations = conversationController;
    this.#deleteBots = deleteBots;
    this.#onSelectAgent = onSelectAgent;
    this.#readActiveAgentId = readActiveAgentId;
    this.#now = now;
    this.#botListener = () => {
      this.#advanceRosterEpoch();
      void this.#publishAgentsToAll();
    };
    this.#conversationListener = (event) => { this.#receiveConversationEvent(event); };
    this.#bots.on("bot-changed", this.#botListener);
    this.#conversations.on("event", this.#conversationListener);
  }

  bindPort(port) {
    if (this.#disposed) throw coordinatorFailure(
      "OPENBOT_NATIVE_COORDINATOR_DISPOSED",
      "OpenBot native coordinator is disposed.",
    );
    if (!port || typeof port.postMessage !== "function" || typeof port.on !== "function"
      || (typeof port.off !== "function" && typeof port.removeListener !== "function")
      || typeof port.start !== "function" || typeof port.close !== "function") {
      throw new TypeError("OpenBot native coordinator requires an Electron MessagePortMain-like port.");
    }
    const binding = {
      port,
      state: "awaiting-hello",
      disposed: false,
      seenRequestIds: new Set(),
      inflight: 0,
      requests: new Map(),
      onMessage: null,
    };
    binding.onMessage = (event) => this.#receivePortMessage(binding, event);
    port.on("message", binding.onMessage);
    try { port.start(); } catch (error) {
      this.#removePortListener(binding);
      try { port.close(); } catch {}
      throw error;
    }
    this.#bindings.add(binding);
    return () => this.#disposeBinding(binding);
  }

  #receivePortMessage(binding, event) {
    if (binding.disposed) return;
    let frame;
    try { frame = cloneFrameData(messageData(event)); } catch {
      this.#protocolError(binding, "malformed-frame");
      return;
    }
    if (binding.state === "awaiting-hello") {
      if (!this.#isHello(frame)) {
        this.#protocolError(binding, frame?.kind === "request" ? "hello-required" : "malformed-frame");
        return;
      }
      binding.state = "ready";
      this.#post(binding, { kind: "lifecycle", phase: "ready", protocolVersion: PROTOCOL_VERSION });
      void this.#publishAgents(binding);
      return;
    }
    if (this.#isHello(frame)) {
      this.#protocolError(binding, "duplicate-hello");
      return;
    }
    if (this.#isRequestedShutdown(frame)) {
      this.#disposeBinding(binding);
      return;
    }
    if (frame?.kind === "cancel") {
      if (!this.#isCancel(frame)) {
        this.#protocolError(binding, "malformed-frame");
        return;
      }
      const operation = binding.requests.get(frame.requestId);
      if (operation && !operation.cancelled) {
        operation.cancelled = true;
        this.#post(binding, {
          kind: "reply",
          requestId: frame.requestId,
          outcome: {
            status: "failed",
            failure: { code: "cancelled", message: "OpenBot native request was cancelled." },
          },
        });
      }
      return;
    }
    if (!this.#isRequest(frame)) {
      this.#protocolError(binding, "malformed-frame");
      return;
    }
    if (binding.seenRequestIds.has(frame.requestId)) {
      this.#protocolError(binding, "duplicate-request-id");
      return;
    }
    if (binding.seenRequestIds.size >= MAX_REQUESTS_PER_PORT || binding.inflight >= MAX_INFLIGHT_REQUESTS) {
      this.#protocolError(binding, "request-limit");
      return;
    }
    binding.seenRequestIds.add(frame.requestId);
    binding.inflight += 1;
    const operation = { cancelled: false };
    binding.requests.set(frame.requestId, operation);
    void Promise.resolve()
      .then(() => this.#dispatch(frame.method, frame.args))
      .then((value) => ({ status: "ok", value: cloneReplyValue(value) }))
      .catch((error) => failureOutcome(error, frame.method))
      .then((outcome) => {
        binding.inflight -= 1;
        binding.requests.delete(frame.requestId);
        if (operation.cancelled || binding.disposed || binding.state !== "ready") return;
        this.#post(binding, { kind: "reply", requestId: frame.requestId, outcome });
      });
  }

  #isHello(frame) {
    return frame && typeof frame === "object" && !Array.isArray(frame)
      && Object.keys(frame).length === 3
      && frame.kind === "lifecycle" && frame.phase === "hello"
      && frame.protocolVersion === PROTOCOL_VERSION;
  }

  #isRequestedShutdown(frame) {
    return frame && typeof frame === "object" && !Array.isArray(frame)
      && Object.keys(frame).length === 4
      && frame.kind === "lifecycle" && frame.phase === "shutdown"
      && frame.reason === "requested" && frame.detail === null;
  }

  #isCancel(frame) {
    return frame && typeof frame === "object" && !Array.isArray(frame)
      && Object.keys(frame).length === 2
      && frame.kind === "cancel"
      && typeof frame.requestId === "string" && frame.requestId.length > 0
      && utf8Bytes(frame.requestId) <= MAX_REQUEST_ID_BYTES;
  }

  #isRequest(frame) {
    return frame && typeof frame === "object" && !Array.isArray(frame)
      && Object.keys(frame).length === 4
      && frame.kind === "request"
      && typeof frame.requestId === "string" && frame.requestId.length > 0
      && utf8Bytes(frame.requestId) <= MAX_REQUEST_ID_BYTES
      && typeof frame.method === "string" && frame.method.length > 0
      && utf8Bytes(frame.method) <= MAX_METHOD_BYTES
      && Object.hasOwn(frame, "args");
  }

  async #dispatch(method, args) {
    if (!SUPPORTED_METHODS.has(method)) {
      throw capabilityUnavailable(method);
    }
    if (method === "listAgents") {
      this.#noneArgs(args);
      return this.#agentRows();
    }
    if (method === "countAgents") {
      this.#noneArgs(args);
      return (await this.#agentRows()).length;
    }
    if (method === "searchAgents" || method === "searchMedia") {
      return this.#emptySearch(args);
    }
    if (method === "createAgent") return this.#createAgent(args);
    if (method === "updateAgent") return this.#updateAgent(args);
    if (method === "deleteAgents") return this.#deleteAgents(args);
    if (method === "kickstartAgent") return this.#kickstartAgent(args);
    if (method === "getCloudAgentInfo") return this.#cloudAgentInfo(args);
    if (method === "getAgentAvatar") return this.#agentAvatar(args);
    if (EMPTY_AGENT_ARRAY_READ_METHODS.has(method)) return this.#emptyAgentArray(args);
    if (EMPTY_NONE_ARRAY_READ_METHODS.has(method)) {
      this.#noneArgs(args);
      return [];
    }
    if (method === "getForeverBoxStatus") {
      await this.#localBotFromIdArgs(args);
      return null;
    }
    if (method === "getTeachRecordingStatus") {
      this.#noneArgs(args);
      return { state: "idle", agentId: null, startedAtMs: null, maxDurationMs: 600_000 };
    }
    if (method === "getAgentChannels") {
      await this.#localBotFromIdArgs(args);
      return { manifests: [], connections: [] };
    }
    if (method === "getBoxSecretsStatus") {
      this.#noneArgs(args);
      return { keys: [], isApplied: false, lastAppliedAtMs: null };
    }
    if (FALSE_NONE_READ_METHODS.has(method)) {
      this.#noneArgs(args);
      return false;
    }
    if (method === "getSharingState") {
      this.#noneArgs(args);
      return {
        isEnabled: false,
        selfAuthId: null,
        pendingJoinRequests: [],
        rooms: [],
        typingUsers: [],
      };
    }
    if (method === "setAgentUnread") return this.#setAgentUnread(args);
    if (method === "openAgentTail" || method === "getAgentTranscriptTail") {
      return this.#tail(args, method === "openAgentTail");
    }
    if (method === "sendPrompt") return this.#sendPrompt(args);
    if (method === "promptAcceptanceStatus") return this.#promptAcceptanceStatus(args);
    throw capabilityUnavailable(method);
  }

  #noneArgs(args) {
    exactRecord(args, new Set(), new Set());
  }

  #advanceRosterEpoch() {
    if (!Number.isSafeInteger(this.#rosterEpoch + 1)) throw new TypeError("native roster epoch exhausted");
    this.#rosterEpoch += 1;
  }

  #setActiveAgentId(id, { durableSelection = false } = {}) {
    if (durableSelection) {
      const nextRevision = this.#activeRevision + 1;
      if (!Number.isSafeInteger(nextRevision)) throw new TypeError("native active epoch exhausted");
      this.#activeRevision = nextRevision;
    }
    this.#activeAgentId = id;
  }

  async #restoreActiveAgent() {
    if (this.#activeAgentInitialized) return;
    if (this.#activeAgentPromise) return this.#activeAgentPromise;
    const operation = (async () => {
      let activeAgentId = null;
      if (this.#readActiveAgentId) activeAgentId = await this.#readActiveAgentId();
      if (this.#disposed) throw new TypeError("native coordinator disposed");
      if (activeAgentId !== null && (typeof activeAgentId !== "string" || !BOT_ID.test(activeAgentId))) {
        throw new TypeError("invalid durable active bot");
      }
      if (!this.#activeAgentInitialized) {
        this.#setActiveAgentId(activeAgentId ?? "");
        this.#activeAgentInitialized = true;
      }
    })();
    this.#activeAgentPromise = operation;
    try { await operation; } finally {
      if (this.#activeAgentPromise === operation) this.#activeAgentPromise = null;
    }
  }

  #advanceBotEpoch(id) {
    const epoch = (this.#botEpochs.get(id) ?? 0) + 1;
    if (!Number.isSafeInteger(epoch)) throw new TypeError("native bot epoch exhausted");
    this.#botEpochs.set(id, epoch);
    return epoch;
  }

  #captureBot(id) {
    if (this.#disposed || this.#deletedBots.has(id) || this.#deletionClaims.has(id)) {
      throw new TypeError("native bot is unavailable");
    }
    return Object.freeze({ id, epoch: this.#botEpochs.get(id) ?? 0 });
  }

  #botIsCurrent(token) {
    return Boolean(token && !this.#disposed && !this.#deletedBots.has(token.id)
      && !this.#deletionClaims.has(token.id)
      && (this.#botEpochs.get(token.id) ?? 0) === token.epoch);
  }

  #assertBotCurrent(token) {
    if (!this.#botIsCurrent(token)) throw new TypeError("stale native bot operation");
  }

  #beginDeletion(ids) {
    if (ids.some((id) => this.#deletedBots.has(id) || this.#deletionClaims.has(id))) {
      throw new TypeError("native bot deletion is unavailable");
    }
    const claim = Object.freeze({
      activeAgentId: this.#activeAgentId,
      activeRevision: this.#activeRevision,
    });
    for (const id of ids) {
      this.#advanceBotEpoch(id);
      this.#deletionClaims.set(id, claim);
    }
    this.#purgeVolatileBotOperations(ids);
    this.#advanceRosterEpoch();
    return claim;
  }

  #purgeVolatileBotOperations(ids) {
    const targets = new Set(ids);
    for (const [key, operation] of this.#operations) {
      if (!targets.has(operation?.botId)) continue;
      operation.finishing = true;
      if (this.#operations.get(key) === operation) this.#operations.delete(key);
    }
    for (const [conversationId, pending] of this.#pendingOperations) {
      if (!targets.has(pending?.botId)) continue;
      if (pending.operation) pending.operation.finishing = true;
      if (this.#pendingOperations.get(conversationId) === pending) {
        this.#pendingOperations.delete(conversationId);
      }
    }
  }

  #releaseDeletion(ids, claim, { deleted }) {
    for (const id of ids) {
      if (this.#deletionClaims.get(id) !== claim) throw new TypeError("stale native deletion claim");
    }
    for (const id of ids) {
      this.#deletionClaims.delete(id);
      if (deleted) {
        this.#deletedBots.add(id);
        this.#botEpochs.delete(id);
      }
    }
    this.#advanceRosterEpoch();
  }

  #emptySearch(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["query"]));
    boundedString(args.query, MAX_TEXT_BYTES, { allowEmpty: true });
    return [];
  }

  #cloudAgentInfo(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["bcId", "includeFiles"]));
    boundedString(args.bcId, 512);
    if (typeof args.includeFiles !== "boolean") {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    return null;
  }

  async #localBotFromIdArgs(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["id"]));
    const id = botId(args.id);
    const token = this.#captureBot(id);
    const rosterEpoch = this.#rosterEpoch;
    const values = await this.#bots.listBots();
    this.#assertBotCurrent(token);
    if (this.#rosterEpoch !== rosterEpoch) throw new TypeError("stale native roster");
    if (!Array.isArray(values) || values.length > MAX_AGENTS) throw new TypeError("invalid bot list");
    const value = values.find((candidate) => candidate?.botId === id);
    if (!value) throw new TypeError("missing bot");
    return validateBot(value);
  }

  async #agentAvatar(rawArgs) {
    const localBot = await this.#localBotFromIdArgs(rawArgs);
    const image = localBot.appearance.image;
    return {
      dataUrl: typeof image === "string" && image.length > 0 && utf8Bytes(image) <= MAX_TEXT_BYTES
        ? image : null,
      version: localBot.updatedAt,
    };
  }

  async #emptyAgentArray(rawArgs) {
    await this.#localBotFromIdArgs(rawArgs);
    return [];
  }

  async #agentRows() {
    await this.#restoreActiveAgent();
    const rosterEpoch = this.#rosterEpoch;
    const values = await this.#bots.listBots();
    if (this.#disposed || this.#rosterEpoch !== rosterEpoch) throw new TypeError("stale native roster");
    if (!Array.isArray(values) || values.length > MAX_AGENTS) throw new TypeError("invalid bot list");
    const rows = values
      .filter((value) => !this.#deletedBots.has(value?.botId) && !this.#deletionClaims.has(value?.botId))
      .map((value) => agentRow(value, this.#unread.get(value.botId)));
    if (this.#rosterEpoch !== rosterEpoch) throw new TypeError("stale native roster");
    if (this.#activeAgentId && !rows.some((row) => row.id === this.#activeAgentId)) this.#setActiveAgentId("");
    if (!this.#activeAgentId) this.#setActiveAgentId(rows[0]?.id ?? "");
    for (const row of rows) row.isActive = row.id === this.#activeAgentId;
    return rows;
  }

  async #createAgent(rawArgs) {
    const args = exactRecord(rawArgs, new Set([
      "name", "description", "origin", "isKickstartRequested", "templateId", "avatarShape", "avatarColor",
    ]), new Set(["name", "description"]));
    const name = boundedString(args.name, 160);
    const description = boundedString(args.description, 1000, { allowEmpty: true });
    if (args.origin !== undefined && args.origin !== "user"
      || args.isKickstartRequested !== undefined && typeof args.isKickstartRequested !== "boolean") {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    if (args.templateId !== undefined) {
      throw capabilityUnavailable("createAgent");
    }
    const appearance = {
      shape: appearanceId(args.avatarShape, "blob"),
      color: appearanceId(args.avatarColor, "blue"),
      title: "",
      description,
    };
    let created = await this.#bots.createBot({ appearance, notifications: true });
    const id = botId(created.botId);
    const token = this.#captureBot(id);
    created = await this.#bots.renameBot(id, name);
    this.#assertBotCurrent(token);
    const row = agentRow(created, false);
    this.#setActiveAgentId(row.id);
    row.isActive = true;
    void this.#publishAgentsToAll();
    return { agent: row, transcript: [] };
  }

  async #updateAgent(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["id", "profile"]));
    const id = botId(args.id);
    const token = this.#captureBot(id);
    const profile = exactRecord(args.profile, new Set([
      "name", "description", "title", "avatarShape", "avatarColor",
    ]), new Set());
    if (Object.keys(profile).length === 0) {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    let updated = null;
    if (Object.hasOwn(profile, "name")) {
      updated = await this.#bots.renameBot(id, boundedString(profile.name, 160));
      this.#assertBotCurrent(token);
    }
    const appearance = {};
    if (Object.hasOwn(profile, "description")) {
      appearance.description = boundedString(profile.description, 1000, { allowEmpty: true });
    }
    if (Object.hasOwn(profile, "title")) {
      appearance.title = boundedString(profile.title, 160, { allowEmpty: true });
    }
    if (Object.hasOwn(profile, "avatarShape")) appearance.shape = appearanceId(profile.avatarShape);
    if (Object.hasOwn(profile, "avatarColor")) appearance.color = appearanceId(profile.avatarColor);
    if (Object.keys(appearance).length > 0) {
      updated = await this.#bots.updateProfile(id, { appearance });
      this.#assertBotCurrent(token);
    }
    if (!updated && typeof this.#bots.readBot === "function") {
      updated = await this.#bots.readBot(id);
      this.#assertBotCurrent(token);
    }
    if (!updated) {
      updated = (await this.#bots.listBots()).find((candidate) => candidate.botId === id);
      this.#assertBotCurrent(token);
    }
    if (!updated) throw new TypeError("missing updated bot");
    const row = agentRow(updated, this.#unread.get(id));
    row.isActive = id === this.#activeAgentId;
    void this.#publishAgentsToAll();
    return row;
  }

  async #deleteAgents(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["ids"]));
    const ids = denseArray(args.ids, MAX_AGENT_IDS).map(botId);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    if (!this.#deleteBots) {
      throw capabilityUnavailable("deleteAgents");
    }
    const claim = this.#beginDeletion(ids);
    let outcome;
    try {
      outcome = deletionOutcome(
        await this.#deleteBots(Object.freeze([...ids])),
        ids,
      );
      this.#releaseDeletion(ids, claim, { deleted: true });
    } catch (error) {
      this.#releaseDeletion(ids, claim, { deleted: false });
      if (this.#activeRevision === claim.activeRevision) {
        this.#setActiveAgentId(claim.activeAgentId);
      }
      void this.#publishAgentsToAll();
      throw error;
    }
    const deletedIds = new Set(outcome.deletedBotIds);
    const noncePrefixes = outcome.deletedBotIds.map((id) => `${id}\0`);
    for (const key of this.#clientNonces.keys()) {
      if (noncePrefixes.some((prefix) => key.startsWith(prefix))) this.#clientNonces.delete(key);
    }
    for (const [clientNonce, acceptance] of this.#acceptances) {
      if (deletedIds.has(acceptance?.record?.agentId)) this.#acceptances.delete(clientNonce);
    }
    for (const [key, operation] of this.#operations) {
      if (!deletedIds.has(operation?.botId)) continue;
      operation.finishing = true;
      this.#operations.delete(key);
    }
    for (const [conversationId, pending] of this.#pendingOperations) {
      if (!deletedIds.has(pending?.botId)) continue;
      if (pending.operation) pending.operation.finishing = true;
      this.#pendingOperations.delete(conversationId);
    }
    for (const id of ids) {
      this.#unread.delete(id);
      this.#conversationIds.delete(id);
      this.#conversationPromises.delete(id);
    }
    if (this.#activeRevision === claim.activeRevision
      || !outcome.survivingBotIds.includes(this.#activeAgentId)) {
      this.#setActiveAgentId(outcome.activeBotId ?? "");
    }
    void this.#publishAgentsToAll();
    return { transcript: [] };
  }

  async #setAgentUnread(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["id", "isUnread"]));
    const id = botId(args.id);
    const token = this.#captureBot(id);
    if (typeof args.isUnread !== "boolean") {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    const rows = await this.#agentRows();
    this.#assertBotCurrent(token);
    if (!rows.some((row) => row.id === id)) throw new TypeError("missing bot");
    this.#unread.set(id, args.isUnread);
    void this.#publishAgentsToAll();
    return undefined;
  }

  async #kickstartAgent(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["id"]));
    const id = botId(args.id);
    const token = this.#captureBot(id);
    const rows = await this.#agentRows();
    this.#assertBotCurrent(token);
    if (!rows.some((row) => row.id === id)) throw new TypeError("missing bot");
    return { isIntroductionInFlight: false };
  }

  async #ensureConversation(id, token = this.#captureBot(id)) {
    this.#assertBotCurrent(token);
    const known = this.#conversationIds.get(id);
    if (known) return known;
    const pending = this.#conversationPromises.get(id);
    if (pending && pending.token.epoch === token.epoch) {
      const conversationId = await pending.promise;
      this.#assertBotCurrent(token);
      return conversationId;
    }
    if (pending && this.#conversationPromises.get(id) === pending) this.#conversationPromises.delete(id);
    const entry = { token, promise: null };
    entry.promise = (async () => {
      const rows = await this.#agentRows();
      this.#assertBotCurrent(token);
      if (!rows.some((row) => row.id === id)) throw new TypeError("missing bot");
      const listed = await this.#conversations.list(id);
      this.#assertBotCurrent(token);
      if (!Array.isArray(listed) || listed.length > MAX_CONVERSATIONS) throw new TypeError("invalid conversations");
      const summaries = listed.map((entry) => validateConversationSummary(entry, id));
      let selected = summaries[0];
      if (!selected) {
        selected = validateConversationSummary(
          await this.#conversations.create({ botId: id }),
          id,
        );
        this.#assertBotCurrent(token);
      }
      this.#assertBotCurrent(token);
      this.#conversationIds.set(id, selected.conversationId);
      return selected.conversationId;
    })();
    this.#conversationPromises.set(id, entry);
    try {
      const conversationId = await entry.promise;
      this.#assertBotCurrent(token);
      return conversationId;
    } finally {
      if (this.#conversationPromises.get(id) === entry) this.#conversationPromises.delete(id);
    }
  }

  async #readConversation(id, conversationId, token = null) {
    const record = validateConversationRecord(
      await this.#conversations.read({ botId: id, conversationId }),
      id,
      conversationId,
    );
    if (token) this.#assertBotCurrent(token);
    return record;
  }

  #messageEntry(id, message, streaming = false) {
    if (!message || typeof message !== "object" || Array.isArray(message)
      || typeof message.messageId !== "string" || !SAFE_ID.test(message.messageId)
      || !new Set(["user", "assistant"]).has(message.role)
      || typeof message.text !== "string" || message.text.includes("\0")
      || utf8Bytes(message.text) > MAX_TEXT_BYTES) throw new TypeError("invalid message");
    const entry = {
      kind: "message",
      id: message.messageId,
      role: message.role,
      content: message.text,
      isStreaming: streaming,
      timestampMs: timestampMs(message.createdAt),
    };
    if ((message.clientNonce === undefined) !== (message.inputDigest === undefined)
      || message.clientNonce !== undefined
        && (message.role !== "user" || typeof message.clientNonce !== "string"
          || utf8Bytes(message.clientNonce) > MAX_CLIENT_NONCE_BYTES
          || typeof message.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(message.inputDigest))) {
      throw new TypeError("invalid native prompt acceptance");
    }
    const nonce = message.clientNonce ?? this.#clientNonces.get(`${id}\0${message.messageId}`);
    if (message.role === "user" && nonce) entry.clientNonce = nonce;
    return entry;
  }

  #conversationEntries(id, record) {
    if (record.messages.length > MAX_MESSAGES) throw new TypeError("too many messages");
    return record.messages.map((message) => this.#messageEntry(id, message));
  }

  async #tail(rawArgs, opening) {
    const args = exactRecord(rawArgs, new Set(["id", "limit", "beforeSeq"]), new Set(["id", "limit"]));
    const id = botId(args.id);
    const token = this.#captureBot(id);
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_TAIL_LIMIT
      || args.beforeSeq !== undefined
        && (!Number.isSafeInteger(args.beforeSeq) || args.beforeSeq < 1 || args.beforeSeq > MAX_MESSAGES + 1)) {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    if (opening && this.#onSelectAgent) {
      await this.#onSelectAgent(id);
      this.#assertBotCurrent(token);
    }
    const conversationId = await this.#ensureConversation(id, token);
    this.#assertBotCurrent(token);
    const record = await this.#readConversation(id, conversationId, token);
    this.#assertBotCurrent(token);
    const all = this.#conversationEntries(id, record);
    const live = [...this.#operations].find(([key, candidate]) => candidate.botId === id
      && candidate.conversationId === conversationId && candidate.started && !candidate.finishing
      && this.#botIsCurrent(candidate.token) && this.#operations.get(key) === candidate)?.[1];
    if (live) {
      all.push({
        kind: "message",
        id: live.streamId,
        role: "assistant",
        content: live.text,
        isStreaming: true,
        timestampMs: live.timestampMs,
      });
    }
    const end = args.beforeSeq === undefined ? all.length : Math.min(all.length, args.beforeSeq - 1);
    const start = Math.max(0, end - args.limit);
    const entries = all.slice(start, end);
    if (opening) {
      this.#assertBotCurrent(token);
      this.#setActiveAgentId(id, { durableSelection: this.#onSelectAgent !== null });
      this.#unread.set(id, false);
      void this.#publishAgentsToAll();
    }
    return { entries, nextBeforeSeq: start > 0 ? start + 1 : null };
  }

  async #sendPrompt(rawArgs) {
    const args = exactRecord(rawArgs, new Set([
      "agentId", "prompt", "clientNonce", "directAddressedAcceptance", "richText", "replyToId", "isFork",
      "composedAtMs", "attachmentPaths", "attachmentNames", "traceparent", "enterEpochMs",
    ]), new Set(["agentId", "prompt", "clientNonce", "directAddressedAcceptance"]));
    const id = botId(args.agentId);
    const token = this.#captureBot(id);
    const prompt = boundedString(args.prompt, MAX_TEXT_BYTES);
    const clientNonce = boundedString(args.clientNonce, MAX_CLIENT_NONCE_BYTES);
    if (args.directAddressedAcceptance !== true) {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    const richText = args.richText === undefined
      ? undefined : boundedString(args.richText, MAX_TEXT_BYTES, { allowEmpty: true });
    const replyToId = args.replyToId === undefined
      ? undefined : boundedString(args.replyToId, MAX_REQUEST_ID_BYTES);
    if (args.isFork !== undefined && typeof args.isFork !== "boolean") {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    optionalFiniteNumber(args.composedAtMs);
    optionalFiniteNumber(args.enterEpochMs);
    if (args.traceparent !== undefined) boundedString(args.traceparent, 512);
    const hasAttachmentPaths = Object.hasOwn(args, "attachmentPaths");
    const hasAttachmentNames = Object.hasOwn(args, "attachmentNames");
    if (hasAttachmentPaths !== hasAttachmentNames) {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    const attachmentPaths = hasAttachmentPaths
      ? denseArray(args.attachmentPaths, 64).map((value) => boundedString(value, 4096)) : [];
    const attachmentNames = hasAttachmentNames
      ? denseArray(args.attachmentNames, 64).map((value) => boundedString(value, 1024)) : [];
    if (attachmentPaths.length !== attachmentNames.length) {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    if (replyToId !== undefined || args.isFork === true || attachmentPaths.length > 0) {
      throw capabilityUnavailable("sendPrompt");
    }
    const inputDigest = promptInputDigest({
      agentId: id,
      prompt,
      richText,
      replyToId,
      isFork: args.isFork,
      attachmentPaths,
      attachmentNames,
    });
    const existingAcceptance = this.#acceptances.get(clientNonce)
      ?? await this.#durableAcceptance(clientNonce);
    this.#assertBotCurrent(token);
    if (existingAcceptance) {
      if (existingAcceptance.record.inputDigest !== inputDigest) {
        throw coordinatorFailure("send/nonce-digest-mismatch", "OpenBot prompt nonce does not match its original input.");
      }
      await existingAcceptance.completion;
      this.#assertBotCurrent(token);
      if (existingAcceptance.record.status === "accepted") return { accepted: true };
      throw coordinatorFailure(
        existingAcceptance.record.rejectionCode ?? "source/transport-failure",
        "OpenBot native send failed.",
      );
    }
    let settleAcceptance;
    const acceptance = {
      completion: new Promise((resolve) => { settleAcceptance = resolve; }),
      record: {
        accountSlot: "host",
        clientNonce,
        inputDigest,
        status: "pending",
        acceptedAtMs: null,
        agentId: id,
        echoEntryId: null,
        rejectionCode: null,
      },
    };
    this.#assertBotCurrent(token);
    this.#acceptances.set(clientNonce, acceptance);
    let conversationId = null;
    let pending = null;
    try {
      conversationId = await this.#ensureConversation(id, token);
      this.#assertBotCurrent(token);
      const before = await this.#readConversation(id, conversationId, token);
      const priorIds = new Set(before.messages.map((message) => message.messageId));
      pending = { botId: id, conversationId, token, buffer: [], ready: false, operation: null };
      this.#pendingOperations.set(conversationId, pending);
      const accepted = await this.#conversations.send({
        botId: id,
        conversationId,
        text: prompt,
        clientNonce,
        inputDigest,
      });
      this.#assertBotCurrent(token);
      if (!accepted || typeof accepted !== "object" || accepted.botId !== id
        || accepted.conversationId !== conversationId || !INVOCATION_ID.test(accepted.invocationId)) {
        throw new TypeError("invalid send result");
      }
      const record = await this.#readConversation(id, conversationId, token);
      const addedUsers = record.messages.filter((message) => !priorIds.has(message.messageId)
        && message.role === "user" && message.text === prompt);
      const echoed = addedUsers.at(-1);
      if (!echoed || echoed.clientNonce !== clientNonce || echoed.inputDigest !== inputDigest) {
        throw new TypeError("missing durable prompt echo");
      }
      this.#assertBotCurrent(token);
      this.#clientNonces.set(`${id}\0${echoed.messageId}`, clientNonce);
      acceptance.record.status = "accepted";
      acceptance.record.acceptedAtMs = timestampMs(echoed.createdAt);
      acceptance.record.echoEntryId = echoed.messageId;
      const operation = {
        botId: id,
        token,
        conversationId,
        invocationId: accepted.invocationId,
        streamId: `stream-${accepted.invocationId}`,
        text: "",
        timestampMs: this.#currentTimeMs(),
        started: false,
        finishing: false,
      };
      pending.operation = operation;
      pending.ready = true;
      this.#assertBotCurrent(token);
      this.#operations.set(`${conversationId}\0${accepted.invocationId}`, operation);
      this.#broadcastEvent("transcript", {
        type: "appended",
        agentId: id,
        entry: this.#messageEntry(id, echoed),
      });
      for (const event of pending.buffer) this.#routeOperationEvent(operation, event);
      settleAcceptance();
      return { accepted: true };
    } catch (error) {
      if (!this.#botIsCurrent(token)) {
        acceptance.record.status = "rejected";
        acceptance.record.rejectionCode = "source/transport-failure";
        if (this.#acceptances.get(clientNonce) === acceptance) this.#acceptances.delete(clientNonce);
        settleAcceptance();
        throw error;
      }
      let echoed = null;
      if (conversationId) {
        try {
          const record = await this.#readConversation(id, conversationId, token);
          const matches = record.messages.filter((message) => message?.role === "user"
            && message.text === prompt && message.clientNonce === clientNonce
            && message.inputDigest === inputDigest);
          if (matches.length > 1) throw new TypeError("ambiguous durable prompt echo");
          [echoed] = matches;
          if (echoed) this.#messageEntry(id, echoed);
        } catch {
          echoed = null;
        }
      }
      if (!this.#botIsCurrent(token)) {
        acceptance.record.status = "rejected";
        acceptance.record.rejectionCode = "source/transport-failure";
        if (this.#acceptances.get(clientNonce) === acceptance) this.#acceptances.delete(clientNonce);
        settleAcceptance();
        throw error;
      }
      if (echoed) {
        this.#clientNonces.set(`${id}\0${echoed.messageId}`, clientNonce);
        acceptance.record.status = "accepted";
        acceptance.record.acceptedAtMs = timestampMs(echoed.createdAt);
        acceptance.record.echoEntryId = echoed.messageId;
        this.#broadcastEvent("transcript", {
          type: "appended",
          agentId: id,
          entry: this.#messageEntry(id, echoed),
        });
        settleAcceptance();
        return { accepted: true };
      }
      acceptance.record.status = "rejected";
      acceptance.record.rejectionCode = error instanceof OpenBotNativeCoordinatorError
        ? error.code : "source/transport-failure";
      settleAcceptance();
      throw error;
    } finally {
      if (conversationId && pending && this.#pendingOperations.get(conversationId) === pending) {
        this.#pendingOperations.delete(conversationId);
      }
    }
  }

  async #promptAcceptanceStatus(rawArgs) {
    const args = exactRecord(rawArgs, new Set(["accountSlot", "clientNonce"]));
    if (args.accountSlot !== "host") {
      throw coordinatorFailure("source/malformed-request", "Malformed OpenBot native request.");
    }
    const clientNonce = boundedString(args.clientNonce, MAX_CLIENT_NONCE_BYTES);
    let acceptance = this.#acceptances.get(clientNonce);
    if (acceptance && (this.#deletedBots.has(acceptance.record.agentId)
      || this.#deletionClaims.has(acceptance.record.agentId))) acceptance = null;
    acceptance = acceptance
      ?? await this.#durableAcceptance(clientNonce);
    return acceptance
      ? { outcome: "found", record: { ...acceptance.record } }
      : { outcome: "not-found" };
  }

  async #durableAcceptance(clientNonce) {
    let found = null;
    const rows = await this.#agentRows();
    for (const row of rows) {
      const token = this.#captureBot(row.id);
      const listed = await this.#conversations.list(row.id);
      this.#assertBotCurrent(token);
      if (!Array.isArray(listed) || listed.length > MAX_CONVERSATIONS) throw new TypeError("invalid conversations");
      for (const value of listed) {
        const summary = validateConversationSummary(value, row.id);
        const record = await this.#readConversation(row.id, summary.conversationId, token);
        for (const message of record.messages) {
          if (message?.clientNonce !== clientNonce) continue;
          if (found || message.role !== "user" || typeof message.inputDigest !== "string"
            || !/^[0-9a-f]{64}$/.test(message.inputDigest)) {
            throw new TypeError("ambiguous native prompt acceptance");
          }
          found = {
            completion: Promise.resolve(),
            record: {
              accountSlot: "host",
              clientNonce,
              inputDigest: message.inputDigest,
              status: "accepted",
              acceptedAtMs: timestampMs(message.createdAt),
              agentId: row.id,
              echoEntryId: message.messageId,
              rejectionCode: null,
            },
          };
        }
      }
    }
    if (found) {
      const token = this.#captureBot(found.record.agentId);
      this.#assertBotCurrent(token);
      this.#acceptances.set(clientNonce, found);
    }
    return found;
  }

  #currentTimeMs() {
    let value;
    try { value = this.#now(); } catch { throw new TypeError("invalid clock"); }
    const normalized = typeof value === "string" ? Date.parse(value) : value;
    if (!Number.isFinite(normalized) || normalized < 0) throw new TypeError("invalid clock");
    return normalized;
  }

  #receiveConversationEvent(rawEvent) {
    if (this.#disposed || !rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)
      || typeof rawEvent.conversationId !== "string") return;
    const pending = this.#pendingOperations.get(rawEvent.conversationId);
    if (pending && !pending.ready) {
      if (!this.#botIsCurrent(pending.token)) {
        if (this.#pendingOperations.get(rawEvent.conversationId) === pending) {
          this.#pendingOperations.delete(rawEvent.conversationId);
        }
        return;
      }
      if (pending.buffer.length < 1024) pending.buffer.push(rawEvent);
      return;
    }
    const invocationId = rawEvent.invocationId;
    const operation = typeof invocationId === "string"
      ? this.#operations.get(`${rawEvent.conversationId}\0${invocationId}`)
      : null;
    if (!operation || !this.#botIsCurrent(operation.token)) return;
    this.#routeOperationEvent(operation, rawEvent);
  }

  #routeOperationEvent(operation, event) {
    const key = `${operation.conversationId}\0${operation.invocationId}`;
    if (!this.#botIsCurrent(operation.token) || this.#operations.get(key) !== operation) return;
    if (event.type === "text-delta") {
      this.#emitTextDelta(operation, event.text);
      return;
    }
    if (TERMINAL_EVENTS.has(event.type)) void this.#finishOperation(operation);
  }

  #emitTextDelta(operation, delta) {
    const key = `${operation.conversationId}\0${operation.invocationId}`;
    if (!this.#botIsCurrent(operation.token) || this.#operations.get(key) !== operation
      || operation.finishing || typeof delta !== "string" || delta.includes("\0")) return;
    if (utf8Bytes(operation.text + delta) > MAX_TEXT_BYTES) {
      operation.finishing = true;
      this.#operations.delete(`${operation.conversationId}\0${operation.invocationId}`);
      return;
    }
    operation.text += delta;
    const type = operation.started ? "updated" : "appended";
    operation.started = true;
    this.#broadcastEvent("transcript", {
      type,
      agentId: operation.botId,
      entry: {
        kind: "message",
        id: operation.streamId,
        role: "assistant",
        content: operation.text,
        isStreaming: true,
        timestampMs: operation.timestampMs,
      },
    });
  }

  async #finishOperation(operation) {
    const key = `${operation.conversationId}\0${operation.invocationId}`;
    if (operation.finishing || !this.#botIsCurrent(operation.token)
      || this.#operations.get(key) !== operation) return;
    operation.finishing = true;
    try {
      const record = await this.#readConversation(
        operation.botId,
        operation.conversationId,
        operation.token,
      );
      if (!this.#botIsCurrent(operation.token) || this.#operations.get(key) !== operation) return;
      this.#broadcastEvent("transcript", {
        type: "snapshot",
        activeAgentId: operation.botId,
        entries: this.#conversationEntries(operation.botId, record),
      });
    } catch {
      // The durable controller remains authoritative; no speculative terminal frame is emitted.
    } finally {
      if (this.#operations.get(key) === operation) this.#operations.delete(key);
    }
  }

  #broadcastEvent(family, payload) {
    if (this.#disposed) return;
    for (const binding of [...this.#bindings]) {
      if (!binding.disposed && binding.state === "ready") {
        this.#post(binding, { kind: "event", family, payload });
      }
    }
  }

  async #publishAgents(binding) {
    try {
      const agents = await this.#agentRows();
      if (binding.disposed || binding.state !== "ready") return;
      this.#post(binding, {
        kind: "event",
        family: "agents",
        payload: { agents, activeAgentId: this.#activeAgentId },
      });
    } catch {
      // A malformed or unavailable controller snapshot is never speculatively published.
    }
  }

  async #publishAgentsToAll() {
    if (this.#disposed) return;
    let agents;
    try { agents = await this.#agentRows(); } catch { return; }
    if (this.#disposed) return;
    this.#broadcastEvent("agents", { agents, activeAgentId: this.#activeAgentId });
  }

  #post(binding, frame) {
    if (binding.disposed) return false;
    try {
      binding.port.postMessage(frame);
      return true;
    } catch {
      this.#disposeBinding(binding);
      return false;
    }
  }

  #protocolError(binding, detail) {
    if (binding.disposed) return;
    try {
      binding.port.postMessage({
        kind: "lifecycle",
        phase: "shutdown",
        reason: "protocol-error",
        detail,
      });
    } catch {}
    this.#disposeBinding(binding);
  }

  #removePortListener(binding) {
    try {
      const off = binding.port.off || binding.port.removeListener;
      off.call(binding.port, "message", binding.onMessage);
    } catch {}
  }

  #disposeBinding(binding) {
    if (binding.disposed) return;
    binding.disposed = true;
    binding.state = "closed";
    this.#bindings.delete(binding);
    this.#removePortListener(binding);
    try { binding.port.close(); } catch {}
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const botOff = this.#bots.off || this.#bots.removeListener;
    const conversationOff = this.#conversations.off || this.#conversations.removeListener;
    try { botOff.call(this.#bots, "bot-changed", this.#botListener); } catch {}
    try { conversationOff.call(this.#conversations, "event", this.#conversationListener); } catch {}
    for (const binding of [...this.#bindings]) this.#disposeBinding(binding);
    this.#conversationIds.clear();
    this.#conversationPromises.clear();
    this.#clientNonces.clear();
    this.#acceptances.clear();
    this.#operations.clear();
    this.#pendingOperations.clear();
    this.#unread.clear();
    this.#botEpochs.clear();
    this.#deletionClaims.clear();
    this.#deletedBots.clear();
    this.#activeAgentPromise = null;
  }
}

module.exports = {
  OpenBotNativeCoordinator,
  OpenBotNativeCoordinatorError,
};
