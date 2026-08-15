"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FORBIDDEN_SEGMENTS = new Set([
  ".git", ".svn", ".hg", ".env", ".DS_Store", "artifacts", "coverage",
  "profile", "profiles", "state", "states", "test", "tests", "screenshots",
  "conversations", "cookies", "history", "logs",
]);
const FORBIDDEN_SUFFIXES = [".log", ".pem", ".key", ".p12", ".mobileprovision"];
const TEXT_SUFFIXES = new Set([
  ".cjs", ".css", ".html", ".ini", ".js", ".json", ".md", ".mjs",
  ".plist", ".sh", ".swift", ".toml", ".txt", ".xml", ".yaml", ".yml",
]);
const PERSONAL_PATH = /(?:\/Users\/[^/\s"'<>]+|\/home\/[^/\s"'<>]+|[A-Za-z]:\\Users\\[^\\\s"'<>]+)/;
const PRIVATE_SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp|github_pat|sk|sess)-[A-Za-z0-9_\-]{20,}\b|\bBearer\s+[A-Za-z0-9_./+\-=]{20,}\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_./+\-=]{24,}["']/i;

function containsBytes(file, needle) {
  if (!Buffer.isBuffer(needle) || needle.length < 2) return false;
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024 + needle.length - 1);
  let carry = 0;
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, carry, 1024 * 1024, null);
      if (bytes === 0) return buffer.subarray(0, carry).includes(needle);
      const length = carry + bytes;
      if (buffer.subarray(0, length).includes(needle)) return true;
      carry = Math.min(needle.length - 1, length);
      buffer.copyWithin(0, length - carry, length);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function fail(reason) {
  throw new Error(`Release privacy audit failed: ${reason}`);
}

function run(executable, args) {
  const result = childProcess.spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) fail(`${path.basename(executable)} could not inspect the image`);
  return result.stdout;
}

function auditTree(root, options = {}) {
  const resolved = path.resolve(root);
  const expectedAppName = options.expectedAppName;
  const rootStat = fs.lstatSync(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("release root is not a real directory");
  const roots = fs.readdirSync(resolved).sort();
  if (!expectedAppName || roots.length !== 1 || roots[0] !== expectedAppName || !expectedAppName.endsWith(".app")) {
    fail("image root must contain exactly the expected installer app");
  }

  let fileCount = 0;
  let totalBytes = 0;
  let personalPathMatches = 0;
  let secretMatches = 0;
  const localHome = Buffer.from(os.homedir());
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(resolved, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`symlink is forbidden: ${relative}`);
      if (stat.isDirectory()) {
        const normalized = entry.name.toLowerCase();
        if (FORBIDDEN_SEGMENTS.has(normalized)) fail(`development or user-state directory is forbidden: ${relative}`);
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) fail(`unsupported filesystem entry: ${relative}`);
      fileCount += 1;
      totalBytes += stat.size;
      const normalized = entry.name.toLowerCase();
      if (FORBIDDEN_SEGMENTS.has(normalized) || FORBIDDEN_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
        fail(`development, credential, or user-state file is forbidden: ${relative}`);
      }
      if (containsBytes(absolute, localHome)) {
        personalPathMatches += 1;
        fail(`local developer path found in ${relative}`);
      }
      if (TEXT_SUFFIXES.has(path.extname(normalized)) && stat.size <= 16 * 1024 * 1024) {
        const contents = fs.readFileSync(absolute, "utf8");
        if (PERSONAL_PATH.test(contents)) {
          personalPathMatches += 1;
          fail(`personal absolute path found in ${relative}`);
        }
        if (PRIVATE_SECRET.test(contents)) {
          secretMatches += 1;
          fail(`credential material found in ${relative}`);
        }
      }
    }
  };
  walk(resolved);
  if (fileCount === 0) fail("installer app is empty");
  return Object.freeze({ fileCount, totalBytes, personalPathMatches, secretMatches });
}

function auditDmg(dmg, options = {}) {
  const resolved = path.resolve(dmg);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || path.extname(resolved).toLowerCase() !== ".dmg") {
    fail("release image must be a real DMG file");
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-release-mount-"));
  const mount = path.join(temporary, "mounted");
  fs.mkdirSync(mount, { mode: 0o700 });
  let attached = false;
  try {
    run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, resolved]);
    attached = true;
    return auditTree(mount, options);
  } finally {
    if (attached) childProcess.spawnSync("/usr/bin/hdiutil", ["detach", mount], { stdio: "ignore" });
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const parsed = {};
  const allowed = new Set(["dmg", "expected-app"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || !allowed.has(flag.slice(2)) || typeof argv[index + 1] !== "string") {
      throw new Error(`Invalid release audit argument: ${flag}`);
    }
    parsed[flag.slice(2)] = argv[index + 1];
  }
  if (!parsed.dmg || !parsed["expected-app"]) throw new Error("Release audit requires --dmg and --expected-app");
  return parsed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = auditDmg(options.dmg, { expectedAppName: options["expected-app"] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { auditDmg, auditTree, containsBytes, parseArgs };
