"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "0.1.4-macos.1";
const SIDECAR_BYTES = 58509266;
const SIDECAR_SHA256 = "1d7a12c5a1974b492dd2f21e3ecfb39db66d3465a67fd7039a844ce2c40e55df";
const NODE_PACKAGES = Object.freeze([
  "@electron/asar",
  "balanced-match",
  "brace-expansion",
  "glob",
  "lru-cache",
  "minimatch",
  "minipass",
  "path-scurry",
  "prettier",
  "ws",
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

function realFile(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
  return { file: resolved, stat };
}

function copyFile(source, target, mode = 0o644) {
  realFile(source, "Installer payload");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, mode);
}

function copyTree(source, target) {
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Installer payload tree is unsafe");
  fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFile(from, to);
    else throw new Error(`Installer payload contains an unsupported entry: ${entry.name}`);
  }
}

function run(executable, args, options = {}) {
  const result = childProcess.spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || "")
      .replace(/\/Users\/[^/\s]+/g, "/Users/[redacted]")
      .replace(/\/private\/tmp\/[^/\s]+/g, "/private/tmp/[redacted]")
      .replace(/[\r\n\t]+/g, " ")
      .trim()
      .slice(0, 500);
    throw new Error(`Installer build command failed: ${path.basename(executable)}${detail ? ` (${detail})` : ""}`);
  }
}

function parseArgs(argv) {
  const parsed = { release: false };
  const allowed = new Set([
    "output",
    "sidecar",
    "sidecar-license",
    "installer-binary",
    "signing-identity",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--release") {
      parsed.release = true;
      continue;
    }
    if (!value.startsWith("--") || index + 1 >= argv.length || !allowed.has(value.slice(2))) {
      throw new Error(`Invalid installer build argument: ${value}`);
    }
    parsed[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function plist(identity, development, sidecarBytes, sidecarSHA256) {
  const warning = development ? "DEVELOPMENT BUILD - NOT NOTARIZED FOR PUBLIC RELEASE" : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Install Codex Bot${development ? " DEVELOPMENT" : ""}</string>
  <key>CFBundleExecutable</key><string>InstallCodexBot</string>
  <key>CFBundleIdentifier</key><string>com.limonlimez.codex-bot.installer</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Install Codex Bot${development ? " DEVELOPMENT" : ""}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>0.1.4.1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CodexBotSigningIdentity</key><string>${identity.replace(/[&<>"']/g, "")}</string>
  <key>CodexBotBuildWarning</key><string>${warning}</string>
  <key>CodexBotSidecarBytes</key><integer>${sidecarBytes}</integer>
  <key>CodexBotSidecarSHA256</key><string>${sidecarSHA256}</string>
</dict></plist>
`;
}

function buildInstaller(options) {
  const macRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(macRoot, "..");
  const output = path.resolve(options.output || path.join(macRoot, "dist", VERSION));
  if (fs.existsSync(output)) throw new Error("Installer output already exists");
  const sidecar = realFile(options.sidecar, "CLIProxyAPI executable").file;
  const sidecarStat = fs.statSync(sidecar);
  if (sidecarStat.size !== SIDECAR_BYTES || sha256File(sidecar) !== SIDECAR_SHA256) {
    throw new Error("CLIProxyAPI executable failed the pinned integrity check");
  }
  const sidecarLicense = realFile(options["sidecar-license"], "CLIProxyAPI license").file;
  const signingIdentity = options["signing-identity"] || "-";
  if (options.release && !/^Developer ID Application: /.test(signingIdentity)) {
    throw new Error("A Developer ID Application identity is required for a release installer");
  }

  let installerBinary = options["installer-binary"];
  if (!installerBinary) {
    run("/usr/bin/swift", [
      "build", "--package-path", path.join(macRoot, "installer"),
      "-c", "release", "--product", "InstallCodexBot",
    ], { cwd: repoRoot });
    installerBinary = path.join(macRoot, "installer", ".build", "release", "InstallCodexBot");
  }
  installerBinary = realFile(installerBinary, "Installer executable").file;

  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-installer-build-"));
  const appName = options.release ? "Install Codex Bot.app" : "Install Codex Bot DEVELOPMENT.app";
  const app = path.join(temporary, appName);
  const contents = path.join(app, "Contents");
  const resources = path.join(contents, "Resources");
  try {
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true, mode: 0o755 });
    fs.mkdirSync(resources, { mode: 0o755 });
    const installedExecutable = path.join(contents, "MacOS", "InstallCodexBot");
    copyFile(installerBinary, installedExecutable, 0o755);
    run("/usr/bin/strip", ["-S", "-x", installedExecutable]);

    const patcherRoot = path.join(resources, "Patcher");
    for (const script of ["patch-app.cjs", "verify-vendor-app.cjs", "audit-grok-contract.cjs"]) {
      copyFile(path.join(macRoot, "scripts", script), path.join(patcherRoot, "scripts", script));
    }
    copyTree(path.join(macRoot, "src"), path.join(patcherRoot, "src"));
    for (const asset of [
      "grok-bot-0.20.0-contract.json",
      "grok-bot-0.20.0-darwin-arm64.manifest.json",
      "cliproxyapi-7.2.130-darwin-aarch64.json",
      "cliproxyapi-model-catalog-2026-08-14.json",
    ]) {
      copyFile(path.join(macRoot, "assets", asset), path.join(patcherRoot, "assets", asset));
    }
    for (const packageName of NODE_PACKAGES) {
      copyTree(
        path.join(macRoot, "node_modules", ...packageName.split("/")),
        path.join(patcherRoot, "node_modules", ...packageName.split("/")),
      );
    }
    const installedSidecar = path.join(resources, "CLIProxy", "cli-proxy-api");
    copyFile(sidecar, installedSidecar, 0o755);
    copyFile(sidecarLicense, path.join(resources, "CLIProxy", "LICENSE"));
    copyFile(path.join(repoRoot, "LICENSE"), path.join(resources, "Notices", "LICENSE"));
    copyFile(path.join(repoRoot, "NOTICE.md"), path.join(resources, "Notices", "NOTICE.md"));
    copyFile(path.join(macRoot, "PRIVACY.md"), path.join(resources, "Notices", "PRIVACY.md"));
    copyFile(path.join(macRoot, "README.md"), path.join(resources, "Notices", "README.md"));
    fs.writeFileSync(
      path.join(resources, "DEVELOPMENT-BUILD.txt"),
      options.release
        ? "Release installer.\n"
        : "DEVELOPMENT BUILD - NOT NOTARIZED - DO NOT PUBLISH AS A FINAL RELEASE.\n",
      { mode: 0o644 },
    );

    run("/usr/bin/xattr", ["-cr", app]);
    run("/usr/bin/codesign", [
      "--force", "--timestamp=none", "--sign", signingIdentity,
      installedSidecar,
    ]);
    fs.writeFileSync(
      path.join(contents, "Info.plist"),
      plist(signingIdentity, !options.release, fs.statSync(installedSidecar).size, sha256File(installedSidecar)),
      { mode: 0o644 },
    );
    run("/usr/bin/xattr", ["-cr", app]);
    run("/usr/bin/codesign", [
      "--force", "--timestamp=none", "--sign", signingIdentity, app,
    ]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    fs.renameSync(temporary, output);
    return Object.freeze({ app: path.join(output, appName), development: !options.release, version: VERSION });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const receipt = buildInstaller(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { NODE_PACKAGES, SIDECAR_BYTES, SIDECAR_SHA256, VERSION, buildInstaller, parseArgs };
