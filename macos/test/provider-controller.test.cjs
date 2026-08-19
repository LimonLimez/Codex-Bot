"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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
    if (this.state.onboarding?.providerId === value.providerId
      && (value.state !== "connected" || value.generation !== this.state.onboarding.connectionGeneration)) {
      this.state.onboarding = null;
    }
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

function directAccountModel(id = "gpt-live-terra") {
  return {
    id,
    displayName: "Live Terra",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    serviceTiers: [],
    defaultReasoningEffort: "low",
    defaultServiceTier: null,
    isDefault: true,
  };
}

class FakeDirectAccount extends EventEmitter {
  constructor({ signedOut = false, catalogStatus = "ready", models = [directAccountModel()], logoutErrors = 0 } = {}) {
    super();
    this.starts = 0;
    this.loginModes = [];
    this.cancelLogins = 0;
    this.logouts = 0;
    this.logoutErrors = logoutErrors;
    this.account = {
      generation: 1,
      status: signedOut ? "signed-out" : "ready",
      authMode: signedOut ? null : "chatgpt",
      planType: signedOut ? null : "pro",
      requiresOpenaiAuth: true,
      login: null,
      rateLimits: null,
    };
    this.catalog = { generation: 1, status: catalogStatus, models: catalogStatus === "ready" ? models : [] };
  }

  async start() { this.starts += 1; }

  accountState() { return structuredClone(this.account); }

  catalogState() { return structuredClone(this.catalog); }

  async login(mode) {
    this.loginModes.push(mode);
    this.account = {
      ...this.account,
      status: "signing-in",
      authMode: null,
      login: mode === "device-code"
        ? { mode, verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" }
        : { mode },
    };
    this.emit("account-changed", this.account);
    const result = { state: this.account };
    if (mode === "browser") {
      Object.defineProperty(result, "openUrl", {
        value: "https://chatgpt.com/auth/codex?private=main-only",
        enumerable: false,
      });
    }
    return Object.freeze(result);
  }

  async cancelLogin() {
    this.cancelLogins += 1;
    this.account = { ...this.account, status: "signed-out", authMode: null, login: null };
    this.emit("account-changed", this.account);
  }

  async logout() {
    this.logouts += 1;
    if (this.logoutErrors > 0) {
      this.logoutErrors -= 1;
      throw new Error("private logout failure");
    }
    this.account = { ...this.account, status: "signed-out", authMode: null, login: null };
    this.catalog = { generation: this.catalog.generation + 1, status: "unavailable", models: [] };
    this.emit("account-changed", this.account);
    this.emit("catalog-changed", this.catalog);
  }

  becomeReady(models = [directAccountModel()], generation = this.catalog.generation + 1) {
    this.account = { ...this.account, generation: this.account.generation + 1, status: "ready", authMode: "chatgpt", login: null };
    this.catalog = { generation, status: "ready", models };
    this.emit("account-changed", this.account);
    this.emit("catalog-changed", this.catalog);
  }
}

function directContext({ openExternal = async () => {}, onLoginPrompt = () => {}, isCurrent = () => true } = {}) {
  return { openExternal, onLoginPrompt, isCurrent };
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
  let logins = 0;
  const controller = new ProviderController({
    stateStore: state,
    account: {
      start: async () => { starts += 1; },
      login: async () => { logins += 1; },
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
  assert.equal(logins, 0);
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

test("signed-out Direct Codex browser connect invokes login once, opens only the private URL in main, publishes connecting, and commits only after readiness", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount({ signedOut: true });
  const opened = [];
  const presentations = [];
  const controller = new ProviderController({ stateStore: state, account });
  controller.on("connections-changed", (connections) => presentations.push(connections));
  const pending = controller.connect(
    { providerId: "openai-codex", authMode: "browser" },
    directContext({ openExternal: async (url) => { opened.push(url); } }),
  );
  void pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(account.loginModes, ["browser"]);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^https:\/\/chatgpt\.com\/auth\/codex\?/);
  assert.equal((await controller.readAuthoritySnapshot()).connections[0].state, "connecting");
  assert.equal(state.state.connections.length, 0);
  assert.equal(presentations.at(-1)?.[0].state, "connecting");

  account.becomeReady();
  const connected = await pending;
  assert.equal(connected.providerId, "openai-codex");
  assert.equal((await controller.catalog()).status, "ready");
  assert.doesNotMatch(JSON.stringify(connected), /chatgpt\.com|private|loginId|verificationUrl/);
});

test("Direct Codex device connect publishes only the bounded ceremony DTO and waits for readiness before durable commit", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount({ signedOut: true });
  const prompts = [];
  const controller = new ProviderController({ stateStore: state, account });
  const pending = controller.connect(
    { providerId: "openai-codex", authMode: "device-code" },
    directContext({ onLoginPrompt: (prompt) => prompts.push(prompt) }),
  );
  void pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, [{
    schemaVersion: 1,
    providerId: "openai-codex",
    generation: 1,
    mode: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  }]);
  assert.equal(state.state.connections.length, 0);
  assert.equal((await controller.readAuthoritySnapshot()).connections[0].state, "connecting");
  assert.doesNotMatch(JSON.stringify(prompts), /loginId|token|private|authUrl/);

  account.becomeReady();
  await pending;
  assert.equal(state.state.connections[0].providerId, "openai-codex");
  assert.equal(state.state.connections[0].state, "connected");
});

test("already-ready Direct Codex connect never invokes login and preserves an existing connection generation and receipt", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-codex", 7);
  state.state.onboarding = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 7,
    catalogGeneration: 7,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const account = new FakeDirectAccount();
  account.catalog = { generation: 3, status: "ready", models: [directAccountModel("gpt-live-sol")] };
  const controller = new ProviderController({ stateStore: state, account });
  await controller.connect({ providerId: "openai-codex" });
  assert.equal(account.starts, 1);
  assert.deepEqual(account.loginModes, []);
  assert.equal(state.state.connections[0].generation, 7);
  assert.equal(state.state.onboarding.connectionGeneration, 7);
  assert.equal(state.state.connections[0].models[0].model, "gpt-live-sol");
});

test("duplicate Direct Codex connects return one Promise and start one ceremony", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount({ signedOut: true });
  const controller = new ProviderController({ stateStore: state, account });
  const first = controller.connect(
    { providerId: "openai-codex", authMode: "browser" },
    directContext({ openExternal: async () => {} }),
  );
  const second = controller.connect(
    { providerId: "openai-codex", authMode: "browser" },
    directContext({ openExternal: async () => { throw new Error("second context must not run"); } }),
  );
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(account.loginModes, ["browser"]);
  account.becomeReady();
  await first;
});

test("Direct Codex disconnect cancels a pending ceremony and no late completion can resurrect the route", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount({ signedOut: true });
  const cliproxy = {
    disconnects: 0,
    connectProvider: async () => {},
    importVertex: async () => {},
    connectionStatus: async () => ({ state: "connected" }),
    listModels: async () => [descriptorModel("anthropic-claude")],
    disconnectProvider: async () => { cliproxy.disconnects += 1; },
  };
  const controller = new ProviderController({ stateStore: state, account, cliproxy });
  const pending = controller.connect(
    { providerId: "openai-codex", authMode: "device-code" },
    directContext({ onLoginPrompt: () => {} }),
  );
  void pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const disconnecting = controller.disconnect("openai-codex");
  await assert.rejects(pending, /cancel|supersed|unavailable/i);
  await disconnecting;
  assert.equal(account.cancelLogins, 1);
  assert.equal(cliproxy.disconnects, 0);
  account.becomeReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.state.connections.length, 0);
  assert.equal((await controller.catalog()).models.length, 0);
});

test("dispose cancels Direct login, detaches account listeners, and prevents a late connection write", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount({ signedOut: true });
  const controller = new ProviderController({ stateStore: state, account });
  const pending = controller.connect(
    { providerId: "openai-codex", authMode: "browser" },
    directContext({ openExternal: async () => {} }),
  );
  void pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose();
  await assert.rejects(pending, { code: "OPENBOT_PROVIDER_DISPOSED" });
  assert.equal(account.cancelLogins, 1);
  assert.equal(account.listenerCount("account-changed"), 0);
  assert.equal(account.listenerCount("catalog-changed"), 0);
  account.becomeReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.state.connections.length, 0);
});

test("Direct Codex disconnect never invokes CLIProxy, stages model-free authority, logs out, and clears connection plus receipt", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-codex", 1);
  state.state.onboarding = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 1,
    catalogGeneration: 1,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const account = new FakeDirectAccount();
  const cliproxy = {
    disconnects: 0,
    connectProvider: async () => {}, importVertex: async () => {},
    connectionStatus: async () => ({ state: "connected" }),
    listModels: async () => [descriptorModel("anthropic-claude")],
    disconnectProvider: async () => { cliproxy.disconnects += 1; },
  };
  const controller = new ProviderController({ stateStore: state, account, cliproxy });
  const rows = [];
  controller.on("connections-changed", (connections) => rows.push(connections[0]));
  await controller.disconnect("openai-codex");
  assert.equal(cliproxy.disconnects, 0);
  assert.equal(account.logouts, 1);
  assert.equal(rows.some((row) => row.state === "unavailable" && row.errorCode === "OPENBOT_PROVIDER_DISCONNECT_PENDING"), true);
  assert.equal(state.state.connections.length, 0);
  assert.equal(state.state.onboarding, null);
});

test("failed Direct logout remains unavailable and model-free and can retry cleanup", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-codex", 4);
  state.state.onboarding = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 4,
    catalogGeneration: 4,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const account = new FakeDirectAccount({ logoutErrors: 1 });
  const controller = new ProviderController({ stateStore: state, account });
  await assert.rejects(controller.disconnect("openai-codex"), { code: "OPENBOT_PROVIDER_DISCONNECT_FAILED" });
  assert.equal(state.state.connections[0].state, "unavailable");
  assert.deepEqual(state.state.connections[0].models, []);
  assert.equal(state.state.onboarding, null);
  await controller.disconnect("openai-codex");
  assert.equal(account.logouts, 2);
  assert.equal(state.state.connections.length, 0);
});

test("external account signed-out/offline and catalog-unavailable signals cannot leave Direct Codex connected or catalogued", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-codex", 2);
  state.state.onboarding = {
    schemaVersion: 1,
    providerId: "openai-codex",
    connectionGeneration: 2,
    catalogGeneration: 2,
    completedAt: "2026-08-19T00:00:00.000Z",
  };
  const account = new FakeDirectAccount();
  const controller = new ProviderController({ stateStore: state, account });
  account.account = { ...account.account, status: "signed-out", authMode: null, login: null };
  account.emit("account-changed", account.account);
  let snapshot = await controller.readAuthoritySnapshot();
  assert.equal(snapshot.connections[0].state, "unavailable");
  assert.equal(snapshot.catalog.models.length, 0);
  for (let attempt = 0; attempt < 10 && state.state.connections[0]?.state === "connected"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state.state.connections[0].state, "unavailable");
  assert.equal(state.state.onboarding, null);

  state.state = connectedState("openai-codex", 5);
  account.account = { ...account.account, status: "ready", authMode: "chatgpt" };
  account.catalog = { generation: 8, status: "ready", models: [directAccountModel()] };
  account.emit("account-changed", account.account);
  account.catalog = { generation: 9, status: "unavailable", models: [] };
  account.emit("catalog-changed", account.catalog);
  snapshot = await controller.readAuthoritySnapshot();
  assert.equal(snapshot.connections[0].state, "unavailable");
  assert.equal(snapshot.catalog.models.length, 0);
});

test("ready account/catalog refresh updates only an existing Direct connection and never silently creates one", async () => {
  const { ProviderController } = require(controllerPath);
  const emptyState = new FakeStateStore();
  const account = new FakeDirectAccount();
  const controller = new ProviderController({ stateStore: emptyState, account });
  account.emit("account-changed", account.account);
  account.emit("catalog-changed", account.catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emptyState.state.connections.length, 0);

  emptyState.state = connectedState("openai-codex", 6);
  account.catalog = { generation: 10, status: "ready", models: [directAccountModel("gpt-live-sol")] };
  account.emit("catalog-changed", account.catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emptyState.state.connections[0].generation, 6);
  assert.equal(emptyState.state.connections[0].models[0].model, "gpt-live-sol");
});

test("postcommit onboarding publication/readback failure returns the committed receipt without rewriting it", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("anthropic-claude", 1);
  const originalRead = state.read.bind(state);
  let reads = 0;
  state.read = async () => {
    reads += 1;
    if (reads >= 5) throw new Error("publication readback failed");
    return originalRead();
  };
  let writes = 0;
  const originalWrite = state.writeOnboarding.bind(state);
  state.writeOnboarding = async (receipt) => {
    writes += 1;
    return originalWrite(receipt);
  };
  const controller = new ProviderController({ stateStore: state, now: () => "2026-08-19T00:00:00.000Z" });
  const receipt = await controller.completeOnboarding("anthropic-claude");
  assert.deepEqual(receipt, state.state.onboarding);
  assert.equal(writes, 1);
});

test("C3 held final Direct connect read cannot return or store connected authority after account offline", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-codex", 3);
  const account = new FakeDirectAccount();
  let reads = 0;
  let releaseRead;
  const originalRead = state.read.bind(state);
  state.read = async () => {
    reads += 1;
    if (reads === 2) await new Promise((resolve) => { releaseRead = resolve; });
    return originalRead();
  };
  const controller = new ProviderController({ stateStore: state, account });
  const pending = controller.connect({ providerId: "openai-codex" });
  await new Promise((resolve) => setImmediate(resolve));
  while (typeof releaseRead !== "function") await new Promise((resolve) => setImmediate(resolve));
  account.account = { ...account.account, status: "offline", authMode: null, login: null };
  account.emit("account-changed", account.account);
  releaseRead();
  await assert.rejects(pending, /offline|unavailable|supersed/i);
  assert.notEqual(state.state.connections[0]?.state, "connected");
  assert.deepEqual(state.state.connections[0]?.models, []);
});

test("C3 held ready reconciliation cannot publish connected authority after account offline", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-codex", 2);
  const account = new FakeDirectAccount();
  let releaseCommit;
  const originalCommit = state.commitConnection.bind(state);
  state.commitConnection = async (value) => {
    if (value.providerId === "openai-codex" && value.state === "connected" && value.models.length > 0) {
      await new Promise((resolve) => { releaseCommit = resolve; });
    }
    return originalCommit(value);
  };
  const controller = new ProviderController({ stateStore: state, account });
  const events = [];
  controller.on("connections-changed", (connections) => events.push(connections[0]));
  account.catalog = { generation: 4, status: "ready", models: [directAccountModel("gpt-live-sol")] };
  account.emit("catalog-changed", account.catalog);
  while (typeof releaseCommit !== "function") await new Promise((resolve) => setImmediate(resolve));
  account.account = { ...account.account, status: "offline", authMode: null, login: null };
  account.emit("account-changed", account.account);
  releaseCommit();
  for (let attempt = 0; attempt < 20 && state.state.connections[0]?.state === "connected"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(events.some((row) => row?.state === "connected"), false);
  assert.equal(state.state.connections[0]?.state, "unavailable");
  assert.deepEqual(state.state.connections[0]?.models, []);
});

test("C4 ready reconciliation never promotes disconnected or unqualified unavailable Direct rows, but restores a qualified account marker", async () => {
  const { ProviderController } = require(controllerPath);
  const disconnectedState = new FakeStateStore();
  disconnectedState.state = {
    schemaVersion: 1,
    connections: [{ providerId: "openai-codex", generation: 5, state: "disconnected", models: [] }],
    onboarding: null,
  };
  const disconnectedAccount = new FakeDirectAccount();
  const disconnectedController = new ProviderController({ stateStore: disconnectedState, account: disconnectedAccount });
  disconnectedAccount.emit("catalog-changed", disconnectedAccount.catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnectedState.state.connections[0].state, "disconnected");
  assert.deepEqual(disconnectedState.state.connections[0].models, []);

  const unqualifiedState = new FakeStateStore();
  unqualifiedState.state = {
    schemaVersion: 1,
    connections: [{
      providerId: "openai-codex", generation: 6, state: "unavailable", errorCode: "OTHER_ERROR", models: [],
    }],
    onboarding: null,
  };
  const unqualifiedAccount = new FakeDirectAccount();
  const unqualifiedController = new ProviderController({ stateStore: unqualifiedState, account: unqualifiedAccount });
  unqualifiedAccount.emit("catalog-changed", unqualifiedAccount.catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unqualifiedState.state.connections[0].state, "unavailable");
  assert.deepEqual(unqualifiedState.state.connections[0].models, []);

  const qualifiedState = new FakeStateStore();
  qualifiedState.state = {
    schemaVersion: 1,
    connections: [{
      providerId: "openai-codex", generation: 7, state: "unavailable",
      errorCode: "OPENBOT_PROVIDER_ACCOUNT_UNAVAILABLE", models: [],
    }],
    onboarding: null,
  };
  const qualifiedAccount = new FakeDirectAccount();
  const qualifiedController = new ProviderController({ stateStore: qualifiedState, account: qualifiedAccount });
  qualifiedAccount.catalog = { generation: 8, status: "ready", models: [directAccountModel("gpt-live-sol")] };
  qualifiedAccount.emit("catalog-changed", qualifiedAccount.catalog);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(qualifiedState.state.connections[0].state, "connected");
  assert.equal(qualifiedState.state.connections[0].generation, 7);
  assert.equal(qualifiedState.state.connections[0].models[0].model, "gpt-live-sol");
  disconnectedController.dispose();
  unqualifiedController.dispose();
  qualifiedController.dispose();
});

test("I2 dispose is sentinel-first, idempotent, and awaits Direct login cancellation", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount({ signedOut: true });
  let releaseCancel;
  let cancelStarted = false;
  account.cancelLogin = async () => {
    cancelStarted = true;
    account.cancelLogins += 1;
    await new Promise((resolve) => { releaseCancel = resolve; });
    account.account = { ...account.account, status: "signed-out", authMode: null, login: null };
  };
  const controller = new ProviderController({ stateStore: state, account });
  const pending = controller.connect(
    { providerId: "openai-codex", authMode: "browser" },
    directContext({ openExternal: async () => {} }),
  );
  void pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const first = controller.dispose();
  const second = controller.dispose();
  assert.equal(first, second);
  assert.equal(typeof first?.then, "function");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelStarted, true);
  let settled = false;
  first.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseCancel();
  await first;
  assert.equal(settled, true);
  await assert.rejects(pending, { code: "OPENBOT_PROVIDER_DISPOSED" });
});

test("M1 disposal awaits the underlying provider tail rather than a public race", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  let releaseConnect;
  const cliproxy = {
    connectProvider: async () => new Promise((resolve) => { releaseConnect = resolve; }),
    importVertex: async () => {},
    connectionStatus: async () => ({ state: "connected" }),
    listModels: async () => [descriptorModel("anthropic-claude")],
    disconnectProvider: async () => {},
  };
  const controller = new ProviderController({ stateStore: state, cliproxy });
  const pending = controller.connect({ providerId: "anthropic-claude" });
  void pending.catch(() => {});
  while (typeof releaseConnect !== "function") await new Promise((resolve) => setImmediate(resolve));
  const disposing = controller.dispose();
  assert.equal(typeof disposing?.then, "function");
  let settled = false;
  disposing.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseConnect();
  await disposing;
  assert.equal(settled, true);
});

function holdConnectedCommit(state, providerId) {
  let release;
  let held = false;
  const originalCommit = state.commitConnection.bind(state);
  state.commitConnection = async (value) => {
    if (!held && value.providerId === providerId && value.state === "connected" && value.models.length > 0) {
      held = true;
      await new Promise((resolve) => { release = resolve; });
    }
    return originalCommit(value);
  };
  const control = () => release?.();
  control.isHeld = () => held;
  return control;
}

test("C5 Direct connect held commit compensates after abort", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount();
  const release = holdConnectedCommit(state, "openai-codex");
  const controller = new ProviderController({ stateStore: state, account });
  const abortController = new AbortController();
  const pending = controller.connect({ providerId: "openai-codex", signal: abortController.signal });
  while (!release.isHeld()) await new Promise((resolve) => setImmediate(resolve));
  // The held writer is reached asynchronously; release is intentionally only
  // called after the abort to pressure the post-write signal fence.
  abortController.abort();
  release();
  await assert.rejects(pending, /cancel|supersed|unavailable/i);
  const row = state.state.connections.find(({ providerId }) => providerId === "openai-codex");
  assert.notEqual(row?.state, "connected");
  assert.deepEqual(row?.models || [], []);
});

test("C5 Direct connect held commit compensates after disposal", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  const account = new FakeDirectAccount();
  const release = holdConnectedCommit(state, "openai-codex");
  const controller = new ProviderController({ stateStore: state, account });
  const pending = controller.connect({ providerId: "openai-codex" });
  void pending.catch(() => {});
  while (!release.isHeld()) await new Promise((resolve) => setImmediate(resolve));
  const disposing = controller.dispose();
  release();
  await disposing;
  await assert.rejects(pending, { code: "OPENBOT_PROVIDER_DISPOSED" });
  const row = state.state.connections.find(({ providerId }) => providerId === "openai-codex");
  assert.notEqual(row?.state, "connected");
  assert.deepEqual(row?.models || [], []);
});

test("C5 Direct reconciliation held commit compensates after disposal", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("openai-codex", 5);
  const account = new FakeDirectAccount();
  const release = holdConnectedCommit(state, "openai-codex");
  const controller = new ProviderController({ stateStore: state, account });
  account.catalog = { generation: 9, status: "ready", models: [directAccountModel("gpt-live-sol")] };
  account.emit("catalog-changed", account.catalog);
  while (!release.isHeld()) await new Promise((resolve) => setImmediate(resolve));
  const disposing = controller.dispose();
  release();
  await disposing;
  const row = state.state.connections.find(({ providerId }) => providerId === "openai-codex");
  assert.notEqual(row?.state, "connected");
  assert.deepEqual(row?.models || [], []);
});

test("C5 Direct held commit remains fail-closed across offline and disconnect signals", async () => {
  const { ProviderController } = require(controllerPath);
  for (const mode of ["offline", "disconnect"]) {
    const state = new FakeStateStore();
    const account = new FakeDirectAccount();
    const release = holdConnectedCommit(state, "openai-codex");
    const controller = new ProviderController({ stateStore: state, account });
    const pending = controller.connect({ providerId: "openai-codex" });
    void pending.catch(() => {});
    while (!release.isHeld()) await new Promise((resolve) => setImmediate(resolve));
    const followup = mode === "offline"
      ? (() => {
        account.account = { ...account.account, status: "offline", authMode: null };
        account.emit("account-changed", account.account);
        return Promise.resolve();
      })()
      : controller.disconnect("openai-codex");
    release();
    await followup.catch(() => {});
    await pending.catch(() => {});
    if (mode === "disconnect") await controller.dispose();
    const row = state.state.connections.find(({ providerId }) => providerId === "openai-codex");
    assert.notEqual(row?.state, "connected");
    assert.deepEqual(row?.models || [], []);
    if (mode === "offline") controller.dispose();
  }
});

test("C5 hosted/API/local held commits compensate after abort and disposal without foreign cleanup", async (t) => {
  const { ProviderController } = require(controllerPath);
  const cases = [
    {
      name: "hosted Claude",
      providerId: "anthropic-claude",
      request: { providerId: "anthropic-claude" },
      dependencies: (state) => ({
        cliproxy: {
          disconnects: 0,
          connectProvider: async () => {}, importVertex: async () => {},
          connectionStatus: async () => ({ state: "connected" }),
          listModels: async () => [descriptorModel("anthropic-claude")],
          disconnectProvider: async () => {},
        },
      }),
    },
    {
      name: "OpenAI API key",
      providerId: "openai-api-key",
      request: { providerId: "openai-api-key", apiKey: "sk-test" },
      dependencies: () => ({
        openai: {
          discover: async () => ({ models: [{ provider: "openai-api-key", model: "gpt-live", label: "Live" }] }),
          streamConfiguration: () => ({ providerId: "openai-api-key", baseUrl: "https://api.openai.com/v1", apiKey: null }),
        },
      }),
    },
    {
      name: "local OpenAI-compatible",
      providerId: "local-openai-compatible",
      request: { providerId: "local-openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" },
      dependencies: () => ({
        openai: {
          discover: async () => ({ models: [{ provider: "local-openai-compatible", model: "local-model", label: "Local" }] }),
          streamConfiguration: () => ({ providerId: "local-openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", apiKey: null }),
        },
      }),
    },
  ];
  for (const entry of cases) {
    await t.test(`${entry.name} abort`, async () => {
      const state = new FakeStateStore();
      const abortController = new AbortController();
      const dependencies = entry.dependencies(state);
      const release = holdConnectedCommit(state, entry.providerId);
      const controller = new ProviderController({ stateStore: state, ...dependencies });
      const pending = controller.connect({ ...entry.request, signal: abortController.signal });
      void pending.catch(() => {});
      while (!release.isHeld()) await new Promise((resolve) => setImmediate(resolve));
      abortController.abort();
      release();
      await assert.rejects(pending, /cancel|supersed|unavailable/i);
      const row = state.state.connections.find(({ providerId }) => providerId === entry.providerId);
      assert.notEqual(row?.state, "connected");
      assert.deepEqual(row?.models || [], []);
      controller.dispose();
    });
    await t.test(`${entry.name} disposal`, async () => {
      const state = new FakeStateStore();
      const dependencies = entry.dependencies(state);
      const release = holdConnectedCommit(state, entry.providerId);
      const controller = new ProviderController({ stateStore: state, ...dependencies });
      const pending = controller.connect(entry.request);
      void pending.catch(() => {});
      while (!release.isHeld()) await new Promise((resolve) => setImmediate(resolve));
      const disposing = controller.dispose();
      release();
      await disposing;
      await assert.rejects(pending, { code: "OPENBOT_PROVIDER_DISPOSED" });
      const row = state.state.connections.find(({ providerId }) => providerId === entry.providerId);
      assert.notEqual(row?.state, "connected");
      assert.deepEqual(row?.models || [], []);
    });
  }
});

test("I3 onboarding write acknowledgement survives disposal during held post-write publication", async () => {
  const { ProviderController } = require(controllerPath);
  const state = new FakeStateStore();
  state.state = connectedState("anthropic-claude", 1);
  let reads = 0;
  let releasePublication;
  const originalRead = state.read.bind(state);
  state.read = async () => {
    reads += 1;
    if (reads === 5) await new Promise((resolve) => { releasePublication = resolve; });
    return originalRead();
  };
  let writes = 0;
  const originalWrite = state.writeOnboarding.bind(state);
  state.writeOnboarding = async (receipt) => {
    writes += 1;
    return originalWrite(receipt);
  };
  const controller = new ProviderController({ stateStore: state, now: () => "2026-08-19T00:00:00.000Z" });
  const pending = controller.completeOnboarding("anthropic-claude");
  while (typeof releasePublication !== "function") await new Promise((resolve) => setImmediate(resolve));
  const disposing = controller.dispose();
  releasePublication();
  const receipt = await pending;
  await disposing;
  assert.deepEqual(receipt, state.state.onboarding);
  assert.equal(writes, 1);
});
