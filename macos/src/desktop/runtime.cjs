"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { BotStore } = require("../bots/bot-store.cjs");
const { BotRuntimeController } = require("../bots/runtime-controller.cjs");
const { unavailableProvider, validateProvider } = require("../bots/runtime-provider.cjs");
const { CLIProxyManager } = require("./cliproxy-manager.cjs");
const { ModelSelectionStore, normalizeSelectionRequest } = require("./model-selection-store.cjs");

const IPC_CHANNELS = Object.freeze({
  list: "codex-bot:list",
  create: "codex-bot:create",
  adoptLegacy: "codex-bot:adopt-legacy",
  connectProvider: "codex-bot:connect-provider",
  read: "codex-bot:read",
  rename: "codex-bot:rename",
  updateProfile: "codex-bot:update-profile",
  retryRuntime: "codex-bot:retry-runtime",
  selectBot: "codex-bot:select-bot",
  readModel: "codex-bot:read-model",
  selectModel: "codex-bot:select-model",
});
const CHANGE_CHANNEL = "codex-bot:changed";
const RUNTIME_EVENT_CHANNEL = "codex-runtime:event";
const INSTALLED = Symbol.for("codex.bot.macos.desktop-runtime");

function sanitizedFailure() {
  const error = new Error("Codex bot operation failed.");
  error.code = "CODEX_BOT_OPERATION_FAILED";
  return error;
}

function setSidecarEnvironment(session) {
  if (
    !session ||
    typeof session.endpoint !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(session.endpoint) ||
    typeof session.credential !== "string" ||
    session.credential.length < 32 ||
    session.credential.length > 256
  ) {
    throw sanitizedFailure();
  }
  process.env.CODEX_BOT_CLIPROXY_URL = session.endpoint;
  process.env.CODEX_BOT_CLIPROXY_TOKEN = session.credential;
}

function loadConfiguredProvider() {
  const modulePath = process.env.CODEX_BOT_REMOTE_PROVIDER_MODULE;
  if (!modulePath) return unavailableProvider();
  try {
    if (!path.isAbsolute(modulePath)) throw new Error("provider path");
    const stat = fs.lstatSync(modulePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("provider file");
    const loaded = require(modulePath);
    const provider = typeof loaded?.createProvider === "function" ? loaded.createProvider() : loaded;
    return validateProvider(provider);
  } catch {
    return unavailableProvider();
  }
}

function productionDependencies(electron) {
  const stateRoot = path.join(electron.app.getPath("userData"), "codex-bot");
  const botStore = new BotStore({ filePath: path.join(stateRoot, "bots.v1.json") });
  const controller = new BotRuntimeController({ store: botStore, provider: loadConfiguredProvider() });
  const modelSelectionsPath = path.join(stateRoot, "model-selections.v1.json");
  const conversationBindingsPath = path.join(stateRoot, "conversation-bindings.v1.json");
  const selectionStore = new ModelSelectionStore({ filePath: modelSelectionsPath });
  const sidecarManager = new CLIProxyManager({
    binaryPath: path.join(process.resourcesPath, "codex", "cliproxy", "cli-proxy-api"),
    stateRoot: path.join(stateRoot, "cliproxy"),
    expectedBinaryBytes: 58509266,
    expectedBinarySha256: "1d7a12c5a1974b492dd2f21e3ecfb39db66d3465a67fd7039a844ce2c40e55df",
  });
  process.env.CODEX_BOT_BRIDGE = path.join(__dirname, "..", "bridge", "server.cjs");
  process.env.CODEX_BOT_CONVERSATION_BINDINGS = conversationBindingsPath;
  process.env.CODEX_BOT_MODEL_SELECTIONS = modelSelectionsPath;
  delete process.env.CODEX_BOT_CLIPROXY_URL;
  delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
  void sidecarManager.start().then((session) => {
    setSidecarEnvironment(session);
  }).catch(() => {
    delete process.env.CODEX_BOT_CLIPROXY_URL;
    delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
  });
  void controller.reconcile().catch(() => {});
  return { controller, selectionStore, sidecarManager, store: botStore };
}

function installDesktopRuntime(electron, injected = {}) {
  if (!electron?.app || !electron?.ipcMain || !electron?.BrowserWindow) {
    throw new Error("Codex desktop runtime requires Electron.");
  }
  if (electron.app[INSTALLED]) return electron.app[INSTALLED];
  const dependencies = injected.controller && injected.selectionStore
    ? injected
    : productionDependencies(electron);
  const { controller, selectionStore, store } = dependencies;
  const sidecarManager = dependencies.sidecarManager || Object.freeze({
    async connectProvider() { throw sanitizedFailure(); },
    stop() {},
  });
  const registered = [];
  let disposed = false;

  function broadcast(bot) {
    const record = bot?.bot && typeof bot.bot === "object" ? bot.bot : bot;
    if (!record || typeof record !== "object") return;
    for (const window of electron.BrowserWindow.getAllWindows()) {
      try {
        if (!window.webContents.isDestroyed()) window.webContents.send(CHANGE_CHANNEL, record);
      } catch {}
    }
  }

  function broadcastRuntimeEvent(event) {
    if (!event || typeof event !== "object") return;
    for (const window of electron.BrowserWindow.getAllWindows()) {
      try {
        if (!window.webContents.isDestroyed()) window.webContents.send(RUNTIME_EVENT_CHANNEL, event);
      } catch {}
    }
  }

  function handle(channel, operation) {
    electron.ipcMain.handle(channel, async (_event, ...args) => {
      if (disposed) throw sanitizedFailure();
      try {
        return await operation(...args);
      } catch {
        throw sanitizedFailure();
      }
    });
    registered.push(channel);
  }

  handle(IPC_CHANNELS.list, () => controller.listBots());
  handle(IPC_CHANNELS.create, () => controller.createBot());
  handle(IPC_CHANNELS.adoptLegacy, async (value) => {
    if (!store || typeof store.adoptLegacy !== "function") throw sanitizedFailure();
    const adopted = await store.adoptLegacy(value);
    return controller.ensureRuntime(adopted.botId);
  });
  handle(IPC_CHANNELS.connectProvider, async (provider) => {
    await sidecarManager.connectProvider(provider);
    setSidecarEnvironment(await sidecarManager.start());
  });
  handle(IPC_CHANNELS.read, (botId) => controller.readBot(botId));
  handle(IPC_CHANNELS.rename, (botId, name) => controller.renameBot(botId, name));
  handle(IPC_CHANNELS.updateProfile, (botId, profile) => controller.updateProfile(botId, profile));
  handle(IPC_CHANNELS.retryRuntime, (botId) => controller.retryRuntime(botId));
  handle(IPC_CHANNELS.selectBot, async (botId) => {
    const bot = await controller.readBot(botId);
    if (!bot) throw sanitizedFailure();
    await selectionStore.selectBot(bot.botId);
    const current = await selectionStore.read(bot.botId);
    const session = await controller.runtimeSession(bot.botId);
    if (!session || !Number.isSafeInteger(session.generation) || session.generation < 0) {
      return current || bot.botId;
    }
    if (current && current.generation === session.generation) return current;
    return selectionStore.write({
      botId: bot.botId,
      model: current?.model || "gpt-5.6-sol",
      reasoningEffort: current?.reasoningEffort || "medium",
      generation: session.generation,
    });
  });
  handle(IPC_CHANNELS.readModel, (botId) => selectionStore.read(botId));
  handle(IPC_CHANNELS.selectModel, async (rawSelection) => {
    const requested = normalizeSelectionRequest(rawSelection);
    const session = await controller.runtimeSession(requested.botId);
    if (!session || !Number.isSafeInteger(session.generation) || session.generation < 0) {
      throw sanitizedFailure();
    }
    return selectionStore.write({ ...requested, generation: session.generation });
  });

  const onBotChanged = (event) => broadcast(event);
  const onRuntimeChanged = (event) => {
    if (typeof event?.botId !== "string") return;
    void controller.readBot(event.botId).then(broadcast).catch(() => {});
  };
  const onRuntimeEvent = (event) => broadcastRuntimeEvent(event);
  controller.on?.("bot-changed", onBotChanged);
  controller.on?.("runtime-changed", onRuntimeChanged);
  controller.on?.("runtime-event", onRuntimeEvent);

  const api = Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of registered) electron.ipcMain.removeHandler(channel);
      controller.off?.("bot-changed", onBotChanged);
      controller.off?.("runtime-changed", onRuntimeChanged);
      controller.off?.("runtime-event", onRuntimeEvent);
      sidecarManager.stop();
      delete process.env.CODEX_BOT_CLIPROXY_URL;
      delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
      controller.dispose();
      try { delete electron.app[INSTALLED]; } catch {}
    },
  });
  electron.app[INSTALLED] = api;
  electron.app.once?.("before-quit", () => api.dispose());
  return api;
}

module.exports = {
  CHANGE_CHANNEL,
  IPC_CHANNELS,
  RUNTIME_EVENT_CHANNEL,
  installDesktopRuntime,
  loadConfiguredProvider,
};
