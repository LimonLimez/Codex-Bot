"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const test = require("node:test");

const scriptPath = path.join(__dirname, "..", "scripts", "build-installer-app.cjs");

function relativeFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
      else assert.fail(`unsupported staged entry: ${absolute}`);
    }
  };
  walk(root);
  return files.sort();
}

function git(root, args) {
  return childProcess.execFileSync("/usr/bin/git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

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
  assert.match(source, /native["'],\s*["']openbot-profile-publish\.c/);
  assert.match(source, /\/usr\/bin\/cc/);
  assert.match(source, /["']-arch["'],\s*["']arm64["']/);
  assert.match(source, /\/usr\/bin\/lipo/);
  assert.match(source, /OpenBotMigration["'],\s*["']openbot-profile-publish/);
  assert.match(source, /OpenBotProfilePublisherBytes/);
  assert.match(source, /OpenBotProfilePublisherSHA256/);
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

test("installer stages only the exact exported patcher source script and asset closures", (t) => {
  const {
    PATCHER_ASSET_FILES,
    PATCHER_SCRIPT_FILES,
    PATCHER_SOURCE_FILES,
    stagePatcherPayload,
  } = require(scriptPath);
  assert.equal(typeof stagePatcherPayload, "function");
  assert.deepEqual(PATCHER_SCRIPT_FILES, [
    "audit-grok-contract.cjs",
    "patch-app.cjs",
    "verify-vendor-app.cjs",
  ]);
  assert.deepEqual(PATCHER_ASSET_FILES, [
    "grok-bot-0.20.0-contract.json",
    "grok-bot-0.20.0-darwin-arm64.manifest.json",
  ]);
  assert.deepEqual(PATCHER_SOURCE_FILES, [
    "bots/bot-store.cjs",
    "bots/chatgpt-relay-codec.cjs",
    "bots/conversation-router.cjs",
    "bots/remote-app-server-client.cjs",
    "bots/runtime-controller.cjs",
    "bots/runtime-provider.cjs",
    "bridge/codex-client.cjs",
    "bridge/inference-socket-client.cjs",
    "bridge/message-codec.cjs",
    "bridge/redaction.cjs",
    "bridge/runtime-config.cjs",
    "bridge/server.cjs",
    "computer/computer-target-router.cjs",
    "desktop/bot-deletion-coordinator.cjs",
    "desktop/cliproxy-inference-transport.cjs",
    "desktop/cliproxy-manager.cjs",
    "desktop/codex-account-controller.cjs",
    "desktop/codex-app-server-manager.cjs",
    "desktop/codex-direct-inference-transport.cjs",
    "desktop/codex-runtime-integrity.cjs",
    "desktop/inference-bridge-server.cjs",
    "desktop/inference-provider-router.cjs",
    "desktop/local-desktop-frame-ipc.cjs",
    "desktop/model-selection-store.cjs",
    "desktop/openbot-native-coordinator-ipc.cjs",
    "desktop/openbot-native-coordinator.cjs",
    "desktop/openbot-user-data.cjs",
    "desktop/runtime.cjs",
    "desktop/standalone-conversation-controller.cjs",
    "desktop/standalone-conversation-ipc.cjs",
    "desktop/standalone-conversation-store.cjs",
    "desktop/standalone-subagent-runner.cjs",
    "local/local-computer-boundary.cjs",
    "local/local-computer-runtime.cjs",
    "local/local-desktop-manager.cjs",
    "local/local-helper-child.cjs",
    "local/local-helper-protocol.cjs",
    "local/local-helper-transport.cjs",
    "local/local-permission-broker.cjs",
    "local/local-permission-store.cjs",
    "patch/anchors.cjs",
    "patch/desktop.cjs",
    "patch/diff-audit.cjs",
    "patch/host-inference.cjs",
    "patch/renderer.cjs",
    "renderer/bot-runtime-ui.js",
    "renderer/chat-content.js",
    "renderer/codex-ui.css",
    "renderer/model-controls.js",
    "renderer/openbot-local-desktop-view.css",
    "renderer/openbot-local-desktop-view.js",
    "renderer/reasoning-control.js",
  ]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-patcher-payload-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const patcher = path.join(root, "Patcher");
  stagePatcherPayload({
    macRoot: path.join(__dirname, ".."),
    patcherRoot: patcher,
  });
  assert.deepEqual(relativeFiles(patcher), [
    ...PATCHER_ASSET_FILES.map((file) => `assets/${file}`),
    ...PATCHER_SCRIPT_FILES.map((file) => `scripts/${file}`),
    ...PATCHER_SOURCE_FILES.map((file) => `src/${file}`),
  ].sort());

  for (const relative of [
    "src/bots/remote-provider-live-gate.cjs",
    "src/bots/remote-provider-live-report.cjs",
    "src/bots/reviewed-adapter-worker-source.cjs",
    "scripts/verify-codex-runtime.cjs",
    "assets/cliproxyapi-7.2.132-darwin-aarch64.json",
    "assets/cliproxyapi-model-catalog-2026-08-14.json",
    "assets/openai-codex-0.147.0-darwin-arm64.json",
  ]) {
    assert.equal(fs.existsSync(path.join(__dirname, "..", relative)), true, `${relative} remains a build-time input`);
    assert.equal(fs.existsSync(path.join(patcher, relative)), false, `${relative} is not shipped`);
  }
});

test("release checkout capture requires a clean HEAD exactly equal to origin main while development stays dirty-safe", (t) => {
  const { captureReleaseCheckout, verifyReleaseCheckout } = require(scriptPath);
  assert.equal(typeof captureReleaseCheckout, "function");
  assert.equal(typeof verifyReleaseCheckout, "function");

  const nonRepository = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-development-checkout-test-"));
  t.after(() => fs.rmSync(nonRepository, { recursive: true, force: true }));
  fs.writeFileSync(path.join(nonRepository, "dirty.txt"), "development\n");
  assert.equal(captureReleaseCheckout({ repoRoot: nonRepository, release: false }), null);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-release-checkout-test-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "OpenBot Test"]);
  git(repo, ["config", "user.email", "openbot-test@example.invalid"]);
  fs.writeFileSync(path.join(repo, "release.txt"), "one\n");
  git(repo, ["add", "release.txt"]);
  git(repo, ["commit", "-q", "-m", "release"]);
  const mainCommit = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", mainCommit]);

  const captured = captureReleaseCheckout({ repoRoot: repo, release: true });
  assert.deepEqual(captured, { commit: mainCommit });
  assert.deepEqual(verifyReleaseCheckout({ repoRoot: repo, release: true, captured }), captured);

  fs.writeFileSync(path.join(repo, "untracked.txt"), "dirty\n");
  assert.throws(() => captureReleaseCheckout({ repoRoot: repo, release: true }), /clean|dirty|worktree/i);
  fs.rmSync(path.join(repo, "untracked.txt"));

  fs.writeFileSync(path.join(repo, "release.txt"), "two\n");
  git(repo, ["add", "release.txt"]);
  git(repo, ["commit", "-q", "-m", "later"]);
  assert.throws(() => captureReleaseCheckout({ repoRoot: repo, release: true }), /origin\/main|exact.*commit/i);
  assert.throws(() => verifyReleaseCheckout({ repoRoot: repo, release: true, captured }), /changed|exact.*commit/i);
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
  const profilePublisher = path.join(resources, "OpenBotMigration", "openbot-profile-publish");
  assert.equal(fs.statSync(profilePublisher).mode & 0o111, 0o111);
  const plist = fs.readFileSync(path.join(receipt.app, "Contents", "Info.plist"), "utf8");
  assert.match(plist, new RegExp(`<key>CodexBotSidecarBytes</key><integer>${fs.statSync(path.join(resources, "CLIProxy", "cli-proxy-api")).size}</integer>`));
  assert.match(plist, new RegExp(`<key>CodexBotSidecarSHA256</key><string>${require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(resources, "CLIProxy", "cli-proxy-api"))).digest("hex")}</string>`));
  assert.match(plist, new RegExp(`<key>OpenBotProfilePublisherBytes</key><integer>${fs.statSync(profilePublisher).size}</integer>`));
  assert.match(plist, new RegExp(`<key>OpenBotProfilePublisherSHA256</key><string>${require("node:crypto").createHash("sha256").update(fs.readFileSync(profilePublisher)).digest("hex")}</string>`));
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
