"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { replaceUnique } = require("./anchors.cjs");

const DESKTOP_FILES = Object.freeze([
  "desktop/cliproxy-manager.cjs",
  "desktop/model-selection-store.cjs",
  "desktop/runtime.cjs",
  "bridge/codex-client.cjs",
  "bridge/message-codec.cjs",
  "bridge/redaction.cjs",
  "bridge/runtime-config.cjs",
  "bridge/server.cjs",
  "bots/bot-store.cjs",
  "bots/chatgpt-relay-codec.cjs",
  "bots/conversation-router.cjs",
  "bots/remote-app-server-client.cjs",
  "bots/runtime-controller.cjs",
  "bots/runtime-provider.cjs",
]);

const MAIN_ANCHOR = '"use strict";var fjn=Object.create;';
const MAIN_PATCH = '"use strict";require("../codex/desktop/runtime.cjs").installDesktopRuntime(require("electron"));var fjn=Object.create;';
const PRELOAD_ANCHOR = 's.contextBridge.exposeInMainWorld("desktop",Q);s.contextBridge.exposeInMainWorld("coordinatorPort",X);s.ipcRenderer.on("sand:coordinator-port",e=>';
const PRELOAD_SENTINEL = 'exposeInMainWorld("codexBots"';

const PRELOAD_PATCH = `const __codexInvoke=(method,...args)=>s.ipcRenderer.invoke("codex-bot:"+method,...args);const __codexBots=Object.freeze({list:()=>__codexInvoke("list"),create:()=>__codexInvoke("create"),adoptLegacy:value=>__codexInvoke("adopt-legacy",value),read:botId=>__codexInvoke("read",botId),rename:(botId,name)=>__codexInvoke("rename",botId,name),updateProfile:(botId,profile)=>__codexInvoke("update-profile",botId,profile),retryRuntime:botId=>__codexInvoke("retry-runtime",botId),onChanged:callback=>{if(typeof callback!=="function")throw new TypeError("Bot change listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("codex-bot:changed",listener);return()=>s.ipcRenderer.removeListener("codex-bot:changed",listener)}});const __codexRuntime=Object.freeze({connectProvider:provider=>__codexInvoke("connect-provider",provider),selectBot:botId=>__codexInvoke("select-bot",botId),readModel:botId=>__codexInvoke("read-model",botId),selectModel:selection=>__codexInvoke("select-model",selection),onEvent:callback=>{if(typeof callback!=="function")throw new TypeError("Runtime event listener must be a function.");const listener=(_event,value)=>callback(value);s.ipcRenderer.on("codex-runtime:event",listener);return()=>s.ipcRenderer.removeListener("codex-runtime:event",listener)}});s.contextBridge.exposeInMainWorld("codexBots",__codexBots);s.contextBridge.exposeInMainWorld("codexRuntime",__codexRuntime);`;

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
  return replaceUnique(source, PRELOAD_ANCHOR, `${PRELOAD_PATCH}${PRELOAD_ANCHOR}`, "Grok Electron preload facade");
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
  fs.writeFileSync(main, patchMainSource(fs.readFileSync(main, "utf8")), {
    encoding: "utf8",
    mode: mainStat.mode & 0o777,
  });
  fs.writeFileSync(preload, patchPreloadSource(fs.readFileSync(preload, "utf8")), {
    encoding: "utf8",
    mode: preloadStat.mode & 0o777,
  });
}

module.exports = { DESKTOP_FILES, patchDesktop, patchMainSource, patchPreloadSource };
