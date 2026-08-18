"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.resolve(__dirname, "..");
const runtimeVerifier = path.join(root, "scripts", "Verify-GrokBotRuntime.ps1");
const installerVerifier = path.join(
  root,
  "scripts",
  "Verify-GrokBotInstaller.ps1",
);
const manifestGenerator = path.join(
  root,
  "scripts",
  "New-GrokBotRuntimeManifest.ps1",
);
const releaseManifestPath = path.join(
  root,
  "assets",
  "grok-bot-0.18.0-windows-x64.manifest.json",
);
const expectedSignerSubject =
  'CN="Anysphere, Inc.", O="Anysphere, Inc.", L=San Francisco, S=California, C=US';
const expectedSignerThumbprint = "67E878CBE262D364A6D059B77DAC002E2C064F0E";
const expectedInstallerIssuer =
  "CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US";
const expectedInstallerUrl =
  "https://downloads.cursor.com/grokbot/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe";
const expectedInstallerHash =
  "464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E";
const expectedInstallerSize = 125825552;
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function createFixture(t, additionalFiles = []) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-vendor-integrity-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const tree = path.join(temporary, "Grok Bot");
  fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "Grok Bot.exe"), "test executable bytes\n");
  for (const [relative, contents] of additionalFiles) {
    const file = path.join(tree, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const paths = [
    "Grok Bot.exe",
    ...additionalFiles.map(([relative]) => relative),
  ].sort();
  const manifest = {
    schemaVersion: 1,
    product: "Grok Bot",
    version: "0.18.0",
    platform: "windows-x64",
    signer: {
      subject: expectedSignerSubject,
      thumbprint: expectedSignerThumbprint,
    },
    files: paths.map((relative) => ({
      path: relative,
      sha256: sha256(path.join(tree, ...relative.split("/"))),
    })),
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
  return childProcess.spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PSModulePath: undefined,
        CODEX_BOT_TEST_VERIFIER: runtimeVerifier,
        CODEX_BOT_TEST_TREE: fixture.tree,
        CODEX_BOT_TEST_MANIFEST: fixture.manifestPath,
        CODEX_BOT_TEST_SIGNER_SUBJECT: expectedSignerSubject,
        CODEX_BOT_TEST_SIGNER_THUMBPRINT: signerThumbprint,
      },
    },
  );
}

test("the reviewed 0.18 runtime manifest is complete, canonical, and pinned", () => {
  const manifest = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
  assert.deepEqual(
    {
      schemaVersion: manifest.schemaVersion,
      product: manifest.product,
      version: manifest.version,
      platform: manifest.platform,
    },
    {
      schemaVersion: 1,
      product: "Grok Bot",
      version: "0.18.0",
      platform: "windows-x64",
    },
  );
  assert.deepEqual(manifest.signer, {
    subject: expectedSignerSubject,
    thumbprint: expectedSignerThumbprint,
  });
  assert.equal(manifest.files.length, 657);
  const paths = manifest.files.map(({ path: relative }) => relative);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(
    new Set(paths.map((relative) => relative.toLowerCase())).size,
    paths.length,
  );
  for (const entry of manifest.files) {
    assert.match(
      entry.path,
      /^(?![A-Za-z]:)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+$/,
    );
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
  const byPath = new Map(
    manifest.files.map((entry) => [entry.path, entry.sha256]),
  );
  assert.equal(
    byPath.get("resources/app.asar"),
    "38e85c0e5042c0257db7925e1e55709d6d155d90d92fe26ad654127d509766e0",
  );
  assert.equal(
    byPath.get("Grok Bot.exe"),
    "86719c9dcbfc580b7bc29ece62302401a7622ae577e2cff42b4c525db674f1ca",
  );
  assert.equal(
    byPath.get("Uninstall Grok Bot.exe"),
    "4e4045884146e852beb42b22d95c509d6a5439e362236410eb5d45cc9cfe380a",
  );
  for (const required of [
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "ffmpeg.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "vulkan-1.dll",
  ]) {
    assert.match(byPath.get(required), /^[a-f0-9]{64}$/);
  }
});

test("the runtime verifier accepts a complete matching tree with the pinned signer", (t) => {
  const fixture = createFixture(t, [
    ["resources/app.asar", "supported archive bytes\n"],
  ]);
  const result = verifyFixture(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("the runtime verifier rejects missing, extra, and hash-mismatched files", async (t) => {
  await t.test("missing", (subtest) => {
    const fixture = createFixture(subtest, [
      ["resources/app.asar", "supported archive bytes\n"],
    ]);
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

test("the runtime verifier rejects reparse points without traversing them", (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.temporary, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "payload.dll"), "outside\n");
  try {
    fs.symlinkSync(outside, path.join(fixture.tree, "linked"), "junction");
  } catch (error) {
    if (error.code === "EPERM")
      return t.skip("This Windows session cannot create a test junction.");
    throw error;
  }
  const result = verifyFixture(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reparse point/i);
});

test("the runtime verifier rejects a valid signature from any signer except the pin", (t) => {
  const fixture = createFixture(t);
  const result = verifyFixture(
    fixture,
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not by the reviewed pinned signer/i);
});

test("the vendor-installer verifier pins size, bytes, metadata, and artifact signer", (t) => {
  const source = fs.readFileSync(installerVerifier, "utf8");
  for (const pin of [
    String(expectedInstallerSize),
    expectedInstallerHash,
    "0.18.0",
    "Grok Bot",
    "SpaceXAI",
    expectedSignerSubject,
    expectedSignerThumbprint,
    expectedInstallerIssuer,
  ]) {
    assert.ok(source.includes(pin), `missing installer pin: ${pin}`);
  }
  assert.match(source, /FileAttributes\]::ReparsePoint/);
  assert.match(source, /Security\.Cryptography\.SHA256/);
  assert.match(source, /System\.Management\.Automation\.SignatureHelper/);
  assert.ok(
    source.indexOf("Security.Cryptography.SHA256") <
      source.indexOf("SignatureHelper"),
    "the exact bytes must be pinned before trusting their signature",
  );

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-installer-verifier-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const fakeInstaller = path.join(temporary, "Grok_Bot_0.18.0_Setup.exe");
  fs.writeFileSync(fakeInstaller, "not the reviewed installer\n");
  const result = childProcess.spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installerVerifier,
      "-InstallerPath",
      fakeInstaller,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /length is wrong/i);
});

test("manifest generation is deterministic and restricted to a clean signed 0.18 tree", () => {
  const source = fs.readFileSync(manifestGenerator, "utf8");
  for (const required of [
    "$expectedVersion = '0.18.0'",
    expectedSignerSubject,
    expectedSignerThumbprint,
    "FileAttributes]::ReparsePoint",
    "Get-AuthenticodeSignature",
    "Get-FileHash -Algorithm SHA256",
    "[Array]::Sort($paths, [StringComparer]::Ordinal)",
    "case-insensitive duplicate path",
  ]) {
    assert.ok(
      source.includes(required),
      `manifest generator lost required control: ${required}`,
    );
  }
});

test("the bootstrap downloads only the explicitly authorized vendor-hosted pinned installer and never packages it", () => {
  const inno = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  assert.ok(inno.includes(expectedInstallerUrl));
  assert.ok(inno.includes(expectedInstallerHash));
  assert.ok(inno.includes(String(expectedInstallerSize)));
  assert.doesNotMatch(
    inno,
    /Source:\s*"[^\r\n]*(?:Grok_Bot_0\.18\.0_Setup|CursorUserSetup-x64-0\.18\.0)\.exe"/i,
  );
  assert.match(
    inno,
    /DownloadPage\.Add\([\s\S]*VendorInstallerURL[\s\S]*VendorInstallerSHA256/,
  );
  assert.match(inno, /ExtractTemporaryFile\('Verify-GrokBotInstaller\.ps1'\)/);
  assert.match(
    inno,
    /DownloadAndVerifyVendorInstaller[\s\S]*Verify-GrokBotInstaller\.ps1/,
  );
  assert.match(
    inno,
    /ExecAsOriginalUser\([\s\S]*VendorInstallerName[\s\S]*'\/S \/currentuser'/,
  );
  assert.match(inno, /cursor\.com\/terms-of-service/);
  assert.match(inno, /cursor\.com\/privacy/);
  assert.match(inno, /exact separate 120 MiB per-user installer/);
  assert.match(
    inno,
    /remains installed if Open Bot Setup fails, is canceled, or Open Bot is later uninstalled/,
  );
  assert.match(inno, /VendorChoicePage\.SelectedValueIndex := -1/);
  assert.doesNotMatch(inno, /VendorChoicePage\.SelectedValueIndex := [01]/);
  assert.match(
    inno,
    /CreateInputOptionPage\([\s\S]*?wpSelectDir,[\s\S]*?True,\s*False\s*\)/,
    "the vendor acquisition choice must be an exclusive radio-button group",
  );
  assert.match(inno, /VendorChoicePage\.SelectedValueIndex = 0/);
});

test("interactive vendor acquisition requires a deliberate choice and rejects missing existing-only installs before Ready", () => {
  const inno = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  const nextStart = inno.indexOf("function NextButtonClick");
  const nextEnd = inno.indexOf("procedure CurStepChanged", nextStart);
  assert.ok(nextStart >= 0 && nextEnd > nextStart);
  const next = inno.slice(nextStart, nextEnd);

  const invalidated = next.indexOf("InvalidateInteractiveVendorChoiceCache");
  const noChoiceGate = next.indexOf(
    "if VendorChoicePage.SelectedValueIndex < 0 then",
  );
  assert.ok(
    invalidated >= 0 && noChoiceGate > invalidated,
    "every interactive choice evaluation must invalidate the prior prepared root first",
  );
  assert.match(
    next,
    /CurPageID = VendorChoicePage\.ID[\s\S]*SelectedValueIndex < 0/,
  );
  assert.match(
    next,
    /Nothing will be downloaded until you deliberately select the authorization option/,
  );
  assert.match(
    next,
    /SelectedValueIndex < 0[\s\S]*Result := False;[\s\S]*Exit;/,
  );

  const existingOnlyStart = next.indexOf(
    "if VendorChoicePage.SelectedValueIndex = 1 then",
  );
  const readyStart = next.indexOf("if (CurPageID = wpReady)");
  assert.ok(
    existingOnlyStart >= 0 && readyStart > existingOnlyStart,
    "the existing-only acquisition gate must run before the Ready page",
  );
  const existingOnly = next.slice(existingOnlyStart, readyStart);
  assert.match(existingOnly, /ExactVendorFound := FindExactVendorRoot/);
  assert.match(existingOnly, /if not ExactVendorFound then/);
  assert.match(existingOnly, /No download will occur/);
  assert.match(
    existingOnly,
    /Setup did not find an exact, signed Grok Bot 0\.18\.0 installation/,
  );
  assert.match(existingOnly, /Result := False;[\s\S]*Exit;/);
  assert.doesNotMatch(existingOnly, /DownloadAndVerifyVendorInstaller/);
  const verified = existingOnly.indexOf(
    "ExactVendorFound := FindExactVendorRoot",
  );
  const rejected = existingOnly.indexOf("if not ExactVendorFound then");
  const prepared = existingOnly.indexOf("VendorPrepared := True");
  assert.ok(
    verified >= 0 && rejected > verified && prepared > rejected,
    "only a successfully verified existing tree may satisfy the later Ready gate",
  );

  const prepareStart = inno.indexOf("function PrepareVendorDependency");
  const prepareEnd = inno.indexOf(
    "function GetCustomSetupExitCode",
    prepareStart,
  );
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  const prepare = inno.slice(prepareStart, prepareEnd);
  assert.ok(
    prepare.indexOf("if VendorPrepared then") <
      prepare.indexOf("if FindExactVendorRoot then"),
    "the Ready page must reuse the acquisition-page verification instead of hashing the full tree twice",
  );

  const invalidationStart = inno.indexOf(
    "procedure InvalidateInteractiveVendorChoiceCache",
  );
  const outcomeStart = inno.indexOf(
    "function PrepareVendorDependencyAndRecordExitCode",
    invalidationStart,
  );
  const outcomeEnd = inno.indexOf(
    "function GetCustomSetupExitCode",
    outcomeStart,
  );
  assert.ok(
    invalidationStart >= 0 &&
      outcomeStart > invalidationStart &&
      outcomeEnd > outcomeStart,
  );
  const invalidation = inno.slice(invalidationStart, outcomeStart);
  assert.match(
    invalidation,
    /VendorPrepared := False;[\s\S]*VerifiedVendorRoot := '';/,
  );
  assert.doesNotMatch(invalidation, /RequestedVendorRoot/);

  const outcome = inno.slice(outcomeStart, outcomeEnd);
  assert.match(
    outcome,
    /Result := PrepareVendorDependency;[\s\S]*if Result then[\s\S]*InstallExitCode := 0[\s\S]*else[\s\S]*InstallExitCode := 7/,
  );
  assert.equal(
    inno.match(/InstallExitCode := 7/g)?.length,
    1,
    "exit code 7 must be recorded only by the preparation-result wrapper",
  );

  const prepareToInstall = inno.slice(
    inno.indexOf("function PrepareToInstall"),
    nextStart,
  );
  assert.match(
    prepareToInstall,
    /if not PrepareVendorDependencyAndRecordExitCode then/,
  );
  assert.match(
    next.slice(readyStart),
    /Result := PrepareVendorDependencyAndRecordExitCode/,
  );
});

test(
  "the real Inno option page preserves a deliberate no-selection value",
  { timeout: 30_000 },
  (t) => {
    if (process.platform !== "win32")
      return t.skip("The Inno option-page probe is Windows-only.");

    const isccCandidates = [
      process.env.CODEX_BOT_ISCC,
      path.join(
        process.env.LOCALAPPDATA || "",
        "Programs",
        "Inno Setup 6",
        "ISCC.exe",
      ),
      path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Inno Setup 6",
        "ISCC.exe",
      ),
      path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Inno Setup 6",
        "ISCC.exe",
      ),
    ].filter(Boolean);
    const iscc = isccCandidates.find((candidate) => fs.existsSync(candidate));
    if (!iscc) return t.skip("Inno Setup 6 is not installed.");

    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "codex-bot-choice-probe-"),
    );
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const probePath = path.join(temporary, "choice-probe.iss");
    const resultPath = path.join(temporary, "choice-result.txt");
    fs.writeFileSync(
      probePath,
      String.raw`[Setup]
AppId={{218B68E7-85D6-450C-A351-29A0D64B4AE0}
AppName=Codex Bot explicit choice probe
AppVersion=1.0
DefaultDirName={tmp}\CodexBotExplicitChoiceProbe
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=${temporary}
OutputBaseFilename=choice-probe

[Code]
var
  ChoicePage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  ChoicePage := CreateInputOptionPage(
    wpWelcome,
    'Choice',
    'Choice',
    'Choose one.',
    True,
    False
  );
  ChoicePage.Add('Authorize');
  ChoicePage.Add('Existing only');
  ChoicePage.SelectedValueIndex := -1;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  SaveStringToFile(
    ExpandConstant('{param:RESULT|}'),
    IntToStr(ChoicePage.SelectedValueIndex),
    False
  );
end;
`,
    );

    const compile = childProcess.spawnSync(iscc, ["/Qp", probePath], {
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(
      compile.status,
      0,
      compile.stderr || compile.stdout || compile.error?.message,
    );
    const setup = path.join(temporary, "choice-probe.exe");
    assert.ok(fs.existsSync(setup), "the Inno choice probe did not compile");

    const execution = childProcess.spawnSync(
      setup,
      [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/SP-",
        `/RESULT=${resultPath}`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(
      execution.status,
      0,
      execution.stderr || execution.stdout || execution.error?.message,
    );
    assert.equal(fs.readFileSync(resultPath, "utf8"), "-1");
  },
);

test(
  "the real Inno retry state clears a recovered exit code and invalidates a re-evaluated choice cache",
  { timeout: 30_000 },
  (t) => {
    if (process.platform !== "win32")
      return t.skip("The Inno retry-state probe is Windows-only.");

    const inno = fs.readFileSync(
      path.join(root, "installer", "CodexBot.iss"),
      "utf8",
    );
    const invalidationStart = inno.indexOf(
      "procedure InvalidateInteractiveVendorChoiceCache",
    );
    const outcomeStart = inno.indexOf(
      "function PrepareVendorDependencyAndRecordExitCode",
      invalidationStart,
    );
    const outcomeEnd = inno.indexOf(
      "function GetCustomSetupExitCode",
      outcomeStart,
    );
    assert.ok(
      invalidationStart >= 0 &&
        outcomeStart > invalidationStart &&
        outcomeEnd > outcomeStart,
    );
    const invalidationSource = inno
      .slice(invalidationStart, outcomeStart)
      .trim();
    const outcomeSource = inno.slice(outcomeStart, outcomeEnd).trim();

    const isccCandidates = [
      process.env.CODEX_BOT_ISCC,
      path.join(
        process.env.LOCALAPPDATA || "",
        "Programs",
        "Inno Setup 6",
        "ISCC.exe",
      ),
      path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Inno Setup 6",
        "ISCC.exe",
      ),
      path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Inno Setup 6",
        "ISCC.exe",
      ),
    ].filter(Boolean);
    const iscc = isccCandidates.find((candidate) => fs.existsSync(candidate));
    if (!iscc) return t.skip("Inno Setup 6 is not installed.");

    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "codex-bot-retry-state-probe-"),
    );
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const probePath = path.join(temporary, "retry-state-probe.iss");
    const resultPath = path.join(temporary, "retry-state-result.txt");
    fs.writeFileSync(
      probePath,
      String.raw`[Setup]
AppId={{B7239089-EAD3-440A-96C8-4017F6875FC8}
AppName=Codex Bot retry state probe
AppVersion=1.0
DefaultDirName={tmp}\CodexBotRetryStateProbe
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=${temporary}
OutputBaseFilename=retry-state-probe

[Code]
var
  InstallExitCode: Integer;
  VendorPrepared: Boolean;
  VerifiedVendorRoot: String;
  NextPrepareResult: Boolean;
  PrepareCallCount: Integer;

function PrepareVendorDependency: Boolean;
begin
  PrepareCallCount := PrepareCallCount + 1;
  Result := NextPrepareResult;
end;

${invalidationSource}

${outcomeSource}

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  FailedExitCode: Integer;
  RecoveredExitCode: Integer;
  CachePrepared: String;
begin
  Result := '';
  InstallExitCode := 0;
  NextPrepareResult := False;
  if PrepareVendorDependencyAndRecordExitCode then
  begin
    Result := 'The first preparation unexpectedly succeeded.';
    Exit;
  end;
  FailedExitCode := InstallExitCode;

  NextPrepareResult := True;
  if not PrepareVendorDependencyAndRecordExitCode then
  begin
    Result := 'The retry unexpectedly failed.';
    Exit;
  end;
  RecoveredExitCode := InstallExitCode;

  VendorPrepared := True;
  VerifiedVendorRoot := 'stale-root';
  InvalidateInteractiveVendorChoiceCache;
  if VendorPrepared then
    CachePrepared := 'true'
  else
    CachePrepared := 'false';

  SaveStringToFile(
    ExpandConstant('{param:RESULT|}'),
    IntToStr(FailedExitCode) + '|' +
      IntToStr(RecoveredExitCode) + '|' +
      CachePrepared + '|' +
      VerifiedVendorRoot + '|' +
      IntToStr(PrepareCallCount),
    False
  );
end;
`,
    );

    const compile = childProcess.spawnSync(iscc, ["/Qp", probePath], {
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(
      compile.status,
      0,
      compile.stderr || compile.stdout || compile.error?.message,
    );
    const setup = path.join(temporary, "retry-state-probe.exe");
    assert.ok(
      fs.existsSync(setup),
      "the Inno retry-state probe did not compile",
    );

    const execution = childProcess.spawnSync(
      setup,
      [
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/SP-",
        `/RESULT=${resultPath}`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(
      execution.status,
      0,
      execution.stderr || execution.stdout || execution.error?.message,
    );
    assert.equal(fs.readFileSync(resultPath, "utf8"), "7|0|false||2");
  },
);

test("the bootstrap bounds the vendor download before verification", () => {
  const inno = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  assert.match(
    inno,
    /function GetVendorInstallerSizeBytes:\s*Int64;[\s\S]*Result := \{#VendorInstallerSize\}/,
  );
  assert.match(
    inno,
    /CreateDownloadPage\([\s\S]*@OnVendorDownloadProgress\s*\)/,
  );

  const callbackStart = inno.indexOf("function OnVendorDownloadProgress");
  const callbackEnd = inno.indexOf("procedure InitializeWizard", callbackStart);
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
  const callback = inno.slice(callbackStart, callbackEnd);
  assert.match(callback, /const Progress, ProgressMax:\s*Int64/);
  assert.match(
    callback,
    /\(ProgressMax > 0\) and\s*\(ProgressMax <> GetVendorInstallerSizeBytes\)/,
  );
  assert.match(callback, /Progress > GetVendorInstallerSizeBytes/);
  assert.match(callback, /Result := False/);

  const flowStart = inno.indexOf("function DownloadAndVerifyVendorInstaller");
  const flowEnd = inno.indexOf("function InstallVendorDependency", flowStart);
  assert.ok(flowStart >= 0 && flowEnd > flowStart);
  const flow = inno.slice(flowStart, flowEnd);
  const downloaded = flow.indexOf("DownloadedBytes := DownloadPage.Download;");
  const exactSizeGate = flow.indexOf(
    "if DownloadedFileSize <> GetVendorInstallerSizeBytes then",
  );
  const cacheHitGate = flow.indexOf("(DownloadedBytes <> 0)");
  const verifier = flow.indexOf("Verify-GrokBotInstaller.ps1");
  const userCancellation = flow.indexOf("if DownloadPage.AbortedByUser then");
  const policyRejection = flow.indexOf(
    "else if VendorDownloadPolicyError <> '' then",
  );
  assert.ok(downloaded >= 0, "Download() byte count must be captured");
  assert.ok(
    userCancellation >= 0 && policyRejection > userCancellation,
    "an explicit user cancellation must retain its distinct error semantics",
  );
  assert.ok(
    exactSizeGate > downloaded,
    "the downloaded file size must be checked after Download()",
  );
  assert.ok(
    cacheHitGate > exactSizeGate,
    "only Inno's documented zero-byte cache hit may bypass the returned-count equality check",
  );
  assert.ok(
    verifier > exactSizeGate,
    "the exact byte-count gate must precede the executable verifier",
  );
});

test(
  "the real Inno callback accepts an exact response and stops mismatched or chunked oversized responses",
  { timeout: 60_000 },
  async (t) => {
    if (process.platform !== "win32")
      return t.skip("The Inno download probe is Windows-only.");

    const isccCandidates = [
      process.env.CODEX_BOT_ISCC,
      path.join(
        process.env.LOCALAPPDATA || "",
        "Programs",
        "Inno Setup 6",
        "ISCC.exe",
      ),
      path.join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Inno Setup 6",
        "ISCC.exe",
      ),
      path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Inno Setup 6",
        "ISCC.exe",
      ),
    ].filter(Boolean);
    const iscc = isccCandidates.find((candidate) => fs.existsSync(candidate));
    if (!iscc) return t.skip("Inno Setup 6 is not installed.");

    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "codex-bot-download-cap-probe-"),
    );
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const serverLog = path.join(temporary, "server.jsonl");
    const serverSource = String.raw`
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const expected = 1024 * 1024;
const totals = new Map([
  ["/exact", expected],
  ["/mismatch", expected * 2],
  ["/chunked", expected * 8],
]);
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const total = totals.get(pathname);
  if (!total) {
    response.writeHead(404).end();
    return;
  }
  const headers = { "Content-Type": "application/octet-stream" };
  if (pathname !== "/chunked") headers["Content-Length"] = String(total);
  response.writeHead(200, headers);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const pace = pathname === "/chunked" ? 5 : 1;
  let sent = 0;
  let recorded = false;
  const record = (event) => {
    if (recorded) return;
    recorded = true;
    fs.appendFileSync(
      process.env.CODEX_BOT_PROBE_SERVER_LOG,
      JSON.stringify({ pathname, total, sent, event }) + "\n",
    );
  };
  response.once("finish", () => record("finish"));
  response.once("close", () => record("close"));
  const sendNext = () => {
    if (response.destroyed) return;
    if (sent >= total) {
      response.end();
      return;
    }
    const bytes = Math.min(chunk.length, total - sent);
    const writable = response.write(chunk.subarray(0, bytes));
    sent += bytes;
    const resume = () => setTimeout(sendNext, pace);
    if (writable) resume();
    else response.once("drain", resume);
  };
  sendNext();
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
    const server = childProcess.spawn(process.execPath, ["-e", serverSource], {
      env: {
        ...process.env,
        CODEX_BOT_PROBE_SERVER_LOG: serverLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverStderr = "";
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (chunk) => {
      serverStderr += chunk;
    });
    t.after(() => {
      if (server.exitCode === null) server.kill();
    });
    const port = await new Promise((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(
        () =>
          reject(new Error(`probe server startup timed out: ${serverStderr}`)),
        5_000,
      );
      server.stdout.setEncoding("utf8");
      server.stdout.on("data", (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        resolve(JSON.parse(stdout.slice(0, newline)).port);
      });
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `probe server exited during startup (${code}): ${serverStderr}`,
          ),
        );
      });
    });

    const inno = fs.readFileSync(
      path.join(root, "installer", "CodexBot.iss"),
      "utf8",
    );
    const guardStart = inno.indexOf("function GetVendorInstallerSizeBytes");
    const guardEnd = inno.indexOf("procedure InitializeWizard", guardStart);
    assert.ok(guardStart >= 0 && guardEnd > guardStart);
    const productionGuard = inno.slice(guardStart, guardEnd).trim();
    const probePath = path.join(temporary, "download-cap-probe.iss");
    const outputPath = temporary;
    fs.writeFileSync(
      probePath,
      String.raw`#define VendorInstallerSize "1048576"

[Setup]
AppId={{7B63AD62-E9A6-4E5D-A112-6C1417329AE4}
AppName=Codex Bot download cap probe
AppVersion=1.0
DefaultDirName={tmp}\CodexBotDownloadCapProbe
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=${outputPath}
OutputBaseFilename=download-cap-probe

[Code]
var
  DownloadPage: TDownloadWizardPage;
  VendorDownloadPolicyError: String;

${productionGuard}

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage('Probe', 'Probe', @OnVendorDownloadProgress);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  DownloadedBytes: Int64;
  CachedBytes: Int64;
  ResultPath: String;
  Url: String;
begin
  Result := '';
  ResultPath := ExpandConstant('{param:RESULT|}');
  Url := ExpandConstant('{param:URL|}');
  VendorDownloadPolicyError := '';
  DownloadPage.Clear;
  DownloadPage.Add(Url, 'payload.bin', '9bc1b2a288b26af7257a36277ae3816a7d4f16e89c1e7e77d0a5c48bad62b360');
  try
    DownloadedBytes := DownloadPage.Download;
    if CompareText(ExpandConstant('{param:CACHEHIT|0}'), '1') = 0 then
    begin
      DownloadPage.Clear;
      DownloadPage.Add(Url, 'payload.bin', '9bc1b2a288b26af7257a36277ae3816a7d4f16e89c1e7e77d0a5c48bad62b360');
      CachedBytes := DownloadPage.Download;
      SaveStringToFile(ResultPath, 'CACHE:' + IntToStr(DownloadedBytes) + ':' + IntToStr(CachedBytes), False);
    end
    else if DownloadedBytes = GetVendorInstallerSizeBytes then
      SaveStringToFile(ResultPath, 'OK:' + IntToStr(DownloadedBytes), False)
    else
      SaveStringToFile(ResultPath, 'COUNT_MISMATCH:' + IntToStr(DownloadedBytes), False);
  except
    SaveStringToFile(ResultPath, 'REJECT:' + VendorDownloadPolicyError + ':' + GetExceptionMessage, False);
  end;
end;
`,
    );
    const compile = childProcess.spawnSync(iscc, ["/Qp", probePath], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(
      compile.status,
      0,
      compile.stderr || compile.stdout || compile.error?.message,
    );
    const setup = path.join(temporary, "download-cap-probe.exe");
    assert.ok(fs.existsSync(setup), "the Inno probe did not compile");

    const runProbe = (route, extraArgs = []) => {
      const suffix = extraArgs.length ? "-cache" : "";
      const resultPath = path.join(temporary, `${route}${suffix}.txt`);
      const execution = childProcess.spawnSync(
        setup,
        [
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART",
          "/SP-",
          `/URL=http://127.0.0.1:${port}/${route}`,
          `/RESULT=${resultPath}`,
          ...extraArgs,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(
        execution.status,
        0,
        execution.stderr || execution.stdout || execution.error?.message,
      );
      assert.ok(fs.existsSync(resultPath), `${route} probe produced no result`);
      return fs.readFileSync(resultPath, "utf8");
    };

    assert.equal(runProbe("exact"), "OK:1048576");
    assert.equal(runProbe("exact", ["/CACHEHIT=1"]), "CACHE:1048576:0");
    assert.match(runProbe("mismatch"), /^REJECT:.*size did not match/i);
    assert.match(runProbe("chunked"), /^REJECT:.*exceeded the pinned/i);

    let entries = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (fs.existsSync(serverLog)) {
        entries = fs
          .readFileSync(serverLog, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      }
      if (entries.some((entry) => entry.pathname === "/chunked")) break;
      await delay(25);
    }
    const exact = entries.find((entry) => entry.pathname === "/exact");
    const mismatch = entries.find((entry) => entry.pathname === "/mismatch");
    const chunked = entries.find((entry) => entry.pathname === "/chunked");
    assert.deepEqual(
      { sent: exact?.sent, total: exact?.total, event: exact?.event },
      { sent: 1024 * 1024, total: 1024 * 1024, event: "finish" },
    );
    assert.ok(
      mismatch && mismatch.sent < mismatch.total,
      "a known mismatched length should be rejected before the full body arrives",
    );
    assert.ok(
      chunked && chunked.sent < chunked.total,
      "a chunked oversized body should be stopped before the full body arrives",
    );
  },
);

test("bootstrap discovery is ordered, fail-closed, and ownership-safe", () => {
  const inno = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  const discovery = inno.slice(
    inno.indexOf("function FindExactVendorRoot"),
    inno.indexOf("function BootstrapAllowed"),
  );
  const order = [
    "RequestedVendorRoot",
    "FindVendorInRegistry(HKCU64)",
    "FindVendorInRegistry(HKCU32)",
    "FindVendorInRegistry(HKLM64)",
    "FindVendorInRegistry(HKLM32)",
    "{localappdata}\\Programs\\Grok Bot",
    "{localappdata}\\Programs\\grok-bot",
    "{commonpf}\\Grok Bot",
  ];
  let previous = -1;
  for (const anchor of order) {
    const current = discovery.indexOf(anchor);
    assert.ok(current > previous, `discovery order is wrong at ${anchor}`);
    previous = current;
  }
  assert.match(
    inno,
    /function VerifyVendorCandidate[\s\S]*Verify-GrokBotRuntime\.ps1[\s\S]*ewWaitUntilTerminated/,
  );
  assert.match(
    inno,
    /function HasConflictingPerUserVendor[\s\S]*HasPerUserVendorInRegistry\(HKCU64\)[\s\S]*HasPerUserVendorInRegistry\(HKCU32\)/,
  );
  const ownershipGate = inno.slice(
    inno.indexOf("function HasConflictingPerUserVendor"),
    inno.indexOf("function FindExactVendorRoot"),
  );
  assert.doesNotMatch(ownershipGate, /HKLM/);
  assert.match(
    inno,
    /if HasConflictingPerUserVendor then[\s\S]*will not repair, overwrite, update, or downgrade/,
  );
});

test("bootstrap silent, cancellation, and rollback semantics are explicit", () => {
  const inno = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  const bootstrap = inno.slice(
    inno.indexOf("function BootstrapAllowed"),
    inno.indexOf("function DownloadAndVerifyVendorInstaller"),
  );
  assert.match(
    bootstrap,
    /if WizardSilent then\s*Result := CompareText\(Trim\(ExpandConstant\('\{param:BOOTSTRAPGROKBOT\|0\}'\)\), '1'\) = 0\s*else\s*Result := VendorChoicePage\.SelectedValueIndex = 0/,
  );
  assert.match(
    inno,
    /function PrepareToInstall[\s\S]*PrepareVendorDependencyAndRecordExitCode/,
  );
  assert.match(
    inno,
    /if \(CurPageID = wpReady\) and \(not WizardSilent\) then/,
  );
  assert.match(inno, /DownloadPage\.AbortedByUser[\s\S]*download was canceled/);
  assert.match(
    inno,
    /VendorProgressPage\.Show[\s\S]*ExecAsOriginalUser[\s\S]*ewWaitUntilTerminated/,
  );
  assert.match(
    inno,
    /separate vendor application remains installed if Open Bot Setup is later canceled or fails/i,
  );
  assert.match(inno, /separate vendor installation was not rolled back/i);
  assert.match(
    inno,
    /separately installed official Grok Bot app remains installed and is not rolled back/i,
  );
});

test("both installer phases verify the complete runtime before Grok Bot.exe can execute", () => {
  const inno = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  const install = fs.readFileSync(
    path.join(root, "scripts", "Install-CodexBot.ps1"),
    "utf8",
  );
  assert.match(inno, /Verify-GrokBotRuntime\.ps1"; Flags: dontcopy/);
  assert.match(
    inno,
    /grok-bot-0\.18\.0-windows-x64\.manifest\.json"; Flags: dontcopy/,
  );
  assert.match(inno, /function PrepareToInstall[\s\S]*PrepareVendorDependency/);
  assert.match(
    inno,
    /Verify-GrokBotRuntime\.ps1"; DestDir: "\{app\}\\tools\\integrity"/,
  );
  assert.match(
    inno,
    /grok-bot-0\.18\.0-windows-x64\.manifest\.json"; DestDir: "\{app\}\\tools\\integrity"/,
  );
  assert.match(
    inno,
    /Source: "\{code:GetVendorRoot\}\\\*"[\s\S]*ExternalSize: 496010226/,
  );
  const verification = install.indexOf(
    "& $runtimeVerifier -InstallRoot $appRoot -ManifestPath $runtimeManifest",
  );
  const firstLaunch = install.indexOf("$patchProcess = Start-Process");
  assert.ok(
    verification >= 0 && firstLaunch > verification,
    "copied runtime verification must precede every vendor-process launch",
  );
});

test("upgrades remove only the managed Chromium debug log before exact runtime verification", () => {
  const install = fs.readFileSync(
    path.join(root, "scripts", "Install-CodexBot.ps1"),
    "utf8",
  );
  const cleanup = install.indexOf(
    "Remove-Item -LiteralPath $managedRuntimeDebugLog -Force",
  );
  const verification = install.indexOf(
    "& $runtimeVerifier -InstallRoot $appRoot -ManifestPath $runtimeManifest",
  );

  assert.match(
    install,
    /\$managedRuntimeDebugLog = Join-Path \$appRoot 'debug\.log'/,
  );
  assert.ok(cleanup >= 0 && verification > cleanup);
  assert.doesNotMatch(
    install.slice(0, verification),
    /Remove-Item[^\r\n]*\$appRoot[^\r\n]*-Recurse/i,
    "upgrade cleanup must not replace complete-tree verification with a broad app deletion",
  );
});

test("release building gates bootstrap inputs and never stages the proprietary installer", () => {
  const builder = fs.readFileSync(
    path.join(root, "scripts", "build-installer.ps1"),
    "utf8",
  );
  for (const required of [
    "Verify-GrokBotInstaller.ps1",
    "Verify-GrokBotRuntime.ps1",
    "grok-bot-0.18.0-windows-x64.manifest.json",
    "@('check', 'test', 'audit:release')",
  ]) {
    assert.ok(
      builder.includes(required),
      `builder lost mandatory gate: ${required}`,
    );
  }
  assert.doesNotMatch(
    builder,
    /downloads\.cursor\.com|Grok_Bot_0\.18\.0_Setup\.exe|CursorUserSetup-x64-0\.18\.0\.exe/i,
  );
  const inno = fs.readFileSync(
    path.join(root, "installer", "CodexBot.iss"),
    "utf8",
  );
  assert.doesNotMatch(inno, /New-GrokBotRuntimeManifest\.ps1/);
});
