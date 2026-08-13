"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-oauth-link-test-"));
process.env.CODEX_BOT_STATE_ROOT = stateRoot;
process.env.GROK_BOT_CLIPROXY_EXE = __filename;
process.env.GROK_BOT_CLIPROXY_CONFIG = path.join(stateRoot, "cliproxy.yaml");

const connection = require(path.join(root, "src", "codex-connection.cjs"));
const OFFICIAL_DEVICE_URL = "https://auth.openai.com/codex/device";

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("Codex device links are canonicalized to the official OpenAI endpoint only", () => {
  assert.equal(connection.normalizeCodexDeviceUrl(OFFICIAL_DEVICE_URL), OFFICIAL_DEVICE_URL);
  assert.equal(connection.normalizeCodexDeviceUrl(`${OFFICIAL_DEVICE_URL}/`), OFFICIAL_DEVICE_URL);

  for (const rejected of [
    "http://auth.openai.com/codex/device",
    "https://cursor.com/loginDeepControl",
    "https://x.ai/bot",
    "https://auth.openai.com.evil.example/codex/device",
    "https://auth.openai.com@evil.example/codex/device",
    "https://auth.openai.com/codex/device?next=https://cursor.com",
    "https://auth.openai.com/codex/device#cursor",
    "https://auth.openai.com/other",
    "not a URL",
  ]) {
    assert.equal(connection.normalizeCodexDeviceUrl(rejected), null, rejected);
  }
});

function fakeCliProxy() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test("the OAuth handoff returns a canonical OpenAI link and rejects vendor links", async (t) => {
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
    globalThis[Symbol.for("codexbot.connection.oauth")] = null;
  });

  await t.test("official OpenAI device output", async () => {
    const child = fakeCliProxy();
    childProcess.spawn = () => child;
    const resultPromise = connection.beginCodexOAuth();
    child.stdout.emit("data", `Codex device URL: ${OFFICIAL_DEVICE_URL}\nCodex device code: ABCD-EFGH\n`);
    const result = await resultPromise;
    assert.equal(result.url, OFFICIAL_DEVICE_URL);
    assert.equal(result.code, "ABCD-EFGH");
    globalThis[Symbol.for("codexbot.connection.oauth")] = null;
  });

  await t.test("unexpected vendor device output", async () => {
    const child = fakeCliProxy();
    childProcess.spawn = () => child;
    const resultPromise = connection.beginCodexOAuth();
    child.stderr.emit("data", "Codex device URL: https://cursor.com/loginDeepControl\nCodex device code: WXYZ-1234\n");
    await assert.rejects(resultPromise, /Only the official OpenAI device page is allowed/);
    assert.equal(child.killed, true);
    globalThis[Symbol.for("codexbot.connection.oauth")] = null;
  });
});

test("the first-run renderer opens only the canonical device link in the external-browser path", () => {
  const ui = fs.readFileSync(path.join(root, "src", "renderer", "codex-ui.js"), "utf8");
  assert.match(ui, /const CODEX_DEVICE_URL = "https:\/\/auth\.openai\.com\/codex\/device";/);
  assert.match(ui, /device\?\.url !== CODEX_DEVICE_URL/);
  assert.match(ui, /link\.href = CODEX_DEVICE_URL;/);
  assert.match(ui, /link\.target = "_blank";/);
  assert.match(ui, /link\.rel = "noreferrer";/);
});
