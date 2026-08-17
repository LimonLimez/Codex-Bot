"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const runtimePath = path.join(__dirname, "..", "src", "desktop", "runtime.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function computerRecord() {
  return Object.freeze({
    botId: BOT_A,
    computer: Object.freeze({
      mode: "local",
      generation: 1,
      localProfileId: LOCAL_A,
      nativeAgentId: null,
      state: "ready",
      lastConfirmedAt: "2026-08-16T12:00:00.000Z",
      lastErrorCode: null,
    }),
  });
}

function electronHarness() {
  const handlers = new Map();
  const delivered = [];
  const sent = [];
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (...args) => { sent.push(args); };
  sender.mainFrame = {
    processId: 41,
    routingId: 73,
    isDestroyed: () => false,
  };
  const senderFrame = {
    processId: 41,
    routingId: 73,
    isDestroyed: () => false,
    postMessage(channel, value, ports) { delivered.push({ channel, value, ports }); },
  };
  const window = {
    webContents: sender,
    isDestroyed: () => false,
  };
  class Port extends EventEmitter {
    start() {}
    close() {}
    postMessage() {}
  }
  class MessageChannelMain {
    constructor() {
      this.port1 = new Port();
      this.port2 = new Port();
    }
  }
  const electron = {
    app: {
      on() {},
      off() {},
    },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    MessageChannelMain,
    BrowserWindow: {
      fromWebContents(value) { return value === sender ? window : null; },
      getAllWindows() { return [window]; },
    },
  };
  return {
    delivered,
    electron,
    event: { sender, senderFrame },
    handlers,
    sent,
  };
}

function conversationsFixture(effects, order = null) {
  const conversations = new EventEmitter();
  Object.assign(conversations, {
    list() { effects.standaloneLists += 1; return []; },
    create() { throw new Error("unused"); },
    read() { throw new Error("unused"); },
    send() { throw new Error("unused"); },
    cancel() { throw new Error("unused"); },
    dispose() { order?.push("conversations"); },
  });
  return conversations;
}

test("production deletion composition shares the exact durable cleanup owners", () => {
  const { createBotDeletionCoordinator } = require(runtimePath);
  assert.equal(typeof createBotDeletionCoordinator, "function");
  const dependencies = {
    controller: { deleteBots() {} },
    store: { list() {}, listPendingDeletions() {}, completeDeletion() {} },
    conversations: { deleteBots() {} },
    computerTargetRouter: { deleteBot() {} },
    computerBoundary: { deleteBot() {} },
    selectionStore: { deleteBots() {} },
    conversationBindingsPath: "/tmp/openbot-delete-runtime-wiring-bindings.json",
  };
  const deleteBindings = () => {};
  let constructed = null;
  class CoordinatorFixture {
    constructor(options) { constructed = options; }
  }
  const result = createBotDeletionCoordinator({
    ...dependencies,
    CoordinatorClass: CoordinatorFixture,
    deleteBindings,
  });
  assert.equal(result instanceof CoordinatorFixture, true);
  assert.deepEqual(constructed, {
    botRuntimeController: dependencies.controller,
    botStore: dependencies.store,
    conversationController: dependencies.conversations,
    computerTargetRouter: dependencies.computerTargetRouter,
    computerBoundary: dependencies.computerBoundary,
    modelSelectionStore: dependencies.selectionStore,
    conversationBindingsFile: dependencies.conversationBindingsPath,
    deleteConversationBindings: deleteBindings,
  });
});

test("native deletion and startup share the durable selected active bot with the renderer", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const harness = electronHarness();
  let factoryOptions = null;
  const controller = new EventEmitter();
  Object.assign(controller, { async reconcile() {}, dispose() {} });
  const authoritativeOutcome = Object.freeze({
    deletedBotIds: Object.freeze([BOT_A]),
    survivingBotIds: Object.freeze([
      "bot-22222222-2222-4222-8222-222222222222",
      "bot-33333333-3333-4333-8333-333333333333",
    ]),
    activeBotId: "bot-33333333-3333-4333-8333-333333333333",
  });
  const installed = installDesktopRuntime(harness.electron, {
    controller,
    selectionStore: {
      async readActiveBotId() { return authoritativeOutcome.activeBotId; },
    },
    botDeletionCoordinator: {
      async reconcilePending() {},
      async deleteBots() { return authoritativeOutcome; },
      async dispose() {},
    },
    nativeCoordinatorFactory(options) {
      factoryOptions = options;
      return { bindPort() { return () => {}; }, dispose() {} };
    },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });
  assert.equal(await factoryOptions.readActiveAgentId(), authoritativeOutcome.activeBotId);
  assert.deepEqual(await factoryOptions.deleteBots(Object.freeze([BOT_A])), authoritativeOutcome);
  assert.deepEqual(harness.sent, [["codex-runtime:event", {
    type: "active-bot-changed",
    botId: authoritativeOutcome.activeBotId,
  }]]);
  await installed.dispose();
});

test("a committed native deletion succeeds without a fallible post-commit selection read", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const harness = electronHarness();
  let factoryOptions = null;
  let activeReads = 0;
  const controller = new EventEmitter();
  Object.assign(controller, { async reconcile() {}, dispose() {} });
  const authoritativeOutcome = Object.freeze({
    deletedBotIds: Object.freeze([BOT_A]),
    survivingBotIds: Object.freeze([BOT_B]),
    activeBotId: BOT_B,
  });
  const installed = installDesktopRuntime(harness.electron, {
    controller,
    selectionStore: {
      async readActiveBotId() {
        activeReads += 1;
        throw new Error("selection store became unavailable after commit");
      },
    },
    botDeletionCoordinator: {
      async reconcilePending() {},
      async deleteBots() { return authoritativeOutcome; },
      async dispose() {},
    },
    nativeCoordinatorFactory(options) {
      factoryOptions = options;
      return { bindPort() { return () => {}; }, dispose() {} };
    },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });

  assert.deepEqual(await factoryOptions.deleteBots(Object.freeze([BOT_A])), authoritativeOutcome);
  assert.equal(activeReads, 0);
  assert.deepEqual(harness.sent, [["codex-runtime:event", {
    type: "active-bot-changed",
    botId: BOT_B,
  }]]);
  await installed.dispose();
});

test("a pre-intent native selection cannot rewrite a bot id after its deletion commits", async () => {
  const { installDesktopRuntime } = require(runtimePath);
  const harness = electronHarness();
  const selectionEntered = deferred();
  const releaseSelection = deferred();
  let factoryOptions = null;
  let durableActiveBotId = BOT_A;
  const controller = new EventEmitter();
  Object.assign(controller, {
    async readBot(botId) { return botId === BOT_A ? { botId } : null; },
    async reconcile() {},
    dispose() {},
  });
  const currentSelection = Object.freeze({ botId: BOT_A, generation: 1 });
  const installed = installDesktopRuntime(harness.electron, {
    controller,
    selectionStore: {
      async read() { return currentSelection; },
      async selectBot(botId) {
        selectionEntered.resolve();
        await releaseSelection.promise;
        durableActiveBotId = botId;
      },
      async readActiveBotId() { return durableActiveBotId; },
    },
    botDeletionCoordinator: {
      async reconcilePending() {},
      async deleteBots() {
        durableActiveBotId = BOT_B;
        return Object.freeze({
          deletedBotIds: Object.freeze([BOT_A]),
          survivingBotIds: Object.freeze([BOT_B]),
          activeBotId: BOT_B,
        });
      },
      async dispose() {},
    },
    nativeCoordinatorFactory(options) {
      factoryOptions = options;
      return { bindPort() { return () => {}; }, dispose() {} };
    },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });

  const selecting = factoryOptions.onSelectAgent(BOT_A);
  await selectionEntered.promise;
  const deleting = factoryOptions.deleteBots(Object.freeze([BOT_A]));
  await tick();
  releaseSelection.resolve();
  await selecting;
  assert.deepEqual(await deleting, {
    deletedBotIds: [BOT_A],
    survivingBotIds: [BOT_B],
    activeBotId: BOT_B,
  });
  assert.equal(durableActiveBotId, BOT_B);
  await installed.dispose();
});

test("every pre-intent renderer selection mutation finishes before native deletion commits", async (t) => {
  const { IPC_CHANNELS, installDesktopRuntime } = require(runtimePath);
  const catalog = Object.freeze({
    generation: 7,
    status: "ready",
    models: Object.freeze([Object.freeze({
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: Object.freeze(["medium"]),
      inputModalities: Object.freeze(["text", "image"]),
      supportsPersonality: false,
      isDefault: true,
    })]),
  });
  const scenarios = [
    {
      name: "select bot",
      channel: IPC_CHANNELS.selectBot,
      args: [BOT_A],
      mutation: "selectBot",
      readsSelection: true,
    },
    {
      name: "read model ensure",
      channel: IPC_CHANNELS.readModel,
      args: [BOT_A],
      mutation: "ensure",
      readsSelection: false,
    },
    {
      name: "select model",
      channel: IPC_CHANNELS.selectModel,
      args: [{
        botId: BOT_A,
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: null,
      }],
      mutation: "writeNext",
      readsSelection: false,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = electronHarness();
      const mutationEntered = deferred();
      const releaseMutation = deferred();
      let heldTargetMutation = true;
      let factoryOptions = null;
      let durableActiveBotId = BOT_A;
      let targetDeleted = false;
      const selection = (botId, generation = 1) => Object.freeze({
        botId,
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        serviceTier: null,
        catalogGeneration: 7,
        generation,
      });
      const commitSelection = async (botId, result) => {
        if (botId === BOT_A && heldTargetMutation) {
          heldTargetMutation = false;
          mutationEntered.resolve();
          await releaseMutation.promise;
        }
        durableActiveBotId = botId;
        return result;
      };
      const selectionStore = {
        async read(botId) {
          return scenario.readsSelection ? selection(botId) : null;
        },
        async selectBot(botId) {
          return commitSelection(botId, botId);
        },
        async ensure(botId, requested) {
          return commitSelection(botId, Object.freeze({ ...requested, generation: 0 }));
        },
        async writeNext(requested) {
          return commitSelection(requested.botId, Object.freeze({ ...requested, generation: 2 }));
        },
        async readActiveBotId() { return durableActiveBotId; },
      };
      const controller = new EventEmitter();
      Object.assign(controller, {
        async readBot(botId) {
          return new Set([BOT_A, BOT_B]).has(botId) && !(botId === BOT_A && targetDeleted)
            ? Object.freeze({ botId }) : null;
        },
        async reconcile() {},
        dispose() {},
      });
      const installed = installDesktopRuntime(harness.electron, {
        controller,
        selectionStore,
        botDeletionCoordinator: {
          async reconcilePending() {},
          async deleteBots() {
            targetDeleted = true;
            durableActiveBotId = BOT_B;
            return Object.freeze({
              deletedBotIds: Object.freeze([BOT_A]),
              survivingBotIds: Object.freeze([BOT_B]),
              activeBotId: BOT_B,
            });
          },
          async dispose() {},
        },
        nativeCoordinatorFactory(options) {
          factoryOptions = options;
          return { bindPort() { return () => {}; }, dispose() {} };
        },
        accountController: {
          async start() {}, accountState() { return {}; }, catalogState() { return catalog; },
          on() {}, off() {}, dispose() {},
        },
      });

      const mutateDeletedBot = harness.handlers.get(scenario.channel)(harness.event, ...scenario.args);
      await mutationEntered.promise;
      const deleting = factoryOptions.deleteBots(Object.freeze([BOT_A]));
      await tick();
      releaseMutation.resolve();
      await mutateDeletedBot;
      assert.deepEqual(await deleting, {
        deletedBotIds: [BOT_A],
        survivingBotIds: [BOT_B],
        activeBotId: BOT_B,
      });
      assert.equal(durableActiveBotId, BOT_B);

      if (scenario.channel === IPC_CHANNELS.readModel) {
        await assert.rejects(
          harness.handlers.get(scenario.channel)(harness.event, BOT_A),
          { code: "CODEX_BOT_OPERATION_FAILED" },
        );
        assert.equal(durableActiveBotId, BOT_B);
      }

      const survivingArgs = scenario.channel === IPC_CHANNELS.selectModel
        ? [{ ...scenario.args[0], botId: BOT_B }]
        : [BOT_B];
      await harness.handlers.get(scenario.channel)(harness.event, ...survivingArgs);
      assert.equal(durableActiveBotId, BOT_B);
      await installed.dispose();
    });
  }
});

test("pending deletion replay blocks every bot surface and bridge start until it settles", async () => {
  const {
    IPC_CHANNELS,
    installDesktopRuntime,
  } = require(runtimePath);
  const { STANDALONE_IPC_CHANNELS } = require("../src/desktop/standalone-conversation-ipc.cjs");
  const { LOCAL_DESKTOP_FRAME_CHANNELS } = require("../src/desktop/local-desktop-frame-ipc.cjs");
  const { OPENBOT_NATIVE_COORDINATOR_CHANNELS } = require("../src/desktop/openbot-native-coordinator-ipc.cjs");
  const replay = deferred();
  const effects = {
    bridgeStarts: 0,
    controllerLists: 0,
    controllerReconciles: 0,
    deletionCalls: [],
    deletionReconciles: 0,
    localReads: 0,
    nativeBindings: 0,
    standaloneLists: 0,
  };
  const harness = electronHarness();
  const controller = new EventEmitter();
  Object.assign(controller, {
    listBots() { effects.controllerLists += 1; return []; },
    async reconcile() { effects.controllerReconciles += 1; },
    dispose() {},
  });
  const conversations = conversationsFixture(effects);
  const boundary = new EventEmitter();
  Object.assign(boundary, {
    async read() { effects.localReads += 1; return computerRecord(); },
    dispose() {},
  });
  const localDesktopManager = {
    ownsWindow() { return false; },
    async open() {},
    async captureDisplayFrame() {
      return Object.freeze({
        botId: BOT_A,
        targetId: LOCAL_A,
        targetGeneration: 1,
        frameId: "frame-ready",
        width: 1,
        height: 1,
        mimeType: "image/png",
        bytes: Uint8Array.from([1]),
      });
    },
  };
  let factoryOptions = null;
  const nativeCoordinator = {
    bindPort() { effects.nativeBindings += 1; return () => {}; },
    dispose() {},
  };
  const deletionCoordinator = {
    async reconcilePending() {
      effects.deletionReconciles += 1;
      await replay.promise;
      return Object.freeze({ completedDeletionIds: Object.freeze([]), pendingDeletionIds: Object.freeze([]) });
    },
    async deleteBots(botIds) {
      effects.deletionCalls.push([...botIds]);
      return Object.freeze({
        deletedBotIds: Object.freeze([...botIds]),
        survivingBotIds: Object.freeze([]),
        activeBotId: null,
      });
    },
    async dispose() {},
  };
  const inferenceBridge = {
    async start() {
      effects.bridgeStarts += 1;
      return Object.freeze({ endpoint: "tcp://127.0.0.1:43123", capability: "a".repeat(64) });
    },
    dispose() {},
  };
  const installed = installDesktopRuntime(harness.electron, {
    controller,
    selectionStore: {},
    botDeletionCoordinator: deletionCoordinator,
    standaloneConversations: conversations,
    computerBoundary: boundary,
    computerTargetRouter: { dispose() {} },
    localDesktopManager,
    nativeCoordinatorFactory(options) { factoryOptions = options; return nativeCoordinator; },
    inferenceBridge,
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });

  const operations = [
    harness.handlers.get(IPC_CHANNELS.list)(harness.event),
    harness.handlers.get(IPC_CHANNELS.computerRead)(harness.event, BOT_A),
    harness.handlers.get(STANDALONE_IPC_CHANNELS.list)(harness.event, BOT_A),
    harness.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(harness.event, {
      botId: BOT_A,
      viewGeneration: 1,
    }),
    harness.handlers.get(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request)(harness.event),
  ];
  await tick();
  assert.equal(effects.deletionReconciles, 1);
  assert.deepEqual({
    bridgeStarts: effects.bridgeStarts,
    controllerLists: effects.controllerLists,
    controllerReconciles: effects.controllerReconciles,
    localReads: effects.localReads,
    nativeBindings: effects.nativeBindings,
    standaloneLists: effects.standaloneLists,
  }, {
    bridgeStarts: 0,
    controllerLists: 0,
    controllerReconciles: 0,
    localReads: 0,
    nativeBindings: 0,
    standaloneLists: 0,
  });
  assert.equal(harness.delivered.length, 0);

  replay.resolve();
  await Promise.all(operations);
  await tick();
  assert.equal(effects.bridgeStarts, 1);
  assert.equal(effects.controllerLists, 1);
  assert.equal(effects.controllerReconciles, 1);
  assert.equal(effects.localReads >= 2, true);
  assert.equal(effects.nativeBindings, 1);
  assert.equal(effects.standaloneLists, 1);
  assert.equal(harness.delivered.length, 1);
  assert.equal(typeof factoryOptions?.deleteBots, "function");
  await factoryOptions.deleteBots(Object.freeze([BOT_A]));
  assert.deepEqual(effects.deletionCalls, [[BOT_A]]);
  await installed.dispose();
});

test("every central IPC request rejects if the main frame navigates while deletion replay is held", async () => {
  const { IPC_CHANNELS, installDesktopRuntime } = require(runtimePath);
  const replay = deferred();
  const harness = electronHarness();
  const effects = [];
  const effect = (name, value) => (...args) => {
    effects.push([name, ...args]);
    return value;
  };
  const controller = new EventEmitter();
  Object.assign(controller, {
    listBots: effect("listBots", []),
    createBot: effect("createBot", { botId: BOT_A }),
    readBot: effect("readBot", null),
    renameBot: effect("renameBot", null),
    updateProfile: effect("updateProfile", null),
    advanceSetup: effect("advanceSetup", null),
    retryRuntime: effect("retryRuntime", null),
    ensureRuntime: effect("ensureRuntime", null),
    async reconcile() {},
    dispose() {},
  });
  const accountController = {
    async start() {},
    accountState: effect("accountState", {}),
    catalogState: effect("catalogState", {}),
    login: effect("login", { state: {} }),
    cancelLogin: effect("cancelLogin", {}),
    logout: effect("logout", {}),
    refresh: effect("refresh", {}),
    on() {}, off() {}, dispose() {},
  };
  const selectionStore = {
    read: effect("selectionRead", null),
    writeNext: effect("selectionWrite", null),
    ensure: effect("selectionEnsure", null),
    selectBot: effect("selectBot", null),
  };
  const computerBoundary = new EventEmitter();
  Object.assign(computerBoundary, {
    selectMode: effect("computerSelectMode", null),
    read: effect("computerRead", null),
    decidePermission: effect("permissionDecide", null),
    listPermissionRequests: effect("permissionRequestsList", null),
    listPermissions: effect("permissionsList", null),
    revokePermission: effect("permissionRevoke", null),
    dispose() {},
  });
  const installed = installDesktopRuntime(harness.electron, {
    controller,
    selectionStore,
    store: { adoptLegacy: effect("adoptLegacy", null) },
    sidecarManager: { connectProvider: effect("connectProvider", null), stop() {} },
    botDeletionCoordinator: {
      async reconcilePending() { await replay.promise; },
      async deleteBots() {},
      async dispose() {},
    },
    computerBoundary,
    accountController,
  });
  const pending = Object.entries(IPC_CHANNELS).map(([name, channel]) => {
    const handler = harness.handlers.get(channel);
    assert.equal(typeof handler, "function", name);
    return handler(harness.event).then(
      () => ({ name, status: "fulfilled" }),
      (error) => ({ name, status: "rejected", code: error?.code }),
    );
  });
  await tick();
  harness.event.sender.mainFrame = {
    processId: harness.event.senderFrame.processId,
    routingId: harness.event.senderFrame.routingId + 1,
    isDestroyed: () => false,
  };
  replay.resolve();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(({ name, status }) => [name, status]),
    Object.keys(IPC_CHANNELS).map((name) => [name, "rejected"]));
  assert.equal(results.every(({ code }) => new Set([
    "CODEX_BOT_OPERATION_FAILED",
    "OPENBOT_COMPUTER_OPERATION_FAILED",
  ]).has(code)), true);
  assert.deepEqual(effects, []);
  await installed.dispose();
});

test("disposal awaits deletion coordination before owners and prevents late gated work", async () => {
  const { IPC_CHANNELS, installDesktopRuntime } = require(runtimePath);
  const replay = deferred();
  const deletionDisposal = deferred();
  const harness = electronHarness();
  const order = [];
  const effects = {
    bridgeStarts: 0,
    controllerLists: 0,
    controllerReconciles: 0,
    standaloneLists: 0,
  };
  const controller = new EventEmitter();
  Object.assign(controller, {
    listBots() { effects.controllerLists += 1; return []; },
    async reconcile() { effects.controllerReconciles += 1; },
    dispose() { order.push("controller"); },
  });
  const conversations = conversationsFixture(effects, order);
  const boundary = new EventEmitter();
  Object.assign(boundary, { dispose() { order.push("boundary"); } });
  const deletionCoordinator = {
    async reconcilePending() { await replay.promise; },
    async deleteBots() {},
    async dispose() {
      order.push("deletion-start");
      await deletionDisposal.promise;
      order.push("deletion-done");
    },
  };
  const installed = installDesktopRuntime(harness.electron, {
    controller,
    selectionStore: {},
    botDeletionCoordinator: deletionCoordinator,
    standaloneConversations: conversations,
    computerBoundary: boundary,
    computerTargetRouter: { dispose() { order.push("router"); } },
    inferenceBridge: {
      async start() { effects.bridgeStarts += 1; },
      dispose() { order.push("bridge"); },
    },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() { order.push("account"); },
    },
  });
  const pendingList = harness.handlers.get(IPC_CHANNELS.list)(harness.event);
  const rejectedList = assert.rejects(pendingList, { code: "CODEX_BOT_OPERATION_FAILED" });
  const disposal = installed.dispose();
  await tick();
  assert.deepEqual(order, ["deletion-start"]);
  assert.equal(effects.bridgeStarts, 0);
  assert.equal(effects.controllerReconciles, 0);

  deletionDisposal.resolve();
  await disposal;
  for (const owner of ["conversations", "boundary", "router", "controller", "bridge"]) {
    assert.equal(order.indexOf(owner) > order.indexOf("deletion-done"), true, owner);
  }
  replay.resolve();
  await rejectedList;
  await tick();
  assert.equal(effects.bridgeStarts, 0);
  assert.equal(effects.controllerLists, 0);
  assert.equal(effects.controllerReconciles, 0);
});

test("rejected deletion replay fails every gated surface closed without late startup", async () => {
  const { IPC_CHANNELS, installDesktopRuntime } = require(runtimePath);
  const { STANDALONE_IPC_CHANNELS } = require("../src/desktop/standalone-conversation-ipc.cjs");
  const { LOCAL_DESKTOP_FRAME_CHANNELS } = require("../src/desktop/local-desktop-frame-ipc.cjs");
  const { OPENBOT_NATIVE_COORDINATOR_CHANNELS } = require("../src/desktop/openbot-native-coordinator-ipc.cjs");
  const harness = electronHarness();
  const effects = {
    bridgeStarts: 0,
    controllerLists: 0,
    controllerReconciles: 0,
    localReads: 0,
    nativeBindings: 0,
    standaloneLists: 0,
  };
  const controller = new EventEmitter();
  Object.assign(controller, {
    listBots() { effects.controllerLists += 1; return []; },
    async reconcile() { effects.controllerReconciles += 1; },
    dispose() {},
  });
  const conversations = conversationsFixture(effects);
  const boundary = new EventEmitter();
  Object.assign(boundary, {
    async read() { effects.localReads += 1; return computerRecord(); },
    dispose() {},
  });
  const localDesktopManager = {
    ownsWindow() { return false; },
    async open() {},
    async captureDisplayFrame() { throw new Error("must remain gated"); },
  };
  const installed = installDesktopRuntime(harness.electron, {
    controller,
    selectionStore: {},
    botDeletionCoordinator: {
      async reconcilePending() { throw new Error("private replay detail"); },
      async deleteBots() { throw new Error("must remain gated"); },
      async dispose() {},
    },
    standaloneConversations: conversations,
    computerBoundary: boundary,
    computerTargetRouter: { dispose() {} },
    localDesktopManager,
    nativeCoordinatorFactory() {
      return {
        bindPort() { effects.nativeBindings += 1; return () => {}; },
        dispose() {},
      };
    },
    inferenceBridge: {
      async start() { effects.bridgeStarts += 1; },
      dispose() {},
    },
    accountController: {
      async start() {}, accountState() { return {}; }, catalogState() { return {}; },
      on() {}, off() {}, dispose() {},
    },
  });
  await Promise.all([
    assert.rejects(harness.handlers.get(IPC_CHANNELS.list)(harness.event), {
      code: "CODEX_BOT_OPERATION_FAILED",
    }),
    assert.rejects(harness.handlers.get(IPC_CHANNELS.computerRead)(harness.event, BOT_A), {
      code: "OPENBOT_COMPUTER_OPERATION_FAILED",
    }),
    assert.rejects(harness.handlers.get(STANDALONE_IPC_CHANNELS.list)(harness.event, BOT_A), {
      code: "OPENBOT_CONVERSATION_OPERATION_FAILED",
    }),
    assert.rejects(harness.handlers.get(LOCAL_DESKTOP_FRAME_CHANNELS.select)(harness.event, {
      botId: BOT_A,
      viewGeneration: 1,
    }), { code: "OPENBOT_LOCAL_FRAME_OPERATION_FAILED" }),
    assert.rejects(harness.handlers.get(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request)(harness.event), {
      code: "OPENBOT_NATIVE_COORDINATOR_OPERATION_FAILED",
    }),
  ]);
  await tick();
  assert.deepEqual(effects, {
    bridgeStarts: 0,
    controllerLists: 0,
    controllerReconciles: 0,
    localReads: 0,
    nativeBindings: 0,
    standaloneLists: 0,
  });
  await installed.dispose();
});
