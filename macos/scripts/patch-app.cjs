"use strict";

if (process.versions?.electron) process.noAsar = true;

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");
const { auditTreeDiff, snapshotTree } = require("../src/patch/diff-audit.cjs");
const { patchHostInference } = require("../src/patch/host-inference.cjs");
const { patchDesktop } = require("../src/patch/desktop.cjs");
const { patchRenderer } = require("../src/patch/renderer.cjs");

const VENDOR_APP_ASAR_SHA256 =
  "1e41f9da52be5d2ff24892b150a74d3d0145659cf6cbd83e9476d025865fb997";
const VENDOR_VERSION = "0.20.0";
const RELEASE_VERSION = "0.1.4-macos.1";
const ALLOWED_MUTATIONS = Object.freeze([
  "dist/codex/bots/bot-store.cjs",
  "dist/codex/bots/chatgpt-relay-codec.cjs",
  "dist/codex/bots/conversation-router.cjs",
  "dist/codex/bots/remote-app-server-client.cjs",
  "dist/codex/bots/runtime-controller.cjs",
  "dist/codex/bots/runtime-provider.cjs",
  "dist/codex/bridge/codex-client.cjs",
  "dist/codex/bridge/message-codec.cjs",
  "dist/codex/bridge/redaction.cjs",
  "dist/codex/bridge/runtime-config.cjs",
  "dist/codex/bridge/server.cjs",
  "dist/codex/desktop/cliproxy-manager.cjs",
  "dist/codex/desktop/model-selection-store.cjs",
  "dist/codex/desktop/runtime.cjs",
  "dist/electron-main/main.cjs",
  "dist/electron-preload/preload.cjs",
  "dist/host/host-main.cjs",
  "dist/renderer/codex/bot-runtime-ui.js",
  "dist/renderer/codex/codex-ui.css",
  "dist/renderer/codex/model-controls.js",
  "dist/renderer/codex/reasoning-control.js",
  "dist/renderer/index.html",
  "package.json",
]);

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function patchPackage(extractedRoot, sourceSha256) {
  const file = path.join(extractedRoot, "package.json");
  const packageJson = readJson(file);
  if (
    packageJson.name !== "sand" ||
    packageJson.productName !== "Grok Bot" ||
    packageJson.version !== VENDOR_VERSION ||
    packageJson.description !== "Grok Bot desktop agent" ||
    packageJson.codexBot != null
  ) {
    throw new Error("Unsupported Grok Bot 0.20.0 package metadata");
  }
  packageJson.productName = "Codex Bot";
  packageJson.version = RELEASE_VERSION;
  packageJson.description = "Codex Bot desktop agent";
  packageJson.homepage = "https://github.com/LimonLimez/Codex-Bot";
  packageJson.codexBot = {
    platform: "darwin-arm64",
    vendorProduct: "Grok Bot",
    vendorVersion: VENDOR_VERSION,
    vendorAppAsarSha256: sourceSha256,
  };
  fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}

function validatePatchPaths(sourceAsar, targetAsar) {
  if (typeof sourceAsar !== "string" || typeof targetAsar !== "string") {
    throw new TypeError("Patch source and target paths are required");
  }
  const source = path.resolve(sourceAsar);
  const target = path.resolve(targetAsar);
  if (source === target) throw new Error("Patch source and target must differ");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Patch source app.asar must be a real file, not a symlink");
  }
  if (fs.existsSync(target) || fs.existsSync(`${target}.unpacked`)) {
    throw new Error("Patch target already exists");
  }
  const targetParent = path.dirname(target);
  const targetParentStat = fs.lstatSync(targetParent);
  if (!targetParentStat.isDirectory() || targetParentStat.isSymbolicLink()) {
    throw new Error("Patch target parent must be a real directory");
  }
  return { source, target, targetParent };
}

async function patchAsar({
  sourceAsar,
  targetAsar,
  expectedSourceHash = VENDOR_APP_ASAR_SHA256,
}) {
  if (typeof expectedSourceHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedSourceHash)) {
    throw new Error("Expected source hash is invalid");
  }
  const { source, target, targetParent } = validatePatchPaths(sourceAsar, targetAsar);
  const sourceSha256 = sha256File(source);
  if (sourceSha256 !== expectedSourceHash) {
    throw new Error(`Unsupported app.asar hash: ${sourceSha256}`);
  }

  const extractionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-mac-patch-"));
  const extracted = path.join(extractionRoot, "app");
  const token = crypto.randomBytes(12).toString("hex");
  const partial = path.join(targetParent, `.${path.basename(target)}.${token}.partial`);
  const partialUnpacked = `${partial}.unpacked`;
  const targetUnpacked = `${target}.unpacked`;
  fs.mkdirSync(extracted, { mode: 0o700 });
  let targetCreated = false;
  let unpackedCreated = false;
  try {
    asar.extractAll(source, extracted);
    const before = snapshotTree(extracted);
    patchPackage(extracted, sourceSha256);
    patchHostInference(extracted);
    patchDesktop(extracted);
    patchRenderer(extracted);
    const after = snapshotTree(extracted);
    const mutations = auditTreeDiff(before, after, ALLOWED_MUTATIONS);
    await asar.createPackageWithOptions(extracted, partial, {
      unpackDir: "{dist/deps,dist/native}",
    });
    if (!fs.existsSync(partial) || fs.existsSync(target)) {
      throw new Error("Patch target changed during packaging");
    }
    if (fs.existsSync(partialUnpacked)) {
      if (fs.existsSync(targetUnpacked)) {
        throw new Error("Patch unpacked target changed during packaging");
      }
      fs.renameSync(partialUnpacked, targetUnpacked);
      unpackedCreated = true;
    }
    fs.renameSync(partial, target);
    targetCreated = true;
    const targetSha256 = sha256File(target);
    return {
      ok: true,
      sourceSha256,
      targetSha256,
      vendorVersion: VENDOR_VERSION,
      releaseVersion: RELEASE_VERSION,
      mutations,
    };
  } catch (error) {
    if (fs.existsSync(partial)) fs.rmSync(partial, { force: true });
    if (fs.existsSync(partialUnpacked)) {
      fs.rmSync(partialUnpacked, { recursive: true, force: true });
    }
    if (targetCreated && fs.existsSync(target)) fs.rmSync(target, { force: true });
    if (unpackedCreated && fs.existsSync(targetUnpacked)) {
      fs.rmSync(targetUnpacked, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (extractionRoot.startsWith(`${os.tmpdir()}${path.sep}`)) {
      fs.rmSync(extractionRoot, { recursive: true, force: true });
    }
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${value}`);
    }
    const key = value.slice(2);
    if (!new Set(["source-asar", "target-asar"]).has(key)) {
      throw new Error(`Unsupported patch argument: ${value}`);
    }
    args[key] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["source-asar"] || !args["target-asar"]) {
    throw new Error("Usage: patch-app.cjs --source-asar <official app.asar> --target-asar <staged app.asar>");
  }
  const receipt = await patchAsar({
    sourceAsar: args["source-asar"],
    targetAsar: args["target-asar"],
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_MUTATIONS,
  RELEASE_VERSION,
  VENDOR_APP_ASAR_SHA256,
  VENDOR_VERSION,
  patchAsar,
  patchPackage,
  sha256File,
};
