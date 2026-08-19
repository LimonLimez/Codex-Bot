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
