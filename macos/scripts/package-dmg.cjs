"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { auditDmg, auditTree } = require("./audit-release.cjs");

function run(executable, args) {
  const result = childProcess.spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error(`DMG packaging command failed: ${path.basename(executable)}`);
}

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

function assertExactReleaseNames(installerApp, output, release) {
  const expectedInstaller = release
    ? "Install OpenBot.app"
    : "Install OpenBot DEVELOPMENT.app";
  const expectedDmg = release
    ? "OpenBot-0.2.0-macos.1.dmg"
    : "OpenBot-0.2.0-macos.1-DEVELOPMENT.dmg";
  if (path.basename(installerApp) !== expectedInstaller || path.basename(output) !== expectedDmg) {
    throw new Error(`OpenBot ${release ? "release" : "DEVELOPMENT"} packaging requires ${expectedInstaller} and ${expectedDmg}`);
  }
}

function parseArgs(argv) {
  const parsed = { release: false };
  const allowed = new Set(["installer-app", "output", "signing-identity"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--release") {
      parsed.release = true;
      continue;
    }
    if (!value?.startsWith("--") || !allowed.has(value.slice(2)) || typeof argv[index + 1] !== "string") {
      throw new Error(`Invalid DMG packaging argument: ${value}`);
    }
    parsed[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!parsed["installer-app"] || !parsed.output) throw new Error("DMG packaging requires --installer-app and --output");
  if (parsed.release && !/^Developer ID Application: /.test(parsed["signing-identity"] || "")) {
    throw new Error("A Developer ID Application identity is required for a release DMG");
  }
  assertExactReleaseNames(parsed["installer-app"], parsed.output, parsed.release);
  return parsed;
}

function packageDmg(options) {
  const installerApp = path.resolve(options["installer-app"]);
  const output = path.resolve(options.output);
  assertExactReleaseNames(installerApp, output, Boolean(options.release));
  const appStat = fs.lstatSync(installerApp);
  if (!appStat.isDirectory() || appStat.isSymbolicLink() || !installerApp.endsWith(".app")) {
    throw new Error("Installer app must be a real application bundle");
  }
  if (fs.existsSync(output)) throw new Error("DMG output already exists");
  const development = !options.release;
  const expectedAppName = path.basename(installerApp);
  auditTree(path.dirname(installerApp), { expectedAppName });

  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-dmg-build-"));
  const stage = path.join(temporary, "stage");
  const temporaryDmg = path.join(temporary, "OpenBot-0.2.0-macos.1.dmg");
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    fs.cpSync(installerApp, path.join(stage, expectedAppName), { recursive: true, errorOnExist: true, force: false });
    auditTree(stage, { expectedAppName });
    run("/usr/bin/hdiutil", [
      "create", "-quiet", "-fs", "HFS+", "-format", "UDZO",
      "-imagekey", "zlib-level=9", "-volname",
      development ? "OpenBot DEVELOPMENT" : "OpenBot Installer",
      "-srcfolder", stage, temporaryDmg,
    ]);
    if (!development) {
      run("/usr/bin/codesign", [
        "--force", "--timestamp", "--sign", options["signing-identity"], temporaryDmg,
      ]);
      run("/usr/bin/codesign", ["--verify", "--strict", temporaryDmg]);
    }
    auditDmg(temporaryDmg, { expectedAppName });
    fs.renameSync(temporaryDmg, output);
    return Object.freeze({
      development,
      dmg: output,
      bytes: fs.statSync(output).size,
      sha256: sha256File(output),
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  process.stdout.write(`${JSON.stringify(packageDmg(parseArgs(process.argv.slice(2))))}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { packageDmg, parseArgs, sha256File };
