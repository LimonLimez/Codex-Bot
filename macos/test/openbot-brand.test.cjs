"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(macRoot, relative), "utf8");

test("macOS package and patched shell use the exact OpenBot release identity", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.name, "openbot-macos");
  assert.equal(packageJson.version, "0.2.0-macos.1");
  assert.match(packageJson.description, /^OpenBot\b/);

  const patcher = read("scripts/patch-app.cjs");
  assert.match(patcher, /RELEASE_VERSION\s*=\s*"0\.2\.0-macos\.1"/);
  assert.match(patcher, /productName\s*=\s*"OpenBot"/);
  assert.match(patcher, /description\s*=\s*"OpenBot desktop agent"/);

  const rendererPatch = read("src/patch/renderer.cjs");
  assert.match(rendererPatch, /<title>OpenBot<\/title>/);
  assert.doesNotMatch(rendererPatch, /<title>Codex Bot<\/title>/);

  const runtime = read("src/desktop/runtime.cjs");
  assert.match(runtime, /setName\?\.\("OpenBot"\)/);
  assert.doesNotMatch(runtime, /setName\?\.\("Codex Bot"\)/);
});

test("OpenBot provider clients and public reports distinguish product from OpenAI Codex", () => {
  const appServer = read("src/desktop/codex-app-server-manager.cjs");
  const remoteClient = read("src/bots/remote-app-server-client.cjs");
  const report = read("src/bots/remote-provider-live-report.cjs");
  const renderer = read("src/renderer/bot-runtime-ui.js");

  assert.match(appServer, /title:\s*"OpenBot"/);
  assert.match(remoteClient, /title:\s*"OpenBot"/);
  assert.match(report, /# OpenBot Remote Provider Live Gate/);
  assert.match(renderer, /OpenAI Codex/);
  assert.doesNotMatch(renderer, /aria-label=[^\n]*Codex Bot|Codex Bot bot/i);
});

test("installer and DMG sources expose only the versioned OpenBot release identity", () => {
  const builder = read("scripts/build-installer-app.cjs");
  const packageDmg = read("scripts/package-dmg.cjs");
  const core = read("installer/Sources/InstallerCore/InstallerCore.swift");
  const installer = read("installer/Sources/InstallCodexBot/main.swift");

  for (const source of [builder, core, installer]) {
    assert.match(source, /OpenBot/);
  }
  assert.match(builder, /com\.limonlimez\.openbot\.installer/);
  assert.match(builder, /0\.2\.0-macos\.1/);
  assert.match(core, /OpenBot\.app/);
  assert.match(core, /com\.limonlimez\.openbot/);
  assert.match(packageDmg, /OpenBot-0\.2\.0-macos\.1\.dmg/);
  assert.match(packageDmg, /OpenBot Installer/);

  for (const source of [builder, packageDmg, core, installer]) {
    assert.doesNotMatch(source, /Install Codex Bot|Codex Bot Installer|Codex Bot\.app/);
  }
});

test("public macOS documents name OpenBot and disclose legacy implementation identifiers", () => {
  for (const relative of ["README.md", "PRIVACY.md", "NOTICE.md"]) {
    const source = read(relative);
    assert.match(source, /OpenBot/);
    assert.match(source, /legacy|compatib/i);
    assert.doesNotMatch(source, /Codex Bot for macOS|Codex Bot DMG|separate Codex Bot application/);
  }
});
