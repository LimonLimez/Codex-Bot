"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function runtimeFixture(t, {
  providerController = null,
  selectionStore = {},
  botDeletionCoordinator = null,
  accountController = null,
  computerBoundary = null,
  shell = null,
  secondaryWindow = false,
  controllerOverride = null,
  canCreateAgent = null,
} = {}) {
  const { installDesktopRuntime } = require(runtimePath);
  const handlers = new Map();
  const sent = [];
  const frame = { processId: 31, routingId: 47, isDestroyed: () => false };
  const senderListeners = new Map();
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send(...args) { sent.push(args); },
    on(eventName, listener) {
      const listeners = senderListeners.get(eventName) || new Set();
      listeners.add(listener);
      senderListeners.set(eventName, listeners);
    },
    removeListener(eventName, listener) {
      senderListeners.get(eventName)?.delete(listener);
    },
    emit(eventName, ...args) {
      for (const listener of [...(senderListeners.get(eventName) || [])]) listener(...args);
    },
  };
  const window = { isDestroyed: () => false, webContents: sender };
  const secondaryFrame = { processId: 32, routingId: 48, isDestroyed: () => false };
  const secondarySent = [];
  const secondarySender = { mainFrame: secondaryFrame, isDestroyed: () => false, send(...args) { secondarySent.push(args); } };
  const secondary = { isDestroyed: () => false, webContents: secondarySender };
  const controller = controllerOverride || { on() {}, off() {}, dispose() {} };
  const electron = {
    app: { once() {}, on() {}, off() {} },
    ipcMain: {
      on() {},
      removeListener() {},
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(value) {
        if (value === sender) return window;
        if (secondaryWindow && value === secondarySender) return secondary;
        return null;
      },
      getAllWindows() { return secondaryWindow ? [window, secondary] : [window]; },
    },
  };
  if (shell !== null) electron.shell = shell;
  const injected = { controller, selectionStore };
  if (providerController !== null) injected.providerController = providerController;
  if (botDeletionCoordinator !== null) injected.botDeletionCoordinator = botDeletionCoordinator;
  if (accountController !== null) injected.accountController = accountController;
  if (computerBoundary !== null) injected.computerBoundary = computerBoundary;
  if (canCreateAgent !== null) injected.canCreateAgent = canCreateAgent;
  const installed = installDesktopRuntime(electron, injected);
  t.after(() => installed.dispose());
  return Object.freeze({
    electron, handlers, frame, sender, window, sent, senderListeners, installed,
    secondaryFrame, secondarySender, secondarySent,
  });
}

test("desktop accepts Cursor-unavailable null identity for live selection and restart reads", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const unavailable = Object.freeze({
    mode: "cursor",
    generation: 2,
    localProfileId: null,
    nativeAgentId: null,
    state: "unavailable",
    lastConfirmedAt: null,
    lastErrorCode: "CURSOR_ACCOUNT_REQUIRED",
  });
  let current = unavailable;
  const boundary = {
    async selectMode(value) { return { botId: value.botId, computer: current }; },
    async read(botId) { return { botId, computer: current }; },
    async decidePermission() { throw new Error("unused"); },
    async listPermissionRequests() { return { botId: BOT_A, requests: [] }; },
    async listPermissions() { return { botId: BOT_A, permissions: [] }; },
    async revokePermission() { throw new Error("unused"); },
    dispose() {},
  };
  const fixture = runtimeFixture(t, { computerBoundary: boundary });
  const event = { sender: fixture.sender };
  const selected = await fixture.handlers.get(IPC_CHANNELS.computerSelectMode)(
    event,
    { botId: BOT_A, mode: "cursor" },
  );
  assert.deepEqual(selected, { botId: BOT_A, computer: unavailable });
  const restarted = await fixture.handlers.get(IPC_CHANNELS.computerRead)(event, BOT_A);
  assert.deepEqual(restarted, { botId: BOT_A, computer: unavailable });

  current = Object.freeze({ ...unavailable, state: "starting" });
  await assert.rejects(
    fixture.handlers.get(IPC_CHANNELS.computerSelectMode)(event, { botId: BOT_A, mode: "cursor" }),
    { code: "OPENBOT_COMPUTER_OPERATION_FAILED" },
  );
  await assert.rejects(
    fixture.handlers.get(IPC_CHANNELS.computerRead)(event, BOT_A),
    { code: "OPENBOT_COMPUTER_OPERATION_FAILED" },
  );
});

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

test("desktop runtime requires a paired private provider SHA and never loads the module in the main process", async (t) => {
  const { loadConfiguredProvider } = require(runtimePath);
  const root = tempRoot(t);
  const marker = path.join(root, "main-process-marker");
  const source = [
    '"use strict";',
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "main-process");`,
    "module.exports = {",
    "  createProvider() {",
    "    return {",
    "      async capabilities() { return { provision: true, reconcile: true, retire: true, remoteAppServer: true, computerFrames: true }; },",
    "      async provision() { throw new Error(\"unused\"); },",
    "      async inspect() { throw new Error(\"unused\"); },",
    "      async retire() { throw new Error(\"unused\"); },",
    "      subscribe() { return () => {}; },",
    "    };",
    "  },",
    "};",
  ].join("\n");
  const modulePath = path.join(root, "provider.cjs");
  fs.writeFileSync(modulePath, source, { mode: 0o600 });
  fs.chmodSync(modulePath, 0o600);
  const previousPath = process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE;
  const previousSha = process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256;
  t.after(() => {
    if (previousPath === undefined) delete process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE;
    else process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE = previousPath;
    if (previousSha === undefined) delete process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256;
    else process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256 = previousSha;
  });
  process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE = modulePath;
  delete process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256;

  const unavailable = loadConfiguredProvider();
  assert.equal((await unavailable.capabilities()).provision, false);
  assert.equal(fs.existsSync(marker), false);
});

test("desktop runtime executes a correctly hashed provider only through the reviewed worker contract", async (t) => {
  const { loadConfiguredProvider } = require(runtimePath);
  const root = tempRoot(t);
  const source = [
    '"use strict";',
    "module.exports = {",
    "  createProvider() {",
    "    return {",
    "      async capabilities() { return { provision: true, reconcile: true, retire: true, remoteAppServer: true, computerFrames: true }; },",
    "      async provision() { throw new Error(\"unused\"); },",
    "      async inspect() { throw new Error(\"unused\"); },",
    "      async retire() { throw new Error(\"unused\"); },",
    "      subscribe() { return () => {}; },",
    "    };",
    "  },",
    "};",
  ].join("\n");
  const modulePath = path.join(root, "provider.cjs");
  fs.writeFileSync(modulePath, source, { mode: 0o600 });
  fs.chmodSync(modulePath, 0o600);
  const previousPath = process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE;
  const previousSha = process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256;
  t.after(() => {
    if (previousPath === undefined) delete process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE;
    else process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE = previousPath;
    if (previousSha === undefined) delete process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256;
    else process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256 = previousSha;
  });
  process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE = modulePath;
  process.env.CODEX_BOT_REMOTE_PROVIDER_SHA256 = createHash("sha256").update(source).digest("hex");

  const provider = loadConfiguredProvider();
  assert.deepEqual(Reflect.ownKeys(provider), ["capabilities", "provision", "inspect", "retire", "subscribe"]);
  assert.deepEqual(await provider.capabilities(), {
    provision: true,
    reconcile: true,
    retire: true,
    remoteAppServer: true,
    computerFrames: true,
  });
  const unsubscribe = provider.subscribe(() => {});
  unsubscribe();
});

test("desktop runtime exposes a frozen private machine-id reader without installing IPC", async (t) => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  let reads = 0;
  const machineIdStore = {
    async read() {
      reads += 1;
      return "11111111-1111-4111-8111-111111111111";
    },
  };
  const electron = {
    app: { once() {}, on() {}, off() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const installed = installDesktopRuntime(electron, {
    controller: { on() {}, off() {}, dispose() {} },
    selectionStore: {},
    machineIdStore,
    accountController: accountWithCatalog(),
  });
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(typeof installed.readMachineId, "function");
  assert.equal(reads, 0);
  assert.equal(handlers.has("openbot-machine-id:read"), false);
  assert.equal(await installed.readMachineId(), "11111111-1111-4111-8111-111111111111");
  assert.equal(reads, 1);
  await installed.dispose();
});

test("desktop runtime keeps one process-stable fallback when the durable machine-id store rejects", async (t) => {
  const { installDesktopRuntime } = require(runtimePath);
  const handlers = new Map();
  const machineIdStore = { async read() { throw new Error("unsafe durable state"); } };
  const electron = {
    app: { once() {}, on() {}, off() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const installed = installDesktopRuntime(electron, {
    controller: { on() {}, off() {}, dispose() {} },
    selectionStore: {},
    machineIdStore,
    accountController: accountWithCatalog(),
  });
  const first = await installed.readMachineId();
  const second = await installed.readMachineId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(second, first);
  await installed.dispose();
});

test("desktop runtime fences new machine-id reads after disposal", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  let reads = 0;
  const handlers = new Map();
  const electron = {
    app: { once() {}, on() {}, off() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const installed = installDesktopRuntime(electron, {
    controller: { on() {}, off() {}, dispose() {} },
    selectionStore: {},
    machineIdStore: {
      async read() { reads += 1; return "11111111-1111-4111-8111-111111111111"; },
    },
    accountController: accountWithCatalog(),
  });

  await installed.dispose();
  await assert.rejects(installed.readMachineId(), /failed|unavailable/i);
  assert.equal(reads, 0);
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
    catalogGeneration: 7,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    serviceTier: null,
  });
  const optionalBot = "bot-22222222-2222-4222-8222-222222222222";
  assert.deepEqual(await constructed[1][1].readSelection(optionalBot), {
    botId: optionalBot,
    generation: 4,
    catalogGeneration: 1,
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
  });
  const optional = await constructed[1][1].createOptionalTransport("cliproxy-anthropic");
  assert.equal(optional.kind, "optional");
  assert.equal(starts, 2);
  assert.deepEqual(constructed.map(([name]) => name), ["direct", "router", "bridge", "optional"]);
});

test("provider-controller inference preserves catalog generation and streams through the production router branch", async (t) => {
  const { createInferenceBridgeRuntime } = require(runtimePath);
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  const calls = [];
  class DirectFixture {
    constructor() {}
    stream(request) {
      calls.push(request);
      return {
        fullStream: (async function* () { yield { type: "finish", finishReason: "stop" }; })(),
      };
    }
    dispose() {}
  }
  class BridgeFixture {
    constructor(options) { this.router = options.router; }
  }
  const providerController = {
    async catalog() {
      return { status: "ready", generation: 7, models: [{ provider: "openai-codex", model: "gpt-5.6-sol" }] };
    },
    async readOnboarding() { return null; },
  };
  const selectionStore = {
    async read() {
      return {
        botId: BOT_A,
        generation: 3,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        serviceTier: null,
        catalogGeneration: 7,
      };
    },
  };
  const inference = createInferenceBridgeRuntime({
    codexManager: {},
    selectionStore,
    sidecarManager: { async start() { throw new Error("sidecar must remain unused"); } },
    providerController,
    stateRoot,
    computerTargetRouter: { async resolve() {} },
    DirectTransportClass: DirectFixture,
    BridgeClass: BridgeFixture,
  });
  t.after(() => inference.dispose?.());
  const result = await inference.router.stream({
    selection: {
      botId: BOT_A,
      generation: 3,
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
      serviceTier: null,
      catalogGeneration: 7,
    },
    conversationId: "conversation-1",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    toolChoice: "none",
    invocationId: "invocation-1",
  });
  for await (const _event of result.fullStream) {}
  assert.equal(calls.length, 1);
  assert.equal(calls[0].selection.catalogGeneration, 7);
});

test("provider-controller API inference adapts the private durable connection DTO", async (t) => {
  const { createInferenceBridgeRuntime } = require(runtimePath);
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  let capturedConnection;
  class DirectFixture { constructor() {} }
  class OpenAIFixture {
    constructor(options) { this.options = options; }
    async stream() {
      capturedConnection = await this.options.resolveConnection();
      return { fullStream: (async function* () {})() };
    }
    dispose() {}
  }
  class BridgeFixture {
    constructor(options) { this.router = options.router; }
  }
  const providerController = {
    async catalog() {
      return { status: "ready", generation: 9, models: [{ provider: "openai-api-key", model: "gpt-live-only" }] };
    },
    async readOnboarding() { return null; },
  };
  const selectionStore = {
    async read() {
      return {
        botId: BOT_A,
        generation: 1,
        provider: "openai-api-key",
        model: "gpt-live-only",
        reasoningEffort: "high",
        serviceTier: "priority",
        catalogGeneration: 9,
      };
    },
  };
  const openaiProvider = {
    streamConfiguration() {
      const result = { providerId: "openai-api-key", baseUrl: "https://api.openai.com/v1" };
      Object.defineProperty(result, "apiKey", { value: "k".repeat(64), enumerable: false });
      return Object.freeze(result);
    },
  };
  const inference = createInferenceBridgeRuntime({
    codexManager: {}, selectionStore,
    sidecarManager: { async start() { throw new Error("sidecar must remain unused"); } },
    providerController, openaiProvider, stateRoot,
    computerTargetRouter: { async resolve() {} },
    DirectTransportClass: DirectFixture,
    OpenAITransportClass: OpenAIFixture,
    BridgeClass: BridgeFixture,
  });
  t.after(() => inference.dispose?.());
  const result = await inference.router.stream({
    selection: {
      botId: BOT_A, generation: 1, provider: "openai-api-key", model: "gpt-live-only",
      reasoningEffort: "high", serviceTier: "priority", catalogGeneration: 9,
    },
    conversationId: "conversation-1", messages: [{ role: "user", content: "hello" }],
    tools: [], toolChoice: "none", invocationId: "invocation-1",
  });
  for await (const _event of result.fullStream) {}
  assert.deepEqual(Object.keys(capturedConnection), ["endpoint"]);
  assert.equal(capturedConnection.endpoint, "https://api.openai.com/v1");
  assert.equal(capturedConnection.credential, "k".repeat(64));
  assert.equal(Object.prototype.propertyIsEnumerable.call(capturedConnection, "credential"), false);
});

test("explicit inference rehydrates API connection and Keychain state after provider restart", async (t) => {
  const { createInferenceBridgeRuntime } = require(runtimePath);
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  let capturedConnection;
  let keychainReads = 0;
  class DirectFixture { constructor() {} }
  class OpenAIFixture {
    constructor(options) { this.options = options; }
    async stream() {
      capturedConnection = await this.options.resolveConnection();
      return { fullStream: (async function* () {})() };
    }
    dispose() {}
  }
  class BridgeFixture { constructor(options) { this.router = options.router; } }
  const providerController = {
    async catalog() { return { status: "ready", generation: 12, models: [{ provider: "openai-api-key", model: "gpt-rehydrated" }] }; },
    async readOnboarding() {
      return { schemaVersion: 1, providerId: "openai-api-key", connectionGeneration: 5, catalogGeneration: 12, completedAt: "2026-08-19T00:00:00.000Z" };
    },
    async listConnections() { return [{ providerId: "openai-api-key", state: "connected", generation: 5 }]; },
  };
  const selectionStore = {
    async read() {
      return { botId: BOT_A, generation: 2, provider: "openai-api-key", model: "gpt-rehydrated", reasoningEffort: "high", serviceTier: "priority", catalogGeneration: 12 };
    },
  };
  const providerStateStore = {
    async read() {
      return { connections: [{ providerId: "openai-api-key", state: "connected", generation: 5, baseUrl: "https://api.openai.com/v1" }] };
    },
  };
  const keychain = { async read(provider) { keychainReads += 1; assert.equal(provider, "openai-api-key"); return "r".repeat(64); } };
  const inference = createInferenceBridgeRuntime({
    codexManager: {}, selectionStore,
    sidecarManager: { async start() { throw new Error("sidecar must remain unused"); } },
    providerController, providerStateStore, keychain, stateRoot,
    computerTargetRouter: { async resolve() {} },
    DirectTransportClass: DirectFixture,
    OpenAITransportClass: OpenAIFixture,
    BridgeClass: BridgeFixture,
  });
  t.after(() => inference.dispose?.());
  const result = await inference.router.stream({
    selection: { botId: BOT_A, generation: 2, provider: "openai-api-key", model: "gpt-rehydrated", reasoningEffort: "high", serviceTier: "priority", catalogGeneration: 12 },
    conversationId: "conversation-1", messages: [{ role: "user", content: "hello" }], tools: [], toolChoice: "none", invocationId: "invocation-1",
  });
  for await (const _event of result.fullStream) {}
  assert.equal(keychainReads, 1);
  assert.equal(capturedConnection.endpoint, "https://api.openai.com/v1");
  assert.equal(capturedConnection.credential, "r".repeat(64));
  assert.deepEqual(Object.keys(capturedConnection), ["endpoint"]);
});

test("inference fences the selected provider generation independently of the onboarding provider", async (t) => {
  const { createInferenceBridgeRuntime } = require(runtimePath);
  const root = tempRoot(t);
  const stateRoot = path.join(root, "state");
  let selected = {
    botId: BOT_A,
    generation: 1,
    provider: "xai",
    model: "grok-4.5",
    reasoningEffort: "high",
    serviceTier: null,
    catalogGeneration: 2,
  };
  let xaiConnection = { providerId: "xai", state: "connected", generation: 2 };
  let xaiCatalogGeneration = 2;
  let mutateBeforeFence = null;
  let sends = 0;
  class DirectFixture { constructor() {} }
  class OptionalFixture {
    constructor(options) { this.options = options; }
    async stream() {
      await this.options.resolveConnection();
      mutateBeforeFence?.();
      if (this.options.assertConnectionCurrent
        && await this.options.assertConnectionCurrent() !== true) {
        const error = new Error("stale selected provider");
        error.code = "CODEX_INFERENCE_STALE";
        throw error;
      }
      sends += 1;
      return { fullStream: (async function* () { yield { type: "finish" }; })() };
    }
    dispose() {}
  }
  class BridgeFixture { constructor(options) { this.router = options.router; } }
  const providerController = {
    async readOnboarding() {
      return { schemaVersion: 1, providerId: "openai-codex", connectionGeneration: 1, catalogGeneration: 1, completedAt: "2026-08-19T00:00:00.000Z" };
    },
    async listConnections() {
      return [
        { providerId: "openai-codex", state: "connected", generation: 1 },
        xaiConnection,
      ];
    },
    async catalog() {
      return {
        status: "ready",
        generation: xaiCatalogGeneration,
        models: [{ provider: "xai", model: "grok-4.5" }],
      };
    },
  };
  const selectionStore = { async read() { return selected; } };
  const inference = createInferenceBridgeRuntime({
    codexManager: {}, selectionStore,
    sidecarManager: {
      async start() {
        const session = { endpoint: "http://127.0.0.1:43211/v1" };
        Object.defineProperty(session, "credential", { value: "x".repeat(64), enumerable: false });
        return Object.freeze(session);
      },
    },
    providerController,
    stateRoot,
    computerTargetRouter: { async resolve() {} },
    DirectTransportClass: DirectFixture,
    OptionalTransportClass: OptionalFixture,
    BridgeClass: BridgeFixture,
  });
  t.after(() => inference.dispose?.());
  const request = () => ({
    selection: { ...selected },
    conversationId: "conversation-1",
    messages: [{ role: "user", content: "hello" }],
    tools: [], toolChoice: "none", invocationId: `invocation-${selected.catalogGeneration}`,
  });

  mutateBeforeFence = () => { xaiConnection = { ...xaiConnection, state: "disconnected" }; };
  await assert.rejects(inference.router.stream(request()), { code: "CODEX_INFERENCE_UNAVAILABLE" });
  assert.equal(sends, 0);

  xaiConnection = { providerId: "xai", state: "connected", generation: 3 };
  xaiCatalogGeneration = 3;
  selected = { ...selected, generation: 2, catalogGeneration: 3 };
  mutateBeforeFence = null;
  const healthy = await inference.router.stream(request());
  for await (const _event of healthy.fullStream) {}
  assert.equal(sends, 1);
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
  const synchronousListeners = new Map();
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
      on(channel, listener) {
        const listeners = synchronousListeners.get(channel) || new Set();
        listeners.add(listener);
        synchronousListeners.set(channel, listeners);
      },
      removeListener(channel, listener) {
        const listeners = synchronousListeners.get(channel);
        listeners?.delete(listener);
        if (listeners?.size === 0) synchronousListeners.delete(channel);
      },
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
    nativeTheme: {
      themeSource: "system",
      shouldUseDarkColors: true,
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
    "permissionDecide", "permissionRequestsList", "permissionRevoke", "permissionsList",
    "providerAuthoritySnapshot", "providerCatalog", "providerConnect", "providerDisconnect", "providerList", "providerOnboardingComplete", "providerOnboardingRead",
    "read", "readActiveBotId", "readModel", "rename",
    "retryRuntime", "selectBot", "selectModel", "updateProfile",
  ]);
  assert.equal(handlers.size, 32);
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(typeof installed.releaseEarlySyncIpc, "function");
  assert.deepEqual([...synchronousListeners.keys()].sort(), [
    "sand:egress-tunnel-get-sync",
    "sand:egress-tunnel-status-get-sync",
    "sand:experiments-snapshot-sync",
    "sand:theme-get-sync",
    "sand:webauthn-proxy-get-sync",
  ]);
  const earlyValues = Object.fromEntries([...synchronousListeners].map(([channel, listeners]) => {
    const event = {};
    for (const listener of listeners) listener(event);
    return [channel, event.returnValue];
  }));
  assert.deepEqual(earlyValues, {
    "sand:experiments-snapshot-sync": null,
    "sand:theme-get-sync": { preference: "system", resolved: "dark" },
    "sand:egress-tunnel-get-sync": false,
    "sand:webauthn-proxy-get-sync": false,
    "sand:egress-tunnel-status-get-sync": { state: "off", relayedStreams: 0, activeStreams: 0 },
  });
  installed.releaseEarlySyncIpc();
  installed.releaseEarlySyncIpc();
  assert.deepEqual([...synchronousListeners.keys()], [], "stock IPC handoff must remove exact bootstrap listeners once");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter(([name]) => name === "direct-start"), []);
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

test("provider IPC is main-frame scoped and codex-bot creation is gated before mutation", async (t) => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const calls = [];
  const senderFrame = { processId: 3, routingId: 4, isDestroyed: () => false };
  const sender = { mainFrame: senderFrame, isDestroyed: () => false, send() {} };
  const window = { isDestroyed: () => false, webContents: sender };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(value) { return value === sender ? window : null; },
      getAllWindows() { return [window]; },
    },
  };
  const providerController = {
    async readAuthoritySnapshot() { return { schemaVersion: 1, connections: [], catalog: { generation: 0, status: "unavailable", models: [] }, onboarding: null }; },
    async listConnections() { calls.push("list"); return []; },
    async connect() { calls.push("connect"); },
    async disconnect() { calls.push("disconnect"); },
    async catalog() { calls.push("catalog"); return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { calls.push("onboarding-read"); return null; },
    async completeOnboarding() { calls.push("onboarding-complete"); },
    on() {}, off() {}, dispose() {},
  };
  const controller = {
    on() {}, off() {}, dispose() {},
    async listBots() { return []; },
    async createBot() { calls.push("create"); throw new Error("must not mutate"); },
    async readBot() { return null; },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore: { async read() { return null; }, async ensure() {}, async readActiveBotId() { return null; } },
    providerController,
    canCreateAgent: async () => false,
  });
  t.after(() => installed.dispose());
  for (const key of ["providerList", "providerConnect", "providerDisconnect", "providerCatalog", "providerOnboardingRead", "providerOnboardingComplete"]) {
    assert.equal(typeof IPC_CHANNELS[key], "string");
    assert.equal(handlers.has(IPC_CHANNELS[key]), true);
  }
  assert.deepEqual(await handlers.get(IPC_CHANNELS.providerList)({ sender, senderFrame }), []);
  await assert.rejects(handlers.get(IPC_CHANNELS.providerList)({ sender: {}, senderFrame }), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  await assert.rejects(handlers.get(IPC_CHANNELS.create)({ sender, senderFrame }), {
    code: "CODEX_BOT_OPERATION_FAILED",
  });
  assert.deepEqual(calls.filter((value) => value === "create"), []);
});

test("provider browser connect opens only the private URL in main and returns no login details", async (t) => {
  const { IPC_CHANNELS, PROVIDER_LOGIN_PROMPT_CHANNEL } = require(runtimePath);
  const opened = [];
  const loginUrl = "https://chatgpt.com/auth/codex?state=private-login";
  const providerController = {
    async connect(request, context) {
      assert.equal(request.providerId, "openai-codex");
      assert.equal(request.authMode, "browser");
      assert.equal(typeof context?.openExternal, "function");
      await context.openExternal(loginUrl);
      return {
        providerId: "openai-codex", label: "OpenAI Codex", loginKind: "account",
        state: "connected", generation: 1,
        capabilities: { reasoning: true, fast: false }, errorCode: null,
      };
    },
    async listConnections() { return []; }, async disconnect() {}, async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; }, async completeOnboarding() {}, async readAuthoritySnapshot() { return null; },
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    shell: { async openExternal(url) { opened.push(url); } },
  });
  const result = await fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "browser" },
  );
  assert.deepEqual(opened, [loginUrl]);
  assert.equal(result.providerId, "openai-codex");
  assert.doesNotMatch(JSON.stringify(result), /chatgpt\.com|loginId|private-login/);
  assert.deepEqual(fixture.sent, []);
  assert.equal(PROVIDER_LOGIN_PROMPT_CHANNEL, "openbot-provider:login-prompt");
});

test("provider IPC preserves a keyless local connect while rejecting null keys elsewhere", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const requests = [];
  const providerController = {
    connect(request) {
      requests.push(request);
      return {
        providerId: request.providerId,
        state: "connected",
        generation: 1,
      };
    },
    async listConnections() { return []; },
    async disconnect() {},
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; },
    async completeOnboarding() {},
    async readAuthoritySnapshot() { return null; },
    on() {},
    off() {},
    dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController });
  const connect = fixture.handlers.get(IPC_CHANNELS.providerConnect);
  const event = { sender: fixture.sender, senderFrame: fixture.frame };

  const localResult = await connect(event, {
    providerId: "local-openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: null,
  });
  assert.equal(localResult.providerId, "local-openai-compatible");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].providerId, "local-openai-compatible");
  assert.equal(requests[0].baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(requests[0].apiKey, null);

  await assert.rejects(connect(event, {
    providerId: "openai-api-key",
    apiKey: null,
  }), { code: "CODEX_BOT_OPERATION_FAILED" });
  await assert.rejects(connect(event, {
    providerId: "anthropic-claude",
    apiKey: null,
  }), { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(requests.length, 1);
});

test("device login prompt is delivered only to the initiating current frame", async (t) => {
  const { IPC_CHANNELS, PROVIDER_LOGIN_PROMPT_CHANNEL } = require(runtimePath);
  const flight = deferred();
  const opened = [];
  let firstContext = null;
  let connectCalls = 0;
  const prompt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    generation: 1,
    mode: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  };
  const providerController = {
    connect(_request, context) {
      if (firstContext) return flight.promise;
      connectCalls += 1;
      firstContext = context;
      return flight.promise;
    },
    async listConnections() { return []; }, async disconnect() {}, async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; }, async completeOnboarding() {}, async readAuthoritySnapshot() { return null; },
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    secondaryWindow: true,
    shell: { async openExternal(url) { opened.push(url); } },
  });
  const first = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "device-code" },
  );
  const second = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.secondarySender, senderFrame: fixture.secondaryFrame },
    { providerId: "openai-codex", authMode: "device-code" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  await firstContext.onLoginPrompt(prompt);
  assert.deepEqual(opened, [prompt.verificationUrl]);
  assert.deepEqual(fixture.sent, [[PROVIDER_LOGIN_PROMPT_CHANNEL, prompt]]);
  assert.deepEqual(fixture.secondarySent, []);
  assert.equal(connectCalls, 1);
  flight.resolve({ providerId: "openai-codex", state: "connected", generation: 1 });
  await Promise.all([first, second]);
});

test("provider connect admission aborts and rejects after the initiating main frame navigates", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  let request = null;
  let context = null;
  let commits = 0;
  let settleConnect = null;
  const providerController = {
    connect(value, internalContext) {
      request = value;
      context = internalContext;
      return new Promise((resolve) => {
        settleConnect = () => {
          if (!value.signal.aborted) commits += 1;
          resolve({
            providerId: "openai-codex", label: "OpenAI Codex", loginKind: "account",
            state: "connected", generation: 1,
            capabilities: { reasoning: true, fast: false }, errorCode: null,
          });
        };
      });
    },
    async listConnections() { return []; }, async disconnect() {}, async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; }, async completeOnboarding() {}, async readAuthoritySnapshot() { return null; },
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController });
  const pending = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "device-code" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request.signal.aborted, false);
  assert.equal(context.isCurrent(), true);
  fixture.sender.emit("did-navigate");
  assert.equal(request.signal.aborted, true);
  assert.equal(context.isCurrent(), false);
  settleConnect();
  await assert.rejects(pending, { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(commits, 0);
  assert.deepEqual(fixture.sent, []);
});

test("provider connect admission aborts and rejects when runtime disposal wins the pending flight", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const flight = deferred();
  let request = null;
  let context = null;
  const providerController = {
    connect(value, internalContext) {
      request = value;
      context = internalContext;
      return flight.promise;
    },
    async listConnections() { return []; }, async disconnect() {}, async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; }, async completeOnboarding() {}, async readAuthoritySnapshot() { return null; },
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController });
  const pending = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "browser" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.installed.dispose();
  assert.equal(request.signal.aborted, true);
  assert.equal(context.isCurrent(), false);
  flight.resolve({
    providerId: "openai-codex", label: "OpenAI Codex", loginKind: "account",
    state: "connected", generation: 1,
    capabilities: { reasoning: true, fast: false }, errorCode: null,
  });
  await assert.rejects(pending, { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.deepEqual(fixture.sent, []);
});

test("device login prompt rejects malformed and navigated or destroyed frames", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  for (const scenario of ["malformed", "navigated", "destroyed"]) {
    const flight = deferred();
    let context = null;
    const providerController = {
      connect(_request, value) { context = value; return flight.promise; },
      async listConnections() { return []; }, async disconnect() {}, async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
      async readOnboarding() { return null; }, async completeOnboarding() {}, async readAuthoritySnapshot() { return null; },
      on() {}, off() {}, dispose() {},
    };
    const fixture = runtimeFixture(t, { providerController });
    const pending = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
      { sender: fixture.sender, senderFrame: fixture.frame },
      { providerId: "openai-codex", authMode: "device-code" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    if (scenario === "navigated") fixture.sender.mainFrame = { processId: 31, routingId: 99, isDestroyed: () => false };
    if (scenario === "destroyed") fixture.sender.isDestroyed = () => true;
    const prompt = scenario === "malformed"
      ? {
        schemaVersion: 1, providerId: "openai-codex", generation: 1, mode: "device-code",
        verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234", loginId: "private",
      }
      : {
        schemaVersion: 1, providerId: "openai-codex", generation: 1, mode: "device-code",
        verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234",
      };
    await assert.rejects(context.onLoginPrompt(prompt));
    assert.deepEqual(fixture.sent, []);
    flight.reject(new Error("prompt admission rejected"));
    await assert.rejects(pending, { code: "CODEX_BOT_OPERATION_FAILED" });
  }
});

test("provider-owned Direct login scrubs ceremony data from broad account events while keeping the exact prompt sender-scoped", async (t) => {
  const {
    ACCOUNT_CHANGE_CHANNEL,
    IPC_CHANNELS,
    PROVIDER_LOGIN_PROMPT_CHANNEL,
  } = require(runtimePath);
  const account = new EventEmitter();
  const flight = deferred();
  const prompt = Object.freeze({
    schemaVersion: 1,
    providerId: "openai-codex",
    generation: 1,
    mode: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });
  const ceremony = {
    mode: "device-code",
    verificationUrl: prompt.verificationUrl,
    userCode: prompt.userCode,
    loginId: "11111111-1111-4111-8111-111111111111",
    authUrl: "https://chatgpt.com/auth/codex?private=browser",
    browserUrl: "https://chatgpt.com/auth/codex?private=browser",
  };
  const accountState = Object.freeze({
    generation: 2,
    status: "signing-in",
    authMode: null,
    planType: null,
    requiresOpenaiAuth: true,
    login: Object.freeze(ceremony),
    rateLimits: null,
  });
  account.start = async () => {};
  account.accountState = () => accountState;
  account.catalogState = () => ({ generation: 1, status: "unavailable", models: [] });
  account.cancelLogin = async () => {};
  account.logout = async () => {};
  account.refresh = async () => {};
  account.dispose = () => account.removeAllListeners();
  let connectContext = null;
  const providerController = {
    async connect(_request, context) {
      connectContext = context;
      // ProviderController can synchronously re-enter the account observer
      // from account.login before connect() returns its flight.
      account.emit("account-changed", accountState);
      await context.onLoginPrompt(prompt);
      return flight.promise;
    },
    async listConnections() { return []; },
    async disconnect() {},
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; },
    async completeOnboarding() {},
    async readAuthoritySnapshot() { return null; },
    on() {},
    off() {},
    dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    accountController: account,
    secondaryWindow: true,
    shell: { async openExternal() {} },
  });
  const pending = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "device-code" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof connectContext?.isCurrent, "function");
  const accountBroadcasts = fixture.sent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL);
  assert.equal(accountBroadcasts.length, 1);
  assert.equal(accountBroadcasts[0][1].status, "signing-in");
  assert.equal(accountBroadcasts[0][1].login, null);
  assert.doesNotMatch(JSON.stringify(accountBroadcasts), /verificationUrl|userCode|loginId|authUrl|browserUrl|chatgpt\.com|auth\.openai\.com/);
  assert.deepEqual(fixture.sent.filter(([channel]) => channel === PROVIDER_LOGIN_PROMPT_CHANNEL), [
    [PROVIDER_LOGIN_PROMPT_CHANNEL, prompt],
  ]);
  assert.deepEqual(fixture.secondarySent, [[ACCOUNT_CHANGE_CHANNEL, accountBroadcasts[0][1]]]);
  assert.doesNotMatch(JSON.stringify(fixture.secondarySent), /verificationUrl|userCode|loginId|authUrl|browserUrl|chatgpt\.com|auth\.openai\.com/);
  flight.resolve({
    providerId: "openai-codex",
    label: "OpenAI Codex",
    loginKind: "account",
    state: "connected",
    generation: 1,
    capabilities: { reasoning: true, fast: false },
    errorCode: null,
  });
  const result = await pending;
  assert.doesNotMatch(JSON.stringify(result), /verificationUrl|userCode|loginId|authUrl|browserUrl|chatgpt\.com|auth\.openai\.com/);
  assert.deepEqual(fixture.sent.filter(([channel]) => channel === PROVIDER_LOGIN_PROMPT_CHANNEL), [
    [PROVIDER_LOGIN_PROMPT_CHANNEL, prompt],
  ]);
});

test("provider-owned account-event sanitization survives coalesced callers and clears only after the shared flight settles", async (t) => {
  const { ACCOUNT_CHANGE_CHANNEL, IPC_CHANNELS } = require(runtimePath);
  const account = new EventEmitter();
  const flight = deferred();
  const events = [];
  account.start = async () => {};
  account.accountState = () => ({ status: "signing-in", authMode: null, login: null });
  account.catalogState = () => ({ generation: 1, status: "unavailable", models: [] });
  account.cancelLogin = async () => {};
  account.logout = async () => {};
  account.refresh = async () => {};
  account.dispose = () => account.removeAllListeners();
  const sensitive = {
    status: "signing-in",
    authMode: null,
    login: {
      mode: "browser",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "WXYZ-9876",
      loginId: "22222222-2222-4222-8222-222222222222",
      authUrl: "https://chatgpt.com/auth/codex?private=late",
    },
  };
  const providerController = {
    connect(_request, context) {
      events.push(["connect", context]);
      account.emit("account-changed", sensitive);
      return flight.promise;
    },
    async listConnections() { return []; },
    async disconnect() {},
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; },
    async completeOnboarding() {},
    async readAuthoritySnapshot() { return null; },
    on() {},
    off() {},
    dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController, accountController: account, secondaryWindow: true });
  const first = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "browser" },
  );
  const second = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.secondarySender, senderFrame: fixture.secondaryFrame },
    { providerId: "openai-codex", authMode: "browser" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 2);
  const allBroadcasts = [
    ...fixture.sent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL),
    ...fixture.secondarySent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL),
  ];
  assert.equal(allBroadcasts.length, 4);
  assert.ok(allBroadcasts.every(([, value]) => value.status === "signing-in" && value.login === null));
  assert.doesNotMatch(JSON.stringify(allBroadcasts), /verificationUrl|userCode|loginId|authUrl|chatgpt\.com|auth\.openai\.com/);
  flight.resolve({ providerId: "openai-codex", state: "connected", generation: 1 });
  await Promise.all([first, second]);
  // A provider result without an authoritative terminal account event keeps
  // the scrub owner fail-closed. Once the account settles without ceremony,
  // a later explicit/legacy event is no longer provider-owned.
  account.emit("account-changed", { ...sensitive, status: "signed-out", login: null });
  account.emit("account-changed", { ...sensitive, status: "signed-out" });
  const after = fixture.sent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL).at(-1)?.[1];
  assert.equal(after.status, "signed-out");
  assert.deepEqual(after.login, sensitive.login);
});

test("provider-owned account-event sanitization stays active through disconnect cancellation and rejection", async (t) => {
  const { ACCOUNT_CHANGE_CHANNEL, IPC_CHANNELS } = require(runtimePath);
  const account = new EventEmitter();
  const flight = deferred();
  const cancellation = deferred();
  const sensitive = {
    status: "signing-in",
    authMode: null,
    login: {
      mode: "device-code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "LMNO-4567",
      loginId: "33333333-3333-4333-8333-333333333333",
      authUrl: "https://chatgpt.com/auth/codex?private=cancel",
    },
  };
  account.start = async () => {};
  account.accountState = () => ({ status: "signing-in", authMode: null, login: sensitive.login });
  account.catalogState = () => ({ generation: 1, status: "unavailable", models: [] });
  account.cancelLogin = async () => {};
  account.logout = async () => {};
  account.refresh = async () => {};
  account.dispose = () => account.removeAllListeners();
  const providerController = {
    connect() {
      account.emit("account-changed", sensitive);
      return flight.promise;
    },
    async disconnect() {
      account.emit("account-changed", sensitive);
      await cancellation.promise;
      account.emit("account-changed", { ...sensitive, status: "signed-out", login: null });
    },
    async listConnections() { return []; },
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; },
    async completeOnboarding() {},
    async readAuthoritySnapshot() { return null; },
    on() {},
    off() {},
    dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController, accountController: account });
  const connect = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "device-code" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const disconnect = fixture.handlers.get(IPC_CHANNELS.providerDisconnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    "openai-codex",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const beforeCancel = fixture.sent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL);
  assert.ok(beforeCancel.length >= 2);
  assert.doesNotMatch(JSON.stringify(beforeCancel), /verificationUrl|userCode|loginId|authUrl|chatgpt\.com|auth\.openai\.com/);
  flight.reject(new Error("provider canceled"));
  cancellation.resolve();
  await assert.rejects(connect, { code: "CODEX_BOT_OPERATION_FAILED" });
  await disconnect;
  const late = { ...sensitive, status: "signed-out" };
  account.emit("account-changed", late);
  const last = fixture.sent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL).at(-1)?.[1];
  assert.deepEqual(last.login, late.login);
});

test("failed provider-owned cancelLogin keeps broad account ceremony scrubbing until authoritative account settlement", async (t) => {
  const { ACCOUNT_CHANGE_CHANNEL, IPC_CHANNELS } = require(runtimePath);
  const account = new EventEmitter();
  const flight = deferred();
  const sensitive = {
    status: "signing-in",
    authMode: null,
    login: {
      mode: "device-code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      loginId: "44444444-4444-4444-8444-444444444444",
      authUrl: "https://chatgpt.com/auth/codex?private=failed-cancel",
    },
  };
  account.start = async () => {};
  account.accountState = () => sensitive;
  account.catalogState = () => ({ generation: 1, status: "unavailable", models: [] });
  account.cancelLogin = async () => { throw new Error("cancel failed"); };
  account.logout = async () => {};
  account.refresh = async () => {};
  account.dispose = () => account.removeAllListeners();
  const providerController = {
    connect() { return flight.promise; },
    async disconnect() {},
    async listConnections() { return []; },
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; },
    async completeOnboarding() {},
    async readAuthoritySnapshot() { return null; },
    on() {},
    off() {},
    dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    accountController: account,
    secondaryWindow: true,
  });
  const connect = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "device-code" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  account.emit("account-changed", sensitive);
  flight.reject(new Error("provider flight failed"));
  await assert.rejects(connect, { code: "CODEX_BOT_OPERATION_FAILED" });
  const cancel = fixture.handlers.get(IPC_CHANNELS.accountCancelLogin)({});
  await assert.rejects(cancel, { code: "CODEX_BOT_OPERATION_FAILED" });
  // The cleanup rejected without publishing a settled account state. A later
  // signing-in event must remain ceremony-free in every normal renderer.
  account.emit("account-changed", sensitive);
  const primary = fixture.sent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL);
  const secondary = fixture.secondarySent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL);
  assert.ok(primary.length >= 2);
  assert.ok(secondary.length >= 2);
  assert.ok(primary.every(([, value]) => value.login === null));
  assert.ok(secondary.every(([, value]) => value.login === null));
  assert.doesNotMatch(JSON.stringify(primary), /verificationUrl|userCode|loginId|authUrl|chatgpt\.com|auth\.openai\.com/);
  assert.doesNotMatch(JSON.stringify(secondary), /verificationUrl|userCode|loginId|authUrl|chatgpt\.com|auth\.openai\.com/);
  account.emit("account-changed", { ...sensitive, status: "signed-out", login: null });
});

test("failed provider-owned disconnect keeps broad account ceremony scrubbing until authoritative account settlement", async (t) => {
  const { ACCOUNT_CHANGE_CHANNEL, IPC_CHANNELS } = require(runtimePath);
  const account = new EventEmitter();
  const flight = deferred();
  const sensitive = {
    status: "signing-in",
    authMode: null,
    login: {
      mode: "device-code",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "WXYZ-9876",
      loginId: "55555555-5555-4555-8555-555555555555",
      authUrl: "https://chatgpt.com/auth/codex?private=failed-disconnect",
    },
  };
  account.start = async () => {};
  account.accountState = () => sensitive;
  account.catalogState = () => ({ generation: 1, status: "unavailable", models: [] });
  account.cancelLogin = async () => {};
  account.logout = async () => {};
  account.refresh = async () => {};
  account.dispose = () => account.removeAllListeners();
  const providerController = {
    connect() { return flight.promise; },
    async disconnect() { throw new Error("disconnect failed"); },
    async listConnections() { return []; },
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; },
    async completeOnboarding() {},
    async readAuthoritySnapshot() { return null; },
    on() {},
    off() {},
    dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    accountController: account,
    secondaryWindow: true,
  });
  const connect = fixture.handlers.get(IPC_CHANNELS.providerConnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    { providerId: "openai-codex", authMode: "device-code" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  account.emit("account-changed", sensitive);
  flight.reject(new Error("provider flight failed"));
  await assert.rejects(connect, { code: "CODEX_BOT_OPERATION_FAILED" });
  const disconnect = fixture.handlers.get(IPC_CHANNELS.providerDisconnect)(
    { sender: fixture.sender, senderFrame: fixture.frame },
    "openai-codex",
  );
  await assert.rejects(disconnect, { code: "CODEX_BOT_OPERATION_FAILED" });
  // A rejected disconnect is not authoritative account settlement. The next
  // account event must still be scrubbed, including in the secondary window.
  account.emit("account-changed", sensitive);
  const primary = fixture.sent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL);
  const secondary = fixture.secondarySent.filter(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL);
  assert.ok(primary.length >= 2);
  assert.ok(secondary.length >= 2);
  assert.ok(primary.every(([, value]) => value.login === null));
  assert.ok(secondary.every(([, value]) => value.login === null));
  assert.doesNotMatch(JSON.stringify(primary), /verificationUrl|userCode|loginId|authUrl|chatgpt\.com|auth\.openai\.com/);
  assert.doesNotMatch(JSON.stringify(secondary), /verificationUrl|userCode|loginId|authUrl|chatgpt\.com|auth\.openai\.com/);
  account.emit("account-changed", { ...sensitive, status: "signed-out", login: null });
});

test("explicit legacy account login keeps its existing account-event payload outside provider ownership", async (t) => {
  const { ACCOUNT_CHANGE_CHANNEL, IPC_CHANNELS } = require(runtimePath);
  const account = new EventEmitter();
  const state = {
    generation: 3,
    status: "signed-out",
    authMode: null,
    planType: null,
    requiresOpenaiAuth: true,
    login: null,
    rateLimits: null,
  };
  account.start = async () => {};
  account.accountState = () => state;
  account.catalogState = () => ({ generation: 1, status: "unavailable", models: [] });
  account.login = async () => {
    const next = {
      ...state,
      generation: 4,
      status: "signing-in",
      login: {
        mode: "device-code",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      },
    };
    account.emit("account-changed", next);
    return { state: next };
  };
  account.cancelLogin = async () => {};
  account.logout = async () => {};
  account.refresh = async () => {};
  account.dispose = () => account.removeAllListeners();
  const providerController = {
    async listConnections() { return []; },
    async connect() {},
    async disconnect() {},
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; },
    async completeOnboarding() {},
    async readAuthoritySnapshot() { return null; },
    on() {},
    off() {},
    dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController, accountController: account });
  await fixture.handlers.get(IPC_CHANNELS.accountLogin)({}, "device-code");
  const event = fixture.sent.find(([channel]) => channel === ACCOUNT_CHANGE_CHANNEL)?.[1];
  assert.equal(event.status, "signing-in");
  assert.deepEqual(event.login, {
    mode: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });
});

test("legacy account logout delegates to Direct Codex provider disconnect", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const calls = [];
  const providerController = {
    async disconnect(providerId) { calls.push(["provider-disconnect", providerId]); },
    async connect() {}, async listConnections() { return []; }, async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; }, async completeOnboarding() {}, async readAuthoritySnapshot() { return null; },
    on() {}, off() {}, dispose() {},
  };
  const accountController = {
    async start() {}, accountState() { return {}; }, catalogState() { return {}; },
    async login() {}, async cancelLogin() {}, async logout() { calls.push(["account-logout"]); }, async refresh() {},
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController, accountController });
  await fixture.handlers.get(IPC_CHANNELS.accountLogout)({});
  assert.deepEqual(calls, [["provider-disconnect", "openai-codex"]]);
});

test("account authority invalidation fences a late create before durable mutation", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const listeners = new Map();
  const providerController = {
    async readOnboarding() { return null; },
    async listConnections() { return []; },
    async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async connect() {}, async disconnect() {}, async completeOnboarding() {}, async readAuthoritySnapshot() { return null; },
    on(event, listener) { listeners.set(event, listener); }, off() {}, dispose() {},
  };
  const calls = [];
  let fenceResult = null;
  const controller = {
    on() {}, off() {}, dispose() {}, async listBots() { return []; },
    async createBot(_input, options) {
      calls.push(options);
      listeners.get("account:account-changed")?.({ status: "signed-out" });
      fenceResult = options.commitFence();
      throw new Error("late mutation");
    },
  };
  const accountController = {
    async start() {}, accountState() { return {}; }, catalogState() { return {}; },
    async login() {}, async cancelLogin() {}, async logout() {}, async refresh() {},
    on(event, listener) { listeners.set(`account:${event}`, listener); },
    off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    accountController,
    controllerOverride: controller,
    canCreateAgent: async () => true,
  });
  const pending = fixture.handlers.get(IPC_CHANNELS.create)({});
  await assert.rejects(pending, { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(calls.length, 1);
  assert.equal(fenceResult, false);
});

test("authority snapshot delegates exactly once without provider mutation", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const calls = [];
  const snapshot = Object.freeze({
    schemaVersion: 1,
    connections: Object.freeze([]),
    catalog: Object.freeze({ generation: 0, status: "unavailable", models: Object.freeze([]) }),
    onboarding: null,
  });
  const providerController = {
    async readAuthoritySnapshot() { calls.push("authority"); return snapshot; },
    async listConnections() { calls.push("list"); return []; },
    async connect() { calls.push("connect"); },
    async disconnect() { calls.push("disconnect"); },
    async catalog() { calls.push("catalog"); return snapshot.catalog; },
    async readOnboarding() { calls.push("onboarding-read"); return null; },
    async completeOnboarding() { calls.push("onboarding-complete"); },
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, { providerController });
  const event = { sender: fixture.sender, senderFrame: fixture.frame };
  assert.equal(IPC_CHANNELS.providerAuthoritySnapshot, "openbot-provider:authority-snapshot");
  const result = await fixture.handlers.get(IPC_CHANNELS.providerAuthoritySnapshot)(event);
  assert.strictEqual(result, snapshot);
  assert.deepEqual(calls, ["authority"]);
});

test("active bot identity read returns only a valid ID or null", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  for (const activeBotId of [BOT_A, null]) {
    const calls = [];
    const fixture = runtimeFixture(t, {
      selectionStore: {
        async readActiveBotId() { calls.push("read"); return activeBotId; },
        async selectBot() { calls.push("select"); throw new Error("must remain read-only"); },
      },
    });
    const event = { sender: fixture.sender, senderFrame: fixture.frame };
    assert.equal(IPC_CHANNELS.readActiveBotId, "codex-bot:read-active-bot-id");
    assert.equal(
      await fixture.handlers.get(IPC_CHANNELS.readActiveBotId)(event),
      activeBotId,
    );
    assert.deepEqual(calls, ["read"]);
  }
});

test("malformed active bot identity fails closed without selecting a bot", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const calls = [];
  const fixture = runtimeFixture(t, {
    selectionStore: {
      async readActiveBotId() { calls.push("read"); return { botId: BOT_A }; },
      async selectBot() { calls.push("select"); },
    },
  });
  const event = { sender: fixture.sender, senderFrame: fixture.frame };
  await assert.rejects(
    fixture.handlers.get(IPC_CHANNELS.readActiveBotId)(event),
    { code: "CODEX_BOT_OPERATION_FAILED" },
  );
  assert.deepEqual(calls, ["read"]);
});

test("read-only authority handlers reject a navigated main frame while startup is held", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const startup = deferred();
  let authorityReads = 0;
  let activeReads = 0;
  const snapshot = Object.freeze({
    schemaVersion: 1,
    connections: Object.freeze([]),
    catalog: Object.freeze({ generation: 0, status: "unavailable", models: Object.freeze([]) }),
    onboarding: null,
  });
  const providerController = {
    async readAuthoritySnapshot() { authorityReads += 1; return snapshot; },
    async listConnections() { return []; },
    async connect() {}, async disconnect() {}, async catalog() { return snapshot.catalog; },
    async readOnboarding() { return null; }, async completeOnboarding() {},
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    selectionStore: { async readActiveBotId() { activeReads += 1; return null; } },
    botDeletionCoordinator: {
      async reconcilePending() { return startup.promise; },
      async deleteBots() {},
      dispose() {},
    },
  });
  const event = { sender: fixture.sender, senderFrame: fixture.frame };
  const authorityPending = fixture.handlers.get(IPC_CHANNELS.providerAuthoritySnapshot)(event);
  const activePending = fixture.handlers.get(IPC_CHANNELS.readActiveBotId)(event);
  fixture.sender.mainFrame = { processId: 31, routingId: 48, isDestroyed: () => false };
  startup.resolve();
  await assert.rejects(authorityPending, { code: "CODEX_BOT_OPERATION_FAILED" });
  await assert.rejects(activePending, { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(authorityReads, 0);
  assert.equal(activeReads, 0);
});

test("read-only authority handlers fail closed when disposed before startup is ready", async (t) => {
  const { IPC_CHANNELS } = require(runtimePath);
  const startup = deferred();
  let authorityReads = 0;
  let activeReads = 0;
  const providerController = {
    async readAuthoritySnapshot() { authorityReads += 1; return null; },
    async listConnections() { return []; },
    async connect() {}, async disconnect() {}, async catalog() { return { status: "unavailable", generation: 0, models: [] }; },
    async readOnboarding() { return null; }, async completeOnboarding() {},
    on() {}, off() {}, dispose() {},
  };
  const fixture = runtimeFixture(t, {
    providerController,
    selectionStore: { async readActiveBotId() { activeReads += 1; return null; } },
    botDeletionCoordinator: {
      async reconcilePending() { return startup.promise; },
      async deleteBots() {},
      dispose() {},
    },
  });
  const event = { sender: fixture.sender, senderFrame: fixture.frame };
  const authorityPending = fixture.handlers.get(IPC_CHANNELS.providerAuthoritySnapshot)(event);
  const activePending = fixture.handlers.get(IPC_CHANNELS.readActiveBotId)(event);
  await fixture.installed.dispose();
  startup.resolve();
  await assert.rejects(authorityPending, { code: "CODEX_BOT_OPERATION_FAILED" });
  await assert.rejects(activePending, { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.equal(authorityReads, 0);
  assert.equal(activeReads, 0);
});

test("matching provider onboarding receipt permits IPC create after generation re-read", async (t) => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const calls = [];
  const providerController = {
    async readAuthoritySnapshot() { return { schemaVersion: 1, connections: [], catalog: { generation: 0, status: "unavailable", models: [] }, onboarding: null }; },
    async readOnboarding() { calls.push("receipt"); return { schemaVersion: 1, providerId: "openai-codex", connectionGeneration: 4, catalogGeneration: 4, completedAt: "2026-08-19T00:00:00.000Z" }; },
    async catalog() { calls.push("catalog"); return { status: "ready", generation: 4, models: [{ provider: "openai-codex", model: "gpt-live" }] }; },
    async listConnections() { calls.push("connections"); return [{ providerId: "openai-codex", state: "connected", generation: 4 }]; },
    async connect() {}, async disconnect() {}, async completeOnboarding() {},
    on() {}, off() {}, dispose() {},
  };
  const bot = { botId: BOT_A };
  const controller = {
    on() {}, off() {}, dispose() {},
    async createBot() { calls.push("create"); return bot; },
    async listBots() { return []; },
  };
  const electron = {
    app: { once() {} },
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    BrowserWindow: { getAllWindows() { return []; } },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    selectionStore: {},
    providerController,
  });
  t.after(() => installed.dispose());
  assert.deepEqual(await handlers.get(IPC_CHANNELS.create)({}), bot);
  assert.equal(calls.at(-1), "create");
  assert.deepEqual(calls.slice(0, 3), ["receipt", "connections", "catalog"]);
});

test("provider authority invalidated after the final catalog read fences IPC before the durable create boundary", async (t) => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const providerListeners = new Map();
  const calls = [];
  const providerController = {
    async readAuthoritySnapshot() { return { schemaVersion: 1, connections: [], catalog: { generation: 0, status: "unavailable", models: [] }, onboarding: null }; },
    async readOnboarding() {
      return { schemaVersion: 1, providerId: "openai-codex", connectionGeneration: 4, catalogGeneration: 4, completedAt: "2026-08-19T00:00:00.000Z" };
    },
    async listConnections() { return [{ providerId: "openai-codex", state: "connected", generation: 4 }]; },
    async catalog() {
      return { status: "ready", generation: 4, models: [{ provider: "openai-codex", model: "gpt-live" }] };
    },
    async connect() {}, async disconnect() {}, async completeOnboarding() {},
    on(event, listener) { providerListeners.set(event, listener); },
    off(event) { providerListeners.delete(event); },
    dispose() {},
  };
  const controller = {
    on() {}, off() {}, dispose() {},
    async listBots() { return []; },
    async createBot(_input, options) {
      providerListeners.get("catalog-changed")?.({ generation: 5, status: "unavailable", models: [] });
      calls.push(["create", options]);
      if (options?.commitFence?.() !== true) {
        const error = new Error("stale provider authority");
        error.code = "BOT_STORE_PROVIDER_AUTHORITY_STALE";
        throw error;
      }
      calls.push(["mutated"]);
      return { botId: BOT_A };
    },
  };
  const electron = {
    app: { once() {} },
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); }, removeHandler(channel) { handlers.delete(channel); } },
    BrowserWindow: { getAllWindows() { return []; } },
  };
  const installed = installDesktopRuntime(electron, {
    controller,
    store: {},
    selectionStore: {},
    providerController,
  });
  t.after(() => installed.dispose());
  assert.equal(providerListeners.has("catalog-changed"), true);
  let createOutcome;
  try { createOutcome = await handlers.get(IPC_CHANNELS.create)({}); } catch (error) { createOutcome = error; }
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0][1]?.commitFence, "function");
  assert.equal(calls[0][1].commitFence(), false);
  assert.equal(createOutcome?.code, "CODEX_BOT_OPERATION_FAILED");
  assert.equal(calls[0][0], "create");
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
  assert.equal(calls.some(([name]) => name === "account-start"), false);
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

test("a temporarily unavailable official catalog never rewrites a stored Direct Codex bot to CLIProxy", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const retained = Object.freeze({
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 7,
    generation: 11,
  });
  let writes = 0;
  const selectionStore = {
    async read() { return retained; },
    async writeNext() { writes += 1; throw new Error("stored Direct Codex selection must not be rewritten"); },
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
    controller: {
      on() {}, off() {}, dispose() {},
      async readBot(botId) { return botId === BOT_A ? { botId } : null; },
    },
    selectionStore,
    accountController: accountWithCatalog(Object.freeze({
      generation: 8,
      status: "loading",
      models: Object.freeze([]),
    })),
  });
  assert.equal(await handlers.get(IPC_CHANNELS.selectBot)({}, BOT_A), null);
  assert.equal(writes, 0);
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
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 1,
    generation: 5,
  }), {
    botId: BOT_A,
    provider: "anthropic-claude",
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
      Object.freeze({
        provider: "anthropic-claude",
        model: "claude-fable-5",
        displayName: "Claude Fable 5",
        defaultReasoningEffort: "max",
        defaultServiceTier: null,
        serviceTiers: Object.freeze([]),
        supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
        isDefault: false,
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
  assert.equal(optional.provider, "anthropic-claude");
  assert.equal(optional.catalogGeneration, 12);
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

test("native Grok model projection carries the Codex and CLIProxy catalogs through the existing picker schema", () => {
  const {
    nativeAvailableModels,
    nativeModelSelection,
    resolveModelSelection,
    resolveNativeModelSelection,
  } = require(runtimePath);
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-live-sol",
      displayName: "GPT Live Sol",
      defaultReasoningEffort: "high",
      defaultServiceTier: "priority",
      serviceTiers: Object.freeze([
        Object.freeze({ id: "priority", name: "Fast", description: "Lower latency" }),
        Object.freeze({ id: "ultrafast", name: "Ultra fast", description: "Fastest" }),
      ]),
      supportedReasoningEfforts: Object.freeze(["medium", "high", "ultra"]),
      inputModalities: Object.freeze(["text", "image"]),
      isDefault: true,
    }), Object.freeze({
      id: "gpt-effort-only",
      displayName: "GPT Effort Only",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      supportedReasoningEfforts: Object.freeze(["medium"]),
      inputModalities: Object.freeze(["text"]),
      isDefault: false,
    }), Object.freeze({
      provider: "anthropic-claude",
      model: "claude-fable-5",
      displayName: "Claude Fable 5",
      defaultReasoningEffort: "max",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
      isDefault: false,
    }), Object.freeze({
      provider: "anthropic-claude",
      model: "claude-opus-5",
      displayName: "Claude Opus 5",
      defaultReasoningEffort: "max",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
      isDefault: false,
    }), Object.freeze({
      provider: "anthropic-claude",
      model: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      defaultReasoningEffort: "max",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
      isDefault: false,
    })]),
  });
  assert.equal(typeof nativeAvailableModels, "function");
  const response = nativeAvailableModels(catalog);
  assert.equal(response.useModelParameters, true);
  assert.deepEqual(response.modelNames, response.models.map((model) => model.name));
  assert.deepEqual(response.models.map((model) => model.name), [
    "gpt-live-sol",
    "gpt-effort-only",
    "claude-fable-5",
    "claude-opus-5",
    "claude-sonnet-5",
  ]);
  assert.deepEqual(response.models.map((model) => model.vendor.id), [
    "MODEL_VENDOR_ID_OPENAI",
    "MODEL_VENDOR_ID_OPENAI",
    "MODEL_VENDOR_ID_ANTHROPIC",
    "MODEL_VENDOR_ID_ANTHROPIC",
    "MODEL_VENDOR_ID_ANTHROPIC",
  ]);
  const direct = response.models[0];
  assert.equal(direct.defaultOn, true);
  assert.deepEqual(direct.parameterDefinitions.map(({ id }) => id), ["effort", "speed"]);
  assert.deepEqual(
    direct.parameterDefinitions[0].parameterType.enumParameter.values.map(({ value }) => value),
    ["medium", "high", "ultra"],
  );
  assert.deepEqual(
    direct.parameterDefinitions[1].parameterType.enumParameter.values.map(({ value }) => value),
    ["standard", "priority", "ultrafast"],
  );
  assert.equal(direct.variants.length, 9);
  assert.equal(Object.isFrozen(response), true);

  const native = nativeModelSelection({
    provider: "openai-codex",
    model: "gpt-live-sol",
    reasoningEffort: "ultra",
    serviceTier: "priority",
  }, catalog);
  assert.deepEqual(native, {
    modelId: "gpt-live-sol",
    maxMode: true,
    parameters: [
      { id: "effort", value: "ultra" },
      { id: "speed", value: "priority" },
    ],
  });
  assert.deepEqual(resolveNativeModelSelection(native, BOT_A, catalog), {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-live-sol",
    reasoningEffort: "ultra",
    serviceTier: "priority",
    catalogGeneration: 12,
  });
  assert.deepEqual(nativeModelSelection({
    provider: "openai-codex",
    model: "gpt-effort-only",
    reasoningEffort: "medium",
    serviceTier: null,
  }, catalog), {
    modelId: "gpt-effort-only",
    maxMode: true,
    parameters: [{ id: "effort", value: "medium" }],
  });
  assert.deepEqual(nativeModelSelection({
    provider: "openai-codex",
    model: "gpt-live-sol",
    reasoningEffort: "medium",
    serviceTier: null,
  }, catalog).parameters, [
    { id: "effort", value: "medium" },
    { id: "speed", value: "standard" },
  ]);

  const optionalNative = nativeModelSelection({
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
  }, catalog);
  assert.equal(optionalNative.modelId, "claude-fable-5");
  assert.deepEqual(resolveNativeModelSelection(optionalNative, BOT_A, catalog), {
    botId: BOT_A,
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    serviceTier: null,
    catalogGeneration: 12,
  });

  const withoutMaxMode = structuredClone(native);
  delete withoutMaxMode.maxMode;
  assert.deepEqual(resolveNativeModelSelection(withoutMaxMode, BOT_A, catalog), {
    botId: BOT_A,
    provider: "openai-codex",
    model: "gpt-live-sol",
    reasoningEffort: "ultra",
    serviceTier: "priority",
    catalogGeneration: 12,
  });
  for (const malformed of [
    { ...native, maxMode: false },
    { ...native, parameters: [{ id: "effort", value: "ultra" }, { id: "fast", value: "true" }] },
    { ...native, parameters: [{ id: "effort", value: "ultra" }, { id: "serviceTier", value: "priority" }] },
    { ...native, parameters: [{ id: "speed", value: "priority" }, { id: "effort", value: "ultra" }] },
    { ...native, parameters: [{ id: "effort", value: "ultra" }] },
    { ...native, parameters: [{ id: "effort", value: "ultra", privateToken: "forbidden" }, { id: "speed", value: "priority" }] },
  ]) assert.throws(() => resolveNativeModelSelection(malformed, BOT_A, catalog), {
    code: "CODEX_BOT_INVALID_NATIVE_MODEL_SELECTION",
  });

  const collisionCatalog = Object.freeze({
    generation: 13,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "claude-fable-5",
      displayName: "Direct Claude Fable 5",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      supportedReasoningEfforts: Object.freeze(["medium"]),
      inputModalities: Object.freeze(["text"]),
      isDefault: true,
    }), Object.freeze({
      provider: "anthropic-claude",
      model: "claude-fable-5",
      displayName: "Claude Fable 5",
      defaultReasoningEffort: "medium",
      defaultServiceTier: null,
      serviceTiers: Object.freeze([]),
      supportedReasoningEfforts: Object.freeze(["medium", "max"]),
      inputModalities: Object.freeze(["text"]),
      isDefault: false,
    })]),
  });
  const collisionResponse = nativeAvailableModels(collisionCatalog);
  assert.equal(new Set(collisionResponse.modelNames).size, collisionResponse.modelNames.length);
  assert.deepEqual(collisionResponse.modelNames, [
    "openai-codex--claude-fable-5",
    "anthropic-claude--claude-fable-5",
  ]);
  assert.equal(nativeModelSelection({
    provider: "openai-codex",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  }, collisionCatalog).modelId, "openai-codex--claude-fable-5");
  assert.equal(nativeModelSelection({
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  }, collisionCatalog).modelId, "anthropic-claude--claude-fable-5");
  assert.equal(resolveNativeModelSelection({
    modelId: "openai-codex--claude-fable-5",
    maxMode: true,
    parameters: [{ id: "effort", value: "medium" }],
  }, BOT_A, collisionCatalog).provider, "openai-codex");
  assert.equal(resolveNativeModelSelection({
    modelId: "anthropic-claude--claude-fable-5",
    maxMode: true,
    parameters: [{ id: "effort", value: "medium" }],
  }, BOT_A, collisionCatalog).provider, "anthropic-claude");
  assert.equal(resolveModelSelection({
    botId: BOT_A,
    provider: "openai-codex",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  }, collisionCatalog).provider, "openai-codex");
  assert.equal(resolveModelSelection({
    botId: BOT_A,
    provider: "anthropic-claude",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  }, collisionCatalog).provider, "anthropic-claude");
  assert.throws(() => resolveModelSelection({
    botId: BOT_A,
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
  }, collisionCatalog), { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.throws(() => nativeAvailableModels(Object.freeze({
    ...collisionCatalog,
    models: Object.freeze([Object.freeze({
      ...collisionCatalog.models[0],
      id: "anthropic-claude--claude-fable-5",
    })]),
  })), { code: "CODEX_BOT_OPERATION_FAILED" });
  assert.throws(() => nativeAvailableModels(Object.freeze({
    ...catalog,
    models: Object.freeze([Object.freeze({
      ...catalog.models[0],
      defaultServiceTier: null,
      serviceTiers: Object.freeze([
        Object.freeze({ id: "standard", name: "Provider Standard" }),
      ]),
    })]),
  })), { code: "CODEX_BOT_OPERATION_FAILED" });
});

test("native model projection exposes only connected provider catalogs and prefixes exact collisions", () => {
  const { nativeAvailableModels, nativeModelSelection, resolveNativeModelSelection } = require(runtimePath);
  const catalog = Object.freeze({
    generation: 12,
    status: "ready",
    models: Object.freeze([
      Object.freeze({ provider: "openai-api-key", model: "shared-model", label: "API shared", efforts: ["high"], serviceTiers: [], defaultReasoningEffort: "high", defaultServiceTier: null, isDefault: true }),
      Object.freeze({ provider: "local-openai-compatible", model: "shared-model", label: "Local shared", efforts: ["none"], serviceTiers: [], defaultReasoningEffort: "none", defaultServiceTier: null, isDefault: false }),
    ]),
  });
  const projected = nativeAvailableModels(catalog);
  assert.deepEqual(projected.modelNames, ["openai-api-key--shared-model", "local-openai-compatible--shared-model"]);
  const apiSelection = nativeModelSelection({ provider: "openai-api-key", model: "shared-model", reasoningEffort: "high", serviceTier: null }, catalog);
  const localSelection = nativeModelSelection({ provider: "local-openai-compatible", model: "shared-model", reasoningEffort: "none", serviceTier: null }, catalog);
  assert.equal(apiSelection.modelId, "openai-api-key--shared-model");
  assert.equal(resolveNativeModelSelection(apiSelection, BOT_A, catalog).provider, "openai-api-key");
  assert.equal(resolveNativeModelSelection(localSelection, BOT_A, catalog).provider, "local-openai-compatible");
});

test("native provider projection keeps every provider label and vendor identity distinct", () => {
  const { nativeAvailableModels } = require(runtimePath);
  const providers = [
    ["openai-codex", "gpt-5.6-sol"],
    ["anthropic-claude", "claude-fable-5"],
    ["google-antigravity", "gemini-3.6-flash-high"],
    ["moonshot-kimi", "kimi-k3"],
    ["xai", "grok-4.5"],
    ["google-vertex-ai", "gemini-3.1-pro"],
    ["openai-api-key", "gpt-api"],
    ["local-openai-compatible", "local-model"],
  ];
  const response = nativeAvailableModels({
    generation: 3,
    status: "ready",
    models: providers.map(([provider, model]) => ({
      provider, model, label: model, efforts: ["none"], serviceTiers: [],
      defaultReasoningEffort: "none", defaultServiceTier: null,
    })),
  });
  assert.deepEqual(response.models.map((entry) => [entry.vendorName, entry.vendor.displayName]), [
    ["OpenAI Codex", "OpenAI Codex"],
    ["Anthropic Claude", "Anthropic Claude"],
    ["Google Antigravity", "Google Antigravity"],
    ["Moonshot Kimi", "Moonshot Kimi"],
    ["xAI", "xAI"],
    ["Google Vertex AI", "Google Vertex AI"],
    ["OpenAI API key", "OpenAI API key"],
    ["Local models", "Local models"],
  ]);
  assert.equal(new Set(response.models.map((entry) => entry.vendor.id)).size, providers.length);
});
