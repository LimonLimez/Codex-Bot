"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
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
const MANIFEST_RELATIVE = "Contents/Resources/INSTALLER-MANIFEST.json";
const SIGNATURE_RELATIVES = new Set([
  "Contents/_CodeSignature",
  "Contents/_CodeSignature/CodeResources",
]);
const REVIEWED_UPSTREAM_BINARIES = new Set([
  "Contents/Resources/CLIProxy/cli-proxy-api",
  "Contents/Resources/CodexRuntime/codex",
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

function safeRelative(relative) {
  return typeof relative === "string"
    && (relative === "Contents" || relative.startsWith("Contents/"))
    && !path.isAbsolute(relative)
    && relative.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function collectManifestEntries(app) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(app, absolute).split(path.sep).join("/");
      if (relative === MANIFEST_RELATIVE || relative === "Contents/_CodeSignature"
        || relative.startsWith("Contents/_CodeSignature/")) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`symlink is forbidden: ${relative}`);
      if (stat.isDirectory()) {
        entries.push(Object.freeze({ path: relative, type: "directory" }));
        walk(absolute);
      } else if (stat.isFile()) {
        entries.push(Object.freeze(relative === "Contents/MacOS/InstallCodexBot"
          ? { path: relative, type: "signed-code" }
          : {
              path: relative,
              type: "file",
              bytes: stat.size,
              sha256: sha256File(absolute),
            }));
      } else {
        fail(`unsupported filesystem entry: ${relative}`);
      }
    }
  };
  walk(app);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function writeInstallerManifest(app) {
  const resolved = path.resolve(app);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("installer app is not a real directory");
  const manifestPath = path.join(resolved, ...MANIFEST_RELATIVE.split("/"));
  if (fs.existsSync(manifestPath)) fail("installer manifest already exists");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o755 });
  const manifest = { schemaVersion: 1, entries: collectManifestEntries(resolved) };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o644, flag: "wx" });
  return manifestPath;
}

function loadInstallerManifest(app) {
  const manifestPath = path.join(app, ...MANIFEST_RELATIVE.split("/"));
  let stat;
  try { stat = fs.lstatSync(manifestPath); } catch { fail("installer manifest is missing"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || stat.size > 1024 * 1024) {
    fail("installer manifest is invalid");
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { fail("installer manifest is invalid"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(",") !== "entries,schemaVersion"
    || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)
    || manifest.entries.length < 1 || manifest.entries.length > 10_000) {
    fail("installer manifest is invalid");
  }
  const expected = new Map();
  let previous = "";
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !safeRelative(entry.path)
      || entry.path.localeCompare(previous) <= 0 || expected.has(entry.path)) fail("installer manifest is invalid");
    previous = entry.path;
    if (entry.type === "directory") {
      if (Object.keys(entry).sort().join(",") !== "path,type") fail("installer manifest is invalid");
    } else if (entry.type === "file") {
      if (Object.keys(entry).sort().join(",") !== "bytes,path,sha256,type"
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        fail("installer manifest is invalid");
      }
    } else if (entry.type === "signed-code") {
      if (entry.path !== "Contents/MacOS/InstallCodexBot"
        || Object.keys(entry).sort().join(",") !== "path,type") {
        fail("installer manifest is invalid");
      }
    } else {
      fail("installer manifest is invalid");
    }
    expected.set(entry.path, entry);
  }
  return expected;
}

function scanFile(file, relative) {
  if (REVIEWED_UPSTREAM_BINARIES.has(relative)) return;
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024 + 1024);
  let carry = 0;
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, carry, 1024 * 1024, null);
      const length = carry + bytes;
      const contents = buffer.subarray(0, length).toString("latin1");
      if (PERSONAL_PATH.test(contents)) fail(`personal absolute path found in ${relative}`);
      if (PRIVATE_SECRET.test(contents)) fail(`credential material found in ${relative}`);
      if (bytes === 0) break;
      carry = Math.min(1024, length);
      buffer.copyWithin(0, length - carry, length);
    }
  } finally {
    fs.closeSync(descriptor);
  }
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

  const app = path.join(resolved, expectedAppName);
  const expected = loadInstallerManifest(app);
  const seen = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  let personalPathMatches = 0;
  let secretMatches = 0;
  const localHome = Buffer.from(os.homedir());
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(app, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`symlink is forbidden: ${relative}`);
      const special = relative === MANIFEST_RELATIVE || SIGNATURE_RELATIVES.has(relative);
      const expectedEntry = expected.get(relative);
      if (!special && !expectedEntry) fail(`unexpected installer member: ${relative}`);
      if (stat.isDirectory()) {
        if (!special && expectedEntry.type !== "directory") fail(`installer member type mismatch: ${relative}`);
        if (!special) seen.add(relative);
        const normalized = entry.name.toLowerCase();
        if (FORBIDDEN_SEGMENTS.has(normalized)) fail(`development or user-state directory is forbidden: ${relative}`);
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) fail(`unsupported filesystem entry: ${relative}`);
      if (!special) {
        if (expectedEntry.type === "signed-code") {
          if (stat.size < 1) fail(`installer member mismatch: ${relative}`);
        } else if (expectedEntry.type !== "file" || expectedEntry.bytes !== stat.size
          || expectedEntry.sha256 !== sha256File(absolute)) fail(`installer member mismatch: ${relative}`);
        seen.add(relative);
      }
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
      try { scanFile(absolute, relative); } catch (error) {
        if (/personal absolute path/.test(error.message)) personalPathMatches += 1;
        if (/credential material/.test(error.message)) secretMatches += 1;
        throw error;
      }
    }
  };
  walk(app);
  if (seen.size !== expected.size) fail("installer manifest member is missing");
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

module.exports = {
  auditDmg,
  auditTree,
  containsBytes,
  parseArgs,
  writeInstallerManifest,
};
