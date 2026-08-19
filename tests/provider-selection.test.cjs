"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const connectionPath = path.join(root, "src", "codex-connection.cjs");
const stateKey = Symbol.for("codexbot.connection.state");
const oauthKey = Symbol.for("codexbot.connection.oauth");

function environment(t) {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-provider-selection-"),
  );
  const authRoot = path.join(stateRoot, "auth");
  fs.mkdirSync(authRoot, { recursive: true });
  const names = [
    "CODEX_BOT_STATE_ROOT",
    "GROK_BOT_CODEX_AUTH_DIR",
    "GROK_BOT_CLIPROXY_EXE",
    "GROK_BOT_CLIPROXY_CONFIG",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, {
    CODEX_BOT_STATE_ROOT: stateRoot,
    GROK_BOT_CODEX_AUTH_DIR: authRoot,
    GROK_BOT_CLIPROXY_EXE: __filename,
    GROK_BOT_CLIPROXY_CONFIG: path.join(stateRoot, "cliproxy.yaml"),
  });
  delete require.cache[require.resolve(connectionPath)];
  globalThis[stateKey] = null;
  globalThis[oauthKey] = null;
  t.after(() => {
    delete require.cache[require.resolve(connectionPath)];
    globalThis[stateKey] = null;
    globalThis[oauthKey] = null;
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  return { stateRoot, authRoot, connection: require(connectionPath) };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test("every interactive CLIProxy provider is selectable with independent models and defaults", (t) => {
  const { stateRoot, connection } = environment(t);
  const expected = {
    codex: ["gpt-5.6-terra", "cliproxyapi-codex-oauth", true],
    claude: ["claude-sonnet-5", "cliproxyapi-claude-oauth", false],
    antigravity: [
      "gemini-3.6-flash-high",
      "cliproxyapi-antigravity-oauth",
      false,
    ],
    kimi: ["kimi-k3", "cliproxyapi-kimi-oauth", false],
    xai: ["grok-4.5", "cliproxyapi-xai-oauth", false],
    vertex: ["gemini-3.1-pro", "cliproxyapi-vertex-oauth", false],
  };

  assert.deepEqual(
    connection.CLIPROXY_PROVIDERS.map((provider) => provider.id),
    Object.keys(expected),
  );
  assert.deepEqual(
    connection.CLIPROXY_PROVIDERS.map((provider) => provider.providerId),
    [
      "openai-codex",
      "anthropic-claude",
      "google-antigravity",
      "moonshot-kimi",
      "xai",
      "google-vertex-ai",
    ],
  );
  for (const [provider, [model, route, fastSupported]] of Object.entries(
    expected,
  )) {
    connection.setProvider(provider);
    const status = connection.publicStatus();
    assert.equal(status.connection.provider, provider);
    assert.equal(status.connection.route, route);
    assert.equal(status.connection.model, model);
    assert.equal(status.preferences.catalog.fastMode.supported, fastSupported);
    assert.ok(status.preferences.catalog.models.length >= 3);
  }

  connection.setProvider("claude");
  connection.setDefaultPreferences({
    model: "claude-opus-5",
    reasoningEffort: "xhigh",
  });
  connection.setProvider("kimi");
  connection.setDefaultPreferences({ model: "kimi-k3-256k" });
  assert.throws(
    () => connection.setDefaultPreferences({ fastMode: true }),
    /does not expose Fast mode/,
  );
  connection.setProvider("claude");
  assert.deepEqual(connection.getPreferences().defaults, {
    model: "claude-opus-5",
    reasoningEffort: "xhigh",
    fastMode: false,
  });
  connection.setProvider("kimi");
  assert.equal(connection.getPreferences().defaults.model, "kimi-k3-256k");
  const persisted = JSON.parse(
    fs.readFileSync(path.join(stateRoot, "connection.json"), "utf8"),
  );
  assert.equal(persisted.provider, "moonshot-kimi");
  assert.ok(persisted.providerPreferences["moonshot-kimi"]);
  assert.throws(
    () => connection.setProvider("unknown"),
    /provider must be one/,
  );
});

test("every Windows provider alias writes its canonical provider ID", (t) => {
  const { stateRoot, connection } = environment(t);
  const expected = {
    codex: "openai-codex",
    claude: "anthropic-claude",
    antigravity: "google-antigravity",
    kimi: "moonshot-kimi",
    xai: "xai",
    vertex: "google-vertex-ai",
    "openai-api-key": "openai-api-key",
    local: "local-openai-compatible",
  };

  for (const [windowsProviderId, canonicalProviderId] of Object.entries(
    expected,
  )) {
    if (windowsProviderId === "local") {
      const current = JSON.parse(
        fs.readFileSync(path.join(stateRoot, "connection.json"), "utf8"),
      );
      fs.writeFileSync(
        path.join(stateRoot, "connection.json"),
        JSON.stringify({
          ...current,
          localServer: {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [{ id: "local-model", label: "Local model" }],
          },
        }),
      );
      globalThis[stateKey] = null;
    }
    connection.setProvider(windowsProviderId);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(stateRoot, "connection.json"), "utf8"),
    );
    assert.equal(persisted.provider, canonicalProviderId);
    assert.ok(persisted.providerPreferences[canonicalProviderId]);
  }
});

test("provider account discovery stays inside the installation auth directory and exposes no token", (t) => {
  const { authRoot, connection } = environment(t);
  const accessTokenKey = ["access", "token"].join("_");
  const refreshTokenKey = ["refresh", "token"].join("_");
  const accessToken = ["SECRET", "ACCESS", "TOKEN"].join("_");
  const refreshToken = ["SECRET", "REFRESH", "TOKEN"].join("_");
  fs.writeFileSync(
    path.join(authRoot, "claude-person@example.test.json"),
    JSON.stringify({
      type: "claude",
      email: "person@example.test",
      organization_name: "Example Org",
      [accessTokenKey]: accessToken,
      [refreshTokenKey]: refreshToken,
    }),
  );
  connection.setProvider("claude");
  const status = connection.publicStatus();
  assert.equal(status.account.signedIn, true);
  assert.equal(status.account.provider, "claude");
  assert.equal(status.account.name, "Example Org");
  assert.equal(status.account.email, "person@example.test");
  assert.equal(
    status.providers.find((provider) => provider.id === "claude").signedIn,
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(status),
    new RegExp(`${accessToken}|${refreshToken}`),
  );
});

test("provider sign-in is transactional, cancellable, and activates only after a credential exists", async (t) => {
  const { authRoot, connection } = environment(t);
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });
  const child = fakeChild();
  childProcess.spawn = () => child;

  connection.setProvider("codex");
  connection.setDefaultPreferences({
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
  });
  const pending = connection.beginProviderLogin("claude");
  child.stdout.emit(
    "data",
    "Visit the following URL to continue authentication:\nhttps://claude.ai/oauth/authorize?code=transactional\n",
  );
  const handoff = await pending;

  assert.equal(handoff.provider, "claude");
  assert.equal(handoff.previousCredentialRevision, null);
  assert.equal(connection.publicStatus().connection.provider, "codex");
  assert.deepEqual(connection.getPreferences().defaults, {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    fastMode: false,
  });
  assert.throws(
    () => connection.useProvider("claude"),
    /Finish its official sign-in/,
  );

  assert.deepEqual(connection.cancelProviderLogin("claude"), {
    cancelled: true,
    provider: "claude",
  });
  assert.equal(child.killed, true);
  assert.deepEqual(connection.cancelProviderLogin("claude"), {
    cancelled: false,
    provider: "claude",
  });

  fs.writeFileSync(
    path.join(authRoot, "claude-connected.json"),
    JSON.stringify({
      type: "claude",
      organization_name: "Connected Claude",
    }),
  );
  const status = connection.useProvider("claude");
  assert.equal(status.connection.provider, "claude");
  assert.equal(status.connection.route, "cliproxyapi-claude-oauth");
  assert.equal(status.connection.model, "claude-sonnet-5");
  assert.deepEqual(
    status.preferences.catalog.models.map((model) => model.id),
    ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"],
  );
  assert.deepEqual(status.preferences.catalog.reasoningEfforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("provider sign-in completion is reconciled and activated by backend status", async (t) => {
  const { authRoot, connection } = environment(t);
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });
  const child = fakeChild();
  childProcess.spawn = () => child;

  const pending = connection.beginProviderLogin("claude");
  child.stdout.emit(
    "data",
    "Visit the following URL to continue authentication:\nhttps://claude.ai/oauth/authorize?code=backend-owned\n",
  );
  await pending;
  fs.writeFileSync(
    path.join(authRoot, "claude-backend-owned.json"),
    JSON.stringify({
      type: "claude",
      organization_name: "Backend Reconciled Claude",
      [["access", "token"].join("_")]: "SECRET_PROVIDER_TOKEN",
    }),
  );

  const status = connection.publicStatus();
  assert.equal(status.connection.provider, "claude");
  assert.equal(status.connection.model, "claude-sonnet-5");
  assert.deepEqual(status.providerLogin, {
    provider: "claude",
    providerLabel: "Anthropic Claude",
    state: "connected",
    message:
      "Anthropic Claude connected. Models and reasoning controls are now updated for this provider.",
  });
  assert.doesNotMatch(JSON.stringify(status), /SECRET_PROVIDER_TOKEN/);
});

test("provider browser success reports safe callback and token-exchange failures without changing routes or leaking output", async (t) => {
  const { connection } = environment(t);
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });
  const child = fakeChild();
  childProcess.spawn = () => child;

  const pending = connection.beginProviderLogin("antigravity");
  child.stdout.emit(
    "data",
    "Visit the following URL to continue authentication:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=test\n",
  );
  await pending;
  child.stderr.emit(
    "data",
    "token exchange failed SECRET_SENTINEL https://accounts.google.com/private\n",
  );
  child.exitCode = 1;
  child.emit("exit", 1);

  const status = connection.publicStatus();
  assert.equal(status.connection.provider, "codex");
  assert.equal(status.providerLogin.state, "error");
  assert.match(status.providerLogin.message, /token exchange could not reach/i);
  assert.doesNotMatch(
    JSON.stringify(status.providerLogin),
    /SECRET_SENTINEL|private/,
  );

  globalThis[oauthKey] = null;
  const callbackChild = fakeChild();
  childProcess.spawn = () => callbackChild;
  const callbackPending = connection.beginProviderLogin("antigravity");
  callbackChild.stdout.emit(
    "data",
    "Visit the following URL to continue authentication:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=callback\n",
  );
  await callbackPending;
  callbackChild.stderr.emit(
    "data",
    "Antigravity authentication failed: authentication timed out",
  );
  callbackChild.exitCode = 1;
  callbackChild.emit("exit", 1);
  const callbackFailure = connection.providerLoginStatus();
  assert.match(
    callbackFailure.message,
    /did not receive the browser callback/i,
  );
  assert.doesNotMatch(callbackFailure.message, /token exchange/i);

  globalThis[oauthKey] = {
    providerId: "antigravity",
    providerLabel: "Google Antigravity",
    state: "settling",
    settleDeadlineAt: Date.now() - 1,
    exitCode: 0,
    output: "Antigravity authentication failed: antigravity: invalid state",
  };
  const staleFailure = connection.providerLoginStatus();
  assert.match(staleFailure.message, /callback from an older sign-in attempt/i);
  assert.doesNotMatch(staleFailure.message, /exit 0/i);

  globalThis[oauthKey] = {
    providerId: "antigravity",
    providerLabel: "Google Antigravity",
    state: "settling",
    settleDeadlineAt: Date.now() - 1,
    exitCode: 0,
    output:
      "Antigravity authentication failed: antigravity: failed to fetch project ID: no project_id in response SECRET_SENTINEL",
  };
  const missingProject = connection.providerLoginStatus();
  assert.match(missingProject.message, /Google sign-in succeeded/i);
  assert.match(
    missingProject.message,
    /did not assign this account a cloud project/i,
  );
  assert.doesNotMatch(
    JSON.stringify(missingProject),
    /SECRET_SENTINEL|exit 0|callback port/i,
  );
});

test("clean provider exit waits for credential persistence and still fails closed after its grace window", async (t) => {
  const { authRoot, connection } = environment(t);
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });
  const child = fakeChild();
  childProcess.spawn = () => child;

  const pending = connection.beginProviderLogin("antigravity");
  child.stdout.emit(
    "data",
    "Visit the following URL to continue authentication:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=test\n",
  );
  await pending;
  child.exitCode = 0;
  child.emit("exit", 0);

  assert.equal(connection.providerLoginStatus().state, "settling");
  assert.match(connection.providerLoginStatus().message, /Finishing Google/);
  fs.writeFileSync(
    path.join(authRoot, "antigravity-person@example.test.json"),
    JSON.stringify({ type: "antigravity", email: "person@example.test" }),
  );
  const connected = connection.publicStatus();
  assert.equal(connected.providerLogin.state, "connected");
  assert.equal(connected.connection.provider, "antigravity");

  globalThis[oauthKey] = {
    child: null,
    providerId: "antigravity",
    providerLabel: "Google Antigravity",
    previousCredentialRevision: connected.providers.find(
      (provider) => provider.id === "antigravity",
    ).credentialRevision,
    state: "settling",
    settleDeadlineAt: Date.now() - 1,
    exitCode: 0,
    output:
      "token exchange failed SECRET_SENTINEL https://oauth2.googleapis.com/token",
  };
  const failed = connection.providerLoginStatus();
  assert.equal(failed.state, "error");
  assert.match(failed.message, /token exchange could not reach the provider/i);
  assert.doesNotMatch(JSON.stringify(failed), /SECRET_SENTINEL|oauth2/);
});

test("all provider login outputs are normalized to reviewed official pages and exact CLI flags", async (t) => {
  const { connection } = environment(t);
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });
  const cases = [
    {
      provider: "codex",
      flag: "-codex-device-login",
      output:
        "Codex device URL: https://auth.openai.com/codex/device\nCodex device code: ABCD-EFGH\n",
      host: "auth.openai.com",
      code: "ABCD-EFGH",
    },
    {
      provider: "claude",
      flag: "-claude-login",
      output:
        "Visit the following URL to continue authentication:\nhttps://claude.ai/oauth/authorize?code=true\n",
      host: "claude.ai",
      code: null,
    },
    {
      provider: "antigravity",
      flag: "-antigravity-login",
      output:
        "Visit the following URL to continue authentication:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=test\n",
      host: "accounts.google.com",
      code: null,
    },
    {
      provider: "kimi",
      flag: "-kimi-login",
      output:
        "To authenticate, please visit:\nhttps://www.kimi.com/code/authorize_device?user_code=KIMI-1234\n\nUser code: KIMI-1234\n",
      host: "www.kimi.com",
      code: "KIMI-1234",
    },
    {
      provider: "xai",
      flag: "-xai-login",
      output:
        "To authenticate, please visit:\nhttps://accounts.x.ai/oauth2/device?user_code=XAI-1234\n\nThen enter this code: XAI-1234\n",
      host: "accounts.x.ai",
      code: "XAI-1234",
    },
  ];

  for (const item of cases) {
    const child = fakeChild();
    let args;
    let options;
    childProcess.spawn = (_executable, passed, passedOptions) => {
      args = passed;
      options = passedOptions;
      return child;
    };
    const pending = connection.beginProviderLogin(item.provider);
    child.stdout.emit("data", item.output);
    const result = await pending;
    assert.equal(args[0], item.flag);
    if (item.provider === "antigravity") {
      assert.equal(args[1], "-no-browser");
      assert.equal(args[2], "-oauth-callback-port");
      assert.ok(Number(args[3]) >= 41_000 && Number(args[3]) < 49_000);
      assert.deepEqual(args.slice(4), [
        "-config",
        process.env.GROK_BOT_CLIPROXY_CONFIG,
      ]);
    } else {
      assert.deepEqual(args.slice(1), [
        "-no-browser",
        "-config",
        process.env.GROK_BOT_CLIPROXY_CONFIG,
      ]);
    }
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(new URL(result.url).hostname, item.host);
    assert.equal(result.provider, item.provider);
    assert.equal(result.code, item.code);
    child.exitCode = 0;
    child.emit("exit", 0);
    globalThis[oauthKey] = null;
  }

  for (const [provider, malicious] of [
    ["claude", "https://claude.ai.evil.test/oauth/authorize"],
    ["antigravity", "https://evil.test/o/oauth2/v2/auth"],
    ["kimi", "http://www.kimi.com/code/authorize_device"],
    ["kimi", "https://www.kimi.com/wrong"],
    ["xai", "https://accounts.x.ai@evil.test/oauth2/device"],
  ])
    assert.equal(
      connection.normalizeProviderLoginUrl(provider, malicious),
      null,
    );
});

test("Vertex import uses a private temporary file and requires a saved CLIProxy credential", async (t) => {
  const { stateRoot, authRoot, connection } = environment(t);
  const privateKeyName = ["private", "key"].join("_");
  const originalSpawn = childProcess.spawn;
  t.after(() => {
    childProcess.spawn = originalSpawn;
  });
  let importPath;
  childProcess.spawn = (_executable, args) => {
    const child = fakeChild();
    importPath = args[1];
    process.nextTick(() => {
      assert.equal(args[0], "-vertex-import");
      assert.equal(fs.existsSync(importPath), true);
      fs.writeFileSync(
        path.join(authRoot, "vertex-example-project.json"),
        JSON.stringify({
          type: "vertex",
          project_id: "example-project",
          email: "service@example.iam.gserviceaccount.com",
          service_account: { [privateKeyName]: ["SEC", "RET"].join("") },
        }),
      );
      child.stdout.emit(
        "data",
        `Vertex credentials imported: ${path.join(authRoot, "vertex-example-project.json")}\n`,
      );
      child.emit("exit", 0);
    });
    return child;
  };
  const status = await connection.importVertexServiceAccount({
    type: "service_account",
    project_id: "example-project",
    client_email: "service@example.iam.gserviceaccount.com",
    [privateKeyName]: [
      "-----BEGIN",
      "PRIVATE",
      "KEY-----",
      "TEST",
      "-----END",
      "PRIVATE",
      "KEY-----",
      "",
    ].join("\n"),
    token_uri: "https://oauth2.googleapis.com/token",
  });
  assert.equal(status.connection.provider, "vertex");
  assert.equal(status.account.signedIn, true);
  assert.equal(fs.existsSync(importPath), false);
  assert.equal(
    fs
      .readdirSync(stateRoot)
      .some((name) => name.startsWith(".vertex-import-")),
    false,
  );
});
