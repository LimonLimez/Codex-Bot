"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.join(__dirname, "..", "scripts", "build-installer-app.cjs");

test("installer builder pins the sidecar and refuses ad-hoc release packaging", () => {
  const {
    CODEX_RUNTIME_BYTES,
    CODEX_RUNTIME_LICENSE_BYTES,
    CODEX_RUNTIME_LICENSE_SHA256,
    CODEX_RUNTIME_SHA256,
    NODE_PACKAGES,
    SIDECAR_BYTES,
    SIDECAR_LICENSE_BYTES,
    SIDECAR_LICENSE_SHA256,
    SIDECAR_SHA256,
    parseArgs,
  } = require(scriptPath);
  assert.equal(SIDECAR_BYTES, 58558850);
  assert.equal(SIDECAR_SHA256, "a46fe86e32845876832c6f2c7e66587ab7d9ee70d899ee5a7112de29f7d70cd6");
  assert.equal(SIDECAR_LICENSE_BYTES, 1116);
  assert.equal(SIDECAR_LICENSE_SHA256, "879792e89cf1bdd6a8d446033ec87e30496f97dcafc4656dc53f641509b346a6");
  assert.equal(CODEX_RUNTIME_BYTES, 219997536);
  assert.equal(CODEX_RUNTIME_SHA256, "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37");
  assert.equal(CODEX_RUNTIME_LICENSE_BYTES, 10926);
  assert.equal(CODEX_RUNTIME_LICENSE_SHA256, "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc");
  assert.deepEqual(NODE_PACKAGES, [
    "@electron/asar", "balanced-match", "brace-expansion", "glob", "lru-cache",
    "minimatch", "minipass", "path-scurry", "prettier", "ws",
  ]);
  assert.deepEqual(parseArgs(["--release", "--signing-identity", "Developer ID Application: Example (ABCDE12345)"]), {
    release: true,
    "signing-identity": "Developer ID Application: Example (ABCDE12345)",
  });
  assert.deepEqual(parseArgs([
    "--codex-archive", "/tmp/codex.tar.gz",
    "--codex-runtime", "/tmp/codex",
    "--codex-license", "/tmp/CODEX-LICENSE",
  ]), {
    release: false,
    "codex-archive": "/tmp/codex.tar.gz",
    "codex-runtime": "/tmp/codex",
    "codex-license": "/tmp/CODEX-LICENSE",
  });
  assert.throws(() => parseArgs(["--shell", "rm -rf"]), /invalid/i);
});

test("installer bundles the macOS privacy notice instead of Windows release policy", () => {
  const source = fs.readFileSync(scriptPath, "utf8");
  const notice = fs.readFileSync(path.join(__dirname, "..", "PRIVACY.md"), "utf8");
  assert.match(source, /path\.join\(macRoot,\s*"PRIVACY\.md"\)/);
  assert.match(source, /path\.join\(macRoot,\s*"README\.md"\)/);
  assert.match(source, /path\.join\(macRoot,\s*"NOTICE\.md"\)/);
  assert.match(source, /\/usr\/bin\/strip/);
  assert.match(source, /verify-codex-runtime\.cjs/);
  assert.match(source, /Resources["'],\s*["']CodexRuntime/);
  assert.match(source, /--options["'],\s*["']runtime/);
  assert.match(source, /--timestamp/);
  assert.doesNotMatch(source, /<key>CodexBotSigningIdentity<\/key>/);
  assert.doesNotMatch(notice, /%LOCALAPPDATA%|Windows DPAPI|Grok Bot 0\.18\.0/i);
  assert.match(notice, /macOS|CLIProxyAPI|127\.0\.0\.1/);
  const bundledNotice = fs.readFileSync(path.join(__dirname, "..", "NOTICE.md"), "utf8");
  assert.match(bundledNotice, /Codex 0\.147\.0/);
  assert.match(bundledNotice, /CLIProxyAPI 7\.2\.132/);
  assert.doesNotMatch(bundledNotice, /Windows|0\.18\.0/);
});

test("exact pinned inputs build an isolated signed development installer bundle", {
  skip: !process.env.CLIPROXYAPI_DARWIN_ARM64 || !process.env.CLIPROXYAPI_LICENSE
    || !process.env.CODEX_RUNTIME_ARCHIVE || !process.env.CODEX_RUNTIME_BINARY
    || !process.env.CODEX_RUNTIME_LICENSE,
}, (t) => {
  const { buildInstaller } = require(scriptPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-installer-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receipt = buildInstaller({
    output: path.join(root, "out"),
    sidecar: process.env.CLIPROXYAPI_DARWIN_ARM64,
    "sidecar-license": process.env.CLIPROXYAPI_LICENSE,
    "codex-archive": process.env.CODEX_RUNTIME_ARCHIVE,
    "codex-runtime": process.env.CODEX_RUNTIME_BINARY,
    "codex-license": process.env.CODEX_RUNTIME_LICENSE,
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
  const packagedRuntime = path.join(resources, "CodexRuntime", "codex");
  const runtimeReceipt = JSON.parse(fs.readFileSync(path.join(resources, "CodexRuntime", "receipt.json"), "utf8"));
  assert.equal(fs.statSync(packagedRuntime).mode & 0o111, 0o111);
  assert.equal(fs.statSync(packagedRuntime).size, 219997536);
  assert.equal(runtimeReceipt.version, "0.147.0");
  assert.equal(runtimeReceipt.sha256, "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37");
  assert.equal(fs.readFileSync(path.join(resources, "CodexRuntime", "LICENSE"), "utf8").includes("Apache License"), true);
  const privacy = fs.readFileSync(path.join(resources, "Notices", "PRIVACY.md"), "utf8");
  assert.match(privacy, /macOS|CLIProxyAPI/);
  assert.doesNotMatch(privacy, /%LOCALAPPDATA%|Windows DPAPI|Grok Bot 0\.18\.0/i);
  assert.equal(fs.readFileSync(path.join(receipt.app, "Contents", "MacOS", "InstallCodexBot")).includes(Buffer.from(os.homedir())), false);
  assert.match(fs.readFileSync(path.join(resources, "DEVELOPMENT-BUILD.txt"), "utf8"), /DO NOT PUBLISH/);
  assert.equal(fs.existsSync(path.join(resources, "Patcher", "test")), false);
  assert.equal(fs.existsSync(path.join(resources, ".git")), false);
});
