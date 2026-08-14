"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "build",
  "artifacts",
]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".asar",
  ".exe",
  ".msi",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".log",
  ".jsonl",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".zip",
  ".7z",
  ".pfx",
  ".p12",
  ".pem",
  ".key",
]);
const FORBIDDEN_NAMES = new Set([
  ".env",
  ".npmrc",
  "runtime.json",
  "connection.json",
  "config.yaml",
  "session-state.json",
  "cookies",
  "history",
  "login data",
  "web data",
  "local state",
]);
const FORBIDDEN_PATHS = [
  /(^|\/)browser-seats\/profiles(\/|$)/i,
  /(^|\/)chrome-profile(\/|$)/i,
  /(^|\/)cliproxy\/auth(\/|$)/i,
  /(^|\/)auth(\/|$)/i,
  /(^|\/)official-computer\/credentials\.json$/i,
  /(^|\/)(?:local-host-data|desktop-user-data|attachments|downloads|screenshots)(\/|$)/i,
];
const CONTENT_RULES = [
  {
    label: "absolute Windows user path",
    regex: /[A-Za-z]:\\Users\\[^\\\r\n]+/i,
  },
  {
    label: "personal email address",
    regex: /\b[A-Z0-9._%+-]+@(?:gmail|icloud|outlook|hotmail|yahoo)\.com\b/i,
  },
  {
    label: "OpenAI-style API key",
    regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    label: "GitHub credential",
    regex: /\b(?:github_pat_|gh[opurs]_)[A-Za-z0-9_]{20,}\b/,
  },
  { label: "npm credential", regex: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { label: "Slack credential", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: "Google OAuth credential", regex: /\bya29\.[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key", regex: /\bAKIA[A-Z0-9]{16}\b/ },
  {
    label: "fixed local gateway token",
    regex: /\bgbc_local_[A-Za-z0-9_-]{10,}\b/i,
  },
  {
    label: "JWT credential",
    regex: /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    label: "private key block",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    label: "literal OAuth/API secret assignment",
    regex:
      /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*["'][A-Za-z0-9_./+=-]{20,}["']/i,
  },
  {
    label: "URL with embedded credentials",
    regex: /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
  },
];

function collect(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      files.push({ path: path.join(directory, entry.name), symlink: true });
      continue;
    }
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(file, files);
    else if (entry.isFile()) files.push({ path: file, symlink: false });
  }
  return files;
}

function normalize(file) {
  return path.relative(ROOT, file).replaceAll("\\", "/");
}

function isForbiddenPrivateRuntimePath(relative) {
  return FORBIDDEN_PATHS.some((pattern) => pattern.test(relative));
}

function collectArtifactInventory(
  directory,
  relative = "artifacts",
  inventory = [],
) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const entryRelative = `${relative}/${entry.name}`;
    const record = {
      file,
      relative: entryRelative,
      directory: entry.isDirectory(),
      fileEntry: entry.isFile(),
      symlink: entry.isSymbolicLink(),
    };
    inventory.push(record);
    if (record.directory && !record.symlink) {
      collectArtifactInventory(file, entryRelative, inventory);
    }
  }
  return inventory;
}

function auditArtifactStaging(projectRoot) {
  const issues = [];
  const artifactsRoot = path.join(projectRoot, "artifacts");
  let rootStat;
  try {
    rootStat = fs.lstatSync(artifactsRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return issues;
    return [
      `artifacts: release artifact staging could not be inspected (${error instanceof Error ? error.message : String(error)})`,
    ];
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return ["artifacts: release artifact staging must be a real directory"];
  }

  let packageManifest;
  try {
    packageManifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
    );
  } catch (error) {
    return [
      `artifacts: could not resolve the canonical release filename (${error instanceof Error ? error.message : String(error)})`,
    ];
  }
  const version = String(packageManifest.version || "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return [
      `artifacts: package.json contains an invalid release version (${version || "missing"})`,
    ];
  }

  const installerName = `CodexBot-Setup-${version}.exe`;
  const sidecarName = `${installerName}.sha256`;
  const allowed = new Set([
    `artifacts/${installerName}`,
    `artifacts/${sidecarName}`,
  ]);
  const inventory = collectArtifactInventory(artifactsRoot);
  if (inventory.length === 0) return issues;

  const accepted = new Map();
  for (const entry of inventory) {
    if (
      !allowed.has(entry.relative) ||
      !entry.fileEntry ||
      entry.directory ||
      entry.symlink
    ) {
      issues.push(
        `${entry.relative}: unexpected release artifact entry; only ${installerName} and ${sidecarName} are allowed`,
      );
      continue;
    }
    accepted.set(entry.relative, entry.file);
  }

  for (const expected of allowed) {
    if (!accepted.has(expected)) {
      issues.push(`${expected}: canonical release artifact pair is incomplete`);
    }
  }
  if (issues.length) return issues;

  const installerPath = accepted.get(`artifacts/${installerName}`);
  const sidecarPath = accepted.get(`artifacts/${sidecarName}`);
  const sidecarStat = fs.statSync(sidecarPath);
  if (sidecarStat.size > 1024) {
    return [`artifacts/${sidecarName}: checksum sidecar is unexpectedly large`];
  }
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(installerPath))
    .digest("hex");
  const expectedSidecar = `${hash}  ${installerName}`;
  const actualSidecar = fs.readFileSync(sidecarPath, "utf8").trim();
  if (actualSidecar !== expectedSidecar) {
    issues.push(
      `artifacts/${sidecarName}: checksum sidecar does not match the canonical installer`,
    );
  }
  return issues;
}

const failures = [];
failures.push(...auditArtifactStaging(ROOT));
for (const suppliedPath of process.argv.slice(2)) {
  const relative = suppliedPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (isForbiddenPrivateRuntimePath(relative)) {
    failures.push(`${relative}: forbidden private runtime-data path`);
  }
}
for (const entry of collect(ROOT)) {
  const file = entry.path;
  const relative = normalize(file);
  if (entry.symlink) {
    failures.push(
      `${relative}: symbolic links are not allowed in release source`,
    );
    continue;
  }
  const extension = path.extname(file).toLowerCase();
  const basename = path.basename(file).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension))
    failures.push(`${relative}: forbidden release file type ${extension}`);
  if (FORBIDDEN_NAMES.has(basename) || basename.startsWith(".env."))
    failures.push(`${relative}: forbidden credential/runtime filename`);
  if (isForbiddenPrivateRuntimePath(relative))
    failures.push(`${relative}: forbidden private runtime-data path`);
  const stat = fs.statSync(file);
  if (stat.size > 5 * 1024 * 1024)
    failures.push(`${relative}: unexpected source file larger than 5 MiB`);
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) {
    if (extension !== ".ico")
      failures.push(`${relative}: unexpected binary file in source tree`);
    continue;
  }
  const text = bytes.toString("utf8");
  for (const rule of CONTENT_RULES) {
    if (rule.regex.test(text)) failures.push(`${relative}: ${rule.label}`);
  }
}

const installerManifest = fs.readFileSync(
  path.join(ROOT, "installer", "CodexBot.iss"),
  "utf8",
);
for (const line of installerManifest.split(/\r?\n/)) {
  if (!/^Source:/i.test(line.trim())) continue;
  const source = line.match(/^Source:\s*"([^"]+)"/i)?.[1] ?? "";
  if (/\.\.\\(?:src|scripts|assets)\\.*\*/i.test(source)) {
    failures.push(
      `installer/CodexBot.iss: broad source wildcard is forbidden (${source})`,
    );
  }
}
for (const relative of [
  "official-computer-client.cjs",
  "official-computer-helper.cjs",
]) {
  const expected = `Source: "..\\src\\${relative}"; DestDir: "{app}\\tools\\src"; Flags: ignoreversion`;
  if (!installerManifest.includes(expected)) {
    failures.push(
      `installer/CodexBot.iss: ${relative} must be packaged explicitly`,
    );
  }
}
if (
  /Filename:\s*"powershell\.exe"/i.test(installerManifest) ||
  /Exec\(\s*['"]powershell\.exe['"]/i.test(installerManifest)
) {
  failures.push(
    "installer/CodexBot.iss: PowerShell launches must use the absolute {sys} Windows PowerShell path",
  );
}
if (
  (
    installerManifest.match(
      /\{sys\}\\WindowsPowerShell\\v1\.0\\powershell\.exe/gi,
    ) || []
  ).length !== 4
) {
  failures.push(
    "installer/CodexBot.iss: every installer, shortcut, launch, and uninstall PowerShell entry must use the absolute {sys} path",
  );
}
if ((installerManifest.match(/\{sys\}\\wscript\.exe/gi) || []).length !== 3) {
  failures.push(
    "installer/CodexBot.iss: every windowless shortcut and post-install launch must use the absolute {sys} Windows Script Host path",
  );
}

const launcherScript = fs.readFileSync(
  path.join(ROOT, "src", "runtime", "Launch-Codex-Bot.ps1"),
  "utf8",
);
const enableAlwaysOnScript = fs.readFileSync(
  path.join(ROOT, "src", "runtime", "Enable-Always-On.ps1"),
  "utf8",
);
const connectionSource = fs.readFileSync(
  path.join(ROOT, "src", "codex-connection.cjs"),
  "utf8",
);
const officialComputerClientSource = fs.readFileSync(
  path.join(ROOT, "src", "official-computer-client.cjs"),
  "utf8",
);
const officialComputerHelperSource = fs.readFileSync(
  path.join(ROOT, "src", "official-computer-helper.cjs"),
  "utf8",
);
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
);

for (const relative of [
  "src/official-computer-client.cjs",
  "src/official-computer-helper.cjs",
]) {
  if (
    !String(packageManifest.scripts?.check || "").includes(
      `node --check ${relative}`,
    )
  ) {
    failures.push(
      `package.json: the release syntax gate must check ${relative}`,
    );
  }
}
if (
  packageManifest.dependencies?.["@novnc/novnc"] !== "1.7.0" ||
  packageManifest.dependencies?.ws !== "8.21.3"
) {
  failures.push(
    "package.json: official-computer transport dependencies must remain exactly pinned",
  );
}
if (
  !officialComputerHelperSource.includes("DataProtectionScope]::CurrentUser") ||
  !officialComputerHelperSource.includes("ProtectedData]::Protect") ||
  !officialComputerHelperSource.includes("ProtectedData]::Unprotect")
) {
  failures.push(
    "src/official-computer-helper.cjs: vendor OAuth credentials must use current-user Windows DPAPI",
  );
}
if (
  /\.\.\.process\.env/.test(officialComputerClientSource) ||
  !officialComputerClientSource.includes("env: helperEnvironment()") ||
  !officialComputerClientSource.includes('env.ELECTRON_RUN_AS_NODE = "1"')
) {
  failures.push(
    "src/official-computer-client.cjs: helper must launch with its explicit scrubbed environment",
  );
}
for (const forbiddenCapability of [
  "ExecService",
  "InferenceService",
  "AgentService",
  "execDaemonAuthToken",
  "exec_daemon_auth_token",
  "gatewayToken",
  "gateway_token",
  "forkVncBaseUrl",
  "fork_vnc_base_url",
]) {
  if (officialComputerHelperSource.includes(forbiddenCapability)) {
    failures.push(
      `src/official-computer-helper.cjs: VNC-only helper must not retain or invoke ${forbiddenCapability}`,
    );
  }
}

const documentationRequirements = {
  "README.md": [
    "Private browser seats remain the default.",
    "one persistent account box shared",
    "Zero vendor inference, telemetry, or charges cannot be guaranteed.",
    "Billing is possible.",
    "Windows DPAPI",
    "verified remote deletion",
    "downloads.cursor.com",
    "464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E",
    "/BOOTSTRAPGROKBOT=1",
    "remains installed if Codex Bot Setup is canceled",
    "terms of service",
  ],
  "SECURITY.md": [
    "Private browser seats remain the default.",
    "one persistent account box shared",
    "Zero vendor inference, telemetry, or charges cannot be guaranteed.",
    "billing is possible",
    "current-user Windows DPAPI",
    "verified remote deletion",
    "125,825,552-byte Grok Bot 0.18.0 installer",
    "/BOOTSTRAPGROKBOT=1",
    "not part of the Codex Bot rollback boundary",
  ],
  "PRIVACY.md": [
    "Private browser seats remain the default.",
    "one persistent account box shared",
    "Zero vendor inference, telemetry, or charges cannot be guaranteed",
    "billing is possible",
    "current-user Windows DPAPI",
    "verified remote deletion",
    "downloads.cursor.com",
    "remains separately installed",
  ],
  "NOTICE.md": [
    "noVNC 1.7.0",
    "Mozilla Public License 2.0 (MPL-2.0)",
    "ws 8.21.3",
    "MIT License",
    "vendor installer is never embedded or staged",
    "not removed by the Codex Bot uninstaller",
  ],
};
for (const [relative, requiredPhrases] of Object.entries(
  documentationRequirements,
)) {
  const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
  for (const required of requiredPhrases) {
    if (!source.toLowerCase().includes(required.toLowerCase())) {
      failures.push(
        `${relative}: required release disclosure is missing (${required})`,
      );
    }
  }
  if (/\uFFFD|(?:\u00c3.|\u00c2.|\u00e2[\u0080-\u00bf])/.test(source)) {
    failures.push(`${relative}: possible mojibake in release documentation`);
  }
}
if (
  /Start-Process -FilePath ['"]wscript\.exe['"]/i.test(launcherScript) ||
  !/Start-Process -FilePath \$windowsScriptHost/.test(launcherScript)
) {
  failures.push(
    "src/runtime/Launch-Codex-Bot.ps1: watchdog fallback must use the validated absolute Windows Script Host path",
  );
}
if (
  /New-ScheduledTaskAction -Execute ['"]wscript\.exe['"]/i.test(
    enableAlwaysOnScript,
  ) ||
  !/New-ScheduledTaskAction -Execute \$windowsScriptHost/.test(
    enableAlwaysOnScript,
  )
) {
  failures.push(
    "src/runtime/Enable-Always-On.ps1: scheduled task must use the validated absolute Windows Script Host path",
  );
}
for (const [relative, source] of [
  ["src/runtime/Launch-Codex-Bot.ps1", launcherScript],
  ["src/runtime/Enable-Always-On.ps1", enableAlwaysOnScript],
]) {
  if (
    !/\$windowsScriptHost\s*=\s*Join-Path \$env:SystemRoot 'System32\\wscript\.exe'/.test(
      source,
    ) ||
    !/Test-Path -LiteralPath \$windowsScriptHost -PathType Leaf/.test(source)
  ) {
    failures.push(
      `${relative}: absolute Windows Script Host path must be constructed and validated before use`,
    );
  }
}
if (
  /spawnSync\(['"]powershell\.exe['"]/i.test(connectionSource) ||
  !/spawnSync\(\s*WINDOWS_POWERSHELL,/.test(connectionSource)
) {
  failures.push(
    "src/codex-connection.cjs: credential protection must use the absolute Windows PowerShell path",
  );
}

const supportedRuntimeManifestPath = path.join(
  ROOT,
  "assets",
  "grok-bot-0.18.0-windows-x64.manifest.json",
);
const supportedRuntimeVerifierPath = path.join(
  ROOT,
  "scripts",
  "Verify-GrokBotRuntime.ps1",
);
const supportedInstallerVerifierPath = path.join(
  ROOT,
  "scripts",
  "Verify-GrokBotInstaller.ps1",
);
const supportedManifestGeneratorPath = path.join(
  ROOT,
  "scripts",
  "New-GrokBotRuntimeManifest.ps1",
);
const expectedSignerSubject =
  'CN="Anysphere, Inc.", O="Anysphere, Inc.", L=San Francisco, S=California, C=US';
const expectedSignerThumbprint = "67E878CBE262D364A6D059B77DAC002E2C064F0E";
const expectedInstallerIssuer =
  "CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US";
const expectedInstallerUrl =
  "https://downloads.cursor.com/grokbot/stable/win32-x64/0.18.0/Grok_Bot_0.18.0_Setup.exe";
const expectedInstallerSha256 =
  "464079A15EF5FA8B61CCEA8FFFCC78F63CFCF6DF65FB0AD5E725D8B95F7E437E";
const expectedInstallerSize = "125825552";
try {
  const manifest = JSON.parse(
    fs.readFileSync(supportedRuntimeManifestPath, "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.product !== "Grok Bot" ||
    manifest.version !== "0.18.0" ||
    manifest.platform !== "windows-x64"
  ) {
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: unexpected supported-runtime identity",
    );
  }
  if (
    manifest.signer?.subject !== expectedSignerSubject ||
    manifest.signer?.thumbprint !== expectedSignerThumbprint
  ) {
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: signer identity is not the reviewed pin",
    );
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const paths = files.map((entry) => entry?.path);
  if (files.length !== 657)
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: expected the reviewed 657-file runtime tree",
    );
  if (
    paths.some(
      (relative, index) =>
        typeof relative !== "string" ||
        (index > 0 && paths[index - 1] >= relative),
    )
  ) {
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: paths must be unique and ordinally sorted",
    );
  }
  if (
    new Set(paths.map((relative) => String(relative).toLowerCase())).size !==
    paths.length
  ) {
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: paths must be case-insensitively unique",
    );
  }
  if (
    files.some(
      (entry) =>
        typeof entry?.path !== "string" ||
        entry.path.includes("\\") ||
        path.win32.isAbsolute(entry.path) ||
        entry.path
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        !/^[a-f0-9]{64}$/.test(entry?.sha256 || ""),
    )
  ) {
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: entries must contain canonical relative paths and lowercase SHA-256 values",
    );
  }
  const byPath = new Map(files.map((entry) => [entry.path, entry.sha256]));
  if (
    byPath.get("resources/app.asar") !==
    "38e85c0e5042c0257db7925e1e55709d6d155d90d92fe26ad654127d509766e0"
  ) {
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: app.asar hash does not match the supported archive",
    );
  }
  if (
    byPath.get("Grok Bot.exe") !==
      "86719c9dcbfc580b7bc29ece62302401a7622ae577e2cff42b4c525db674f1ca" ||
    byPath.get("Uninstall Grok Bot.exe") !==
      "4e4045884146e852beb42b22d95c509d6a5439e362236410eb5d45cc9cfe380a"
  ) {
    failures.push(
      "assets/grok-bot-0.18.0-windows-x64.manifest.json: executable hashes do not match the reviewed installed tree",
    );
  }
  for (const required of [
    "Grok Bot.exe",
    "d3dcompiler_47.dll",
    "dxcompiler.dll",
    "ffmpeg.dll",
    "libEGL.dll",
    "libGLESv2.dll",
    "vulkan-1.dll",
  ]) {
    if (!/^[a-f0-9]{64}$/.test(byPath.get(required) || ""))
      failures.push(
        `assets/grok-bot-0.18.0-windows-x64.manifest.json: missing required runtime file ${required}`,
      );
  }
} catch (error) {
  failures.push(
    `assets/grok-bot-0.18.0-windows-x64.manifest.json: could not validate manifest (${error instanceof Error ? error.message : String(error)})`,
  );
}

try {
  const verifier = fs.readFileSync(supportedRuntimeVerifierPath, "utf8");
  for (const required of [
    "Get-AuthenticodeSignature",
    "Get-FileHash -Algorithm SHA256",
    "FileAttributes]::ReparsePoint",
    expectedSignerSubject,
    expectedSignerThumbprint,
  ]) {
    if (!verifier.includes(required))
      failures.push(
        `scripts/Verify-GrokBotRuntime.ps1: required integrity control is missing (${required})`,
      );
  }
  const installedVerifier =
    /Source: "\.\.\\scripts\\Verify-GrokBotRuntime\.ps1"; DestDir: "\{app\}\\tools\\integrity"; Flags: ignoreversion/i.test(
      installerManifest,
    );
  const temporaryVerifier =
    /Source: "\.\.\\scripts\\Verify-GrokBotRuntime\.ps1"; Flags: dontcopy/i.test(
      installerManifest,
    );
  const installedManifest =
    /Source: "\.\.\\assets\\grok-bot-0\.18\.0-windows-x64\.manifest\.json"; DestDir: "\{app\}\\tools\\integrity"; Flags: ignoreversion/i.test(
      installerManifest,
    );
  const temporaryManifest =
    /Source: "\.\.\\assets\\grok-bot-0\.18\.0-windows-x64\.manifest\.json"; Flags: dontcopy/i.test(
      installerManifest,
    );
  if (
    !installedVerifier ||
    !temporaryVerifier ||
    !installedManifest ||
    !temporaryManifest
  ) {
    failures.push(
      "installer/CodexBot.iss: verifier and manifest must be explicitly packaged for both preflight and copied-tree checks",
    );
  }
  if (
    !/function PrepareToInstall[\s\S]*PrepareVendorDependency/i.test(
      installerManifest,
    ) ||
    !/function VerifyVendorCandidate[\s\S]*Verify-GrokBotRuntime\.ps1[\s\S]*ewWaitUntilTerminated/i.test(
      installerManifest,
    )
  ) {
    failures.push(
      "installer/CodexBot.iss: selected vendor tree must be verified before external files are installed",
    );
  }

  const installerVerifier = fs.readFileSync(
    supportedInstallerVerifierPath,
    "utf8",
  );
  for (const required of [
    expectedInstallerSize,
    expectedInstallerSha256,
    "0.18.0",
    "Grok Bot",
    "SpaceXAI",
    expectedSignerSubject,
    expectedSignerThumbprint,
    expectedInstallerIssuer,
    "FileAttributes]::ReparsePoint",
    "Get-FileHash -Algorithm SHA256",
    "Get-AuthenticodeSignature",
  ]) {
    if (!installerVerifier.includes(required)) {
      failures.push(
        `scripts/Verify-GrokBotInstaller.ps1: required installer pin is missing (${required})`,
      );
    }
  }
  const hashIndex = installerVerifier.indexOf("Get-FileHash -Algorithm SHA256");
  const signatureIndex = installerVerifier.indexOf("Get-AuthenticodeSignature");
  if (hashIndex < 0 || signatureIndex <= hashIndex) {
    failures.push(
      "scripts/Verify-GrokBotInstaller.ps1: exact byte verification must precede signature verification",
    );
  }

  const generator = fs.readFileSync(supportedManifestGeneratorPath, "utf8");
  for (const required of [
    "$expectedVersion = '0.18.0'",
    expectedSignerSubject,
    expectedSignerThumbprint,
    "FileAttributes]::ReparsePoint",
    "Get-AuthenticodeSignature",
    "Get-FileHash -Algorithm SHA256",
    "[Array]::Sort($paths, [StringComparer]::Ordinal)",
  ]) {
    if (!generator.includes(required)) {
      failures.push(
        `scripts/New-GrokBotRuntimeManifest.ps1: required deterministic-generation control is missing (${required})`,
      );
    }
  }

  for (const required of [
    expectedInstallerUrl,
    expectedInstallerSha256,
    expectedInstallerSize,
    "DownloadPage.Add",
    "Verify-GrokBotInstaller.ps1",
    "ExecAsOriginalUser",
    "'/S /currentuser'",
    "BOOTSTRAPGROKBOT|0",
    "InstallExitCode := 7",
    "VendorChoicePage.SelectedValueIndex := -1",
    "CurPageID = VendorChoicePage.ID",
    "VendorChoicePage.SelectedValueIndex < 0",
    "Nothing will be downloaded until you deliberately select the authorization option",
    "InvalidateInteractiveVendorChoiceCache",
    "PrepareVendorDependencyAndRecordExitCode",
    "exact separate 120 MiB per-user installer",
    "remains installed if Codex Bot Setup fails, is canceled, or Codex Bot is later uninstalled",
    "VendorChoicePage.SelectedValueIndex = 0",
    "HasConflictingPerUserVendor",
    "will not repair, overwrite, update, or downgrade",
    "https://cursor.com/terms-of-service",
    "https://cursor.com/privacy",
    "ExternalSize: 496010226",
  ]) {
    if (!installerManifest.includes(required)) {
      failures.push(
        `installer/CodexBot.iss: required no-bundle bootstrap control is missing (${required})`,
      );
    }
  }
  if (/VendorChoicePage\.SelectedValueIndex := [01]/.test(installerManifest)) {
    failures.push(
      "installer/CodexBot.iss: interactive vendor acquisition must not preselect download or existing-only",
    );
  }
  if (
    !/procedure InvalidateInteractiveVendorChoiceCache;[\s\S]*VendorPrepared := False;[\s\S]*VerifiedVendorRoot := '';[\s\S]*end;/.test(
      installerManifest,
    ) ||
    !/CurPageID = VendorChoicePage\.ID[\s\S]*InvalidateInteractiveVendorChoiceCache;[\s\S]*VendorChoicePage\.SelectedValueIndex < 0/.test(
      installerManifest,
    )
  ) {
    failures.push(
      "installer/CodexBot.iss: every interactive vendor-choice re-evaluation must clear the prepared flag and verified root before validating the new choice",
    );
  }
  if (
    !/function PrepareVendorDependencyAndRecordExitCode: Boolean;[\s\S]*Result := PrepareVendorDependency;[\s\S]*if Result then[\s\S]*InstallExitCode := 0[\s\S]*else[\s\S]*InstallExitCode := 7;/.test(
      installerManifest,
    ) ||
    !/function PrepareToInstall[\s\S]*if not PrepareVendorDependencyAndRecordExitCode then/.test(
      installerManifest,
    ) ||
    !/CurPageID = wpReady[\s\S]*Result := PrepareVendorDependencyAndRecordExitCode/.test(
      installerManifest,
    ) ||
    (installerManifest.match(/InstallExitCode := 7/g) || []).length !== 1
  ) {
    failures.push(
      "installer/CodexBot.iss: a failed dependency preparation must record exit 7 and only a genuinely successful retry may clear it",
    );
  }
  if (
    /Source:\s*"[^\r\n]*(?:Grok_Bot_0\.18\.0_Setup|CursorUserSetup-x64-0\.18\.0)\.exe"/i.test(
      installerManifest,
    ) ||
    /New-GrokBotRuntimeManifest\.ps1/i.test(installerManifest)
  ) {
    failures.push(
      "installer/CodexBot.iss: the proprietary vendor installer and manifest-generation tooling must never be packaged",
    );
  }
  const installedBootstrapVerifier =
    /Source: "\.\.\\scripts\\Verify-GrokBotInstaller\.ps1"; DestDir: "\{app\}\\tools\\integrity"; Flags: ignoreversion/i.test(
      installerManifest,
    );
  const temporaryBootstrapVerifier =
    /Source: "\.\.\\scripts\\Verify-GrokBotInstaller\.ps1"; Flags: dontcopy/i.test(
      installerManifest,
    );
  if (!installedBootstrapVerifier || !temporaryBootstrapVerifier) {
    failures.push(
      "installer/CodexBot.iss: the installer integrity verifier must be explicitly packaged for audit and temporary execution",
    );
  }

  const builder = fs.readFileSync(
    path.join(ROOT, "scripts", "build-installer.ps1"),
    "utf8",
  );
  for (const required of [
    "Verify-GrokBotInstaller.ps1",
    "Verify-GrokBotRuntime.ps1",
    "grok-bot-0.18.0-windows-x64.manifest.json",
    "@('check', 'test', 'audit:release')",
  ]) {
    if (!builder.includes(required)) {
      failures.push(
        `scripts/build-installer.ps1: required release gate is missing (${required})`,
      );
    }
  }
  if (
    /downloads\.cursor\.com|Grok_Bot_0\.18\.0_Setup\.exe|CursorUserSetup-x64-0\.18\.0\.exe/i.test(
      builder,
    )
  ) {
    failures.push(
      "scripts/build-installer.ps1: release builds must not download or stage the proprietary Grok Bot installer",
    );
  }
  const installScript = fs.readFileSync(
    path.join(ROOT, "scripts", "Install-CodexBot.ps1"),
    "utf8",
  );
  const verifyIndex = installScript.indexOf(
    "& $runtimeVerifier -InstallRoot $appRoot -ManifestPath $runtimeManifest",
  );
  const launchIndex = installScript.indexOf("$patchProcess = Start-Process");
  if (verifyIndex < 0 || launchIndex <= verifyIndex) {
    failures.push(
      "scripts/Install-CodexBot.ps1: complete copied-tree verification must precede the first vendor executable launch",
    );
  }
} catch (error) {
  failures.push(
    `supported-runtime enforcement inspection failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

try {
  const tracked = childProcess
    .execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const relative of tracked) {
    const normalized = relative.replaceAll("\\", "/");
    const extension = path.extname(normalized).toLowerCase();
    if ([".exe", ".msi", ".asar", ".zip", ".7z"].includes(extension)) {
      failures.push(
        `${normalized}: generated/proprietary binary must not be tracked`,
      );
    }
    if (isForbiddenPrivateRuntimePath(normalized)) {
      failures.push(`${normalized}: private runtime data must not be tracked`);
    }
  }
} catch (error) {
  failures.push(
    `git index inspection failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (failures.length) {
  process.stderr.write(
    `Release source audit failed:\n${[...new Set(failures)].map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Release source audit passed: source boundaries are clean and artifact staging is empty or contains only the verified canonical installer pair.\n",
  );
}
