"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("node:test");

const runtimePath = path.join(__dirname, "..", "src", "local", "local-computer-runtime.cjs");
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";

test("production resource chooser uses no picker for terminal and exact bookmark data for files", async () => {
  const showOpenDialog = mock.fn(async () => ({
    canceled: false,
    filePaths: ["/Users/private/Documents"],
    bookmarks: [Buffer.from("bookmark-private").toString("base64")],
  }));
  const { createResourceChooser } = require(runtimePath);
  const choose = createResourceChooser({ dialog: { showOpenDialog } });

  const terminal = await choose({ botId: BOT_A, capability: "shell.execute" });
  assert.deepEqual(terminal, Buffer.from("openbot-workspace-v1"));
  assert.equal(showOpenDialog.mock.callCount(), 0);

  const bookmark = await choose({ botId: BOT_A, capability: "filesystem.read" });
  assert.deepEqual(bookmark, Buffer.from("bookmark-private"));
  assert.equal(showOpenDialog.mock.callCount(), 1);
  const options = showOpenDialog.mock.calls[0].arguments[0];
  assert.equal(options.securityScopedBookmarks, true);
  assert.equal(options.properties.includes("openFile"), true);
  assert.equal(options.properties.includes("openDirectory"), true);
  assert.doesNotMatch(JSON.stringify(options), /Users|private|token|secret/i);

  showOpenDialog.mock.mockImplementation(async () => ({ canceled: true, filePaths: [], bookmarks: [] }));
  await assert.rejects(choose({ botId: BOT_A, capability: "filesystem.write" }), /cancelled|unavailable/i);
});

test("TCC adapter requests only exact macOS capabilities and fails closed", async () => {
  const systemPreferences = {
    getMediaAccessStatus: mock.fn(() => "granted"),
    isTrustedAccessibilityClient: mock.fn(() => true),
  };
  const { createTccAdapter } = require(runtimePath);
  const tcc = createTccAdapter({ systemPreferences });
  assert.equal(await tcc.ensure({ capability: "shell.execute" }), true);
  assert.equal(await tcc.ensure({ capability: "screen.capture" }), true);
  assert.equal(await tcc.ensure({ capability: "application.automate" }), true);
  assert.deepEqual(systemPreferences.getMediaAccessStatus.mock.calls[0].arguments, ["screen"]);
  assert.deepEqual(systemPreferences.isTrustedAccessibilityClient.mock.calls[0].arguments, [true]);
  systemPreferences.getMediaAccessStatus.mock.mockImplementation(() => "denied");
  assert.equal(await tcc.ensure({ capability: "screen.capture" }), false);
  assert.equal(await tcc.ensure({ capability: "unknown" }), false);
});

test("production local runtime owns the exact store broker manager and boundary closure", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openbot-local-runtime-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const made = {};
  class FakePermissionStore {
    constructor(options) { made.permissionStore = options; }
    authorize() {}
    remember() {}
    revoke() {}
    listPublic() {}
  }
  class FakeBroker {
    constructor(options) { Object.assign(this, { on() {}, off() {}, dispose() {}, decide() {}, list() {}, revoke() {} }); made.broker = options; }
    request() {}
    cancelBot() {}
  }
  class FakeManager {
    constructor(options) { Object.assign(this, { open() {}, close() {}, dispose() {} }); made.manager = options; }
  }
  class FakeBoundary {
    constructor(options) { made.boundary = options; }
  }
  const electron = {
    BrowserWindow: class {},
    session: { fromPartition() {} },
    utilityProcess: { fork: mock.fn() },
    dialog: { showOpenDialog: mock.fn() },
    systemPreferences: {},
  };
  const store = { read: mock.fn(), updateComputer: mock.fn() };
  const { createLocalComputerRuntime } = require(runtimePath);
  const boundary = createLocalComputerRuntime({
    electron,
    stateRoot,
    store,
    PermissionStoreClass: FakePermissionStore,
    BrokerClass: FakeBroker,
    ManagerClass: FakeManager,
    BoundaryClass: FakeBoundary,
  });
  assert.equal(boundary instanceof FakeBoundary, true);
  assert.equal(made.permissionStore.filePath, path.join(stateRoot, "local-permissions.v1.json"));
  assert.equal(made.broker.store instanceof FakePermissionStore, true);
  assert.equal(made.manager.permissionBroker instanceof FakeBroker, true);
  assert.equal(made.boundary.store, store);
  assert.equal(made.boundary.manager instanceof FakeManager, true);
  assert.equal(made.boundary.broker instanceof FakeBroker, true);
  assert.equal(typeof made.manager.helperFactory, "function");
});
