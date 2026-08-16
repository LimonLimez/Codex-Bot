"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const storePath = path.join(__dirname, "..", "src", "local", "local-permission-store.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const TARGET_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GRANT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const GRANT_B = "bbbbbbbb-2222-4222-8222-222222222222";
const TEMP_A = "cccccccc-3333-4333-8333-333333333333";
const TEMP_B = "dddddddd-4444-4444-8444-444444444444";
const TEMP_C = "eeeeeeee-5555-4555-8555-555555555555";
const NOW = "2026-08-15T12:34:56.000Z";

function sequence(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, "test UUID sequence was exhausted");
    return values[index++];
  };
}

function request(botId = BOT_A, overrides = {}) {
  return {
    botId,
    targetId: TARGET_A,
    targetGeneration: 4,
    capability: "filesystem.read",
    resourceId: "folder-a",
    resourceLabel: "Folder A",
    ...overrides,
  };
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested, seen);
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-local-grants-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "private", "permissions.json");
  const { LocalPermissionStore } = require(storePath);
  return {
    directory,
    filePath,
    LocalPermissionStore,
    store: new LocalPermissionStore({
      filePath,
      now: () => NOW,
      randomUUID: sequence(options.uuids || [GRANT_A, TEMP_A, GRANT_B, TEMP_B, TEMP_C]),
      ...(options.fs ? { fs: options.fs } : {}),
    }),
  };
}

test("persistent grants are private mode 0600 exact-bot and revocable", async (t) => {
  const { store, filePath } = await fixture(t);
  const bookmark = Buffer.from("bookmark-private", "utf8");
  const grant = await store.remember(request(), bookmark);

  assert.deepEqual(grant, {
    grantId: `grant-${GRANT_A}`,
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "folder-a",
    resourceLabel: "Folder A",
    scope: "always",
    createdAt: NOW,
  });
  assertDeepFrozen(grant);
  assert.equal(Object.hasOwn(grant, "bookmark"), false);
  assert.equal(Object.hasOwn(grant, "privateBookmark"), false);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);

  const authorized = await store.authorize(request());
  assert.equal(authorized.allowed, true);
  assert.deepEqual(authorized.privateBookmark, bookmark);
  assert.equal(Object.isFrozen(authorized), true);
  assert.equal((await store.authorize(request(BOT_B))).allowed, false);
  assert.equal((await store.authorize(request(BOT_A, { targetGeneration: 5 }))).allowed, false);
  assert.equal((await store.authorize(request(BOT_A, { capability: "filesystem.write" }))).allowed, false);

  assert.deepEqual(await store.listPublic(BOT_A), [grant]);
  assert.deepEqual(await store.listPublic(BOT_A, {
    targetId: TARGET_A,
    targetGeneration: 4,
  }), [grant]);
  assert.deepEqual(await store.listPublic(BOT_A, {
    targetId: TARGET_A,
    targetGeneration: 5,
  }), []);
  assert.deepEqual(await store.listPublic(BOT_A, {
    targetId: TARGET_B,
    targetGeneration: 4,
  }), []);
  assert.deepEqual(await store.listPublic(BOT_B), []);
  const contents = await fs.readFile(filePath, "utf8");
  assert.doesNotMatch(contents, /bookmark-private|\/Users\/|harlin/i);
  assert.match(contents, new RegExp(bookmark.toString("base64")));

  await store.revoke(BOT_A, grant.grantId);
  assert.equal((await store.authorize(request())).allowed, false);
  await assert.rejects(store.revoke(BOT_A, grant.grantId), /not found|unavailable/i);
});

test("concurrent Store instances remain atomic and deleteBot removes only exact ownership", async (t) => {
  const { store, filePath, LocalPermissionStore } = await fixture(t, {
    uuids: [GRANT_A, TEMP_A, TEMP_C],
  });
  const secondStore = new LocalPermissionStore({
    filePath,
    now: () => NOW,
    randomUUID: sequence([GRANT_B, TEMP_B]),
  });
  const first = request(BOT_A);
  const second = request(BOT_B, {
    targetId: TARGET_B,
    targetGeneration: 9,
    capability: "application.open",
    resourceId: "com.apple.TextEdit",
    resourceLabel: "TextEdit",
  });

  const [grantA, grantB] = await Promise.all([
    store.remember(first, Buffer.from("bookmark-a")),
    secondStore.remember(second, Buffer.from("bookmark-b")),
  ]);
  assert.equal((await store.listPublic(BOT_A)).length, 1);
  assert.equal((await store.listPublic(BOT_B)).length, 1);
  assert.notEqual(grantA.grantId, grantB.grantId);

  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.grants.length, 2);
  await store.deleteBot(BOT_A);
  assert.deepEqual(await store.listPublic(BOT_A), []);
  assert.deepEqual(await store.listPublic(BOT_B), [grantB]);
  assert.equal((await store.authorize(second)).allowed, true);
});

test("hostile inputs paths malformed stores and symlinks fail closed without leaking data", async (t) => {
  const { store, filePath, directory } = await fixture(t);
  await assert.rejects(store.remember(request(BOT_A, {
    resourceLabel: "/Users/example/Documents/private",
  }), Buffer.from("bookmark")), /label|path/i);
  await assert.rejects(store.remember(request(BOT_A, {
    resourceId: "../private",
  }), Buffer.from("bookmark")), /resource/i);
  await assert.rejects(store.remember(new Proxy({}, {
    ownKeys() { throw new Error("secret-path-token"); },
  }), Buffer.from("bookmark")), /plain data/i);
  await assert.rejects(store.remember(request(), Buffer.alloc(70 * 1024)), /bookmark|oversized/i);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 1, grants: [{ secret: "token" }] }));
  await assert.rejects(store.listPublic(BOT_A), /grant|malformed|unsupported|private/i);

  await fs.rm(filePath, { force: true });
  const target = path.join(directory, "outside.json");
  await fs.writeFile(target, JSON.stringify({ schemaVersion: 1, grants: [] }));
  await fs.symlink(target, filePath);
  await assert.rejects(store.listPublic(BOT_A), /real file|symbolic link/i);
});
