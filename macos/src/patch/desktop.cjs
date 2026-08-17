"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { replaceUnique } = require("./anchors.cjs");

const DESKTOP_FILES = Object.freeze([
  "desktop/bot-deletion-coordinator.cjs",
  "desktop/cliproxy-manager.cjs",
  "desktop/cliproxy-inference-transport.cjs",
  "desktop/codex-account-controller.cjs",
  "desktop/codex-app-server-manager.cjs",
  "desktop/codex-direct-inference-transport.cjs",
  "desktop/codex-runtime-integrity.cjs",
  "desktop/inference-bridge-server.cjs",
  "desktop/inference-provider-router.cjs",
  "desktop/local-automation-controller.cjs",
  "desktop/local-automation-native-io.cjs",
  "desktop/local-automation-store.cjs",
  "desktop/local-cron-schedule.cjs",
  "desktop/local-desktop-frame-ipc.cjs",
  "desktop/model-selection-store.cjs",
  "desktop/openbot-native-coordinator-ipc.cjs",
  "desktop/openbot-native-coordinator.cjs",
  "desktop/openbot-user-data.cjs",
  "desktop/runtime.cjs",
  "desktop/standalone-conversation-controller.cjs",
  "desktop/standalone-conversation-ipc.cjs",
  "desktop/standalone-conversation-store.cjs",
  "desktop/standalone-subagent-runner.cjs",
  "bridge/codex-client.cjs",
  "bridge/inference-socket-client.cjs",
  "bridge/message-codec.cjs",
  "bridge/redaction.cjs",
  "bridge/runtime-config.cjs",
  "bridge/server.cjs",
  "computer/computer-target-router.cjs",
  "bots/bot-store.cjs",
  "bots/chatgpt-relay-codec.cjs",
  "bots/conversation-router.cjs",
  "bots/remote-app-server-client.cjs",
  "bots/runtime-controller.cjs",
  "bots/runtime-provider.cjs",
  "local/local-computer-boundary.cjs",
  "local/local-computer-runtime.cjs",
  "local/local-desktop-manager.cjs",
  "local/local-helper-child.cjs",
  "local/local-helper-protocol.cjs",
  "local/local-helper-transport.cjs",
  "local/local-permission-broker.cjs",
  "local/local-permission-store.cjs",
  "renderer/chat-content.js",
]);
const WS_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "browser.js",
  "index.js",
  "lib/buffer-util.js",
  "lib/constants.js",
  "lib/event-target.js",
  "lib/extension.js",
  "lib/limiter.js",
  "lib/permessage-deflate.js",
  "lib/receiver.js",
  "lib/sender.js",
  "lib/stream.js",
  "lib/subprotocol.js",
  "lib/validation.js",
  "lib/websocket-server.js",
  "lib/websocket.js",
  "package.json",
  "wrapper.mjs",
]);

const MAIN_ANCHOR = '"use strict";var fjn=Object.create;';
const MAIN_PATCH = '"use strict";require("../codex/desktop/runtime.cjs").installDesktopRuntime(require("electron"));var fjn=Object.create;';
const COORDINATOR_REQUEST_ANCHOR = 'L=M({invokeRequest:()=>{s.ipcRenderer.invoke("sand:coordinator-port-request")}})';
const COORDINATOR_REQUEST_PATCH = 'L=M({invokeRequest:()=>{s.ipcRenderer.invoke("openbot:coordinator-port-request")}})';
const PRELOAD_ANCHOR = 's.contextBridge.exposeInMainWorld("desktop",Q);s.contextBridge.exposeInMainWorld("coordinatorPort",X);s.ipcRenderer.on("sand:coordinator-port",e=>';
const OPENBOT_PRELOAD_ANCHOR = 's.contextBridge.exposeInMainWorld("desktop",Q);s.contextBridge.exposeInMainWorld("coordinatorPort",X);s.contextBridge.exposeInMainWorld("openbotProtocol",Object.freeze({schemaVersion:1,mode:"local-protocol"}));s.ipcRenderer.on("openbot:coordinator-port",e=>';
const PRELOAD_SENTINEL = 'exposeInMainWorld("codexBots"';

const PRELOAD_PATCH = `const __codexInvoke=(method,...args)=>s.ipcRenderer.invoke("codex-bot:"+method,...args);const __codexAccountInvoke=(method,...args)=>s.ipcRenderer.invoke("codex-account:"+method,...args);const __openbotComputerInvoke=(method,...args)=>s.ipcRenderer.invoke("openbot-computer:"+method,...args);const __codexBots=Object.freeze({list:()=>__codexInvoke("list"),create:()=>__codexInvoke("create"),adoptLegacy:value=>__codexInvoke("adopt-legacy",value),read:botId=>__codexInvoke("read",botId),rename:(botId,name)=>__codexInvoke("rename",botId,name),updateProfile:(botId,profile)=>__codexInvoke("update-profile",botId,profile),advanceSetup:value=>__codexInvoke("advance-setup",value),retryRuntime:botId=>__codexInvoke("retry-runtime",botId),onChanged:callback=>{if(typeof callback!=="function")throw new TypeError("Bot change listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("codex-bot:changed",listener);return()=>s.ipcRenderer.removeListener("codex-bot:changed",listener)}});const __codexRuntime=Object.freeze({connectProvider:provider=>__codexInvoke("connect-provider",provider),selectBot:botId=>__codexInvoke("select-bot",botId),readModel:botId=>__codexInvoke("read-model",botId),selectModel:selection=>__codexInvoke("select-model",selection),onEvent:callback=>{if(typeof callback!=="function")throw new TypeError("Runtime event listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("codex-runtime:event",listener);return()=>s.ipcRenderer.removeListener("codex-runtime:event",listener)}});const __codexAccount=Object.freeze({read:()=>__codexAccountInvoke("read"),login:mode=>__codexAccountInvoke("login",mode),cancelLogin:()=>__codexAccountInvoke("login-cancel"),logout:()=>__codexAccountInvoke("logout"),retry:()=>__codexAccountInvoke("retry"),catalog:()=>s.ipcRenderer.invoke("codex-catalog:list"),onChanged:callback=>{if(typeof callback!=="function")throw new TypeError("Account change listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("codex-account:changed",listener);return()=>s.ipcRenderer.removeListener("codex-account:changed",listener)},onCatalogChanged:callback=>{if(typeof callback!=="function")throw new TypeError("Catalog change listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("codex-catalog:changed",listener);return()=>s.ipcRenderer.removeListener("codex-catalog:changed",listener)}});const __openbotComputer=Object.freeze({selectMode:value=>__openbotComputerInvoke("select-mode",value),read:botId=>__openbotComputerInvoke("read",botId),decidePermission:value=>__openbotComputerInvoke("permission-decide",value),listPermissionRequests:botId=>__openbotComputerInvoke("permission-requests-list",botId),listPermissions:botId=>__openbotComputerInvoke("permissions-list",botId),revokePermission:value=>__openbotComputerInvoke("permission-revoke",value),onChanged:callback=>{if(typeof callback!=="function")throw new TypeError("Computer change listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("openbot-computer:changed",listener);return()=>s.ipcRenderer.removeListener("openbot-computer:changed",listener)},onPermissionRequested:callback=>{if(typeof callback!=="function")throw new TypeError("Computer permission listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("openbot-computer:permission-requested",listener);return()=>s.ipcRenderer.removeListener("openbot-computer:permission-requested",listener)}});s.contextBridge.exposeInMainWorld("codexBots",__codexBots);s.contextBridge.exposeInMainWorld("codexRuntime",__codexRuntime);s.contextBridge.exposeInMainWorld("codexAccount",__codexAccount);s.contextBridge.exposeInMainWorld("openbotComputer",__openbotComputer);`;
const STANDALONE_PRELOAD_PATCH = `const __openbotConversationInvoke=(method,...args)=>s.ipcRenderer.invoke("openbot-conversation:"+method,...args);const __openbotConversations=Object.freeze({list:botId=>__openbotConversationInvoke("list",botId),create:value=>__openbotConversationInvoke("create",value),read:value=>__openbotConversationInvoke("read",value),send:value=>__openbotConversationInvoke("send",value),cancel:value=>__openbotConversationInvoke("cancel",value),onChanged:callback=>{if(typeof callback!=="function")throw new TypeError("Conversation change listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("openbot-conversation:changed",listener);return()=>s.ipcRenderer.removeListener("openbot-conversation:changed",listener)},onEvent:callback=>{if(typeof callback!=="function")throw new TypeError("Conversation event listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("openbot-conversation:event",listener);return()=>s.ipcRenderer.removeListener("openbot-conversation:event",listener)}});s.contextBridge.exposeInMainWorld("openbotConversations",__openbotConversations);`;
const LOCAL_FRAME_PRELOAD_PATCH = `const __openbotLocalDesktop=Object.freeze({select:value=>s.ipcRenderer.invoke("openbot-local-frame:select",value),clear:value=>s.ipcRenderer.invoke("openbot-local-frame:clear",value),onFrame:callback=>{if(typeof callback!=="function")throw new TypeError("Local Desktop frame listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("openbot-local-frame:frame",listener);return()=>s.ipcRenderer.removeListener("openbot-local-frame:frame",listener)}});s.contextBridge.exposeInMainWorld("openbotLocalDesktop",__openbotLocalDesktop);`;

function patchMainSource(source) {
  if (typeof source !== "string" || source.includes("codex/desktop/runtime.cjs")) {
    throw new Error("Codex desktop main patch is already installed or invalid.");
  }
  return replaceUnique(source, MAIN_ANCHOR, MAIN_PATCH, "Grok Electron main runtime");
}

function patchPreloadSource(source) {
  if (typeof source !== "string" || source.includes(PRELOAD_SENTINEL)) {
    throw new Error("Codex desktop preload patch is already installed or invalid.");
  }
  const coordinator = replaceUnique(
    source,
    COORDINATOR_REQUEST_ANCHOR,
    COORDINATOR_REQUEST_PATCH,
    "Grok Electron coordinator request",
  );
  return replaceUnique(
    coordinator,
    PRELOAD_ANCHOR,
    `${PRELOAD_PATCH}${STANDALONE_PRELOAD_PATCH}${LOCAL_FRAME_PRELOAD_PATCH}${OPENBOT_PRELOAD_ANCHOR}`,
    "Grok Electron preload facade",
  );
}

function realFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file.`);
  return stat;
}

function patchDesktop(extractedRoot) {
  const root = path.resolve(extractedRoot);
  const main = path.join(root, "dist", "electron-main", "main.cjs");
  const preload = path.join(root, "dist", "electron-preload", "preload.cjs");
  const mainStat = realFile(main, "Grok Electron main");
  const preloadStat = realFile(preload, "Grok Electron preload");
  const targetRoot = path.join(root, "dist", "codex");
  if (fs.existsSync(targetRoot)) throw new Error("Codex desktop target already exists.");
  const sourceRoot = path.resolve(__dirname, "..");
  for (const relative of DESKTOP_FILES) {
    const source = path.join(sourceRoot, ...relative.split("/"));
    realFile(source, `Codex desktop source ${relative}`);
    const target = path.join(targetRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o644);
  }
  const wsRoot = path.resolve(sourceRoot, "..", "node_modules", "ws");
  for (const relative of WS_FILES) {
    const source = path.join(wsRoot, ...relative.split("/"));
    realFile(source, `Pinned ws source ${relative}`);
    const target = path.join(targetRoot, "node_modules", "ws", ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o644);
  }
  fs.writeFileSync(main, patchMainSource(fs.readFileSync(main, "utf8")), {
    encoding: "utf8",
    mode: mainStat.mode & 0o777,
  });
  fs.writeFileSync(preload, patchPreloadSource(fs.readFileSync(preload, "utf8")), {
    encoding: "utf8",
    mode: preloadStat.mode & 0o777,
  });
}

module.exports = { DESKTOP_FILES, WS_FILES, patchDesktop, patchMainSource, patchPreloadSource };
