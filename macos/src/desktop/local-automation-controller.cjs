"use strict";

const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { types } = require("node:util");
const {
  nextLocalCronAt,
  parseLocalCron,
} = require("./local-cron-schedule.cjs");

const MAX_TIMER_DELAY = 2_147_483_647;
const ARM_RETRY_BASE_DELAY = 1_000;
const ARM_RETRY_MAX_DELAY = 60_000;
const RUN_RETRY_BASE_DELAY = 1_000;
const RUN_RETRY_MAX_DELAY = 60_000;
const MAX_TERMINAL_BUFFER = 128;
const MAX_BOT_IDS = 256;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_AUTOMATION_ID_LENGTH = 256;

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^conversation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^invocation-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const INVALID = "OPENBOT_LOCAL_AUTOMATION_INVALID";
const UNAVAILABLE = "OPENBOT_LOCAL_AUTOMATION_UNAVAILABLE";
const STORE_FAILED = "OPENBOT_LOCAL_AUTOMATION_STORE_FAILED";
const FAILED = "OPENBOT_LOCAL_AUTOMATION_FAILED";
const RUN_FAILURE_DETAIL = "OpenBot local Routine run failed.";
const CANCELLED = Symbol("cancelled");
const ADVANCE_EXHAUSTED = Symbol("advance_exhausted");

const EMPTY_FIELDS = new Set();
const ID_FIELDS = new Set(["id"]);
const AUTOMATION_FIELDS = new Set(["id", "automationId"]);
const ENABLE_FIELDS = new Set(["id", "automationId", "isEnabled"]);
const SPEC_FIELDS = new Set(["name", "prompt", "trigger", "isEnabled"]);
const CREATE_FIELDS = new Set(["id", "spec"]);
const UPDATE_FIELDS = new Set(["id", "automationId", "spec"]);
const DELETE_BOTS_FIELDS = new Set(["botIds"]);
const CRON_TRIGGER_FIELDS = new Set(["type", "schedule"]);
const TERMINAL_FIELDS = new Set([
  "type", "botId", "conversationId", "invocationId", "generation", "code",
]);
const TERMINAL_REQUIRED_FIELDS = new Set([
  "type", "botId", "conversationId", "invocationId", "generation",
]);
const REMOTE_TRIGGER_TYPES = new Set([
  "slack", "github", "microsoftTeams", "linear", "sentry", "pagerduty", "group",
]);

class LocalAutomationControllerError extends Error {
  constructor(code = FAILED) {
    const message = code === INVALID
      ? "OpenBot local Routine request is invalid."
      : code === UNAVAILABLE
        ? "OpenBot local Routine capability is unavailable."
        : code === STORE_FAILED
          ? "OpenBot local Routine storage failed."
        : "OpenBot local Routine operation failed.";
    super(message);
    this.name = "LocalAutomationControllerError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `LocalAutomationControllerError: ${message}`,
      writable: true,
    });
  }
}

function fail(code = FAILED) { throw new LocalAutomationControllerError(code); }

function sanitized(error, fallback = FAILED) {
  if (error instanceof LocalAutomationControllerError) return error;
  if (error?.code === INVALID) return new LocalAutomationControllerError(INVALID);
  if (error?.code === STORE_FAILED) return new LocalAutomationControllerError(STORE_FAILED);
  return new LocalAutomationControllerError(fallback);
}

function ownData(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    fail(INVALID);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail(INVALID); }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !allowed.has(key) || !("value" in descriptors[key]))
    || [...required].some((key) => !descriptors[key])) fail(INVALID);
  return Object.fromEntries(Object.entries(descriptors)
    .map(([key, descriptor]) => [key, descriptor.value]));
}

function dataRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return null;
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { return null; }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !("value" in descriptors[key]))) return null;
  return Object.fromEntries(Object.entries(descriptors)
    .map(([key, descriptor]) => [key, descriptor.value]));
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || types.isProxy(value)) fail(INVALID);
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { fail(INVALID); }
  const length = descriptors.length?.value;
  if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 1
    || length > maximum || Reflect.ownKeys(descriptors).length !== length + 1) fail(INVALID);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)) fail(INVALID);
    result.push(descriptor.value);
  }
  return result;
}

function normalizedBotId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) fail(INVALID);
  return value;
}

function normalizedAutomationId(value) {
  if (typeof value !== "string" || value.length === 0
    || value.length > MAX_AUTOMATION_ID_LENGTH || value === "." || value === ".."
    || /[\\/\0]/u.test(value)) fail(INVALID);
  return value;
}

function normalizedBoolean(value) {
  if (typeof value !== "boolean") fail(INVALID);
  return value;
}

function normalizedSpec(value) {
  const raw = ownData(value, SPEC_FIELDS);
  if (typeof raw.name !== "string" || raw.name.includes("\0") || raw.name.length > 4096) {
    fail(INVALID);
  }
  const name = raw.name.trim().replace(/\s+/gu, " ");
  if (name.length === 0 || name.length > MAX_NAME_LENGTH
    || typeof raw.prompt !== "string" || raw.prompt.includes("\0")
    || raw.prompt.trim().length === 0
    || Buffer.byteLength(raw.prompt, "utf8") > MAX_PROMPT_BYTES) fail(INVALID);
  const triggerRecord = dataRecord(raw.trigger);
  if (!triggerRecord || typeof triggerRecord.type !== "string") fail(INVALID);
  if (triggerRecord.type !== "cron") {
    if (REMOTE_TRIGGER_TYPES.has(triggerRecord.type)) fail(UNAVAILABLE);
    fail(INVALID);
  }
  const trigger = ownData(raw.trigger, CRON_TRIGGER_FIELDS);
  if (trigger.type !== "cron" || typeof trigger.schedule !== "string") fail(INVALID);
  return {
    name,
    prompt: raw.prompt,
    schedule: trigger.schedule,
    isEnabled: normalizedBoolean(raw.isEnabled),
  };
}

function normalizedTerminalEvent(value) {
  let raw;
  try { raw = ownData(value, TERMINAL_FIELDS, TERMINAL_REQUIRED_FIELDS); }
  catch { return null; }
  if (!new Set(["completed", "failed", "cancelled"]).has(raw.type)
    || typeof raw.botId !== "string" || !BOT_ID.test(raw.botId)
    || typeof raw.conversationId !== "string" || !CONVERSATION_ID.test(raw.conversationId)
    || typeof raw.invocationId !== "string" || !INVOCATION_ID.test(raw.invocationId)
    || !Number.isSafeInteger(raw.generation) || raw.generation < 0
    || (raw.code !== undefined && (typeof raw.code !== "string" || raw.code.length > 256))) return null;
  return Object.freeze({
    type: raw.type,
    botId: raw.botId,
    conversationId: raw.conversationId,
    invocationId: raw.invocationId,
    generation: raw.generation,
    ...(raw.code === undefined ? {} : { code: raw.code }),
  });
}

function terminalErrorKind(event) {
  if (event.type === "cancelled") return "cancelled";
  if (event.code === "OPENBOT_CONVERSATION_STALE") return "interrupted";
  return "opaque_wire_failure";
}

function operationErrorKind(error) {
  if (!error || typeof error !== "object" || types.isProxy(error)) {
    return "opaque_wire_failure";
  }
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(error, "code"); }
  catch { return "opaque_wire_failure"; }
  const code = descriptor && "value" in descriptor ? descriptor.value : null;
  if (code === "OPENBOT_CONVERSATION_STALE") return "interrupted";
  if (code === "OPENBOT_CONVERSATION_CANCELLED") return "cancelled";
  return "opaque_wire_failure";
}

function frozenValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenValue));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(Object.entries(value)
    .map(([key, nested]) => [key, frozenValue(nested)])));
}

function sortAutomations(records) {
  return [...records].sort((left, right) => {
    if (left.nextRunAt === null && right.nextRunAt !== null) return 1;
    if (left.nextRunAt !== null && right.nextRunAt === null) return -1;
    if (left.nextRunAt !== right.nextRunAt) return left.nextRunAt - right.nextRunAt;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id.localeCompare(right.id);
  });
}

function runProjection(run) {
  return frozenValue({
    id: run.id,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    ...(run.detail === undefined ? {} : { detail: run.detail }),
    ...(run.errorKind === undefined ? {} : { errorKind: run.errorKind }),
    ...(run.event === undefined ? {} : { event: run.event }),
    ...(run.coalescedRunIds === undefined ? {} : { coalescedRunIds: run.coalescedRunIds }),
  });
}

function logicalPath(record) {
  return `openbot-local-routine:${record.botId}:${record.id}`;
}

function automationProjection(record) {
  return frozenValue({
    id: record.id,
    name: record.name,
    prompt: record.prompt,
    trigger: { type: "cron", schedule: record.trigger.schedule },
    schedule: record.trigger.schedule,
    triggerDescription: record.triggerDescription,
    isEnabled: record.isEnabled,
    provenance: "local",
    createdAt: record.createdAt,
    lastRunAt: record.lastRunAt ?? null,
    nextRunAt: record.nextRunAt ?? null,
    runs: record.runs.map(runProjection),
    filePath: logicalPath(record),
  });
}

function workflowProjection(record) {
  return frozenValue({
    id: record.id,
    name: record.name,
    description: "",
    body: record.prompt,
    trigger: {
      schedule: record.trigger.schedule,
      isEnabled: record.isEnabled,
    },
    source: "automation",
    sourceRef: null,
    pluginId: null,
    publishedByCurrentUser: false,
    isEnabledForAgent: true,
    scheduleDescription: record.triggerDescription,
    createdAt: record.createdAt,
    lastRunAt: record.lastRunAt ?? null,
    nextRunAt: record.nextRunAt ?? null,
    helperScripts: [],
    runs: record.runs.map(runProjection),
    filePath: logicalPath(record),
  });
}

function formatTime(hour, minute) {
  const suffix = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function arithmeticStep(values) {
  if (values.length < 2) return null;
  const step = values[1] - values[0];
  if (step <= 0) return null;
  for (let index = 2; index < values.length; index += 1) {
    if (values[index] - values[index - 1] !== step) return null;
  }
  return step;
}

function joinedWords(values) {
  if (values.length <= 1) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function ordinal(value) {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? "st" : value % 10 === 2 ? "nd"
    : value % 10 === 3 ? "rd" : "th"}`;
}

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const WEEKDAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);
const WEEKENDS = new Set([0, 6]);

function sameSet(values, expected) {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

function sortedNumbers(values) { return [...values].sort((left, right) => left - right); }

function dayDescription(schedule) {
  const months = schedule.month?.values;
  const daysOfMonth = schedule.dayOfMonth?.values;
  const daysOfWeek = schedule.dayOfWeek?.values;
  if (!Array.isArray(months) || !Array.isArray(daysOfMonth) || !Array.isArray(daysOfWeek)) {
    return null;
  }
  const everyMonth = months.length === 12;
  const restrictedMonthDay = !schedule.dayOfMonth?.wildcard && daysOfMonth.length < 31;
  const restrictedWeekday = !schedule.dayOfWeek?.wildcard && daysOfWeek.length < 7;
  if (restrictedMonthDay && restrictedWeekday) return null;
  if (restrictedWeekday) {
    if (!everyMonth) return null;
    if (sameSet(daysOfWeek, WEEKDAYS)) return { lead: "Weekdays", on: " on weekdays" };
    if (sameSet(daysOfWeek, WEEKENDS)) return { lead: "Weekends", on: " on weekends" };
    const sorted = sortedNumbers(daysOfWeek);
    const first = sorted[0];
    const last = sorted.at(-1);
    if (first === undefined || last === undefined) return null;
    if (sorted.length > 3) {
      if (arithmeticStep(sorted) !== 1) return null;
      const range = `${WEEKDAY_SHORT_NAMES[first]}–${WEEKDAY_SHORT_NAMES[last]}`;
      return { lead: range, on: `, ${range}` };
    }
    const names = sorted.flatMap((value) => WEEKDAY_NAMES[value] ?? []);
    const joined = joinedWords(names);
    return { lead: `Every ${joined}`, on: ` on ${joined}` };
  }
  if (restrictedMonthDay) {
    const sorted = sortedNumbers(daysOfMonth);
    if (everyMonth) {
      if (sorted.length > 3) return null;
      const joined = joinedWords(sorted.map(ordinal));
      return {
        lead: `On the ${joined} of every month`,
        on: ` on the ${joined} of every month`,
      };
    }
    if (months.length === 1 && sorted.length === 1) {
      const month = months[0];
      const day = sorted[0];
      if (month === undefined || day === undefined) return null;
      const date = `${MONTH_NAMES[month - 1]} ${day}`;
      return { lead: `Every ${date}`, on: ` on ${date}` };
    }
    return null;
  }
  return everyMonth ? { lead: "Every day", on: null } : null;
}

function minuteStep(values) {
  if (values[0] !== 0) return null;
  const step = arithmeticStep(values);
  const last = values.at(-1);
  return step === null || last === undefined || last + step <= 59 ? null : step;
}

function minuteLabel(value) { return `:${String(value).padStart(2, "0")}`; }

function timeDescription(schedule) {
  const minutes = sortedNumbers(schedule.minute?.values || []);
  const hours = sortedNumbers(schedule.hour?.values || []);
  const firstMinute = minutes[0];
  const lastMinute = minutes.at(-1);
  const firstHour = hours[0];
  const lastHour = hours.at(-1);
  if (firstMinute === undefined || lastMinute === undefined
    || firstHour === undefined || lastHour === undefined) return null;
  const everyHour = hours.length === 24;
  if (minutes.length === 1) {
    const minuteSuffix = firstMinute === 0 ? "" : ` at ${minuteLabel(firstMinute)}`;
    if (everyHour) return { kind: "interval", base: `Every hour${minuteSuffix}`, window: null };
    if (hours.length === 1) return { kind: "times", times: [formatTime(firstHour, firstMinute)] };
    const step = arithmeticStep(hours);
    if (step !== null) {
      const base = step === 1 ? "Every hour" : `Every ${step} hours`;
      if (firstHour === 0 && lastHour + step > 23) {
        return { kind: "interval", base: `${base}${minuteSuffix}`, window: null };
      }
      if (step === 1 || hours.length > 3) {
        return {
          kind: "interval",
          base,
          window: `${formatTime(firstHour, firstMinute)} – ${formatTime(lastHour, firstMinute)}`,
        };
      }
    }
    return hours.length <= 3
      ? { kind: "times", times: hours.map((hour) => formatTime(hour, firstMinute)) }
      : null;
  }
  const step = minuteStep(minutes);
  let base;
  if (step !== null) {
    base = step === 1 ? "Every minute" : `Every ${step} minutes`;
  } else {
    if (minutes.length > 3) return null;
    if (!everyHour && hours.length === 1) {
      return {
        kind: "times",
        times: minutes.map((minute) => formatTime(firstHour, minute)),
      };
    }
    base = `Every hour at ${joinedWords(minutes.map(minuteLabel))}`;
  }
  if (everyHour) return { kind: "interval", base, window: null };
  if (hours.length === 1 || arithmeticStep(hours) === 1) {
    return {
      kind: "interval",
      base,
      window: `${formatTime(firstHour, firstMinute)} – ${formatTime(lastHour, lastMinute)}`,
    };
  }
  return null;
}

function cronDescription(schedule) {
  const day = dayDescription(schedule);
  if (!day) return null;
  const time = timeDescription(schedule);
  if (!time) return null;
  if (time.kind === "times") return `${day.lead} at ${joinedWords(time.times)}`;
  return `${time.base}${day.on ?? ""}${time.window === null ? "" : `, ${time.window}`}`;
}

function describeSchedule(schedule) {
  if (schedule.kind === "interval") {
    const match = /^@every (\d+)([smhd])$/u.exec(schedule.normalized);
    if (!match) return schedule.normalized;
    const amount = Number(match[1]);
    const unit = { s: "second", m: "minute", h: "hour", d: "day" }[match[2]];
    return amount === 1 ? `Every ${unit}` : `Every ${amount} ${unit}s`;
  }
  const description = cronDescription(schedule);
  if (description === null) return schedule.normalized;
  const timezonePrefix = /^(?:TZ|CRON_TZ)=([^\s]+)\s/u.exec(schedule.normalized);
  return `${description}${timezonePrefix ? ` (${timezonePrefix[1]})` : ""}`;
}

function terminalKey(value) {
  return `${value.botId}\0${value.conversationId}\0${value.invocationId}\0${value.generation}`;
}

function conversationPairKey(botId, conversationId) {
  return `${botId}\0${conversationId}`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class LocalAutomationController extends EventEmitter {
  #store;
  #conversations;
  #parseCron;
  #nextCronAt;
  #makeId;
  #now;
  #setTimer;
  #clearTimer;
  #timer = null;
  #armEpoch = 0;
  #started = false;
  #startPromise = null;
  #disposed = false;
  #disposeEpoch = 0;
  #disposePromise = null;
  #runClaims = new Map();
  #runBackoffs = new Map();
  #armReadFailures = 0;
  #routineDeletes = new Map();
  #botMutationTails = new Map();
  #botEpochs = new Map();
  #deletedBots = new Set();
  #deleteOperations = new Map();
  #snapshots = new Map();
  #terminalBuffer = new Map();
  #settledTerminalKeys = new Set();
  #onConversationEvent;

  constructor(rawOptions = {}) {
    super();
    const options = ownData(rawOptions, new Set([
      "store", "conversations", "parseCron", "nextCronAt", "randomUUID", "now",
      "setTimer", "clearTimer",
    ]), new Set(["store", "conversations"]));
    const storeMethods = [
      "list", "listAll", "create", "replace", "delete", "claimRun", "acceptRun",
      "finishRun", "bindConversation", "recoverRunning", "deleteBots",
    ];
    const conversationMethods = ["list", "create", "read", "send", "on", "removeListener"];
    if (!options.store || typeof options.store !== "object" || types.isProxy(options.store)
      || storeMethods.some((name) => typeof options.store[name] !== "function")
      || !options.conversations || typeof options.conversations !== "object"
      || types.isProxy(options.conversations)
      || conversationMethods.some((name) => typeof options.conversations[name] !== "function")
      || (options.parseCron !== undefined && typeof options.parseCron !== "function")
      || (options.nextCronAt !== undefined && typeof options.nextCronAt !== "function")
      || (options.randomUUID !== undefined && typeof options.randomUUID !== "function")
      || (options.now !== undefined && typeof options.now !== "function")
      || (options.setTimer !== undefined && typeof options.setTimer !== "function")
      || (options.clearTimer !== undefined && typeof options.clearTimer !== "function")
      || ((options.setTimer === undefined) !== (options.clearTimer === undefined))) fail(INVALID);
    this.#store = options.store;
    this.#conversations = options.conversations;
    this.#parseCron = options.parseCron || parseLocalCron;
    this.#nextCronAt = options.nextCronAt || nextLocalCronAt;
    this.#makeId = options.randomUUID || randomUUID;
    this.#now = options.now || Date.now;
    this.#setTimer = options.setTimer || setTimeout;
    this.#clearTimer = options.clearTimer || clearTimeout;
    this.#onConversationEvent = (event) => this.#acceptConversationEvent(event);
    this.#conversations.on("event", this.#onConversationEvent);
  }

  emit(eventName, ...args) {
    for (const listener of this.rawListeners(eventName)) {
      try { void Promise.resolve(listener.call(this, ...args)).catch(() => {}); } catch {}
    }
    return this.listenerCount(eventName) > 0;
  }

  async getAgentAutomations(rawRequest) {
    const request = ownData(rawRequest, ID_FIELDS);
    const botId = normalizedBotId(request.id);
    const token = this.#botToken(botId);
    this.#availableBot(botId, token);
    let records;
    try { records = await this.#store.list(botId); }
    catch (error) { throw sanitized(error); }
    this.#availableBot(botId, token);
    this.#rememberBot(botId, records);
    return this.#projectAutomations(records);
  }

  async listAllAutomations(rawRequest) {
    ownData(rawRequest, EMPTY_FIELDS);
    const disposeEpoch = this.#available();
    let records;
    try { records = await this.#store.listAll(); }
    catch (error) { throw sanitized(error); }
    this.#assertDisposeEpoch(disposeEpoch);
    const visible = records.filter((record) => !this.#deletedBots.has(record.botId));
    this.#rememberAll(visible);
    return frozenValue(visible.map((record) => ({
      agentId: record.botId,
      automation: automationProjection(record),
    })));
  }

  async createAgentAutomation(rawRequest) {
    const request = ownData(rawRequest, CREATE_FIELDS);
    const botId = normalizedBotId(request.id);
    const prepared = this.#prepareSpec(normalizedSpec(request.spec));
    const token = this.#botToken(botId);
    this.#availableBot(botId, token);
    return this.#queueBotMutation(botId, token, async () => {
      let records;
      try { records = await this.#store.create({ botId, automation: prepared }); }
      catch (error) { throw sanitized(error); }
      this.#availableBot(botId, token);
      const projected = this.#publishBot(botId, records, token);
      this.#rearmKnownSnapshot();
      await this.#scheduleArm().catch(() => {});
      this.#availableBot(botId, token);
      return projected;
    });
  }

  async updateAgentAutomation(rawRequest) {
    const request = ownData(rawRequest, UPDATE_FIELDS);
    const botId = normalizedBotId(request.id);
    const automationId = normalizedAutomationId(request.automationId);
    const prepared = this.#prepareSpec(normalizedSpec(request.spec));
    const token = this.#botToken(botId);
    this.#availableBot(botId, token);
    return this.#queueBotMutation(botId, token, async () => {
      const current = await this.#readOwned(botId, automationId, token);
      if (!current) return this.#projectAutomations(this.#snapshots.get(botId) || []);
      let records;
      try {
        records = await this.#store.replace({
          botId,
          automationId,
          expectedRevision: current.revision,
          automation: prepared,
        });
      } catch (error) { throw sanitized(error); }
      this.#availableBot(botId, token);
      this.#runBackoffs.delete(this.#runKey(botId, automationId));
      const projected = this.#publishBot(botId, records, token);
      this.#rearmKnownSnapshot();
      await this.#scheduleArm().catch(() => {});
      this.#availableBot(botId, token);
      return projected;
    });
  }

  async setAgentAutomationEnabled(rawRequest) {
    const request = ownData(rawRequest, ENABLE_FIELDS);
    const botId = normalizedBotId(request.id);
    const automationId = normalizedAutomationId(request.automationId);
    const isEnabled = normalizedBoolean(request.isEnabled);
    const token = this.#botToken(botId);
    this.#availableBot(botId, token);
    return this.#queueBotMutation(botId, token, async () => {
      const current = await this.#readOwned(botId, automationId, token);
      if (!current) return this.#projectAutomations(this.#snapshots.get(botId) || []);
      let nextRunAt = null;
      if (isEnabled) {
        let parsed;
        try { parsed = this.#parseCron(current.trigger.schedule); }
        catch (error) { throw sanitized(error, INVALID); }
        nextRunAt = this.#nextAt(parsed, this.#timestamp());
      }
      let records;
      try {
        records = await this.#store.replace({
          botId,
          automationId,
          expectedRevision: current.revision,
          automation: this.#configFromRecord(current, { isEnabled, nextRunAt }),
        });
      } catch (error) { throw sanitized(error); }
      this.#availableBot(botId, token);
      this.#runBackoffs.delete(this.#runKey(botId, automationId));
      const projected = this.#publishBot(botId, records, token);
      this.#rearmKnownSnapshot();
      await this.#scheduleArm().catch(() => {});
      this.#availableBot(botId, token);
      return projected;
    });
  }

  async deleteAgentAutomation(rawRequest) {
    const request = ownData(rawRequest, AUTOMATION_FIELDS);
    const botId = normalizedBotId(request.id);
    const automationId = normalizedAutomationId(request.automationId);
    const token = this.#botToken(botId);
    this.#availableBot(botId, token);
    const key = this.#runKey(botId, automationId);
    const priorDeleteCount = this.#routineDeletes.get(key) ?? 0;
    this.#routineDeletes.set(key, priorDeleteCount + 1);
    if (priorDeleteCount === 0) this.#rearmKnownSnapshot();
    let deleteCommitted = false;
    try {
      const active = this.#runClaims.get(key);
      if (active) this.#cancelContext(active);
      return await this.#queueBotMutation(botId, token, async () => {
        if (active) await active.promise.catch(() => {});
        this.#availableBot(botId, token);
        const current = await this.#readOwned(botId, automationId, token);
        if (!current) return this.#projectAutomations(this.#snapshots.get(botId) || []);
        let records;
        try {
          records = await this.#store.delete({
            botId,
            automationId,
            expectedRevision: current.revision,
          });
          deleteCommitted = true;
        } catch (error) { throw sanitized(error); }
        this.#availableBot(botId, token);
        this.#runBackoffs.delete(key);
        const projected = this.#publishBot(botId, records, token);
        this.#availableBot(botId, token);
        return projected;
      });
    } finally {
      const remaining = (this.#routineDeletes.get(key) ?? 1) - 1;
      if (remaining === 0) this.#routineDeletes.delete(key);
      else this.#routineDeletes.set(key, remaining);
      if (remaining === 0) {
        let authoritative = true;
        try { await this.#scheduleArm(); } catch { authoritative = false; }
        if (!authoritative && !deleteCommitted) this.#rearmKnownSnapshot();
      }
    }
  }

  runAgentAutomationNow(rawRequest) {
    const request = ownData(rawRequest, AUTOMATION_FIELDS);
    const botId = normalizedBotId(request.id);
    const automationId = normalizedAutomationId(request.automationId);
    const token = this.#botToken(botId);
    this.#availableBot(botId, token);
    return this.#launchRun({ botId, automationId, trigger: "manual" }).terminal;
  }

  start() {
    this.#available();
    if (this.#startPromise) return this.#startPromise;
    const admitted = deferred();
    this.#startPromise = admitted.promise;
    const disposeEpoch = this.#disposeEpoch;
    const operation = (async () => {
      let records;
      try { records = await this.#store.recoverRunning({ finishedAt: this.#timestamp() }); }
      catch (error) { throw sanitized(error); }
      this.#assertDisposeEpoch(disposeEpoch);
      this.#rememberAll(records);
      for (const [botId, botRecords] of this.#groupRecords(records)) {
        if (!this.#deletedBots.has(botId)) this.#publishBot(botId, botRecords, this.#botToken(botId));
      }
      this.#started = true;
      const now = this.#timestamp();
      const due = records.filter((record) => {
        const candidate = this.#scheduleCandidate(record, now);
        return candidate !== null && candidate.delay === 0;
      });
      if (due.length === 0) {
        await this.#scheduleArm({ retryOnEmptyFailure: false });
      } else {
        for (const record of due) {
          this.#launchRun({ botId: record.botId, automationId: record.id, trigger: "schedule" });
        }
      }
    })();
    void operation.then(admitted.resolve, (error) => {
      if (this.#startPromise === admitted.promise) this.#startPromise = null;
      admitted.reject(error);
    });
    return admitted.promise;
  }

  deleteBots(rawRequest) {
    const request = ownData(rawRequest, DELETE_BOTS_FIELDS);
    const botIds = denseArray(request.botIds, MAX_BOT_IDS).map(normalizedBotId);
    if (new Set(botIds).size !== botIds.length) fail(INVALID);
    this.#available();
    const operationKey = botIds.join("\0");
    const existing = this.#deleteOperations.get(operationKey);
    if (existing) return existing;
    const admitted = deferred();
    this.#deleteOperations.set(operationKey, admitted.promise);
    try {
      for (const botId of botIds) {
        if (this.#deletedBots.has(botId)) continue;
        this.#deletedBots.add(botId);
        this.#botEpochs.set(botId, (this.#botEpochs.get(botId) ?? 0) + 1);
      }
      for (const botId of botIds) {
        this.#snapshots.delete(botId);
        for (const key of this.#runBackoffs.keys()) {
          if (key.startsWith(`${botId}\0`)) this.#runBackoffs.delete(key);
        }
      }
      this.#rearmKnownSnapshot();
      const mutationTails = botIds
        .map((botId) => this.#botMutationTails.get(botId))
        .filter((tail) => tail !== undefined);
      const operation = (async () => {
        const active = [...this.#runClaims.values()]
          .filter((context) => botIds.includes(context.botId));
        for (const context of active) this.#cancelContext(context);
        await Promise.all(active.map((context) => context.promise.catch(() => {})));
        await Promise.all(mutationTails);
        let result;
        try { result = await this.#store.deleteBots({ botIds }); }
        catch (error) { throw sanitized(error); }
        await this.#scheduleArm().catch(() => {});
        return result;
      })();
      void operation.then(admitted.resolve, (error) => {
        this.#deleteOperations.delete(operationKey);
        admitted.reject(error);
      });
    } catch (error) {
      this.#deleteOperations.delete(operationKey);
      admitted.reject(sanitized(error));
    }
    return admitted.promise;
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    const completion = deferred();
    this.#disposePromise = completion.promise;
    this.#disposed = true;
    this.#disposeEpoch += 1;
    this.#started = false;
    this.#armEpoch += 1;
    const active = [...this.#runClaims.values()];
    const mutationTails = [...this.#botMutationTails.values()];
    const deleteOperations = [...this.#deleteOperations.values()];
    const startOperation = this.#startPromise;
    for (const context of active) this.#cancelContext(context);
    this.#clearArmedTimer();
    try { this.#conversations.removeListener("event", this.#onConversationEvent); } catch {}
    const admitted = [
      ...active.map((context) => context.promise),
      ...mutationTails,
      ...deleteOperations,
      ...(startOperation ? [startOperation] : []),
    ];
    void Promise.all(admitted.map((operation) => operation.catch(() => {}))).then(() => {
      try {
        this.#terminalBuffer.clear();
        this.#settledTerminalKeys.clear();
        this.#runBackoffs.clear();
        this.#armReadFailures = 0;
        this.removeAllListeners();
        completion.resolve();
      } catch (error) { completion.reject(sanitized(error)); }
    }, (error) => completion.reject(sanitized(error)));
    return completion.promise;
  }

  #available() {
    if (this.#disposed) throw new LocalAutomationControllerError(FAILED);
    return this.#disposeEpoch;
  }

  #assertDisposeEpoch(epoch) {
    if (this.#disposed || this.#disposeEpoch !== epoch) throw new LocalAutomationControllerError(FAILED);
  }

  #botToken(botId) {
    return Object.freeze({
      botId,
      botEpoch: this.#botEpochs.get(botId) ?? 0,
      disposeEpoch: this.#disposeEpoch,
    });
  }

  #availableBot(botId, token) {
    this.#assertDisposeEpoch(token.disposeEpoch);
    if (token.botId !== botId || this.#deletedBots.has(botId)
      || (this.#botEpochs.get(botId) ?? 0) !== token.botEpoch) {
      throw new LocalAutomationControllerError(FAILED);
    }
  }

  #contextCurrent(context) {
    return !context.cancelled && !this.#disposed
      && context.disposeEpoch === this.#disposeEpoch
      && !this.#deletedBots.has(context.botId)
      && (this.#botEpochs.get(context.botId) ?? 0) === context.botEpoch
      && !this.#routineDeletes.has(context.key);
  }

  #timestamp() {
    let value;
    try { value = this.#now(); } catch { fail(FAILED); }
    if (!Number.isSafeInteger(value) || value < 0) fail(FAILED);
    return value;
  }

  #newRunId() {
    let value;
    try { value = this.#makeId(); } catch { fail(FAILED); }
    if (typeof value !== "string" || !UUID.test(value)) fail(FAILED);
    return value;
  }

  #nextAt(schedule, after) {
    let value;
    try { value = this.#nextCronAt(schedule, after); }
    catch (error) { throw sanitized(error, INVALID); }
    if (!Number.isSafeInteger(value) || value <= after) fail(INVALID);
    return value;
  }

  #prepareSpec(spec) {
    let schedule;
    try { schedule = this.#parseCron(spec.schedule); }
    catch (error) { throw sanitized(error, INVALID); }
    const normalized = schedule?.normalized;
    if (typeof normalized !== "string" || normalized.length === 0) fail(INVALID);
    return frozenValue({
      name: spec.name,
      prompt: spec.prompt,
      trigger: { type: "cron", schedule: normalized },
      triggerDescription: describeSchedule(schedule),
      isEnabled: spec.isEnabled,
      nextRunAt: spec.isEnabled ? this.#nextAt(schedule, this.#timestamp()) : null,
    });
  }

  #configFromRecord(record, overrides = {}) {
    return frozenValue({
      name: record.name,
      prompt: record.prompt,
      trigger: { type: "cron", schedule: record.trigger.schedule },
      triggerDescription: record.triggerDescription,
      isEnabled: overrides.isEnabled ?? record.isEnabled,
      nextRunAt: Object.hasOwn(overrides, "nextRunAt") ? overrides.nextRunAt : record.nextRunAt,
    });
  }

  async #readOwned(botId, automationId, token) {
    let records;
    try { records = await this.#store.list(botId); }
    catch (error) { throw sanitized(error); }
    this.#availableBot(botId, token);
    this.#rememberBot(botId, records);
    return records.find((record) => record.id === automationId) || null;
  }

  #rememberBot(botId, records) {
    this.#snapshots.set(botId, sortAutomations(records));
  }

  #rememberAll(records) {
    const groups = this.#groupRecords(records);
    for (const botId of this.#snapshots.keys()) {
      if (!groups.has(botId) && !this.#deletedBots.has(botId)) this.#snapshots.set(botId, []);
    }
    for (const [botId, botRecords] of groups) this.#rememberBot(botId, botRecords);
  }

  #groupRecords(records) {
    const groups = new Map();
    for (const record of records) {
      const current = groups.get(record.botId) || [];
      current.push(record);
      groups.set(record.botId, current);
    }
    return groups;
  }

  #mergeAutomation(record) {
    const records = [...(this.#snapshots.get(record.botId) || [])];
    const index = records.findIndex((candidate) => candidate.id === record.id);
    if (index < 0) records.push(record);
    else records[index] = record;
    this.#rememberBot(record.botId, records);
    return this.#snapshots.get(record.botId);
  }

  #projectAutomations(records) {
    return Object.freeze(sortAutomations(records).map(automationProjection));
  }

  #publishBot(botId, records, token) {
    if (this.#disposed || this.#deletedBots.has(botId)
      || (token && ((this.#botEpochs.get(botId) ?? 0) !== token.botEpoch
        || token.disposeEpoch !== this.#disposeEpoch))) return this.#projectAutomations(records);
    this.#rememberBot(botId, records);
    const automations = this.#projectAutomations(records);
    const workflows = Object.freeze(sortAutomations(records).map(workflowProjection));
    this.emit("changed", frozenValue({ agentId: botId, automations, workflows }));
    return automations;
  }

  #publishAutomation(record, context) {
    const records = this.#mergeAutomation(record);
    if (this.#contextCurrent(context)) this.#publishBot(record.botId, records, context);
  }

  #runKey(botId, automationId) { return `${botId}\0${automationId}`; }

  #recordRunBackoff(key) {
    const previous = this.#runBackoffs.get(key);
    const attempts = Math.min(64, (previous?.attempts ?? 0) + 1);
    const multiplier = 2 ** Math.min(30, attempts - 1);
    const delay = Math.min(RUN_RETRY_MAX_DELAY, RUN_RETRY_BASE_DELAY * multiplier);
    const now = this.#timestamp();
    const saturated = delay > Number.MAX_SAFE_INTEGER - now;
    const retryAt = saturated ? Number.MAX_SAFE_INTEGER : now + delay;
    this.#runBackoffs.set(key, Object.freeze({
      attempts,
      retryAt,
      minimumDelay: saturated ? delay : 0,
      ready: !saturated,
    }));
  }

  #scheduleCandidate(record, now) {
    if (!record.isEnabled || record.nextRunAt === null
      || this.#deletedBots.has(record.botId)
      || this.#routineDeletes.has(this.#runKey(record.botId, record.id))) return null;
    const key = this.#runKey(record.botId, record.id);
    const backoff = this.#runBackoffs.get(key) || null;
    const scheduledAt = backoff ? Math.max(record.nextRunAt, backoff.retryAt) : record.nextRunAt;
    const absoluteDelay = Math.max(0, scheduledAt - now);
    const minimumDelay = backoff && !backoff.ready ? backoff.minimumDelay : 0;
    return {
      record,
      key,
      backoff,
      scheduledAt,
      delay: Math.max(absoluteDelay, minimumDelay),
    };
  }

  #knownRecords() {
    const records = [];
    for (const botRecords of this.#snapshots.values()) records.push(...botRecords);
    return records;
  }

  #queueBotMutation(botId, token, operation) {
    const previous = this.#botMutationTails.get(botId) || Promise.resolve();
    const result = previous.then(
      () => {
        this.#availableBot(botId, token);
        return operation();
      },
      () => {
        this.#availableBot(botId, token);
        return operation();
      },
    );
    const tail = result.then(() => undefined, () => undefined);
    this.#botMutationTails.set(botId, tail);
    void tail.then(() => {
      if (this.#botMutationTails.get(botId) === tail) this.#botMutationTails.delete(botId);
    });
    return result;
  }

  #launchRun({ botId, automationId, trigger }) {
    const key = this.#runKey(botId, automationId);
    const existing = this.#runClaims.get(key);
    if (existing) {
      const armed = trigger === "schedule"
        ? existing.armed.promise.then(async () => {
          try {
            await this.#advanceCoalescedSchedule(existing);
            if (this.#runBackoffs.delete(key)) this.#rearmKnownSnapshot();
          } catch (error) {
            if (error === ADVANCE_EXHAUSTED && this.#contextCurrent(existing)) {
              this.#recordRunBackoff(key);
            }
            throw error;
          }
        })
        : Promise.resolve();
      void armed.catch(() => { void this.#scheduleArm().catch(() => {}); });
      return { terminal: existing.promise, armed };
    }
    if (this.#disposed || this.#deletedBots.has(botId) || this.#routineDeletes.has(key)) {
      return { terminal: Promise.resolve(), armed: Promise.resolve() };
    }
    const cancelled = deferred();
    const armed = deferred();
    const terminal = deferred();
    const context = {
      key,
      botId,
      automationId,
      trigger,
      botEpoch: this.#botEpochs.get(botId) ?? 0,
      disposeEpoch: this.#disposeEpoch,
      cancelled: false,
      cancel: cancelled,
      armed,
      terminal,
      terminalEvent: deferred(),
      identity: null,
      acceptPair: null,
      promise: terminal.promise,
    };
    this.#runClaims.set(key, context);
    const operation = this.#performRun(context);
    const observed = trigger === "schedule" ? operation.catch(() => undefined) : operation;
    void observed.then(terminal.resolve, terminal.reject);
    const cleanup = () => {
      armed.resolve();
      if (this.#runClaims.get(key) === context) this.#runClaims.delete(key);
      void this.#scheduleArm().catch(() => {});
    };
    void context.promise.then(cleanup, cleanup);
    return { terminal: context.promise, armed: armed.promise };
  }

  #cancelContext(context) {
    if (context.cancelled) return;
    context.cancelled = true;
    context.cancel.resolve(CANCELLED);
    context.terminalEvent.resolve(CANCELLED);
  }

  async #external(context, operation) {
    const outcome = Promise.resolve().then(operation).then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
    const result = await Promise.race([
      outcome,
      context.cancel.promise.then(() => ({ kind: "cancelled" })),
    ]);
    if (result.kind === "cancelled") return CANCELLED;
    if (result.kind === "error") throw result.error;
    return result.value;
  }

  async #performRun(context) {
    let claimed = false;
    let runId = null;
    let current = null;
    let capturedPrompt = null;
    try {
      let records = await this.#store.list(context.botId);
      if (!this.#contextCurrent(context)) return undefined;
      this.#rememberBot(context.botId, records);
      current = records.find((record) => record.id === context.automationId) || null;
      if (!current) return undefined;
      const now = this.#timestamp();
      if (context.trigger === "schedule"
        && (!current.isEnabled || current.nextRunAt === null || current.nextRunAt > now)) return undefined;
      let nextRunAt = current.nextRunAt;
      if (context.trigger === "schedule") {
        const parsed = this.#parseCron(current.trigger.schedule);
        nextRunAt = this.#nextAt(parsed, now);
      }
      runId = this.#newRunId();
      const claim = await this.#store.claimRun({
        botId: context.botId,
        automationId: context.automationId,
        expectedRevision: current.revision,
        run: {
          id: runId,
          trigger: context.trigger,
          startedAt: now,
          finishedAt: null,
          status: "running",
        },
        nextRunAt,
      });
      if (!this.#contextCurrent(context)) return undefined;
      if (!claim.claimed) {
        if (context.trigger === "schedule") {
          await this.#advanceCoalescedSchedule(context);
          if (this.#runBackoffs.delete(context.key)) this.#rearmKnownSnapshot();
        }
        return undefined;
      }
      claimed = true;
      if (context.trigger === "schedule") this.#runBackoffs.delete(context.key);
      current = claim.automation;
      capturedPrompt = current.prompt;
      this.#publishAutomation(current, context);
      await this.#scheduleArm().catch(() => {});
      context.armed.resolve();
      if (!this.#contextCurrent(context)) return undefined;

      const conversation = await this.#conversationFor(context, current);
      if (conversation === CANCELLED || !this.#contextCurrent(context)) return undefined;
      current = conversation.automation;
      context.acceptPair = conversationPairKey(context.botId, conversation.conversationId);
      let accepted;
      try {
        accepted = await this.#external(context, () => this.#conversations.send({
          botId: context.botId,
          conversationId: conversation.conversationId,
          text: capturedPrompt,
        }));
      } catch (error) {
        this.#discardBufferedPair(context.acceptPair);
        context.acceptPair = null;
        throw error;
      }
      if (accepted === CANCELLED || !this.#contextCurrent(context)) return undefined;
      const identity = this.#acceptedIdentity(accepted, context.botId, conversation.conversationId);
      context.identity = identity;
      context.acceptPair = null;
      const buffered = this.#terminalBuffer.get(terminalKey(identity));
      if (buffered) {
        this.#terminalBuffer.delete(terminalKey(identity));
        context.terminalEvent.resolve(buffered);
      }
      current = await this.#store.acceptRun({
        botId: context.botId,
        automationId: context.automationId,
        runId,
        invocationId: identity.invocationId,
        conversationId: identity.conversationId,
      });
      if (!this.#contextCurrent(context)) return undefined;
      this.#publishAutomation(current, context);

      const terminalEvent = await Promise.race([
        context.terminalEvent.promise,
        context.cancel.promise.then(() => CANCELLED),
      ]);
      if (terminalEvent === CANCELLED || !this.#contextCurrent(context)) return undefined;
      current = await this.#store.finishRun({
        botId: context.botId,
        automationId: context.automationId,
        runId,
        finishedAt: this.#timestamp(),
        status: terminalEvent.type === "completed" ? "ok" : "error",
        detail: terminalEvent.type === "completed" ? undefined : RUN_FAILURE_DETAIL,
        errorKind: terminalEvent.type === "completed" ? undefined : terminalErrorKind(terminalEvent),
      });
      if (!this.#contextCurrent(context)) return undefined;
      this.#markTerminalSettled(identity);
      this.#publishAutomation(current, context);
      return undefined;
    } catch (error) {
      context.armed.resolve();
      if (!claimed) {
        if (context.trigger === "schedule" && this.#contextCurrent(context)) {
          this.#recordRunBackoff(context.key);
        }
        throw sanitized(error);
      }
      if (!this.#contextCurrent(context)) return undefined;
      let finished;
      try {
        finished = await this.#store.finishRun({
          botId: context.botId,
          automationId: context.automationId,
          runId,
          finishedAt: this.#timestamp(),
          status: "error",
          detail: RUN_FAILURE_DETAIL,
          errorKind: operationErrorKind(error),
        });
      } catch (finishError) { throw sanitized(finishError); }
      if (this.#contextCurrent(context)) this.#publishAutomation(finished, context);
      return undefined;
    } finally {
      context.armed.resolve();
    }
  }

  async #conversationFor(context, automation) {
    let conversationId = automation.conversationId;
    if (conversationId !== null) {
      let readFailure = null;
      try {
        const read = await this.#external(context, () => this.#conversations.read({
          botId: context.botId,
          conversationId,
        }));
        if (read === CANCELLED) return CANCELLED;
        const record = dataRecord(read);
        if (!record || record.botId !== context.botId || record.conversationId !== conversationId) {
          readFailure = new LocalAutomationControllerError(FAILED);
        }
      } catch (error) {
        readFailure = error;
      }
      if (readFailure) {
        const listed = await this.#external(context, () => this.#conversations.list(context.botId));
        if (listed === CANCELLED) return CANCELLED;
        if (!Array.isArray(listed) || types.isProxy(listed)) fail(FAILED);
        let stillExists = false;
        for (const entry of listed) {
          const record = dataRecord(entry);
          if (!record) fail(FAILED);
          if (record.botId === context.botId && record.conversationId === conversationId) {
            stillExists = true;
          }
        }
        if (stillExists) throw readFailure;
        conversationId = null;
      }
    }
    if (conversationId !== null) return { conversationId, automation };
    const created = await this.#external(context, () => this.#conversations.create({ botId: context.botId }));
    if (created === CANCELLED) return CANCELLED;
    const record = dataRecord(created);
    if (!record || record.botId !== context.botId || typeof record.conversationId !== "string"
      || !CONVERSATION_ID.test(record.conversationId)) fail(FAILED);
    conversationId = record.conversationId;
    let bound = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!this.#contextCurrent(context)) return CANCELLED;
      const records = await this.#store.list(context.botId);
      const latest = records.find((candidate) => candidate.id === context.automationId);
      if (!latest) return CANCELLED;
      try {
        bound = await this.#store.bindConversation({
          botId: context.botId,
          automationId: context.automationId,
          expectedRevision: latest.revision,
          conversationId,
        });
        break;
      } catch {
        if (attempt === 2) fail(FAILED);
      }
    }
    if (!this.#contextCurrent(context)) return CANCELLED;
    this.#publishAutomation(bound, context);
    return { conversationId, automation: bound };
  }

  #acceptedIdentity(value, botId, conversationId) {
    const record = dataRecord(value);
    if (!record || record.botId !== botId || record.conversationId !== conversationId
      || typeof record.invocationId !== "string" || !INVOCATION_ID.test(record.invocationId)
      || !Number.isSafeInteger(record.generation) || record.generation < 0
      || record.status !== "streaming") fail(FAILED);
    return Object.freeze({
      botId,
      conversationId,
      invocationId: record.invocationId,
      generation: record.generation,
    });
  }

  #acceptConversationEvent(rawEvent) {
    if (this.#disposed) return;
    const event = normalizedTerminalEvent(rawEvent);
    if (!event) return;
    const key = terminalKey(event);
    if (this.#settledTerminalKeys.has(key)) return;
    for (const context of this.#runClaims.values()) {
      if (!this.#contextCurrent(context) || !context.identity) continue;
      if (terminalKey(context.identity) === key) {
        context.terminalEvent.resolve(event);
        return;
      }
    }
    const pair = conversationPairKey(event.botId, event.conversationId);
    const awaitingAcceptance = [...this.#runClaims.values()]
      .some((context) => this.#contextCurrent(context) && context.acceptPair === pair);
    if (!awaitingAcceptance) return;
    this.#terminalBuffer.set(key, event);
    while (this.#terminalBuffer.size > MAX_TERMINAL_BUFFER) {
      this.#terminalBuffer.delete(this.#terminalBuffer.keys().next().value);
    }
  }

  #discardBufferedPair(pair) {
    if (!pair) return;
    for (const [key, event] of this.#terminalBuffer) {
      if (conversationPairKey(event.botId, event.conversationId) === pair) {
        this.#terminalBuffer.delete(key);
      }
    }
  }

  #markTerminalSettled(identity) {
    const key = terminalKey(identity);
    this.#settledTerminalKeys.add(key);
    while (this.#settledTerminalKeys.size > MAX_TERMINAL_BUFFER) {
      this.#settledTerminalKeys.delete(this.#settledTerminalKeys.values().next().value);
    }
  }

  async #advanceCoalescedSchedule(context) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!this.#contextCurrent(context)) return;
      let records;
      try { records = await this.#store.list(context.botId); }
      catch { continue; }
      if (!this.#contextCurrent(context)) return;
      this.#rememberBot(context.botId, records);
      const current = records.find((record) => record.id === context.automationId);
      const now = this.#timestamp();
      if (!current || !current.isEnabled || current.nextRunAt === null || current.nextRunAt > now) {
        await this.#scheduleArm().catch(() => {});
        return;
      }
      let nextRunAt;
      try { nextRunAt = this.#nextAt(this.#parseCron(current.trigger.schedule), now); }
      catch { continue; }
      try {
        records = await this.#store.replace({
          botId: context.botId,
          automationId: context.automationId,
          expectedRevision: current.revision,
          automation: this.#configFromRecord(current, { nextRunAt }),
        });
      } catch { continue; }
      if (this.#contextCurrent(context)) {
        this.#publishBot(context.botId, records, context);
        this.#rearmKnownSnapshot();
      }
      await this.#scheduleArm().catch(() => {});
      return;
    }
    throw ADVANCE_EXHAUSTED;
  }

  #clearArmedTimer() {
    const current = this.#timer;
    this.#timer = null;
    if (!current) return;
    try { this.#clearTimer(current.token); } catch {}
  }

  #armRecords(records, armEpoch) {
    if (this.#disposed || !this.#started || armEpoch !== this.#armEpoch) return;
    const now = this.#timestamp();
    const next = records.map((record) => this.#scheduleCandidate(record, now))
      .filter((entry) => entry !== null)
      .sort((left, right) => left.delay - right.delay
        || left.scheduledAt - right.scheduledAt
        || left.record.createdAt - right.record.createdAt
        || left.record.id.localeCompare(right.record.id)
        || left.record.botId.localeCompare(right.record.botId))[0];
    if (!next) {
      this.#clearArmedTimer();
      return;
    }
    const delay = Math.min(MAX_TIMER_DELAY, next.delay);
    const replacement = {
      token: null,
      armEpoch,
      kind: "schedule",
      backoffRelease: next.backoff && !next.backoff.ready
        ? { key: next.key, backoff: next.backoff }
        : null,
    };
    try { replacement.token = this.#setTimer(() => this.#fireTimer(replacement), delay); }
    catch { return; }
    if (this.#disposed || armEpoch !== this.#armEpoch) {
      try { this.#clearTimer(replacement.token); } catch {}
      return;
    }
    const previous = this.#timer;
    this.#timer = replacement;
    if (previous && previous.token !== replacement.token) {
      try { this.#clearTimer(previous.token); } catch {}
    }
    if (this.#timer !== replacement) return;
    if (this.#disposed || !this.#started) {
      this.#clearArmedTimer();
      return;
    }
    if (armEpoch !== this.#armEpoch) return;
  }

  #rearmKnownSnapshot() {
    this.#armEpoch += 1;
    const armEpoch = this.#armEpoch;
    if (!this.#started || this.#disposed) return;
    try { this.#armRecords(this.#knownRecords(), armEpoch); } catch {}
  }

  #scheduleArm({ retryOnEmptyFailure = true } = {}) {
    this.#armEpoch += 1;
    const armEpoch = this.#armEpoch;
    if (!this.#started || this.#disposed) return Promise.resolve();
    const operation = (async () => {
      let records;
      try { records = await this.#store.listAll(); }
      catch (error) {
        const failure = sanitized(error);
        if (retryOnEmptyFailure && !this.#timer && !this.#disposed && this.#started
          && armEpoch === this.#armEpoch) {
          const attempts = Math.min(64, this.#armReadFailures + 1);
          const multiplier = 2 ** Math.min(30, attempts - 1);
          const delay = Math.min(ARM_RETRY_MAX_DELAY, ARM_RETRY_BASE_DELAY * multiplier);
          this.#armReadFailures = attempts;
          this.#installArmRetry(armEpoch, delay);
        }
        throw failure;
      }
      if (this.#disposed || !this.#started || armEpoch !== this.#armEpoch) return;
      this.#armReadFailures = 0;
      const visible = records.filter((record) => !this.#deletedBots.has(record.botId));
      this.#rememberAll(visible);
      this.#armRecords(visible, armEpoch);
    })();
    void operation.catch(() => {});
    return operation;
  }

  #installArmRetry(armEpoch, delay) {
    if (this.#disposed || !this.#started || this.#timer || armEpoch !== this.#armEpoch) return;
    const retry = { token: null, armEpoch, kind: "retry" };
    try { retry.token = this.#setTimer(() => this.#fireArmRetry(retry), delay); }
    catch { return; }
    if (this.#disposed || !this.#started || this.#timer || armEpoch !== this.#armEpoch) {
      try { this.#clearTimer(retry.token); } catch {}
      return;
    }
    this.#timer = retry;
  }

  async #fireArmRetry(retry) {
    if (this.#disposed || !this.#started || this.#timer !== retry) return;
    this.#timer = null;
    await this.#scheduleArm().catch(() => {});
  }

  async #fireTimer(timer) {
    if (this.#disposed || !this.#started || this.#timer !== timer) return;
    const release = timer.backoffRelease;
    if (release && this.#runBackoffs.get(release.key) === release.backoff) {
      this.#runBackoffs.set(release.key, Object.freeze({ ...release.backoff, ready: true }));
    }
    this.#timer = null;
    let records;
    try { records = await this.#store.listAll(); }
    catch {
      await this.#scheduleArm().catch(() => {});
      return;
    }
    if (this.#disposed || this.#timer !== null) return;
    this.#armReadFailures = 0;
    const now = this.#timestamp();
    const due = records.filter((record) => {
      const candidate = this.#scheduleCandidate(record, now);
      return candidate !== null && candidate.delay === 0;
    });
    if (due.length === 0) {
      await this.#scheduleArm().catch(() => {});
      return;
    }
    const launched = due.map((record) => this.#launchRun({
      botId: record.botId,
      automationId: record.id,
      trigger: "schedule",
    }));
    await Promise.all(launched.map((entry) => entry.armed.catch(() => {})));
  }
}

module.exports = {
  LocalAutomationController,
  LocalAutomationControllerError,
};
