"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { types } = require("node:util");

const EXPECTED_IDENTITY = Object.freeze({
  identifier: "codex",
  architecture: "arm64",
  version: "0.147.0",
  signer: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
  teamIdentifier: "2DC432GLL2",
  cdHash: "95686307357ad315175f553a68dce5c62d0ff435",
  hardenedRuntime: true,
  timestamped: true,
});
const EXPECTED_RUNTIME = Object.freeze({
  version: "0.147.0",
  bytes: 219997536,
  sha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
});

class CodexRuntimeIntegrityError extends Error {
  constructor(message = "Codex runtime integrity verification failed.") {
    super(message);
    this.name = "CodexRuntimeIntegrityError";
    this.code = "CODEX_RUNTIME_INTEGRITY_FAILED";
  }
}

function plainData(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new CodexRuntimeIntegrityError(`Invalid Codex ${label}.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CodexRuntimeIntegrityError(`Invalid Codex ${label}.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string") || keys.some((key) => !("value" in descriptors[key]))) {
    throw new CodexRuntimeIntegrityError(`Invalid Codex ${label}.`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new CodexRuntimeIntegrityError(`Invalid Codex ${label} shape.`);
  }
}

function validateIdentity(value) {
  const identity = plainData(value, "runtime identity");
  exactKeys(identity, Object.keys(EXPECTED_IDENTITY), "runtime identity");
  for (const [key, expected] of Object.entries(EXPECTED_IDENTITY)) {
    if (identity[key] !== expected) {
      throw new CodexRuntimeIntegrityError(`Codex runtime identity mismatch: ${key}.`);
    }
  }
  return Object.freeze({ ...identity });
}

function validateReceipt(value) {
  const receipt = plainData(value, "runtime receipt");
  exactKeys(receipt, ["schemaVersion", "version", "bytes", "sha256", "identity"], "runtime receipt");
  if (receipt.schemaVersion !== 1 || receipt.version !== "0.147.0"
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1
    || typeof receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
    throw new CodexRuntimeIntegrityError("Invalid Codex runtime receipt.");
  }
  return Object.freeze({
    schemaVersion: 1,
    version: receipt.version,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    identity: validateIdentity(receipt.identity),
  });
}

function validatePackagedReceipt(value, expectedRuntime = EXPECTED_RUNTIME) {
  const receipt = validateReceipt(value);
  const expected = plainData(expectedRuntime, "pinned runtime");
  exactKeys(expected, ["version", "bytes", "sha256"], "pinned runtime");
  if (typeof expected.version !== "string"
    || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1
    || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)
    || receipt.version !== expected.version
    || receipt.bytes !== expected.bytes
    || receipt.sha256 !== expected.sha256) {
    throw new CodexRuntimeIntegrityError("Codex runtime receipt does not match the pinned release.");
  }
  return receipt;
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

async function defaultRun(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  if (result.error || result.status !== 0) throw new CodexRuntimeIntegrityError();
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function probeCodexIdentity(binaryPath, { run = defaultRun } = {}) {
  if (typeof binaryPath !== "string" || !path.isAbsolute(binaryPath) || typeof run !== "function") {
    throw new CodexRuntimeIntegrityError();
  }
  let architecture;
  let version;
  let signature;
  try {
    architecture = await run("/usr/bin/file", [binaryPath]);
    version = await run(binaryPath, ["--version"]);
    await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", binaryPath]);
    signature = await run("/usr/bin/codesign", ["-dvvv", "--strict", binaryPath]);
  } catch {
    throw new CodexRuntimeIntegrityError();
  }
  const identity = {
    identifier: /^Identifier=(.+)$/m.exec(signature)?.[1] || null,
    architecture: /Mach-O 64-bit executable arm64(?:\s|$)/m.test(architecture) ? "arm64" : null,
    version: /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(version.trim())?.[1] || null,
    signer: /^Authority=(Developer ID Application:.+)$/m.exec(signature)?.[1] || null,
    teamIdentifier: /^TeamIdentifier=(.+)$/m.exec(signature)?.[1] || null,
    cdHash: /^CDHash=([a-f0-9]+)$/m.exec(signature)?.[1] || null,
    hardenedRuntime: /(?:^|\s)flags=.*\(runtime\)/m.test(signature),
    timestamped: /^Timestamp=.+$/m.test(signature),
  };
  return Object.freeze(identity);
}

async function verifyCodexRuntime({ binaryPath, receipt, probeIdentity = probeCodexIdentity } = {}) {
  if (typeof binaryPath !== "string" || !path.isAbsolute(binaryPath) || typeof probeIdentity !== "function") {
    throw new CodexRuntimeIntegrityError();
  }
  const expected = validateReceipt(receipt);
  let stat;
  try { stat = fs.lstatSync(binaryPath); } catch { throw new CodexRuntimeIntegrityError(); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CodexRuntimeIntegrityError("Codex runtime must be a regular non-symlink file.");
  }
  if ((stat.mode & 0o111) === 0) {
    throw new CodexRuntimeIntegrityError("Codex runtime is not executable.");
  }
  if (stat.size !== expected.bytes || sha256File(binaryPath) !== expected.sha256) {
    throw new CodexRuntimeIntegrityError();
  }
  let identity;
  try { identity = await probeIdentity(binaryPath); } catch { throw new CodexRuntimeIntegrityError(); }
  validateIdentity(identity);
  return Object.freeze({ binaryPath, version: expected.version });
}

async function loadPackagedCodexRuntime(resourcesPath, {
  probeIdentity = probeCodexIdentity,
  expectedRuntime = EXPECTED_RUNTIME,
} = {}) {
  if (typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) {
    throw new CodexRuntimeIntegrityError();
  }
  const runtimeRoot = path.join(resourcesPath, "codex", "runtime");
  const receiptPath = path.join(runtimeRoot, "receipt.json");
  const binaryPath = path.join(runtimeRoot, "codex");
  let receiptStat;
  try { receiptStat = fs.lstatSync(receiptPath); } catch { throw new CodexRuntimeIntegrityError(); }
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size < 100 || receiptStat.size > 2048) {
    throw new CodexRuntimeIntegrityError("Invalid Codex runtime receipt.");
  }
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); } catch { throw new CodexRuntimeIntegrityError(); }
  return verifyCodexRuntime({
    binaryPath,
    receipt: validatePackagedReceipt(receipt, expectedRuntime),
    probeIdentity,
  });
}

module.exports = {
  CodexRuntimeIntegrityError,
  EXPECTED_IDENTITY,
  EXPECTED_RUNTIME,
  loadPackagedCodexRuntime,
  probeCodexIdentity,
  sha256File,
  validateIdentity,
  validatePackagedReceipt,
  validateReceipt,
  verifyCodexRuntime,
};
