"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");

test("installation registers the watchdog but leaves first-run startup to the launcher", () => {
  const installer = read("scripts/Install-CodexBot.ps1");
  const enableAlwaysOn = read("src/runtime/Enable-Always-On.ps1");
  const launcher = read("src/runtime/Launch-Codex-Bot.ps1");

  assert.match(installer, /& \$enableAlwaysOn/);
  assert.match(
    enableAlwaysOn,
    /Register-ScheduledTask -TaskName 'Codex Bot Bridge'/,
  );
  assert.doesNotMatch(enableAlwaysOn, /Start-ScheduledTask/);

  const desktopStart = launcher.indexOf(
    "Start-Process -FilePath $portable",
    launcher.indexOf("if ($DebugRenderer)"),
  );
  const watchdogStart = launcher.indexOf(
    "Start-ScheduledTask -TaskName 'Codex Bot Bridge'",
  );
  assert.ok(desktopStart >= 0, "launcher must start the desktop");
  assert.ok(
    watchdogStart > desktopStart,
    "watchdog handoff must happen after the desktop start",
  );
});

test("scheduled and interactive launches use the windowless system script host", () => {
  const manifest = read("installer/CodexBot.iss");
  const enableAlwaysOn = read("src/runtime/Enable-Always-On.ps1");
  const hiddenRunner = read("src/runtime/CodexBot-Hidden-Runner.vbs");

  assert.match(
    enableAlwaysOn,
    /\$windowsScriptHost = Join-Path \$env:SystemRoot 'System32\\wscript\.exe'/,
  );
  assert.match(
    enableAlwaysOn,
    /New-ScheduledTaskAction -Execute \$windowsScriptHost/,
  );
  assert.match(enableAlwaysOn, /CodexBot-Hidden-Runner\.vbs/);

  const runSection = manifest.match(/\[Run\]([\s\S]*?)\r?\n\[/)?.[1] ?? "";
  assert.match(runSection, /Filename: "\{sys\}\\wscript\.exe"/i);
  assert.match(runSection, /CodexBot-Hidden-Runner\.vbs/);
  assert.match(runSection, /Flags:.*\brunhidden\b/i);
  assert.equal((manifest.match(/\{sys\}\\wscript\.exe/gi) || []).length, 3);

  assert.match(hiddenRunner, /Case "launcher"[\s\S]*waitForExit = False/);
  assert.match(hiddenRunner, /Case "watchdog"[\s\S]*waitForExit = True/);
  assert.match(hiddenRunner, /shell\.Run\(command, 0, waitForExit\)/);

  const syntaxProbe = spawnSync(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "cscript.exe",
    ),
    [
      "//B",
      "//NoLogo",
      path.join(root, "src", "runtime", "CodexBot-Hidden-Runner.vbs"),
      "invalid-mode",
    ],
    { windowsHide: true },
  );
  assert.equal(syntaxProbe.status, 64, syntaxProbe.stderr?.toString("utf8"));
});

test("launcher records failures even though it has no console", () => {
  const launcher = read("src/runtime/Launch-Codex-Bot.ps1");
  assert.match(launcher, /function Write-SafeLauncherLog/);
  assert.match(
    launcher,
    /trap \{[\s\S]*Write-SafeLauncherLog \("Launch failed: "/,
  );
  assert.match(launcher, /launcher\.log/);
  assert.match(launcher, /Registered watchdog task could not be started/);
});

test("both supervisors safely adopt a verified same-install listener that won a bind race", () => {
  for (const relativePath of [
    "src/runtime/Launch-Codex-Bot.ps1",
    "src/runtime/CodexBot-Watchdog.ps1",
  ]) {
    const source = read(relativePath);
    assert.match(source, /function Get-VerifiedLoopbackListenerProcessId/);
    assert.match(
      source,
      /\$processIds = @\(Get-NetTCPConnection[\s\S]*OwningProcess -Unique\)/,
    );
    assert.match(
      source,
      /Test-ExpectedLoopbackListener -Port \$Port -ExpectedExecutable \$ExpectedExecutable -ExpectedProcessId \$candidateProcessId/,
    );
    assert.match(
      source,
      /\$script:expectedProxyProcessId = \$verifiedProcessId/,
    );
    assert.match(
      source,
      /\$script:expectedHostProcessId = \$verifiedProcessId/,
    );
    assert.match(
      source,
      /function Test-CLIProxyAPI[\s\S]*Get-VerifiedLoopbackListenerProcessId[\s\S]*Authorization = "Bearer \$\(\$runtime\.proxyKey\)"/,
    );
    assert.match(
      source,
      /function Test-CoworkerGateway[\s\S]*Get-VerifiedLoopbackListenerProcessId[\s\S]*Authorization = "Bearer \$\(\$runtime\.gatewayToken\)"/,
    );
  }
});
