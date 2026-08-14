"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const generator = path.join(
  root,
  "scripts",
  "New-WindowsSandboxAcceptanceHarness.ps1",
);
const runner = path.join(
  root,
  "scripts",
  "Invoke-WindowsSandboxAcceptance.ps1",
);
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function createDevelopmentInstallerFixture(t) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-sandbox-harness-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const revisionResult = run("git", ["rev-parse", "--short=12", "HEAD"]);
  assert.equal(
    revisionResult.status,
    0,
    revisionResult.stderr || revisionResult.stdout,
  );
  const revision = revisionResult.stdout.trim().toLowerCase();
  const installerName = `CodexBot-Setup-0.1.4-DEVELOPMENT-20260814T000000000Z-${revision}.exe`;
  const installer = path.join(temporary, installerName);
  const source = path.join(temporary, "fixture.cs");
  fs.writeFileSync(
    source,
    String.raw`using System.Reflection;
[assembly: AssemblyTitle("Codex Bot DEVELOPMENT TEST installer - DO NOT PUBLISH")]
[assembly: AssemblyDescription("Codex Bot DEVELOPMENT TEST installer - DO NOT PUBLISH")]
[assembly: AssemblyCompany("Codex Bot contributors")]
[assembly: AssemblyProduct("Codex Bot DEVELOPMENT TEST BUILD")]
[assembly: AssemblyVersion("0.1.4.0")]
[assembly: AssemblyFileVersion("0.1.4.0")]
[assembly: AssemblyInformationalVersion("0.1.4 DEVELOPMENT TEST BUILD")]
internal static class Program { private static void Main() {} }
`,
    "utf8",
  );
  const compile = run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -Path $env:CODEX_BOT_FIXTURE_SOURCE -OutputAssembly $env:CODEX_BOT_FIXTURE_EXE -OutputType WindowsApplication",
    ],
    {
      env: {
        ...process.env,
        CODEX_BOT_FIXTURE_SOURCE: source,
        CODEX_BOT_FIXTURE_EXE: installer,
      },
    },
  );
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);
  const hash = sha256(installer);
  const sidecar = `${installer}.sha256`;
  fs.writeFileSync(sidecar, `${hash}  ${installerName}\n`, "ascii");
  return { temporary, revision, installerName, installer, sidecar, hash };
}

function generate(fixture, output, extra = []) {
  return run(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    generator,
    "-InstallerPath",
    fixture.installer,
    "-ExpectedSha256",
    fixture.hash,
    "-ExpectedBrandedExecutableSha256",
    fixture.hash,
    "-OutputRoot",
    output,
    "-DryRun",
    ...extra,
  ]);
}

test("dry run generates two isolated WSB scenarios from an audited DEVELOPMENT pair", (t) => {
  const fixture = createDevelopmentInstallerFixture(t);
  const output = path.join(fixture.temporary, "generated");
  const result = generate(fixture, output);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const interactivePath = path.join(
    output,
    "CodexBot-Acceptance-Interactive.wsb",
  );
  const silentPath = path.join(output, "CodexBot-Acceptance-Silent.wsb");
  assert.ok(fs.existsSync(interactivePath));
  assert.ok(fs.existsSync(silentPath));
  const interactive = fs.readFileSync(interactivePath, "utf8");
  const silent = fs.readFileSync(silentPath, "utf8");

  for (const config of [interactive, silent]) {
    assert.match(config, /<Networking>Enable<\/Networking>/);
    assert.match(config, /<vGPU>Disable<\/vGPU>/);
    assert.match(
      config,
      /<ClipboardRedirection>Disable<\/ClipboardRedirection>/,
    );
    assert.match(config, /<PrinterRedirection>Disable<\/PrinterRedirection>/);
    assert.match(config, /<AudioInput>Disable<\/AudioInput>/);
    assert.match(config, /<VideoInput>Disable<\/VideoInput>/);
    assert.match(config, /<ProtectedClient>Enable<\/ProtectedClient>/);
    assert.equal((config.match(/<MappedFolder>/g) || []).length, 3);
    assert.equal((config.match(/<ReadOnly>true<\/ReadOnly>/g) || []).length, 2);
    assert.equal(
      (config.match(/<ReadOnly>false<\/ReadOnly>/g) || []).length,
      1,
    );
    assert.match(config, new RegExp(fixture.hash));
    assert.match(
      config,
      new RegExp(fixture.installerName.replaceAll(".", "\\.")),
    );
  }
  assert.match(interactive, /-Scenario &quot;Interactive&quot;/);
  assert.match(silent, /-Scenario &quot;Silent&quot;/);

  assert.deepEqual(fs.readdirSync(path.join(output, "artifact")).sort(), [
    fixture.installerName,
    `${fixture.installerName}.sha256`,
  ]);
  assert.deepEqual(fs.readdirSync(path.join(output, "harness")).sort(), [
    "Invoke-WindowsSandboxAcceptance.ps1",
    "artifact-audit.json",
  ]);
  assert.deepEqual(
    fs.readdirSync(path.join(output, "evidence", "interactive")),
    [],
  );
  assert.deepEqual(fs.readdirSync(path.join(output, "evidence", "silent")), []);

  const receipt = JSON.parse(
    fs.readFileSync(
      path.join(output, "harness", "artifact-audit.json"),
      "utf8",
    ),
  );
  assert.equal(receipt.auditPolicy, "codex-bot-development-sandbox-v1");
  assert.equal(receipt.audited, true);
  assert.equal(receipt.sha256, fixture.hash);
  assert.equal(receipt.gitRevision, fixture.revision);
  assert.equal(receipt.brandedExecutableSha256, fixture.hash);
  assert.match(receipt.patchInputsSha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.vendorManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.productName, "Codex Bot DEVELOPMENT TEST BUILD");
  assert.equal(
    receipt.fileDescription,
    "Codex Bot DEVELOPMENT TEST installer - DO NOT PUBLISH",
  );
});

test("generation fails closed on an unreviewed hash, non-development name, or reused evidence root", (t) => {
  const fixture = createDevelopmentInstallerFixture(t);

  const wrongHash = { ...fixture, hash: "0".repeat(64) };
  const hashFailure = generate(
    wrongHash,
    path.join(fixture.temporary, "wrong-hash"),
  );
  assert.notEqual(hashFailure.status, 0);
  assert.match(hashFailure.stderr, /independently reviewed value/i);

  fs.writeFileSync(
    fixture.sidecar,
    `${fixture.hash} ${fixture.installerName}\n`,
    "ascii",
  );
  const sidecarFailure = generate(
    fixture,
    path.join(fixture.temporary, "wrong-sidecar"),
  );
  assert.notEqual(sidecarFailure.status, 0);
  assert.match(sidecarFailure.stderr, /exact canonical record/i);
  fs.writeFileSync(
    fixture.sidecar,
    `${fixture.hash}  ${fixture.installerName}\n`,
    "ascii",
  );

  const releaseName = "CodexBot-Setup-0.1.4.exe";
  const releaseInstaller = path.join(fixture.temporary, releaseName);
  fs.copyFileSync(fixture.installer, releaseInstaller);
  const releaseHash = sha256(releaseInstaller);
  fs.writeFileSync(
    `${releaseInstaller}.sha256`,
    `${releaseHash}  ${releaseName}\n`,
    "ascii",
  );
  const nameFailure = generate(
    { ...fixture, installer: releaseInstaller, hash: releaseHash },
    path.join(fixture.temporary, "release-name"),
  );
  assert.notEqual(nameFailure.status, 0);
  assert.match(nameFailure.stderr, /DEVELOPMENT installer/i);

  const existing = path.join(fixture.temporary, "existing");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "prior-evidence.txt"), "do not mix\n");
  const reuseFailure = generate(fixture, existing);
  assert.notEqual(reuseFailure.status, 0);
  assert.match(
    reuseFailure.stderr,
    /already exists.*evidence cannot be mixed/i,
  );
  assert.equal(
    fs.readFileSync(path.join(existing, "prior-evidence.txt"), "utf8"),
    "do not mix\n",
  );

  const unavailableOutput = path.join(fixture.temporary, "sandbox-unavailable");
  const unavailable = run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      String.raw`. $env:CODEX_BOT_GENERATOR
function Get-WindowsSandboxReadiness { [pscustomobject]@{ ready = $false; executable = 'unavailable'; reason = 'fixture unavailable' } }
function Start-Process { throw 'UNEXPECTED SANDBOX START' }
try {
  Invoke-HarnessGeneration -InstallerPath $env:CODEX_BOT_INSTALLER -SidecarPath $env:CODEX_BOT_SIDECAR -ExpectedSha256 $env:CODEX_BOT_HASH -ExpectedBrandedExecutableSha256 $env:CODEX_BOT_BRANDED_HASH -OutputRoot $env:CODEX_BOT_OUTPUT -LaunchScenario Silent | Out-Null
  Write-Error 'generation unexpectedly returned'
  exit 2
} catch {
  if ($_.Exception.Message -notmatch 'Windows Sandbox launch is blocked') {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 3
  }
  exit 0
}`,
    ],
    {
      env: {
        ...process.env,
        CODEX_BOT_GENERATOR: generator,
        CODEX_BOT_INSTALLER: fixture.installer,
        CODEX_BOT_SIDECAR: fixture.sidecar,
        CODEX_BOT_HASH: fixture.hash,
        CODEX_BOT_BRANDED_HASH: fixture.hash,
        CODEX_BOT_OUTPUT: unavailableOutput,
      },
    },
  );
  assert.equal(
    unavailable.status,
    0,
    JSON.stringify({
      stdout: unavailable.stdout,
      stderr: unavailable.stderr,
      error: unavailable.error?.message,
    }),
  );
});

test("sandbox runner enforces clean baseline, sanitization, and manual authentication", () => {
  const generatorSource = fs.readFileSync(generator, "utf8");
  const runnerSource = fs.readFileSync(runner, "utf8");

  assert.match(
    generatorSource,
    /Get-CimInstance[\s\S]*Containers-DisposableClientVM/,
  );
  assert.match(generatorSource, /Windows Sandbox launch is blocked/);
  assert.doesNotMatch(
    generatorSource,
    /Enable-WindowsOptionalFeature|dism(?:\.exe)?\s+\/Enable-Feature/i,
  );
  assert.match(runnerSource, /Codex Bot Bridge/);
  assert.match(runnerSource, /Programs\\Grok Bot/);
  assert.match(runnerSource, /Programs\\Cursor/);
  assert.match(runnerSource, /uninstall-registry/);
  assert.match(runnerSource, /app-path-registry/);
  assert.match(runnerSource, /Get-ScheduledTask/);
  assert.match(runnerSource, /The installer was not executed/);
  assert.match(runnerSource, /\/BOOTSTRAPGROKBOT=1/);
  assert.match(
    runnerSource,
    /Test-InstalledCodexRuntime[\s\S]*resources\/app\.asar[\s\S]*Codex Bot\.exe/,
  );
  assert.match(runnerSource, /vendorRuntimeVerified/);
  assert.match(runnerSource, /Read-Host[\s\S]*do not type credentials here/);
  assert.match(runnerSource, /authenticationAutomation = \$false/);
  assert.match(runnerSource, /Copy-SanitizedInstallerLog/);
  assert.match(runnerSource, /sensitive-data scan/);
  assert.match(runnerSource, /Test-DeterministicPatchedAsar/);
  assert.match(runnerSource, /Get-InstalledPatchInputsDigest/);
  assert.doesNotMatch(runnerSource, /ExpectedPatchedAppAsarSha256/);
  assert.match(runnerSource, /Stop-GuestProductProcessesForEvidenceExport/);
  assert.match(runnerSource, /Export-SanitizedEvidenceToHost/);
  assert.match(runnerSource, /Read-GuestRuntimeInMemory/);
  assert.match(runnerSource, /Test-ExpectedLoopbackListener/);
  assert.match(runnerSource, /productListenersLoopbackOnly/);
  assert.match(runnerSource, /\/api\/codex\/status/);
  assert.match(runnerSource, /\/api\/frame\?seatKey=sandbox-acceptance-review/);
  assert.match(runnerSource, /Drawing\.Image\]::FromStream/);
  assert.match(runnerSource, /directNavigationOperatorAttested = \$true/);
  assert.match(runnerSource, /takeoverReleaseOperatorAttested = \$true/);
  assert.doesNotMatch(
    runnerSource,
    /Start-Transcript|SendKeys|WScript\.Shell|UIAutomation|connection\.json|credentials\.json/i,
  );
});

test("authenticated backend evidence contains only allowlisted booleans, counts, and dimensions", () => {
  const source = fs.readFileSync(runner, "utf8");
  const functionStart = source.indexOf("function Get-GuestBackendVerification");
  const functionEnd = source.indexOf(
    "function Test-InstalledCodexRuntime",
    functionStart,
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const backendFunction = source.slice(functionStart, functionEnd);
  const reportStart = backendFunction.indexOf(
    "$report = [pscustomobject][ordered]@{",
  );
  const reportEnd = backendFunction.indexOf("return $report", reportStart);
  assert.ok(reportStart >= 0 && reportEnd > reportStart);
  const report = backendFunction.slice(reportStart, reportEnd);
  const keys = [...report.matchAll(/^\s{12}([A-Za-z][A-Za-z0-9]+)\s*=/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(keys, [
    "schemaVersion",
    "verified",
    "codexSignedIn",
    "codexAvailable",
    "proxyAvailable",
    "proxyModelCount",
    "gatewayAvailable",
    "officialMode",
    "officialConnected",
    "officialReady",
    "officialErrorAbsent",
    "frameValid",
    "frameWidth",
    "frameHeight",
    "frameByteCount",
    "expectedListenersVerified",
    "productListenersLoopbackOnly",
    "productProcessCount",
    "productTcpListenerCount",
    "productUdpEndpointCount",
  ]);
  assert.doesNotMatch(
    report,
    /name|email|url|screenshot|header|accountId|access|refresh|bearer|credential/i,
  );
  assert.doesNotMatch(
    backendFunction,
    /Write-JsonEvidence|Write-Host|Write-Output|Set-Content|Add-Content/,
  );
  assert.ok(
    backendFunction.indexOf("Get-VerifiedGuestListenerReport") <
      backendFunction.indexOf("$viewHeaders = @{"),
    "listener identity must be proven before local authentication headers exist",
  );
  assert.match(
    backendFunction,
    /screenshotBase64 = \$null[\s\S]*viewHeaders = \$null[\s\S]*runtime = \$null/,
  );
  assert.match(
    source,
    /x-codex-seat-token[\s\S]*gateway\[_ -\]\?token[\s\S]*proxy\[_ -\]\?key[\s\S]*api\[_ -\]\?key/i,
  );
});

test("post-install archive verification recomputes bytes and rejects a nonempty corrupt archive", (t) => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-patch-recompute-"),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "vendor.asar");
  const installed = path.join(temporary, "installed.asar");
  const runtime = path.join(temporary, "runtime.json");
  const patcher = path.join(temporary, "patch-app.cjs");
  const executableSource = path.join(temporary, "fake-electron.cs");
  const executable = path.join(temporary, "fake-electron.exe");
  fs.writeFileSync(source, "trusted vendor archive\n", "utf8");
  fs.copyFileSync(source, installed);
  fs.writeFileSync(runtime, '{"schemaVersion":2}\n', "utf8");
  fs.writeFileSync(patcher, "// reviewed fixture patcher\n", "utf8");
  fs.writeFileSync(
    executableSource,
    String.raw`using System;
using System.IO;
internal static class Program {
  private static int Main(string[] args) {
    string source = null, target = null;
    for (int i = 0; i + 1 < args.Length; i++) {
      if (args[i] == "--source-asar") source = args[++i];
      else if (args[i] == "--target-asar") target = args[++i];
    }
    if (source == null || target == null) return 2;
    File.Copy(source, target, true);
    return 0;
  }
}`,
    "utf8",
  );
  const compile = run(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Add-Type -Path $env:CODEX_BOT_FIXTURE_SOURCE -OutputAssembly $env:CODEX_BOT_FIXTURE_EXE -OutputType ConsoleApplication",
    ],
    {
      env: {
        ...process.env,
        CODEX_BOT_FIXTURE_SOURCE: executableSource,
        CODEX_BOT_FIXTURE_EXE: executable,
      },
    },
  );
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);

  const invoke = () =>
    run(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        String.raw`. $env:CODEX_BOT_RUNNER -Scenario Silent -ArtifactDirectory fixture -HarnessDirectory fixture -EvidenceDirectory fixture -ExpectedSha256 $('0' * 64) -ExpectedInstallerName fixture -ExpectedVersion 0.1.4 -ExpectedRevision 14fcf819cd7a -ExpectedBrandedExecutableSha256 $('1' * 64) -ExpectedPatchInputsSha256 $('2' * 64) -ExpectedVendorManifestSha256 $('3' * 64)
$verified = Test-DeterministicPatchedAsar -VendorSourceAsar $env:CODEX_BOT_SOURCE -InstalledPatchedAsar $env:CODEX_BOT_INSTALLED -VendorElectronExecutable $env:CODEX_BOT_EXECUTABLE -PatcherPath $env:CODEX_BOT_PATCHER -RuntimePath $env:CODEX_BOT_RUNTIME
if ($verified) { exit 0 } else { exit 7 }`,
      ],
      {
        env: {
          ...process.env,
          CODEX_BOT_RUNNER: runner,
          CODEX_BOT_SOURCE: source,
          CODEX_BOT_INSTALLED: installed,
          CODEX_BOT_EXECUTABLE: executable,
          CODEX_BOT_PATCHER: patcher,
          CODEX_BOT_RUNTIME: runtime,
        },
      },
    );

  const exact = invoke();
  assert.equal(exact.status, 0, exact.stderr || exact.stdout);
  fs.writeFileSync(installed, "CORRUPT BUT NONEMPTY\n", "utf8");
  const corrupt = invoke();
  assert.equal(corrupt.status, 7, corrupt.stderr || corrupt.stdout);
});

test("both PowerShell harness scripts parse without errors", () => {
  for (const script of [generator, runner]) {
    const parsed = run(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        String.raw`$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile($env:CODEX_BOT_SCRIPT,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{Write-Error $_.Message};exit 1}`,
      ],
      { env: { ...process.env, CODEX_BOT_SCRIPT: script } },
    );
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
  }
});
