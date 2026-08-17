"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function run(command, args, cwd = root) {
  return childProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

function copyAuditFixture() {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-release-audit-test-"),
  );
  const indexed = run("git", ["ls-files", "-z"]);
  assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);
  const tracked = indexed.stdout.split("\0").filter(Boolean);
  for (const relative of tracked) {
    const segments = relative.split("/");
    if (segments[0] === "macos") continue;
    const source = path.join(root, ...segments);
    const destination = path.join(fixture, ...segments);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), destination);
    } else {
      fs.copyFileSync(source, destination);
    }
  }
  const initialized = run("git", ["init", "--quiet"], fixture);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const added = run("git", ["add", "--force", "--all"], fixture);
  assert.equal(added.status, 0, added.stderr || added.stdout);
  return fixture;
}

test("official OAuth state is ignored and rejected without hiding official source", () => {
  const fixture = copyAuditFixture();
  const credentialPaths = [
    "official-computer/credentials.json",
    "copied-state/official-computer/credentials.json",
  ];
  try {
    for (const relativePath of credentialPaths) {
      const ignored = run(
        "git",
        ["check-ignore", "--no-index", "--", relativePath],
        fixture,
      );
      assert.equal(
        ignored.status,
        0,
        `${relativePath} must be ignored: ${ignored.stderr || ignored.stdout}`,
      );

      const audited = run(
        process.execPath,
        [path.join(fixture, "scripts", "security-audit.cjs"), relativePath],
        fixture,
      );
      assert.equal(audited.status, 1);
      assert.match(audited.stderr, /forbidden private runtime-data path/);
    }

    const sourcePath = "src/official-computer-helper.cjs";
    const sourceIgnored = run(
      "git",
      ["check-ignore", "--no-index", "--", sourcePath],
      fixture,
    );
    assert.equal(
      sourceIgnored.status,
      1,
      sourceIgnored.stderr || sourceIgnored.stdout,
    );

    const sourceAudited = run(
      process.execPath,
      [path.join(fixture, "scripts", "security-audit.cjs"), sourcePath],
      fixture,
    );
    assert.equal(
      sourceAudited.status,
      0,
      sourceAudited.stderr || sourceAudited.stdout,
    );
  } finally {
    fs.rmSync(fixture, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});

test("Windows release audit excludes only the top-level macOS product", () => {
  const fixture = copyAuditFixture();
  try {
    const fixtureAudit = path.join(fixture, "scripts", "security-audit.cjs");
    const topLevel = path.join(fixture, "macos", "forbidden.log");
    const nested = path.join(fixture, "src", "macos", "forbidden.log");
    const contents = "forbidden release fixture\n";
    fs.mkdirSync(path.dirname(topLevel), { recursive: true });
    fs.writeFileSync(topLevel, contents);

    const excluded = run(process.execPath, [fixtureAudit], fixture);
    assert.equal(excluded.status, 0, excluded.stderr || excluded.stdout);

    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, contents);
    const rejected = run(process.execPath, [fixtureAudit], fixture);
    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /src\/macos\/forbidden\.log: forbidden release file type \.log/,
    );
  } finally {
    fs.rmSync(fixture, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});

test("normal release audit allows only an empty artifacts directory or the exact canonical pair", () => {
  const fixture = copyAuditFixture();
  try {
    const fixtureAudit = path.join(fixture, "scripts", "security-audit.cjs");
    const empty = run(process.execPath, [fixtureAudit], fixture);
    assert.equal(empty.status, 0, empty.stderr || empty.stdout);

    const version = JSON.parse(
      fs.readFileSync(path.join(fixture, "package.json"), "utf8"),
    ).version;
    const installerName = `OpenBot-Setup-${version}.exe`;
    const artifacts = path.join(fixture, "artifacts");
    const installer = path.join(artifacts, installerName);
    const sidecar = `${installer}.sha256`;
    const installerBytes = Buffer.from(
      "harmless canonical installer fixture\n",
    );
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(installer, installerBytes);
    const hash = crypto
      .createHash("sha256")
      .update(installerBytes)
      .digest("hex");
    fs.writeFileSync(sidecar, `${hash}  ${installerName}\n`, "ascii");

    const canonical = run(process.execPath, [fixtureAudit], fixture);
    assert.equal(canonical.status, 0, canonical.stderr || canonical.stdout);

    const sentinel = path.join(
      artifacts,
      "copied-state",
      "official-computer",
      "credentials.json",
    );
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "{}\n", { encoding: "utf8", flag: "wx" });
    const rejected = run(process.execPath, [fixtureAudit], fixture);
    assert.equal(rejected.status, 1);
    assert.match(
      rejected.stderr,
      /artifacts\/copied-state\/official-computer\/credentials\.json: unexpected release artifact entry/,
    );

    fs.rmSync(path.join(artifacts, "copied-state"), {
      recursive: true,
      force: true,
    });
    const developmentName = `OpenBot-Setup-${version}-DEVELOPMENT-fixture.exe`;
    const developmentInstaller = path.join(artifacts, developmentName);
    const developmentBytes = Buffer.from(
      "harmless development installer fixture\n",
    );
    fs.writeFileSync(developmentInstaller, developmentBytes);
    const developmentHash = crypto
      .createHash("sha256")
      .update(developmentBytes)
      .digest("hex");
    fs.writeFileSync(
      `${developmentInstaller}.sha256`,
      `${developmentHash}  ${developmentName}\n`,
      "ascii",
    );

    const developmentRejected = run(process.execPath, [fixtureAudit], fixture);
    assert.equal(developmentRejected.status, 1);
    assert.match(
      developmentRejected.stderr,
      new RegExp(
        `${developmentName.replaceAll(".", "\\.")}: unexpected release artifact entry`,
      ),
    );
  } finally {
    fs.rmSync(fixture, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  }
});
