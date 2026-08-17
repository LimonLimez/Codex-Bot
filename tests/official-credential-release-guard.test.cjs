"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const auditScript = path.join(root, "scripts", "security-audit.cjs");

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
  const excluded = new Set([".git", "node_modules", "build", "artifacts"]);
  fs.cpSync(root, fixture, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      const first = relative.split(path.sep)[0];
      return relative === "" || !excluded.has(first);
    },
  });
  const initialized = run("git", ["init", "--quiet"], fixture);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  const indexed = run("git", ["add", "-A"], fixture);
  assert.equal(indexed.status, 0, indexed.stderr || indexed.stdout);
  return fixture;
}

test("official OAuth state is ignored and rejected without hiding official source", () => {
  const credentialPaths = [
    "official-computer/credentials.json",
    "copied-state/official-computer/credentials.json",
  ];

  for (const relativePath of credentialPaths) {
    const ignored = run("git", [
      "check-ignore",
      "--no-index",
      "--",
      relativePath,
    ]);
    assert.equal(
      ignored.status,
      0,
      `${relativePath} must be ignored: ${ignored.stderr || ignored.stdout}`,
    );

    const audited = run(process.execPath, [auditScript, relativePath]);
    assert.equal(audited.status, 1);
    assert.match(audited.stderr, /forbidden private runtime-data path/);
  }

  const sourcePath = "src/official-computer-helper.cjs";
  const sourceIgnored = run("git", [
    "check-ignore",
    "--no-index",
    "--",
    sourcePath,
  ]);
  assert.equal(
    sourceIgnored.status,
    1,
    sourceIgnored.stderr || sourceIgnored.stdout,
  );

  const sourceAudited = run(process.execPath, [auditScript, sourcePath]);
  assert.equal(
    sourceAudited.status,
    0,
    sourceAudited.stderr || sourceAudited.stdout,
  );
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
