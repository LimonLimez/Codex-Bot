"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ModelSelectionStore } = require("../src/desktop/model-selection-store.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const BOT_C = "bot-33333333-3333-4333-8333-333333333333";

function selection(botId, generation) {
  return {
    botId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 7,
    generation,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-model-selection-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "private", "model-selections.v1.json");
  return { filePath, store: new ModelSelectionStore({ filePath }) };
}

test("batch delete removes every requested selection and rehomes a deleted active bot idempotently", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.write(selection(BOT_A, 1));
  await store.write(selection(BOT_B, 2));
  assert.equal(await store.readActiveBotId(), BOT_B);

  const deleted = await store.deleteBots({ botIds: [BOT_A, BOT_B], successorBotId: BOT_C });
  assert.deepEqual(deleted, { activeBotId: BOT_C });
  assert.equal(await store.readActiveBotId(), BOT_C);
  assert.equal(Object.isFrozen(deleted), true);
  assert.equal(await store.read(BOT_A), null);
  assert.equal(await store.read(BOT_B), null);
  assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), {
    schemaVersion: 1,
    activeBotId: BOT_C,
    selections: {},
  });

  assert.deepEqual(await store.deleteBots({
    botIds: [BOT_A, BOT_B], successorBotId: BOT_C,
  }), { activeBotId: BOT_C });
});

test("batch delete preserves a surviving or null active bot instead of forcing the proposed successor", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.write(selection(BOT_A, 1));
  await store.write(selection(BOT_B, 2));
  assert.deepEqual(await store.deleteBots({ botIds: [BOT_A], successorBotId: BOT_C }), {
    activeBotId: BOT_B,
  });

  const emptyPath = path.join(path.dirname(filePath), "empty-model-selections.v1.json");
  const empty = new ModelSelectionStore({ filePath: emptyPath });
  assert.deepEqual(await empty.deleteBots({ botIds: [BOT_A], successorBotId: BOT_C }), {
    activeBotId: null,
  });
});

test("batch delete rejects malformed dense-set requests without touching durable bytes", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.write(selection(BOT_A, 1));
  const before = await fs.readFile(filePath);
  const sparse = [];
  sparse.length = 1;
  let accessorReads = 0;
  const hostile = Object.defineProperty({ successorBotId: BOT_C }, "botIds", {
    enumerable: true,
    get() { accessorReads += 1; return [BOT_A]; },
  });

  for (const request of [
    { botIds: [], successorBotId: null },
    { botIds: [BOT_A, BOT_A], successorBotId: null },
    { botIds: sparse, successorBotId: null },
    { botIds: [BOT_A], successorBotId: BOT_A },
    { botIds: ["bot-invalid"], successorBotId: null },
    { botIds: [BOT_A], successorBotId: null, extra: true },
    hostile,
  ]) {
    assert.throws(() => store.deleteBots(request), /delete|bot|invalid/i);
  }
  assert.equal(accessorReads, 0);
  assert.deepEqual(await fs.readFile(filePath), before);
});

test("batch delete is atomic before commit and retry-safe when commit success is uncertain", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.write(selection(BOT_A, 1));
  const before = await fs.readFile(filePath);
  const precommitFailure = new ModelSelectionStore({
    filePath,
    fs: {
      ...fs,
      async open() { throw new Error("precommit write failed"); },
    },
  });
  await assert.rejects(precommitFailure.deleteBots({ botIds: [BOT_A], successorBotId: BOT_B }));
  assert.deepEqual(await fs.readFile(filePath), before);

  let failCommittedChmod = true;
  const committedUncertain = new ModelSelectionStore({
    filePath,
    fs: {
      ...fs,
      async chmod(target, mode) {
        if (target === filePath && failCommittedChmod) {
          failCommittedChmod = false;
          throw new Error("post-rename durability uncertain");
        }
        return fs.chmod(target, mode);
      },
    },
  });
  await assert.rejects(committedUncertain.deleteBots({ botIds: [BOT_A], successorBotId: BOT_B }));
  const reopened = new ModelSelectionStore({ filePath });
  assert.equal(await reopened.read(BOT_A), null);
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).activeBotId, BOT_B);
  assert.deepEqual(await committedUncertain.deleteBots({
    botIds: [BOT_A], successorBotId: BOT_B,
  }), { activeBotId: BOT_B });
});
