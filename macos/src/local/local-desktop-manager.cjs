"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { LocalHelperProtocol } = require("./local-helper-protocol.cjs");

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_URL_BYTES = 4096;
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET_ID_PATTERN = /^local-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTION_FIELDS = new Set([
  "botId",
  "targetId",
  "targetGeneration",
  "taskId",
  "capability",
  "operation",
  "arguments",
  "resourceId",
  "resourceLabel",
  "reason",
]);
const IDENTITY_FIELDS = new Set(["botId", "targetId", "targetGeneration"]);
const NAVIGATION_FIELDS = new Set([...IDENTITY_FIELDS, "url"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EXTERNAL_RESOURCE_CAPABILITIES = new Set([
  "filesystem.read",
  "filesystem.write",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const SECURED_BROWSER_SESSIONS = new WeakSet();

class LocalDesktopError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LocalDesktopError";
    this.code = code;
  }
}

function desktopError(message, code) {
  return new LocalDesktopError(message, code);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clonePlain(value, seen = new Set(), depth = 0) {
  if (depth > 16) throw new TypeError("Local Desktop data is oversized.");
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Local Desktop data contains an invalid number.");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("Local Desktop data must contain plain data values only.");
  if (seen.has(value)) throw new TypeError("Local Desktop data cannot contain cycles.");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Local Desktop data must use plain objects and arrays.");
  }
  let descriptors;
  let keys;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(descriptors);
  } catch {
    throw new TypeError("Local Desktop data must contain plain data values only.");
  }
  if (keys.some((key) => typeof key !== "string")) throw new TypeError("Local Desktop data cannot contain symbols.");
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key)) throw new TypeError("Local Desktop data contains a forbidden field.");
    if (!("value" in descriptors[key])) throw new TypeError("Local Desktop data must not contain accessors.");
  }
  if (array) {
    const elements = keys.filter((key) => key !== "length");
    if (elements.length !== value.length || elements.some((key, index) => key !== String(index))) {
      throw new TypeError("Local Desktop arrays must be dense.");
    }
  }
  seen.add(value);
  const copy = array ? [] : {};
  for (const key of keys) {
    if (array && key === "length") continue;
    copy[key] = clonePlain(descriptors[key].value, seen, depth + 1);
  }
  seen.delete(value);
  return copy;
}

function cloneInput(value, label) {
  try {
    return clonePlain(value);
  } catch {
    throw new TypeError(`${label} must contain plain data values only.`);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  return value;
}

function assertExactKeys(value, fields, label) {
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw new Error(`${label} contains an unsupported field.`);
  }
  for (const key of fields) {
    if (!hasOwn(value, key)) throw new Error(`${label} is missing ${key}.`);
  }
}

function normalizeBotId(value) {
  if (typeof value !== "string" || !BOT_ID_PATTERN.test(value)) throw new Error("Local Desktop bot ID is invalid.");
  return value.toLowerCase();
}

function normalizeTargetId(value) {
  if (typeof value !== "string") throw new Error("Local Desktop target ID is invalid.");
  const match = TARGET_ID_PATTERN.exec(value);
  if (!match) throw new Error("Local Desktop target ID is invalid.");
  return { targetId: value.toLowerCase(), uuid: match[1].toLowerCase() };
}

function normalizeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Local Desktop generation is invalid.");
  return value;
}

function normalizeComputer(value) {
  const input = assertPlainObject(cloneInput(value, "Local Computer"), "Local Computer");
  const botId = normalizeBotId(input.botId);
  const computer = assertPlainObject(input.computer, "Local Computer state");
  const target = normalizeTargetId(computer.localProfileId);
  if (computer.mode !== "local" || computer.state !== "ready") {
    throw desktopError("Local Computer is unavailable.", "OPENBOT_LOCAL_DESKTOP_UNAVAILABLE");
  }
  return {
    botId,
    targetId: target.targetId,
    profileUuid: target.uuid,
    targetGeneration: normalizeGeneration(computer.generation),
  };
}

function normalizeIdentity(value, fields = IDENTITY_FIELDS, label = "Local Desktop identity") {
  const input = assertPlainObject(cloneInput(value, label), label);
  assertExactKeys(input, fields, label);
  const target = normalizeTargetId(input.targetId);
  return {
    botId: normalizeBotId(input.botId),
    targetId: target.targetId,
    profileUuid: target.uuid,
    targetGeneration: normalizeGeneration(input.targetGeneration),
  };
}

function normalizeAction(value) {
  const input = assertPlainObject(cloneInput(value, "Local Desktop action"), "Local Desktop action");
  assertExactKeys(input, ACTION_FIELDS, "Local Desktop action");
  const identity = normalizeIdentity({
    botId: input.botId,
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
  });
  for (const [field, label] of [
    ["taskId", "task ID"],
    ["resourceId", "resource ID"],
  ]) {
    if (typeof input[field] !== "string" || !SAFE_ID_PATTERN.test(input[field]) || input[field].includes("..")) {
      throw new Error(`Local Desktop ${label} is invalid.`);
    }
  }
  if (typeof input.capability !== "string" || input.operation !== input.capability) {
    throw new Error("Local Desktop operation is invalid.");
  }
  for (const [field, label] of [["resourceLabel", "resource label"], ["reason", "reason"]]) {
    if (typeof input[field] !== "string" || input[field].length === 0 || input[field].trim() !== input[field]
      || Buffer.byteLength(input[field], "utf8") > 512 || /[\0-\x1f\x7f\\/]/.test(input[field])) {
      throw new Error(`Local Desktop ${label} is invalid.`);
    }
  }
  assertPlainObject(input.arguments, "Local Desktop arguments");
  return { ...input, ...identity };
}

function normalizeNavigation(value) {
  const input = assertPlainObject(cloneInput(value, "Local navigation"), "Local navigation");
  assertExactKeys(input, NAVIGATION_FIELDS, "Local navigation");
  const identity = normalizeIdentity({
    botId: input.botId,
    targetId: input.targetId,
    targetGeneration: input.targetGeneration,
  });
  return { ...identity, url: safeHttpsUrl(input.url) };
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_URL_BYTES || value.includes("\0")) {
    throw desktopError("Local navigation URL is invalid.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
  let url;
  try { url = new URL(value); } catch {
    throw desktopError("Local navigation URL is invalid.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !hostname
    || hostname === "localhost" || hostname.endsWith(".localhost") || privateIp(hostname)) {
    throw desktopError("Local navigation requires a public HTTPS URL.", "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
  return url.href;
}

function privateIp(hostname) {
  const address = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    return address === "::1" || address === "::" || /^f[cd]/i.test(address) || /^fe[89ab]/i.test(address);
  }
  return false;
}

function safeUUID(makeUUID) {
  const value = makeUUID();
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error("Generated Local Desktop UUID is invalid.");
  return value.toLowerCase();
}

function publicSession(entry) {
  return Object.freeze({
    botId: entry.botId,
    targetId: entry.targetId,
    targetGeneration: entry.targetGeneration,
    partition: entry.partition,
    workspaceId: entry.workspaceId,
    state: "ready",
  });
}

function currentBot(entry) {
  return Object.freeze({
    botId: entry.botId,
    computer: Object.freeze({
      mode: "local",
      generation: entry.targetGeneration,
      localProfileId: entry.targetId,
      state: "ready",
    }),
  });
}

class LocalDesktopManager extends EventEmitter {
  #electron;
  #userDataPath;
  #permissionBroker;
  #helperFactory;
  #randomUUID;
  #helperTimeoutMs;
  #entries = new Map();
  #profiles = new Map();
  #queues = new Map();
  #disposed = false;

  constructor({
    electron,
    userDataPath,
    permissionBroker,
    helperFactory,
    randomUUID = crypto.randomUUID,
    helperTimeoutMs = 30_000,
  } = {}) {
    super();
    if (!electron?.BrowserWindow || typeof electron?.session?.fromPartition !== "function") {
      throw new TypeError("Local Desktop manager requires Electron browser APIs.");
    }
    if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath) || userDataPath.includes("\0")) {
      throw new TypeError("Local Desktop manager requires an absolute userData path.");
    }
    if (!permissionBroker || typeof permissionBroker.request !== "function"
      || typeof permissionBroker.cancelBot !== "function") {
      throw new TypeError("Local Desktop manager requires a permission broker.");
    }
    if (typeof helperFactory !== "function" || typeof randomUUID !== "function"
      || !Number.isSafeInteger(helperTimeoutMs) || helperTimeoutMs < 1 || helperTimeoutMs > 120_000) {
      throw new TypeError("Local Desktop helper configuration is invalid.");
    }
    this.#electron = electron;
    this.#userDataPath = path.resolve(userDataPath);
    this.#permissionBroker = permissionBroker;
    this.#helperFactory = helperFactory;
    this.#randomUUID = randomUUID;
    this.#helperTimeoutMs = helperTimeoutMs;
  }

  emit(eventName, ...args) {
    const listeners = this.rawListeners(eventName);
    if (listeners.length === 0) return false;
    for (const listener of listeners) {
      try {
        const result = listener.call(this, ...args);
        void Promise.resolve(result).catch(() => {});
      } catch {}
    }
    return true;
  }

  async open(value) {
    this.#assertActive();
    const computer = normalizeComputer(value);
    return this.#enqueue(computer.botId, async () => {
      this.#assertActive();
      const existing = this.#entries.get(computer.botId);
      if (existing && this.#sameIdentity(existing, computer)) return publicSession(existing);
      if (existing) this.#closeEntry(existing, true);

      const profilePath = await this.#ensureProfile(computer.profileUuid);
      this.#assertActive();
      const partition = `persist:openbot-local-${computer.profileUuid}`;
      const browserSession = this.#electron.session.fromPartition(partition);
      this.#secureSession(browserSession);
      const window = new this.#electron.BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          session: browserSession,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
        },
      });
      let helperTransport;
      let protocol;
      try {
        this.#secureWindow(window);
        helperTransport = await this.#helperFactory(Object.freeze({
          botId: computer.botId,
          targetId: computer.targetId,
          targetGeneration: computer.targetGeneration,
          workspacePath: profilePath.workspacePath,
        }));
        this.#assertActive();
        const entry = {
          ...computer,
          partition,
          workspaceId: `workspace-${computer.profileUuid}`,
          profilePath: profilePath.profilePath,
          workspacePath: profilePath.workspacePath,
          browserSession,
          window,
          helperTransport,
          protocol: null,
        };
        protocol = new LocalHelperProtocol({
          transport: helperTransport,
          readCurrentComputer: async () => {
            const current = this.#entries.get(computer.botId);
            return current ? currentBot(current) : null;
          },
          timeoutMs: this.#helperTimeoutMs,
        });
        entry.protocol = protocol;
        this.#entries.set(computer.botId, entry);
        this.#profiles.set(computer.botId, {
          ...computer,
          partition,
          browserSession,
          profilePath: profilePath.profilePath,
          workspacePath: profilePath.workspacePath,
        });
        window.once?.("closed", () => {
          if (this.#entries.get(computer.botId) !== entry) return;
          this.#entries.delete(computer.botId);
          protocol.dispose();
          this.#permissionBroker.cancelBot(computer.botId);
        });
        return publicSession(entry);
      } catch (error) {
        try { protocol?.dispose(); } catch {}
        if (!protocol) {
          try { helperTransport?.dispose?.(); } catch {}
        }
        try { if (!window.isDestroyed?.()) window.destroy(); } catch {}
        if (error instanceof LocalDesktopError) throw error;
        throw desktopError("Local Desktop could not start.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
      }
    });
  }

  async navigate(value) {
    this.#assertActive();
    const input = normalizeNavigation(value);
    const entry = this.#requiredEntry(input);
    try {
      await entry.window.webContents.loadURL(input.url);
    } catch {
      throw desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
    }
    this.#requiredEntry(input, entry);
    return publicSession(entry);
  }

  async capture(value) {
    this.#assertActive();
    const input = normalizeIdentity(value);
    const entry = this.#requiredEntry(input);
    let image;
    try {
      image = await entry.window.webContents.capturePage();
    } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    this.#requiredEntry(input, entry);
    let size;
    let bytes;
    try {
      size = image.getSize();
      bytes = image.toPNG();
    } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height)
      || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192
      || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    const frame = Object.freeze({
      botId: entry.botId,
      targetId: entry.targetId,
      targetGeneration: entry.targetGeneration,
      frameId: `frame-${crypto.createHash("sha256").update(bytes).digest("hex")}`,
      width: size.width,
      height: size.height,
      mimeType: "image/png",
    });
    this.emit("frame", frame);
    return frame;
  }

  async run(value) {
    this.#assertActive();
    const input = normalizeAction(value);
    const entry = this.#requiredEntry(input);
    const requestId = `request-${safeUUID(this.#randomUUID)}`;
    const result = await this.#permissionBroker.request({
      botId: input.botId,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
      capability: input.capability,
      resourceId: input.resourceId,
      resourceLabel: input.resourceLabel,
      reason: input.reason,
    }, async (bookmark) => {
      this.#requiredEntry(input, entry);
      if (EXTERNAL_RESOURCE_CAPABILITIES.has(input.capability)) {
        if (typeof entry.helperTransport.authorizeResource !== "function") {
          throw desktopError("Local resource handoff is unavailable.", "OPENBOT_LOCAL_RESOURCE_UNAVAILABLE");
        }
        await entry.helperTransport.authorizeResource(requestId, Buffer.from(bookmark));
        this.#requiredEntry(input, entry);
      }
      return entry.protocol.run({
        requestId,
        botId: input.botId,
        targetId: input.targetId,
        targetGeneration: input.targetGeneration,
        taskId: input.taskId,
        capability: input.capability,
        operation: input.operation,
        arguments: input.arguments,
      });
    });
    this.#requiredEntry(input, entry);
    this.emit("result", Object.freeze({
      requestId,
      botId: entry.botId,
      targetId: entry.targetId,
      targetGeneration: entry.targetGeneration,
      taskId: input.taskId,
      ok: true,
    }));
    return result;
  }

  async close(botId) {
    const normalizedBotId = normalizeBotId(botId);
    return this.#enqueue(normalizedBotId, async () => {
      const entry = this.#entries.get(normalizedBotId);
      if (entry) this.#closeEntry(entry, true);
      else this.#permissionBroker.cancelBot(normalizedBotId);
    });
  }

  async deleteBot(botId) {
    const normalizedBotId = normalizeBotId(botId);
    return this.#enqueue(normalizedBotId, async () => {
      const entry = this.#entries.get(normalizedBotId);
      if (entry) this.#closeEntry(entry, true);
      else this.#permissionBroker.cancelBot(normalizedBotId);
      const profile = this.#profiles.get(normalizedBotId);
      if (!profile) return;
      this.#profiles.delete(normalizedBotId);
      try { await profile.browserSession.clearStorageData(); } catch {}
      const expectedRoot = path.join(this.#userDataPath, "openbot-local");
      if (path.dirname(profile.profilePath) !== expectedRoot) {
        throw desktopError("Local profile cleanup was refused.", "OPENBOT_LOCAL_CLEANUP_REFUSED");
      }
      await fs.rm(profile.profilePath, { recursive: true, force: true });
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of [...this.#entries.values()]) this.#closeEntry(entry, true);
    this.#entries.clear();
    this.#queues.clear();
    this.removeAllListeners();
  }

  #sameIdentity(entry, identity) {
    return entry.botId === identity.botId
      && entry.targetId === identity.targetId
      && entry.targetGeneration === identity.targetGeneration;
  }

  #requiredEntry(identity, expected = null) {
    this.#assertActive();
    const entry = this.#entries.get(identity.botId);
    if (!entry || (expected && entry !== expected) || !this.#sameIdentity(entry, identity)
      || entry.window.isDestroyed?.()) {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    return entry;
  }

  #closeEntry(entry, cancelPermissions) {
    if (this.#entries.get(entry.botId) === entry) this.#entries.delete(entry.botId);
    try { entry.protocol.dispose(); } catch {}
    try { if (!entry.window.isDestroyed?.()) entry.window.destroy(); } catch {}
    if (cancelPermissions) this.#permissionBroker.cancelBot(entry.botId);
  }

  async #ensureProfile(uuid) {
    const root = path.join(this.#userDataPath, "openbot-local");
    const profilePath = path.join(root, uuid);
    const workspacePath = path.join(profilePath, "workspace");
    for (const directory of [root, profilePath, workspacePath]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw desktopError("Local workspace must be a private real directory.", "OPENBOT_LOCAL_WORKSPACE_UNSAFE");
      }
      await fs.chmod(directory, 0o700);
    }
    return { profilePath, workspacePath };
  }

  #secureSession(browserSession) {
    if (!browserSession || typeof browserSession.setPermissionRequestHandler !== "function"
      || typeof browserSession.setPermissionCheckHandler !== "function") {
      throw desktopError("Local browser session is unavailable.", "OPENBOT_LOCAL_BROWSER_UNAVAILABLE");
    }
    if (SECURED_BROWSER_SESSIONS.has(browserSession)) return;
    SECURED_BROWSER_SESSIONS.add(browserSession);
    browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setDevicePermissionHandler?.(() => false);
    browserSession.on?.("will-download", (event) => event.preventDefault?.());
  }

  #secureWindow(window) {
    if (!window?.webContents || typeof window.webContents.setWindowOpenHandler !== "function"
      || typeof window.webContents.loadURL !== "function" || typeof window.webContents.capturePage !== "function") {
      throw desktopError("Local browser window is unavailable.", "OPENBOT_LOCAL_BROWSER_UNAVAILABLE");
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on?.("will-navigate", (event, url) => {
      try { safeHttpsUrl(url); } catch { event.preventDefault?.(); }
    });
  }

  #enqueue(botId, operation) {
    const previous = this.#queues.get(botId) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#queues.set(botId, tail);
    void tail.then(() => {
      if (this.#queues.get(botId) === tail) this.#queues.delete(botId);
    });
    return result;
  }

  #assertActive() {
    if (this.#disposed) {
      throw desktopError("Local Desktop manager is disposed.", "OPENBOT_LOCAL_DESKTOP_DISPOSED");
    }
  }
}

module.exports = {
  LocalDesktopError,
  LocalDesktopManager,
};
