"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const patchPath = path.join(__dirname, "..", "src", "patch", "desktop.cjs");

const STOCK_MAIN = "const setup='stock';\n\"use strict\";var fjn=Object.create;const mainFeature='kept';\n";
const STOCK_PRELOAD = "const stock='kept';const L=M({invokeRequest:()=>{s.ipcRenderer.invoke(\"sand:coordinator-port-request\")}});s.contextBridge.exposeInMainWorld(\"desktop\",Q);s.contextBridge.exposeInMainWorld(\"coordinatorPort\",X);s.ipcRenderer.on(\"sand:coordinator-port\",e=>{});\n";

test("desktop patch adds isolated main/preload facades without changing stock exports", () => {
  const { patchMainSource, patchPreloadSource } = require(patchPath);
  const main = patchMainSource(STOCK_MAIN);
  const preload = patchPreloadSource(STOCK_PRELOAD);
  assert.match(main, /\.\.\/codex\/desktop\/runtime\.cjs/);
  assert.match(main, /installDesktopRuntime/);
  assert.match(main, /mainFeature='kept'/);
  assert.match(preload, /exposeInMainWorld\("desktop",Q\)/);
  assert.match(preload, /exposeInMainWorld\("coordinatorPort",X\)/);
  assert.match(preload, /invoke\("openbot:coordinator-port-request"\)/);
  assert.match(preload, /ipcRenderer\.on\("openbot:coordinator-port"/);
  assert.match(
    preload,
    /exposeInMainWorld\("openbotProtocol",Object\.freeze\(\{schemaVersion:1,mode:"local-protocol"\}\)\)/,
  );
  assert.doesNotMatch(preload, /invoke\("sand:coordinator-port-request"\)/);
  assert.doesNotMatch(preload, /ipcRenderer\.on\("sand:coordinator-port"/);
  assert.doesNotMatch(preload, /getCursorAuthStatus\s*[:=]/);
  assert.match(preload, /exposeInMainWorld\("codexBots"/);
  assert.match(preload, /exposeInMainWorld\("codexRuntime"/);
  assert.match(preload, /exposeInMainWorld\("codexAccount"/);
  assert.match(preload, /exposeInMainWorld\("openbotComputer"/);
  assert.match(preload, /exposeInMainWorld\("openbotLocalDesktop"/);
  assert.match(preload, /select:value=>s\.ipcRenderer\.invoke\("openbot-local-frame:select",value\)/);
  assert.match(preload, /clear:value=>s\.ipcRenderer\.invoke\("openbot-local-frame:clear",value\)/);
  assert.match(preload, /openbot-local-frame:frame/);
  assert.match(preload, /codex-bot:changed/);
  assert.match(preload, /codex-runtime:event/);
  assert.match(preload, /onEvent:callback/);
  assert.match(preload, /connectProvider:provider/);
  assert.match(preload, /read:\(\)=>__codexAccountInvoke\("read"\)/);
  assert.match(preload, /login:mode=>__codexAccountInvoke\("login",mode\)/);
  assert.match(preload, /cancelLogin:\(\)=>__codexAccountInvoke\("login-cancel"\)/);
  assert.match(preload, /logout:\(\)=>__codexAccountInvoke\("logout"\)/);
  assert.match(preload, /retry:\(\)=>__codexAccountInvoke\("retry"\)/);
  assert.match(preload, /catalog:\(\)=>s\.ipcRenderer\.invoke\("codex-catalog:list"\)/);
  assert.match(preload, /codex-account:changed/);
  assert.match(preload, /codex-catalog:changed/);
  assert.match(preload, /create:\(\)=>__codexInvoke\("create"\)/);
  assert.match(preload, /advanceSetup:value=>__codexInvoke\("advance-setup",value\)/);
  for (const method of [
    "selectMode", "read", "decidePermission", "listPermissions",
    "listPermissionRequests", "revokePermission", "onChanged", "onPermissionRequested",
  ]) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.throws(() => patchMainSource(main), /already|anchor/i);
  assert.throws(() => patchPreloadSource(preload), /already|anchor/i);
});

test("desktop packaging includes every direct inference runtime module in the audited ASAR", () => {
  const { DESKTOP_FILES } = require(patchPath);
  const { ALLOWED_MUTATIONS } = require(path.join(__dirname, "..", "scripts", "patch-app.cjs"));
  const required = [
    "bridge/inference-socket-client.cjs",
    "desktop/cliproxy-inference-transport.cjs",
    "desktop/codex-account-controller.cjs",
    "desktop/codex-app-server-manager.cjs",
    "desktop/codex-direct-inference-transport.cjs",
    "desktop/codex-runtime-integrity.cjs",
    "desktop/inference-bridge-server.cjs",
    "desktop/inference-provider-router.cjs",
    "desktop/local-desktop-frame-ipc.cjs",
    "desktop/openbot-native-coordinator-ipc.cjs",
    "desktop/openbot-native-coordinator.cjs",
    "computer/computer-target-router.cjs",
    "local/local-computer-boundary.cjs",
    "local/local-computer-runtime.cjs",
    "local/local-desktop-manager.cjs",
    "local/local-helper-child.cjs",
    "local/local-helper-protocol.cjs",
    "local/local-helper-transport.cjs",
    "local/local-permission-broker.cjs",
    "local/local-permission-store.cjs",
  ];
  for (const relative of required) {
    assert.equal(DESKTOP_FILES.includes(relative), true, `${relative} must be copied`);
    assert.equal(
      ALLOWED_MUTATIONS.includes(`dist/codex/${relative}`),
      true,
      `${relative} must be included in the exact mutation audit`,
    );
  }
});

test("desktop packaging closes every relative require reachable from its exact source list", () => {
  const { DESKTOP_FILES } = require(patchPath);
  const sourceRoot = path.join(__dirname, "..", "src");
  const packaged = new Set(DESKTOP_FILES);
  const relativeRequire = /require\(\s*["'](?<request>\.\.?\/[^"']+)["']\s*\)/g;

  for (const relative of DESKTOP_FILES) {
    const source = fs.readFileSync(path.join(sourceRoot, ...relative.split("/")), "utf8");
    for (const match of source.matchAll(relativeRequire)) {
      let dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match.groups.request));
      if (path.posix.extname(dependency) === "") dependency += ".cjs";
      assert.equal(
        packaged.has(dependency),
        true,
        `${relative} requires ${dependency}, which must be present in the packaged closure`,
      );
    }
  }
});
