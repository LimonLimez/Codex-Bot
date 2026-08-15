"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const runtimePath = path.join(__dirname, "..", "src", "desktop", "runtime.cjs");
const selectionPath = path.join(__dirname, "..", "src", "desktop", "model-selection-store.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-desktop-runtime-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("desktop runtime loads only an exact sealed sidecar receipt", (t) => {
  const { loadSidecarReceipt } = require(runtimePath);
  const root = tempRoot(t);
  const sidecarRoot = path.join(root, "codex", "cliproxy");
  fs.mkdirSync(sidecarRoot, { recursive: true });
  fs.writeFileSync(path.join(sidecarRoot, "receipt.json"), JSON.stringify({
    bytes: 58169264,
    sha256: "d".repeat(64),
  }));
  assert.deepEqual(loadSidecarReceipt(root), {
    bytes: 58169264,
    sha256: "d".repeat(64),
  });
  assert.equal(Object.isFrozen(loadSidecarReceipt(root)), true);
  fs.writeFileSync(path.join(sidecarRoot, "receipt.json"), JSON.stringify({
    bytes: 58169264,
    sha256: "d".repeat(64),
    endpoint: "private",
  }));
  assert.throws(() => loadSidecarReceipt(root), /receipt/i);
  fs.rmSync(path.join(sidecarRoot, "receipt.json"));
  fs.symlinkSync(path.join(root, "outside.json"), path.join(sidecarRoot, "receipt.json"));
  assert.throws(() => loadSidecarReceipt(root), /receipt/i);
});

test("desktop runtime registers the exact frozen bot/model boundary and keeps create zero-argument", async (t) => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const sends = [];
  const calls = [];
  const listeners = new Map();
  const bot = Object.freeze({
    botId: BOT_A,
    name: "New Bot",
    runtime: Object.freeze({ state: "ready" }),
  });
  const controller = {
    on(event, listener) { listeners.set(event, listener); },
    async listBots() { calls.push(["list"]); return [bot]; },
    async createBot() { calls.push(["create", arguments.length]); return bot; },
    async readBot(botId) { calls.push(["read", botId]); return bot; },
    async renameBot(botId, name) { calls.push(["rename", botId, name]); return { ...bot, name }; },
    async updateProfile(botId, profile) { calls.push(["profile", botId, profile]); return bot; },
    async retryRuntime(botId) { calls.push(["retry", botId]); return bot; },
    async runtimeSession(botId) {
      calls.push(["session", botId]);
      return Object.freeze({
        provider: "fixture",
        runtimeId: "runtime-a",
        endpoint: "wss://runtime.invalid/app-server",
        authToken: "opaque-private-token-value",
        generation: 7,
      });
    },
    dispose() { calls.push(["dispose"]); },
  };
  const selectionStore = {
    async selectBot(botId) { calls.push(["select-bot", botId]); return botId; },
    async write(selection) { calls.push(["select-model", selection]); return selection; },
    async read(botId) { calls.push(["read-model", botId]); return null; },
  };
  const sidecarManager = {
    async connectProvider(provider) { calls.push(["connect-provider", provider]); return undefined; },
    async start() {
      calls.push(["sidecar-start"]);
      const session = { endpoint: "http://127.0.0.1:54321/v1" };
      Object.defineProperty(session, "credential", { value: "f".repeat(64), enumerable: false });
      return Object.freeze(session);
    },
    stop() { calls.push(["sidecar-stop"]); },
  };
  t.after(() => {
    delete process.env.CODEX_BOT_CLIPROXY_URL;
    delete process.env.CODEX_BOT_CLIPROXY_TOKEN;
  });
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false);
        handlers.set(channel, handler);
      },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      getAllWindows() {
        return [{ webContents: { isDestroyed: () => false, send: (...args) => sends.push(args) } }];
      },
    },
  };
  const installed = installDesktopRuntime(electron, { controller, selectionStore, sidecarManager });
  assert.deepEqual(Object.keys(IPC_CHANNELS).sort(), [
    "adoptLegacy", "connectProvider", "create", "list", "read", "readModel", "rename", "retryRuntime",
    "selectBot", "selectModel", "updateProfile",
  ]);
  assert.equal(handlers.size, 11);
  assert.equal(Object.isFrozen(installed), true);

  await handlers.get(IPC_CHANNELS.create)({ sender: {} });
  assert.deepEqual(calls.find(([name]) => name === "create"), ["create", 0]);
  await handlers.get(IPC_CHANNELS.selectBot)({}, BOT_A);
  assert.deepEqual(calls.find(([name, selection]) => name === "select-model" && selection.reasoningEffort === "medium"), [
    "select-model",
    { botId: BOT_A, model: "gpt-5.6-sol", reasoningEffort: "medium", generation: 7 },
  ]);
  const selected = await handlers.get(IPC_CHANNELS.selectModel)({}, {
    botId: BOT_A,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  });
  assert.deepEqual(selected, {
    botId: BOT_A,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    generation: 7,
  });
  assert.doesNotMatch(JSON.stringify(selected), /endpoint|authToken|opaque-private|runtime-a/);
  assert.equal(await handlers.get(IPC_CHANNELS.connectProvider)({}, "claude"), undefined);
  assert.deepEqual(calls.find(([name]) => name === "connect-provider"), ["connect-provider", "claude"]);
  assert.deepEqual(calls.find(([name]) => name === "sidecar-start"), ["sidecar-start"]);
  assert.equal(process.env.CODEX_BOT_CLIPROXY_URL, "http://127.0.0.1:54321/v1");
  assert.equal(process.env.CODEX_BOT_CLIPROXY_TOKEN, "f".repeat(64));
  listeners.get("bot-changed")({ botId: BOT_A, bot });
  assert.deepEqual(sends, [["codex-bot:changed", bot]]);
  listeners.get("runtime-changed")({
    botId: BOT_A,
    runtime: { state: "reconnecting" },
    generation: 8,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sends.at(-1), ["codex-bot:changed", bot]);
  installed.dispose();
  assert.equal(process.env.CODEX_BOT_CLIPROXY_URL, undefined);
  assert.equal(process.env.CODEX_BOT_CLIPROXY_TOKEN, undefined);
  assert.equal(handlers.size, 0);
  assert.deepEqual(calls.slice(-2), [["sidecar-stop"], ["dispose"]]);
});

test("selecting a bot refreshes a retained model selection to the current runtime generation", async () => {
  const { installDesktopRuntime, IPC_CHANNELS } = require(runtimePath);
  const handlers = new Map();
  const writes = [];
  const bot = Object.freeze({ botId: BOT_A, name: "New Bot", runtime: Object.freeze({ state: "ready" }) });
  const controller = {
    on() {}, off() {}, dispose() {},
    async readBot() { return bot; },
    async runtimeSession() {
      return Object.freeze({
        provider: "fixture",
        runtimeId: "runtime-current",
        endpoint: "wss://runtime.invalid/app-server",
        authToken: "opaque-private-token-value",
        generation: 12,
      });
    },
  };
  const selectionStore = {
    async selectBot() {},
    async read() {
      return Object.freeze({
        botId: BOT_A,
        model: "gpt-5.6-terra",
        reasoningEffort: "max",
        generation: 11,
      });
    },
    async write(value) { writes.push(value); return value; },
  };
  const electron = {
    app: { once() {} },
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  const installed = installDesktopRuntime(electron, { controller, selectionStore });
  const selected = await handlers.get(IPC_CHANNELS.selectBot)({}, BOT_A);
  assert.deepEqual(selected, {
    botId: BOT_A,
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    generation: 12,
  });
  assert.deepEqual(writes, [selected]);
  assert.doesNotMatch(JSON.stringify(selected), /endpoint|authToken|runtime-current|opaque-private/);
  installed.dispose();
});

test("desktop runtime forwards only the controller's sanitized scoped runtime events", async () => {
  const { installDesktopRuntime, RUNTIME_EVENT_CHANNEL } = require(runtimePath);
  const listeners = new Map();
  const sends = [];
  const controller = {
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) { if (listeners.get(event) === listener) listeners.delete(event); },
    dispose() {},
  };
  const electron = {
    app: { once() {} },
    ipcMain: { handle() {}, removeHandler() {} },
    BrowserWindow: {
      getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => sends.push(args) } }],
    },
  };
  const installed = installDesktopRuntime(electron, { controller, selectionStore: {} });
  const scoped = Object.freeze({
    botId: BOT_A,
    generation: 12,
    runtime: Object.freeze({ provider: "fixture", remoteRuntimeId: "runtime-a", state: "ready" }),
    event: Object.freeze({ type: "computer/frame", sequence: 41, payload: Object.freeze({ bytes: 3 }) }),
  });
  listeners.get("runtime-event")(scoped);
  assert.deepEqual(sends, [[RUNTIME_EVENT_CHANNEL, scoped]]);
  assert.doesNotMatch(JSON.stringify(sends), /endpoint|authToken|Bearer|providerDiagnostic/);
  installed.dispose();
  assert.equal(listeners.has("runtime-event"), false);
});

test("model selection registry is atomic, private, exact, and contains no runtime secrets", async (t) => {
  const { ModelSelectionStore } = require(selectionPath);
  const root = tempRoot(t);
  const filePath = path.join(root, "state", "model-selections.v1.json");
  const store = new ModelSelectionStore({ filePath, now: () => "2026-08-14T12:00:00.000Z" });
  assert.equal(await store.read(BOT_A), null);
  await store.selectBot(BOT_A);
  const written = await store.write({
    botId: BOT_A,
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    generation: 4,
  });
  assert.deepEqual(written, {
    botId: BOT_A,
    model: "gpt-5.6-terra",
    reasoningEffort: "max",
    generation: 4,
  });
  assert.deepEqual(await store.read(BOT_A), written);
  const contents = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(contents, /endpoint|authToken|providerDiagnostic|Bearer|sk-|\/Users\/|\/private\/tmp\//);
  assert.equal(fs.statSync(filePath).mode & 0o077, 0);
  await assert.rejects(
    store.write({ botId: BOT_A, model: "gpt-5.5", reasoningEffort: "ultra", generation: 5 }),
    /selection|effort|model/i,
  );
  assert.deepEqual(await store.write({
    botId: BOT_A,
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    generation: 5,
  }), {
    botId: BOT_A,
    model: "claude-fable-5",
    reasoningEffort: "ultra-code",
    generation: 5,
  });
});
