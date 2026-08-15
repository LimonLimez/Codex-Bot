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
  assert.match(patched, /<title>Codex Bot<\/title>/);
  assert.equal((patched.match(/\.\/codex\/codex-ui\.css/g) ?? []).length, 1);
  for (const file of ["model-controls.js", "reasoning-control.js", "bot-runtime-ui.js"]) {
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
    "reasoning-control.js",
  ]);
  for (const file of fs.readdirSync(target)) {
    assert.deepEqual(
      fs.readFileSync(path.join(target, file)),
      fs.readFileSync(path.join(macRoot, "src", "renderer", file)),
    );
  }
});

test("approved CSS docks management in the sidebar and model controls at the composer", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const botUi = fs.readFileSync(botUiPath, "utf8");
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*position:\s*relative[^}]*width:\s*100%/s);
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*color:\s*var\(--codex-text\)[^}]*background:\s*var\(--codex-surface\)/s);
  assert.match(css, /\.codex-model-dock\s*\{[^}]*position:\s*relative[^}]*width:\s*100%/s);
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
  assert.match(css, /\.codex-power-ultra-field[^}]*linear-gradient\([^)]*#2383ff[^)]*(?:#7c3aed|#8b5cf6)[^)]*#2383ff/s);
  assert.match(css, /\.codex-power-control\.is-ultra-entering[^}]*\.codex-power-burst/s);
  assert.match(css, /@keyframes\s+codex-power-ultra-flow/);
  assert.match(css, /\.codex-power-advanced[^}]*grid-template-columns/s);
  assert.doesNotMatch(css, /\.codex-model-row[^}]*112px/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none\s*!important/);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.codex-power-particles,[\s\S]*\.codex-power-burst\s*\{[^}]*display:\s*none\s*!important/s,
  );
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--codex-surface:\s*#f[0-9a-f]{5}/i);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*light\)/);
  assert.match(css, /\.codex-model-dock\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(
    css,
    /@container\s*\(max-width:\s*440px\)[\s\S]*\.codex-power-shell\s*\{[^}]*grid-template-areas:[^}]*height:\s*auto/s,
  );
  assert.match(css, /@media\s*\(max-width:\s*1100px\)/);
  assert.match(css, /\.codex-bot-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/s);
  assert.match(css, /\.codex-bot-new\s*\{[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(css, /url\(|data:image|\/Users\/|\/private\/tmp\//);
  assert.match(botUi, /"button",\s*"codex-bot-rename-action",\s*"Rename"/);
  assert.match(botUi, /rename\.addEventListener\("keydown"[\s\S]*event\.key === "Enter"/);
  assert.match(botUi, /findUiMounts/);
  assert.match(botUi, /MutationObserver/);
  assert.match(botUi, /reasoningView\.control\.classList\.toggle\("is-disabled",\s*snapshot\.disabled\)/s);
});
