"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runtimePath = path.join(__dirname, "..", "src", "desktop", "runtime.cjs");
const selectionPath = path.join(__dirname, "..", "src", "desktop", "model-selection-store.cjs");
const runtimeConfigPath = path.join(__dirname, "..", "src", "bridge", "runtime-config.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";

function readyCatalog(generation = 7) {
  const entry = (id, efforts, defaultReasoningEffort = efforts[0], isDefault = false) => Object.freeze({
    id,
    displayName: id,
    defaultReasoningEffort,
    supportedReasoningEfforts: Object.freeze(efforts),
    inputModalities: Object.freeze(["text", "image"]),
    supportsPersonality: false,
    isDefault,
  });
  return Object.freeze({
    generation,
    status: "ready",
    models: Object.freeze([
      entry("gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium", true),
      entry("gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
      entry("gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"], "medium"),
    ]),
  });
}

function accountWithCatalog(catalog = readyCatalog(), onStart = async () => {}) {
  return {
    async start() { return onStart(); },
    accountState() { return Object.freeze({}); },
    catalogState() { return catalog; },
    async login() { throw new Error("unused"); },
    async cancelLogin() {},
    async logout() {},
    async refresh() {},
    on() {},
    off() {},
    dispose() {},
  };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-desktop-runtime-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("desktop runtime loads only an exact sealed sidecar receipt", (t) => {
  const { loadSidecarReceipt } = require(runtimePath);
  const root = tempRoot(t);
  const sidecarRoot = path.join(root, "codex", "cliproxy");
  fs.mkdirSync(sidecarRoot, { recursive: true });
  fs.writeFileSync(path.join(sidecarRoot, "receipt.json"), JSON.stringify({
    bytes: 58169264,
    sha256: "d".repeat(64),
  }));
  assert.deepEqual(loadSidecarReceipt(root), {
    bytes: 58169264,
    sha256: "d".repeat(64),
  });
  assert.equal(Object.isFrozen(loadSidecarReceipt(root)), true);
  fs.writeFileSync(path.join(sidecarRoot, "receipt.json"), JSON.stringify({
    bytes: 58169264,
    sha256: "d".repeat(64),
    endpoint: "private",
  }));
  assert.throws(() => loadSidecarReceipt(root), /receipt/i);
  fs.rmSync(path.join(sidecarRoot, "receipt.json"));
  fs.symlinkSync(path.join(root, "outside.json"), path.join(sidecarRoot, "receipt.json"));
  assert.throws(() => loadSidecarReceipt(root), /receipt/i);
});

test("desktop factories own direct Codex immediately but keep CLIProxy entirely lazy", async (t) => {
  const {
    createDirectCodexManager,
    createInferenceBridgeRuntime,
    createLazySidecarManager,
  } = require(runtimePath);
  const root = tempRoot(t);
  const resourcesPath = path.join(root, "OpenBot.app", "Contents", "Resources");
  const stateRoot = path.join(root, "state");
  const homeDirectory = path.join(root, "home");
  const directCalls = [];
  class DirectFixture {
    constructor(options) { directCalls.push(options); }
  }
  const direct = createDirectCodexManager({
    resourcesPath,
    stateRoot,
    environment: { HOME: homeDirectory, OPENAI_API_KEY: "must-not-forward" },
    ManagerClass: DirectFixture,
  });
  assert.equal(direct instanceof DirectFixture, true);
  assert.deepEqual(directCalls, [{
    resourcesPath,
    stateRoot: path.join(stateRoot, "direct-codex"),
    environment: { HOME: homeDirectory, OPENAI_API_KEY: "must-not-forward" },
    clientVersion: "0.2.0-macos.1",
  }]);

  const sidecarCalls = [];
  let receiptReads = 0;
  let managerCreations = 0;
  let providerConnections = 0;
  let starts = 0;
  let stops = 0;
  class SidecarFixture {
    constructor(options) { managerCreations += 1; sidecarCalls.push(options); }
    async connectProvider(provider) { providerConnections += 1; assert.equal(provider, "claude"); }
    async start() { starts += 1; return "optional-session"; }
    stop() { stops += 1; }
  }
  const lazy = createLazySidecarManager({
    resourcesPath,
    stateRoot,
    loadReceipt() {
      receiptReads += 1;
      return { bytes: 123, sha256: "a".repeat(64) };
    },
    ManagerClass: SidecarFixture,
  });
  assert.equal(receiptReads, 0);
  assert.equal(managerCreations, 0);
  assert.equal(starts, 0);
  assert.equal(fs.existsSync(path.join(stateRoot, "cliproxy")), false);
  assert.equal(await lazy.connectProvider("claude"), undefined);
  assert.equal(await lazy.start(), "optional-session");
  assert.equal(receiptReads, 1);
  assert.equal(managerCreations, 1);
  assert.equal(providerConnections, 1);
  assert.equal(starts, 1);
  assert.deepEqual(sidecarCalls, [{
    binaryPath: path.join(resourcesPath, "codex", "cliproxy", "cli-proxy-api"),
    stateRoot: path.join(stateRoot, "cliproxy"),
    expectedBinaryBytes: 123,
    expectedBinarySha256: "a".repeat(64),
  }]);
  lazy.stop();
  assert.equal(stops, 1);

  const constructed = [];
  class DirectTransportFixture {
    constructor(options) { this.kind = "direct"; constructed.push(["direct", options]); }
  }
  class OptionalTransportFixture {
    constructor(options) { this.kind = "optional"; constructed.push(["optional", options]); }
  }
  class RouterFixture {
    constructor(options) { this.options = options; constructed.push(["router", options]); }
    stream() {}
  }
  class BridgeFixture {
    constructor(options) { this.options = options; constructed.push(["bridge", options]); }
  }
  const selectionStore = {
    async read(botId) {
      return {
        botId,
        provider: botId === BOT_A ? "openai-codex" : "cliproxy-anthropic",
        model: botId === BOT_A ? "gpt-5.6-sol" : "claude-fable-5",
        reasoningEffort: botId === BOT_A ? "ultra" : "ultra-code",
        serviceTier: null,
        catalogGeneration: botId === BOT_A ? 7 : 1,
        generation: 4,
      };
    },
  };
  const inference = createInferenceBridgeRuntime({
    codexManager: direct,
    selectionStore,
    sidecarManager: lazy,
    computerTargetRouter: { async resolve() {} },
    stateRoot,
    capability: "b".repeat(64),
    DirectTransportClass: DirectTransportFixture,
    OptionalTransportClass: OptionalTransportFixture,
    RouterClass: RouterFixture,
    BridgeClass: BridgeFixture,
  });
  assert.equal(inference instanceof BridgeFixture, true);
  assert.deepEqual(constructed.map(([name]) => name), ["direct", "router", "bridge"]);
  assert.equal(constructed[0][1].manager, direct);
  assert.equal(constructed[0][1].workspacePath, path.join(stateRoot, "direct-codex", "empty-workspace"));
  assert.equal(constructed[2][1].capability, "b".repeat(64));
  assert.equal(typeof constructed[2][1].computerTargetRouter.resolve, "function");
  assert.deepEqual(await constructed[1][1].readSelection(BOT_A), {
    botId: BOT_A,
    generation: 4,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
  });
  const optionalBot = "bot-22222222-2222-4222-8222-222222222222";
  assert.deepEqual(await constructed[1][1].readSelection(optionalBot), {
    botId: optionalBot,
    generation: 4,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
  });
  const optional = await constructed[1][1].createOptionalTransport("cliproxy-anthropic");
  assert.equal(optional.kind, "optional");
  assert.equal(starts, 2);
  assert.deepEqual(constructed.map(([name]) => name), ["direct", "router", "bridge", "optional"]);
});

test("production direct Codex snapshots the host environment into a plain launch DTO", (t) => {
  const { createDirectCodexManager } = require(runtimePath);
  const { CodexAppServerManager } = require(path.join(__dirname, "..", "src", "desktop", "codex-app-server-manager.cjs"));
  const root = tempRoot(t);
  const manager = createDirectCodexManager({
    resourcesPath: path.join(root, "OpenBot.app", "Contents", "Resources"),
    stateRoot: path.join(root, "state"),
  });
  assert.equal(manager instanceof CodexAppServerManager, true);
  manager.stop();
});

test("desktop runtime registers the exact frozen bot/model boundary and keeps create zero-argument", async (t) => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const sends = [];
  const calls = [];
  const listeners = new Map();
  const bot = Object.freeze({
    botId: BOT_A,
    name: "New Bot",
    setupStage: "profile-model",
    runtime: Object.freeze({ state: "ready" }),
  });
  const controller = {
    on(event, listener) { listeners.set(event, listener); },
    async listBots() { calls.push(["list"]); return [bot]; },
    async createBot() { calls.push(["create", arguments.length]); return bot; },
    async readBot(botId) { calls.push(["read", botId]); return bot; },
    async renameBot(botId, name) { calls.push(["rename", botId, name]); return { ...bot, name }; },
    async updateProfile(botId, profile) { calls.push(["profile", botId, profile]); return bot; },
    async advanceSetup(botId, transition) {
      calls.push(["advance-setup", botId, transition]);
      return Object.freeze({ ...bot, setupStage: transition.nextStage });
    },
    async retryRuntime(botId) { calls.push(["retry", botId]); return bot; },
    async runtimeSession(botId) {
      calls.push(["session", botId]);
      return Object.freeze({
        provider: "fixture",
        runtimeId: "runtime-a",
        endpoint: "wss://runtime.invalid/app-server",
        authToken: "opaque-private-token-value",
        generation: 7,
      });
    },
    dispose() { calls.push(["dispose"]); },
  };
  let storedSelection = null;
  const selectionStore = {
    async selectBot(botId) { calls.push(["activate-model-bot", botId]); return botId; },
    async ensure(botId, fallback) {
      const selection = { botId, ...fallback, generation: 0 };
      calls.push(["ensure-model", selection]);
      storedSelection ??= selection;
      return storedSelection;
    },
    async writeNext(selection) {
      const previous = calls.filter(([name]) => name === "select-model").length;
      const next = { ...selection, generation: previous + 1 };
      calls.push(["select-model", next]);
      storedSelection = next;
      return storedSelection;
    },
    async read(botId) { calls.push(["read-model", botId]); return storedSelection; },
  };
  const sidecarManager = {
    async connectProvider(provider) { calls.push(["connect-provider", provider]); return undefined; },
    async start() {
      calls.push(["sidecar-start"]);
      const session = { endpoint: "http://127.0.0.1:54321/v1" };
      Object.defineProperty(session, "credential", { value: "f".repeat(64), enumerable: false });
      return Object.freeze(session);
    },
    stop() { calls.push(["sidecar-stop"]); },
  };
  const codexManager = {
    async start() { calls.push(["direct-start"]); },
    stop() { calls.push(["direct-stop"]); },
  };
  let setupCatalog = readyCatalog();
  const setupAccount = accountWithCatalog(setupCatalog, () => codexManager.start());
  setupAccount.catalogState = () => setupCatalog;
  const inferenceBridge = {
    async start() {
      calls.push(["inference-bridge-start"]);
      const session = { endpoint: "tcp://127.0.0.1:43210" };
      Object.defineProperty(session, "capability", { value: "a".repeat(64), enumerable: false });
      return Object.freeze(session);
    },
    dispose() { calls.push(["inference-bridge-dispose"]); },
  };
  t.after(() => {
    delete process.env.CODEX_BOT_CLIPROXY_URL;
    delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
    delete process.env.CODEX_BOT_INFERENCE_ENDPOINT;
    delete process.env.CODEX_BOT_INFERENCE_CAPABILITY;
  });
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false);
        handlers.set(channel, handler);
      },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      getAllWindows() {
        return [{ webContents: { isDestroyed: () => false, send: (...args) => sends.push(args) } }];
      },
    },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore,
    accountController: setupAccount,
    sidecarManager,
    codexManager,
    inferenceBridge,
  });
  assert.deepEqual(Object.keys(IPC_CHANNELS).sort(), [
    "accountCancelLogin", "accountLogin", "accountLogout", "accountRead", "accountRetry", "adoptLegacy", "advanceSetup",
    "catalogList", "computerRead", "computerSelectMode", "connectProvider", "create", "list",
    "permissionDecide", "permissionRequestsList", "permissionRevoke", "permissionsList", "read", "readModel", "rename",
    "retryRuntime", "selectBot", "selectModel", "updateProfile",
  ]);
  assert.equal(handlers.size, 24);
  assert.equal(Object.isFrozen(installed), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter(([name]) => name === "direct-start"), [["direct-start"]]);
  assert.deepEqual(calls.filter(([name]) => name === "sidecar-start"), []);
  assert.deepEqual(calls.filter(([name]) => name === "inference-bridge-start"), [["inference-bridge-start"]]);
  assert.equal(process.env.CODEX_BOT_INFERENCE_ENDPOINT, "tcp://127.0.0.1:43210");
  assert.equal(process.env.CODEX_BOT_INFERENCE_CAPABILITY, "a".repeat(64));

  await handlers.get(IPC_CHANNELS.create)({ sender: {} });
  assert.deepEqual(calls.find(([name]) => name === "create"), ["create", 0]);
  await handlers.get(IPC_CHANNELS.selectBot)({}, BOT_A);
  assert.deepEqual(calls.find(([name]) => name === "ensure-model"), [
    "ensure-model",
    {
      botId: BOT_A,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      serviceTier: null,
      catalogGeneration: 7,
      generation: 0,
    },
  ]);
  assert.deepEqual(calls.find(([name]) => name === "activate-model-bot"), ["activate-model-bot", BOT_A]);
  const profileTransition = {
    botId: BOT_A,
    expectedStage: "profile-model",
    nextStage: "computer",
  };
  await assert.rejects(handlers.get(IPC_CHANNELS.advanceSetup)({}, profileTransition), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  assert.equal(calls.filter(([name]) => name === "advance-setup").length, 0);
  await handlers.get(IPC_CHANNELS.rename)({}, BOT_A, "Research Bot");
  await handlers.get(IPC_CHANNELS.updateProfile)({}, BOT_A, {
    appearance: { description: "Find exact primary sources." },
  });
  const selected = await handlers.get(IPC_CHANNELS.selectModel)({}, {
    botId: BOT_A,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  });
  assert.deepEqual(selected, {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 1,
  });
  assert.doesNotMatch(JSON.stringify(selected), /endpoint|authToken|opaque-private|runtime-a/);
  setupCatalog = readyCatalog(8);
  await assert.rejects(handlers.get(IPC_CHANNELS.advanceSetup)({}, profileTransition), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  assert.equal(calls.filter(([name]) => name === "advance-setup").length, 0);
  const refreshed = await handlers.get(IPC_CHANNELS.selectModel)({}, {
    botId: BOT_A,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  });
  assert.equal(refreshed.catalogGeneration, 8);
  assert.equal(refreshed.generation, 2);
  assert.equal((await handlers.get(IPC_CHANNELS.advanceSetup)({}, profileTransition)).setupStage, "computer");
  assert.deepEqual(calls.find(([name]) => name === "advance-setup"), [
    "advance-setup",
    BOT_A,
    { expectedStage: "profile-model", nextStage: "computer" },
  ]);
  const hostileTransition = new Proxy({}, {
    getPrototypeOf() { throw new Error("/Users/private token=secret"); },
  });
  await assert.rejects(handlers.get(IPC_CHANNELS.advanceSetup)({}, hostileTransition), (error) => (
    error?.code === "CODEX_BOT_OPERATION_FAILED"
      && !/Users|token|secret/i.test(error?.message)
  ));
  assert.equal(calls.filter(([name]) => name === "advance-setup").length, 1);
  assert.equal(await handlers.get(IPC_CHANNELS.connectProvider)({}, "claude"), undefined);
  assert.deepEqual(calls.find(([name]) => name === "connect-provider"), ["connect-provider", "claude"]);
  await assert.rejects(handlers.get(IPC_CHANNELS.connectProvider)({}, "codex"), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  assert.equal(calls.filter(([name]) => name === "connect-provider").length, 1);
  assert.equal(calls.find(([name]) => name === "sidecar-start"), undefined);
  assert.equal(process.env.CODEX_BOT_CLIPROXY_URL, undefined);
  assert.equal(process.env.CODEX_BOT_CLIPROXY_TOKEN, undefined);
  listeners.get("bot-changed")({ botId: BOT_A, bot });
  assert.deepEqual(sends, [["codex-bot:changed", bot]]);
  listeners.get("runtime-changed")({
    botId: BOT_A,
    runtime: { state: "reconnecting" },
    generation: 8,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sends.at(-1), ["codex-bot:changed", bot]);
  await installed.dispose();
  assert.equal(process.env.CODEX_BOT_CLIPROXY_URL, undefined);
  assert.equal(process.env.CODEX_BOT_CLIPROXY_TOKEN, undefined);
  assert.equal(process.env.CODEX_BOT_INFERENCE_ENDPOINT, undefined);
  assert.equal(process.env.CODEX_BOT_INFERENCE_CAPABILITY, undefined);
  assert.equal(handlers.size, 0);
  assert.deepEqual(calls.slice(-4), [
    ["inference-bridge-dispose"], ["direct-stop"], ["sidecar-stop"], ["dispose"],
  ]);
});

test("setup completion consumes a fresh authoritative Computer selection for the same bot", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const calls = [];
  const computer = Object.freeze({
    mode: "local",
    generation: 4,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  });
  let record = Object.freeze({
    botId: BOT_A,
    name: "Research Bot",
    setupStage: "computer",
    runtime: Object.freeze({ state: "ready" }),
    computer,
  });
  const controller = {
    on() {},
    off() {},
    async readBot(botId) { assert.equal(botId, BOT_A); return record; },
    async advanceSetup(botId, transition) {
      calls.push(["advance", botId, transition]);
      record = Object.freeze({ ...record, setupStage: transition.nextStage });
      return record;
    },
    dispose() {},
  };
  const computerBoundary = {
    async selectMode(value) {
      calls.push(["select-mode", value]);
      return Object.freeze({ botId: value.botId, computer });
    },
    dispose() {},
  };
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send() {} },
  };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(sender) { return sender === window.webContents ? window : null; },
      getAllWindows() { return [window]; },
    },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore: {},
    computerBoundary,
    codexManager: { async start() {}, stop() {} },
  });
  const transition = { botId: BOT_A, expectedStage: "computer", nextStage: "complete" };
  await assert.rejects(handlers.get(IPC_CHANNELS.advanceSetup)({}, transition), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  assert.deepEqual(calls, []);
  await assert.rejects(
    handlers.get(IPC_CHANNELS.computerSelectMode)(
      { sender: window.webContents },
      { botId: BOT_A, mode: "not-now" },
    ),
    { code: "OPENBOT_COMPUTER_OPERATION_FAILED" },
  );
  await assert.rejects(handlers.get(IPC_CHANNELS.advanceSetup)({}, transition), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  assert.deepEqual(calls, [["select-mode", { botId: BOT_A, mode: "not-now" }]]);
  await handlers.get(IPC_CHANNELS.computerSelectMode)(
    { sender: window.webContents },
    { botId: BOT_A, mode: "local" },
  );
  assert.equal((await handlers.get(IPC_CHANNELS.advanceSetup)({}, transition)).setupStage, "complete");
  assert.deepEqual(calls, [
    ["select-mode", { botId: BOT_A, mode: "not-now" }],
    ["select-mode", { botId: BOT_A, mode: "local" }],
    ["advance", BOT_A, { expectedStage: "computer", nextStage: "complete" }],
  ]);
  await assert.rejects(handlers.get(IPC_CHANNELS.advanceSetup)({}, transition), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  assert.equal(calls.length, 3, "the same Computer receipt cannot complete setup twice");
  await installed.dispose();
});

test("profile setup cannot commit after its authoritative catalog receipt changes in flight", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  let catalog = readyCatalog(7);
  let selected = null;
  let record = Object.freeze({
    botId: BOT_A,
    name: "New Bot",
    setupStage: "profile-model",
    runtime: Object.freeze({ state: "ready" }),
    computer: Object.freeze({
      mode: "not-now", generation: 0, localProfileId: null, nativeAgentId: null,
      state: "unconfigured", lastConfirmedAt: null, lastErrorCode: null,
    }),
  });
  let releaseAdvance;
  let enteredAdvance;
  const entered = new Promise((resolve) => { enteredAdvance = resolve; });
  const gate = new Promise((resolve) => { releaseAdvance = resolve; });
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot() { return record; },
    async renameBot(_botId, name) { record = Object.freeze({ ...record, name }); return record; },
    async updateProfile() { return record; },
    async advanceSetup(_botId, transition, fence) {
      enteredAdvance();
      await gate;
      if (typeof fence === "function") fence(record);
      record = Object.freeze({ ...record, setupStage: transition.nextStage });
      return record;
    },
  };
  const selectionStore = {
    async writeNext(value) {
      selected = Object.freeze({ ...value, generation: (selected?.generation ?? 0) + 1 });
      return selected;
    },
    async read() { return selected; },
  };
  const accountController = { ...accountWithCatalog(), catalogState() { return catalog; } };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows() { return []; } },
  };
  const installed = installDesktopRuntime(electron, {
    controller, selectionStore, accountController,
    codexManager: { async start() {}, stop() {} },
  });
  await handlers.get(IPC_CHANNELS.rename)({}, BOT_A, "Research Bot");
  await handlers.get(IPC_CHANNELS.updateProfile)({}, BOT_A, {
    appearance: { description: "Review primary sources." },
  });
  await handlers.get(IPC_CHANNELS.selectModel)({}, {
    botId: BOT_A,
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  const pending = handlers.get(IPC_CHANNELS.advanceSetup)({}, {
    botId: BOT_A,
    expectedStage: "profile-model",
    nextStage: "computer",
  });
  await Promise.race([
    entered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("selection barrier was not entered")), 100)),
  ]);
  catalog = readyCatalog(8);
  releaseAdvance();
  await assert.rejects(pending, { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(record.setupStage, "profile-model");
  assert.equal(selected.catalogGeneration, 7);
  assert.equal(catalog.generation, 8);
  await installed.dispose();
});

test("Computer setup cannot commit after its authoritative target changes in flight", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const computer = Object.freeze({
    mode: "local", generation: 4,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null, state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z", lastErrorCode: null,
  });
  let record = Object.freeze({
    botId: BOT_A, name: "Research Bot", setupStage: "computer",
    runtime: Object.freeze({ state: "ready" }), computer,
  });
  let releaseAdvance;
  let enteredAdvance;
  const entered = new Promise((resolve) => { enteredAdvance = resolve; });
  const gate = new Promise((resolve) => { releaseAdvance = resolve; });
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot() { return record; },
    async advanceSetup(_botId, transition, fence) {
      enteredAdvance();
      await gate;
      if (typeof fence === "function") fence(record);
      record = Object.freeze({ ...record, setupStage: transition.nextStage });
      return record;
    },
  };
  const computerBoundary = {
    async selectMode(value) { return Object.freeze({ botId: value.botId, computer }); },
    dispose() {},
  };
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send() {} },
  };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(sender) { return sender === window.webContents ? window : null; },
      getAllWindows() { return [window]; },
    },
  };
  const installed = installDesktopRuntime(electron, {
    controller, selectionStore: {}, computerBoundary,
    codexManager: { async start() {}, stop() {} },
  });
  await handlers.get(IPC_CHANNELS.computerSelectMode)(
    { sender: window.webContents },
    { botId: BOT_A, mode: "local" },
  );
  const pending = handlers.get(IPC_CHANNELS.advanceSetup)({}, {
    botId: BOT_A,
    expectedStage: "computer",
    nextStage: "complete",
  });
  await entered;
  record = Object.freeze({ ...record, computer: Object.freeze({ ...computer, generation: 5 }) });
  releaseAdvance();
  await assert.rejects(pending, { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(record.setupStage, "computer");
  assert.equal(record.computer.generation, 5);
  await installed.dispose();
});

test("desktop exposes exact local computer methods and rejects hostile IPC before private effects", async () => {
  const {
    COMPUTER_CHANGE_CHANNEL,
    COMPUTER_PERMISSION_CHANNEL,
    installDesktopRuntime,
    IPC_CHANNELS,
  } = require(runtimePath);
  const handlers = new Map();
  const listeners = new Map();
  const sends = [];
  const calls = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args) => sends.push(args),
    },
  };
  const sender = window.webContents;
  const computer = Object.freeze({
    mode: "local",
    generation: 1,
    localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-15T12:34:56.000Z",
    lastErrorCode: null,
  });
  const grant = Object.freeze({
    grantId: "grant-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    botId: BOT_A,
    capability: "filesystem.read",
    resourceId: "folder-a",
    resourceLabel: "Folder A",
    scope: "always",
    createdAt: "2026-08-15T12:34:56.000Z",
  });
  const prompt = Object.freeze({
    requestId: "permission-11111111-1111-4111-8111-111111111111",
    botId: BOT_A,
    targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetGeneration: 1,
    capability: "filesystem.read",
    resourceLabel: "Folder A",
    reason: "Read an approved file",
  });
  const resultOverrides = Object.create(null);
  const resultOr = (name, fallback) => (
    Object.prototype.hasOwnProperty.call(resultOverrides, name) ? resultOverrides[name] : fallback
  );
  const computerBoundary = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    async selectMode(value) {
      calls.push(["select-mode", value]);
      return resultOr("select", { botId: value.botId, computer });
    },
    async read(botId) {
      calls.push(["computer-read", botId]);
      return resultOr("read", { botId, computer });
    },
    async decidePermission(value) {
      calls.push(["permission-decide", value]);
      return resultOr("decide", { botId: value.botId, permissions: [grant] });
    },
    async listPermissions(botId) {
      calls.push(["permissions-list", botId]);
      return resultOr("permissions", { botId, permissions: [grant] });
    },
    async listPermissionRequests(botId) {
      calls.push(["permission-requests-list", botId]);
      return resultOr("requests", { botId, requests: [prompt] });
    },
    async revokePermission(value) {
      calls.push(["permission-revoke", value]);
      return resultOr("revoke", { botId: value.botId, permissions: [] });
    },
    dispose() { calls.push(["computer-dispose"]); },
  };
  const controller = { on() {}, off() {}, dispose() {} };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(value) { return value === sender ? window : null; },
      getAllWindows: () => [window],
    },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore: {},
    computerBoundary,
    codexManager: { async start() {}, stop() {} },
  });
  const event = { sender };
  const selected = await handlers.get(IPC_CHANNELS.computerSelectMode)(event, { botId: BOT_A, mode: "local" });
  assert.deepEqual(selected, { botId: BOT_A, computer });
  assert.equal(Object.isFrozen(selected), true);
  const computerReadHandler = handlers.get(IPC_CHANNELS.computerRead);
  assert.deepEqual(await computerReadHandler(event, BOT_A), { botId: BOT_A, computer });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.permissionsList)(event, BOT_A), {
    botId: BOT_A,
    permissions: [grant],
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.permissionRequestsList)(event, BOT_A), {
    botId: BOT_A,
    requests: [prompt],
  });
  const shellPrompt = Object.freeze({
    ...prompt,
    capability: "shell.execute",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
    command: "printf 'exact command'\n/usr/bin/true",
    allowsAlways: false,
  });
  resultOverrides.requests = { botId: BOT_A, requests: [shellPrompt] };
  assert.deepEqual(await handlers.get(IPC_CHANNELS.permissionRequestsList)(event, BOT_A), {
    botId: BOT_A,
    requests: [shellPrompt],
  });
  delete resultOverrides.requests;
  const permissionDecideHandler = handlers.get(IPC_CHANNELS.permissionDecide);
  const decision = {
    requestId: "permission-11111111-1111-4111-8111-111111111111",
    botId: BOT_A,
    targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    targetGeneration: 1,
    decision: "once",
  };
  assert.deepEqual(await permissionDecideHandler(event, decision), {
    botId: BOT_A,
    permissions: [grant],
  });
  const permissionRevokeHandler = handlers.get(IPC_CHANNELS.permissionRevoke);
  assert.deepEqual(await permissionRevokeHandler(event, { botId: BOT_A, grantId: grant.grantId }), {
    botId: BOT_A,
    permissions: [],
  });
  assert.equal(calls.length, 7);

  await assert.rejects(
    handlers.get(IPC_CHANNELS.computerSelectMode)(event, new Proxy({}, {
      ownKeys() { throw new Error("private /Users/person token"); },
    })),
    (error) => {
      assert.equal(error.code, "OPENBOT_COMPUTER_OPERATION_FAILED");
      assert.doesNotMatch(String(error), /Users|private|token/);
      return true;
    },
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.computerRead)({ sender: {} }, BOT_A),
    { code: "OPENBOT_COMPUTER_OPERATION_FAILED" },
  );
  assert.equal(calls.length, 7);
  resultOverrides.read = { botId: BOT_A, computer, unexpected: true };
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  delete resultOverrides.read;
  assert.equal(calls.length, 8);

  let accessorReads = 0;
  resultOverrides.read = Object.defineProperty({ botId: BOT_A }, "computer", {
    enumerable: true,
    get() { accessorReads += 1; return computer; },
  });
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  assert.equal(accessorReads, 0);
  resultOverrides.read = { botId: BOT_A, computer: { ...computer, unexpected: true } };
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  resultOverrides.read = { botId: BOT_B, computer };
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  resultOverrides.read = Object.assign(Object.create({ inherited: true }), { botId: BOT_A, computer });
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  resultOverrides.read = { botId: BOT_A, computer, [Symbol("private")]: true };
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  delete resultOverrides.read;

  const permissionsHandler = handlers.get(IPC_CHANNELS.permissionsList);
  const sparsePermissions = [];
  sparsePermissions.length = 1;
  resultOverrides.permissions = { botId: BOT_A, permissions: sparsePermissions };
  await assert.rejects(permissionsHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  const accessorPermissions = [];
  Object.defineProperty(accessorPermissions, "0", {
    enumerable: true,
    get() { accessorReads += 1; return grant; },
  });
  resultOverrides.permissions = { botId: BOT_A, permissions: accessorPermissions };
  await assert.rejects(permissionsHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  assert.equal(accessorReads, 0);
  resultOverrides.permissions = { botId: BOT_A, permissions: [{ ...grant, unexpected: true }] };
  await assert.rejects(permissionsHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  resultOverrides.permissions = { botId: BOT_B, permissions: [{ ...grant, botId: BOT_B }] };
  await assert.rejects(permissionsHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  delete resultOverrides.permissions;

  const requestsHandler = handlers.get(IPC_CHANNELS.permissionRequestsList);
  resultOverrides.requests = { botId: BOT_A, requests: [{ ...prompt, extra: true }] };
  await assert.rejects(requestsHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  resultOverrides.requests = { botId: BOT_B, requests: [{ ...prompt, botId: BOT_B }] };
  await assert.rejects(requestsHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  delete resultOverrides.requests;

  resultOverrides.select = { botId: BOT_B, computer };
  await assert.rejects(
    handlers.get(IPC_CHANNELS.computerSelectMode)(event, { botId: BOT_A, mode: "local" }),
    { code: "OPENBOT_COMPUTER_OPERATION_FAILED" },
  );
  delete resultOverrides.select;
  resultOverrides.decide = { botId: BOT_B, permissions: [{ ...grant, botId: BOT_B }] };
  await assert.rejects(permissionDecideHandler(event, decision), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  delete resultOverrides.decide;
  resultOverrides.revoke = { botId: BOT_B, permissions: [] };
  await assert.rejects(permissionRevokeHandler(event, { botId: BOT_A, grantId: grant.grantId }), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  delete resultOverrides.revoke;

  const callsBeforeInvalidSender = calls.length;
  const fromWebContents = electron.BrowserWindow.fromWebContents;
  delete electron.BrowserWindow.fromWebContents;
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  electron.BrowserWindow.fromWebContents = fromWebContents;
  assert.equal(calls.length, callsBeforeInvalidSender);
  const senderIsDestroyed = sender.isDestroyed;
  sender.isDestroyed = () => true;
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
  sender.isDestroyed = senderIsDestroyed;
  assert.equal(calls.length, callsBeforeInvalidSender);

  listeners.get("changed")({ botId: BOT_A, computer });
  listeners.get("permission-requested")({
    requestId: "permission-11111111-1111-4111-8111-111111111111",
    botId: BOT_A,
    targetId: computer.localProfileId,
    targetGeneration: 1,
    capability: "filesystem.read",
    resourceLabel: "Folder A",
    reason: "Read an approved file",
  });
  assert.deepEqual(sends.map(([channel]) => channel), [COMPUTER_CHANGE_CHANNEL, COMPUTER_PERMISSION_CHANNEL]);
  listeners.get("permission-requested")({ ...prompt, reason: " Read an approved file" });
  listeners.get("permission-requested")({ ...prompt, unexpected: true });
  const accessorComputer = Object.defineProperty({}, "mode", {
    enumerable: true,
    get() { accessorReads += 1; return "local"; },
  });
  for (const [key, value] of Object.entries(computer)) {
    if (key !== "mode") Object.defineProperty(accessorComputer, key, { enumerable: true, value });
  }
  listeners.get("changed")({ botId: BOT_A, computer: accessorComputer });
  listeners.get("changed")({ botId: BOT_A, computer, [Symbol("private")]: true });
  assert.equal(sends.length, 2);
  assert.equal(accessorReads, 0);
  assert.doesNotMatch(JSON.stringify(sends), /bookmark|Users|authToken|endpoint/);
  await installed.dispose();
  assert.equal(handlers.has(IPC_CHANNELS.computerRead), false);
  assert.equal(listeners.size, 0);
  assert.deepEqual(calls.at(-1), ["computer-dispose"]);
  await assert.rejects(computerReadHandler(event, BOT_A), {
    code: "OPENBOT_COMPUTER_OPERATION_FAILED",
  });
});

test("desktop account boundary opens browser login only in main and publishes frozen sanitized account and catalog generations", async () => {
  const {
    ACCOUNT_CHANGE_CHANNEL,
    CATALOG_CHANGE_CHANNEL,
    installDesktopRuntime,
    IPC_CHANNELS,
  } = require(runtimePath);
  const handlers = new Map();
  const listeners = new Map();
  const sends = [];
  const opened = [];
  let rejectBrowserOpen = false;
  const calls = [];
  const account = Object.freeze({
    generation: 4,
    status: "signed-out",
    authMode: null,
    planType: null,
    requiresOpenaiAuth: true,
    login: null,
    rateLimits: null,
  });
  const catalog = Object.freeze({
    generation: 7,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "dynamic-model",
      displayName: "Dynamic Model",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["low", "medium", "ultra"]),
      inputModalities: Object.freeze(["text"]),
      supportsPersonality: true,
      isDefault: true,
    })]),
  });
  const accountController = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    async start() { calls.push(["account-start"]); },
    accountState() { calls.push(["account-read"]); return account; },
    catalogState() { calls.push(["catalog-list"]); return catalog; },
    async login(mode) {
      calls.push(["account-login", mode]);
      const state = Object.freeze({ ...account, generation: account.generation + 1, status: "signing-in", login: Object.freeze({ mode }) });
      const result = { state };
      if (mode === "browser") Object.defineProperty(result, "openUrl", { value: "https://chatgpt.com/auth/codex?state=private", enumerable: false });
      return Object.freeze(result);
    },
    async cancelLogin() { calls.push(["account-cancel"]); return account; },
    async logout() { calls.push(["account-logout"]); return account; },
    async refresh() { calls.push(["account-retry"]); return { account, catalog }; },
    dispose() { calls.push(["account-dispose"]); },
  };
  const controller = {
    on() {}, off() {}, dispose() {},
  };
  const electron = {
    app: { once() {} },
    shell: {
      async openExternal(url) {
        opened.push(url);
        if (rejectBrowserOpen) throw new Error("private browser /Users/person token");
      },
    },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => sends.push(args) } }],
    },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore: {},
    accountController,
    codexManager: { stop() {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.shift(), ["account-start"]);
  assert.equal(await handlers.get(IPC_CHANNELS.accountRead)({}), account);
  assert.equal(await handlers.get(IPC_CHANNELS.catalogList)({}), catalog);
  const browser = await handlers.get(IPC_CHANNELS.accountLogin)({}, "browser");
  assert.equal(browser.status, "signing-in");
  assert.deepEqual(opened, ["https://chatgpt.com/auth/codex?state=private"]);
  assert.doesNotMatch(JSON.stringify(browser), /https:|state=private|loginId|accessToken|email/);
  rejectBrowserOpen = true;
  await assert.rejects(
    handlers.get(IPC_CHANNELS.accountLogin)({}, "browser"),
    (error) => {
      assert.equal(error.code, "CODEX_BOT_OPERATION_FAILED");
      assert.doesNotMatch(String(error), /private|Users|token|chatgpt\.com/);
      return true;
    },
  );
  assert.deepEqual(calls.at(-1), ["account-cancel"]);
  rejectBrowserOpen = false;
  await handlers.get(IPC_CHANNELS.accountLogin)({}, "device-code");
  assert.equal(opened.length, 2);
  await handlers.get(IPC_CHANNELS.accountCancelLogin)({});
  await handlers.get(IPC_CHANNELS.accountLogout)({});
  await handlers.get(IPC_CHANNELS.accountRetry)({});
  listeners.get("account-changed")(account);
  listeners.get("catalog-changed")(catalog);
  assert.deepEqual(sends, [
    [ACCOUNT_CHANGE_CHANNEL, account],
    [CATALOG_CHANGE_CHANNEL, catalog],
  ]);
  assert.doesNotMatch(JSON.stringify(sends), /private|authUrl|loginId|accessToken|email|endpoint/);
  await installed.dispose();
  assert.equal(listeners.size, 0);
  assert.equal(handlers.size, 0);
  assert.deepEqual(calls.slice(-1), [["account-dispose"]]);
});

test("selecting a bot retains its local model generation across remote runtime changes", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  let runtimeReads = 0;
  const bot = Object.freeze({ botId: BOT_A, name: "New Bot", runtime: Object.freeze({ state: "ready" }) });
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot() { return bot; },
    async runtimeSession() { runtimeReads += 1; throw new Error("must not run"); },
  };
  const retained = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 11,
  });
  const selectionStore = {
    async read() { return retained; },
    async selectBot(botId) { assert.equal(botId, BOT_A); return botId; },
  };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore,
    accountController: accountWithCatalog(),
  });
  const selected = await handlers.get(IPC_CHANNELS.selectBot)({}, BOT_A);
  assert.equal(selected, retained);
  assert.equal(runtimeReads, 0);
  await installed.dispose();
});

test("selecting a stored bot durably owns the next unbound inference conversation", async (t) => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const { ModelSelectionStore } = require(selectionPath);
  const { loadRuntimeConfig } = require(runtimeConfigPath);
  const handlers = new Map();
  const root = tempRoot(t);
  const filePath = path.join(root, "state", "model-selections.v1.json");
  const selectionStore = new ModelSelectionStore({ filePath });
  await selectionStore.write({
    botId: BOT_B, provider: "openai-codex", model: "gpt-5.6-terra",
    reasoningEffort: "low", serviceTier: null, catalogGeneration: 7, generation: 9,
  });
  await selectionStore.write({
    botId: BOT_A, provider: "openai-codex", model: "gpt-5.6-sol",
    reasoningEffort: "medium", serviceTier: null, catalogGeneration: 7, generation: 4,
  });
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot(botId) {
      return Object.freeze({ botId, name: botId === BOT_B ? "B" : "A", runtime: Object.freeze({ state: "ready" }) });
    },
  };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore,
    accountController: accountWithCatalog(),
  });
  const selected = await handlers.get(IPC_CHANNELS.selectBot)({}, BOT_B);
  assert.equal(selected.botId, BOT_B);
  assert.equal(selected.generation, 9);
  const config = loadRuntimeConfig({
    CODEX_BOT_MODEL_SELECTIONS: filePath,
    CODEX_BOT_INFERENCE_ENDPOINT: "tcp://127.0.0.1:49152",
    CODEX_BOT_INFERENCE_CAPABILITY: "a".repeat(64),
  });
  assert.equal(config.botId, BOT_B.slice(4));
  assert.equal(config.generation, 9);
  assert.equal(config.model, "gpt-5.6-terra");
  await installed.dispose();
});

test("official Codex selection remains usable when the bot's remote Work runtime is unavailable", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const calls = [];
  const bot = Object.freeze({
    botId: BOT_A,
    name: "New Bot",
    runtime: Object.freeze({ state: "unavailable" }),
  });
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot(botId) { calls.push(["read", botId]); return bot; },
    async runtimeSession() { throw new Error("remote Work runtime must not gate local Codex"); },
  };
  const initial = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 0,
  });
  const changed = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 1,
  });
  const selectionStore = {
    async selectBot(botId) { calls.push(["activate-model-bot", botId]); return botId; },
    async ensure(botId, fallback) { calls.push(["ensure", botId, fallback]); return initial; },
    async read(botId) { calls.push(["read-model", botId]); return initial; },
    async writeNext(value) { calls.push(["write-next", value]); return changed; },
  };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore,
    accountController: accountWithCatalog(),
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.selectBot)({}, BOT_A), initial);
  assert.deepEqual(await handlers.get(IPC_CHANNELS.selectModel)({}, {
    botId: BOT_A,
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
  }), changed);
  assert.equal(calls.some(([name]) => name === "session"), false);
  assert.deepEqual(calls.find(([name]) => name === "write-next"), ["write-next", {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: null,
    catalogGeneration: 7,
  }]);
  await installed.dispose();
});

test("desktop model selection publishes only inside the controller same-bot mutation barrier", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  let markEntered;
  let releaseBarrier;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  const calls = [];
  const bot = Object.freeze({ botId: BOT_A, name: "New Bot", runtime: Object.freeze({ state: "ready" }) });
  class Conversations {
    on() {}
    off() {}
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    send() { throw new Error("unused"); }
    cancel() { throw new Error("unused"); }
    async withModelSelectionMutation(botId, operation) {
      calls.push(["barrier-enter", botId]);
      markEntered();
      await barrier;
      const value = await operation();
      calls.push(["barrier-exit", botId]);
      return value;
    }
    async dispose() {}
  }
  const conversations = new Conversations();
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot() { return bot; },
  };
  const selectionStore = {
    async writeNext(value) {
      calls.push(["write-next", value.botId]);
      return Object.freeze({ ...value, generation: 4 });
    },
  };
  const electron = {
    app: { on() {}, off() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore,
    standaloneConversations: conversations,
    accountController: accountWithCatalog(),
  });
  const selecting = handlers.get(IPC_CHANNELS.selectModel)({}, {
    botId: BOT_A,
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
  });
  await entered;
  assert.deepEqual(calls, [["barrier-enter", BOT_A]]);
  releaseBarrier();
  const selected = await selecting;
  assert.equal(selected.generation, 4);
  assert.deepEqual(calls.map(([name]) => name), ["barrier-enter", "write-next", "barrier-exit"]);
  await installed.dispose();
});

test("desktop model selection establishes the real same-bot send fence before a held bot read", async () => {
  const { StandaloneConversationController } = require("../src/desktop/standalone-conversation-controller.cjs");
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  let enterRead;
  let releaseRead;
  const readEntered = new Promise((resolve) => { enterRead = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const initial = Object.freeze({
    botId: BOT_A,
    generation: 3,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
  });
  let streams = 0;
  const generated = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const conversations = new StandaloneConversationController({
    router: {
      async stream() {
        streams += 1;
        return { fullStream: (async function* () { await new Promise(() => {}); })() };
      },
    },
    async readSelection() { return initial; },
    makeId() { return generated.shift(); },
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const conversation = conversations.create({ botId: BOT_A });
  const bot = Object.freeze({
    botId: BOT_A,
    name: "OpenBot",
    setupStage: "complete",
    runtime: Object.freeze({ state: "ready" }),
  });
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot() {
      enterRead();
      await readGate;
      return bot;
    },
  };
  const selectionStore = {
    async writeNext(value) { return Object.freeze({ ...value, generation: 4 }); },
  };
  const electron = {
    app: { on() {}, off() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore,
    standaloneConversations: conversations,
    accountController: accountWithCatalog(),
  });
  const selecting = handlers.get(IPC_CHANNELS.selectModel)({}, {
    botId: BOT_A,
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
  });
  await readEntered;
  const sendResult = await Promise.allSettled([conversations.send({
    botId: BOT_A,
    conversationId: conversation.conversationId,
    text: "must use the old model only if no selection is pending",
  })]);
  if (sendResult[0].status === "fulfilled") {
    await conversations.cancel({
      botId: BOT_A,
      conversationId: conversation.conversationId,
      invocationId: sendResult[0].value.invocationId,
    });
  }
  assert.equal(sendResult[0].status, "rejected");
  assert.equal(sendResult[0].reason?.code, "OPENBOT_CONVERSATION_STALE");
  assert.equal(streams, 0);

  releaseRead();
  assert.equal((await selecting).generation, 4);
  await installed.dispose();
});

test("desktop runtime forwards only the controller's sanitized scoped runtime events", async () => {
  const { installDesktopRuntime, RUNTIME_EVENT_CHANNEL } = require(runtimePath);
  const listeners = new Map();
  const sends = [];
  const controller = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    dispose() {},
  };
  const electron = {
    app: { once() {} },
    ipcMain: { handle() {}, removeHandler() {} },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => sends.push(args) } }],
    },
  };
  const installed = installDesktopRuntime(electron, { controller, selectionStore: {} });
  const scoped = Object.freeze({
    botId: BOT_A,
    generation: 12,
    runtime: Object.freeze({ provider: "fixture", remoteRuntimeId: "runtime-a", state: "ready" }),
    event: Object.freeze({ type: "computer/frame", sequence: 41, payload: Object.freeze({ bytes: 3 }) }),
  });
  listeners.get("runtime-event")(scoped);
  assert.deepEqual(sends, [[RUNTIME_EVENT_CHANNEL, scoped]]);
  assert.doesNotMatch(JSON.stringify(sends), /endpoint|authToken|Bearer|providerDiagnostic/);
  await installed.dispose();
  assert.equal(listeners.has("runtime-event"), false);
});

test("runtime bot account and computer broadcasts never enter Local Desktop browser windows", async () => {
  const {
    ACCOUNT_CHANGE_CHANNEL,
    CATALOG_CHANGE_CHANNEL,
    CHANGE_CHANNEL,
    COMPUTER_CHANGE_CHANNEL,
    COMPUTER_PERMISSION_CHANNEL,
    installDesktopRuntime,
    RUNTIME_EVENT_CHANNEL,
  } = require(runtimePath);
  const handlers = new Map();
  const controllerListeners = new Map();
  const accountListeners = new Map();
  const computerListeners = new Map();
  const normalSends = [];
  const hiddenSends = [];
  const normalWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (...args) => normalSends.push(args),
    },
  };
  const hiddenLocalWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send(...args) {
        hiddenSends.push(args);
        throw new Error("cross-bot DTO reached hidden Local Desktop");
      },
    },
  };
  normalWindow.webContents.mainFrame = { isDestroyed: () => false };
  hiddenLocalWindow.webContents.mainFrame = { isDestroyed: () => false };
  const controller = {
    on(event, listener) { controllerListeners.set(event, listener); },
    off(event, listener) { if (controllerListeners.get(event) === listener) controllerListeners.delete(event); },
    dispose() {},
  };
  const accountController = {
    ...accountWithCatalog(),
    on(event, listener) { accountListeners.set(event, listener); },
    off(event, listener) { if (accountListeners.get(event) === listener) accountListeners.delete(event); },
  };
  const computerBoundary = {
    on(event, listener) { computerListeners.set(event, listener); },
    off(event, listener) { if (computerListeners.get(event) === listener) computerListeners.delete(event); },
    async read(botId) {
      return {
        botId,
        computer: {
          mode: "local",
          generation: 1,
          localProfileId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          nativeAgentId: null,
          state: "ready",
          lastConfirmedAt: "2026-08-16T12:00:00.000Z",
          lastErrorCode: null,
        },
      };
    },
    dispose() {},
  };
  const localDesktopManager = {
    ownsWindow(window) { return window === hiddenLocalWindow; },
    async open() {},
    async captureDisplayFrame() { throw new Error("unused"); },
  };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(webContents) {
        return [normalWindow, hiddenLocalWindow].find((window) => window.webContents === webContents) ?? null;
      },
      getAllWindows: () => [normalWindow, hiddenLocalWindow],
    },
  };
  const installed = installDesktopRuntime(electron, {
    accountController,
    codexManager: { async start() {}, stop() {} },
    computerBoundary,
    controller,
    localDesktopManager,
    selectionStore: {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  const bot = Object.freeze({ botId: BOT_B, name: "Other Bot", runtime: Object.freeze({ state: "ready" }) });
  const runtimeEvent = Object.freeze({ botId: BOT_B, generation: 2, event: Object.freeze({ type: "completed" }) });
  const account = Object.freeze({ generation: 2, status: "signed-out" });
  const catalog = readyCatalog(8);
  const computer = Object.freeze({
    mode: "local",
    generation: 2,
    localProfileId: "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    nativeAgentId: null,
    state: "ready",
    lastConfirmedAt: "2026-08-16T12:00:00.000Z",
    lastErrorCode: null,
  });
  const permission = Object.freeze({
    requestId: "permission-22222222-2222-4222-8222-222222222222",
    botId: BOT_B,
    targetId: computer.localProfileId,
    targetGeneration: 2,
    capability: "application.open",
    resourceLabel: "Approved App",
    reason: "Open an approved app",
  });
  controllerListeners.get("bot-changed")({ botId: BOT_B, bot });
  controllerListeners.get("runtime-event")(runtimeEvent);
  accountListeners.get("account-changed")(account);
  accountListeners.get("catalog-changed")(catalog);
  computerListeners.get("changed")({ botId: BOT_B, computer });
  computerListeners.get("permission-requested")(permission);

  assert.deepEqual(hiddenSends, []);
  assert.deepEqual(normalSends.map(([channel]) => channel), [
    CHANGE_CHANNEL,
    RUNTIME_EVENT_CHANNEL,
    ACCOUNT_CHANGE_CHANNEL,
    CATALOG_CHANGE_CHANNEL,
    COMPUTER_CHANGE_CHANNEL,
    COMPUTER_PERMISSION_CHANNEL,
  ]);
  await installed.dispose();
});

test("model selection registry is atomic, private, exact, and contains no runtime secrets", async (t) => {
  const { ModelSelectionStore } = require(selectionPath);
  const root = tempRoot(t);
  const filePath = path.join(root, "state", "model-selections.v1.json");
  const store = new ModelSelectionStore({ filePath, now: () => "2026-08-14T12:00:00.000Z" });
  assert.equal(await store.read(BOT_A), null);
  await store.selectBot(BOT_A);
  const written = await store.write({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 4,
  });
  assert.deepEqual(written, {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 4,
  });
  assert.deepEqual(await store.read(BOT_A), written);
  const contents = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(contents, /endpoint|authToken|providerDiagnostic|Bearer|sk-|\/Users\/|\/private\/tmp\//);
  assert.equal(fs.statSync(filePath).mode & 0o077, 0);
  await assert.rejects(
    store.write({ botId: BOT_A, model: "gpt-5.5", reasoningEffort: "ultra", generation: 5 }),
    /selection|effort|model/i,
  );
  assert.deepEqual(await store.write({
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 5,
  }), {
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 5,
  });
});

test("model selection registry owns an atomic generation independent from remote Work sessions", async (t) => {
  const { ModelSelectionStore } = require(selectionPath);
  const filePath = path.join(tempRoot(t), "state", "model-selections.v1.json");
  const store = new ModelSelectionStore({ filePath, now: () => "2026-08-14T12:00:00.000Z" });
  const initial = await store.ensure(BOT_A, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 7,
  });
  assert.deepEqual(initial, {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 0,
  });
  assert.deepEqual(await store.ensure(BOT_A, {
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    reasoningEffort: "ultra",
    serviceTier: null,
    catalogGeneration: 7,
  }), initial);
  const first = await store.writeNext({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: null,
    catalogGeneration: 7,
  });
  const second = await store.writeNext({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.4",
    reasoningEffort: "xhigh",
    serviceTier: null,
    catalogGeneration: 7,
  });
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.deepEqual(await store.read(BOT_A), second);
});

test("model selection policy persists the complete live-catalog routing tuple and rejects stale catalog entries", async (t) => {
  const { ModelSelectionStore } = require(selectionPath);
  const { resolveModelSelection, selectionMatchesCatalog } = require(runtimePath);
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([
      Object.freeze({
        id: "gpt-live-only",
        displayName: "GPT Live Only",
        defaultReasoningEffort: "high",
        defaultServiceTier: "priority",
        serviceTiers: Object.freeze([
          Object.freeze({ id: "priority", name: "Fast", description: "1.5x speed" }),
          Object.freeze({ id: "ultrafast", name: "Ultra fast", description: "Fastest" }),
        ]),
        supportedReasoningEfforts: Object.freeze(["medium", "high", "ultra"]),
        inputModalities: Object.freeze(["text", "image"]),
        supportsPersonality: false,
        isDefault: true,
      }),
    ]),
  });
  const official = resolveModelSelection({
    botId: BOT_A,
    model: "gpt-live-only",
    reasoningEffort: "ultra",
    serviceTier: "ultrafast",
  }, catalog);
  assert.deepEqual(official, {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-live-only",
    reasoningEffort: "ultra",
    serviceTier: "ultrafast",
    catalogGeneration: 12,
  });
  const optional = resolveModelSelection({
    botId: BOT_A,
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
  }, catalog);
  assert.equal(optional.provider, "cliproxy-anthropic");
  assert.equal(optional.catalogGeneration, 1);
  assert.equal(selectionMatchesCatalog({ ...official, generation: 4 }, catalog), true);
  assert.throws(() => resolveModelSelection({
    botId: BOT_A,
    model: "gpt-live-only",
    reasoningEffort: "high",
    serviceTier: "invented",
  }, catalog), { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(selectionMatchesCatalog({ ...official, catalogGeneration: 11, generation: 4 }, catalog), false);
  assert.throws(() => resolveModelSelection({
    botId: BOT_A,
    model: "gpt-removed",
    reasoningEffort: "high",
  }, catalog), { code: "CODEX_BOT_OPERATION_FAILED" });

  const filePath = path.join(tempRoot(t), "state", "model-selections.v1.json");
  const store = new ModelSelectionStore({ filePath, now: () => "2026-08-14T12:00:00.000Z" });
  const persisted = await store.write({ ...official, generation: 4 });
  assert.deepEqual(persisted, { ...official, generation: 4 });
  assert.deepEqual(await store.read(BOT_A), persisted);
  await assert.rejects(store.write({
    botId: BOT_A,
    model: "gpt-live-only",
    reasoningEffort: "ultra",
    generation: 5,
  }), /selection/i);
});
