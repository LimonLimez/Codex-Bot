"use strict";

const childProcess = require("node:child_process");
const { types } = require("node:util");
const { PROVIDER_IDS } = require("../provider-descriptors.cjs");

const SERVICE = "com.limonlimez.openbot.providers";
const SECURITY = "/usr/bin/security";
const MAX_SECRET_BYTES = 16 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_STDOUT_BYTES = 16 * 1024;
const SECURITY_TIMEOUT_MS = 10_000;
const ACCOUNTS = new Set(PROVIDER_IDS);

class KeychainSecretStoreError extends Error {
  constructor(message = "OpenBot Keychain operation failed.", code = "OPENBOT_KEYCHAIN_FAILED") {
    super(message);
    this.name = "KeychainSecretStoreError";
    this.code = code;
    Object.defineProperty(this, "stack", {
      configurable: true,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: true,
    });
  }
}

function invalid() {
  return new KeychainSecretStoreError("OpenBot Keychain request is invalid.", "OPENBOT_KEYCHAIN_INVALID");
}

function failed(code = "OPENBOT_KEYCHAIN_FAILED") {
  return new KeychainSecretStoreError(
    code === "OPENBOT_KEYCHAIN_TIMEOUT"
      ? "OpenBot Keychain operation timed out."
      : "OpenBot Keychain operation failed.",
    code,
  );
}

function ownData(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw invalid();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalid();
  }
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => typeof key !== "string" || !allowed.has(key) || !("value" in descriptors[key]))
    || [...required].some((key) => !Object.hasOwn(descriptors, key))) throw invalid();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function safeAccount(value) {
  if (typeof value !== "string" || !ACCOUNTS.has(value)) throw invalid();
  return value;
}

function safeSecret(value) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")
    || /[\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw invalid();
  return value;
}

function appendBounded(target, chunk, maximum) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  if (target.bytes + value.length > maximum) {
    target.overflow = true;
    const available = Math.max(0, maximum - target.bytes);
    if (available > 0) target.chunks.push(value.subarray(0, available));
    target.bytes = maximum;
    return;
  }
  target.chunks.push(value);
  target.bytes += value.length;
}

function settledSecurityChild(child, { input = null, captureStdout = false } = {}) {
  if (!child || typeof child !== "object" || typeof child.once !== "function") return Promise.reject(failed());
  const stdout = { chunks: [], bytes: 0, overflow: false };
  const stderr = { chunks: [], bytes: 0, overflow: false };
  if (captureStdout && child.stdout?.on) child.stdout.on("data", (chunk) => appendBounded(stdout, chunk, MAX_STDOUT_BYTES));
  if (child.stderr?.on) child.stderr.on("data", (chunk) => appendBounded(stderr, chunk, MAX_STDERR_BYTES));
  if (input !== null) {
    if (!child.stdin || typeof child.stdin.end !== "function") return Promise.reject(failed());
    try { child.stdin.end(input, "utf8"); } catch { return Promise.reject(failed()); }
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener?.("error", onError);
      child.removeListener?.("close", onClose);
      child.removeListener?.("exit", onExit);
    };
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onError = () => finish(() => reject(failed()));
    const onClose = (code, signal) => finish(() => {
      if (code !== 0 || signal) return reject(failed());
      if (stderr.overflow) return reject(failed());
      resolve({ stdout: Buffer.concat(stdout.chunks).toString("utf8") });
    });
    const onExit = (code, signal) => {
      // `exit` is enough for the security helper; a later `close` is ignored.
      onClose(code, signal);
    };
    timer = setTimeout(() => finish(() => {
      try { child.kill?.(); } catch { /* process cleanup is best effort */ }
      reject(failed("OPENBOT_KEYCHAIN_TIMEOUT"));
    }), SECURITY_TIMEOUT_MS);
    timer.unref?.();
    child.once("error", onError);
    child.once("close", onClose);
    child.once("exit", onExit);
  });
}

class KeychainSecretStore {
  #service;
  #spawn;

  constructor(rawOptions = {}) {
    const options = ownData(rawOptions, new Set(["service", "spawn"]));
    if (options.service !== SERVICE || typeof options.spawn !== "function") throw invalid();
    this.#service = options.service;
    this.#spawn = options.spawn;
  }

  set(rawAccount, rawSecret) {
    let account;
    let secret;
    try {
      account = safeAccount(rawAccount);
      secret = safeSecret(rawSecret);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#run([
      "add-generic-password", "-U", "-s", this.#service, "-a", account, "-w",
    ], { input: secret }).then(() => undefined);
  }

  read(rawAccount) {
    let account;
    try { account = safeAccount(rawAccount); } catch (error) { return Promise.reject(error); }
    return this.#run([
      "find-generic-password", "-s", this.#service, "-a", account, "-w",
    ], { captureStdout: true, allowMissing: true }).then(({ stdout }) => {
      if (stdout.length === 0) return null;
      let secret = stdout;
      if (secret.endsWith("\n")) secret = secret.slice(0, -1);
      if (secret.endsWith("\r")) secret = secret.slice(0, -1);
      return safeSecret(secret);
    });
  }

  delete(rawAccount) {
    let account;
    try { account = safeAccount(rawAccount); } catch (error) { return Promise.reject(error); }
    return this.#run([
      "delete-generic-password", "-s", this.#service, "-a", account,
    ], { allowMissing: true }).then(() => undefined);
  }

  #run(args, { input = null, captureStdout = false, allowMissing = false } = {}) {
    let child;
    try {
      child = this.#spawn(SECURITY, args, {
        stdio: [input === null ? "ignore" : "pipe", captureStdout ? "pipe" : "ignore", "pipe"],
      });
    } catch {
      return Promise.reject(failed());
    }
    return settledSecurityChild(child, { input, captureStdout }).catch((error) => {
      // `security find-generic-password` uses status 44 when no matching item
      // exists. The child helper intentionally keeps process details private;
      // recognize that one status without exposing stderr or argv.
      if (allowMissing && child.exitCode === 44) return { stdout: "" };
      throw error instanceof KeychainSecretStoreError ? error : failed();
    });
  }
}

module.exports = {
  KEYCHAIN_SERVICE: SERVICE,
  KeychainSecretStore,
  KeychainSecretStoreError,
  settledSecurityChild,
};
