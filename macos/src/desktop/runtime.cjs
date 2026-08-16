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
const { prepareOpenBotUserData } = require("./openbot-user-data.cjs");
const { createLocalComputerRuntime } = require("../local/local-computer-runtime.cjs");

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
  computerSelectMode: "openbot-computer:select-mode",
  computerRead: "openbot-computer:read",
  permissionDecide: "openbot-computer:permission-decide",
  permissionRequestsList: "openbot-computer:permission-requests-list",
  permissionsList: "openbot-computer:permissions-list",
  permissionRevoke: "openbot-computer:permission-revoke",
});
const CHANGE_CHANNEL = "codex-bot:changed";
const RUNTIME_EVENT_CHANNEL = "codex-runtime:event";
const ACCOUNT_CHANGE_CHANNEL = "codex-account:changed";
const CATALOG_CHANGE_CHANNEL = "codex-catalog:changed";
const COMPUTER_CHANGE_CHANNEL = "openbot-computer:changed";
const COMPUTER_PERMISSION_CHANNEL = "openbot-computer:permission-requested";
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

function sanitizedComputerFailure() {
  const error = new Error("OpenBot Computer operation failed.");
  error.code = "OPENBOT_COMPUTER_OPERATION_FAILED";
  return error;
}

function exactPlainInput(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sanitizedComputerFailure();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch { throw sanitizedComputerFailure(); }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !fields.includes(key) || !("value" in descriptors[key]))
    || required.some((field) => !descriptors[field])) throw sanitizedComputerFailure();
  return Object.fromEntries(fields
    .filter((field) => descriptors[field])
    .map((field) => [field, descriptors[field].value]));
}

function computerBotId(value) {
  if (typeof value !== "string" || !BOT_ID.test(value)) throw sanitizedComputerFailure();
  return value.toLowerCase();
}

function computerModeRequest(value) {
  const request = exactPlainInput(value, ["botId", "mode"]);
  if (!new Set(["local", "cursor", "not-now"]).has(request.mode)) throw sanitizedComputerFailure();
  return Object.freeze({ botId: computerBotId(request.botId), mode: request.mode });
}

function computerDecisionRequest(value) {
  const request = exactPlainInput(value, [
    "requestId", "botId", "targetId", "targetGeneration", "decision",
  ]);
  if (typeof request.requestId !== "string"
    || !/^permission-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.requestId)
    || typeof request.targetId !== "string"
    || !/^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.targetId)
    || !Number.isSafeInteger(request.targetGeneration) || request.targetGeneration < 0
    || !new Set(["deny", "once", "always"]).has(request.decision)) throw sanitizedComputerFailure();
  return Object.freeze({
    requestId: request.requestId.toLowerCase(),
    botId: computerBotId(request.botId),
    targetId: request.targetId.toLowerCase(),
    targetGeneration: request.targetGeneration,
    decision: request.decision,
  });
}

function computerRevokeRequest(value) {
  const request = exactPlainInput(value, ["botId", "grantId"]);
  if (typeof request.grantId !== "string"
    || !/^grant-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.grantId)) {
    throw sanitizedComputerFailure();
  }
  return Object.freeze({
    botId: computerBotId(request.botId),
    grantId: request.grantId.toLowerCase(),
  });
}

const COMPUTER_PUBLIC_FIELDS = Object.freeze([
  "mode", "generation", "localProfileId", "nativeAgentId", "state", "lastConfirmedAt", "lastErrorCode",
]);
const PROMPT_PUBLIC_FIELDS = Object.freeze([
  "requestId", "botId", "targetId", "targetGeneration", "capability", "resourceLabel", "reason",
]);
const GRANT_PUBLIC_FIELDS = Object.freeze([
  "grantId", "botId", "capability", "resourceId", "resourceLabel", "scope", "createdAt",
]);
const COMPUTER_MODES = new Set(["local", "cursor", "not-now"]);
const COMPUTER_STATES = new Set(["unconfigured", "starting", "ready", "reconnecting", "unavailable"]);
const COMPUTER_CAPABILITIES = new Set([
  "filesystem.read", "filesystem.write", "shell.execute", "application.open", "application.automate", "screen.capture",
]);
const TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMISSION_ID = /^permission-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRANT_ID = /^grant-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function exactPublicArray(value, maximum) {
  let descriptors;
  let prototype;
  try {
    if (!Array.isArray(value)) throw sanitizedComputerFailure();
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw sanitizedComputerFailure(); }
  const length = descriptors.length && "value" in descriptors.length ? descriptors.length.value : -1;
  const keys = Reflect.ownKeys(descriptors);
  if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 0 || length > maximum
    || keys.length !== length + 1 || keys.some((key) => {
      if (key === "length") return !("value" in descriptors[key]);
      return typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)
        || Number(key) >= length || !("value" in descriptors[key]);
    })) throw sanitizedComputerFailure();
  return Array.from({ length }, (_, index) => descriptors[String(index)].value);
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function boundedPublicText(value, maximum = 320) {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= maximum && !/[\0-\x1f\x7f\\/]/.test(value)
    && !/(?:^|\s)~(?:\/|\s|$)/.test(value)
    && !/(?:^|\s)(?:file:|\/Users\/)/i.test(value);
}

function computerRecordPublic(value) {
  const record = exactPlainInput(value, COMPUTER_PUBLIC_FIELDS);
  if (!COMPUTER_MODES.has(record.mode)
    || !Number.isSafeInteger(record.generation) || record.generation < 0
    || !COMPUTER_STATES.has(record.state)
    || !(record.localProfileId === null || (typeof record.localProfileId === "string" && TARGET_ID.test(record.localProfileId)))
    || !(record.nativeAgentId === null || (typeof record.nativeAgentId === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(record.nativeAgentId)))
    || !(record.lastConfirmedAt === null || canonicalTimestamp(record.lastConfirmedAt))
    || !(record.lastErrorCode === null || (typeof record.lastErrorCode === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.lastErrorCode)))) throw sanitizedComputerFailure();
  if (record.mode === "local" && record.localProfileId === null) throw sanitizedComputerFailure();
  if (record.mode === "cursor" && record.nativeAgentId === null) throw sanitizedComputerFailure();
  if (record.mode === "not-now" && record.state !== "unconfigured") throw sanitizedComputerFailure();
  if (record.state === "ready" && record.lastConfirmedAt === null) throw sanitizedComputerFailure();
  return record;
}

function computerEnvelopePublic(value, expectedBotId = null) {
  const envelope = exactPlainInput(value, ["botId", "computer"]);
  const botId = computerBotId(envelope.botId);
  if (expectedBotId !== null && botId !== expectedBotId) throw sanitizedComputerFailure();
  return computerPublic({ botId, computer: computerRecordPublic(envelope.computer) });
}

function permissionPromptPublic(value, expectedBotId = null) {
  const prompt = exactPlainInput(value, PROMPT_PUBLIC_FIELDS);
  const botId = computerBotId(prompt.botId);
  if ((expectedBotId !== null && botId !== expectedBotId)
    || typeof prompt.requestId !== "string" || !PERMISSION_ID.test(prompt.requestId)
    || typeof prompt.targetId !== "string" || !TARGET_ID.test(prompt.targetId)
    || !Number.isSafeInteger(prompt.targetGeneration) || prompt.targetGeneration < 0
    || !COMPUTER_CAPABILITIES.has(prompt.capability)
    || !boundedPublicText(prompt.resourceLabel)
    || !boundedPublicText(prompt.reason, 512)) {
    throw sanitizedComputerFailure();
  }
  return {
    requestId: prompt.requestId.toLowerCase(),
    botId,
    targetId: prompt.targetId.toLowerCase(),
    targetGeneration: prompt.targetGeneration,
    capability: prompt.capability,
    resourceLabel: prompt.resourceLabel,
    reason: prompt.reason,
  };
}

function permissionRequestsPublic(value, expectedBotId) {
  const envelope = exactPlainInput(value, ["botId", "requests"]);
  const botId = computerBotId(envelope.botId);
  if (botId !== expectedBotId) throw sanitizedComputerFailure();
  const requests = exactPublicArray(envelope.requests, 32)
    .map((entry) => permissionPromptPublic(entry, botId));
  return computerPublic({ botId, requests });
}

function permissionGrantPublic(value, expectedBotId) {
  const grant = exactPlainInput(value, GRANT_PUBLIC_FIELDS);
  const botId = computerBotId(grant.botId);
  if (botId !== expectedBotId || typeof grant.grantId !== "string" || !GRANT_ID.test(grant.grantId)
    || !COMPUTER_CAPABILITIES.has(grant.capability)
    || typeof grant.resourceId !== "string" || !RESOURCE_ID.test(grant.resourceId)
    || grant.resourceId.includes("..") || !boundedPublicText(grant.resourceLabel)
    || grant.scope !== "always" || !canonicalTimestamp(grant.createdAt)) throw sanitizedComputerFailure();
  return {
    grantId: grant.grantId.toLowerCase(), botId, capability: grant.capability,
    resourceId: grant.resourceId, resourceLabel: grant.resourceLabel,
    scope: "always", createdAt: grant.createdAt,
  };
}

function permissionsPublic(value, expectedBotId) {
  const envelope = exactPlainInput(value, ["botId", "permissions"]);
  const botId = computerBotId(envelope.botId);
  if (botId !== expectedBotId) throw sanitizedComputerFailure();
  const permissions = exactPublicArray(envelope.permissions, 256)
    .map((entry) => permissionGrantPublic(entry, botId));
  return computerPublic({ botId, permissions });
}

function computerPublic(value) {
  if (value === undefined) return null;
  const state = { nodes: 0, seen: new Set() };
  return deepFreezeComputer(cloneComputerValue(value, state, 0));
}

function cloneComputerValue(value, state, depth) {
  state.nodes += 1;
  if (state.nodes > 4096 || depth > 16) throw sanitizedComputerFailure();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw sanitizedComputerFailure();
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 128 * 1024 || value.includes("\0")
      || /(?:\/Users\/|Authorization\s*:|\bBearer\s+|(?:password|access[_-]?token|cookie)\s*[:=])/i.test(value)) {
      throw sanitizedComputerFailure();
    }
    return value;
  }
  if (typeof value !== "object" || state.seen.has(value)) throw sanitizedComputerFailure();
  const array = Array.isArray(value);
  let prototype;
  let descriptors;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch { throw sanitizedComputerFailure(); }
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !("value" in descriptors[key])
      || /(?:auth|bookmark|credential|endpoint|password|secret|token|url)/i.test(key))) {
    throw sanitizedComputerFailure();
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw sanitizedComputerFailure();
    }
  }
  state.seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = cloneComputerValue(descriptors[key].value, state, depth + 1);
  }
  state.seen.delete(value);
  return copy;
}

function deepFreezeComputer(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreezeComputer(nested, seen);
  return Object.freeze(value);
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
    clientVersion: "0.2.0-macos.1",
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

function prepareProductionUserData(electron, publisherPath = path.join(
  process.resourcesPath,
  "codex",
  "native",
  "openbot-profile-publish",
)) {
  const migration = prepareOpenBotUserData({
    appDataPath: electron.app.getPath("appData"),
    publisherPath,
  });
  electron.app.setPath("userData", migration.userDataPath);
  return migration;
}

function productionDependencies(electron) {
  prepareProductionUserData(electron);
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
  const computerBoundary = createLocalComputerRuntime({
    electron,
    stateRoot,
    store: botStore,
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
    computerBoundary,
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
  try { electron.app.setName?.("OpenBot"); } catch {}
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
  const computerBoundary = dependencies.computerBoundary || Object.freeze({
    async selectMode() { throw sanitizedComputerFailure(); },
    async read() { throw sanitizedComputerFailure(); },
    async decidePermission() { throw sanitizedComputerFailure(); },
    async listPermissionRequests() { throw sanitizedComputerFailure(); },
    async listPermissions() { throw sanitizedComputerFailure(); },
    async revokePermission() { throw sanitizedComputerFailure(); },
    dispose() {},
  });
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

  function currentWindowSender(event) {
    if (typeof electron.BrowserWindow.fromWebContents !== "function"
      || !event?.sender || typeof event.sender.isDestroyed !== "function") return false;
    try {
      const window = electron.BrowserWindow.fromWebContents(event?.sender);
      return Boolean(window && typeof window.isDestroyed === "function" && !window.isDestroyed()
        && window.webContents === event.sender && typeof window.webContents?.isDestroyed === "function"
        && !window.webContents.isDestroyed());
    } catch { return false; }
  }

  function handle(channel, operation, { requireCurrentWindow = false, computer = false } = {}) {
    electron.ipcMain.handle(channel, async (event, ...args) => {
      if (disposed) throw computer ? sanitizedComputerFailure() : sanitizedFailure();
      try {
        if (requireCurrentWindow && !currentWindowSender(event)) throw sanitizedComputerFailure();
        const result = await operation(...args);
        return computer ? computerPublic(result) : result;
      } catch {
        throw computer ? sanitizedComputerFailure() : sanitizedFailure();
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
  handle(IPC_CHANNELS.computerSelectMode, async (value) => {
    const request = computerModeRequest(value);
    return computerEnvelopePublic(await computerBoundary.selectMode(request), request.botId);
  }, { requireCurrentWindow: true, computer: true });
  handle(IPC_CHANNELS.computerRead, async (value) => {
    const botId = computerBotId(value);
    return computerEnvelopePublic(await computerBoundary.read(botId), botId);
  }, { requireCurrentWindow: true, computer: true });
  handle(IPC_CHANNELS.permissionDecide, async (value) => {
    const request = computerDecisionRequest(value);
    return permissionsPublic(await computerBoundary.decidePermission(request), request.botId);
  }, { requireCurrentWindow: true, computer: true });
  handle(IPC_CHANNELS.permissionRequestsList, async (value) => {
    const botId = computerBotId(value);
    return permissionRequestsPublic(await computerBoundary.listPermissionRequests(botId), botId);
  }, { requireCurrentWindow: true, computer: true });
  handle(IPC_CHANNELS.permissionsList, async (value) => {
    const botId = computerBotId(value);
    return permissionsPublic(await computerBoundary.listPermissions(botId), botId);
  }, { requireCurrentWindow: true, computer: true });
  handle(IPC_CHANNELS.permissionRevoke, async (value) => {
    const request = computerRevokeRequest(value);
    return permissionsPublic(await computerBoundary.revokePermission(request), request.botId);
  }, { requireCurrentWindow: true, computer: true });

  const onBotChanged = (event) => broadcast(event);
  const onRuntimeChanged = (event) => {
    if (typeof event?.botId !== "string") return;
    void controller.readBot(event.botId).then(broadcast).catch(() => {});
  };
  const onRuntimeEvent = (event) => broadcastRuntimeEvent(event);
  const onAccountChanged = (event) => broadcastChannel(ACCOUNT_CHANGE_CHANNEL, event);
  const onCatalogChanged = (event) => broadcastChannel(CATALOG_CHANGE_CHANNEL, event);
  const onComputerChanged = (event) => {
    try { broadcastChannel(COMPUTER_CHANGE_CHANNEL, computerEnvelopePublic(event)); } catch {}
  };
  const onComputerPermission = (event) => {
    try { broadcastChannel(COMPUTER_PERMISSION_CHANNEL, computerPublic(permissionPromptPublic(event))); } catch {}
  };
  controller.on?.("bot-changed", onBotChanged);
  controller.on?.("runtime-changed", onRuntimeChanged);
  controller.on?.("runtime-event", onRuntimeEvent);
  accountController.on?.("account-changed", onAccountChanged);
  accountController.on?.("catalog-changed", onCatalogChanged);
  computerBoundary.on?.("changed", onComputerChanged);
  computerBoundary.on?.("permission-requested", onComputerPermission);

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
      computerBoundary.off?.("changed", onComputerChanged);
      computerBoundary.off?.("permission-requested", onComputerPermission);
      computerBoundary.dispose?.();
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
  COMPUTER_CHANGE_CHANNEL,
  COMPUTER_PERMISSION_CHANNEL,
  IPC_CHANNELS,
  RUNTIME_EVENT_CHANNEL,
  createDirectCodexManager,
  createInferenceBridgeRuntime,
  createLazySidecarManager,
  installDesktopRuntime,
  loadConfiguredProvider,
  loadSidecarReceipt,
  prepareProductionUserData,
  resolveModelSelection,
  selectionMatchesCatalog,
  setInferenceBridgeEnvironment,
};
