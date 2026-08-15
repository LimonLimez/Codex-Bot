"use strict";

const { EventEmitter } = require("node:events");
const { types } = require("node:util");

const MAX_CATALOG_PAGES = 16;
const MAX_MODELS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const SERVICE_TIER = /^[a-z][a-z0-9_-]{0,31}$/;
const CURSOR = /^[A-Za-z0-9._~+/=-]{1,512}$/;
const USER_CODE = /^[A-Z0-9]{3,16}(?:-[A-Z0-9]{2,16})?$/;
const AUTH_MODES = new Set([
  "apikey",
  "chatgpt",
  "chatgptAuthTokens",
  "agentIdentity",
  "personalAccessToken",
  "bedrockApiKey",
]);

class CodexAccountError extends Error {
  constructor(code = "CODEX_ACCOUNT_UNAVAILABLE", message = "Codex account is unavailable.") {
    super(message);
    this.name = "CodexAccountError";
    this.code = code;
  }
}

function accountError(code, message) {
  return new CodexAccountError(code, message);
}

function plainData(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw accountError(code, "Codex response is invalid.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw accountError(code, "Codex response is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw accountError(code, "Codex response is invalid.");
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function initialAccount() {
  return deepFreeze({
    generation: 0,
    status: "starting",
    authMode: null,
    planType: null,
    requiresOpenaiAuth: true,
    login: null,
    rateLimits: null,
  });
}

function initialCatalog() {
  return deepFreeze({ generation: 0, status: "loading", models: [] });
}

function validPlanType(value) {
  return value === null || (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(value));
}

function normalizeAuthMode(value) {
  if (value === "apiKey") return "apikey";
  return typeof value === "string" && AUTH_MODES.has(value) ? value : null;
}

function rateWindow(value) {
  if (value === null || value === undefined) return null;
  const window = plainData(value, "CODEX_ACCOUNT_INVALID");
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)
    || window.usedPercent < 0 || window.usedPercent > 1000
    || !Number.isSafeInteger(window.windowDurationMins) || window.windowDurationMins <= 0
    || !Number.isSafeInteger(window.resetsAt) || window.resetsAt < 0) {
    throw accountError("CODEX_ACCOUNT_INVALID", "Codex account response is invalid.");
  }
  return deepFreeze({
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
  });
}

function normalizeRateLimits(value) {
  if (value === null || value === undefined) return null;
  const limits = plainData(value, "CODEX_ACCOUNT_INVALID");
  const reachedType = limits.rateLimitReachedType;
  if (reachedType !== null && reachedType !== undefined
    && (typeof reachedType !== "string" || reachedType.length > 64 || /[^A-Za-z0-9._-]/.test(reachedType))) {
    throw accountError("CODEX_ACCOUNT_INVALID", "Codex account response is invalid.");
  }
  return deepFreeze({
    primary: rateWindow(limits.primary),
    secondary: rateWindow(limits.secondary),
    reachedType: reachedType ?? null,
  });
}

function accountFromRead(value, previous) {
  const result = plainData(value, "CODEX_ACCOUNT_INVALID");
  if (typeof result.requiresOpenaiAuth !== "boolean") {
    throw accountError("CODEX_ACCOUNT_INVALID", "Codex account response is invalid.");
  }
  let authMode = null;
  let planType = null;
  if (result.account !== null) {
    const account = plainData(result.account, "CODEX_ACCOUNT_INVALID");
    authMode = normalizeAuthMode(account.type);
    planType = account.planType ?? null;
    if (!authMode || !validPlanType(planType)) {
      throw accountError("CODEX_ACCOUNT_INVALID", "Codex account response is invalid.");
    }
  }
  return {
    status: authMode ? "ready" : "signed-out",
    authMode,
    planType,
    requiresOpenaiAuth: result.requiresOpenaiAuth,
    login: null,
    rateLimits: authMode === "chatgpt" ? previous.rateLimits : null,
  };
}

function normalizeModel(value) {
  const raw = plainData(value, "CODEX_CATALOG_INVALID");
  if (raw.hidden === true) return null;
  if (typeof raw.id !== "string" || !MODEL_ID.test(raw.id) || raw.model !== raw.id
    || typeof raw.displayName !== "string" || raw.displayName.length < 1 || raw.displayName.length > 160
    || !Array.isArray(raw.supportedReasoningEfforts) || raw.supportedReasoningEfforts.length < 1
    || raw.supportedReasoningEfforts.length > 16
    || typeof raw.defaultReasoningEffort !== "string" || !EFFORT.test(raw.defaultReasoningEffort)) {
    throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
  }
  const efforts = [];
  const seenEfforts = new Set();
  for (const valueEntry of raw.supportedReasoningEfforts) {
    const entry = plainData(valueEntry, "CODEX_CATALOG_INVALID");
    if (typeof entry.reasoningEffort !== "string" || !EFFORT.test(entry.reasoningEffort)) {
      throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
    }
    if (!seenEfforts.has(entry.reasoningEffort)) {
      seenEfforts.add(entry.reasoningEffort);
      efforts.push(entry.reasoningEffort);
    }
  }
  if (!seenEfforts.has(raw.defaultReasoningEffort)) {
    throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
  }
  const rawServiceTiers = raw.serviceTiers === undefined ? [] : raw.serviceTiers;
  const defaultServiceTier = raw.defaultServiceTier ?? null;
  if (!Array.isArray(rawServiceTiers) || types.isProxy(rawServiceTiers)
    || rawServiceTiers.length > 16
    || !(defaultServiceTier === null
      || (typeof defaultServiceTier === "string" && SERVICE_TIER.test(defaultServiceTier)))) {
    throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
  }
  const serviceTiers = [];
  const seenServiceTiers = new Set();
  for (const valueEntry of rawServiceTiers) {
    const entry = plainData(valueEntry, "CODEX_CATALOG_INVALID");
    if (typeof entry.id !== "string" || !SERVICE_TIER.test(entry.id)
      || seenServiceTiers.has(entry.id)
      || typeof entry.name !== "string" || entry.name.trim().length < 1 || entry.name.length > 160
      || typeof entry.description !== "string" || entry.description.length > 1024) {
      throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
    }
    seenServiceTiers.add(entry.id);
    serviceTiers.push(deepFreeze({
      id: entry.id,
      name: entry.name,
      description: entry.description,
    }));
  }
  if (defaultServiceTier !== null && !seenServiceTiers.has(defaultServiceTier)) {
    throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
  }
  const rawModalities = raw.inputModalities === undefined ? ["text", "image"] : raw.inputModalities;
  if (!Array.isArray(rawModalities) || rawModalities.length < 1 || rawModalities.length > 8) {
    throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
  }
  const modalities = [];
  for (const modality of rawModalities) {
    if (!new Set(["text", "image"]).has(modality)) {
      throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
    }
    if (!modalities.includes(modality)) modalities.push(modality);
  }
  return deepFreeze({
    id: raw.id,
    displayName: raw.displayName,
    defaultReasoningEffort: raw.defaultReasoningEffort,
    defaultServiceTier,
    serviceTiers,
    supportedReasoningEfforts: efforts,
    inputModalities: modalities,
    supportsPersonality: raw.supportsPersonality === true,
    isDefault: raw.isDefault === true,
  });
}

function validLoginUrl(value, { device = false } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password
    || !new Set(["chatgpt.com", "auth.openai.com"]).has(url.hostname)) return null;
  if (device && (url.origin !== "https://auth.openai.com"
    || url.pathname !== "/codex/device" || url.search || url.hash)) return null;
  return url.href;
}

function privateLoginResult(state, openUrl) {
  const result = { state };
  if (openUrl !== undefined) {
    Object.defineProperty(result, "openUrl", {
      value: openUrl,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result);
}

class CodexAccountController extends EventEmitter {
  #manager;
  #account = initialAccount();
  #catalog = initialCatalog();
  #startFlight = null;
  #catalogFlight = null;
  #started = false;
  #disposed = false;
  #currentLogin = null;
  #loginGeneration = 0;
  #loginOperationEpoch = 0;
  #loginPending = null;
  #lifecycleEpoch = 0;
  #onNotification;
  #onReady;
  #onOffline;

  constructor(rawOptions = {}) {
    super();
    const options = plainData(rawOptions, "CODEX_ACCOUNT_INVALID");
    if (Object.keys(options).some((key) => key !== "manager")
      || !options.manager || typeof options.manager !== "object" || types.isProxy(options.manager)
      || typeof options.manager.start !== "function" || typeof options.manager.request !== "function"
      || typeof options.manager.on !== "function" || typeof options.manager.removeListener !== "function") {
      throw accountError("CODEX_ACCOUNT_INVALID", "Codex account controller is invalid.");
    }
    this.#manager = options.manager;
    this.#onNotification = (message) => this.#handleNotification(message);
    this.#onReady = () => {
      if (this.#started && !this.#disposed && !this.#startFlight) void this.refresh().catch(() => {});
    };
    this.#onOffline = () => this.#markOffline();
    this.#manager.on("notification", this.#onNotification);
    this.#manager.on("ready", this.#onReady);
    this.#manager.on("offline", this.#onOffline);
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Observers cannot affect account or catalog state.
      }
    }
    return true;
  }

  accountState() {
    return this.#account;
  }

  catalogState() {
    return this.#catalog;
  }

  start() {
    if (this.#disposed) return Promise.reject(accountError("CODEX_ACCOUNT_DISPOSED", "Codex account was disposed."));
    if (this.#started) return Promise.resolve();
    if (this.#startFlight) return this.#startFlight;
    let flight;
    const epoch = this.#lifecycleEpoch;
    flight = this.#start(epoch).finally(() => {
      if (this.#startFlight === flight) this.#startFlight = null;
    });
    this.#startFlight = flight;
    return flight;
  }

  async #start(epoch) {
    try {
      await this.#manager.start();
      this.#assertLifecycle(epoch);
      await this.refresh(epoch);
      this.#assertLifecycle(epoch);
      this.#started = true;
    } catch (error) {
      if (error instanceof CodexAccountError) throw error;
      this.#markOffline();
      throw accountError("CODEX_ACCOUNT_UNAVAILABLE", "Codex account is unavailable.");
    }
  }

  #assertLifecycle(epoch) {
    if (this.#disposed) throw accountError("CODEX_ACCOUNT_DISPOSED", "Codex account was disposed.");
    if (epoch !== this.#lifecycleEpoch) {
      throw accountError("CODEX_ACCOUNT_SUPERSEDED", "Codex account operation was superseded.");
    }
  }

  async refresh(epoch = this.#lifecycleEpoch) {
    this.#assertLifecycle(epoch);
    let read;
    try { read = await this.#manager.request("account/read", { refreshToken: false }); }
    catch { this.#markOffline(); throw accountError("CODEX_ACCOUNT_UNAVAILABLE", "Codex account is unavailable."); }
    this.#assertLifecycle(epoch);
    const next = accountFromRead(read, this.#account);
    if (next.authMode === "chatgpt") {
      try {
        const rateResult = plainData(
          await this.#manager.request("account/rateLimits/read"),
          "CODEX_ACCOUNT_INVALID",
        );
        this.#assertLifecycle(epoch);
        next.rateLimits = normalizeRateLimits(rateResult.rateLimits);
      } catch (error) {
        if (error instanceof CodexAccountError) throw error;
        next.rateLimits = null;
      }
    }
    this.#assertLifecycle(epoch);
    this.#publishAccount(next);
    await this.#refreshCatalog(epoch);
    this.#assertLifecycle(epoch);
    return deepFreeze({ account: this.#account, catalog: this.#catalog });
  }

  #publishAccount(value) {
    this.#account = deepFreeze({
      generation: this.#account.generation + 1,
      status: value.status,
      authMode: value.authMode,
      planType: value.planType,
      requiresOpenaiAuth: value.requiresOpenaiAuth,
      login: value.login,
      rateLimits: value.rateLimits,
    });
    this.emit("account-changed", this.#account);
  }

  #publishCatalog(status, models) {
    this.#catalog = deepFreeze({
      generation: this.#catalog.generation + 1,
      status,
      models,
    });
    this.emit("catalog-changed", this.#catalog);
  }

  #refreshCatalog(epoch = this.#lifecycleEpoch) {
    if (this.#catalogFlight?.epoch === epoch) return this.#catalogFlight.promise;
    if (this.#catalogFlight) {
      return Promise.reject(accountError("CODEX_ACCOUNT_SUPERSEDED", "Codex catalog operation was superseded."));
    }
    let flight;
    flight = this.#readCatalog(epoch).finally(() => {
      if (this.#catalogFlight?.promise === flight) this.#catalogFlight = null;
    });
    this.#catalogFlight = { epoch, promise: flight };
    return flight;
  }

  async #readCatalog(epoch) {
    const models = new Map();
    const cursors = new Set();
    let cursor = null;
    try {
      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        const result = plainData(await this.#manager.request("model/list", {
          cursor,
          limit: 100,
          includeHidden: false,
        }), "CODEX_CATALOG_INVALID");
        this.#assertLifecycle(epoch);
        if (!Array.isArray(result.data) || result.data.length > MAX_MODELS
          || !(result.nextCursor === null || result.nextCursor === undefined
            || (typeof result.nextCursor === "string" && CURSOR.test(result.nextCursor)))) {
          throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
        }
        for (const rawModel of result.data) {
          const candidate = normalizeModel(rawModel);
          if (candidate && !models.has(candidate.id)) models.set(candidate.id, candidate);
          if (models.size > MAX_MODELS) throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
        }
        const next = result.nextCursor ?? null;
        if (next === null) break;
        if (cursors.has(next)) throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
        cursors.add(next);
        cursor = next;
        if (page === MAX_CATALOG_PAGES - 1) throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
      }
      if (models.size === 0) throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
      this.#assertLifecycle(epoch);
      this.#publishCatalog("ready", [...models.values()]);
      return this.#catalog;
    } catch (error) {
      if (this.#disposed || epoch !== this.#lifecycleEpoch) throw error;
      this.#publishCatalog("unavailable", []);
      if (error instanceof CodexAccountError) throw error;
      throw accountError("CODEX_CATALOG_INVALID", "Codex catalog is invalid.");
    }
  }

  async login(mode) {
    if (this.#disposed) throw accountError("CODEX_ACCOUNT_DISPOSED", "Codex account was disposed.");
    if (!new Set(["browser", "device-code"]).has(mode) || this.#currentLogin || this.#loginPending !== null) {
      throw accountError("CODEX_LOGIN_INVALID", "Codex login is unavailable.");
    }
    const operationEpoch = ++this.#loginOperationEpoch;
    this.#loginPending = operationEpoch;
    await this.start();
    let result;
    try {
      result = plainData(await this.#manager.request("account/login/start", mode === "browser"
        ? { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" }
        : { type: "chatgptDeviceCode" }), "CODEX_LOGIN_INVALID");
    } finally {
      if (this.#loginPending === operationEpoch) this.#loginPending = null;
    }
    if (typeof result.loginId !== "string" || !UUID.test(result.loginId)) {
      throw accountError("CODEX_LOGIN_INVALID", "Codex login is unavailable.");
    }
    if (this.#disposed || operationEpoch !== this.#loginOperationEpoch) {
      try { await this.#manager.request("account/login/cancel", { loginId: result.loginId }); } catch { /* Late login stays private. */ }
      throw accountError("CODEX_LOGIN_SUPERSEDED", "Codex login was superseded.");
    }
    let publicLogin;
    let openUrl;
    if (mode === "browser") {
      openUrl = validLoginUrl(result.authUrl);
      if (result.type !== "chatgpt" || !openUrl) {
        throw accountError("CODEX_LOGIN_INVALID", "Codex login is unavailable.");
      }
      publicLogin = deepFreeze({ mode: "browser" });
    } else {
      const verificationUrl = validLoginUrl(result.verificationUrl, { device: true });
      if (result.type !== "chatgptDeviceCode" || !verificationUrl
        || typeof result.userCode !== "string" || !USER_CODE.test(result.userCode)) {
        throw accountError("CODEX_LOGIN_INVALID", "Codex login is unavailable.");
      }
      publicLogin = deepFreeze({ mode: "device-code", verificationUrl, userCode: result.userCode });
    }
    const generation = ++this.#loginGeneration;
    this.#currentLogin = Object.freeze({ loginId: result.loginId, generation, mode });
    this.#publishAccount({
      ...this.#account,
      status: "signing-in",
      login: publicLogin,
    });
    return privateLoginResult(this.#account, openUrl);
  }

  async cancelLogin() {
    if (this.#disposed) throw accountError("CODEX_ACCOUNT_DISPOSED", "Codex account was disposed.");
    this.#loginOperationEpoch += 1;
    this.#loginPending = null;
    const current = this.#currentLogin;
    if (!current) return this.#account;
    await this.#manager.request("account/login/cancel", { loginId: current.loginId });
    if (this.#currentLogin !== current) return this.#account;
    this.#currentLogin = null;
    this.#loginGeneration += 1;
    this.#publishAccount({
      ...this.#account,
      status: this.#account.authMode ? "ready" : "signed-out",
      login: null,
    });
    return this.#account;
  }

  async logout() {
    if (this.#disposed) throw accountError("CODEX_ACCOUNT_DISPOSED", "Codex account was disposed.");
    this.#loginOperationEpoch += 1;
    this.#loginPending = null;
    await this.start();
    await this.#manager.request("account/logout");
    this.#currentLogin = null;
    this.#loginGeneration += 1;
    this.#publishAccount({
      status: "signed-out",
      authMode: null,
      planType: null,
      requiresOpenaiAuth: this.#account.requiresOpenaiAuth,
      login: null,
      rateLimits: null,
    });
    return this.#account;
  }

  #handleNotification(rawMessage) {
    if (this.#disposed || !rawMessage || typeof rawMessage !== "object" || types.isProxy(rawMessage)) return;
    let message;
    try { message = plainData(rawMessage, "CODEX_ACCOUNT_INVALID"); } catch { return; }
    if (message.method === "account/login/completed") {
      let params;
      try { params = plainData(message.params, "CODEX_LOGIN_INVALID"); } catch { return; }
      const current = this.#currentLogin;
      if (!current || params.loginId !== current.loginId || typeof params.success !== "boolean") return;
      this.#currentLogin = null;
      this.#loginGeneration += 1;
      this.#loginOperationEpoch += 1;
      if (params.success) {
        void this.refresh().catch(() => this.#markOffline());
      } else {
        this.#publishAccount({
          status: "signed-out",
          authMode: null,
          planType: null,
          requiresOpenaiAuth: this.#account.requiresOpenaiAuth,
          login: null,
          rateLimits: null,
        });
      }
      return;
    }
    if (message.method === "account/updated") {
      let params;
      try { params = plainData(message.params, "CODEX_ACCOUNT_INVALID"); } catch { return; }
      const authMode = params.authMode === null ? null : normalizeAuthMode(params.authMode);
      const planType = params.planType ?? null;
      if ((params.authMode !== null && !authMode) || !validPlanType(planType)) return;
      if (authMode) this.#currentLogin = null;
      if (authMode) {
        this.#loginOperationEpoch += 1;
        this.#loginPending = null;
      }
      this.#publishAccount({
        ...this.#account,
        status: authMode ? "ready" : "signed-out",
        authMode,
        planType,
        login: authMode ? null : this.#account.login,
        rateLimits: authMode === "chatgpt" ? this.#account.rateLimits : null,
      });
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      let params;
      try { params = plainData(message.params, "CODEX_ACCOUNT_INVALID"); } catch { return; }
      try {
        this.#publishAccount({
          ...this.#account,
          rateLimits: normalizeRateLimits(params.rateLimits),
        });
      } catch { /* Invalid remote rate state cannot replace the current state. */ }
      return;
    }
    if (message.method === "model/list/updated") void this.#refreshCatalog().catch(() => {});
  }

  #markOffline() {
    if (this.#disposed) return;
    this.#lifecycleEpoch += 1;
    this.#started = false;
    this.#currentLogin = null;
    this.#loginGeneration += 1;
    this.#loginOperationEpoch += 1;
    this.#loginPending = null;
    this.#publishAccount({
      status: "offline",
      authMode: null,
      planType: null,
      requiresOpenaiAuth: this.#account.requiresOpenaiAuth,
      login: null,
      rateLimits: null,
    });
    this.#publishCatalog("unavailable", []);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycleEpoch += 1;
    this.#currentLogin = null;
    this.#loginOperationEpoch += 1;
    this.#loginPending = null;
    this.#manager.removeListener("notification", this.#onNotification);
    this.#manager.removeListener("ready", this.#onReady);
    this.#manager.removeListener("offline", this.#onOffline);
    this.removeAllListeners();
  }
}

module.exports = {
  CodexAccountController,
  CodexAccountError,
};
