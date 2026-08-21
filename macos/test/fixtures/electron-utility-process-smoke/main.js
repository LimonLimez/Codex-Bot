"use strict";

const { app, utilityProcess } = require("electron");

const transportPath = process.argv[3];
const childPath = process.argv[4];
const workspacePath = process.argv[5];
let child;
let finished = false;

function finish(code, value) {
  if (finished) return;
  finished = true;
  process.stdout.write(`OPENBOT_ELECTRON_SMOKE:${JSON.stringify(value)}\n`);
  try { child?.kill?.(); } catch {}
  app.quit();
  process.exitCode = code;
}

app.commandLine.appendSwitch("no-sandbox");
app.whenReady().then(async () => {
  try {
    const { createLocalHelperTransport } = require(transportPath);
    const transport = await createLocalHelperTransport({
      spawnHelper(modulePath, args, options) {
        child = utilityProcess.fork(modulePath, args, options);
        return child;
      },
      childPath,
      botId: "bot-11111111-1111-4111-8111-111111111111",
      targetId: "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      targetGeneration: 1,
      workspacePath,
      startupTimeoutMs: 1_500,
    });
    const closed = transport.isClosed?.() ?? null;
    transport.dispose();
    finish(0, { outcome: "resolved", closed });
  } catch (error) {
    finish(0, { outcome: "rejected", code: error?.code ?? null });
  }
});

app.on("window-all-closed", () => {});
