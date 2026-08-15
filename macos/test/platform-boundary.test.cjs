"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(macRoot, "..");
const windowsBase = "129bc098ec1a8152c11b99e205eb87220603e268";

function git(...args) {
  return childProcess.execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(macRoot, relative), "utf8"));
}

test("the macOS package is isolated from the Windows release line", () => {
  assert.equal(git("branch", "--show-current").trim(), "macos/codex-bot");
  assert.equal(
    git("merge-base", windowsBase, "HEAD").trim(),
    windowsBase,
    "the macOS branch must remain based on the reviewed Windows release",
  );

  const changed = git(
    "diff",
    "--name-only",
    windowsBase,
    "--",
    ":(exclude)macos/**",
    ":(exclude)docs/superpowers/specs/2026-08-14-macos-grok-020-preserve-patch-design.md",
    ":(exclude)docs/superpowers/plans/2026-08-14-macos-grok-020-preserve-patch.md",
    ":(exclude).github/workflows/macos-release.yml",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(changed, [], `Windows/shared paths changed: ${changed.join(", ")}`);
});

test("the macOS package has an independent release and command surface", () => {
  const packageJson = readJson("package.json");
  assert.deepEqual(
    {
      name: packageJson.name,
      version: packageJson.version,
      private: packageJson.private,
      license: packageJson.license,
      node: packageJson.engines?.node,
    },
    {
      name: "openbot-macos",
      version: "0.2.0-macos.1",
      private: true,
      license: "MIT",
      node: ">=22.13.0",
    },
  );
  for (const command of [
    "test",
    "check",
    "audit:release",
    "build:installer",
    "package:dmg",
  ]) {
    assert.equal(typeof packageJson.scripts?.[command], "string", command);
    assert.notEqual(packageJson.scripts[command].trim(), "", command);
  }
  assert.equal(
    packageJson.repository?.url,
    "https://github.com/LimonLimez/Codex-Bot.git",
  );

  const lock = readJson("package-lock.json");
  assert.equal(lock.name, packageJson.name);
  assert.equal(lock.version, packageJson.version);
  assert.equal(lock.packages?.[""]?.name, packageJson.name);
  assert.equal(lock.packages?.[""]?.version, packageJson.version);
  assert.doesNotMatch(JSON.stringify(lock), /\/Users\/|\\Users\\/);
});

test("macOS documentation and ignores preserve the distribution boundary", () => {
  const readme = fs.readFileSync(path.join(macRoot, "README.md"), "utf8");
  assert.match(readme, /macOS Apple Silicon/i);
  assert.match(readme, /Windows.*unchanged/is);
  assert.match(readme, /Grok Bot 0\.20\.0/);
  assert.match(readme, /does not contain.*Grok Bot/is);
  assert.match(readme, /no local.*fallback/is);
  assert.match(readme, /Codex 0\.147\.0/);
  assert.match(readme, /CLIProxyAPI 7\.2\.132/);
  assert.match(readme, /official Codex\s+account.*without.*ChatGPT\.app/is);
  assert.match(readme, /CLIProxyAPI.*optional/is);

  const privacy = fs.readFileSync(path.join(macRoot, "PRIVACY.md"), "utf8");
  assert.match(privacy, /official Codex\s+account.*OpenAI/is);
  assert.match(privacy, /CLIProxyAPI.*optional/is);
  assert.doesNotMatch(privacy, /Connecting a Codex.*CLIProxyAPI/is);

  const ignore = fs.readFileSync(path.join(macRoot, ".gitignore"), "utf8");
  for (const entry of [
    "node_modules/",
    "build/",
    "dist/",
    "*.dmg",
    "*.app",
    "*.asar",
    "state/",
    "profiles/",
    "*.log",
  ]) {
    assert.match(ignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});
