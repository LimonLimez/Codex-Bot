"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "build", "artifacts"]);
const FORBIDDEN_EXTENSIONS = new Set([
  ".asar", ".exe", ".msi", ".db", ".sqlite", ".sqlite3", ".log", ".jsonl",
  ".png", ".jpg", ".jpeg", ".webp", ".zip", ".7z", ".pfx", ".p12", ".pem", ".key",
]);
const FORBIDDEN_NAMES = new Set([
  ".env", ".npmrc", "runtime.json", "connection.json", "config.yaml", "session-state.json",
  "cookies", "history", "login data", "web data", "local state",
]);
const FORBIDDEN_PATHS = [
  /(^|\/)browser-seats\/profiles(\/|$)/i,
  /(^|\/)chrome-profile(\/|$)/i,
  /(^|\/)cliproxy\/auth(\/|$)/i,
  /(^|\/)auth(\/|$)/i,
  /(^|\/)(?:local-host-data|desktop-user-data|attachments|downloads|screenshots)(\/|$)/i,
];
const CONTENT_RULES = [
  { label: "absolute Windows user path", regex: /[A-Za-z]:\\Users\\[^\\\r\n]+/i },
  {
    label: "personal email address",
    regex: /\b[A-Z0-9._%+-]+@(?:gmail|icloud|outlook|hotmail|yahoo)\.com\b/i,
  },
  { label: "OpenAI-style API key", regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub credential", regex: /\b(?:github_pat_|gh[opurs]_)[A-Za-z0-9_]{20,}\b/ },
  { label: "npm credential", regex: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { label: "Slack credential", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { label: "Google OAuth credential", regex: /\bya29\.[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key", regex: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: "fixed local gateway token", regex: /\bgbc_local_[A-Za-z0-9_-]{10,}\b/i },
  { label: "JWT credential", regex: /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/ },
  { label: "private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    label: "literal OAuth/API secret assignment",
    regex: /\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*["'][A-Za-z0-9_./+=-]{20,}["']/i,
  },
  { label: "URL with embedded credentials", regex: /https?:\/\/[^\s/@:]+:[^\s/@]+@/i },
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

const failures = [];
for (const entry of collect(ROOT)) {
  const file = entry.path;
  const relative = normalize(file);
  if (entry.symlink) {
    failures.push(`${relative}: symbolic links are not allowed in release source`);
    continue;
  }
  const extension = path.extname(file).toLowerCase();
  const basename = path.basename(file).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) failures.push(`${relative}: forbidden release file type ${extension}`);
  if (FORBIDDEN_NAMES.has(basename) || basename.startsWith(".env.")) failures.push(`${relative}: forbidden credential/runtime filename`);
  if (FORBIDDEN_PATHS.some((pattern) => pattern.test(relative))) failures.push(`${relative}: forbidden private runtime-data path`);
  const stat = fs.statSync(file);
  if (stat.size > 5 * 1024 * 1024) failures.push(`${relative}: unexpected source file larger than 5 MiB`);
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) {
    if (extension !== ".ico") failures.push(`${relative}: unexpected binary file in source tree`);
    continue;
  }
  const text = bytes.toString("utf8");
  for (const rule of CONTENT_RULES) {
    if (rule.regex.test(text)) failures.push(`${relative}: ${rule.label}`);
  }
}

const installerManifest = fs.readFileSync(path.join(ROOT, "installer", "CodexBot.iss"), "utf8");
for (const line of installerManifest.split(/\r?\n/)) {
  if (!/^Source:/i.test(line.trim())) continue;
  const source = line.match(/^Source:\s*"([^"]+)"/i)?.[1] ?? "";
  if (/\.\.\\(?:src|scripts|assets)\\.*\*/i.test(source)) {
    failures.push(`installer/CodexBot.iss: broad source wildcard is forbidden (${source})`);
  }
}
if (/Filename:\s*"powershell\.exe"/i.test(installerManifest) || /Exec\(\s*['"]powershell\.exe['"]/i.test(installerManifest)) {
  failures.push("installer/CodexBot.iss: PowerShell launches must use the absolute {sys} Windows PowerShell path");
}
if ((installerManifest.match(/\{sys\}\\WindowsPowerShell\\v1\.0\\powershell\.exe/gi) || []).length !== 3) {
  failures.push("installer/CodexBot.iss: every installer, shortcut, launch, and uninstall PowerShell entry must use the absolute {sys} path");
}
if ((installerManifest.match(/\{sys\}\\wscript\.exe/gi) || []).length !== 3) {
  failures.push("installer/CodexBot.iss: every windowless shortcut and post-install launch must use the absolute {sys} Windows Script Host path");
}

const launcherScript = fs.readFileSync(path.join(ROOT, "src", "runtime", "Launch-Codex-Bot.ps1"), "utf8");
const enableAlwaysOnScript = fs.readFileSync(path.join(ROOT, "src", "runtime", "Enable-Always-On.ps1"), "utf8");
const connectionSource = fs.readFileSync(path.join(ROOT, "src", "codex-connection.cjs"), "utf8");
if (/Start-Process -FilePath ['"]wscript\.exe['"]/i.test(launcherScript) || !/Start-Process -FilePath \$windowsScriptHost/.test(launcherScript)) {
  failures.push("src/runtime/Launch-Codex-Bot.ps1: watchdog fallback must use the validated absolute Windows Script Host path");
}
if (/New-ScheduledTaskAction -Execute ['"]wscript\.exe['"]/i.test(enableAlwaysOnScript) || !/New-ScheduledTaskAction -Execute \$windowsScriptHost/.test(enableAlwaysOnScript)) {
  failures.push("src/runtime/Enable-Always-On.ps1: scheduled task must use the validated absolute Windows Script Host path");
}
for (const [relative, source] of [
  ["src/runtime/Launch-Codex-Bot.ps1", launcherScript],
  ["src/runtime/Enable-Always-On.ps1", enableAlwaysOnScript],
]) {
  if (!/\$windowsScriptHost\s*=\s*Join-Path \$env:SystemRoot 'System32\\wscript\.exe'/.test(source) || !/Test-Path -LiteralPath \$windowsScriptHost -PathType Leaf/.test(source)) {
    failures.push(`${relative}: absolute Windows Script Host path must be constructed and validated before use`);
  }
}
if (/spawnSync\(['"]powershell\.exe['"]/i.test(connectionSource) || !/spawnSync\(WINDOWS_POWERSHELL,/.test(connectionSource)) {
  failures.push("src/codex-connection.cjs: credential protection must use the absolute Windows PowerShell path");
}

const supportedRuntimeManifestPath = path.join(ROOT, "assets", "grok-bot-0.16.0-windows-x64.manifest.json");
const supportedRuntimeVerifierPath = path.join(ROOT, "scripts", "Verify-GrokBotRuntime.ps1");
const expectedSignerSubject = 'CN="Anysphere, Inc.", O="Anysphere, Inc.", L=San Francisco, S=California, C=US';
const expectedSignerThumbprint = "786DA5811DB0A4B3C1AD4754B4CC06BF76C97827";
try {
  const manifest = JSON.parse(fs.readFileSync(supportedRuntimeManifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.product !== "Grok Bot" || manifest.version !== "0.16.0" || manifest.platform !== "windows-x64") {
    failures.push("assets/grok-bot-0.16.0-windows-x64.manifest.json: unexpected supported-runtime identity");
  }
  if (manifest.signer?.subject !== expectedSignerSubject || manifest.signer?.thumbprint !== expectedSignerThumbprint) {
    failures.push("assets/grok-bot-0.16.0-windows-x64.manifest.json: signer identity is not the reviewed pin");
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const paths = files.map((entry) => entry?.path);
  if (files.length !== 657) failures.push("assets/grok-bot-0.16.0-windows-x64.manifest.json: expected the reviewed 657-file runtime tree");
  if (paths.some((relative, index) => typeof relative !== "string" || (index > 0 && paths[index - 1] >= relative))) {
    failures.push("assets/grok-bot-0.16.0-windows-x64.manifest.json: paths must be unique and ordinally sorted");
  }
  if (new Set(paths.map((relative) => String(relative).toLowerCase())).size !== paths.length) {
    failures.push("assets/grok-bot-0.16.0-windows-x64.manifest.json: paths must be case-insensitively unique");
  }
  if (files.some((entry) => typeof entry?.path !== "string" || entry.path.includes("\\") || path.win32.isAbsolute(entry.path) || entry.path.split("/").some((part) => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(entry?.sha256 || ""))) {
    failures.push("assets/grok-bot-0.16.0-windows-x64.manifest.json: entries must contain canonical relative paths and lowercase SHA-256 values");
  }
  const byPath = new Map(files.map((entry) => [entry.path, entry.sha256]));
  if (byPath.get("resources/app.asar") !== "955fb24e72ec85729cac2f921758a93a85089a0fc659e712125d6650b364d20e") {
    failures.push("assets/grok-bot-0.16.0-windows-x64.manifest.json: app.asar hash does not match the supported archive");
  }
  for (const required of ["Grok Bot.exe", "d3dcompiler_47.dll", "dxcompiler.dll", "ffmpeg.dll", "libEGL.dll", "libGLESv2.dll", "vulkan-1.dll"]) {
    if (!/^[a-f0-9]{64}$/.test(byPath.get(required) || "")) failures.push(`assets/grok-bot-0.16.0-windows-x64.manifest.json: missing required runtime file ${required}`);
  }
} catch (error) {
  failures.push(`assets/grok-bot-0.16.0-windows-x64.manifest.json: could not validate manifest (${error instanceof Error ? error.message : String(error)})`);
}

try {
  const verifier = fs.readFileSync(supportedRuntimeVerifierPath, "utf8");
  for (const required of ["Get-AuthenticodeSignature", "Get-FileHash -Algorithm SHA256", "FileAttributes]::ReparsePoint", expectedSignerSubject, expectedSignerThumbprint]) {
    if (!verifier.includes(required)) failures.push(`scripts/Verify-GrokBotRuntime.ps1: required integrity control is missing (${required})`);
  }
  const installedVerifier = /Source: "\.\.\\scripts\\Verify-GrokBotRuntime\.ps1"; DestDir: "\{app\}\\tools\\integrity"; Flags: ignoreversion/i.test(installerManifest);
  const temporaryVerifier = /Source: "\.\.\\scripts\\Verify-GrokBotRuntime\.ps1"; Flags: dontcopy/i.test(installerManifest);
  const installedManifest = /Source: "\.\.\\assets\\grok-bot-0\.16\.0-windows-x64\.manifest\.json"; DestDir: "\{app\}\\tools\\integrity"; Flags: ignoreversion/i.test(installerManifest);
  const temporaryManifest = /Source: "\.\.\\assets\\grok-bot-0\.16\.0-windows-x64\.manifest\.json"; Flags: dontcopy/i.test(installerManifest);
  if (!installedVerifier || !temporaryVerifier || !installedManifest || !temporaryManifest) {
    failures.push("installer/CodexBot.iss: verifier and manifest must be explicitly packaged for both preflight and copied-tree checks");
  }
  if (!/function PrepareToInstall[\s\S]*Verify-GrokBotRuntime\.ps1[\s\S]*ewWaitUntilTerminated/i.test(installerManifest)) {
    failures.push("installer/CodexBot.iss: selected vendor tree must be verified before external files are installed");
  }
  const installScript = fs.readFileSync(path.join(ROOT, "scripts", "Install-CodexBot.ps1"), "utf8");
  const verifyIndex = installScript.indexOf("& $runtimeVerifier -InstallRoot $appRoot -ManifestPath $runtimeManifest");
  const launchIndex = installScript.indexOf("$patchProcess = Start-Process");
  if (verifyIndex < 0 || launchIndex <= verifyIndex) {
    failures.push("scripts/Install-CodexBot.ps1: complete copied-tree verification must precede the first vendor executable launch");
  }
} catch (error) {
  failures.push(`supported-runtime enforcement inspection failed: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  const tracked = childProcess.execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const relative of tracked) {
    const normalized = relative.replaceAll("\\", "/");
    const extension = path.extname(normalized).toLowerCase();
    if ([".exe", ".msi", ".asar", ".zip", ".7z"].includes(extension)) {
      failures.push(`${normalized}: generated/proprietary binary must not be tracked`);
    }
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(normalized))) {
      failures.push(`${normalized}: private runtime data must not be tracked`);
    }
  }
} catch (error) {
  failures.push(`git index inspection failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (failures.length) {
  process.stderr.write(`Release source audit failed:\n${[...new Set(failures)].map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Release source audit passed: no runtime state, personal paths, secrets, proprietary bundles, or broad installer source globs found.\n");
}
