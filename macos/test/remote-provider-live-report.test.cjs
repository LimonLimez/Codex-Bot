"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let publicGateReport;
let writeGateReport;
let moduleLoadError = null;
try {
  ({
    publicGateReport,
    writeGateReport,
  } = require("../src/bots/remote-provider-live-report.cjs"));
} catch (error) {
  moduleLoadError = error;
}

const BOT_A = "bot-00000000-0000-4000-8000-000000000001";
const BOT_B = "bot-00000000-0000-4000-8000-000000000002";

async function outputDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bot-live-report-test-"));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function privateResult(overrides = {}) {
  return {
    status: "PASS",
    startedAt: "2026-08-15T12:00:00.000Z",
    finishedAt: "2026-08-15T12:01:00.000Z",
    provider: "fixture-provider",
    bots: [
      { botId: BOT_A, runtimeId: "runtime-1", generation: 1 },
      { botId: BOT_B, runtimeId: "runtime-2", generation: 1 },
    ],
    capabilities: {
      provision: true,
      reconcile: true,
      retire: true,
      remoteAppServer: true,
      computerFrames: true,
    },
    protocol: [
      { botId: BOT_A, accountReadable: true, modelCount: 1 },
      { botId: BOT_B, accountReadable: true, modelCount: 1 },
    ],
    computer: {
      browser: "Google Chrome",
      host: "www.youtube.com",
      titleMarker: "YouTube",
      frameReceived: true,
    },
    isolation: { crossBotFrameCount: 0, passed: true },
    cleanup: {
      safe: true,
      retiredRuntimeCount: 2,
      terminalRuntimeCount: 2,
      storeRemoved: true,
    },
    endpoint: "wss://runtime.example/private?access_token=never-print",
    authToken: "private-auth-token-value",
    account: { email: "private@example.com" },
    providerDiagnostic: "/Users/private/source",
    ...overrides,
  };
}

test("builds an exact frozen sanitized live gate report", () => {
  assert.ifError(moduleLoadError);

  const report = publicGateReport(privateResult());

  assert.deepEqual(Reflect.ownKeys(report), [
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
  assert.deepEqual(report.bots, [
    { botId: BOT_A, runtimeFingerprint: "sha256:168957e8d7dc810a", generation: 1 },
    { botId: BOT_B, runtimeFingerprint: "sha256:74ca72ca5d6e920e", generation: 1 },
  ]);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.bots), true);
  assert.equal(Object.isFrozen(report.bots[0]), true);
  assert.doesNotMatch(JSON.stringify(report), /access_token|authToken|private@example|\/Users\/private|wss:/i);
});

test("writes atomic private JSON and Markdown reports without secret material", async (t) => {
  assert.ifError(moduleLoadError);
  const directory = await outputDirectory(t);
  const report = publicGateReport(privateResult());

  const paths = await writeGateReport({ report, outputDirectory: directory });

  assert.deepEqual(paths, {
    jsonPath: path.join(directory, "result.json"),
    markdownPath: path.join(directory, "result.md"),
  });
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(paths.jsonPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(paths.markdownPath)).mode & 0o777, 0o600);
  const output = `${await fs.readFile(paths.jsonPath, "utf8")}\n${await fs.readFile(paths.markdownPath, "utf8")}`;
  assert.match(output, /REMOTE_PROVIDER_GATE=PASS|"status": "PASS"/);
  assert.doesNotMatch(output, /access_token|authToken|private@example|\/Users\/private|wss:|runtime-1|runtime-2/i);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["result.json", "result.md"]);
});

test("serializes report ownership so concurrent writers cannot mix JSON and Markdown", async (t) => {
  const directory = await outputDirectory(t);
  const first = publicGateReport(privateResult({ provider: "provider-first" }));
  const second = publicGateReport(privateResult({ provider: "provider-second" }));

  const outcomes = await Promise.allSettled([
    writeGateReport({ report: first, outputDirectory: directory }),
    writeGateReport({ report: second, outputDirectory: directory }),
  ]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  const json = await fs.readFile(path.join(directory, "result.json"), "utf8");
  const markdown = await fs.readFile(path.join(directory, "result.md"), "utf8");
  const provider = JSON.parse(json).provider;
  assert.match(markdown, new RegExp(`Provider: ${provider}`));
  assert.deepEqual((await fs.readdir(directory)).sort(), ["result.json", "result.md"]);
});

test("rejects hostile report inputs and unsafe output destinations", async (t) => {
  assert.ifError(moduleLoadError);
  const hostile = new Proxy({}, { ownKeys() { throw new Error("private-proxy-path"); } });
  assert.throws(() => publicGateReport(hostile), {
    code: "REMOTE_PROVIDER_GATE_FAILED",
    message: "Remote provider verification failed.",
  });

  const directory = await outputDirectory(t);
  const target = path.join(directory, "outside.json");
  await fs.writeFile(target, "owned", { mode: 0o600 });
  await fs.symlink(target, path.join(directory, "result.json"));
  await assert.rejects(
    writeGateReport({ report: publicGateReport(privateResult()), outputDirectory: directory }),
    { code: "REMOTE_PROVIDER_GATE_FAILED" },
  );
  assert.equal(await fs.readFile(target, "utf8"), "owned");
});
