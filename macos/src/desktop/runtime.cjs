"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { BotStore } = require("../bots/bot-store.cjs");
const { BotRuntimeController } = require("../bots/runtime-controller.cjs");
const { unavailableProvider, validateProvider } = require("../bots/runtime-provider.cjs");
const { CLIProxyManager } = require("./cliproxy-manager.cjs");
const { CodexAccountController } = require("./codex-account-controller.cjs");
const { CodexAppServerManager } = require("./codex-app-server-manager.cjs");
const { CodexDirectInferenceTransport } = require("./codex-direct-inference-transport.cjs");
const { CLIProxyInferenceTransport } = require("./cliproxy-inference-transport.cjs");
const { InferenceBridgeServer } = require("./inference-bridge-server.cjs");
const { InferenceProviderRouter } = require("./inference-provider-router.cjs");
const { BOT_ID, ModelSelectionStore } = require("./model-selection-store.cjs");

const IPC_CHANNELS = Object.freeze({
  accountRead: "codex-account:read",
  accountLogin: "codex-account:login",
  accountCancelLogin: "codex-account:login-cancel",
  accountLogout: "codex-account:logout",
  accountRetry: "codex-account:retry",
  catalogList: "codex-catalog:list",
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
const ACCOUNT_CHANGE_CHANNEL = "codex-account:changed";
const CATALOG_CHANGE_CHANNEL = "codex-catalog:changed";
const INSTALLED = Symbol.for("codex.bot.macos.desktop-runtime");
const OPTIONAL_MODEL_EFFORTS = Object.freeze({
  "claude-fable-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-opus-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-sonnet-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
});

function sanitizedFailure() {
  const error = new Error("Codex bot operation failed.");
  error.code = "CODEX_BOT_OPERATION_FAILED";
  return error;
}

function selectionRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sanitizedFailure();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch { throw sanitizedFailure(); }
  const fields = ["botId", "model", "reasoningEffort", "serviceTier"];
  const required = ["botId", "model", "reasoningEffort"];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !fields.includes(key) || !("value" in descriptors[key]))
    || required.some((field) => !descriptors[field])) throw sanitizedFailure();
  const result = Object.fromEntries(fields
    .filter((field) => descriptors[field])
    .map((field) => [field, descriptors[field].value]));
  if (typeof result.botId !== "string" || !BOT_ID.test(result.botId)
    || !(result.serviceTier === undefined || result.serviceTier === null
      || (typeof result.serviceTier === "string"
        && /^[a-z][a-z0-9_-]{0,31}$/.test(result.serviceTier)))) throw sanitizedFailure();
  return result;
}

function catalogModels(catalog) {
  if (!catalog || typeof catalog !== "object" || catalog.status !== "ready"
    || !Number.isSafeInteger(catalog.generation) || catalog.generation < 1
    || !Array.isArray(catalog.models) || catalog.models.length < 1) throw sanitizedFailure();
  return catalog.models;
}

function resolveModelSelection(rawSelection, catalog) {
  const requested = selectionRequest(rawSelection);
  const optionalEfforts = OPTIONAL_MODEL_EFFORTS[requested.model];
  if (optionalEfforts) {
    if (!optionalEfforts.includes(requested.reasoningEffort)
      || (requested.serviceTier !== undefined && requested.serviceTier !== null)) throw sanitizedFailure();
    return Object.freeze({
      botId: requested.botId,
      provider: "cliproxy-anthropic",
      model: requested.model,
      reasoningEffort: requested.reasoningEffort,
      serviceTier: null,
      catalogGeneration: 1,
    });
  }
  const models = catalogModels(catalog);
  const model = models.find((entry) => entry?.id === requested.model);
  if (!model || !Array.isArray(model.supportedReasoningEfforts)
    || !model.supportedReasoningEfforts.includes(requested.reasoningEffort)) throw sanitizedFailure();
  const serviceTier = requested.serviceTier === undefined
    ? model.defaultServiceTier ?? null
    : requested.serviceTier;
  if (serviceTier !== null && (!Array.isArray(model.serviceTiers)
    || !model.serviceTiers.some((entry) => entry?.id === serviceTier))) throw sanitizedFailure();
  return Object.freeze({
    botId: requested.botId,
    provider: "openai-codex",
    model: requested.model,
    reasoningEffort: requested.reasoningEffort,
    serviceTier,
    catalogGeneration: catalog.generation,
  });
}

function selectionMatchesCatalog(value, catalog) {
  try {
    if (!value || !Number.isSafeInteger(value.generation) || value.generation < 0) return false;
    const current = resolveModelSelection({
      botId: value.botId,
      model: value.model,
      reasoningEffort: value.reasoningEffort,
      serviceTier: value.serviceTier,
    }, catalog);
    return current.provider === value.provider && current.model === value.model
      && current.reasoningEffort === value.reasoningEffort
      && current.serviceTier === value.serviceTier
      && current.catalogGeneration === value.catalogGeneration;
  } catch { return false; }
}

function defaultModelSelection(botId, catalog) {
  const models = catalogModels(catalog);
  const model = models.find((entry) => entry?.isDefault === true) ?? models[0];
  return resolveModelSelection({
    botId,
    model: model.id,
    reasoningEffort: model.defaultReasoningEffort,
    serviceTier: model.defaultServiceTier ?? null,
  }, catalog);
}

function setInferenceBridgeEnvironment(session) {
  if (!session || typeof session.endpoint !== "string"
    || !/^tcp:\/\/127\.0\.0\.1:\d+$/.test(session.endpoint)
    || typeof session.capability !== "string" || !/^[a-f0-9]{64}$/.test(session.capability)) {
    throw sanitizedFailure();
  }
  process.env.CODEX_BOT_INFERENCE_ENDPOINT = session.endpoint;
  process.env.CODEX_BOT_INFERENCE_CAPABILITY = session.capability;
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

function loadSidecarReceipt(resourcesPath) {
  try {
    if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) throw new Error("path");
    const receiptPath = path.join(resourcesPath, "codex", "cliproxy", "receipt.json");
    const stat = fs.lstatSync(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 80 || stat.size > 512) throw new Error("file");
    const parsed = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      Object.keys(parsed).sort().join(",") !== "bytes,sha256" ||
      !Number.isSafeInteger(parsed.bytes) ||
      parsed.bytes < 1 ||
      typeof parsed.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.sha256)
    ) throw new Error("shape");
    return Object.freeze({ bytes: parsed.bytes, sha256: parsed.sha256 });
  } catch {
    throw new Error("CLIProxyAPI receipt is unavailable.");
  }
}

function createDirectCodexManager({
  resourcesPath,
  stateRoot,
  homeDirectory,
  environment = process.env,
  ManagerClass = CodexAppServerManager,
} = {}) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)
    || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || typeof homeDirectory !== "string" || !path.isAbsolute(homeDirectory)
    || typeof ManagerClass !== "function") {
    throw sanitizedFailure();
  }
  return new ManagerClass({
    resourcesPath,
    stateRoot: path.join(stateRoot, "direct-codex"),
    homeDirectory,
    environment,
    clientVersion: "0.1.4-macos.1",
  });
}

function createLazySidecarManager({
  resourcesPath,
  stateRoot,
  loadReceipt = loadSidecarReceipt,
  ManagerClass = CLIProxyManager,
} = {}) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)
    || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || typeof loadReceipt !== "function" || typeof ManagerClass !== "function") {
    throw sanitizedFailure();
  }
  let manager = null;
  function current() {
    if (manager) return manager;
    const receipt = loadReceipt(resourcesPath);
    manager = new ManagerClass({
      binaryPath: path.join(resourcesPath, "codex", "cliproxy", "cli-proxy-api"),
      stateRoot: path.join(stateRoot, "cliproxy"),
      expectedBinaryBytes: receipt.bytes,
      expectedBinarySha256: receipt.sha256,
    });
    return manager;
  }
  return Object.freeze({
    connectProvider(provider) { return current().connectProvider(provider); },
    start() { return current().start(); },
    stop() { manager?.stop(); },
  });
}

function createInferenceBridgeRuntime({
  codexManager,
  selectionStore,
  sidecarManager,
  readCatalog = null,
  stateRoot,
  capability = crypto.randomBytes(32).toString("hex"),
  DirectTransportClass = CodexDirectInferenceTransport,
  OptionalTransportClass = CLIProxyInferenceTransport,
  RouterClass = InferenceProviderRouter,
  BridgeClass = InferenceBridgeServer,
} = {}) {
  if (!codexManager || typeof codexManager !== "object"
    || !selectionStore || typeof selectionStore.read !== "function"
    || !sidecarManager || typeof sidecarManager.start !== "function"
    || !(readCatalog === null || typeof readCatalog === "function")
    || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || typeof capability !== "string" || !/^[a-f0-9]{64}$/.test(capability)
    || [DirectTransportClass, OptionalTransportClass, RouterClass, BridgeClass]
      .some((value) => typeof value !== "function")) throw sanitizedFailure();
  const directTransport = new DirectTransportClass({
    manager: codexManager,
    workspacePath: path.join(stateRoot, "direct-codex", "empty-workspace"),
  });
  const router = new RouterClass({
    async readSelection(botId) {
      const stored = await selectionStore.read(botId);
      if (!stored || typeof stored !== "object") throw sanitizedFailure();
      if (readCatalog !== null && !selectionMatchesCatalog(stored, readCatalog())) {
        throw sanitizedFailure();
      }
      return Object.freeze({
        botId: stored.botId,
        generation: stored.generation,
        provider: stored.provider,
        model: stored.model,
        reasoningEffort: stored.reasoningEffort,
        serviceTier: stored.serviceTier,
      });
    },
    directTransport,
    async createOptionalTransport(provider) {
      if (provider !== "cliproxy-anthropic") throw sanitizedFailure();
      const session = await sidecarManager.start();
      return new OptionalTransportClass({ session });
    },
  });
  return new BridgeClass({ router, capability });
}

function productionDependencies(electron) {
  const stateRoot = path.join(electron.app.getPath("userData"), "codex-bot");
  const botStore = new BotStore({ filePath: path.join(stateRoot, "bots.v1.json") });
  const controller = new BotRuntimeController({ store: botStore, provider: loadConfiguredProvider() });
  const modelSelectionsPath = path.join(stateRoot, "model-selections.v1.json");
  const conversationBindingsPath = path.join(stateRoot, "conversation-bindings.v1.json");
  const selectionStore = new ModelSelectionStore({ filePath: modelSelectionsPath });
  const codexManager = createDirectCodexManager({
    resourcesPath: process.resourcesPath,
    stateRoot,
    homeDirectory: electron.app.getPath("home"),
  });
  const accountController = new CodexAccountController({ manager: codexManager });
  const sidecarManager = createLazySidecarManager({
    resourcesPath: process.resourcesPath,
    stateRoot,
  });
  const inferenceBridge = createInferenceBridgeRuntime({
    codexManager,
    selectionStore,
    sidecarManager,
    readCatalog: () => accountController.catalogState(),
    stateRoot,
  });
  process.env.CODEX_BOT_BRIDGE = path.join(__dirname, "..", "bridge", "server.cjs");
  process.env.CODEX_BOT_CONVERSATION_BINDINGS = conversationBindingsPath;
  process.env.CODEX_BOT_MODEL_SELECTIONS = modelSelectionsPath;
  delete process.env.CODEX_BOT_CLIPROXY_URL;
  delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
  delete process.env.CODEX_BOT_INFERENCE_ENDPOINT;
  delete process.env.CODEX_BOT_INFERENCE_CAPABILITY;
  void controller.reconcile().catch(() => {});
  return {
    accountController,
    codexManager,
    controller,
    inferenceBridge,
    selectionStore,
    sidecarManager,
    store: botStore,
  };
}

function installDesktopRuntime(electron, injected = {}) {
  if (!electron?.app || !electron?.ipcMain || !electron?.BrowserWindow) {
    throw new Error("Codex desktop runtime requires Electron.");
  }
  if (electron.app[INSTALLED]) return electron.app[INSTALLED];
  try { electron.app.setName?.("Codex Bot"); } catch {}
  const dependencies = injected.controller && injected.selectionStore
    ? injected
    : productionDependencies(electron);
  const { controller, selectionStore, store } = dependencies;
  const codexManager = dependencies.codexManager || Object.freeze({
    async start() {},
    stop() {},
  });
  const accountController = dependencies.accountController || Object.freeze({
    start() { return codexManager.start(); },
    accountState() { throw sanitizedFailure(); },
    catalogState() { throw sanitizedFailure(); },
    async login() { throw sanitizedFailure(); },
    async cancelLogin() { throw sanitizedFailure(); },
    async logout() { throw sanitizedFailure(); },
    async refresh() { throw sanitizedFailure(); },
    dispose() {},
  });
  const sidecarManager = dependencies.sidecarManager || Object.freeze({
    async connectProvider() { throw sanitizedFailure(); },
    stop() {},
  });
  const inferenceBridge = dependencies.inferenceBridge || null;
  const registered = [];
  let disposed = false;
  void accountController.start().catch(() => {});
  if (inferenceBridge && typeof inferenceBridge.start === "function") {
    void Promise.resolve()
      .then(() => inferenceBridge.start())
      .then((session) => {
        if (disposed) return;
        setInferenceBridgeEnvironment(session);
      })
      .catch(() => {
        delete process.env.CODEX_BOT_INFERENCE_ENDPOINT;
        delete process.env.CODEX_BOT_INFERENCE_CAPABILITY;
      });
  }

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

  function broadcastChannel(channel, value) {
    if (!value || typeof value !== "object") return;
    for (const window of electron.BrowserWindow.getAllWindows()) {
      try {
        if (!window.webContents.isDestroyed()) window.webContents.send(channel, value);
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

  async function currentModelSelection(botId) {
    const catalog = accountController.catalogState();
    const current = await selectionStore.read(botId);
    if (current && selectionMatchesCatalog(current, catalog)) return current;
    let requested;
    if (current) {
      try {
        requested = resolveModelSelection({
          botId,
          model: current.model,
          reasoningEffort: current.reasoningEffort,
          serviceTier: current.serviceTier,
        }, catalog);
      } catch {
        requested = defaultModelSelection(botId, catalog);
      }
      return selectionStore.writeNext(requested);
    }
    requested = defaultModelSelection(botId, catalog);
    return selectionStore.ensure(botId, requested);
  }

  handle(IPC_CHANNELS.list, () => controller.listBots());
  handle(IPC_CHANNELS.accountRead, () => accountController.accountState());
  handle(IPC_CHANNELS.catalogList, () => accountController.catalogState());
  handle(IPC_CHANNELS.accountLogin, async (mode) => {
    const login = await accountController.login(mode);
    if (typeof login?.openUrl === "string") {
      try {
        if (disposed || !electron.shell || typeof electron.shell.openExternal !== "function") throw sanitizedFailure();
        await electron.shell.openExternal(login.openUrl);
        if (disposed) throw sanitizedFailure();
      } catch {
        try { await accountController.cancelLogin(); } catch {}
        throw sanitizedFailure();
      }
    }
    return login.state;
  });
  handle(IPC_CHANNELS.accountCancelLogin, () => accountController.cancelLogin());
  handle(IPC_CHANNELS.accountLogout, () => accountController.logout());
  handle(IPC_CHANNELS.accountRetry, () => accountController.refresh());
  handle(IPC_CHANNELS.create, () => controller.createBot());
  handle(IPC_CHANNELS.adoptLegacy, async (value) => {
    if (!store || typeof store.adoptLegacy !== "function") throw sanitizedFailure();
    const adopted = await store.adoptLegacy(value);
    return controller.ensureRuntime(adopted.botId);
  });
  handle(IPC_CHANNELS.connectProvider, async (provider) => {
    if (!new Set(["claude", "kimi"]).has(provider)) throw sanitizedFailure();
    await sidecarManager.connectProvider(provider);
  });
  handle(IPC_CHANNELS.read, (botId) => controller.readBot(botId));
  handle(IPC_CHANNELS.rename, (botId, name) => controller.renameBot(botId, name));
  handle(IPC_CHANNELS.updateProfile, (botId, profile) => controller.updateProfile(botId, profile));
  handle(IPC_CHANNELS.retryRuntime, (botId) => controller.retryRuntime(botId));
  handle(IPC_CHANNELS.selectBot, async (botId) => {
    const bot = await controller.readBot(botId);
    if (!bot) throw sanitizedFailure();
    const selection = await currentModelSelection(bot.botId);
    await selectionStore.selectBot(bot.botId);
    return selection;
  });
  handle(IPC_CHANNELS.readModel, (botId) => currentModelSelection(botId));
  handle(IPC_CHANNELS.selectModel, async (rawSelection) => {
    const requested = selectionRequest(rawSelection);
    const bot = await controller.readBot(requested.botId);
    if (!bot) throw sanitizedFailure();
    return selectionStore.writeNext(resolveModelSelection(
      requested,
      accountController.catalogState(),
    ));
  });

  const onBotChanged = (event) => broadcast(event);
  const onRuntimeChanged = (event) => {
    if (typeof event?.botId !== "string") return;
    void controller.readBot(event.botId).then(broadcast).catch(() => {});
  };
  const onRuntimeEvent = (event) => broadcastRuntimeEvent(event);
  const onAccountChanged = (event) => broadcastChannel(ACCOUNT_CHANGE_CHANNEL, event);
  const onCatalogChanged = (event) => broadcastChannel(CATALOG_CHANGE_CHANNEL, event);
  controller.on?.("bot-changed", onBotChanged);
  controller.on?.("runtime-changed", onRuntimeChanged);
  controller.on?.("runtime-event", onRuntimeEvent);
  accountController.on?.("account-changed", onAccountChanged);
  accountController.on?.("catalog-changed", onCatalogChanged);

  const api = Object.freeze({
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of registered) electron.ipcMain.removeHandler(channel);
      controller.off?.("bot-changed", onBotChanged);
      controller.off?.("runtime-changed", onRuntimeChanged);
      controller.off?.("runtime-event", onRuntimeEvent);
      accountController.off?.("account-changed", onAccountChanged);
      accountController.off?.("catalog-changed", onCatalogChanged);
      accountController.dispose();
      inferenceBridge?.dispose?.();
      codexManager.stop();
      sidecarManager.stop();
      delete process.env.CODEX_BOT_CLIPROXY_URL;
      delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
      delete process.env.CODEX_BOT_INFERENCE_ENDPOINT;
      delete process.env.CODEX_BOT_INFERENCE_CAPABILITY;
      controller.dispose();
      try { delete electron.app[INSTALLED]; } catch {}
    },
  });
  electron.app[INSTALLED] = api;
  electron.app.once?.("before-quit", () => api.dispose());
  return api;
}

module.exports = {
  ACCOUNT_CHANGE_CHANNEL,
  CATALOG_CHANGE_CHANNEL,
  CHANGE_CHANNEL,
  IPC_CHANNELS,
  RUNTIME_EVENT_CHANNEL,
  createDirectCodexManager,
  createInferenceBridgeRuntime,
  createLazySidecarManager,
  installDesktopRuntime,
  loadConfiguredProvider,
  loadSidecarReceipt,
  resolveModelSelection,
  selectionMatchesCatalog,
  setInferenceBridgeEnvironment,
};
