"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const storePath = path.join(__dirname, "..", "src", "desktop", "provider-state-store.cjs");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-provider-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function model() {
  return {
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    label: "Terra",
    reasoningEfforts: ["low", "medium"],
  };
}

test("onboarding receipt is tied to an authoritative connection generation", async (t) => {
  const { ProviderStateStore } = require(storePath);
  const root = tempRoot(t);
  const store = new ProviderStateStore({ filePath: path.join(root, "providers.v1.json") });
  const now = "2026-08-18T00:00:00.000Z";
  await store.commitConnection({ providerId: "openai-codex", generation: 7, state: "connected", models: [model()] });
  await store.writeOnboarding({ schemaVersion: 1, providerId: "openai-codex", connectionGeneration: 7, completedAt: now });
  assert.equal((await store.read()).onboarding.connectionGeneration, 7);
  await store.removeConnection("openai-codex");
  assert.equal((await store.read()).onboarding, null);
});

test("provider state is atomic, private, frozen, and rejects descriptor-invalid values", async (t) => {
  const { ProviderStateStore } = require(storePath);
  const root = tempRoot(t);
  const filePath = path.join(root, "nested", "providers.v1.json");
  const store = new ProviderStateStore({ filePath });
  const connection = await store.commitConnection({
    providerId: "openai-codex", generation: 1, state: "connected", models: [model()],
  });
  assert.equal(Object.isFrozen(connection), true);
  assert.equal(Object.isFrozen(connection.models), true);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(await store.read(), {
    schemaVersion: 1,
    connections: [connection],
    onboarding: null,
  });
  await assert.rejects(store.commitConnection({
    providerId: "local", generation: 2, state: "connected", models: [],
  }), /invalid/i);
  const extra = { providerId: "openai-codex", generation: 2, state: "connected", models: [], extra: true };
  await assert.rejects(store.commitConnection(extra), /invalid/i);
});

test("same-provider commits serialize and remove clears only matching onboarding", async (t) => {
  const { ProviderStateStore } = require(storePath);
  const root = tempRoot(t);
  const store = new ProviderStateStore({ filePath: path.join(root, "providers.v1.json") });
  await Promise.all([
    store.commitConnection({ providerId: "openai-codex", generation: 1, state: "connected", models: [model()] }),
    store.commitConnection({ providerId: "openai-codex", generation: 2, state: "connected", models: [model()] }),
  ]);
  assert.equal((await store.read()).connections[0].generation, 2);
});
