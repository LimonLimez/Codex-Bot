"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { types } = require("node:util");

const FAILED_CODE = "REMOTE_PROVIDER_GATE_FAILED";
const FAILED_MESSAGE = "Remote provider verification failed.";
const STATUS = new Set(["PASS", "BLOCKED", "FAIL"]);
const CAPABILITY_KEYS = Object.freeze([
  "provision",
  "reconcile",
  "retire",
  "remoteAppServer",
  "computerFrames",
]);
const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{16}$/;

function failedError() {
  const error = new Error(FAILED_MESSAGE);
  error.name = "RemoteProviderGateError";
  error.code = FAILED_CODE;
  error.stack = `${error.name}: ${FAILED_MESSAGE}`;
  return error;
}

function descriptors(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw failedError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failedError();
  const result = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(result);
  if (keys.some((key) => typeof key !== "string" || !("value" in result[key]))) throw failedError();
  if (expectedKeys) {
    if ([...keys].sort().join(",") !== [...expectedKeys].sort().join(",")) throw failedError();
  }
  return result;
}

function value(descriptorMap, key) {
  if (!Object.prototype.hasOwnProperty.call(descriptorMap, key)) throw failedError();
  return descriptorMap[key].value;
}

function validTimestamp(input) {
  if (typeof input !== "string") return false;
  const milliseconds = Date.parse(input);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input;
}

function deepFreeze(input, seen = new Set()) {
  if (!input || typeof input !== "object" || seen.has(input)) return input;
  seen.add(input);
  for (const nested of Object.values(input)) deepFreeze(nested, seen);
  return Object.freeze(input);
}

function runtimeFingerprint(runtimeId) {
  if (typeof runtimeId !== "string" || !SAFE_IDENTIFIER.test(runtimeId)) throw failedError();
  return `sha256:${createHash("sha256").update(runtimeId).digest("hex").slice(0, 16)}`;
}

function normalizedCapabilities(input) {
  const map = descriptors(input, CAPABILITY_KEYS);
  const result = {};
  for (const key of CAPABILITY_KEYS) {
    if (map[key].value !== true) throw failedError();
    result[key] = true;
  }
  return result;
}

function normalizedBots(input) {
  if (!Array.isArray(input) || input.length !== 2) throw failedError();
  const seenBots = new Set();
  const seenRuntimes = new Set();
  return input.map((entry) => {
    const map = descriptors(entry);
    const botId = value(map, "botId");
    const runtimeId = value(map, "runtimeId");
    const generation = value(map, "generation");
    if (typeof botId !== "string" || !BOT_ID.test(botId)
      || seenBots.has(botId.toLowerCase())
      || typeof runtimeId !== "string" || !SAFE_IDENTIFIER.test(runtimeId)
      || seenRuntimes.has(runtimeId)
      || !Number.isSafeInteger(generation) || generation < 1) throw failedError();
    seenBots.add(botId.toLowerCase());
    seenRuntimes.add(runtimeId);
    return { botId: botId.toLowerCase(), runtimeFingerprint: runtimeFingerprint(runtimeId), generation };
  });
}

function normalizedProtocol(input, bots) {
  if (!Array.isArray(input) || input.length !== 2) throw failedError();
  return input.map((entry, index) => {
    const map = descriptors(entry, ["botId", "accountReadable", "modelCount"]);
    const botId = value(map, "botId");
    const accountReadable = value(map, "accountReadable");
    const modelCount = value(map, "modelCount");
    if (botId !== bots[index].botId || accountReadable !== true
      || !Number.isSafeInteger(modelCount) || modelCount < 1 || modelCount > 4096) throw failedError();
    return { botId, accountReadable: true, modelCount };
  });
}

function normalizedComputer(input) {
  const map = descriptors(input, ["browser", "host", "titleMarker", "frameReceived"]);
  if (value(map, "browser") !== "Google Chrome"
    || value(map, "host") !== "www.youtube.com"
    || value(map, "titleMarker") !== "YouTube"
    || value(map, "frameReceived") !== true) throw failedError();
  return { browser: "Google Chrome", host: "www.youtube.com", titleMarker: "YouTube", frameReceived: true };
}

function normalizedIsolation(input) {
  const map = descriptors(input, ["crossBotFrameCount", "passed"]);
  if (value(map, "crossBotFrameCount") !== 0 || value(map, "passed") !== true) throw failedError();
  return { crossBotFrameCount: 0, passed: true };
}

function normalizedCleanup(input) {
  const map = descriptors(input, [
    "safe",
    "retiredRuntimeCount",
    "terminalRuntimeCount",
    "storeRemoved",
  ]);
  if (value(map, "safe") !== true
    || value(map, "retiredRuntimeCount") !== 2
    || value(map, "terminalRuntimeCount") !== 2
    || value(map, "storeRemoved") !== true) throw failedError();
  return { safe: true, retiredRuntimeCount: 2, terminalRuntimeCount: 2, storeRemoved: true };
}

function assertNoSensitiveOutput(serialized) {
  if (/wss:|authorization|auth.?token|access.?token|refresh.?token|session.?token|api.?key|cookie|password|credential|\/Users\//i.test(serialized)) {
    throw failedError();
  }
}

function publicGateReport(input) {
  try {
    const map = descriptors(input);
    const status = value(map, "status");
    const startedAt = value(map, "startedAt");
    const finishedAt = value(map, "finishedAt");
    const provider = value(map, "provider");
    if (!STATUS.has(status) || !validTimestamp(startedAt) || !validTimestamp(finishedAt)
      || Date.parse(finishedAt) < Date.parse(startedAt)
      || typeof provider !== "string" || !SAFE_IDENTIFIER.test(provider)) throw failedError();
    const bots = normalizedBots(value(map, "bots"));
    const report = {
      schemaVersion: 1,
      status,
      startedAt,
      finishedAt,
      provider,
      bots,
      capabilities: normalizedCapabilities(value(map, "capabilities")),
      protocol: normalizedProtocol(value(map, "protocol"), bots),
      computer: normalizedComputer(value(map, "computer")),
      isolation: normalizedIsolation(value(map, "isolation")),
      cleanup: normalizedCleanup(value(map, "cleanup")),
    };
    assertNoSensitiveOutput(JSON.stringify(report));
    return deepFreeze(report);
  } catch (error) {
    if (error?.code === FAILED_CODE) throw error;
    throw failedError();
  }
}

function validatedPublicReport(input) {
  const map = descriptors(input, [
    "schemaVersion",
    "status",
    "startedAt",
    "finishedAt",
    "provider",
    "bots",
    "capabilities",
    "protocol",
    "computer",
    "isolation",
    "cleanup",
  ]);
  if (value(map, "schemaVersion") !== 1 || !Object.isFrozen(input)) throw failedError();
  assertNoSensitiveOutput(JSON.stringify(input));
  return input;
}

function markdownReport(report) {
  return [
    "# Codex Bot Remote Provider Live Gate",
    "",
    `REMOTE_PROVIDER_GATE=${report.status}`,
    "",
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Provider: ${report.provider}`,
    `- Bot A runtime: ${report.bots[0].runtimeFingerprint}`,
    `- Bot B runtime: ${report.bots[1].runtimeFingerprint}`,
    `- Chrome: ${report.computer.browser}`,
    `- Host: ${report.computer.host}`,
    `- Isolation: ${report.isolation.passed ? "PASS" : "FAIL"}`,
    `- Cleanup: ${report.cleanup.safe ? "PASS" : "FAIL"}`,
    "",
  ].join("\n");
}

async function absentDestination(filePath) {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw failedError();
  }
  throw failedError();
}

async function privateOutputDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw failedError();
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw failedError();
  return value;
}

async function writeExclusive(filePath, content) {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeGateReport(options) {
  const ownedTemps = [];
  const committed = [];
  let lockHandle = null;
  let ownedLockPath = null;
  try {
    const map = descriptors(options, ["report", "outputDirectory"]);
    const report = validatedPublicReport(value(map, "report"));
    const directory = await privateOutputDirectory(value(map, "outputDirectory"));
    const lockPath = path.join(directory, ".remote-provider-gate.lock");
    lockHandle = await fs.open(lockPath, "wx", 0o600);
    ownedLockPath = lockPath;
    const jsonPath = path.join(directory, "result.json");
    const markdownPath = path.join(directory, "result.md");
    await absentDestination(jsonPath);
    await absentDestination(markdownPath);
    const nonce = randomUUID();
    const jsonTemp = path.join(directory, `.result-${nonce}.json.tmp`);
    const markdownTemp = path.join(directory, `.result-${nonce}.md.tmp`);
    ownedTemps.push(jsonTemp, markdownTemp);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = markdownReport(report);
    assertNoSensitiveOutput(`${json}\n${markdown}`);
    await writeExclusive(jsonTemp, json);
    await writeExclusive(markdownTemp, markdown);
    await fs.rename(jsonTemp, jsonPath);
    ownedTemps.splice(ownedTemps.indexOf(jsonTemp), 1);
    committed.push(jsonPath);
    await fs.rename(markdownTemp, markdownPath);
    ownedTemps.splice(ownedTemps.indexOf(markdownTemp), 1);
    committed.push(markdownPath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    await lockHandle.close();
    lockHandle = null;
    await fs.unlink(ownedLockPath);
    ownedLockPath = null;
    return Object.freeze({ jsonPath, markdownPath });
  } catch {
    if (lockHandle) {
      try { await lockHandle.close(); } catch {}
      lockHandle = null;
    }
    if (ownedLockPath) {
      try { await fs.unlink(ownedLockPath); } catch {}
      ownedLockPath = null;
    }
    for (const filePath of [...ownedTemps, ...committed]) {
      try {
        await fs.unlink(filePath);
      } catch {
        // Cleanup targets only files created by this call.
      }
    }
    throw failedError();
  }
}

module.exports = {
  publicGateReport,
  runtimeFingerprint,
  writeGateReport,
};
