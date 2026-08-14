"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const patchPath = path.join(__dirname, "..", "src", "patch", "desktop.cjs");

const STOCK_MAIN = "const setup='stock';\n\"use strict\";var fjn=Object.create;const mainFeature='kept';\n";
const STOCK_PRELOAD = "const stock='kept';s.contextBridge.exposeInMainWorld(\"desktop\",Q);s.contextBridge.exposeInMainWorld(\"coordinatorPort\",X);s.ipcRenderer.on(\"sand:coordinator-port\",e=>{});\n";

test("desktop patch adds isolated main/preload facades without changing stock exports", () => {
  const { patchMainSource, patchPreloadSource } = require(patchPath);
  const main = patchMainSource(STOCK_MAIN);
  const preload = patchPreloadSource(STOCK_PRELOAD);
  assert.match(main, /\.\.\/codex\/desktop\/runtime\.cjs/);
  assert.match(main, /installDesktopRuntime/);
  assert.match(main, /mainFeature='kept'/);
  assert.match(preload, /exposeInMainWorld\("desktop",Q\)/);
  assert.match(preload, /exposeInMainWorld\("coordinatorPort",X\)/);
  assert.match(preload, /exposeInMainWorld\("codexBots"/);
  assert.match(preload, /exposeInMainWorld\("codexRuntime"/);
  assert.match(preload, /codex-bot:changed/);
  assert.match(preload, /codex-runtime:event/);
  assert.match(preload, /onEvent:callback/);
  assert.match(preload, /connectProvider:provider/);
  assert.match(preload, /create:\(\)=>__codexInvoke\("create"\)/);
  assert.throws(() => patchMainSource(main), /already|anchor/i);
  assert.throws(() => patchPreloadSource(preload), /already|anchor/i);
});
