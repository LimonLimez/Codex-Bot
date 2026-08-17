"use strict";

const path = require("node:path");
const { types } = require("node:util");

const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROFILE_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DELETION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LIVE_DELETE_BOTS = 256;
const MAX_STORE_BOTS = 4_096;
const MAX_CLEANUP_IDS = MAX_STORE_BOTS * 3;
const MAX_RECEIPTS = MAX_STORE_BOTS;
const RECEIPT_FIELDS = new Set([
  "deletionId", "createdAt", "botIds", "remoteRuntimes", "localProfiles",
]);
const REMOTE_FIELDS = new Set(["botId", "runtimeId"]);
const PROFILE_FIELDS = new Set(["botId", "profileId"]);
const OUTCOME_FIELDS = new Set(["deletedBotIds", "survivingBotIds", "activeBotId"]);

class BotDeletionCoordinatorError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BotDeletionCoordinatorError";
    this.code = code;
  }
}

function coordinatorError(message, code = "OPENBOT_BOT_DELETE_FAILED") {
  return new BotDeletionCoordinatorError(message, code);
}

function invalid() {
  return coordinatorError("Bot deletion request is invalid.", "OPENBOT_BOT_DELETE_INVALID");
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) throw invalid();
  return value;
}

function ownValues(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalid();
  }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.length !== fields.size
    || keys.some((key) => typeof key !== "string" || !fields.has(key)
      || !Object.hasOwn(descriptors[key], "value"))) {
    throw invalid();
  }
  return Object.fromEntries([...fields].map((field) => [field, descriptors[field].value]));
}

function denseArray(value, maximum, normalize) {
  if (!Array.isArray(value) || types.isProxy(value)) throw invalid();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { throw invalid(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum
    || Reflect.ownKeys(descriptors).length !== length + 1) throw invalid();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw invalid();
    result.push(normalize(descriptor.value, index));
  }
  return result;
}

function normalizeBotIds(value, {
  allowEmpty = false,
  maximum = MAX_LIVE_DELETE_BOTS,
} = {}) {
  const botIds = denseArray(value, maximum, normalizeBotId);
  if ((!allowEmpty && botIds.length === 0) || new Set(botIds).size !== botIds.length) throw invalid();
  return Object.freeze(botIds);
}

function exactSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function normalizeReceipt(value) {
  const input = ownValues(value, RECEIPT_FIELDS);
  if (typeof input.deletionId !== "string" || !DELETION_ID.test(input.deletionId)
    || typeof input.createdAt !== "string" || !Number.isFinite(Date.parse(input.createdAt))) throw invalid();
  const botIds = normalizeBotIds(input.botIds, { maximum: MAX_STORE_BOTS });
  const members = new Set(botIds);
  const remoteRuntimes = denseArray(input.remoteRuntimes, MAX_CLEANUP_IDS, (entry) => {
    const remote = ownValues(entry, REMOTE_FIELDS);
    const botId = normalizeBotId(remote.botId);
    if (!members.has(botId) || typeof remote.runtimeId !== "string"
      || remote.runtimeId.length < 1 || remote.runtimeId.length > 512
      || /[\u0000-\u001f\u007f]/.test(remote.runtimeId)) throw invalid();
    return Object.freeze({ botId, runtimeId: remote.runtimeId });
  });
  if (new Set(remoteRuntimes.map((entry) => entry.runtimeId)).size !== remoteRuntimes.length) throw invalid();
  const localProfiles = denseArray(input.localProfiles, botIds.length, (entry) => {
    const profile = ownValues(entry, PROFILE_FIELDS);
    const botId = normalizeBotId(profile.botId);
    if (!members.has(botId) || typeof profile.profileId !== "string"
      || !PROFILE_ID.test(profile.profileId)) throw invalid();
    return Object.freeze({ botId, profileId: profile.profileId });
  });
  if (new Set(localProfiles.map((entry) => entry.botId)).size !== localProfiles.length
    || new Set(localProfiles.map((entry) => entry.profileId)).size !== localProfiles.length) throw invalid();
  return Object.freeze({
    deletionId: input.deletionId,
    createdAt: new Date(Date.parse(input.createdAt)).toISOString(),
    botIds,
    remoteRuntimes: Object.freeze(remoteRuntimes),
    localProfiles: Object.freeze(localProfiles),
  });
}

function normalizeReceipts(value) {
  const receipts = denseArray(value, MAX_RECEIPTS, normalizeReceipt);
  if (new Set(receipts.map((entry) => entry.deletionId)).size !== receipts.length) throw invalid();
  const botIds = new Set();
  const runtimeIds = new Set();
  const profileIds = new Set();
  let cleanupIds = 0;
  for (const receipt of receipts) {
    for (const botId of receipt.botIds) {
      if (botIds.has(botId)) throw invalid();
      botIds.add(botId);
    }
    for (const entry of receipt.remoteRuntimes) {
      if (runtimeIds.has(entry.runtimeId)) throw invalid();
      runtimeIds.add(entry.runtimeId);
    }
    for (const entry of receipt.localProfiles) {
      if (profileIds.has(entry.profileId)) throw invalid();
      profileIds.add(entry.profileId);
    }
    cleanupIds += receipt.botIds.length
      + receipt.remoteRuntimes.length
      + receipt.localProfiles.length;
    if (cleanupIds > MAX_CLEANUP_IDS) throw invalid();
  }
  return receipts;
}

function normalizeOutcome(value, expectedBotIds) {
  const input = ownValues(value, OUTCOME_FIELDS);
  const deletedBotIds = normalizeBotIds(input.deletedBotIds);
  const survivingBotIds = normalizeBotIds(input.survivingBotIds, {
    allowEmpty: true,
    maximum: MAX_STORE_BOTS,
  });
  const activeBotId = input.activeBotId === null ? null : normalizeBotId(input.activeBotId);
  if (!exactSet(deletedBotIds, expectedBotIds)
    || deletedBotIds.some((botId) => survivingBotIds.includes(botId))
    || (activeBotId !== null && !survivingBotIds.includes(activeBotId))) throw invalid();
  return Object.freeze({ deletedBotIds, survivingBotIds, activeBotId });
}

function survivorBotIds(value) {
  const records = denseArray(value, MAX_STORE_BOTS, (record) => {
    if (!record || typeof record !== "object" || Array.isArray(record) || types.isProxy(record)) throw invalid();
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(record, "botId"); } catch { throw invalid(); }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw invalid();
    return normalizeBotId(descriptor.value);
  });
  if (new Set(records).size !== records.length) throw invalid();
  return records;
}

function summary(completedDeletionIds, pendingDeletionIds) {
  return Object.freeze({
    completedDeletionIds: Object.freeze([...completedDeletionIds]),
    pendingDeletionIds: Object.freeze([...pendingDeletionIds]),
  });
}

function batches(values, size = MAX_LIVE_DELETE_BOTS) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

class BotDeletionCoordinator {
  #botRuntimeController;
  #botStore;
  #conversationController;
  #computerTargetRouter;
  #computerBoundary;
  #modelSelectionStore;
  #conversationBindingsFile;
  #deleteConversationBindings;
  #liveOperations = new Map();
  #botClaims = new Map();
  #cleanupOperations = new Map();
  #coordinationTail = Promise.resolve();
  #reconcilePromise = null;
  #disposePromise = null;
  #disposed = false;

  constructor({
    botRuntimeController,
    botStore,
    conversationController,
    computerTargetRouter,
    computerBoundary,
    modelSelectionStore,
    conversationBindingsFile,
    deleteConversationBindings,
  } = {}) {
    if (!botRuntimeController || typeof botRuntimeController.deleteBots !== "function"
      || !botStore || typeof botStore.list !== "function"
      || typeof botStore.listPendingDeletions !== "function"
      || typeof botStore.completeDeletion !== "function"
      || !conversationController || typeof conversationController.deleteBots !== "function"
      || !computerTargetRouter || typeof computerTargetRouter.deleteBot !== "function"
      || !computerBoundary || typeof computerBoundary.deleteBot !== "function"
      || !modelSelectionStore || typeof modelSelectionStore.deleteBots !== "function"
      || typeof modelSelectionStore.readActiveBotId !== "function"
      || typeof conversationBindingsFile !== "string" || !path.isAbsolute(conversationBindingsFile)
      || conversationBindingsFile.includes("\0")
      || typeof deleteConversationBindings !== "function") {
      throw new TypeError("Bot deletion coordinator dependencies are invalid.");
    }
    this.#botRuntimeController = botRuntimeController;
    this.#botStore = botStore;
    this.#conversationController = conversationController;
    this.#computerTargetRouter = computerTargetRouter;
    this.#computerBoundary = computerBoundary;
    this.#modelSelectionStore = modelSelectionStore;
    this.#conversationBindingsFile = conversationBindingsFile;
    this.#deleteConversationBindings = deleteConversationBindings;
  }

  deleteBots(rawBotIds) {
    if (arguments.length !== 1) throw invalid();
    this.#assertAccepting();
    const botIds = normalizeBotIds(rawBotIds);
    const operationKey = [...botIds].sort().join("\0");
    const existing = this.#liveOperations.get(operationKey);
    if (existing) return existing;
    if (botIds.some((botId) => this.#botClaims.has(botId))) {
      throw coordinatorError("Bot deletion overlaps an active batch.", "OPENBOT_BOT_DELETE_CONFLICT");
    }
    for (const botId of botIds) this.#botClaims.set(botId, operationKey);
    const operation = this.#enqueue(() => this.#deleteLive(botIds))
      .finally(() => {
        if (this.#liveOperations.get(operationKey) === operation) {
          this.#liveOperations.delete(operationKey);
        }
        for (const botId of botIds) {
          if (this.#botClaims.get(botId) === operationKey) this.#botClaims.delete(botId);
        }
      });
    this.#liveOperations.set(operationKey, operation);
    return operation;
  }

  reconcilePending() {
    this.#assertAccepting();
    if (this.#reconcilePromise) return this.#reconcilePromise;
    const operation = this.#enqueue(() => this.#reconcile())
      .finally(() => {
        if (this.#reconcilePromise === operation) this.#reconcilePromise = null;
      });
    this.#reconcilePromise = operation;
    return operation;
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    const operations = new Set([
      ...this.#liveOperations.values(),
      ...[...this.#cleanupOperations.values()].map((entry) => entry.operation),
      ...(this.#reconcilePromise ? [this.#reconcilePromise] : []),
    ]);
    this.#disposePromise = Promise.allSettled([...operations]).then(() => undefined);
    return this.#disposePromise;
  }

  async #deleteLive(botIds) {
    let result;
    let receiptState;
    let preferredActiveBotId;
    try { preferredActiveBotId = await this.#readActiveBotId(); }
    catch { throw coordinatorError("Active bot selection is unavailable."); }
    try {
      result = normalizeOutcome(await this.#botRuntimeController.deleteBots([...botIds], {
        preferredActiveBotId,
      }), botIds);
    } catch {
      try { receiptState = await this.#findReceipt(botIds); }
      catch { throw coordinatorError("Bot deletion could not be committed."); }
      try {
        result = normalizeOutcome(await this.#botRuntimeController.deleteBots([...botIds], {
          preferredActiveBotId,
        }), botIds);
      } catch {
        throw coordinatorError("Committed bot deletion could not be finalized.");
      }
    }
    if (!receiptState) receiptState = await this.#findReceipt(botIds);
    if (result.survivingBotIds.some((botId) => receiptState.pendingBotIds.has(botId))) {
      throw coordinatorError("Bot deletion successor is unavailable.");
    }
    const cleanupSuccessor = preferredActiveBotId !== null
      && result.survivingBotIds.includes(preferredActiveBotId)
      ? preferredActiveBotId
      : result.activeBotId;
    try {
      await this.#cleanupReceipt(receiptState.receipt, cleanupSuccessor);
    } catch {
      // The bot is already durably absent. Its tombstone remains for exact replay.
    }
    let selectedActiveBotId = cleanupSuccessor;
    try {
      const current = await this.#readActiveBotId();
      if (current !== null && result.survivingBotIds.includes(current)) selectedActiveBotId = current;
      else if (result.survivingBotIds.length === 0) selectedActiveBotId = null;
    } catch {
      // The anchored result remains the last validated successor if selection cannot be re-read.
    }
    return normalizeOutcome({
      deletedBotIds: [...result.deletedBotIds],
      survivingBotIds: [...result.survivingBotIds],
      activeBotId: selectedActiveBotId,
    }, botIds);
  }

  async #reconcile() {
    let receipts;
    try { receipts = normalizeReceipts(await this.#botStore.listPendingDeletions()); }
    catch { throw coordinatorError("Pending bot deletion data is unavailable."); }
    if (receipts.length === 0) return summary([], []);
    let survivingBotIds;
    try { survivingBotIds = survivorBotIds(await this.#botStore.list()); }
    catch {
      return summary([], receipts.map((receipt) => receipt.deletionId));
    }
    const pendingBotIds = new Set(receipts.flatMap((receipt) => receipt.botIds));
    if (survivingBotIds.some((botId) => pendingBotIds.has(botId))) {
      return summary([], receipts.map((receipt) => receipt.deletionId));
    }
    let selectedActiveBotId;
    try { selectedActiveBotId = await this.#readActiveBotId(); }
    catch { return summary([], receipts.map((receipt) => receipt.deletionId)); }
    const successorBotId = selectedActiveBotId !== null && survivingBotIds.includes(selectedActiveBotId)
      ? selectedActiveBotId
      : (survivingBotIds[0] ?? null);
    const completed = [];
    const pending = [];
    for (const receipt of receipts) {
      try {
        await this.#cleanupReceipt(receipt, successorBotId);
        completed.push(receipt.deletionId);
      } catch {
        pending.push(receipt.deletionId);
      }
    }
    return summary(completed, pending);
  }

  async #findReceipt(botIds) {
    let receipts;
    try { receipts = normalizeReceipts(await this.#botStore.listPendingDeletions()); }
    catch { throw coordinatorError("Pending bot deletion data is unavailable."); }
    const matches = receipts.filter((receipt) => exactSet(receipt.botIds, botIds));
    if (matches.length !== 1) throw coordinatorError("Pending bot deletion does not match.");
    return {
      receipt: matches[0],
      pendingBotIds: new Set(receipts.flatMap((receipt) => receipt.botIds)),
    };
  }

  async #readActiveBotId() {
    const value = await this.#modelSelectionStore.readActiveBotId();
    return value === null ? null : normalizeBotId(value);
  }

  #cleanupReceipt(receipt, successorBotId) {
    const fingerprint = JSON.stringify(receipt);
    const existing = this.#cleanupOperations.get(receipt.deletionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(coordinatorError("Pending bot deletion does not match."));
      }
      return existing.operation;
    }
    const entry = { fingerprint, operation: null };
    const operation = Promise.resolve()
      .then(() => this.#performCleanup(receipt, successorBotId))
      .finally(() => {
        if (this.#cleanupOperations.get(receipt.deletionId) === entry) {
          this.#cleanupOperations.delete(receipt.deletionId);
        }
      });
    entry.operation = operation;
    this.#cleanupOperations.set(receipt.deletionId, entry);
    return operation;
  }

  async #performCleanup(receipt, successorBotId) {
    for (const botId of receipt.botIds) await this.#computerTargetRouter.deleteBot(botId);
    for (const botIds of batches(receipt.botIds)) {
      await this.#conversationController.deleteBots({ botIds });
    }
    const profiles = new Map(receipt.localProfiles.map((entry) => [entry.botId, entry.profileId]));
    for (const botId of receipt.botIds) {
      await this.#computerBoundary.deleteBot({
        botId,
        localProfileId: profiles.get(botId) ?? null,
      });
    }
    for (const botIds of batches(receipt.botIds)) {
      await this.#modelSelectionStore.deleteBots({ botIds, successorBotId });
    }
    await this.#deleteConversationBindings(this.#conversationBindingsFile, [...receipt.botIds]);
    if (receipt.remoteRuntimes.length > 0) {
      throw coordinatorError("Remote Computer cleanup remains pending.", "OPENBOT_BOT_DELETE_REMOTE_PENDING");
    }
    const completed = await this.#botStore.completeDeletion(receipt.deletionId);
    if (completed === true) return;
    let pending;
    try { pending = normalizeReceipts(await this.#botStore.listPendingDeletions()); }
    catch { throw coordinatorError("Bot deletion completion is unavailable."); }
    if (pending.some((entry) => entry.deletionId === receipt.deletionId)) {
      throw coordinatorError("Bot deletion completion is unavailable.");
    }
  }

  #enqueue(operation) {
    const result = this.#coordinationTail.then(operation, operation);
    this.#coordinationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertAccepting() {
    if (this.#disposed) {
      throw coordinatorError("Bot deletion coordinator is disposed.", "OPENBOT_BOT_DELETE_DISPOSED");
    }
  }
}

module.exports = {
  BotDeletionCoordinator,
  BotDeletionCoordinatorError,
};
