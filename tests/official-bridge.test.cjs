"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");

const root = path.resolve(__dirname, "..");
const VIEW_TOKEN = "official-bridge-test-token-00000000000000000000";
const SECRET_SENTINEL = "must-not-reach-renderer-00000000000000000000";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl7sAAAAASUVORK5CYII=";

let bridge;
let server;
let port;
let stateRoot;
let official;
let privateManager;
let originalOfficial;
let originalPrivate;
const openedOfficialLogins = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function reserveLoopbackPort() {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const selected = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return selected;
}

async function request(route, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.authorized !== false) headers["X-Codex-Seat-Token"] = VIEW_TOKEN;
  let body;
  if (Object.hasOwn(options, "body")) {
    headers["Content-Type"] = options.contentType || "application/json";
    body =
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  }
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: options.method || (body == null ? "GET" : "POST"),
    headers,
    body,
    cache: "no-store",
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    value: text ? JSON.parse(text) : null,
  };
}

function safeStatus(mode = "private") {
  return {
    mode,
    connected: true,
    state: mode === "official" ? "ready" : "signed-in",
    ready: mode === "official",
    generation: 7,
    shared: true,
    provider: "official-grok-cloud",
    experimental: true,
    billingPossible: true,
    permissions: {
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: false,
    },
    lastError: null,
  };
}

function restoreMocks() {
  Object.assign(official, originalOfficial);
  Object.assign(privateManager, originalPrivate);
}

test.before(async () => {
  port = await reserveLoopbackPort();
  stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-official-bridge-test-"),
  );
  process.env.CODEX_BOT_STATE_ROOT = stateRoot;
  process.env.GROK_BOT_BROWSER_VIEW_PORT = String(port);
  process.env.GROK_BOT_BROWSER_VIEW_TOKEN = VIEW_TOKEN;
  bridge = require(path.join(root, "src", "browser-seat-bridge.cjs"));
  official = bridge.officialComputer;
  privateManager = bridge.privateManager;
  originalOfficial = { ...official };
  originalPrivate = {
    ensureSeat: privateManager.ensureSeat,
    closeSeatForKey: privateManager.closeSeatForKey,
    captureSeat: privateManager.captureSeat,
    executeSeatActions: privateManager.executeSeatActions,
    pendingApprovals: privateManager.pendingApprovals,
    computerPermissions: privateManager.computerPermissions,
    setComputerPermissions: privateManager.setComputerPermissions,
  };
  official.status = async () => safeStatus("private");
  server = bridge.startViewServer({
    openOfficialLogin: async (loginUrl) => {
      openedOfficialLogins.push(loginUrl);
      return loginUrl;
    },
  });
  if (!server.listening) await once(server, "listening");
});

test.after(async () => {
  restoreMocks();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test.afterEach(() => {
  restoreMocks();
  openedOfficialLogins.length = 0;
});

test("official control route requires authentication and an exact JSON schema", async () => {
  let loginCalls = 0;
  let modeCalls = 0;
  official.startLogin = async () => {
    loginCalls += 1;
    return {
      loginUrl:
        "https://cursor.com/loginDeepControl?challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&uuid=123e4567-e89b-42d3-a456-426614174000&mode=login&redirectTarget=sand",
      state: "signing-in",
    };
  };
  official.setMode = async (mode, acknowledged) => {
    modeCalls += 1;
    if (mode === "official" && acknowledged !== true) {
      const error = new Error("Acknowledgement required.");
      error.statusCode = 400;
      throw error;
    }
    return safeStatus(mode);
  };

  assert.equal(
    (
      await request("/api/official-computer", {
        authorized: false,
        body: { action: "login" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/official-computer", {
        body: { action: "login" },
        contentType: "text/plain",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/official-computer", {
        body: { action: "login", unexpected: true },
      })
    ).status,
    400,
  );
  assert.equal(loginCalls, 0);

  assert.equal(
    (
      await request("/api/official-computer", {
        body: { action: "mode", mode: "private" },
      })
    ).status,
    200,
  );
  assert.equal(modeCalls, 1);
  assert.equal(
    (
      await request("/api/official-computer", {
        body: { action: "mode", mode: "private", acknowledged: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/official-computer", {
        body: { action: "mode", mode: "official" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/official-computer?unexpected=1", {
        body: { action: "login" },
      })
    ).status,
    400,
  );
});

test("vendor permission updates require an exact provider-scoped acknowledgement", async () => {
  const updates = [];
  let alwaysAllow = false;
  official.setComputerPermissions = async (next, acknowledged, provider) => {
    updates.push({ next, acknowledged, provider });
    if (next && acknowledged !== true) {
      const error = new Error("Acknowledgement required.");
      error.statusCode = 400;
      throw error;
    }
    alwaysAllow = next;
    return {
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: next,
      injectedSecret: SECRET_SENTINEL,
    };
  };
  official.status = async () => ({
    ...safeStatus("official"),
    permissions: {
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: alwaysAllow,
    },
  });
  const enabled = await request("/api/official-computer", {
    body: {
      action: "permissions",
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: true,
      acknowledged: true,
    },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.text.includes(SECRET_SENTINEL), false);
  assert.deepEqual(enabled.value.result, {
    provider: "official-grok-cloud",
    alwaysAllowComputerActions: true,
  });
  assert.equal(
    enabled.value.status.permissions.alwaysAllowComputerActions,
    true,
  );
  assert.deepEqual(updates, [
    {
      next: true,
      acknowledged: true,
      provider: "official-grok-cloud",
    },
  ]);

  for (const body of [
    {
      action: "permissions",
      provider: "private",
      alwaysAllowComputerActions: true,
      acknowledged: true,
    },
    {
      action: "permissions",
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: true,
      acknowledged: true,
      unexpected: true,
    },
    {
      action: "permissions",
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: "true",
      acknowledged: true,
    },
  ])
    assert.equal(
      (await request("/api/official-computer", { body })).status,
      400,
    );
  assert.equal(updates.length, 1);

  const disabled = await request("/api/official-computer", {
    body: {
      action: "permissions",
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: false,
      acknowledged: false,
    },
  });
  assert.equal(disabled.status, 200);
  assert.equal(
    disabled.value.status.permissions.alwaysAllowComputerActions,
    false,
  );
  assert.equal(updates.length, 2);
});

test("Private browser permission updates are exact, scoped, and exposed in status", async () => {
  const updates = [];
  let alwaysAllow = false;
  privateManager.computerPermissions = () => ({
    provider: "private-browser",
    alwaysAllowComputerActions: alwaysAllow,
    injectedSecret: SECRET_SENTINEL,
  });
  privateManager.setComputerPermissions = (next, acknowledged, provider) => {
    updates.push({ next, acknowledged, provider });
    alwaysAllow = next;
    return privateManager.computerPermissions();
  };
  const enabled = await request("/api/private-computer", {
    body: {
      action: "permissions",
      provider: "private-browser",
      alwaysAllowComputerActions: true,
      acknowledged: true,
    },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.text.includes(SECRET_SENTINEL), false);
  assert.deepEqual(enabled.value.result, {
    provider: "private-browser",
    alwaysAllowComputerActions: true,
  });
  assert.deepEqual(enabled.value.status, {
    provider: "private-browser",
    available: true,
    permissions: {
      provider: "private-browser",
      alwaysAllowComputerActions: true,
    },
  });
  assert.deepEqual(updates, [
    {
      next: true,
      acknowledged: true,
      provider: "private-browser",
    },
  ]);

  const status = await request("/api/codex/status");
  assert.equal(
    status.value.privateComputer.permissions.alwaysAllowComputerActions,
    true,
  );

  for (const body of [
    {
      action: "permissions",
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: true,
      acknowledged: true,
    },
    {
      action: "permissions",
      provider: "private-browser",
      alwaysAllowComputerActions: "true",
      acknowledged: true,
    },
    {
      action: "permissions",
      provider: "private-browser",
      alwaysAllowComputerActions: true,
      acknowledged: true,
      unexpected: true,
    },
  ])
    assert.equal(
      (await request("/api/private-computer", { body })).status,
      400,
    );
  assert.equal(updates.length, 1);
});

test("helper results are allowlisted before anything reaches the renderer", async () => {
  const loginUrl =
    "https://cursor.com/loginDeepControl?challenge=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&uuid=123e4567-e89b-42d3-a456-426614174000&mode=login&redirectTarget=sand";
  official.status = async () => ({
    ...safeStatus("official"),
    retrying: true,
    retryAfterMs: 2500.2,
    retryAttempt: 2,
    retryStage: "viewer",
    accessToken: SECRET_SENTINEL,
    networkToken: SECRET_SENTINEL,
    vncUrl: `https://example.invalid/vnc.html?network_token=${SECRET_SENTINEL}`,
    lastError: `Viewer failed at https://example.invalid/vnc.html?network_token=${SECRET_SENTINEL}`,
  });
  official.startLogin = async () => ({
    loginUrl,
    state: "signing-in",
    refreshToken: SECRET_SENTINEL,
  });
  official.captureSeat = async () => ({
    screenshotBase64: "/9j/AAAAAAAAAP/Z",
    mimeType: "image/jpeg",
    frameSequence: 19,
    width: 1280,
    height: 800,
    cursorPosition: { x: 4, y: 5 },
    url: `https://example.invalid/vnc.html?network_token=${SECRET_SENTINEL}`,
    title: SECRET_SENTINEL,
    pageState: "loaded",
    profileId: SECRET_SENTINEL,
    provider: "official",
    generation: 7,
    networkToken: SECRET_SENTINEL,
    vncUrl: `https://example.invalid/vnc.html?network_token=${SECRET_SENTINEL}`,
  });
  official.executeSeatActions = async () => ({
    url: `https://example.invalid/vnc.html?network_token=${SECRET_SENTINEL}`,
    title: SECRET_SENTINEL,
    pageState: "loaded",
    profileId: SECRET_SENTINEL,
  });

  const status = await request("/api/codex/status");
  assert.equal(status.status, 200);
  assert.equal(status.text.includes(SECRET_SENTINEL), false);
  assert.equal(
    Object.hasOwn(status.value.officialComputer, "networkToken"),
    false,
  );
  assert.equal(Object.hasOwn(status.value.officialComputer, "vncUrl"), false);
  assert.equal(
    Object.hasOwn(status.value.officialComputer, "accessToken"),
    false,
  );
  assert.equal(status.value.officialComputer.retrying, true);
  assert.equal(status.value.officialComputer.retryAfterMs, 2501);
  assert.equal(status.value.officialComputer.retryAttempt, 2);
  assert.equal(status.value.officialComputer.retryStage, "viewer");

  const login = await request("/api/official-computer", {
    body: { action: "login" },
  });
  assert.equal(login.status, 200);
  assert.equal(login.value.result.loginUrl, loginUrl);
  assert.equal(login.text.includes(SECRET_SENTINEL), false);
  assert.deepEqual(Object.keys(login.value.result).sort(), [
    "loginUrl",
    "state",
  ]);
  assert.deepEqual(openedOfficialLogins, [loginUrl]);

  const frame = await request("/api/frame?seatKey=employee-a");
  assert.equal(frame.status, 200);
  assert.equal(frame.text.includes(SECRET_SENTINEL), false);
  assert.equal(Object.hasOwn(frame.value, "networkToken"), false);
  assert.equal(Object.hasOwn(frame.value, "vncUrl"), false);
  assert.equal(frame.value.url, "official-computer://shared-primary");
  assert.equal(frame.value.title, "Official vendor cloud computer");
  assert.equal(frame.value.profileId, "official-cloud-primary");
  assert.equal(frame.value.mimeType, "image/jpeg");
  assert.equal(frame.value.frameSequence, 19);

  const input = await request("/api/input", {
    body: {
      seatKey: "employee-a",
      actions: [{ kind: "wait", durationMs: 1 }],
      controlId: "control-a",
    },
  });
  assert.equal(input.status, 200);
  assert.equal(input.text.includes(SECRET_SENTINEL), false);
  assert.equal(input.value.url, "official-computer://shared-primary");
  assert.equal(input.value.title, "Official vendor cloud computer");
  assert.equal(input.value.profileId, "official-cloud-primary");
});

test("approval routes expose only the exact safe frame and echo its displayed binding", async () => {
  const sha256 = crypto
    .createHash("sha256")
    .update(Buffer.from(PNG_BASE64, "base64"))
    .digest("hex");
  let receivedDecision = null;
  official.status = async () => safeStatus("official");
  official.pendingApprovalForSeat = async () => ({
    requestId: "approval-request-1",
    seatId: "employee-a",
    origin: "https://official-cloud-computer.invalid",
    actionDigest: "action-digest-1",
    riskClass: "confirmation",
    summary: "Click the current page",
    presentation: { actions: [{ kind: "click" }] },
    expiresAt: Date.now() + 30_000,
    siteLeaseAvailable: false,
    frame: {
      generation: 7,
      sequence: 3,
      sha256,
      screenshotBase64: PNG_BASE64,
      networkToken: SECRET_SENTINEL,
    },
    networkToken: SECRET_SENTINEL,
  });
  official.decidePendingApproval = async (seatKey, decision, binding) => {
    receivedDecision = { seatKey, decision, binding };
    return true;
  };

  const approval = await request("/api/approval?seatKey=employee-a");
  assert.equal(approval.status, 200);
  assert.equal(approval.text.includes(SECRET_SENTINEL), false);
  assert.deepEqual(approval.value.pending.frame, {
    generation: 7,
    sequence: 3,
    sha256,
    screenshotBase64: PNG_BASE64,
    mimeType: "image/png",
  });

  const binding = {
    requestId: approval.value.pending.requestId,
    seatId: approval.value.pending.seatId,
    origin: approval.value.pending.origin,
    actionDigest: approval.value.pending.actionDigest,
    presentedFrame: { generation: 7, sequence: 3, sha256 },
  };
  const decision = await request("/api/approval", {
    body: { seatKey: "employee-a", decision: "allow-once", binding },
  });
  assert.equal(decision.status, 200);
  assert.deepEqual(receivedDecision, {
    seatKey: "employee-a",
    decision: "allow-once",
    binding,
  });
  assert.deepEqual(decision.value, { ok: true });

  official.pendingApprovals = async () => [
    {
      requestId: "approval-request-list-1",
      seatId: "group-member-a",
      origin: "https://official-cloud-computer.invalid",
      actionDigest: "action-digest-list-1",
      riskClass: "confirmation",
      summary: "Navigate to another page",
      presentation: { actions: [{ kind: "navigate" }] },
      expiresAt: Date.now() + 30_000,
      frame: {
        generation: 7,
        sequence: 5,
        sha256,
        screenshotBase64: PNG_BASE64,
        networkToken: SECRET_SENTINEL,
      },
      networkToken: SECRET_SENTINEL,
    },
  ];
  const approvalList = await request("/api/approvals");
  assert.equal(approvalList.status, 200);
  assert.equal(approvalList.text.includes(SECRET_SENTINEL), false);
  assert.equal(approvalList.value.pending.length, 1);
  assert.equal(approvalList.value.pending[0].seatId, "group-member-a");
  assert.deepEqual(approvalList.value.pending[0].frame, {
    generation: 7,
    sequence: 5,
    sha256,
    screenshotBase64: PNG_BASE64,
    mimeType: "image/png",
  });

  official.decidePendingApproval = async () => ({
    accepted: true,
    injectedSecret: SECRET_SENTINEL,
  });
  const malformedDecision = await request("/api/approval", {
    body: { seatKey: "employee-a", decision: "deny", binding },
  });
  assert.equal(malformedDecision.status, 409);
  assert.equal(malformedDecision.text.includes(SECRET_SENTINEL), false);
  assert.deepEqual(malformedDecision.value, { ok: false });

  official.pendingApprovalForSeat = async () => ({
    requestId: "approval-request-2",
    seatId: "employee-a",
    origin: "https://official-cloud-computer.invalid",
    actionDigest: "action-digest-2",
    riskClass: "confirmation",
    summary: "Click the current page",
    presentation: { actions: [{ kind: "click" }] },
    expiresAt: Date.now() + 30_000,
    frame: {
      generation: 7,
      sequence: 4,
      sha256: "b".repeat(64),
      screenshotBase64: PNG_BASE64,
    },
  });
  const malformed = await request("/api/approval?seatKey=employee-a");
  assert.equal(malformed.status, 502);
});

test("helper failure cannot route work or cleanup through the private provider", async () => {
  let privateEnsureCalls = 0;
  let privateCloseCalls = 0;
  official.status = async () => {
    const error = new Error("The official-computer helper stopped.");
    error.code = "HELPER_EXITED";
    error.statusCode = 503;
    throw error;
  };
  privateManager.ensureSeat = async () => {
    privateEnsureCalls += 1;
    return true;
  };
  await assert.rejects(
    bridge.manager.ensureSeat("employee-a"),
    /official-computer helper stopped/i,
  );
  assert.equal(privateEnsureCalls, 0);

  official.status = async () => safeStatus("official");
  official.closeSeatForKey = async () => {
    const error = new Error("Official cleanup failed.");
    error.statusCode = 503;
    throw error;
  };
  privateManager.closeSeatForKey = async () => {
    privateCloseCalls += 1;
    return true;
  };
  await assert.rejects(
    bridge.manager.closeSeatForKey("employee-a", "test"),
    /Official cleanup failed/i,
  );
  assert.equal(privateCloseCalls, 0);
});

test("provider transitions fence active input and route each action only to its selected provider", async () => {
  let mode = "official";
  let officialActionCalls = 0;
  let privateActionCalls = 0;
  const officialActionStarted = deferred();
  const releaseOfficialAction = deferred();

  official.status = async () => safeStatus(mode);
  official.setMode = async (nextMode) => {
    mode = nextMode;
    return safeStatus(mode);
  };
  official.executeSeatActions = async () => {
    officialActionCalls += 1;
    officialActionStarted.resolve();
    await releaseOfficialAction.promise;
    return { pageState: "loaded" };
  };
  privateManager.executeSeatActions = async () => {
    privateActionCalls += 1;
    return {
      url: "https://private.example.test/after-switch",
      title: "Private provider",
      pageState: "loaded",
      profileId: "private-profile",
      activeSeatCount: 1,
    };
  };

  const activeInput = request("/api/input", {
    body: {
      seatKey: "employee-transition",
      actions: [{ kind: "wait", durationMs: 1 }],
      controlId: "control-transition",
    },
  });
  await officialActionStarted.promise;

  const blockedSwitch = await request("/api/official-computer", {
    body: { action: "mode", mode: "private" },
  });
  assert.equal(blockedSwitch.status, 409);
  assert.match(
    blockedSwitch.value.error,
    /finish or deny the current computer action/i,
  );
  assert.equal(mode, "official");
  assert.equal(officialActionCalls, 1);
  assert.equal(privateActionCalls, 0);

  releaseOfficialAction.resolve();
  const firstInput = await activeInput;
  assert.equal(firstInput.status, 200);
  assert.equal(officialActionCalls, 1);
  assert.equal(privateActionCalls, 0);

  const completedSwitch = await request("/api/official-computer", {
    body: { action: "mode", mode: "private" },
  });
  assert.equal(completedSwitch.status, 200);
  assert.equal(mode, "private");

  const secondInput = await request("/api/input", {
    body: {
      seatKey: "employee-transition",
      actions: [{ kind: "wait", durationMs: 1 }],
      controlId: "control-transition",
    },
  });
  assert.equal(secondInput.status, 200);
  assert.equal(secondInput.value.url, "https://private.example.test");
  assert.equal(officialActionCalls, 1);
  assert.equal(privateActionCalls, 1);
});

test("provider epoch rejects a stale read before either provider action executes", async () => {
  let mode = "official";
  let officialCaptureCalls = 0;
  let privateCaptureCalls = 0;
  let holdFirstStatus = true;
  const providerSelectionStarted = deferred();
  const releaseStaleStatus = deferred();

  official.status = async () => {
    if (holdFirstStatus) {
      holdFirstStatus = false;
      providerSelectionStarted.resolve();
      return releaseStaleStatus.promise;
    }
    return safeStatus(mode);
  };
  official.setMode = async (nextMode) => {
    mode = nextMode;
    return safeStatus(mode);
  };
  official.captureSeat = async () => {
    officialCaptureCalls += 1;
    throw new Error("A stale official capture must not execute.");
  };
  privateManager.captureSeat = async () => {
    privateCaptureCalls += 1;
    return {
      screenshotBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Wl7sAAAAASUVORK5CYII=",
      cursorPosition: { x: 0, y: 0 },
      url: "https://private.example.test/fresh-frame",
      title: "Fresh private frame",
      pageState: "loaded",
      profileId: "private-profile",
      activeSeatCount: 1,
    };
  };

  const staleFrame = request("/api/frame?seatKey=employee-epoch");
  await providerSelectionStarted.promise;

  const switched = await request("/api/official-computer", {
    body: { action: "mode", mode: "private" },
  });
  assert.equal(switched.status, 200);
  assert.equal(mode, "private");

  releaseStaleStatus.resolve(safeStatus("official"));
  const rejectedFrame = await staleFrame;
  assert.equal(rejectedFrame.status, 409);
  assert.match(rejectedFrame.value.error, /provider changed/i);
  assert.equal(officialCaptureCalls, 0);
  assert.equal(privateCaptureCalls, 0);

  const freshFrame = await request("/api/frame?seatKey=employee-epoch");
  assert.equal(freshFrame.status, 200);
  assert.equal(freshFrame.value.url, "https://private.example.test");
  assert.equal(officialCaptureCalls, 0);
  assert.equal(privateCaptureCalls, 1);
});

test("group-task endpoint exposes only the active group task and clears it", async () => {
  const task = bridge.groupTaskTracker.begin({
    groupId: "group-bridge",
    groupName: "Release crew",
    summary: "Verify the release together.",
    members: [{ id: "scout", name: "Scout" }],
  });
  bridge.groupTaskTracker.updateMember(
    "group-bridge",
    task.id,
    "scout",
    "working",
  );
  const loaded = await request("/api/group-tasks?groupId=group-bridge");
  assert.equal(loaded.status, 200);
  assert.equal(loaded.value.task.id, task.id);
  assert.equal(loaded.value.task.groupId, "group-bridge");
  assert.equal(loaded.value.task.summary, "Verify the release together.");
  assert.deepEqual(
    loaded.value.task.members.map((member) => member.status),
    ["working"],
  );
  assert.equal(
    (await request("/api/group-tasks?groupId=group-bridge&extra=1")).status,
    400,
  );
  const cleared = await request("/api/group-tasks", {
    body: { action: "clear", groupId: "group-bridge" },
  });
  assert.deepEqual(cleared.value, { ok: true });
  assert.equal(
    (await request("/api/group-tasks?groupId=group-bridge")).value.task,
    null,
  );
});

test("installer and runtime preflight include the complete official-computer helper", () => {
  const installer = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  const installScript = fs.readFileSync(
    path.join(root, "scripts", "Install-CodexBot.ps1"),
    "utf8",
  );
  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const file of [
    "group-task-tracker.cjs",
    "official-computer-client.cjs",
    "official-computer-helper.cjs",
  ]) {
    assert.match(
      installer,
      new RegExp(
        `Source: "\\.\\.\\\\src\\\\${file.replaceAll(".", "\\.")}"; DestDir: "\\{app\\}\\\\tools\\\\src"; Flags: ignoreversion`,
        "i",
      ),
    );
    assert.match(installScript, new RegExp(file.replaceAll(".", "\\."), "i"));
  }
  assert.match(installer, /Source: "\.\.\\node_modules\\\*"/i);
  assert.match(
    installScript,
    /node_modules[\\/]@novnc[\\/]novnc[\\/]package\.json/i,
  );
  assert.match(installScript, /node_modules[\\/]ws[\\/]package\.json/i);
  assert.equal(packageManifest.dependencies["@novnc/novnc"], "1.7.0");
  assert.equal(packageManifest.dependencies.ws, "8.21.3");
});
