#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  EXPECTED_IDENTITY,
  probeCodexIdentity,
  sha256File,
  verifyCodexRuntime,
} = require("../src/desktop/codex-runtime-integrity.cjs");

const MANIFEST_PATH = path.join(__dirname, "..", "assets", "openai-codex-0.147.0-darwin-arm64.json");
const EXPECTED_ARCHIVE_ENTRY = "codex-aarch64-apple-darwin";

function failure(message = "Codex runtime verification failed.") {
  return new Error(message);
}

function verifyArchiveFile(archivePath, expected) {
  if (typeof archivePath !== "string" || !path.isAbsolute(archivePath)
    || !expected || typeof expected !== "object"
    || !Number.isSafeInteger(expected.bytes) || expected.bytes < 1
    || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw failure();
  }
  let stat;
  try { stat = fs.lstatSync(archivePath); } catch { throw failure(); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure("Codex archive must be a regular file.");
  if (stat.size !== expected.bytes) throw failure("Codex archive size mismatch.");
  const sha256 = sha256File(archivePath);
  if (sha256 !== expected.sha256) throw failure("Codex archive hash mismatch.");
  return Object.freeze({ bytes: stat.size, sha256 });
}

function tarListing(archivePath) {
  const result = childProcess.spawnSync("/usr/bin/tar", ["-tzvf", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { LANG: "C", PATH: "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) throw failure("Codex archive listing failed.");
  return result.stdout;
}

function inspectCodexArchive(archivePath) {
  if (typeof archivePath !== "string" || !path.isAbsolute(archivePath)) throw failure();
  const members = [];
  for (const rawLine of tarListing(archivePath).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const type = line[0];
    const tokens = line.split(/\s+/);
    const name = tokens.at(-1)?.replace(/^\.\//, "");
    if (type === "d" && (name === "." || name === "")) continue;
    members.push({ type, name, line });
  }
  if (members.length !== 1) throw failure("Codex archive must contain exactly one member.");
  const member = members[0];
  if (member.type !== "-" || member.name !== EXPECTED_ARCHIVE_ENTRY) {
    throw failure("Codex archive member must be the expected regular executable.");
  }
  return Object.freeze({ entry: EXPECTED_ARCHIVE_ENTRY, type: "file" });
}

function validateManifest(manifest) {
  const canonical = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || JSON.stringify(manifest) !== JSON.stringify(canonical)) {
    throw failure("Unsupported Codex runtime manifest.");
  }
  return manifest;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw failure("Invalid arguments.");
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.archive || !args.binary) {
    throw failure("Usage: verify-codex-runtime.cjs --archive <archive> --binary <extracted binary>.");
  }
  const manifest = validateManifest(JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")));
  const archivePath = path.resolve(args.archive);
  const binaryPath = path.resolve(args.binary);
  verifyArchiveFile(archivePath, manifest.archive);
  inspectCodexArchive(archivePath);
  const receipt = Object.freeze({
    schemaVersion: 1,
    version: manifest.version,
    bytes: manifest.executable.bytes,
    sha256: manifest.executable.sha256,
    identity: EXPECTED_IDENTITY,
  });
  const runtime = await verifyCodexRuntime({ binaryPath, receipt, probeIdentity: probeCodexIdentity });
  process.stdout.write(`${JSON.stringify({ ok: true, version: runtime.version, archiveSha256: manifest.archive.sha256, executableSha256: manifest.executable.sha256 })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || "Codex runtime verification failed."}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_ARCHIVE_ENTRY,
  inspectCodexArchive,
  validateManifest,
  verifyArchiveFile,
};
