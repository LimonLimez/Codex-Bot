"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { types } = require("node:util");
const { parseLocalCron } = require("./local-cron-schedule.cjs");

const SCHEMA_VERSION = 1;
const MAX_AUTOMATIONS = 100;
const MAX_AUTOMATIONS_PER_BOT = 50;
const MAX_RUNS = 20;
const MAX_BOT_IDS = 256;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_SCHEDULE_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_METADATA_LENGTH = 300;
const MAX_COALESCED_RUN_IDS = 25;
const MAX_COALESCED_INPUT_IDS = 256;
const MAX_OPAQUE_ID_LENGTH = 256;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const STATE_FIELDS = new Set(["schemaVersion", "automations"]);
const AUTOMATION_FIELDS = new Set([
  "botId", "id", "name", "prompt", "trigger", "triggerDescription", "isEnabled",
  "provenance", "createdAt", "updatedAt", "lastRunAt", "nextRunAt", "runs",
  "revision", "conversationId",
]);
const CONFIG_FIELDS = new Set([
  "name", "prompt", "trigger", "triggerDescription", "isEnabled", "nextRunAt",
]);
const TRIGGER_FIELDS = new Set(["type", "schedule"]);
const RUN_FIELDS = new Set([
  "id", "trigger", "startedAt", "finishedAt", "status", "detail", "errorKind",
  "event", "coalescedRunIds", "invocationId",
]);
const RUN_REQUIRED_FIELDS = new Set(["id", "trigger", "startedAt", "finishedAt", "status"]);
const PUBLIC_RUN_FIELDS = new Set([
  "id", "trigger", "startedAt", "finishedAt", "status", "detail", "errorKind",
  "event", "coalescedRunIds",
]);

class LocalAutomationStoreError extends Error {
  constructor() {
    super("OpenBot local Routine storage failed.");
    this.name = "LocalAutomationStoreError";
    this.code = "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED";
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: "LocalAutomationStoreError: OpenBot local Routine storage failed.",
      writable: true,
    });
  }
}

function fail() { throw new LocalAutomationStoreError(); }

function ownData(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail(); }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !allowed.has(key) || !("value" in descriptors[key]))
    || [...required].some((key) => !descriptors[key])) fail();
  return Object.fromEntries(Object.entries(descriptors)
    .map(([key, descriptor]) => [key, descriptor.value]));
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value)) fail();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) fail();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)) fail();
    result.push(descriptor.value);
  }
  return result;
}

function publicValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(publicValue));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "invocationId")
    .map(([key, nested]) => [key, publicValue(nested)])));
}

function botId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) fail();
  return value;
}

function automationId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OPAQUE_ID_LENGTH
    || value === "." || value === ".." || /[\\/\0]/.test(value)) fail();
  return value;
}

function conversationId(value) {
  if (typeof value !== "string" || !CONVERSATION_ID.test(value)) fail();
  return value;
}

function invocationId(value) {
  if (typeof value !== "string" || !INVOCATION_ID.test(value)) fail();
  return value;
}

function opaqueId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OPAQUE_ID_LENGTH
    || value.trim() !== value || value.includes("\0")) fail();
  return value;
}

function epoch(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail();
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail();
  return value;
}

function incrementRevision(value) {
  const next = revision(value) + 1;
  if (!Number.isSafeInteger(next)) fail();
  return next;
}

function boundedString(value, { maximum, bytes = false, nonempty = true } = {}) {
  if (typeof value !== "string" || value.includes("\0")
    || (nonempty && (value.length === 0 || value.trim().length === 0))
    || (bytes ? Buffer.byteLength(value, "utf8") : value.length) > maximum) fail();
  return value;
}

function cronTrigger(value) {
  const raw = ownData(value, TRIGGER_FIELDS);
  if (raw.type !== "cron") fail();
  const schedule = boundedString(raw.schedule, { maximum: MAX_SCHEDULE_LENGTH });
  let parsed;
  try { parsed = parseLocalCron(schedule); } catch { fail(); }
  if (parsed.normalized !== schedule) fail();
  return {
    type: "cron",
    schedule,
  };
}

function config(value) {
  const raw = ownData(value, CONFIG_FIELDS);
  return {
    name: boundedString(raw.name, { maximum: MAX_NAME_LENGTH }),
    prompt: boundedString(raw.prompt, { maximum: MAX_PROMPT_BYTES, bytes: true }),
    trigger: cronTrigger(raw.trigger),
    triggerDescription: boundedString(raw.triggerDescription, {
      maximum: MAX_DESCRIPTION_LENGTH,
    }),
    isEnabled: (() => { if (typeof raw.isEnabled !== "boolean") fail(); return raw.isEnabled; })(),
    nextRunAt: epoch(raw.nextRunAt, { nullable: true }),
  };
}

function optionalMetadata(value) {
  if (value === undefined) return undefined;
  return boundedString(value, { maximum: MAX_METADATA_LENGTH });
}

function coalescedIds(value) {
  if (value === undefined) return undefined;
  const ids = denseArray(value, MAX_COALESCED_INPUT_IDS).map(opaqueId)
    .slice(0, MAX_COALESCED_RUN_IDS);
  return ids.length === 0 ? undefined : ids;
}

function runRecord(value, { persisted = false } = {}) {
  const raw = ownData(value, persisted ? RUN_FIELDS : PUBLIC_RUN_FIELDS, RUN_REQUIRED_FIELDS);
  const status = raw.status;
  const startedAt = epoch(raw.startedAt);
  const finishedAt = epoch(raw.finishedAt, { nullable: true });
  if (!new Set(["manual", "event", "schedule"]).has(raw.trigger)
    || !new Set(["running", "ok", "error"]).has(status)
    || (status === "running") !== (finishedAt === null)
    || (finishedAt !== null && finishedAt < startedAt)) fail();
  const detail = optionalMetadata(raw.detail);
  const errorKind = optionalMetadata(raw.errorKind);
  const event = optionalMetadata(raw.event);
  const coalescedRunIds = coalescedIds(raw.coalescedRunIds);
  if (status === "running" && (detail !== undefined || errorKind !== undefined)) fail();
  if (status === "ok" && errorKind !== undefined) fail();
  let storedInvocationId = null;
  if (persisted) {
    if (!(raw.invocationId === undefined || raw.invocationId === null)) {
      storedInvocationId = invocationId(raw.invocationId);
    }
    if (status === "running" && !Object.hasOwn(raw, "invocationId")) fail();
  }
  return {
    id: opaqueId(raw.id),
    trigger: raw.trigger,
    startedAt,
    finishedAt,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(event === undefined ? {} : { event }),
    ...(coalescedRunIds === undefined ? {} : { coalescedRunIds }),
    ...(persisted ? { invocationId: storedInvocationId } : {}),
  };
}

function storedAutomation(value) {
  const raw = ownData(value, AUTOMATION_FIELDS);
  const normalizedConfig = config({
    name: raw.name,
    prompt: raw.prompt,
    trigger: raw.trigger,
    triggerDescription: raw.triggerDescription,
    isEnabled: raw.isEnabled,
    nextRunAt: raw.nextRunAt,
  });
  if (raw.provenance !== "local") fail();
  const createdAt = epoch(raw.createdAt);
  const updatedAt = epoch(raw.updatedAt);
  const lastRunAt = epoch(raw.lastRunAt, { nullable: true });
  if (updatedAt < createdAt) fail();
  const runs = denseArray(raw.runs, MAX_RUNS).map((entry) => runRecord(entry, { persisted: true }));
  if (new Set(runs.map((entry) => entry.id)).size !== runs.length) fail();
  for (let index = 1; index < runs.length; index += 1) {
    if (runs[index - 1].startedAt < runs[index].startedAt) fail();
  }
  return {
    botId: botId(raw.botId),
    id: automationId(raw.id),
    ...normalizedConfig,
    provenance: "local",
    createdAt,
    updatedAt,
    lastRunAt,
    runs,
    revision: revision(raw.revision),
    conversationId: raw.conversationId === null ? null : conversationId(raw.conversationId),
  };
}

function normalizeState(value) {
  const raw = ownData(value, STATE_FIELDS);
  if (raw.schemaVersion !== SCHEMA_VERSION) fail();
  const automations = denseArray(raw.automations, MAX_AUTOMATIONS).map(storedAutomation);
  const ids = new Set();
  const botCounts = new Map();
  for (const entry of automations) {
    const ownerId = `${entry.botId}\0${entry.id}`;
    if (ids.has(ownerId)) fail();
    ids.add(ownerId);
    const count = (botCounts.get(entry.botId) ?? 0) + 1;
    if (count > MAX_AUTOMATIONS_PER_BOT) fail();
    botCounts.set(entry.botId, count);
  }
  return { schemaVersion: SCHEMA_VERSION, automations };
}

function emptyState() { return { schemaVersion: SCHEMA_VERSION, automations: [] }; }

function slugName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
}

function availableAutomationId(state, owner, name, now) {
  const occupied = new Set(state.automations
    .filter((entry) => entry.botId === owner).map((entry) => entry.id));
  const slug = slugName(name);
  const base = slug || `automation-${now}`;
  if (!occupied.has(base)) return base;
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  const fallback = `${base}-${now}`;
  if (occupied.has(fallback)) fail();
  return fallback;
}

function sorted(records) {
  return [...records].sort((left, right) => {
    if (left.nextRunAt === null && right.nextRunAt !== null) return 1;
    if (left.nextRunAt !== null && right.nextRunAt === null) return -1;
    if (left.nextRunAt !== right.nextRunAt) return left.nextRunAt - right.nextRunAt;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id.localeCompare(right.id);
  });
}

function parseNow(now) {
  let value;
  try { value = now(); } catch { fail(); }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) fail();
  return epoch(Date.parse(value));
}

function normalizeCreateRequest(value) {
  const raw = ownData(value, new Set(["botId", "automation"]));
  return { botId: botId(raw.botId), automation: config(raw.automation) };
}

function normalizeReplaceRequest(value) {
  const raw = ownData(value, new Set(["botId", "automationId", "expectedRevision", "automation"]));
  return {
    botId: botId(raw.botId),
    automationId: automationId(raw.automationId),
    expectedRevision: revision(raw.expectedRevision),
    automation: config(raw.automation),
  };
}

function normalizeOwnedRevisionRequest(value) {
  const raw = ownData(value, new Set(["botId", "automationId", "expectedRevision"]));
  return {
    botId: botId(raw.botId),
    automationId: automationId(raw.automationId),
    expectedRevision: revision(raw.expectedRevision),
  };
}

function normalizeClaimRequest(value) {
  const raw = ownData(value, new Set([
    "botId", "automationId", "expectedRevision", "run", "nextRunAt",
  ]));
  const run = runRecord(raw.run);
  if (run.status !== "running") fail();
  return {
    botId: botId(raw.botId),
    automationId: automationId(raw.automationId),
    expectedRevision: revision(raw.expectedRevision),
    run,
    nextRunAt: epoch(raw.nextRunAt, { nullable: true }),
  };
}

function normalizeAcceptRequest(value) {
  const raw = ownData(value, new Set([
    "botId", "automationId", "runId", "invocationId", "conversationId",
  ]));
  return {
    botId: botId(raw.botId),
    automationId: automationId(raw.automationId),
    runId: opaqueId(raw.runId),
    invocationId: invocationId(raw.invocationId),
    conversationId: conversationId(raw.conversationId),
  };
}

function normalizeFinishRequest(value) {
  const raw = ownData(value, new Set([
    "botId", "automationId", "runId", "finishedAt", "status", "detail", "errorKind",
  ]));
  if (!new Set(["ok", "error"]).has(raw.status)) fail();
  const detail = optionalMetadata(raw.detail);
  const errorKind = optionalMetadata(raw.errorKind);
  if (raw.status === "ok" && errorKind !== undefined) fail();
  return {
    botId: botId(raw.botId),
    automationId: automationId(raw.automationId),
    runId: opaqueId(raw.runId),
    finishedAt: epoch(raw.finishedAt),
    status: raw.status,
    detail,
    errorKind,
  };
}

function normalizeDeleteBotsRequest(value) {
  const raw = ownData(value, new Set(["botIds"]));
  const botIds = denseArray(raw.botIds, MAX_BOT_IDS).map(botId);
  if (botIds.length === 0 || new Set(botIds).size !== botIds.length) fail();
  return { botIds };
}

class LocalAutomationStore {
  #filePath;
  #fs;
  #makeId;
  #now;
  #queue = Promise.resolve();

  constructor({ filePath, fs: fsApi = fs, randomUUID: makeId = randomUUID,
    now = () => new Date().toISOString() } = {}) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)
      || !fsApi || typeof fsApi.lstat !== "function" || typeof fsApi.readFile !== "function"
      || typeof fsApi.mkdir !== "function" || typeof fsApi.open !== "function"
      || typeof fsApi.rename !== "function" || typeof fsApi.chmod !== "function"
      || typeof makeId !== "function" || typeof now !== "function") fail();
    this.#filePath = filePath;
    this.#fs = fsApi;
    this.#makeId = makeId;
    this.#now = now;
  }

  list(rawBotId) {
    return this.#enqueue(async () => {
      const owner = botId(rawBotId);
      const state = await this.#readState();
      return publicValue(sorted(state.automations.filter((entry) => entry.botId === owner)));
    });
  }

  listAll() {
    return this.#enqueue(async () => publicValue(sorted((await this.#readState()).automations)));
  }

  create(value) {
    let request;
    try { request = normalizeCreateRequest(value); }
    catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#mutate((state) => {
      if (state.automations.length >= MAX_AUTOMATIONS
        || state.automations.filter((entry) => entry.botId === request.botId).length
          >= MAX_AUTOMATIONS_PER_BOT) fail();
      const current = parseNow(this.#now);
      const id = availableAutomationId(state, request.botId, request.automation.name, current);
      state.automations.push({
        botId: request.botId,
        id,
        ...request.automation,
        provenance: "local",
        createdAt: current,
        updatedAt: current,
        lastRunAt: null,
        runs: [],
        revision: 1,
        conversationId: null,
      });
      return sorted(state.automations.filter((entry) => entry.botId === request.botId));
    });
  }

  replace(value) {
    let request;
    try { request = normalizeReplaceRequest(value); }
    catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#mutate((state) => {
      const index = this.#ownedIndex(state, request.botId, request.automationId);
      const current = state.automations[index];
      if (current.revision !== request.expectedRevision) fail();
      state.automations[index] = {
        ...current,
        ...request.automation,
        updatedAt: parseNow(this.#now),
        revision: incrementRevision(current.revision),
      };
      return sorted(state.automations.filter((entry) => entry.botId === request.botId));
    });
  }

  delete(value) {
    let request;
    try { request = normalizeOwnedRevisionRequest(value); }
    catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#mutate((state) => {
      const index = this.#ownedIndex(state, request.botId, request.automationId);
      if (state.automations[index].revision !== request.expectedRevision) fail();
      state.automations.splice(index, 1);
      return sorted(state.automations.filter((entry) => entry.botId === request.botId));
    });
  }

  bindConversation(value) {
    let request;
    try {
      const raw = ownData(value, new Set([
        "botId", "automationId", "expectedRevision", "conversationId",
      ]));
      request = {
        botId: botId(raw.botId),
        automationId: automationId(raw.automationId),
        expectedRevision: revision(raw.expectedRevision),
        conversationId: conversationId(raw.conversationId),
      };
    } catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#mutate((state) => {
      const index = this.#ownedIndex(state, request.botId, request.automationId);
      const current = state.automations[index];
      if (current.revision !== request.expectedRevision) fail();
      if (current.conversationId === request.conversationId) return current;
      const updated = {
        ...current,
        conversationId: request.conversationId,
        updatedAt: parseNow(this.#now),
        revision: incrementRevision(current.revision),
      };
      state.automations[index] = updated;
      return updated;
    });
  }

  claimRun(value) {
    let request;
    try { request = normalizeClaimRequest(value); }
    catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const index = this.#ownedIndex(state, request.botId, request.automationId);
      const current = state.automations[index];
      if (current.revision !== request.expectedRevision
        || current.runs.some((entry) => entry.status === "running")) {
        return publicValue({ claimed: false, automation: current });
      }
      if (current.runs.some((entry) => entry.id === request.run.id)) fail();
      const updated = {
        ...current,
        nextRunAt: request.nextRunAt,
        lastRunAt: request.run.startedAt,
        updatedAt: parseNow(this.#now),
        runs: [{ ...request.run, invocationId: null }, ...current.runs].slice(0, MAX_RUNS),
        revision: incrementRevision(current.revision),
      };
      state.automations[index] = updated;
      await this.#writeState(state);
      return publicValue({ claimed: true, automation: updated });
    });
  }

  acceptRun(value) {
    let request;
    try { request = normalizeAcceptRequest(value); }
    catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#mutate((state) => {
      const index = this.#ownedIndex(state, request.botId, request.automationId);
      const current = state.automations[index];
      const runIndex = current.runs.findIndex((entry) => entry.id === request.runId);
      if (runIndex < 0 || current.runs[runIndex].status !== "running") fail();
      if (current.runs[runIndex].invocationId === request.invocationId
        && current.conversationId === request.conversationId) return current;
      if (current.runs[runIndex].invocationId !== null) fail();
      const runs = [...current.runs];
      runs[runIndex] = { ...runs[runIndex], invocationId: request.invocationId };
      const updated = {
        ...current,
        conversationId: request.conversationId,
        updatedAt: parseNow(this.#now),
        runs,
        revision: incrementRevision(current.revision),
      };
      state.automations[index] = updated;
      return updated;
    });
  }

  finishRun(value) {
    let request;
    try { request = normalizeFinishRequest(value); }
    catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#mutate((state) => {
      const index = this.#ownedIndex(state, request.botId, request.automationId);
      const current = state.automations[index];
      const runIndex = current.runs.findIndex((entry) => entry.id === request.runId);
      if (runIndex < 0) fail();
      const previous = current.runs[runIndex];
      if (previous.status !== "running" || request.finishedAt < previous.startedAt) fail();
      const runs = [...current.runs];
      runs[runIndex] = {
        ...previous,
        finishedAt: request.finishedAt,
        status: request.status,
        ...(request.detail === undefined ? {} : { detail: request.detail }),
        ...(request.errorKind === undefined ? {} : { errorKind: request.errorKind }),
      };
      const updated = {
        ...current,
        updatedAt: parseNow(this.#now),
        runs,
        revision: incrementRevision(current.revision),
      };
      state.automations[index] = updated;
      return updated;
    });
  }

  recoverRunning(value) {
    let finishedAt;
    try {
      const raw = ownData(value, new Set(["finishedAt"]));
      finishedAt = epoch(raw.finishedAt);
    } catch { return Promise.reject(new LocalAutomationStoreError()); }
    return this.#enqueue(async () => {
      const state = await this.#readState();
      let changed = false;
      for (let index = 0; index < state.automations.length; index += 1) {
        const current = state.automations[index];
        let recovered = false;
        const runs = current.runs.map((run) => {
          if (run.status !== "running") return run;
          if (finishedAt < run.startedAt) fail();
          recovered = true;
          return {
            ...run,
            finishedAt,
            status: "error",
            errorKind: "interrupted",
          };
        });
        if (recovered) {
          state.automations[index] = {
            ...current,
            updatedAt: finishedAt,
            runs,
            revision: incrementRevision(current.revision),
          };
          changed = true;
        }
      }
      if (changed) await this.#writeState(state);
      return publicValue(sorted(state.automations));
    });
  }

  deleteBots(value) {
    let request;
    try { request = normalizeDeleteBotsRequest(value); }
    catch { return Promise.reject(new LocalAutomationStoreError()); }
    const ids = new Set(request.botIds);
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const deletedAutomationIds = state.automations
        .filter((entry) => ids.has(entry.botId)).map((entry) => entry.id);
      if (deletedAutomationIds.length > 0) {
        state.automations = state.automations.filter((entry) => !ids.has(entry.botId));
        await this.#writeState(state);
      }
      return publicValue({ deletedAutomationIds });
    });
  }

  #newUuid() {
    let value;
    try { value = this.#makeId(); } catch { fail(); }
    if (typeof value !== "string" || !UUID.test(value)) fail();
    return value;
  }

  #ownedIndex(state, owner, id) {
    const index = state.automations.findIndex((entry) => entry.botId === owner && entry.id === id);
    if (index < 0) fail();
    return index;
  }

  #enqueue(operation) {
    const next = this.#queue.then(operation, operation)
      .catch(() => { throw new LocalAutomationStoreError(); });
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  #mutate(operation) {
    return this.#enqueue(async () => {
      const state = await this.#readState();
      const result = operation(state);
      await this.#writeState(state);
      return publicValue(result);
    });
  }

  async #readState() {
    const directory = path.dirname(this.#filePath);
    let directoryStat;
    try { directoryStat = await this.#fs.lstat(directory); }
    catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      fail();
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail();
    if ((directoryStat.mode & 0o777) !== 0o700) {
      try {
        await this.#fs.chmod(directory, 0o700);
        directoryStat = await this.#fs.lstat(directory);
      } catch { fail(); }
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (directoryStat.mode & 0o777) !== 0o700) fail();
    }
    let stat;
    try { stat = await this.#fs.lstat(this.#filePath); }
    catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      fail();
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail();
    if ((stat.mode & 0o777) !== 0o600) {
      try {
        await this.#fs.chmod(this.#filePath, 0o600);
        stat = await this.#fs.lstat(this.#filePath);
      } catch { fail(); }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES
        || (stat.mode & 0o777) !== 0o600) fail();
    }
    let source;
    try { source = await this.#fs.readFile(this.#filePath, "utf8"); } catch { fail(); }
    if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) fail();
    try { return normalizeState(JSON.parse(source)); } catch { fail(); }
  }

  async #writeState(rawState) {
    const state = normalizeState(rawState);
    let source;
    try { source = `${JSON.stringify(state, null, 2)}\n`; } catch { fail(); }
    if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) fail();
    const directory = path.dirname(this.#filePath);
    let temporary = null;
    let fileHandle = null;
    let directoryHandle = null;
    let renamed = false;
    try {
      await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 });
      let directoryStat = await this.#fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail();
      if ((directoryStat.mode & 0o777) !== 0o700) {
        await this.#fs.chmod(directory, 0o700);
        directoryStat = await this.#fs.lstat(directory);
      }
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || (directoryStat.mode & 0o777) !== 0o700) fail();
      temporary = path.join(directory, `.${path.basename(this.#filePath)}.${this.#newUuid()}.tmp`);
      fileHandle = await this.#fs.open(temporary, "wx", 0o600);
      await fileHandle.writeFile(source, "utf8");
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;
      await this.#fs.rename(temporary, this.#filePath);
      renamed = true;
      temporary = null;
      await this.#fs.chmod(this.#filePath, 0o600);
      directoryHandle = await this.#fs.open(directory, "r");
      await directoryHandle.sync();
      await directoryHandle.close();
      directoryHandle = null;
    } catch {
      try { await fileHandle?.close(); } catch {}
      try { await directoryHandle?.close(); } catch {}
      if (temporary) {
        try { await this.#fs.rm(temporary, { force: true }); } catch {}
      }
      if (renamed) {
        try {
          const committed = await this.#readState();
          if (JSON.stringify(committed) === JSON.stringify(state)) return;
        } catch {}
      }
      fail();
    }
  }
}

module.exports = {
  LocalAutomationStore,
  LocalAutomationStoreError,
};
