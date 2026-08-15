"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const auditPath = path.join(__dirname, "..", "scripts", "audit-release.cjs");
const packagePath = path.join(__dirname, "..", "scripts", "package-dmg.cjs");

test("release audit rejects state, secrets, personal paths, symlinks, and extra roots", () => {
  const { auditTree, writeInstallerManifest } = require(auditPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-release-audit-test-"));
  const app = path.join(root, "Install Codex Bot DEVELOPMENT.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "InstallCodexBot"), "safe\n");
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "safe\n");
  writeInstallerManifest(app);
  assert.doesNotThrow(() => auditTree(root, { expectedAppName: path.basename(app) }));

  const reject = (relative, contents = "unsafe\n", makeLink = false) => {
    const target = path.join(app, "Contents", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (makeLink) fs.symlinkSync("Info.plist", target);
    else fs.writeFileSync(target, contents);
    assert.throws(() => auditTree(root, { expectedAppName: path.basename(app) }), /privacy audit/i);
    fs.rmSync(target, { force: true, recursive: true });
    let parent = path.dirname(target);
    const contentsRoot = path.join(app, "Contents");
    while (parent !== contentsRoot && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
      parent = path.dirname(parent);
    }
  };
  reject("Resources/state/session.json");
  reject("Resources/dev.log");
  reject("Resources/leak.txt", "/Users/private-developer/secret\n");
  reject("Resources/compiled.bin", Buffer.from(`binary\0${os.homedir()}/private-source\0`));
  reject("Resources/unexpected-member.bin", Buffer.from("binary\0/Users/foreign-builder/private/source\0"));
  reject("Resources/key.txt", "-----BEGIN PRIVATE KEY-----\n");
  reject("Resources/link", "", true);
  fs.writeFileSync(path.join(root, "extra.txt"), "extra\n");
  assert.throws(() => auditTree(root, { expectedAppName: path.basename(app) }), /privacy audit/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test("DMG parser requires an explicit installer and release identity", () => {
  const { parseArgs } = require(packagePath);
  assert.deepEqual(parseArgs(["--installer-app", "/tmp/Test.app", "--output", "/tmp/Test.dmg"]), {
    release: false,
    "installer-app": "/tmp/Test.app",
    output: "/tmp/Test.dmg",
  });
  assert.throws(() => parseArgs(["--release", "--installer-app", "/tmp/Test.app", "--output", "/tmp/Test.dmg"]), /Developer ID Application/i);
  assert.throws(() => parseArgs(["--shell", "unsafe"]), /invalid/i);
});

test("exact installer packages to a mounted privacy-clean development DMG", {
  skip: !process.env.CODEX_BOT_INSTALLER_APP,
}, (t) => {
  const { auditDmg } = require(auditPath);
  const { packageDmg } = require(packagePath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-dmg-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "Codex-Bot-0.1.4-macos.1-DEVELOPMENT.dmg");
  const receipt = packageDmg({
    "installer-app": process.env.CODEX_BOT_INSTALLER_APP,
    output,
    release: false,
  });
  assert.equal(receipt.development, true);
  assert.equal(receipt.dmg, output);
  assert.equal(receipt.sha256.length, 64);
  assert.equal(fs.statSync(output).isFile(), true);
  const audit = auditDmg(output, { expectedAppName: "Install Codex Bot DEVELOPMENT.app" });
  assert.equal(audit.fileCount > 20, true);
  assert.equal(audit.personalPathMatches, 0);
  assert.equal(audit.secretMatches, 0);
});
