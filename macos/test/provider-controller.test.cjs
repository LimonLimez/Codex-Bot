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
