"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const patchPath = path.join(__dirname, "..", "src", "patch", "desktop.cjs");

const STOCK_MAIN = "const setup='stock';\n\"use strict\";var fjn=Object.create;jEr=F=>o.emit(\"mcp-auth-completed\",F),mh=Rzn(remoteReady);aJn(),Ic.markPhase(\"auth_service\");let $=Dzn({});qEr=$,s={pipes:{}};VOn({ipcMain:xt.ipcMain,getExperimentService:cJt});qEr?.hardenWebviewAttach(r.webContents),bu=r;UOn({}),Ic.markPhase(\"window\"),ijn=!0,await mjn(),Ic.noteReady(),xt.app.on(\"activate\",()=>{xt.BrowserWindow.getAllWindows().length===0&&sjn()});const mainFeature='kept';\n";
const STOCK_MACHINE_DS = "async function Ds(){let t=await xgt(Ihr);if(t!=null)return t;await $9t();let e=await xgt(Ihr);if(e!=null)return e;let r=(0,j5n.randomUUID)();return await j9t(Ihr,r),r}";
const STOCK_MACHINE_STARTUP = 'F5n();let e=uJt(),r=await Ds().catch(F=>(xe("update","machine-id",F),crypto.randomUUID()))';
const STOCK_MACHINE_TELEMETRY = 'Ic.markPhase("telemetry");let x=await Ds(),C=hHn(';
const STOCK_MACHINE_TOKEN_FUNCTIONS = [
  "function z9t(){globalThis.__machine.safeStorageCalls+=1;return globalThis.__machine.safeStorageAvailable}",
  "async function xgt(t){globalThis.__machine.safeStorageCalls+=1;return null}",
  "async function j9t(t,e){globalThis.__machine.safeStorageCalls+=1;return e}",
];
const STOCK_MAIN_WITH_HELD_REMOTE_READY = `"use strict";var fjn=Object.create;
function createWebContents(){return{kind:"window-web-contents",listeners:new Map(),on(name,listener){let values=this.listeners.get(name)??[];values.push(listener);this.listeners.set(name,values)},removeListener(name,listener){let values=this.listeners.get(name)??[],index=values.indexOf(listener);if(index>=0){values.splice(index,1);globalThis.__startup.removedWebviewGuards+=1}this.listeners.set(name,values)},emit(name,...args){for(let listener of [...(this.listeners.get(name)??[])])listener(...args)},listenerCount(name){return(this.listeners.get(name)??[]).length}}}
const Ic=globalThis.__startup.Ic,o={emit(){}},xt={
  BrowserWindow:class BrowserWindow{constructor(){globalThis.__startup.windows+=1;globalThis.__startup.events.push("browser-window");this.webContents=createWebContents();this.destroyed=false;globalThis.__startup.liveWindows.push(this)}static getAllWindows(){return globalThis.__startup.liveWindows.filter(window=>!window.isDestroyed())}isDestroyed(){return this.destroyed}destroy(){this.destroyed=true}},
  app:{on(name,handler){if(name==="activate"){globalThis.__startup.activateHandlers+=1;globalThis.__startup.activateHandler=handler}}}
};
const Rzn=value=>{globalThis.__startup.remoteCompleted=true;return value},UOn=()=>{},Dzn=()=>({
  configureBoxVncSession(){globalThis.__startup.vncConfigurations+=1},
  hardenWebviewAttach(contents){if(globalThis.__startup.hardenerFailure!=null)throw globalThis.__startup.hardenerFailure;globalThis.__startup.hardenedContents.push(contents);contents.on("will-attach-webview",()=>{globalThis.__startup.realWebviewAttachEvents+=1})}
});
const cJt=()=>null;
function VOn(){globalThis.__startup.stockSyncRegistrations+=1}
let ijn=false,jEr,mh,qEr,s,bu,FEr;
function aJn(){globalThis.__startup.protocolRegistrations+=1;globalThis.__startup.events.push("protocol")}
async function mjn(){qEr?.configureBoxVncSession();let r=new xt.BrowserWindow();qEr?.hardenWebviewAttach(r.webContents),bu=r,globalThis.__startup.window=r}
function sjn(){bu!=null&&!bu.isDestroyed()||FEr==null&&(FEr=mjn().finally(()=>{FEr=void 0}))}
globalThis.__bootstrapDone=(async()=>{
  jEr=F=>o.emit("mcp-auth-completed",F),mh=Rzn(await globalThis.__remoteReady);aJn(),Ic.markPhase("auth_service");
  let $=Dzn({});qEr=$,s={pipes:{}};VOn({ipcMain:xt.ipcMain,getExperimentService:cJt});
  UOn({}),Ic.markPhase("window"),ijn=!0,await mjn(),Ic.noteReady(),xt.app.on("activate",()=>{xt.BrowserWindow.getAllWindows().length===0&&sjn()})
})().catch(error=>{Ic.noteFailed(error);throw error});
`;
const STOCK_MAIN_WITH_MACHINE_ID = `${STOCK_MAIN_WITH_HELD_REMOTE_READY}
const __machine = globalThis.__machine;
const j5n={randomUUID(){__machine.stockRandomCalls+=1;return "stock-machine-id"}};
const Ihr="cursor-machine-id";
${STOCK_MACHINE_TOKEN_FUNCTIONS.join("\n")}
function F5n(){z9t()}
async function $9t(){__machine.safeStorageCalls+=1;return false}
${STOCK_MACHINE_DS}
function uJt(){return {version:"0.20.0"}}
function xe(){__machine.events.push("machine-id-fallback")}
function hHn(value){__machine.events.push(["telemetry",value]);return value}
globalThis.__machineProbe=async()=>{Ic.markPhase("update_service"),Ic.armStuckWatchdog();${STOCK_MACHINE_STARTUP};${STOCK_MACHINE_TELEMETRY}{machineId:x});return {startupId:r,telemetryId:x,telemetry:C}};
`;
const STOCK_MAIN_WITH_MACHINE_ANCHORS = `${STOCK_MAIN}
${STOCK_MACHINE_DS}
${STOCK_MACHINE_STARTUP};${STOCK_MACHINE_TELEMETRY}{machineId:x};
`;
const STOCK_PRELOAD = "const stock='kept';const L=M({invokeRequest:()=>{s.ipcRenderer.invoke(\"sand:coordinator-port-request\")}});s.contextBridge.exposeInMainWorld(\"desktop\",Q);s.contextBridge.exposeInMainWorld(\"coordinatorPort\",X);s.ipcRenderer.on(\"sand:coordinator-port\",e=>{});\n";

function runSyntheticPreload(source) {
  const exposed = new Map();
  const calls = [];
  const listeners = new Map();
  const removals = [];
  const ipcRenderer = {
    invoke(channel, ...args) {
      calls.push({ channel, args });
      return Promise.resolve({ channel, args });
    },
    on(channel, listener) {
      const registered = listeners.get(channel) ?? [];
      registered.push(listener);
      listeners.set(channel, registered);
    },
    removeListener(channel, listener) {
      removals.push({ channel, listener });
      const registered = listeners.get(channel) ?? [];
      const index = registered.indexOf(listener);
      if (index >= 0) registered.splice(index, 1);
      listeners.set(channel, registered);
    },
    emit(channel, value) {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener({}, value);
    },
  };
  const context = {
    M: (value) => value,
    Q: Object.freeze({ stock: true }),
    X: Object.freeze({ stock: true }),
    s: {
      contextBridge: {
        exposeInMainWorld(name, value) {
          exposed.set(name, value);
        },
      },
      ipcRenderer,
    },
  };
  vm.runInNewContext(source, context, { filename: "synthetic-preload.cjs" });
  return { calls, exposed, ipcRenderer, listeners, removals };
}

function startSyntheticMain(remoteReady, overrides = {}) {
  const { patchMainSource } = require(patchPath);
  const startup = {
    activateHandlers: 0,
    activateHandler: null,
    events: [],
    earlySyncReleases: 0,
    hardenedContents: [],
    hardenerFailure: null,
    liveWindows: [],
    protocolRegistrations: 0,
    ready: false,
    readyCalls: 0,
    realWebviewAttachEvents: 0,
    remoteCompleted: false,
    remoteFailures: [],
    removedWebviewGuards: 0,
    stockSyncRegistrations: 0,
    vncConfigurations: 0,
    window: null,
    windows: 0,
    ...overrides,
  };
  startup.Ic = {
    armStuckWatchdog() {},
    markPhase() {},
    noteReady() {
      startup.ready = true;
      startup.readyCalls += 1;
    },
    noteFailed(error) {
      startup.remoteFailures.push(error);
    },
  };
  const context = {
    __remoteReady: remoteReady,
    __machine: startup.machine,
    __startup: startup,
    require(request) {
      if (request === "../codex/desktop/runtime.cjs") {
        return {
          installDesktopRuntime() {
            return {
              releaseEarlySyncIpc() {
                startup.earlySyncReleases += 1;
              },
              readMachineId() {
                startup.machine.runtimeReads += 1;
                return Promise.resolve(startup.machine.machineId);
              },
            };
          },
        };
      }
      if (request === "electron") return {};
      throw new Error(`Unexpected synthetic require: ${request}`);
    },
  };
  vm.runInNewContext(patchMainSource(overrides.source ?? STOCK_MAIN_WITH_MACHINE_ID), context);
  return { context, startup };
}

test("desktop patch isolates the vendor machine-id path from stock secure storage", async () => {
  const { patchMainSource } = require(patchPath);
  const source = STOCK_MAIN_WITH_MACHINE_ID;
  const tokenBefore = STOCK_MACHINE_TOKEN_FUNCTIONS.map((anchor) => {
    assert.equal(source.split(anchor).length - 1, 1, `fixture must contain one ${anchor}`);
    return anchor;
  });
  assert.equal(source.split(STOCK_MACHINE_DS).length - 1, 1);
  assert.equal(source.split(STOCK_MACHINE_STARTUP).length - 1, 1);
  assert.equal(source.split(STOCK_MACHINE_TELEMETRY).length - 1, 1);

  const patched = patchMainSource(source);
  assert.equal(
    patched.split("async function Ds(){return __openbotDesktopRuntime.readMachineId()}").length - 1,
    1,
  );
  assert.doesNotMatch(patched, new RegExp(STOCK_MACHINE_DS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    patched,
    /let e=uJt\(\),r=await __openbotDesktopRuntime\.readMachineId\(\)\.catch\(F=>\(xe\("update","machine-id",F\),crypto\.randomUUID\(\)\)\)/,
  );
  assert.doesNotMatch(patched, /F5n\(\);let e=uJt\(\)/);
  assert.match(patched, /Ic\.markPhase\("telemetry"\);let x=r,C=hHn\(/);
  for (const anchor of tokenBefore) assert.match(patched, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.throws(() => patchMainSource(patched), /already|anchor/i);

  const machine = {
    machineId: "openbot-machine-id",
    runtimeReads: 0,
    safeStorageAvailable: true,
    safeStorageCalls: 0,
    stockRandomCalls: 0,
    events: [],
  };
  const startup = {
    activateHandlers: 0,
    activateHandler: null,
    events: [],
    earlySyncReleases: 0,
    hardenedContents: [],
    hardenerFailure: null,
    liveWindows: [],
    protocolRegistrations: 0,
    ready: false,
    readyCalls: 0,
    realWebviewAttachEvents: 0,
    remoteCompleted: false,
    remoteFailures: [],
    removedWebviewGuards: 0,
    stockSyncRegistrations: 0,
    vncConfigurations: 0,
    window: null,
    windows: 0,
    machine,
  };
  startup.Ic = {
    armStuckWatchdog() {},
    markPhase() {},
    noteReady() {},
    noteFailed(error) { startup.remoteFailures.push(error); },
  };
  const context = {
    __machine: machine,
    __remoteReady: Promise.resolve("remote-ready"),
    __startup: startup,
    require(request) {
      if (request === "../codex/desktop/runtime.cjs") {
        return {
          installDesktopRuntime() {
            return {
              releaseEarlySyncIpc() {},
              readMachineId() {
                machine.runtimeReads += 1;
                return Promise.resolve(machine.machineId);
              },
            };
          },
        };
      }
      if (request === "electron") return {};
      throw new Error(`Unexpected synthetic require: ${request}`);
    },
  };
  vm.runInNewContext(patched, context);
  await context.__bootstrapDone;
  const result = await context.__machineProbe();
  assert.equal(result.startupId, "openbot-machine-id");
  assert.equal(result.telemetryId, "openbot-machine-id");
  assert.equal(result.telemetry.machineId, "openbot-machine-id");
  assert.equal(machine.runtimeReads, 1);
  assert.equal(machine.safeStorageCalls, 0);
  assert.equal(machine.stockRandomCalls, 0);
});

test("desktop patch adds isolated main/preload facades without changing stock exports", () => {
  const { patchMainSource, patchPreloadSource } = require(patchPath);
  const main = patchMainSource(STOCK_MAIN_WITH_MACHINE_ANCHORS);
  const preload = patchPreloadSource(STOCK_PRELOAD);
  assert.match(main, /\.\.\/codex\/desktop\/runtime\.cjs/);
  assert.match(main, /installDesktopRuntime/);
  assert.match(main, /releaseEarlySyncIpc\(\),VOn\(/);
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
  assert.match(preload, /retry:value=>s\.ipcRenderer\.invoke\("openbot-local-frame:retry",value\)/);
  assert.match(preload, /clear:value=>s\.ipcRenderer\.invoke\("openbot-local-frame:clear",value\)/);
  assert.match(preload, /openbot-local-frame:frame/);
  assert.match(preload, /openbot-local-frame:status/);
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

test("local desktop preload facade exposes exact frame and status channels with removable listeners", async () => {
  const { patchPreloadSource } = require(patchPath);
  const harness = runSyntheticPreload(patchPreloadSource(STOCK_PRELOAD));
  const localDesktop = harness.exposed.get("openbotLocalDesktop");

  assert.ok(localDesktop, "the renderer must discover the local desktop facade");
  assert.equal(Object.isFrozen(localDesktop), true);
  assert.deepEqual(Object.keys(localDesktop).sort(), [
    "clear", "onFrame", "onStatus", "retry", "select",
  ]);

  await localDesktop.select({ botId: "bot-a", viewGeneration: 1 });
  await localDesktop.retry({ botId: "bot-a", viewGeneration: 1 });
  await localDesktop.clear({ viewGeneration: 1 });
  assert.deepEqual(harness.calls.map(({ channel, args }) => ({ channel, args })), [
    { channel: "openbot-local-frame:select", args: [{ botId: "bot-a", viewGeneration: 1 }] },
    { channel: "openbot-local-frame:retry", args: [{ botId: "bot-a", viewGeneration: 1 }] },
    { channel: "openbot-local-frame:clear", args: [{ viewGeneration: 1 }] },
  ]);

  const frames = [];
  const statuses = [];
  assert.throws(() => localDesktop.onFrame(null), (error) => error?.name === "TypeError");
  assert.throws(() => localDesktop.onStatus("not-a-function"), (error) => error?.name === "TypeError");
  const removeFrame = localDesktop.onFrame((value) => frames.push(value));
  const removeStatus = localDesktop.onStatus((value) => statuses.push(value));
  const frameListener = harness.listeners.get("openbot-local-frame:frame")[0];
  const statusListener = harness.listeners.get("openbot-local-frame:status")[0];
  harness.ipcRenderer.emit("openbot-local-frame:frame", { frameId: "frame-1" });
  harness.ipcRenderer.emit("openbot-local-frame:status", { state: "live" });
  assert.deepEqual(frames, [{ frameId: "frame-1" }]);
  assert.deepEqual(statuses, [{ state: "live" }]);
  removeFrame();
  removeStatus();
  assert.deepEqual(harness.removals, [
    { channel: "openbot-local-frame:frame", listener: frameListener },
    { channel: "openbot-local-frame:status", listener: statusListener },
  ]);
});

test("provider authority snapshot and active bot identity use exact narrow preload channels", async () => {
  const { patchPreloadSource } = require(patchPath);
  const source = patchPreloadSource(STOCK_PRELOAD);
  const harness = runSyntheticPreload(source);
  const providers = harness.exposed.get("openbotProviders");
  const runtime = harness.exposed.get("codexRuntime");

  assert.ok(providers, "the renderer must discover the provider facade");
  assert.equal(Object.isFrozen(providers), true);
  assert.equal(Object.keys(providers).length, 7);
  assert.deepEqual(Object.keys(providers).sort(), [
    "completeOnboarding",
    "connect",
    "disconnect",
    "onCatalogChanged",
    "onConnectionsChanged",
    "onLoginPrompt",
    "readAuthoritySnapshot",
  ]);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(typeof runtime.readActiveBotId, "function");

  await providers.readAuthoritySnapshot();
  await providers.connect({ providerId: "openai-codex", loginKind: "account" });
  await providers.disconnect("openai-codex");
  await providers.completeOnboarding("openai-codex");
  await runtime.readActiveBotId();
  assert.deepEqual(harness.calls.map(({ channel, args }) => ({ channel, args })), [
    { channel: "openbot-provider:authority-snapshot", args: [] },
    { channel: "openbot-provider:connect", args: [{ providerId: "openai-codex", loginKind: "account" }] },
    { channel: "openbot-provider:disconnect", args: ["openai-codex"] },
    { channel: "openbot-provider:onboarding-complete", args: ["openai-codex"] },
    { channel: "codex-bot:read-active-bot-id", args: [] },
  ]);

  const connectionPayloads = [];
  const catalogPayloads = [];
  const loginPrompts = [];
  assert.throws(() => providers.onConnectionsChanged(null), (error) => error?.name === "TypeError");
  assert.throws(() => providers.onCatalogChanged("not-a-function"), (error) => error?.name === "TypeError");
  assert.throws(() => providers.onLoginPrompt(null), (error) => error?.name === "TypeError");
  const removeConnections = providers.onConnectionsChanged((value) => connectionPayloads.push(value));
  const removeCatalog = providers.onCatalogChanged((value) => catalogPayloads.push(value));
  const removeLoginPrompt = providers.onLoginPrompt((value) => loginPrompts.push(value));
  const connectionListener = harness.listeners.get("openbot-provider:changed")[0];
  const catalogListener = harness.listeners.get("openbot-provider:catalog-changed")[0];
  const loginPromptListener = harness.listeners.get("openbot-provider:login-prompt")[0];
  harness.ipcRenderer.emit("openbot-provider:changed", { generation: 1 });
  harness.ipcRenderer.emit("openbot-provider:catalog-changed", { generation: 2 });
  const prompt = {
    schemaVersion: 1,
    providerId: "openai-codex",
    generation: 3,
    mode: "device-code",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  };
  harness.ipcRenderer.emit("openbot-provider:login-prompt", prompt);
  assert.deepEqual(connectionPayloads, [{ generation: 1 }]);
  assert.deepEqual(catalogPayloads, [{ generation: 2 }]);
  assert.deepEqual(loginPrompts, [prompt]);
  removeConnections();
  removeCatalog();
  removeLoginPrompt();
  assert.deepEqual(harness.removals, [
    { channel: "openbot-provider:changed", listener: connectionListener },
    { channel: "openbot-provider:catalog-changed", listener: catalogListener },
    { channel: "openbot-provider:login-prompt", listener: loginPromptListener },
  ]);
  harness.ipcRenderer.emit("openbot-provider:changed", { generation: 3 });
  harness.ipcRenderer.emit("openbot-provider:catalog-changed", { generation: 4 });
  harness.ipcRenderer.emit("openbot-provider:login-prompt", { generation: 5 });
  assert.deepEqual(connectionPayloads, [{ generation: 1 }]);
  assert.deepEqual(catalogPayloads, [{ generation: 2 }]);
  assert.deepEqual(loginPrompts, [prompt]);
});

test("provider preload facade has no controller, state, secret, path, endpoint, or command access", () => {
  const { patchPreloadSource } = require(patchPath);
  const source = patchPreloadSource(STOCK_PRELOAD);
  const providers = runSyntheticPreload(source).exposed.get("openbotProviders");
  for (const forbidden of [
    "controller", "stateStore", "keychain", "secret", "path", "endpoint", "command",
    "url", "account",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(providers, forbidden), false, forbidden);
  }
  assert.doesNotMatch(source, /openbotProviders[^;]*(?:controller|stateStore|keychain|secret|endpoint|command|path)/i);
  assert.doesNotMatch(source, /openbot-provider:login-prompt[^;]*invoke\(/);
  assert.match(
    source,
    /onLoginPrompt:callback=>\{if\(typeof callback!=="function"\)throw new TypeError\([^)]+\);const listener=/,
  );
});

test("packaged renderer contract discovers the exact provider facade methods", () => {
  const { patchPreloadSource } = require(patchPath);
  const preload = patchPreloadSource(STOCK_PRELOAD);
  const rendererPath = path.join(__dirname, "..", "src", "renderer", "bot-runtime-ui.js");
  const renderer = fs.readFileSync(rendererPath, "utf8");
  assert.match(preload, /exposeInMainWorld\("openbotProviders"/);
  for (const method of [
    "readAuthoritySnapshot", "connect", "disconnect", "completeOnboarding",
    "onConnectionsChanged", "onCatalogChanged", "onLoginPrompt",
  ]) {
    assert.match(renderer, new RegExp(`"${method}"`));
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.match(renderer, /windowRef\.openbotProviders/);
});

test("desktop patch creates the stock window while remote-service readiness is held", async () => {
  let releaseRemoteReady;
  const remoteReady = new Promise(resolve => {
    releaseRemoteReady = resolve;
  });
  const { context, startup } = startSyntheticMain(remoteReady);
  await Promise.resolve();

  assert.equal(startup.remoteCompleted, false, "the stock remote gate must still be held");
  assert.deepEqual(startup.events, ["protocol", "browser-window"], "media protocol must precede the window");
  assert.equal(startup.protocolRegistrations, 1);
  assert.equal(startup.earlySyncReleases, 0, "bootstrap sync IPC must remain active while the remote gate is held");
  assert.equal(startup.stockSyncRegistrations, 0);
  assert.equal(startup.windows, 1, "window creation must not wait for stock remote readiness");
  const blockedAttach = {
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  };
  startup.window.webContents.emit("will-attach-webview", blockedAttach, {}, {});
  assert.equal(blockedAttach.prevented, true, "early webviews must fail closed before VNC hardening exists");
  assert.equal(startup.realWebviewAttachEvents, 0);
  assert.equal(startup.window.webContents.listenerCount("will-attach-webview"), 1);
  assert.equal(startup.vncConfigurations, 0, "late VNC services must still be held");
  assert.deepEqual(startup.hardenedContents, []);
  assert.equal(startup.ready, true, "the usable local window is ready while remote-only services are held");
  assert.equal(startup.readyCalls, 1, "local startup readiness must be reported exactly once");
  assert.equal(startup.activateHandlers, 1, "window recreation must be armed before remote readiness");
  assert.equal(typeof startup.activateHandler, "function");
  releaseRemoteReady();
  await context.__bootstrapDone;
  assert.equal(startup.remoteCompleted, true);
  assert.equal(startup.ready, true);
  assert.equal(startup.readyCalls, 1);
  assert.equal(startup.protocolRegistrations, 1, "the relocated media protocol registration must run once");
  assert.equal(startup.earlySyncReleases, 1, "stock sync IPC must atomically take ownership after remote readiness");
  assert.equal(startup.stockSyncRegistrations, 1);
  assert.equal(startup.windows, 1, "the relocated stock window creator must run exactly once");
  assert.equal(startup.vncConfigurations, 1, "late VNC setup must catch up to the early window exactly once");
  assert.deepEqual(startup.hardenedContents, [startup.window.webContents]);
  assert.equal(startup.removedWebviewGuards, 1, "the exact temporary guard must be removed at handoff");
  assert.equal(startup.window.webContents.listenerCount("will-attach-webview"), 1, "the real hardener must own future attaches");
  const hardenedAttach = { prevented: false, preventDefault() { this.prevented = true; } };
  startup.window.webContents.emit("will-attach-webview", hardenedAttach, {}, {});
  assert.equal(hardenedAttach.prevented, false);
  assert.equal(startup.realWebviewAttachEvents, 1);
  assert.equal(startup.activateHandlers, 1, "stock activation handling must remain installed");

  const firstWindow = startup.window;
  firstWindow.destroy();
  startup.activateHandler();
  startup.activateHandler();
  await Promise.resolve();
  assert.equal(startup.windows, 2, "repeated activation must recreate exactly one window");
  assert.notEqual(startup.window, firstWindow);
  assert.equal(startup.vncConfigurations, 2, "the recreated window must use the ready VNC service");
  assert.deepEqual(startup.hardenedContents, [firstWindow.webContents, startup.window.webContents]);
  assert.equal(startup.window.webContents.listenerCount("will-attach-webview"), 1);
  assert.equal(startup.activateHandlers, 1, "activation registration must not duplicate");
});

test("early webview denial survives a throwing real hardener", async () => {
  let releaseRemoteReady;
  const remoteReady = new Promise(resolve => {
    releaseRemoteReady = resolve;
  });
  const hardenerFailure = new Error("synthetic hardener failure");
  const { context, startup } = startSyntheticMain(remoteReady, { hardenerFailure });
  await Promise.resolve();
  assert.equal(startup.ready, true);
  assert.equal(startup.readyCalls, 1);

  const rejected = assert.rejects(context.__bootstrapDone, error => error === hardenerFailure);
  releaseRemoteReady();
  await rejected;

  assert.deepEqual(startup.remoteFailures, [hardenerFailure]);
  assert.equal(startup.removedWebviewGuards, 0, "a failed handoff must retain the deny guard");
  assert.deepEqual(startup.hardenedContents, []);
  assert.equal(startup.window.webContents.listenerCount("will-attach-webview"), 1);
  const blockedAttach = { prevented: false, preventDefault() { this.prevented = true; } };
  startup.window.webContents.emit("will-attach-webview", blockedAttach, {}, {});
  assert.equal(blockedAttach.prevented, true);
  assert.equal(startup.realWebviewAttachEvents, 0);
});

test("a remote failure after local readiness remains captured", async () => {
  let rejectRemoteReady;
  const remoteReady = new Promise((_resolve, reject) => {
    rejectRemoteReady = reject;
  });
  const remoteFailure = new Error("synthetic remote readiness failure");
  const { context, startup } = startSyntheticMain(remoteReady);
  await Promise.resolve();
  assert.equal(startup.ready, true);
  assert.equal(startup.readyCalls, 1);

  const rejected = assert.rejects(context.__bootstrapDone, error => error === remoteFailure);
  rejectRemoteReady(remoteFailure);
  await rejected;

  assert.equal(startup.ready, true, "a usable local window remains ready");
  assert.equal(startup.readyCalls, 1);
  assert.deepEqual(startup.remoteFailures, [remoteFailure]);
  assert.equal(startup.remoteCompleted, false);
  assert.equal(startup.earlySyncReleases, 0, "failed remote startup must retain local bootstrap sync IPC");
  assert.equal(startup.stockSyncRegistrations, 0);
  assert.equal(startup.activateHandlers, 1, "remote failure must not remove local window recreation");
  const failedBootstrapWindow = startup.window;
  failedBootstrapWindow.destroy();
  startup.activateHandler();
  startup.activateHandler();
  await Promise.resolve();
  assert.equal(startup.windows, 2, "activation after remote failure must create exactly one local window");
  assert.notEqual(startup.window, failedBootstrapWindow);
  assert.equal(startup.vncConfigurations, 0, "remote VNC remains unavailable after the failed gate");
  const blockedAttach = { prevented: false, preventDefault() { this.prevented = true; } };
  startup.window.webContents.emit("will-attach-webview", blockedAttach, {}, {});
  assert.equal(blockedAttach.prevented, true, "the recreated local window must remain fail-closed");
  assert.equal(startup.activateHandlers, 1);
});

test("desktop packaging includes every direct inference runtime module in the audited ASAR", () => {
  const { DESKTOP_FILES } = require(patchPath);
  const { ALLOWED_MUTATIONS } = require(path.join(__dirname, "..", "scripts", "patch-app.cjs"));
  const required = [
    "bridge/inference-socket-client.cjs",
    "desktop/bot-deletion-coordinator.cjs",
    "desktop/local-automation-controller.cjs",
    "desktop/local-automation-native-io.cjs",
    "desktop/local-automation-store.cjs",
    "desktop/local-cron-schedule.cjs",
    "desktop/cliproxy-inference-transport.cjs",
    "desktop/codex-account-controller.cjs",
    "desktop/codex-app-server-manager.cjs",
    "desktop/codex-direct-inference-transport.cjs",
    "desktop/codex-runtime-integrity.cjs",
    "desktop/inference-bridge-server.cjs",
    "desktop/inference-provider-router.cjs",
    "desktop/keychain-secret-store.cjs",
    "desktop/local-desktop-frame-ipc.cjs",
    "desktop/openai-compatible-inference-transport.cjs",
    "desktop/openai-compatible-provider.cjs",
    "desktop/openbot-native-coordinator-ipc.cjs",
    "desktop/openbot-native-coordinator.cjs",
    "desktop/provider-controller.cjs",
    "desktop/provider-state-store.cjs",
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
  const { DESKTOP_FILES, SHARED_FILES } = require(patchPath);
  const sourceRoot = path.join(__dirname, "..", "src");
  const sharedSourceRoot = path.resolve(sourceRoot, "..", "..", "src");
  const packaged = new Set([...DESKTOP_FILES, ...SHARED_FILES]);
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
  assert.deepEqual(SHARED_FILES, ["provider-descriptors.cjs"]);
  for (const relative of SHARED_FILES) {
    const source = fs.readFileSync(path.join(sharedSourceRoot, relative), "utf8");
    for (const match of source.matchAll(relativeRequire)) {
      let dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match.groups.request));
      if (path.posix.extname(dependency) === "") dependency += ".cjs";
      assert.equal(packaged.has(dependency), true, `${relative} requires ${dependency}`);
    }
  }
});
