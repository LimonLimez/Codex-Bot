"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BotDeletionCoordinator,
} = require("../src/desktop/bot-deletion-coordinator.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const BOT_C = "bot-33333333-3333-4333-8333-333333333333";
const DELETION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DELETION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUNTIME_A = "runtime-openbot-a";
const BINDINGS_FILE = "/private/openbot/conversation-bindings.v1.json";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function generatedUuid(index, base = 0x10000000) {
  return `${(base + index).toString(16).padStart(8, "0")}-1111-4111-8111-${index.toString(16).padStart(12, "0")}`;
}

function pendingReceipt(overrides = {}) {
  return Object.freeze({
    deletionId: DELETION_A,
    createdAt: "2026-08-16T23:00:00.000Z",
    botIds: Object.freeze([BOT_A, BOT_B]),
    remoteRuntimes: Object.freeze([]),
    localProfiles: Object.freeze([Object.freeze({ botId: BOT_A, profileId: LOCAL_A })]),
    ...overrides,
  });
}

function fixture({
  receipts = [pendingReceipt()],
  boundaryFailure = null,
  boundaryGate = null,
  bindingsGate = null,
  anchorGate = null,
  completeResult = undefined,
  retainOnComplete = false,
  survivingBots = [{ botId: BOT_C }],
  anchorFailure = null,
  anchorOutcome = null,
  modelActiveBotId = BOT_C,
} = {}) {
  const order = [];
  let pending = [...receipts];
  let failBoundary = boundaryFailure;
  const anchorFailures = Array.isArray(anchorFailure)
    ? [...anchorFailure]
    : (anchorFailure ? [anchorFailure] : []);
  const outcome = anchorOutcome ?? Object.freeze({
    deletedBotIds: Object.freeze([BOT_A, BOT_B]),
    survivingBotIds: Object.freeze([BOT_C]),
    activeBotId: BOT_C,
  });
  let activeBotId = modelActiveBotId;
  const botRuntimeController = {
    async deleteBots(botIds) {
      order.push(`anchor:${botIds.join(",")}`);
      if (anchorFailures.length > 0) throw anchorFailures.shift();
      if (anchorGate) await anchorGate;
      return outcome;
    },
  };
  const botStore = {
    async list() {
      return survivingBots;
    },
    async listPendingDeletions() {
      order.push("list-pending");
      return pending;
    },
    async completeDeletion(deletionId) {
      order.push(`complete:${deletionId}`);
      const had = pending.some((entry) => entry.deletionId === deletionId);
      if (!retainOnComplete) pending = pending.filter((entry) => entry.deletionId !== deletionId);
      return completeResult === undefined ? had : completeResult;
    },
  };
  const conversationController = {
    async deleteBots({ botIds }) {
      order.push(`conversations:${botIds.join(",")}`);
      return { deletedConversationIds: [] };
    },
  };
  const computerTargetRouter = {
    async deleteBot(botId) { order.push(`router:${botId}`); },
  };
  const computerBoundary = {
    async deleteBot({ botId, localProfileId }) {
      order.push(`boundary:${botId}:${localProfileId}`);
      if (boundaryGate) await boundaryGate;
      if (failBoundary) {
        const failure = failBoundary;
        failBoundary = null;
        throw failure;
      }
    },
  };
  const modelSelectionStore = {
    async readActiveBotId() { return activeBotId; },
    async deleteBots({ botIds, successorBotId }) {
      order.push(`models:${botIds.join(",")}:${successorBotId}`);
      if (botIds.includes(activeBotId)) activeBotId = successorBotId;
      return { activeBotId };
    },
  };
  const deleteConversationBindings = (file, botIds) => {
    order.push(`bindings:${file}:${botIds.join(",")}`);
    return bindingsGate;
  };
  const coordinator = new BotDeletionCoordinator({
    botRuntimeController,
    botStore,
    conversationController,
    computerTargetRouter,
    computerBoundary,
    modelSelectionStore,
    conversationBindingsFile: BINDINGS_FILE,
    deleteConversationBindings,
  });
  return {
    coordinator,
    order,
    outcome,
    pending: () => [...pending],
  };
}

test("live deletion anchors once then replays every exact owner before completing its tombstone", async () => {
  const value = fixture();

  const result = await value.coordinator.deleteBots([BOT_A, BOT_B]);

  assert.deepEqual(result, value.outcome);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(value.pending(), []);
  assert.deepEqual(value.order, [
    `anchor:${BOT_A},${BOT_B}`,
    "list-pending",
    `router:${BOT_A}`,
    `router:${BOT_B}`,
    `conversations:${BOT_A},${BOT_B}`,
    `boundary:${BOT_A}:${LOCAL_A}`,
    `boundary:${BOT_B}:null`,
    `models:${BOT_A},${BOT_B}:${BOT_C}`,
    `bindings:${BINDINGS_FILE}:${BOT_A},${BOT_B}`,
    `complete:${DELETION_A}`,
  ]);
});

test("background deletion keeps the durable model-selected active bot instead of the first survivor", async () => {
  const value = fixture({
    receipts: [pendingReceipt({
      botIds: Object.freeze([BOT_A]),
      localProfiles: Object.freeze([Object.freeze({ botId: BOT_A, profileId: LOCAL_A })]),
    })],
    survivingBots: [{ botId: BOT_B }, { botId: BOT_C }],
    modelActiveBotId: BOT_C,
    anchorOutcome: Object.freeze({
      deletedBotIds: Object.freeze([BOT_A]),
      survivingBotIds: Object.freeze([BOT_B, BOT_C]),
      activeBotId: BOT_B,
    }),
  });

  assert.deepEqual(await value.coordinator.deleteBots([BOT_A]), {
    deletedBotIds: [BOT_A],
    survivingBotIds: [BOT_B, BOT_C],
    activeBotId: BOT_C,
  });
  assert.equal(value.order.includes(`models:${BOT_A}:${BOT_C}`), true);
});

test("pending deletion replay uses the surviving durable model-selected bot as cleanup successor", async () => {
  const value = fixture({
    receipts: [pendingReceipt({
      botIds: Object.freeze([BOT_A]),
      localProfiles: Object.freeze([]),
    })],
    survivingBots: [{ botId: BOT_B }, { botId: BOT_C }],
    modelActiveBotId: BOT_C,
  });

  assert.deepEqual(await value.coordinator.reconcilePending(), {
    completedDeletionIds: [DELETION_A],
    pendingDeletionIds: [],
  });
  assert.equal(value.order.includes(`models:${BOT_A}:${BOT_C}`), true);
});

test("a pre-anchor failure reaches no cleanup while a post-anchor failure returns committed success", async () => {
  const before = fixture({
    receipts: [],
    anchorFailure: new Error("/Users/private pre-anchor"),
  });
  await assert.rejects(
    before.coordinator.deleteBots([BOT_A, BOT_B]),
    (error) => error?.code === "OPENBOT_BOT_DELETE_FAILED" && !/Users|private/i.test(error.message),
  );
  assert.deepEqual(before.order, [`anchor:${BOT_A},${BOT_B}`, "list-pending"]);

  const after = fixture({ boundaryFailure: new Error("private cleanup failure") });
  assert.deepEqual(
    await after.coordinator.deleteBots([BOT_A, BOT_B]),
    after.outcome,
  );
  assert.equal(after.pending().length, 1);
  assert.equal(after.order.some((entry) => entry.startsWith("complete:")), false);

  const replay = await after.coordinator.reconcilePending();
  assert.deepEqual(replay, {
    completedDeletionIds: [DELETION_A],
    pendingDeletionIds: [],
  });
  assert.deepEqual(after.pending(), []);
});

test("startup replay handles every receipt without re-running the durable visibility anchor", async () => {
  const value = fixture();

  assert.deepEqual(await value.coordinator.reconcilePending(), {
    completedDeletionIds: [DELETION_A],
    pendingDeletionIds: [],
  });
  assert.equal(value.order.some((entry) => entry.startsWith("anchor:")), false);
  assert.equal(value.order.at(-1), `complete:${DELETION_A}`);
});

test("a remote-runtime receipt remains pending without an owner-bound retirement capability", async () => {
  const value = fixture({
    receipts: [pendingReceipt({
      remoteRuntimes: Object.freeze([Object.freeze({ botId: BOT_A, runtimeId: RUNTIME_A })]),
    })],
  });

  assert.deepEqual(await value.coordinator.reconcilePending(), {
    completedDeletionIds: [],
    pendingDeletionIds: [DELETION_A],
  });
  assert.equal(value.order.some((entry) => entry.startsWith("complete:")), false);
  assert.equal(value.pending().length, 1);
});

test("exact duplicate live requests coalesce and hostile requests reach no dependency", async () => {
  const value = fixture();
  const first = value.coordinator.deleteBots([BOT_A, BOT_B]);
  const second = value.coordinator.deleteBots([BOT_B, BOT_A]);
  assert.equal(second, first);
  await first;
  assert.equal(value.order.filter((entry) => entry.startsWith("anchor:")).length, 1);

  const hostile = fixture();
  const sparse = [BOT_A, BOT_B];
  delete sparse[0];
  assert.throws(() => hostile.coordinator.deleteBots(sparse), /invalid/i);
  assert.throws(() => hostile.coordinator.deleteBots([BOT_A], {}), /invalid/i);
  assert.deepEqual(hostile.order, []);
});

test("overlapping non-identical deletion batches are refused before another anchor starts", async () => {
  const value = fixture();
  const first = value.coordinator.deleteBots([BOT_A, BOT_B]);
  let unexpected;
  assert.throws(() => {
    unexpected = value.coordinator.deleteBots([BOT_B, BOT_C]);
    void unexpected.catch(() => {});
  }, /overlap|active|invalid/i);
  await first;
  assert.equal(value.order.filter((entry) => entry.startsWith("anchor:")).length, 1);
});

test("a controller error with an exact durable receipt is recovered as committed deletion", async () => {
  const value = fixture({ anchorFailure: [new Error("committed but acknowledgement failed")] });

  assert.deepEqual(await value.coordinator.deleteBots([BOT_A, BOT_B]), value.outcome);
  assert.deepEqual(value.pending(), []);
  assert.equal(value.order.filter((entry) => entry.startsWith("anchor:")).length, 2);
  assert.equal(value.order.at(-1), `complete:${DELETION_A}`);
});

test("dispose rejects new deletion work and awaits an already-anchored cleanup", async () => {
  const gate = deferred();
  const value = fixture({ boundaryGate: gate.promise });
  const deleting = value.coordinator.deleteBots([BOT_A, BOT_B]);
  while (!value.order.some((entry) => entry.startsWith("boundary:"))) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  let settled = false;
  const disposing = value.coordinator.dispose().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.throws(
    () => value.coordinator.deleteBots([BOT_C]),
    (error) => error?.code === "OPENBOT_BOT_DELETE_DISPOSED",
  );

  gate.resolve();
  await Promise.all([deleting, disposing]);
  assert.equal(value.order.at(-1), `complete:${DELETION_A}`);
});

test("a receipt with duplicate per-bot local cleanup ownership fails before every effect", async () => {
  const value = fixture({
    receipts: [pendingReceipt({
      localProfiles: Object.freeze([
        Object.freeze({ botId: BOT_A, profileId: LOCAL_A }),
        Object.freeze({ botId: BOT_A, profileId: LOCAL_B }),
      ]),
    })],
  });

  await assert.rejects(value.coordinator.reconcilePending(), {
    code: "OPENBOT_BOT_DELETE_FAILED",
  });
  assert.deepEqual(value.order, ["list-pending"]);
});

test("tombstone completion waits for asynchronous conversation-binding cleanup", async () => {
  const gate = deferred();
  const value = fixture({ bindingsGate: gate.promise });
  const deleting = value.coordinator.deleteBots([BOT_A, BOT_B]);
  while (!value.order.some((entry) => entry.startsWith("bindings:"))) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  let disposed = false;
  const disposing = value.coordinator.dispose().then(() => { disposed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.order.some((entry) => entry.startsWith("complete:")), false);
  assert.equal(disposed, false);

  gate.resolve();
  await Promise.all([deleting, disposing]);
  assert.equal(value.order.at(-1), `complete:${DELETION_A}`);
});

test("a false completion that retains its tombstone remains pending", async () => {
  const value = fixture({ completeResult: false, retainOnComplete: true });

  assert.deepEqual(await value.coordinator.reconcilePending(), {
    completedDeletionIds: [],
    pendingDeletionIds: [DELETION_A],
  });
  assert.equal(value.pending().length, 1);
});

test("committed recovery rejects a receipt whose deleted bot is still visible", async () => {
  const value = fixture({
    survivingBots: [{ botId: BOT_A }],
  });

  assert.deepEqual(await value.coordinator.reconcilePending(), {
    completedDeletionIds: [],
    pendingDeletionIds: [DELETION_A],
  });
  assert.equal(value.order.some((entry) => entry.startsWith("complete:")), false);
});

test("startup replay validates survivors against every pending receipt before cleanup", async () => {
  const value = fixture({
    receipts: [
      pendingReceipt({
        botIds: Object.freeze([BOT_A]),
        localProfiles: Object.freeze([]),
      }),
      pendingReceipt({
        deletionId: DELETION_B,
        botIds: Object.freeze([BOT_B]),
        localProfiles: Object.freeze([]),
      }),
    ],
    survivingBots: [{ botId: BOT_B }, { botId: BOT_C }],
  });

  assert.deepEqual(await value.coordinator.reconcilePending(), {
    completedDeletionIds: [],
    pendingDeletionIds: [DELETION_A, DELETION_B],
  });
  assert.equal(value.order.some((entry) => entry.startsWith("router:")), false);
  assert.equal(value.order.some((entry) => entry.startsWith("models:")), false);
  assert.equal(value.order.some((entry) => entry.startsWith("complete:")), false);
});

test("live deletion rejects a survivor owned by another pending receipt before cleanup", async () => {
  const value = fixture({
    receipts: [
      pendingReceipt({
        botIds: Object.freeze([BOT_A]),
        localProfiles: Object.freeze([]),
      }),
      pendingReceipt({
        deletionId: DELETION_B,
        botIds: Object.freeze([BOT_B]),
        localProfiles: Object.freeze([]),
      }),
    ],
    anchorOutcome: Object.freeze({
      deletedBotIds: Object.freeze([BOT_A]),
      survivingBotIds: Object.freeze([BOT_B, BOT_C]),
      activeBotId: BOT_B,
    }),
  });

  await assert.rejects(value.coordinator.deleteBots([BOT_A]), {
    code: "OPENBOT_BOT_DELETE_FAILED",
  });
  assert.equal(value.order.some((entry) => entry.startsWith("router:")), false);
  assert.equal(value.order.some((entry) => entry.startsWith("models:")), false);
  assert.equal(value.order.some((entry) => entry.startsWith("complete:")), false);
});

test("controller success without one exact durable receipt is not reported as cleaned", async () => {
  const value = fixture({ receipts: [] });

  await assert.rejects(value.coordinator.deleteBots([BOT_A, BOT_B]), {
    code: "OPENBOT_BOT_DELETE_FAILED",
  });
  assert.deepEqual(value.order, [`anchor:${BOT_A},${BOT_B}`, "list-pending"]);
});

test("startup replay cannot consume a live deletion receipt while its anchor is held", async () => {
  const gate = deferred();
  const value = fixture({ anchorGate: gate.promise });
  const deleting = value.coordinator.deleteBots([BOT_A, BOT_B]);
  while (!value.order.some((entry) => entry.startsWith("anchor:"))) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const reconciling = value.coordinator.reconcilePending();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(value.order, [`anchor:${BOT_A},${BOT_B}`]);
  gate.resolve();

  assert.deepEqual(await deleting, value.outcome);
  assert.deepEqual(await reconciling, {
    completedDeletionIds: [],
    pendingDeletionIds: [],
  });
  assert.equal(value.order.filter((entry) => entry === `complete:${DELETION_A}`).length, 1);
});

test("startup replay accepts more than 256 valid remote-pending receipts without starving them", async () => {
  const receipts = Array.from({ length: 257 }, (_, index) => {
    const botId = `bot-${generatedUuid(index + 1)}`;
    return pendingReceipt({
      deletionId: generatedUuid(index + 1, 0x40000000),
      botIds: Object.freeze([botId]),
      remoteRuntimes: Object.freeze([Object.freeze({
        botId,
        runtimeId: `runtime-pending-${index + 1}`,
      })]),
      localProfiles: Object.freeze([]),
    });
  });
  const value = fixture({ receipts });

  const result = await value.coordinator.reconcilePending();

  assert.equal(result.completedDeletionIds.length, 0);
  assert.equal(result.pendingDeletionIds.length, 257);
  assert.deepEqual(result.pendingDeletionIds, receipts.map((entry) => entry.deletionId));
  assert.equal(value.order.some((entry) => entry.startsWith("complete:")), false);
});
