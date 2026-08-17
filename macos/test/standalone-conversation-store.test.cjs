"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { StandaloneConversationStore } = require("../src/desktop/standalone-conversation-store.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const CONVERSATION = "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function record(overrides = {}) {
  return {
    botId: BOT_A,
    conversationId: CONVERSATION,
    createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z",
    messages: [{
      messageId: "message-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      role: "user",
      text: "Persist me.",
      createdAt: "2026-08-16T12:00:00.000Z",
    }],
    ...overrides,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-standalone-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "private", "standalone-conversations.v1.json");
  return { filePath, root, store: new StandaloneConversationStore({ filePath }) };
}

test("standalone transcript store is atomic private durable and exact-bot", async (t) => {
  const { filePath, store } = await fixture(t);
  const created = await store.create(record());
  assert.equal(Object.isFrozen(created), true);
  assert.equal((await store.read(BOT_A, CONVERSATION)).messages[0].text, "Persist me.");
  assert.equal(await store.read(BOT_B, CONVERSATION), null);
  assert.deepEqual((await store.list(BOT_A)).map(({ conversationId }) => conversationId), [CONVERSATION]);
  assert.deepEqual(await store.list(BOT_B), []);
  assert.equal((await fs.stat(filePath)).mode & 0o077, 0);
  assert.equal((await fs.stat(path.dirname(filePath))).mode & 0o077, 0);

  const reopened = new StandaloneConversationStore({ filePath });
  assert.equal((await reopened.read(BOT_A, CONVERSATION)).messages[0].text, "Persist me.");
  const replaced = await reopened.replace(record({
    updatedAt: "2026-08-16T12:01:00.000Z",
    messages: [...record().messages, {
      messageId: "message-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      role: "assistant",
      text: "Still here.",
      createdAt: "2026-08-16T12:01:00.000Z",
    }],
  }));
  assert.equal(replaced.messages.length, 2);
  assert.equal((await reopened.read(BOT_A, CONVERSATION)).messages[1].text, "Still here.");
  assert.doesNotMatch(await fs.readFile(filePath, "utf8"), /endpoint|credential|token|bookmark|\/Users\//i);
});

test("native prompt nonces survive reopen while schema v1 transcripts migrate without inventing acceptance", async (t) => {
  const { filePath, store } = await fixture(t);
  const withNonce = record({
    messages: [{
      ...record().messages[0],
      clientNonce: "native-nonce-123",
      inputDigest: "1".repeat(64),
    }],
  });
  await store.create(withNonce);
  const reopened = new StandaloneConversationStore({ filePath });
  assert.equal((await reopened.read(BOT_A, CONVERSATION)).messages[0].clientNonce, "native-nonce-123");
  assert.equal((await reopened.read(BOT_A, CONVERSATION)).messages[0].inputDigest, "1".repeat(64));
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).schemaVersion, 2);

  await fs.writeFile(filePath, `${JSON.stringify({
    schemaVersion: 1,
    conversations: [record()],
  })}\n`, { mode: 0o600 });
  const legacy = new StandaloneConversationStore({ filePath });
  const legacyMessage = (await legacy.read(BOT_A, CONVERSATION)).messages[0];
  assert.equal(Object.hasOwn(legacyMessage, "clientNonce"), false);
  await legacy.replace(record({ updatedAt: "2026-08-16T12:02:00.000Z" }));
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).schemaVersion, 2);
});

test("corruption hostile records and write failure stay sanitized and fail closed", async (t) => {
  const { filePath, store } = await fixture(t);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, "{corrupt", { mode: 0o600 });
  await assert.rejects(store.list(BOT_A), (error) => {
    assert.equal(error.code, "OPENBOT_CONVERSATION_STORE_FAILED");
    assert.doesNotMatch(String(error.stack), /corrupt|Users|token|private/);
    return true;
  });
  await fs.rm(filePath);
  let accessorReads = 0;
  const hostile = Object.defineProperty(record(), "messages", {
    enumerable: true,
    get() { accessorReads += 1; throw new Error("private /Users/person token"); },
  });
  await assert.rejects(store.create(hostile), { code: "OPENBOT_CONVERSATION_STORE_FAILED" });
  assert.equal(accessorReads, 0);

  const writeFailure = new StandaloneConversationStore({
    filePath,
    fs: {
      ...fs,
      async open() {
        const error = new Error("ENOSPC /Users/person token");
        error.code = "ENOSPC";
        throw error;
      },
    },
  });
  await assert.rejects(writeFailure.create(record()), (error) => {
    assert.equal(error.code, "OPENBOT_CONVERSATION_STORE_FAILED");
    assert.doesNotMatch(String(error.stack), /ENOSPC|Users|token/);
    return true;
  });
  assert.equal(await fs.stat(path.dirname(filePath)).then(() => true, () => false), true);
});

test("duplicate cross-bot IDs and oversized text never mutate the durable file", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create(record());
  const before = await fs.readFile(filePath);
  await assert.rejects(store.create(record({ botId: BOT_B })), { code: "OPENBOT_CONVERSATION_STORE_FAILED" });
  await assert.rejects(store.replace(record({
    messages: [{ ...record().messages[0], text: "x".repeat(70_000) }],
  })), { code: "OPENBOT_CONVERSATION_STORE_FAILED" });
  assert.deepEqual(await fs.readFile(filePath), before);
});

test("a reopened transcript repairs mode 0644 to exactly 0600 before reading", async (t) => {
  const { filePath, store } = await fixture(t);
  await store.create(record());
  await fs.chmod(filePath, 0o644);
  let reads = 0;
  const reopened = new StandaloneConversationStore({
    filePath,
    fs: {
      ...fs,
      async readFile(...args) {
        reads += 1;
        assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
        return fs.readFile(...args);
      },
    },
  });
  assert.equal((await reopened.read(BOT_A, CONVERSATION)).messages[0].text, "Persist me.");
  assert.equal(reads, 1);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});
