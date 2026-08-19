"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { LocalHelperProtocol } = require("./local-helper-protocol.cjs");

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_DISPLAY_FRAME_BYTES = 1_048_576;
const MAX_DISPLAY_FRAME_WIDTH = 640;
const MAX_DISPLAY_FRAME_HEIGHT = 400;
const DISPLAY_FRAME_BOUNDS = Object.freeze([
  Object.freeze({ width: 640, height: 400 }),
  Object.freeze({ width: 512, height: 320 }),
  Object.freeze({ width: 400, height: 250 }),
  Object.freeze({ width: 320, height: 200 }),
]);
const MAX_URL_BYTES = 4096;
const LOCAL_DESKTOP_START_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\"><title>OpenBot Free Local Desktop</title></head><body><main><h1>Free Local Desktop</h1><p>Ready for this bot.</p></main></body></html>";
const LOCAL_DESKTOP_START_URL = `data:text/html;base64,${Buffer.from(LOCAL_DESKTOP_START_HTML, "utf8").toString("base64")}`;
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
const DISPOSE_TASK_FIELDS = new Set(["botId", "taskId"]);
const DELETE_BOT_FIELDS = new Set(["botId", "localProfileId"]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const EXTERNAL_RESOURCE_CAPABILITIES = new Set([
  "filesystem.read",
  "filesystem.write",
  "application.open",
  "application.automate",
  "screen.capture",
]);
const SECURED_BROWSER_SESSIONS = new WeakSet();
const PROFILE_REMOVE_SCRIPT = String.raw`set -efu
expected_root=$1
expected_profile=$2
profile_name=$3
case "$profile_name" in
  ????????-????-????-????-????????????) ;;
  *) exit 64 ;;
esac
case "$profile_name" in *[!0123456789abcdef-]*) exit 64 ;; esac
actual_root=$(/usr/bin/stat -f '%d:%i:%FB' .) || exit 65
[ "$actual_root" = "$expected_root" ] || exit 66
[ ! -L "./$profile_name" ] || exit 67
[ -d "./$profile_name" ] || exit 67
actual_profile=$(/usr/bin/stat -f '%d:%i:%FB' "./$profile_name") || exit 67
[ "$actual_profile" = "$expected_profile" ] || exit 68
exec /bin/rm -Rfx "./$profile_name"`;
const PROFILE_REMOVE_REFUSAL_CODES = new Set([64, 66, 67, 68]);

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

function normalizeComputer(value, { allowStarting = false } = {}) {
  const input = assertPlainObject(cloneInput(value, "Local Computer"), "Local Computer");
  const botId = normalizeBotId(input.botId);
  const computer = assertPlainObject(input.computer, "Local Computer state");
  const target = normalizeTargetId(computer.localProfileId);
  if (computer.mode !== "local"
    || (computer.state !== "ready" && (!allowStarting || computer.state !== "starting"))) {
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

function normalizeDisposeTask(value) {
  const input = assertPlainObject(cloneInput(value, "Local Desktop task"), "Local Desktop task");
  assertExactKeys(input, DISPOSE_TASK_FIELDS, "Local Desktop task");
  if (typeof input.taskId !== "string" || !SAFE_ID_PATTERN.test(input.taskId)) {
    throw new Error("Local Desktop task ID is invalid.");
  }
  return { botId: normalizeBotId(input.botId), taskId: input.taskId };
}

function normalizeDeleteBot(value) {
  if (typeof value === "string") {
    return { botId: normalizeBotId(value), localProfileId: null, profileUuid: null, legacy: true };
  }
  let array;
  let prototype;
  let descriptors;
  try {
    array = Array.isArray(value);
    if (value && typeof value === "object" && !array) {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    }
  } catch {
    throw new TypeError("Local Desktop deletion must contain plain data values only.");
  }
  if (!value || typeof value !== "object" || array
    || (prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError("Local Desktop deletion must be a plain object.");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("Local Desktop deletion cannot contain symbols.");
  }
  for (const key of keys) {
    if (DANGEROUS_KEYS.has(key) || !DELETE_BOT_FIELDS.has(key)) {
      throw new Error("Local Desktop deletion contains an unsupported field.");
    }
  }
  for (const key of DELETE_BOT_FIELDS) {
    if (!hasOwn(descriptors, key)) throw new Error(`Local Desktop deletion is missing ${key}.`);
    if (!("value" in descriptors[key])) {
      throw new TypeError("Local Desktop deletion must contain plain data values only.");
    }
  }
  const target = normalizeTargetId(descriptors.localProfileId.value);
  return {
    botId: normalizeBotId(descriptors.botId.value),
    localProfileId: target.targetId,
    profileUuid: target.uuid,
    legacy: false,
  };
}

function botDeletingError() {
  return desktopError("Local Desktop data for this bot is being deleted.", "OPENBOT_LOCAL_BOT_DELETING");
}

function cleanupRefusedError() {
  return desktopError("Local profile cleanup was refused.", "OPENBOT_LOCAL_CLEANUP_REFUSED");
}

function cleanupFailedError() {
  return desktopError("Local profile cleanup failed.", "OPENBOT_LOCAL_CLEANUP_FAILED");
}

function directoryIdentity(stat) {
  const seconds = stat.birthtimeNs / 1_000_000_000n;
  const nanoseconds = String(stat.birthtimeNs % 1_000_000_000n).padStart(9, "0");
  return `${stat.dev}:${stat.ino}:${seconds}.${nanoseconds}`;
}

function removeBoundProfile({ root, rootIdentity, profileIdentity, profileUuid }) {
  return new Promise((resolve, reject) => {
    try {
      childProcess.execFile(
        "/bin/sh",
        ["-c", PROFILE_REMOVE_SCRIPT, "openbot-profile-cleanup", rootIdentity, profileIdentity, profileUuid],
        {
          cwd: root,
          env: { LC_ALL: "C" },
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_024,
        },
        (error) => {
          if (!error) {
            resolve();
            return;
          }
          if (PROFILE_REMOVE_REFUSAL_CODES.has(error.code)) reject(cleanupRefusedError());
          else reject(cleanupFailedError());
        },
      );
    } catch {
      reject(cleanupFailedError());
    }
  });
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

function safeDisplayUrl(value) {
  if (value === LOCAL_DESKTOP_START_URL) return LOCAL_DESKTOP_START_URL;
  return safeHttpsUrl(value);
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
  #readCurrentComputer;
  #helperFactory;
  #randomUUID;
  #helperTimeoutMs;
  #entries = new Map();
  #profiles = new Map();
  #profileOwners = new Map();
  #queues = new Map();
  #deletions = new Map();
  #windows = new WeakSet();
  #disposePromise = null;
  #disposed = false;

  constructor({
    electron,
    userDataPath,
    permissionBroker,
    readCurrentComputer,
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
      || typeof permissionBroker.cancelTask !== "function"
      || typeof permissionBroker.cancelBot !== "function"
      || typeof permissionBroker.deleteBot !== "function") {
      throw new TypeError("Local Desktop manager requires a permission broker.");
    }
    if (typeof readCurrentComputer !== "function") {
      throw new TypeError("Local Desktop manager requires an authoritative current Computer reader.");
    }
    if (typeof helperFactory !== "function" || typeof randomUUID !== "function"
      || !Number.isSafeInteger(helperTimeoutMs) || helperTimeoutMs < 1 || helperTimeoutMs > 120_000) {
      throw new TypeError("Local Desktop helper configuration is invalid.");
    }
    this.#electron = electron;
    this.#userDataPath = path.resolve(userDataPath);
    this.#permissionBroker = permissionBroker;
    this.#readCurrentComputer = readCurrentComputer;
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

  ownsWindow(window) {
    try { return Boolean(window && typeof window === "object" && this.#windows.has(window)); } catch { return false; }
  }

  async open(value) {
    this.#assertActive();
    const computer = normalizeComputer(value);
    this.#assertBotAvailable(computer.botId);
    this.#claimProfile(computer.botId, computer.targetId);
    return this.#enqueue(computer.botId, async () => {
      this.#assertBotAvailable(computer.botId);
      const existing = this.#entries.get(computer.botId);
      if (existing && this.#sameIdentity(existing, computer)) {
        existing.fenced = true;
        try {
          await this.#assertCurrentComputer(computer);
          this.#assertReusableEntry(existing, computer);
          existing.fenced = false;
          return publicSession(existing);
        } catch (error) {
          if (this.#entries.get(computer.botId) === existing) {
            try { await this.#closeEntry(existing, true); } catch {}
          } else if (existing.closePromise) {
            try { await existing.closePromise; } catch {}
          }
          throw error;
        }
      }
      if (existing) {
        await this.#closeEntry(existing, true);
        await this.#assertCurrentComputer(computer);
      }

      const profilePath = await this.#ensureProfile(computer.profileUuid);
      await this.#assertCurrentComputer(computer);
      this.#assertBotAvailable(computer.botId);
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
      this.#windows.add(window);
      let helperTransport;
      let protocol;
      try {
        this.#secureWindow(window);
        await window.webContents.loadURL(LOCAL_DESKTOP_START_URL);
        await this.#assertCurrentComputer(computer);
        if (window.webContents.getURL() !== LOCAL_DESKTOP_START_URL) {
          throw desktopError("Local Desktop start document is invalid.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
        helperTransport = await this.#helperFactory(Object.freeze({
          botId: computer.botId,
          targetId: computer.targetId,
          targetGeneration: computer.targetGeneration,
          workspacePath: profilePath.workspacePath,
        }));
        await this.#assertCurrentComputer(computer);
        if (window.webContents.getURL() !== LOCAL_DESKTOP_START_URL) {
          throw desktopError("Local Desktop start document is invalid.", "OPENBOT_LOCAL_DESKTOP_START_FAILED");
        }
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
          operations: new Map(),
          closePromise: null,
          fenced: false,
          closeRequested: false,
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
          void this.#closeEntry(entry, true);
        });
        return publicSession(entry);
      } catch (error) {
        try { await protocol?.dispose(); } catch {}
        if (!protocol) {
          try { await helperTransport?.dispose?.(); } catch {}
        }
        try { if (!window.isDestroyed?.()) window.destroy(); } catch {}
        this.#assertBotAvailable(computer.botId);
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
    try { safeHttpsUrl(entry.window.webContents.getURL()); } catch {
      throw desktopError("Local navigation failed.", "OPENBOT_LOCAL_NAVIGATION_FAILED");
    }
    return publicSession(entry);
  }

  async capture(value) {
    this.#assertActive();
    const input = normalizeIdentity(value);
    const entry = this.#requiredEntry(input);
      const image = await this.#captureCurrentImage(input, entry);
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

  async captureDisplayFrame(value) {
    this.#assertActive();
    const input = normalizeIdentity(value);
    const entry = this.#requiredEntry(input);
    const image = await this.#captureCurrentImage(input, entry);
    let sourceSize;
    try { sourceSize = image.getSize(); } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    if (!this.#validFrameSize(sourceSize, 8192, 8192) || typeof image.resize !== "function") {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    for (const bounds of DISPLAY_FRAME_BOUNDS) {
      const scale = Math.min(1, bounds.width / sourceSize.width, bounds.height / sourceSize.height);
      const width = Math.max(1, Math.floor(sourceSize.width * scale));
      const height = Math.max(1, Math.floor(sourceSize.height * scale));
      let rendered;
      let size;
      let bytes;
      try {
        rendered = width === sourceSize.width && height === sourceSize.height
          ? image
          : image.resize({ width, height, quality: "good" });
        size = rendered.getSize();
        bytes = rendered.toPNG();
      } catch { continue; }
      if (!this.#validFrameSize(size, MAX_DISPLAY_FRAME_WIDTH, MAX_DISPLAY_FRAME_HEIGHT)
        || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_DISPLAY_FRAME_BYTES) continue;
      const frame = Object.freeze({
        botId: entry.botId,
        targetId: entry.targetId,
        targetGeneration: entry.targetGeneration,
        frameId: `frame-${crypto.createHash("sha256").update(bytes).digest("hex")}`,
        width: size.width,
        height: size.height,
        mimeType: "image/png",
        bytes: Uint8Array.from(bytes),
      });
      try {
        await this.#assertCurrentComputer(input);
      } catch (error) {
        if (this.#entries.get(entry.botId) === entry) {
          try { await this.#closeEntry(entry, true); } catch {}
        }
        throw error;
      }
      this.#requiredEntry(input, entry);
      return frame;
    }
    throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
  }

  async run(value) {
    this.#assertActive();
    const input = normalizeAction(value);
    const entry = this.#requiredEntry(input);
    const requestId = `request-${safeUUID(this.#randomUUID)}`;
    let finishOperation;
    const operation = {
      requestId,
      taskId: input.taskId,
      cancelled: false,
      done: new Promise((resolve) => { finishOperation = resolve; }),
      finish: () => finishOperation(),
    };
    entry.operations.set(requestId, operation);
    try {
      const result = await this.#permissionBroker.request({
        botId: input.botId,
        targetId: input.targetId,
        targetGeneration: input.targetGeneration,
        capability: input.capability,
        resourceId: input.resourceId,
        resourceLabel: input.resourceLabel,
        reason: input.reason,
        ...(input.capability === "shell.execute" ? { command: input.arguments.command } : {}),
      }, async (bookmark) => {
        this.#assertOperationActive(entry, input, operation);
        if (EXTERNAL_RESOURCE_CAPABILITIES.has(input.capability)) {
          if (typeof entry.helperTransport.authorizeResource !== "function") {
            throw desktopError("Local resource handoff is unavailable.", "OPENBOT_LOCAL_RESOURCE_UNAVAILABLE");
          }
          await entry.helperTransport.authorizeResource(requestId, Buffer.from(bookmark));
          this.#assertOperationActive(entry, input, operation);
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
      }, { taskId: input.taskId });
      this.#assertOperationActive(entry, input, operation);
      this.emit("result", Object.freeze({
        requestId,
        botId: entry.botId,
        targetId: entry.targetId,
        targetGeneration: entry.targetGeneration,
        taskId: input.taskId,
        ok: true,
      }));
      return result;
    } finally {
      if (entry.operations.get(requestId) === operation) entry.operations.delete(requestId);
      operation.finish();
    }
  }

  async disposeTask(value) {
    this.#assertActive();
    const input = normalizeDisposeTask(value);
    const entry = this.#entries.get(input.botId);
    if (!entry) return;
    const operations = [...entry.operations.values()]
      .filter((operation) => operation.taskId === input.taskId);
    for (const operation of operations) operation.cancelled = true;
    this.#permissionBroker.cancelTask(input);
    await entry.protocol.cancelTask(input.taskId);
    await Promise.all(operations.map((operation) => operation.done));
  }

  async close(botId) {
    const normalizedBotId = normalizeBotId(botId);
    this.#assertBotAvailable(normalizedBotId);
    const current = this.#entries.get(normalizedBotId);
    if (current) current.closeRequested = true;
    return this.#enqueue(normalizedBotId, async () => {
      this.#assertBotAvailable(normalizedBotId);
      const entry = this.#entries.get(normalizedBotId);
      if (entry) await this.#closeEntry(entry, true);
      else this.#permissionBroker.cancelBot(normalizedBotId);
    });
  }

  deleteBot(value) {
    let request;
    let state;
    try {
      this.#assertActive();
      request = normalizeDeleteBot(value);
      state = this.#deletions.get(request.botId);
      if (state) {
        if (!request.legacy && state.localProfileId !== request.localProfileId) {
          throw cleanupRefusedError();
        }
        if (state.completed) return state.completedPromise;
        if (state.inFlight) return state.inFlight;
      } else {
        let identity = request;
        if (request.legacy) {
          const profile = this.#profiles.get(request.botId);
          if (profile) {
            const target = normalizeTargetId(profile.targetId);
            identity = {
              ...request,
              localProfileId: target.targetId,
              profileUuid: target.uuid,
            };
          }
        }
        if (identity.localProfileId !== null) {
          this.#claimProfile(identity.botId, identity.localProfileId);
        }
        state = {
          botId: identity.botId,
          localProfileId: identity.localProfileId,
          profileUuid: identity.profileUuid,
          completed: false,
          completedPromise: null,
          inFlight: null,
        };
        this.#deletions.set(request.botId, state);
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const olderQueue = this.#queues.get(request.botId) || null;
    const attempt = this.#deleteBotAttempt(state, olderQueue);
    let shared;
    shared = attempt.then((result) => {
      state.completed = true;
      state.completedPromise = shared;
      return result;
    }).finally(() => {
      if (state.inFlight === shared) state.inFlight = null;
    });
    state.inFlight = shared;
    return shared;
  }

  async #deleteBotAttempt(state, olderQueue) {
    try {
      if (olderQueue) await Promise.allSettled([olderQueue]);
      this.#assertDeletionActive(state);
      const cleanup = this.#deletionCleanupIdentity(state);
      if (cleanup) await this.#inspectDeletionPath(cleanup.profilePath);
      this.#assertDeletionActive(state);

      const entry = this.#entries.get(state.botId);
      if (entry) await this.#closeEntry(entry, true);
      this.#assertDeletionActive(state);
      await this.#permissionBroker.deleteBot(state.botId);
      this.#assertDeletionActive(state);

      if (cleanup) {
        const browserSession = this.#electron.session.fromPartition(cleanup.partition);
        if (!browserSession || typeof browserSession.clearStorageData !== "function") {
          throw cleanupFailedError();
        }
        await browserSession.clearStorageData();
        this.#assertDeletionActive(state);
        const inspected = await this.#inspectDeletionPath(cleanup.profilePath);
        this.#assertDeletionActive(state);
        if (inspected) {
          await removeBoundProfile(inspected);
          await this.#verifyDeletionResult(inspected);
        }
        this.#assertDeletionActive(state);
      }

      const profile = this.#profiles.get(state.botId);
      if (profile && (!cleanup || profile === cleanup.cachedProfile)) {
        this.#profiles.delete(state.botId);
      }
    } catch (error) {
      if (error instanceof LocalDesktopError) throw error;
      this.#assertDeletionActive(state);
      throw cleanupFailedError();
    }
  }

  #deletionCleanupIdentity(state) {
    const entry = this.#entries.get(state.botId) || null;
    const profile = this.#profiles.get(state.botId) || null;
    if (state.localProfileId === null) {
      if (entry || profile) throw cleanupRefusedError();
      return null;
    }
    const claimedOwner = this.#profileOwner(state.localProfileId);
    if (claimedOwner !== null && claimedOwner !== state.botId) throw cleanupRefusedError();
    const root = path.join(this.#userDataPath, "openbot-local");
    const profilePath = path.join(root, state.profileUuid);
    const workspacePath = path.join(profilePath, "workspace");
    const partition = `persist:openbot-local-${state.profileUuid}`;
    if (path.dirname(profilePath) !== root || path.basename(profilePath) !== state.profileUuid) {
      throw cleanupRefusedError();
    }
    for (const cached of [entry, profile]) {
      if (!cached) continue;
      if (cached.botId !== state.botId
        || cached.targetId !== state.localProfileId
        || cached.profileUuid !== state.profileUuid
        || cached.partition !== partition
        || cached.profilePath !== profilePath
        || cached.workspacePath !== workspacePath) {
        throw cleanupRefusedError();
      }
    }
    return { cachedProfile: profile, partition, profilePath };
  }

  async #inspectDeletionPath(profilePath) {
    const root = path.join(this.#userDataPath, "openbot-local");
    let rootStat;
    try {
      rootStat = await fs.lstat(root, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || rootStat.uid !== BigInt(process.getuid()) || (rootStat.mode & 0o777n) !== 0o700n) {
      throw cleanupRefusedError();
    }
    let profileStat;
    try {
      profileStat = await fs.lstat(profilePath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!profileStat.isDirectory() || profileStat.isSymbolicLink()
      || profileStat.uid !== BigInt(process.getuid()) || (profileStat.mode & 0o777n) !== 0o700n) {
      throw cleanupRefusedError();
    }
    return {
      root,
      rootIdentity: directoryIdentity(rootStat),
      profileIdentity: directoryIdentity(profileStat),
      profilePath,
      profileUuid: path.basename(profilePath),
    };
  }

  async #verifyDeletionResult(inspection) {
    let rootStat;
    try {
      rootStat = await fs.lstat(inspection.root, { bigint: true });
    } catch {
      throw cleanupRefusedError();
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || directoryIdentity(rootStat) !== inspection.rootIdentity) {
      throw cleanupRefusedError();
    }
    try {
      await fs.lstat(inspection.profilePath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw cleanupRefusedError();
    }
    throw cleanupRefusedError();
  }

  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#disposed) return Promise.resolve();
    const deletions = [...this.#deletions.values()]
      .map((state) => state.inFlight)
      .filter((operation) => operation && typeof operation.then === "function");
    this.#disposed = true;
    const entries = [...this.#entries.values()];
    this.#disposePromise = (async () => {
      await Promise.allSettled([
        ...entries.map((entry) => this.#closeEntry(entry, true)),
        ...deletions,
      ]);
      this.#entries.clear();
      this.#queues.clear();
      this.#profileOwners.clear();
      this.removeAllListeners();
    })();
    return this.#disposePromise;
  }

  #sameIdentity(entry, identity) {
    return entry.botId === identity.botId
      && entry.targetId === identity.targetId
      && entry.targetGeneration === identity.targetGeneration;
  }

  #requiredEntry(identity, expected = null) {
    this.#assertBotAvailable(identity.botId);
    const entry = this.#entries.get(identity.botId);
    if (!entry || (expected && entry !== expected) || entry.fenced || !this.#sameIdentity(entry, identity)
      || entry.window.isDestroyed?.()) {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    return entry;
  }

  #assertOperationActive(entry, identity, operation) {
    this.#requiredEntry(identity, entry);
    if (operation.cancelled || entry.operations.get(operation.requestId) !== operation) {
      throw desktopError("Local Desktop task was cancelled.", "OPENBOT_LOCAL_TASK_CANCELLED");
    }
  }

  #assertBotAvailable(botId) {
    this.#assertActive();
    if (this.#deletions.has(botId)) throw botDeletingError();
  }

  async #assertCurrentComputer(expected) {
    this.#assertBotAvailable(expected.botId);
    let value;
    try {
      value = await this.#readCurrentComputer(expected.botId);
    } catch {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    this.#assertBotAvailable(expected.botId);
    let current;
    try {
      current = normalizeComputer(value, { allowStarting: true });
    } catch {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    if (!this.#sameIdentity(expected, current)) {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
    return current;
  }

  #assertReusableEntry(entry, expected) {
    this.#assertBotAvailable(expected.botId);
    let destroyed = false;
    try { destroyed = Boolean(entry.window.isDestroyed?.()); } catch { destroyed = true; }
    if (this.#entries.get(expected.botId) !== entry || entry.closePromise || entry.closeRequested || destroyed
      || !this.#sameIdentity(entry, expected)) {
      throw desktopError("Local Desktop session is stale or unavailable.", "OPENBOT_LOCAL_DESKTOP_STALE");
    }
  }

  #profileOwner(targetId) {
    const claimed = this.#profileOwners.get(targetId);
    if (claimed) return claimed;
    for (const collection of [this.#entries, this.#profiles]) {
      for (const [botId, value] of collection) {
        if (value?.targetId !== targetId) continue;
        this.#profileOwners.set(targetId, botId);
        return botId;
      }
    }
    return null;
  }

  #claimProfile(botId, targetId) {
    const owner = this.#profileOwner(targetId);
    if (owner !== null && owner !== botId) throw cleanupRefusedError();
    this.#profileOwners.set(targetId, botId);
  }

  #assertDeletionActive(state) {
    if (this.#deletions.get(state.botId) !== state) throw cleanupRefusedError();
  }

  #closeEntry(entry, cancelPermissions) {
    if (entry.closePromise) return entry.closePromise;
    entry.fenced = true;
    entry.closeRequested = true;
    if (this.#entries.get(entry.botId) === entry) this.#entries.delete(entry.botId);
    for (const operation of entry.operations.values()) operation.cancelled = true;
    if (cancelPermissions) this.#permissionBroker.cancelBot(entry.botId);
    entry.closePromise = (async () => {
      try { await entry.protocol.dispose(); } catch {}
      await Promise.all([...entry.operations.values()].map((operation) => operation.done));
      try { if (!entry.window.isDestroyed?.()) entry.window.destroy(); } catch {}
    })();
    return entry.closePromise;
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
      || typeof window.webContents.loadURL !== "function" || typeof window.webContents.getURL !== "function"
      || typeof window.webContents.capturePage !== "function") {
      throw desktopError("Local browser window is unavailable.", "OPENBOT_LOCAL_BROWSER_UNAVAILABLE");
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on?.("will-navigate", (event, url) => {
      try { safeHttpsUrl(url); } catch { event.preventDefault?.(); }
    });
    window.webContents.on?.("will-redirect", (event, url) => {
      try { safeHttpsUrl(url); } catch { event.preventDefault?.(); }
    });
  }

  async #captureCurrentImage(identity, expected) {
    this.#requiredEntry(identity, expected);
    this.#assertCaptureUrl(expected);
    let image;
    try { image = await expected.window.webContents.capturePage(); } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
    this.#requiredEntry(identity, expected);
    this.#assertCaptureUrl(expected);
    return image;
  }

  #assertCaptureUrl(entry) {
    try { safeDisplayUrl(entry.window.webContents.getURL()); } catch {
      throw desktopError("Local frame capture failed.", "OPENBOT_LOCAL_CAPTURE_FAILED");
    }
  }

  #validFrameSize(size, maximumWidth, maximumHeight) {
    return Boolean(size && Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height)
      && size.width >= 1 && size.height >= 1
      && size.width <= maximumWidth && size.height <= maximumHeight);
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
  LOCAL_DESKTOP_START_HTML,
  LOCAL_DESKTOP_START_URL,
  LocalDesktopError,
  LocalDesktopManager,
  safeDisplayUrl,
};
