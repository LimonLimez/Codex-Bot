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

test("local desktop start document uses plain OpenBot Desktop naming", () => {
  const encoded = LOCAL_DESKTOP_START_URL.slice("data:text/html;base64,".length);
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  assert.equal(decoded, LOCAL_DESKTOP_START_HTML);
  assert.match(decoded, /<title>OpenBot Desktop<\/title>/);
  assert.match(decoded, /<h1>Desktop<\/h1>/);
  assert.match(decoded, /Content-Security-Policy/);
  assert.match(decoded, /default-src 'none'/);
  assert.match(decoded, /Ready for this bot\./);
  assert.doesNotMatch(decoded, /Free Local Desktop/);
});

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

function inputIdentity(session, frame, inputSequence = 1, overrides = {}) {
  return {
    botId: session.botId,
    targetId: session.targetId,
    targetGeneration: session.targetGeneration,
    sessionGeneration: frame.sessionGeneration ?? session.sessionGeneration,
    pageGeneration: frame.pageGeneration,
    frameId: frame.frameId,
    frameSequence: frame.frameSequence,
    inputSequence,
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

class FakeDebugger extends EventEmitter {
  constructor() {
    super();
    this.attached = false;
    this.attachVersions = [];
    this.commands = [];
    this.detachCalls = 0;
    this.failCommands = new Set();
    this.attachImpl = null;
    this.sendCommandImpl = null;
    this.detachImpl = null;
  }

  get isAttached() { return this.attached; }

  async attach(version) {
    this.attachVersions.push(version);
    this.attached = true;
    if (this.attachImpl) return this.attachImpl(version);
  }

  async sendCommand(method, params) {
    this.commands.push({ method, params });
    if (this.sendCommandImpl) return this.sendCommandImpl(method, params);
    if (this.failCommands.has(method)) throw new Error(`blocked ${method}`);
    return {};
  }

  async detach() {
    this.detachCalls += 1;
    this.attached = false;
    if (this.detachImpl) return this.detachImpl();
    this.emit("detach", {}, "test detach");
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
    debuggerFactory: overrides.debuggerFactory,
    navigationTimeoutMs: overrides.navigationTimeoutMs,
    randomUUID: overrides.randomUUID || sequence([REQUEST_A, REQUEST_B]),
    helperTimeoutMs: 100,
  });
  if (!hasCurrentReader) {
    const open = manager.open.bind(manager);
    manager.open = async (value, options) => {
      current.set(value.botId, value);
      return open(value, options);
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
    "https://localhost./",
    "https://worker.localhost./",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:7f00:1]/",
    "https://[::ffff:10.0.0.1]/",
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

  await manager.navigate({ ...identity(a), sessionGeneration: a.sessionGeneration, url: "https://www.youtube.com/" });
  assert.deepEqual(windows[0].webContents.urls, [LOCAL_DESKTOP_START_URL, "https://www.youtube.com/"]);
  const frame = await manager.capture(identity(a));
  assert.equal(frame.botId, BOT_A);
  assert.equal(frame.targetGeneration, 1);
  assert.equal(frame.width, 1024);
  assert.equal(frame.height, 680);
  assert.equal(Object.hasOwn(frame, "bytes"), false);
  assert.equal(frames.filter((event) => event.botId === BOT_B).length, 0);
});

test("successful external capture and navigation publish bounded internal currentness events", async (t) => {
  const { manager } = await fixture(t);
  const frameEvents = [];
  const navigationEvents = [];
  manager.on("frame-changed", (value) => frameEvents.push(value));
  manager.on("navigation-changed", (value) => navigationEvents.push(value));
  const session = await manager.open(localComputer());

  const captured = await manager.capture(identity(session));
  await manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/next" });

  assert.deepEqual(Object.keys(captured).sort(), [
    "botId", "frameId", "height", "mimeType", "targetGeneration", "targetId", "width",
  ]);
  assert.equal(frameEvents.length, 1);
  assert.deepEqual(Object.keys(frameEvents[0]).sort(), [
    "botId", "frameId", "frameSequence", "pageGeneration", "sessionGeneration", "targetGeneration", "targetId",
  ]);
  assert.deepEqual(frameEvents[0], {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: session.sessionGeneration,
    pageGeneration: session.pageGeneration,
    frameId: captured.frameId,
    frameSequence: 1,
  });
  assert.equal(navigationEvents.length, 1);
  assert.deepEqual(Object.keys(navigationEvents[0]).sort(), [
    "action", "botId", "pageGeneration", "sessionGeneration", "targetGeneration", "targetId", "url",
  ]);
  assert.deepEqual(navigationEvents[0], {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: session.sessionGeneration,
    pageGeneration: session.pageGeneration + 1,
    action: "navigate",
    url: "https://example.com/next",
  });
  assert.doesNotMatch(JSON.stringify({ frameEvents, navigationEvents }), /bytes|partition|workspace|Users|token/i);
});

test("spontaneous main-frame navigation emits one ordered currentness event while subframes do nothing", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  const webContents = windows[0].webContents;

  webContents.emit("did-start-navigation", {}, "https://example.com/child", false, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0);

  webContents.urls.push("https://example.com/hidden-input");
  webContents.emit("did-start-navigation", {}, "https://example.com/hidden-input", false, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: session.sessionGeneration,
    pageGeneration: session.pageGeneration + 1,
    action: "navigate",
    url: "https://example.com/hidden-input",
  });
});

test("internal programmatic navigation publishes one manager notification for IPC ownership", async (t) => {
  const { manager } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));

  await manager.navigate(
    { ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/internal" },
    { internal: true },
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].action, "navigate");
  assert.equal(events[0].url, "https://example.com/internal");
});

test("history navigation to the built-in home emits a known-home null URL", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  await manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/next" });
  events.length = 0;
  const webContents = windows[0].webContents;
  webContents.canGoBack = () => true;
  webContents.goBack = () => queueMicrotask(() => {
    webContents.urls.push(LOCAL_DESKTOP_START_URL);
    webContents.emit("did-start-navigation", {}, LOCAL_DESKTOP_START_URL, false, true);
    webContents.emit("did-navigate", {}, LOCAL_DESKTOP_START_URL);
  });

  await manager.goBack({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    pageGeneration: session.pageGeneration + 1,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].action, "goBack");
  assert.equal(events[0].url, null);
});

test("history navigation preserves its public action while hiding the destination URL", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  const webContents = windows[0].webContents;
  webContents.canGoBack = () => true;
  webContents.goBack = () => queueMicrotask(() => {
    webContents.urls.push("https://example.com/back");
    webContents.emit("did-start-navigation", {}, "https://example.com/back", false, true);
    webContents.emit("did-navigate", {}, "https://example.com/back");
  });

  await manager.goBack({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    pageGeneration: session.pageGeneration,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].action, "goBack");
  assert.equal(events[0].url, null);
});

test("spontaneous main-frame navigation storms publish only the latest URL and page", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  const webContents = windows[0].webContents;

  webContents.urls.push("https://example.com/first");
  webContents.emit("did-start-navigation", {}, "https://example.com/first", false, true);
  webContents.urls.push("https://example.com/latest");
  webContents.emit("did-start-navigation", {}, "https://example.com/latest", false, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.equal(events[0].url, "https://example.com/latest");
  assert.equal(events[0].pageGeneration, session.pageGeneration + 1);
});

test("programmatic navigation redirects remain command-owned and publish one result event", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  windows[0].webContents.loadURL = async (url) => {
    windows[0].webContents.urls.push(url);
    windows[0].webContents.emit("did-start-navigation", {}, url, false, true);
    windows[0].webContents.urls.push("https://example.com/redirect");
    windows[0].webContents.emit("did-start-navigation", {}, "https://example.com/redirect", false, true);
  };

  await manager.navigate({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    url: "https://example.com/requested",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.equal(events[0].action, "navigate");
  assert.equal(events[0].url, "https://example.com/redirect");
  assert.equal(events[0].pageGeneration, session.pageGeneration + 1);
});

test("internal programmatic navigation still publishes one manager event for IPC ownership", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  windows[0].webContents.loadURL = async (url) => {
    windows[0].webContents.urls.push(url);
    windows[0].webContents.emit("did-start-navigation", {}, url, false, true);
    windows[0].webContents.urls.push("https://example.com/internal-redirect");
    windows[0].webContents.emit("did-start-navigation", {}, "https://example.com/internal-redirect", false, true);
  };

  await manager.navigate({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    url: "https://example.com/internal",
  }, { internal: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.length, 1);
  assert.equal(events[0].url, "https://example.com/internal-redirect");
});

test("malformed spontaneous main-frame navigation fails closed before fencing currentness", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  const webContents = windows[0].webContents;

  webContents.emit("did-start-navigation", {}, undefined, false, true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(session.pageGeneration, 1);
  assert.equal(events.length, 0);
});

test("successful external session replacement publishes only bounded current session identity", async (t) => {
  const { manager } = await fixture(t);
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("session-changed", (value) => events.push(value));

  const replacement = await manager.retry(localComputer(BOT_A, LOCAL_A, 1));

  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), [
    "botId", "pageGeneration", "sessionGeneration", "targetGeneration", "targetId",
  ]);
  assert.deepEqual(events[0], {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: replacement.sessionGeneration,
    pageGeneration: replacement.pageGeneration,
  });
  assert.doesNotMatch(JSON.stringify(events), /bytes|partition|workspace|Users|token/i);
});

test("display capture returns bounded private PNG bytes while tool capture remains metadata only", async (t) => {
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  await manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://www.youtube.com/" });
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
  await manager.navigate({ ...identity(first), sessionGeneration: first.sessionGeneration, url: "https://www.youtube.com/" });
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
    manager.navigate({ ...identity(a), sessionGeneration: a.sessionGeneration, url: "http://127.0.0.1/private" }),
    /HTTPS|navigation|invalid/i,
  );
  let redirectPrevented = false;
  windows[0].webContents.emit("will-redirect", {
    preventDefault() { redirectPrevented = true; },
  }, "https://127.0.0.1/private?token=secret");
  assert.equal(redirectPrevented, true);
  await assert.rejects(
    manager.navigate({ ...identity(a), sessionGeneration: a.sessionGeneration, url: "https://[::1]/private" }),
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
  await manager.navigate({ ...identity(a), sessionGeneration: a.sessionGeneration, url: "https://example.com/a" });
  await manager.navigate({ ...identity(b), sessionGeneration: b.sessionGeneration, url: "https://example.com/b" });
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

test("interactive presentations use the fixed surface and an injected CDP debugger without hidden focus", async (t) => {
  const debuggers = new Map();
  const { manager, windows } = await fixture(t, {
    debuggerFactory: (_webContents, identityValue) => {
      const debuggerClient = new FakeDebugger();
      debuggers.set(identityValue.botId, debuggerClient);
      return debuggerClient;
    },
  });
  const session = await manager.open(localComputer());
  const debuggerClient = debuggers.get(BOT_A);

  assert.deepEqual(debuggerClient.attachVersions, ["1.3"]);
  assert.equal(session.pageGeneration, 1);
  assert.deepEqual(session.surface, { cssWidth: 1280, cssHeight: 800 });
  assert.deepEqual(session.presentations, {
    preview: { width: 640, height: 400, fps: 1 },
    interactive: { width: 960, height: 600 },
  });
  assert.equal(windows[0].options.show, false);
  assert.equal(typeof windows[0].focus, "undefined");
  assert.equal(typeof windows[0].show, "undefined");

  const preview = await manager.capturePreviewFrame(identity(session));
  assert.deepEqual(
    Object.keys(preview).sort(),
    ["botId", "bytes", "frameId", "frameSequence", "height", "mimeType", "pageGeneration", "presentation", "sessionGeneration", "targetGeneration", "targetId", "width"],
  );
  assert.equal(preview.width, 602);
  assert.equal(preview.height, 400);
  assert.equal(preview.pageGeneration, 1);
  assert.equal(preview.frameSequence, 1);

  const interactive = await manager.captureInteractiveFrame(identity(session));
  assert.equal(interactive.width, 903);
  assert.equal(interactive.height, 600);
  assert.equal(interactive.frameSequence, 2);
  const current = inputIdentity(session, interactive, 1);
  await manager.dispatchMouseEvent({ ...current, type: "mouseMoved", x: 320, y: 200 });
  await manager.dispatchKeyEvent({ ...current, inputSequence: 2, type: "keyDown", key: "a", code: "KeyA" });
  await manager.insertText({ ...current, inputSequence: 3, text: "hello" });
  await manager.imeSetComposition({
    ...current,
    inputSequence: 4,
    text: "hello",
    selectionStart: 5,
    selectionEnd: 5,
  });

  assert.deepEqual(debuggerClient.commands.map(({ method }) => method), [
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Input.imeSetComposition",
  ]);
  assert.equal(debuggerClient.commands[0].params.x, 320);
  assert.equal(debuggerClient.commands[0].params.y, 200);
  assert.equal(debuggerClient.commands.some(({ method }) => method === "Runtime.evaluate"), false);
  assert.equal(debuggerClient.commands.some(({ method }) => method === "Page.bringToFront"), false);
  assert.equal(debuggerClient.commands.some(({ method }) => method === "Input.dispatchMouseEvent" && method === "sendInputEvent"), false);
});

test("interactive input requires the current page and frame and strictly increasing input sequences", async (t) => {
  const { manager } = await fixture(t, { debuggerFactory: () => new FakeDebugger() });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  const current = inputIdentity(session, frame, 1);

  await manager.dispatchMouseEvent({ ...current, type: "mouseMoved", x: 4, y: 5 });
  await assert.rejects(
    manager.dispatchMouseEvent({ ...current, type: "mouseMoved", x: 4, y: 5 }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_STALE",
  );
  await assert.rejects(
    manager.dispatchMouseEvent({ ...current, type: "mouseMoved", x: 4, y: 5, inputSequence: 2, frameSequence: frame.frameSequence + 1 }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_STALE",
  );
  await assert.rejects(
    manager.dispatchMouseEvent({ ...current, type: "mouseMoved", x: 4, y: 5, inputSequence: 3, pageGeneration: frame.pageGeneration + 1 }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_STALE",
  );
  await assert.rejects(
    manager.dispatchMouseEvent({ ...current, type: "mouseMoved", inputSequence: 4, x: 1280.01, y: 5 }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_INVALID",
  );
  await assert.rejects(
    manager.dispatchMouseEvent({ ...current, type: "mouseMoved", inputSequence: 5, x: Number.NaN, y: 5 }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_INVALID",
  );
});

test("navigation releases held input, advances page generation, and keeps history controls HTTPS-only", async (t) => {
  const debuggerClient = new FakeDebugger();
  const { manager, windows } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  const webContents = windows[0].webContents;
  const finishHistory = () => queueMicrotask(() => {
    webContents.emit("did-start-navigation", {}, webContents.getURL(), false, true);
    webContents.emit("did-navigate", {}, webContents.getURL());
  });
  webContents.goBack = mock.fn(finishHistory);
  webContents.goForward = mock.fn(finishHistory);
  webContents.reload = mock.fn(finishHistory);

  await manager.dispatchMouseEvent({ ...inputIdentity(session, frame, 1), type: "mousePressed", x: 10, y: 20, button: "left" });
  await manager.dispatchKeyEvent({ ...inputIdentity(session, frame, 2), type: "keyDown", key: "Shift", code: "ShiftLeft" });
  await manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/next" });
  assert.equal(session.pageGeneration, 1);
  const nextFrame = await manager.captureInteractiveFrame(identity(session));
  assert.equal(nextFrame.pageGeneration, 2);
  assert.equal(debuggerClient.commands.filter(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased").length, 1);
  assert.equal(debuggerClient.commands.filter(({ method, params }) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 1);

  await manager.goBack({ ...identity(session), sessionGeneration: session.sessionGeneration, pageGeneration: nextFrame.pageGeneration });
  await manager.goForward({ ...identity(session), sessionGeneration: session.sessionGeneration, pageGeneration: nextFrame.pageGeneration + 1 });
  await manager.reload({ ...identity(session), sessionGeneration: session.sessionGeneration, pageGeneration: nextFrame.pageGeneration + 2 });
  assert.equal(webContents.goBack.mock.callCount(), 1);
  assert.equal(webContents.goForward.mock.callCount(), 1);
  assert.equal(webContents.reload.mock.callCount(), 1);
  await assert.rejects(
    manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "http://example.com/nope" }),
    (error) => error?.code === "OPENBOT_LOCAL_NAVIGATION_INVALID",
  );
});

test("debugger detach releases held input and fences only its bot", async (t) => {
  const debuggers = new Map();
  const { manager } = await fixture(t, {
    debuggerFactory: (_webContents, identityValue) => {
      const debuggerClient = new FakeDebugger();
      debuggers.set(identityValue.botId, debuggerClient);
      return debuggerClient;
    },
  });
  const a = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const b = await manager.open(localComputer(BOT_B, LOCAL_B, 1));
  const frameA = await manager.captureInteractiveFrame(identity(a));
  const frameB = await manager.captureInteractiveFrame(identity(b));
  await manager.dispatchMouseEvent({ ...inputIdentity(a, frameA, 1), type: "mousePressed", x: 1, y: 2, button: "left" });
  await manager.dispatchKeyEvent({ ...inputIdentity(a, frameA, 2), type: "keyDown", key: "a", code: "KeyA" });
  await manager.dispatchMouseEvent({ ...inputIdentity(b, frameB, 1), type: "mouseMoved", x: 3, y: 4 });

  debuggers.get(BOT_A).emit("detach", {}, "lost debugger");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.captureInteractiveFrame(identity(a)), (error) => error?.code === "OPENBOT_LOCAL_DESKTOP_STALE");
  assert.equal((await manager.captureInteractiveFrame(identity(b))).botId, BOT_B);
  const aMethods = debuggers.get(BOT_A).commands.map(({ method, params }) => `${method}:${params.type || ""}`);
  assert.ok(aMethods.includes("Input.dispatchMouseEvent:mouseReleased"));
  assert.ok(aMethods.includes("Input.dispatchKeyEvent:keyUp"));
  assert.equal(debuggers.get(BOT_B).commands.some(({ params }) => params.type === "mouseReleased" || params.type === "keyUp"), false);
});

test("retry tears down held input before reopening the exact bot", async (t) => {
  const debuggerClients = [];
  const { manager } = await fixture(t, {
    debuggerFactory: () => {
      const client = new FakeDebugger();
      debuggerClients.push(client);
      return client;
    },
  });
  const first = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  const frame = await manager.captureInteractiveFrame(identity(first));
  await manager.dispatchMouseEvent({ ...inputIdentity(first, frame, 1), type: "mousePressed", x: 1, y: 2, button: "left" });
  const second = await manager.retry(localComputer(BOT_A, LOCAL_A, 1));
  assert.equal(second.botId, BOT_A);
  assert.equal(second.pageGeneration, 2);
  assert.equal(debuggerClients.length, 2);
  assert.equal(debuggerClients[0].commands.some(({ method, params }) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"), true);
  await assert.rejects(
    manager.dispatchMouseEvent({ ...inputIdentity(first, frame, 2), type: "mouseMoved", x: 1, y: 2 }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_STALE",
  );
});

test("a closed and reopened profile rejects a byte-identical old frame and input token", async (t) => {
  const debuggers = [];
  const { manager, windows } = await fixture(t, {
    debuggerFactory: () => {
      const client = new FakeDebugger();
      debuggers.push(client);
      return client;
    },
  });
  const first = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  windows[0].webContents.capturePageImpl = async () => nativeImage({ bytes: Buffer.from("identical-frame") });
  const oldFrame = await manager.captureInteractiveFrame(identity(first));
  const oldInput = inputIdentity(first, oldFrame, 1);

  debuggers[0].emit("detach", {}, "lost debugger");
  await new Promise((resolve) => setImmediate(resolve));
  const second = await manager.open(localComputer(BOT_A, LOCAL_A, 1));
  windows[1].webContents.capturePageImpl = async () => nativeImage({ bytes: Buffer.from("identical-frame") });
  const newFrame = await manager.captureInteractiveFrame(identity(second));

  assert.notEqual(second.sessionGeneration, first.sessionGeneration);
  assert.equal(newFrame.frameId, oldFrame.frameId);
  assert.equal(newFrame.frameSequence, oldFrame.frameSequence);
  assert.equal(newFrame.pageGeneration, oldFrame.pageGeneration);
  await assert.rejects(
    manager.dispatchMouseEvent({ ...oldInput, type: "mouseMoved", x: 12, y: 13 }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_STALE",
  );
  assert.equal(debuggers[1].commands.length, 0);
});

test("a rejected browser-applied key down is preclaimed and explicitly compensated with its key-code tuple", async (t) => {
  const debuggerClient = new FakeDebugger();
  debuggerClient.sendCommandImpl = async (method) => {
    if (method === "Input.dispatchKeyEvent" && debuggerClient.commands.at(-1)?.params.type === "keyDown") {
      throw new Error("browser applied then transport rejected");
    }
    return {};
  };
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));

  await assert.rejects(
    manager.dispatchKeyEvent({
      ...inputIdentity(session, frame, 1),
      type: "keyDown",
      key: "Shift",
      code: "ShiftLeft",
    }),
    (error) => error?.code === "OPENBOT_LOCAL_DEBUGGER_DETACHED",
  );
  assert.deepEqual(debuggerClient.commands.map(({ method, params }) => ({ method, params })), [
    {
      method: "Input.dispatchKeyEvent",
      params: { type: "keyDown", key: "Shift", code: "ShiftLeft" },
    },
    {
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", key: "Shift", code: "ShiftLeft" },
    },
  ]);
});

test("synchronous detach during the final debugger check cannot queue key down after cleanup key up", async (t) => {
  class DetachOnFinalCheckDebugger extends FakeDebugger {
    checks = 0;
    get isAttached() {
      this.checks += 1;
      if (this.checks === 3) this.emit("detach", {}, "detach before command");
      return this.attached;
    }
  }
  const debuggerClient = new DetachOnFinalCheckDebugger();
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await assert.rejects(
    manager.dispatchKeyEvent({
      ...inputIdentity(session, frame, 1),
      type: "keyDown",
      key: "a",
      code: "KeyA",
    }),
    (error) => /STALE|DETACHED/.test(error?.code || ""),
  );
  assert.deepEqual(debuggerClient.commands, [
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a", code: "KeyA" } },
  ]);
});

test("CDP receives only the exact public mouse and keyboard parameter whitelist", async (t) => {
  const debuggerClient = new FakeDebugger();
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.dispatchMouseEvent({
    ...inputIdentity(session, frame, 1),
    type: "mouseMoved",
    coordinate: { x: 10, y: 11 },
    coordinateSpace: "css-dip",
    deviceScaleFactor: 1,
    modifiers: 2,
  });
  await manager.dispatchKeyEvent({
    ...inputIdentity(session, frame, 2),
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  assert.deepEqual(debuggerClient.commands, [
    { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 10, y: 11, modifiers: 2 } },
    { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 } },
  ]);
});

test("history navigation waits for authoritative main-frame start and completion events", async (t) => {
  const { manager, windows } = await fixture(t, { navigationTimeoutMs: 50 });
  const session = await manager.open(localComputer());
  windows[0].webContents.goBack = () => {};
  let settled = false;
  const navigating = manager.goBack({ ...identity(session), sessionGeneration: session.sessionGeneration, pageGeneration: session.pageGeneration })
    .then((value) => {
      settled = true;
      return value;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  windows[0].webContents.emit("did-start-navigation", {}, "https://example.com/", false, true);
  windows[0].webContents.emit("did-navigate", {}, "https://example.com/");
  const result = await navigating;
  assert.equal(result.pageGeneration, session.pageGeneration + 1);
});

test("history navigation fails within its bound when no authoritative navigation event arrives", async (t) => {
  const { manager, windows } = await fixture(t, { navigationTimeoutMs: 10 });
  const session = await manager.open(localComputer());
  windows[0].webContents.reload = () => {};
  await assert.rejects(
    manager.reload({ ...identity(session), sessionGeneration: session.sessionGeneration, pageGeneration: session.pageGeneration }),
    (error) => error?.code === "OPENBOT_LOCAL_NAVIGATION_FAILED",
  );
});

test("history navigation treats redirect main-frame starts as one command", async (t) => {
  const { manager, windows } = await fixture(t, { navigationTimeoutMs: 50 });
  const session = await manager.open(localComputer());
  const events = [];
  manager.on("navigation-changed", (value) => events.push(value));
  const webContents = windows[0].webContents;
  webContents.goForward = () => queueMicrotask(() => {
    webContents.emit("did-start-navigation", {}, "https://example.com/one", false, true);
    webContents.emit("did-start-navigation", {}, "https://example.com/two", false, true);
    webContents.emit("did-navigate", {}, "https://example.com/two");
  });
  const result = await manager.goForward({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    pageGeneration: session.pageGeneration,
  });
  assert.equal(result.pageGeneration, session.pageGeneration + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "goForward");
  assert.equal(events[0].url, null);
});

test("synchronous debugger detach during attach cannot publish a live session", async (t) => {
  const debuggerClient = new FakeDebugger();
  debuggerClient.attachImpl = async () => {
    debuggerClient.emit("detach", {}, "detach inside attach");
  };
  const { manager, windows } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const result = await manager.open(localComputer()).catch((error) => error);
  assert.match(result?.code || "", /DEBUGGER|STALE|START_FAILED/);
  assert.equal(windows[0].destroyed, true);
});

test("close during debugger attach drains ownership and cannot publish the late debugger", async (t) => {
  const attachEntered = deferred();
  const releaseAttach = deferred();
  const debuggerClient = new FakeDebugger();
  debuggerClient.attachImpl = async () => {
    attachEntered.resolve();
    await releaseAttach.promise;
  };
  const { manager, windows } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const opening = manager.open(localComputer()).catch((error) => error);
  await attachEntered.promise;
  windows[0].destroy();
  releaseAttach.resolve();
  const result = await opening;
  assert.match(result?.code || "", /STALE|START_FAILED/);
  assert.equal(debuggerClient.detachCalls, 1);
});

test("debugger attachment requires a detachable event ownership surface", async (t) => {
  const { manager, windows } = await fixture(t, {
    debuggerFactory: () => ({
      isAttached: false,
      async attach() { this.isAttached = true; },
      async sendCommand() {},
    }),
  });
  const result = await manager.open(localComputer()).catch((error) => error);
  assert.equal(result?.code, "OPENBOT_LOCAL_DEBUGGER_UNAVAILABLE");
  assert.equal(windows[0].destroyed, true);
});

test("close during debugger factory await adopts and detaches an already-attached late client", async (t) => {
  const factoryEntered = deferred();
  const releaseFactory = deferred();
  const debuggerClient = new FakeDebugger();
  debuggerClient.attached = true;
  const { manager, windows } = await fixture(t, {
    debuggerFactory: async () => {
      factoryEntered.resolve();
      await releaseFactory.promise;
      return debuggerClient;
    },
  });
  const opening = manager.open(localComputer()).catch((error) => error);
  await factoryEntered.promise;
  windows[0].destroy();
  releaseFactory.resolve();
  const result = await opening;
  assert.match(result?.code || "", /STALE|START_FAILED/);
  assert.equal(debuggerClient.detachCalls, 1);
});

test("detach cleanup is drained before the same bot can attach a replacement debugger", async (t) => {
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  const clients = [];
  const { manager } = await fixture(t, {
    debuggerFactory: () => {
      const client = new FakeDebugger();
      clients.push(client);
      return client;
    },
  });
  const first = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(first));
  await manager.dispatchKeyEvent({ ...inputIdentity(first, frame, 1), type: "keyDown", key: "a", code: "KeyA" });
  clients[0].sendCommandImpl = async (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    }
    return {};
  };
  clients[0].emit("detach", {}, "lost debugger");
  await cleanupEntered.promise;
  const reopening = manager.open(localComputer());
  for (let attempt = 0; attempt < 100 && clients.length === 1; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(clients.length, 1);
  releaseCleanup.resolve();
  await reopening;
  assert.equal(clients.length, 2);
});

test("synchronous detach during compensating release cannot reenter close ownership", async (t) => {
  const debuggerClient = new FakeDebugger();
  const { manager, permissionBroker } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.dispatchKeyEvent({ ...inputIdentity(session, frame, 1), type: "keyDown", key: "a", code: "KeyA" });
  let emitted = false;
  debuggerClient.sendCommandImpl = async (method, params) => {
    if (!emitted && method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
      emitted = true;
      debuggerClient.emit("detach", {}, "detach during release");
    }
    return {};
  };
  await manager.close(BOT_A);
  assert.equal(permissionBroker.cancelBot.mock.callCount(), 1);
  assert.equal(debuggerClient.commands.filter(({ method, params }) => (
    method === "Input.dispatchKeyEvent" && params.type === "keyUp"
  )).length, 1);
});

test("capture presentation probing sanitizes hostile proxy traps", async (t) => {
  const { manager } = await fixture(t);
  const hostile = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error("private-presentation-trap");
    },
  });
  let pending;
  assert.doesNotThrow(() => { pending = manager.captureDisplayFrame(hostile); });
  await assert.rejects(
    pending,
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_INVALID"
      && !/private-presentation-trap/.test(String(error)),
  );
});

test("IME replacement range is both present or both absent before any CDP command", async (t) => {
  const debuggerClient = new FakeDebugger();
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await assert.rejects(
    manager.imeSetComposition({
      ...inputIdentity(session, frame, 1),
      text: "hello",
      selectionStart: 0,
      selectionEnd: 5,
      replacementStart: 0,
    }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_INVALID",
  );
  assert.equal(debuggerClient.commands.length, 0);
});

test("close snapshots and drains an already-running exact-bot detach cleanup", async (t) => {
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  const debuggerClient = new FakeDebugger();
  t.after(() => releaseCleanup.resolve());
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.dispatchKeyEvent({ ...inputIdentity(session, frame, 1), type: "keyDown", key: "a", code: "KeyA" });
  debuggerClient.sendCommandImpl = async (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    }
    return {};
  };
  debuggerClient.emit("detach", {}, "lost debugger");
  await cleanupEntered.promise;
  let settled = false;
  const closing = manager.close(BOT_A).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseCleanup.resolve();
  await closing;
});

test("deleteBot drains exact-bot detach cleanup before permission and profile deletion", async (t) => {
  const cleanupEntered = deferred();
  const releaseCleanup = deferred();
  const debuggerClient = new FakeDebugger();
  t.after(() => releaseCleanup.resolve());
  const { manager, permissionBroker, root } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.dispatchKeyEvent({ ...inputIdentity(session, frame, 1), type: "keyDown", key: "a", code: "KeyA" });
  debuggerClient.sendCommandImpl = async (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
    }
    return {};
  };
  debuggerClient.emit("detach", {}, "lost debugger");
  await cleanupEntered.promise;
  const profilePath = path.join(root, "openbot-local", LOCAL_A.slice("local-".length));
  const deleting = manager.deleteBot({ botId: BOT_A, localProfileId: LOCAL_A });
  for (let attempt = 0; attempt < 100 && permissionBroker.deleteBot.mock.callCount() === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 0);
  assert.equal((await fs.lstat(profilePath)).isDirectory(), true);
  releaseCleanup.resolve();
  await deleting;
  assert.equal(permissionBroker.deleteBot.mock.callCount(), 1);
  await assert.rejects(fs.lstat(profilePath), /ENOENT/);
});

test("production debugger isAttached method is authoritative without redundant attach", async (t) => {
  class MethodDebugger extends EventEmitter {
    attached = true;
    attachCalls = 0;
    detachCalls = 0;
    isAttached() { return this.attached; }
    async attach() { this.attachCalls += 1; this.attached = true; }
    async sendCommand() { return {}; }
    async detach() { this.detachCalls += 1; this.attached = false; }
  }
  const debuggerClient = new MethodDebugger();
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  await manager.open(localComputer());
  assert.equal(debuggerClient.attachCalls, 0);
  await manager.close(BOT_A);
  assert.equal(debuggerClient.detachCalls, 1);
});

test("same-document history accepts only a current main-frame in-page completion", async (t) => {
  const { manager, windows } = await fixture(t, { navigationTimeoutMs: 50 });
  const session = await manager.open(localComputer());
  const webContents = windows[0].webContents;
  let settled = false;
  webContents.goBack = () => queueMicrotask(() => {
    webContents.emit("did-start-navigation", {}, "https://example.com/#one", true, true);
    webContents.emit("did-navigate-in-page", {}, "https://example.com/#one", false);
  });
  const navigating = manager.goBack({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    pageGeneration: session.pageGeneration,
  }).then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  webContents.emit("did-navigate-in-page", {}, "https://example.com/#one", true);
  assert.equal((await navigating).pageGeneration, session.pageGeneration + 1);
});

test("failed held-input release fences navigation and closes its exact entry", async (t) => {
  const debuggerClient = new FakeDebugger();
  const { manager, windows } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.dispatchKeyEvent({ ...inputIdentity(session, frame, 1), type: "keyDown", key: "a", code: "KeyA" });
  debuggerClient.sendCommandImpl = async (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") throw new Error("release failed");
    return {};
  };
  await assert.rejects(
    manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/after-release" }),
    (error) => error?.code === "OPENBOT_LOCAL_INPUT_RELEASE_FAILED",
  );
  assert.equal(windows[0].destroyed, true);
  assert.deepEqual(windows[0].webContents.urls, [LOCAL_DESKTOP_START_URL]);
});

test("detach navigation and close share one held-input release flight", async (t) => {
  const releaseEntered = deferred();
  const releaseGate = deferred();
  const debuggerClient = new FakeDebugger();
  t.after(() => releaseGate.resolve());
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.dispatchKeyEvent({ ...inputIdentity(session, frame, 1), type: "keyDown", key: "a", code: "KeyA" });
  debuggerClient.sendCommandImpl = async (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") {
      releaseEntered.resolve();
      await releaseGate.promise;
    }
    return {};
  };
  const navigating = manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/next" }).catch((error) => error);
  await releaseEntered.promise;
  debuggerClient.emit("detach", {}, "detach during navigation cleanup");
  const closing = manager.close(BOT_A);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(debuggerClient.commands.filter(({ method, params }) => (
    method === "Input.dispatchKeyEvent" && params.type === "keyUp"
  )).length, 1);
  releaseGate.resolve();
  await Promise.allSettled([navigating, closing]);
  assert.equal(debuggerClient.commands.filter(({ method, params }) => (
    method === "Input.dispatchKeyEvent" && params.type === "keyUp"
  )).length, 1);
});

test("navigation timeout bounds a held-input release before loadURL", async (t) => {
  const never = deferred();
  const debuggerClient = new FakeDebugger();
  const { manager, windows } = await fixture(t, { debuggerFactory: () => debuggerClient, navigationTimeoutMs: 10 });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.dispatchKeyEvent({ ...inputIdentity(session, frame, 1), type: "keyDown", key: "a", code: "KeyA" });
  debuggerClient.sendCommandImpl = async (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") return never.promise;
    return {};
  };
  const outcome = await Promise.race([
    manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/never" }).then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 80)),
  ]);
  assert.equal(outcome, "OPENBOT_LOCAL_NAVIGATION_FAILED");
  assert.equal(windows[0].destroyed, true);
});

test("navigation timeout bounds a pending direct loadURL and suppresses late publication", async (t) => {
  const loadGate = deferred();
  const { manager, windows } = await fixture(t, { navigationTimeoutMs: 10 });
  const session = await manager.open(localComputer());
  windows[0].webContents.loadURL = () => loadGate.promise;
  const outcome = await Promise.race([
    manager.navigate({ ...identity(session), sessionGeneration: session.sessionGeneration, url: "https://example.com/never" }).then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setTimeout(() => resolve("test-timeout"), 80)),
  ]);
  assert.equal(outcome, "OPENBOT_LOCAL_NAVIGATION_FAILED");
  assert.equal(windows[0].destroyed, true);
  loadGate.resolve();
});

test("direct navigation requires the current session generation after reopen", async (t) => {
  const { manager, windows } = await fixture(t);
  const first = await manager.open(localComputer());
  await manager.close(BOT_A);
  const second = await manager.open(localComputer());
  await assert.rejects(
    manager.navigate({ ...identity(second), url: "https://example.com/missing-session" }),
    (error) => error?.code === "OPENBOT_LOCAL_NAVIGATION_INVALID",
  );
  await assert.rejects(
    manager.navigate({
      ...identity(second),
      sessionGeneration: first.sessionGeneration,
      url: "https://example.com/stale-session",
    }),
    (error) => error?.code === "OPENBOT_LOCAL_NAVIGATION_STALE",
  );
  assert.deepEqual(windows[1].webContents.urls, [LOCAL_DESKTOP_START_URL]);
});

test("IME replacement offsets use an independent bounded existing-document range", async (t) => {
  const debuggerClient = new FakeDebugger();
  const { manager } = await fixture(t, { debuggerFactory: () => debuggerClient });
  const session = await manager.open(localComputer());
  const frame = await manager.captureInteractiveFrame(identity(session));
  await manager.imeSetComposition({
    ...inputIdentity(session, frame, 1),
    text: "x",
    selectionStart: 0,
    selectionEnd: 1,
    replacementStart: 10_000,
    replacementEnd: 10_005,
  });
  assert.deepEqual(debuggerClient.commands.at(-1), {
    method: "Input.imeSetComposition",
    params: {
      text: "x",
      selectionStart: 0,
      selectionEnd: 1,
      replacementStart: 10_000,
      replacementEnd: 10_005,
    },
  });
});

test("close intent immediately rejects new exact-bot work while its navigation queue is held", async (t) => {
  const loadEntered = deferred();
  const releaseLoad = deferred();
  t.after(() => releaseLoad.resolve());
  const { manager, windows, helpers } = await fixture(t);
  const first = await manager.open(localComputer());
  const sibling = await manager.open(localComputer(BOT_B, LOCAL_B));
  windows[0].webContents.loadURL = async () => {
    loadEntered.resolve();
    await releaseLoad.promise;
  };

  const navigating = manager.navigate({
    ...identity(first),
    sessionGeneration: first.sessionGeneration,
    url: "https://example.com/held",
  }).catch((error) => error);
  await loadEntered.promise;

  const closing = manager.close(BOT_A);
  const duplicateClose = manager.close(BOT_A);
  const runOutcome = Promise.race([
    manager.run(action(first)).then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);
  const captureOutcome = Promise.race([
    manager.captureDisplayFrame(identity(first)).then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);

  assert.deepEqual(await Promise.all([runOutcome, captureOutcome]), [
    "OPENBOT_LOCAL_DESKTOP_STALE",
    "OPENBOT_LOCAL_DESKTOP_STALE",
  ]);
  assert.equal(helpers[0].messages.length, 0);
  assert.equal((await manager.captureDisplayFrame(identity(sibling))).botId, BOT_B);

  releaseLoad.resolve();
  await Promise.allSettled([navigating, closing, duplicateClose]);
  assert.equal(windows[0].destroyed, true);
  assert.equal(windows[1].destroyed, false);
});

test("close intent rejects navigation and history admission before the held queue releases", async (t) => {
  const loadEntered = deferred();
  const releaseLoad = deferred();
  t.after(() => releaseLoad.resolve());
  const { manager, windows } = await fixture(t);
  const session = await manager.open(localComputer());
  windows[0].webContents.loadURL = async () => {
    loadEntered.resolve();
    await releaseLoad.promise;
  };

  const navigating = manager.navigate({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    url: "https://example.com/held",
  }).catch((error) => error);
  await loadEntered.promise;
  const closing = manager.close(BOT_A);
  const newNavigation = Promise.race([
    manager.navigate({
      ...identity(session),
      sessionGeneration: session.sessionGeneration,
      url: "https://example.com/rejected",
    }).then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);
  const newHistory = Promise.race([
    manager.reload({
      ...identity(session),
      sessionGeneration: session.sessionGeneration,
      pageGeneration: session.pageGeneration + 1,
    }).then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);

  assert.deepEqual(await Promise.all([newNavigation, newHistory]), [
    "OPENBOT_LOCAL_DESKTOP_STALE",
    "OPENBOT_LOCAL_DESKTOP_STALE",
  ]);
  releaseLoad.resolve();
  await Promise.allSettled([navigating, closing]);
});

test("close intent rejects a pending permission authorization before helper send", async (t) => {
  const authorize = deferred();
  const loadEntered = deferred();
  const releaseLoad = deferred();
  t.after(() => {
    authorize.resolve();
    releaseLoad.resolve();
  });
  const permissionBroker = {
    request: mock.fn(async (_request, effect) => {
      await authorize.promise;
      return effect(Buffer.from("private-bookmark"));
    }),
    cancelTask: mock.fn(),
    cancelBot: mock.fn(),
    deleteBot: mock.fn(async () => {}),
  };
  const { manager, windows, helpers } = await fixture(t, { permissionBroker });
  const session = await manager.open(localComputer());
  const running = manager.run(action(session));
  windows[0].webContents.loadURL = async () => {
    loadEntered.resolve();
    await releaseLoad.promise;
  };
  const navigating = manager.navigate({
    ...identity(session),
    sessionGeneration: session.sessionGeneration,
    url: "https://example.com/held",
  }).catch((error) => error);
  await loadEntered.promise;
  const closing = manager.close(BOT_A);

  authorize.resolve();
  const runOutcome = await Promise.race([
    running.then(() => "resolved", (error) => error?.code),
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);
  assert.equal(runOutcome, "OPENBOT_LOCAL_DESKTOP_STALE");
  assert.equal(helpers[0].messages.length, 0);

  releaseLoad.resolve();
  await Promise.allSettled([navigating, closing, running]);
});
