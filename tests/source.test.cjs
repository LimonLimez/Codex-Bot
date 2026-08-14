"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");

test("bot avatars retain the original customizable blob renderer", () => {
  const ui = fs.readFileSync(
    path.join(root, "src", "renderer", "codex-ui.js"),
    "utf8",
  );
  assert.equal(ui.includes("replaceLegacyMarks"), false);
  assert.equal(ui.includes(".sand-grok-bot-mark"), false);
});

test("live view uses an install-generated token", () => {
  const ui = fs.readFileSync(
    path.join(root, "src", "renderer", "codex-ui.js"),
    "utf8",
  );
  const component = fs.readFileSync(
    path.join(root, "src", "renderer", "live-seat-component.jsfrag"),
    "utf8",
  );
  assert.match(ui, /__CODEX_VIEW_TOKEN__/);
  assert.match(ui, /__CODEX_VIEW_PORT__/);
  assert.match(component, /__CODEX_VIEW_PORT__/);
  assert.match(ui, /verifyCodexViewServer/);
  assert.match(component, /globalThis\.__CODEX_BOT_VIEW_REQUEST__/);
  assert.doesNotMatch(component, /X-Codex-Seat-Token/);
  assert.doesNotMatch(component, /gbc-seat-view-/);
  assert.doesNotMatch(ui, /127\.0\.0\.1:18318/);
  assert.doesNotMatch(component, /127\.0\.0\.1:18318/);
});

test("every bot seat has a deterministic isolated profile and the public cap is three", () => {
  const manager = require(
    path.join(root, "src", "browser-seats", "browser-seat-manager.cjs"),
  );
  assert.equal(manager.MAX_ACTIVE, 3);
  assert.equal(
    manager.profileIdFor("employee-a"),
    manager.profileIdFor("employee-a"),
  );
  assert.notEqual(
    manager.profileIdFor("employee-a"),
    manager.profileIdFor("employee-b"),
  );
  assert.equal(typeof manager.ensureSeat, "function");
  assert.equal(typeof manager.closeSeatForKey, "function");
  assert.match(
    manager.sessionStatePathFor("employee-a"),
    /session-state\.json$/,
  );
  assert.deepEqual(
    manager.normalizeSessionState({
      version: 1,
      tabs: ["https://example.com", "file:///private"],
      activeIndex: 4,
    }),
    { version: 1, tabs: ["https://example.com/"], activeIndex: 0 },
  );
  assert.deepEqual(
    manager.normalizeSessionState({
      version: 1,
      tabs: [
        "file:///private",
        "https://active.example",
        "https://other.example",
      ],
      activeIndex: 1,
    }),
    {
      version: 1,
      tabs: ["https://active.example/", "https://other.example/"],
      activeIndex: 0,
    },
  );
  assert.equal(
    manager.normalizeSessionState({
      version: 1,
      tabs: Array.from(
        { length: 12 },
        (_, index) => `https://tab-${index}.example`,
      ),
      activeIndex: 11,
    }).tabs.length,
    8,
  );

  const duplicateA = {
    isClosed: () => false,
    url: () => "https://duplicate.example",
  };
  const duplicateB = {
    isClosed: () => false,
    url: () => "https://duplicate.example",
  };
  const closed = { isClosed: () => true, url: () => "https://closed.example" };
  assert.deepEqual(
    manager.createSessionStateSnapshot(
      [duplicateA, closed, duplicateB],
      duplicateA,
      true,
    ),
    {
      version: 1,
      tabs: ["https://duplicate.example/", "https://duplicate.example/"],
      activeIndex: 0,
    },
  );
});

test("model bridge hides every tool still backed by vendor services", () => {
  const bridge = require(path.join(root, "src", "bridge.cjs"));
  const converted = bridge.convertTools([
    {
      name: "Computer",
      description: "browser",
      parameters: { type: "object" },
    },
    {
      name: "SearchPlugins",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "WebSearch",
      description: "vendor",
      parameters: { type: "object" },
    },
    { name: "WebFetch", description: "vendor", parameters: { type: "object" } },
    {
      name: "GenerateImage",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "CloudAgent",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "GetMcpTools",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "CallMcpTool",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "AddMcpServer",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "UninstallMcpServer",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "GetMcpServerStatus",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "SetMcpInstructions",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "RestartMcpServers",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "AuthenticateMcpServer",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "RemoveMcpAccount",
      description: "vendor",
      parameters: { type: "object" },
    },
    {
      name: "RenameMcpAccount",
      description: "vendor",
      parameters: { type: "object" },
    },
  ]);
  assert.deepEqual(
    converted.map((item) => item.function.name),
    ["Computer"],
  );
});

test("the derived app disables vendor network, telemetry, experiments, and labeling", () => {
  const patcher = read("scripts/patch-app.cjs");
  const launcher = read("src/runtime/Launch-Codex-Bot.ps1");
  const watchdog = read("src/runtime/CodexBot-Watchdog.ps1");
  for (const source of [patcher, launcher, watchdog]) {
    assert.match(source, /GROK_BOT_LOCAL_ONLY/);
    assert.match(source, /SAND_DISABLE_TELEMETRY/);
    assert.match(source, /SAND_DISABLE_ANALYTICS/);
    assert.match(source, /SAND_BACKEND_URL/);
  }
  assert.match(patcher, /Vendor backend RPCs are disabled/);
  assert.match(patcher, /PrivacyMode\.NO_TRAINING/);
  assert.match(patcher, /host followup labeling isolation/);
  assert.match(patcher, /host post-turn labeling isolation/);
  assert.match(patcher, /host experiment refresh isolation/);
  assert.match(patcher, /desktop experiment refresh isolation/);
  assert.match(patcher, /Renderer Sentry is disabled/);
  assert.match(patcher, /codebase telemetry isolation/);
  assert.match(patcher, /managed vendor setup isolation/);
});

test("patcher supports one exact vendor archive and contains no personal fallback path", () => {
  const patcher = fs.readFileSync(
    path.join(root, "scripts", "patch-app.cjs"),
    "utf8",
  );
  assert.match(
    patcher,
    /38e85c0e5042c0257db7925e1e55709d6d155d90d92fe26ad654127d509766e0/,
  );
  assert.doesNotMatch(patcher, /[A-Za-z]:\\Users\\/);
  assert.match(patcher, /GROK_BOT_CLIPROXY_BRIDGE is required/);
});

test("runtime scripts generate secrets instead of embedding credentials", () => {
  const installer = fs.readFileSync(
    path.join(root, "scripts", "Install-CodexBot.ps1"),
    "utf8",
  );
  assert.match(installer, /RandomNumberGenerator/);
  assert.match(installer, /New-CryptoRandomLoopbackPort/);
  assert.match(installer, /schemaVersion = 2/);
  assert.doesNotMatch(
    installer,
    /gatewayPort = 18317|viewPort = 18318|proxyPort = 8317/,
  );
  assert.doesNotMatch(
    installer,
    /gbc_local_|gbc-seat-view-|lockin-market-local/,
  );
});

test("release inputs are explicit, third-party bits are pinned, and uninstall offers a data wipe", () => {
  const manifest = read("installer/CodexBot.iss");
  const builder = read("scripts/build-installer.ps1");
  const disable = read("src/runtime/Disable-Always-On.ps1");
  assert.doesNotMatch(manifest, /Source: "\.\.\\(?:src|scripts|assets)\\\*"/i);
  assert.match(builder, /cliProxyVersion = '7\.2\.130'/);
  assert.match(
    builder,
    /C1D9F07AF4698C4F63A5F6A866BECD8279B7AF849F6E17D7EF4A7D049B54E3B7/i,
  );
  assert.doesNotMatch(builder, /releases\/latest|CLIProxyAPI\/main\/LICENSE/);
  assert.match(builder, /\.sha256/);
  assert.match(builder, /package\.json'[)]\s*\|\s*ConvertFrom-Json/);
  assert.match(
    builder,
    /\$canonicalInstallerName\s*=\s*"CodexBot-Setup-\$packageVersion\.exe"/,
  );
  assert.match(
    builder,
    /\$isDevelopmentBuild\s*=\s*\[bool\]\$AllowDirtyDevelopmentBuild/,
  );
  assert.match(
    builder,
    /\$installerName\s*=\s*"CodexBot-Setup-\$packageVersion-DEVELOPMENT-\$developmentBuildId\.exe"/,
  );
  assert.match(builder, /yyyyMMdd'T'HHmmssfff'Z'/);
  assert.match(
    builder,
    /\$installerBaseName\s*=\s*\[IO\.Path\]::GetFileNameWithoutExtension\(\$installerName\)/,
  );
  assert.match(builder, /CODEX_BOT_INSTALLER_DEVELOPMENT/);
  assert.match(builder, /CODEX_BOT_INSTALLER_OUTPUT_BASENAME/);
  assert.match(builder, /& \$InnoCompiler "\/F\$installerBaseName"/);
  assert.match(builder, /BuildKind = if \(\$isDevelopmentBuild\)/);
  assert.match(builder, /Publishable = -not \$isDevelopmentBuild/);
  assert.match(builder, /CanonicalName = \$canonicalInstallerName/);
  assert.doesNotMatch(builder, /Get-ChildItem[^\r\n]+CodexBot-Setup-\*\.exe/);
  assert.match(
    builder,
    /\$actualSidecar\s*=\s*\(Get-Content -Raw -LiteralPath \$hashFile\)\.Trim\(\)/,
  );
  assert.match(builder, /\$actualSidecar -cne \$expectedSidecar/);
  assert.match(builder, /\[switch\]\$AllowDirtyDevelopmentBuild/);
  assert.match(
    builder,
    /git -C \$projectRoot status --porcelain=v1 --untracked-files=all/,
  );
  assert.match(builder, /Release builds require a clean Git worktree/);
  assert.match(builder, /DEVELOPMENT TEST BUILD/);
  assert.match(builder, /Remove-Item -LiteralPath \$staleOutput -Force/);
  assert.match(manifest, /#define AppCanonicalVersion "0\.1\.4"/);
  assert.match(
    manifest,
    /#define DevelopmentBuild GetEnv\("CODEX_BOT_INSTALLER_DEVELOPMENT"\)/,
  );
  assert.match(manifest, /#define AppName "Codex Bot DEVELOPMENT TEST BUILD"/);
  assert.match(manifest, /#define AppVersion "0\.1\.4 DEVELOPMENT TEST BUILD"/);
  assert.match(
    manifest,
    /#define AppVersionInfoDescription "Codex Bot DEVELOPMENT TEST installer - DO NOT PUBLISH"/,
  );
  assert.match(
    manifest,
    /#define AppOutputBaseFilename GetEnv\("CODEX_BOT_INSTALLER_OUTPUT_BASENAME"\)/,
  );
  assert.match(
    manifest,
    /#define AppOutputBaseFilename "CodexBot-Setup-0\.1\.4"/,
  );
  assert.match(manifest, /OutputBaseFilename=\{#AppOutputBaseFilename\}/);
  assert.match(
    manifest,
    /VersionInfoDescription=\{#AppVersionInfoDescription\}/,
  );
  assert.match(manifest, /RemoveUserDataOnUninstall/);
  assert.match(manifest, /Local-Service-Identity\.ps1/);
  assert.match(manifest, /UninstallSilent/);
  assert.match(manifest, /not DelTree\(StateRoot, True, True, True\)/);
  assert.match(manifest, /Windows could not delete all local conversations/);
  assert.match(disable, /ExecutablePath/);
  assert.match(disable, /cli-proxy-api\.exe/);
});

test("production PowerShell launches use the absolute system executable", () => {
  const manifest = read("installer/CodexBot.iss");
  const launcher = read("src/runtime/Launch-Codex-Bot.ps1");
  const enableAlwaysOn = read("src/runtime/Enable-Always-On.ps1");
  const disableAlwaysOn = read("src/runtime/Disable-Always-On.ps1");
  const connection = read("src/codex-connection.cjs");

  assert.doesNotMatch(manifest, /Filename:\s*"powershell\.exe"/i);
  assert.doesNotMatch(manifest, /Exec\(\s*['"]powershell\.exe['"]/i);
  assert.equal(
    (
      manifest.match(/\{sys\}\\WindowsPowerShell\\v1\.0\\powershell\.exe/gi) ||
      []
    ).length,
    4,
  );
  assert.equal((manifest.match(/\{sys\}\\wscript\.exe/gi) || []).length, 3);

  for (const script of [launcher, enableAlwaysOn]) {
    assert.match(
      script,
      /\$windowsScriptHost\s*=\s*Join-Path \$env:SystemRoot 'System32\\wscript\.exe'/,
    );
    assert.match(
      script,
      /Test-Path -LiteralPath \$windowsScriptHost -PathType Leaf/,
    );
  }
  assert.match(launcher, /Start-Process -FilePath \$windowsScriptHost/);
  assert.doesNotMatch(
    launcher,
    /Start-Process -FilePath ['"]powershell\.exe['"]/i,
  );
  assert.match(
    enableAlwaysOn,
    /New-ScheduledTaskAction -Execute \$windowsScriptHost/,
  );
  assert.doesNotMatch(
    enableAlwaysOn,
    /New-ScheduledTaskAction -Execute ['"]powershell\.exe['"]/i,
  );

  assert.match(
    connection,
    /path\.join\(\s*process\.env\.SystemRoot \|\| "C:\\\\Windows",\s*"System32",\s*"WindowsPowerShell",\s*"v1\.0",\s*"powershell\.exe",?\s*\)/,
  );
  assert.match(connection, /fs\.existsSync\(WINDOWS_POWERSHELL\)/);
  assert.match(connection, /spawnSync\(\s*WINDOWS_POWERSHELL,/);
  assert.doesNotMatch(connection, /spawnSync\(['"]powershell\.exe['"]/i);

  // This is process-name introspection for cleanup, not an executable launch.
  assert.match(disableAlwaysOn, /\$_\.Name -eq 'powershell\.exe'/);
});

test("account status is isolated to this installation's OAuth directory", () => {
  const launcher = read("src/runtime/Launch-Codex-Bot.ps1");
  const watchdog = read("src/runtime/CodexBot-Watchdog.ps1");
  assert.match(launcher, /GROK_BOT_CODEX_AUTH_DIR\s*=\s*\$proxyAuth/);
  assert.match(watchdog, /GROK_BOT_CODEX_AUTH_DIR\s*=\s*\$proxyAuth/);
});

test("runtime supervisors validate state and identify services with authenticated probes", () => {
  for (const relativePath of [
    "src/runtime/Launch-Codex-Bot.ps1",
    "src/runtime/CodexBot-Watchdog.ps1",
  ]) {
    const script = read(relativePath);
    assert.match(script, /gatewayPort.*viewPort.*proxyPort.*must be distinct/s);
    assert.match(script, /\^\[A-Za-z0-9_-\]\{24,\}\$/);
    assert.match(script, /'maxBrowserSeats' 1 3/);
    assert.match(script, /allowedReasoningEfforts/);
    assert.match(script, /model' cannot be empty/);
    assert.match(script, /\/v1\/models/);
    assert.match(script, /\/api\/listAgents/);
    assert.match(script, /Authorization = "Bearer \$\(\$runtime\.proxyKey\)"/);
    assert.match(
      script,
      /Authorization = "Bearer \$\(\$runtime\.gatewayToken\)"/,
    );
    assert.match(
      script,
      /occupied by a service that is not this installation's authenticated/,
    );
  }
});

test("launcher applies required host settings before starting the desktop", () => {
  const launcher = read("src/runtime/Launch-Codex-Bot.ps1");
  const settingsCall = launcher.indexOf("/api/setHostSettings");
  const settingsFailure = launcher.indexOf(
    "required local tool settings could not be applied",
    settingsCall,
  );
  const desktopBranch = launcher.indexOf(
    "if ($DebugRenderer)",
    settingsFailure,
  );
  assert.ok(settingsCall >= 0);
  assert.ok(settingsFailure > settingsCall);
  assert.ok(desktopBranch > settingsFailure);
});

test("account switching uses a visible OpenAI device code instead of a hidden browser launch", () => {
  const connection = read("src/codex-connection.cjs");
  const bridge = read("src/browser-seat-bridge.cjs");
  const ui = read("src/renderer/codex-ui.js");
  assert.match(connection, /"-codex-device-login", "-no-browser"/);
  assert.match(connection, /Codex device URL/);
  assert.match(connection, /Codex device code/);
  assert.match(
    bridge,
    /const device = await connectionManager\.beginCodexOAuth\(\)/,
  );
  assert.match(ui, /Open OpenAI sign-in/);
  assert.doesNotMatch(connection, /stdio: "ignore"/);
});

test("release defaults to the verified Codex OAuth model and reports cooldowns", () => {
  const connection = read("src/codex-connection.cjs");
  const installer = read("scripts/Install-CodexBot.ps1");
  assert.match(connection, /DEFAULT_MODEL = "gpt-5\.6-terra"/);
  assert.match(installer, /model = 'gpt-5\.6-terra'/);
  assert.match(connection, /model_cooldown/);
});

test("fresh installs enter the genuine workspace behind the local Codex connection gate", () => {
  const patcher = read("scripts/patch-app.cjs");
  const ui = read("src/renderer/codex-ui.js");
  assert.match(
    patcher,
    /const onboardingGateName = functionName\(onboardingGate, "onboarding gate"\)/,
  );
  assert.match(patcher, /async function \$\{onboardingGateName\}\(n\)/);
  assert.match(patcher, /gate: "shell", sessionFact: true/);
  assert.match(patcher, /fabricating a vendor session/);
  assert.match(patcher, /noteSignedOut: \(\) => \{\}/);
  assert.match(patcher, /forceOnboarding: \(\) => \{\}/);
  assert.match(patcher, /original workspace shell selection/);
  assert.match(patcher, /local frontend identity adapter/);
  const rendererIdentityStart = patcher.indexOf("async getCursorAuthStatus(t)");
  const rendererIdentityEnd = patcher.indexOf(
    '"local frontend identity adapter"',
    rendererIdentityStart,
  );
  assert.ok(
    rendererIdentityStart >= 0 && rendererIdentityEnd > rendererIdentityStart,
  );
  assert.match(
    patcher.slice(rendererIdentityStart, rendererIdentityEnd),
    /return codexLocalAuthIdentity\(\)/,
  );
  assert.match(
    patcher,
    /function codexLocalAuthIdentity\(\)[\s\S]*?authId: "codex-bot-local"/,
  );
  assert.match(patcher, /local computer setup bypass/);
  assert.match(ui, /installCodexOnboarding\(lastStatus\)/);
  assert.match(
    ui,
    /status\?\.account\?\.signedIn \|\| status\?\.connection\?\.mode === "api-key"/,
  );
  assert.match(ui, /document\.body\.append\(onboarding\)/);
});

test("the first-run Codex connection gate blocks the workspace and offers both supported routes", () => {
  const ui = read("src/renderer/codex-ui.js");
  const helperSource = ui.match(
    /function hasCodexConnection\(status\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(helperSource);
  const hasCodexConnection = Function(
    `"use strict"; ${helperSource}; return hasCodexConnection;`,
  )();
  assert.equal(hasCodexConnection(null), false);
  assert.equal(
    hasCodexConnection({
      account: { signedIn: false },
      connection: { mode: "codex-oauth" },
    }),
    false,
  );
  assert.equal(
    hasCodexConnection({
      account: { signedIn: true },
      connection: { mode: "codex-oauth" },
    }),
    true,
  );
  assert.equal(
    hasCodexConnection({
      account: { signedIn: false },
      connection: { mode: "api-key" },
    }),
    true,
  );
  assert.match(ui, /Connect Codex to start/);
  assert.match(ui, /Use Codex OAuth/);
  assert.match(ui, /Use OpenAI API key/);
  assert.match(ui, /child\.inert = true/);
  assert.match(ui, /data-codex-connection-required/);
  assert.match(
    ui,
    /for \(const eventName of \["beforeinput", "keydown", "submit"\]\)/,
  );
  assert.match(ui, /onboarding\?\.remove\(\)/);
  assert.match(ui, /Manage Codex connection/);
  assert.doesNotMatch(ui, /\u00c2|\u00c3|\u00e2[\u0080-\u00bf]|\uFFFD/);
});

test("the stock desktop coordinator uses only the configured local gateway identity", () => {
  const patcher = read("scripts/patch-app.cjs");
  assert.match(patcher, /local coordinator startup account/);
  assert.match(patcher, /local coordinator account observation/);
  assert.match(patcher, /verified local gateway mode/);
  assert.match(patcher, /CODEX_BOT_STATE_ROOT/);
  assert.match(patcher, /url\.protocol === "http:"/);
  assert.match(patcher, /url\.hostname === "127\.0\.0\.1"/);
  assert.match(patcher, /local descriptor binding bypass/);
  assert.match(patcher, /authId: \"codex-bot-local\"/);
  assert.doesNotMatch(
    patcher,
    /SAND_HOST_GATEWAY_URL\?\.trim\(\) \? \{ kind: "logged-in"/,
  );
});

test("official cloud-computer release disclosures and packaging remain explicit", () => {
  const readme = read("README.md");
  const security = read("SECURITY.md");
  const privacy = read("PRIVACY.md");
  const notice = read("NOTICE.md");
  const manifest = read("installer/CodexBot.iss");
  const packageManifest = JSON.parse(read("package.json"));

  for (const document of [readme, security, privacy]) {
    assert.match(document, /Private browser seats remain the default\./);
    assert.match(document, /one persistent account box shared/i);
    assert.match(
      document,
      /Zero vendor inference, telemetry, or charges cannot be guaranteed/i,
    );
    assert.match(document, /billing is possible/i);
    assert.match(document, /Windows DPAPI/i);
    assert.match(document, /verified remote deletion/i);
  }
  assert.match(readme, /Codex remains the local chat and planning model/);
  assert.match(security, /Codex remains the local chat and planning model/);
  assert.doesNotMatch(
    readme,
    /No xAI inference, vendor-backend fallback, or Grok Bot usage-credit route/,
  );

  assert.match(notice, /noVNC 1\.7\.0/);
  assert.match(notice, /Mozilla Public License 2\.0 \(MPL-2\.0\)/);
  assert.match(notice, /ws 8\.21\.3/);
  assert.match(notice, /MIT License/);
  assert.doesNotMatch(notice, /[^\x00-\x7f]/);

  assert.equal(packageManifest.dependencies["@novnc/novnc"], "1.7.0");
  assert.equal(packageManifest.dependencies.ws, "8.21.3");
  for (const relative of [
    "src/official-computer-client.cjs",
    "src/official-computer-helper.cjs",
  ]) {
    assert.match(
      packageManifest.scripts.check,
      new RegExp(`node --check ${relative.replaceAll(".", "\\.")}`),
    );
    assert.match(
      manifest,
      new RegExp(
        `Source: "\\.\\.\\\\src\\\\${path.basename(relative).replaceAll(".", "\\.")}"; DestDir: "\\{app\\}\\\\tools\\\\src"; Flags: ignoreversion`,
        "i",
      ),
    );
  }
});
