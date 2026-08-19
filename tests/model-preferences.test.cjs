"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const connectionPath = path.join(root, "src", "codex-connection.cjs");
const bridgePath = path.join(root, "src", "browser-seat-bridge.cjs");
const connectionStateKey = Symbol.for("codexbot.connection.state");
const viewServerKey = Symbol.for("codexbot.browserSeatViewServer");
const envNames = [
  "CODEX_BOT_STATE_ROOT",
  "GROK_BOT_CODEX_AUTH_DIR",
  "GROK_BOT_CLIPROXY_MODEL",
  "GROK_BOT_REASONING_EFFORT",
  "GROK_BOT_FAST_MODE",
  "GROK_BOT_CLIPROXY_KEY",
  "GROK_BOT_BROWSER_VIEW_PORT",
  "GROK_BOT_BROWSER_VIEW_TOKEN",
];

function isolatedEnvironment(t, overrides = {}) {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-preferences-"),
  );
  const previous = Object.fromEntries(
    envNames.map((name) => [name, process.env[name]]),
  );
  fs.mkdirSync(path.join(stateRoot, "auth"), { recursive: true });
  Object.assign(process.env, {
    CODEX_BOT_STATE_ROOT: stateRoot,
    GROK_BOT_CODEX_AUTH_DIR: path.join(stateRoot, "auth"),
    GROK_BOT_CLIPROXY_MODEL: "gpt-5.6-terra",
    GROK_BOT_REASONING_EFFORT: "high",
    GROK_BOT_FAST_MODE: "false",
    GROK_BOT_CLIPROXY_KEY: "test-proxy-key-that-must-never-be-public",
    ...overrides,
  });
  t.after(() => {
    for (const name of envNames) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
    delete require.cache[require.resolve(connectionPath)];
    globalThis[connectionStateKey] = null;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  return stateRoot;
}

function loadConnection() {
  delete require.cache[require.resolve(connectionPath)];
  globalThis[connectionStateKey] = null;
  return require(connectionPath);
}

function writeConnectionConfig(stateRoot, value) {
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "connection.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

test("legacy preferences migrate, persisted defaults beat bootstrap environment, and unrelated state survives", (t) => {
  const stateRoot = isolatedEnvironment(t, {
    GROK_BOT_CLIPROXY_MODEL: "gpt-5.6-sol",
    GROK_BOT_REASONING_EFFORT: "low",
    GROK_BOT_FAST_MODE: "true",
  });
  writeConnectionConfig(stateRoot, {
    mode: "codex-oauth",
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    protectedApiKey: `PROTECTED-${"KEY"}-SENTINEL`,
    oauthState: { installation: "keep-me" },
    futureConnectionField: { also: "keep-me" },
  });
  let connection = loadConnection();

  assert.deepEqual(connection.getPreferences(), {
    agentId: null,
    provider: "codex",
    defaults: {
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      fastMode: true,
    },
    override: null,
    effective: {
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      fastMode: true,
    },
  });

  connection.setDefaultPreferences({ reasoningEffort: "max", fastMode: false });
  const persisted = JSON.parse(
    fs.readFileSync(path.join(stateRoot, "connection.json"), "utf8"),
  );
  assert.equal(persisted.mode, "codex-oauth");
  assert.equal(persisted.protectedApiKey, "PROTECTED-KEY-SENTINEL");
  assert.deepEqual(persisted.oauthState, { installation: "keep-me" });
  assert.deepEqual(persisted.futureConnectionField, { also: "keep-me" });
  assert.deepEqual(persisted.defaults, {
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    fastMode: false,
  });
  assert.equal(persisted.model, "gpt-5.6-luna");
  assert.equal(persisted.reasoningEffort, "max");
  assert.equal(persisted.fastMode, false);

  // Simulate the launcher continuing to export its bootstrap values on the
  // next process start. Stored choices must remain authoritative.
  connection = loadConnection();
  assert.deepEqual(connection.getConnection(), {
    mode: "cliproxy-oauth",
    route: "cliproxyapi-codex-oauth",
    provider: "codex",
    providerLabel: "OpenAI Codex",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: `test-${"proxy-key"}-that-must-never-be-public`,
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
    fastMode: false,
  });
});

test("canonical provider preference entries win over stale Windows aliases", (t) => {
  const stateRoot = isolatedEnvironment(t);
  writeConnectionConfig(stateRoot, {
    mode: "codex-oauth",
    provider: "openai-codex",
    providerPreferences: {
      "openai-codex": {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        fastMode: false,
      },
      codex: {
        model: "gpt-5.6-luna",
        reasoningEffort: "none",
        fastMode: true,
      },
    },
    providerAgentPreferences: {
      "openai-codex": {
        "agent-1": { model: "gpt-5.6-sol" },
      },
      codex: {
        "agent-1": { model: "gpt-5.6-luna" },
      },
    },
  });
  const connection = loadConnection();

  assert.deepEqual(connection.getPreferences("agent-1"), {
    agentId: "agent-1",
    provider: "codex",
    defaults: {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: false,
    },
    override: { model: "gpt-5.6-sol" },
    effective: {
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      fastMode: false,
    },
  });

  connection.setDefaultPreferences({ reasoningEffort: "max" });
  const persisted = JSON.parse(
    fs.readFileSync(path.join(stateRoot, "connection.json"), "utf8"),
  );
  assert.deepEqual(persisted.providerPreferences["openai-codex"], {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    fastMode: false,
  });
  assert.deepEqual(persisted.providerAgentPreferences["openai-codex"], {
    "agent-1": { model: "gpt-5.6-sol" },
  });
  assert.equal(persisted.providerPreferences.codex, undefined);
  assert.equal(persisted.providerAgentPreferences.codex, undefined);
});

test("agent overrides are partial, inherit updated defaults, and can be cleared", (t) => {
  const stateRoot = isolatedEnvironment(t);
  let connection = loadConnection();

  connection.setDefaultPreferences({
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    fastMode: false,
  });
  connection.setAgentPreferences("agent-123", {
    model: "gpt-5.6-sol",
    fastMode: true,
  });
  assert.deepEqual(connection.getPreferences("agent-123"), {
    agentId: "agent-123",
    provider: "codex",
    defaults: {
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      fastMode: false,
    },
    override: { model: "gpt-5.6-sol", fastMode: true },
    effective: {
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      fastMode: true,
    },
  });

  connection.setDefaultPreferences({ reasoningEffort: "xhigh" });
  const persisted = JSON.parse(
    fs.readFileSync(path.join(stateRoot, "connection.json"), "utf8"),
  );
  assert.deepEqual(persisted.agentPreferences["agent-123"], {
    model: "gpt-5.6-sol",
    fastMode: true,
  });
  connection = loadConnection();
  assert.deepEqual(connection.getConnection("agent-123"), {
    mode: "cliproxy-oauth",
    route: "cliproxyapi-codex-oauth",
    provider: "codex",
    providerLabel: "OpenAI Codex",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: `test-${"proxy-key"}-that-must-never-be-public`,
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    fastMode: true,
  });

  connection.clearAgentPreferences("agent-123");
  assert.deepEqual(connection.getPreferences("agent-123"), {
    agentId: "agent-123",
    provider: "codex",
    defaults: {
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
      fastMode: false,
    },
    override: null,
    effective: {
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
      fastMode: false,
    },
  });
});

test("settings validation is strict and the public status contains only the fixed safe catalog", (t) => {
  const stateRoot = isolatedEnvironment(t);
  writeConnectionConfig(stateRoot, {
    mode: "codex-oauth",
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    fastMode: false,
    protectedApiKey: `PROTECTED-${"KEY"}-MUST-NOT-LEAK`,
    refreshToken: `REFRESH-${"TOKEN"}-MUST-NOT-LEAK`,
  });
  const connection = loadConnection();

  const invalid = [
    { scope: "default", model: "gpt-5.4" },
    { scope: "default", reasoningEffort: "extreme" },
    { scope: "default", fastMode: "true" },
    { scope: "default", inherit: true },
    { scope: "default", model: "gpt-5.6-sol", extra: true },
    { scope: "agent", agentId: "agent/unsafe", model: "gpt-5.6-sol" },
    { scope: "agent", agentId: "agent-1", inherit: true, fastMode: false },
    { scope: "agent", agentId: "agent-1", clear: true, inherit: true },
    { scope: "agent", agentId: "agent-1" },
  ];
  for (const body of invalid) {
    assert.throws(
      () => connection.applySettingsUpdate(body),
      (error) =>
        error?.name === "SettingsValidationError" && error?.statusCode === 400,
    );
  }

  const status = connection.publicStatus("agent-1");
  assert.deepEqual(
    status.preferences.catalog.models.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  assert.deepEqual(status.preferences.catalog.reasoningEfforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(status.preferences.catalog.fastMode, {
    supported: true,
    default: false,
  });
  assert.deepEqual(status.preferences.effective, status.preferences.defaults);
  assert.equal(status.preferences.override, null);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(
    serialized,
    /PROTECTED-KEY-MUST-NOT-LEAK|REFRESH-TOKEN-MUST-NOT-LEAK|test-proxy-key-that-must-never-be-public/,
  );
  assert.throws(
    () => connection.publicStatus("__proto__"),
    /unsupported characters/,
  );
});

async function unusedLoopbackPort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("authenticated Codex settings HTTP API updates defaults and per-agent inheritance", async (t) => {
  const token = "model-preferences-test-token-123456789";
  const port = await unusedLoopbackPort();
  const stateRoot = isolatedEnvironment(t, {
    GROK_BOT_BROWSER_VIEW_PORT: String(port),
    GROK_BOT_BROWSER_VIEW_TOKEN: token,
  });
  delete require.cache[require.resolve(bridgePath)];
  delete require.cache[require.resolve(connectionPath)];
  globalThis[connectionStateKey] = null;
  globalThis[viewServerKey] = null;
  const bridge = require(bridgePath);
  const server = bridge.startViewServer();
  if (!server.listening) await once(server, "listening");
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    globalThis[viewServerKey] = null;
    delete require.cache[require.resolve(bridgePath)];
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const request = (pathname, { body, authenticated = true } = {}) =>
    fetch(`${baseUrl}${pathname}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(authenticated ? { "X-Codex-Seat-Token": token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  assert.equal(
    (await request("/api/codex/status", { authenticated: false })).status,
    401,
  );
  assert.equal(
    (
      await request("/api/codex/settings", {
        authenticated: false,
        body: { scope: "default", model: "gpt-5.6-sol" },
      })
    ).status,
    401,
  );

  let response = await request("/api/codex/settings", {
    body: {
      scope: "default",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      fastMode: false,
    },
  });
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.operation, "update-default");
  assert.deepEqual(payload.status.preferences.defaults, {
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    fastMode: false,
  });

  response = await request("/api/codex/settings", {
    body: {
      scope: "agent",
      agentId: "employee-42",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      fastMode: true,
    },
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.operation, "update-agent");
  assert.deepEqual(payload.status.preferences.override, {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    fastMode: true,
  });

  response = await request("/api/codex/status?agentId=employee-42");
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.preferences.agentId, "employee-42");
  assert.deepEqual(payload.preferences.effective, {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    fastMode: true,
  });
  assert.deepEqual(payload.connection, {
    mode: "cliproxy-oauth",
    route: "cliproxyapi-codex-oauth",
    provider: "codex",
    providerLabel: "OpenAI Codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    fastMode: true,
  });

  response = await request("/api/codex/settings", {
    body: { scope: "agent", agentId: "employee-42", inherit: true },
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.operation, "clear-agent");
  assert.equal(payload.status.preferences.override, null);
  assert.deepEqual(
    payload.status.preferences.effective,
    payload.status.preferences.defaults,
  );

  response = await request("/api/codex/auth", {
    body: { action: "use-provider", provider: "claude" },
  });
  assert.equal(response.status, 400);
  payload = await response.json();
  assert.match(payload.error, /not connected/i);

  fs.writeFileSync(
    path.join(stateRoot, "auth", "claude-connected.json"),
    JSON.stringify({ type: "claude", organization_name: "Claude Test" }),
  );
  response = await request("/api/codex/auth", {
    body: { action: "use-provider", provider: "claude" },
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.status.connection.provider, "claude");
  assert.equal(payload.status.connection.route, "cliproxyapi-claude-oauth");
  assert.equal(payload.status.preferences.defaults.model, "claude-sonnet-5");
  assert.equal(payload.status.preferences.catalog.fastMode.supported, false);
  assert.deepEqual(
    payload.status.providers.map((provider) => provider.id),
    ["codex", "claude", "antigravity", "kimi", "xai", "vertex", "local"],
  );

  response = await request("/api/codex/settings", {
    body: {
      scope: "default",
      model: "claude-opus-5",
      reasoningEffort: "xhigh",
    },
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.status.preferences.defaults.model, "claude-opus-5");
  assert.equal(payload.status.preferences.defaults.reasoningEffort, "xhigh");

  fs.writeFileSync(
    path.join(stateRoot, "auth", "codex-connected.json"),
    JSON.stringify({ type: "codex", name: "Codex Test" }),
  );
  response = await request("/api/codex/auth", {
    body: { action: "use-provider", provider: "codex" },
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.status.preferences.defaults.model, "gpt-5.6-luna");
  assert.equal(payload.status.preferences.defaults.reasoningEffort, "low");

  assert.equal(
    (
      await request("/api/codex/auth", {
        body: {
          action: "use-provider",
          provider: "claude",
          unexpected: true,
        },
      })
    ).status,
    400,
  );

  assert.equal(
    (
      await request("/api/codex/settings", {
        body: { scope: "default", model: "gpt-5.4", surprise: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/codex/settings`, {
        method: "POST",
        headers: { "X-Codex-Seat-Token": token },
        body: JSON.stringify({ scope: "default", model: "gpt-5.6-sol" }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${baseUrl}/api/codex/settings`, {
        method: "POST",
        headers: {
          "X-Codex-Seat-Token": token,
          "Content-Type": "application/json",
        },
        body: "{not-json",
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/codex/status?agentId=one&agentId=two")).status,
    400,
  );
  assert.equal(
    (await request("/api/codex/status?agentId=employee%2Funsafe")).status,
    400,
  );
  assert.equal(
    (await request("/api/codex/status?unexpected=true")).status,
    400,
  );
});
