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
  const phase = argument("phase", "steady");
  const tier = argument("tier", "standard");
  const theme = argument("theme", "dark");
  const layout = argument("layout", "wide");
  const catalog = argument("catalog", "full");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || height < 480
    || !new Set(["terra-light", "sol-light", "medium", "high", "xhigh", "max", "ultra", "ultra-code"]).has(effort)
    || !new Set(["closed", "entry", "steady", "later", "advanced", "hold", "drag", "wheel", "arrows", "focus", "hover", "disabled", "reduced", "fast-entry", "fast-steady", "fast-exit"]).has(phase)
    || !new Set(["standard", "priority"]).has(tier)
    || !new Set(["dark", "light"]).has(theme)
    || !new Set(["wide", "narrow"]).has(layout)
    || !new Set(["full", "minimal", "long"]).has(catalog)) {
    throw new Error("Visual capture arguments are invalid.");
  }
  if (phase === "reduced") app.commandLine.appendSwitch("force-prefers-reduced-motion", "reduce");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    backgroundColor: theme === "light" ? "#f4f5f7" : "#181818",
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  const fixture = path.join(__dirname, "..", "fixtures", "renderer-panel.html");
  const initialTier = phase === "fast-entry" ? "standard"
    : phase === "fast-exit" ? "priority"
      : tier;
  await window.loadFile(fixture, { query: {
    effort,
    tier: initialTier,
    theme,
    layout,
    catalog,
    disabled: phase === "disabled" ? "true" : "false",
  } });
  const expectedLabel = effort === "terra-light" || effort === "sol-light" ? "Light"
    : effort === "medium" ? "Standard"
      : effort === "high" ? "Extended"
        : effort === "xhigh" ? "Extra High"
          : effort === "ultra-code" ? "Ultra Code"
            : effort[0].toUpperCase() + effort.slice(1);
  const sliderRect = await window.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector(".codex-model-trigger");
    if (!trigger) throw new Error("Power trigger did not mount.");
    const phase = ${JSON.stringify(phase)};
    if (phase === "closed" || phase === "disabled") {
      const popover = document.querySelector(".codex-power-popover");
      if (trigger.getAttribute("aria-expanded") !== "false"
        || !popover?.hidden) {
        throw new Error("Power popover did not begin closed.");
      }
      if (phase === "disabled" && !trigger.disabled) {
        throw new Error("Disabled evidence did not originate from production state.");
      }
      if (phase === "disabled" && !/Choose model/.test(trigger.textContent)) {
        throw new Error("Pending selection evidence exposed an unconfirmed model.");
      }
      const rect = trigger.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }
    trigger.click();
    if (trigger.getAttribute("aria-expanded") !== "true"
      || document.querySelector(".codex-power-popover")?.hidden) {
      throw new Error("Power popover did not open from the composer trigger.");
    }
    const slider = document.querySelector(".codex-power-input");
    const label = document.querySelector(".codex-power-label");
    if (!slider || !label) throw new Error("Power control did not mount.");
    if (label.textContent !== ${JSON.stringify(expectedLabel)}) {
      throw new Error("Power control did not render the requested state.");
    }
    if (phase === "advanced") document.querySelector(".codex-power-advanced-toggle")?.click();
    if (phase === "hold") slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    if (phase === "drag") {
      slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      slider.value = String(Math.min(Number(slider.max), Number(slider.value) + 2));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (phase === "wheel") slider.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    if (phase === "arrows") {
      slider.focus();
      slider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    }
    if (phase === "focus") slider.focus();
    if (phase === "fast-entry") {
      document.querySelector(".codex-power-fast-toggle")?.click();
    }
    if (phase === "fast-exit") {
      document.querySelector(".codex-power-fast-toggle")?.click();
    }
    const rect = slider.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (phase === "hover") {
    window.webContents.sendInputEvent({ type: "mouseMove", x: sliderRect.x, y: sliderRect.y, movementX: 0, movementY: 0 });
  }
  const delay = phase === "entry" || phase === "fast-entry" ? 280
    : phase === "hold" ? 560
      : phase === "later" ? 3300
      : phase === "fast-steady" || tier === "priority" ? 720
      : (effort === "ultra" || effort === "ultra-code") ? 2300 : 180;
  await new Promise((resolve) => setTimeout(resolve, delay));
  const image = await window.webContents.capturePage();
  require("node:fs").writeFileSync(output, image.toPNG(), { mode: 0o600 });
  window.destroy();
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
