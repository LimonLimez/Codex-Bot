"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const auditPath = path.join(__dirname, "..", "scripts", "audit-release.cjs");
const packagePath = path.join(__dirname, "..", "scripts", "package-dmg.cjs");

function auditFixture(t, entries = []) {
  const { auditTree, writeInstallerManifest } = require(auditPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-release-audit-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Install OpenBot DEVELOPMENT.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "InstallCodexBot"), "safe\n");
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "safe\n");
  for (const [relative, contents, kind = "file"] of entries) {
    const target = path.join(app, "Contents", ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (kind === "symlink") fs.symlinkSync("../Info.plist", target);
    else fs.writeFileSync(target, contents);
  }
  writeInstallerManifest(app);
  return {
    app,
    audit: () => auditTree(root, { expectedAppName: path.basename(app) }),
    root,
  };
}

function signedInstallerFixture(t) {
  const { writeInstallerManifest } = require(auditPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-signed-installer-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Install OpenBot DEVELOPMENT.app");
  const executable = path.join(app, "Contents", "MacOS", "InstallCodexBot");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.copyFileSync("/usr/bin/true", executable);
  fs.chmodSync(executable, 0o755);
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.limonlimez.openbot.test-installer</string><key>CFBundleExecutable</key><string>InstallCodexBot</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n',
  );
  const signedExecutable = childProcess.spawnSync("/usr/bin/codesign", [
    "--force", "--timestamp=none", "--sign", "-", executable,
  ], { encoding: "utf8" });
  assert.equal(signedExecutable.status, 0, signedExecutable.stderr);
  const manifestPath = writeInstallerManifest(app);
  const signed = childProcess.spawnSync("/usr/bin/codesign", [
    "--force", "--timestamp=none", "--sign", "-", app,
  ], { encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr);
  return { app, executable, manifestPath, root };
}

test("release audit rejects manifest-approved local profiles state workspaces evidence and development files", async (t) => {
  const cases = [
    ["compound browser profile", "Resources/private-browser-profile/Default/Preferences", "safe\n"],
    ["spaced compound browser profiles", "Resources/private browser profiles/Default/Preferences", "safe\n"],
    ["browser Bookmarks", "Resources/Browser/Default/Bookmarks", "safe\n"],
    ["permission grants and bookmarks", "Resources/local-permissions.v1.json", '{"grants":[],"bookmarks":[]}\n'],
    ["local workspace", "Resources/openbot-local/bot-a/tasks/task-a/file.txt", "safe\n"],
    ["standalone transcripts", "Resources/standalone-conversations.v1.json", '{"conversations":[]}\n'],
    ["captured frame", "Resources/evidence/frame-0001.png", Buffer.from("89504e470d0a1a0a", "hex")],
    ["screenshot", "Resources/evidence/setup-screenshot.png", Buffer.from("89504e470d0a1a0a", "hex")],
    ["helper logs", "Resources/helper-logs/stdout.txt", "safe\n"],
    ["log suffix", "Resources/helper-output.log", "safe\n"],
    ["dotenv", "Resources/config/.env.production", "SAFE=true\n"],
    ["npmrc", "Resources/config/.npmrc", "registry=https://registry.npmjs.org\n"],
    ["suffixed npmrc", "Resources/config/.npmrc.private", "registry=https://registry.npmjs.org\n"],
    ["secret file", "Resources/config/secrets.json", '{}\n'],
    ["token file", "Resources/config/oauth-tokens.json", '{}\n'],
  ];
  for (const [label, relative, contents] of cases) {
    await t.test(label, (subtest) => {
      const fixture = auditFixture(subtest, [[relative, contents]]);
      assert.throws(fixture.audit, /privacy audit.*(?:state|profile|bookmark|workspace|screenshot|frame|log|development|credential|secret)/i);
    });
  }
});

test("release audit scans every manifest-approved regular file for paths credentials OAuth JWT and fixture secrets", async (t) => {
  const cases = [
    ["foreign macOS home", "Resources/leak.txt", "/Users/private-developer/secret\n"],
    ["lowercase Windows home", "Resources/leak.txt", "C:\\users\\Alice\\private\\file\n"],
    ["binary home", "Resources/compiled.bin", Buffer.from("binary\0/Users/foreign-builder/private/source\0")],
    ["private key", "Resources/key.txt", "-----BEGIN PRIVATE KEY-----\n"],
    ["short access token", "Resources/config.txt", '{"access_token":"abc123"}\n'],
    ["alphabetic access token", "Resources/config.txt", "access_token=supersecretvalue\n"],
    ["password assignment", "Resources/config.txt", "password=huntertwo\n"],
    ["cookie assignment", "Resources/config.txt", "cookie=sessionvalue\n"],
    ["OAuth token", "Resources/config.txt", "oauthToken = oauth-fixture-value\n"],
    ["JWT", "Resources/config.txt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.c2lnbmF0dXJlLXZhbHVl\n"],
    ["known fixture token", "Resources/config.txt", "fixture-private-auth-token-value\n"],
    ["pinned CLIProxy path", "Resources/CLIProxy/cli-proxy-api", Buffer.from("official\0/Users/private/build\0")],
    ["pinned Codex secret", "Resources/CodexRuntime/codex", Buffer.from("official\0access_token=abc123\0")],
  ];
  for (const [label, relative, contents] of cases) {
    await t.test(label, (subtest) => {
      const fixture = auditFixture(subtest, [[relative, contents]]);
      assert.throws(fixture.audit, /privacy audit.*(?:personal|path|credential|secret)/i);
    });
  }
});

test("release audit accepts reviewed pinned binaries without treating high entropy as a secret", (t) => {
  const fixture = auditFixture(t, [
    ["Resources/CLIProxy/cli-proxy-api", crypto.randomBytes(64 * 1024)],
    ["Resources/CodexRuntime/codex", crypto.randomBytes(64 * 1024)],
  ]);
  assert.doesNotThrow(fixture.audit);
});

test("release audit distinguishes reviewed public CI build paths from personal paths", async (t) => {
  await t.test("exact upstream binary members accept only reviewed public CI roots", (subtest) => {
    const fixture = auditFixture(subtest, [
      [
        "Resources/CLIProxy/cli-proxy-api",
        Buffer.from([
          "/Users/runner/go/pkg/mod/example.org/module/file.go",
          "/Users/runner/go/pkg/mod/example.org/module/home/client.go",
          "/Users/runner/hostedtoolcache/go/1.24.0/arm64/src/runtime/proc.go",
          "/Users/runner/work/CLIProxyAPI/CLIProxyAPI/internal/server.go",
        ].join("\0")),
      ],
      [
        "Resources/CodexRuntime/codex",
        Buffer.from([
          "/Users/runner/.cargo/registry/src/index.crates.io/package/src/lib.rs",
          "/Users/runner/.cargo/git/checkouts/package/revision/src/lib.rs",
          "/Users/runner/.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/src/rust/library/std/src/lib.rs",
        ].join("\0")),
      ],
    ]);
    assert.doesNotThrow(fixture.audit);
  });

  await t.test("a reviewed public CI path remains valid across an audit chunk boundary", (subtest) => {
    const splitAt = (1024 * 1024) - Buffer.byteLength("/Users/run");
    const fixture = auditFixture(subtest, [[
      "Resources/CLIProxy/cli-proxy-api",
      Buffer.concat([
        Buffer.alloc(splitAt, 0x78),
        Buffer.from("/Users/runner/hostedtoolcache/go/1.24.0/arm64/src/runtime/proc.go\0"),
      ]),
    ]]);
    assert.doesNotThrow(fixture.audit);
  });

  for (const [label, relative, contents] of [
    [
      "reviewed-looking path in an ordinary member",
      "Resources/Patcher/compiled.bin",
      "/Users/runner/.cargo/registry/src/private/file.rs",
    ],
    [
      "unreviewed repository in CLIProxy",
      "Resources/CLIProxy/cli-proxy-api",
      "/Users/runner/work/private-repository/private/file.go",
    ],
    [
      "unreviewed Cargo directory in Codex",
      "Resources/CodexRuntime/codex",
      "/Users/runner/.cargo/private/credentials",
    ],
    [
      "a reviewed root cannot conceal a concatenated private home",
      "Resources/CLIProxy/cli-proxy-api",
      "/Users/runner/go/pkg/mod/example:/Users/private-developer/project",
    ],
    [
      "a reviewed root cannot escape through parent path segments",
      "Resources/CLIProxy/cli-proxy-api",
      "/Users/runner/work/CLIProxyAPI/../../private-developer/project",
    ],
  ]) {
    await t.test(label, (subtest) => {
      const fixture = auditFixture(subtest, [[relative, Buffer.from(contents)]]);
      assert.throws(fixture.audit, /privacy audit.*personal absolute path/i);
    });
  }
});

test("exact reviewed binaries ignore only embedded static token vocabulary", () => {
  const { credentialMaterialKind } = require(auditPath);
  assert.equal(typeof credentialMaterialKind, "function");
  const staticVocabulary = `usage: Authorization: Bearer ${"a".repeat(40)} example sk-${"b".repeat(24)}`;
  assert.equal(credentialMaterialKind(staticVocabulary, { exactReviewedBinary: false }), "generic-token");
  assert.equal(credentialMaterialKind(staticVocabulary, { exactReviewedBinary: true }), null);
  for (const value of [
    "/Users/private/source",
    "-----BEGIN PRIVATE KEY-----",
    '{"access_token":"abc123"}',
    "fixture-private-auth-token-value",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.c2lnbmF0dXJlLXZhbHVl",
  ]) {
    assert.equal(credentialMaterialKind(value, { exactReviewedBinary: true }), "strict");
  }
});

test("release audit distinguishes reviewed user-data source from an actual user data store", async (t) => {
  await t.test("reviewed source", (subtest) => {
    const fixture = auditFixture(subtest, [
      [
        "Resources/Patcher/src/desktop/openbot-user-data.cjs",
        '"use strict";\nmodule.exports = {};\n',
      ],
      [
        "Resources/Patcher/src/renderer/openbot-local-desktop-view.css",
        ".openbot-local-desktop { display: block; }\n",
      ],
    ]);
    assert.doesNotThrow(fixture.audit);
  });
  await t.test("actual User Data store", (subtest) => {
    const fixture = auditFixture(subtest, [["Resources/User Data/Preferences", "safe\n"]]);
    assert.throws(fixture.audit, /privacy audit.*state/i);
  });
});

test("release audit rejects symlinks and extra image roots", (t) => {
  const { auditTree } = require(auditPath);
  const fixture = auditFixture(t);

  const link = path.join(fixture.app, "Contents", "Resources", "link");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync("../Info.plist", link);
  assert.throws(fixture.audit, /privacy audit.*symlink/i);
  fs.rmSync(link);
  fs.writeFileSync(path.join(fixture.root, "extra.txt"), "extra\n");
  assert.throws(
    () => auditTree(fixture.root, { expectedAppName: path.basename(fixture.app) }),
    /privacy audit.*exactly/i,
  );
});

test("installer preflight binds InstallCodexBot byte count and strict signature before packaging", (t) => {
  const { preflightInstallerApp, verifyInstallerSignature } = require(packagePath);
  assert.equal(typeof preflightInstallerApp, "function");
  assert.equal(typeof verifyInstallerSignature, "function");
  const fixture = signedInstallerFixture(t);
  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
  const executableEntry = manifest.entries.find(
    (entry) => entry.path === "Contents/MacOS/InstallCodexBot",
  );
  assert.deepEqual(executableEntry, {
    path: "Contents/MacOS/InstallCodexBot",
    type: "signed-code",
    bytes: fs.statSync(fixture.executable).size,
  });
  assert.doesNotThrow(() => verifyInstallerSignature(fixture.app));
  assert.doesNotThrow(() => preflightInstallerApp({
    installerApp: fixture.app,
    expectedAppName: path.basename(fixture.app),
  }));

  const descriptor = fs.openSync(fixture.executable, "r+");
  try {
    const byte = Buffer.alloc(1);
    fs.readSync(descriptor, byte, 0, 1, 64);
    byte[0] ^= 0xff;
    fs.writeSync(descriptor, byte, 0, 1, 64);
  } finally {
    fs.closeSync(descriptor);
  }
  assert.throws(
    () => preflightInstallerApp({
      installerApp: fixture.app,
      expectedAppName: path.basename(fixture.app),
    }),
    /signature|codesign/i,
  );
});

test("DMG parser requires an explicit installer and release identity", () => {
  const { packageDmg, parseArgs } = require(packagePath);
  assert.deepEqual(parseArgs([
    "--installer-app", "/tmp/Install OpenBot DEVELOPMENT.app",
    "--output", "/tmp/OpenBot-0.2.0-macos.1-DEVELOPMENT.dmg",
  ]), {
    release: false,
    "installer-app": "/tmp/Install OpenBot DEVELOPMENT.app",
    output: "/tmp/OpenBot-0.2.0-macos.1-DEVELOPMENT.dmg",
  });
  assert.throws(() => parseArgs(["--release", "--installer-app", "/tmp/Test.app", "--output", "/tmp/Test.dmg"]), /Developer ID Application/i);
  assert.throws(() => parseArgs(["--shell", "unsafe"]), /invalid/i);
  assert.throws(() => parseArgs([
    "--release",
    "--installer-app", "/tmp/Wrong Product.app",
    "--output", "/tmp/Wrong-9.9.9.dmg",
    "--signing-identity", "Developer ID Application: Example (ABCDE12345)",
  ]), /OpenBot/i);
  assert.throws(() => parseArgs([
    "--installer-app", "/tmp/Install OpenBot.app",
    "--output", "/tmp/OpenBot-0.2.0-macos.1.dmg",
  ]), /DEVELOPMENT/i);
  assert.throws(() => packageDmg({
    "installer-app": "/tmp/Wrong Product.app",
    output: "/tmp/Wrong-9.9.9.dmg",
    release: false,
  }), /OpenBot.*DEVELOPMENT/i);
});

test("exact installer packages to a mounted privacy-clean development DMG", {
  skip: !process.env.CODEX_BOT_INSTALLER_APP,
}, (t) => {
  const { auditDmg } = require(auditPath);
  const { packageDmg } = require(packagePath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-dmg-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "OpenBot-0.2.0-macos.1-DEVELOPMENT.dmg");
  const receipt = packageDmg({
    "installer-app": process.env.CODEX_BOT_INSTALLER_APP,
    output,
    release: false,
  });
  assert.equal(receipt.development, true);
  assert.equal(receipt.dmg, output);
  assert.equal(receipt.sha256.length, 64);
  assert.equal(fs.statSync(output).isFile(), true);
  const audit = auditDmg(output, { expectedAppName: "Install OpenBot DEVELOPMENT.app" });
  assert.equal(audit.fileCount > 20, true);
  assert.equal(audit.personalPathMatches, 0);
  assert.equal(audit.secretMatches, 0);
});
