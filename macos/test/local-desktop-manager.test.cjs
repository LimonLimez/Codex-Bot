"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { mock } = require("node:test");

const managerPath = path.join(__dirname, "..", "src", "local", "local-desktop-manager.cjs");

const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";

function localComputer(botId = BOT_A, targetId = LOCAL_A, generation = 1) {
  return {
    botId,
    computer: {
      mode: "local",
      generation,
      localProfileId: targetId,
      nativeAgentId: null,
      state: "ready",
      lastConfirmedAt: "2026-08-15T12:34:56.000Z",
      lastErrorCode: null,
    },
  };
}

function identity(session) {
  return {
    botId: session.botId,
    targetId: session.targetId,
    targetGeneration: session.targetGeneration,
  };
}

function action(session, overrides = {}) {
  return {
    ...identity(session),
    taskId: "task-a",
    capability: "shell.execute",
    operation: "shell.execute",
    arguments: { command: "pwd" },
    resourceId: "workspace",
    resourceLabel: "OpenBot Workspace",
    reason: "Run an approved command for this task",
    ...overrides,
  };
}

function sequence(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, "manager UUID sequence was exhausted");
    return values[index++];
  };
}

class FakeHelperTransport {
  messages = [];
  disposed = false;
  #messages = new Set();
  #exits = new Set();

  async send(message) {
    this.messages.push(message);
  }

  onMessage(listener) {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onExit(listener) {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  reply(value) {
    for (const listener of [...this.#messages]) listener(value);
  }

  exit() {
    for (const listener of [...this.#exits]) listener();
  }

  dispose() {
    this.disposed = true;
  }
}

function electronFixture() {
  const sessions = new Map();
  const windows = [];
  class FakeSession extends EventEmitter {
    constructor(partition) {
      super();
      this.partition = partition;
      this.clearStorageData = mock.fn(async () => {});
    }
    setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
    setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; }
    setDevicePermissionHandler(handler) { this.devicePermissionHandler = handler; }
  }
  class FakeWebContents extends EventEmitter {
    constructor(frame) {
      super();
      this.frame = frame;
      this.urls = [];
    }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    async loadURL(url) { this.urls.push(url); }
    async capturePage() {
      return {
        getSize: () => ({ width: 1024, height: 680 }),
        toPNG: () => Buffer.from(this.frame),
      };
    }
  }
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new FakeWebContents(`frame-${windows.length + 1}`);
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return {
    electron: {
      BrowserWindow: FakeBrowserWindow,
      session: {
        fromPartition(partition) {
          if (!sessions.has(partition)) sessions.set(partition, new FakeSession(partition));
          return sessions.get(partition);
        },
      },
    },
    sessions,
    windows,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-local-desktop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const electron = electronFixture();
  const helpers = [];
  const permissionBroker = {
    request: mock.fn(async (_request, effect) => effect(Buffer.from("private-bookmark"))),
    cancelBot: mock.fn(),
  };
  const { LocalDesktopManager } = require(managerPath);
  const manager = new LocalDesktopManager({
    electron: electron.electron,
    userDataPath: root,
    permissionBroker,
    helperFactory: async () => {
      const helper = new FakeHelperTransport();
      helpers.push(helper);
      return helper;
    },
    randomUUID: sequence([REQUEST_A, REQUEST_B]),
    helperTimeoutMs: 100,
  });
  return { ...electron, helpers, manager, permissionBroker, root };
}

test("two bots receive distinct partitions workspaces and current frames", async (t) => {
  const { manager, sessions, windows, root } = await fixture(t);
  const frames = [];
  manager.on("frame", (frame) => frames.push(frame));
  const a = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const b = await manager.open(localComputer(BOT_B, LOCAL_B, 1));

  assert.equal(a.partition, "persist:openbot-local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(b.partition, "persist:openbot-local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assert.notEqual(a.partition, b.partition);
  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.doesNotMatch(JSON.stringify({ a, b }), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(windows.length, 2);
  for (const window of windows) {
    assert.equal(window.options.show, false);
    assert.equal(window.options.webPreferences.contextIsolation, true);
    assert.equal(window.options.webPreferences.sandbox, true);
    assert.equal(window.options.webPreferences.nodeIntegration, false);
    assert.deepEqual(window.webContents.windowOpenHandler(), { action: "deny" });
  }
  for (const session of sessions.values()) {
    let allowed = true;
    session.permissionRequestHandler(null, "camera", (value) => { allowed = value; });
    assert.equal(allowed, false);
    assert.equal(session.permissionCheckHandler(), false);
    assert.equal(session.devicePermissionHandler(), false);
  }

  await manager.navigate({ ...identity(a), url: "https://www.youtube.com/" });
  assert.deepEqual(windows[0].webContents.urls, ["https://www.youtube.com/"]);
  const frame = await manager.capture(identity(a));
  assert.equal(frame.botId, BOT_A);
  assert.equal(frame.targetGeneration, 1);
  assert.equal(frame.width, 1024);
  assert.equal(frame.height, 680);
  assert.equal(Object.hasOwn(frame, "bytes"), false);
  assert.equal(frames.filter((event) => event.botId === BOT_B).length, 0);
});

test("generation changes cancel old helper work and stale replies publish nothing", async (t) => {
  const { helpers, manager, permissionBroker, sessions } = await fixture(t);
  const publicEvents = [];
  manager.on("result", (value) => publicEvents.push(value));
  const first = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const pending = manager.run(action(first));
  const outcome = pending.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(permissionBroker.request.mock.callCount(), 1);
  assert.equal(helpers[0].messages.length, 1);

  const second = await manager.open(localComputer(BOT_A, LOCAL_A, 2));
  assert.equal(sessions.get(second.partition).listenerCount("will-download"), 1);
  helpers[0].reply({
    requestId: helpers[0].messages[0].requestId,
    ok: true,
    value: { output: "token=/Users/private" },
  });
  const failure = await outcome;
  assert.match(failure.message, /stale|disposed|failed/i);
  assert.doesNotMatch(JSON.stringify(failure), /Users|token|private/);
  assert.equal(helpers[0].disposed, true);
  assert.equal(publicEvents.length, 0);

  const current = manager.run(action(second, { targetId: LOCAL_A.toUpperCase() }));
  await new Promise((resolve) => setImmediate(resolve));
  const sent = helpers[1].messages[0];
  helpers[1].reply({ requestId: sent.requestId, ok: true, value: { output: "workspace" } });
  assert.deepEqual(await current, { output: "workspace" });
});

test("close delete and disposal remove only exact bot resources and reject hostile navigation", async (t) => {
  const { helpers, manager, permissionBroker, sessions, windows, root } = await fixture(t);
  const a = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const b = await manager.open(localComputer(BOT_B, LOCAL_B, 1));
  await assert.rejects(
    manager.navigate({ ...identity(a), url: "http://127.0.0.1/private" }),
    /HTTPS|navigation|invalid/i,
  );
  await assert.rejects(
    manager.navigate({ ...identity(a), url: "https://[::1]/private" }),
    /HTTPS|navigation|invalid/i,
  );
  await assert.rejects(manager.open(new Proxy({}, {
    ownKeys() { throw new Error("secret-path-token"); },
  })), /plain data/i);

  await manager.close(BOT_A);
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows[1].destroyed, false);
  assert.equal(helpers[0].disposed, true);
  await manager.deleteBot(BOT_A);
  assert.equal(permissionBroker.cancelBot.mock.callCount(), 2);
  assert.deepEqual(permissionBroker.cancelBot.mock.calls.map((call) => call.arguments), [[BOT_A], [BOT_A]]);
  assert.equal(sessions.get(a.partition).clearStorageData.mock.callCount(), 1);
  await assert.rejects(fs.stat(path.join(root, "openbot-local", LOCAL_A.slice("local-".length))), /ENOENT/);
  assert.equal((await fs.stat(path.join(root, "openbot-local", LOCAL_B.slice("local-".length)))).isDirectory(), true);

  manager.dispose();
  assert.equal(windows[1].destroyed, true);
  assert.equal(helpers[1].disposed, true);
  await assert.rejects(manager.capture(identity(b)), /disposed/i);
});
