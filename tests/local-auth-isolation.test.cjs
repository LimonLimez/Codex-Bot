"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const { verifyLocalAuthIsolationSources } = require(path.join(root, "scripts", "patch-app.cjs"));

const localGuard = 'if (process.env.GROK_BOT_LOCAL_ONLY === "1") return codexLocalAuthIdentity();';

function validMainSource() {
  return `"use strict";
function showCodexBotLocalOnlyLaunchError(detail) {
  process.exit(1);
}
function handOffDirectCodexBotLaunch() {
  const stateRoot = process.env.CODEX_BOT_STATE_ROOT;
  const gatewayUrl = process.env.SAND_HOST_GATEWAY_URL;
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
function codexLocalAuthIdentity() { return { kind: "logged-in", authId: "codex-bot-local" }; }
function registerCursorAuthIpc(deps) {
  ipcMain9.handle("sand:cursor-auth-status", async () => {
    ${localGuard}
    const service = await ensureCursorAuthService2();
    return service.getStatus();
  });
  ipcMain9.handle("sand:cursor-auth-login", async () => {
    ${localGuard}
    const service = await ensureCursorAuthService2();
    return service.login();
  });
  ipcMain9.handle("sand:cursor-auth-cancel-login", async () => {
    ${localGuard}
    const service = await ensureCursorAuthService2();
    return service.cancelLogin();
  });
  ipcMain9.handle("sand:cursor-auth-logout", async () => {
    ${localGuard}
    const service = await ensureCursorAuthService2();
    return service.logout();
  });
}
function parseDashboardActionRequest(request3) {}
var cursorAuthWiring = createCursorAuthWiring({
  openExternal: async (url3) => {
    if (process.env.GROK_BOT_LOCAL_ONLY === "1") return;
    await import_electron50.shell.openExternal(url3);
  },
});
var { ensureCursorAuthService } = cursorAuthWiring;
`;
}

function validRendererSource() {
  return `function codexLocalAuthIdentity() {
  return { kind: "logged-in", authId: "codex-bot-local" };
}
function mfs(n) {
  const e = n.cursorAccount;
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
      return e.updateName(t.name);
    },
  };
}
function ffs(n) {}
`;
}

test("post-patch local auth verifier accepts the fully isolated shape", () => {
  assert.doesNotThrow(() => verifyLocalAuthIsolationSources(validMainSource(), validRendererSource()));
});

test("post-patch verifier rejects a renderer vendor-login mutation", () => {
  const mutated = validRendererSource().replace(
    `async loginCursor(t) {
      return codexLocalAuthIdentity();`,
    `async loginCursor(t) {
      return e.login();`,
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(validMainSource(), mutated),
    /renderer loginCursor returns the synthetic local identity/,
  );
});

test("post-patch verifier rejects auth IPC that reaches the vendor service first", () => {
  const guarded = `${localGuard}
    const service = await ensureCursorAuthService2();`;
  const mutated = validMainSource().replace(
    guarded,
    `const service = await ensureCursorAuthService2();
    ${localGuard}`,
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /sand:cursor-auth-status short-circuits before vendor auth service access/,
  );
});

test("post-patch verifier rejects an unguarded ultimate auth browser launch", () => {
  const mutated = validMainSource().replace(
    `if (process.env.GROK_BOT_LOCAL_ONLY === "1") return;
    await import_electron50.shell.openExternal(url3);`,
    "await import_electron50.shell.openExternal(url3);",
  );
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /auth browser launch is guarded in local-only mode/,
  );
});

test("post-patch verifier rejects removal of the direct-launch handoff", () => {
  const mutated = validMainSource().replace("handOffDirectCodexBotLaunch();", "void 0;");
  assert.throws(
    () => verifyLocalAuthIsolationSources(mutated, validRendererSource()),
    /direct-launch handoff runs before local-only desktop startup/,
  );
});

test("post-patch verifier rejects an abandoned detached direct-launch child", () => {
  const mutated = validMainSource()
    .replace('require("node:child_process").spawnSync(', 'require("node:child_process").spawn(')
    .replace('{ cwd: installRoot, windowsHide: true, stdio: "ignore" }', '{ cwd: installRoot, detached: true, windowsHide: true, stdio: "ignore" }');
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

test("patching cannot pack an archive before local auth verification", () => {
  const patcher = fs.readFileSync(path.join(root, "scripts", "patch-app.cjs"), "utf8");
  const verify = patcher.indexOf("verifyLocalAuthIsolation(extracted);");
  const pack = patcher.indexOf("asar.createPackageWithOptions(extracted", verify);
  assert.ok(verify >= 0, "post-patch verifier call is present");
  assert.ok(pack > verify, "post-patch verifier runs before packing");
  assert.match(patcher, /renderer local login no-op/);
  assert.match(patcher, /desktop local auth login/);
  assert.match(patcher, /ultimate auth browser launch guard/);
});
