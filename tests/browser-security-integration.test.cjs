"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) =>
  fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");

function loadIsolatedSeatManager(dataRoot) {
  const filename = path.join(
    root,
    "src",
    "browser-seats",
    "browser-seat-manager.cjs",
  );
  const source = `${fs.readFileSync(filename, "utf8")}\nmodule.exports.__activeSeatsForTest = activeSeats;\n`;
  const previousDataRoot = process.env.GROK_BOT_BROWSER_SEAT_DATA;
  process.env.GROK_BOT_BROWSER_SEAT_DATA = dataRoot;
  try {
    const isolatedModule = new Module(filename, module);
    isolatedModule.filename = filename;
    isolatedModule.paths = Module._nodeModulePaths(path.dirname(filename));
    isolatedModule._compile(source, filename);
    return isolatedModule.exports;
  } finally {
    if (previousDataRoot === undefined)
      delete process.env.GROK_BOT_BROWSER_SEAT_DATA;
    else process.env.GROK_BOT_BROWSER_SEAT_DATA = previousDataRoot;
  }
}

test("every browser seat launches behind the authenticated pinned-DNS proxy", () => {
  const manager = read("src/browser-seats/browser-seat-manager.cjs");
  assert.match(manager, /createPublicWebProxy\(\)/);
  assert.match(manager, /const proxyConfig = await publicWebProxy\.listen\(\)/);
  assert.match(
    manager,
    /proxy:\s*\{\s*server: proxyConfig\.server,\s*username: proxyConfig\.username,\s*password: proxyConfig\.password/s,
  );
  assert.match(manager, /await seat\.publicWebProxy\?\.close\(\)/);
  assert.match(manager, /void publicWebProxy\.close\(\)\.catch/);
  assert.match(manager, /installBrowserPageHardening\(context\)/);
  assert.match(manager, /context\.clearPermissions\(\)/);
  assert.match(manager, /acceptDownloads: false/);
  assert.match(manager, /download\.cancel\(\)/);
  assert.match(manager, /\.\.\.CHROMIUM_HARDENING_ARGS/);
  assert.match(
    manager,
    /launchPersistentContext\(profileDir, \{[\s\S]*?chromiumSandbox: true/,
  );
  assert.match(
    manager,
    /--host-resolver-rules=MAP \* ~NOTFOUND, EXCLUDE 127\.0\.0\.1/,
  );
});

test("persistent profile pages remain quarantined until hardening and routes exist", () => {
  const manager = read("src/browser-seats/browser-seat-manager.cjs");
  assert.match(
    manager,
    /preparePersistentProfileForSafeLaunch\(profileDir\)[\s\S]*?launchPersistentContext/,
  );
  assert.match(manager, /preferences\.session\.restore_on_startup = 5/);
  assert.match(manager, /preferences\.session\.startup_urls = \[\]/);
  assert.match(manager, /\^\(\?:Session\|Tabs\)_/);
  assert.match(
    manager,
    /context\.on\("page", quarantineStartupPage\)[\s\S]*?quarantinePersistentStartupPages\(\s*context[\s\S]*?installBrowserPageHardening\(context\)[\s\S]*?context\.route\("\*\*\/\*"/,
  );
  assert.match(
    manager,
    /let seat = null;[\s\S]*?seat = \{[\s\S]*?catch \(error\) \{\s*if \(seat\) seat\.closing = true/,
  );
});

test("the official noVNC viewer keeps Chromium's process sandbox enabled", () => {
  const helper = read("src/official-computer-helper.cjs");
  assert.match(
    helper,
    /chromium\.launch\(\{[\s\S]*?headless: true,[\s\S]*?chromiumSandbox: true/,
  );
  assert.match(
    helper,
    /--host-resolver-rules=MAP \* ~NOTFOUND, EXCLUDE 127\.0\.0\.1/,
  );
});

test("agent browser input is approval-gated while direct takeover is a trusted user actor", () => {
  const manager = read("src/browser-seats/browser-seat-manager.cjs");
  const bridge = read("src/browser-seat-bridge.cjs");
  assert.match(manager, /await actionApprovals\.requestAgentAction/);
  assert.match(manager, /immutableActionSnapshot/);
  assert.match(manager, /seat\.navigationEpoch === expectedEpoch/);
  assert.match(
    manager,
    /JSON\.stringify\(currentContext\) === expectedContext/,
  );
  assert.match(
    manager,
    /approvalOriginForPage\(current\) === decision\.origin/,
  );
  assert.match(manager, /if \(!decision\.allowed\)/);
  assert.match(
    bridge,
    /executeSeatActions\(\s*seatKey,\s*actions,\s*\{\s*actor: "agent",?\s*\},?\s*\)/,
  );
  assert.match(bridge, /actor: "user"/);
  assert.match(bridge, /controlId: String\(body\.controlId/);
  assert.match(manager, /browserControls\.assertAgentAllowed/);
  assert.match(manager, /browserControls\.authorizeUser/);
  assert.match(manager, /acquireUserControl/);
});

test("Private browser Always allow persists, bypasses only action prompts, and fails closed", async (t) => {
  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "open-bot-private-permission-"),
  );
  t.after(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  const manager = loadIsolatedSeatManager(dataRoot);
  assert.deepEqual(manager.computerPermissions(), {
    provider: "private-browser",
    alwaysAllowComputerActions: false,
  });
  assert.throws(
    () => manager.setComputerPermissions(true, false, "private-browser"),
    /requires acknowledgement/,
  );
  assert.deepEqual(
    manager.setComputerPermissions(true, true, "private-browser"),
    {
      provider: "private-browser",
      alwaysAllowComputerActions: true,
    },
  );
  assert.equal(
    loadIsolatedSeatManager(dataRoot).computerPermissions()
      .alwaysAllowComputerActions,
    true,
  );

  const sinkCalls = [];
  const page = {
    isClosed: () => false,
    url: () => "https://example.com/work",
    mouse: {
      click: async () => sinkCalls.push("mouse.click"),
    },
    keyboard: {},
    locator: () => ({ innerText: async () => "ready" }),
    screenshot: async () => Buffer.from("frame"),
    title: async () => "Example",
    waitForTimeout: async () => {},
  };
  const seatKey = "always-allow-seat";
  manager.__activeSeatsForTest.set(seatKey, {
    key: seatKey,
    profileId: "always-allow-profile",
    profileDir: dataRoot,
    downloadsDir: dataRoot,
    sessionStatePath: path.join(dataRoot, "session-state.json"),
    context: { pages: () => [page], newPage: async () => page },
    publicWebProxy: null,
    page,
    cursor: { x: 640, y: 400 },
    address: null,
    navigationEpoch: 0,
    queue: Promise.resolve(),
    pending: 0,
    lastUsed: Date.now(),
    lastPageInfo: { state: "loaded", title: "Example", bodyPreview: "ready" },
    restoringSession: false,
    closing: false,
    closePromise: null,
  });
  await manager.executeSeatActions(seatKey, [
    { kind: "click", coordinate: { x: 12, y: 34 }, button: "left" },
  ]);
  assert.deepEqual(sinkCalls, ["mouse.click"]);
  assert.equal(manager.pendingApprovalForSeat(seatKey), null);

  fs.writeFileSync(path.join(dataRoot, "permissions.json"), "corrupt");
  assert.equal(manager.computerPermissions().alwaysAllowComputerActions, false);
  assert.deepEqual(
    manager.setComputerPermissions(false, false, "private-browser"),
    {
      provider: "private-browser",
      alwaysAllowComputerActions: false,
    },
  );
});

test("takeover during the final validated page lookup stops the approved agent action", async (t) => {
  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-seat-takeover-"),
  );
  t.after(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  const manager = loadIsolatedSeatManager(dataRoot);
  const seatKey = "takeover-race-seat";
  const ownerId = "trusted-view-owner-0001";
  const sinkCalls = [];
  const handoffEvents = [];
  let pageLookupCount = 0;
  let takeoverPromise;
  let signalTakeoverStarted;
  const takeoverStarted = new Promise((resolve) => {
    signalTakeoverStarted = resolve;
  });

  const page = {
    isClosed: () => false,
    url: () => "https://example.com/work",
    mouse: {
      click: async () => sinkCalls.push("mouse.click"),
      down: async () => sinkCalls.push("mouse.down"),
      move: async () => sinkCalls.push("mouse.move"),
      up: async () => sinkCalls.push("mouse.up"),
      wheel: async () => sinkCalls.push("mouse.wheel"),
    },
    keyboard: {
      press: async () => sinkCalls.push("keyboard.press"),
      type: async () => sinkCalls.push("keyboard.type"),
    },
    locator: () => ({ innerText: async () => "ready" }),
    screenshot: async () => Buffer.from("frame"),
    title: async () => "Example",
    waitForTimeout: async () => {},
  };
  const seat = {
    key: seatKey,
    profileId: "takeover-race-profile",
    profileDir: dataRoot,
    downloadsDir: dataRoot,
    sessionStatePath: path.join(dataRoot, "session-state.json"),
    context: {
      pages() {
        pageLookupCount += 1;
        if (pageLookupCount === 3) {
          queueMicrotask(() => {
            handoffEvents.push("takeover-started");
            let queueDrained = false;
            seat.queue.then(() => {
              queueDrained = true;
              handoffEvents.push("queue-drained");
            });
            takeoverPromise = manager
              .acquireUserControl(seatKey, ownerId)
              .then((lease) => {
                assert.equal(queueDrained, true);
                handoffEvents.push("takeover-resolved");
                return lease;
              });
            signalTakeoverStarted();
          });
        }
        return [page];
      },
      newPage: async () => page,
    },
    publicWebProxy: null,
    page,
    cursor: { x: 640, y: 400 },
    address: null,
    navigationEpoch: 0,
    queue: Promise.resolve(),
    pending: 0,
    lastUsed: Date.now(),
    lastPageInfo: { state: "loaded", title: "Example", bodyPreview: "ready" },
    restoringSession: false,
    closing: false,
    closePromise: null,
  };
  manager.__activeSeatsForTest.set(seatKey, seat);

  const agentAction = manager.executeSeatActions(seatKey, [
    { kind: "mouseMove", coordinate: { x: 12, y: 34 } },
  ]);
  await takeoverStarted;
  assert.equal(manager.controlStatusForSeat(seatKey).controlled, true);
  await assert.rejects(
    manager.executeSeatActions(seatKey, [
      { kind: "mouseMove", coordinate: { x: 1, y: 2 } },
    ]),
    /direct control/,
  );
  await assert.rejects(agentAction, /direct control/);
  await takeoverPromise;

  assert.deepEqual(sinkCalls, []);
  assert.deepEqual(handoffEvents, [
    "takeover-started",
    "queue-drained",
    "takeover-resolved",
  ]);
  assert.equal(seat.pending, 0);
});

test("an approved action stays on the exact page that passed final validation", async (t) => {
  const dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-seat-page-binding-"),
  );
  t.after(() => fs.rmSync(dataRoot, { force: true, recursive: true }));
  const manager = loadIsolatedSeatManager(dataRoot);
  const seatKey = "page-binding-seat";
  const sinkCalls = [];
  let pageLookupCount = 0;

  const makePage = (name) => ({
    isClosed: () => false,
    url: () => `https://example.com/${name}`,
    mouse: {
      click: async () => sinkCalls.push(`${name}.mouse.click`),
      down: async () => sinkCalls.push(`${name}.mouse.down`),
      move: async () => sinkCalls.push(`${name}.mouse.move`),
      up: async () => sinkCalls.push(`${name}.mouse.up`),
      wheel: async () => sinkCalls.push(`${name}.mouse.wheel`),
    },
    keyboard: {
      press: async () => sinkCalls.push(`${name}.keyboard.press`),
      type: async () => sinkCalls.push(`${name}.keyboard.type`),
    },
    locator: () => ({ innerText: async () => "ready" }),
    screenshot: async () => Buffer.from(`frame-${name}`),
    title: async () => name,
    waitForTimeout: async () => {},
  });
  const approvedPage = makePage("approved");
  const replacementPage = makePage("replacement");
  const seat = {
    key: seatKey,
    profileId: "page-binding-profile",
    profileDir: dataRoot,
    downloadsDir: dataRoot,
    sessionStatePath: path.join(dataRoot, "session-state.json"),
    context: {
      pages() {
        pageLookupCount += 1;
        return [pageLookupCount >= 4 ? replacementPage : approvedPage];
      },
      newPage: async () => approvedPage,
    },
    publicWebProxy: null,
    page: approvedPage,
    cursor: { x: 640, y: 400 },
    address: null,
    navigationEpoch: 0,
    queue: Promise.resolve(),
    pending: 0,
    lastUsed: Date.now(),
    lastPageInfo: { state: "loaded", title: "approved", bodyPreview: "ready" },
    restoringSession: false,
    closing: false,
    closePromise: null,
  };
  manager.__activeSeatsForTest.set(seatKey, seat);

  await manager.executeSeatActions(seatKey, [
    { kind: "mouseMove", coordinate: { x: 12, y: 34 } },
  ]);

  assert.deepEqual(sinkCalls, ["approved.mouse.move"]);
  assert.equal(
    pageLookupCount >= 4,
    true,
    "post-action capture may observe the replacement page",
  );
  assert.equal(seat.pending, 0);
});

test("approval UI exposes safe status and authenticated allow or deny decisions", () => {
  const bridge = read("src/browser-seat-bridge.cjs");
  const liveSeat = read("src/renderer/live-seat-component.jsfrag");
  const renderer = read("src/renderer/codex-ui.js");
  assert.match(bridge, /\/api\/approval/);
  assert.match(bridge, /\/api\/approvals/);
  assert.match(bridge, /provider\.pendingApprovalForSeat/);
  assert.match(bridge, /provider\.pendingApprovals/);
  assert.match(bridge, /provider\.decidePendingApproval/);
  assert.match(renderer, /Computer action needs your permission/);
  assert.match(renderer, /Private browser/);
  assert.match(renderer, /Vendor computer/);
  assert.match(renderer, /Allow once/);
  assert.match(renderer, /Deny/);
  assert.match(renderer, /approvalActionLabel/);
  assert.match(renderer, /officialApprovalBinding/);
  assert.match(renderer, /request\("\/api\/approvals"\)/);
  assert.match(renderer, /request\("\/api\/approval"/);
  const approvalPoll = liveSeat.slice(
    liveSeat.indexOf("const j = T.useCallback"),
    liveSeat.indexOf(
      "T.useEffect",
      liveSeat.indexOf("const j = T.useCallback"),
    ),
  );
  assert.doesNotMatch(approvalPoll, /\/api\/approval/);
  assert.match(liveSeat, /action: "acquire"/);
  assert.match(liveSeat, /action: "heartbeat"/);
  assert.match(liveSeat, /action: "release"/);
});

test("installer explicitly packages both browser security modules", () => {
  const installer = read("installer/CodexBot.iss");
  assert.match(installer, /public-web-proxy\.cjs/);
  assert.match(installer, /browser-action-approval\.cjs/);
  assert.match(installer, /browser-control-lease\.cjs/);
  assert.match(installer, /browser-page-hardening\.cjs/);
});
