"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");

const SCHEMA_VERSION = 1;
const MAX_BOT_IDS = 256;
const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVICE_TIER = /^[a-z][a-z0-9_-]{0,31}$/;
const PROVIDERS = new Set(["openai-codex", "cliproxy-anthropic"]);
const SELECTION_FIELDS = new Set([
  "botId", "provider", "model", "reasoningEffort", "serviceTier",
  "catalogGeneration", "generation",
]);
const REQUEST_FIELDS = new Set([
  "botId", "provider", "model", "reasoningEffort", "serviceTier", "catalogGeneration",
]);
const DELETE_FIELDS = new Set(["botIds", "successorBotId"]);

function ownData(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is invalid.`);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new Error(`${label} is invalid.`);
  }
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label} is invalid.`);
  }
  return Object.fromEntries([...allowed].map((key) => [key, descriptors[key].value]));
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) throw new Error("Bot selection is invalid.");
  return value;
}

function normalizeDeleteRequest(value) {
  if (types.isProxy(value)) throw new Error("Bot deletion is invalid.");
  const request = ownData(value, DELETE_FIELDS, "Bot deletion");
  if (!Array.isArray(request.botIds) || types.isProxy(request.botIds)) {
    throw new Error("Bot deletion is invalid.");
  }
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(request.botIds); }
  catch { throw new Error("Bot deletion is invalid."); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BOT_IDS
    || Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new Error("Bot deletion is invalid.");
  }
  const botIds = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)) throw new Error("Bot deletion is invalid.");
    botIds.push(normalizeBotId(descriptor.value));
  }
  const ids = new Set(botIds);
  if (ids.size !== botIds.length) throw new Error("Bot deletion is invalid.");
  const successorBotId = request.successorBotId === null
    ? null : normalizeBotId(request.successorBotId);
  if (successorBotId !== null && ids.has(successorBotId)) {
    throw new Error("Bot deletion is invalid.");
  }
  return Object.freeze({ botIds: Object.freeze(botIds), successorBotId });
}

function normalizeSelection(value) {
  const selection = ownData(value, SELECTION_FIELDS, "Model selection");
  const botId = normalizeBotId(selection.botId);
  if (!PROVIDERS.has(selection.provider) || typeof selection.model !== "string"
    || !MODEL_ID.test(selection.model) || typeof selection.reasoningEffort !== "string"
    || !EFFORT.test(selection.reasoningEffort)
    || !(selection.serviceTier === null || (typeof selection.serviceTier === "string"
      && SERVICE_TIER.test(selection.serviceTier)))
    || !Number.isSafeInteger(selection.catalogGeneration) || selection.catalogGeneration < 0) {
    throw new Error("Model selection is invalid.");
  }
  if (!Number.isSafeInteger(selection.generation) || selection.generation < 0) {
    throw new Error("Model selection generation is invalid.");
  }
  return Object.freeze({
    botId,
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    serviceTier: selection.serviceTier,
    catalogGeneration: selection.catalogGeneration,
    generation: selection.generation,
  });
}

function normalizeSelectionRequest(value) {
  const selection = ownData(value, REQUEST_FIELDS, "Model selection");
  const botId = normalizeBotId(selection.botId);
  if (!PROVIDERS.has(selection.provider) || typeof selection.model !== "string"
    || !MODEL_ID.test(selection.model) || typeof selection.reasoningEffort !== "string"
    || !EFFORT.test(selection.reasoningEffort)
    || !(selection.serviceTier === null || (typeof selection.serviceTier === "string"
      && SERVICE_TIER.test(selection.serviceTier)))
    || !Number.isSafeInteger(selection.catalogGeneration) || selection.catalogGeneration < 0) {
    throw new Error("Model selection is invalid.");
  }
  return Object.freeze({
    botId,
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    serviceTier: selection.serviceTier,
    catalogGeneration: selection.catalogGeneration,
  });
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, activeBotId: null, selections: Object.create(null) };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || (value.activeBotId !== null && (typeof value.activeBotId !== "string" || !BOT_ID.test(value.activeBotId)))
    || !value.selections || typeof value.selections !== "object" || Array.isArray(value.selections)) {
    throw new Error("Model selection registry is malformed.");
  }
  const selections = Object.create(null);
  for (const [botId, raw] of Object.entries(value.selections)) {
    if (!BOT_ID.test(botId) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Model selection registry is malformed.");
    }
    const normalized = normalizeSelection({
      botId,
      provider: raw.provider ?? (String(raw.model).startsWith("claude-")
        ? "cliproxy-anthropic" : "openai-codex"),
      model: raw.model,
      reasoningEffort: raw.reasoningEffort,
      serviceTier: raw.serviceTier ?? null,
      catalogGeneration: raw.catalogGeneration ?? 0,
      generation: raw.generation,
    });
    selections[botId] = {
      model: normalized.model,
      reasoningEffort: normalized.reasoningEffort,
      provider: normalized.provider,
      serviceTier: normalized.serviceTier,
      catalogGeneration: normalized.catalogGeneration,
      generation: normalized.generation,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  }
  return { schemaVersion: SCHEMA_VERSION, activeBotId: value.activeBotId, selections };
}

class ModelSelectionStore {
  #filePath;
  #fs;
  #now;
  #randomUUID;
  #queue = Promise.resolve();

  constructor({ filePath, fs: fsApi = fs, now = () => new Date().toISOString(), randomUUID: uuid = randomUUID } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
      throw new Error("Model selection store requires an absolute file path.");
    }
    this.#filePath = filePath;
    this.#fs = fsApi;
    this.#now = now;
    this.#randomUUID = uuid;
  }

  read(botId) {
    const normalizedBotId = normalizeBotId(botId);
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const selection = state.selections[normalizedBotId];
      return selection ? Object.freeze({ botId: normalizedBotId, model: selection.model,
        provider: selection.provider, reasoningEffort: selection.reasoningEffort,
        serviceTier: selection.serviceTier, catalogGeneration: selection.catalogGeneration,
        generation: selection.generation }) : null;
    });
  }

  readActiveBotId() {
    return this.#enqueue(async () => {
      const state = await this.#readState();
      return state.activeBotId;
    });
  }

  selectBot(botId) {
    const normalizedBotId = normalizeBotId(botId);
    return this.#mutate((state) => {
      state.activeBotId = normalizedBotId;
      return normalizedBotId;
    });
  }

  ensure(botId, fallback) {
    const requested = normalizeSelectionRequest({ botId, ...fallback });
    return this.#mutate((state) => {
      state.activeBotId = requested.botId;
      const current = state.selections[requested.botId];
      if (current) {
        return Object.freeze({
          botId: requested.botId,
          provider: current.provider,
          model: current.model,
          reasoningEffort: current.reasoningEffort,
          serviceTier: current.serviceTier,
          catalogGeneration: current.catalogGeneration,
          generation: current.generation,
        });
      }
      const selection = Object.freeze({ ...requested, generation: 0 });
      state.selections[requested.botId] = {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        provider: selection.provider,
        serviceTier: selection.serviceTier,
        catalogGeneration: selection.catalogGeneration,
        generation: selection.generation,
        updatedAt: this.#now(),
      };
      return selection;
    });
  }

  writeNext(value) {
    const requested = normalizeSelectionRequest(value);
    return this.#mutate((state) => {
      const current = state.selections[requested.botId];
      const generation = current ? current.generation + 1 : 0;
      if (!Number.isSafeInteger(generation)) throw new Error("Model selection generation is invalid.");
      const selection = Object.freeze({ ...requested, generation });
      state.activeBotId = selection.botId;
      state.selections[selection.botId] = {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        provider: selection.provider,
        serviceTier: selection.serviceTier,
        catalogGeneration: selection.catalogGeneration,
        generation: selection.generation,
        updatedAt: this.#now(),
      };
      return selection;
    });
  }

  async write(value) {
    const selection = normalizeSelection(value);
    return this.#mutate((state) => {
      state.activeBotId = selection.botId;
      state.selections[selection.botId] = {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        provider: selection.provider,
        serviceTier: selection.serviceTier,
        catalogGeneration: selection.catalogGeneration,
        generation: selection.generation,
        updatedAt: this.#now(),
      };
      return selection;
    });
  }

  deleteBots(rawRequest) {
    const request = normalizeDeleteRequest(rawRequest);
    const ids = new Set(request.botIds);
    return this.#mutate((state) => {
      for (const id of ids) delete state.selections[id];
      if (ids.has(state.activeBotId)) state.activeBotId = request.successorBotId;
      return Object.freeze({ activeBotId: state.activeBotId });
    });
  }

  #enqueue(operation) {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #mutate(operation) {
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const result = operation(state);
      await this.#writeState(state);
      return result;
    });
  }

  async #readState() {
    try {
      const stat = await this.#fs.lstat(this.#filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Model selection registry is unsafe.");
      return normalizeState(JSON.parse(await this.#fs.readFile(this.#filePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      if (error instanceof SyntaxError) throw new Error("Model selection registry is malformed.");
      throw error;
    }
  }

  async #writeState(state) {
    const directory = path.dirname(this.#filePath);
    const temporary = path.join(directory, `.${path.basename(this.#filePath)}.${this.#randomUUID()}.tmp`);
    await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await this.#fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#fs.rename(temporary, this.#filePath);
      await this.#fs.chmod(this.#filePath, 0o600);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await this.#fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

module.exports = {
  BOT_ID,
  ModelSelectionStore,
  normalizeSelection,
  normalizeSelectionRequest,
};
