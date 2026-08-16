"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { mock } = require("node:test");

const managerPath = path.join(__dirname, "..", "src", "local", "local-desktop-manager.cjs");
const helperChildPath = path.join(__dirname, "..", "src", "local", "local-helper-child.cjs");

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function nativeImage({ width = 1024, height = 680, bytes = Buffer.from("frame"), resizedBytes = null } = {}) {
  return {
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.from(bytes),
    resize(options) {
      const nextWidth = options.width;
      const nextHeight = options.height;
      return nativeImage({
        width: nextWidth,
        height: nextHeight,
        bytes: resizedBytes ?? bytes,
        resizedBytes,
      });
    },
  };
}

class FakeHelperTransport {
  messages = [];
  cancellations = [];
  disposed = false;
  #messages = new Set();
  #exits = new Set();

  async send(message) {
    this.messages.push(message);
  }

  async cancel(requestId) {
    this.cancellations.push(requestId);
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

function inProcessHelperFactory(records) {
  const { installParentPort } = require(helperChildPath);
  return async ({ workspacePath }) => {
    const messageListeners = new Set();
    const exitListeners = new Set();
    class InProcessPort extends EventEmitter {
      postMessage(message) {
        if (message?.type === "fatal") {
          for (const listener of [...exitListeners]) listener();
          return;
        }
        if (message?.type === "reply") {
          for (const listener of [...messageListeners]) listener(message.reply);
        }
      }
    }
    const port = new InProcessPort();
    const record = { cancellations: [], disposed: false, workspacePath };
    installParentPort(port, workspacePath);
    records.push(record);
    return {
      async send(request) { port.emit("message", { data: { type: "run", request } }); },
      async cancel(requestId) {
        record.cancellations.push(requestId);
        port.emit("message", { data: { type: "cancel", requestId } });
      },
      async authorizeResource() {},
      onMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      dispose() {
        record.disposed = true;
        messageListeners.clear();
        exitListeners.clear();
      },
    };
  };
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fs.access(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${path.basename(file)}.`);
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
      this.capturePageImpl = null;
    }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    async loadURL(url) { this.urls.push(url); }
    getURL() { return this.urls.at(-1) ?? "about:blank"; }
    async capturePage() {
      if (this.capturePageImpl) return this.capturePageImpl();
      return nativeImage({ bytes: Buffer.from(this.frame) });
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

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-local-desktop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const electron = electronFixture();
  const helpers = [];
  const permissionBroker = overrides.permissionBroker || {
    request: mock.fn(async (_request, effect) => effect(Buffer.from("private-bookmark"))),
    cancelTask: mock.fn(),
    cancelBot: mock.fn(),
  };
  const { LocalDesktopManager } = require(managerPath);
  const manager = new LocalDesktopManager({
    electron: electron.electron,
    userDataPath: root,
    permissionBroker,
    helperFactory: overrides.helperFactory || (async () => {
      const helper = new FakeHelperTransport();
      helpers.push(helper);
      return helper;
    }),
    randomUUID: overrides.randomUUID || sequence([REQUEST_A, REQUEST_B]),
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
  assert.equal(manager.ownsWindow(windows[0]), true);
  assert.equal(manager.ownsWindow(windows[1]), true);
  assert.equal(manager.ownsWindow({ webContents: windows[0].webContents }), false);
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

test("display capture returns bounded private PNG bytes while tool capture remains metadata only", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  await manager.navigate({ ...identity(session), url: "https://www.youtube.com/" });
  windows[0].webContents.capturePageImpl = async () => nativeImage({
    width: 1280,
    height: 800,
    bytes: Buffer.alloc(2 * 1024 * 1024, 0x61),
    resizedBytes: Buffer.alloc(900 * 1024, 0x62),
  });

  const display = await manager.captureDisplayFrame(identity(session));
  assert.deepEqual(Object.keys(display).sort(), [
    "botId", "bytes", "frameId", "height", "mimeType", "targetGeneration", "targetId", "width",
  ]);
  assert.equal(display.botId, BOT_A);
  assert.equal(display.targetId, LOCAL_A);
  assert.equal(display.targetGeneration, 1);
  assert.equal(display.mimeType, "image/png");
  assert.equal(display.width <= 640, true);
  assert.equal(display.height <= 400, true);
  assert.equal(display.bytes instanceof Uint8Array, true);
  assert.equal(display.bytes.byteLength <= 1_048_576, true);
  assert.doesNotMatch(JSON.stringify({ ...display, bytes: display.bytes.byteLength }), /youtube|https|Users|partition|workspace/i);

  const tool = await manager.capture(identity(session));
  assert.equal(Object.hasOwn(tool, "bytes"), false);
  assert.deepEqual(Object.keys(tool).sort(), [
    "botId", "frameId", "height", "mimeType", "targetGeneration", "targetId", "width",
  ]);
});

test("display capture rejects oversized PNGs and stale in-flight generations without private output", async (t) => {
  const { manager, windows } = await fixture(t);
  const first = await manager.open(localComputer());
  await manager.navigate({ ...identity(first), url: "https://www.youtube.com/" });
  windows[0].webContents.capturePageImpl = async () => nativeImage({
    width: 1280,
    height: 800,
    bytes: Buffer.alloc(2 * 1024 * 1024),
    resizedBytes: Buffer.alloc(1_048_577),
  });
  const oversized = await manager.captureDisplayFrame(identity(first)).catch((error) => error);
  assert.equal(oversized.code, "OPENBOT_LOCAL_CAPTURE_FAILED");
  assert.doesNotMatch(JSON.stringify(oversized), /Users|youtube|https|token|private/i);

  const waiting = deferred();
  windows[0].webContents.capturePageImpl = () => waiting.promise;
  const pending = manager.captureDisplayFrame(identity(first)).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  await manager.open(localComputer(BOT_A, LOCAL_A, 2));
  waiting.resolve(nativeImage({ bytes: Buffer.from("private-frame") }));
  const stale = await pending;
  assert.equal(stale.code, "OPENBOT_LOCAL_DESKTOP_STALE");
  assert.doesNotMatch(JSON.stringify(stale), /private-frame|Users|token/i);
});

test("shell permission requests carry the exact command and truthful full-host scope", async (t) => {
  const { helpers, manager, permissionBroker } = await fixture(t);
  const session = await manager.open(localComputer());
  const pending = manager.run(action(session, {
    arguments: { command: "printf 'exact command' && /usr/bin/true" },
    resourceId: "full-host-shell",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(permissionBroker.request.mock.calls[0].arguments[0], {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    capability: "shell.execute",
    resourceId: "full-host-shell",
    resourceLabel: "Full host shell",
    reason: "Full host shell as your macOS user, not confined to this workspace",
    command: "printf 'exact command' && /usr/bin/true",
  });
  const sent = helpers[0].messages[0];
  helpers[0].reply({ requestId: sent.requestId, ok: true, value: { exitCode: 0, stdout: "", stderr: "" } });
  await pending;
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

  const reopening = manager.open(localComputer(BOT_A, LOCAL_A, 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(helpers[0].cancellations, [helpers[0].messages[0].requestId]);
  helpers[0].reply({
    requestId: helpers[0].messages[0].requestId,
    ok: false,
    errorCode: "OPENBOT_LOCAL_CANCELLED",
  });
  const second = await reopening;
  assert.equal(sessions.get(second.partition).listenerCount("will-download"), 1);
  helpers[0].reply({
    requestId: helpers[0].messages[0].requestId,
    ok: true,
    value: { output: "token=/Users/private" },
  });
  const failure = await outcome;
  assert.match(failure.message, /stale|disposed|failed|cancelled/i);
  assert.doesNotMatch(JSON.stringify(failure), /Users|token|private/);
  assert.equal(helpers[0].disposed, true);
  assert.equal(publicEvents.length, 0);

  const current = manager.run(action(second, { targetId: LOCAL_A.toUpperCase() }));
  await new Promise((resolve) => setImmediate(resolve));
  const sent = helpers[1].messages[0];
  const currentValue = { exitCode: 0, stdout: "workspace", stderr: "" };
  helpers[1].reply({ requestId: sent.requestId, ok: true, value: currentValue });
  assert.deepEqual(await current, currentValue);
});

test("disposing one task waits for its helper acknowledgement then permits exact task reuse", async (t) => {
  const { helpers, manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const taskA = manager.run(action(session, { taskId: "task-a" }));
  const taskAOutcome = taskA.catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const requestA = helpers[0].messages[0].requestId;
  let disposalSettled = false;
  const disposal = manager.disposeTask({ botId: BOT_A, taskId: "task-a" }).then(() => {
    disposalSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(helpers[0].cancellations, [requestA]);
  assert.equal(disposalSettled, false);
  helpers[0].reply({ requestId: requestA, ok: false, errorCode: "OPENBOT_LOCAL_CANCELLED" });
  await disposal;
  assert.equal((await taskAOutcome).code, "OPENBOT_LOCAL_CANCELLED");
  assert.equal(windows[0].destroyed, false);

  const taskB = manager.run(action(session, { taskId: "task-a" }));
  await new Promise((resolve) => setImmediate(resolve));
  const requestB = helpers[0].messages[1].requestId;
  helpers[0].reply({ requestId: requestB, ok: true, value: { exitCode: 0, stdout: "", stderr: "" } });
  assert.equal((await taskB).exitCode, 0);
});

test("disposing a task removes its exact pending consent and leaves sibling consent live", async (t) => {
  const held = new Map();
  const permissionBroker = {
    request: mock.fn((_request, effect, context) => new Promise((resolve, reject) => {
      held.set(context.taskId, { effect, reject, resolve });
    })),
    cancelTask: mock.fn(({ taskId }) => {
      const pending = held.get(taskId);
      held.delete(taskId);
      if (!pending) return;
      const error = new Error("Permission request was cancelled.");
      error.code = "OPENBOT_PERMISSION_CANCELLED";
      pending.reject(error);
    }),
    cancelBot: mock.fn(),
  };
  const { helpers, manager } = await fixture(t, { permissionBroker });
  const session = await manager.open(localComputer());
  const first = manager.run(action(session, { taskId: "task-a" })).catch((error) => error);
  const second = manager.run(action(session, { taskId: "task-b" })).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));

  await manager.disposeTask({ botId: BOT_A, taskId: "task-a" });
  assert.equal((await first).code, "OPENBOT_PERMISSION_CANCELLED");
  assert.deepEqual(permissionBroker.cancelTask.mock.calls[0].arguments, [{ botId: BOT_A, taskId: "task-a" }]);
  assert.equal(held.has("task-a"), false);
  assert.equal(held.has("task-b"), true);

  const sibling = held.get("task-b");
  const effectFlight = sibling.effect(Buffer.from("private-bookmark"));
  await new Promise((resolve) => setImmediate(resolve));
  const sent = helpers[0].messages[0];
  helpers[0].reply({
    requestId: sent.requestId,
    ok: true,
    value: { exitCode: 0, stdout: "", stderr: "" },
  });
  const effectResult = await effectFlight;
  sibling.resolve(effectResult);
  assert.equal((await second).exitCode, 0);
  await manager.dispose();
});

test("close generation replacement and manager disposal await descendant-safe helper cancellation", async (t) => {
  for (const scenario of ["close", "generation", "dispose"]) {
    await t.test(scenario, async (subtest) => {
      const records = [];
      const { manager, root } = await fixture(subtest, {
        helperFactory: inProcessHelperFactory(records),
        randomUUID: sequence([REQUEST_A]),
      });
      const session = await manager.open(localComputer());
      const taskWorkspace = path.join(
        root,
        "openbot-local",
        LOCAL_A.slice("local-".length),
        "workspace",
        "tasks",
        "task-a",
      );
      const started = path.join(taskWorkspace, "started.txt");
      const late = path.join(taskWorkspace, "late.txt");
      const flight = manager.run(action(session, {
        arguments: {
          command: "printf started > started.txt; (sleep 0.35; printf late > late.txt) & wait",
        },
      })).catch((error) => error);
      await waitForFile(started);

      if (scenario === "close") await manager.close(BOT_A);
      if (scenario === "generation") await manager.open(localComputer(BOT_A, LOCAL_A, 2));
      if (scenario === "dispose") await manager.dispose();

      assert.equal((await flight).code, "OPENBOT_LOCAL_CANCELLED");
      assert.equal(records[0].cancellations.length, 1);
      assert.equal(records[0].disposed, true);
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(await fs.access(late).then(() => true, () => false), false);
      if (scenario !== "dispose") await manager.dispose();
    });
  }
});

test("reviewed Stop awaits real helper descendant cancellation through the target router", async (t) => {
  const { ComputerTargetRouter } = require("../src/computer/computer-target-router.cjs");
  const { createStandaloneComputerToolBridge } = require("../src/desktop/standalone-conversation-controller.cjs");
  const records = [];
  const { manager, root } = await fixture(t, {
    helperFactory: inProcessHelperFactory(records),
    randomUUID: sequence([REQUEST_A]),
  });
  const current = localComputer();
  const targetRouter = new ComputerTargetRouter({
    store: { async read(botId) { return botId === BOT_A ? current : null; } },
    localManager: manager,
  });
  const taskId = "standalone-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const identity = {
    botId: BOT_A,
    conversationId: "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    taskId,
  };
  const session = await createStandaloneComputerToolBridge({ computerTargetRouter: targetRouter }).open(identity);
  const taskWorkspace = path.join(
    root,
    "openbot-local",
    LOCAL_A.slice("local-".length),
    "workspace",
    "tasks",
    taskId,
  );
  const started = path.join(taskWorkspace, "started.txt");
  const late = path.join(taskWorkspace, "late.txt");
  const dispatch = session.dispatch({
    ...identity,
    invocationId: "invocation-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    toolCallId: "call-shell",
    toolName: "shell_execute",
    args: { command: "printf started > started.txt; (sleep 0.35; printf late > late.txt) & wait" },
  }).catch((error) => error);
  await waitForFile(started);
  await session.dispose();
  assert.equal((await dispatch).code, "OPENBOT_CONVERSATION_OPERATION_FAILED");
  assert.equal(records[0].cancellations.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(await fs.access(late).then(() => true, () => false), false);
  targetRouter.dispose();
  await manager.dispose();
});

test("close delete and disposal remove only exact bot resources and reject hostile navigation", async (t) => {
  const { helpers, manager, permissionBroker, sessions, windows, root } = await fixture(t);
  const a = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const b = await manager.open(localComputer(BOT_B, LOCAL_B, 1));
  await assert.rejects(
    manager.navigate({ ...identity(a), url: "http://127.0.0.1/private" }),
    /HTTPS|navigation|invalid/i,
  );
  let redirectPrevented = false;
  windows[0].webContents.emit("will-redirect", {
    preventDefault() { redirectPrevented = true; },
  }, "https://127.0.0.1/private?token=secret");
  assert.equal(redirectPrevented, true);
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

  await manager.dispose();
  assert.equal(windows[1].destroyed, true);
  assert.equal(helpers[1].disposed, true);
  await assert.rejects(manager.capture(identity(b)), /disposed/i);
});
