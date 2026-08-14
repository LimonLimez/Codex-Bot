"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PROVIDER_FLAGS = Object.freeze({
  codex: "-codex-login",
  claude: "-claude-login",
  kimi: "-kimi-login",
});

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
  #expectedBinaryBytes;
  #expectedBinarySha256;
  #child = null;
  #session = null;
  #startPromise = null;
  #configPath = null;
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
    } catch {
      fs.rmSync(configPath, { force: true });
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
      try { fs.rmSync(configPath, { force: true }); } catch {}
    };
    child.once?.("error", onTermination);
    child.once?.("exit", onTermination);
    this.#session = privateSession(endpoint, credential);
    return this.#session;
  }

  connectProvider(provider) {
    if (typeof provider !== "string" || !Object.hasOwn(PROVIDER_FLAGS, provider)) {
      return Promise.reject(
        new CLIProxyError("CLIProxyAPI provider is invalid.", "CLIPROXY_PROVIDER_INVALID"),
      );
    }
    const existing = this.#providerPromises.get(provider);
    if (existing) return existing;
    let promise;
    promise = this.#connectProvider(provider).finally(() => {
      if (this.#providerPromises.get(provider) === promise) {
        this.#providerPromises.delete(provider);
      }
    });
    this.#providerPromises.set(provider, promise);
    return promise;
  }

  async #connectProvider(provider) {
    await this.start();
    const epoch = this.#lifecycleEpoch;
    const configPath = this.#configPath;
    if (!configPath) throw new CLIProxyError();
    let child;
    try {
      child = this.#spawn(this.#binaryPath, ["-config", configPath, PROVIDER_FLAGS[provider]], {
        cwd: path.dirname(configPath),
        env: spawnEnvironment(),
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch {
      throw new CLIProxyError("CLIProxyAPI provider connection failed.", "CLIPROXY_PROVIDER_FAILED");
    }
    this.#providerChildren.add(child);
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (operation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#providerChildren.delete(child);
        operation();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(() => reject(new CLIProxyError(
          "CLIProxyAPI provider connection timed out.",
          "CLIPROXY_PROVIDER_TIMEOUT",
        )));
      }, 10 * 60 * 1000);
      timer.unref?.();
      child.once("error", () => {
        finish(() => reject(new CLIProxyError(
          "CLIProxyAPI provider connection failed.",
          "CLIPROXY_PROVIDER_FAILED",
        )));
      });
      child.once("exit", (code) => {
        if (code === 0 && epoch === this.#lifecycleEpoch) finish(resolve);
        else finish(() => reject(new CLIProxyError(
          "CLIProxyAPI provider connection failed.",
          "CLIPROXY_PROVIDER_FAILED",
        )));
      });
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
  }
}

module.exports = { CLIProxyError, CLIProxyManager, configText, defaultProbe };
