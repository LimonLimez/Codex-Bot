"use strict";

const path = require("node:path");
const { app, BrowserWindow } = require("electron");

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

async function main() {
  const output = path.resolve(argument("output", "renderer-panel.png"));
  const width = Number(argument("width", "1024"));
  const height = Number(argument("height", "680"));
  const effort = argument("effort", "medium");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || height < 480
    || !new Set(["medium", "max", "ultra", "ultra-code"]).has(effort)) {
    throw new Error("Visual capture arguments are invalid.");
  }
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    backgroundColor: "#181818",
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  const fixture = path.join(__dirname, "..", "fixtures", "renderer-panel.html");
  await window.loadFile(fixture, { query: { effort } });
  await window.webContents.executeJavaScript(`(() => {
    const slider = document.querySelector(".codex-reasoning-input");
    const model = document.querySelector(".codex-model-select");
    const positions = { medium: 1, max: 4, ultra: 5, "ultra-code": 5 };
    if (!slider || !model) throw new Error("Reasoning control did not mount.");
    if (${JSON.stringify(effort)} === "ultra-code") {
      model.value = "claude-fable-5";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    }
    slider.value = String(positions[${JSON.stringify(effort)}]);
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await new Promise((resolve) => setTimeout(resolve, effort === "ultra" || effort === "ultra-code" ? 700 : 150));
  const image = await window.webContents.capturePage();
  require("node:fs").writeFileSync(output, image.toPNG(), { mode: 0o600 });
  window.destroy();
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
