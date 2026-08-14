"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { replaceUnique } = require("./anchors.cjs");

const ASSETS = Object.freeze([
  "bot-runtime-ui.js",
  "codex-ui.css",
  "model-controls.js",
  "reasoning-control.js",
]);
const TITLE = "<title>Grok Bot</title>";
const CODEX_TITLE = "<title>Codex Bot</title>";
const HEAD_END = "  </head>";
const CODEX_HEAD = `    <link rel="stylesheet" href="./codex/codex-ui.css">
    <script src="./codex/model-controls.js" defer></script>
    <script src="./codex/reasoning-control.js" defer></script>
    <script src="./codex/bot-runtime-ui.js" defer></script>
  </head>`;

function patchRendererIndexSource(source) {
  if (typeof source !== "string" || source.length < 1 || source.length > 1_000_000) {
    throw new Error("Grok renderer index is invalid");
  }
  if (source.includes("./codex/") || source.includes(CODEX_TITLE)) {
    throw new Error("Codex renderer controls are already installed");
  }
  let patched = replaceUnique(source, TITLE, CODEX_TITLE, "Grok renderer title");
  patched = replaceUnique(patched, HEAD_END, CODEX_HEAD, "Grok renderer head");
  return patched;
}

function realDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function patchRenderer(extractedRoot) {
  const root = path.resolve(extractedRoot);
  const renderer = path.join(root, "dist", "renderer");
  realDirectory(root, "Extracted app");
  realDirectory(renderer, "Grok renderer");
  const index = path.join(renderer, "index.html");
  const indexStat = fs.lstatSync(index);
  if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
    throw new Error("Grok renderer index must be a real file");
  }
  const target = path.join(renderer, "codex");
  if (fs.existsSync(target)) throw new Error("Codex renderer asset target already exists");
  const sourceRoot = path.resolve(__dirname, "..", "renderer");
  realDirectory(sourceRoot, "Codex renderer source");
  fs.mkdirSync(target, { mode: 0o755 });
  for (const asset of ASSETS) {
    const source = path.join(sourceRoot, asset);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Codex renderer asset is invalid: ${asset}`);
    }
    fs.copyFileSync(source, path.join(target, asset), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(target, asset), 0o644);
  }
  const patched = patchRendererIndexSource(fs.readFileSync(index, "utf8"));
  fs.writeFileSync(index, patched, { encoding: "utf8", mode: indexStat.mode & 0o777 });
}

module.exports = { ASSETS, patchRenderer, patchRendererIndexSource };
