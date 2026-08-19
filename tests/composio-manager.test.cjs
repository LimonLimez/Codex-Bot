"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ComposioError,
  createComposioManager,
} = require("../src/composio-manager.cjs");

test("Composio uses the production launcher state-root contract", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "composio-manager.cjs"),
    "utf8",
  );
  const launcher = fs.readFileSync(
    path.join(__dirname, "..", "src", "runtime", "Launch-Codex-Bot.ps1"),
    "utf8",
  );
  assert.match(source, /process\.env\.CODEX_BOT_STATE_ROOT/);
  assert.doesNotMatch(source, /process\.env\.GROK_BOT_STATE_ROOT/);
  assert.match(launcher, /\$env:CODEX_BOT_STATE_ROOT = \$stateRoot/);
});

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-composio-"));
  const prior = process.env.CODEX_BOT_STATE_ROOT;
  process.env.CODEX_BOT_STATE_ROOT = root;
  t.after(() => {
    if (prior == null) delete process.env.CODEX_BOT_STATE_ROOT;
    else process.env.CODEX_BOT_STATE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  const session = {
    sessionId: "trs_fixture_123456",
    toolkits: async () => ({
      items: [
        {
          slug: "github",
          name: "GitHub",
          logo: "https://cdn.example/github.png",
          connection: {
            isActive: true,
            connectedAccount: { id: "ca_fixture", status: "ACTIVE" },
          },
        },
      ],
      cursor: undefined,
    }),
    authorize: async (toolkit) => ({
      connectedAccountId: `ca_${toolkit}`,
      redirectUrl: `https://app.composio.dev/link/${toolkit}`,
    }),
    search: async (params) => ({
      items: [{ slug: "GITHUB_LIST_REPOS" }],
      params,
    }),
    execute: async (slug, args) => ({ data: { slug, args }, error: null }),
    ...overrides.session,
  };
  class Composio {
    constructor(options) {
      calls.push({ operation: "construct", options });
      this.sessions = {
        create: async (userId, config) => {
          calls.push({ operation: "create", userId, config });
          return session;
        },
        use: async () => session,
      };
    }
  }
  const manager = createComposioManager({
    protectSecret: (value) => `sealed:${Buffer.from(value).toString("base64")}`,
    unprotectSecret: (value) => {
      if (!value.startsWith("sealed:")) throw new Error("bad seal");
      return Buffer.from(value.slice(7), "base64").toString("utf8");
    },
    loadSdk: async () => ({ Composio }),
  });
  return { root, manager, calls };
}

test("Composio configuration is protected and creates a sandbox-free session", async (t) => {
  const { root, manager, calls } = fixture(t);
  const key = "sk_test_secret_must_not_leak";
  const status = await manager.configure(key);
  assert.deepEqual(status, { configured: true });
  const stored = fs.readFileSync(
    path.join(root, "composio", "config.json"),
    "utf8",
  );
  assert.doesNotMatch(stored, new RegExp(key));
  assert.match(stored, /sealed:/);
  const constructed = calls.find((call) => call.operation === "construct");
  assert.equal(constructed.options.allowTracking, false);
  assert.equal(
    constructed.options.dangerouslyAllowAutoUploadDownloadFiles,
    false,
  );
  assert.equal(constructed.options.allowSensitiveFileUploads, false);
  const created = calls.find((call) => call.operation === "create");
  assert.deepEqual(created.config.sandbox, {
    enable: false,
    enableProxyExecution: false,
  });
  assert.equal(created.config.manageConnections, false);
  assert.equal(created.config.multiAccount.requireExplicitSelection, true);
});

test("public catalog, authorization, search, and execution are bounded and secret-free", async (t) => {
  const { manager } = fixture(t);
  await manager.configure("sk_fixture_123456789");
  const catalog = await manager.listToolkits();
  assert.deepEqual(catalog.items[0], {
    slug: "github",
    name: "GitHub",
    logo: "https://cdn.example/github.png",
    connected: true,
    accountId: "ca_fixture",
  });
  const link = await manager.authorize("github");
  assert.equal(link.redirectUrl, "https://app.composio.dev/link/github");
  assert.equal(link.connectedAccountId, "ca_github");
  const found = await manager.search("list my repositories", ["github"]);
  assert.equal(found.items[0].slug, "GITHUB_LIST_REPOS");
  const executed = await manager.execute("GITHUB_LIST_REPOS", {
    visibility: "private",
  });
  assert.equal(executed.data.slug, "GITHUB_LIST_REPOS");
});

test("unsafe connection links and malformed tool calls fail closed", async (t) => {
  const { manager } = fixture(t, {
    session: {
      authorize: async () => ({
        connectedAccountId: "ca_bad",
        redirectUrl: "https://attacker.example/steal",
      }),
    },
  });
  await manager.configure("sk_fixture_123456789");
  await assert.rejects(
    manager.authorize("github"),
    (error) =>
      error instanceof ComposioError &&
      error.code === "COMPOSIO_UNSAFE_CONNECT_URL",
  );
  await assert.rejects(
    manager.execute("bad-tool", {}),
    /valid connected-app action/i,
  );
  await assert.rejects(
    manager.execute("GITHUB_LIST_REPOS", []),
    /must be an object/i,
  );
  await assert.rejects(
    manager.execute("GMAIL_SEND_EMAIL", { to: "person@example.com" }),
    /direct user request/i,
  );
  await assert.rejects(
    manager.execute(
      "GMAIL_DELETE_EMAIL",
      { id: "mail_1" },
      { userAuthorizedWrite: true },
    ),
    /destructive connected-app actions/i,
  );
  const sent = await manager.execute(
    "GMAIL_SEND_EMAIL",
    { to: "person@example.com" },
    { userAuthorizedWrite: true },
  );
  assert.equal(sent.data.slug, "GMAIL_SEND_EMAIL");
});

test("disconnect removes only Open Bot's protected Composio configuration", async (t) => {
  const { root, manager } = fixture(t);
  await manager.configure("sk_fixture_123456789");
  assert.deepEqual(manager.disconnect(), { configured: false });
  assert.deepEqual(manager.status(), { configured: false });
  assert.equal(
    fs.existsSync(path.join(root, "composio", "config.json")),
    false,
  );
});
