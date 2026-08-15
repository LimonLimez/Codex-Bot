"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "..", "scripts", "build-installer-app.cjs");

test("installer builder pins the sidecar and refuses ad-hoc release packaging", () => {
  const { NODE_PACKAGES, SIDECAR_BYTES, SIDECAR_SHA256, parseArgs } = require(scriptPath);
  assert.equal(SIDECAR_BYTES, 58509266);
  assert.equal(SIDECAR_SHA256, "1d7a12c5a1974b492dd2f21e3ecfb39db66d3465a67fd7039a844ce2c40e55df");
  assert.deepEqual(NODE_PACKAGES, [
    "@electron/asar", "balanced-match", "brace-expansion", "glob", "lru-cache",
    "minimatch", "minipass", "path-scurry", "prettier", "ws",
  ]);
  assert.deepEqual(parseArgs(["--release", "--signing-identity", "Developer ID Application: Example (ABCDE12345)"]), {
    release: true,
    "signing-identity": "Developer ID Application: Example (ABCDE12345)",
  });
  assert.throws(() => parseArgs(["--shell", "rm -rf"]), /invalid/i);
});

test("installer bundles the macOS privacy notice instead of Windows release policy", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  const notice = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
  assert.match(source, /path\.join\(macRoot,\s*"PRIVACY\.md"\)/);
  assert.match(source, /path\.join\(macRoot,\s*"README\.md"\)/);
  assert.match(source, /\/usr\/bin\/strip/);
  assert.doesNotMatch(notice, /%LOCALAPPDATA%|Windows DPAPI|Grok Bot 0\.18\.0/i);
  assert.match(notice, /macOS|CLIProxyAPI|127\.0\.0\.1/);
});

test("exact pinned inputs build an isolated signed development installer bundle", {
  skip: !process.env.CLIPROXYAPI_DARWIN_ARM64 || !process.env.CLIPROXYAPI_LICENSE,
}, (t) => {
  const { buildInstaller } = require(scriptPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-installer-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = buildInstaller({
    output: path.join(root, "out"),
    sidecar: process.env.CLIPROXYAPI_DARWIN_ARM64,
    "sidecar-license": process.env.CLIPROXYAPI_LICENSE,
    "installer-binary": path.join(__dirname, "..", "installer", ".build", "release", "InstallCodexBot"),
    "signing-identity": "-",
    release: false,
  });
  assert.equal(receipt.development, true);
  assert.equal(fs.lstatSync(receipt.app).isDirectory(), true);
  const resources = path.join(receipt.app, "Contents", "Resources");
  assert.equal(fs.statSync(path.join(resources, "CLIProxy", "cli-proxy-api")).mode & 0o111, 0o111);
  const plist = fs.readFileSync(path.join(receipt.app, "Contents", "Info.plist"), "utf8");
  assert.match(plist, new RegExp(`<key>CodexBotSidecarBytes</key><integer>${fs.statSync(path.join(resources, "CLIProxy", "cli-proxy-api")).size}</integer>`));
  assert.match(plist, new RegExp(`<key>CodexBotSidecarSHA256</key><string>${require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(resources, "CLIProxy", "cli-proxy-api"))).digest("hex")}</string>`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(resources, "Patcher", "node_modules", "ws", "package.json"), "utf8")).version, "8.21.3");
  const privacy = fs.readFileSync(path.join(resources, "Notices", "PRIVACY.md"), "utf8");
  assert.match(privacy, /macOS|CLIProxyAPI/);
  assert.doesNotMatch(privacy, /%LOCALAPPDATA%|Windows DPAPI|Grok Bot 0\.18\.0/i);
  assert.equal(fs.readFileSync(path.join(receipt.app, "Contents", "MacOS", "InstallCodexBot")).includes(Buffer.from(os.homedir())), false);
  assert.match(fs.readFileSync(path.join(resources, "DEVELOPMENT-BUILD.txt"), "utf8"), /DO NOT PUBLISH/);
  assert.equal(fs.existsSync(path.join(resources, "Patcher", "test")), false);
  assert.equal(fs.existsSync(path.join(resources, ".git")), false);
});
