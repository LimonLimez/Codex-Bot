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
    || !new Set(["closed", "entry", "steady", "later", "advanced", "hold", "drag", "wheel", "arrows", "focus", "hover", "disabled", "reduced", "fast-entry", "fast-steady", "fast-exit", "new-bot-setup", "computer-setup", "computer-change", "permission", "grants"]).has(phase)
    || !new Set(["standard", "priority"]).has(tier)
    || !new Set(["dark", "light"]).has(theme)
    || !new Set(["wide", "narrow"]).has(layout)
    || !new Set(["full", "minimal", "long"]).has(catalog)
    || (phase === "entry" && !new Set(["ultra", "ultra-code"]).has(effort))) {
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
    computer: phase,
  } });
  const expectedLabel = effort === "terra-light" || effort === "sol-light" ? "Light"
    : effort === "medium" ? "Standard"
      : effort === "high" ? "Extended"
        : effort === "xhigh" ? "Extra High"
          : effort === "ultra-code" ? "Ultra Code"
            : effort[0].toUpperCase() + effort.slice(1);
  const sliderRect = await window.webContents.executeJavaScript(`(async () => {
    const phase = ${JSON.stringify(phase)};
    if (phase === "new-bot-setup" || phase === "computer-setup") {
      document.querySelector(".codex-bot-new")?.click();
      await new Promise((resolve, reject) => {
        let remainingFrames = 120;
        const waitForSetup = () => {
          const setup = document.querySelector(".codex-new-bot-setup");
          if (setup && !setup.hidden) return resolve();
          if (remainingFrames-- <= 0) return reject(new Error("New Bot profile setup did not open."));
          requestAnimationFrame(waitForSetup);
        };
        waitForSetup();
      });
      const profile = document.querySelector(".codex-new-bot-setup");
      const profileTitle = document.querySelector(".codex-new-bot-setup-title");
      const name = document.querySelector(".codex-new-bot-name");
      const description = document.querySelector(".codex-new-bot-description");
      const photo = document.querySelector(".codex-new-bot-photo");
      const shape = document.querySelector(".codex-new-bot-shape");
      const color = document.querySelector(".codex-new-bot-color");
      const provider = document.querySelector(".codex-new-bot-provider");
      const model = document.querySelector(".codex-new-bot-model");
      const power = document.querySelector(".codex-new-bot-power");
      const speed = document.querySelector(".codex-new-bot-speed");
      const profileProceed = document.querySelector(".codex-new-bot-continue");
      const computerBeforeProfile = document.querySelector(".codex-computer-setup");
      if (!profile || profile.hidden || !profile.open || profileTitle?.textContent !== "Set up New Bot"
        || name?.value !== "New Bot" || name.placeholder !== "Name your Bot"
        || description?.placeholder !== "What should this Bot help with?"
        || photo?.accept !== "image/png" || shape?.options.length !== 18 || color?.options.length !== 11
        || !provider?.value || !model?.value || !power?.value || !speed?.value
        || profileProceed?.disabled || (computerBeforeProfile && !computerBeforeProfile.hidden)) {
        throw new Error("New Bot profile setup did not originate from production state.");
      }
      const profileRect = profile.getBoundingClientRect();
      if (profileRect.top < 12 || profileRect.right > innerWidth - 12
        || profileRect.bottom > innerHeight - 12 || profileRect.left < 12) {
        throw new Error("New Bot profile setup is clipped by the viewport.");
      }
      if (phase === "new-bot-setup") {
        return {
          x: Math.round(profileRect.left + profileRect.width / 2),
          y: Math.round(profileRect.top + profileRect.height / 2),
        };
      }
      name.value = "Research Bot";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      profileProceed.click();
      await new Promise((resolve, reject) => {
        let remainingFrames = 120;
        const waitForSetup = () => {
          const setup = document.querySelector(".codex-computer-setup");
          if (setup && !setup.hidden) return resolve();
          if (remainingFrames-- <= 0) return reject(new Error("Computer setup did not open after profile confirmation."));
          requestAnimationFrame(waitForSetup);
        };
        waitForSetup();
      });
      const setup = document.querySelector(".codex-computer-setup");
      const choices = [...document.querySelectorAll(".codex-computer-choice-input")];
      const proceed = document.querySelector(".codex-computer-continue");
      if (!profile.hidden || !setup || setup.hidden || choices.length !== 3 || choices.some((choice) => choice.checked)
        || !proceed?.disabled) throw new Error("Computer setup did not originate from production state.");
      const rect = setup.getBoundingClientRect();
      if (rect.top < 12 || rect.right > innerWidth - 12 || rect.bottom > innerHeight - 12 || rect.left < 12) {
        throw new Error("Computer setup is clipped by the viewport.");
      }
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }
    if (phase === "computer-change") {
      document.querySelector(".codex-computer-change")?.click();
      await new Promise((resolve, reject) => {
        let remainingFrames = 120;
        const waitForSetup = () => {
          const setup = document.querySelector(".codex-computer-setup");
          if (setup && !setup.hidden) return resolve();
          if (remainingFrames-- <= 0) return reject(new Error("Change Computer setup did not open."));
          requestAnimationFrame(waitForSetup);
        };
        waitForSetup();
      });
      const setup = document.querySelector(".codex-computer-setup");
      const cancel = document.querySelector(".codex-computer-cancel");
      const proceed = document.querySelector(".codex-computer-continue");
      if (!setup || setup.hidden || !cancel || cancel.hidden || cancel.disabled || !proceed?.disabled) {
        throw new Error("Change Computer setup did not expose its dismissible production state.");
      }
      const rect = setup.getBoundingClientRect();
      if (rect.top < 12 || rect.right > innerWidth - 12 || rect.bottom > innerHeight - 12 || rect.left < 12) {
        throw new Error("Change Computer setup is clipped by the viewport.");
      }
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }
    if (phase === "permission") {
      await new Promise((resolve, reject) => {
        let remainingFrames = 120;
        const waitForPermission = () => {
          const sheet = document.querySelector(".codex-permission-sheet");
          if (sheet && !sheet.hidden) return resolve();
          if (remainingFrames-- <= 0) return reject(new Error("Permission sheet did not open."));
          requestAnimationFrame(waitForPermission);
        };
        waitForPermission();
      });
      const sheet = document.querySelector(".codex-permission-sheet");
      if (!sheet || sheet.hidden || !/Google Chrome/.test(sheet.textContent)
        || !/Always Allow for This Bot/.test(sheet.textContent)) {
        throw new Error("Permission sheet did not originate from production state.");
      }
      const rect = sheet.getBoundingClientRect();
      const always = sheet.querySelector(".codex-permission-always")?.getBoundingClientRect();
      if (rect.top < 12 || rect.right > innerWidth - 12 || rect.bottom > innerHeight - 12 || rect.left < 12
        || !always || always.width < 136 || always.height > 56) {
        throw new Error("Permission actions are clipped or unreadable.");
      }
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }
    if (phase === "grants") {
      await new Promise((resolve, reject) => {
        let remainingFrames = 120;
        const waitForGrant = () => {
          const grant = document.querySelector(".codex-computer-grant");
          if (grant) return resolve();
          if (remainingFrames-- <= 0) return reject(new Error("Saved Computer grant did not render."));
          requestAnimationFrame(waitForGrant);
        };
        waitForGrant();
      });
      const grant = document.querySelector(".codex-computer-grant");
      const label = grant?.querySelector(".codex-computer-grant-label");
      const computerStatus = document.querySelector(".codex-computer-status");
      if (!/OpenBot Workspace/.test(grant?.textContent) || !/Revoke/.test(grant?.textContent)) {
        throw new Error("Saved Computer grant did not originate from production state.");
      }
      const rect = grant.getBoundingClientRect();
      if (rect.height > 56 || !label || label.scrollWidth > label.clientWidth
        || computerStatus?.textContent !== "Runs on this Mac"
        || computerStatus.scrollWidth > computerStatus.clientWidth) {
        throw new Error("Saved Computer grant is clipped or oversized.");
      }
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }
    const trigger = document.querySelector(".codex-model-trigger");
    if (!trigger) throw new Error("Power trigger did not mount.");
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
    if (phase === "entry") {
      const waitForPowerState = (predicate, message) => new Promise((resolve, reject) => {
        let remainingFrames = 120;
        const inspect = () => {
          if (predicate()) return resolve();
          if (remainingFrames-- <= 0) return reject(new Error(message));
          requestAnimationFrame(inspect);
        };
        inspect();
      });
      slider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
      await waitForPowerState(
        () => label.textContent !== ${JSON.stringify(expectedLabel)}
          && !document.querySelector(".codex-power-control")?.classList.contains("is-ultra"),
        "Ultra entry evidence did not leave its persisted steady state.",
      );
      slider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }));
      await waitForPowerState(
        () => label.textContent === ${JSON.stringify(expectedLabel)}
          && document.querySelector(".codex-power-control")?.classList.contains("is-ultra-entering")
          && document.querySelector(".codex-power-warning")?.hidden === false,
        "Ultra entry evidence did not originate from a user transition.",
      );
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
    : phase === "new-bot-setup" || phase === "computer-setup" || phase === "computer-change" || phase === "permission" || phase === "grants" ? 240
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
