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
const { BotDeletionCoordinator } = require("./bot-deletion-coordinator.cjs");
const { LocalAutomationController } = require("./local-automation-controller.cjs");
const { LocalAutomationNativeIO } = require("./local-automation-native-io.cjs");
const { LocalAutomationStore } = require("./local-automation-store.cjs");
const { BOT_ID, ModelSelectionStore } = require("./model-selection-store.cjs");
const { deleteConversationBindings } = require("../bridge/runtime-config.cjs");
const {
  acceptanceAppDataIntent,
  prepareOpenBotUserData,
  selectOpenBotAppData,
  verifySelectedOpenBotAppData,
} = require("./openbot-user-data.cjs");
const {
  createStandaloneComputerToolBridge,
  StandaloneConversationController,
} = require("./standalone-conversation-controller.cjs");
const { installStandaloneConversationIpc } = require("./standalone-conversation-ipc.cjs");
const { installLocalDesktopFrameIpc } = require("./local-desktop-frame-ipc.cjs");
const { OpenBotNativeCoordinator } = require("./openbot-native-coordinator.cjs");
const { installOpenBotNativeCoordinatorIpc } = require("./openbot-native-coordinator-ipc.cjs");
const { StandaloneConversationStore } = require("./standalone-conversation-store.cjs");
const { StandaloneSubagentRunner } = require("./standalone-subagent-runner.cjs");
const { ComputerTargetRouter } = require("../computer/computer-target-router.cjs");
const { createLocalComputerRuntimeComponents } = require("../local/local-computer-runtime.cjs");

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
  advanceSetup: "codex-bot:advance-setup",
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
const QUIT_HANDOFF_TIMEOUT_MS = 5_000;
const OPTIONAL_MODEL_EFFORTS = Object.freeze({
  "claude-fable-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-opus-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
  "claude-sonnet-5": Object.freeze(["low", "medium", "high", "xhigh", "max", "ultra-code"]),
});
const OPTIONAL_NATIVE_MODEL_PREFIX = "cliproxy-anthropic--";
const LOCAL_AUTOMATION_METHODS = Object.freeze([
  "getAgentAutomations",
  "listAllAutomations",
  "createAgentAutomation",
  "updateAgentAutomation",
  "setAgentAutomationEnabled",
  "deleteAgentAutomation",
  "runAgentAutomationNow",
]);

function sanitizedFailure() {
  const error = new Error("Codex bot operation failed.");
  error.code = "CODEX_BOT_OPERATION_FAILED";
  return error;
}

function invalidNativeModelSelection() {
  const error = new Error("Codex bot operation failed.");
  error.code = "CODEX_BOT_INVALID_NATIVE_MODEL_SELECTION";
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

function setupTransitionRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sanitizedFailure();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch { throw sanitizedFailure(); }
  const fields = ["botId", "expectedStage", "nextStage"];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !fields.includes(key) || !("value" in descriptors[key]))
    || fields.some((field) => !descriptors[field])) throw sanitizedFailure();
  const botId = descriptors.botId.value;
  const expectedStage = descriptors.expectedStage.value;
  const nextStage = descriptors.nextStage.value;
  const monotonic = (expectedStage === "profile-model" && nextStage === "computer")
    || (expectedStage === "computer" && nextStage === "complete");
  if (typeof botId !== "string" || !BOT_ID.test(botId) || !monotonic) throw sanitizedFailure();
  return Object.freeze({
    botId: botId.toLowerCase(),
    expectedStage,
    nextStage,
  });
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
const SHELL_PROMPT_PUBLIC_FIELDS = Object.freeze([
  ...PROMPT_PUBLIC_FIELDS, "command", "allowsAlways",
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
  let prompt;
  try { prompt = exactPlainInput(value, PROMPT_PUBLIC_FIELDS); }
  catch { prompt = exactPlainInput(value, SHELL_PROMPT_PUBLIC_FIELDS); }
  const botId = computerBotId(prompt.botId);
  const shell = prompt.capability === "shell.execute";
  if ((expectedBotId !== null && botId !== expectedBotId)
    || typeof prompt.requestId !== "string" || !PERMISSION_ID.test(prompt.requestId)
    || typeof prompt.targetId !== "string" || !TARGET_ID.test(prompt.targetId)
    || !Number.isSafeInteger(prompt.targetGeneration) || prompt.targetGeneration < 0
    || !COMPUTER_CAPABILITIES.has(prompt.capability)
    || !boundedPublicText(prompt.resourceLabel)
    || !boundedPublicText(prompt.reason, 512)
    || (shell && (typeof prompt.command !== "string" || prompt.command.length === 0
      || prompt.command.includes("\0") || Buffer.byteLength(prompt.command, "utf8") > 8192
      || prompt.allowsAlways !== false))
    || (!shell && Object.hasOwn(prompt, "command"))) {
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
    ...(shell ? { command: prompt.command, allowsAlways: false } : {}),
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
  const fields = ["botId", "provider", "model", "reasoningEffort", "serviceTier"];
  const required = ["botId", "model", "reasoningEffort"];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !fields.includes(key) || !("value" in descriptors[key]))
    || required.some((field) => !descriptors[field])) throw sanitizedFailure();
  const result = Object.fromEntries(fields
    .filter((field) => descriptors[field])
    .map((field) => [field, descriptors[field].value]));
  if (typeof result.botId !== "string" || !BOT_ID.test(result.botId)
    || !(result.provider === undefined || result.provider === "openai-codex"
      || result.provider === "cliproxy-anthropic")
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
  const officialModels = catalog?.status === "ready" ? catalogModels(catalog) : null;
  const officialModel = officialModels?.find((entry) => entry?.id === requested.model) ?? null;
  const choosesOptional = requested.provider === "cliproxy-anthropic"
    || (requested.provider === undefined && optionalEfforts && !officialModel);
  if (choosesOptional) {
    if (!optionalEfforts || !optionalEfforts.includes(requested.reasoningEffort)
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
  if (requested.provider === undefined && optionalEfforts && officialModel) throw sanitizedFailure();
  if (requested.provider === "cliproxy-anthropic"
    || (requested.provider === "openai-codex" && !officialModel)) {
    throw sanitizedFailure();
  }
  const model = officialModel;
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
      provider: value.provider,
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
  if (catalog?.status !== "ready") {
    return resolveModelSelection({
      botId,
      provider: "cliproxy-anthropic",
      model: "claude-fable-5",
      reasoningEffort: "medium",
      serviceTier: null,
    }, catalog);
  }
  const models = catalogModels(catalog);
  const model = models.find((entry) => entry?.isDefault === true) ?? models[0];
  return resolveModelSelection({
    botId,
    provider: "openai-codex",
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
  environment,
  ManagerClass = CodexAppServerManager,
} = {}) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)
    || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || typeof ManagerClass !== "function") {
    throw sanitizedFailure();
  }
  return new ManagerClass({
    resourcesPath,
    stateRoot: path.join(stateRoot, "direct-codex"),
    environment: environment === undefined
      ? Object.fromEntries(Object.entries(process.env))
      : environment,
    clientVersion: "0.2.0-macos.1",
  });
}

function freezeNativeModelValue(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeNativeModelValue(nested);
  return Object.freeze(value);
}

function nativeEffortLabel(value) {
  const labels = {
    low: "Light",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
    "ultra-code": "Ultra Code",
  };
  return labels[value] ?? String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function optionalNativeModelId(model) {
  if (typeof model !== "string" || !Object.hasOwn(OPTIONAL_MODEL_EFFORTS, model)) {
    throw sanitizedFailure();
  }
  return `${OPTIONAL_NATIVE_MODEL_PREFIX}${model}`;
}

function optionalModelFromNativeId(modelId) {
  if (typeof modelId !== "string" || !modelId.startsWith(OPTIONAL_NATIVE_MODEL_PREFIX)) return null;
  const model = modelId.slice(OPTIONAL_NATIVE_MODEL_PREFIX.length);
  return Object.hasOwn(OPTIONAL_MODEL_EFFORTS, model) && optionalNativeModelId(model) === modelId
    ? model
    : null;
}

function nativeCatalogModel({
  id,
  displayName,
  efforts,
  serviceTiers = [],
  defaultEffort,
  defaultServiceTier = null,
  defaultOn = false,
  provider,
  supportsImages = false,
}) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)
    || typeof displayName !== "string" || displayName.length < 1 || displayName.length > 160
    || !Array.isArray(efforts) || efforts.length < 1 || efforts.length > 16
    || efforts.some((effort) => typeof effort !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))
    || new Set(efforts).size !== efforts.length
    || !efforts.includes(defaultEffort)
    || !Array.isArray(serviceTiers) || serviceTiers.length > 16) throw sanitizedFailure();
  const tiers = serviceTiers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.id)
      || entry.id === "standard"
      || typeof entry.name !== "string" || entry.name.length < 1 || entry.name.length > 160) {
      throw sanitizedFailure();
    }
    return { id: entry.id, name: entry.name };
  });
  if (new Set(tiers.map((entry) => entry.id)).size !== tiers.length
    || (defaultServiceTier !== null && !tiers.some((entry) => entry.id === defaultServiceTier))) {
    throw sanitizedFailure();
  }
  const speedValues = [
    { value: "standard", displayName: "Standard" },
    ...tiers.map((entry) => ({ value: entry.id, displayName: entry.name })),
  ];
  const parameterDefinitions = [{
    id: "effort",
    name: "Effort",
    parameterType: {
      enumParameter: {
        values: efforts.map((effort) => ({ value: effort, displayName: nativeEffortLabel(effort) })),
      },
    },
  }];
  if (tiers.length) parameterDefinitions.push({
    id: "speed",
    name: "Speed",
    parameterType: { enumParameter: { values: speedValues } },
  });
  const speeds = tiers.length ? [null, ...tiers.map((entry) => entry.id)] : [null];
  const variants = efforts.flatMap((effort) => speeds.map((serviceTier) => {
    const speedName = serviceTier === null
      ? "Standard" : tiers.find((entry) => entry.id === serviceTier)?.name ?? serviceTier;
    const isDefault = effort === defaultEffort && serviceTier === defaultServiceTier;
    return {
      parameterValues: [
        { id: "effort", value: effort },
        ...(tiers.length ? [{ id: "speed", value: serviceTier ?? "standard" }] : []),
      ],
      displayName: tiers.length ? `${nativeEffortLabel(effort)} · ${speedName}` : nativeEffortLabel(effort),
      displayNameOutsidePicker: displayName,
      isMaxMode: true,
      isDefaultMaxConfig: isDefault,
      isDefaultNonMaxConfig: isDefault,
    };
  }));
  const anthropic = provider === "cliproxy-anthropic";
  return {
    name: id,
    defaultOn: defaultOn === true,
    supportsAgent: true,
    supportsThinking: true,
    supportsImages: supportsImages === true,
    supportsMaxMode: true,
    supportsNonMaxMode: false,
    clientDisplayName: displayName,
    inputboxShortModelName: displayName,
    vendorName: anthropic ? "CLIProxyAPI · Anthropic" : "OpenAI Codex",
    vendor: {
      id: anthropic ? "MODEL_VENDOR_ID_ANTHROPIC" : "MODEL_VENDOR_ID_OPENAI",
      displayName: anthropic ? "CLIProxyAPI · Anthropic" : "OpenAI Codex",
    },
    parameterDefinitions,
    variants,
  };
}

function nativeAvailableModels(catalog) {
  const official = catalog?.status === "ready" ? catalogModels(catalog) : [];
  if (official.some((entry) => typeof entry?.id === "string"
    && entry.id.startsWith(OPTIONAL_NATIVE_MODEL_PREFIX))) throw sanitizedFailure();
  const models = official.map((entry, index) => nativeCatalogModel({
    id: entry?.id,
    displayName: entry?.displayName,
    efforts: entry?.supportedReasoningEfforts,
    serviceTiers: entry?.serviceTiers ?? [],
    defaultEffort: entry?.defaultReasoningEffort,
    defaultServiceTier: entry?.defaultServiceTier ?? null,
    defaultOn: entry?.isDefault === true || (!official.some((model) => model?.isDefault === true) && index === 0),
    provider: "openai-codex",
    supportsImages: entry?.inputModalities?.includes?.("image") === true,
  }));
  for (const [id, efforts] of Object.entries(OPTIONAL_MODEL_EFFORTS)) {
    models.push(nativeCatalogModel({
      id: optionalNativeModelId(id),
      displayName: id.replace(/[-_.]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      efforts,
      defaultEffort: efforts.includes("medium") ? "medium" : efforts[0],
      provider: "cliproxy-anthropic",
    }));
  }
  if (models.length < 1 || new Set(models.map((model) => model.name)).size !== models.length) {
    throw sanitizedFailure();
  }
  return freezeNativeModelValue({
    models,
    modelNames: models.map((model) => model.name),
    useModelParameters: true,
  });
}

function nativeModelSelection(selection, catalog = null) {
  if (!selection || typeof selection !== "object"
    || !new Set(["openai-codex", "cliproxy-anthropic"]).has(selection.provider)
    || typeof selection.model !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(selection.model)
    || typeof selection.reasoningEffort !== "string"
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(selection.reasoningEffort)
    || !(selection.serviceTier === null || typeof selection.serviceTier === "string")) {
    throw sanitizedFailure();
  }
  const optional = selection.provider === "cliproxy-anthropic";
  if (optional && (!Object.hasOwn(OPTIONAL_MODEL_EFFORTS, selection.model)
    || !OPTIONAL_MODEL_EFFORTS[selection.model].includes(selection.reasoningEffort)
    || selection.serviceTier !== null)) throw sanitizedFailure();
  if (!optional && selection.model.startsWith(OPTIONAL_NATIVE_MODEL_PREFIX)) throw sanitizedFailure();
  const official = !optional && catalog?.status === "ready"
    ? catalogModels(catalog).find((entry) => entry?.id === selection.model)
    : null;
  if (!optional && catalog?.status === "ready") {
    if (!official || !Array.isArray(official.supportedReasoningEfforts)
      || !official.supportedReasoningEfforts.includes(selection.reasoningEffort)
      || !Array.isArray(official.serviceTiers)
      || official.serviceTiers.some((entry) => entry?.id === "standard")
      || new Set(official.serviceTiers.map((entry) => entry?.id)).size !== official.serviceTiers.length
      || (selection.serviceTier !== null && (!Array.isArray(official.serviceTiers)
        || !official.serviceTiers.some((entry) => entry?.id === selection.serviceTier)))) {
      throw sanitizedFailure();
    }
  }
  const hasSpeedParameter = !optional && (selection.serviceTier !== null
    || (Array.isArray(official?.serviceTiers) && official.serviceTiers.length > 0));
  return freezeNativeModelValue({
    modelId: optional ? optionalNativeModelId(selection.model) : selection.model,
    maxMode: true,
    parameters: [
      { id: "effort", value: selection.reasoningEffort },
      ...(hasSpeedParameter ? [{ id: "speed", value: selection.serviceTier ?? "standard" }] : []),
    ],
  });
}

function exactNativeModelParameters(value) {
  if (!Array.isArray(value)) throw invalidNativeModelSelection();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch { throw invalidNativeModelSelection(); }
  const length = descriptors.length?.value;
  const keys = Reflect.ownKeys(descriptors);
  if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 1 || length > 2
    || keys.length !== length + 1 || keys.some((key) => key === "length"
      ? !("value" in descriptors[key])
      : typeof key !== "string" || !/^(?:0|1)$/.test(key) || Number(key) >= length
        || !("value" in descriptors[key]))) throw invalidNativeModelSelection();
  return Array.from({ length }, (_, index) => {
    const entry = descriptors[String(index)].value;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidNativeModelSelection();
    }
    let entryDescriptors;
    let entryPrototype;
    try {
      entryDescriptors = Object.getOwnPropertyDescriptors(entry);
      entryPrototype = Object.getPrototypeOf(entry);
    } catch { throw invalidNativeModelSelection(); }
    const entryKeys = Reflect.ownKeys(entryDescriptors);
    const expectedId = index === 0 ? "effort" : "speed";
    if ((entryPrototype !== Object.prototype && entryPrototype !== null)
      || entryKeys.length !== 2
      || entryKeys.some((key) => typeof key !== "string" || !new Set(["id", "value"]).has(key)
        || !("value" in entryDescriptors[key]))
      || !entryDescriptors.id || !entryDescriptors.value
      || entryDescriptors.id.value !== expectedId
      || typeof entryDescriptors.value.value !== "string"
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(entryDescriptors.value.value)) {
      throw invalidNativeModelSelection();
    }
    return Object.freeze({ id: expectedId, value: entryDescriptors.value.value });
  });
}

function resolveNativeModelSelection(value, botId, catalog) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof botId !== "string" || !BOT_ID.test(botId)) throw invalidNativeModelSelection();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch { throw invalidNativeModelSelection(); }
  const fields = new Set(["modelId", "maxMode", "parameters"]);
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !fields.has(key)
      || !("value" in descriptors[key]))
    || !descriptors.modelId || !descriptors.parameters
    || typeof descriptors.modelId.value !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(descriptors.modelId.value)
    || (descriptors.maxMode && descriptors.maxMode.value !== true)) {
    throw invalidNativeModelSelection();
  }
  const modelId = descriptors.modelId.value;
  const parameters = exactNativeModelParameters(descriptors.parameters.value);
  const effort = parameters[0].value;
  const readyModels = catalog?.status === "ready" ? catalogModels(catalog) : null;
  if (readyModels && (new Set(readyModels.map((entry) => entry?.id)).size !== readyModels.length
    || readyModels.some((entry) => typeof entry?.id === "string"
      && entry.id.startsWith(OPTIONAL_NATIVE_MODEL_PREFIX)))) throw sanitizedFailure();
  if (modelId.startsWith(OPTIONAL_NATIVE_MODEL_PREFIX)) {
    const model = optionalModelFromNativeId(modelId);
    if (model === null || parameters.length !== 1
      || !OPTIONAL_MODEL_EFFORTS[model].includes(effort)) throw invalidNativeModelSelection();
    return Object.freeze({
      botId,
      provider: "cliproxy-anthropic",
      model,
      reasoningEffort: effort,
      serviceTier: null,
      catalogGeneration: 1,
    });
  }
  const models = readyModels ?? catalogModels(catalog);
  const model = models.find((entry) => entry?.id === modelId);
  if (!model) throw invalidNativeModelSelection();
  if (!Array.isArray(model.supportedReasoningEfforts) || !Array.isArray(model.serviceTiers)) {
    throw sanitizedFailure();
  }
  if (model.serviceTiers.some((entry) => entry?.id === "standard")
    || new Set(model.serviceTiers.map((entry) => entry?.id)).size !== model.serviceTiers.length) {
    throw sanitizedFailure();
  }
  if (!model.supportedReasoningEfforts.includes(effort)) throw invalidNativeModelSelection();
  let serviceTier = null;
  if (model.serviceTiers.length > 0) {
    if (parameters.length !== 2) throw invalidNativeModelSelection();
    const speed = parameters[1].value;
    serviceTier = speed === "standard" ? null : speed;
    if (serviceTier !== null && !model.serviceTiers.some((entry) => entry?.id === serviceTier)) {
      throw invalidNativeModelSelection();
    }
  } else if (parameters.length !== 1) throw invalidNativeModelSelection();
  return Object.freeze({
    botId,
    provider: "openai-codex",
    model: modelId,
    reasoningEffort: effort,
    serviceTier,
    catalogGeneration: catalog.generation,
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
  toolBridge = null,
  computerTargetRouter = null,
  capability = crypto.randomBytes(32).toString("hex"),
  DirectTransportClass = CodexDirectInferenceTransport,
  OptionalTransportClass = CLIProxyInferenceTransport,
  RouterClass = InferenceProviderRouter,
  StandaloneControllerClass = StandaloneConversationController,
  StandaloneStoreClass = StandaloneConversationStore,
  StandaloneSubagentRunnerClass = StandaloneSubagentRunner,
  BridgeClass = InferenceBridgeServer,
} = {}) {
  if (!codexManager || typeof codexManager !== "object"
    || !selectionStore || typeof selectionStore.read !== "function"
    || !sidecarManager || typeof sidecarManager.start !== "function"
    || !(readCatalog === null || typeof readCatalog === "function")
    || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || typeof capability !== "string" || !/^[a-f0-9]{64}$/.test(capability)
    || !(toolBridge === null || (toolBridge && typeof toolBridge.open === "function"))
    || !computerTargetRouter || typeof computerTargetRouter !== "object"
    || typeof computerTargetRouter.resolve !== "function"
    || [DirectTransportClass, OptionalTransportClass, RouterClass, StandaloneControllerClass,
      StandaloneStoreClass, StandaloneSubagentRunnerClass, BridgeClass]
      .some((value) => typeof value !== "function")) throw sanitizedFailure();
  const directTransport = new DirectTransportClass({
    manager: codexManager,
    workspacePath: path.join(stateRoot, "direct-codex", "empty-workspace"),
  });
  const readSelection = async (botId) => {
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
  };
  const router = new RouterClass({
    readSelection,
    directTransport,
    async createOptionalTransport(provider) {
      if (provider !== "cliproxy-anthropic") throw sanitizedFailure();
      const session = await sidecarManager.start();
      return new OptionalTransportClass({ session });
    },
  });
  const conversationStore = new StandaloneStoreClass({
    filePath: path.join(stateRoot, "standalone-conversations.v1.json"),
  });
  const subagentOptions = { router, readSelection };
  if (toolBridge !== null) subagentOptions.toolBridge = toolBridge;
  const subagentRunner = new StandaloneSubagentRunnerClass(subagentOptions);
  const conversationOptions = {
    router,
    readSelection,
    store: conversationStore,
    subagentRunner,
  };
  if (toolBridge !== null) conversationOptions.toolBridge = toolBridge;
  const conversations = new StandaloneControllerClass(conversationOptions);
  const bridge = new BridgeClass({ router, computerTargetRouter, capability });
  try {
    Object.defineProperty(bridge, "conversations", {
      configurable: false,
      enumerable: false,
      value: conversations,
      writable: false,
    });
  } catch {
    conversations.dispose?.();
    router.dispose?.();
    throw sanitizedFailure();
  }
  return bridge;
}

function prepareProductionUserData(electron, publisherPath = path.join(
  process.resourcesPath,
  "codex",
  "native",
  "openbot-profile-publish",
), options = {}) {
  const argv = options.argv ?? process.argv;
  const acceptanceIntent = acceptanceAppDataIntent(argv);
  const selected = selectOpenBotAppData({
    argv,
    appDataPath: acceptanceIntent ? undefined : electron.app.getPath("appData"),
    fsApi: options.fsApi,
    tempDirectory: options.tempDirectory,
    currentUid: options.currentUid,
  });
  const migration = prepareOpenBotUserData({
    appDataPath: selected.appDataPath,
    fsApi: options.fsApi,
    publisherPath,
  });
  if (selected.acceptance) {
    verifySelectedOpenBotAppData(selected, {
      fsApi: options.fsApi,
      currentUid: options.currentUid,
    });
  }
  electron.app.setPath("userData", migration.userDataPath);
  return migration;
}

function createStandaloneComputerComposition({
  electron,
  stateRoot,
  store,
  createComponents = createLocalComputerRuntimeComponents,
  TargetRouterClass = ComputerTargetRouter,
  createToolBridge = createStandaloneComputerToolBridge,
} = {}) {
  if (!electron || typeof electron !== "object"
    || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || !store || typeof store.read !== "function" || typeof store.updateComputer !== "function"
    || typeof createComponents !== "function" || typeof TargetRouterClass !== "function"
    || typeof createToolBridge !== "function") throw sanitizedFailure();
  let components;
  try { components = createComponents({ electron, stateRoot, store }); } catch { throw sanitizedFailure(); }
  if (!components || typeof components !== "object" || !components.boundary || !components.manager) {
    throw sanitizedFailure();
  }
  let targetRouter;
  let toolBridge;
  try {
    targetRouter = new TargetRouterClass({ store, localManager: components.manager });
    toolBridge = createToolBridge({ computerTargetRouter: targetRouter });
  } catch {
    try { targetRouter?.dispose?.(); } catch {}
    try { components.boundary.dispose?.(); } catch {}
    throw sanitizedFailure();
  }
  if (!toolBridge || typeof toolBridge.open !== "function") {
    try { targetRouter.dispose?.(); } catch {}
    try { components.boundary.dispose?.(); } catch {}
    throw sanitizedFailure();
  }
  return Object.freeze({
    boundary: components.boundary,
    localManager: components.manager,
    targetRouter,
    toolBridge,
  });
}

function createBotDeletionCoordinator({
  controller,
  store,
  automations,
  conversations,
  computerTargetRouter,
  computerBoundary,
  selectionStore,
  conversationBindingsPath,
  CoordinatorClass = BotDeletionCoordinator,
  deleteBindings = deleteConversationBindings,
} = {}) {
  if (typeof CoordinatorClass !== "function" || typeof deleteBindings !== "function") {
    throw sanitizedFailure();
  }
  return new CoordinatorClass({
    botRuntimeController: controller,
    botStore: store,
    automationController: automations,
    conversationController: conversations,
    computerTargetRouter,
    computerBoundary,
    modelSelectionStore: selectionStore,
    conversationBindingsFile: conversationBindingsPath,
    deleteConversationBindings: deleteBindings,
  });
}

function prepareLocalAutomationStateRoot(stateRoot) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || path.normalize(stateRoot) !== stateRoot || stateRoot.includes("\0")) throw sanitizedFailure();
  try {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const before = fs.lstatSync(stateRoot);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (!before.isDirectory() || before.isSymbolicLink()
      || currentUid < 0 || before.uid !== currentUid
      || fs.realpathSync.native(stateRoot) !== stateRoot) throw sanitizedFailure();
    fs.chmodSync(stateRoot, 0o700);
    const after = fs.lstatSync(stateRoot);
    if (!after.isDirectory() || after.isSymbolicLink() || after.uid !== currentUid
      || (after.mode & 0o7777) !== 0o700) throw sanitizedFailure();
  } catch { throw sanitizedFailure(); }
}

function createLocalAutomationComposition({
  stateRoot,
  conversations,
  NativeIOClass = LocalAutomationNativeIO,
  StoreClass = LocalAutomationStore,
  ControllerClass = LocalAutomationController,
} = {}) {
  if (!conversations || typeof conversations !== "object"
    || typeof NativeIOClass !== "function" || typeof StoreClass !== "function"
    || typeof ControllerClass !== "function") throw sanitizedFailure();
  prepareLocalAutomationStateRoot(stateRoot);
  try {
    const stateIO = new NativeIOClass({
      filePath: path.join(stateRoot, "local-automations.v1.json"),
    });
    const store = new StoreClass({ stateIO });
    const controller = new ControllerClass({ store, conversations });
    return Object.freeze({ controller, stateIO, store });
  } catch { throw sanitizedFailure(); }
}

function unavailableLocalAutomationCleanup() {
  return Object.freeze({
    async deleteBots() { throw sanitizedFailure(); },
  });
}

function readyLocalAutomationController(controller, ready) {
  const delegate = {};
  for (const method of LOCAL_AUTOMATION_METHODS) {
    delegate[method] = (...args) => Promise.resolve(ready)
      .then(() => controller[method](...args));
  }
  delegate.on = (...args) => controller.on(...args);
  delegate.off = (...args) => (typeof controller.off === "function"
    ? controller.off(...args)
    : controller.removeListener(...args));
  delegate.removeListener = (...args) => controller.removeListener(...args);
  return Object.freeze(delegate);
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
  });
  const accountController = new CodexAccountController({ manager: codexManager });
  const sidecarManager = createLazySidecarManager({
    resourcesPath: process.resourcesPath,
    stateRoot,
  });
  const computer = createStandaloneComputerComposition({ electron, stateRoot, store: botStore });
  const inferenceBridge = createInferenceBridgeRuntime({
    codexManager,
    selectionStore,
    sidecarManager,
    readCatalog: () => accountController.catalogState(),
    stateRoot,
    toolBridge: computer.toolBridge,
    computerTargetRouter: computer.targetRouter,
  });
  let localAutomation = null;
  try {
    localAutomation = createLocalAutomationComposition({
      stateRoot,
      conversations: inferenceBridge.conversations,
    });
  } catch {}
  const botDeletionCoordinator = createBotDeletionCoordinator({
    controller,
    store: botStore,
    automations: localAutomation?.controller ?? unavailableLocalAutomationCleanup(),
    conversations: inferenceBridge.conversations,
    computerTargetRouter: computer.targetRouter,
    computerBoundary: computer.boundary,
    selectionStore,
    conversationBindingsPath,
  });
  const nativeCoordinatorFactory = ({
    onSelectAgent, deleteBots, readActiveAgentId, automationController, modelController,
  }) => new OpenBotNativeCoordinator({
    botRuntimeController: controller,
    conversationController: inferenceBridge.conversations,
    automationController,
    modelController,
    deleteBots,
    onSelectAgent,
    readActiveAgentId,
  });
  process.env.CODEX_BOT_BRIDGE = path.join(__dirname, "..", "bridge", "server.cjs");
  process.env.CODEX_BOT_CONVERSATION_BINDINGS = conversationBindingsPath;
  process.env.CODEX_BOT_MODEL_SELECTIONS = modelSelectionsPath;
  delete process.env.CODEX_BOT_CLIPROXY_URL;
  delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
  delete process.env.CODEX_BOT_INFERENCE_ENDPOINT;
  delete process.env.CODEX_BOT_INFERENCE_CAPABILITY;
  return {
    accountController,
    botDeletionCoordinator,
    codexManager,
    computerBoundary: computer.boundary,
    computerTargetRouter: computer.targetRouter,
    localDesktopManager: computer.localManager,
    controller,
    inferenceBridge,
    localAutomationController: localAutomation?.controller ?? null,
    nativeCoordinatorFactory,
    standaloneConversations: inferenceBridge.conversations,
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
  const setQuitTimeout = typeof dependencies.setQuitTimeout === "function"
    ? dependencies.setQuitTimeout
    : setTimeout;
  const clearQuitTimeout = typeof dependencies.clearQuitTimeout === "function"
    ? dependencies.clearQuitTimeout
    : clearTimeout;
  const inferenceBridge = dependencies.inferenceBridge || null;
  const standaloneConversations = dependencies.standaloneConversations
    || inferenceBridge?.conversations
    || null;
  const botDeletionCoordinator = dependencies.botDeletionCoordinator || null;
  if (botDeletionCoordinator !== null
    && (!botDeletionCoordinator || typeof botDeletionCoordinator !== "object"
      || typeof botDeletionCoordinator.reconcilePending !== "function"
      || typeof botDeletionCoordinator.deleteBots !== "function"
      || typeof botDeletionCoordinator.dispose !== "function")) throw sanitizedFailure();
  const computerBoundary = dependencies.computerBoundary || Object.freeze({
    async selectMode() { throw sanitizedComputerFailure(); },
    async read() { throw sanitizedComputerFailure(); },
    async decidePermission() { throw sanitizedComputerFailure(); },
    async listPermissionRequests() { throw sanitizedComputerFailure(); },
    async listPermissions() { throw sanitizedComputerFailure(); },
    async revokePermission() { throw sanitizedComputerFailure(); },
    dispose() {},
  });
  const computerTargetRouter = dependencies.computerTargetRouter || null;
  const localDesktopManager = dependencies.localDesktopManager || null;
  const localAutomationController = dependencies.localAutomationController ?? null;
  if (localAutomationController !== null
    && (!localAutomationController || typeof localAutomationController !== "object"
      || LOCAL_AUTOMATION_METHODS.some((method) => typeof localAutomationController[method] !== "function")
      || typeof localAutomationController.start !== "function"
      || typeof localAutomationController.deleteBots !== "function"
      || typeof localAutomationController.dispose !== "function"
      || typeof localAutomationController.on !== "function"
      || typeof localAutomationController.removeListener !== "function")) throw sanitizedFailure();
  const profileSetupReceipts = new Map();
  const computerSetupReceipts = new Map();
  const registered = [];
  let disposePromise = null;
  let disposeComplete = false;
  let quitRequested = false;
  let finalQuitIssued = false;
  let quitHandoffStarted = false;
  let quitHandoffSettled = false;
  let quitDeadlineHandle = null;
  let disposed = false;
  let activeIdentityMutation = Promise.resolve();
  const startupReady = botDeletionCoordinator === null
    ? Promise.resolve()
    : Promise.resolve().then(() => botDeletionCoordinator.reconcilePending());
  void startupReady.catch(() => {});
  const automationReady = localAutomationController === null
    ? Promise.resolve()
    : startupReady.then(() => {
      if (disposed) throw sanitizedFailure();
      return localAutomationController.start();
    });
  void automationReady.catch(() => {});
  const nativeAutomationController = localAutomationController === null
    ? null
    : readyLocalAutomationController(localAutomationController, automationReady);
  const nativeModelController = Object.freeze({
    getAvailableModels: () => Promise.resolve(nativeAvailableModels(accountController.catalogState())),
    getAgentDefaultModel: () => readNativeModel(),
    setAgentDefaultModel: (model) => writeNativeModel(model),
    getComputerUseModel: () => readNativeModel(),
    setComputerUseModel: (model) => writeNativeModel(model),
  });
  const nativeCoordinator = dependencies.nativeCoordinator
    || (typeof dependencies.nativeCoordinatorFactory === "function"
      ? dependencies.nativeCoordinatorFactory({
        onSelectAgent: selectNativeAgent,
        deleteBots: botDeletionCoordinator === null ? null : deleteNativeBots,
        automationController: nativeAutomationController,
        modelController: nativeModelController,
        readActiveAgentId: typeof selectionStore.readActiveBotId === "function"
          ? () => selectionStore.readActiveBotId()
          : null,
      })
      : null);
  const standaloneIpc = standaloneConversations
    ? installStandaloneConversationIpc({
      electron,
      controller: standaloneConversations,
      ready: startupReady,
    })
    : null;
  const localFrameIpc = localDesktopManager
    ? installLocalDesktopFrameIpc({
      electron,
      manager: localDesktopManager,
      computerBoundary,
      ready: startupReady,
    })
    : null;
  const nativeCoordinatorIpc = nativeCoordinator
    ? installOpenBotNativeCoordinatorIpc({
      electron,
      coordinator: nativeCoordinator,
      localDesktopManager,
      ready: startupReady,
    })
    : null;
  void accountController.start().catch(() => {});
  void startupReady.then(() => {
    if (disposed || typeof controller.reconcile !== "function") return;
    return controller.reconcile();
  }).catch(() => {});
  if (inferenceBridge && typeof inferenceBridge.start === "function") {
    void startupReady
      .then(() => {
        if (disposed) return null;
        return inferenceBridge.start();
      })
      .then((session) => {
        if (disposed || session === null) return;
        setInferenceBridgeEnvironment(session);
      })
      .catch(() => {
        delete process.env.CODEX_BOT_INFERENCE_ENDPOINT;
        delete process.env.CODEX_BOT_INFERENCE_CAPABILITY;
      });
  }

  function isLocalDesktopWindow(window) {
    if (!localDesktopManager || typeof localDesktopManager.ownsWindow !== "function") return false;
    try { return Boolean(localDesktopManager.ownsWindow(window)); } catch { return true; }
  }

  function broadcast(bot) {
    const record = bot?.bot && typeof bot.bot === "object" ? bot.bot : bot;
    if (!record || typeof record !== "object") return;
    for (const window of electron.BrowserWindow.getAllWindows()) {
      if (isLocalDesktopWindow(window)) continue;
      try {
        if (!window.webContents.isDestroyed()) window.webContents.send(CHANGE_CHANNEL, record);
      } catch {}
    }
  }

  function broadcastRuntimeEvent(event) {
    if (!event || typeof event !== "object") return;
    for (const window of electron.BrowserWindow.getAllWindows()) {
      if (isLocalDesktopWindow(window)) continue;
      try {
        if (!window.webContents.isDestroyed()) window.webContents.send(RUNTIME_EVENT_CHANNEL, event);
      } catch {}
    }
  }

  function serializeActiveIdentityMutation(operation) {
    const current = activeIdentityMutation.then(operation, operation);
    activeIdentityMutation = current.catch(() => {});
    return current;
  }

  function selectNativeAgent(botId) {
    return serializeActiveIdentityMutation(async () => {
      if (disposed || typeof botId !== "string") throw sanitizedFailure();
      const bot = await controller.readBot(botId);
      if (disposed || !bot || bot.botId !== botId || typeof selectionStore.selectBot !== "function") {
        throw sanitizedFailure();
      }
      await currentModelSelection(botId);
      if (disposed) throw sanitizedFailure();
      await selectionStore.selectBot(botId);
      if (disposed) throw sanitizedFailure();
      broadcastRuntimeEvent(Object.freeze({ type: "active-bot-changed", botId }));
    });
  }

  async function deleteNativeBots(botIds) {
    try {
      await startupReady;
      return await serializeActiveIdentityMutation(async () => {
        if (disposed || botDeletionCoordinator === null) throw sanitizedFailure();
        const outcome = await botDeletionCoordinator.deleteBots(botIds);
        if (typeof outcome.activeBotId === "string") {
          broadcastRuntimeEvent(Object.freeze({
            type: "active-bot-changed",
            botId: outcome.activeBotId,
          }));
        }
        return outcome;
      });
    } catch {
      throw sanitizedFailure();
    }
  }

  function broadcastChannel(channel, value) {
    if (!value || typeof value !== "object") return;
    for (const window of electron.BrowserWindow.getAllWindows()) {
      if (isLocalDesktopWindow(window)) continue;
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

  function sameMainFrame(left, right) {
    try {
      const leftProcessId = left?.processId;
      const leftRoutingId = left?.routingId;
      const rightProcessId = right?.processId;
      const rightRoutingId = right?.routingId;
      return Number.isSafeInteger(leftProcessId) && leftProcessId >= 0
        && Number.isSafeInteger(leftRoutingId) && leftRoutingId >= 0
        && Number.isSafeInteger(rightProcessId) && rightProcessId >= 0
        && Number.isSafeInteger(rightRoutingId) && rightRoutingId >= 0
        && leftProcessId === rightProcessId && leftRoutingId === rightRoutingId;
    } catch { return false; }
  }

  function currentWindowView(event) {
    try {
      const sender = event?.sender;
      const senderFrame = event?.senderFrame;
      if (!currentWindowSender(event) || !senderFrame || !sameMainFrame(sender?.mainFrame, senderFrame)
        || typeof senderFrame.isDestroyed !== "function" || senderFrame.isDestroyed()) return null;
      return Object.freeze({ sender, senderFrame });
    } catch { return null; }
  }

  function handle(channel, operation, { requireCurrentWindow = false, computer = false } = {}) {
    electron.ipcMain.handle(channel, async (event, ...args) => {
      if (disposed) throw computer ? sanitizedComputerFailure() : sanitizedFailure();
      const view = botDeletionCoordinator === null ? null : currentWindowView(event);
      if (botDeletionCoordinator !== null && !view) {
        throw computer ? sanitizedComputerFailure() : sanitizedFailure();
      }
      try {
        await startupReady;
        if (disposed) throw computer ? sanitizedComputerFailure() : sanitizedFailure();
        if (view) {
          const current = currentWindowView(event);
          if (!current || current.sender !== view.sender
            || !sameMainFrame(current.senderFrame, view.senderFrame)) {
            throw computer ? sanitizedComputerFailure() : sanitizedFailure();
          }
        }
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
    if (current && catalog?.status !== "ready") return current;
    if (current && selectionMatchesCatalog(current, catalog)) return current;
    let requested;
    if (current) {
      try {
        requested = resolveModelSelection({
          botId,
          provider: current.provider,
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

  function modelSelectionMatches(left, right) {
    return Boolean(left && right
      && left.botId === right.botId
      && left.provider === right.provider
      && left.model === right.model
      && left.reasoningEffort === right.reasoningEffort
      && left.serviceTier === right.serviceTier
      && left.catalogGeneration === right.catalogGeneration
      && left.generation === right.generation);
  }

  async function activeNativeModelBot() {
    const activeBotId = typeof selectionStore.readActiveBotId === "function"
      ? await selectionStore.readActiveBotId()
      : null;
    if (typeof activeBotId === "string") {
      const active = await controller.readBot(activeBotId);
      if (active?.botId === activeBotId) return active;
    }
    const bots = await controller.listBots();
    const fallback = Array.isArray(bots) ? bots[0] : null;
    if (!fallback || typeof fallback.botId !== "string") return null;
    const current = await controller.readBot(fallback.botId);
    return current?.botId === fallback.botId ? current : null;
  }

  function readNativeModel() {
    return serializeActiveIdentityMutation(async () => {
      const bot = await activeNativeModelBot();
      if (!bot) return null;
      const selected = await currentModelSelection(bot.botId);
      return nativeModelSelection(selected, accountController.catalogState());
    });
  }

  function writeNativeModel(model) {
    return serializeActiveIdentityMutation(async () => {
      const bot = await activeNativeModelBot();
      if (!bot) throw sanitizedFailure();
      const catalog = accountController.catalogState();
      const requested = resolveNativeModelSelection(model, bot.botId, catalog);
      const selectWithinBarrier = async () => {
        const previousReceipt = profileSetupReceipts.get(bot.botId);
        const pendingReceipt = Object.freeze({
          renamed: previousReceipt?.renamed === true,
          profiled: previousReceipt?.profiled === true,
          model: null,
          catalogGeneration: null,
        });
        profileSetupReceipts.set(bot.botId, pendingReceipt);
        const currentBot = await controller.readBot(bot.botId);
        if (!currentBot || currentBot.botId !== bot.botId) throw sanitizedFailure();
        const selected = await selectionStore.writeNext(requested);
        await markModelForSetup(currentBot, selected, catalog, pendingReceipt);
        return selected;
      };
      const selected = typeof standaloneConversations?.withModelSelectionMutation === "function"
        ? await standaloneConversations.withModelSelectionMutation(bot.botId, selectWithinBarrier)
        : await selectWithinBarrier();
      broadcastRuntimeEvent(Object.freeze({ type: "active-bot-changed", botId: bot.botId }));
      return nativeModelSelection(selected, catalog);
    });
  }

  function computerIdentityMatches(left, right) {
    return Boolean(left && right
      && left.mode === right.mode
      && left.generation === right.generation
      && left.localProfileId === right.localProfileId
      && left.nativeAgentId === right.nativeAgentId
      && left.state === right.state
      && left.lastConfirmedAt === right.lastConfirmedAt
      && left.lastErrorCode === right.lastErrorCode);
  }

  function markRenamedForSetup(bot) {
    if (bot?.setupStage !== "profile-model") {
      if (typeof bot?.botId === "string") profileSetupReceipts.delete(bot.botId);
      return;
    }
    profileSetupReceipts.set(bot.botId, {
      renamed: true,
      profiled: false,
      model: null,
      catalogGeneration: null,
    });
  }

  function markProfiledForSetup(bot) {
    if (bot?.setupStage !== "profile-model") {
      if (typeof bot?.botId === "string") profileSetupReceipts.delete(bot.botId);
      return;
    }
    const previous = profileSetupReceipts.get(bot.botId);
    profileSetupReceipts.set(bot.botId, {
      renamed: previous?.renamed === true,
      profiled: previous?.renamed === true,
      model: null,
      catalogGeneration: null,
    });
  }

  async function markModelForSetup(bot, selection, catalog, pendingReceipt) {
    const previous = profileSetupReceipts.get(bot.botId);
    const currentBot = typeof controller.readBot === "function"
      ? await controller.readBot(bot.botId)
      : null;
    const currentCatalog = accountController.catalogState();
    if (previous !== pendingReceipt
      || bot.setupStage !== "profile-model" || currentBot?.setupStage !== "profile-model"
      || previous?.renamed !== true || previous?.profiled !== true
      || !Number.isSafeInteger(catalog?.generation) || catalog.generation < 0
      || currentCatalog?.generation !== catalog.generation
      || !selectionMatchesCatalog(selection, currentCatalog)) {
      if (profileSetupReceipts.get(bot.botId) === pendingReceipt) {
        profileSetupReceipts.delete(bot.botId);
      }
      return;
    }
    profileSetupReceipts.set(bot.botId, Object.freeze({
      renamed: true,
      profiled: true,
      model: selection,
      catalogGeneration: catalog.generation,
    }));
  }

  async function profileSetupCommitFence(botId) {
    const receipt = profileSetupReceipts.get(botId);
    const bot = typeof controller.readBot === "function" ? await controller.readBot(botId) : null;
    const catalog = accountController.catalogState();
    const selected = typeof selectionStore.read === "function" ? await selectionStore.read(botId) : null;
    if (bot?.setupStage !== "profile-model" || receipt?.renamed !== true || receipt?.profiled !== true
      || !receipt.model || catalog?.generation !== receipt.catalogGeneration
      || !selectionMatchesCatalog(receipt.model, catalog)
      || !modelSelectionMatches(selected, receipt.model)) {
      if (receipt && catalog?.generation !== receipt.catalogGeneration) {
        profileSetupReceipts.set(botId, { ...receipt, model: null, catalogGeneration: null });
      }
      throw sanitizedFailure();
    }
    return (currentBot) => {
      const currentReceipt = profileSetupReceipts.get(botId);
      const currentCatalog = accountController.catalogState();
      if (currentReceipt !== receipt || currentBot?.setupStage !== "profile-model"
        || currentCatalog?.generation !== receipt.catalogGeneration
        || !selectionMatchesCatalog(receipt.model, currentCatalog)) {
        if (currentReceipt === receipt
          && currentCatalog?.generation !== receipt.catalogGeneration) {
          profileSetupReceipts.set(botId, Object.freeze({
            ...receipt,
            model: null,
            catalogGeneration: null,
          }));
        }
        throw sanitizedFailure();
      }
    };
  }

  async function computerSetupCommitFence(botId) {
    const receipt = computerSetupReceipts.get(botId);
    const bot = typeof controller.readBot === "function" ? await controller.readBot(botId) : null;
    if (bot?.setupStage !== "computer" || !receipt
      || !computerIdentityMatches(bot.computer, receipt.computer)) throw sanitizedFailure();
    return (currentBot) => {
      if (computerSetupReceipts.get(botId) !== receipt
        || currentBot?.setupStage !== "computer"
        || !computerIdentityMatches(currentBot.computer, receipt.computer)) {
        if (computerSetupReceipts.get(botId) === receipt) computerSetupReceipts.delete(botId);
        throw sanitizedFailure();
      }
    };
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
  handle(IPC_CHANNELS.rename, async (botId, name) => {
    const bot = await controller.renameBot(botId, name);
    markRenamedForSetup(bot);
    return bot;
  });
  handle(IPC_CHANNELS.updateProfile, async (botId, profile) => {
    const bot = await controller.updateProfile(botId, profile);
    markProfiledForSetup(bot);
    return bot;
  });
  handle(IPC_CHANNELS.advanceSetup, async (value) => {
    const request = setupTransitionRequest(value);
    const commitFence = request.expectedStage === "profile-model"
      ? await profileSetupCommitFence(request.botId)
      : await computerSetupCommitFence(request.botId);
    const bot = await controller.advanceSetup(request.botId, {
      expectedStage: request.expectedStage,
      nextStage: request.nextStage,
    }, commitFence);
    profileSetupReceipts.delete(request.botId);
    computerSetupReceipts.delete(request.botId);
    return bot;
  });
  handle(IPC_CHANNELS.retryRuntime, (botId) => controller.retryRuntime(botId));
  handle(IPC_CHANNELS.selectBot, (botId) => serializeActiveIdentityMutation(async () => {
    const bot = await controller.readBot(botId);
    if (!bot || bot.botId !== botId) throw sanitizedFailure();
    const selection = await currentModelSelection(bot.botId);
    await selectionStore.selectBot(bot.botId);
    return selection;
  }));
  handle(IPC_CHANNELS.readModel, (botId) => serializeActiveIdentityMutation(async () => {
    const bot = await controller.readBot(botId);
    if (!bot || bot.botId !== botId) throw sanitizedFailure();
    return currentModelSelection(bot.botId);
  }));
  handle(IPC_CHANNELS.selectModel, (rawSelection) => {
    const requested = selectionRequest(rawSelection);
    return serializeActiveIdentityMutation(async () => {
      const selectWithinBarrier = async () => {
        const previousReceipt = profileSetupReceipts.get(requested.botId);
        const pendingReceipt = Object.freeze({
          renamed: previousReceipt?.renamed === true,
          profiled: previousReceipt?.profiled === true,
          model: null,
          catalogGeneration: null,
        });
        profileSetupReceipts.set(requested.botId, pendingReceipt);
        const bot = await controller.readBot(requested.botId);
        if (!bot || bot.botId !== requested.botId) throw sanitizedFailure();
        const catalog = accountController.catalogState();
        const selected = await selectionStore.writeNext(resolveModelSelection(requested, catalog));
        await markModelForSetup(bot, selected, catalog, pendingReceipt);
        return selected;
      };
      return typeof standaloneConversations?.withModelSelectionMutation === "function"
        ? standaloneConversations.withModelSelectionMutation(requested.botId, selectWithinBarrier)
        : selectWithinBarrier();
    });
  });
  handle(IPC_CHANNELS.computerSelectMode, async (value) => {
    const request = computerModeRequest(value);
    const pendingReceipt = Object.freeze({ mode: request.mode, computer: null });
    computerSetupReceipts.set(request.botId, pendingReceipt);
    const selected = computerEnvelopePublic(await computerBoundary.selectMode(request), request.botId);
    if (selected.computer.mode !== request.mode) {
      if (computerSetupReceipts.get(request.botId) === pendingReceipt) {
        computerSetupReceipts.delete(request.botId);
      }
      throw sanitizedComputerFailure();
    }
    if (typeof controller.readBot === "function") {
      const bot = await controller.readBot(request.botId);
      if (computerSetupReceipts.get(request.botId) !== pendingReceipt) return selected;
      if (bot?.setupStage === "computer" && computerIdentityMatches(bot.computer, selected.computer)) {
        computerSetupReceipts.set(request.botId, Object.freeze({
          mode: request.mode,
          computer: selected.computer,
        }));
      } else computerSetupReceipts.delete(request.botId);
    }
    return selected;
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
      if (disposePromise) return disposePromise;
      if (disposeComplete) return Promise.resolve();
      let settleDispose;
      disposePromise = new Promise((resolve) => { settleDispose = resolve; });
      disposed = true;
      const acknowledgements = [];
      const capture = (effect) => {
        try { acknowledgements.push(Promise.resolve(effect()).catch(() => {})); } catch {}
      };
      capture(() => profileSetupReceipts.clear());
      capture(() => computerSetupReceipts.clear());
      for (const channel of registered) {
        capture(() => electron.ipcMain.removeHandler(channel));
      }
      capture(() => controller.off?.("bot-changed", onBotChanged));
      capture(() => controller.off?.("runtime-changed", onRuntimeChanged));
      capture(() => controller.off?.("runtime-event", onRuntimeEvent));
      capture(() => accountController.off?.("account-changed", onAccountChanged));
      capture(() => accountController.off?.("catalog-changed", onCatalogChanged));
      capture(() => computerBoundary.off?.("changed", onComputerChanged));
      capture(() => computerBoundary.off?.("permission-requested", onComputerPermission));
      capture(() => localFrameIpc?.dispose());
      capture(() => nativeCoordinatorIpc?.dispose?.());
      capture(() => { delete process.env.CODEX_BOT_CLIPROXY_URL; });
      capture(() => { delete process.env.CODEX_BOT_CLIPROXY_TOKEN; });
      capture(() => { delete process.env.CODEX_BOT_INFERENCE_ENDPOINT; });
      capture(() => { delete process.env.CODEX_BOT_INFERENCE_CAPABILITY; });
      capture(() => standaloneIpc?.dispose?.());
      const disposeOwners = () => {
        const owners = [];
        const captureOwner = (effect) => {
          try { owners.push(Promise.resolve(effect()).catch(() => {})); } catch {}
        };
        captureOwner(() => standaloneConversations?.dispose?.());
        captureOwner(() => computerBoundary.dispose?.());
        captureOwner(() => computerTargetRouter?.dispose?.());
        captureOwner(() => accountController.dispose());
        captureOwner(() => inferenceBridge?.dispose?.());
        captureOwner(() => codexManager.stop());
        captureOwner(() => sidecarManager.stop());
        captureOwner(() => controller.dispose());
        return Promise.all(owners).then(() => undefined);
      };
      if (botDeletionCoordinator === null && localAutomationController === null) {
        capture(disposeOwners);
      } else {
        capture(async () => {
          if (botDeletionCoordinator !== null) {
            try { await botDeletionCoordinator.dispose(); } catch {}
          }
          if (localAutomationController !== null) {
            try { await localAutomationController.dispose(); } catch {}
          }
          await disposeOwners();
        });
      }
      const finishDispose = () => {
        try {
          disposeComplete = true;
          try { delete electron.app[INSTALLED]; } catch {}
          if (!quitRequested) removeBeforeQuitListener();
        } finally {
          settleDispose();
        }
      };
      void Promise.all(acknowledgements).then(finishDispose, finishDispose);
      return disposePromise;
    },
  });
  electron.app[INSTALLED] = api;
  const removeBeforeQuitListener = () => {
    try {
      if (typeof electron.app.off === "function") electron.app.off("before-quit", onBeforeQuit);
      else electron.app.removeListener?.("before-quit", onBeforeQuit);
    } catch {}
  };
  const issueFinalQuit = () => {
    if (!quitRequested || finalQuitIssued) return;
    finalQuitIssued = true;
    removeBeforeQuitListener();
    try { electron.app.quit?.(); } catch {}
  };
  const settleQuitHandoff = () => {
    if (quitHandoffSettled) return;
    quitHandoffSettled = true;
    if (quitDeadlineHandle !== null) {
      const handle = quitDeadlineHandle;
      quitDeadlineHandle = null;
      try { clearQuitTimeout(handle); } catch {}
    }
    issueFinalQuit();
  };
  const startQuitHandoff = () => {
    if (quitHandoffStarted) return;
    quitHandoffStarted = true;
    const disposal = api.dispose();
    try {
      quitDeadlineHandle = setQuitTimeout(() => {
        quitDeadlineHandle = null;
        settleQuitHandoff();
      }, QUIT_HANDOFF_TIMEOUT_MS);
      try { quitDeadlineHandle?.unref?.(); } catch {}
    } catch {
      settleQuitHandoff();
    }
    void disposal.then(settleQuitHandoff);
  };
  const onBeforeQuit = (event) => {
    if (disposeComplete || finalQuitIssued) return;
    try { event?.preventDefault?.(); } catch {}
    quitRequested = true;
    startQuitHandoff();
  };
  electron.app.on?.("before-quit", onBeforeQuit);
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
  createBotDeletionCoordinator,
  createLocalAutomationComposition,
  createDirectCodexManager,
  createInferenceBridgeRuntime,
  createLazySidecarManager,
  createStandaloneComputerComposition,
  installDesktopRuntime,
  loadConfiguredProvider,
  loadSidecarReceipt,
  nativeAvailableModels,
  nativeModelSelection,
  prepareProductionUserData,
  resolveModelSelection,
  resolveNativeModelSelection,
  selectionMatchesCatalog,
  setInferenceBridgeEnvironment,
};
