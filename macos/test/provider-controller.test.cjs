"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const controllerPath = path.join(__dirname, "..", "src", "desktop", "provider-controller.cjs");
const PROVIDER_IDS = [
  "openai-codex", "anthropic-claude", "google-antigravity", "moonshot-kimi", "xai",
  "google-vertex-ai", "openai-api-key", "local-openai-compatible",
];

function descriptorModel(provider = "anthropic-claude") {
  return { provider, model: provider === "anthropic-claude" ? "claude-sonnet-5" : "gpt-live", label: "Live" };
}

class FakeStateStore {
  constructor() { this.state = { schemaVersion: 1, connections: [], onboarding: null }; }
  async read() { return structuredClone(this.state); }
  async commitConnection(value) {
    this.state.connections = this.state.connections.filter(({ providerId }) => providerId !== value.providerId);
    this.state.connections.push(structuredClone(value));
    return structuredClone(value);
  }
  async removeConnection(providerId) {
    this.state.connections = this.state.connections.filter((entry) => entry.providerId !== providerId);
    if (this.state.onboarding?.providerId === providerId) this.state.onboarding = null;
  }
  async removeConnectionAndOnboarding(providerId) {
    this.state.connections = this.state.connections.filter((entry) => entry.providerId !== providerId);
    if (this.state.onboarding?.providerId === providerId) this.state.onboarding = null;
  }
  async writeOnboarding(receipt) { this.state.onboarding = structuredClone(receipt); return structuredClone(receipt); }
  async clearOnboardingFor(providerId) { if (this.state.onboarding?.providerId === providerId) this.state.onboarding = null; }
}

function connectedState(providerId = "anthropic-claude", generation = 1) {
  return {
    schemaVersion: 1,
    connections: [{
      providerId,
      generation,
      state: "connected",
      models: [descriptorModel(providerId)],
    }],
    onboarding: null,
  };
}

test("controller lists eight routes but catalogs only authoritative connected providers", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const manager = {
    connectProvider: async () => {},
    importVertex: async () => {},
    connectionStatus: async () => ({ state: "connected", models: [descriptorModel()] }),
    listModels: async (providerId) => [descriptorModel(providerId)],
    disconnectProvider: async () => {},
  };
  const controller = new ProviderController({ stateStore: state, cliproxy: manager });
  assert.deepEqual((await controller.listConnections()).map(({ providerId }) => providerId), PROVIDER_IDS);
  assert.deepEqual((await controller.catalog()).models, []);
  await controller.connect({ providerId: "anthropic-claude" });
  assert.equal((await controller.catalog()).models.every((entry) => entry.provider === "anthropic-claude"), true);
  assert.doesNotMatch(JSON.stringify(await controller.listConnections()), /token|secret|Users|stderr|auth.*json/i);
});

test("cancelled connection cannot complete onboarding", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const controller = new ProviderController({
    stateStore: state,
    cliproxy: {
      connectProvider: async () => { throw Object.assign(new Error("cancelled"), { code: "CLIPROXY_PROVIDER_CANCELLED" }); },
      importVertex: async () => {},
      connectionStatus: async () => ({ state: "disconnected", models: [] }),
      listModels: async () => [],
      disconnectProvider: async () => {},
    },
  });
  await assert.rejects(controller.connect({ providerId: "moonshot-kimi" }), /cancelled|unavailable/i);
  await assert.rejects(controller.completeOnboarding("moonshot-kimi"), /ready|connected/i);
  assert.equal(await controller.readOnboarding(), null);
});

test("duplicate disconnect operations coalesce to one Promise and one external effect", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState();
  let release;
  let disconnects = 0;
  const controller = new ProviderController({
    stateStore: state,
    cliproxy: {
      connectProvider: async () => {}, importVertex: async () => {},
      connectionStatus: async () => ({ state: "connected" }), listModels: async () => [descriptorModel()],
      disconnectProvider: async () => { disconnects += 1; await new Promise((resolve) => { release = resolve; }); },
    },
  });
  const first = controller.disconnect("anthropic-claude");
  const second = controller.disconnect("anthropic-claude");
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.equal(disconnects, 1);
});

test("duplicate onboarding operations coalesce including synchronous reentry", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState();
  let release;
  state.writeOnboarding = async (receipt) => {
    await new Promise((resolve) => { release = resolve; });
    state.state.onboarding = receipt;
    return receipt;
  };
  const controller = new ProviderController({ stateStore: state });
  const first = controller.completeOnboarding("anthropic-claude");
  const second = controller.completeOnboarding("anthropic-claude");
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
});

test("cancelled API reconnect restores the prior Keychain secret and durable connection", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-api-key", 1);
  let current = "old";
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const controller = new ProviderController({
    stateStore: state,
    openai: {
      discover: async () => ({ models: [{ provider: "openai-api-key", model: "gpt-new", label: "New" }] }),
      streamConfiguration: () => ({ providerId: "openai-api-key", baseUrl: "https://api.openai.com/v1", apiKey: "new" }),
    },
    keychain: {
      read: async () => current,
      set: async (_providerId, secret) => { current = secret; if (secret === "new") signal.aborted = true; },
      delete: async () => { current = null; },
    },
  });
  await assert.rejects(controller.connect({ providerId: "openai-api-key", apiKey: "new", signal }), /cancelled/i);
  assert.equal(current, "old");
  assert.equal(state.state.connections[0].generation, 1);
});

test("disconnect is fenced behind a pending connect so a late connect cannot resurrect the provider", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  let release;
  let connected = false;
  const manager = {
    connectProvider: async () => { await new Promise((resolve) => { release = resolve; }); connected = true; },
    importVertex: async () => {},
    connectionStatus: async () => ({ state: connected ? "connected" : "disconnected" }),
    listModels: async () => [descriptorModel("anthropic-claude")],
    disconnectProvider: async () => { connected = false; },
  };
  const controller = new ProviderController({ stateStore: state, cliproxy: manager });
  const connecting = controller.connect({ providerId: "anthropic-claude" });
  const disconnecting = controller.disconnect("anthropic-claude");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await connecting;
  await disconnecting;
  assert.equal(state.state.connections.length, 0);
  assert.equal(connected, false);
});

test("failed hosted reconnect invokes the provider rollback and preserves the prior durable connection", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("anthropic-claude", 1);
  let rolledBack = 0;
  const controller = new ProviderController({
    stateStore: state,
    cliproxy: {
      connectProvider: async () => ({ rollback: async () => { rolledBack += 1; } }),
      importVertex: async () => {},
      connectionStatus: async () => ({ state: "connected" }),
      listModels: async () => { throw new Error("catalog unavailable"); },
      disconnectProvider: async () => {},
    },
  });
  await assert.rejects(controller.connect({ providerId: "anthropic-claude" }), /unavailable|failed/i);
  assert.equal(rolledBack, 1);
  assert.equal(state.state.connections[0].generation, 1);
});

test("disconnect uses one atomic durable removal-and-receipt mutation", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState();
  let atomicCalls = 0;
  let legacyCalls = 0;
  state.removeConnectionAndOnboarding = async (providerId) => {
    atomicCalls += 1;
    state.state.connections = state.state.connections.filter(({ providerId: current }) => current !== providerId);
    state.state.onboarding = null;
  };
  state.removeConnection = async () => { legacyCalls += 1; throw new Error("legacy mutation must not run"); };
  const controller = new ProviderController({
    stateStore: state,
    cliproxy: {
      connectProvider: async () => {}, importVertex: async () => {},
      connectionStatus: async () => ({ state: "connected" }), listModels: async () => [descriptorModel()],
      disconnectProvider: async () => {},
    },
  });
  await controller.disconnect("anthropic-claude");
  assert.equal(atomicCalls, 1);
  assert.equal(legacyCalls, 0);
});

test("durable disconnect failure rolls back external cleanup and preserves the prior connection", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState();
  state.removeConnectionAndOnboarding = async () => { throw new Error("durable precommit failure"); };
  let rolledBack = 0;
  const controller = new ProviderController({
    stateStore: state,
    cliproxy: {
      connectProvider: async () => {}, importVertex: async () => {},
      connectionStatus: async () => ({ state: "connected" }), listModels: async () => [descriptorModel()],
      disconnectProvider: async () => ({ rollback: async () => { rolledBack += 1; } }),
    },
  });
  await assert.rejects(controller.disconnect("anthropic-claude"), /failed|unavailable/i);
  assert.equal(rolledBack, 1);
  assert.equal(state.state.connections.length, 1);
});

test("postcommit publication failure does not report a committed disconnect as failed", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState();
  let removed = false;
  state.removeConnectionAndOnboarding = async () => {
    removed = true;
    state.state.connections = [];
    state.state.onboarding = null;
  };
  const read = state.read.bind(state);
  state.read = async () => {
    if (removed) throw new Error("publication read failed");
    return read();
  };
  const controller = new ProviderController({
    stateStore: state,
    cliproxy: {
      connectProvider: async () => {}, importVertex: async () => {},
      connectionStatus: async () => ({ state: "connected" }), listModels: async () => [descriptorModel()],
      disconnectProvider: async () => {},
    },
  });
  await controller.disconnect("anthropic-claude");
  assert.equal(removed, true);
});

test("catalog generation ignores disconnected and unavailable connections in the real state store", async (t) => {
  const { ProviderController } = require(controllerPath);
  const { ProviderStateStore } = require("../src/desktop/provider-state-store.cjs");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-provider-r1-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProviderStateStore({ filePath: path.join(root, "providers.v1.json") });
  await store.commitConnection({ providerId: "openai-codex", generation: 1, state: "connected", models: [descriptorModel("openai-codex")] });
  await store.commitConnection({ providerId: "xai", generation: 10, state: "disconnected", models: [descriptorModel("xai")] });
  const controller = new ProviderController({ stateStore: store });
  const receipt = await controller.completeOnboarding("openai-codex");
  assert.equal(receipt.catalogGeneration, 1);
  assert.equal((await store.read()).onboarding.catalogGeneration, 1);
});

test("onboarding rejects a catalog-generation interleaving and carries the exact generation in the receipt", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("anthropic-claude", 1);
  let reads = 0;
  state.read = async () => {
    reads += 1;
    if (reads === 3) state.state.connections.push({
      providerId: "xai", generation: 10, state: "connected", models: [descriptorModel("xai")],
    });
    return structuredClone(state.state);
  };
  state.writeOnboarding = async (receipt) => {
    if (receipt.catalogGeneration !== 1) throw new Error("stale catalog generation");
    state.state.onboarding = receipt;
    return receipt;
  };
  const controller = new ProviderController({ stateStore: state });
  await assert.rejects(controller.completeOnboarding("anthropic-claude"), { code: "OPENBOT_PROVIDER_CATALOG_STALE" });
  assert.equal(state.state.onboarding, null);
});

test("dispose fences pending provider operations and rejects new work", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  let release;
  const controller = new ProviderController({
    stateStore: state,
    cliproxy: {
      connectProvider: async () => new Promise((resolve) => { release = resolve; }),
      importVertex: async () => {}, connectionStatus: async () => ({ state: "connected" }),
      listModels: async () => [descriptorModel()], disconnectProvider: async () => {},
    },
  });
  const pending = controller.connect({ providerId: "anthropic-claude" });
  controller.dispose();
  await assert.rejects(pending, { code: "OPENBOT_PROVIDER_DISPOSED" });
  await assert.rejects(controller.connect({ providerId: "anthropic-claude" }), { code: "OPENBOT_PROVIDER_DISPOSED" });
  release?.();
});

test("atomic authority snapshot projects one coherent frozen DTO from one state read", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = {
    schemaVersion: 1,
    connections: [
      {
        providerId: "openai-codex",
        generation: 1,
        state: "connected",
        models: [{
          provider: "openai-codex",
          providerLabel: "OpenAI Codex",
          model: "gpt-5.6-terra",
          label: "Terra",
          efforts: ["low", "high"],
          serviceTiers: [],
          defaultReasoningEffort: "low",
          defaultServiceTier: null,
          catalogGeneration: 3,
          isDefault: true,
        }],
      },
      {
        providerId: "xai",
        generation: 9,
        state: "disconnected",
        models: [descriptorModel("xai")],
      },
    ],
    onboarding: {
      schemaVersion: 1,
      providerId: "openai-codex",
      connectionGeneration: 1,
      catalogGeneration: 1,
      completedAt: "2026-08-18T00:00:00.000Z",
    },
  };
  let reads = 0;
  state.read = async () => {
    reads += 1;
    return structuredClone(state.state);
  };
  const externalCalls = [];
  const controller = new ProviderController({
    stateStore: state,
    keychain: {
      read: async () => { externalCalls.push("keychain.read"); throw new Error("must not run"); },
      set: async () => { externalCalls.push("keychain.set"); throw new Error("must not run"); },
      delete: async () => { externalCalls.push("keychain.delete"); throw new Error("must not run"); },
    },
    account: {
      start: async () => { externalCalls.push("account.start"); throw new Error("must not run"); },
      accountState: () => { externalCalls.push("account.state"); throw new Error("must not run"); },
      catalogState: () => { externalCalls.push("account.catalog"); throw new Error("must not run"); },
    },
    cliproxy: {
      connectProvider: async () => { externalCalls.push("cliproxy.connect"); throw new Error("must not run"); },
      importVertex: async () => { externalCalls.push("cliproxy.import"); throw new Error("must not run"); },
      disconnectProvider: async () => { externalCalls.push("cliproxy.disconnect"); throw new Error("must not run"); },
      listModels: async () => { externalCalls.push("cliproxy.models"); throw new Error("must not run"); },
      connectionStatus: async () => { externalCalls.push("cliproxy.status"); throw new Error("must not run"); },
    },
  });

  const snapshot = await controller.readAuthoritySnapshot();
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(snapshot), ["schemaVersion", "connections", "catalog", "onboarding"]);
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.connections.map(({ providerId }) => providerId), PROVIDER_IDS);
  assert.deepEqual(Object.keys(snapshot.connections[0]), [
    "providerId", "label", "loginKind", "state", "generation", "capabilities", "errorCode",
  ]);
  assert.deepEqual(snapshot.catalog, {
    generation: 1,
    status: "ready",
    models: [{
      provider: "openai-codex",
      providerLabel: "OpenAI Codex",
      model: "gpt-5.6-terra",
      label: "Terra",
      efforts: ["low", "high"],
      serviceTiers: [],
      defaultReasoningEffort: "low",
      defaultServiceTier: null,
      catalogGeneration: 3,
      isDefault: true,
    }],
  });
  assert.deepEqual(snapshot.onboarding, state.state.onboarding);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.connections), true);
  assert.equal(Object.isFrozen(snapshot.connections[0]), true);
  assert.equal(Object.isFrozen(snapshot.connections[0].capabilities), true);
  assert.equal(Object.isFrozen(snapshot.catalog), true);
  assert.equal(Object.isFrozen(snapshot.catalog.models), true);
  assert.equal(Object.isFrozen(snapshot.catalog.models[0]), true);
  assert.equal(Object.isFrozen(snapshot.catalog.models[0].efforts), true);
  assert.equal(Object.isFrozen(snapshot.onboarding), true);
  assert.deepEqual(externalCalls, []);
});

test("catalog metadata keeps the real Direct Codex generation independent of connection generation", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  let starts = 0;
  const controller = new ProviderController({
    stateStore: state,
    account: {
      start: async () => { starts += 1; },
      accountState: () => ({ status: "ready", authMode: "chatgpt" }),
      catalogState: () => ({
        status: "ready",
        generation: 3,
        models: [{
          id: "gpt-5.6-terra",
          displayName: "Terra",
          supportedReasoningEfforts: ["low"],
          serviceTiers: [],
          defaultReasoningEffort: "low",
          defaultServiceTier: null,
          isDefault: true,
        }],
      }),
    },
  });

  await controller.connect({ providerId: "openai-codex" });
  const snapshot = await controller.readAuthoritySnapshot();
  const connection = snapshot.connections.find(({ providerId }) => providerId === "openai-codex");
  assert.equal(starts, 1);
  assert.equal(connection.generation, 1);
  assert.equal(snapshot.catalog.generation, 1);
  assert.equal(snapshot.catalog.models[0].catalogGeneration, 3);
});

test("readAuthoritySnapshot rejects descriptor-hostile state without invoking accessors", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  let accessed = false;
  const hostile = {};
  Object.defineProperty(hostile, "schemaVersion", {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error("hostile accessor");
    },
  });
  state.read = async () => hostile;
  const controller = new ProviderController({ stateStore: state });
  await assert.rejects(controller.readAuthoritySnapshot(), { code: "OPENBOT_PROVIDER_UNAVAILABLE" });
  assert.equal(accessed, false);
});

test("readAuthoritySnapshot is disposal-fenced before and during its one state read", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  let reads = 0;
  state.read = async () => {
    reads += 1;
    return structuredClone(state.state);
  };
  const controller = new ProviderController({ stateStore: state });
  controller.dispose();
  await assert.rejects(controller.readAuthoritySnapshot(), { code: "OPENBOT_PROVIDER_DISPOSED" });
  assert.equal(reads, 0);

  let resolveRead;
  const pendingState = new FakeStateStore();
  pendingState.read = () => new Promise((resolve) => { resolveRead = resolve; });
  const pendingController = new ProviderController({ stateStore: pendingState });
  const pending = pendingController.readAuthoritySnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  pendingController.dispose();
  resolveRead(structuredClone(pendingState.state));
  await assert.rejects(pending, { code: "OPENBOT_PROVIDER_DISPOSED" });

  let rejectRead;
  const failedState = new FakeStateStore();
  failedState.read = () => new Promise((_resolve, reject) => { rejectRead = reject; });
  const failedController = new ProviderController({ stateStore: failedState });
  const failedPending = failedController.readAuthoritySnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  failedController.dispose();
  rejectRead(new Error("late state failure"));
  await assert.rejects(failedPending, { code: "OPENBOT_PROVIDER_DISPOSED" });
});

test("internal error connection state is publicly unavailable with its stable error code", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = {
    schemaVersion: 1,
    connections: [{
      providerId: "anthropic-claude",
      generation: 4,
      state: "error",
      errorCode: "OPENBOT_PROVIDER_FAILED",
      models: [],
    }],
    onboarding: null,
  };
  const controller = new ProviderController({ stateStore: state });

  const listed = (await controller.listConnections()).find(({ providerId }) => providerId === "anthropic-claude");
  assert.equal(listed.state, "unavailable");
  assert.equal(listed.errorCode, "OPENBOT_PROVIDER_FAILED");

  const snapshot = await controller.readAuthoritySnapshot();
  const projected = snapshot.connections.find(({ providerId }) => providerId === "anthropic-claude");
  assert.equal(projected.state, "unavailable");
  assert.equal(projected.errorCode, "OPENBOT_PROVIDER_FAILED");
});
