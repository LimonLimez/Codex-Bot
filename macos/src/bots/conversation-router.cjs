const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");
const {
  acknowledgeCommand,
  adaptSnapshotResult,
  cancelCommand,
  createCommand,
  reconcileCommand,
  selectModelCommand,
  sendCommand,
  snapshotCommand,
} = require("./chatgpt-relay-codec.cjs");

const WORK_CREATE_TIMEOUT_MS = 120_000;
const WORK_CREATE_FIELDS = new Set([
  "botId",
  "clientUserMessageId",
  "cwd",
  "approvalPolicy",
  "model",
  "serviceTier",
  "effort",
  "sandbox",
  "serviceName",
  "developerInstructions",
  "personality",
  "ephemeral",
]);
const WORK_SEND_FIELDS = new Set(["clientUserMessageId", "cwd", "approvalPolicy", "serviceTier", "effort", "model"]);
const CHAT_CREATE_FIELDS = new Set(["modelID", "title", "preview"]);
const RESERVED_RUNTIME_FIELDS = new Set([
  "provider",
  "runtimeId",
  "remoteRuntimeId",
  "generation",
  "endpoint",
  "authToken",
  "modulePath",
  "codexBinary",
  "localBinary",
]);
const APPROVAL_POLICIES = new Set(["untrusted", "on-failure", "on-request", "never"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const PERSONALITIES = new Set(["none", "friendly", "pragmatic"]);
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredBotId(value) {
  if (typeof value !== "string"
    || !/^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("A bot ID is required for Work.");
  }
  return value;
}

function ownData(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw new Error(`Invalid ${label}.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${label}.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")
    || keys.some((key) => !("value" in descriptors[key]))
    || keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
    throw new Error(`Invalid ${label}.`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function selectedOptions(value, allowed, label) {
  const data = ownData(value, label);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key) || RESERVED_RUNTIME_FIELDS.has(key)) throw new Error(`Invalid ${label} override.`);
  }
  return data;
}

function validOptionalString(value, { max, nullable = false, values = null, empty = false }) {
  if (value === undefined || (nullable && value === null)) return true;
  return typeof value === "string"
    && (empty || value.length > 0)
    && value.length <= max
    && (!values || values.has(value));
}

function workCreateOptions(value) {
  const data = selectedOptions(value, WORK_CREATE_FIELDS, "Work create");
  if (!validOptionalString(data.clientUserMessageId, { max: 256 })
    || !validOptionalString(data.cwd, { max: 4_096, nullable: true })
    || !validOptionalString(data.approvalPolicy, { max: 32, values: APPROVAL_POLICIES })
    || !validOptionalString(data.model, { max: 128 })
    || !validOptionalString(data.serviceTier, { max: 128 })
    || !validOptionalString(data.effort, { max: 128, values: REASONING_EFFORTS })
    || !validOptionalString(data.sandbox, { max: 32, values: SANDBOX_MODES })
    || !validOptionalString(data.serviceName, { max: 128 })
    || !validOptionalString(data.developerInstructions, { max: 100_000, empty: true })
    || !validOptionalString(data.personality, { max: 32, values: PERSONALITIES })
    || (data.ephemeral !== undefined && typeof data.ephemeral !== "boolean")) {
    throw new Error("Invalid Work create options.");
  }
  requiredBotId(data.botId);
  return data;
}

function chatRef(conversationId) {
  if (typeof conversationId !== "string" || !conversationId) throw new Error("ChatGPT did not return a conversation ID.");
  return Object.freeze({ source: "chatgpt", conversationId });
}

function workRef(threadId, botId) {
  if (typeof threadId !== "string" || !threadId) throw new Error("Codex did not return a thread ID.");
  return Object.freeze({ source: "codex", threadId, botId: requiredBotId(botId) });
}

function assertRefForMode(mode, ref) {
  if (ref === null) return;
  const data = ownData(ref, "conversation reference");
  if (mode === "chat" && (data.source !== "chatgpt" || typeof data.conversationId !== "string" || !data.conversationId)) {
    throw new Error("Open the ChatGPT conversation before sending in Chat mode.");
  }
  if (mode === "work") {
    if (data.source !== "codex" || typeof data.threadId !== "string" || !data.threadId) {
      throw new Error("Open the Codex task before sending in Work mode.");
    }
    if (typeof data.botId !== "string" || !data.botId) throw new Error("A bot ID is required for Work.");
  }
  if (mode !== "chat" && mode !== "work") throw new Error("Unknown conversation mode.");
  const keys = Object.keys(data).sort();
  const expected = (mode === "chat" ? ["conversationId", "source"] : ["botId", "source", "threadId"]).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Invalid conversation reference.");
  }
}

function modeForRef(ref) {
  const data = ownData(ref, "conversation reference");
  if (data.source === "chatgpt") return "chat";
  if (data.source === "codex") return "work";
  throw new Error("A source-aware conversation reference is required.");
}

function canonicalRefForMode(mode, ref, expectedBotId = null) {
  assertRefForMode(mode, ref);
  const data = ownData(ref, "conversation reference");
  if (mode === "chat") return chatRef(data.conversationId);
  const botId = requiredBotId(data.botId);
  if (expectedBotId !== null && botId !== expectedBotId) throw new Error("Work reference belongs to another bot.");
  return workRef(data.threadId, botId);
}

function now() {
  return new Date().toISOString();
}

function textPreview(text) {
  return typeof text === "string" ? text : "";
}

class ConversationRouter extends EventEmitter {
  constructor({ chatgpt, codexForBot, chatStore, makeId = randomUUID } = {}) {
    super();
    this.chatgpt = chatgpt || null;
    this.codexForBot = typeof codexForBot === "function" ? codexForBot : null;
    this.chatStore = chatStore || null;
    this.makeId = makeId;
    this.chatEventQueues = new Map();
    this.workBindings = new Map();
    this.disposed = false;
    this.chatEventListener = (event) => this.#queueChatEvent(event);
    if (this.chatgpt?.on) this.chatgpt.on("event", this.chatEventListener);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof this.chatgpt?.off === "function") this.chatgpt.off("event", this.chatEventListener);
    else this.chatgpt?.removeListener?.("event", this.chatEventListener);
    for (const binding of this.workBindings.values()) {
      if (typeof binding.client.off === "function") binding.client.off("notification", binding.listener);
      else binding.client.removeListener?.("notification", binding.listener);
    }
    this.workBindings.clear();
  }

  invalidateWorkClient(botId, client) {
    const binding = this.workBindings.get(botId);
    if (!binding || binding.client !== client) return false;
    if (typeof binding.client.off === "function") binding.client.off("notification", binding.listener);
    else binding.client.removeListener?.("notification", binding.listener);
    this.workBindings.delete(botId);
    return true;
  }

  async status(mode, context = undefined) {
    const transport = mode === "chat"
      ? this.#chatTransportWithContext(context)
      : await this.#workTransport(this.#contextBotId(mode, context));
    return transport.request(mode === "chat" ? "status/read" : "account/read", {});
  }

  async models(mode, context = undefined) {
    const transport = mode === "chat"
      ? this.#chatTransportWithContext(context)
      : await this.#workTransport(this.#contextBotId(mode, context));
    return transport.request("model/list", {});
  }

  async list(mode, context = undefined) {
    if (mode === "chat") {
      this.#assertChatContext(context);
      return this.#store().list();
    }
    if (mode === "work") {
      const transport = await this.#workTransport(this.#contextBotId(mode, context));
      return transport.request("thread/list", {
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: true,
      });
    }
    throw new Error("Unknown conversation mode.");
  }

  async create(mode, options = {}) {
    if (mode === "chat") {
      const safeOptions = selectedOptions(options, CHAT_CREATE_FIELDS, "Chat create");
      const encoded = createCommand({ companionChatID: this.makeId(), modelID: safeOptions.modelID });
      const result = adaptSnapshotResult(await this.#chatTransport().request(encoded.method, encoded.params));
      const ref = chatRef(result.conversationID);
      await this.#upsertChat(ref, {
        title: safeOptions.title || result.snapshot.title,
        preview: safeOptions.preview || "",
        selectedModelId: result.snapshot.modelID || safeOptions.modelID,
        lastWatermark: result.snapshot.watermark,
      });
      return { ref, result };
    }
    if (mode === "work") {
      const safeOptions = workCreateOptions(options);
      const botId = requiredBotId(safeOptions.botId);
      delete safeOptions.botId;
      const transport = await this.#workTransport(botId);
      const result = await transport.request("thread/start", safeOptions, WORK_CREATE_TIMEOUT_MS);
      const ref = workRef(result?.thread?.id || result?.threadId, botId);
      return { ref, result };
    }
    throw new Error("Unknown conversation mode.");
  }

  async read(ref) {
    const mode = modeForRef(ref);
    const active = canonicalRefForMode(mode, ref);
    if (mode === "chat") {
      const stored = await this.#store().read(active.conversationId);
      const afterSequence = typeof stored?.lastWatermark?.sequence === "number" ? stored.lastWatermark.sequence : undefined;
      const encoded = snapshotCommand({ conversationID: active.conversationId, afterSequence });
      const result = adaptSnapshotResult(await this.#chatTransport().request(encoded.method, encoded.params));
      this.#assertChatIdentity(active, result);
      await this.#upsertChat(active, { title: result.snapshot.title, selectedModelId: result.snapshot.modelID, lastWatermark: result.snapshot.watermark });
      return { ref: active, result };
    }
    const result = await (await this.#workTransport(active.botId)).request("thread/read", { threadId: active.threadId, includeTurns: true });
    this.#assertWorkIdentity(active, result);
    return { ref: active, result };
  }

  async snapshot(ref) {
    return this.read(ref);
  }

  async send(...args) {
    const singlePayload = args.length === 1 && args[0] && typeof args[0] === "object";
    const input = singlePayload
      ? ownData(args[0], "conversation send")
      : { mode: args[0], ref: args[1], text: args[2], attachments: args[3], selection: args[4], workOptions: args[5] };
    const { mode, ref = null, text, attachments = [], selection = {}, workOptions = {} } = input;
    if (mode === "chat") {
      if (hasOwn(input, "botId")) throw new Error("Invalid Chat runtime override.");
      selectedOptions(workOptions, new Set(), "Chat send");
      const provided = ref === null ? null : canonicalRefForMode(mode, ref);
      const active = provided || (await this.create("chat", { modelID: selection.modelID })).ref;
      const requestID = this.makeId();
      const encoded = sendCommand({ requestID, conversationID: active.conversationId, text, attachments });
      const beforeSend = await this.#store().read(active.conversationId);
      const pendingRequests = [...(beforeSend?.pendingRequests || []), { requestID }];
      await this.#upsertChat(active, { pendingRequests });
      const result = await this.#chatTransport().request(encoded.method, encoded.params);
      this.#assertChatIdentity(active, result);
      const afterSend = await this.#store().read(active.conversationId);
      await this.#upsertChat(active, {
        preview: textPreview(text),
        selectedModelId: selection.modelID,
        pendingRequests: (afterSend?.pendingRequests || []).map((pending) => pending.requestID === requestID
          ? { requestID, ...(result?.turnID ? { turnID: result.turnID } : {}) }
          : pending),
      });
      return { ref: chatRef(active.conversationId), result };
    }
    if (mode === "work") {
      const botId = requiredBotId(input.botId);
      const provided = ref === null ? null : canonicalRefForMode(mode, ref, botId);
      const safeWorkOptions = selectedOptions(workOptions, WORK_SEND_FIELDS, "Work send");
      const allowed = Object.fromEntries(["clientUserMessageId", "cwd", "approvalPolicy", "serviceTier", "effort"].filter((key) => safeWorkOptions[key] !== undefined).map((key) => [key, safeWorkOptions[key]]));
      const active = provided || (await this.create("work", { botId, ...allowed, model: selection.modelID || safeWorkOptions.model })).ref;
      const result = await (await this.#workTransport(botId)).request("turn/start", {
        ...allowed,
        model: selection.modelID || safeWorkOptions.model,
        threadId: active.threadId,
        input: [{ type: "text", text, text_elements: [] }, ...attachments],
      });
      this.#assertWorkIdentity(active, result);
      return { ref: workRef(active.threadId, botId), result };
    }
    throw new Error("Unknown conversation mode.");
  }

  async cancel(ref, turnId) {
    const mode = modeForRef(ref);
    const active = canonicalRefForMode(mode, ref);
    let result;
    if (mode === "chat") {
      const encoded = cancelCommand({ requestID: this.makeId(), conversationID: active.conversationId, turnID: turnId });
      result = await this.#chatTransport().request(encoded.method, encoded.params);
    } else result = await (await this.#workTransport(active.botId)).request("turn/interrupt", { threadId: active.threadId, turnId });
    mode === "chat" ? this.#assertChatIdentity(active, result) : this.#assertWorkIdentity(active, result);
    return { ref: active, result };
  }

  async selectModel(ref, modelId) {
    const mode = modeForRef(ref);
    const active = canonicalRefForMode(mode, ref);
    if (mode === "chat") {
      const encoded = selectModelCommand({ conversationID: active.conversationId, modelID: modelId });
      const result = await this.#chatTransport().request(encoded.method, encoded.params);
      this.#assertChatIdentity(active, result);
      await this.#upsertChat(active, { selectedModelId: modelId });
      return { ref: active, result };
    }
    return { ref: active, modelId };
  }

  async rename(ref, name) {
    const mode = modeForRef(ref);
    const active = canonicalRefForMode(mode, ref);
    if (mode === "chat") {
      await this.#upsertChat(active, { title: name });
      return { ref: active, name };
    }
    const result = await (await this.#workTransport(active.botId)).request("thread/name/set", { threadId: active.threadId, name });
    this.#assertWorkIdentity(active, result);
    return { ref: active, result };
  }

  async reconcilePendingRequests() {
    const records = await this.#store().list();
    const owners = new Map();
    for (const record of records) {
      for (const pending of record.pendingRequests || []) owners.set(pending.requestID, record.conversationId);
    }
    const requestIDs = [...owners.keys()];
    if (!requestIDs.length) return { reconciliations: [] };
    const encoded = reconcileCommand({ requestIDs });
    const result = await this.#chatTransport().request(encoded.method, encoded.params);
    if (!Array.isArray(result?.reconciliations)) throw new Error("ChatGPT returned invalid request reconciliation.");
    const byConversation = new Map();
    for (const reconciliation of result.reconciliations) {
      const conversationId = owners.get(reconciliation?.requestID);
      if (!conversationId || (reconciliation.conversationID && reconciliation.conversationID !== conversationId)) {
        throw new Error("ChatGPT changed its native conversation ID.");
      }
      if (!byConversation.has(conversationId)) byConversation.set(conversationId, []);
      byConversation.get(conversationId).push(reconciliation);
    }
    for (const [conversationId, reconciliations] of byConversation) {
      const ref = chatRef(conversationId);
      const existing = await this.#store().read(conversationId);
      const outcomes = new Map(reconciliations.map((entry) => [entry.requestID, entry]));
      const terminal = new Set(["completed", "failed", "cancelled", "terminal"]);
      const pendingRequests = (existing?.pendingRequests || []).flatMap((pending) => {
        const outcome = outcomes.get(pending.requestID);
        if (!outcome || terminal.has(outcome.status)) return outcome ? [] : [pending];
        return [{ requestID: pending.requestID, ...(outcome.turnID || pending.turnID ? { turnID: outcome.turnID || pending.turnID } : {}) }];
      });
      const sequence = reconciliations.reduce((highest, entry) => Number.isSafeInteger(entry.sequence) ? Math.max(highest, entry.sequence) : highest, existing?.lastWatermark?.sequence ?? -1);
      const lastWatermark = sequence >= 0
        ? { streamID: existing?.lastWatermark?.streamID || `conversation:${conversationId}`, sequence }
        : existing?.lastWatermark;
      await this.#upsertChat(ref, { pendingRequests, lastWatermark });
    }
    return result;
  }

  #chatTransport() {
    if (this.disposed) throw new Error("ChatGPT is unavailable");
    if (!this.chatgpt?.request) throw new Error("ChatGPT is unavailable");
    return this.chatgpt;
  }

  #assertChatContext(context) {
    if (context === undefined) return;
    const data = ownData(context, "Chat context");
    if (Object.keys(data).length) throw new Error("Invalid Chat runtime override.");
  }

  #chatTransportWithContext(context) {
    this.#assertChatContext(context);
    return this.#chatTransport();
  }

  #contextBotId(mode, context) {
    if (mode !== "work") throw new Error("Unknown conversation mode.");
    if (context === undefined) throw new Error("A bot ID is required for Work.");
    const data = ownData(context, "Work context");
    if (Object.keys(data).length !== 1 || !hasOwn(data, "botId")) throw new Error("A bot ID is required for Work.");
    return requiredBotId(data.botId);
  }

  async #workTransport(botId) {
    if (this.disposed) throw new Error("Remote computer unavailable.");
    const owner = requiredBotId(botId);
    if (!this.codexForBot) throw new Error("Remote computer unavailable.");
    const client = await this.codexForBot(owner);
    if (this.disposed) throw new Error("Remote computer unavailable.");
    if (!client?.request) throw new Error("Remote computer unavailable.");
    this.#bindWorkClient(owner, client);
    return client;
  }

  #bindWorkClient(botId, client) {
    if (this.disposed) return;
    const current = this.workBindings.get(botId);
    if (current?.client === client) return;
    if (current) {
      if (typeof current.client.off === "function") current.client.off("notification", current.listener);
      else if (typeof current.client.removeListener === "function") current.client.removeListener("notification", current.listener);
    }
    const binding = { client, generation: client.generation ?? null, listener: null };
    binding.listener = (message) => {
      if (this.workBindings.get(botId) !== binding) return;
      this.#codexNotification(botId, message);
    };
    this.workBindings.set(botId, binding);
    if (typeof client.on === "function") client.on("notification", binding.listener);
  }

  #store() {
    if (!this.chatStore?.list || !this.chatStore?.read || !this.chatStore?.upsert) {
      throw new Error("Chat conversation history is unavailable");
    }
    return this.chatStore;
  }

  async #upsertChat(ref, patch) {
    const existing = await this.#store().read(ref.conversationId);
    const timestamp = now();
    return this.#store().upsert({
      conversationId: ref.conversationId,
      title: patch.title ?? existing?.title ?? "",
      preview: patch.preview ?? existing?.preview ?? "",
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      selectedModelId: patch.selectedModelId ?? existing?.selectedModelId,
      lastWatermark: patch.lastWatermark ?? existing?.lastWatermark,
      pendingRequests: patch.pendingRequests ?? existing?.pendingRequests ?? [],
    });
  }

  #assertChatIdentity(ref, result) {
    const received = result?.conversationID || result?.conversationId;
    if (received !== undefined && received !== ref.conversationId) {
      throw new Error("ChatGPT changed its native conversation ID.");
    }
  }

  #assertWorkIdentity(ref, result) {
    const received = result?.thread?.id || result?.threadId;
    if (received !== undefined && received !== ref.threadId) {
      throw new Error("Codex changed its native thread ID.");
    }
  }

  #queueChatEvent(event) {
    if (this.disposed) return;
    if (!event || typeof event.conversationID !== "string" || !event.conversationID) return;
    const previous = this.chatEventQueues.get(event.conversationID) || Promise.resolve();
    const current = previous.then(() => this.#chatEvent(event)).catch(() => {});
    this.chatEventQueues.set(event.conversationID, current);
    void current.finally(() => {
      if (this.chatEventQueues.get(event.conversationID) === current) this.chatEventQueues.delete(event.conversationID);
    });
  }

  async #chatEvent(event) {
    if (this.disposed) return;
    const ref = chatRef(event.conversationID);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) return;
    const existing = await this.#store().read(ref.conversationId);
    if (existing?.lastWatermark && event.sequence <= existing.lastWatermark.sequence) return;
    const terminalTypes = new Set(["turnCompleted", "turnFailed", "turnCancelled"]);
    const pendingRequests = terminalTypes.has(event.type)
      ? (existing?.pendingRequests || []).filter((pending) => pending.turnID !== event.turnID)
      : existing?.pendingRequests || [];
    const lastWatermark = {
      streamID: existing?.lastWatermark?.streamID || `conversation:${ref.conversationId}`,
      sequence: event.sequence,
    };
    await this.#upsertChat(ref, { lastWatermark, pendingRequests });
    if (this.disposed) return;
    this.emit("event", {
      source: "chatgpt",
      nativeId: ref.conversationId,
      ref,
      type: event.type,
      eventId: event.eventID || null,
      turnId: event.turnID || null,
      sequence: event.sequence ?? null,
      content: event.content ?? null,
      replacementRange: event.replacementRange ?? null,
      message: event.message ?? null,
    });
    const encoded = acknowledgeCommand({ watermarks: [lastWatermark] });
    await this.#chatTransport().request(encoded.method, encoded.params);
  }

  #codexNotification(botId, message) {
    if (this.disposed) return;
    const params = message?.params;
    if (!params || typeof params.threadId !== "string" || !params.threadId) return;
    const ref = workRef(params.threadId, botId);
    this.emit("event", {
      source: "codex",
      nativeId: ref.threadId,
      ref,
      type: message.method,
      eventId: null,
      turnId: params.turn?.id || params.turnId || null,
      sequence: null,
      content: null,
      message: params,
    });
  }
}

module.exports = {
  ConversationRouter,
  assertRefForMode,
};
