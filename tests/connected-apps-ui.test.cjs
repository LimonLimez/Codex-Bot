"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const ui = fs.readFileSync(
  path.join(root, "src", "renderer", "codex-ui.js"),
  "utf8",
);
const patcher = fs.readFileSync(
  path.join(root, "scripts", "patch-app.cjs"),
  "utf8",
);
const installer = fs.readFileSync(
  path.join(root, "installer", "CodexBot.iss"),
  "utf8",
);

test("the genuine Grok sidebar opens Open Bot connected apps instead of the vendor overlay", () => {
  assert.match(patcher, /sand-agents-sidebar__plugins-entry/);
  assert.match(patcher, /"Connected apps"/);
  assert.match(patcher, /globalThis\.OpenBotConnectedApps\?\.open\?\.\(\)/);
  assert.match(patcher, /Vendor plugin overlays are disabled/);
  assert.match(patcher, /vendor plugin command is disabled/);
});

test("connected apps use a keyboard-accessible local dialog and authenticated APIs", () => {
  assert.match(ui, /document\.createElement\("dialog"\)/);
  assert.match(ui, /aria-labelledby", "openbot-apps-title"/);
  assert.match(ui, /type="password"/);
  assert.match(ui, /\/api\/composio\/status/);
  assert.match(ui, /\/api\/composio\/toolkits/);
  assert.match(ui, /action: "authorize"/);
  assert.match(ui, /App OAuth tokens stay with Composio/);
  assert.doesNotMatch(ui, /src="\$\{item\.logo\}"/);
});

test("the installer carries the local Composio manager but no Composio credentials", () => {
  assert.match(
    installer,
    /Source: "\.\.\\src\\composio-manager\.cjs"; DestDir: "\{app\}\\tools\\src"/,
  );
  assert.doesNotMatch(installer, /composio\\config\.json/i);
});
