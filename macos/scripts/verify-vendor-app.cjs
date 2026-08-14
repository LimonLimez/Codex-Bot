"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED = Object.freeze({
  schemaVersion: 1,
  product: "Grok Bot",
  version: "0.20.0",
  platform: "darwin-arm64",
  artifact: Object.freeze({
    url: "https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.20.0/Grok_Bot_0.20.0.dmg",
    bytes: 151151794,
    sha256:
      "73dfc1656a0e122a9a98bdcf1f49da5ec5475e156977c8730d207bfe01281a42",
  }),
  identity: Object.freeze({
    bundleIdentifier: "com.anysphere.sand",
    bundleVersion: "0.20.0",
    architecture: "arm64",
    signer: "Developer ID Application: Anysphere Incorporated (DCNK4UB866)",
    teamIdentifier: "DCNK4UB866",
    cdHash: "b6086bbb8fee0954c596997c2f20630be79d8417",
    notarized: true,
  }),
});

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

function assertSafeRelativePath(relative, label = "manifest path") {
  if (
    typeof relative !== "string" ||
    relative.length === 0 ||
    relative.length > 4096 ||
    relative.includes("\\") ||
    /[\0-\x1f\x7f-\x9f]/.test(relative) ||
    path.posix.isAbsolute(relative) ||
    relative !== relative.normalize("NFC") ||
    path.posix.normalize(relative) !== relative ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(relative)}`);
  }
  return relative;
}

function safeSymlinkResolution(root, relative, target) {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.length > 4096 ||
    target.includes("\\") ||
    /[\0-\x1f\x7f-\x9f]/.test(target) ||
    path.posix.isAbsolute(target) ||
    target.startsWith("~")
  ) {
    throw new Error(`Unsafe symlink target for ${relative}`);
  }
  const rootResolved = path.resolve(root);
  const linkDirectory = path.dirname(path.join(rootResolved, ...relative.split("/")));
  const resolved = path.resolve(linkDirectory, ...target.split("/"));
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Symlink target leaves the application: ${relative}`);
  }
  return resolved;
}

function validateManifest(manifest) {
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Vendor manifest must be an object");
  }
  for (const field of ["schemaVersion", "product", "version", "platform"]) {
    if (manifest[field] !== SUPPORTED[field]) {
      throw new Error(`Unsupported vendor manifest ${field}`);
    }
  }
  if (JSON.stringify(manifest.artifact) !== JSON.stringify(SUPPORTED.artifact)) {
    throw new Error("Unsupported vendor artifact identity");
  }
  if (JSON.stringify(manifest.identity) !== JSON.stringify(SUPPORTED.identity)) {
    throw new Error("Unsupported vendor application identity");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Vendor manifest files are missing");
  }
  const paths = [];
  const caseFolded = new Set();
  for (const entry of manifest.files) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Vendor manifest file entry must be an object");
    }
    const relative = assertSafeRelativePath(entry.path);
    paths.push(relative);
    const folded = relative.toLowerCase();
    if (caseFolded.has(folded)) {
      throw new Error(`Duplicate vendor manifest path: ${relative}`);
    }
    caseFolded.add(folded);
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new Error(`Invalid file size for ${relative}`);
      }
      if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error(`Invalid file hash for ${relative}`);
      }
      if (Object.hasOwn(entry, "target")) {
        throw new Error(`File entry cannot have a symlink target: ${relative}`);
      }
    } else if (entry.type === "symlink") {
      if (typeof entry.target !== "string" || entry.target.length === 0) {
        throw new Error(`Invalid symlink target for ${relative}`);
      }
      if (Object.hasOwn(entry, "sha256") || Object.hasOwn(entry, "bytes")) {
        throw new Error(`Symlink entry cannot have file metadata: ${relative}`);
      }
    } else {
      throw new Error(`Unsupported manifest file type for ${relative}`);
    }
  }
  const sorted = [...paths].sort();
  if (!paths.every((value, index) => value === sorted[index])) {
    throw new Error("Vendor manifest paths must be sorted");
  }
  if (!manifest.files.some((entry) => entry.path === "Contents/Resources/app.asar")) {
    throw new Error("Vendor manifest is missing app.asar");
  }
  return manifest;
}

function inventoryApp(appPath) {
  const root = path.resolve(appPath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Vendor application root must be a real directory");
  }
  const entries = [];
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop();
    const absolute = directory === "" ? root : path.join(root, ...directory.split("/"));
    const children = fs.readdirSync(absolute).sort().reverse();
    for (const child of children) {
      const relative = directory === "" ? child : `${directory}/${child}`;
      assertSafeRelativePath(relative, "application path");
      const target = path.join(root, ...relative.split("/"));
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        pending.push(relative);
      } else if (stat.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(target);
        safeSymlinkResolution(root, relative, linkTarget);
        entries.push({ path: relative, type: "symlink", target: linkTarget });
      } else if (stat.isFile()) {
        entries.push({
          path: relative,
          type: "file",
          bytes: stat.size,
          sha256: sha256File(target),
        });
      } else {
        throw new Error(`Unsupported application file type: ${relative}`);
      }
    }
  }
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function verifyTree(appPath, manifest) {
  const root = path.resolve(appPath);
  for (const entry of manifest.files) {
    if (entry.type === "symlink") {
      safeSymlinkResolution(root, entry.path, entry.target);
    }
  }
  const actual = inventoryApp(root);
  const expectedByPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  for (const entry of manifest.files) {
    const found = actualByPath.get(entry.path);
    if (found == null) throw new Error(`Missing manifest file: ${entry.path}`);
    if (found.type !== entry.type) throw new Error(`File type mismatch: ${entry.path}`);
    if (entry.type === "symlink") {
      if (found.target !== entry.target) {
        throw new Error(`Symlink target mismatch: ${entry.path}`);
      }
      continue;
    }
    if (found.bytes !== entry.bytes) throw new Error(`File size mismatch: ${entry.path}`);
    if (found.sha256 !== entry.sha256) throw new Error(`File hash mismatch: ${entry.path}`);
  }
  for (const entry of actual) {
    if (!expectedByPath.has(entry.path)) {
      throw new Error(`Unexpected vendor application file: ${entry.path}`);
    }
  }
  return actual;
}

function run(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
    throw new Error(`${command} failed (${result.status}): ${detail}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function plistValue(appPath, key) {
  const plist = path.join(appPath, "Contents", "Info.plist");
  return run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]).trim();
}

async function probeVendorIdentity(appPath) {
  const executable = path.join(appPath, "Contents", "MacOS", "Grok Bot");
  const architectureOutput = run("/usr/bin/file", [executable]);
  if (!/Mach-O 64-bit executable arm64(?:\s|$)/.test(architectureOutput)) {
    throw new Error("Vendor application architecture is not thin arm64");
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const signature = run("/usr/bin/codesign", ["-dvvv", "--strict", appPath]);
  const gatekeeper = run("/usr/sbin/spctl", ["-a", "-vv", "--type", "execute", appPath]);
  const signer = /^Authority=(.+)$/m.exec(signature)?.[1];
  const teamIdentifier = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1];
  const cdHash = /^CDHash=([a-f0-9]+)$/m.exec(signature)?.[1];
  return {
    bundleIdentifier: plistValue(appPath, "CFBundleIdentifier"),
    bundleVersion: plistValue(appPath, "CFBundleShortVersionString"),
    architecture: "arm64",
    signer,
    teamIdentifier,
    cdHash,
    notarized:
      /Notarization Ticket=stapled/.test(signature) &&
      /accepted/.test(gatekeeper) &&
      /source=Notarized Developer ID/.test(gatekeeper),
  };
}

function verifyIdentity(actual, expected) {
  for (const field of Object.keys(expected)) {
    if (actual?.[field] !== expected[field]) {
      throw new Error(`Vendor application identity mismatch: ${field}`);
    }
  }
}

async function verifyVendorApp({ appPath, manifest, probeIdentity = probeVendorIdentity }) {
  validateManifest(manifest);
  const actualFiles = verifyTree(appPath, manifest);
  const identity = await probeIdentity(appPath);
  verifyIdentity(identity, manifest.identity);
  const asar = manifest.files.find(
    (entry) => entry.path === "Contents/Resources/app.asar",
  );
  return {
    ok: true,
    product: manifest.product,
    version: manifest.version,
    platform: manifest.platform,
    files: actualFiles.length,
    appAsarSha256: asar.sha256,
  };
}

function verifyDmg(dmgPath, manifest) {
  validateManifest(manifest);
  const stat = fs.statSync(dmgPath);
  if (!stat.isFile()) throw new Error("Vendor DMG must be a regular file");
  if (stat.size !== manifest.artifact.bytes) throw new Error("Vendor DMG size mismatch");
  if (sha256File(dmgPath) !== manifest.artifact.sha256) {
    throw new Error("Vendor DMG hash mismatch");
  }
  run("/usr/bin/hdiutil", ["verify", dmgPath]);
  return { ok: true, bytes: stat.size, sha256: manifest.artifact.sha256 };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`Invalid argument: ${key}`);
    }
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.app || !args.manifest) {
    throw new Error("Usage: verify-vendor-app.cjs --app <Grok Bot.app> --manifest <manifest.json> [--dmg <vendor.dmg>]");
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), "utf8"));
  if (args.dmg) verifyDmg(path.resolve(args.dmg), manifest);
  const result = await verifyVendorApp({
    appPath: path.resolve(args.app),
    manifest,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SUPPORTED,
  assertSafeRelativePath,
  inventoryApp,
  probeVendorIdentity,
  sha256File,
  validateManifest,
  verifyDmg,
  verifyIdentity,
  verifyTree,
  verifyVendorApp,
};
