"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "src", "runtime", "Local-Service-Identity.ps1");
const read = (relativePath) => fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let pending = "";
    const onData = (chunk) => {
      pending += chunk.toString("utf8");
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(pending.slice(0, newline).trim());
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`listener process exited before reporting its port (${code})`));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", reject);
    };
    stream.on("data", onData);
    stream.on("error", reject);
    stream.once("close", () => {});
    stream.__ownerProcess?.once("exit", onExit);
  });
}

test("listener identity requires the current user, exact executable, and expected PID", async (t) => {
  const listenerScript = [
    "$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)",
    "$listener.Start()",
    "[Console]::Out.WriteLine(([Net.IPEndPoint]$listener.LocalEndpoint).Port)",
    "[Console]::Out.Flush()",
    "Start-Sleep -Seconds 30",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", listenerScript], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.__ownerProcess = child;
  t.after(() => child.kill());

  const port = Number(await firstLine(child.stdout));
  assert.ok(Number.isInteger(port) && port > 0);

  const probeScript = [
    `. '${helper.replaceAll("'", "''")}'`,
    `$expected = (Get-Process -Id ${child.pid}).Path`,
    `$accepted = Test-ExpectedLoopbackListener -Port ${port} -ExpectedExecutable $expected -ExpectedProcessId ${child.pid}`,
    `$wrongPath = Test-ExpectedLoopbackListener -Port ${port} -ExpectedExecutable '${process.execPath.replaceAll("'", "''")}' -ExpectedProcessId ${child.pid}`,
    `$wrongPid = Test-ExpectedLoopbackListener -Port ${port} -ExpectedExecutable $expected -ExpectedProcessId ${process.pid}`,
    "[pscustomobject]@{ accepted = $accepted; wrongPath = $wrongPath; wrongPid = $wrongPid } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", probeScript], { encoding: "utf8" }));
  assert.deepEqual(result, { accepted: true, wrongPath: false, wrongPid: false });
});

test("credentialed probes establish listener identity before constructing bearer headers", () => {
  for (const relativePath of ["src/runtime/Launch-Codex-Bot.ps1", "src/runtime/CodexBot-Watchdog.ps1"]) {
    const source = read(relativePath);
    assert.match(source, /Local-Service-Identity\.ps1/);
    assert.match(source, /function Test-CLIProxyAPI[\s\S]*?Test-ExpectedLoopbackListener[\s\S]*?Authorization = "Bearer \$\(\$runtime\.proxyKey\)"/);
    assert.match(source, /function Test-CoworkerGateway[\s\S]*?Test-ExpectedLoopbackListener[\s\S]*?Authorization = "Bearer \$\(\$runtime\.gatewayToken\)"/);
    assert.match(source, /function Test-BrowserView[\s\S]*?Test-ExpectedLoopbackListener[\s\S]*?X-Codex-Seat-Token/);
  }
  const installer = read("scripts/Install-CodexBot.ps1");
  assert.match(installer, /New-CryptoRandomLoopbackPort/);
  assert.match(installer, /gatewayPort = New-CryptoRandomLoopbackPort/);
  assert.match(installer, /viewPort = New-CryptoRandomLoopbackPort/);
  assert.match(installer, /proxyPort = New-CryptoRandomLoopbackPort/);
  assert.doesNotMatch(installer, /gatewayPort = 18317|viewPort = 18318|proxyPort = 8317/);
});

test("browser-view port collisions fail closed", () => {
  const bridge = read("src/browser-seat-bridge.cjs");
  const ui = read("src/renderer/codex-ui.js");
  const component = read("src/renderer/live-seat-component.jsfrag");
  assert.match(bridge, /view_server_port_conflict/);
  assert.match(bridge, /Refusing to trust an existing browser-view listener/);
  assert.match(bridge, /\/api\/identity/);
  assert.match(bridge, /createHmac\("sha256", VIEW_TOKEN\)/);
  assert.match(ui, /const headers = \{ "X-Codex-Seat-Token": CODEX_TOKEN \}/);
  assert.match(ui, /async function request\(path, body\) \{[\s\S]*?await verifyCodexViewServer\(\);[\s\S]*?await fetch/);
  assert.match(component, /__CODEX_BOT_VIEW_REQUEST__/);
  assert.doesNotMatch(component, /X-Codex-Seat-Token/);
  assert.doesNotMatch(bridge, /view_server_already_running/);
});
