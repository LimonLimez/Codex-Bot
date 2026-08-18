"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const runtimePath = path.join(macRoot, "src", "desktop", "runtime.cjs");
const desktopPatchPath = path.join(macRoot, "src", "patch", "desktop.cjs");
const rendererPatchPath = path.join(macRoot, "src", "patch", "renderer.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";

const STOCK_PRELOAD = 'const stock="kept";const L=M({invokeRequest:()=>{s.ipcRenderer.invoke("sand:coordinator-port-request")}});s.contextBridge.exposeInMainWorld("desktop",Q);s.contextBridge.exposeInMainWorld("coordinatorPort",X);s.ipcRenderer.on("sand:coordinator-port",e=>{});\n';
const STOCK_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Grok Bot</title>
    <script type="module" crossorigin src="./assets/index-CphCyQnY.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;
const STOCK_NATIVE_SHELL_GATE = 'function MHn(){const n=wLt(),{phase:e,onboardingRunId:t,completeOnboarding:s}=RFn();return n?p.jsxs(p.Fragment,{children:[p.jsx(Upe,{}),p.jsx(ggt,{})]}):e==="checking"?null:p.jsx(TDn,{chrome:JHn,children:e==="onboarding"?p.jsx(qFn,{onComplete:s,presentation:KUn},t):p.jsx(BHn,{})})}';
const STOCK_PROMPT_TRAILING = 'se=p.jsx("div",{className:ne,ref:d,style:X.style,children:Q})';
const STOCK_LOCAL_IDENTITY_ANCHORS = [
  'const Bgt={slice:"send-journal",schemaVersion:2,scope:"client-persisted",accountSensitive:!0}',
  'bt=()=>{if(!(Ge||t.get().status!=="ready"||s==null)){',
  'mt=()=>{if(Ge||t.get().status!=="ready"||s==null)return;',
  ':s?f!=null?W._(mbn(f)):i.length>0?U({id:"I/1BxG"}):C??W._(dht):U({id:"622+sP"})',
  'if(await j.write({accountSlot:null,value:Ve}),!Ye()||(await B.restore(Ve),!Ye())||(await q.restore(Ve),!Ye())||(await K.restore(Ve),!Ye())||(await F.restore(Ve),!Ye())||(await ne.restore(Ve),!Ye())||(await Z.restore(Ve),!Ye())||(await ke.restore(Ve),!Ye()))return;',
  'Ve!=null&&F.connect()',
  'Ve!=null&&(B.loadPinnedAgentsFromBox(),q.loadFromBox(),ke.reconcileWithHost())',
  'onIdentityRestoreComplete:({accountSlot:n})=>Whe.completeIdentityChange({acceptPort:n!=null})',
].join(";");
const SYNTHETIC_VENDOR_RENDERER = `const before="kept";${STOCK_NATIVE_SHELL_GATE}${STOCK_LOCAL_IDENTITY_ANCHORS}${STOCK_PROMPT_TRAILING}const after="kept";`;

function sha256Text(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-standalone-wiring-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function manualCleanupClock() {
  let timer = null;
  return Object.freeze({
    options: Object.freeze({
      setCleanupTimeout(callback, milliseconds) {
        assert.equal(timer, null);
        timer = { callback, cleared: false, milliseconds };
        return timer;
      },
      clearCleanupTimeout(value) {
        assert.equal(value, timer);
        value.cleared = true;
      },
    }),
    delay() { return timer?.milliseconds ?? null; },
    pending() { return Boolean(timer && !timer.cleared); },
    fire() {
      assert.equal(this.pending(), true);
      timer.cleared = true;
      timer.callback();
    },
  });
}

test("patching keeps the native Grok shell and does not stage the replacement standalone renderer", (t) => {
  const { ASSETS, patchRenderer, patchRendererIndexSource } = require(rendererPatchPath);
  const { DESKTOP_FILES, patchPreloadSource } = require(desktopPatchPath);
  assert.equal(DESKTOP_FILES.includes("desktop/bot-deletion-coordinator.cjs"), true);
  assert.equal(DESKTOP_FILES.includes("desktop/standalone-conversation-controller.cjs"), true);
  assert.equal(DESKTOP_FILES.includes("desktop/standalone-conversation-ipc.cjs"), true);
  assert.equal(DESKTOP_FILES.includes("desktop/standalone-conversation-store.cjs"), true);
  assert.equal(DESKTOP_FILES.includes("desktop/local-desktop-frame-ipc.cjs"), true);
  const preload = patchPreloadSource(STOCK_PRELOAD);
  assert.match(preload, /exposeInMainWorld\("openbotConversations"/);
  assert.match(preload, /exposeInMainWorld\("openbotLocalDesktop"/);
  assert.match(preload, /openbot-local-frame:select/);
  assert.match(preload, /openbot-local-frame:clear/);
  assert.match(preload, /openbot-local-frame:frame/);
  for (const method of ["list", "create", "read", "send", "cancel", "onChanged", "onEvent"]) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  const index = patchRendererIndexSource(STOCK_INDEX);
  const desktopView = index.indexOf("./codex/openbot-local-desktop-view.js");
  const controls = index.indexOf("./codex/bot-runtime-ui.js");
  assert.ok(desktopView >= 0 && controls > desktopView);
  assert.match(index, /\.\/codex\/openbot-local-desktop-view\.css/);
  assert.doesNotMatch(index, /openbot-standalone-shell/);
  assert.deepEqual(ASSETS, [
    "bot-runtime-ui.js",
    "codex-ui.css",
    "model-controls.js",
    "openbot-local-desktop-view.css",
    "openbot-local-desktop-view.js",
    "reasoning-control.js",
  ]);

  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "dist", "renderer", "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "renderer", "index.html"), STOCK_INDEX);
  fs.writeFileSync(
    path.join(root, "dist", "renderer", "assets", "index-CphCyQnY.js"),
    SYNTHETIC_VENDOR_RENDERER,
  );
  patchRenderer(root, { expectedVendorRendererSha256: sha256Text(SYNTHETIC_VENDOR_RENDERER) });
  const staged = path.join(root, "dist", "renderer", "codex");
  assert.deepEqual(fs.readdirSync(staged).sort(), ASSETS);
  for (const asset of [
    "openbot-local-desktop-view.css", "openbot-local-desktop-view.js",
  ]) {
    assert.deepEqual(
      fs.readFileSync(path.join(staged, asset)),
      fs.readFileSync(path.join(macRoot, "src", "renderer", asset)),
    );
  }
  assert.equal(fs.existsSync(path.join(staged, "openbot-standalone-shell.js")), false);
  assert.equal(fs.existsSync(path.join(staged, "openbot-standalone-shell.css")), false);
});

test("the inference factory gives standalone and preserved host one router", () => {
  const { createInferenceBridgeRuntime } = require(runtimePath);
  const constructed = [];
  class DirectTransportFixture {
    constructor(options) { this.options = options; constructed.push(["direct", this]); }
  }
  class RouterFixture {
    constructor(options) { this.options = options; constructed.push(["router", this]); }
    stream() {}
  }
  class StandaloneFixture {
    constructor(options) { this.options = options; constructed.push(["standalone", this]); }
  }
  class StoreFixture {
    constructor(options) { this.options = options; constructed.push(["store", this]); }
  }
  class BridgeFixture {
    constructor(options) { this.options = options; constructed.push(["bridge", this]); }
  }
  const toolBridge = Object.freeze({ open() {} });
  const computerTargetRouter = Object.freeze({ async resolve() {} });
  const stateRoot = "/tmp/openbot-standalone-shared-router";
  const bridge = createInferenceBridgeRuntime({
    codexManager: {},
    selectionStore: { async read() { return null; } },
    sidecarManager: { async start() {} },
    stateRoot,
    toolBridge,
    computerTargetRouter,
    capability: "a".repeat(64),
    DirectTransportClass: DirectTransportFixture,
    RouterClass: RouterFixture,
    StandaloneControllerClass: StandaloneFixture,
    StandaloneStoreClass: StoreFixture,
    BridgeClass: BridgeFixture,
    OptionalTransportClass: class OptionalTransportFixture {},
  });
  assert.deepEqual(constructed.map(([name]) => name), ["direct", "router", "store", "standalone", "bridge"]);
  assert.equal(bridge.conversations, constructed[3][1]);
  assert.equal(constructed[3][1].options.router, constructed[1][1]);
  assert.equal(constructed[4][1].options.router, constructed[1][1]);
  assert.equal(constructed[4][1].options.computerTargetRouter, computerTargetRouter);
  assert.equal(constructed[3][1].options.readSelection, constructed[1][1].options.readSelection);
  assert.equal(constructed[3][1].options.store, constructed[2][1]);
  assert.equal(constructed[3][1].options.toolBridge, toolBridge);
  assert.equal(constructed[2][1].options.filePath, path.join(stateRoot, "standalone-conversations.v1.json"));
});

test("top-level computer composition shares one manager and one target router with standalone tools", () => {
  const { createStandaloneComputerComposition } = require(runtimePath);
  const store = { read() {}, updateComputer() {} };
  const manager = { open() {}, run() {}, navigate() {}, capture() {} };
  const boundary = { dispose() {} };
  const made = [];
  class TargetRouterFixture {
    constructor(options) { this.options = options; made.push(["target", this]); }
    resolve() {}
    run() {}
    disposeTask() {}
    dispose() {}
  }
  const composition = createStandaloneComputerComposition({
    electron: {},
    stateRoot: "/tmp/openbot-computer-composition",
    store,
    createComponents(options) {
      made.push(["components", options]);
      return { boundary, manager };
    },
    TargetRouterClass: TargetRouterFixture,
    createToolBridge(options) { made.push(["tools", options]); return { open() {} }; },
  });
  assert.deepEqual(Object.keys(composition).sort(), ["boundary", "localManager", "targetRouter", "toolBridge"]);
  assert.equal(Object.isFrozen(composition), true);
  assert.equal(composition.boundary, boundary);
  assert.equal(composition.localManager, manager);
  assert.equal(composition.targetRouter.options.store, store);
  assert.equal(composition.targetRouter.options.localManager, manager);
  assert.equal(made[2][1].computerTargetRouter, composition.targetRouter);
});

test("desktop runtime installs standalone handlers only for current OpenBot windows", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const { STANDALONE_IPC_CHANNELS } = require("../src/desktop/standalone-conversation-ipc.cjs");
  const { LOCAL_DESKTOP_FRAME_CHANNELS } = require("../src/desktop/local-desktop-frame-ipc.cjs");
  const { OPENBOT_NATIVE_COORDINATOR_CHANNELS } = require("../src/desktop/openbot-native-coordinator-ipc.cjs");
  const handlers = new Map();
  const senderFrame = { processId: 31, routingId: 47, isDestroyed: () => false };
  const sender = { mainFrame: senderFrame, isDestroyed: () => false, send() {} };
  const window = { isDestroyed: () => false, webContents: sender };
  const electron = {
    app: { once() {} },
    MessageChannelMain: class {},
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(value) { return value === sender ? window : null; },
      getAllWindows() { return [window]; },
    },
  };
  class Conversations extends EventEmitter {
    list() { return []; }
    create() { throw new Error("unused"); }
    read() { throw new Error("unused"); }
    send() { throw new Error("unused"); }
    cancel() { throw new Error("unused"); }
    dispose() { this.disposed = true; }
  }
  const standaloneConversations = new Conversations();
  const nativeCoordinator = {
    disposed: 0,
    bindPort() { return () => {}; },
    dispose() { this.disposed += 1; },
  };
  let targetDisposed = 0;
  const installed = installDesktopRuntime(electron, {
    controller: {
      on() {}, off() {}, dispose() {},
      async readBot(botId) { return botId === BOT_A ? { botId } : null; },
    },
    selectionStore: {},
    standaloneConversations,
    nativeCoordinator,
    localDesktopManager: {
      ownsWindow() { return false; }, async open() {}, async captureDisplayFrame() { throw new Error("unused"); },
    },
    computerTargetRouter: { dispose() { targetDisposed += 1; } },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });
  for (const channel of Object.values(STANDALONE_IPC_CHANNELS)) assert.equal(handlers.has(channel), true);
  for (const channel of Object.values(LOCAL_DESKTOP_FRAME_CHANNELS)) assert.equal(handlers.has(channel), true);
  assert.equal(handlers.has(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request), true);
  assert.deepEqual(await handlers.get(STANDALONE_IPC_CHANNELS.list)({ sender, senderFrame }, BOT_A), []);
  await assert.rejects(handlers.get(STANDALONE_IPC_CHANNELS.list)({ sender: {} }, BOT_A), {
    code: "OPENBOT_CONVERSATION_OPERATION_FAILED",
  });
  await installed.dispose();
  for (const channel of Object.values(STANDALONE_IPC_CHANNELS)) assert.equal(handlers.has(channel), false);
  for (const channel of Object.values(LOCAL_DESKTOP_FRAME_CHANNELS)) assert.equal(handlers.has(channel), false);
  assert.equal(handlers.has(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request), false);
  assert.equal(standaloneConversations.disposed, true);
  assert.equal(nativeCoordinator.disposed, 1);
  assert.equal(targetDisposed, 1);
});

test("signed-out native Grok bot selection and local models remain available while remote Work is absent", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const handlers = new Map();
  const sent = [];
  const selected = [];
  const ensured = [];
  let storedSelection = null;
  let factoryOptions = null;
  const nativeCoordinator = {
    bindPort() { return () => {}; },
    dispose() {},
  };
  const sender = { isDestroyed: () => false, send(channel, value) { sent.push([channel, value]); } };
  const window = { isDestroyed: () => false, webContents: sender };
  const electron = {
    app: { once() {} },
    MessageChannelMain: class {},
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(value) { return value === sender ? window : null; },
      getAllWindows() { return [window]; },
    },
  };
  const installed = installDesktopRuntime(electron, {
    controller: {
      on() {}, off() {}, dispose() {},
      async readBot(botId) { return botId === BOT_A ? { botId } : null; },
    },
    selectionStore: {
      async read() { return storedSelection; },
      async ensure(botId, selection) {
        ensured.push([botId, selection]);
        storedSelection = Object.freeze({ ...selection, generation: 1 });
        return storedSelection;
      },
      async selectBot(botId) { selected.push(botId); },
      async readActiveBotId() { return BOT_A; },
    },
    nativeCoordinatorFactory(options) {
      factoryOptions = options;
      return nativeCoordinator;
    },
    accountController: {
      async start() {},
      accountState() { return {}; },
      catalogState() {
        return Object.freeze({
          generation: 7,
          status: "unavailable",
          models: Object.freeze([]),
        });
      },
      on() {}, off() {}, dispose() {},
    },
  });
  assert.equal(typeof factoryOptions?.onSelectAgent, "function");
  await factoryOptions.onSelectAgent(BOT_A);
  assert.equal(ensured.length, 1);
  assert.equal(ensured[0][0], BOT_A);
  assert.deepEqual(ensured[0][1], {
    botId: BOT_A,
    provider: "cliproxy-anthropic",
    model: "claude-fable-5",
    reasoningEffort: "medium",
    serviceTier: null,
    catalogGeneration: 1,
  });
  assert.deepEqual(selected, [BOT_A]);
  assert.equal(typeof factoryOptions.modelController?.getAvailableModels, "function");
  const nativeCatalog = await factoryOptions.modelController.getAvailableModels();
  assert.deepEqual(nativeCatalog.modelNames, [
    "cliproxy-anthropic--claude-fable-5",
    "cliproxy-anthropic--claude-opus-5",
    "cliproxy-anthropic--claude-sonnet-5",
  ]);
  assert.deepEqual(await factoryOptions.modelController.getAgentDefaultModel(), {
    modelId: "cliproxy-anthropic--claude-fable-5",
    maxMode: true,
    parameters: [{ id: "effort", value: "medium" }],
  });
  assert.deepEqual(sent, [["codex-runtime:event", {
    type: "active-bot-changed",
    botId: BOT_A,
  }]]);
  await installed.dispose();
});

test("desktop runtime starts every owner before awaiting standalone and Local Desktop cancellation", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const handlers = new Map();
  const order = [];
  const conversationsGate = deferred();
  const boundaryGate = deferred();
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  const conversations = new EventEmitter();
  Object.assign(conversations, {
    list() { return []; }, create() {}, read() {}, send() {}, cancel() {},
    async dispose() {
      order.push("conversations-start");
      await conversationsGate.promise;
      order.push("conversations-done");
    },
  });
  const boundary = new EventEmitter();
  Object.assign(boundary, {
    async dispose() {
      order.push("boundary-start");
      await boundaryGate.promise;
      order.push("boundary-done");
    },
  });
  const installed = installDesktopRuntime(electron, {
    controller: { on() {}, off() {}, dispose() { order.push("controller"); } },
    selectionStore: {},
    standaloneConversations: conversations,
    computerBoundary: boundary,
    computerTargetRouter: { dispose() { order.push("target-router"); } },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() { order.push("account"); },
    },
    codexManager: { async start() {}, stop() { order.push("codex"); } },
    sidecarManager: { stop() { order.push("sidecar"); } },
  });

  let settled = false;
  const first = installed.dispose();
  const second = installed.dispose();
  first.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first, second);
  assert.equal(settled, false);
  assert.equal(handlers.size, 0);
  assert.deepEqual(order, [
    "conversations-start", "boundary-start", "target-router", "account", "codex", "sidecar", "controller",
  ]);

  conversationsGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [
    "conversations-start", "boundary-start", "target-router", "account", "codex", "sidecar", "controller",
    "conversations-done",
  ]);
  assert.equal(settled, false);
  boundaryGate.resolve();
  await first;
  assert.deepEqual(order, [
    "conversations-start", "boundary-start", "target-router", "account", "codex", "sidecar", "controller",
    "conversations-done", "boundary-done",
  ]);
});

test("top-level runtime disposal releases an adopted Computer source while merged subagent open stays hung", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const { StandaloneConversationController } = require("../src/desktop/standalone-conversation-controller.cjs");
  const cleanupClock = manualCleanupClock();
  const runnerOpenEntered = deferred();
  const runnerOpenGate = deferred();
  const toolDisposalGate = deferred();
  const runnerDisposalEntered = deferred();
  let toolDisposals = 0;
  let runnerDisposals = 0;
  let streams = 0;
  const identifiers = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const conversations = new StandaloneConversationController({
    router: {
      async stream() {
        streams += 1;
        throw new Error("cancelled partial open must not stream");
      },
    },
    toolBridge: {
      async open(identity) {
        return Object.freeze({
          ...identity,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("cancelled partial open must not dispatch"); },
          async dispose() {
            toolDisposals += 1;
            await toolDisposalGate.promise;
          },
        });
      },
    },
    subagentRunner: {
      async open(identity) {
        runnerOpenEntered.resolve();
        await runnerOpenGate.promise;
        return Object.freeze({
          botId: identity.botId,
          conversationId: identity.conversationId,
          taskId: identity.taskId,
          definitions: Object.freeze([]),
          async dispatch() { throw new Error("late source must not dispatch"); },
          async dispose() {
            runnerDisposals += 1;
            runnerDisposalEntered.resolve();
          },
        });
      },
      async dispose() {},
    },
    async readSelection() {
      return Object.freeze({
        botId: BOT_A,
        generation: 7,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "ultra",
        serviceTier: null,
      });
    },
    makeId() {
      const value = identifiers.shift();
      if (!value) throw new Error("test exhausted deterministic IDs");
      return value;
    },
    now: () => "2026-08-16T12:00:00.000Z",
    ...cleanupClock.options,
  });
  const created = conversations.create({ botId: BOT_A });
  const sending = conversations.send({
    botId: BOT_A,
    conversationId: created.conversationId,
    text: "Dispose partial merged open",
  });
  const rejectedSending = assert.rejects(sending, { code: "OPENBOT_CONVERSATION_CANCELLED" });
  await runnerOpenEntered.promise;

  const electron = {
    app: { on() {}, off() {} },
    ipcMain: { handle() {}, removeHandler() {} },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  const installed = installDesktopRuntime(electron, {
    controller: { on() {}, off() {}, dispose() {} },
    selectionStore: {},
    standaloneConversations: conversations,
    computerBoundary: { on() {}, off() {}, dispose() {} },
    computerTargetRouter: { dispose() {} },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });
  let runtimeSettled = false;
  const runtimeDisposal = installed.dispose().then(() => { runtimeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  for (let attempt = 0; attempt < 20 && !cleanupClock.pending(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(toolDisposals, 1);
  assert.equal(cleanupClock.delay(), 250);
  assert.equal(cleanupClock.pending(), true);
  cleanupClock.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeSettled, false);
  toolDisposalGate.resolve();
  await runtimeDisposal;
  await rejectedSending;
  assert.equal(toolDisposals, 1);
  assert.equal(runnerDisposals, 0);
  assert.equal(streams, 0);

  runnerOpenGate.resolve();
  await runnerDisposalEntered.promise;
  assert.equal(toolDisposals, 1);
  assert.equal(runnerDisposals, 1);
  assert.equal(streams, 0);
});

test("every repeated before-quit is prevented until one disposal acknowledgement and one final quit", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const gate = deferred();
  const beforeQuitListeners = new Set();
  let prevented = 0;
  let quits = 0;
  const electron = {
    app: {
      on(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.add(listener); },
      off(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.delete(listener); },
      quit() {
        quits += 1;
        for (const listener of [...beforeQuitListeners]) listener({ preventDefault() { prevented += 1; } });
      },
    },
    ipcMain: { handle() {}, removeHandler() {} },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  installDesktopRuntime(electron, {
    controller: { on() {}, off() {}, dispose() {} },
    selectionStore: {},
    computerBoundary: { on() {}, off() {}, async dispose() { await gate.promise; } },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });
  assert.equal(beforeQuitListeners.size, 1);
  const requestQuit = () => {
    for (const listener of [...beforeQuitListeners]) listener({ preventDefault() { prevented += 1; } });
  };
  requestQuit();
  requestQuit();
  requestQuit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, 3);
  assert.equal(quits, 0);
  gate.resolve();
  for (let attempt = 0; attempt < 20 && quits === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(quits, 1);
  assert.equal(prevented, 3);
  assert.equal(beforeQuitListeners.size, 0);
});

test("quit deadline hands off once after every owned disposer starts without falsifying acknowledgement", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const boundaryGate = deferred();
  const beforeQuitListeners = new Set();
  const disposalCalls = new Map();
  let deadline = null;
  let prevented = 0;
  let quits = 0;
  let vendorQuitEvents = 0;
  const vendorListener = () => { vendorQuitEvents += 1; };
  beforeQuitListeners.add(vendorListener);
  const noteDisposal = (name, effect = () => undefined) => () => {
    disposalCalls.set(name, (disposalCalls.get(name) || 0) + 1);
    return effect();
  };
  const electron = {
    app: {
      on(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.add(listener); },
      off(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.delete(listener); },
      quit() {
        quits += 1;
        for (const listener of [...beforeQuitListeners]) listener({ preventDefault() { prevented += 1; } });
      },
      exit() { assert.fail("OpenBot must hand shutdown back through app.quit()."); },
    },
    ipcMain: { handle() {}, removeHandler() {} },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  const installed = installDesktopRuntime(electron, {
    controller: {
      on() {}, off() {},
      dispose: noteDisposal("controller"),
    },
    selectionStore: {},
    computerBoundary: {
      on() {}, off() {},
      dispose: noteDisposal("computer-boundary", () => boundaryGate.promise),
    },
    computerTargetRouter: { dispose: noteDisposal("computer-router") },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose: noteDisposal("account"),
    },
    inferenceBridge: { dispose: noteDisposal("inference-bridge") },
    codexManager: { stop: noteDisposal("codex") },
    sidecarManager: { stop: noteDisposal("sidecar") },
    setQuitTimeout(callback, milliseconds) {
      assert.equal(deadline, null);
      assert.equal(typeof callback, "function");
      assert.equal(Number.isFinite(milliseconds) && milliseconds > 0, true);
      deadline = { callback, cleared: false };
      return deadline;
    },
    clearQuitTimeout(value) {
      assert.equal(value, deadline);
      value.cleared = true;
    },
  });
  const requestQuit = () => {
    for (const listener of [...beforeQuitListeners]) listener({ preventDefault() { prevented += 1; } });
  };

  requestQuit();
  requestQuit();
  requestQuit();
  assert.equal(prevented, 3);
  assert.equal(vendorQuitEvents, 3);
  assert.deepEqual(Object.fromEntries(disposalCalls), {
    "computer-boundary": 1,
    "computer-router": 1,
    account: 1,
    "inference-bridge": 1,
    codex: 1,
    sidecar: 1,
    controller: 1,
  });
  assert.equal(quits, 0);
  assert.equal(Boolean(deadline && !deadline.cleared), true);
  let disposalSettled = false;
  const disposal = installed.dispose().then(() => { disposalSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposalSettled, false);

  deadline.cleared = true;
  deadline.callback();
  assert.equal(quits, 1);
  assert.equal(prevented, 3);
  assert.equal(vendorQuitEvents, 4);
  assert.equal(beforeQuitListeners.size, 1);
  assert.equal(beforeQuitListeners.has(vendorListener), true);

  boundaryGate.resolve();
  await disposal;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposalSettled, true);
  assert.equal(quits, 1);
  assert.deepEqual([...disposalCalls.values()], [1, 1, 1, 1, 1, 1, 1]);
});

test("reentrant before-quit during synchronous handler removal shares one cleanup and one final quit", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const beforeQuitListeners = new Set();
  let prevented = 0;
  let quits = 0;
  let controllerDisposals = 0;
  let boundaryDisposals = 0;
  let reentered = false;
  const requestQuit = () => {
    for (const listener of [...beforeQuitListeners]) {
      listener({ preventDefault() { prevented += 1; } });
    }
  };
  const electron = {
    app: {
      on(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.add(listener); },
      off(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.delete(listener); },
      quit() { quits += 1; requestQuit(); },
    },
    ipcMain: {
      handle() {},
      removeHandler() {
        if (reentered) return;
        reentered = true;
        requestQuit();
      },
    },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  installDesktopRuntime(electron, {
    controller: {
      on() {}, off() {},
      dispose() { controllerDisposals += 1; },
    },
    selectionStore: {},
    computerBoundary: {
      on() {}, off() {},
      dispose() { boundaryDisposals += 1; },
    },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });

  requestQuit();
  for (let attempt = 0; attempt < 20 && quits === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(prevented, 2);
  assert.equal(controllerDisposals, 1);
  assert.equal(boundaryDisposals, 1);
  assert.equal(quits, 1);
  assert.equal(beforeQuitListeners.size, 0);
});

test("a synchronous teardown exception cannot orphan repeated before-quit cleanup", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const boundaryGate = deferred();
  const beforeQuitListeners = new Set();
  const listenerErrors = [];
  let prevented = 0;
  let quits = 0;
  let removeAttempts = 0;
  let controllerDisposals = 0;
  let boundaryDisposals = 0;
  const requestQuit = () => {
    for (const listener of [...beforeQuitListeners]) {
      try {
        listener({ preventDefault() { prevented += 1; } });
      } catch (error) {
        listenerErrors.push(error);
      }
    }
  };
  const electron = {
    app: {
      on(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.add(listener); },
      off(event, listener) { assert.equal(event, "before-quit"); beforeQuitListeners.delete(listener); },
      quit() { quits += 1; requestQuit(); },
    },
    ipcMain: {
      handle() {},
      removeHandler() {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("one-shot remove failure");
      },
    },
    BrowserWindow: { fromWebContents() { return null; }, getAllWindows() { return []; } },
  };
  installDesktopRuntime(electron, {
    controller: {
      on() {}, off() {},
      dispose() { controllerDisposals += 1; },
    },
    selectionStore: {},
    computerBoundary: {
      on() {}, off() {},
      async dispose() {
        boundaryDisposals += 1;
        await boundaryGate.promise;
      },
    },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });

  requestQuit();
  requestQuit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, 2);
  assert.deepEqual(listenerErrors, []);
  assert.equal(boundaryDisposals, 1);
  assert.equal(controllerDisposals, 1);
  assert.equal(quits, 0);

  boundaryGate.resolve();
  for (let attempt = 0; attempt < 20 && quits === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controllerDisposals, 1);
  assert.equal(boundaryDisposals, 1);
  assert.equal(quits, 1);
  assert.equal(prevented, 2);
  assert.equal(beforeQuitListeners.size, 0);
});
