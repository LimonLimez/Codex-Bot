"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const ipcPath = path.join(__dirname, "..", "src", "desktop", "openbot-native-coordinator-ipc.cjs");

class FakePort extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.closed = 0;
  }

  close() { this.closed += 1; }
  start() {}
  postMessage() {}
}

function harness({ ownsWindow = false } = {}) {
  const handlers = new Map();
  const channels = [];
  class MessageChannelMain {
    constructor() {
      this.port1 = new FakePort(`main-${channels.length + 1}`);
      this.port2 = new FakePort(`renderer-${channels.length + 1}`);
      channels.push(this);
    }
  }
  const sender = new EventEmitter();
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  const mainFrame = {
    processId: 41,
    routingId: 73,
    isDestroyed: () => false,
  };
  sender.mainFrame = mainFrame;
  const delivered = [];
  const senderFrame = {
    processId: 41,
    routingId: 73,
    isDestroyed: () => false,
    postMessage(channel, value, ports) { delivered.push({ channel, value, ports }); },
  };
  const window = {
    webContents: sender,
    isDestroyed: () => false,
  };
  const electron = {
    MessageChannelMain,
    ipcMain: {
      handle(channel, handler) { handlers.set(channel, handler); },
      removeHandler(channel) { handlers.delete(channel); },
    },
    BrowserWindow: {
      fromWebContents(value) { return value === sender ? window : null; },
    },
  };
  const bound = [];
  const coordinator = {
    disposed: 0,
    bindPort(port) {
      const session = { port, disposed: 0 };
      bound.push(session);
      return () => { session.disposed += 1; port.close(); };
    },
    dispose() { this.disposed += 1; },
  };
  const localDesktopManager = { ownsWindow() { return ownsWindow; } };
  return {
    bound,
    channels,
    coordinator,
    delivered,
    electron,
    event: { sender, senderFrame },
    handlers,
    localDesktopManager,
    sender,
  };
}

test("native coordinator IPC transfers one OpenBot port to the exact current main frame", async () => {
  const {
    OPENBOT_NATIVE_COORDINATOR_CHANNELS,
    installOpenBotNativeCoordinatorIpc,
  } = require(ipcPath);
  const fixture = harness();
  const installed = installOpenBotNativeCoordinatorIpc({
    electron: fixture.electron,
    coordinator: fixture.coordinator,
    localDesktopManager: fixture.localDesktopManager,
  });
  const handler = fixture.handlers.get(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request);
  assert.equal(typeof handler, "function");
  assert.equal(await handler(fixture.event), null);
  assert.equal(fixture.bound.length, 1);
  assert.equal(fixture.bound[0].port, fixture.channels[0].port1);
  assert.deepEqual(fixture.delivered, [{
    channel: OPENBOT_NATIVE_COORDINATOR_CHANNELS.deliver,
    value: null,
    ports: [fixture.channels[0].port2],
  }]);
  assert.equal(fixture.sender.listenerCount("destroyed"), 1);
  await installed.dispose();
});

test("native coordinator IPC replaces a sender session and tears it down on sender destruction", async () => {
  const {
    OPENBOT_NATIVE_COORDINATOR_CHANNELS,
    installOpenBotNativeCoordinatorIpc,
  } = require(ipcPath);
  const fixture = harness();
  const installed = installOpenBotNativeCoordinatorIpc({
    electron: fixture.electron,
    coordinator: fixture.coordinator,
    localDesktopManager: fixture.localDesktopManager,
  });
  const handler = fixture.handlers.get(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request);
  await handler(fixture.event);
  await handler(fixture.event);
  assert.equal(fixture.bound.length, 2);
  assert.equal(fixture.bound[0].disposed, 1);
  assert.equal(fixture.bound[1].disposed, 0);
  fixture.sender.destroyed = true;
  fixture.sender.emit("destroyed");
  assert.equal(fixture.bound[1].disposed, 1);
  await installed.dispose();
  assert.equal(fixture.bound[1].disposed, 1);
});

test("native coordinator IPC rejects child, destroyed, and hidden Local Desktop senders before effects", async () => {
  const {
    OPENBOT_NATIVE_COORDINATOR_CHANNELS,
    installOpenBotNativeCoordinatorIpc,
  } = require(ipcPath);
  for (const variant of ["child", "destroyed", "hidden"]) {
    const fixture = harness({ ownsWindow: variant === "hidden" });
    if (variant === "child") fixture.event.senderFrame.routingId = 74;
    if (variant === "destroyed") fixture.sender.destroyed = true;
    const installed = installOpenBotNativeCoordinatorIpc({
      electron: fixture.electron,
      coordinator: fixture.coordinator,
      localDesktopManager: fixture.localDesktopManager,
    });
    const handler = fixture.handlers.get(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request);
    await assert.rejects(async () => handler(fixture.event), (error) => {
      assert.equal(error.code, "OPENBOT_NATIVE_COORDINATOR_OPERATION_FAILED");
      assert.equal(error.message, "OpenBot native coordinator operation failed.");
      return true;
    });
    assert.equal(fixture.channels.length, 0, variant);
    assert.equal(fixture.bound.length, 0, variant);
    assert.equal(fixture.delivered.length, 0, variant);
    await installed.dispose();
  }
});

test("native coordinator IPC disposal removes only its handler and disposes every owner once", async () => {
  const {
    OPENBOT_NATIVE_COORDINATOR_CHANNELS,
    installOpenBotNativeCoordinatorIpc,
  } = require(ipcPath);
  const fixture = harness();
  const sibling = () => {};
  fixture.handlers.set("vendor:sibling", sibling);
  const installed = installOpenBotNativeCoordinatorIpc({
    electron: fixture.electron,
    coordinator: fixture.coordinator,
    localDesktopManager: fixture.localDesktopManager,
  });
  await fixture.handlers.get(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request)(fixture.event);
  await Promise.all([installed.dispose(), installed.dispose()]);
  assert.equal(fixture.handlers.has(OPENBOT_NATIVE_COORDINATOR_CHANNELS.request), false);
  assert.equal(fixture.handlers.get("vendor:sibling"), sibling);
  assert.equal(fixture.bound[0].disposed, 1);
  assert.equal(fixture.coordinator.disposed, 1);
});
