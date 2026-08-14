"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const SCHEMA_VERSION = 1;
const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL_EFFORTS = Object.freeze({
  "gpt-5.6-sol": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.6-terra": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra"]),
  "gpt-5.5": Object.freeze(["low", "medium", "high", "xhigh"]),
  "claude-fable-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-opus-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-sonnet-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
});
const SELECTION_FIELDS = new Set(["botId", "model", "reasoningEffort", "generation"]);
const REQUEST_FIELDS = new Set(["botId", "model", "reasoningEffort"]);

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

function normalizeSelection(value) {
  const selection = ownData(value, SELECTION_FIELDS, "Model selection");
  const botId = normalizeBotId(selection.botId);
  const efforts = MODEL_EFFORTS[selection.model];
  if (!efforts || !efforts.includes(selection.reasoningEffort)) {
    throw new Error("Model selection is invalid.");
  }
  if (!Number.isSafeInteger(selection.generation) || selection.generation < 0) {
    throw new Error("Model selection generation is invalid.");
  }
  return Object.freeze({
    botId,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    generation: selection.generation,
  });
}

function normalizeSelectionRequest(value) {
  const selection = ownData(value, REQUEST_FIELDS, "Model selection");
  const botId = normalizeBotId(selection.botId);
  const efforts = MODEL_EFFORTS[selection.model];
  if (!efforts || !efforts.includes(selection.reasoningEffort)) {
    throw new Error("Model selection is invalid.");
  }
  return Object.freeze({
    botId,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
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
      model: raw.model,
      reasoningEffort: raw.reasoningEffort,
      generation: raw.generation,
    });
    selections[botId] = {
      model: normalized.model,
      reasoningEffort: normalized.reasoningEffort,
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
        reasoningEffort: selection.reasoningEffort, generation: selection.generation }) : null;
    });
  }

  selectBot(botId) {
    const normalizedBotId = normalizeBotId(botId);
    return this.#mutate((state) => {
      state.activeBotId = normalizedBotId;
      return normalizedBotId;
    });
  }

  async write(value) {
    const selection = normalizeSelection(value);
    return this.#mutate((state) => {
      state.activeBotId = selection.botId;
      state.selections[selection.botId] = {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        generation: selection.generation,
        updatedAt: this.#now(),
      };
      return selection;
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
  MODEL_EFFORTS,
  ModelSelectionStore,
  normalizeSelection,
  normalizeSelectionRequest,
};
