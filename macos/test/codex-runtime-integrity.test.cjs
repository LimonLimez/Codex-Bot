"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(macRoot, "assets", "openai-codex-0.147.0-darwin-arm64.json");
const runtimeIntegrityPath = path.join(macRoot, "src", "desktop", "codex-runtime-integrity.cjs");
const verifierPath = path.join(macRoot, "scripts", "verify-codex-runtime.cjs");

const EXPECTED_ARCHIVE = Object.freeze({
  name: "codex-aarch64-apple-darwin.tar.gz",
  url: "https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-aarch64-apple-darwin.tar.gz",
  bytes: 87984231,
  sha256: "75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358",
});
const EXPECTED_EXECUTABLE = Object.freeze({
  name: "codex-aarch64-apple-darwin",
  bytes: 219997536,
  sha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
  identifier: "codex",
  architecture: "arm64",
  version: "0.147.0",
  signer: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
  teamIdentifier: "2DC432GLL2",
  cdHash: "95686307357ad315175f553a68dce5c62d0ff435",
  hardenedRuntime: true,
  timestamped: true,
});
const EXPECTED_IDENTITY = Object.freeze({
  identifier: EXPECTED_EXECUTABLE.identifier,
  architecture: EXPECTED_EXECUTABLE.architecture,
  version: EXPECTED_EXECUTABLE.version,
  signer: EXPECTED_EXECUTABLE.signer,
  teamIdentifier: EXPECTED_EXECUTABLE.teamIdentifier,
  cdHash: EXPECTED_EXECUTABLE.cdHash,
  hardenedRuntime: true,
  timestamped: true,
});

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-runtime-integrity-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createArchive(t, entries) {
  const root = tempRoot(t);
  const contents = path.join(root, "contents");
  fs.mkdirSync(contents);
  for (const entry of entries) {
    const target = path.join(contents, entry.name);
    if (entry.type === "symlink") fs.symlinkSync(entry.target, target);
    else {
      fs.writeFileSync(target, entry.contents || "fixture\n");
      fs.chmodSync(target, entry.mode || 0o755);
    }
  }
  const archivePath = path.join(root, "runtime.tar.gz");
  childProcess.execFileSync("/usr/bin/tar", ["-czf", archivePath, "-C", contents, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { archivePath, bytes: fs.statSync(archivePath).size, sha256: sha256File(archivePath) };
}

test("canonical Codex runtime manifest pins the official signed 0.147.0 arm64 artifact", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    product: "Codex",
    version: "0.147.0",
    releaseTag: "rust-v0.147.0",
    publishedAt: "2026-08-07T01:41:49Z",
    upstreamRepository: "https://github.com/openai/codex",
    platform: "darwin-arm64",
    archive: EXPECTED_ARCHIVE,
    executable: EXPECTED_EXECUTABLE,
    license: {
      spdx: "Apache-2.0",
      url: "https://raw.githubusercontent.com/openai/codex/rust-v0.147.0/LICENSE",
    },
  });
  assert.doesNotMatch(JSON.stringify(manifest), /\/Users\/|\/private\/tmp\/|Bearer |sk-|access[_-]?token/i);
  const ignored = childProcess.spawnSync("git", ["check-ignore", "--quiet", manifestPath], {
    cwd: macRoot,
    stdio: "ignore",
  });
  assert.equal(ignored.status, 1, "the public non-secret runtime manifest must not match credential ignore rules");
});

test("archive verifier accepts exactly one regular executable and rejects extra or linked members", (t) => {
  const { inspectCodexArchive, verifyArchiveFile } = require(verifierPath);
  const exact = createArchive(t, [{ name: EXPECTED_EXECUTABLE.name, contents: "fixture codex\n" }]);
  assert.deepEqual(verifyArchiveFile(exact.archivePath, {
    bytes: exact.bytes,
    sha256: exact.sha256,
  }), { bytes: exact.bytes, sha256: exact.sha256 });
  assert.deepEqual(inspectCodexArchive(exact.archivePath), {
    entry: EXPECTED_EXECUTABLE.name,
    type: "file",
  });

  const extra = createArchive(t, [
    { name: EXPECTED_EXECUTABLE.name, contents: "fixture codex\n" },
    { name: "private.log", contents: "developer residue\n" },
  ]);
  assert.throws(() => inspectCodexArchive(extra.archivePath), /exactly one|unexpected/i);

  const linked = createArchive(t, [{
    name: EXPECTED_EXECUTABLE.name,
    type: "symlink",
    target: "/usr/bin/true",
  }]);
  assert.throws(() => inspectCodexArchive(linked.archivePath), /regular|symlink|type/i);

  assert.throws(
    () => verifyArchiveFile(exact.archivePath, { bytes: exact.bytes + 1, sha256: exact.sha256 }),
    /size/i,
  );
  assert.throws(
    () => verifyArchiveFile(exact.archivePath, { bytes: exact.bytes, sha256: "0".repeat(64) }),
    /hash/i,
  );
});

test("runtime integrity accepts only the exact executable and authoritative OpenAI identity", async (t) => {
  const { verifyCodexRuntime } = require(runtimeIntegrityPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, EXPECTED_EXECUTABLE.name);
  fs.writeFileSync(binaryPath, "synthetic signed binary\n");
  fs.chmodSync(binaryPath, 0o755);
  const receipt = Object.freeze({
    schemaVersion: 1,
    version: "0.147.0",
    bytes: fs.statSync(binaryPath).size,
    sha256: sha256File(binaryPath),
    identity: EXPECTED_IDENTITY,
  });
  const verified = await verifyCodexRuntime({
    binaryPath,
    receipt,
    probeIdentity: async () => EXPECTED_IDENTITY,
  });
  assert.deepEqual(verified, { binaryPath, version: "0.147.0" });
  assert.equal(Object.isFrozen(verified), true);

  fs.appendFileSync(binaryPath, "changed\n");
  await assert.rejects(
    verifyCodexRuntime({ binaryPath, receipt, probeIdentity: async () => EXPECTED_IDENTITY }),
    /integrity|size|hash/i,
  );
  fs.writeFileSync(binaryPath, "synthetic signed binary\n");
  fs.chmodSync(binaryPath, 0o755);
  await assert.rejects(
    verifyCodexRuntime({
      binaryPath,
      receipt,
      probeIdentity: async () => ({ ...EXPECTED_IDENTITY, teamIdentifier: "FOREIGNTEAM" }),
    }),
    /identity|team/i,
  );
});

test("packaged runtime loader rejects hostile receipts symlinks and non-executable files", async (t) => {
  const { loadPackagedCodexRuntime } = require(runtimeIntegrityPath);
  const root = tempRoot(t);
  const runtimeRoot = path.join(root, "codex", "runtime");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const binaryPath = path.join(runtimeRoot, "codex");
  fs.writeFileSync(binaryPath, "synthetic signed binary\n");
  fs.chmodSync(binaryPath, 0o755);
  const receiptPath = path.join(runtimeRoot, "receipt.json");
  const receipt = {
    schemaVersion: 1,
    version: "0.147.0",
    bytes: fs.statSync(binaryPath).size,
    sha256: sha256File(binaryPath),
    identity: EXPECTED_IDENTITY,
  };
  const expectedRuntime = Object.freeze({
    version: receipt.version,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
  });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o644 });
  assert.deepEqual(await loadPackagedCodexRuntime(root, {
    probeIdentity: async () => EXPECTED_IDENTITY,
    expectedRuntime,
  }), { binaryPath, version: "0.147.0" });

  fs.writeFileSync(binaryPath, "different OpenAI-signed fixture bytes\n");
  fs.chmodSync(binaryPath, 0o755);
  const selfConsistentForgery = {
    ...receipt,
    bytes: fs.statSync(binaryPath).size,
    sha256: sha256File(binaryPath),
  };
  fs.writeFileSync(receiptPath, JSON.stringify(selfConsistentForgery));
  await assert.rejects(
    loadPackagedCodexRuntime(root, { probeIdentity: async () => EXPECTED_IDENTITY, expectedRuntime }),
    /receipt|integrity|hash|size/i,
  );

  fs.writeFileSync(binaryPath, "synthetic signed binary\n");
  fs.chmodSync(binaryPath, 0o755);
  fs.writeFileSync(receiptPath, JSON.stringify({ ...receipt, endpoint: "private" }));
  await assert.rejects(
    loadPackagedCodexRuntime(root, { probeIdentity: async () => EXPECTED_IDENTITY, expectedRuntime }),
    /receipt|shape/i,
  );
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  fs.chmodSync(binaryPath, 0o644);
  await assert.rejects(
    loadPackagedCodexRuntime(root, { probeIdentity: async () => EXPECTED_IDENTITY, expectedRuntime }),
    /executable|integrity/i,
  );
  fs.rmSync(binaryPath);
  fs.symlinkSync("/usr/bin/true", binaryPath);
  await assert.rejects(
    loadPackagedCodexRuntime(root, { probeIdentity: async () => EXPECTED_IDENTITY, expectedRuntime }),
    /symlink|regular|integrity/i,
  );
});

test("identity probe derives version architecture hardened runtime timestamp and signer from system output", async (t) => {
  const { probeCodexIdentity } = require(runtimeIntegrityPath);
  const root = tempRoot(t);
  const binaryPath = path.join(root, "codex");
  fs.writeFileSync(binaryPath, "fixture\n");
  fs.chmodSync(binaryPath, 0o755);
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "/usr/bin/file") return `${binaryPath}: Mach-O 64-bit executable arm64\n`;
    if (command === binaryPath) return "codex-cli 0.147.0\n";
    if (args[0] === "--verify") return "";
    return [
      "Identifier=codex",
      "CDHash=95686307357ad315175f553a68dce5c62d0ff435",
      "Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)",
      "Authority=Developer ID Certification Authority",
      "TeamIdentifier=2DC432GLL2",
      "flags=0x10000(runtime)",
      "Timestamp=Aug 6, 2026 at 9:17:46 PM",
    ].join("\n");
  };
  assert.deepEqual(await probeCodexIdentity(binaryPath, { run }), EXPECTED_IDENTITY);
  assert.deepEqual(calls.map(([command]) => command), [
    "/usr/bin/file",
    binaryPath,
    "/usr/bin/codesign",
    "/usr/bin/codesign",
  ]);
});
