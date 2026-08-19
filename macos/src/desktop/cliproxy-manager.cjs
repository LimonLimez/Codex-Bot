"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { types } = require("node:util");
const { providerDescriptor } = require("../provider-descriptors.cjs");

const CLIPROXY_PROVIDER_IDS = Object.freeze([
  "anthropic-claude", "google-antigravity", "moonshot-kimi", "xai", "google-vertex-ai",
]);
const CLIPROXY_PROVIDER_SET = new Set(CLIPROXY_PROVIDER_IDS);
const PROVIDER_FLAGS = Object.freeze(Object.fromEntries(
  CLIPROXY_PROVIDER_IDS
    .filter((providerId) => providerDescriptor(providerId).loginKind !== "service-account")
    .map((providerId) => [providerId, providerDescriptor(providerId).loginFlag]),
));
const AUTH_WAIT_MS = 10_000;
const PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROVIDER_STDERR_BYTES = 16 * 1024;
const MAX_MODEL_BYTES = 1_048_576;
const MAX_MODELS = 200;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function plainOwn(value, allowed, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw new Error();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { throw new Error(); }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]))
    || required.some((key) => !Object.hasOwn(descriptors, key))) throw new Error();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

class CLIProxyError extends Error {
  constructor(message = "CLIProxyAPI is unavailable.", code = "CLIPROXY_UNAVAILABLE") {
    super(message);
    this.name = "CLIProxyError";
    this.code = code;
  }
}

function privateSession(endpoint, credential) {
  const session = { endpoint };
  Object.defineProperty(session, "credential", {
    value: credential,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(session);
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function configText({ authDirectory, credential, port }) {
  return `host: "127.0.0.1"
port: ${port}
tls:
  enable: false
  cert: ""
  key: ""
remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true
  disable-auto-update-panel: true
auth-dir: ${yamlString(authDirectory)}
api-keys:
  - ${yamlString(credential)}
debug: false
pprof:
  enable: false
  addr: "127.0.0.1:0"
plugins:
  enabled: false
logging-to-file: false
usage-statistics-enabled: false
request-retry: 1
`;
}

function spawnEnvironment(environment = process.env) {
  return Object.freeze({
    HOME: typeof environment.HOME === "string" ? environment.HOME : "",
    LANG: typeof environment.LANG === "string" ? environment.LANG : "C.UTF-8",
    PATH: typeof environment.PATH === "string" ? environment.PATH : "/usr/bin:/bin",
    TMPDIR: typeof environment.TMPDIR === "string" ? environment.TMPDIR : os.tmpdir(),
  });
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function defaultProbe({ endpoint, credential, attempts = 50, delayMs = 100 }) {
  return new Promise((resolve) => {
    let remaining = attempts;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const retry = () => {
      if (settled) return;
      remaining -= 1;
      if (remaining <= 0) finish(false);
      else setTimeout(attempt, delayMs).unref?.();
    };
    const attempt = () => {
      const request = http.get(`${endpoint}/models`, {
        headers: { Authorization: `Bearer ${credential}` },
        timeout: 500,
      }, (response) => {
        response.resume();
        if (response.statusCode === 200) finish(true);
        else retry();
      });
      request.once("timeout", () => request.destroy());
      request.once("error", retry);
    };
    attempt();
  });
}

class CLIProxyManager {
  #binaryPath;
  #stateRoot;
  #spawn;
  #probe;
  #randomBytes;
  #randomInt;
  #request;
  #expectedBinaryBytes;
  #expectedBinarySha256;
  #child = null;
  #session = null;
  #startPromise = null;
  #configPath = null;
  #authDirectory = null;
  #runDirectory = null;
  #lifecycleEpoch = 0;
  #providerChildren = new Set();
  #providerPromises = new Map();

  constructor({
    binaryPath,
    stateRoot,
    spawnImpl = childProcess.spawn,
    probeImpl = defaultProbe,
    randomBytes = crypto.randomBytes,
    randomInt = crypto.randomInt,
    requestImpl = null,
    expectedBinaryBytes,
    expectedBinarySha256,
  } = {}) {
    if (typeof binaryPath !== "string" || !path.isAbsolute(binaryPath)
      || typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
      || typeof spawnImpl !== "function" || typeof probeImpl !== "function"
      || typeof randomBytes !== "function" || typeof randomInt !== "function") {
      throw new CLIProxyError();
    }
    const expectsIntegrity = expectedBinaryBytes !== undefined || expectedBinarySha256 !== undefined;
    if (
      expectsIntegrity &&
      (!Number.isSafeInteger(expectedBinaryBytes) || expectedBinaryBytes < 1 ||
        typeof expectedBinarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedBinarySha256))
    ) {
      throw new CLIProxyError();
    }
    this.#binaryPath = binaryPath;
    this.#stateRoot = stateRoot;
    this.#spawn = spawnImpl;
    this.#probe = probeImpl;
    this.#randomBytes = randomBytes;
    this.#randomInt = randomInt;
    if (requestImpl !== null && typeof requestImpl !== "function") throw new CLIProxyError();
    this.#request = requestImpl;
    this.#expectedBinaryBytes = expectedBinaryBytes;
    this.#expectedBinarySha256 = expectedBinarySha256;
  }

  start() {
    if (this.#session) return Promise.resolve(this.#session);
    if (this.#startPromise) return this.#startPromise;
    const epoch = ++this.#lifecycleEpoch;
    let promise;
    promise = this.#start(epoch).finally(() => {
      if (this.#startPromise === promise) this.#startPromise = null;
    });
    this.#startPromise = promise;
    return this.#startPromise;
  }

  async #start(epoch) {
    let stat;
    try { stat = fs.lstatSync(this.#binaryPath); } catch { throw new CLIProxyError(); }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
      throw new CLIProxyError();
    }
    if (
      this.#expectedBinaryBytes !== undefined &&
      (stat.size !== this.#expectedBinaryBytes || sha256File(this.#binaryPath) !== this.#expectedBinarySha256)
    ) {
      throw new CLIProxyError(
        "CLIProxyAPI executable failed integrity verification.",
        "CLIPROXY_INTEGRITY_FAILED",
      );
    }
    const authDirectory = path.join(this.#stateRoot, "auth");
    const configDirectory = path.join(this.#stateRoot, "run");
    fs.mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(authDirectory, 0o700);
    fs.chmodSync(configDirectory, 0o700);
    this.#authDirectory = authDirectory;
    this.#runDirectory = configDirectory;
    const credential = this.#randomBytes(32).toString("hex");
    const port = this.#randomInt(49152, 65536);
    const endpoint = `http://127.0.0.1:${port}/v1`;
    const configPath = path.join(configDirectory, "config.yaml");
    const temporary = path.join(configDirectory, `.config.${process.pid}.${this.#randomBytes(8).toString("hex")}.tmp`);
    fs.writeFileSync(temporary, configText({ authDirectory, credential, port }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, configPath);
    fs.chmodSync(configPath, 0o600);
    let child;
    try {
      child = this.#spawn(this.#binaryPath, ["-config", configPath, "-local-model"], {
        cwd: configDirectory,
        env: spawnEnvironment(),
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      if (!child || typeof child.once !== "function") throw new Error();
    } catch {
      fs.rmSync(configPath, { force: true });
      this.#authDirectory = null;
      this.#runDirectory = null;
      throw new CLIProxyError();
    }
    this.#child = child;
    this.#configPath = configPath;
    let onEarlyError;
    let onEarlyExit;
    const childFailure = new Promise((_resolve, reject) => {
      onEarlyError = () => reject(new CLIProxyError());
      onEarlyExit = () => reject(new CLIProxyError());
      child.once?.("error", onEarlyError);
      child.once?.("exit", onEarlyExit);
    });
    let ready;
    try {
      ready = await Promise.race([
        Promise.resolve(this.#probe({ endpoint, credential, child })),
        childFailure,
      ]);
    } catch {
      ready = false;
    } finally {
      child.removeListener?.("error", onEarlyError);
      child.removeListener?.("exit", onEarlyExit);
    }
    if (
      ready !== true ||
      child.exitCode != null ||
      epoch !== this.#lifecycleEpoch ||
      this.#child !== child
    ) {
      try { child.kill(); } catch {}
      fs.rmSync(configPath, { force: true });
      if (this.#child === child) this.#child = null;
      if (this.#configPath === configPath) this.#configPath = null;
      throw new CLIProxyError();
    }
    const onTermination = () => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#session = null;
      if (this.#configPath === configPath) this.#configPath = null;
      if (this.#authDirectory === authDirectory) this.#authDirectory = null;
      if (this.#runDirectory === configDirectory) this.#runDirectory = null;
      try { fs.rmSync(configPath, { force: true }); } catch {}
    };
    child.once?.("error", onTermination);
    child.once?.("exit", onTermination);
    this.#session = privateSession(endpoint, credential);
    return this.#session;
  }

  connectProvider(provider) {
    let descriptor;
    try { descriptor = providerDescriptor(provider); } catch {
      return Promise.reject(
        new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID"),
      );
    }
    if (!CLIPROXY_PROVIDER_SET.has(descriptor.providerId)
      || descriptor.loginKind === "service-account" || !PROVIDER_FLAGS[descriptor.providerId]) {
      return Promise.reject(
        new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID"),
      );
    }
    const providerId = descriptor.providerId;
    const existing = this.#providerPromises.get(providerId);
    if (existing) return existing;
    let promise;
    // Queue the body behind a microtask before invoking it. This makes the
    // map write happen before any dependency can synchronously re-enter the
    // manager and request the same provider.
    promise = Promise.resolve().then(() => this.#connectProvider(descriptor)).finally(() => {
      if (this.#providerPromises.get(providerId) === promise) {
        this.#providerPromises.delete(providerId);
      }
    });
    this.#providerPromises.set(providerId, promise);
    return promise;
  }

  async #connectProvider(descriptor) {
    await this.start();
    const epoch = this.#lifecycleEpoch;
    const configPath = this.#configPath;
    if (!configPath || !this.#authDirectory) throw new CLIProxyError();
    const snapshot = this.#snapshotAuth(descriptor);
    await this.#runProviderChild(
      ["-config", configPath, descriptor.loginFlag],
      epoch,
    );
    await this.#waitForAuth(descriptor, snapshot, epoch);
    return this.connectionStatus(descriptor.providerId);
  }

  importVertex(sourcePath) {
    const providerId = "google-vertex-ai";
    let source;
    try {
      if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)
        || sourcePath.includes("\0") || path.normalize(sourcePath) !== sourcePath) throw new Error();
      const stat = fs.lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4 * 1024 * 1024) throw new Error();
      source = sourcePath;
    } catch {
      return Promise.reject(new CLIProxyError("CLIProxyAPI provider source is invalid.", "CLIPROXY_PROVIDER_INVALID"));
    }
    const existing = this.#providerPromises.get(providerId);
    if (existing) return existing;
    let promise;
    promise = Promise.resolve().then(async () => {
      await this.start();
      const epoch = this.#lifecycleEpoch;
      const configPath = this.#configPath;
      const runDirectory = this.#runDirectory;
      if (!configPath || !runDirectory || !this.#authDirectory) throw new CLIProxyError();
      let sourceStat;
      try {
        sourceStat = fs.lstatSync(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error();
      } catch {
        throw new CLIProxyError("CLIProxyAPI provider source is invalid.", "CLIPROXY_PROVIDER_INVALID");
      }
      const snapshot = this.#snapshotAuth(providerDescriptor(providerId));
      const temporary = path.join(runDirectory, `.vertex-${process.pid}-${this.#randomBytes(12).toString("hex")}.json`);
      try {
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(temporary, 0o600);
        await this.#runProviderChild(["-vertex-import", temporary, "-config", configPath], epoch);
        await this.#waitForAuth(providerDescriptor(providerId), snapshot, epoch);
        return this.connectionStatus(providerId);
      } finally {
        try { fs.rmSync(temporary, { force: true }); } catch { /* exact temporary cleanup is best effort */ }
      }
    }).finally(() => {
      if (this.#providerPromises.get(providerId) === promise) this.#providerPromises.delete(providerId);
    });
    this.#providerPromises.set(providerId, promise);
    return promise;
  }

  async disconnectProvider(provider) {
    let descriptor;
    try { descriptor = providerDescriptor(provider); } catch {
      throw new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID");
    }
    if (!CLIPROXY_PROVIDER_SET.has(descriptor.providerId)) {
      throw new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID");
    }
    const directory = this.#authDirectory || path.join(this.#stateRoot, "auth");
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw new CLIProxyError(); }
    for (const entry of entries) {
      if (!descriptor.authFilePattern.test(entry.name)) continue;
      const target = path.join(directory, entry.name);
      let stat;
      try { stat = fs.lstatSync(target); } catch { throw new CLIProxyError(); }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new CLIProxyError(
        "CLIProxyAPI provider credential is unsafe.", "CLIPROXY_PROVIDER_FAILED",
      );
      try { fs.rmSync(target, { force: true }); } catch { throw new CLIProxyError(); }
    }
  }

  async listModels(provider) {
    let descriptor;
    try { descriptor = providerDescriptor(provider); } catch {
      throw new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID");
    }
    if (!CLIPROXY_PROVIDER_SET.has(descriptor.providerId)) {
      throw new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID");
    }
    const session = await this.start();
    if (typeof this.#request === "function") {
      try {
        const requestOptions = {
          providerId: descriptor.providerId,
          endpoint: session.endpoint,
          timeout: 5_000,
          maxBytes: MAX_MODEL_BYTES,
          redirects: 0,
        };
        Object.defineProperty(requestOptions, "credential", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: session.credential,
        });
        const response = await this.#request(requestOptions);
        return this.#normalizeModels(descriptor.providerId, response);
      } catch (error) {
        if (error instanceof CLIProxyError) throw error;
        throw new CLIProxyError("CLIProxyAPI model catalog is unavailable.", "CLIPROXY_PROVIDER_FAILED");
      }
    }
    return new Promise((resolve, reject) => {
      const parsed = new URL(`${session.endpoint}/models`);
      const request = http.get(parsed, {
        headers: { Authorization: `Bearer ${session.credential}`, Connection: "close" },
        timeout: 5_000,
      }, (response) => {
        const chunks = [];
        let total = 0;
        response.on("data", (chunk) => {
          total += Buffer.byteLength(chunk);
          if (total > MAX_MODEL_BYTES) {
            request.destroy();
            reject(new CLIProxyError("CLIProxyAPI model catalog is unavailable.", "CLIPROXY_PROVIDER_FAILED"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => {
          if (response.statusCode !== 200) {
            reject(new CLIProxyError("CLIProxyAPI model catalog is unavailable.", "CLIPROXY_PROVIDER_FAILED"));
            return;
          }
          try {
            resolve(this.#normalizeModels(descriptor.providerId, {
              statusCode: response.statusCode,
              body: Buffer.concat(chunks),
            }));
          } catch { reject(new CLIProxyError("CLIProxyAPI model catalog is unavailable.", "CLIPROXY_PROVIDER_FAILED")); }
        });
      });
      request.once("timeout", () => request.destroy());
      request.once("error", () => reject(new CLIProxyError("CLIProxyAPI model catalog is unavailable.", "CLIPROXY_PROVIDER_FAILED")));
    });
  }

  async connectionStatus(provider) {
    let descriptor;
    try { descriptor = providerDescriptor(provider); } catch {
      throw new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID");
    }
    if (!CLIPROXY_PROVIDER_SET.has(descriptor.providerId)) {
      throw new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID");
    }
    const connected = this.#hasAuth(descriptor);
    return Object.freeze({
      providerId: descriptor.providerId,
      state: connected ? "connected" : "disconnected",
      models: Object.freeze([]),
    });
  }

  #normalizeModels(providerId, response) {
    const responseData = plainOwn(response, new Set(["statusCode", "body"]), ["body"]);
    const statusCode = responseData.statusCode;
    if (statusCode !== undefined && statusCode !== 200) throw new Error();
    const body = responseData.body;
    if (Buffer.byteLength(Buffer.isBuffer(body) ? body : String(body || ""), "utf8") > MAX_MODEL_BYTES) throw new Error();
    const parsed = typeof body === "string" || Buffer.isBuffer(body) ? JSON.parse(body.toString()) : body;
    const parsedData = plainOwn(parsed, new Set(["object", "data"]), ["data"]);
    if (!Array.isArray(parsedData.data) || types.isProxy(parsedData.data)
      || parsedData.data.length > MAX_MODELS) throw new Error();
    const models = [];
    const seen = new Set();
    for (const entry of parsedData.data) {
      const model = plainOwn(entry, new Set(["id", "object"]), ["id"]);
      if (typeof model.id !== "string" || !MODEL_ID.test(model.id) || seen.has(model.id)) throw new Error();
      if (model.object !== undefined && model.object !== "model") throw new Error();
      seen.add(model.id);
      models.push(Object.freeze({ provider: providerId, model: model.id, label: model.id }));
    }
    return Object.freeze(models);
  }

  #runProviderChild(args, epoch) {
    const configPath = this.#configPath;
    if (!configPath || epoch !== this.#lifecycleEpoch) {
      return Promise.reject(new CLIProxyError());
    }
    let child;
    try {
      child = this.#spawn(this.#binaryPath, args, {
        cwd: path.dirname(configPath),
        env: spawnEnvironment(),
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      if (!child || typeof child.once !== "function") throw new Error();
    } catch {
      return Promise.reject(new CLIProxyError("CLIProxyAPI provider connection failed.", "CLIPROXY_PROVIDER_FAILED"));
    }
    this.#providerChildren.add(child);
    const stderr = { bytes: 0 };
    child.stderr?.on?.("data", (chunk) => { stderr.bytes = Math.min(MAX_PROVIDER_STDERR_BYTES + 1, stderr.bytes + Buffer.byteLength(chunk)); });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        try { child.kill?.(); } catch { /* best effort */ }
        finish(() => reject(new CLIProxyError(
          "CLIProxyAPI provider connection timed out.", "CLIPROXY_PROVIDER_TIMEOUT",
        )));
      }, PROVIDER_TIMEOUT_MS);
      timer.unref?.();
      const finish = (operation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#providerChildren.delete(child);
        operation();
      };
      child.once?.("error", () => finish(() => reject(new CLIProxyError(
        "CLIProxyAPI provider connection failed.", "CLIPROXY_PROVIDER_FAILED",
      ))));
      child.once?.("exit", (code) => {
        if (code === 0 && epoch === this.#lifecycleEpoch && stderr.bytes <= MAX_PROVIDER_STDERR_BYTES) finish(resolve);
        else finish(() => reject(new CLIProxyError(
          "CLIProxyAPI provider connection failed.", "CLIPROXY_PROVIDER_FAILED",
        )));
      });
    });
  }

  #snapshotAuth(descriptor) {
    const directory = this.#authDirectory;
    const snapshot = new Map();
    if (!directory) return snapshot;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return snapshot; }
    for (const entry of entries) {
      if (!descriptor.authFilePattern.test(entry.name)) continue;
      const target = path.join(directory, entry.name);
      try {
        const stat = fs.lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          snapshot.set(entry.name, `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode & 0o777}`);
        }
      } catch { /* unreadable candidates are not treated as credentials */ }
    }
    return snapshot;
  }

  #hasAuth(descriptor) {
    const snapshot = this.#snapshotAuth(descriptor);
    return snapshot.size > 0;
  }

  #waitForAuth(descriptor, before, epoch) {
    const deadline = Date.now() + AUTH_WAIT_MS;
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (epoch !== this.#lifecycleEpoch) {
          reject(new CLIProxyError("CLIProxyAPI provider connection was superseded.", "CLIPROXY_PROVIDER_FAILED"));
          return;
        }
        const current = this.#snapshotAuth(descriptor);
        const changed = [...current.entries()].filter(([name, signature]) => before.get(name) !== signature);
        if (changed.length === 1) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new CLIProxyError(
            "CLIProxyAPI provider credentials were not installed.", "CLIPROXY_PROVIDER_NOT_READY",
          ));
          return;
        }
        setTimeout(poll, 50).unref?.();
      };
      poll();
    });
  }

  stop() {
    this.#lifecycleEpoch += 1;
    const child = this.#child;
    this.#child = null;
    this.#session = null;
    if (child && child.exitCode == null) {
      try { child.kill(); } catch {}
    }
    for (const providerChild of this.#providerChildren) {
      try { providerChild.kill(); } catch {}
    }
    this.#providerChildren.clear();
    if (this.#configPath) {
      try { fs.rmSync(this.#configPath, { force: true }); } catch {}
    }
    this.#configPath = null;
    this.#authDirectory = null;
    this.#runDirectory = null;
  }
}

module.exports = {
  CLIPROXY_PROVIDER_IDS,
  CLIProxyError,
  CLIProxyManager,
  configText,
  defaultProbe,
};
