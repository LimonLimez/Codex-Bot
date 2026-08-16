"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const controllerPath = path.join(__dirname, "..", "src", "desktop", "codex-account-controller.cjs");

let CodexAccountController;
try {
  ({ CodexAccountController } = require(controllerPath));
} catch {
  // The first RED intentionally runs before production exists.
}

class FakeManager extends EventEmitter {
  constructor(responders = {}) {
    super();
    this.responders = responders;
    this.calls = [];
    this.starts = 0;
    this.stops = 0;
  }

  async start() {
    this.starts += 1;
  }

  request(method, params) {
    this.calls.push({ method, params });
    const responder = this.responders[method];
    if (typeof responder !== "function") throw new Error(`unexpected ${method}`);
    return Promise.resolve().then(() => responder(params, this.calls));
  }

  stop() {
    this.stops += 1;
  }
}

function model({
  id,
  efforts,
  defaultEffort = efforts[0],
  defaultServiceTier = null,
  serviceTiers = [],
  displayName = id,
  hidden = false,
  isDefault = false,
  modalities = ["text", "image"],
} = {}) {
  return {
    id,
    model: id,
    displayName,
    hidden,
    defaultReasoningEffort: defaultEffort,
    defaultServiceTier,
    serviceTiers: serviceTiers.map(({ id: tierId, name, description }) => ({
      id: tierId,
      name,
      description,
    })),
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} description`,
    })),
    inputModalities: modalities,
    supportsPersonality: true,
    isDefault,
    providerDiagnostic: "private provider stack",
  };
}

function readyManager(overrides = {}) {
  const pages = new Map([
    [null, {
      data: [
        model({
          id: "gpt-live-sol",
          efforts: ["low", "medium", "high", "ultra"],
          isDefault: true,
          defaultServiceTier: "priority",
          serviceTiers: [
            { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
            { id: "ultrafast", name: "Ultra fast", description: "Fastest available speed" },
          ],
        }),
        model({ id: "hidden-private", efforts: ["low"], hidden: true }),
      ],
      nextCursor: "page-two",
    }],
    ["page-two", {
      data: [
        model({ id: "gpt-live-terra", efforts: ["low", "medium", "max", "ultra"], displayName: "Live Terra" }),
        model({ id: "gpt-live-sol", efforts: ["low"], displayName: "duplicate must lose" }),
      ],
      nextCursor: null,
    }],
  ]);
  return new FakeManager({
    "account/read": () => ({
      account: {
        type: "chatgpt",
        email: "private@example.com",
        planType: "pro",
        accountId: "acct-private",
        accessToken: "private-token",
      },
      requiresOpenaiAuth: true,
    }),
    "account/rateLimits/read": () => ({
      rateLimits: {
        limitId: "codex-private-bucket",
        limitName: "private workspace",
        primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_780_000_000 },
        secondary: null,
        rateLimitReachedType: null,
        credits: { balance: "private" },
      },
      rateLimitsByLimitId: { private: { providerDiagnostic: "private" } },
    }),
    "model/list": ({ cursor }) => pages.get(cursor ?? null),
    ...overrides,
  });
}

test("starts one direct account flight and publishes only frozen sanitized account rate-limit and paginated catalog state", async () => {
  const manager = readyManager();
  const controller = new CodexAccountController({ manager });
  const accountEvents = [];
  const catalogEvents = [];
  controller.on("account-changed", (value) => accountEvents.push(value));
  controller.on("catalog-changed", (value) => catalogEvents.push(value));
  const first = controller.start();
  const second = controller.start();
  assert.equal(first, second);
  await first;
  assert.equal(manager.starts, 1);
  assert.deepEqual(manager.calls, [
    { method: "account/read", params: { refreshToken: false } },
    { method: "account/rateLimits/read", params: undefined },
    { method: "model/list", params: { cursor: null, limit: 100, includeHidden: false } },
    { method: "model/list", params: { cursor: "page-two", limit: 100, includeHidden: false } },
  ]);
  assert.deepEqual(controller.accountState(), {
    generation: 1,
    status: "ready",
    authMode: "chatgpt",
    planType: "pro",
    requiresOpenaiAuth: true,
    login: null,
    rateLimits: {
      primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_780_000_000 },
      secondary: null,
      reachedType: null,
    },
  });
  assert.deepEqual(controller.catalogState(), {
    generation: 1,
    status: "ready",
    models: [
      {
        id: "gpt-live-sol",
        displayName: "gpt-live-sol",
        defaultReasoningEffort: "low",
        defaultServiceTier: "priority",
        serviceTiers: [
          { id: "priority", name: "Fast", description: "1.5x speed, increased usage" },
          { id: "ultrafast", name: "Ultra fast", description: "Fastest available speed" },
        ],
        supportedReasoningEfforts: ["low", "medium", "high", "ultra"],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        isDefault: true,
      },
      {
        id: "gpt-live-terra",
        displayName: "Live Terra",
        defaultReasoningEffort: "low",
        defaultServiceTier: null,
        serviceTiers: [],
        supportedReasoningEfforts: ["low", "medium", "max", "ultra"],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        isDefault: false,
      },
    ],
  });
  assert.equal(Object.isFrozen(controller.accountState()), true);
  assert.equal(Object.isFrozen(controller.catalogState().models[0].supportedReasoningEfforts), true);
  assert.equal(Object.isFrozen(controller.catalogState().models[0].serviceTiers), true);
  assert.equal(Object.isFrozen(controller.catalogState().models[0].serviceTiers[0]), true);
  assert.equal(accountEvents.length, 1);
  assert.equal(catalogEvents.length, 1);
  assert.doesNotMatch(JSON.stringify({ accountEvents, catalogEvents }), /private@example|acct-private|accessToken|private-token|providerDiagnostic|limitId|limitName/);
});

test("browser login keeps its credential-bearing URL private while device login publishes only current validated ceremony data", async () => {
  const loginResults = [
    {
      type: "chatgpt",
      loginId: "11111111-1111-4111-8111-111111111111",
      authUrl: "https://chatgpt.com/auth/codex?state=private-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
    },
    {
      type: "chatgptDeviceCode",
      loginId: "22222222-2222-4222-8222-222222222222",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    },
  ];
  const manager = readyManager({
    "account/login/start": () => loginResults.shift(),
    "account/login/cancel": () => ({}),
  });
  const controller = new CodexAccountController({ manager });
  await controller.start();
  const browser = await controller.login("browser");
  assert.deepEqual(Object.keys(browser), ["state"]);
  assert.equal(browser.openUrl.startsWith("https://chatgpt.com/auth/codex?"), true);
  assert.equal(Object.getOwnPropertyDescriptor(browser, "openUrl").enumerable, false);
  assert.deepEqual(browser.state.login, { mode: "browser" });
  assert.doesNotMatch(JSON.stringify(browser), /state=|redirect_uri|loginId|private-state/);
  await controller.cancelLogin();

  const device = await controller.login("device-code");
  assert.equal(device.openUrl, undefined);
  assert.deepEqual(device.state.login, {
    mode: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  });
  assert.doesNotMatch(JSON.stringify(device), /loginId|22222222|accessToken|email/);
});

test("a fresh private Codex home can sign in from signed-out state and refresh the official catalog", async () => {
  const loginId = "33333333-3333-4333-8333-333333333333";
  let accountReads = 0;
  const manager = readyManager({
    "account/read": () => {
      accountReads += 1;
      return accountReads === 1
        ? { account: null, requiresOpenaiAuth: true }
        : {
            account: { type: "chatgpt", planType: "pro" },
            requiresOpenaiAuth: true,
          };
    },
    "account/login/start": () => ({
      type: "chatgpt",
      loginId,
      authUrl: "https://chatgpt.com/auth/codex?state=private-state",
    }),
  });
  const controller = new CodexAccountController({ manager });
  await controller.start();
  assert.equal(controller.accountState().status, "signed-out");
  assert.equal(controller.accountState().authMode, null);
  assert.equal(controller.catalogState().status, "ready");

  const login = await controller.login("browser");
  assert.equal(login.state.status, "signing-in");
  assert.equal(login.state.login.mode, "browser");
  manager.emit("notification", {
    method: "account/login/completed",
    params: { loginId, success: true, error: null },
  });
  for (let attempt = 0; attempt < 10 && controller.accountState().status !== "ready"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.accountState().status, "ready");
  assert.equal(controller.accountState().authMode, "chatgpt");
  assert.equal(controller.accountState().planType, "pro");
  assert.equal(controller.accountState().login, null);
  assert.equal(controller.catalogState().status, "ready");
  assert.equal(controller.catalogState().generation, 2);
  assert.equal(accountReads, 2);
  assert.equal(manager.starts, 1);
  assert.doesNotMatch(JSON.stringify({
    account: controller.accountState(),
    catalog: controller.catalogState(),
  }), /private-state|loginId|accessToken|email/);
});

test("login completion cancel and replacement are generation scoped so stale notifications cannot overwrite the current ceremony", async () => {
  const loginResults = [
    {
      type: "chatgptDeviceCode",
      loginId: "11111111-1111-4111-8111-111111111111",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "OLD1-CODE",
    },
    {
      type: "chatgptDeviceCode",
      loginId: "22222222-2222-4222-8222-222222222222",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "NEW2-CODE",
    },
  ];
  const manager = readyManager({
    "account/login/start": () => loginResults.shift(),
    "account/login/cancel": () => ({}),
  });
  const controller = new CodexAccountController({ manager });
  await controller.start();
  await controller.login("device-code");
  await controller.cancelLogin();
  const current = await controller.login("device-code");
  assert.equal(current.state.login.userCode, "NEW2-CODE");
  manager.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "11111111-1111-4111-8111-111111111111", success: true, error: null },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.accountState().login.userCode, "NEW2-CODE");
  manager.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "22222222-2222-4222-8222-222222222222", success: false, error: "private OAuth stack" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.accountState().login, null);
  assert.equal(controller.accountState().status, "signed-out");
  assert.doesNotMatch(JSON.stringify(controller.accountState()), /OAuth|private|error/);
});

test("account logout and notifications update only sanitized public state while catalog notifications refresh once", async () => {
  let catalogReads = 0;
  const manager = readyManager({
    "account/logout": () => ({}),
    "model/list": () => {
      catalogReads += 1;
      return {
        data: [model({ id: `dynamic-model-${catalogReads}`, efforts: ["low", "medium"] })],
        nextCursor: null,
      };
    },
  });
  const controller = new CodexAccountController({ manager });
  await controller.start();
  await controller.logout();
  assert.deepEqual(manager.calls.at(-1), { method: "account/logout", params: undefined });
  assert.equal(controller.accountState().status, "signed-out");
  assert.equal(controller.accountState().authMode, null);
  manager.emit("notification", {
    method: "account/updated",
    params: { authMode: "chatgpt", planType: "plus", email: "private@example.com" },
  });
  manager.emit("notification", {
    method: "account/rateLimits/updated",
    params: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 } } },
  });
  manager.emit("notification", { method: "model/list/updated", params: { providerDiagnostic: "private" } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.accountState().authMode, "chatgpt");
  assert.equal(controller.accountState().planType, "plus");
  assert.equal(controller.accountState().rateLimits.primary.usedPercent, 42);
  assert.equal(controller.catalogState().models[0].id, "dynamic-model-2");
  assert.equal(catalogReads, 2);
  assert.doesNotMatch(JSON.stringify(controller.accountState()), /email|private@example|providerDiagnostic/);
});

test("rejects malformed account login catalog pagination and capability payloads without inventing a fallback model", async (t) => {
  await t.test("malformed login URL", async () => {
    const manager = readyManager({
      "account/login/start": () => ({
        type: "chatgpt",
        loginId: "11111111-1111-4111-8111-111111111111",
        authUrl: "file:///Users/person/.codex/auth.json",
      }),
    });
    const controller = new CodexAccountController({ manager });
    await controller.start();
    await assert.rejects(controller.login("browser"), { code: "CODEX_LOGIN_INVALID" });
    assert.equal(controller.accountState().login, null);
  });

  await t.test("cyclic pagination", async () => {
    const manager = readyManager({
      "model/list": () => ({ data: [], nextCursor: "same" }),
    });
    const controller = new CodexAccountController({ manager });
    await assert.rejects(controller.start(), { code: "CODEX_CATALOG_INVALID" });
    assert.deepEqual(controller.catalogState().models, []);
    assert.equal(controller.catalogState().status, "unavailable");
  });

  await t.test("malformed model", async () => {
    const manager = readyManager({
      "model/list": () => ({
        data: [{
          id: "malformed-model",
          model: "malformed-model",
          displayName: "Malformed",
          hidden: false,
          defaultReasoningEffort: "ultra",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        }],
        nextCursor: null,
      }),
    });
    const controller = new CodexAccountController({ manager });
    await assert.rejects(controller.start(), { code: "CODEX_CATALOG_INVALID" });
    assert.deepEqual(controller.catalogState().models, []);
  });

  await t.test("malformed or duplicate service tiers", async () => {
    for (const invalid of [
      model({
        id: "bad-default-tier",
        efforts: ["low"],
        defaultServiceTier: "missing",
        serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
      }),
      model({
        id: "duplicate-tier",
        efforts: ["low"],
        defaultServiceTier: "priority",
        serviceTiers: [
          { id: "priority", name: "Fast", description: "Fast" },
          { id: "priority", name: "Duplicate", description: "Duplicate" },
        ],
      }),
    ]) {
      const manager = readyManager({
        "model/list": () => ({ data: [invalid], nextCursor: null }),
      });
      const controller = new CodexAccountController({ manager });
      await assert.rejects(controller.start(), { code: "CODEX_CATALOG_INVALID" });
    }
  });
});

test("manager offline and listener failures are isolated and dispose detaches every observer", async () => {
  const manager = readyManager();
  const controller = new CodexAccountController({ manager });
  controller.on("account-changed", () => { throw new Error("private listener"); });
  controller.on("catalog-changed", async () => { throw new Error("private async listener"); });
  await controller.start();
  manager.emit("offline", Object.assign(new Error("private /Users/person token"), { code: "PRIVATE" }));
  assert.equal(controller.accountState().status, "offline");
  assert.equal(controller.catalogState().status, "unavailable");
  assert.doesNotMatch(JSON.stringify(controller.accountState()), /private|Users|token|PRIVATE/);
  controller.dispose();
  assert.equal(manager.listenerCount("notification"), 0);
  assert.equal(manager.listenerCount("ready"), 0);
  assert.equal(manager.listenerCount("offline"), 0);
  assert.equal(manager.stops, 0, "the desktop runtime owns manager shutdown");
  await assert.rejects(controller.start(), { code: "CODEX_ACCOUNT_DISPOSED" });
});

test("logout supersedes an in-flight login response and cancels the late server ceremony without public resurrection", async () => {
  let releaseLogin;
  const manager = readyManager({
    "account/login/start": () => new Promise((resolve) => { releaseLogin = resolve; }),
    "account/login/cancel": () => ({}),
    "account/logout": () => ({}),
  });
  const controller = new CodexAccountController({ manager });
  await controller.start();
  const login = controller.login("browser");
  await new Promise((resolve) => setImmediate(resolve));
  await controller.logout();
  releaseLogin({
    type: "chatgpt",
    loginId: "33333333-3333-4333-8333-333333333333",
    authUrl: "https://chatgpt.com/auth/codex?state=late-private-state",
  });
  await assert.rejects(login, { code: "CODEX_LOGIN_SUPERSEDED" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.accountState().status, "signed-out");
  assert.equal(controller.accountState().login, null);
  assert.deepEqual(manager.calls.at(-1), {
    method: "account/login/cancel",
    params: { loginId: "33333333-3333-4333-8333-333333333333" },
  });
  assert.doesNotMatch(JSON.stringify(controller.accountState()), /late-private|33333333/);
});

test("dispose fences a paginated catalog continuation so it cannot publish or complete startup", async () => {
  let releaseSecondPage;
  const manager = readyManager({
    "model/list": ({ cursor }) => cursor === null
      ? {
        data: [model({ id: "first-before-dispose", efforts: ["low"] })],
        nextCursor: "held-page",
      }
      : new Promise((resolve) => { releaseSecondPage = resolve; }),
  });
  const controller = new CodexAccountController({ manager });
  const catalogEvents = [];
  controller.on("catalog-changed", (value) => catalogEvents.push(value));
  const starting = controller.start();
  while (typeof releaseSecondPage !== "function") {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.dispose();
  releaseSecondPage({
    data: [model({ id: "late-after-dispose", efforts: ["low"] })],
    nextCursor: null,
  });
  await assert.rejects(starting, { code: "CODEX_ACCOUNT_DISPOSED" });
  assert.deepEqual(catalogEvents, []);
  assert.deepEqual(controller.catalogState(), { generation: 0, status: "loading", models: [] });
});

test("a failed startup releases the pending login slot so a later direct-account retry can succeed", async () => {
  const manager = readyManager({
    "account/login/start": () => ({
      type: "chatgpt",
      loginId: "44444444-4444-4444-8444-444444444444",
      authUrl: "https://chatgpt.com/auth/codex?state=current-private-state",
    }),
  });
  let startAttempt = 0;
  manager.start = async () => {
    startAttempt += 1;
    if (startAttempt === 1) throw new Error("private startup path");
  };
  const controller = new CodexAccountController({ manager });
  await assert.rejects(controller.login("browser"), { code: "CODEX_ACCOUNT_UNAVAILABLE" });
  const retry = await controller.login("browser");
  assert.equal(retry.state.status, "signing-in");
  assert.equal(retry.openUrl.startsWith("https://chatgpt.com/"), true);
  assert.doesNotMatch(JSON.stringify(retry), /current-private|chatgpt\.com|startup path/);
});
