"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const patchPath = path.join(macRoot, "src", "patch", "renderer.cjs");
const cssPath = path.join(macRoot, "src", "renderer", "codex-ui.css");
const botUiPath = path.join(macRoot, "src", "renderer", "bot-runtime-ui.js");
const visualRuntimePath = path.join(macRoot, "test", "visual", "renderer-panel-runtime.cjs");
const visualFixturePath = path.join(macRoot, "test", "fixtures", "renderer-panel.html");

const STOCK_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Grok Bot</title>
    <script type="module" crossorigin src="./assets/index-CphCyQnY.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-DTIy1z2L.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-renderer-patch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("stock renderer index receives one self-hosted Codex control layer", () => {
  const { patchRendererIndexSource } = require(patchPath);
  const patched = patchRendererIndexSource(STOCK_INDEX);
  assert.match(patched, /<title>OpenBot<\/title>/);
  assert.equal((patched.match(/\.\/codex\/codex-ui\.css/g) ?? []).length, 1);
  for (const file of [
    "model-controls.js", "reasoning-control.js", "openbot-local-desktop-view.js", "bot-runtime-ui.js",
  ]) {
    assert.equal((patched.match(new RegExp(`\\.\\/codex\\/${file.replace(".", "\\.")}`, "g")) ?? []).length, 1);
  }
  assert.match(patched, /assets\/index-CphCyQnY\.js/);
  assert.match(patched, /assets\/index-DTIy1z2L\.css/);
  assert.match(patched, /<div id="root"><\/div>/);
  assert.throws(() => patchRendererIndexSource(patched), /already|anchor|Codex/i);
  assert.throws(
    () => patchRendererIndexSource(STOCK_INDEX.replace("Grok Bot", "Other")),
    /title|anchor|Grok/i,
  );
});

test("renderer patch copies only the reviewed control assets into a synthetic stock tree", (t) => {
  const { patchRenderer } = require(patchPath);
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "dist", "renderer"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "renderer", "index.html"), STOCK_INDEX);
  patchRenderer(root);
  const target = path.join(root, "dist", "renderer", "codex");
  assert.deepEqual(fs.readdirSync(target).sort(), [
    "bot-runtime-ui.js",
    "codex-ui.css",
    "model-controls.js",
    "openbot-local-desktop-view.css",
    "openbot-local-desktop-view.js",
    "openbot-standalone-shell.css",
    "openbot-standalone-shell.js",
    "reasoning-control.js",
  ]);
  for (const file of fs.readdirSync(target)) {
    assert.deepEqual(
      fs.readFileSync(path.join(target, file)),
      fs.readFileSync(path.join(macRoot, "src", "renderer", file)),
    );
  }
});

test("approved CSS docks management in the sidebar and opens native Power from the composer trigger", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const botUi = fs.readFileSync(botUiPath, "utf8");
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*position:\s*relative[^}]*width:\s*100%/s);
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*color:\s*var\(--codex-text\)[^}]*background:\s*var\(--codex-surface\)/s);
  assert.match(css, /\.codex-model-dock\s*\{[^}]*position:\s*relative[^}]*width:\s*max-content/s);
  assert.match(css, /\.codex-model-trigger\s*\{[^}]*max-width:\s*210px/s);
  assert.match(css, /\.codex-power-popover\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*calc\(100% \+ 8px\)[^}]*width:\s*224px/s);
  assert.match(css, /\.codex-power-popover\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\[data-codex-mount-state="pending"\][^}]*display:\s*none/s);
  assert.doesNotMatch(css, /\.codex-bot-controls\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(css, /\.codex-bot-controls\s*\{[^}]*top:\s*12px/s);
  assert.doesNotMatch(css, /\bCanvas(?:Text)?\b/);
  assert.match(css, /\.codex-power-shell\s*\{[^}]*height:\s*32px/s);
  assert.match(css, /\.codex-power-control\s*\{[^}]*height:\s*28px/s);
  assert.match(css, /\.codex-power-track\s*\{[^}]*height:\s*24px/s);
  assert.match(css, /\.codex-power-thumb\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s);
  assert.match(css, /\.codex-power-tick\s*\{[^}]*width:\s*4px[^}]*height:\s*4px/s);
  assert.match(css, /\.codex-power-control\.is-max[^}]*#2383ff/s);
  assert.match(css, /\.codex-power-control\.is-disabled\s*\{[^}]*opacity:\s*0\.5[0-9]/s);
  assert.match(css, /\.codex-power-ultra-field\s*\{[^}]*overflow:\s*hidden[^}]*isolation:\s*isolate[^}]*linear-gradient\([^)]*#2383ff[^)]*(?:#7c3aed|#8b5cf6)/s);
  assert.match(css, /\.codex-power-ultra-field::before\s*\{[^}]*radial-gradient[^}]*mix-blend-mode:\s*screen/s);
  assert.match(css, /\.codex-power-ultra-field::after\s*\{[^}]*radial-gradient[^}]*repeating-linear-gradient[^}]*mix-blend-mode:\s*soft-light/s);
  assert.match(css, /\.codex-power-control\.is-ultra\s+\.codex-power-particles,[^}]*\.codex-power-control\.is-ultra\s+\.codex-power-burst\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.codex-power-control\.is-ultra-entering\s+\.codex-power-thumb::after\s*\{[^}]*radial-gradient[^}]*codex-power-ultra-thumb-flare/s);
  assert.match(css, /@keyframes\s+codex-power-ultra-reveal/);
  assert.match(css, /@keyframes\s+codex-power-ultra-field-a/);
  assert.match(css, /@keyframes\s+codex-power-ultra-field-b/);
  assert.match(css, /@keyframes\s+codex-power-ultra-thumb-flare/);
  assert.match(css, /\.codex-power-compact-controls\s*\{[^}]*position:\s*relative[^}]*height:\s*40px/s);
  assert.match(css, /\.codex-power-endpoints\s*\{[^}]*font-size:\s*14px[^}]*line-height:\s*20px/s);
  assert.match(
    css,
    /\.codex-power-warning\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*font-size:\s*14px[^}]*line-height:\s*20px/s,
  );
  assert.match(css, /\.codex-power-warning:not\(\[hidden\]\)\s*\{[^}]*background-clip:\s*text[^}]*animation:\s*codex-power-warning-shimmer\s+1\.1s\s+ease-out\s+both/s);
  assert.doesNotMatch(css, /\.codex-power-warning(?:[^{}]|\{[^}]*\})*animation:[^;}]*infinite/s);
  assert.match(css, /@keyframes\s+codex-power-warning-shimmer/);
  assert.match(css, /\.codex-model-dock\.is-warning[^}]*\.codex-power-(?:advanced|fast)-toggle/s);
  assert.match(css, /\.codex-power-advanced[^}]*grid-template-columns/s);
  assert.doesNotMatch(css, /\.codex-model-row[^}]*112px/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none\s*!important/);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.codex-power-particles,[\s\S]*\.codex-power-burst\s*\{[^}]*display:\s*none\s*!important/s,
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.codex-power-warning:not\(\[hidden\]\)\s*\{[^}]*background:\s*none[^}]*-webkit-text-fill-color:\s*currentColor/s,
  );
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--codex-surface:\s*#f[0-9a-f]{5}/i);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*light\)/);
  assert.match(css, /\.codex-power-fast-toggle\.is-active\s*\{[^}]*var\(--codex-blue\)/s);
  assert.doesNotMatch(css, /\.codex-model-dock\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)/);
  assert.match(css, /\.codex-bot-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/s);
  assert.match(css, /\.codex-bot-new\s*\{[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(css, /url\(|data:image|\/Users\/|\/private\/tmp\//);
  assert.match(botUi, /"button",\s*"codex-bot-rename-action",\s*"Rename"/);
  assert.match(botUi, /rename\.addEventListener\("keydown"[\s\S]*event\.key === "Enter"/);
  assert.match(botUi, /findUiMounts/);
  assert.match(botUi, /MutationObserver/);
  assert.match(botUi, /modelTrigger\.setAttribute\("aria-haspopup",\s*"dialog"\)/);
  assert.match(botUi, /composerHost\.append\?\.\(modelDock\)/);
  assert.match(botUi, /reasoningView\.control\.classList\.toggle\("is-disabled",\s*snapshot\.disabled\)/s);
  assert.match(botUi, /compactControls\.append\(advancedToggle,\s*fastToggle,\s*reasoningView\.warning\)/s);
  assert.doesNotMatch(botUi, /popover\.append\([^;]*reasoningView\.warning/s);
});

test("Computer status and actions remain legible in the dark compact panel", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const root = css.match(/:root\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";
  const color = (name) => root.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255)
      .map((part) => part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const foreground = luminance(color("codex-blue-strong"));
  const background = luminance(color("codex-surface"));
  const contrast = (Math.max(foreground, background) + 0.05)
    / (Math.min(foreground, background) + 0.05);
  assert.ok(contrast >= 4.5, `dark action contrast must be at least 4.5:1, got ${contrast.toFixed(2)}:1`);
  assert.match(
    css,
    /\.codex-computer-status\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*visible[^}]*overflow-wrap:\s*anywhere[^}]*text-overflow:\s*clip[^}]*white-space:\s*normal/s,
  );
  assert.match(
    css,
    /\.codex-computer-setup-actions\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*flex-end[^}]*gap:\s*[4-9]px/s,
  );
});

test("visual disabled and later-Ultra evidence comes from production state instead of DOM mutation", () => {
  const runtime = fs.readFileSync(visualRuntimePath, "utf8");
  const fixture = fs.readFileSync(visualFixturePath, "utf8");
  assert.match(runtime, /phase === "disabled"[\s\S]*trigger\.disabled[\s\S]*popover[^\n]*hidden/s);
  assert.match(runtime, /disabled:\s*phase === "disabled"\s*\?\s*"true"\s*:\s*"false"/s);
  assert.match(runtime, /phase === "later"[\s\S]*3300/s);
  assert.match(
    runtime,
    /phase === "entry"[\s\S]*KeyboardEvent\("keydown",\s*\{[^}]*key:\s*"Home"[^}]*\}\)[\s\S]*KeyboardEvent\("keydown",\s*\{[^}]*key:\s*"End"[^}]*\}\)[\s\S]*is-ultra-entering[\s\S]*codex-power-warning/s,
  );
  assert.doesNotMatch(runtime, /slider\.disabled\s*=|classList\.add\("is-disabled"\)/);
  assert.match(fixture, /params\.get\("disabled"\) === "true"/);
  assert.match(fixture, /selectBot\(\)[\s\S]*new Promise\(\(\) => \{\}\)/s);
  assert.match(runtime, /new-bot-setup/);
  assert.match(runtime, /New Bot profile setup did not originate from production state/);
  assert.match(runtime, /codex-new-bot-continue/);
  assert.match(runtime, /computer-setup/);
  assert.match(runtime, /computer-change/);
  assert.match(runtime, /Permission sheet did not originate from production state/);
  assert.match(fixture, /async updateProfile/);
  assert.match(fixture, /setupStage:\s*"complete"/);
  assert.match(fixture, /async create\(\)[\s\S]*setupStage:\s*"profile-model"/s);
  assert.match(fixture, /async advanceSetup\([^)]+\)[\s\S]*expectedStage[\s\S]*nextStage/s);
  assert.match(fixture, /window\.openbotComputer/);
});
