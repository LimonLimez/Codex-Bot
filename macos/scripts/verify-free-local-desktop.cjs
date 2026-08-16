#!/usr/bin/env node
"use strict";

const { types } = require("node:util");

const REPORT_FIELDS = Object.freeze([
  "result", "commit", "appVersion", "botCount", "distinctProfiles",
  "youtubeCurrentFrame", "denyZeroEffects", "onceExpired", "perBotIsolation",
  "revoked", "subagentWorkspaceIsolation", "cleanup", "evidenceHashes",
]);
const BOOLEAN_FIELDS = Object.freeze([
  "distinctProfiles", "youtubeCurrentFrame", "denyZeroEffects", "onceExpired",
  "perBotIsolation", "revoked", "subagentWorkspaceIsolation", "cleanup",
]);

function fail() {
  const error = new Error("Free Local Desktop verification failed.");
  error.code = "FREE_LOCAL_DESKTOP_VERIFICATION_FAILED";
  throw error;
}

function exactRecord(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) fail();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch { fail(); }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || !fields.includes(key) || !("value" in descriptors[key]))
    || fields.some((field) => !descriptors[field])) fail();
  return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
}

function exactHashes(value) {
  if (!Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype) fail();
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(); }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 16
    || Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)))) fail();
  const hashes = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor)
      || typeof descriptor.value !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.value)) fail();
    hashes.push(descriptor.value);
  }
  return Object.freeze(hashes);
}

function publicReport(value) {
  const report = exactRecord(value, REPORT_FIELDS);
  if (!new Set(["PASS", "BLOCKED", "FAIL"]).has(report.result)
    || (report.commit !== null && (typeof report.commit !== "string" || !/^[a-f0-9]{40}$/.test(report.commit)))
    || (report.appVersion !== null && (typeof report.appVersion !== "string"
      || !/^\d+\.\d+\.\d+-macos\.\d+$/.test(report.appVersion)))
    || !Number.isSafeInteger(report.botCount) || report.botCount < 0 || report.botCount > 2
    || BOOLEAN_FIELDS.some((field) => typeof report[field] !== "boolean")) fail();
  const evidenceHashes = exactHashes(report.evidenceHashes);
  if (report.result === "PASS" && (report.commit === null || report.appVersion === null
    || report.botCount !== 2 || BOOLEAN_FIELDS.some((field) => report[field] !== true)
    || evidenceHashes.length === 0)) fail();
  return Object.freeze({
    result: report.result,
    commit: report.commit,
    appVersion: report.appVersion,
    botCount: report.botCount,
    distinctProfiles: report.distinctProfiles,
    youtubeCurrentFrame: report.youtubeCurrentFrame,
    denyZeroEffects: report.denyZeroEffects,
    onceExpired: report.onceExpired,
    perBotIsolation: report.perBotIsolation,
    revoked: report.revoked,
    subagentWorkspaceIsolation: report.subagentWorkspaceIsolation,
    cleanup: report.cleanup,
    evidenceHashes,
  });
}

function emptyReport(result) {
  return Object.freeze({
    result,
    commit: null,
    appVersion: null,
    botCount: 0,
    distinctProfiles: false,
    youtubeCurrentFrame: false,
    denyZeroEffects: false,
    onceExpired: false,
    perBotIsolation: false,
    revoked: false,
    subagentWorkspaceIsolation: false,
    cleanup: false,
    evidenceHashes: Object.freeze([]),
  });
}

function blockedReport() {
  return emptyReport("BLOCKED");
}

function defaultConfiguration(env) {
  if (!env || typeof env !== "object" || env.OPENBOT_FREE_LOCAL_APP === undefined) return null;
  return Object.freeze({ app: env.OPENBOT_FREE_LOCAL_APP });
}

async function unavailableLiveGate() {
  const error = new Error("Free Local Desktop live verification is not configured.");
  error.code = "FREE_LOCAL_DESKTOP_BLOCKED";
  throw error;
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  resolveConfiguration = defaultConfiguration,
  runGate = unavailableLiveGate,
} = {}) {
  let report = blockedReport();
  let status = "BLOCKED";
  let code = 2;
  try {
    if (!Array.isArray(argv) || argv.length !== 0) fail();
    const configuration = resolveConfiguration(env);
    if (configuration !== null) {
      report = publicReport(await runGate(configuration));
      status = report.result;
      code = status === "PASS" ? 0 : status === "BLOCKED" ? 2 : 1;
    }
  } catch (error) {
    if (error?.code !== "FREE_LOCAL_DESKTOP_BLOCKED") {
      report = emptyReport("FAIL");
      status = "FAIL";
      code = 1;
    }
  }
  stdout.write(`FREE_LOCAL_DESKTOP=${status}\n`);
  stdout.write(`FREE_LOCAL_DESKTOP_REPORT=${JSON.stringify(report)}\n`);
  return code;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    process.stdout.write("FREE_LOCAL_DESKTOP=FAIL\n");
    process.exitCode = 1;
  });
}

module.exports = { blockedReport, main, publicReport };
