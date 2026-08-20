(function exposeBotRuntimeUi(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CodexBotRuntimeUi = api;
})(typeof window === "object" ? window : null, function createBotRuntimeUi() {
  "use strict";

  const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const MODEL_CONTROLS = typeof globalThis.CodexModelControls === "object"
    ? globalThis.CodexModelControls
    : typeof require === "function"
      ? require("./model-controls.js")
      : null;
  const POWER_CONTROL = typeof globalThis.CodexReasoningControl === "object"
    ? globalThis.CodexReasoningControl
    : typeof require === "function"
      ? require("./reasoning-control.js")
      : null;
  const NODE_UTIL_TYPES = typeof require === "function"
    ? (() => {
      try { return require("node:util").types; } catch { return null; }
    })()
    : null;
  const PROVIDER_IDS = Object.freeze([
    "openai-codex",
    "anthropic-claude",
    "google-antigravity",
    "moonshot-kimi",
    "xai",
    "google-vertex-ai",
    "openai-api-key",
    "local-openai-compatible",
  ]);
  const PROVIDER_LABELS = Object.freeze({
    "openai-codex": "OpenAI Codex",
    "anthropic-claude": "Anthropic Claude",
    "google-antigravity": "Google Antigravity",
    "moonshot-kimi": "Moonshot Kimi",
    xai: "xAI",
    "google-vertex-ai": "Google Vertex AI",
    "openai-api-key": "OpenAI API key",
    "local-openai-compatible": "Local models",
  });
  const PROVIDER_PRESENTATION = Object.freeze({
    "openai-codex": Object.freeze({ mark: "O", description: "Use your OpenAI Codex account.", recommended: true }),
    "anthropic-claude": Object.freeze({ mark: "A", description: "Connect your Anthropic account." }),
    "google-antigravity": Object.freeze({ mark: "G", description: "Connect Google Antigravity." }),
    "moonshot-kimi": Object.freeze({ mark: "K", description: "Sign in with a device code." }),
    xai: Object.freeze({ mark: "x", description: "Connect xAI with a device flow." }),
    "google-vertex-ai": Object.freeze({ mark: "V", description: "Use a Google Cloud service account." }),
    "openai-api-key": Object.freeze({ mark: "AI", description: "Use an OpenAI API key." }),
    "local-openai-compatible": Object.freeze({ mark: "{}", description: "Use an OpenAI-compatible local server." }),
  });
  const VERTEX_UNAVAILABLE_COPY = "A secure JSON file picker is not available in this build.";
  const PROVIDER_STATES = new Set(["connected", "connecting", "disconnected", "unavailable"]);
  const PROVIDER_LOGIN_USER_CODE = /^[A-Z0-9]{3,16}(?:-[A-Z0-9]{2,16})?$/;
  const API_KEY_LOGIN_KIND = "api-key";
  const PROVIDER_LOGIN_KINDS = Object.freeze({
    "openai-codex": "account",
    "anthropic-claude": "oauth",
    "google-antigravity": "oauth",
    "moonshot-kimi": "device",
    xai: "device",
    "google-vertex-ai": "service-account",
    "openai-api-key": API_KEY_LOGIN_KIND,
    "local-openai-compatible": "local",
  });
  const EFFORT_LABELS = Object.freeze({
    low: "Light",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
    "ultra-code": "Ultra Code",
  });
  const COMPUTER_CHOICES = Object.freeze([
    Object.freeze({ value: "local", label: "Free Local Desktop" }),
    Object.freeze({ value: "cursor", label: "Cursor Remote Computer" }),
    Object.freeze({ value: "not-now", label: "Not Now" }),
  ]);
  const DEFAULT_COMPUTER = Object.freeze({
    mode: "not-now",
    generation: 0,
    localProfileId: null,
    nativeAgentId: null,
    state: "unconfigured",
    lastConfirmedAt: null,
    lastErrorCode: null,
  });
  const COMPUTER_MODES = new Set(COMPUTER_CHOICES.map((entry) => entry.value));
  const COMPUTER_STATES = new Set(["unconfigured", "starting", "ready", "reconnecting", "unavailable"]);
  const BOT_SHAPES = Object.freeze([
    "blob", "pebble", "bean", "egg", "squircle", "tablet", "capsule", "cylinder",
    "hex", "gem", "crystal", "wedge", "shield", "dome", "arch", "cloud", "teardrop", "leaf",
  ]);
  const BOT_COLORS = Object.freeze([
    "black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray",
  ]);
  const BOT_SHAPE_IDS = new Set(BOT_SHAPES);
  const BOT_COLOR_IDS = new Set(BOT_COLORS);
  const SETUP_STAGES = new Set(["profile-model", "computer", "complete"]);
  const SETUP_STAGE_ORDER = Object.freeze({ "profile-model": 0, computer: 1, complete: 2 });
  const DEFAULT_SETUP_APPEARANCE = Object.freeze({
    shape: "blob",
    color: "red",
    image: null,
    description: "",
  });
  const MAX_AVATAR_DATA_LENGTH = 2_000_000;
  const MAX_LOCAL_PNG_BYTES = Math.floor((MAX_AVATAR_DATA_LENGTH - "data:image/png;base64,".length) * 3 / 4);
  const MAX_DESCRIPTION_LENGTH = 1000;
  const PERMISSION_DECISIONS = new Set(["deny", "once", "always"]);
  const TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const PERMISSION_ID = /^permission-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const GRANT_ID = /^grant-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
  const PERMISSION_CAPABILITIES = new Set([
    "filesystem.read",
    "filesystem.write",
    "shell.execute",
    "application.open",
    "application.automate",
    "screen.capture",
  ]);
  const COMPUTER_FIELDS = Object.freeze([
    "mode", "generation", "localProfileId", "nativeAgentId", "state",
    "lastConfirmedAt", "lastErrorCode",
  ]);
  const PROMPT_FIELDS = Object.freeze([
    "requestId", "botId", "targetId", "targetGeneration", "capability",
    "resourceLabel", "reason",
  ]);
  const SHELL_PROMPT_FIELDS = Object.freeze([
    ...PROMPT_FIELDS, "command", "allowsAlways",
  ]);
  const GRANT_FIELDS = Object.freeze([
    "grantId", "botId", "capability", "resourceId", "resourceLabel", "scope", "createdAt",
  ]);
  const MAX_PUBLIC_GRANTS = 256;
  const MAX_PENDING_PER_BOT = 32;
  const MAX_PENDING_TOTAL = 64;

  function isUltraEffect(effort) {
    return effort === "ultra" || effort === "ultra-code";
  }

  function normalizeLocalPngAvatar(value) {
    if (value === null) return null;
    if (typeof value !== "string" || value.length > MAX_AVATAR_DATA_LENGTH
      || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error("Bot photo must be a PNG smaller than 2 MB.");
    }
    const encoded = value.slice(value.indexOf(",") + 1);
    if (encoded.length % 4 !== 0) throw new Error("Bot photo must be a valid PNG.");
    return value;
  }

  function readLocalPngFile(file, FileReaderCtor) {
    if (!file || file.type !== "image/png" || !Number.isSafeInteger(file.size)
      || file.size < 1 || file.size > MAX_LOCAL_PNG_BYTES || typeof FileReaderCtor !== "function") {
      return Promise.reject(new Error("Choose a PNG smaller than 2 MB."));
    }
    return new Promise((resolve, reject) => {
      let reader;
      try { reader = new FileReaderCtor(); }
      catch { reject(new Error("Could not read that PNG.")); return; }
      reader.onerror = () => reject(new Error("Could not read that PNG."));
      reader.onload = () => {
        try { resolve(normalizeLocalPngAvatar(reader.result)); }
        catch { reject(new Error("Choose a valid PNG smaller than 2 MB.")); }
      };
      try { reader.readAsDataURL(file); }
      catch { reject(new Error("Could not read that PNG.")); }
    });
  }

  function closedProfileSetup() {
    return Object.freeze({
      open: false,
      pending: false,
      dismissible: false,
      name: "",
      description: "",
      image: null,
      shape: "blob",
      color: "red",
      provider: null,
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      error: null,
    });
  }

  function runtimePresentation(state) {
    if (state === "ready") {
      return Object.freeze({
        label: "Remote computer ready",
        controlsEnabled: true,
        retryVisible: false,
        tone: "ready",
      });
    }
    if (state === "provisioning") {
      return Object.freeze({
        label: "Starting remote computer…",
        controlsEnabled: false,
        retryVisible: false,
        tone: "pending",
      });
    }
    if (state === "reconnecting") {
      return Object.freeze({
        label: "Reconnecting to remote computer…",
        controlsEnabled: false,
        retryVisible: false,
        tone: "pending",
      });
    }
    return Object.freeze({
      label: "Remote computer unavailable",
      controlsEnabled: false,
      retryVisible: true,
      tone: "unavailable",
    });
  }

  function computerPresentation(computer) {
    if (computer.mode === "local") {
      if (computer.state === "ready") return Object.freeze({ label: "Runs on this Mac", tone: "ready" });
      if (computer.state === "starting") return Object.freeze({ label: "Starting on this Mac…", tone: "pending" });
      if (computer.state === "reconnecting") return Object.freeze({ label: "Reconnecting on this Mac…", tone: "pending" });
      return Object.freeze({ label: "Local Computer unavailable", tone: "unavailable" });
    }
    if (computer.mode === "cursor") {
      if (computer.state === "ready") return Object.freeze({ label: "Cursor Remote Computer ready", tone: "ready" });
      if (computer.state === "starting" || computer.state === "reconnecting") {
        return Object.freeze({ label: "Connecting Cursor Remote Computer…", tone: "pending" });
      }
      return Object.freeze({ label: "Connect Cursor for Remote Computer", tone: "unavailable" });
    }
    return Object.freeze({ label: "Computer not configured", tone: "neutral" });
  }

  function exactDataObject(value, fields, requiredOrMessage, messageValue) {
    const allowed = fields instanceof Set ? fields : new Set(fields);
    const legacyExact = messageValue === undefined && typeof requiredOrMessage === "string";
    const required = legacyExact
      ? [...allowed]
      : Array.isArray(requiredOrMessage) ? requiredOrMessage : [];
    const message = legacyExact ? requiredOrMessage : messageValue;
    let descriptors;
    let prototype;
    try {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      throw new Error(message);
    }
    const keys = Reflect.ownKeys(descriptors);
    if ((prototype !== Object.prototype && prototype !== null)
      || (legacyExact && keys.length !== allowed.size)
      || keys.some((key) => typeof key !== "string" || !allowed.has(key)
        || !("value" in descriptors[key]))
      || required.some((field) => !descriptors[field])) {
      throw new Error(message);
    }
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  }

  function exactDataArray(value, maximum, message) {
    let descriptors;
    let prototype;
    try {
      if (!Array.isArray(value)) throw new Error();
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      throw new Error(message);
    }
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : -1;
    const keys = Reflect.ownKeys(descriptors);
    if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 0 || length > maximum
      || keys.length !== length + 1 || keys.some((key) => {
        if (key === "length") return !("value" in descriptors[key]);
        return typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= length || !("value" in descriptors[key]);
      })) {
      throw new Error(message);
    }
    return Array.from({ length }, (_, index) => descriptors[String(index)].value);
  }

  function isProxyValue(value) {
    try { return NODE_UTIL_TYPES?.isProxy(value) === true; } catch { return false; }
  }

  function normalizeProviderLoginPrompt(value) {
    if (isProxyValue(value)) throw new Error("Provider login prompt is unavailable.");
    const prompt = exactDataObject(
      value,
      new Set(["schemaVersion", "providerId", "generation", "mode", "verificationUrl", "userCode"]),
      ["schemaVersion", "providerId", "generation", "mode", "verificationUrl", "userCode"],
      "Provider login prompt is unavailable.",
    );
    if (!NODE_UTIL_TYPES && typeof structuredClone === "function") {
      try { structuredClone(value); } catch { throw new Error("Provider login prompt is unavailable."); }
    }
    if (prompt.schemaVersion !== 1
      || prompt.providerId !== "openai-codex"
      || !Number.isSafeInteger(prompt.generation) || prompt.generation < 1
      || prompt.mode !== "device-code"
      || prompt.verificationUrl !== "https://auth.openai.com/codex/device"
      || typeof prompt.userCode !== "string" || !PROVIDER_LOGIN_USER_CODE.test(prompt.userCode)) {
      throw new Error("Provider login prompt is unavailable.");
    }
    return Object.freeze({
      schemaVersion: 1,
      providerId: "openai-codex",
      generation: prompt.generation,
      mode: "device-code",
      verificationUrl: prompt.verificationUrl,
      userCode: prompt.userCode,
    });
  }

  function clonePlainData(value, message) {
    const seen = new Set();
    const inspect = (candidate) => {
      if (candidate === null || typeof candidate !== "object") return;
      if (seen.has(candidate)) throw new Error(message);
      seen.add(candidate);
      let descriptors;
      let prototype;
      try {
        prototype = Object.getPrototypeOf(candidate);
        descriptors = Object.getOwnPropertyDescriptors(candidate);
      } catch {
        throw new Error(message);
      }
      if (Array.isArray(candidate)) {
        const lengthDescriptor = descriptors.length;
        const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : -1;
        if (prototype !== Array.prototype || !Number.isSafeInteger(length) || length < 0
          || Reflect.ownKeys(descriptors).length !== length + 1) throw new Error(message);
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor)) throw new Error(message);
          inspect(descriptor.value);
        }
        if (!("value" in lengthDescriptor)) throw new Error(message);
        return;
      }
      if (prototype !== Object.prototype && prototype !== null) throw new Error(message);
      for (const key of Reflect.ownKeys(descriptors)) {
        const descriptor = descriptors[key];
        if (typeof key !== "string" || !("value" in descriptor)) throw new Error(message);
        inspect(descriptor.value);
      }
    };
    try { inspect(value); }
    catch { throw new Error(message); }
    let clone;
    try {
      if (typeof structuredClone !== "function") throw new Error();
      clone = structuredClone(value);
    } catch {
      throw new Error(message);
    }
    return clone;
  }

  function validTimestamp(value) {
    if (typeof value !== "string") return false;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }

  function utf8Length(value) {
    try { return new TextEncoder().encode(value).byteLength; }
    catch { return Number.POSITIVE_INFINITY; }
  }

  function validPublicText(value, maximum = 320) {
    return typeof value === "string" && value.length > 0 && value.trim() === value
      && utf8Length(value) <= maximum && !/[\0-\x1f\x7f\\/]/.test(value)
      && !/(?:^|\s)~(?:\/|\s|$)/.test(value)
      && !/(?:^|\s)(?:file:|\/Users\/)/i.test(value);
  }

  function validResourceLabel(value) {
    return validPublicText(value);
  }

  function normalizeComputer(value) {
    const record = exactDataObject(value, COMPUTER_FIELDS, "Computer state is unavailable.");
    if (!COMPUTER_MODES.has(record.mode)
      || !Number.isSafeInteger(record.generation) || record.generation < 0
      || !COMPUTER_STATES.has(record.state)
      || !(record.localProfileId === null || (typeof record.localProfileId === "string" && TARGET_ID.test(record.localProfileId)))
      || !(record.nativeAgentId === null || (typeof record.nativeAgentId === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(record.nativeAgentId)))
      || !(record.lastConfirmedAt === null || validTimestamp(record.lastConfirmedAt))
      || !(record.lastErrorCode === null || (typeof record.lastErrorCode === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.lastErrorCode)))) {
      throw new Error("Computer state is unavailable.");
    }
    if (record.mode === "local" && record.localProfileId === null) throw new Error("Computer state is unavailable.");
    if (record.mode === "cursor" && record.state === "unconfigured") throw new Error("Computer state is unavailable.");
    if (record.mode === "cursor"
      && ["starting", "ready", "reconnecting"].includes(record.state)
      && record.nativeAgentId === null) throw new Error("Computer state is unavailable.");
    if (record.mode === "not-now" && record.state !== "unconfigured") throw new Error("Computer state is unavailable.");
    if (record.state === "ready" && record.lastConfirmedAt === null) throw new Error("Computer state is unavailable.");
    return Object.freeze(record);
  }

  function normalizeComputerEnvelope(value, expectedBotId = null) {
    const envelope = exactDataObject(value, ["botId", "computer"], "Computer state is unavailable.");
    if (typeof envelope.botId !== "string" || !BOT_ID.test(envelope.botId)
      || (expectedBotId !== null && envelope.botId !== expectedBotId)) {
      throw new Error("Computer state is unavailable.");
    }
    return Object.freeze({ botId: envelope.botId, computer: normalizeComputer(envelope.computer) });
  }

  function normalizePermissionPrompt(value) {
    let prompt;
    try {
      prompt = exactDataObject(value, PROMPT_FIELDS, "Permission request is unavailable.");
    } catch {
      prompt = exactDataObject(value, SHELL_PROMPT_FIELDS, "Permission request is unavailable.");
    }
    const shell = prompt.capability === "shell.execute";
    if (typeof prompt.requestId !== "string" || !PERMISSION_ID.test(prompt.requestId)
      || typeof prompt.botId !== "string" || !BOT_ID.test(prompt.botId)
      || typeof prompt.targetId !== "string" || !TARGET_ID.test(prompt.targetId)
      || !Number.isSafeInteger(prompt.targetGeneration) || prompt.targetGeneration < 0
      || !PERMISSION_CAPABILITIES.has(prompt.capability)
      || !validResourceLabel(prompt.resourceLabel)
      || !validPublicText(prompt.reason, 512)
      || (shell && (typeof prompt.command !== "string" || prompt.command.length === 0
        || prompt.command.includes("\0") || utf8Length(prompt.command) > 8192
        || prompt.allowsAlways !== false))
      || (!shell && Object.hasOwn(prompt, "command"))) {
      throw new Error("Permission request is unavailable.");
    }
    return Object.freeze(shell
      ? { ...prompt, allowsAlways: false }
      : prompt);
  }

  function normalizePermissionRequests(value, botId) {
    const envelope = exactDataObject(
      value,
      ["botId", "requests"],
      "Computer permission requests are unavailable.",
    );
    if (envelope.botId !== botId) throw new Error("Computer permission requests are unavailable.");
    const raw = exactDataArray(
      envelope.requests,
      MAX_PENDING_PER_BOT,
      "Computer permission requests are unavailable.",
    );
    return Object.freeze(raw.map((entry) => {
      const prompt = normalizePermissionPrompt(entry);
      if (prompt.botId !== botId) throw new Error("Computer permission requests are unavailable.");
      return prompt;
    }));
  }

  function normalizePermissions(value, botId) {
    const envelope = exactDataObject(value, ["botId", "permissions"], "Computer permissions are unavailable.");
    if (envelope.botId !== botId) throw new Error("Computer permissions are unavailable.");
    const raw = exactDataArray(envelope.permissions, MAX_PUBLIC_GRANTS, "Computer permissions are unavailable.");
    return Object.freeze(raw.map((entry) => {
      const grant = exactDataObject(entry, GRANT_FIELDS, "Computer permissions are unavailable.");
      if (grant.botId !== botId || typeof grant.grantId !== "string" || !GRANT_ID.test(grant.grantId)
        || !PERMISSION_CAPABILITIES.has(grant.capability)
        || typeof grant.resourceId !== "string" || !RESOURCE_ID.test(grant.resourceId)
        || grant.resourceId.includes("..") || grant.resourceId.includes("/") || grant.resourceId.includes("\\")
        || !validResourceLabel(grant.resourceLabel) || grant.scope !== "always"
        || !validTimestamp(grant.createdAt)) {
        throw new Error("Computer permissions are unavailable.");
      }
      return Object.freeze(grant);
    }));
  }

  function normalizeBot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Bot state is unavailable.");
    }
    let descriptors;
    let prototype;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
      prototype = Object.getPrototypeOf(value);
    } catch { throw new Error("Bot state is unavailable."); }
    if ((prototype !== Object.prototype && prototype !== null)
      || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
        || !("value" in descriptors[key]))) throw new Error("Bot state is unavailable.");
    const read = (field) => descriptors[field]?.value;
    const botId = read("botId");
    const name = read("name");
    const setupStage = read("setupStage");
    const runtimeValue = read("runtime");
    if (typeof botId !== "string" || !BOT_ID.test(botId)
      || typeof name !== "string" || name.trim().length === 0 || name.length > 160
      || !SETUP_STAGES.has(setupStage)
      || !runtimeValue || typeof runtimeValue !== "object" || Array.isArray(runtimeValue)) {
      throw new Error("Bot state is unavailable.");
    }
    let runtimeDescriptors;
    let runtimePrototype;
    try {
      runtimeDescriptors = Object.getOwnPropertyDescriptors(runtimeValue);
      runtimePrototype = Object.getPrototypeOf(runtimeValue);
    } catch { throw new Error("Bot state is unavailable."); }
    if ((runtimePrototype !== Object.prototype && runtimePrototype !== null)
      || Reflect.ownKeys(runtimeDescriptors).some((key) => typeof key !== "string"
        || !("value" in runtimeDescriptors[key]))
      || typeof runtimeDescriptors.state?.value !== "string") {
      throw new Error("Bot state is unavailable.");
    }
    let appearance;
    const appearanceValue = read("appearance");
    if (setupStage === "profile-model" && appearanceValue !== undefined) {
      if (!appearanceValue || typeof appearanceValue !== "object" || Array.isArray(appearanceValue)) {
        throw new Error("Bot state is unavailable.");
      }
      let appearanceDescriptors;
      let appearancePrototype;
      try {
        appearanceDescriptors = Object.getOwnPropertyDescriptors(appearanceValue);
        appearancePrototype = Object.getPrototypeOf(appearanceValue);
      } catch { throw new Error("Bot state is unavailable."); }
      if ((appearancePrototype !== Object.prototype && appearancePrototype !== null)
        || Reflect.ownKeys(appearanceDescriptors).some((key) => typeof key !== "string"
          || !("value" in appearanceDescriptors[key]))) throw new Error("Bot state is unavailable.");
      const shape = appearanceDescriptors.shape?.value;
      const color = appearanceDescriptors.color?.value;
      const image = appearanceDescriptors.image?.value;
      const description = appearanceDescriptors.description?.value;
      if (!BOT_SHAPE_IDS.has(shape) || !BOT_COLOR_IDS.has(color)
        || typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH
        || description.includes("\0")) throw new Error("Bot state is unavailable.");
      try { normalizeLocalPngAvatar(image); }
      catch { throw new Error("Bot state is unavailable."); }
      appearance = Object.freeze({ shape, color, image, description });
    }
    return Object.freeze({
      botId,
      name,
      setupStage,
      ...(appearance ? { appearance } : {}),
      runtime: Object.freeze({ state: runtimeDescriptors.state.value }),
      computer: normalizeComputer(read("computer") ?? DEFAULT_COMPUTER),
    });
  }

  function normalizeModelCatalog(value) {
    const catalog = exactDataObject(
      value,
      new Set(["status", "generation", "models"]),
      ["status", "generation", "models"],
      "Model catalog is unavailable.",
    );
    if (catalog.status !== "ready" || !Number.isSafeInteger(catalog.generation)
      || catalog.generation < 0) {
      throw new Error("Model catalog is unavailable.");
    }
    const catalogModels = exactDataArray(catalog.models, 512, "Model catalog is unavailable.");
    const models = [];
    const tuples = new Set();
    for (const valueEntry of catalogModels) {
      const raw = exactDataObject(
        valueEntry,
        new Set([
          "provider", "providerLabel", "model", "label", "efforts", "serviceTiers",
          "defaultReasoningEffort", "defaultServiceTier", "catalogGeneration", "isDefault",
        ]),
        ["provider", "providerLabel", "model", "label", "efforts", "serviceTiers",
          "defaultReasoningEffort", "defaultServiceTier", "catalogGeneration", "isDefault"],
        "Model catalog is unavailable.",
      );
      if (!PROVIDER_IDS.includes(raw.provider)
        || typeof raw.providerLabel !== "string" || raw.providerLabel.length < 1
        || raw.providerLabel.length > 160
        || typeof raw.model !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(raw.model)
        || typeof raw.label !== "string" || raw.label.trim().length < 1 || raw.label.length > 160
        || tuples.has(`${raw.provider}\u0000${raw.model}`)
        || !Array.isArray(raw.efforts) || raw.efforts.length < 1 || raw.efforts.length > 32
        || !Array.isArray(raw.serviceTiers) || typeof raw.isDefault !== "boolean") {
        throw new Error("Model catalog is unavailable.");
      }
      const effortValues = exactDataArray(raw.efforts, 32, "Model catalog is unavailable.");
      const serviceTierValues = exactDataArray(raw.serviceTiers, 16, "Model catalog is unavailable.");
      if (effortValues.length < 1 || effortValues.some((effort) => typeof effort !== "string"
        || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))) {
        throw new Error("Model catalog is unavailable.");
      }
      const efforts = Object.freeze([...new Set(effortValues)]);
      if (!efforts.includes(raw.defaultReasoningEffort)
        || typeof raw.defaultReasoningEffort !== "string"
        || !(raw.defaultServiceTier === null || (typeof raw.defaultServiceTier === "string"
          && /^[a-z][a-z0-9_-]{0,31}$/.test(raw.defaultServiceTier)))
        || !Number.isSafeInteger(raw.catalogGeneration) || raw.catalogGeneration < 0) {
        throw new Error("Model catalog is unavailable.");
      }
      const tierIds = new Set();
      const serviceTiers = Object.freeze(serviceTierValues.map((tierValue) => {
        const tier = exactDataObject(
          tierValue,
          new Set(["id", "name", "description"]),
          ["id", "name"],
          "Model catalog is unavailable.",
        );
        if (typeof tier.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(tier.id)
          || tierIds.has(tier.id) || typeof tier.name !== "string"
          || tier.name.trim().length < 1 || tier.name.length > 160
          || (tier.description !== undefined && (typeof tier.description !== "string"
            || tier.description.length > 1024))) {
          throw new Error("Model catalog is unavailable.");
        }
        tierIds.add(tier.id);
        return Object.freeze({ id: tier.id, name: tier.name, description: tier.description ?? "" });
      }));
      if (raw.defaultServiceTier !== null && !tierIds.has(raw.defaultServiceTier)) {
        throw new Error("Model catalog is unavailable.");
      }
      tuples.add(`${raw.provider}\u0000${raw.model}`);
      models.push(Object.freeze({
        model: raw.model,
        label: raw.label,
        provider: raw.provider,
        providerLabel: raw.providerLabel,
        efforts,
        defaultServiceTier: raw.defaultServiceTier,
        serviceTiers,
        catalogGeneration: raw.catalogGeneration,
        defaultReasoningEffort: raw.defaultReasoningEffort,
        isDefault: raw.isDefault,
      }));
    }
    return Object.freeze(models);
  }

  function normalizeProviderCatalog(value) {
    const envelope = exactDataObject(
      value,
      new Set(["status", "generation", "models"]),
      ["status", "generation", "models"],
      "Model catalog is unavailable.",
    );
    if (!(envelope.status === "ready" || envelope.status === "unavailable")
      || !Number.isSafeInteger(envelope.generation) || envelope.generation < 0) {
      throw new Error("Model catalog is unavailable.");
    }
    const models = exactDataArray(envelope.models, 512, "Model catalog is unavailable.");
    if (envelope.status === "ready") {
      return Object.freeze({
        generation: envelope.generation,
        status: "ready",
        models: normalizeModelCatalog(Object.freeze({
          status: "ready",
          generation: envelope.generation,
          models,
        })),
      });
    }
    return Object.freeze({
      generation: envelope.generation,
      status: "unavailable",
      models: Object.freeze([]),
    });
  }

  function normalizeLegacyAccountCatalog(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "ready" || !Number.isSafeInteger(value.generation)
      || value.generation < 0 || !Array.isArray(value.models)) {
      throw new Error("Model catalog is unavailable.");
    }
    const models = [];
    const seen = new Set();
    for (const candidate of value.models) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
        || typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(candidate.id)
        || seen.has(candidate.id) || typeof candidate.displayName !== "string"
        || candidate.displayName.length < 1 || candidate.displayName.length > 160
        || !Array.isArray(candidate.supportedReasoningEfforts)
        || candidate.supportedReasoningEfforts.length < 1) throw new Error("Model catalog is unavailable.");
      const efforts = Object.freeze([...candidate.supportedReasoningEfforts]);
      if (efforts.some((effort) => typeof effort !== "string"
        || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))) throw new Error("Model catalog is unavailable.");
      const tiers = Array.isArray(candidate.serviceTiers) ? candidate.serviceTiers : [];
      const serviceTiers = Object.freeze(tiers.map((tier) => {
        if (!tier || typeof tier !== "object" || Array.isArray(tier)
          || typeof tier.id !== "string" || typeof tier.name !== "string") {
          throw new Error("Model catalog is unavailable.");
        }
        return Object.freeze({ id: tier.id, name: tier.name, description: tier.description ?? "" });
      }));
      const defaultServiceTier = candidate.defaultServiceTier ?? null;
      const defaultReasoningEffort = candidate.defaultReasoningEffort ?? efforts[0];
      if (!efforts.includes(defaultReasoningEffort)
        || (defaultServiceTier !== null && !serviceTiers.some((tier) => tier.id === defaultServiceTier))) {
        throw new Error("Model catalog is unavailable.");
      }
      seen.add(candidate.id);
      models.push(Object.freeze({
        model: candidate.id,
        label: candidate.displayName,
        provider: "openai-codex",
        providerLabel: PROVIDER_LABELS["openai-codex"],
        efforts,
        defaultServiceTier,
        serviceTiers,
        catalogGeneration: value.generation,
        defaultReasoningEffort,
        isDefault: candidate.isDefault === true,
      }));
    }
    return Object.freeze(models);
  }

  function disconnectedProvider(providerId) {
    return Object.freeze({
      providerId,
      label: PROVIDER_LABELS[providerId],
      loginKind: PROVIDER_LOGIN_KINDS[providerId],
      state: "disconnected",
      generation: 0,
      capabilities: Object.freeze({ reasoning: false, fast: false }),
      errorCode: null,
    });
  }

  function normalizeProviderConnections(value) {
    const values = exactDataArray(value, PROVIDER_IDS.length, "Provider connections are unavailable.");
    if (values.length !== PROVIDER_IDS.length) throw new Error("Provider connections are unavailable.");
    const byId = new Map();
    for (const candidate of values) {
      const raw = exactDataObject(
        candidate,
        new Set(["providerId", "label", "loginKind", "state", "generation", "capabilities", "errorCode"]),
        ["providerId", "label", "loginKind", "state", "generation", "capabilities", "errorCode"],
        "Provider connections are unavailable.",
      );
      if (!PROVIDER_IDS.includes(raw.providerId) || byId.has(raw.providerId)
        || typeof raw.label !== "string" || raw.label.trim().length < 1 || raw.label.length > 160
        || raw.loginKind !== PROVIDER_LOGIN_KINDS[raw.providerId]
        || !PROVIDER_STATES.has(raw.state)
        || !Number.isSafeInteger(raw.generation) || raw.generation < 0
        || (raw.errorCode !== null && (typeof raw.errorCode !== "string" || raw.errorCode.length > 96))) {
        throw new Error("Provider connections are unavailable.");
      }
      const capabilities = exactDataObject(
        raw.capabilities,
        new Set(["reasoning", "fast"]),
        ["reasoning", "fast"],
        "Provider connections are unavailable.",
      );
      if (typeof capabilities.reasoning !== "boolean" || typeof capabilities.fast !== "boolean") {
        throw new Error("Provider connections are unavailable.");
      }
      byId.set(raw.providerId, Object.freeze({
        providerId: raw.providerId,
        label: raw.label,
        loginKind: raw.loginKind,
        state: raw.state,
        generation: raw.generation,
        capabilities: Object.freeze({ reasoning: capabilities.reasoning, fast: capabilities.fast }),
        errorCode: raw.errorCode,
      }));
    }
    return Object.freeze(PROVIDER_IDS.map((providerId) => byId.get(providerId) ?? disconnectedProvider(providerId)));
  }

  function normalizeProviderOnboarding(value, connections, catalog) {
    if (value === null) return null;
    const raw = exactDataObject(
      value,
      new Set(["schemaVersion", "providerId", "connectionGeneration", "catalogGeneration", "completedAt"]),
      ["schemaVersion", "providerId", "connectionGeneration", "catalogGeneration", "completedAt"],
      "Provider onboarding is unavailable.",
    );
    const connection = connections.find((entry) => entry.providerId === raw.providerId);
    if (raw.schemaVersion !== 1 || !connection || connection.state !== "connected"
      || !Number.isSafeInteger(raw.connectionGeneration) || raw.connectionGeneration < 0
      || connection.generation !== raw.connectionGeneration
      || !Number.isSafeInteger(raw.catalogGeneration) || raw.catalogGeneration < 0
      || catalog.status !== "ready" || catalog.generation !== raw.catalogGeneration
      || !catalog.models.some((entry) => entry.provider === raw.providerId)
      || !validTimestamp(raw.completedAt)) {
      throw new Error("Provider onboarding is unavailable.");
    }
    return Object.freeze({
      schemaVersion: 1,
      providerId: raw.providerId,
      connectionGeneration: raw.connectionGeneration,
      catalogGeneration: raw.catalogGeneration,
      completedAt: raw.completedAt,
    });
  }

  function normalizeProviderFacade(value) {
    if (value === null || value === undefined) return null;
    const methods = [
      "readAuthoritySnapshot", "connect", "disconnect", "completeOnboarding",
      "onConnectionsChanged", "onCatalogChanged", "onLoginPrompt",
    ];
    const allowed = new Set([...methods, "list", "catalog", "readOnboarding"]);
    const raw = exactDataObject(value, allowed, methods, "Provider facade is unavailable.");
    if (methods.some((method) => typeof raw[method] !== "function")) {
      throw new Error("Provider facade is unavailable.");
    }
    return Object.freeze(raw);
  }

  function normalizeProviderAuthoritySnapshot(value) {
    const cloned = clonePlainData(value, "Provider authority is unavailable.");
    const raw = exactDataObject(
      cloned,
      new Set(["schemaVersion", "connections", "catalog", "onboarding"]),
      ["schemaVersion", "connections", "catalog", "onboarding"],
      "Provider authority is unavailable.",
    );
    if (raw.schemaVersion !== 1) throw new Error("Provider authority is unavailable.");
    return Object.freeze({
      schemaVersion: 1,
      connections: normalizeProviderConnections(raw.connections),
      catalog: normalizeProviderCatalog(raw.catalog),
      onboarding: raw.onboarding,
    });
  }

  function normalizeNativeActiveBotId(value) {
    if (value === null) return null;
    if (typeof value !== "string" || !BOT_ID.test(value)) {
      throw new Error("Native active bot identity is unavailable.");
    }
    return value;
  }

  function readDataFunction(value, property, message) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, property); }
    catch { throw new Error(message); }
    if (!descriptor) return null;
    if (!("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new Error(message);
    }
    return descriptor.value;
  }

  function normalizeModelSelection(value, botId, catalog = Object.freeze([])) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Model selection is unavailable.");
    }
    let descriptors;
    let prototype;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
      prototype = Object.getPrototypeOf(value);
    } catch {
      throw new Error("Model selection is unavailable.");
    }
    const fields = [
      "botId", "provider", "model", "reasoningEffort", "serviceTier",
      "catalogGeneration", "generation",
    ];
    if ((prototype !== Object.prototype && prototype !== null)
      || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
        || !fields.includes(key) || !("value" in descriptors[key]))
      || fields.some((field) => !descriptors[field])) {
      throw new Error("Model selection is unavailable.");
    }
    const read = (field) => descriptors[field].value;
    const model = catalog.find((entry) => entry.provider === read("provider")
      && entry.model === read("model"));
    if (read("botId") !== botId || !model || !model.efforts.includes(read("reasoningEffort"))
      || read("provider") !== model.provider
      || (read("serviceTier") !== null
        && !model.serviceTiers.some((entry) => entry.id === read("serviceTier")))
      || read("catalogGeneration") !== model.catalogGeneration
      || !(read("serviceTier") === null || (typeof read("serviceTier") === "string"
        && /^[a-z][a-z0-9_-]{0,31}$/.test(read("serviceTier"))))
      || !Number.isSafeInteger(read("catalogGeneration")) || read("catalogGeneration") < 0
      || !Number.isSafeInteger(read("generation")) || read("generation") < 0) {
      throw new Error("Model selection is unavailable.");
    }
    return Object.freeze(Object.fromEntries(fields.map((field) => [field, read(field)])));
  }

  function isPendingCatalogSelection(value, botId) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return (prototype === Object.prototype || prototype === null)
        && descriptors.botId && "value" in descriptors.botId
        && descriptors.botId.value === botId
        && descriptors.provider && "value" in descriptors.provider
        && typeof descriptors.provider.value === "string"
        && PROVIDER_IDS.includes(descriptors.provider.value);
    } catch { return false; }
  }

  function createBotUiController({
    facade,
    runtimeFacade = null,
    accountFacade = null,
    providerFacade = null,
    catalogAuthorityManaged = false,
    computerFacade = null,
    nativeMode = false,
    onSelectionChanged = () => {},
    onRuntimeEvent = () => {},
    onStateChanged = () => {},
  } = {}) {
    if (
      facade == null ||
      typeof facade.list !== "function" ||
      typeof facade.onChanged !== "function" ||
      typeof onSelectionChanged !== "function" ||
      typeof onRuntimeEvent !== "function" ||
      typeof onStateChanged !== "function"
    ) {
      throw new Error("Bot controls are unavailable.");
    }
    const bots = new Map();
    let activeBotId = null;
    let preferredActiveBotId = null;
    let authoritativeActiveBotId = null;
    let activeIdentityEpoch = 0;
    let initializationComplete = false;
    let unsubscribe = null;
    let runtimeUnsubscribe = null;
    let catalogUnsubscribe = null;
    let computerUnsubscribe = null;
    let permissionUnsubscribe = null;
    let computerSubscribed = false;
    let permissionSubscribed = false;
    let disposed = false;
    let selectionEpoch = 0;
    let modelRequestEpoch = 0;
    let selectionFlight = null;
    let selectionPending = false;
    let creationPending = false;
    let creationBotId = null;
    let creationError = null;
    let modelSelection = null;
    let modelCatalog = Object.freeze([]);
    let catalogGeneration = -1;
    let catalogStatus = "loading";
    let profileSetup = closedProfileSetup();
    let profileSetupBotId = null;
    let profileSetupCatalogGeneration = -1;
    let computerSetup = Object.freeze({ open: false, pending: false, selectedMode: null, dismissible: false });
    let computerSetupBotId = null;
    let mandatorySetupBotId = null;
    let permissionRequest = null;
    const permissionQueue = new Map();
    const permissionRefreshes = new Map();
    const permissionRefreshDirty = new Set();
    const permissionReadEpochs = new Map();
    const permissionCommitEpochs = new Map();
    const computerBacklog = new Map();
    const computerIngress = new Map();
    let permissionIngress = 0;
    let permissionDecisionRequestId = null;
    let permissions = Object.freeze([]);

    function activeBot() {
      return activeBotId == null ? null : bots.get(activeBotId) ?? null;
    }

    function setupModelDescriptor(model = null, provider = null) {
      if (typeof model === "string") {
        const exact = modelCatalog.find((entry) => entry.model === model
          && (provider === null || entry.provider === provider));
        if (exact) return exact;
      }
      if (typeof provider === "string") {
        const providerDefault = modelCatalog.find((entry) => entry.provider === provider && entry.isDefault)
          ?? modelCatalog.find((entry) => entry.provider === provider);
        if (providerDefault) return providerDefault;
      }
      return modelCatalog.find((entry) => entry.isDefault) ?? modelCatalog[0] ?? null;
    }

    function setupSelectionFor(descriptor, preferred = null) {
      if (!descriptor) return Object.freeze({
        provider: null,
        model: null,
        reasoningEffort: null,
        serviceTier: null,
      });
      const preferredMatches = preferred?.provider === descriptor.provider
        && preferred.model === descriptor.model
        && preferred.catalogGeneration === descriptor.catalogGeneration;
      const reasoningEffort = preferredMatches && descriptor.efforts.includes(preferred.reasoningEffort)
        ? preferred.reasoningEffort
        : descriptor.efforts.includes(descriptor.defaultReasoningEffort)
          ? descriptor.defaultReasoningEffort
          : descriptor.efforts[0];
      const preferredTier = preferredMatches ? preferred.serviceTier : descriptor.defaultServiceTier;
      const serviceTier = preferredTier === null
        || descriptor.serviceTiers.some((entry) => entry.id === preferredTier)
        ? preferredTier
        : descriptor.defaultServiceTier;
      return Object.freeze({
        provider: descriptor.provider,
        model: descriptor.model,
        reasoningEffort,
        serviceTier,
      });
    }

    function openNewBotProfileSetup(botId) {
      const bot = bots.get(botId);
      if (!bot || botId !== activeBotId || mandatorySetupBotId !== botId
        || bot.setupStage !== "profile-model") {
        throw new Error("New Bot setup is unavailable.");
      }
      const descriptor = setupModelDescriptor(modelSelection?.model, modelSelection?.provider);
      const selection = setupSelectionFor(descriptor, modelSelection);
      const appearance = bot.appearance ?? DEFAULT_SETUP_APPEARANCE;
      profileSetupBotId = botId;
      profileSetupCatalogGeneration = catalogGeneration;
      profileSetup = Object.freeze({
        open: true,
        pending: false,
        dismissible: false,
        name: bot.name,
        description: appearance.description,
        image: appearance.image,
        shape: appearance.shape,
        color: appearance.color,
        ...selection,
        error: null,
      });
      computerSetup = Object.freeze({ open: false, pending: false, selectedMode: null, dismissible: false });
      computerSetupBotId = null;
      return profileSetup;
    }

    function openMandatoryComputerSetup(botId) {
      const bot = bots.get(botId);
      if (!bot || botId !== activeBotId || mandatorySetupBotId !== botId
        || bot.setupStage !== "computer") {
        throw new Error("Computer setup is unavailable.");
      }
      profileSetup = closedProfileSetup();
      profileSetupBotId = null;
      profileSetupCatalogGeneration = -1;
      computerSetupBotId = botId;
      computerSetup = Object.freeze({
        open: true,
        pending: false,
        selectedMode: null,
        dismissible: false,
      });
      return computerSetup;
    }

    function promptMatchesComputer(prompt, record) {
      return Boolean(record && prompt.botId === record.botId
        && record.computer.mode === "local" && record.computer.state === "ready"
        && record.computer.localProfileId === prompt.targetId
        && record.computer.generation === prompt.targetGeneration);
    }

    function computerPermissionTarget(computer) {
      return computer?.mode === "local" && computer.state === "ready"
        && typeof computer.localProfileId === "string"
        && Number.isSafeInteger(computer.generation)
        ? `${computer.localProfileId}:${computer.generation}`
        : null;
    }

    function sameComputerIdentity(left, right) {
      return Boolean(left && right
        && left.mode === right.mode
        && left.generation === right.generation
        && left.localProfileId === right.localProfileId
        && left.nativeAgentId === right.nativeAgentId
        && left.state === right.state
        && left.lastConfirmedAt === right.lastConfirmedAt
        && left.lastErrorCode === right.lastErrorCode);
    }

    function currentPermissionTarget(botId) {
      return computerPermissionTarget(bots.get(botId)?.computer);
    }

    function beginPermissionRead(botId) {
      const epoch = (permissionReadEpochs.get(botId) ?? 0) + 1;
      permissionReadEpochs.set(botId, epoch);
      return epoch;
    }

    function commitPermissionRead(botId, epoch) {
      if (epoch < (permissionCommitEpochs.get(botId) ?? 0)) return false;
      permissionCommitEpochs.set(botId, epoch);
      return true;
    }

    function invalidatePermissionReads(botId) {
      const epoch = beginPermissionRead(botId);
      permissionCommitEpochs.set(botId, epoch);
      return epoch;
    }

    async function refreshPermissionsForTarget(botId, target, ingress) {
      if (disposed || target === null || !computerFacade
        || typeof computerFacade.listPermissions !== "function") return false;
      const readEpoch = beginPermissionRead(botId);
      try {
        const nextPermissions = normalizePermissions(await computerFacade.listPermissions(botId), botId);
        if (disposed || activeBotId !== botId || currentPermissionTarget(botId) !== target
          || (computerIngress.get(botId) ?? 0) !== ingress
          || !commitPermissionRead(botId, readEpoch)) return false;
        permissions = nextPermissions;
        publish();
        return true;
      } catch {
        return false;
      }
    }

    function activePermissionRequests() {
      const record = activeBot();
      if (!record) return Object.freeze([]);
      return Object.freeze([...permissionQueue.values()]
        .map((entry) => entry.prompt)
        .filter((prompt) => promptMatchesComputer(prompt, record)));
    }

    function refreshPermissionRequest() {
      const requests = activePermissionRequests();
      permissionRequest = requests[0] ?? null;
      return requests;
    }

    function permissionQueueHasRoom(prompt) {
      if (permissionQueue.has(prompt.requestId)) return true;
      let botPending = 0;
      for (const entry of permissionQueue.values()) {
        if (entry.prompt.botId === prompt.botId) botPending += 1;
      }
      return botPending < MAX_PENDING_PER_BOT && permissionQueue.size < MAX_PENDING_TOTAL;
    }

    function makePermissionQueueRoom(prompt) {
      if (permissionQueueHasRoom(prompt)) return true;
      let botPending = 0;
      for (const entry of permissionQueue.values()) {
        if (entry.prompt.botId === prompt.botId) botPending += 1;
      }
      if (botPending >= MAX_PENDING_PER_BOT || prompt.botId !== activeBotId) return false;
      for (const [requestId, entry] of permissionQueue) {
        if (entry.prompt.botId === prompt.botId) continue;
        permissionQueue.delete(requestId);
        if (permissionQueueHasRoom(prompt)) return true;
      }
      return permissionQueueHasRoom(prompt);
    }

    function refreshAuthoritativePermissionRequests(botId) {
      if (disposed || !bots.has(botId) || !computerFacade
        || typeof computerFacade.listPermissionRequests !== "function") return null;
      const current = permissionRefreshes.get(botId);
      if (current) {
        permissionRefreshDirty.add(botId);
        return current;
      }
      const marker = permissionIngress;
      const operation = Promise.resolve()
        .then(() => computerFacade.listPermissionRequests(botId))
        .then((value) => {
          if (!disposed && bots.has(botId)) reconcilePermissionRequests(botId, value, marker);
        })
        .catch(() => {})
        .finally(() => {
          if (permissionRefreshes.get(botId) !== operation) return;
          permissionRefreshes.delete(botId);
          if (permissionRefreshDirty.delete(botId) && !disposed) {
            void refreshAuthoritativePermissionRequests(botId);
          }
        });
      permissionRefreshes.set(botId, operation);
      return operation;
    }

    function enqueuePermission(value, { shouldPublish = true } = {}) {
      if (disposed) return false;
      const prompt = normalizePermissionPrompt(value);
      const record = bots.get(prompt.botId);
      if (record && !promptMatchesComputer(prompt, record)) return false;
      if (!makePermissionQueueRoom(prompt)) {
        void refreshAuthoritativePermissionRequests(prompt.botId);
        return false;
      }
      permissionQueue.set(prompt.requestId, Object.freeze({ prompt, ingress: ++permissionIngress }));
      refreshPermissionRequest();
      if (shouldPublish) publish();
      return true;
    }

    function reconcilePermissionRequests(botId, value, marker, { shouldPublish = true } = {}) {
      const requests = normalizePermissionRequests(value, botId);
      for (const [requestId, entry] of permissionQueue) {
        if (entry.prompt.botId === botId && entry.ingress <= marker) permissionQueue.delete(requestId);
      }
      for (const prompt of requests) {
        if (!promptMatchesComputer(prompt, bots.get(botId))) continue;
        const current = permissionQueue.get(prompt.requestId);
        if (current && current.ingress > marker) continue;
        if (!makePermissionQueueRoom(prompt)) continue;
        permissionQueue.set(prompt.requestId, Object.freeze({ prompt, ingress: marker }));
      }
      refreshPermissionRequest();
      if (shouldPublish) publish();
      return requests;
    }

    function prunePermissionRequests(botId) {
      const record = bots.get(botId);
      for (const [requestId, entry] of permissionQueue) {
        if (entry.prompt.botId === botId && !promptMatchesComputer(entry.prompt, record)) {
          permissionQueue.delete(requestId);
        }
      }
      refreshPermissionRequest();
    }

    function snapshot() {
      const records = Object.freeze([...bots.values()]);
      const selected = activeBot();
      return Object.freeze({
        bots: records,
        activeBotId,
        activeBot: selected,
        runtime: runtimePresentation(selected?.runtime.state),
        modelSelection,
        modelCatalog,
        catalogGeneration,
        catalogStatus,
        selectionEpoch,
        selectionPending,
        creationPending,
        creationError,
        mandatorySetupPending: mandatorySetupBotId !== null
          || Boolean(computerFacade && [...bots.values()].some((record) => record.setupStage !== "complete")),
        profileSetup,
        computer: Object.freeze({
          ...(selected?.computer ?? DEFAULT_COMPUTER),
          ...computerPresentation(selected?.computer ?? DEFAULT_COMPUTER),
        }),
        computerChoices: COMPUTER_CHOICES,
        computerSetup,
        permissionRequest,
        permissionRequests: activePermissionRequests(),
        permissionDecisionPending: permissionDecisionRequestId !== null,
        permissions,
      });
    }

    function handleRuntimeEvent(event) {
      if (disposed) return;
      if (event?.type === "active-bot-changed") {
        if (typeof event.botId !== "string" || !BOT_ID.test(event.botId)) return;
        preferredActiveBotId = event.botId;
        activeIdentityEpoch += 1;
        if (initializationComplete && bots.has(event.botId) && activeBotId !== event.botId) {
          requestBotSelection(event.botId);
        }
        return;
      }
      if (
        !event
        || typeof event !== "object"
        || event.botId !== activeBotId
        || !Number.isSafeInteger(event.generation)
        || event.generation < 0
      ) return;
      try { onRuntimeEvent(event); } catch {}
    }

    function subscribeRuntimeEvents() {
      if (runtimeUnsubscribe || !runtimeFacade) return;
      const onEvent = readDataFunction(runtimeFacade, "onEvent", "Runtime event facade is unavailable.");
      if (!onEvent) return;
      const candidate = onEvent.call(runtimeFacade, handleRuntimeEvent);
      if (disposed) {
        if (typeof candidate === "function") candidate();
        throw new Error("Bot controls are unavailable.");
      }
      runtimeUnsubscribe = typeof candidate === "function" ? candidate : null;
    }

    function publish() {
      try {
        onStateChanged(snapshot());
      } catch {}
    }

    function requestBotSelection(botId, force = false) {
      try {
        const operation = selectBot(botId, force);
        if (operation && typeof operation.catch === "function") void operation.catch(() => {});
      } catch {}
    }

    function synchronizeActiveSetupStage(record) {
      if (!computerFacade || !record || record.botId !== activeBotId || selectionPending) return;
      if (record.setupStage === "complete") {
        if (mandatorySetupBotId !== record.botId || profileSetup.pending || computerSetup.pending) return;
        mandatorySetupBotId = null;
        profileSetup = closedProfileSetup();
        profileSetupBotId = null;
        profileSetupCatalogGeneration = -1;
        computerSetup = Object.freeze({ open: false, pending: false, selectedMode: null, dismissible: false });
        computerSetupBotId = null;
        return;
      }
      mandatorySetupBotId = record.botId;
      if (record.setupStage === "profile-model") {
        if (!profileSetup.open && !computerSetup.pending) openNewBotProfileSetup(record.botId);
        return;
      }
      if (!profileSetup.pending && !computerSetup.open) openMandatoryComputerSetup(record.botId);
    }

    function applyBot(value) {
      if (disposed) throw new Error("Bot controls are unavailable.");
      let record = normalizeBot(value);
      const existing = bots.get(record.botId);
      const previousTarget = computerPermissionTarget(existing?.computer);
      if (existing && SETUP_STAGE_ORDER[record.setupStage] < SETUP_STAGE_ORDER[existing.setupStage]) {
        record = Object.freeze({ ...record, setupStage: existing.setupStage });
      }
      if (existing && existing.computer.generation > record.computer.generation) {
        record = Object.freeze({ ...record, computer: existing.computer });
      }
      bots.set(record.botId, record);
      const nextTarget = computerPermissionTarget(record.computer);
      if (previousTarget !== nextTarget) {
        const ingress = (computerIngress.get(record.botId) ?? 0) + 1;
        computerIngress.set(record.botId, ingress);
        invalidatePermissionReads(record.botId);
        if (record.botId === activeBotId) {
          permissions = Object.freeze([]);
          if (nextTarget !== null) void refreshPermissionsForTarget(record.botId, nextTarget, ingress);
        }
      }
      prunePermissionRequests(record.botId);
      synchronizeActiveSetupStage(record);
      // Native mode has no renderer-owned default active bot. A later
      // authoritative active-bot event may select one, but an ordinary bot
      // update must never persist the first roster member by accident.
      if (activeBotId == null && !nativeMode) requestBotSelection(record.botId);
      else publish();
      return record;
    }

    function applyComputer(value, {
      shouldPublish = true,
      expectedIngress = null,
      expectedBotId = null,
    } = {}) {
      if (disposed) return false;
      const normalized = normalizeComputerEnvelope(value, expectedBotId);
      if (!bots.has(normalized.botId)) return false;
      if (expectedIngress !== null
        && (computerIngress.get(normalized.botId) ?? 0) !== expectedIngress) return false;
      const record = bots.get(normalized.botId);
      if (record.computer.generation > normalized.computer.generation) return false;
      const previousTarget = computerPermissionTarget(record.computer);
      bots.set(normalized.botId, Object.freeze({ ...record, computer: normalized.computer }));
      const nextTarget = computerPermissionTarget(normalized.computer);
      if (previousTarget !== nextTarget) {
        invalidatePermissionReads(normalized.botId);
        if (normalized.botId === activeBotId) permissions = Object.freeze([]);
      }
      prunePermissionRequests(normalized.botId);
      if (shouldPublish) publish();
      if (shouldPublish && normalized.botId === activeBotId && nextTarget !== null) {
        void refreshPermissionsForTarget(
          normalized.botId,
          nextTarget,
          computerIngress.get(normalized.botId) ?? 0,
        );
      }
      return true;
    }

    function applyCatalog(value, { refreshSelection = true, legacyAccount = false } = {}) {
      if (disposed) return false;
      const generation = value && typeof value === "object" && !Array.isArray(value)
        && Number.isSafeInteger(value.generation) && value.generation >= 0
        ? value.generation
        : null;
      if (generation !== null && generation < catalogGeneration) return false;

      let nextCatalog = Object.freeze([]);
      let nextStatus = "unavailable";
      if (value && typeof value === "object" && !Array.isArray(value)
        && value.status === "ready") {
        try {
          nextCatalog = legacyAccount ? normalizeLegacyAccountCatalog(value) : normalizeModelCatalog(value);
          nextStatus = "ready";
        } catch {}
      } else if (value && typeof value === "object" && !Array.isArray(value)
        && typeof value.status === "string" && value.status.length > 0) {
        nextStatus = value.status;
      }

      if (generation !== null) catalogGeneration = generation;
      catalogStatus = nextStatus;
      modelCatalog = nextCatalog;
      let retainedSelection = null;
      if (modelSelection && activeBotId) {
        try {
          retainedSelection = normalizeModelSelection(modelSelection, activeBotId, nextCatalog);
        } catch {}
      }
      const selectionInvalidated = modelSelection !== null && retainedSelection === null;
      modelSelection = retainedSelection;
      publish();
      if (refreshSelection && nextStatus === "ready" && activeBotId
        && (selectionInvalidated || modelSelection === null)) {
        requestBotSelection(activeBotId, true);
      } else if (refreshSelection && nextStatus === "ready" && activeBotId === null && computerFacade) {
        const pending = [...bots.values()].find((record) => record.setupStage !== "complete");
        if (pending) requestBotSelection(pending.botId);
      }
      return true;
    }

    function selectBot(botId, force = false) {
      if (disposed || typeof botId !== "string" || !bots.has(botId)) {
        throw new Error("Bot selection is unavailable.");
      }
      const targetBot = bots.get(botId);
      const targetSetupPending = Boolean(computerFacade && targetBot.setupStage !== "complete");
      if (selectionFlight?.botId === botId
        && (creationPending || mandatorySetupBotId === botId)) {
        return selectionFlight.promise;
      }
      if ((creationPending && creationBotId !== botId)
        || (mandatorySetupBotId !== null && mandatorySetupBotId !== botId)
        || (profileSetup.open && (profileSetupBotId !== botId || force))
        || (computerSetup.open && !computerSetup.dismissible
          && (computerSetupBotId !== botId || force))) {
        throw new Error("Bot selection is unavailable while setup is pending.");
      }
      const expectedSetupOpen = targetBot.setupStage === "profile-model"
        ? profileSetup.open
        : computerSetup.open;
      const mandatoryRecovery = targetSetupPending && activeBotId === botId && !expectedSetupOpen;
      if (activeBotId === botId && !force && !mandatoryRecovery) {
        return selectionFlight?.botId === botId
          ? selectionFlight.promise
          : Promise.resolve(snapshot());
      }
      const previousBotId = activeBotId;
      const previousMandatorySetupBotId = mandatorySetupBotId;
      const previousModelSelection = modelSelection;
      const previousPermissions = permissions;
      const previousPermissionTarget = previousBotId === null ? null : currentPermissionTarget(previousBotId);
      const previousPermissionCommit = previousBotId === null
        ? 0
        : permissionCommitEpochs.get(previousBotId) ?? 0;
      const epoch = ++selectionEpoch;
      try {
        onSelectionChanged(null);
      } catch {}
      activeBotId = botId;
      mandatorySetupBotId = targetSetupPending ? botId : null;
      modelSelection = null;
      selectionPending = true;
      permissions = Object.freeze([]);
      profileSetup = closedProfileSetup();
      profileSetupBotId = null;
      profileSetupCatalogGeneration = -1;
      computerSetup = Object.freeze({ open: false, pending: false, selectedMode: null, dismissible: false });
      computerSetupBotId = null;
      refreshPermissionRequest();
      publish();
      const computerMarker = computerIngress.get(botId) ?? 0;
      const operation = (async () => {
        try {
          let selectedResult = null;
          if (runtimeFacade && typeof runtimeFacade.selectBot === "function") {
            selectedResult = await runtimeFacade.selectBot(botId);
          }
          const stored = runtimeFacade && typeof runtimeFacade.readModel === "function"
            ? await runtimeFacade.readModel(botId)
            : selectedResult;
          const computerResult = computerFacade && typeof computerFacade.read === "function"
            ? normalizeComputerEnvelope(await computerFacade.read(botId), botId)
            : null;
          const permissionMarker = permissionIngress;
          const requestResult = computerFacade && typeof computerFacade.listPermissionRequests === "function"
            ? await computerFacade.listPermissionRequests(botId)
            : { botId, requests: [] };
          if (disposed || epoch !== selectionEpoch || activeBotId !== botId) {
            throw new Error("Bot selection changed.");
          }
          if (stored && typeof stored === "object") {
            try {
              modelSelection = normalizeModelSelection(stored, botId, modelCatalog);
            } catch (error) {
              if (catalogStatus === "ready" || !isPendingCatalogSelection(stored, botId)) throw error;
              modelSelection = null;
            }
          }
          if (computerResult) {
            applyComputer(computerResult, {
              shouldPublish: false,
              expectedIngress: computerMarker,
              expectedBotId: botId,
            });
          }
          reconcilePermissionRequests(botId, requestResult, permissionMarker, { shouldPublish: false });
          const permissionReadEpoch = beginPermissionRead(botId);
          const permissionResult = computerFacade && typeof computerFacade.listPermissions === "function"
            ? await computerFacade.listPermissions(botId)
            : { botId, permissions: [] };
          if (disposed || epoch !== selectionEpoch || activeBotId !== botId) {
            throw new Error("Bot selection changed.");
          }
          const nextPermissions = normalizePermissions(permissionResult, botId);
          const permissionTarget = computerResult === null
            ? null
            : computerPermissionTarget(computerResult.computer);
          if ((computerIngress.get(botId) ?? 0) === computerMarker
            && currentPermissionTarget(botId) === permissionTarget
            && commitPermissionRead(botId, permissionReadEpoch)) {
            permissions = permissionTarget === null ? Object.freeze([]) : nextPermissions;
          }
          selectionPending = false;
          if (computerFacade && mandatorySetupBotId === botId) {
            const current = bots.get(botId);
            if (current?.setupStage === "profile-model") openNewBotProfileSetup(botId);
            else if (current?.setupStage === "computer") openMandatoryComputerSetup(botId);
            else mandatorySetupBotId = null;
          }
          try { onSelectionChanged(botId); } catch {}
          publish();
          return snapshot();
        } catch (error) {
          if (!disposed && epoch === selectionEpoch && activeBotId === botId) {
            activeBotId = previousBotId;
            mandatorySetupBotId = previousMandatorySetupBotId;
            modelSelection = previousModelSelection;
            const repairTarget = previousBotId === null ? null : currentPermissionTarget(previousBotId);
            const permissionCommittedSinceSelection = previousBotId !== null
              && (permissionCommitEpochs.get(previousBotId) ?? 0) > previousPermissionCommit;
            if (!(previousBotId === botId && permissionCommittedSinceSelection)) {
              permissions = repairTarget !== previousPermissionTarget
                ? Object.freeze([])
                : previousPermissions;
            }
            selectionPending = false;
            refreshPermissionRequest();
            try { onSelectionChanged(previousBotId); } catch {}
            publish();
            if (previousBotId !== null && repairTarget !== null) {
              void refreshPermissionsForTarget(
                previousBotId,
                repairTarget,
                computerIngress.get(previousBotId) ?? 0,
              );
            }
          }
          throw error;
        }
      })();
      selectionFlight = { botId, epoch, promise: operation };
      const clear = () => {
        if (selectionFlight?.epoch === epoch) selectionFlight = null;
      };
      operation.then(clear, clear);
      return operation;
    }

    async function initialize() {
      if (disposed) throw new Error("Bot controls are unavailable.");
      if (nativeMode) subscribeRuntimeEvents();
      if (nativeMode) {
        const readActiveBotId = readDataFunction(
          runtimeFacade,
          "readActiveBotId",
          "Native active bot identity is unavailable.",
        );
        if (readActiveBotId) {
          const readEpoch = activeIdentityEpoch;
          const readValue = normalizeNativeActiveBotId(await readActiveBotId.call(runtimeFacade));
          if (disposed) throw new Error("Bot controls are unavailable.");
          const eventWonRead = activeIdentityEpoch !== readEpoch || preferredActiveBotId !== null;
          authoritativeActiveBotId = eventWonRead ? preferredActiveBotId : readValue;
        }
      }
      if (computerFacade && typeof computerFacade.onChanged === "function" && !computerSubscribed) {
        computerSubscribed = true;
        const candidateComputer = computerFacade.onChanged((value) => {
          try {
            const normalized = normalizeComputerEnvelope(value);
            computerIngress.set(normalized.botId, (computerIngress.get(normalized.botId) ?? 0) + 1);
            if (!bots.has(normalized.botId)) {
              const previous = computerBacklog.get(normalized.botId);
              if (!previous || previous.computer.generation <= normalized.computer.generation) {
                computerBacklog.set(normalized.botId, normalized);
              }
              return;
            }
            applyComputer(normalized);
          } catch {}
        });
        computerUnsubscribe = typeof candidateComputer === "function" ? candidateComputer : null;
      }
      if (computerFacade && typeof computerFacade.onPermissionRequested === "function" && !permissionSubscribed) {
        permissionSubscribed = true;
        const candidatePermission = computerFacade.onPermissionRequested((value) => {
          try { enqueuePermission(value); } catch {}
        });
        permissionUnsubscribe = typeof candidatePermission === "function" ? candidatePermission : null;
      }
      const catalogFacade = catalogAuthorityManaged
        ? null
        : providerFacade ?? accountFacade;
      if (catalogFacade && typeof catalogFacade.onCatalogChanged === "function") {
        const candidateCatalog = catalogFacade.onCatalogChanged((value) => {
          applyCatalog(value, { legacyAccount: providerFacade === null });
        });
        if (disposed) {
          if (typeof candidateCatalog === "function") candidateCatalog();
          throw new Error("Bot controls are unavailable.");
        }
        catalogUnsubscribe = typeof candidateCatalog === "function" ? candidateCatalog : null;
      }
      if (catalogFacade && typeof catalogFacade.catalog === "function") {
        try {
          const catalog = await catalogFacade.catalog();
          if (disposed) throw new Error("Bot controls are unavailable.");
          applyCatalog(catalog, { refreshSelection: false, legacyAccount: providerFacade === null });
        } catch (error) {
          if (disposed) throw error;
          applyCatalog(null, { refreshSelection: false });
        }
      }
      const records = await facade.list();
      if (disposed) throw new Error("Bot controls are unavailable.");
      if (!Array.isArray(records)) throw new Error("Bot controls are unavailable.");
      for (const value of records) {
        const record = normalizeBot(value);
        bots.set(record.botId, record);
      }
      for (const [botId, value] of computerBacklog) {
        if (!bots.has(botId)) continue;
        applyComputer(value, { shouldPublish: false });
        computerBacklog.delete(botId);
      }
      refreshPermissionRequest();
      if (bots.size > 0) {
        const pending = computerFacade
          ? [...bots.values()].find((record) => record.setupStage !== "complete")
          : null;
        const preferred = preferredActiveBotId ?? authoritativeActiveBotId;
        const observedActive = preferred && bots.has(preferred) ? preferred : null;
        const fallback = nativeMode ? null : bots.keys().next().value;
        const initialBotId = pending?.botId ?? observedActive ?? fallback;
        if (!initialBotId) publish();
        else try { await selectBot(initialBotId); }
        catch (error) {
          if (disposed) throw error;
          publish();
        }
      }
      else publish();
      if (disposed) throw new Error("Bot controls are unavailable.");
      const candidate = facade.onChanged((value) => {
        try {
          applyBot(value);
        } catch {}
      });
      if (disposed) {
        if (typeof candidate === "function") candidate();
        throw new Error("Bot controls are unavailable.");
      }
      unsubscribe = typeof candidate === "function" ? candidate : null;
      initializationComplete = true;
      if (!nativeMode) subscribeRuntimeEvents();
      return snapshot();
    }

    async function createBot() {
      if (disposed || creationPending || mandatorySetupBotId !== null || computerSetup.open
        || (computerFacade && [...bots.values()].some((record) => record.setupStage !== "complete"))
        || typeof facade.create !== "function") {
        throw new Error("Bot creation is unavailable.");
      }
      creationPending = true;
      creationBotId = null;
      creationError = null;
      publish();
      try {
        const created = await facade.create();
        if (disposed) throw new Error("Bot creation is unavailable.");
        const record = normalizeBot(created);
        if (record.name !== "New Bot"
          || (computerFacade && record.setupStage !== "profile-model")) {
          throw new Error("Bot creation is unavailable.");
        }
        bots.set(record.botId, record);
        creationBotId = record.botId;
        await selectBot(record.botId);
        creationPending = false;
        creationBotId = null;
        creationError = null;
        publish();
        return record;
      } catch (error) {
        creationPending = false;
        creationBotId = null;
        if (!disposed) {
          creationError = "Could not finish creating New Bot. Try again.";
          publish();
        }
        throw error;
      }
    }

    function updateNewBotSetup(patch) {
      const allowed = new Set([
        "name", "description", "image", "shape", "color",
        "provider", "model", "reasoningEffort", "serviceTier",
      ]);
      if (disposed || !profileSetup.open || profileSetup.pending
        || profileSetupBotId !== activeBotId || mandatorySetupBotId !== activeBotId
        || !patch || typeof patch !== "object" || Array.isArray(patch)
        || Object.keys(patch).some((key) => !allowed.has(key))) {
        throw new Error("New Bot setup is unavailable.");
      }
      const next = { ...profileSetup, error: null };
      if (Object.hasOwn(patch, "name")) {
        if (typeof patch.name !== "string" || patch.name.length > 160 || patch.name.includes("\0")) {
          throw new Error("Bot name is unavailable.");
        }
        next.name = patch.name;
      }
      if (Object.hasOwn(patch, "description")) {
        if (typeof patch.description !== "string" || patch.description.length > MAX_DESCRIPTION_LENGTH
          || patch.description.includes("\0")) {
          throw new Error("Bot description is unavailable.");
        }
        next.description = patch.description;
      }
      if (Object.hasOwn(patch, "image")) next.image = normalizeLocalPngAvatar(patch.image);
      if (Object.hasOwn(patch, "shape")) {
        if (!BOT_SHAPE_IDS.has(patch.shape)) throw new Error("Bot shape is unavailable.");
        next.shape = patch.shape;
      }
      if (Object.hasOwn(patch, "color")) {
        if (!BOT_COLOR_IDS.has(patch.color)) throw new Error("Bot color is unavailable.");
        next.color = patch.color;
      }
      let descriptor = setupModelDescriptor(next.model, next.provider);
      if (Object.hasOwn(patch, "provider")) {
        if (typeof patch.provider !== "string") throw new Error("Model provider is unavailable.");
        descriptor = setupModelDescriptor(null, patch.provider);
        if (!descriptor) throw new Error("Model provider is unavailable.");
        Object.assign(next, setupSelectionFor(descriptor));
      }
      if (Object.hasOwn(patch, "model")) {
        descriptor = setupModelDescriptor(patch.model, next.provider);
        if (!descriptor || descriptor.model !== patch.model || descriptor.provider !== next.provider) {
          throw new Error("Model selection is unavailable.");
        }
        Object.assign(next, setupSelectionFor(descriptor));
      }
      descriptor = setupModelDescriptor(next.model, next.provider);
      if (!descriptor || descriptor.model !== next.model || descriptor.provider !== next.provider) {
        throw new Error("Model selection is unavailable.");
      }
      if (Object.hasOwn(patch, "reasoningEffort")) {
        if (!descriptor.efforts.includes(patch.reasoningEffort)) {
          throw new Error("Power selection is unavailable.");
        }
        next.reasoningEffort = patch.reasoningEffort;
      }
      if (Object.hasOwn(patch, "serviceTier")) {
        if (!(patch.serviceTier === null
          || descriptor.serviceTiers.some((entry) => entry.id === patch.serviceTier))) {
          throw new Error("Speed selection is unavailable.");
        }
        next.serviceTier = patch.serviceTier;
      }
      profileSetup = Object.freeze(next);
      profileSetupCatalogGeneration = catalogGeneration;
      publish();
      return snapshot();
    }

    function setupTransactionIsCurrent(botId, epoch, catalogMarker, descriptor, expectedStage = "profile-model") {
      const currentDescriptor = setupModelDescriptor(descriptor.model, descriptor.provider);
      return !disposed && activeBotId === botId && mandatorySetupBotId === botId
        && profileSetupBotId === botId && profileSetup.open
        && (expectedStage === null || bots.get(botId)?.setupStage === expectedStage)
        && selectionEpoch === epoch && catalogGeneration === catalogMarker
        && currentDescriptor?.model === descriptor.model
        && currentDescriptor.provider === descriptor.provider
        && currentDescriptor.catalogGeneration === descriptor.catalogGeneration;
    }

    async function confirmNewBotSetup() {
      const bot = activeBot();
      const draft = profileSetup;
      const name = draft.name.trim();
      const description = draft.description.trim();
      const descriptor = setupModelDescriptor(draft.model, draft.provider);
      if (disposed || !bot || !draft.open || draft.pending || profileSetupBotId !== bot.botId
        || mandatorySetupBotId !== bot.botId || bot.setupStage !== "profile-model"
        || name.length < 1 || name.length > 160
        || !descriptor || descriptor.model !== draft.model || descriptor.provider !== draft.provider
        || !descriptor.efforts.includes(draft.reasoningEffort)
        || !(draft.serviceTier === null
          || descriptor.serviceTiers.some((entry) => entry.id === draft.serviceTier))
        || typeof facade.rename !== "function" || typeof facade.updateProfile !== "function"
        || typeof facade.advanceSetup !== "function"
        || !runtimeFacade || typeof runtimeFacade.selectModel !== "function") {
        throw new Error("New Bot setup is unavailable.");
      }
      const botId = bot.botId;
      const epoch = selectionEpoch;
      const catalogMarker = profileSetupCatalogGeneration;
      profileSetup = Object.freeze({ ...draft, pending: true, error: null });
      publish();
      try {
        const renamedValue = await facade.rename(botId, name);
        if (!setupTransactionIsCurrent(botId, epoch, catalogMarker, descriptor)) {
          throw new Error("New Bot setup changed.");
        }
        const renamed = normalizeBot(renamedValue);
        if (renamed.botId !== botId || renamed.setupStage !== "profile-model") {
          throw new Error("New Bot setup changed.");
        }
        applyBot(renamedValue);

        const profileValue = await facade.updateProfile(botId, {
          appearance: {
            shape: draft.shape,
            color: draft.color,
            image: draft.image,
            description,
          },
        });
        if (!setupTransactionIsCurrent(botId, epoch, catalogMarker, descriptor)) {
          throw new Error("New Bot setup changed.");
        }
        const profiled = normalizeBot(profileValue);
        if (profiled.botId !== botId || profiled.setupStage !== "profile-model") {
          throw new Error("New Bot setup changed.");
        }
        applyBot(profileValue);

        const modelValue = await selectModel(
          draft.provider,
          draft.model,
          draft.reasoningEffort,
          draft.serviceTier,
        );
        if (!modelValue || typeof modelValue !== "object"
          || !setupTransactionIsCurrent(botId, epoch, catalogMarker, descriptor)
          || !modelSelection || modelSelection.provider !== draft.provider
          || modelSelection.model !== draft.model
          || modelSelection.reasoningEffort !== draft.reasoningEffort
          || modelSelection.serviceTier !== draft.serviceTier
          || modelSelection.catalogGeneration !== descriptor.catalogGeneration) {
          throw new Error("New Bot setup changed.");
        }
        const stageValue = await facade.advanceSetup({
          botId,
          expectedStage: "profile-model",
          nextStage: "computer",
        });
        const stageRecord = normalizeBot(stageValue);
        if (!setupTransactionIsCurrent(botId, epoch, catalogMarker, descriptor, null)
          || stageRecord.botId !== botId || stageRecord.setupStage !== "computer"
          || !["profile-model", "computer"].includes(bots.get(botId)?.setupStage)) {
          throw new Error("New Bot setup changed.");
        }
        applyBot(stageValue);
        if (disposed || selectionEpoch !== epoch || activeBotId !== botId
          || bots.get(botId)?.setupStage !== "computer") {
          throw new Error("New Bot setup changed.");
        }
        openMandatoryComputerSetup(botId);
        publish();
        return snapshot();
      } catch (error) {
        if (!disposed && activeBotId === botId && mandatorySetupBotId === botId
          && profileSetupBotId === botId && profileSetup.open) {
          profileSetup = Object.freeze({
            ...profileSetup,
            pending: false,
            error: "Could not finish setting up New Bot. Your choices are still here. Try again.",
          });
          synchronizeActiveSetupStage(bots.get(botId));
          publish();
        }
        throw error;
      }
    }

    function openComputerSetup() {
      if (disposed || !activeBot() || selectionPending || mandatorySetupBotId !== null
        || computerSetup.open || !computerFacade) {
        throw new Error("Computer setup is unavailable.");
      }
      computerSetup = Object.freeze({ open: true, pending: false, selectedMode: null, dismissible: true });
      computerSetupBotId = activeBotId;
      publish();
      return snapshot();
    }

    function dismissComputerSetup() {
      if (disposed || !computerSetup.open || computerSetup.pending || !computerSetup.dismissible) {
        throw new Error("Computer setup cannot be dismissed.");
      }
      computerSetup = Object.freeze({ open: false, pending: false, selectedMode: null, dismissible: false });
      computerSetupBotId = null;
      publish();
      return snapshot();
    }

    function chooseComputerMode(mode) {
      if (disposed || !computerSetup.open || computerSetup.pending || computerSetupBotId !== activeBotId
        || !COMPUTER_MODES.has(mode)) {
        throw new Error("Computer setup is unavailable.");
      }
      computerSetup = Object.freeze({ ...computerSetup, selectedMode: mode });
      publish();
      return snapshot();
    }

    async function confirmComputerMode() {
      const bot = activeBot();
      const mode = computerSetup.selectedMode;
      const mandatory = mandatorySetupBotId === bot?.botId;
      if (disposed || !bot || !computerSetup.open || computerSetup.pending || computerSetupBotId !== bot.botId
        || !COMPUTER_MODES.has(mode)
        || (mandatory && (bot.setupStage !== "computer" || typeof facade.advanceSetup !== "function"))
        || !computerFacade || typeof computerFacade.selectMode !== "function") {
        throw new Error("Computer setup is unavailable.");
      }
      const epoch = selectionEpoch;
      const computerMarker = computerIngress.get(bot.botId) ?? 0;
      computerSetup = Object.freeze({ ...computerSetup, pending: true });
      publish();
      try {
        const result = await computerFacade.selectMode({ botId: bot.botId, mode });
        if (disposed || epoch !== selectionEpoch || activeBotId !== bot.botId) {
          throw new Error("Computer setup changed.");
        }
        const normalizedResult = normalizeComputerEnvelope(result, bot.botId);
        const applied = applyComputer(normalizedResult, {
          shouldPublish: false,
          expectedIngress: computerMarker,
          expectedBotId: bot.botId,
        });
        if (!applied && !sameComputerIdentity(bots.get(bot.botId)?.computer, normalizedResult.computer)) {
          throw new Error("Computer setup changed.");
        }
        const permissionReadEpoch = beginPermissionRead(bot.botId);
        const nextPermissions = normalizePermissions(
          await computerFacade.listPermissions(bot.botId),
          bot.botId,
        );
        if (disposed || epoch !== selectionEpoch || activeBotId !== bot.botId) {
          throw new Error("Computer setup changed.");
        }
        const permissionTarget = computerPermissionTarget(normalizedResult.computer);
        const computerChanged = !sameComputerIdentity(bots.get(bot.botId)?.computer, normalizedResult.computer)
          || currentPermissionTarget(bot.botId) !== permissionTarget;
        if (computerChanged) throw new Error("Computer setup changed.");
        if (commitPermissionRead(bot.botId, permissionReadEpoch)) {
          permissions = permissionTarget === null ? Object.freeze([]) : nextPermissions;
        }
        if (mandatory) {
          const stageValue = await facade.advanceSetup({
            botId: bot.botId,
            expectedStage: "computer",
            nextStage: "complete",
          });
          const stageRecord = normalizeBot(stageValue);
          if (disposed || epoch !== selectionEpoch || activeBotId !== bot.botId
            || stageRecord.botId !== bot.botId || stageRecord.setupStage !== "complete"
            || !["computer", "complete"].includes(bots.get(bot.botId)?.setupStage)
            || !sameComputerIdentity(bots.get(bot.botId)?.computer, normalizedResult.computer)) {
            throw new Error("Computer setup changed.");
          }
          applyBot(stageValue);
          if (bots.get(bot.botId)?.setupStage !== "complete") {
            throw new Error("Computer setup changed.");
          }
        }
        computerSetup = Object.freeze({ open: false, pending: false, selectedMode: null, dismissible: false });
        computerSetupBotId = null;
        if (mandatorySetupBotId === bot.botId) mandatorySetupBotId = null;
        publish();
        return snapshot();
      } catch (error) {
        if (!disposed && epoch === selectionEpoch && activeBotId === bot.botId) {
          computerSetup = Object.freeze({ ...computerSetup, pending: false });
          synchronizeActiveSetupStage(bots.get(bot.botId));
          publish();
        }
        throw error;
      }
    }

    async function decideComputerPermission(decision) {
      const prompt = permissionRequest;
      const bot = activeBot();
      if (disposed || !prompt || !bot || prompt.botId !== bot.botId
        || permissionDecisionRequestId !== null
        || (decision === "always" && prompt.allowsAlways === false)
        || !PERMISSION_DECISIONS.has(decision) || !computerFacade
        || typeof computerFacade.decidePermission !== "function") {
        throw new Error("Computer permission is unavailable or changed.");
      }
      const permissionTarget = currentPermissionTarget(bot.botId);
      permissionDecisionRequestId = prompt.requestId;
      publish();
      let result;
      let failure = null;
      let decisionCommitted = false;
      try {
        result = await computerFacade.decidePermission({
          requestId: prompt.requestId,
          botId: prompt.botId,
          targetId: prompt.targetId,
          targetGeneration: prompt.targetGeneration,
          decision,
        });
        if (disposed || activeBotId !== prompt.botId) {
          throw new Error("Computer permission changed.");
        }
        const nextPermissions = normalizePermissions(result, prompt.botId);
        if (permissionTarget === null || currentPermissionTarget(bot.botId) !== permissionTarget) {
          throw new Error("Computer permission changed.");
        }
        commitPermissionRead(bot.botId, beginPermissionRead(bot.botId));
        permissions = nextPermissions;
        decisionCommitted = true;
      } catch (error) {
        failure = error;
      } finally {
        if (!disposed) {
          if (decisionCommitted) permissionQueue.delete(prompt.requestId);
          if (computerFacade && typeof computerFacade.listPermissionRequests === "function") {
            const marker = permissionIngress;
            try {
              const pending = await computerFacade.listPermissionRequests(prompt.botId);
              if (!disposed) {
                reconcilePermissionRequests(prompt.botId, pending, marker, { shouldPublish: false });
              }
            } catch {}
          }
          if (!disposed) {
            if (permissionDecisionRequestId === prompt.requestId) permissionDecisionRequestId = null;
            refreshPermissionRequest();
            publish();
          }
        }
      }
      if (failure) throw failure;
      if (disposed || activeBotId !== prompt.botId
        || currentPermissionTarget(prompt.botId) !== permissionTarget) {
        throw new Error("Computer permission changed.");
      }
      return snapshot();
    }

    async function revokeComputerPermission(grantId) {
      const bot = activeBot();
      if (disposed || !bot || typeof grantId !== "string" || !computerFacade
        || typeof computerFacade.revokePermission !== "function") {
        throw new Error("Computer permission is unavailable.");
      }
      const permissionTarget = currentPermissionTarget(bot.botId);
      const result = await computerFacade.revokePermission({ botId: bot.botId, grantId });
      if (disposed || activeBotId !== bot.botId || permissionTarget === null
        || currentPermissionTarget(bot.botId) !== permissionTarget) {
        throw new Error("Computer permission changed.");
      }
      const nextPermissions = normalizePermissions(result, bot.botId);
      commitPermissionRead(bot.botId, beginPermissionRead(bot.botId));
      permissions = nextPermissions;
      publish();
      return snapshot();
    }

    async function connectProvider(request) {
      const rawProvider = typeof request === "string" ? request : request?.providerId;
      const provider = rawProvider === "codex" ? "openai-codex"
        : rawProvider === "claude" ? "anthropic-claude"
          : rawProvider === "kimi" ? "moonshot-kimi" : rawProvider;
      if (disposed || typeof provider !== "string" || !PROVIDER_IDS.includes(provider)) {
        throw new Error("Provider connection is unavailable.");
      }
      if (!providerFacade && !new Set(["openai-codex", "anthropic-claude", "moonshot-kimi"]).has(provider)) {
        throw new Error("Provider connection is unavailable.");
      }
      if (providerFacade && typeof providerFacade.connect === "function") {
        return providerFacade.connect(request && typeof request === "object"
          ? request
          : { providerId: provider });
      }
      if (provider === "openai-codex") {
        if (!accountFacade || typeof accountFacade.login !== "function") {
          throw new Error("Provider connection is unavailable.");
        }
        return accountFacade.login("browser");
      }
      const legacyProvider = provider === "anthropic-claude" ? "claude"
        : provider === "moonshot-kimi" ? "kimi" : provider;
      if (runtimeFacade == null || typeof runtimeFacade.connectProvider !== "function") {
        throw new Error("Provider connection is unavailable.");
      }
      return runtimeFacade.connectProvider(legacyProvider);
    }

    async function renameActive(name) {
      const bot = activeBot();
      const nextName = typeof name === "string" ? name.trim() : "";
      if (
        disposed ||
        !bot ||
        typeof facade.rename !== "function" ||
        nextName.length < 1 ||
        nextName.length > 160
      ) {
        throw new Error("Bot rename is unavailable.");
      }
      return applyBot(await facade.rename(bot.botId, nextName));
    }

    async function retryActive() {
      const bot = activeBot();
      if (
        disposed ||
        !bot ||
        !runtimePresentation(bot.runtime.state).retryVisible ||
        typeof facade.retryRuntime !== "function"
      ) {
        throw new Error("Remote computer retry is unavailable.");
      }
      return applyBot(await facade.retryRuntime(bot.botId));
    }

    async function selectModel(provider, model, reasoningEffort, requestedServiceTier) {
      const bot = activeBot();
      const catalog = modelCatalog.find((entry) => entry.provider === provider
        && entry.model === model);
      const serviceTier = requestedServiceTier === undefined
        ? catalog?.defaultServiceTier ?? null
        : requestedServiceTier;
      if (
        disposed ||
        !bot ||
        !catalog ||
        !catalog.efforts.includes(reasoningEffort) ||
        !(serviceTier === null
          || catalog.serviceTiers.some((entry) => entry.id
            === serviceTier)) ||
        runtimeFacade == null ||
        typeof runtimeFacade.selectModel !== "function"
      ) {
        throw new Error("Model selection is unavailable.");
      }
      const epoch = selectionEpoch;
      const requestEpoch = ++modelRequestEpoch;
      const selection = Object.freeze({
        botId: bot.botId,
        provider,
        model,
        reasoningEffort,
        serviceTier,
      });
      const result = await runtimeFacade.selectModel(selection);
      if (disposed || epoch !== selectionEpoch || requestEpoch !== modelRequestEpoch
        || activeBotId !== bot.botId) {
        throw new Error("Model selection changed.");
      }
      if (result && typeof result === "object") {
        modelSelection = normalizeModelSelection(result, bot.botId, modelCatalog);
        publish();
      }
      return result;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (unsubscribe) unsubscribe();
      if (runtimeUnsubscribe) runtimeUnsubscribe();
      if (catalogUnsubscribe) catalogUnsubscribe();
      if (computerUnsubscribe) computerUnsubscribe();
      if (permissionUnsubscribe) permissionUnsubscribe();
      unsubscribe = null;
      runtimeUnsubscribe = null;
      catalogUnsubscribe = null;
      computerUnsubscribe = null;
      permissionUnsubscribe = null;
      bots.clear();
      activeBotId = null;
      modelSelection = null;
      selectionPending = false;
      creationPending = false;
      creationBotId = null;
      mandatorySetupBotId = null;
      profileSetup = closedProfileSetup();
      profileSetupBotId = null;
      profileSetupCatalogGeneration = -1;
      permissionRequest = null;
      permissionQueue.clear();
      permissionRefreshes.clear();
      permissionRefreshDirty.clear();
      permissionReadEpochs.clear();
      permissionCommitEpochs.clear();
      computerBacklog.clear();
      computerIngress.clear();
      permissionDecisionRequestId = null;
      permissions = Object.freeze([]);
      computerSetup = Object.freeze({ open: false, pending: false, selectedMode: null, dismissible: false });
      computerSetupBotId = null;
    }

    return Object.freeze({
      applyBot,
      applyCatalog,
      chooseComputerMode,
      confirmComputerMode,
      confirmNewBotSetup,
      connectProvider,
      createBot,
      decideComputerPermission,
      dismissComputerSetup,
      dispose,
      initialize,
      openComputerSetup,
      renameActive,
      retryActive,
      revokeComputerPermission,
      selectBot,
      selectModel,
      snapshot,
      updateNewBotSetup,
    });
  }

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const ULTRA_VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vUv;

  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;
  const ULTRA_FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform vec2 uResolution;

  const vec3 COLOR_1 = vec3(0.592, 0.388, 0.945);
  const vec3 COLOR_2 = vec3(0.831, 0.710, 0.953);
  const vec3 COLOR_3 = vec3(0.286, 0.000, 0.404);
  const vec3 COLOR_4 = vec3(0.145, 0.055, 0.478);
  const vec3 COLOR_5 = vec3(0.592, 0.000, 0.996);
  const vec3 COLOR_6 = vec3(0.780, 0.459, 0.914);
  const vec3 COLOR_7 = vec3(0.725, 0.576, 1.000);
  const vec3 COLOR_8 = vec3(0.400, 0.212, 0.820);
  const vec3 COLOR_9 = vec3(0.882, 0.690, 1.000);
  const vec3 COLOR_10 = vec3(0.498, 0.345, 0.957);
  const vec3 COLOR_11 = vec3(0.659, 0.275, 0.910);
  const vec3 COLOR_12 = vec3(0.212, 0.063, 0.400);

  float grain(vec2 uv) {
    vec2 grainUv = uv * uResolution * 0.5;
    return fract(sin(dot(grainUv + uTime, vec2(12.9898, 78.233))) * 43758.5453) * 2.0 - 1.0;
  }

  float fieldWeight(vec2 point, vec2 center) {
    return exp(-dot(point - center, point - center) * 12.0);
  }

  vec3 fieldColor(vec2 rawUv) {
    const float speed = 1.25;
    vec2 uv = vec2(rawUv.x, 0.40 + rawUv.y * 0.18);
    vec2 spatialScale = vec2(1.55, 1.0);
    vec2 point = uv * spatialScale;
    vec2 center1 = vec2(0.18 + sin(uTime * speed * 0.42) * 0.18, 0.36 + cos(uTime * speed * 0.50) * 0.42) * spatialScale;
    vec2 center2 = vec2(0.34 + cos(uTime * speed * 0.62) * 0.24, 0.62 + sin(uTime * speed * 0.47) * 0.38) * spatialScale;
    vec2 center3 = vec2(0.52 + sin(uTime * speed * 0.38) * 0.28, 0.30 + cos(uTime * speed * 0.58) * 0.36) * spatialScale;
    vec2 center4 = vec2(0.70 + cos(uTime * speed * 0.54) * 0.24, 0.68 + sin(uTime * speed * 0.41) * 0.36) * spatialScale;
    vec2 center5 = vec2(0.88 + sin(uTime * speed * 0.74) * 0.16, 0.36 + cos(uTime * speed * 0.64) * 0.40) * spatialScale;
    vec2 center6 = vec2(0.12 + cos(uTime * speed * 0.48) * 0.20, 0.72 + sin(uTime * speed * 0.70) * 0.30) * spatialScale;
    vec2 center7 = vec2(0.30 + sin(uTime * speed * 0.58) * 0.22, 0.44 + cos(uTime * speed * 0.52) * 0.42) * spatialScale;
    vec2 center8 = vec2(0.46 + cos(uTime * speed * 0.68) * 0.26, 0.72 + sin(uTime * speed * 0.56) * 0.32) * spatialScale;
    vec2 center9 = vec2(0.60 + sin(uTime * speed * 0.44) * 0.28, 0.26 + cos(uTime * speed * 0.60) * 0.38) * spatialScale;
    vec2 center10 = vec2(0.76 + cos(uTime * speed * 0.50) * 0.22, 0.54 + sin(uTime * speed * 0.66) * 0.40) * spatialScale;
    vec2 center11 = vec2(0.92 + sin(uTime * speed * 0.70) * 0.15, 0.66 + cos(uTime * speed * 0.46) * 0.30) * spatialScale;
    vec2 center12 = vec2(0.06 + cos(uTime * speed * 0.40) * 0.14, 0.32 + sin(uTime * speed * 0.60) * 0.40) * spatialScale;
    float weight1 = fieldWeight(point, center1) * (0.7 + 0.3 * sin(uTime * 0.91));
    float weight2 = fieldWeight(point, center2) * (0.7 + 0.3 * cos(uTime * 1.07));
    float weight3 = fieldWeight(point, center3) * (0.7 + 0.3 * sin(uTime * 0.76));
    float weight4 = fieldWeight(point, center4) * (0.7 + 0.3 * cos(uTime * 1.18));
    float weight5 = fieldWeight(point, center5) * (0.7 + 0.3 * sin(uTime * 1.03));
    float weight6 = fieldWeight(point, center6) * (0.7 + 0.3 * cos(uTime * 0.83));
    float weight7 = fieldWeight(point, center7) * (0.7 + 0.3 * sin(uTime * 1.24));
    float weight8 = fieldWeight(point, center8) * (0.7 + 0.3 * cos(uTime * 0.96));
    float weight9 = fieldWeight(point, center9) * (0.7 + 0.3 * sin(uTime * 1.11));
    float weight10 = fieldWeight(point, center10) * (0.7 + 0.3 * cos(uTime * 0.72));
    float weight11 = fieldWeight(point, center11) * (0.7 + 0.3 * sin(uTime * 1.29));
    float weight12 = fieldWeight(point, center12) * (0.7 + 0.3 * cos(uTime * 0.88));
    float totalWeight = max(
      weight1 + weight2 + weight3 + weight4 + weight5 + weight6 +
        weight7 + weight8 + weight9 + weight10 + weight11 + weight12,
      0.0001
    );
    vec3 color = (
      COLOR_1 * weight1 + COLOR_2 * weight2 + COLOR_3 * weight3 +
      COLOR_4 * weight4 + COLOR_5 * weight5 + COLOR_6 * weight6 +
      COLOR_7 * weight7 + COLOR_8 * weight8 + COLOR_9 * weight9 +
      COLOR_10 * weight10 + COLOR_11 * weight11 + COLOR_12 * weight12
    ) / totalWeight;
    color = mix(COLOR_4, color, 0.96);

    return pow(clamp(color, vec3(0.0), vec3(1.0)), vec3(0.9));
  }

  void main() {
    vec3 color = fieldColor(vUv);
    color += grain(vUv) * 0.012;
    color.r += sin(uTime * 0.5) * 0.02;
    color.g += cos(uTime * 0.7) * 0.02;
    color.b += sin(uTime * 0.6) * 0.02;
    color = pow(color, vec3(0.92));

    gl_FragColor = vec4(color, 1.0);
  }
`;
  const ULTRA_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

  function compileUltraShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (shader == null) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader);
    return null;
  }

  function createUltraProgram(gl) {
    const vertex = compileUltraShader(gl, gl.VERTEX_SHADER, ULTRA_VERTEX_SHADER);
    const fragment = compileUltraShader(gl, gl.FRAGMENT_SHADER, ULTRA_FRAGMENT_SHADER);
    if (vertex == null || fragment == null) {
      if (vertex != null) gl.deleteShader(vertex);
      if (fragment != null) gl.deleteShader(fragment);
      return null;
    }
    const program = gl.createProgram();
    if (program == null) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      return null;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
    gl.deleteProgram(program);
    return null;
  }

  function startUltraCanvas(canvas, {
    shouldReduceMotion = false,
    windowRef = typeof window === "object" ? window : null,
  } = {}) {
    const ResizeObserverClass = windowRef?.ResizeObserver;
    if (!windowRef?.WebGLRenderingContext || typeof ResizeObserverClass !== "function"
      || typeof canvas?.getContext !== "function") return () => {};
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    if (gl == null) return () => {};
    const program = createUltraProgram(gl);
    if (program == null) return () => {};
    const buffer = gl.createBuffer();
    if (buffer == null) {
      gl.deleteProgram(program);
      return () => {};
    }
    const position = gl.getAttribLocation(program, "aPosition");
    const resolution = gl.getUniformLocation(program, "uResolution");
    const time = gl.getUniformLocation(program, "uTime");
    const performanceRef = windowRef.performance ?? globalThis.performance;
    const startedAt = performanceRef.now();
    let animationFrame = 0;
    let disposed = false;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, ULTRA_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const draw = (elapsed) => {
      gl.uniform1f(time, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    const resize = () => {
      const ratio = Math.min(windowRef.devicePixelRatio, 2);
      const { height, width } = canvas.getBoundingClientRect();
      const cssWidth = Math.max(Math.round(width), 1);
      const cssHeight = Math.max(Math.round(height), 1);
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolution, cssWidth, cssHeight);
      draw(shouldReduceMotion ? 0 : (performanceRef.now() - startedAt) / 1_000);
    };
    const render = (timestamp) => {
      animationFrame = 0;
      draw((timestamp - startedAt) / 1_000);
      animationFrame = windowRef.requestAnimationFrame(render);
    };
    const resizeObserver = new ResizeObserverClass(resize);
    resize();
    resizeObserver.observe(canvas);
    if (!shouldReduceMotion) animationFrame = windowRef.requestAnimationFrame(render);
    return () => {
      if (disposed) return;
      disposed = true;
      if (animationFrame !== 0) windowRef.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }

  function seededUltraRandom(index, salt) {
    const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return value - Math.floor(value);
  }

  function ultraParticleMotion(random) {
    const horizontal = random();
    const vertical = random();
    return Object.freeze({
      durationScale: 0.8 + random() * 1.2,
      horizontalOffset: Math.round((horizontal - 0.5) * 8),
      y: Math.round(12 + (vertical - 0.5) * 14),
    });
  }

  function initialUltraParticleMotion(index) {
    let salt = 1;
    return ultraParticleMotion(() => seededUltraRandom(index, salt++));
  }

  function styleUltraParticle(particle, index, motion) {
    const position = Math.round(4 + seededUltraRandom(index, 14) * 92);
    const opacity = 0.4 + seededUltraRandom(index, 11) * 0.6;
    const scale = 0.5 + seededUltraRandom(index, 12) * 0.45;
    particle.style.left = `calc(${position}% + ${motion.horizontalOffset}px)`;
    particle.style.opacity = opacity;
    particle.style.top = `${motion.y}px`;
    particle.style.transform = `translate(-50%, -50%) scale(${scale})`;
    particle.style.transitionDuration = `${1.6 * motion.durationScale}s`;
  }

  function createUltraParticleController(container, {
    random = Math.random,
    windowRef = typeof window === "object" ? window : null,
  } = {}) {
    const particles = Array.from(container?.children ?? []);
    const animationFrames = Array(particles.length).fill(0);
    const timeouts = Array(particles.length).fill(0);
    let active = false;
    let disposed = false;
    for (const [index, particle] of particles.entries()) {
      particle.style.setProperty?.("--particle-delay", `${index * 34}ms`);
      styleUltraParticle(particle, index, initialUltraParticleMotion(index));
    }
    const stop = () => {
      for (let index = 0; index < particles.length; index += 1) {
        if (animationFrames[index] !== 0) {
          windowRef?.cancelAnimationFrame?.(animationFrames[index]);
          animationFrames[index] = 0;
        }
        if (timeouts[index] !== 0) {
          windowRef?.clearTimeout?.(timeouts[index]);
          timeouts[index] = 0;
        }
      }
    };
    const start = () => {
      if (typeof windowRef?.requestAnimationFrame !== "function"
        || typeof windowRef?.setTimeout !== "function") return;
      for (const [index, particle] of particles.entries()) {
        const cycle = () => {
          if (!active || disposed) return;
          const motion = ultraParticleMotion(random);
          styleUltraParticle(particle, index, motion);
          timeouts[index] = windowRef.setTimeout(() => {
            timeouts[index] = 0;
            cycle();
          }, 1.6 * motion.durationScale * 1_000);
        };
        animationFrames[index] = windowRef.requestAnimationFrame(() => {
          animationFrames[index] = 0;
          cycle();
        });
      }
    };
    return Object.freeze({
      setActive(nextActive) {
        if (disposed || active === Boolean(nextActive)) return;
        active = Boolean(nextActive);
        stop();
        if (active) start();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        active = false;
        stop();
      },
    });
  }

  function createUltraEffects(canvas, particles, {
    random = Math.random,
    windowRef = typeof window === "object" ? window : null,
  } = {}) {
    const motionQuery = windowRef?.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    const particleController = createUltraParticleController(particles, { random, windowRef });
    let active = false;
    let reducedMotion = motionQuery?.matches === true;
    let canvasCleanup = null;
    let disposed = false;
    const stopCanvas = () => {
      canvasCleanup?.();
      canvasCleanup = null;
    };
    const startCanvas = () => {
      stopCanvas();
      if (active) canvasCleanup = startUltraCanvas(canvas, {
        shouldReduceMotion: reducedMotion,
        windowRef,
      });
    };
    const onMotionChange = (event) => {
      const nextReducedMotion = event?.matches === true;
      if (disposed || nextReducedMotion === reducedMotion) return;
      reducedMotion = nextReducedMotion;
      particleController.setActive(active && !reducedMotion);
      startCanvas();
    };
    motionQuery?.addEventListener?.("change", onMotionChange);
    if (!motionQuery?.addEventListener) motionQuery?.addListener?.(onMotionChange);
    return Object.freeze({
      setActive(nextActive) {
        if (disposed || active === Boolean(nextActive)) return;
        active = Boolean(nextActive);
        particleController.setActive(active && !reducedMotion);
        startCanvas();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        stopCanvas();
        particleController.dispose();
        motionQuery?.removeEventListener?.("change", onMotionChange);
        if (!motionQuery?.removeEventListener) motionQuery?.removeListener?.(onMotionChange);
      },
    });
  }

  function findUiMounts(documentRef) {
    if (!documentRef || typeof documentRef.querySelector !== "function") {
      return Object.freeze({
        sidebarHost: null,
        composerHost: null,
        nativeComposerHost: null,
        nativeBotSettingsHost: null,
        nativeConnectionsHost: null,
      });
    }
    const sidebarSelectors = [
      "[data-codex-bot-sidebar-host]",
      'aside[aria-label="Bots"]',
      '[data-testid*="sidebar" i]',
      '[aria-label*="sidebar" i]',
      "nav[aria-label]",
      "aside[aria-label]",
      "nav",
      "aside",
    ];
    let sidebarHost = null;
    for (const selector of sidebarSelectors) {
      const candidate = documentRef.querySelector(selector);
      if (candidate && candidate.id !== "codex-bot-controls") {
        sidebarHost = candidate;
        break;
      }
    }

    let composerHost = documentRef.querySelector("[data-codex-bot-composer-host]");
    if (!composerHost && typeof documentRef.querySelectorAll === "function") {
      const inputs = documentRef.querySelectorAll(
        'textarea,[contenteditable="true"],input[placeholder]',
      );
      for (const input of inputs) {
        const placeholder = input?.getAttribute?.("placeholder") || input?.placeholder || "";
        const label = input?.getAttribute?.("aria-label") || "";
        if (!/ask anything|drop a file|message|prompt/i.test(`${placeholder} ${label}`)) continue;
        composerHost = input.closest?.(
          '[data-testid*="composer" i],form,[role="form"],[class*="composer" i]',
        ) || input.parentElement || null;
        if (composerHost) break;
      }
    }
    const nativeComposerHost = documentRef.querySelector("[data-openbot-model-picker-host]");
    const nativeBotSettingsHost = documentRef.querySelector("[data-openbot-bot-settings-host]");
    const nativeConnectionsHost = documentRef.querySelector("[data-openbot-connections-host]");
    return Object.freeze({
      sidebarHost,
      composerHost,
      nativeComposerHost,
      nativeBotSettingsHost,
      nativeConnectionsHost,
    });
  }

  function createReasoningView(documentRef, {
    random = Math.random,
    windowRef = documentRef?.defaultView ?? (typeof window === "object" ? window : null),
  } = {}) {
    if (!documentRef || typeof documentRef.createElement !== "function") {
      throw new Error("Power control is unavailable.");
    }
    const control = element(documentRef, "div", "codex-power-control");
    const endpoints = element(documentRef, "div", "codex-power-endpoints");
    const firstLabel = element(documentRef, "span", "codex-power-endpoint is-first");
    const lastLabel = element(documentRef, "span", "codex-power-endpoint is-last");
    endpoints.append(firstLabel, lastLabel);
    endpoints.hidden = true;
    const track = element(documentRef, "div", "codex-power-track");
    track.setAttribute("aria-hidden", "true");
    const fill = element(documentRef, "div", "codex-power-fill");
    const ultraFill = element(documentRef, "div", "codex-power-ultra-field");
    const ultraMask = element(documentRef, "span", "codex-power-ultra-mask");
    const ultraCanvas = element(documentRef, "canvas", "codex-power-ultra-canvas");
    ultraMask.append(ultraCanvas);
    ultraFill.append(ultraMask);
    const particles = element(documentRef, "div", "codex-power-particles");
    for (let index = 0; index < 14; index += 1) {
      particles.append(element(documentRef, "span", "codex-power-particle"));
    }
    const ticks = element(documentRef, "div", "codex-power-ticks");
    track.append(fill, ultraFill, particles, ticks);
    const thumbRail = element(documentRef, "div", "codex-power-thumb-rail");
    thumbRail.setAttribute("aria-hidden", "true");
    const thumb = element(documentRef, "i", "codex-power-thumb");
    const burst = element(documentRef, "span", "codex-power-burst");
    for (let index = 0; index < 16; index += 1) burst.append(element(documentRef, "i"));
    thumbRail.append(thumb, burst);
    const input = element(documentRef, "input", "codex-power-input");
    input.type = "range";
    input.min = "0";
    input.step = "1";
    input.value = "1";
    input.setAttribute("aria-label", "Power");
    input.setAttribute("aria-describedby", "codex-power-instructions");
    const label = element(documentRef, "output", "codex-power-label", "Standard");
    label.setAttribute("aria-live", "polite");
    const instructions = element(
      documentRef,
      "span",
      "codex-power-instructions",
      "Use arrow keys, Home, End, or the scroll wheel to change Power.",
    );
    instructions.id = "codex-power-instructions";
    const warning = element(
      documentRef,
      "div",
      "codex-power-warning",
      "Consumes usage limits faster",
    );
    warning.setAttribute("role", "status");
    warning.setAttribute("aria-live", "polite");
    warning.hidden = true;
    control.append(endpoints, track, thumbRail, input);
    const ultraEffects = createUltraEffects(ultraCanvas, particles, { random, windowRef });
    return Object.freeze({
      burst,
      control,
      dispose() { ultraEffects.dispose(); },
      endpoints,
      fill,
      firstLabel,
      input,
      instructions,
      label,
      lastLabel,
      particles,
      thumb,
      ticks,
      track,
      ultraCanvas,
      ultraEffects,
      ultraFill,
      ultraMask,
      warning,
    });
  }

  function reasoningCenter(index, count) {
    const percent = count <= 1 ? 50 : (index / (count - 1)) * 100;
    const offset = Math.round((13 - (percent / 50) * 13) * 10) / 10;
    return `calc(${percent}% + ${offset}px)`;
  }

  function updateReasoningView(view, stops, selectedIndex, {
    enteredUltra = false,
    endpointLabelsVisible = false,
  } = {}) {
    if (!view?.control || !view?.ticks || !view?.input) {
      throw new Error("Power control is unavailable.");
    }
    const options = Array.isArray(stops) ? stops.filter((stop) => stop && typeof stop === "object"
      && typeof stop.label === "string") : [];
    if (options.length < 1) throw new Error("Power options are unavailable.");
    const index = Math.max(0, Math.min(options.length - 1, Math.round(Number(selectedIndex) || 0)));
    const tickNodes = options.map((_stop, tickIndex) => {
      const tick = element(view.input.ownerDocument || {
        createElement: (tag) => view.input.constructor ? new view.input.constructor(tag) : null,
      }, "i", "codex-power-tick");
      tick.classList.toggle("is-selected", tickIndex === index);
      tick.style.left = reasoningCenter(tickIndex, options.length);
      return tick;
    });
    view.ticks.replaceChildren(...tickNodes);
    const position = reasoningCenter(index, options.length);
    view.control.style.setProperty("--codex-power-thumb-position", position);
    view.control.style.setProperty("--codex-power-fill-position", position);
    view.input.max = String(options.length - 1);
    view.input.value = String(index);
    const stop = options[index];
    view.input.setAttribute("aria-valuetext", stop.label);
    view.label.textContent = stop.label;
    view.firstLabel.textContent = options[0].label;
    view.lastLabel.textContent = options.at(-1).label;
    view.endpoints.hidden = !endpointLabelsVisible;
    view.control.classList.toggle("is-fast", stop.effect === "fast");
    view.control.classList.toggle("is-max", stop.effect === "max");
    view.control.classList.toggle("is-ultra", stop.effect === "ultra");
    view.control.classList.toggle("is-ultra-code", stop.effort === "ultra-code");
    view.control.classList.toggle("is-ultra-entering", stop.effect === "ultra" && enteredUltra);
    view.warning.hidden = stop.effect !== "ultra" || !enteredUltra;
    view.ultraEffects?.setActive(stop.effect === "ultra");
    return Object.freeze({ stop, index });
  }

  function mount({ windowRef = window, documentRef = document } = {}) {
    if (!documentRef?.body || documentRef.getElementById("codex-bot-controls")) return null;
    const facade = windowRef.codexBots;
    if (!facade || !MODEL_CONTROLS || typeof POWER_CONTROL?.PowerControlState !== "function") return null;
    const nativeProtocolMode = windowRef.openbotProtocol?.schemaVersion === 1
      && windowRef.openbotProtocol?.mode === "local-protocol";
    const panel = element(documentRef, "aside", "codex-bot-controls");
    panel.id = "codex-bot-controls";
    panel.dataset.codexMountState = "pending";
    panel.setAttribute("aria-label", "OpenBot and remote computer controls");
    const header = element(documentRef, "div", "codex-bot-header");
    const botSelect = element(documentRef, "select", "codex-bot-select");
    botSelect.setAttribute("aria-label", "Active bot");
    const newButton = element(documentRef, "button", "codex-bot-new", "New Bot");
    newButton.type = "button";
    header.append(botSelect, newButton);
    const creationAlert = element(documentRef, "p", "codex-bot-create-error");
    creationAlert.setAttribute("role", "alert");
    creationAlert.setAttribute("aria-live", "assertive");
    creationAlert.hidden = true;
    const renameRow = element(documentRef, "div", "codex-bot-rename-row");
    const rename = element(documentRef, "input", "codex-bot-rename");
    rename.maxLength = 160;
    rename.setAttribute("aria-label", "Bot name");
    const renameButton = element(documentRef, "button", "codex-bot-rename-action", "Rename");
    renameButton.type = "button";
    renameRow.append(rename, renameButton);
    const statusRow = element(documentRef, "div", "codex-runtime-row");
    const status = element(documentRef, "span", "codex-runtime-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const retry = element(documentRef, "button", "codex-runtime-retry", "Retry");
    retry.type = "button";
    statusRow.append(status, retry);
    const computerRow = element(documentRef, "div", "codex-computer-row");
    const computerStatus = element(documentRef, "span", "codex-computer-status", "Computer not configured");
    computerStatus.setAttribute("role", "status");
    computerStatus.setAttribute("aria-live", "polite");
    const computerChange = element(documentRef, "button", "codex-computer-change", "Change");
    computerChange.type = "button";
    computerRow.append(computerStatus, computerChange);
    const computerGrants = element(documentRef, "section", "codex-computer-grants");
    computerGrants.setAttribute("aria-labelledby", "codex-computer-grants-title");
    computerGrants.hidden = true;
    const computerGrantsTitle = element(
      documentRef,
      "h3",
      "codex-computer-grants-title",
      "Always allowed for this bot",
    );
    computerGrantsTitle.id = "codex-computer-grants-title";
    const computerGrantsList = element(documentRef, "div", "codex-computer-grants-list");
    computerGrants.append(computerGrantsTitle, computerGrantsList);
    const newBotSetup = element(documentRef, "dialog", "codex-new-bot-setup");
    newBotSetup.setAttribute("role", "dialog");
    newBotSetup.setAttribute("aria-modal", "true");
    newBotSetup.setAttribute("aria-labelledby", "codex-new-bot-setup-title");
    newBotSetup.setAttribute("aria-describedby", "codex-new-bot-setup-copy");
    newBotSetup.hidden = true;
    const newBotSetupTitle = element(documentRef, "h2", "codex-new-bot-setup-title", "Set up New Bot");
    newBotSetupTitle.id = "codex-new-bot-setup-title";
    const newBotSetupCopy = element(
      documentRef,
      "p",
      "codex-new-bot-setup-copy",
      "Choose this bot’s profile and model before its Computer.",
    );
    newBotSetupCopy.id = "codex-new-bot-setup-copy";
    const newBotSetupFields = element(documentRef, "div", "codex-new-bot-fields");
    const labeledSetupField = (labelText, control, { optional = false } = {}) => {
      const label = element(documentRef, "label", "codex-new-bot-field");
      const heading = element(documentRef, "span", "codex-new-bot-field-label", labelText);
      if (optional) heading.append(element(documentRef, "span", "codex-new-bot-optional", "(Optional)"));
      label.append(heading, control);
      return label;
    };
    const newBotPhoto = element(documentRef, "input", "codex-new-bot-photo");
    newBotPhoto.type = "file";
    newBotPhoto.accept = "image/png";
    newBotPhoto.setAttribute("aria-label", "Add a Bot photo");
    newBotPhoto.hidden = true;
    const newBotPhotoPick = element(documentRef, "button", "codex-new-bot-photo-pick", "Add a Bot photo");
    newBotPhotoPick.type = "button";
    const newBotPhotoPreview = element(documentRef, "img", "codex-new-bot-photo-preview");
    newBotPhotoPreview.alt = "";
    newBotPhotoPreview.hidden = true;
    const newBotPhotoRemove = element(documentRef, "button", "codex-new-bot-photo-remove", "Remove Bot photo");
    newBotPhotoRemove.type = "button";
    newBotPhotoRemove.hidden = true;
    const newBotPhotoRow = element(documentRef, "div", "codex-new-bot-photo-row");
    newBotPhotoRow.append(newBotPhoto, newBotPhotoPick, newBotPhotoPreview, newBotPhotoRemove);
    const newBotPhotoField = element(documentRef, "div", "codex-new-bot-field");
    const newBotPhotoLabel = element(documentRef, "span", "codex-new-bot-field-label", "Bot photo");
    newBotPhotoLabel.append(element(documentRef, "span", "codex-new-bot-optional", "(Optional)"));
    newBotPhotoField.append(newBotPhotoLabel, newBotPhotoRow);
    const newBotName = element(documentRef, "input", "codex-new-bot-name");
    newBotName.type = "text";
    newBotName.required = true;
    newBotName.maxLength = 160;
    newBotName.placeholder = "Name your Bot";
    newBotName.setAttribute("aria-label", "Name");
    newBotName.setAttribute("aria-required", "true");
    const newBotDescription = element(documentRef, "textarea", "codex-new-bot-description");
    newBotDescription.maxLength = MAX_DESCRIPTION_LENGTH;
    newBotDescription.rows = 3;
    newBotDescription.placeholder = "What should this Bot help with?";
    newBotDescription.setAttribute("aria-label", "Description");
    const newBotShape = element(documentRef, "select", "codex-new-bot-shape");
    newBotShape.setAttribute("aria-label", "Character shape");
    for (const value of BOT_SHAPES) {
      const option = element(documentRef, "option", "", `${value[0].toUpperCase()}${value.slice(1)}`);
      option.value = value;
      newBotShape.append(option);
    }
    const newBotColor = element(documentRef, "select", "codex-new-bot-color");
    newBotColor.setAttribute("aria-label", "Character color");
    for (const value of BOT_COLORS) {
      const option = element(documentRef, "option", "", `${value[0].toUpperCase()}${value.slice(1)}`);
      option.value = value;
      newBotColor.append(option);
    }
    const newBotProvider = element(documentRef, "select", "codex-new-bot-provider");
    newBotProvider.setAttribute("aria-label", "Inference provider");
    const newBotModel = element(documentRef, "select", "codex-new-bot-model");
    newBotModel.setAttribute("aria-label", "Model");
    const newBotPower = element(documentRef, "select", "codex-new-bot-power");
    newBotPower.setAttribute("aria-label", "Power");
    const newBotSpeed = element(documentRef, "select", "codex-new-bot-speed");
    newBotSpeed.setAttribute("aria-label", "Speed");
    newBotSetupFields.append(
      newBotPhotoField,
      labeledSetupField("Name", newBotName),
      labeledSetupField("Description", newBotDescription, { optional: true }),
      labeledSetupField("Character shape", newBotShape),
      labeledSetupField("Character color", newBotColor),
      labeledSetupField("Provider", newBotProvider),
      labeledSetupField("Model", newBotModel),
      labeledSetupField("Power", newBotPower),
      labeledSetupField("Speed", newBotSpeed),
    );
    const newBotSetupError = element(documentRef, "p", "codex-new-bot-error");
    newBotSetupError.setAttribute("role", "alert");
    newBotSetupError.setAttribute("aria-live", "assertive");
    newBotSetupError.hidden = true;
    const newBotSetupActions = element(documentRef, "div", "codex-new-bot-actions");
    const newBotContinue = element(documentRef, "button", "codex-new-bot-continue", "Continue");
    newBotContinue.type = "button";
    newBotSetupActions.append(newBotContinue);
    newBotSetup.append(
      newBotSetupTitle,
      newBotSetupCopy,
      newBotSetupFields,
      newBotSetupError,
      newBotSetupActions,
    );
    const computerSetup = element(documentRef, "dialog", "codex-computer-setup");
    computerSetup.setAttribute("role", "dialog");
    computerSetup.setAttribute("aria-modal", "true");
    computerSetup.setAttribute("aria-labelledby", "codex-computer-setup-title");
    computerSetup.setAttribute("aria-describedby", "codex-computer-setup-copy");
    computerSetup.hidden = true;
    const computerSetupTitle = element(documentRef, "h2", "codex-computer-setup-title", "Choose this bot’s Computer");
    computerSetupTitle.id = "codex-computer-setup-title";
    const computerSetupCopy = element(
      documentRef,
      "p",
      "codex-computer-setup-copy",
      "Models and Computer are separate. You can change this later.",
    );
    computerSetupCopy.id = "codex-computer-setup-copy";
    const computerChoices = element(documentRef, "div", "codex-computer-choices");
    computerChoices.setAttribute("role", "radiogroup");
    computerChoices.setAttribute("aria-label", "Computer mode");
    const computerChoiceInputs = new Map();
    for (const choice of COMPUTER_CHOICES) {
      const label = element(documentRef, "label", "codex-computer-choice");
      const input = element(documentRef, "input", "codex-computer-choice-input");
      input.type = "radio";
      input.name = "codex-computer-mode";
      input.value = choice.value;
      const copy = element(documentRef, "span", "codex-computer-choice-copy");
      copy.append(
        element(documentRef, "strong", "codex-computer-choice-label", choice.label),
        element(
          documentRef,
          "span",
          "codex-computer-choice-detail",
          choice.value === "local"
            ? "A private browser and workspace on this Mac"
            : choice.value === "cursor"
              ? "Uses Cursor’s remote Computer when your account allows it"
              : "Chat and models still work without a Computer",
        ),
      );
      label.append(input, copy);
      computerChoices.append(label);
      computerChoiceInputs.set(choice.value, input);
    }
    const computerSetupActions = element(documentRef, "div", "codex-computer-setup-actions");
    const computerCancel = element(documentRef, "button", "codex-computer-cancel", "Cancel");
    computerCancel.type = "button";
    computerCancel.hidden = true;
    const computerContinue = element(documentRef, "button", "codex-computer-continue", "Continue");
    computerContinue.type = "button";
    computerContinue.disabled = true;
    computerSetupActions.append(computerCancel, computerContinue);
    computerSetup.append(computerSetupTitle, computerSetupCopy, computerChoices, computerSetupActions);
    const permissionSheet = element(documentRef, "dialog", "codex-permission-sheet");
    permissionSheet.setAttribute("role", "dialog");
    permissionSheet.setAttribute("aria-modal", "true");
    permissionSheet.setAttribute("aria-labelledby", "codex-permission-title");
    permissionSheet.setAttribute(
      "aria-describedby",
      "codex-permission-reason codex-permission-capability codex-permission-command",
    );
    permissionSheet.hidden = true;
    const permissionTitle = element(documentRef, "h2", "codex-permission-title", "Computer permission");
    permissionTitle.id = "codex-permission-title";
    const permissionReason = element(documentRef, "p", "codex-permission-reason");
    permissionReason.id = "codex-permission-reason";
    const permissionCapability = element(documentRef, "p", "codex-permission-capability");
    permissionCapability.id = "codex-permission-capability";
    const permissionCommand = element(documentRef, "pre", "codex-permission-command");
    permissionCommand.id = "codex-permission-command";
    permissionCommand.hidden = true;
    const permissionActions = element(documentRef, "div", "codex-permission-actions");
    const permissionDeny = element(documentRef, "button", "codex-permission-deny", "Deny");
    const permissionOnce = element(documentRef, "button", "codex-permission-once", "Allow Once");
    const permissionAlways = element(documentRef, "button", "codex-permission-always", "Always Allow for This Bot");
    for (const button of [permissionDeny, permissionOnce, permissionAlways]) button.type = "button";
    permissionActions.append(permissionDeny, permissionOnce, permissionAlways);
    permissionSheet.append(
      permissionTitle,
      permissionReason,
      permissionCapability,
      permissionCommand,
      permissionActions,
    );
    const modelDock = element(documentRef, "section", "codex-model-dock");
    modelDock.id = "codex-model-dock";
    modelDock.dataset.codexMountState = "pending";
    modelDock.setAttribute("aria-label", "OpenBot Power controls");
    const modelTrigger = element(documentRef, "button", "codex-model-trigger");
    modelTrigger.type = "button";
    modelTrigger.setAttribute("aria-haspopup", "dialog");
    modelTrigger.setAttribute("aria-expanded", "false");
    modelTrigger.setAttribute("aria-controls", "codex-power-popover");
    const triggerFast = element(documentRef, "span", "codex-model-trigger-fast");
    triggerFast.setAttribute("aria-hidden", "true");
    const triggerModel = element(documentRef, "span", "codex-model-trigger-model", "Choose model");
    const triggerEffort = element(documentRef, "span", "codex-model-trigger-effort", "");
    const triggerChevron = element(documentRef, "span", "codex-model-trigger-chevron", "⌄");
    triggerChevron.setAttribute("aria-hidden", "true");
    modelTrigger.append(triggerFast, triggerModel, triggerEffort, triggerChevron);
    const popover = element(documentRef, "div", "codex-power-popover");
    popover.id = "codex-power-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Power");
    popover.hidden = true;
    const reasoningView = createReasoningView(documentRef, { windowRef });
    const reasoning = reasoningView.input;
    const powerShell = element(documentRef, "div", "codex-power-shell");
    const advancedToggle = element(documentRef, "button", "codex-power-advanced-toggle", "Advanced");
    advancedToggle.type = "button";
    advancedToggle.setAttribute("aria-expanded", "false");
    const fastToggle = element(documentRef, "button", "codex-power-fast-toggle");
    fastToggle.type = "button";
    fastToggle.setAttribute("aria-label", "Use Fast speed");
    fastToggle.setAttribute("aria-pressed", "false");
    const compactControls = element(documentRef, "div", "codex-power-compact-controls");
    compactControls.append(advancedToggle, fastToggle, reasoningView.warning);
    powerShell.append(reasoningView.control);
    const pickerMenu = element(documentRef, "div", "codex-power-menu");
    pickerMenu.dataset.view = "simple";
    pickerMenu.dataset.reducedMotion = String(
      windowRef.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true,
    );
    const viewTrack = element(documentRef, "div", "codex-power-view-track");
    const simplePanel = element(
      documentRef,
      "div",
      "codex-power-view-panel codex-power-view-simple",
    );
    simplePanel.setAttribute("aria-hidden", "false");
    simplePanel.inert = false;
    simplePanel.append(powerShell);
    const advancedPanel = element(
      documentRef,
      "div",
      "codex-power-view-panel codex-power-view-advanced",
    );
    advancedPanel.setAttribute("aria-hidden", "true");
    advancedPanel.inert = true;
    const createAdvancedRow = (kind, label) => {
      const row = element(documentRef, "button", "codex-power-advanced-row");
      row.type = "button";
      row.dataset.kind = kind;
      row.setAttribute("role", "menuitem");
      row.setAttribute("aria-haspopup", "menu");
      row.setAttribute("aria-expanded", "false");
      const rowLabel = element(documentRef, "span", "codex-power-advanced-row-label", label);
      const rowValue = element(documentRef, "span", "codex-power-advanced-row-value");
      const rowChevron = element(documentRef, "span", "codex-power-advanced-row-chevron", "›");
      rowChevron.setAttribute("aria-hidden", "true");
      row.append(rowLabel, rowValue, rowChevron);
      return Object.freeze({ row, value: rowValue });
    };
    const advancedModel = createAdvancedRow("model", "Model");
    const advancedEffort = createAdvancedRow("effort", "Effort");
    const advancedSpeed = createAdvancedRow("speed", "Speed");
    const advancedFlyout = element(documentRef, "div", "codex-power-flyout");
    advancedFlyout.setAttribute("role", "menu");
    advancedFlyout.hidden = true;
    const advancedFlyoutTitle = element(documentRef, "div", "codex-power-flyout-title");
    const advancedFlyoutOptions = element(documentRef, "div", "codex-power-flyout-options");
    advancedFlyout.append(advancedFlyoutTitle, advancedFlyoutOptions);
    advancedPanel.append(
      advancedModel.row,
      advancedEffort.row,
      advancedSpeed.row,
    );
    const viewControls = element(documentRef, "div", "codex-power-view-controls");
    viewControls.append(compactControls);
    viewTrack.append(simplePanel, advancedPanel);
    pickerMenu.append(viewTrack, viewControls);
    panel.append(
      header,
      creationAlert,
      renameRow,
      ...(nativeProtocolMode ? [] : [statusRow, computerRow, computerGrants, newBotSetup]),
      computerSetup,
      permissionSheet,
    );
    const nativeBotSettings = element(documentRef, "section", "codex-native-bot-settings");
    nativeBotSettings.setAttribute("aria-label", "OpenBot Computer");
    const nativeBotSettingsTitle = element(
      documentRef,
      "h3",
      "codex-native-section-title",
      "Computer",
    );
    const desktopHost = element(
      documentRef,
      "div",
      "codex-bot-desktop-host openbot-local-desktop-host",
    );
    if (nativeProtocolMode) {
      nativeBotSettings.append(
        nativeBotSettingsTitle,
        statusRow,
        computerRow,
        computerGrants,
        desktopHost,
      );
    }
    const connectionsSettings = element(documentRef, "section", "codex-ai-connections");
    connectionsSettings.setAttribute("aria-label", "AI Connections");
    const connectionsTitle = element(documentRef, "h3", "codex-native-section-title", "AI Connections");
    const connectionsCopy = element(
      documentRef,
      "p",
      "codex-ai-connections-copy",
      "Connect the AI services you want OpenBot to use. Models remain bot-specific.",
    );
    const connectionsStatus = element(documentRef, "p", "codex-ai-connections-status");
    connectionsStatus.setAttribute("role", "status");
    connectionsStatus.setAttribute("aria-live", "polite");
    connectionsStatus.hidden = true;
    const connectionsRetry = element(documentRef, "button", "codex-ai-connections-retry", "Retry");
    connectionsRetry.type = "button";
    connectionsRetry.setAttribute("aria-label", "Retry AI connections");
    connectionsRetry.hidden = true;
    const makeLoginPrompt = () => {
      const prompt = element(documentRef, "div", "codex-provider-login-prompt");
      prompt.setAttribute("role", "status");
      prompt.setAttribute("aria-live", "polite");
      prompt.hidden = true;
      const copy = element(
        documentRef,
        "span",
        "codex-provider-login-prompt-copy",
        "Enter this code in the OpenAI sign-in window:",
      );
      const code = element(documentRef, "code", "codex-provider-login-prompt-code");
      prompt.append(copy, code);
      return Object.freeze({ prompt, code });
    };
    function makeProviderSurface({ first }) {
      const key = first ? "first" : "settings";
      const root = element(documentRef, "section", `codex-provider-picker codex-${key}-provider-picker`);
      const list = element(documentRef, "ul", "codex-provider-choice-list");
      list.setAttribute("role", "list");
      list.setAttribute("aria-label", first ? "Choose your first AI connection" : "AI connections");
      const details = element(documentRef, "div", "codex-provider-details");
      details.id = `codex-${key}-provider-details`;
      details.setAttribute("role", "region");
      const surface = {
        key,
        first,
        selectedProviderId: "openai-codex",
        root,
        list,
        cards: new Map(),
        details,
        detail: null,
        loginPrompt: makeLoginPrompt(),
      };
      for (const providerId of PROVIDER_IDS) {
        const presentation = PROVIDER_PRESENTATION[providerId];
        const item = element(documentRef, "li", "codex-provider-choice");
        const button = element(documentRef, "button", "codex-provider-choice-button");
        button.type = "button";
        button.dataset.providerId = providerId;
        button.dataset.surface = key;
        button.setAttribute("aria-pressed", String(providerId === surface.selectedProviderId));
        button.setAttribute("aria-controls", details.id);
        button.tabIndex = providerId === surface.selectedProviderId ? 0 : -1;
        const mark = element(documentRef, "span", "codex-provider-choice-mark", presentation.mark);
        mark.setAttribute("aria-hidden", "true");
        const copy = element(documentRef, "span", "codex-provider-choice-copy");
        const title = element(documentRef, "strong", "codex-provider-choice-label", PROVIDER_LABELS[providerId]);
        const description = element(documentRef, "span", "codex-provider-choice-description", presentation.description);
        const state = element(documentRef, "span", "codex-provider-choice-state", "Not connected");
        state.id = `codex-${key}-${providerId}-state`;
        button.setAttribute("aria-describedby", state.id);
        const selected = element(documentRef, "span", "codex-provider-choice-selected", "Selected");
        selected.setAttribute("aria-hidden", "true");
        selected.hidden = providerId !== surface.selectedProviderId;
        copy.append(title, description, state, selected);
        if (presentation.recommended) {
          copy.append(element(documentRef, "span", "codex-provider-recommended", "Recommended"));
        }
        button.append(mark, copy);
        item.append(button);
        list.append(item);
        surface.cards.set(providerId, { item, button, mark, title, description, state, selected, providerId });
        button.addEventListener("click", () => {
          selectProvider(surface, providerId, { moveFocus: true });
        });
        button.addEventListener("keydown", (event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault?.();
          moveProviderChoice(surface, providerId, event.key);
        });
      }
      root.append(list, details);
      return surface;
    }

    const providerSurfaces = Object.freeze({
      first: makeProviderSurface({ first: true }),
      settings: makeProviderSurface({ first: false }),
    });
    const firstConnectionSetup = element(documentRef, "dialog", "codex-first-connection-setup");
    firstConnectionSetup.setAttribute("role", "dialog");
    firstConnectionSetup.setAttribute("aria-modal", "true");
    firstConnectionSetup.setAttribute("aria-labelledby", "codex-first-connection-title");
    firstConnectionSetup.setAttribute("aria-describedby", "codex-first-connection-copy");
    firstConnectionSetup.hidden = true;
    const firstConnectionTitle = element(
      documentRef,
      "h2",
      "codex-first-connection-title",
      "Choose your first AI connection",
    );
    firstConnectionTitle.id = "codex-first-connection-title";
    const firstConnectionCopy = element(
      documentRef,
      "p",
      "codex-first-connection-copy",
      "Connect one service before creating your first bot. You can connect more later in Settings.",
    );
    firstConnectionCopy.id = "codex-first-connection-copy";
    const firstConnectionError = element(documentRef, "p", "codex-first-connection-error");
    firstConnectionError.setAttribute("role", "alert");
    firstConnectionError.hidden = true;
    const firstConnectionStatus = element(documentRef, "p", "codex-first-connection-status");
    firstConnectionStatus.setAttribute("role", "status");
    firstConnectionStatus.setAttribute("aria-live", "polite");
    firstConnectionStatus.hidden = true;
    const firstConnectionRetry = element(documentRef, "button", "codex-first-connection-retry", "Retry");
    firstConnectionRetry.type = "button";
    firstConnectionRetry.setAttribute("aria-label", "Retry AI connections");
    firstConnectionRetry.hidden = true;
    const firstConnectionHeader = element(documentRef, "header", "codex-provider-picker-header");
    firstConnectionHeader.append(firstConnectionTitle, firstConnectionCopy);
    const firstConnectionScroll = element(documentRef, "div", "codex-provider-picker-scroll");
    firstConnectionScroll.append(
      providerSurfaces.first.root,
      firstConnectionError,
      firstConnectionStatus,
      firstConnectionRetry,
    );
    firstConnectionSetup.replaceChildren(firstConnectionHeader, firstConnectionScroll);
    connectionsSettings.replaceChildren(
      connectionsTitle,
      connectionsCopy,
      connectionsStatus,
      connectionsRetry,
      providerSurfaces.settings.root,
    );
    if (nativeProtocolMode) {
      popover.append(
        pickerMenu,
        reasoningView.label,
        reasoningView.instructions,
      );
    } else popover.append(pickerMenu, reasoningView.label, reasoningView.instructions);
    modelDock.append(modelTrigger, popover, advancedFlyout);
    if (nativeProtocolMode) {
      documentRef.body.append(computerSetup, permissionSheet, firstConnectionSetup);
      panel.dataset.codexMountState = "native-shell";
    } else documentRef.body.append(panel, modelDock);

    let mountDisposed = false;
    let providerFacade = null;
    let providerFacadeInvalid = nativeProtocolMode;
    try {
      const candidate = normalizeProviderFacade(windowRef.openbotProviders);
      if (candidate) {
        providerFacade = candidate;
        providerFacadeInvalid = false;
      }
    } catch {
      providerFacadeInvalid = nativeProtocolMode;
    }
    const providerPending = new Set();
    let providerConnections = Object.freeze([]);
    let providerCatalogSource = Object.freeze({
      generation: 0,
      status: "unavailable",
      models: Object.freeze([]),
    });
    let providerCatalog = Object.freeze({ generation: 0, status: "unavailable", models: Object.freeze([]) });
    let providerOnboarding = null;
    let providerLoginPrompt = null;
    let providerConnectionsUnsubscribe = null;
    let providerLoginPromptUnsubscribe = null;
    let providerCatalogUnsubscribe = null;
    let providerAuthorityLoaded = false;
    let providerCatalogLoaded = false;
    let providerOnboardingLoaded = false;
    let providerInitialFocusDone = false;
    let providerGateReturnFocus = null;
    let providerAuthorityInvalid = providerFacadeInvalid;
    let providerAuthorityHasCommit = false;
    let providerAuthorityRetryable = false;
    let providerActionSequence = 0;
    const providerOperations = new Map();
    const providerErrors = new Map();
    const providerReceiptRetry = new Set();
    let providerRefreshFlight = null;
    let providerRefreshDeferred = null;
    let providerRefreshTicket = 0;
    let resolveProviderRefreshDisposed = null;
    const providerRefreshDisposed = new Promise((resolve) => {
      resolveProviderRefreshDisposed = resolve;
    });
    let localDesktopView = null;
    let localDesktopSelection = undefined;
    let lastSnapshot = null;
    let advancedViewExpanded = false;
    let pickerTransitionFrame = 0;
    const POWER_SURFACE_MARGIN = 8;
    const POWER_SURFACE_GAP = 8;
    const finiteDimension = (value, fallback = 0) => (
      Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
    );
    const clampSurfaceCoordinate = (value, size, viewportSize) => {
      const lower = POWER_SURFACE_MARGIN;
      if (!Number.isFinite(viewportSize) || viewportSize <= 0) return Math.max(lower, value);
      const upper = Math.max(lower, viewportSize - size - POWER_SURFACE_MARGIN);
      return Math.max(lower, Math.min(value, upper));
    };
    function positionPowerSurfaces() {
      if (mountDisposed || popover.hidden) return;
      const triggerRect = modelTrigger.getBoundingClientRect?.();
      if (!triggerRect) return;
      const viewportWidth = finiteDimension(
        windowRef.innerWidth,
        finiteDimension(documentRef.documentElement?.clientWidth),
      );
      const viewportHeight = finiteDimension(
        windowRef.innerHeight,
        finiteDimension(documentRef.documentElement?.clientHeight),
      );
      const measuredPopover = popover.getBoundingClientRect?.();
      const popoverWidth = finiteDimension(popover.offsetWidth, finiteDimension(measuredPopover?.width, 224));
      const popoverHeight = finiteDimension(popover.offsetHeight, finiteDimension(measuredPopover?.height));
      const triggerRight = Number(triggerRect.right) || (Number(triggerRect.left) + Number(triggerRect.width));
      const triggerTop = Number(triggerRect.top) || 0;
      const triggerBottom = Number(triggerRect.bottom) || (triggerTop + Number(triggerRect.height));
      const left = clampSurfaceCoordinate(triggerRight - popoverWidth, popoverWidth, viewportWidth);
      let top = triggerTop - popoverHeight - POWER_SURFACE_GAP;
      if (top < POWER_SURFACE_MARGIN
        && triggerBottom + POWER_SURFACE_GAP + popoverHeight <= viewportHeight - POWER_SURFACE_MARGIN) {
        top = triggerBottom + POWER_SURFACE_GAP;
      }
      top = clampSurfaceCoordinate(top, popoverHeight, viewportHeight);
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;

      if (advancedFlyout.hidden) return;
      const measuredFlyout = advancedFlyout.getBoundingClientRect?.();
      const flyoutWidth = finiteDimension(advancedFlyout.offsetWidth, finiteDimension(measuredFlyout?.width));
      const flyoutHeight = finiteDimension(advancedFlyout.offsetHeight, finiteDimension(measuredFlyout?.height));
      let flyoutLeft = left - flyoutWidth - POWER_SURFACE_GAP;
      if (flyoutLeft < POWER_SURFACE_MARGIN
        && left + popoverWidth + POWER_SURFACE_GAP + flyoutWidth <= viewportWidth - POWER_SURFACE_MARGIN) {
        flyoutLeft = left + popoverWidth + POWER_SURFACE_GAP;
      }
      flyoutLeft = clampSurfaceCoordinate(flyoutLeft, flyoutWidth, viewportWidth);
      const flyoutTop = clampSurfaceCoordinate(
        top + popoverHeight - flyoutHeight,
        flyoutHeight,
        viewportHeight,
      );
      advancedFlyout.style.left = `${flyoutLeft}px`;
      advancedFlyout.style.top = `${flyoutTop}px`;
    }
    function measurePickerViews() {
      if (mountDisposed) return;
      const simpleHeight = Math.max(0, Number(simplePanel.offsetHeight) || 0);
      const advancedHeight = Math.max(0, Number(advancedPanel.offsetHeight) || 0);
      const controlsHeight = Math.max(0, Number(viewControls.offsetHeight) || 0);
      pickerMenu.style.setProperty("--simple-view-height", `${simpleHeight}px`);
      pickerMenu.style.setProperty("--advanced-view-height", `${advancedHeight}px`);
      pickerMenu.style.height = `${(advancedViewExpanded ? advancedHeight : simpleHeight) + controlsHeight}px`;
      positionPowerSurfaces();
    }
    function setAdvancedView(expanded) {
      advancedViewExpanded = Boolean(expanded);
      if (!advancedViewExpanded) closeAdvancedFlyout();
      pickerMenu.dataset.view = advancedViewExpanded ? "advanced" : "simple";
      simplePanel.setAttribute("aria-hidden", String(advancedViewExpanded));
      simplePanel.inert = advancedViewExpanded;
      advancedPanel.setAttribute("aria-hidden", String(!advancedViewExpanded));
      advancedPanel.inert = !advancedViewExpanded;
      advancedToggle.setAttribute("aria-expanded", String(advancedViewExpanded));
      popover.classList.toggle("is-advanced", advancedViewExpanded);
      if (advancedViewExpanded) fastToggle.hidden = true;
      else if (lastSnapshot) fastToggle.hidden = !activeFastTier;
      measurePickerViews();
    }
    const PickerResizeObserver = windowRef.ResizeObserver;
    const pickerResizeObserver = typeof PickerResizeObserver === "function"
      ? new PickerResizeObserver(() => measurePickerViews())
      : null;
    const surfaceResizeObserver = typeof PickerResizeObserver === "function"
      ? new PickerResizeObserver(() => positionPowerSurfaces())
      : null;
    pickerResizeObserver?.observe(simplePanel);
    pickerResizeObserver?.observe(advancedPanel);
    pickerResizeObserver?.observe(viewControls);
    surfaceResizeObserver?.observe(popover);
    surfaceResizeObserver?.observe(advancedFlyout);
    measurePickerViews();
    if (typeof windowRef.requestAnimationFrame === "function") {
      pickerTransitionFrame = windowRef.requestAnimationFrame(() => {
        pickerTransitionFrame = 0;
        if (!mountDisposed) {
          pickerMenu.dataset.transitionsReady = "true";
          pickerMenu.classList.add("transitions-ready");
        }
      });
    } else {
      pickerMenu.dataset.transitionsReady = "true";
      pickerMenu.classList.add("transitions-ready");
    }
    function attachToProductHosts() {
      if (mountDisposed) return;
      const {
        sidebarHost,
        composerHost,
        nativeComposerHost,
        nativeBotSettingsHost,
        nativeConnectionsHost,
      } = findUiMounts(documentRef);
      if (nativeProtocolMode) {
        panel.dataset.codexMountState = "native-shell";
      } else if (sidebarHost) {
        if (panel.parentElement !== sidebarHost) sidebarHost.append(panel);
        panel.dataset.codexMountState = "mounted";
      } else {
        panel.dataset.codexMountState = "pending";
      }
      const targetComposerHost = nativeProtocolMode ? nativeComposerHost : composerHost;
      if (targetComposerHost) {
        if (modelDock.parentElement !== targetComposerHost) {
          targetComposerHost.append?.(modelDock);
        }
        modelDock.dataset.codexMountState = "mounted";
        positionPowerSurfaces();
      } else {
        if (nativeProtocolMode && modelDock.parentElement) modelDock.remove?.();
        modelDock.dataset.codexMountState = "pending";
      }
      if (nativeProtocolMode && nativeBotSettingsHost) {
        if (nativeBotSettings.parentElement !== nativeBotSettingsHost) {
          nativeBotSettingsHost.append?.(nativeBotSettings);
        }
        if (!localDesktopView
          && typeof windowRef.OpenBotLocalDesktopView?.createLocalDesktopView === "function") {
          try {
            localDesktopView = windowRef.OpenBotLocalDesktopView.createLocalDesktopView({
              documentRef,
              windowRef,
              container: desktopHost,
            });
            localDesktopSelection = null;
          } catch {}
        }
        synchronizeLocalDesktop(lastSnapshot);
      } else if (nativeProtocolMode) {
        nativeBotSettings.remove?.();
        localDesktopView?.dispose?.();
        localDesktopView = null;
        localDesktopSelection = undefined;
      }
      if (nativeProtocolMode && nativeConnectionsHost) {
        if (connectionsSettings.parentElement !== nativeConnectionsHost) {
          nativeConnectionsHost.append?.(connectionsSettings);
        }
      } else if (nativeProtocolMode) connectionsSettings.remove?.();
    }
    attachToProductHosts();
    const MountObserver = windowRef.MutationObserver;
    const mountObserver = typeof MountObserver === "function"
      ? new MountObserver(() => attachToProductHosts())
      : null;
    mountObserver?.observe(documentRef.body, { childList: true, subtree: true });

    let warningTimer = null;
    let warningScope = null;
    let currentPowerScope = "unselected";
    let holdTimer = null;
    let activeFastTier = null;
    const selectionIntents = new Map();
    let advancedModelIdentities = new Map();
    let advancedOptions = null;
    let advancedSelection = null;
    let advancedFlyoutKind = null;
    let advancedFlyoutOwner = null;
    const advancedOptionActions = new WeakMap();
    let selectionIntentSequence = 0;
    let compactProjectionPending = false;
    let newBotSetupReturnFocus = null;
    let newBotPhotoError = null;
    let setupReturnFocus = null;
    let permissionReturnFocus = null;
    const powerState = new POWER_CONTROL.PowerControlState([], null, { ownerKey: "unselected" });
    let controller;

    function buildProviderDetails(surface, connection) {
      const providerId = connection.providerId;
      const label = connection.label;
      const kind = connection.loginKind;
      const panel = surface.details;
      panel.dataset.providerId = providerId;
      panel.dataset.loginKind = kind;
      panel.tabIndex = -1;
      const heading = element(documentRef, "h3", "codex-provider-details-title", label);
      heading.id = `codex-${surface.key}-${providerId}-details-title`;
      panel.setAttribute("aria-labelledby", heading.id);
      const status = element(documentRef, "p", "codex-provider-details-status", "Not connected");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      const error = element(documentRef, "p", "codex-provider-connection-error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const form = element(documentRef, "div", "codex-provider-connection-form");
      const inputs = Object.create(null);
      if (kind === "account") {
        const mode = element(documentRef, "select", "codex-provider-auth-mode");
        mode.setAttribute("aria-label", `${label} sign-in method`);
        for (const [value, text] of [["browser", "Browser"], ["device-code", "Device"]]) {
          const option = element(documentRef, "option", "", text);
          option.value = value;
          mode.append(option);
        }
        inputs.authMode = mode;
        form.append(mode);
      } else if (kind === "api-key") {
        const apiKey = element(documentRef, "input", "codex-provider-api-key");
        apiKey.type = "password";
        apiKey.autocomplete = "off";
        apiKey.placeholder = "API key";
        apiKey.setAttribute("aria-label", `${label} API key`);
        inputs.apiKey = apiKey;
        form.append(apiKey);
      } else if (kind === "local") {
        const baseUrl = element(documentRef, "input", "codex-provider-base-url");
        baseUrl.type = "url";
        baseUrl.value = "http://127.0.0.1:11434/v1";
        baseUrl.setAttribute("aria-label", `${label} base URL`);
        const apiKey = element(documentRef, "input", "codex-provider-api-key");
        apiKey.type = "password";
        apiKey.autocomplete = "off";
        apiKey.placeholder = "Optional API key";
        apiKey.setAttribute("aria-label", `${label} API key`);
        inputs.baseUrl = baseUrl;
        inputs.apiKey = apiKey;
        form.append(baseUrl, apiKey);
      }
      if (providerId === "google-vertex-ai") {
        form.append(element(documentRef, "p", "codex-provider-unavailable-copy", VERTEX_UNAVAILABLE_COPY));
      }
      const action = element(documentRef, "button", "codex-provider-connect", `Connect ${label}`);
      action.type = "button";
      action.dataset.providerId = providerId;
      action.disabled = providerId === "google-vertex-ai";
      const disconnect = element(documentRef, "button", "codex-provider-disconnect", `Disconnect ${label}`);
      disconnect.type = "button";
      disconnect.dataset.providerId = providerId;
      disconnect.hidden = surface.first;
      const actions = element(documentRef, "div", "codex-provider-connection-actions");
      actions.append(action, disconnect);
      panel.replaceChildren(heading, status, error, form, actions, surface.loginPrompt.prompt);
      const detail = {
        panel,
        heading,
        status,
        error,
        form,
        inputs,
        action,
        disconnect,
        firstControl: inputs.authMode ?? inputs.baseUrl ?? inputs.apiKey ?? action,
        providerId,
        first: surface.first,
      };
      action.addEventListener("click", () => { void providerAction(providerId, surface.first); });
      disconnect.addEventListener("click", () => { void disconnectProvider(providerId); });
      return detail;
    }

    function focusProviderDetails(surface) {
      const detail = surface.detail;
      if (!detail) return;
      const candidates = [detail.disconnect, detail.firstControl, detail.action];
      for (const candidate of candidates) {
        if (!candidate
          || candidate.isConnected !== true
          || candidate.hidden
          || candidate.disabled
          || typeof candidate.focus !== "function") continue;
        try { candidate.focus(); } catch { continue; }
        if (documentRef.activeElement === candidate) return;
      }
      const panel = detail.panel;
      if (!panel
        || panel.isConnected !== true
        || typeof panel.focus !== "function") return;
      try { panel.focus(); } catch {}
    }

    function selectProvider(surface, providerId, { moveFocus = false } = {}) {
      if (!surface.cards.has(providerId)) return;
      surface.selectedProviderId = providerId;
      for (const [candidateId, card] of surface.cards) {
        const selected = candidateId === providerId;
        card.button.setAttribute("aria-pressed", String(selected));
        card.button.tabIndex = selected ? 0 : -1;
      }
      renderProviderSurface(surface);
      if (moveFocus) focusProviderDetails(surface);
    }

    function moveProviderChoice(surface, currentId, key) {
      const current = PROVIDER_IDS.indexOf(currentId);
      const columns = windowRef.innerWidth < 620 ? 1 : 2;
      const delta = key === "ArrowRight" ? 1
        : key === "ArrowLeft" ? -1
          : key === "ArrowDown" ? columns : key === "ArrowUp" ? -columns : 0;
      const target = key === "Home" ? 0 : key === "End" ? PROVIDER_IDS.length - 1
        : Math.max(0, Math.min(PROVIDER_IDS.length - 1, current + delta));
      selectProvider(surface, PROVIDER_IDS[target]);
      surface.cards.get(PROVIDER_IDS[target])?.button.focus?.();
    }

    function renderProviderCard(surface, card, connection) {
      const operation = providerOperations.get(connection.providerId);
      const pending = providerPending.has(connection.providerId);
      const stateText = operation?.kind === "disconnect" ? "Disconnecting…"
        : pending ? "Connecting…"
          : connection.state === "connected" ? "Connected"
            : connection.state === "connecting" ? "Connecting…"
              : connection.providerId === "google-vertex-ai" ? "Unavailable"
                : connection.state === "unavailable" ? "Retry available" : "Not connected";
      card.state.textContent = stateText;
      card.state.dataset.state = connection.state;
      card.button.dataset.state = connection.state;
      card.title.textContent = connection.label;
      card.selected.hidden = surface.selectedProviderId !== connection.providerId;
    }

    function renderProviderSurface(surface) {
      for (const providerId of PROVIDER_IDS) {
        renderProviderCard(surface, surface.cards.get(providerId), providerConnection(providerId));
      }
      const connection = providerConnection(surface.selectedProviderId);
      const previous = surface.detail;
      if (!previous || previous.providerId !== connection.providerId) {
        surface.detail = buildProviderDetails(surface, connection);
      }
      updateProviderDetails(surface, surface.detail, connection);
      renderProviderLoginPrompt();
      return surface.detail;
    }

    renderProviderSurface(providerSurfaces.first);
    renderProviderSurface(providerSurfaces.settings);

    function synchronizeLocalDesktop(snapshot) {
      if (!localDesktopView || !snapshot) return;
      const nextBotId = snapshot.activeBotId && snapshot.computer.mode === "local"
        ? snapshot.activeBotId
        : null;
      if (localDesktopSelection === nextBotId) return;
      localDesktopSelection = nextBotId;
      try { localDesktopView.selectBot(nextBotId); } catch {}
    }

    function providerConnection(providerId) {
      return providerConnections.find((entry) => entry.providerId === providerId) ?? disconnectedProvider(providerId);
    }

    function renderProviderLoginPrompt() {
      const operation = providerLoginPrompt?.operation;
      const operationVisible = Boolean(
        providerLoginPrompt
        && operation
        && providerOperations.get("openai-codex") === operation
        && !mountDisposed,
      );
      for (const surface of Object.values(providerSurfaces)) {
        const visible = operationVisible && surface.selectedProviderId === "openai-codex";
        surface.loginPrompt.code.textContent = visible ? providerLoginPrompt.prompt.userCode : "";
        surface.loginPrompt.prompt.hidden = !visible;
      }
    }

    function clearProviderLoginPrompt(operation = null) {
      if (operation !== null && providerLoginPrompt?.operation !== operation) return;
      providerLoginPrompt = null;
      renderProviderLoginPrompt();
    }

    function receiveProviderLoginPrompt(value) {
      let prompt;
      try { prompt = normalizeProviderLoginPrompt(value); } catch { return; }
      const operation = providerOperations.get("openai-codex");
      if (!operation || mountDisposed) return;
      if (providerLoginPrompt && providerLoginPrompt.operation === operation
        && prompt.generation <= providerLoginPrompt.prompt.generation) return;
      const baseline = providerConnection("openai-codex");
      providerLoginPrompt = Object.freeze({
        prompt,
        operation,
        baselineState: baseline.state,
        baselineGeneration: baseline.generation,
      });
      renderProviderLoginPrompt();
    }

    function providerErrorCopy(providerId, error) {
      const connection = providerConnection(providerId);
      const code = typeof error?.code === "string" ? error.code : connection.errorCode;
      if (code === "OPENBOT_PROVIDER_DISCONNECT_PENDING") {
        return `${connection.label} disconnect is pending. Retry disconnect.`;
      }
      if (code && /CANCEL|CANCELLED/i.test(code)) return `${connection.label} connection cancelled. Try again.`;
      if (code && /INVALID/i.test(code)) return `${connection.label} details were not accepted. Check them and try again.`;
      return `${connection.label} could not be connected. Try again.`;
    }

    function providerReceiptsEqual(left, right) {
      return left !== null && right !== null
        && left.schemaVersion === right.schemaVersion
        && left.providerId === right.providerId
        && left.connectionGeneration === right.connectionGeneration
        && left.catalogGeneration === right.catalogGeneration
        && left.completedAt === right.completedAt;
    }

    function updateProviderDetails(surface, entry, connection) {
      const pending = providerPending.has(connection.providerId);
      const operation = providerOperations.get(connection.providerId);
      const surfacePending = pending && operation?.first === surface.first;
      const disconnecting = surfacePending && operation?.kind === "disconnect";
      const connected = connection.state === "connected";
      const externallyConnecting = connection.state === "connecting";
      const disconnectPending = connection.providerId === "openai-codex"
        && connection.state === "unavailable"
        && connection.errorCode === "OPENBOT_PROVIDER_DISCONNECT_PENDING";
      const receiptRetry = surface.first && providerReceiptRetry.has(connection.providerId);
      const legacyConfirmation = surface.first && connected && !receiptRetry
        && providerOnboarding === null
        && providerCatalog.models.some((model) => model.provider === connection.providerId);
      const vertexUnavailable = connection.providerId === "google-vertex-ai";
      const stateText = disconnecting ? "Disconnecting…" : surfacePending ? "Connecting…"
        : connected ? "Connected"
        : externallyConnecting ? "Connecting…"
          : vertexUnavailable ? "Unavailable"
            : connection.state === "unavailable" ? "Retry available" : "Not connected";
      entry.status.textContent = stateText;
      entry.status.dataset.state = connection.state;
      entry.heading.textContent = connection.label;
      entry.panel.dataset.loginKind = connection.loginKind;
      entry.inputs.authMode?.setAttribute("aria-label", `${connection.label} sign-in method`);
      entry.inputs.baseUrl?.setAttribute("aria-label", `${connection.label} base URL`);
      entry.inputs.apiKey?.setAttribute("aria-label", `${connection.label} API key`);
      entry.panel.setAttribute("aria-busy", String(surfacePending));
      entry.action.disabled = providerFacadeInvalid || surfacePending || vertexUnavailable
        || disconnectPending || externallyConnecting
        || (surface.first && providerAuthorityRetryable)
        || (connected && !receiptRetry && !legacyConfirmation);
      entry.disconnect.disabled = surfacePending;
      entry.disconnect.hidden = surface.first || (!connected && !disconnectPending);
      entry.disconnect.textContent = disconnectPending
        ? `Retry disconnect ${connection.label}` : `Disconnect ${connection.label}`;
      const scopedError = providerErrors.get(`${surface.key}:${connection.providerId}`);
      if (scopedError) {
        entry.error.textContent = scopedError;
        entry.error.hidden = false;
      } else if (!surfacePending && connection.state === "unavailable"
        && connection.errorCode && !vertexUnavailable) {
        entry.error.textContent = providerErrorCopy(connection.providerId, { code: connection.errorCode });
        entry.error.hidden = false;
      } else if (!surfacePending) {
        entry.error.hidden = true;
      }
      entry.action.textContent = receiptRetry ? "Finish setup"
        : legacyConfirmation ? `Continue with ${connection.label}`
          : connected ? "Connected"
            : connection.state === "unavailable" && !vertexUnavailable ? `Retry ${connection.label}`
              : `Connect ${connection.label}`;
      const lockSelection = surfacePending && surface.selectedProviderId === connection.providerId;
      for (const card of surface.cards.values()) card.button.disabled = lockSelection;
    }

    function updateConnectionPresentation(snapshot = lastSnapshot) {
      if (!nativeProtocolMode) return;
      for (const surface of Object.values(providerSurfaces)) renderProviderSurface(surface);
      const gateActive = providerFacade !== null || providerFacadeInvalid || providerAuthorityInvalid;
      const authorityFailure = providerFacadeInvalid || providerAuthorityInvalid;
      const shouldOpen = gateActive
        && (providerFacadeInvalid || providerAuthorityInvalid || providerOnboarding === null);
      const retryable = providerAuthorityRetryable && !providerFacadeInvalid;
      const refreshPending = providerRefreshFlight !== null;
      const retryCopy = "AI connection data is stale. Retry to refresh.";
      connectionsStatus.textContent = retryCopy;
      connectionsStatus.hidden = !retryable;
      connectionsRetry.hidden = !retryable;
      connectionsRetry.disabled = refreshPending;
      firstConnectionStatus.textContent = retryCopy;
      firstConnectionStatus.hidden = !(retryable && shouldOpen);
      firstConnectionRetry.hidden = !(retryable && shouldOpen);
      firstConnectionRetry.disabled = refreshPending;
      const wasOpen = firstConnectionSetup.open === true;
      if (shouldOpen && !wasOpen) {
        providerGateReturnFocus = documentRef.activeElement ?? null;
      }
      setDialogOpen(firstConnectionSetup, shouldOpen);
      renderProviderLoginPrompt();
      panel.inert = shouldOpen;
      modelDock.inert = shouldOpen;
      if (authorityFailure) {
        firstConnectionError.textContent = providerFacadeInvalid
          ? "AI connections are unavailable. Update OpenBot and try again."
          : "AI connections are unavailable. Try again.";
        firstConnectionError.hidden = false;
      } else {
        firstConnectionError.hidden = true;
      }
      if (shouldOpen && providerPending.size === 0 && !providerInitialFocusDone) {
        providerSurfaces.first.cards.get("openai-codex")?.button.focus?.();
        providerInitialFocusDone = true;
      }
      if (!shouldOpen && wasOpen) {
        const target = providerGateReturnFocus;
        providerGateReturnFocus = null;
        const candidates = [target, botSelect, newButton, rename, computerChange, modelTrigger];
        for (const candidate of candidates) {
          if (!candidate
            || candidate === documentRef.body
            || candidate === documentRef.documentElement
            || candidate === documentRef
            || candidate.isConnected !== true
            || candidate.hidden
            || candidate.disabled
            || typeof candidate.focus !== "function") continue;
          try { candidate.focus(); } catch { continue; }
          if (documentRef.activeElement === candidate) break;
        }
      }
      if (!shouldOpen) providerInitialFocusDone = false;
      if (snapshot && gateActive && !shouldOpen) {
        panel.removeAttribute?.("aria-busy");
      }
    }

    function requestForProvider(providerId, entry) {
      const request = { providerId };
      if (providerId === "openai-codex") {
        request.authMode = entry?.inputs.authMode?.value === "device-code" ? "device-code" : "browser";
      } else if (providerId === "openai-api-key") {
        request.apiKey = typeof entry?.inputs.apiKey?.value === "string" ? entry.inputs.apiKey.value : "";
        if (!request.apiKey) throw new Error("Provider connection is unavailable.");
        if (entry?.inputs.apiKey) entry.inputs.apiKey.value = "";
      } else if (providerId === "local-openai-compatible") {
        request.baseUrl = typeof entry?.inputs.baseUrl?.value === "string" ? entry.inputs.baseUrl.value : "";
        request.apiKey = typeof entry?.inputs.apiKey?.value === "string" && entry.inputs.apiKey.value.length > 0
          ? entry.inputs.apiKey.value : null;
        if (entry?.inputs.apiKey) entry.inputs.apiKey.value = "";
      }
      return Object.freeze(request);
    }

    function filterProviderCatalog(source, connections = providerConnections) {
      const connected = new Set(connections
        .filter((entry) => entry.state === "connected")
        .map((entry) => entry.providerId));
      const models = source.status === "ready"
        ? source.models.filter((entry) => connected.has(entry.provider))
        : [];
      return Object.freeze({
        generation: source.generation,
        status: source.status === "ready" && models.length > 0 ? "ready" : "unavailable",
        models: Object.freeze(models),
      });
    }

    function validateProviderSnapshot(connections, catalog, onboarding) {
      const connected = connections.filter((entry) => entry.state === "connected");
      const expectedCatalogGeneration = connected.reduce(
        (generation, entry) => Math.max(generation, entry.generation),
        0,
      );
      if (catalog.generation !== expectedCatalogGeneration) {
        throw new Error("Provider authority changed while reading.");
      }
      if (catalog.status === "ready") {
        const connectedProviders = new Set(connected.map((entry) => entry.providerId));
        const modelProviders = new Set();
        for (const model of catalog.models) {
          if (!connectedProviders.has(model.provider)) {
            throw new Error("Model catalog is unavailable.");
          }
          modelProviders.add(model.provider);
        }
        if (connected.some((entry) => !modelProviders.has(entry.providerId))) {
          throw new Error("Model catalog is unavailable.");
        }
      }
      const nextReceipt = onboarding === null
        ? null
        : normalizeProviderOnboarding(onboarding, connections, catalog);
      if (providerOnboarding !== null) {
        let currentReceipt = null;
        try {
          currentReceipt = normalizeProviderOnboarding(providerOnboarding, connections, catalog);
        } catch {}
        if (currentReceipt !== null && (
          nextReceipt === null
          || nextReceipt.providerId !== currentReceipt.providerId
          || nextReceipt.connectionGeneration < currentReceipt.connectionGeneration
          || nextReceipt.catalogGeneration < currentReceipt.catalogGeneration
        )) {
          const error = new Error("Provider onboarding snapshot is stale.");
          error.code = "OPENBOT_PROVIDER_SNAPSHOT_STALE";
          throw error;
        }
      }
      return nextReceipt;
    }

    function commitProviderSnapshot(snapshot) {
      const previousConnections = providerConnections;
      const previousDirect = previousConnections.find((entry) => entry.providerId === "openai-codex");
      const nextDirect = snapshot.connections.find((entry) => entry.providerId === "openai-codex");
      if (providerLoginPrompt && nextDirect) {
        const stateChanged = previousDirect?.state !== nextDirect.state;
        const generationChanged = previousDirect?.generation !== nextDirect.generation;
        const isBaseline = nextDirect.state === providerLoginPrompt.baselineState
          && nextDirect.generation === providerLoginPrompt.baselineGeneration;
        if ((stateChanged || generationChanged)
          && !isBaseline
          && (nextDirect.state !== "connecting"
            || (previousDirect?.state === "connecting" && generationChanged))) {
          clearProviderLoginPrompt();
        }
      }
      providerConnections = snapshot.connections;
      providerCatalogSource = snapshot.catalog;
      providerCatalog = filterProviderCatalog(snapshot.catalog, snapshot.connections);
      providerOnboarding = snapshot.onboarding;
      providerAuthorityInvalid = false;
      providerAuthorityHasCommit = true;
      providerAuthorityRetryable = false;
      providerAuthorityLoaded = true;
      providerCatalogLoaded = true;
      providerOnboardingLoaded = true;
      for (const connection of snapshot.connections) {
        const previous = previousConnections.find((entry) => entry.providerId === connection.providerId);
        const recovered = (connection.state === "connected"
          && !providerReceiptRetry.has(connection.providerId))
          || (connection.state !== "unavailable"
            && (previous?.state === "unavailable"
              || (previous?.errorCode !== null && connection.errorCode === null)));
        if (recovered) {
          clearProviderError(true, connection.providerId);
          clearProviderError(false, connection.providerId);
        }
        if (connection.state === "disconnected"
          && (previous?.state !== "disconnected" || providerReceiptRetry.has(connection.providerId))) {
          providerReceiptRetry.delete(connection.providerId);
        }
      }
      controller?.applyCatalog?.(providerCatalog);
      updateConnectionPresentation(lastSnapshot);
    }

    async function readProviderSnapshot() {
      const results = await Promise.race([
        Promise.resolve().then(() => providerFacade.readAuthoritySnapshot()),
        providerRefreshDisposed,
      ]);
      if (results === null) throw new Error("Provider controls are unavailable.");
      if (mountDisposed) throw new Error("Provider controls are unavailable.");
      try {
        const normalized = normalizeProviderAuthoritySnapshot(results);
        const onboarding = validateProviderSnapshot(
          normalized.connections,
          normalized.catalog,
          normalized.onboarding,
        );
        return Object.freeze({
          connections: normalized.connections,
          catalog: normalized.catalog,
          onboarding,
        });
      } catch (error) {
        if (error?.code === "OPENBOT_PROVIDER_SNAPSHOT_STALE") throw error;
        if (error && typeof error === "object") error.code = "OPENBOT_PROVIDER_SNAPSHOT_INVALID";
        throw error;
      }
    }

    function markProviderRefreshFailure() {
      if (mountDisposed) return false;
      if (!providerAuthorityHasCommit) providerAuthorityInvalid = true;
      else providerAuthorityRetryable = true;
      providerAuthorityLoaded = true;
      providerCatalogLoaded = true;
      providerOnboardingLoaded = true;
      updateConnectionPresentation(lastSnapshot);
      return false;
    }

    function refreshProviderAuthority() {
      if (mountDisposed || !providerFacade || providerFacadeInvalid) return Promise.resolve(false);
      providerRefreshTicket += 1;
      if (providerRefreshFlight) {
        return providerRefreshFlight;
      }
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const deferred = Object.freeze({ promise, resolve, reject });
      // Install the sentinel before starting the pump. The facade may invoke
      // a subscription synchronously while its snapshot method is called.
      providerRefreshFlight = promise;
      providerRefreshDeferred = deferred;
      const pump = async () => {
        try {
          while (!mountDisposed) {
            const requestTicket = providerRefreshTicket;
            let snapshot;
            try {
              snapshot = await readProviderSnapshot();
            } catch (error) {
              if (mountDisposed) break;
              if (providerRefreshTicket !== requestTicket) continue;
              if (error?.code === "OPENBOT_PROVIDER_SNAPSHOT_STALE" && providerOnboarding !== null) {
                deferred.resolve(markProviderRefreshFailure());
              } else {
                deferred.resolve(markProviderRefreshFailure());
              }
              return;
            }
            if (mountDisposed) break;
            commitProviderSnapshot(snapshot);
            if (providerRefreshTicket !== requestTicket) continue;
            deferred.resolve(true);
            return;
          }
          deferred.resolve(false);
        } catch (error) {
          deferred.reject(error);
        } finally {
          if (providerRefreshFlight === promise) {
            providerRefreshFlight = null;
            if (!mountDisposed) updateConnectionPresentation(lastSnapshot);
          }
          if (providerRefreshDeferred === deferred) providerRefreshDeferred = null;
        }
      };
      void pump();
      return promise;
    }

    function beginProviderOperation(providerId, first, entry, kind = "connect") {
      if (mountDisposed || !providerFacade || providerFacadeInvalid || providerOperations.has(providerId)) return null;
      if (providerId === "openai-codex") clearProviderLoginPrompt();
      const operation = Object.freeze({ providerId, first, entry, kind, sequence: ++providerActionSequence });
      providerOperations.set(providerId, operation);
      providerPending.add(providerId);
      return operation;
    }

    function currentProviderOperation(operation) {
      return !mountDisposed && providerOperations.get(operation.providerId) === operation;
    }

    function currentProviderDetail(first, providerId) {
      const surface = first ? providerSurfaces.first : providerSurfaces.settings;
      return surface.selectedProviderId === providerId ? surface.detail : null;
    }

    function setProviderError(first, providerId, message) {
      providerErrors.set(`${first ? "first" : "settings"}:${providerId}`, message);
    }

    function clearProviderError(first, providerId) {
      providerErrors.delete(`${first ? "first" : "settings"}:${providerId}`);
    }

    async function providerAction(providerId, first = false) {
      if (mountDisposed || !providerFacade || providerFacadeInvalid || providerPending.has(providerId)) return;
      const surface = first ? providerSurfaces.first : providerSurfaces.settings;
      const entry = surface.detail;
      if (!entry || entry.providerId !== providerId
        || surface.selectedProviderId !== providerId
        || entry.action.disabled
        || typeof providerFacade.connect !== "function") return;
      const receiptRetry = first && providerReceiptRetry.has(providerId);
      const current = providerConnection(providerId);
      const legacyConfirmation = first && current.state === "connected"
        && !receiptRetry && providerOnboarding === null
        && providerCatalog.models.some((model) => model.provider === providerId);
      const shouldConnect = !receiptRetry && !legacyConfirmation;
      let request;
      if (shouldConnect) {
        try {
          request = requestForProvider(providerId, entry);
        } catch (error) {
          const message = providerErrorCopy(providerId, error);
          setProviderError(first, providerId, message);
          const currentEntry = currentProviderDetail(first, providerId) ?? entry;
          currentEntry.error.textContent = message;
          currentEntry.error.hidden = false;
          currentEntry.action.focus?.();
          return;
        }
      }
      const operation = beginProviderOperation(providerId, first, entry);
      if (!operation) return;
      clearProviderError(first, providerId);
      const activeEntry = currentProviderDetail(first, providerId);
      if (activeEntry) activeEntry.error.hidden = true;
      updateConnectionPresentation(lastSnapshot);
      let failed = false;
      let receiptAttempted = false;
      let receiptAcknowledged = false;
      let expectedReceipt = null;
      try {
        if (shouldConnect) {
          await providerFacade.connect(request);
          if (!currentProviderOperation(operation)) return;
        }
        if (!await refreshProviderAuthority()) throw new Error("Provider authority is unavailable.");
        if (!currentProviderOperation(operation)) return;
        const connection = providerConnection(providerId);
        if (connection.state !== "connected") throw new Error("Provider connection is not ready.");
        if (first) {
          if (typeof providerFacade.completeOnboarding !== "function") throw new Error("Provider onboarding is unavailable.");
          receiptAttempted = true;
          const returnedReceipt = await providerFacade.completeOnboarding(providerId);
          receiptAcknowledged = true;
          if (!currentProviderOperation(operation)) return;
          if (!await refreshProviderAuthority()) {
            // completeOnboarding() is the durable commit acknowledgement. A
            // following snapshot failure is stale publication, not a receipt
            // write failure and must not create a Finish setup retry.
            clearProviderError(first, providerId);
            const activeEntry = currentProviderDetail(first, providerId);
            if (activeEntry) activeEntry.error.hidden = true;
            return;
          }
          if (!currentProviderOperation(operation)) return;
          expectedReceipt = normalizeProviderOnboarding(
            returnedReceipt,
            providerConnections,
            providerCatalog,
          );
          if (!providerReceiptsEqual(providerOnboarding, expectedReceipt)) {
            throw new Error("Provider onboarding is unavailable.");
          }
          providerReceiptRetry.delete(providerId);
        }
      } catch (error) {
        if (receiptAcknowledged) {
          if (!providerAuthorityRetryable) markProviderRefreshFailure();
          clearProviderError(first, providerId);
          const activeEntry = currentProviderDetail(first, providerId);
          if (activeEntry) activeEntry.error.hidden = true;
          failed = false;
        } else {
          failed = true;
          if (currentProviderOperation(operation)) {
            const connectedAfterReceiptFailure = first && receiptAttempted
              && providerConnection(providerId).state === "connected";
            const message = connectedAfterReceiptFailure
              ? `${providerConnection(providerId).label} is connected, but first-connection setup could not be saved. Try again.`
              : providerErrorCopy(providerId, error);
            setProviderError(first, providerId, message);
            const currentEntry = currentProviderDetail(first, providerId);
            if (connectedAfterReceiptFailure) {
              providerReceiptRetry.add(providerId);
            }
            if (currentEntry) {
              currentEntry.error.textContent = message;
              currentEntry.error.hidden = false;
            }
            currentEntry?.action.focus?.();
          }
        }
      } finally {
        const ownsOperation = providerOperations.get(providerId) === operation;
        if (ownsOperation) {
          providerOperations.delete(providerId);
          providerPending.delete(providerId);
          clearProviderLoginPrompt(operation);
        }
        if (ownsOperation && !mountDisposed) {
          updateConnectionPresentation(lastSnapshot);
          if (failed) currentProviderDetail(first, providerId)?.action.focus?.();
        }
      }
    }

    async function disconnectProvider(providerId) {
      if (mountDisposed || !providerFacade || typeof providerFacade.disconnect !== "function"
        || providerFacadeInvalid || providerPending.has(providerId)) return;
      const surface = providerSurfaces.settings;
      const entry = surface.detail;
      if (!entry || entry.providerId !== providerId || surface.selectedProviderId !== providerId) return;
      const operation = beginProviderOperation(providerId, false, entry, "disconnect");
      if (!operation) return;
      clearProviderError(false, providerId);
      const activeEntry = currentProviderDetail(false, providerId);
      if (activeEntry) activeEntry.error.hidden = true;
      updateConnectionPresentation(lastSnapshot);
      try {
        await providerFacade.disconnect(providerId);
        if (!currentProviderOperation(operation)) return;
        if (!await refreshProviderAuthority()) throw new Error("Provider authority is unavailable.");
        if (!currentProviderOperation(operation)) return;
        if (providerConnection(providerId).state === "connected") {
          throw new Error("Provider disconnect is not confirmed.");
        }
      } catch (error) {
        if (currentProviderOperation(operation)) {
          const message = providerErrorCopy(providerId, error).replace("connected", "disconnected");
          setProviderError(false, providerId, message);
          const currentEntry = currentProviderDetail(false, providerId);
          if (currentEntry) {
            currentEntry.error.textContent = message;
            currentEntry.error.hidden = false;
            currentEntry.action.focus?.();
          }
        }
      } finally {
        const ownsOperation = providerOperations.get(providerId) === operation;
        if (ownsOperation) {
          providerOperations.delete(providerId);
          providerPending.delete(providerId);
          clearProviderLoginPrompt(operation);
        }
        if (ownsOperation && !mountDisposed) updateConnectionPresentation(lastSnapshot);
      }
    }

    function setDialogOpen(dialog, open) {
      if (open) {
        dialog.hidden = false;
        if (typeof dialog.showModal === "function" && dialog.open !== true) {
          try { dialog.showModal(); } catch {}
        }
        return;
      }
      if (typeof dialog.close === "function" && dialog.open === true) {
        try { dialog.close(); } catch {}
      }
      dialog.hidden = true;
    }

    function paintPower(snapshot, { enteredUltra = snapshot.enteredUltra } = {}) {
      if (!snapshot.stops.length) return;
      const retainsUltraEntry = !enteredUltra
        && warningTimer != null
        && warningScope === currentPowerScope
        && snapshot.effect === "ultra";
      updateReasoningView(reasoningView, snapshot.stops, snapshot.previewIndex, {
        enteredUltra: enteredUltra || retainsUltraEntry,
        endpointLabelsVisible: snapshot.endpointLabelsVisible,
      });
      reasoning.disabled = snapshot.disabled;
      reasoningView.control.classList.toggle("is-disabled", snapshot.disabled);
      modelDock.classList.toggle("is-fast", snapshot.effect === "fast");
      modelDock.classList.toggle("is-max", snapshot.effect === "max");
      modelDock.classList.toggle("is-ultra", snapshot.effect === "ultra");
      modelDock.classList.toggle("is-ultra-code", snapshot.selection?.effort === "ultra-code");
      modelDock.classList.toggle("is-holding", snapshot.endpointLabelsVisible);
      modelDock.classList.toggle("is-warning", !reasoningView.warning.hidden);
      if (!retainsUltraEntry && warningTimer != null) {
        (windowRef.clearTimeout || clearTimeout)(warningTimer);
        warningTimer = null;
        warningScope = null;
      }
      if (enteredUltra) {
        warningScope = currentPowerScope;
        const scope = warningScope;
        const timer = (windowRef.setTimeout || setTimeout)(() => {
          if (warningTimer !== timer || warningScope !== scope) return;
          reasoningView.control.classList.remove("is-ultra-entering");
          reasoningView.warning.hidden = true;
          modelDock.classList.remove("is-warning");
          warningTimer = null;
          warningScope = null;
        }, 2000);
        warningTimer = timer;
      }
    }

    function paintFast(active) {
      fastToggle.classList.toggle("is-active", active);
      fastToggle.setAttribute("aria-pressed", String(active));
      fastToggle.setAttribute("aria-label", active ? "Use Standard speed" : "Use Fast speed");
      modelDock.classList.toggle("has-fast-tier", active);
    }

    const advancedRowForKind = (kind) => ({
      model: advancedModel.row,
      effort: advancedEffort.row,
      speed: advancedSpeed.row,
    })[kind] ?? null;

    function closeAdvancedFlyout({ restoreFocus = false } = {}) {
      if (advancedFlyoutKind === null) return;
      const owner = advancedFlyoutOwner;
      advancedFlyout.hidden = true;
      advancedFlyout.dataset.kind = "";
      advancedFlyoutKind = null;
      advancedFlyoutOwner = null;
      for (const row of [advancedModel.row, advancedEffort.row, advancedSpeed.row]) {
        row.setAttribute("aria-expanded", "false");
      }
      advancedFlyoutOptions.replaceChildren();
      if (restoreFocus) owner?.focus?.();
    }

    function renderAdvanced(next, preferredSelection) {
      const powerSelection = powerState.snapshot().selection;
      const identity = preferredSelection
        ?? (next.modelSelection && {
          provider: next.modelSelection.provider,
          model: next.modelSelection.model,
        })
        ?? (powerSelection && {
          provider: powerSelection.provider,
          model: powerSelection.model,
        })
        ?? next.modelCatalog[0];
      const options = MODEL_CONTROLS.buildAdvancedOptions(next.modelCatalog, identity);
      const current = options.models.find((entry) => entry.provider === identity?.provider
        && entry.model === identity?.model) ?? options.models[0];
      advancedOptions = options;
      advancedModelIdentities = new Map(options.models.map((entry) => [entry.key, Object.freeze({
        provider: entry.provider,
        model: entry.model,
      })]));
      const catalog = next.modelCatalog.find((entry) => entry.provider === current?.provider
        && entry.model === current?.model);
      const authoritative = next.modelSelection?.provider === current?.provider
        && next.modelSelection?.model === current?.model;
      const preferred = preferredSelection?.provider === current?.provider
        && preferredSelection?.model === current?.model;
      const effort = preferred && typeof preferredSelection.effort === "string"
        ? preferredSelection.effort
        : authoritative
          ? next.modelSelection.reasoningEffort
          : catalog?.defaultReasoningEffort ?? options.efforts[0]?.effort;
      const serviceTier = preferred && Object.hasOwn(preferredSelection, "serviceTier")
        ? preferredSelection.serviceTier
        : authoritative
          ? next.modelSelection.serviceTier
          : catalog?.defaultServiceTier ?? null;
      const effortOption = options.efforts.find((entry) => entry.effort === effort)
        ?? options.efforts[0] ?? null;
      const speedOption = options.speeds.find((entry) => entry.serviceTier === serviceTier)
        ?? options.speeds[0] ?? null;
      advancedSelection = current && effortOption && speedOption ? Object.freeze({
        provider: current.provider,
        model: current.model,
        effort: effortOption.effort,
        serviceTier: speedOption.serviceTier,
      }) : null;
      advancedModel.value.textContent = current?.label ?? "Choose model";
      advancedModel.row.dataset.key = current?.key ?? "";
      advancedModel.row.dataset.provider = current?.provider ?? "";
      advancedModel.row.dataset.model = current?.model ?? "";
      advancedModel.row.title = current?.providerLabel ?? "";
      advancedEffort.value.textContent = effortOption?.label ?? "Choose effort";
      advancedEffort.row.dataset.value = effortOption?.effort ?? "";
      advancedEffort.row.title = effortOption?.description ?? "";
      advancedSpeed.value.textContent = speedOption?.label ?? "Standard";
      advancedSpeed.row.dataset.value = speedOption?.serviceTier ?? "";
      advancedSpeed.row.title = speedOption?.description ?? "";
    }

    function submitSelectionIntent(selection, { fastTier = null } = {}) {
      const botId = lastSnapshot?.activeBotId;
      if (typeof botId !== "string" || !selection) return Promise.resolve();
      const intentSelection = Object.freeze({
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort,
        serviceTier: selection.serviceTier,
      });
      const intent = Object.freeze({
        sequence: ++selectionIntentSequence,
        botId,
        selection: intentSelection,
        fastTier,
      });
      selectionIntents.set(botId, intent);
      renderAdvanced(lastSnapshot, intentSelection);
      return controller.selectModel(
        intentSelection.provider,
        intentSelection.model,
        intentSelection.effort,
        intentSelection.serviceTier,
      ).then(() => {
        if (selectionIntents.get(botId) !== intent || lastSnapshot?.activeBotId !== botId) return;
        selectionIntents.delete(botId);
        render(controller.snapshot());
      }).catch(() => {
        if (selectionIntents.get(botId) !== intent) return;
        selectionIntents.delete(botId);
        if (lastSnapshot?.activeBotId === botId) {
          return controller.selectBot(botId, true).catch(() => render(controller.snapshot()));
        }
      });
    }

    function selectAdvancedOption(kind, entry) {
      if (!lastSnapshot || !advancedSelection) return;
      let nextSelection = null;
      if (kind === "model") {
        const identity = advancedModelIdentities.get(entry.key);
        const descriptor = identity && lastSnapshot.modelCatalog.find((candidate) => (
          candidate.provider === identity.provider && candidate.model === identity.model
        ));
        if (!descriptor) return;
        const projected = MODEL_CONTROLS.buildAdvancedOptions(lastSnapshot.modelCatalog, identity);
        const effort = projected.efforts.some((candidate) => (
          candidate.effort === descriptor.defaultReasoningEffort
        )) ? descriptor.defaultReasoningEffort : projected.efforts[0]?.effort;
        const serviceTier = projected.speeds.some((candidate) => (
          candidate.serviceTier === descriptor.defaultServiceTier
        )) ? descriptor.defaultServiceTier : null;
        nextSelection = MODEL_CONTROLS.resolveAdvancedSelection(lastSnapshot.modelCatalog, {
          provider: identity.provider,
          model: identity.model,
          effort,
          serviceTier,
        });
      } else if (kind === "effort") {
        nextSelection = MODEL_CONTROLS.resolveAdvancedSelection(lastSnapshot.modelCatalog, {
          ...advancedSelection,
          effort: entry.effort,
        });
      } else if (kind === "speed") {
        nextSelection = MODEL_CONTROLS.resolveAdvancedSelection(lastSnapshot.modelCatalog, {
          ...advancedSelection,
          serviceTier: entry.serviceTier,
        });
      }
      if (!nextSelection) return;
      renderAdvanced(lastSnapshot, nextSelection);
      closeAdvancedFlyout({ restoreFocus: true });
      void submitSelectionIntent(nextSelection);
    }

    function openAdvancedFlyout(kind) {
      const owner = advancedRowForKind(kind);
      if (!owner || owner.disabled || !advancedOptions || !advancedSelection) return;
      closeAdvancedFlyout();
      const entries = kind === "model"
        ? advancedOptions.models
        : kind === "effort" ? advancedOptions.efforts : advancedOptions.speeds;
      advancedFlyoutKind = kind;
      advancedFlyoutOwner = owner;
      advancedFlyout.dataset.kind = kind;
      owner.setAttribute("aria-expanded", "true");
      advancedFlyoutTitle.textContent = kind === "model" ? "Model" : kind === "effort" ? "Effort" : "Speed";
      advancedFlyout.style.width = kind === "model" ? "280px" : kind === "effort" ? "180px" : "233px";
      const optionNodes = entries.map((entry) => {
        const option = element(documentRef, "button", "codex-power-flyout-option");
        option.type = "button";
        option.setAttribute("role", "menuitemradio");
        const selected = kind === "model"
          ? entry.provider === advancedSelection.provider && entry.model === advancedSelection.model
          : kind === "effort"
            ? entry.effort === advancedSelection.effort
            : entry.serviceTier === advancedSelection.serviceTier;
        option.setAttribute("aria-checked", String(selected));
        option.tabIndex = selected ? 0 : -1;
        if (kind === "model") {
          option.dataset.key = entry.key;
          option.dataset.value = entry.key;
        } else option.dataset.value = kind === "effort" ? entry.effort : entry.serviceTier ?? "__standard__";
        const copy = element(documentRef, "span", "codex-power-flyout-option-copy");
        copy.append(
          element(documentRef, "span", "codex-power-flyout-option-label", entry.label),
          element(
            documentRef,
            "span",
            "codex-power-flyout-option-description",
            kind === "model" ? entry.providerLabel ?? "" : entry.description ?? "",
          ),
        );
        const check = element(documentRef, "span", "codex-power-flyout-option-check", selected ? "✓" : "");
        check.setAttribute("aria-hidden", "true");
        option.append(copy, check);
        const choose = () => selectAdvancedOption(kind, entry);
        advancedOptionActions.set(option, choose);
        option.addEventListener("click", choose);
        return option;
      });
      advancedFlyoutOptions.replaceChildren(...optionNodes);
      advancedFlyout.hidden = false;
      positionPowerSurfaces();
      (optionNodes.find((option) => option.tabIndex === 0) ?? optionNodes[0])?.focus?.();
    }

    function populateNewBotSetup(next) {
      const draft = next.profileSetup;
      const providers = [];
      const providerLabels = new Map();
      for (const entry of next.modelCatalog) {
        if (!providers.includes(entry.provider)) providers.push(entry.provider);
        if (!providerLabels.has(entry.provider)) providerLabels.set(entry.provider, entry.providerLabel);
      }
      newBotProvider.replaceChildren(...providers.map((provider) => {
        const label = providerLabels.get(provider) || PROVIDER_LABELS[provider] || provider;
        const option = element(documentRef, "option", "", label);
        option.value = provider;
        return option;
      }));
      newBotProvider.value = draft.provider ?? "";
      const models = next.modelCatalog.filter((entry) => entry.provider === draft.provider);
      newBotModel.replaceChildren(...models.map((entry) => {
        const option = element(documentRef, "option", "", entry.label);
        option.value = entry.model;
        return option;
      }));
      newBotModel.value = draft.model ?? "";
      const descriptor = models.find((entry) => entry.model === draft.model) ?? null;
      newBotPower.replaceChildren(...(descriptor?.efforts ?? []).map((effort) => {
        const option = element(documentRef, "option", "", EFFORT_LABELS[effort] ?? effort);
        option.value = effort;
        return option;
      }));
      newBotPower.value = draft.reasoningEffort ?? "";
      const standard = element(documentRef, "option", "", "Standard");
      standard.value = "__standard__";
      newBotSpeed.replaceChildren(standard, ...(descriptor?.serviceTiers ?? []).map((tier) => {
        const option = element(documentRef, "option", "", tier.name);
        option.value = tier.id;
        option.title = tier.description;
        return option;
      }));
      newBotSpeed.value = draft.serviceTier ?? "__standard__";
      newBotName.value = draft.name;
      newBotDescription.value = draft.description;
      newBotShape.value = draft.shape;
      newBotColor.value = draft.color;
      newBotPhotoPreview.src = draft.image ?? "";
      newBotPhotoPreview.hidden = draft.image === null;
      newBotPhotoPick.textContent = draft.image === null ? "Add a Bot photo" : "Change Bot photo";
      newBotPhotoRemove.hidden = draft.image === null;
      const error = draft.error ?? newBotPhotoError;
      newBotSetupError.textContent = error ?? "";
      newBotSetupError.hidden = error == null;
      const valid = draft.name.trim().length > 0 && descriptor
        && descriptor.provider === draft.provider && descriptor.model === draft.model
        && descriptor.efforts.includes(draft.reasoningEffort)
        && (draft.serviceTier === null
          || descriptor.serviceTiers.some((entry) => entry.id === draft.serviceTier));
      newBotContinue.disabled = draft.pending || !valid;
      newBotContinue.textContent = draft.pending ? "Setting up…" : "Continue";
      for (const control of [
        newBotPhoto, newBotPhotoPick, newBotPhotoRemove, newBotName, newBotDescription, newBotShape,
        newBotColor, newBotProvider, newBotModel, newBotPower, newBotSpeed,
      ]) control.disabled = draft.pending;
    }

    function render(next) {
      if (mountDisposed) return;
      const previousSnapshot = lastSnapshot;
      lastSnapshot = next;
      synchronizeLocalDesktop(next);
      updateConnectionPresentation(next);
      const liveBotIds = new Set(next.bots.map((record) => record.botId));
      for (const botId of selectionIntents.keys()) {
        if (!liveBotIds.has(botId)) selectionIntents.delete(botId);
      }
      const selected = next.activeBot;
      botSelect.replaceChildren();
      for (const record of next.bots) {
        const option = element(documentRef, "option", "", record.name);
        option.value = record.botId;
        option.selected = record.botId === next.activeBotId;
        botSelect.append(option);
      }
      botSelect.disabled = next.creationPending || next.profileSetup.open
        || (next.computerSetup.open && !next.computerSetup.dismissible);
      newButton.disabled = next.creationPending || next.mandatorySetupPending
        || next.profileSetup.open || next.computerSetup.open;
      creationAlert.textContent = next.creationError ?? "";
      creationAlert.hidden = next.creationError == null;
      rename.value = selected?.name ?? "";
      rename.disabled = selected == null || next.selectionPending || next.profileSetup.open;
      renameButton.disabled = rename.disabled;
      status.textContent = next.runtime.label;
      status.dataset.tone = next.runtime.tone;
      retry.hidden = !next.runtime.retryVisible;
      retry.disabled = !next.runtime.retryVisible;
      computerStatus.textContent = next.computer.label;
      computerStatus.dataset.tone = next.computer.tone;
      computerChange.disabled = selected == null || next.selectionPending
        || next.mandatorySetupPending || next.computerSetup.open;
      computerGrants.hidden = selected == null || next.permissions.length === 0;
      computerGrantsList.replaceChildren(...next.permissions.map((grant) => {
        const row = element(documentRef, "div", "codex-computer-grant");
        const copy = element(documentRef, "div", "codex-computer-grant-copy");
        copy.append(
          element(documentRef, "strong", "codex-computer-grant-label", grant.resourceLabel),
          element(
            documentRef,
            "span",
            "codex-computer-grant-capability",
            grant.capability.replaceAll(".", " "),
          ),
        );
        const revoke = element(documentRef, "button", "codex-computer-grant-revoke", "Revoke");
        revoke.type = "button";
        revoke.setAttribute(
          "aria-label",
          `Revoke ${grant.capability.replaceAll(".", " ")} access to ${grant.resourceLabel}`,
        );
        revoke.addEventListener("click", () => {
          revoke.disabled = true;
          void controller.revokeComputerPermission(grant.grantId)
            .catch(() => render(controller.snapshot()));
        });
        row.append(copy, revoke);
        return row;
      }));
      const profileOpening = next.profileSetup.open && !previousSnapshot?.profileSetup?.open;
      const profileClosing = !next.profileSetup.open && previousSnapshot?.profileSetup?.open;
      if (profileOpening) newBotSetupReturnFocus = documentRef.activeElement ?? newButton;
      if (!nativeProtocolMode) {
        populateNewBotSetup(next);
        setDialogOpen(newBotSetup, next.profileSetup.open);
        newBotSetup.setAttribute("aria-busy", String(next.profileSetup.pending));
        if (profileOpening) newBotName.focus?.();
      }
      const setupOpening = next.computerSetup.open && !previousSnapshot?.computerSetup?.open;
      const setupClosing = !next.computerSetup.open && previousSnapshot?.computerSetup?.open;
      if (setupOpening) {
        setupReturnFocus = profileClosing
          ? (newBotSetupReturnFocus ?? newButton)
          : (documentRef.activeElement ?? newButton);
        if (profileClosing) newBotSetupReturnFocus = null;
      } else if (profileClosing) {
        newBotSetupReturnFocus?.focus?.();
        newBotSetupReturnFocus = null;
      }
      setDialogOpen(computerSetup, next.computerSetup.open);
      computerSetup.setAttribute("aria-busy", String(next.computerSetup.pending));
      for (const [mode, input] of computerChoiceInputs) {
        input.checked = next.computerSetup.selectedMode === mode;
        input.disabled = next.computerSetup.pending;
      }
      computerContinue.disabled = next.computerSetup.pending || next.computerSetup.selectedMode == null;
      computerContinue.textContent = next.computerSetup.pending ? "Setting up…" : "Continue";
      computerCancel.hidden = !next.computerSetup.dismissible;
      computerCancel.disabled = next.computerSetup.pending;
      if (setupOpening) {
        computerChoiceInputs.values().next().value?.focus?.();
      }
      const prompt = next.permissionRequest;
      const permissionOpening = prompt != null && previousSnapshot?.permissionRequest?.requestId !== prompt.requestId;
      const permissionDecisionSettled = prompt != null
        && previousSnapshot?.permissionRequest?.requestId === prompt.requestId
        && previousSnapshot.permissionDecisionPending
        && !next.permissionDecisionPending;
      const permissionClosing = prompt == null && previousSnapshot?.permissionRequest != null;
      if (prompt != null && previousSnapshot?.permissionRequest == null) {
        permissionReturnFocus = documentRef.activeElement ?? computerStatus;
      }
      setDialogOpen(permissionSheet, prompt != null);
      permissionSheet.setAttribute("aria-busy", String(next.permissionDecisionPending));
      for (const button of [permissionDeny, permissionOnce, permissionAlways]) {
        button.disabled = next.permissionDecisionPending;
      }
      if (prompt) {
        const shell = prompt.capability === "shell.execute";
        permissionTitle.textContent = `Allow ${selected?.name ?? "this bot"} to use ${prompt.resourceLabel}?`;
        permissionReason.textContent = prompt.reason;
        permissionCapability.textContent = prompt.capability.replaceAll(".", " ");
        permissionCommand.textContent = shell ? prompt.command : "";
        permissionCommand.hidden = !shell;
        permissionAlways.hidden = shell;
        permissionAlways.disabled = shell || next.permissionDecisionPending;
      } else {
        permissionTitle.textContent = "Computer permission";
        permissionReason.textContent = "";
        permissionCapability.textContent = "";
        permissionCommand.textContent = "";
        permissionCommand.hidden = true;
        permissionAlways.hidden = false;
      }
      if ((permissionOpening || permissionDecisionSettled) && !next.permissionDecisionPending) {
        permissionDeny.focus?.();
      } else if (permissionClosing) {
        const target = setupClosing ? (setupReturnFocus ?? permissionReturnFocus) : permissionReturnFocus;
        target?.focus?.();
        permissionReturnFocus = null;
        if (setupClosing) setupReturnFocus = null;
      } else if (setupClosing && prompt != null) {
        permissionReturnFocus = setupReturnFocus ?? permissionReturnFocus;
        setupReturnFocus = null;
      } else if (setupClosing) {
        setupReturnFocus?.focus?.();
        setupReturnFocus = null;
      }
      const enabled = selected != null && !next.selectionPending
        && !next.profileSetup.open && next.modelCatalog.length > 0;
      const selectedTuple = next.modelSelection ? {
        provider: next.modelSelection.provider,
        model: next.modelSelection.model,
        effort: next.modelSelection.reasoningEffort,
        serviceTier: next.modelSelection.serviceTier,
        catalogGeneration: next.modelSelection.catalogGeneration,
      } : null;
      const stops = MODEL_CONTROLS.buildPowerStops(next.modelCatalog, selectedTuple);
      const selectedIndex = selectedTuple ? MODEL_CONTROLS.closestPowerStop(stops, selectedTuple) : 0;
      const compactSelectedStop = selectedTuple ? stops.find((stop) => (
        stop.provider === selectedTuple.provider
        && stop.model === selectedTuple.model
        && stop.effort === selectedTuple.effort
        && stop.serviceTier === selectedTuple.serviceTier
        && stop.catalogGeneration === selectedTuple.catalogGeneration
      )) : null;
      const ownerKey = `${next.activeBotId ?? "none"}:${next.modelSelection?.generation ?? "pending"}:${stops[0]?.catalogGeneration ?? 0}`;
      currentPowerScope = `${next.activeBotId ?? "none"}:${next.selectionEpoch}`;
      let power = powerState.setStops(stops, selectedIndex, { ownerKey });
      power = powerState.setDisabled(!enabled);
      compactProjectionPending = Boolean(selectedTuple && power.selection
        && (power.selection.provider !== selectedTuple.provider
          || power.selection.model !== selectedTuple.model
          || power.selection.effort !== selectedTuple.effort
          || power.selection.serviceTier !== selectedTuple.serviceTier
          || power.selection.catalogGeneration !== selectedTuple.catalogGeneration));
      if (power.stops.length) paintPower(power, { enteredUltra: false });
      const visibleSelection = next.selectionPending
        ? null
        : next.modelSelection ? {
        provider: next.modelSelection.provider,
        model: next.modelSelection.model,
        effort: next.modelSelection.reasoningEffort,
        serviceTier: next.modelSelection.serviceTier,
        catalogGeneration: next.modelSelection.catalogGeneration,
        label: compactSelectedStop?.label
          ?? EFFORT_LABELS[next.modelSelection.reasoningEffort]
          ?? next.modelSelection.reasoningEffort,
        effect: isUltraEffect(next.modelSelection.reasoningEffort)
          ? "ultra"
          : next.modelSelection.reasoningEffort === "max"
            ? "max"
            : "ordinary",
        } : power.selection;
      const visibleModel = next.modelCatalog.find((entry) => entry.provider === visibleSelection?.provider
        && entry.model === visibleSelection?.model);
      triggerModel.textContent = visibleModel?.label
        ?? visibleModel?.displayName
        ?? visibleSelection?.model
        ?? "Choose model";
      triggerEffort.textContent = visibleSelection?.label ?? "";
      triggerEffort.classList.toggle("is-max", visibleSelection?.effect === "max");
      triggerEffort.classList.toggle("is-ultra", visibleSelection?.effect === "ultra");
      modelTrigger.disabled = !enabled;
      if (!enabled && !popover.hidden) setPopoverOpen(false);
      const speedOptions = visibleSelection
        ? MODEL_CONTROLS.buildAdvancedOptions(next.modelCatalog, visibleSelection).speeds
        : [];
      activeFastTier = MODEL_CONTROLS.findFastServiceTier(speedOptions);
      const selectionIntent = selectionIntents.get(next.activeBotId);
      const desiredServiceTier = selectionIntent
        && selectionIntent.selection.provider === visibleSelection?.provider
        && selectionIntent.selection.model === visibleSelection?.model
        && selectionIntent.selection.effort === visibleSelection?.effort
        && selectionIntent.fastTier === activeFastTier
        ? selectionIntent.selection.serviceTier
        : visibleSelection?.serviceTier;
      const fastActive = Boolean(activeFastTier
        && desiredServiceTier === activeFastTier);
      fastToggle.hidden = advancedViewExpanded || !activeFastTier;
      fastToggle.disabled = !enabled || !activeFastTier;
      paintFast(fastActive);
      advancedToggle.disabled = !enabled;
      advancedModel.row.disabled = !enabled;
      advancedEffort.row.disabled = !enabled;
      advancedSpeed.row.disabled = !enabled;
      renderAdvanced(next, selectionIntent?.selection);
      positionPowerSurfaces();
    }

    controller = createBotUiController({
      facade,
      runtimeFacade: windowRef.codexRuntime,
      accountFacade: windowRef.codexAccount,
      providerFacade,
      catalogAuthorityManaged: nativeProtocolMode && providerFacade !== null,
      computerFacade: windowRef.openbotComputer,
      nativeMode: nativeProtocolMode,
      onStateChanged: render,
      onSelectionChanged(botId) {
        panel.dataset.activeBotId = botId ?? "";
        windowRef.dispatchEvent?.(new windowRef.CustomEvent("codex-bot-selection-changing"));
      },
      onRuntimeEvent(event) {
        windowRef.dispatchEvent?.(new windowRef.CustomEvent("codex-bot-runtime-event", { detail: event }));
      },
    });
    const updateSetup = (patch) => {
      newBotPhotoError = null;
      try { controller.updateNewBotSetup(patch); }
      catch { render(controller.snapshot()); }
    };
    newBotName.addEventListener("input", () => updateSetup({ name: newBotName.value }));
    newBotDescription.addEventListener("input", () => updateSetup({ description: newBotDescription.value }));
    newBotShape.addEventListener("change", () => updateSetup({ shape: newBotShape.value }));
    newBotColor.addEventListener("change", () => updateSetup({ color: newBotColor.value }));
    newBotProvider.addEventListener("change", () => updateSetup({ provider: newBotProvider.value }));
    newBotModel.addEventListener("change", () => updateSetup({ model: newBotModel.value }));
    newBotPower.addEventListener("change", () => updateSetup({ reasoningEffort: newBotPower.value }));
    newBotSpeed.addEventListener("change", () => updateSetup({
      serviceTier: newBotSpeed.value === "__standard__" ? null : newBotSpeed.value,
    }));
    newBotPhotoPick.addEventListener("click", () => newBotPhoto.click?.());
    newBotPhoto.addEventListener("change", () => {
      const file = newBotPhoto.files?.[0] ?? null;
      newBotPhotoError = null;
      void readLocalPngFile(file, windowRef.FileReader).then((image) => {
        if (!mountDisposed) updateSetup({ image });
      }).catch(() => {
        if (mountDisposed) return;
        newBotPhotoError = "Choose a valid PNG smaller than 2 MB.";
        render(controller.snapshot());
      });
    });
    newBotPhotoRemove.addEventListener("click", () => updateSetup({ image: null }));
    const submitNewBotSetup = () => {
      void controller.confirmNewBotSetup().catch(() => render(controller.snapshot()));
    };
    newBotContinue.addEventListener("click", submitNewBotSetup);
    newBotSetup.addEventListener("cancel", (event) => event.preventDefault?.());
    newBotSetup.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey) || newBotContinue.disabled) return;
      event.preventDefault?.();
      submitNewBotSetup();
    });
    botSelect.addEventListener("change", () => {
      try {
        const operation = controller.selectBot(botSelect.value);
        if (operation && typeof operation.catch === "function") {
          void operation.catch(() => render(controller.snapshot()));
        }
      } catch {
        render(controller.snapshot());
      }
    });
    newButton.addEventListener("click", () => void controller.createBot().catch(() => {}));
    const submitRename = () => void controller.renameActive(rename.value).catch(() => render(lastSnapshot));
    renameButton.addEventListener("click", submitRename);
    rename.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitRename();
      }
    });
    retry.addEventListener("click", () => void controller.retryActive().catch(() => {}));
    computerChange.addEventListener("click", () => {
      try { controller.openComputerSetup(); } catch {}
    });
    for (const [mode, input] of computerChoiceInputs) {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        try { controller.chooseComputerMode(mode); } catch {}
      });
    }
    computerContinue.addEventListener("click", () => {
      void controller.confirmComputerMode().catch(() => render(controller.snapshot()));
    });
    computerCancel.addEventListener("click", () => {
      try { controller.dismissComputerSetup(); } catch {}
    });
    const decidePermission = (decision) => {
      void controller.decideComputerPermission(decision).catch(() => render(controller.snapshot()));
    };
    permissionDeny.addEventListener("click", () => decidePermission("deny"));
    permissionOnce.addEventListener("click", () => decidePermission("once"));
    permissionAlways.addEventListener("click", () => decidePermission("always"));
    computerSetup.addEventListener("cancel", (event) => {
      event.preventDefault?.();
      if (lastSnapshot?.computerSetup?.pending || !lastSnapshot?.computerSetup?.dismissible) return;
      try { controller.dismissComputerSetup(); } catch {}
    });
    permissionSheet.addEventListener("cancel", (event) => {
      if (permissionSheet.hidden) return;
      event.preventDefault?.();
      if (lastSnapshot?.permissionDecisionPending) return;
      decidePermission("deny");
    });
    firstConnectionSetup.addEventListener("cancel", (event) => event.preventDefault?.());
    firstConnectionSetup.addEventListener("keydown", (event) => {
      if (event.key === "Escape") event.preventDefault?.();
    });
    firstConnectionSetup.addEventListener("pointerdown", (event) => {
      if (event.target === firstConnectionSetup) event.preventDefault?.();
    });
    firstConnectionSetup.addEventListener("close", () => {
      if (providerOnboarding === null && !mountDisposed) {
        setDialogOpen(firstConnectionSetup, true);
        providerSurfaces.first.cards.get("openai-codex")?.button.focus?.();
      }
    });

    const setPopoverOpen = (open) => {
      const next = Boolean(open) && !modelTrigger.disabled;
      popover.hidden = !next;
      modelDock.classList.toggle("is-open", next);
      modelTrigger.setAttribute("aria-expanded", String(next));
      if (!next) setAdvancedView(false);
      else {
        measurePickerViews();
        positionPowerSurfaces();
      }
    };
    const repositionPowerSurfaces = () => positionPowerSurfaces();
    windowRef.addEventListener?.("resize", repositionPowerSurfaces);
    windowRef.addEventListener?.("scroll", repositionPowerSurfaces, true);
    modelTrigger.addEventListener("click", () => setPopoverOpen(popover.hidden));
    modelDock.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || popover.hidden) return;
      event.preventDefault?.();
      setPopoverOpen(false);
      modelTrigger.focus?.();
    });
    const dismissPopover = (event) => {
      if (!advancedFlyout.hidden
        && !advancedFlyout.contains?.(event.target)
        && !advancedFlyoutOwner?.contains?.(event.target)) {
        closeAdvancedFlyout();
      }
      if (popover.hidden || modelDock.contains?.(event.target)) return;
      setPopoverOpen(false);
    };
    documentRef.addEventListener?.("pointerdown", dismissPopover);

    const commitPower = (snapshot) => {
      paintPower(snapshot);
      if ((!snapshot.changed && !compactProjectionPending) || !snapshot.selection) return;
      const selection = snapshot.selection;
      compactProjectionPending = false;
      void controller.selectModel(
        selection.provider,
        selection.model,
        selection.effort,
        selection.serviceTier,
      ).catch(() => render(controller.snapshot()));
    };
    reasoning.addEventListener("pointerdown", () => {
      if (holdTimer != null) (windowRef.clearTimeout || clearTimeout)(holdTimer);
      paintPower(powerState.pointerDown(Number(reasoning.value), Date.now()));
      holdTimer = (windowRef.setTimeout || setTimeout)(() => {
        paintPower(powerState.tick(Date.now() + 450));
        holdTimer = null;
      }, 450);
    });
    reasoning.addEventListener("input", () => {
      const snapshot = powerState.snapshot().pointerActive
        ? powerState.pointerMove(Number(reasoning.value))
        : powerState.pointerDown(Number(reasoning.value), Date.now());
      paintPower(snapshot);
    });
    reasoning.addEventListener("change", () => {
      commitPower(powerState.pointerUp(Number(reasoning.value)));
    });
    reasoning.addEventListener("pointerup", () => {
      if (holdTimer != null) {
        (windowRef.clearTimeout || clearTimeout)(holdTimer);
        holdTimer = null;
      }
      commitPower(powerState.pointerUp(Number(reasoning.value)));
    });
    reasoning.addEventListener("pointercancel", () => paintPower(powerState.pointerCancel()));
    reasoning.addEventListener("wheel", (event) => {
      event.preventDefault?.();
      commitPower(powerState.wheel(Number(event.deltaY)));
    }, { passive: false });
    reasoning.addEventListener("keydown", (event) => {
      if (!new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]).has(event.key)) return;
      event.preventDefault?.();
      commitPower(powerState.keyDown(event.key));
    });
    reasoning.addEventListener("focus", () => paintPower(powerState.setFocus(true)));
    reasoning.addEventListener("blur", () => paintPower(powerState.setFocus(false)));
    reasoning.addEventListener("mouseenter", () => paintPower(powerState.setHover(true)));
    reasoning.addEventListener("mouseleave", () => paintPower(powerState.setHover(false)));

    advancedModel.row.addEventListener("click", () => openAdvancedFlyout("model"));
    advancedEffort.row.addEventListener("click", () => openAdvancedFlyout("effort"));
    advancedSpeed.row.addEventListener("click", () => openAdvancedFlyout("speed"));
    advancedFlyout.addEventListener("keydown", (event) => {
      const options = [...advancedFlyoutOptions.children].filter((option) => !option.disabled);
      if (!options.length) return;
      const focused = options.indexOf(documentRef.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault?.();
        let index = focused < 0 ? 0 : focused;
        if (event.key === "ArrowDown") index = (index + 1) % options.length;
        else if (event.key === "ArrowUp") index = (index - 1 + options.length) % options.length;
        else if (event.key === "Home") index = 0;
        else index = options.length - 1;
        for (const [candidateIndex, option] of options.entries()) {
          option.tabIndex = candidateIndex === index ? 0 : -1;
        }
        options[index].focus?.();
        return;
      }
      if (["Enter", " "].includes(event.key) && focused >= 0) {
        event.preventDefault?.();
        advancedOptionActions.get(options[focused])?.();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault?.();
        event.stopPropagation?.();
        closeAdvancedFlyout({ restoreFocus: true });
      }
    });
    advancedToggle.addEventListener("click", () => {
      setAdvancedView(!advancedViewExpanded);
      if (advancedViewExpanded && lastSnapshot) renderAdvanced(lastSnapshot);
    });
    fastToggle.addEventListener("click", () => {
      if (!lastSnapshot || !activeFastTier) return;
      const botId = lastSnapshot.activeBotId;
      if (typeof botId !== "string") return;
      const pendingSelection = selectionIntents.get(botId)?.selection;
      const selection = pendingSelection ?? (lastSnapshot.modelSelection ? {
        provider: lastSnapshot.modelSelection.provider,
        model: lastSnapshot.modelSelection.model,
        effort: lastSnapshot.modelSelection.reasoningEffort,
        serviceTier: lastSnapshot.modelSelection.serviceTier,
      } : powerState.snapshot().selection);
      if (!selection) return;
      const desiredServiceTier = selection.serviceTier === activeFastTier ? null : activeFastTier;
      const nextSelection = Object.freeze({
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort,
        serviceTier: desiredServiceTier,
      });
      paintFast(desiredServiceTier === activeFastTier);
      void submitSelectionIntent(nextSelection, { fastTier: activeFastTier });
    });
    const retryProviderAuthority = () => {
      if (mountDisposed || (providerRefreshFlight && connectionsRetry.disabled)) return;
      void refreshProviderAuthority().catch(() => {});
      updateConnectionPresentation(lastSnapshot);
    };
    connectionsRetry.addEventListener("click", retryProviderAuthority);
    firstConnectionRetry.addEventListener("click", retryProviderAuthority);
    if (providerFacade) {
      if (typeof providerFacade.onConnectionsChanged === "function") {
        try {
          const candidate = providerFacade.onConnectionsChanged((value) => {
            if (mountDisposed) return;
            try { normalizeProviderConnections(value); } catch {}
            updateConnectionPresentation(lastSnapshot);
            void refreshProviderAuthority();
          });
          providerConnectionsUnsubscribe = typeof candidate === "function" ? candidate : null;
        } catch {}
      }
      if (typeof providerFacade.onCatalogChanged === "function") {
        try {
          const candidate = providerFacade.onCatalogChanged((value) => {
            if (mountDisposed) return;
            try { normalizeProviderCatalog(value); } catch {}
            updateConnectionPresentation(lastSnapshot);
            void refreshProviderAuthority();
          });
          providerCatalogUnsubscribe = typeof candidate === "function" ? candidate : null;
        } catch {}
      }
      if (typeof providerFacade.onLoginPrompt === "function") {
        try {
          const candidate = providerFacade.onLoginPrompt((value) => {
            if (mountDisposed) return;
            receiveProviderLoginPrompt(value);
          });
          providerLoginPromptUnsubscribe = typeof candidate === "function" ? candidate : null;
        } catch {}
      }
      void refreshProviderAuthority();
    }
    void controller.initialize().catch(() => {
      if (mountDisposed) return;
      status.textContent = "Remote computer unavailable";
      reasoning.disabled = true;
      advancedToggle.disabled = true;
      advancedModel.row.disabled = true;
      advancedEffort.row.disabled = true;
      advancedSpeed.row.disabled = true;
    });
    return Object.freeze({
      controller,
      modelDock,
      panel,
      dispose() {
        if (mountDisposed) return;
        mountDisposed = true;
        resolveProviderRefreshDisposed?.(null);
        resolveProviderRefreshDisposed = null;
        providerRefreshDeferred?.resolve(false);
        providerRefreshDeferred = null;
        mountObserver?.disconnect();
        pickerResizeObserver?.disconnect();
        surfaceResizeObserver?.disconnect();
        if (pickerTransitionFrame !== 0) {
          windowRef.cancelAnimationFrame?.(pickerTransitionFrame);
          pickerTransitionFrame = 0;
        }
        documentRef.removeEventListener?.("pointerdown", dismissPopover);
        windowRef.removeEventListener?.("resize", repositionPowerSurfaces);
        windowRef.removeEventListener?.("scroll", repositionPowerSurfaces, true);
        if (holdTimer != null) (windowRef.clearTimeout || clearTimeout)(holdTimer);
        if (warningTimer != null) (windowRef.clearTimeout || clearTimeout)(warningTimer);
        warningTimer = null;
        warningScope = null;
        providerOperations.clear();
        providerPending.clear();
        providerErrors.clear();
        clearProviderLoginPrompt();
        providerReceiptRetry.clear();
        closeAdvancedFlyout();
        selectionIntents.clear();
        try { providerConnectionsUnsubscribe?.(); } catch {}
        try { providerCatalogUnsubscribe?.(); } catch {}
        try { providerLoginPromptUnsubscribe?.(); } catch {}
        providerConnectionsUnsubscribe = null;
        providerCatalogUnsubscribe = null;
        providerLoginPromptUnsubscribe = null;
        localDesktopView?.dispose?.();
        localDesktopView = null;
        reasoningView.dispose();
        controller.dispose();
        newBotSetup.remove?.();
        computerSetup.remove?.();
        permissionSheet.remove?.();
        firstConnectionSetup.remove?.();
        nativeBotSettings.remove?.();
        connectionsSettings.remove?.();
        panel.remove?.();
        modelDock.remove?.();
      },
    });
  }

  if (typeof window === "object" && typeof document === "object") {
    window.addEventListener("DOMContentLoaded", () => mount(), { once: true });
  }

  return Object.freeze({
    EFFORT_LABELS,
    createReasoningView,
    createBotUiController,
    findUiMounts,
    mount,
    normalizeLocalPngAvatar,
    readLocalPngFile,
    runtimePresentation,
    startUltraCanvas,
    updateReasoningView,
  });
});
