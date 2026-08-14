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

test("approved CSS keeps Max blue, Ultra purple-blue, compact sizing, and reduced motion", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const botUi = fs.readFileSync(botUiPath, "utf8");
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*width:\s*min\(360px,/s);
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*color:\s*#eee[^}]*background:\s*#242424/s);
  assert.doesNotMatch(css, /\bCanvas(?:Text)?\b/);
  assert.match(css, /\.codex-reasoning-control\.is-max[^}]*#2383ff/s);
  assert.match(css, /\.codex-reasoning-ultra-fill[^}]*linear-gradient\([^)]*#2383ff[^)]*(?:#7c3aed|#8b5cf6)[^)]*#2383ff/s);
  assert.match(css, /\.codex-reasoning-control\.is-ultra-entering[^}]*\.codex-reasoning-burst/s);
  assert.match(css, /@keyframes\s+codex-ultra-flow/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none\s*!important/);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)/);
  assert.doesNotMatch(css, /url\(|data:image|\/Users\/|\/private\/tmp\//);
  assert.match(botUi, /"button",\s*"codex-bot-rename-action",\s*"Rename"/);
  assert.match(botUi, /rename\.addEventListener\("keydown"[\s\S]*event\.key === "Enter"/);
});
