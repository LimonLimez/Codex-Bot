"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const windowsTest = process.platform === "win32" ? test : test.skip;

const root = path.resolve(__dirname, "..");
const { verifyLocalAuthIsolationSources } = require(
  path.join(root, "scripts", "patch-app.cjs"),
);

function validMainSource() {
  return `"use strict";
function showCodexBotLocalOnlyLaunchError(detail) {
  process.exit(1);
}
function isCodexBotWrappedLaunchEnvironment() {
  const stateRoot = process.env.CODEX_BOT_STATE_ROOT?.trim();
  const descriptor = process.env.SAND_HOST_GATEWAY_URL?.trim();
  if (!stateRoot || !require("node:path").isAbsolute(stateRoot) || !descriptor) return false;
  const prefix = "http://127.0.0.1:";
  if (!descriptor.startsWith(prefix)) return false;
  const portText = descriptor.slice(prefix.length);
  if (!/^[1-9][0-9]{0,4}$/.test(portText)) return false;
  const port = Number(portText);
  if (!Number.isInteger(port) || port > 65535) return false;
  try {
    const url = new URL(descriptor);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.port === String(port);
  } catch {
    return false;
  }
}
function handOffDirectCodexBotLaunch() {
  if (isCodexBotWrappedLaunchEnvironment()) return;
  const path = require("node:path");
  const systemRoot = process.env.SystemRoot;
  const installRoot = path.resolve(process.resourcesPath, "..", "..");
  const launcher = path.join(installRoot, "tools", "runtime", "Launch-Codex-Bot.ps1");
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const launcherResult = require("node:child_process").spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher],
    { cwd: installRoot, windowsHide: true, stdio: "ignore" }
  );
  if (launcherResult.error) throw launcherResult.error;
  if (launcherResult.signal) throw new Error("local launcher was terminated by signal " + launcherResult.signal);
  if (!Number.isInteger(launcherResult.status)) throw new Error("local launcher did not report an exit code");
  if (launcherResult.status !== 0) throw new Error("local launcher exited with code " + launcherResult.status);
  showCodexBotLocalOnlyLaunchError("failed");
}
handOffDirectCodexBotLaunch();
process.env.GROK_BOT_LOCAL_ONLY = "1";
function isCodexLocalGatewayMode() {
  return isCodexBotWrappedLaunchEnvironment();
}
function codexLocalAuthIdentity() {
  return { kind: "logged-in", authId: "codex-bot-local" };
}
function createCursorAccountEdgePort(deps) {
  if (process.env.GROK_BOT_LOCAL_ONLY === "1") {
    const identity = async () => codexLocalAuthIdentity();
    const access = async () => {
      return { state: "granted", reason: "none" };
    };
    return {
      getSandAccess: async () => access(),
      getSandAccessFresh: async () => access(),
      getAuthStatus: async () => identity(),
      login: async () => identity(),
      cancelLogin: async () => identity(),
      logout: async () => identity(),
      cancelTrial: async () => ({
        ok: false,
        message: "Vendor account services are disabled in Open Bot local-only mode."
      })
    };
  }
  const { ensureCursorAuthService: ensureCursorAuthService2 } = deps;
  return { login: async () => (await ensureCursorAuthService2()).login() };
}
var cursorAuthWiring = createCursorAuthWiring({
  openExternal: async (url3) => {
    if (process.env.GROK_BOT_LOCAL_ONLY === "1") return;
    await import_electron51.shell.openExternal(url3);
  },
});
var { ensureCursorAuthService } = cursorAuthWiring;
`;
}

function validRendererSource() {
  return `function codexLocalAuthIdentity() {
  return { kind: "logged-in", authId: "codex-bot-local" };
}
function mGn(n) {
  const identity = () => codexLocalAuthIdentity();
  const access = async () => {
    return { state: "granted", reason: "none" };
  };
  return {
    async getCursorAuthStatus(t) {
      return codexLocalAuthIdentity();
    },
    async loginCursor(t) {
      return codexLocalAuthIdentity();
    },
    async cancelCursorLogin(t) {
      return codexLocalAuthIdentity();
    },
    async logoutCursor(t) {
      return codexLocalAuthIdentity();
    },
    async updateCursorAccountName(t) {
      return identity();
    },
    async getCursorAvatar(t) {
      return null;
    },
    async getCursorWeeklyUsage(t) {
      return null;
    },
    async getCursorUsageSummary(t) {
      return null;
    },
    async getSandAccess(t) {
      return access();
    },
    async getSandAccessFresh(t) {
      return access();
    },
    async getSandPrReviewPreferences(t) {
      return null;
    },
    async getCursorPrivacyModeEnabled(t) {
      return true;
    },
    async cancelSandTrial(t) {
      return { ok: false };
    },
    async invokeCursorDashboardAction(t) {
      return { ok: false };
    },
  };
}
function hUn() {
  // The vendor sign-in gates xAI services, not the local Codex workspace.
  const agents = countAgents();
  markOnboardingSeen();
  return { gate: "shell", agents };
}
function authTransitions() {
  return { noteSignedOut: () => {}, forceOnboarding: () => {} };
}
function shell() {
  /* Renderer Sentry is disabled in the Open Bot local-only build. */
  return { children: p.jsx(Gzn, {}) };
}
function uJt() {
  // sand_client_pause belongs to vendor computer setup.
  return false;
}
function s0n() {
  // Vendor plugin discovery is unavailable in the local-only build.
  return null;
}
function RDn() {
  return { label: "Jump to", composerActions: [] };
}
function _bn() {
  return p.jsx("div", {
    className: "sand-computer-preview__frame",
    style: { aspectRatio: "1280 / 800" },
    children: p.jsx(GBLiveSeat, {}),
  });
}
const wDn = [{ id: "general", label: "General", icon: "settings-gear" }];
function IDn() {
  const u = 640;
  const state = S.useSyncExternalStore(EDn, () => ({ windowWidth: window.innerWidth, paneWidth: u })) || !0,
    visible = state;
  return visible;
}
`;
}

function evaluateWrappedLaunchEnvironment(env) {
  const source = validMainSource();
  const start = source.indexOf(
    "function isCodexBotWrappedLaunchEnvironment() {",
  );
  const end = source.indexOf(
    "\nfunction handOffDirectCodexBotLaunch() {",
    start,
  );
  assert.ok(
    start >= 0 && end > start,
    "wrapped-launch predicate fixture exists",
  );
  const predicate = source.slice(start, end);
  return vm.runInNewContext(
    `${predicate}\nisCodexBotWrappedLaunchEnvironment();`,
    {
      process: { env },
      require,
      URL,
    },
  );
}

test("post-patch local auth verifier accepts the fully isolated 0.18 shape", () => {
  assert.doesNotThrow(() =>
    verifyLocalAuthIsolationSources(validMainSource(), validRendererSource()),
  );
});

test("post-patch verifier rejects a renderer vendor-login mutation", () => {
  const mutated = validRendererSource().replace(
    `async loginCursor(t) {
      return codexLocalAuthIdentity();`,
    `async loginCursor(t) {
      return n.cursorAccount.login();`,
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(validMainSource(), mutated),
    /renderer loginCursor returns the synthetic local identity/,
  );
});

test("post-patch verifier rejects a renderer vendor profile mutation", () => {
  const mutated = validRendererSource().replace(
    `async getCursorWeeklyUsage(t) {
      return null;`,
    `async getCursorWeeklyUsage(t) {
      return n.cursorAccount.getWeeklyUsage();`,
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(validMainSource(), mutated),
    /renderer account edge cannot reach vendor auth, access, profile, or usage services/,
  );
});

test("post-patch verifier rejects a reachable vendor plugin shortcut", () => {
  const mutated = `${validRendererSource()}
function uSe() {
  Rme.open(Uf.plugins());
}
function globalPluginShortcut() {
  return {
    id: "sand.openTools",
    label: "Customize",
    hotkey: "mod+shift+m",
    run: uSe,
  };
}
`;
  assert.throws(
    () => verifyLocalAuthIsolationSources(validMainSource(), mutated),
    /vendor plugin overlays have no reachable global action, shortcut, or opener/,
  );
});

test("post-patch verifier rejects an account edge that reaches the vendor service first", () => {
  const mutated = validMainSource().replace(
    `function createCursorAccountEdgePort(deps) {
  if (process.env.GROK_BOT_LOCAL_ONLY === "1") {`,
    `function createCursorAccountEdgePort(deps) {
  const { ensureCursorAuthService: ensureCursorAuthService2 } = deps;
  if (process.env.GROK_BOT_LOCAL_ONLY === "1") {`,
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /local account edge short-circuits before vendor auth service access/,
  );
});

test("post-patch verifier rejects an unguarded ultimate auth browser launch", () => {
  const mutated = validMainSource().replace(
    `if (process.env.GROK_BOT_LOCAL_ONLY === "1") return;
    await import_electron51.shell.openExternal(url3);`,
    "await import_electron51.shell.openExternal(url3);",
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /auth browser launch is guarded in local-only mode/,
  );
});

test("post-patch verifier rejects removal of the direct-launch handoff", () => {
  const mutated = validMainSource().replace(
    "handOffDirectCodexBotLaunch();",
    "void 0;",
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /direct-launch handoff runs before local-only desktop startup/,
  );
});

windowsTest("wrapped-launch predicate accepts only the launcher's exact loopback descriptor", () => {
  const stateRoot = "C:\\Users\\test\\AppData\\Local\\Open Bot";
  assert.equal(
    evaluateWrappedLaunchEnvironment({
      CODEX_BOT_STATE_ROOT: stateRoot,
      SAND_HOST_GATEWAY_URL: "http://127.0.0.1:45678",
    }),
    true,
  );

  for (const descriptor of [
    "https://127.0.0.1:45678",
    "http://localhost:45678",
    "http://example.com:45678",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://user@127.0.0.1:45678",
    "http://127.0.0.1:45678/extra",
    "http://127.0.0.1:45678?stale=1",
    "http://127.0.0.1:45678#fragment",
    "not a URL",
    "",
  ]) {
    assert.equal(
      evaluateWrappedLaunchEnvironment({
        CODEX_BOT_STATE_ROOT: stateRoot,
        SAND_HOST_GATEWAY_URL: descriptor,
      }),
      false,
      descriptor,
    );
  }
  assert.equal(
    evaluateWrappedLaunchEnvironment({
      CODEX_BOT_STATE_ROOT: "relative-state",
      SAND_HOST_GATEWAY_URL: "http://127.0.0.1:45678",
    }),
    false,
  );
});

test("post-patch verifier rejects weakened wrapped-launch validation", () => {
  const source = validMainSource();
  for (const mutated of [
    source.replace(
      'const prefix = "http://127.0.0.1:";',
      'const prefix = "http://";',
    ),
    source.replace('!require("node:path").isAbsolute(stateRoot) || ', ""),
    source.replace("port > 65535", "port > 99999"),
    source.replace(
      "/^[1-9][0-9]{0,4}$/.test(portText)",
      "/^.+$/.test(portText)",
    ),
    source.replace(
      "return isCodexBotWrappedLaunchEnvironment();",
      "return true;",
    ),
  ]) {
    assert.throws(
      () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
      /wrapped-launch environment strictly validates|strict wrapped-launch predicate|local gateway mode predicate/,
    );
  }
});

test("post-patch verifier rejects an abandoned detached direct-launch child", () => {
  const mutated = validMainSource()
    .replace(
      'require("node:child_process").spawnSync(',
      'require("node:child_process").spawn(',
    )
    .replace(
      '{ cwd: installRoot, windowsHide: true, stdio: "ignore" }',
      '{ cwd: installRoot, detached: true, windowsHide: true, stdio: "ignore" }',
    );
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /direct-launch handoff synchronously waits for a hidden launcher/,
  );
});

test("post-patch verifier rejects a synchronous handoff that ignores launcher failure", () => {
  const mutated = validMainSource().replace(
    'if (launcherResult.status !== 0) throw new Error("local launcher exited with code " + launcherResult.status);',
    "void launcherResult.status;",
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /direct-launch handoff validates synchronous launcher completion/,
  );
});

test("patching cannot pack an archive before the 0.18 local auth verifier", () => {
  const patcher = fs.readFileSync(
    path.join(root, "scripts", "patch-app.cjs"),
    "utf8",
  );
  const verify = patcher.indexOf("verifyLocalAuthIsolation(extracted);");
  const pack = patcher.indexOf(
    "asar.createPackageWithOptions(extracted",
    verify,
  );
  assert.ok(verify >= 0, "post-patch verifier call is present");
  assert.ok(pack > verify, "post-patch verifier runs before packing");
  assert.match(patcher, /local frontend identity adapter/);
  assert.match(patcher, /desktop synthetic local identity/);
  assert.match(patcher, /ultimate auth browser launch guard/);
});
