"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const verifier = path.join(root, "scripts", "Verify-GrokBotRuntime.ps1");
const releaseManifestPath = path.join(root, "assets", "grok-bot-0.16.0-windows-x64.manifest.json");
const expectedSignerSubject = 'CN="Anysphere, Inc.", O="Anysphere, Inc.", L=San Francisco, S=California, C=US';
const expectedSignerThumbprint = "786DA5811DB0A4B3C1AD4754B4CC06BF76C97827";
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createFixture(t, additionalFiles = []) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-vendor-integrity-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const tree = path.join(temporary, "Grok Bot");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "Grok Bot.exe"), "test executable bytes\n");
  for (const [relative, contents] of additionalFiles) {
    const file = path.join(tree, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const paths = ["Grok Bot.exe", ...additionalFiles.map(([relative]) => relative)].sort();
  const manifest = {
    schemaVersion: 1,
    product: "Grok Bot",
    version: "0.16.0",
    platform: "windows-x64",
    signer: { subject: expectedSignerSubject, thumbprint: expectedSignerThumbprint },
    files: paths.map((relative) => ({ path: relative, sha256: sha256(path.join(tree, ...relative.split("/"))) })),
  };
  const manifestPath = path.join(temporary, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { temporary, tree, manifestPath };
}

function verifyFixture(fixture, signerThumbprint = expectedSignerThumbprint) {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
function Get-AuthenticodeSignature {
  param([string]$LiteralPath)
  [pscustomobject]@{
    Status = [System.Management.Automation.SignatureStatus]::Valid
    SignerCertificate = [pscustomobject]@{
      Subject = $env:CODEX_BOT_TEST_SIGNER_SUBJECT
      Thumbprint = $env:CODEX_BOT_TEST_SIGNER_THUMBPRINT
    }
  }
}
& $env:CODEX_BOT_TEST_VERIFIER -InstallRoot $env:CODEX_BOT_TEST_TREE -ManifestPath $env:CODEX_BOT_TEST_MANIFEST | ConvertTo-Json -Compress
`;
  return childProcess.spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_BOT_TEST_VERIFIER: verifier,
      CODEX_BOT_TEST_TREE: fixture.tree,
      CODEX_BOT_TEST_MANIFEST: fixture.manifestPath,
      CODEX_BOT_TEST_SIGNER_SUBJECT: expectedSignerSubject,
      CODEX_BOT_TEST_SIGNER_THUMBPRINT: signerThumbprint,
    },
  });
}

test("the reviewed vendor manifest is complete, canonical, and pinned", () => {
  const manifest = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
  assert.deepEqual(
    { schemaVersion: manifest.schemaVersion, product: manifest.product, version: manifest.version, platform: manifest.platform },
    { schemaVersion: 1, product: "Grok Bot", version: "0.16.0", platform: "windows-x64" },
  );
  assert.deepEqual(manifest.signer, { subject: expectedSignerSubject, thumbprint: expectedSignerThumbprint });
  assert.equal(manifest.files.length, 657);
  assert.deepEqual(manifest.files.map(({ path: relative }) => relative), [...manifest.files.map(({ path: relative }) => relative)].sort());
  assert.equal(new Set(manifest.files.map(({ path: relative }) => relative.toLowerCase())).size, manifest.files.length);
  for (const entry of manifest.files) {
    assert.match(entry.path, /^(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
  const byPath = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  assert.equal(byPath.get("resources/app.asar"), "955fb24e72ec85729cac2f921758a93a85089a0fc659e712125d6650b364d20e");
  for (const required of ["Grok Bot.exe", "d3dcompiler_47.dll", "dxcompiler.dll", "ffmpeg.dll", "libEGL.dll", "libGLESv2.dll", "vulkan-1.dll"]) {
    assert.match(byPath.get(required), /^[a-f0-9]{64}$/);
  }
});

test("the verifier accepts a complete matching tree with the pinned signer", (t) => {
  const fixture = createFixture(t, [["resources/app.asar", "supported archive bytes\n"]]);
  const result = verifyFixture(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("the verifier rejects missing, extra, and hash-mismatched files", async (t) => {
  await t.test("missing", (subtest) => {
    const fixture = createFixture(subtest, [["resources/app.asar", "supported archive bytes\n"]]);
    fs.rmSync(path.join(fixture.tree, "resources", "app.asar"));
    const result = verifyFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing manifest file/i);
  });
  await t.test("extra", (subtest) => {
    const fixture = createFixture(subtest);
    fs.writeFileSync(path.join(fixture.tree, "poison.dll"), "poison\n");
    const result = verifyFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unexpected file/i);
  });
  await t.test("mismatch", (subtest) => {
    const fixture = createFixture(subtest);
    fs.appendFileSync(path.join(fixture.tree, "Grok Bot.exe"), "changed\n");
    const result = verifyFixture(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/i);
  });
});

test("the verifier rejects reparse points without traversing them", (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.temporary, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "payload.dll"), "outside\n");
  try {
    fs.symlinkSync(outside, path.join(fixture.tree, "linked"), "junction");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("This Windows session cannot create a test junction.");
    throw error;
  }
  const result = verifyFixture(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reparse point/i);
});

test("the verifier rejects a valid signature from any signer except the pin", (t) => {
  const fixture = createFixture(t);
  const result = verifyFixture(fixture, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not by the reviewed pinned signer/i);
});

test("both installer phases verify the runtime before Grok Bot.exe can execute", () => {
  const inno = fs.readFileSync(path.join(root, "installer", "CodexBot.iss"), "utf8");
  const install = fs.readFileSync(path.join(root, "scripts", "Install-CodexBot.ps1"), "utf8");
  assert.match(inno, /Verify-GrokBotRuntime\.ps1"; Flags: dontcopy/);
  assert.match(inno, /grok-bot-0\.16\.0-windows-x64\.manifest\.json"; Flags: dontcopy/);
  assert.match(inno, /function PrepareToInstall[\s\S]*Verify-GrokBotRuntime\.ps1[\s\S]*ewWaitUntilTerminated/);
  assert.match(inno, /Verify-GrokBotRuntime\.ps1"; DestDir: "\{app\}\\tools\\integrity"/);
  assert.match(inno, /grok-bot-0\.16\.0-windows-x64\.manifest\.json"; DestDir: "\{app\}\\tools\\integrity"/);
  const verification = install.indexOf("& $runtimeVerifier -InstallRoot $appRoot -ManifestPath $runtimeManifest");
  const firstLaunch = install.indexOf("$patchProcess = Start-Process");
  assert.ok(verification >= 0 && firstLaunch > verification, "copied runtime verification must precede every vendor-process launch");
});
