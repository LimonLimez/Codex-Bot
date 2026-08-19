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
  await store.writeOnboarding({ schemaVersion: 1, providerId: "openai-codex", connectionGeneration: 7, catalogGeneration: 7, completedAt: now });
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

test("state rejects a model owned by a different provider", async (t) => {
  const { ProviderStateStore } = require(storePath);
  const root = tempRoot(t);
  const store = new ProviderStateStore({ filePath: path.join(root, "providers.v1.json") });
  await assert.rejects(store.commitConnection({
    providerId: "anthropic-claude",
    generation: 1,
    state: "connected",
    models: [{ provider: "openai-api-key", model: "gpt-live", label: "Wrong owner" }],
  }), /invalid/i);
});

test("state commit treats post-rename durability uncertainty as committed when readback matches", async (t) => {
  const { ProviderStateStore } = require(storePath);
  const root = tempRoot(t);
  const filePath = path.join(root, "providers.v1.json");
  const first = new ProviderStateStore({ filePath });
  await first.commitConnection({
    providerId: "openai-codex", generation: 1, state: "connected", models: [model()],
  });
  let failOnce = true;
  const uncertain = new ProviderStateStore({
    filePath,
    fs: {
      ...require("node:fs/promises"),
      async chmod(target, mode) {
        if (target === filePath && failOnce) {
          failOnce = false;
          throw new Error("post-rename durability uncertain");
        }
        return require("node:fs/promises").chmod(target, mode);
      },
    },
  });
  const committed = await uncertain.commitConnection({
    providerId: "openai-codex", generation: 2, state: "connected", models: [model()],
  });
  assert.equal(committed.generation, 2);
  assert.equal((await uncertain.read()).connections[0].generation, 2);
});

test("state read rejects a file replaced by a symlink after its initial identity check", async (t) => {
  const { ProviderStateStore } = require(storePath);
  const fs = require("node:fs/promises");
  const root = tempRoot(t);
  const filePath = path.join(root, "providers.v1.json");
  const outside = path.join(root, "outside.json");
  const held = path.join(root, "held.json");
  const initial = new ProviderStateStore({ filePath });
  await initial.commitConnection({
    providerId: "openai-codex", generation: 1, state: "connected", models: [model()],
  });
  await fs.writeFile(outside, JSON.stringify({ schemaVersion: 1, connections: [], onboarding: null }));
  let raced = false;
  const race = async () => {
    if (!raced) {
      raced = true;
      await fs.rename(filePath, held);
      await fs.symlink(outside, filePath);
    }
  };
  const racing = new ProviderStateStore({
    filePath,
    fs: {
      ...fs,
      async readFile(target, encoding) {
        if (target === filePath) await race();
        return fs.readFile(target, encoding);
      },
      async open(target, ...args) {
        if (target === filePath) await race();
        return fs.open(target, ...args);
      },
    },
  });
  await assert.rejects(racing.read(), /failed|invalid/i);
  assert.equal((await fs.lstat(outside)).isFile(), true);
});

test("state write rejects a checked parent replaced by a symlink before mode changes", async (t) => {
  const { ProviderStateStore } = require(storePath);
  const fs = require("node:fs/promises");
  const root = tempRoot(t);
  const directory = path.join(root, "private");
  const outside = path.join(root, "outside");
  const moved = path.join(root, "private-held");
  const filePath = path.join(directory, "providers.v1.json");
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o755 });
  let swapped = false;
  const realLstat = fs.lstat;
  const racing = new ProviderStateStore({
    filePath,
    fs: {
      ...fs,
      async lstat(target, ...args) {
        const result = await realLstat(target, ...args);
        if (!swapped && target === directory) {
          swapped = true;
          await fs.rename(directory, moved);
          await fs.symlink(outside, directory, "dir");
        }
        return result;
      },
    },
  });
  await assert.rejects(racing.commitConnection({
    providerId: "openai-codex", generation: 1, state: "connected", models: [model()],
  }), /failed|invalid/i);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await fs.lstat(outside)).mode & 0o777, 0o755);
});
