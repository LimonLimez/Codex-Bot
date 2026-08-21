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
const { LOCAL_DESKTOP_START_HTML, LOCAL_DESKTOP_START_URL, safeDisplayUrl } = require(managerPath);

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
  closed = false;
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
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  isClosed() { return this.closed; }

  exitListenerCount() { return this.#exits.size; }

  reply(value) {
    for (const listener of [...this.#messages]) listener(value);
  }

  exit() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.#exits]) listener();
  }

  dispose() {
    this.disposed = true;
    this.closed = true;
    for (const listener of [...this.#exits]) listener();
    this.#messages.clear();
    this.#exits.clear();
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
    const record = { cancellations: [], disposed: false, closed: false, workspacePath };
    installParentPort(port, workspacePath);
    port.emit("message", {
      data: { type: "startup-challenge", nonce: "d".repeat(64) },
    });
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
        if (record.closed) {
          queueMicrotask(listener);
          return () => {};
        }
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      isClosed() { return record.closed; },
      dispose() {
        record.disposed = true;
        record.closed = true;
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
  const current = new Map();
  const hasCurrentReader = Object.prototype.hasOwnProperty.call(overrides, "readCurrentComputer");
  const permissionBroker = overrides.permissionBroker || {
    request: mock.fn(async (_request, effect) => effect(Buffer.from("private-bookmark"))),
    cancelTask: mock.fn(),
    cancelBot: mock.fn(),
    deleteBot: mock.fn(async () => {}),
  };
  const { LocalDesktopManager } = require(managerPath);
  const manager = new LocalDesktopManager({
    electron: electron.electron,
    userDataPath: root,
    permissionBroker,
    readCurrentComputer: hasCurrentReader
      ? overrides.readCurrentComputer
      : async (botId) => current.get(botId) || localComputer(botId === BOT_B ? BOT_B : BOT_A, botId === BOT_B ? LOCAL_B : LOCAL_A, 1),
    helperFactory: overrides.helperFactory || (async () => {
      const helper = new FakeHelperTransport();
      helpers.push(helper);
      return helper;
    }),
    randomUUID: overrides.randomUUID || sequence([REQUEST_A, REQUEST_B]),
    helperTimeoutMs: 100,
  });
  if (!hasCurrentReader) {
    const open = manager.open.bind(manager);
    manager.open = async (value) => {
      current.set(value.botId, value);
      return open(value);
    };
  }
  return { ...electron, helpers, manager, permissionBroker, root };
}

async function heldReuseFixture(t) {
  let reads = 0;
  const held = deferred();
  const value = await fixture(t, {
    readCurrentComputer: async (botId) => {
      reads += 1;
      if (reads === 7) return held.promise;
      return botId === BOT_B
        ? localComputer(BOT_B, LOCAL_B, 1)
        : localComputer(BOT_A, LOCAL_A, 1);
    },
  });
  const a = await value.manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const b = await value.manager.open(localComputer(BOT_B, LOCAL_B, 1));
  const reuse = value.manager.open(localComputer(BOT_A, LOCAL_A, 1)).catch((error) => error);
  for (let attempt = 0; attempt < 50 && reads < 7; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(reads, 7);
  return { ...value, a, b, held, reuse };
}

test("open loads and captures the exact CSP start document before reporting ready", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());

  assert.deepEqual(windows[0].webContents.urls, [LOCAL_DESKTOP_START_URL]);
  assert.equal(LOCAL_DESKTOP_START_HTML.length > 0, true);
  assert.match(
    Buffer.from(LOCAL_DESKTOP_START_URL.split(",")[1], "base64").toString("utf8"),
    /default-src 'none'; base-uri 'none'; form-action 'none'/,
  );
  const frame = await manager.captureDisplayFrame(identity(session));
  assert.equal(frame.bytes.byteLength > 0, true);
});

test("authoritative current Computer checks accept the boundary's in-flight starting state", async (t) => {
  const current = localComputer(BOT_A, LOCAL_A, 1);
  current.computer.state = "starting";
  const { manager, windows } = await fixture(t, {
    readCurrentComputer: async () => current,
  });
  const session = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  assert.equal(session.state, "ready");
  assert.equal(windows.length, 1);
});

test("same-identity reuse closes the existing entry when authority changes mode, target, or errors", async (t) => {
  for (const scenario of ["mode", "target", "error"]) {
    await t.test(scenario, async (subtest) => {
      const current = localComputer(BOT_A, LOCAL_A, 1);
      let reads = 0;
      const value = await fixture(subtest, {
        readCurrentComputer: async () => {
          reads += 1;
          if (reads <= 3) return current;
          if (scenario === "mode") return { ...current, computer: { ...current.computer, mode: "cursor", state: "unavailable" } };
          if (scenario === "target") return localComputer(BOT_A, LOCAL_B, 1);
          throw new Error("private /Users/reader-error token=secret");
        },
      });
      const session = await value.manager.open(current);
      const failure = await value.manager.open(localComputer(BOT_A, LOCAL_A, 1)).catch((error) => error);
      assert.equal(failure.code, "OPENBOT_LOCAL_DESKTOP_STALE");
      assert.equal(value.windows[0].destroyed, true);
      await assert.rejects(value.manager.captureDisplayFrame(identity(session)),
        (error) => error?.code === "OPENBOT_LOCAL_DESKTOP_STALE");
    });
  }
});

test("captureDisplayFrame rechecks authority before returning bytes and fences drift", async (t) => {
  for (const scenario of ["mode", "target", "error"]) {
    await t.test(scenario, async (subtest) => {
      const current = localComputer(BOT_A, LOCAL_A, 1);
      let reads = 0;
      const value = await fixture(subtest, {
        readCurrentComputer: async () => {
          reads += 1;
          if (reads <= 3) return current;
          if (scenario === "mode") return { ...current, computer: { ...current.computer, mode: "cursor", state: "unavailable" } };
          if (scenario === "target") return localComputer(BOT_A, LOCAL_B, 1);
          throw new Error("private /Users/capture-reader token=secret");
        },
      });
      const session = await value.manager.open(current);
      const result = await value.manager.captureDisplayFrame(identity(session)).catch((error) => error);
      assert.equal(result.code, "OPENBOT_LOCAL_DESKTOP_STALE");
      assert.equal(value.windows[0].destroyed, true);
    });
  }
});

test("same-identity reuse rejects every lifecycle interruption without returning a dead session", async (t) => {
  await t.test("window close", async (subtest) => {
    const value = await heldReuseFixture(subtest);
    value.windows[0].destroy();
    value.held.resolve(localComputer(BOT_A, LOCAL_A, 1));
    const failure = await value.reuse;
    assert.equal(failure.code, "OPENBOT_LOCAL_DESKTOP_STALE");
    assert.equal(value.windows[0].destroyed, true);
    assert.equal(value.windows[1].destroyed, false);
    await value.manager.dispose();
  });

  await t.test("manager close", async (subtest) => {
    const value = await heldReuseFixture(subtest);
    const closing = value.manager.close(BOT_A);
    value.held.resolve(localComputer(BOT_A, LOCAL_A, 1));
    const failure = await value.reuse;
    await closing;
    assert.equal(failure.code, "OPENBOT_LOCAL_DESKTOP_STALE");
    assert.equal(value.windows[0].destroyed, true);
    assert.equal(value.windows[1].destroyed, false);
    await value.manager.dispose();
  });

  await t.test("delete fence", async (subtest) => {
    const value = await heldReuseFixture(subtest);
    const deleting = value.manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A });
    value.held.resolve(localComputer(BOT_A, LOCAL_A, 1));
    const failure = await value.reuse;
    await deleting;
    assert.equal(failure.code, "OPENBOT_LOCAL_BOT_DELETING");
    assert.equal(value.windows[0].destroyed, true);
    assert.equal(value.windows[1].destroyed, false);
    await value.manager.dispose();
  });

  await t.test("manager disposal", async (subtest) => {
    const value = await heldReuseFixture(subtest);
    const disposing = value.manager.dispose();
    value.held.resolve(localComputer(BOT_A, LOCAL_A, 1));
    const failure = await value.reuse;
    await disposing;
    assert.equal(failure.code, "OPENBOT_LOCAL_DESKTOP_DISPOSED");
    assert.equal(value.windows[0].destroyed, true);
    assert.equal(value.windows[1].destroyed, true);
  });
});

test("an untouched about:blank window fails with the public capture code", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  windows[0].webContents.urls = [];
  assert.equal(session.state, "ready");
  await assert.rejects(
    manager.captureDisplayFrame(identity(session)),
    (error) => error?.code === "OPENBOT_LOCAL_CAPTURE_FAILED",
  );
});

test("safeDisplayUrl accepts only the exact built-in document or public HTTPS", () => {
  assert.equal(safeDisplayUrl(LOCAL_DESKTOP_START_URL), LOCAL_DESKTOP_START_URL);
  assert.equal(safeDisplayUrl("https://example.com/path"), "https://example.com/path");
  for (const value of [
    "about:blank",
    `${LOCAL_DESKTOP_START_URL}x`,
    "data:text/html,<script>token=secret</script>",
    "file:///Users/private/index.html",
  ]) {
    assert.throws(() => safeDisplayUrl(value), (error) => error?.code === "OPENBOT_LOCAL_NAVIGATION_INVALID");
  }
});

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
  assert.deepEqual(windows[0].webContents.urls, [LOCAL_DESKTOP_START_URL, "https://www.youtube.com/"]);
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
    deleteBot: mock.fn(async () => {}),
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
  assert.deepEqual(permissionBroker.cancelBot.mock.calls.map((call) => call.arguments), [[BOT_A]]);
  assert.deepEqual(permissionBroker.deleteBot.mock.calls.map((call) => call.arguments), [[BOT_A]]);
  assert.equal(sessions.get(a.partition).clearStorageData.mock.callCount(), 1);
  await assert.rejects(fs.stat(path.join(root, "openbot-local", LOCAL_A.slice("local-".length))), /ENOENT/);
  assert.equal((await fs.stat(path.join(root, "openbot-local", LOCAL_B.slice("local-".length)))).isDirectory(), true);

  await manager.dispose();
  assert.equal(windows[1].destroyed, true);
  assert.equal(helpers[1].disposed, true);
  await assert.rejects(manager.capture(identity(b)), /disposed/i);
});

test("deleteBot removes an exact validated profile after restart and never touches its sibling", async (t) => {
  const { manager, permissionBroker, root, sessions } = await fixture(t);
  const localRoot = path.join(root, "openbot-local");
  const profileA = path.join(localRoot, LOCAL_A.slice("local-".length));
  const profileB = path.join(localRoot, LOCAL_B.slice("local-".length));
  await fs.mkdir(path.join(profileA, "workspace"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(profileB, "workspace"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profileA, "private.txt"), "private-a");
  await fs.writeFile(path.join(profileB, "keep.txt"), "keep-b");

  await manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A });

  assert.deepEqual(permissionBroker.deleteBot.mock.calls.map((call) => call.arguments), [[BOT_A]]);
  const partitionA = `persist:openbot-local-${LOCAL_A.slice("local-".length)}`;
  assert.equal(sessions.get(partitionA).clearStorageData.mock.callCount(), 1);
  await assert.rejects(fs.lstat(profileA), /ENOENT/);
  assert.equal((await fs.lstat(profileB)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(profileB, "keep.txt"), "utf8"), "keep-b");
});

test("deleteBot synchronously fences and coalesces while draining live work without touching another bot", async (t) => {
  const deletionEntered = deferred();
  const releaseDeletion = deferred();
  const permissionBroker = {
    request: mock.fn(async (_request, effect) => effect(Buffer.from("private-bookmark"))),
    cancelTask: mock.fn(),
    cancelBot: mock.fn(),
    deleteBot: mock.fn(async (botId) => {
      assert.equal(botId, BOT_A);
      deletionEntered.resolve();
      await releaseDeletion.promise;
    }),
  };
  t.after(() => releaseDeletion.resolve());
  const { helpers, manager, root, sessions, windows } = await fixture(t, { permissionBroker });
  const a = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const b = await manager.open(localComputer(BOT_B, LOCAL_B, 1));
  await manager.navigate({ ...identity(a), url: "https://example.com/a" });
  await manager.navigate({ ...identity(b), url: "https://example.com/b" });
  const captureGate = deferred();
  windows[0].webContents.capturePageImpl = () => captureGate.promise;
  const lateCapture = manager.capture(identity(a)).catch((error) => error);
  const lateRun = manager.run(action(a)).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const requestId = helpers[0].messages[0].requestId;
  const results = [];
  const frames = [];
  manager.on("result", (value) => results.push(value));
  manager.on("frame", (value) => frames.push(value));

  const request = Object.freeze({ botId: BOT_A, localProfileId: LOCAL_A });
  const deletion = manager.deleteBot(request);
  const sameDeletion = manager.deleteBot({ ...request });
  assert.equal(sameDeletion, deletion);
  assert.equal(manager.deleteBot(BOT_A), deletion, "legacy exact-bot retry must share the fence");
  await assert.rejects(
    manager.open(localComputer(BOT_A, LOCAL_A, 2)),
    (error) => error?.code === "OPENBOT_LOCAL_BOT_DELETING",
  );
  await assert.rejects(
    manager.capture(identity(a)),
    (error) => error?.code === "OPENBOT_LOCAL_BOT_DELETING",
  );

  for (let attempt = 0; attempt < 50 && helpers[0].cancellations.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(helpers[0].cancellations, [requestId]);
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 0);
  helpers[0].reply({
    requestId,
    ok: true,
    value: { exitCode: 0, stdout: "late-private-result", stderr: "" },
  });
  await deletionEntered.promise;
  const runFailure = await lateRun;
  assert.match(runFailure.code, /CANCELLED|DELETING|STALE/);
  assert.deepEqual(results, []);
  releaseDeletion.resolve();
  await Promise.all([deletion, sameDeletion]);
  assert.equal(manager.deleteBot({ ...request }), deletion);

  captureGate.resolve(nativeImage({ bytes: Buffer.from("late-private-frame") }));
  const captureFailure = await lateCapture;
  assert.match(captureFailure.code, /DELETING|STALE/);
  assert.deepEqual(frames, []);
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows[1].destroyed, false);
  assert.equal(helpers[0].disposed, true);
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 1);
  assert.equal(sessions.get(a.partition).clearStorageData.mock.callCount(), 1);
  await assert.rejects(
    fs.lstat(path.join(root, "openbot-local", LOCAL_A.slice("local-".length))),
    /ENOENT/,
  );

  const frameB = await manager.capture(identity(b));
  assert.equal(frameB.botId, BOT_B);
  assert.equal(frames.length, 1);
});

test("deleteBot neutralizes a late open before it can publish or retain private resources", async (t) => {
  const helperEntered = deferred();
  const releaseHelper = deferred();
  const createdHelpers = [];
  t.after(() => releaseHelper.resolve());
  const { manager, permissionBroker, root, sessions, windows } = await fixture(t, {
    helperFactory: async () => {
      const helper = new FakeHelperTransport();
      createdHelpers.push(helper);
      helperEntered.resolve();
      await releaseHelper.promise;
      return helper;
    },
  });
  const opening = manager.open(localComputer(BOT_A, LOCAL_A, 1)).catch((error) => error);
  await helperEntered.promise;

  const deletion = manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A });
  releaseHelper.resolve();
  const openFailure = await opening;
  assert.equal(openFailure.code, "OPENBOT_LOCAL_BOT_DELETING");
  await deletion;

  assert.equal(createdHelpers[0].disposed, true);
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(permissionBroker.deleteBot.mock.calls.map((call) => call.arguments), [[BOT_A]]);
  const partition = `persist:openbot-local-${LOCAL_A.slice("local-".length)}`;
  assert.equal(sessions.get(partition).clearStorageData.mock.callCount(), 1);
  await assert.rejects(
    fs.lstat(path.join(root, "openbot-local", LOCAL_A.slice("local-".length))),
    /ENOENT/,
  );
  await assert.rejects(
    manager.open(localComputer(BOT_A, LOCAL_A, 2)),
    (error) => error?.code === "OPENBOT_LOCAL_BOT_DELETING",
  );
});

test("deleteBot refuses mismatched cached identities and hostile exact requests before cleanup", async (t) => {
  const { manager, permissionBroker, root, sessions } = await fixture(t);
  const cached = await manager.open(localComputer(BOT_A, LOCAL_B, 1));
  const cachedPath = path.join(root, "openbot-local", LOCAL_B.slice("local-".length));

  await assert.rejects(
    manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A }),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_REFUSED",
  );
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 0);
  assert.equal(sessions.get(cached.partition).clearStorageData.mock.callCount(), 0);
  assert.equal((await fs.lstat(cachedPath)).isDirectory(), true);
  await assert.rejects(
    manager.capture(identity(cached)),
    (error) => error?.code === "OPENBOT_LOCAL_BOT_DELETING",
  );

  let getterCalls = 0;
  const accessor = { botId: BOT_B };
  Object.defineProperty(accessor, "localProfileId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return LOCAL_B;
    },
  });
  const hostile = new Proxy({}, { ownKeys() { throw new Error("private-profile-path"); } });
  let unsupportedOwnKeysCalls = 0;
  const unsupported = {
    botId: BOT_B,
    localProfileId: LOCAL_B,
    extra: new Proxy({}, {
      ownKeys() {
        unsupportedOwnKeysCalls += 1;
        throw new Error("unsupported nested data must not be traversed");
      },
    }),
  };
  for (const value of [
    { botId: BOT_B, localProfileId: LOCAL_B, extra: true },
    unsupported,
    accessor,
    hostile,
  ]) {
    let rejection;
    assert.doesNotThrow(() => { rejection = manager.deleteBot(value); });
    assert.equal(typeof rejection?.then, "function");
    await assert.rejects(rejection, /plain data|unsupported/i);
  }
  assert.equal(getterCalls, 0);
  assert.equal(unsupportedOwnKeysCalls, 0);
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 0);
});

test("one bot cannot open or delete another bot's claimed local profile", async (t) => {
  const { manager, permissionBroker, root, sessions, windows } = await fixture(t);
  const b = await manager.open(localComputer(BOT_B, LOCAL_B, 1));
  const profileB = path.join(root, "openbot-local", LOCAL_B.slice("local-".length));
  await fs.writeFile(path.join(profileB, "keep.txt"), "keep-b");

  await assert.rejects(
    manager.open(localComputer(BOT_A, LOCAL_B, 1)),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_REFUSED",
  );
  await assert.rejects(
    manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_B }),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_REFUSED",
  );

  assert.equal(windows[0].destroyed, false);
  assert.equal(sessions.get(b.partition).clearStorageData.mock.callCount(), 0);
  assert.equal(await fs.readFile(path.join(profileB, "keep.txt"), "utf8"), "keep-b");
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 0);
  assert.equal(b.botId, BOT_B);
});

test("an exact cold-profile deletion claims ownership before any cross-bot open can race it", async (t) => {
  const deletionEntered = deferred();
  const releaseDeletion = deferred();
  const permissionBroker = {
    request: mock.fn(async (_request, effect) => effect(Buffer.from("private-bookmark"))),
    cancelTask: mock.fn(),
    cancelBot: mock.fn(),
    deleteBot: mock.fn(async () => {
      deletionEntered.resolve();
      await releaseDeletion.promise;
    }),
  };
  const { manager, root } = await fixture(t, { permissionBroker });
  const profilePath = path.join(root, "openbot-local", LOCAL_A.slice("local-".length));
  await fs.mkdir(path.join(profilePath, "workspace"), { recursive: true, mode: 0o700 });

  const deletion = manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A });
  await deletionEntered.promise;
  const openingError = await manager.open(localComputer(BOT_B, LOCAL_A, 1))
    .then(() => null, (error) => error);
  releaseDeletion.resolve();
  await deletion;

  assert.equal(openingError?.code, "OPENBOT_LOCAL_CLEANUP_REFUSED");
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 1);
  await assert.rejects(
    manager.open(localComputer(BOT_B, LOCAL_A, 2)),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_REFUSED",
  );
});

test("deleteBot refuses a symlink or non-directory and retries the exact fenced cleanup safely", async (t) => {
  const { manager, permissionBroker, root, sessions } = await fixture(t);
  const localRoot = path.join(root, "openbot-local");
  const profileA = path.join(localRoot, LOCAL_A.slice("local-".length));
  const profileB = path.join(localRoot, LOCAL_B.slice("local-".length));
  const outside = path.join(root, "outside-profile");
  await fs.mkdir(localRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.writeFile(path.join(outside, "keep.txt"), "outside-keep");
  await fs.symlink(outside, profileA);

  const exact = { botId: BOT_A, localProfileId: LOCAL_A };
  await assert.rejects(
    manager.deleteBot(exact),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_REFUSED",
  );
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 0);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "outside-keep");
  await assert.rejects(
    manager.open(localComputer(BOT_A, LOCAL_A, 1)),
    (error) => error?.code === "OPENBOT_LOCAL_BOT_DELETING",
  );

  await fs.unlink(profileA);
  await fs.mkdir(path.join(profileA, "workspace"), { recursive: true, mode: 0o700 });
  await manager.deleteBot(exact);
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 1);
  const partitionA = `persist:openbot-local-${LOCAL_A.slice("local-".length)}`;
  assert.equal(sessions.get(partitionA).clearStorageData.mock.callCount(), 1);
  await assert.rejects(fs.lstat(profileA), /ENOENT/);
  assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "outside-keep");

  await fs.writeFile(profileB, "not-a-directory");
  await assert.rejects(
    manager.deleteBot({ botId: BOT_B, localProfileId: LOCAL_B }),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_REFUSED",
  );
  assert.equal(await fs.readFile(profileB, "utf8"), "not-a-directory");
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 1);
});

test("deleteBot cannot follow a swapped local-profile root outside the private state directory", async (t) => {
  const { manager, root } = await fixture(t);
  const profileUuid = LOCAL_A.slice("local-".length);
  const localRoot = path.join(root, "openbot-local");
  const checkedRoot = path.join(root, "openbot-local-checked");
  const profilePath = path.join(localRoot, profileUuid);
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-local-outside-"));
  const outsideProfile = path.join(outsideRoot, profileUuid);
  await fs.mkdir(path.join(profilePath, "workspace"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(profilePath, "original.txt"), "original-profile");
  await fs.mkdir(outsideProfile, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(outsideProfile, "outside.txt"), "outside-profile");

  const originalLstat = fs.lstat;
  let profileChecks = 0;
  fs.lstat = async (...args) => {
    const result = await originalLstat(...args);
    if (args[0] === profilePath) {
      profileChecks += 1;
      if (profileChecks === 2) {
        await fs.rename(localRoot, checkedRoot);
        await fs.symlink(outsideRoot, localRoot);
      }
    }
    return result;
  };
  t.after(async () => {
    fs.lstat = originalLstat;
    try { await fs.unlink(localRoot); } catch {}
    try { await fs.rename(checkedRoot, localRoot); } catch {}
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A }),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_REFUSED",
  );
  assert.equal(profileChecks, 2);
  assert.equal(await fs.readFile(path.join(outsideProfile, "outside.txt"), "utf8"), "outside-profile");
  assert.equal(await fs.readFile(path.join(checkedRoot, profileUuid, "original.txt"), "utf8"), "original-profile");
});

test("a failed permission deletion stays fenced and the exact retry converges idempotently", async (t) => {
  let attempts = 0;
  const permissionBroker = {
    request: mock.fn(async (_request, effect) => effect(Buffer.from("private-bookmark"))),
    cancelTask: mock.fn(),
    cancelBot: mock.fn(),
    deleteBot: mock.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("private-permission-store-path");
    }),
  };
  const { manager, root, sessions } = await fixture(t, { permissionBroker });
  const profile = path.join(root, "openbot-local", LOCAL_A.slice("local-".length));
  await fs.mkdir(path.join(profile, "workspace"), { recursive: true, mode: 0o700 });
  const exact = { botId: BOT_A, localProfileId: LOCAL_A };

  await assert.rejects(
    manager.deleteBot(exact),
    (error) => error?.code === "OPENBOT_LOCAL_CLEANUP_FAILED"
      && !/private-permission-store-path/.test(String(error)),
  );
  await assert.rejects(
    manager.open(localComputer(BOT_A, LOCAL_A, 1)),
    (error) => error?.code === "OPENBOT_LOCAL_BOT_DELETING",
  );
  assert.equal((await fs.lstat(profile)).isDirectory(), true);

  const retry = manager.deleteBot(exact);
  await retry;
  assert.equal(manager.deleteBot({ ...exact }), retry);
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 2);
  const partition = `persist:openbot-local-${LOCAL_A.slice("local-".length)}`;
  assert.equal(sessions.get(partition).clearStorageData.mock.callCount(), 1);
  await assert.rejects(fs.lstat(profile), /ENOENT/);
});

test("manager construction requires durable permission deletion support", async (t) => {
  await assert.rejects(
    fixture(t, {
      permissionBroker: {
        request: async () => {},
        cancelTask() {},
        cancelBot() {},
      },
    }),
    /permission broker/i,
  );
});

test("manager construction requires an authoritative current Computer reader", async (t) => {
  await assert.rejects(
    fixture(t, { readCurrentComputer: null }),
    /current Computer|current computer/i,
  );
});

test("open fences a superseded Computer generation before helper and entry publication", async (t) => {
  const helperCalled = [];
  const current = deferred();
  const { manager, windows } = await fixture(t, {
    readCurrentComputer: async () => current.promise,
    helperFactory: async () => {
      helperCalled.push(true);
      return new FakeHelperTransport();
    },
  });
  const opening = manager.open(localComputer(BOT_A, LOCAL_A, 1)).catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  current.resolve(localComputer(BOT_A, LOCAL_A, 2));
  const failure = await opening;
  assert.equal(failure.code, "OPENBOT_LOCAL_DESKTOP_STALE");
  assert.equal(helperCalled.length, 0);
  assert.equal(windows.length, 0);
});

test("open rechecks the authoritative generation after the start document and helper awaits", async (t) => {
  await t.test("after start document", async (subtest) => {
    const afterLoad = deferred();
    const afterLoadRead = deferred();
    let reads = 0;
    const helperCalled = [];
    const value = await fixture(subtest, {
      readCurrentComputer: async () => {
        reads += 1;
        if (reads === 2) {
          afterLoadRead.resolve();
          return afterLoad.promise;
        }
        return localComputer(BOT_A, LOCAL_A, 1);
      },
      helperFactory: async () => {
        helperCalled.push(true);
        return new FakeHelperTransport();
      },
    });
    const opening = value.manager.open(localComputer(BOT_A, LOCAL_A, 1)).catch((error) => error);
    await afterLoadRead.promise;
    assert.equal(reads, 2);
    afterLoad.resolve(localComputer(BOT_A, LOCAL_A, 2));
    const failure = await opening;
    assert.equal(failure.code, "OPENBOT_LOCAL_DESKTOP_STALE");
    assert.equal(helperCalled.length, 0);
    assert.equal(value.windows[0].destroyed, true);
  });

  await t.test("after helper", async (subtest) => {
    const afterHelper = deferred();
    const helperEntered = deferred();
    const releaseHelper = deferred();
    let reads = 0;
    const helpers = [];
    subtest.after(() => releaseHelper.resolve());
    const value = await fixture(subtest, {
      readCurrentComputer: async () => {
        reads += 1;
        return reads === 3 ? afterHelper.promise : localComputer(BOT_A, LOCAL_A, 1);
      },
      helperFactory: async () => {
        const helper = new FakeHelperTransport();
        helpers.push(helper);
        helperEntered.resolve();
        await releaseHelper.promise;
        return helper;
      },
    });
    const opening = value.manager.open(localComputer(BOT_A, LOCAL_A, 1)).catch((error) => error);
    await helperEntered.promise;
    assert.equal(helpers.length, 1);
    releaseHelper.resolve();
    for (let attempt = 0; attempt < 50 && reads < 3; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 3);
    afterHelper.resolve(localComputer(BOT_A, LOCAL_A, 2));
    const failure = await opening;
    assert.equal(failure.code, "OPENBOT_LOCAL_DESKTOP_STALE");
    assert.equal(helpers[0].disposed, true);
    assert.equal(value.windows[0].destroyed, true);
  });
});

test("manager disposal awaits an already-started exact bot deletion and its profile cleanup", async (t) => {
  const deletionEntered = deferred();
  const releaseDeletion = deferred();
  const permissionBroker = {
    request: mock.fn(async (_request, effect) => effect(Buffer.from("private-bookmark"))),
    cancelTask: mock.fn(),
    cancelBot: mock.fn(),
    deleteBot: mock.fn(async () => {
      deletionEntered.resolve();
      await releaseDeletion.promise;
    }),
  };
  const { manager, root } = await fixture(t, { permissionBroker });
  const profilePath = path.join(root, "openbot-local", LOCAL_A.slice("local-".length));
  await fs.mkdir(path.join(profilePath, "workspace"), { recursive: true, mode: 0o700 });
  const deletionOutcome = manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A })
    .then(() => null, (error) => error);
  await deletionEntered.promise;

  let disposeSettled = false;
  const disposing = manager.dispose().then(() => { disposeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeDeletion = disposeSettled;
  releaseDeletion.resolve();

  assert.equal(await deletionOutcome, null);
  await disposing;
  assert.equal(settledBeforeDeletion, false);
  await assert.rejects(fs.lstat(profilePath), /ENOENT/);
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 1);
});

test("manager disposal owns a helper startup already admitted by open", async (t) => {
  const helperEntered = deferred();
  const releaseHelper = deferred();
  const helper = new FakeHelperTransport();
  t.after(() => releaseHelper.resolve());
  const { manager, windows } = await fixture(t, {
    helperFactory: async () => {
      helperEntered.resolve();
      await releaseHelper.promise;
      return helper;
    },
  });
  const opening = manager.open(localComputer()).then(
    (session) => session,
    (error) => error,
  );
  await helperEntered.promise;

  let disposeSettled = false;
  const firstDispose = manager.dispose();
  const secondDispose = manager.dispose();
  assert.equal(secondDispose, firstDispose);
  firstDispose.then(() => { disposeSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeHelper = disposeSettled;

  releaseHelper.resolve();
  const openingResult = await opening;
  await firstDispose;
  assert.equal(settledBeforeHelper, false);
  assert.equal(openingResult?.code, "OPENBOT_LOCAL_DESKTOP_DISPOSED");
  assert.equal(helper.disposed, true);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].destroyed, true);
});

test("open rejects a helper that exits before manager startup ownership", async (t) => {
  for (const scenario of ["before return", "during listener attachment"]) {
    await t.test(scenario, async (subtest) => {
      class ExitOnOwnershipHelper extends FakeHelperTransport {
        armed = false;
        onExit(listener) {
          const unsubscribe = super.onExit(listener);
          if (!this.armed) {
            this.armed = true;
            queueMicrotask(() => this.exit());
          }
          return unsubscribe;
        }
      }
      const helper = scenario === "before return"
        ? new FakeHelperTransport()
        : new ExitOnOwnershipHelper();
      const { manager, windows } = await fixture(subtest, {
        helperFactory: async () => {
          if (scenario === "before return") helper.exit();
          return helper;
        },
      });
      const result = await manager.open(localComputer()).then(
        (session) => session,
        (error) => error,
      );
      assert.equal(result?.code, "OPENBOT_LOCAL_DESKTOP_START_FAILED");
      assert.equal(helper.disposed, true);
      assert.equal(helper.exitListenerCount(), 0);
      assert.equal(windows.length, 1);
      assert.equal(windows[0].destroyed, true);
    });
  }
});

test("helper exit after publication promptly fences and closes its exact session", async (t) => {
  const { helpers, manager, windows } = await fixture(t);
  const session = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const sibling = await manager.open(localComputer(BOT_B, LOCAL_B, 1));
  assert.equal(helpers[0].exitListenerCount(), 2);
  helpers[0].exit();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    manager.captureDisplayFrame(identity(session)),
    (error) => error?.code === "OPENBOT_LOCAL_DESKTOP_STALE",
  );
  assert.equal((await manager.captureDisplayFrame(identity(sibling))).bytes.byteLength > 0, true);
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows[1].destroyed, false);
  assert.equal(helpers[0].exitListenerCount(), 0);
  assert.equal(helpers[1].exitListenerCount(), 2);
});
