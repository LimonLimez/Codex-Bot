"use strict";

const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { types } = require("node:util");

const { loadPackagedCodexRuntime } = require("./codex-runtime-integrity.cjs");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_FRAME_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 65_536;
const MAX_PENDING_REQUESTS = 128;
const MAX_TIMED_OUT_IDS = 128;
const MAX_PREINIT_NOTIFICATIONS = 128;
const MAX_PREINIT_NOTIFICATION_BYTES = 65_536;
const MAX_DYNAMIC_TOOL_REQUESTS = 128;
const MAX_METHOD_BYTES = 256;
const MAX_DEPTH = 32;
const MAX_COLLECTION_ITEMS = 8_192;
const METHOD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const DISABLED_LOCAL_FEATURES = Object.freeze([
  "apps",
  "apps_mcp_path_override",
  "apply_patch_freeform",
  "apply_patch_streaming_events",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_buffered_exec",
  "code_mode_host",
  "code_mode_only",
  "codex_git_commit",
  "computer_use",
  "default_mode_request_user_input",
  "deferred_executor",
  "deferred_tool_world_state",
  "enable_fanout",
  "enable_mcp_apps",
  "exec_permission_approvals",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "goals",
  "guardian_approval",
  "guardianv2",
  "hooks",
  "image_generation",
  "in_app_browser",
  "js_repl",
  "js_repl_tools_only",
  "mcp_2026_07_28",
  "memories",
  "multi_agent",
  "multi_agent_mode",
  "multi_agent_v2",
  "non_prefixed_mcp_tool_names",
  "plugin_hooks",
  "plugin_sharing",
  "plugins",
  "recommended_plugins",
  "remote_control",
  "remote_plugin",
  "request_permissions_tool",
  "request_rule",
  "search_tool",
  "shell_snapshot",
  "shell_tool",
  "shell_zsh_fork",
  "skill_env_var_dependency_prompt",
  "skill_mcp_dependency_install",
  "skill_search",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "tool_suggest",
  "unavailable_dummy_tools",
  "unified_exec",
  "unified_exec_zsh_fork",
  "view_image",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies",
]);

class CodexAppServerError extends Error {
  constructor(code = "CODEX_APP_SERVER_UNAVAILABLE", message = "Codex is unavailable.") {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

function codexError(code, message) {
  return new CodexAppServerError(code, message);
}

function plainOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw codexError("CODEX_CONFIGURATION_INVALID", "Codex configuration is invalid.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw codexError("CODEX_CONFIGURATION_INVALID", "Codex configuration is invalid.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]))) {
    throw codexError("CODEX_CONFIGURATION_INVALID", "Codex configuration is invalid.");
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function exactKeys(value, allowed, errorCode = "CODEX_CONFIGURATION_INVALID") {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) {
    throw codexError(errorCode, errorCode === "CODEX_PAYLOAD_INVALID"
      ? "Codex payload is invalid."
      : "Codex configuration is invalid.");
  }
}

function absolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && value.length <= 4096 && !value.includes("\0");
}

function validClientVersion(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value);
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sensitiveIncomingKey(value) {
  const key = normalizedKey(value);
  if (["tokenusage", "lasttokenusage", "tokenusagebreakdown", "inputtokens", "outputtokens", "totaltokens"].includes(key)) {
    return false;
  }
  return key === "session"
    || key === "endpoint"
    || key.includes("authorization")
    || key.includes("password")
    || key.includes("credential")
    || key.includes("secret")
    || key.includes("cookie")
    || key.includes("accesstoken")
    || key.includes("authtoken")
    || key.includes("refreshtoken")
    || key.includes("idtoken")
    || key.includes("bearertoken")
    || key.includes("apikey")
    || key.includes("providerdiagnostic");
}

function cloneJson(value, { sanitize = false, depth = 0, seen = new Set() } = {}) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || types.isProxy(value) || depth > MAX_DEPTH || seen.has(value)) {
    throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => key === "length"
      ? !("value" in descriptors[key])
      : typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || !("value" in descriptors[key]))) {
      throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
    }
    result = value.map((item) => cloneJson(item, { sanitize, depth: depth + 1, seen }));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_COLLECTION_ITEMS
      || keys.some((key) => typeof key !== "string" || !("value" in descriptors[key]) || !descriptors[key].enumerable)) {
      throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
    }
    result = {};
    for (const key of keys) {
      if (sanitize && sensitiveIncomingKey(key)) continue;
      result[key] = cloneJson(descriptors[key].value, { sanitize, depth: depth + 1, seen });
    }
  }
  seen.delete(value);
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function freezeIncoming(value) {
  return deepFreeze(cloneJson(value, { sanitize: true }));
}

function launchEnvironment({ environment, homeDirectory, stateRoot }) {
  const lang = typeof environment.LANG === "string"
    && /^[A-Za-z0-9._@-]{1,64}$/.test(environment.LANG)
    ? environment.LANG
    : "C.UTF-8";
  return Object.freeze({
    CODEX_HOME: path.join(homeDirectory, ".codex"),
    HOME: homeDirectory,
    LANG: lang,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: path.join(stateRoot, "tmp"),
  });
}

function launchArguments() {
  return Object.freeze([
    ...DISABLED_LOCAL_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-c",
    "mcp_servers={}",
    "app-server",
    "--stdio",
  ]);
}

function prepareDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw codexError("CODEX_STATE_UNAVAILABLE", "Codex state is unavailable.");
  }
  fs.chmodSync(directory, 0o700);
}

function validateChild(child) {
  if (!child || typeof child !== "object" || types.isProxy(child)
    || !child.stdin || typeof child.stdin.write !== "function"
    || !child.stdout || typeof child.stdout.on !== "function"
    || !child.stderr || typeof child.stderr.on !== "function"
    || typeof child.on !== "function") {
    throw codexError("CODEX_PROCESS_ERROR", "Codex could not start.");
  }
  return child;
}

class CodexAppServerManager extends EventEmitter {
  #resourcesPath;
  #stateRoot;
  #homeDirectory;
  #environment;
  #clientVersion;
  #loadRuntime;
  #spawn;
  #setTimeout;
  #clearTimeout;
  #active = null;
  #starting = null;
  #state = "idle";
  #initialized = false;
  #generation = 0;
  #nextRequestId = 1;
  #pending = new Map();
  #dynamicToolRequests = new Map();
  #timedOutIds = new Set();

  constructor(rawOptions = {}) {
    super();
    const options = plainOptions(rawOptions);
    exactKeys(options, [
      "resourcesPath",
      "stateRoot",
      "homeDirectory",
      "environment",
      "clientVersion",
      "loadRuntime",
      "spawnImpl",
      "setTimeout",
      "clearTimeout",
    ]);
    const environment = options.environment === undefined ? process.env : plainOptions(options.environment);
    if (!absolutePath(options.resourcesPath)
      || !absolutePath(options.stateRoot)
      || !absolutePath(options.homeDirectory)
      || !validClientVersion(options.clientVersion || "0.2.0-macos.1")
      || (options.loadRuntime !== undefined && typeof options.loadRuntime !== "function")
      || (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function")
      || (options.setTimeout !== undefined && typeof options.setTimeout !== "function")
      || (options.clearTimeout !== undefined && typeof options.clearTimeout !== "function")) {
      throw codexError("CODEX_CONFIGURATION_INVALID", "Codex configuration is invalid.");
    }
    this.#resourcesPath = options.resourcesPath;
    this.#stateRoot = options.stateRoot;
    this.#homeDirectory = options.homeDirectory;
    this.#environment = environment;
    this.#clientVersion = options.clientVersion || "0.2.0-macos.1";
    this.#loadRuntime = options.loadRuntime || loadPackagedCodexRuntime;
    this.#spawn = options.spawnImpl || childProcess.spawn;
    this.#setTimeout = options.setTimeout || setTimeout;
    this.#clearTimeout = options.clearTimeout || clearTimeout;
  }

  get state() {
    return this.#state;
  }

  get initialized() {
    return this.#initialized;
  }

  get generation() {
    return this.#generation;
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {
        // Observers cannot change the process or protocol outcome.
      }
    }
    return true;
  }

  start() {
    if (this.#initialized && this.#active && !this.#active.terminal) return Promise.resolve();
    if (this.#starting) return this.#starting.promise;
    const epoch = ++this.#generation;
    this.#state = "connecting";
    this.#initialized = false;
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const starting = { epoch, promise, resolve, reject, settled: false };
    this.#starting = starting;
    void this.#beginStart(starting);
    return promise;
  }

  async #beginStart(starting) {
    let runtime;
    try {
      runtime = await this.#loadRuntime(this.#resourcesPath);
      if (!runtime || typeof runtime !== "object" || types.isProxy(runtime)
        || !absolutePath(runtime.binaryPath) || runtime.version !== "0.147.0") {
        throw new Error("invalid runtime");
      }
    } catch {
      this.#failBeforeProcess(starting, codexError("CODEX_RUNTIME_UNAVAILABLE", "Codex runtime is unavailable."));
      return;
    }
    if (!this.#isStarting(starting)) return;

    const workspace = path.join(this.#stateRoot, "empty-workspace");
    const temporary = path.join(this.#stateRoot, "tmp");
    let child;
    let spawnedChild;
    try {
      prepareDirectory(this.#stateRoot);
      prepareDirectory(workspace);
      prepareDirectory(temporary);
      spawnedChild = this.#spawn(runtime.binaryPath, [...launchArguments()], {
        cwd: workspace,
        env: launchEnvironment({
          environment: this.#environment,
          homeDirectory: this.#homeDirectory,
          stateRoot: this.#stateRoot,
        }),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child = validateChild(spawnedChild);
    } catch {
      try { spawnedChild?.kill?.("SIGTERM"); } catch { /* Invalid children stay fenced. */ }
      this.#failBeforeProcess(starting, codexError("CODEX_PROCESS_ERROR", "Codex could not start."));
      return;
    }
    if (!this.#isStarting(starting)) {
      try { child.kill?.("SIGTERM"); } catch { /* Stale child is already fenced. */ }
      return;
    }

    const active = {
      child,
      epoch: starting.epoch,
      terminal: false,
      stdout: Buffer.alloc(0),
      stderrBytes: 0,
      detach: [],
      preinitNotifications: [],
      preinitNotificationBytes: 0,
    };
    this.#active = active;
    try {
      this.#listen(active, child.stdout, "data", (chunk) => this.#handleStdout(active, chunk));
      this.#listen(active, child.stderr, "data", (chunk) => this.#handleStderr(active, chunk));
      this.#listen(active, child, "error", () => this.#terminal(
        active,
        codexError("CODEX_PROCESS_ERROR", "Codex process failed."),
      ));
      this.#listen(active, child, "exit", () => this.#terminal(
        active,
        codexError("CODEX_PROCESS_EXITED", "Codex disconnected."),
        { kill: false },
      ));
      await this.#sendRequest(active, "initialize", {
        clientInfo: { name: "openbot", title: "OpenBot", version: this.#clientVersion },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      }, DEFAULT_TIMEOUT_MS);
      if (!this.#isCurrent(active) || !this.#isStarting(starting)) return;
      this.#write(active, { method: "initialized" });
      if (!this.#isCurrent(active) || !this.#isStarting(starting)) return;
      this.#initialized = true;
      this.#state = "ready";
      this.#starting = null;
      starting.settled = true;
      starting.resolve();
      this.emit("ready", deepFreeze({ generation: active.epoch, state: "ready" }));
      for (const notification of active.preinitNotifications.splice(0)) {
        this.emit("notification", notification);
      }
      active.preinitNotificationBytes = 0;
    } catch (error) {
      if (!this.#isCurrent(active)) return;
      const safe = error instanceof CodexAppServerError
        ? error
        : codexError("CODEX_INITIALIZE_FAILED", "Codex initialization failed.");
      this.#terminal(active, safe);
    }
  }

  #isStarting(starting) {
    return this.#starting === starting && !starting.settled && this.#generation === starting.epoch;
  }

  #isCurrent(active) {
    return this.#active === active && !active.terminal && this.#generation === active.epoch;
  }

  #failBeforeProcess(starting, error) {
    if (!this.#isStarting(starting)) return;
    this.#starting = null;
    this.#state = "offline";
    starting.settled = true;
    starting.reject(error);
    this.emit("offline", error);
  }

  #listen(active, target, eventName, listener) {
    target.on(eventName, listener);
    active.detach.push(() => target.removeListener?.(eventName, listener));
  }

  request(method, params, rawOptions = {}) {
    const safeMethod = this.#validateMethod(method);
    const options = plainOptions(rawOptions);
    exactKeys(options, ["timeoutMs"]);
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw codexError("CODEX_CONFIGURATION_INVALID", "Codex request options are invalid.");
    }
    const safeParams = params === undefined ? undefined : cloneJson(params);
    const active = this.#active;
    if (!this.#initialized || !active || !this.#isCurrent(active) || this.#state !== "ready") {
      return Promise.reject(codexError("CODEX_NOT_READY", "Codex is not ready."));
    }
    return this.#sendRequest(active, safeMethod, safeParams, timeoutMs);
  }

  #validateMethod(method) {
    if (typeof method !== "string" || Buffer.byteLength(method) > MAX_METHOD_BYTES || !METHOD_PATTERN.test(method)) {
      throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
    }
    return method;
  }

  #sendRequest(active, method, params, timeoutMs) {
    if (this.#pending.size >= MAX_PENDING_REQUESTS || !Number.isSafeInteger(this.#nextRequestId)) {
      return Promise.reject(codexError("CODEX_REQUEST_CAPACITY", "Codex request capacity was exceeded."));
    }
    const id = this.#nextRequestId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    const serialized = this.#serialize(message);
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry = { active, resolve, reject, timer: null };
    try {
      entry.timer = this.#setTimeout(() => {
        if (this.#pending.get(id) !== entry) return;
        this.#pending.delete(id);
        this.#rememberTimedOutId(id);
        entry.reject(codexError("CODEX_REQUEST_TIMEOUT", "Codex request timed out."));
      }, timeoutMs);
      entry.timer?.unref?.();
    } catch {
      reject(codexError("CODEX_TIMER_ERROR", "Codex timer failed."));
      return promise;
    }
    if (!this.#isCurrent(active)) {
      this.#cancelTimer(entry.timer);
      reject(codexError("CODEX_NOT_READY", "Codex is not ready."));
      return promise;
    }
    this.#pending.set(id, entry);
    try {
      this.#writeSerialized(active, serialized);
    } catch (error) {
      if (this.#pending.get(id) === entry) {
        this.#pending.delete(id);
        this.#cancelTimer(entry.timer);
        reject(error);
      }
    }
    return promise;
  }

  #rememberTimedOutId(id) {
    if (this.#timedOutIds.size >= MAX_TIMED_OUT_IDS) {
      this.#timedOutIds.delete(this.#timedOutIds.values().next().value);
    }
    this.#timedOutIds.add(id);
  }

  #cancelTimer(timer) {
    if (timer === null || timer === undefined) return;
    try { this.#clearTimeout(timer); } catch { /* Terminal cleanup stays fail closed. */ }
  }

  #serialize(message) {
    let serialized;
    try { serialized = `${JSON.stringify(message)}\n`; } catch {
      throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
    }
    if (Buffer.byteLength(serialized) > MAX_FRAME_BYTES) {
      throw codexError("CODEX_PAYLOAD_INVALID", "Codex payload is invalid.");
    }
    return serialized;
  }

  #write(active, message) {
    this.#writeSerialized(active, this.#serialize(message));
  }

  #writeSerialized(active, serialized) {
    if (!this.#isCurrent(active)) throw codexError("CODEX_NOT_READY", "Codex is not ready.");
    let accepted;
    try { accepted = active.child.stdin.write(serialized); } catch {
      const error = codexError("CODEX_TRANSPORT_ERROR", "Codex transport failed.");
      this.#terminal(active, error);
      throw error;
    }
    if (accepted !== true) {
      const error = codexError("CODEX_TRANSPORT_BACKPRESSURE", "Codex transport capacity was exceeded.");
      this.#terminal(active, error);
      throw error;
    }
  }

  declineDynamicToolCall(id) {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw codexError("CODEX_DYNAMIC_TOOL_UNAVAILABLE", "Codex tool request is unavailable.");
    }
    const entry = this.#dynamicToolRequests.get(id);
    if (!entry || !this.#isCurrent(entry.active)) {
      throw codexError("CODEX_DYNAMIC_TOOL_UNAVAILABLE", "Codex tool request is unavailable.");
    }
    this.#dynamicToolRequests.delete(id);
    this.#cancelTimer(entry.timer);
    this.#write(entry.active, {
      id,
      result: { contentItems: [], success: false },
    });
  }

  #handleStdout(active, rawChunk) {
    if (!this.#isCurrent(active)) return;
    let chunk;
    try {
      chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    } catch {
      this.#protocolFailure(active);
      return;
    }
    active.stdout = active.stdout.length === 0 ? chunk : Buffer.concat([active.stdout, chunk]);
    for (;;) {
      const newline = active.stdout.indexOf(0x0a);
      if (newline < 0) break;
      let line = active.stdout.subarray(0, newline);
      active.stdout = active.stdout.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0 || line.length > MAX_FRAME_BYTES) {
        this.#protocolFailure(active, line.length > MAX_FRAME_BYTES);
        return;
      }
      let message;
      try {
        const text = UTF8_DECODER.decode(line);
        message = JSON.parse(text);
      } catch {
        this.#protocolFailure(active);
        return;
      }
      this.#route(active, message, line.length);
      if (!this.#isCurrent(active)) return;
    }
    if (active.stdout.length > MAX_FRAME_BYTES) this.#protocolFailure(active, true);
  }

  #handleStderr(active, rawChunk) {
    if (!this.#isCurrent(active)) return;
    let bytes;
    try { bytes = Buffer.isBuffer(rawChunk) ? rawChunk.length : Buffer.byteLength(String(rawChunk)); } catch { bytes = MAX_STDERR_BYTES + 1; }
    active.stderrBytes += bytes;
    if (active.stderrBytes > MAX_STDERR_BYTES) {
      this.#terminal(active, codexError("CODEX_DIAGNOSTIC_CAPACITY", "Codex diagnostics exceeded the safe limit."));
    }
  }

  #route(active, rawMessage, frameBytes) {
    let message;
    try {
      message = cloneJson(rawMessage);
      if (!message || Array.isArray(message)) throw new Error("shape");
    } catch {
      this.#protocolFailure(active);
      return;
    }
    const keys = Object.keys(message);
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    const hasEmittedAt = Object.hasOwn(message, "emittedAtMs");

    if (hasId && (hasResult || hasError)) {
      if (!Number.isSafeInteger(message.id) || message.id <= 0 || hasMethod || hasResult === hasError
        || keys.length !== 2) {
        this.#protocolFailure(active);
        return;
      }
      const entry = this.#pending.get(message.id);
      if (!entry) {
        if (this.#timedOutIds.delete(message.id)) return;
        this.#protocolFailure(active);
        return;
      }
      if (entry.active !== active) return;
      this.#pending.delete(message.id);
      this.#cancelTimer(entry.timer);
      if (hasError) entry.reject(codexError("CODEX_REQUEST_FAILED", "Codex request failed."));
      else {
        try { entry.resolve(freezeIncoming(message.result)); }
        catch {
          entry.reject(codexError("CODEX_PROTOCOL_ERROR", "Codex protocol failed."));
          this.#protocolFailure(active);
        }
      }
      return;
    }

    if (hasId && hasMethod) {
      if (!Number.isSafeInteger(message.id) || message.id < 0 || typeof message.method !== "string"
        || !METHOD_PATTERN.test(message.method) || hasResult || hasError
        || keys.some((key) => !["id", "method", "params"].includes(key))) {
        this.#protocolFailure(active);
        return;
      }
      if (message.method === "item/tool/call"
        && this.rawListeners("dynamic-tool-call").length > 0
        && this.#dynamicToolRequests.size < MAX_DYNAMIC_TOOL_REQUESTS) {
        let dynamicRequest;
        try { dynamicRequest = deepFreeze(cloneJson(message)); }
        catch {
          this.#protocolFailure(active);
          return;
        }
        const entry = { active, timer: null };
        entry.timer = this.#setTimeout(() => {
          if (this.#dynamicToolRequests.get(message.id) !== entry) return;
          try { this.declineDynamicToolCall(message.id); } catch {}
        }, DEFAULT_TIMEOUT_MS);
        entry.timer?.unref?.();
        this.#dynamicToolRequests.set(message.id, entry);
        this.emit("dynamic-tool-call", dynamicRequest);
        return;
      }
      try {
        this.#write(active, {
          id: message.id,
          error: { code: -32601, message: "OpenBot does not permit local tool requests." },
        });
      } catch {
        // The transport terminal owns the failure.
      }
      return;
    }

    if (!hasId && hasMethod) {
      if (typeof message.method !== "string" || !METHOD_PATTERN.test(message.method) || hasResult || hasError
        || (hasEmittedAt && (!Number.isSafeInteger(message.emittedAtMs) || message.emittedAtMs < 0))
        || keys.some((key) => !["method", "params", "emittedAtMs"].includes(key))) {
        this.#protocolFailure(active);
        return;
      }
      let notification;
      try { notification = freezeIncoming(message); } catch {
        this.#protocolFailure(active);
        return;
      }
      if (!this.#initialized) {
        if (active.preinitNotifications.length >= MAX_PREINIT_NOTIFICATIONS
          || active.preinitNotificationBytes + frameBytes > MAX_PREINIT_NOTIFICATION_BYTES) {
          this.#terminal(active, codexError("CODEX_PROTOCOL_CAPACITY", "Codex protocol capacity was exceeded."));
          return;
        }
        active.preinitNotifications.push(notification);
        active.preinitNotificationBytes += frameBytes;
      } else this.emit("notification", notification);
      return;
    }

    this.#protocolFailure(active);
  }

  #protocolFailure(active, capacity = false) {
    this.#terminal(active, capacity
      ? codexError("CODEX_PROTOCOL_CAPACITY", "Codex protocol capacity was exceeded.")
      : codexError("CODEX_PROTOCOL_ERROR", "Codex protocol failed."));
  }

  #terminal(active, error, { kill = true, emitOffline = true, state = "offline" } = {}) {
    if (!this.#isCurrent(active)) return;
    active.terminal = true;
    this.#active = null;
    this.#initialized = false;
    this.#state = state;
    for (const detach of active.detach.splice(0)) {
      try { detach(); } catch { /* Cleanup cannot surface private stream state. */ }
    }
    for (const [id, entry] of [...this.#pending]) {
      if (entry.active !== active) continue;
      this.#pending.delete(id);
      this.#cancelTimer(entry.timer);
      entry.reject(error);
    }
    for (const [id, entry] of [...this.#dynamicToolRequests]) {
      if (entry.active !== active) continue;
      this.#dynamicToolRequests.delete(id);
      this.#cancelTimer(entry.timer);
    }
    const starting = this.#starting;
    if (starting && starting.epoch === active.epoch) {
      this.#starting = null;
      if (!starting.settled) {
        starting.settled = true;
        starting.reject(error);
      }
    }
    try { active.child.stdin.end?.(); } catch { /* Ignore private transport cleanup. */ }
    if (kill) {
      try { active.child.kill?.("SIGTERM"); } catch { /* Process is already terminal. */ }
    }
    if (emitOffline) this.emit("offline", error);
  }

  stop() {
    const stopped = codexError("CODEX_MANAGER_STOPPED", "Codex was stopped.");
    const active = this.#active;
    if (active && this.#isCurrent(active)) {
      this.#terminal(active, stopped, { emitOffline: false, state: "stopped" });
      return;
    }
    const starting = this.#starting;
    if (starting && !starting.settled) {
      this.#starting = null;
      starting.settled = true;
      starting.reject(stopped);
    }
    this.#initialized = false;
    this.#state = "stopped";
  }
}

module.exports = {
  CodexAppServerError,
  CodexAppServerManager,
  DISABLED_LOCAL_FEATURES,
};
