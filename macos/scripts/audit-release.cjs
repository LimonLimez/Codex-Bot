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
const HOME_PREFIX = /(?=(\/Users\/|\/home\/|[A-Za-z]:\\Users\\))/gi;
const STRICT_PRIVATE_SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bfixture-private-[A-Za-z0-9_-]*(?:auth|access|refresh|oauth|secret|token)[A-Za-z0-9_-]*\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|oauth[_-]?token|csrf[_-]?token|private[_-]?token|secret[_-]?token)\s*["'`]?\s*[:=]\s*(?:["'`][A-Za-z0-9_./+\-=]{3,}["'`]|(?=[A-Za-z0-9_./+\-=]{3,}(?:[^A-Za-z0-9_./+\-=]|$))(?=[A-Za-z0-9_./+\-=]*[0-9+\-=])[A-Za-z0-9_./+\-=]{3,})/i;
const PLAIN_PRIVATE_SECRET = /\b(?:access_token|refresh_token|auth_token|client_secret|oauth_token|csrf_token|private_token|secret_token|password|passwd|cookie|session_cookie)\s*["'`]?\s*[:=]\s*(?:["'`][A-Za-z0-9_./+\-=]{3,}["'`]|[A-Za-z]{8,})(?=[^A-Za-z0-9_./+\-=]|$)/i;
const GENERIC_TOKEN_SECRET = /\b(?:ghp|github_pat|sk|sess)-[A-Za-z0-9_\-]{20,}\b|\bBearer\s+[A-Za-z0-9_./+\-=]{6,}\b/i;
const MANIFEST_RELATIVE = "Contents/Resources/INSTALLER-MANIFEST.json";
const PROVENANCE_RELATIVE = "Contents/Resources/INSTALLER-PROVENANCE.json";
const AUTHORIZED_DEVELOPER_ID_TEAM = "HKCH65M45F";
const AUTHORIZED_INSTALLER_REQUIREMENT = '=anchor apple generic and certificate leaf[subject.OU] = "HKCH65M45F" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
const SIGNATURE_RELATIVES = new Set([
  "Contents/_CodeSignature",
  "Contents/_CodeSignature/CodeResources",
]);
const SCAN_CARRY_BYTES = 1024;
const REVIEWED_PUBLIC_CI_ROOTS = new Map([
  ["Contents/Resources/CLIProxy/cli-proxy-api", Object.freeze([
    "/Users/runner/go/pkg",
    "/Users/runner/hostedtoolcache/go",
    "/Users/runner/work/CLIProxyAPI",
  ])],
  ["Contents/Resources/CodexRuntime/codex", Object.freeze([
    "/Users/runner/.cargo/registry",
    "/Users/runner/.cargo/git",
    "/Users/runner/.rustup/toolchains",
  ])],
]);
const CLI_PROXY_INTERNAL_HOME_SOURCE_ROOT = "/Users/runner/work/CLIProxyAPI/CLIProxyAPI/internal/home/";
const CLI_PROXY_RELATIVE = "Contents/Resources/CLIProxy/cli-proxy-api";
const CODEX_RUNTIME_RELATIVE = "Contents/Resources/CodexRuntime/codex";

function reviewedRootsForMember(relative, identity = {}, trustedMembers = null) {
  const expected = trustedMembers instanceof Map ? trustedMembers.get(relative) : null;
  if (expected == null || identity.bytes !== expected.bytes || identity.sha256 !== expected.sha256) return [];
  return REVIEWED_PUBLIC_CI_ROOTS.get(relative) || [];
}

function reviewedHomePrefix(contents, offset, prefix, relative, reviewedRoots) {
  for (const root of reviewedRoots) {
    if (!contents.startsWith(root, offset)) continue;
    const after = contents[offset + root.length];
    if (after == null || after === "/" || after.charCodeAt(0) <= 0x20) return true;
  }
  if (relative !== CLI_PROXY_RELATIVE || prefix.toLowerCase() !== "/home/") return false;
  const nestedOffset = CLI_PROXY_INTERNAL_HOME_SOURCE_ROOT.lastIndexOf("/home/");
  const sourceStart = offset - nestedOffset;
  return sourceStart >= 0 && contents.startsWith(CLI_PROXY_INTERNAL_HOME_SOURCE_ROOT, sourceStart);
}

function unreviewedPinnedHomePath(contents, relative = "", {
  memberIdentity = null,
  trustedMembers = null,
} = {}) {
  if (typeof contents !== "string") return true;
  const reviewedRoots = reviewedRootsForMember(relative, memberIdentity || {}, trustedMembers);
  for (const match of contents.matchAll(new RegExp(HOME_PREFIX.source, HOME_PREFIX.flags))) {
    if (!reviewedHomePrefix(contents, match.index, match[1], relative, reviewedRoots)) return match[1];
  }
  return null;
}

function credentialMaterialKind(contents, {
  memberIdentity = null,
  relative = "",
  trustedMembers = null,
} = {}) {
  if (typeof contents !== "string") return "strict";
  const exactReviewedBinary = reviewedRootsForMember(
    relative,
    memberIdentity || {},
    trustedMembers,
  ).length > 0;
  if (unreviewedPinnedHomePath(contents, relative, { memberIdentity, trustedMembers })
    || STRICT_PRIVATE_SECRET.test(contents) || PLAIN_PRIVATE_SECRET.test(contents)) return "strict";
  if (!exactReviewedBinary && GENERIC_TOKEN_SECRET.test(contents)) return "generic-token";
  return null;
}

function forbiddenPathName(name) {
  const normalized = name.toLowerCase();
  return FORBIDDEN_SEGMENTS.has(normalized)
    || /^\.env(?:\.|$)/.test(normalized)
    || /^\.npmrc(?:\.|$)/.test(normalized)
    || /(?:^|[-_. ])browser[-_. ]?profiles?(?:$|[-_. ])/.test(normalized)
    || /(?:^|[-_.])bookmarks?(?:$|[-_.])/.test(normalized)
    || /^local-permissions(?:\.|$)/.test(normalized)
    || /^openbot-local(?:$|\.(?:db|json|sqlite|sqlite3))/.test(normalized)
    || /^standalone-(?:conversations|transcripts)(?:\.|$)/.test(normalized)
    || /(?:^|[-_.])(?:screenshots?|screen-shots?|frame)(?:[-_.0-9].*)?\.(?:png|jpe?g|webp)$/.test(normalized)
    || /(?:^|[-_.])logs?(?:$|[-_.])/.test(normalized)
    || /(?:^|[-_.])secrets?(?:$|[-_.])/.test(normalized)
    || /(?:^|[-_.])(?:oauth[-_.]?)?tokens?(?:$|[-_.])/.test(normalized)
    || /(?:^|[-_.])grants?(?:$|[-_.])/.test(normalized)
    || /(?:^|[-_.])workspaces?(?:$|[-_.])/.test(normalized)
    || /^user[ _.-]?data(?:$|\.(?:db|json|sqlite|sqlite3))/.test(normalized);
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

function assertAuthorizedInstallerSignature(output, { externalRequirementVerified = false } = {}) {
  if (!externalRequirementVerified) {
    fail("installer signature external Apple requirement was not verified");
  }
  const text = String(output || "");
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(text)?.[1] || null;
  const authority = authorities[0] || null;
  const authorizedApplication = authority != null
    && authority.startsWith("Developer ID Application: ")
    && authority.endsWith(` (${AUTHORIZED_DEVELOPER_ID_TEAM})`);
  if (!authorizedApplication || teamIdentifier !== AUTHORIZED_DEVELOPER_ID_TEAM
    || !authorities.includes("Developer ID Certification Authority")
    || !authorities.includes("Apple Root CA")) {
    fail("installer is not signed by the authorized Developer ID");
  }
  return { authority, teamIdentifier };
}

function installerSignatureVerificationArguments(app) {
  return [
    "--verify", "--deep", "--strict",
    "--test-requirement", AUTHORIZED_INSTALLER_REQUIREMENT,
    app,
  ];
}

function inspectInstallerSignature(app) {
  const verify = childProcess.spawnSync(
    "/usr/bin/codesign",
    installerSignatureVerificationArguments(app),
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (verify.error || verify.status !== 0) {
    fail("installer code signature verification failed");
  }
  const display = childProcess.spawnSync("/usr/bin/codesign", [
    "--display", "--verbose=4", app,
  ], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (display.error || display.status !== 0) {
    fail("installer code signature could not be inspected");
  }
  return assertAuthorizedInstallerSignature(
    `${display.stdout || ""}\n${display.stderr || ""}`,
    { externalRequirementVerified: true },
  );
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
          ? { path: relative, type: "signed-code", bytes: stat.size }
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
        || Object.keys(entry).sort().join(",") !== "bytes,path,type"
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
        fail("installer manifest is invalid");
      }
    } else {
      fail("installer manifest is invalid");
    }
    expected.set(entry.path, entry);
  }
  return expected;
}

function hasExactKeys(value, keys) {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function loadInstallerProvenance(app, expectedManifest) {
  const readReceipt = (filename) => {
    const receipt = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "assets", filename), "utf8"));
    if (receipt == null || typeof receipt !== "object" || Array.isArray(receipt)
      || receipt.executable == null || typeof receipt.executable !== "object"
      || Array.isArray(receipt.executable) || !Number.isSafeInteger(receipt.executable.bytes)
      || typeof receipt.executable.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(receipt.executable.sha256)) {
      fail("reviewed upstream source receipt is invalid");
    }
    return receipt.executable;
  };
  const cliProxySource = readReceipt("cliproxyapi-7.2.132-darwin-aarch64.json");
  const codexSource = readReceipt("openai-codex-0.147.0-darwin-arm64.json");
  const installerVersion = require("../package.json").version;
  const receiptPath = path.join(app, ...PROVENANCE_RELATIVE.split("/"));
  let receiptStat;
  try { receiptStat = fs.lstatSync(receiptPath); } catch { fail("installer provenance receipt is missing"); }
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink()
    || receiptStat.size < 100 || receiptStat.size > 64 * 1024) {
    fail("installer provenance receipt is invalid");
  }
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); } catch {
    fail("installer provenance receipt is invalid");
  }
  if (!hasExactKeys(receipt, ["members", "schemaVersion", "sourcePins", "version"])
    || receipt.schemaVersion !== 1 || receipt.version !== installerVersion
    || !hasExactKeys(receipt.sourcePins, ["cliProxyApi", "codexRuntime"])
    || !hasExactKeys(receipt.sourcePins.cliProxyApi, ["bytes", "sha256"])
    || !hasExactKeys(receipt.sourcePins.codexRuntime, ["bytes", "sha256"])
    || receipt.sourcePins.cliProxyApi.bytes !== cliProxySource.bytes
    || receipt.sourcePins.cliProxyApi.sha256 !== cliProxySource.sha256
    || receipt.sourcePins.codexRuntime.bytes !== codexSource.bytes
    || receipt.sourcePins.codexRuntime.sha256 !== codexSource.sha256
    || !Array.isArray(receipt.members) || receipt.members.length !== 2) {
    fail("installer provenance receipt is invalid");
  }

  const definitions = [
    { path: CLI_PROXY_RELATIVE, source: "cliProxyApi" },
    { path: CODEX_RUNTIME_RELATIVE, source: "codexRuntime" },
  ];
  const trustedMembers = new Map();
  for (let index = 0; index < definitions.length; index += 1) {
    const member = receipt.members[index];
    const definition = definitions[index];
    if (!hasExactKeys(member, ["bytes", "path", "sha256", "source"])
      || member.path !== definition.path || member.source !== definition.source
      || !Number.isSafeInteger(member.bytes) || member.bytes < 1
      || typeof member.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(member.sha256)) {
      fail("installer provenance receipt is invalid");
    }
    const memberPath = path.join(app, ...member.path.split("/"));
    let memberStat;
    try { memberStat = fs.lstatSync(memberPath); } catch { fail("installer provenance member is missing"); }
    const manifestEntry = expectedManifest.get(member.path);
    if (!memberStat.isFile() || memberStat.isSymbolicLink()
      || member.bytes !== memberStat.size || member.sha256 !== sha256File(memberPath)
      || manifestEntry?.type !== "file" || manifestEntry.bytes !== member.bytes
      || manifestEntry.sha256 !== member.sha256) {
      fail("installer provenance member mismatch");
    }
    trustedMembers.set(member.path, Object.freeze({
      bytes: member.bytes,
      sha256: member.sha256,
    }));
  }

  const receiptManifestEntry = expectedManifest.get(PROVENANCE_RELATIVE);
  if (receiptManifestEntry?.type !== "file" || receiptManifestEntry.bytes !== receiptStat.size
    || receiptManifestEntry.sha256 !== sha256File(receiptPath)) {
    fail("installer provenance manifest mismatch");
  }
  return trustedMembers;
}

function scanFile(file, relative, trustedMembers = null) {
  const stat = fs.statSync(file);
  const memberIdentity = { bytes: stat.size, sha256: sha256File(file) };
  const exactReviewedBinary = reviewedRootsForMember(
    relative,
    memberIdentity,
    trustedMembers,
  ).length > 0;
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      const combined = carry.length === 0
        ? buffer.subarray(0, bytes)
        : Buffer.concat([carry, buffer.subarray(0, bytes)]);
      const contents = combined.toString("latin1");
      if (unreviewedPinnedHomePath(contents, relative, { memberIdentity, trustedMembers })) {
        fail(`personal absolute path found in ${relative}`);
      }
      if (STRICT_PRIVATE_SECRET.test(contents) || PLAIN_PRIVATE_SECRET.test(contents)
        || (!exactReviewedBinary && GENERIC_TOKEN_SECRET.test(contents))) {
        fail(`credential material found in ${relative}`);
      }
      if (bytes === 0) break;
      carry = Buffer.from(combined.subarray(Math.max(0, combined.length - SCAN_CARRY_BYTES)));
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

function resolveInstallerRoot(root, expectedAppName) {
  const resolved = path.resolve(root);
  const rootStat = fs.lstatSync(resolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("release root is not a real directory");
  const roots = fs.readdirSync(resolved).sort();
  if (!expectedAppName || roots.length !== 1 || roots[0] !== expectedAppName || !expectedAppName.endsWith(".app")) {
    fail("image root must contain exactly the expected installer app");
  }
  const app = path.join(resolved, expectedAppName);
  let appStat;
  try { appStat = fs.lstatSync(app); } catch { fail("installer app must be a real directory"); }
  if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
    fail("installer app must be a real directory");
  }
  return { app, resolved };
}

function auditTreeContents(app, expected, trustedMembers) {
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
        if (forbiddenPathName(entry.name)) fail(`development or user-state directory is forbidden: ${relative}`);
        walk(absolute);
        continue;
      }
      if (!stat.isFile()) fail(`unsupported filesystem entry: ${relative}`);
      if (!special) {
        if (expectedEntry.type === "signed-code") {
          if (expectedEntry.bytes !== stat.size) fail(`installer member mismatch: ${relative}`);
        } else if (expectedEntry.type !== "file" || expectedEntry.bytes !== stat.size
          || expectedEntry.sha256 !== sha256File(absolute)) fail(`installer member mismatch: ${relative}`);
        seen.add(relative);
      }
      fileCount += 1;
      totalBytes += stat.size;
      const normalized = entry.name.toLowerCase();
      if (forbiddenPathName(entry.name) || FORBIDDEN_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
        fail(`development, credential, or user-state file is forbidden: ${relative}`);
      }
      if (containsBytes(absolute, localHome)) {
        personalPathMatches += 1;
        fail(`local developer path found in ${relative}`);
      }
      try { scanFile(absolute, relative, trustedMembers); } catch (error) {
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

function auditPayloadTree(root, options = {}) {
  const { app } = resolveInstallerRoot(root, options.expectedAppName);
  const expected = loadInstallerManifest(app);
  return auditTreeContents(app, expected, new Map());
}

function auditTree(root, options = {}) {
  const { app } = resolveInstallerRoot(root, options.expectedAppName);
  inspectInstallerSignature(app);
  const expected = loadInstallerManifest(app);
  const trustedMembers = loadInstallerProvenance(app, expected);
  return auditTreeContents(app, expected, trustedMembers);
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

module.exports = {
  assertAuthorizedInstallerSignature,
  auditDmg,
  auditPayloadTree,
  auditTree,
  containsBytes,
  credentialMaterialKind,
  installerSignatureVerificationArguments,
  loadInstallerProvenance,
  parseArgs,
  reviewedRootsForMember,
  writeInstallerManifest,
};

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}
