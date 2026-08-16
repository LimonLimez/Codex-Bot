"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const verifierPath = path.join(__dirname, "..", "scripts", "verify-free-local-desktop.cjs");

const EXPECTED_REPORT_KEYS = Object.freeze([
  "appVersion",
  "botCount",
  "cleanup",
  "commit",
  "denyZeroEffects",
  "distinctProfiles",
  "evidenceHashes",
  "onceExpired",
  "perBotIsolation",
  "result",
  "revoked",
  "subagentWorkspaceIsolation",
  "youtubeCurrentFrame",
]);

function outputCollector() {
  let value = "";
  return Object.freeze({
    stream: Object.freeze({ write(chunk) { value += String(chunk); } }),
    value() { return value; },
  });
}

test("Free Local Desktop verifier is fail-closed and emits only sanitized bounded evidence", async () => {
  const { main } = require(verifierPath);
  const output = outputCollector();
  const exitCode = await main({ argv: [], env: Object.freeze({}), stdout: output.stream });
  const lines = output.value().trim().split("\n");

  assert.equal(exitCode, 2);
  assert.equal(lines[0], "FREE_LOCAL_DESKTOP=BLOCKED");
  assert.match(lines[1], /^FREE_LOCAL_DESKTOP_REPORT=/);
  const report = JSON.parse(lines[1].slice("FREE_LOCAL_DESKTOP_REPORT=".length));
  assert.deepEqual(Object.keys(report).sort(), EXPECTED_REPORT_KEYS);
  assert.deepEqual(report, {
    result: "BLOCKED",
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
    evidenceHashes: [],
  });
  assert.doesNotMatch(
    JSON.stringify(report),
    /Users|home[/\\]|token|bookmark|cookie|endpoint|prompt|screenshot|frameBytes|workspaceName/i,
  );
});

test("Free Local Desktop report accepts only an exact frozen public result", () => {
  const { publicReport } = require(verifierPath);
  const raw = {
    result: "PASS",
    commit: "a".repeat(40),
    appVersion: "0.2.0-macos.1",
    botCount: 2,
    distinctProfiles: true,
    youtubeCurrentFrame: true,
    denyZeroEffects: true,
    onceExpired: true,
    perBotIsolation: true,
    revoked: true,
    subagentWorkspaceIsolation: true,
    cleanup: true,
    evidenceHashes: ["b".repeat(64), "c".repeat(64)],
  };
  const report = publicReport(raw);

  assert.deepEqual(report, raw);
  assert.notEqual(report, raw);
  assert.notEqual(report.evidenceHashes, raw.evidenceHashes);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.evidenceHashes), true);

  let privateReads = 0;
  const hostile = { ...raw };
  Object.defineProperty(hostile, "privatePath", {
    enumerable: true,
    get() { privateReads += 1; return "/Users/private/project"; },
  });
  assert.throws(() => publicReport(hostile), /Free Local Desktop verification failed/);
  assert.equal(privateReads, 0);
  assert.throws(
    () => publicReport({ ...raw, commit: "not-a-commit" }),
    /Free Local Desktop verification failed/,
  );
  assert.throws(
    () => publicReport({ ...raw, evidenceHashes: ["d".repeat(64), , "e".repeat(64)] }),
    /Free Local Desktop verification failed/,
  );
});

test("only the built-in configured live lane can publish a PASS report", async () => {
  const { main } = require(verifierPath);
  const output = outputCollector();
  const calls = [];
  const expected = {
    result: "PASS",
    commit: "d".repeat(40),
    appVersion: "0.2.0-macos.1",
    botCount: 2,
    distinctProfiles: true,
    youtubeCurrentFrame: true,
    denyZeroEffects: true,
    onceExpired: true,
    perBotIsolation: true,
    revoked: true,
    subagentWorkspaceIsolation: true,
    cleanup: true,
    evidenceHashes: ["e".repeat(64)],
  };
  const exitCode = await main({
    argv: [],
    env: Object.freeze({ OPENBOT_FREE_LOCAL_APP: "configured" }),
    stdout: output.stream,
    resolveConfiguration(env) {
      calls.push(["configure", env.OPENBOT_FREE_LOCAL_APP]);
      return Object.freeze({ app: "reviewed-live-app" });
    },
    async runGate(configuration) {
      calls.push(["run", configuration.app]);
      return expected;
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [["configure", "configured"], ["run", "reviewed-live-app"]]);
  const lines = output.value().trim().split("\n");
  assert.equal(lines[0], "FREE_LOCAL_DESKTOP=PASS");
  assert.deepEqual(
    JSON.parse(lines[1].slice("FREE_LOCAL_DESKTOP_REPORT=".length)),
    expected,
  );
});
