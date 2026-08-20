"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const auditPath = path.join(__dirname, "..", "scripts", "audit-release.cjs");
const buildInstallerPath = path.join(__dirname, "..", "scripts", "build-installer-app.cjs");
const packagePath = path.join(__dirname, "..", "scripts", "package-dmg.cjs");

function auditFixture(t, entries = []) {
  const { auditPayloadTree, writeInstallerManifest } = require(auditPath);
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
    audit: () => auditPayloadTree(root, { expectedAppName: path.basename(app) }),
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

function provenanceFixture(t, mutateReceipt = (receipt) => receipt) {
  const {
    PROVENANCE_RELATIVE,
    createInstallerProvenanceReceipt,
  } = require(buildInstallerPath);
  const { writeInstallerManifest } = require(auditPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-provenance-audit-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Install OpenBot DEVELOPMENT.app");
  const executable = path.join(app, "Contents", "MacOS", "InstallCodexBot");
  const sidecar = path.join(app, "Contents", "Resources", "CLIProxy", "cli-proxy-api");
  const codex = path.join(app, "Contents", "Resources", "CodexRuntime", "codex");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  fs.writeFileSync(executable, "safe\n");
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "safe\n");
  fs.writeFileSync(sidecar, Buffer.from(
    "/Users/runner/hostedtoolcache/go/1.26.4/arm64\0"
      + "/Users/runner/work/CLIProxyAPI/CLIProxyAPI/internal/home/certificate.go\0",
    "latin1",
  ));
  fs.writeFileSync(codex, Buffer.from(
    "/Users/runner/.cargo/registry/src/package/src/lib.rsOTELhttp://localhost:4317\0",
    "latin1",
  ));
  const receipt = mutateReceipt(JSON.parse(JSON.stringify(createInstallerProvenanceReceipt({
    installedCodexRuntime: codex,
    installedSidecar: sidecar,
  }))));
  const receiptPath = path.join(app, ...PROVENANCE_RELATIVE.split("/"));
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  const manifestPath = writeInstallerManifest(app);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  return { app, codex, expected, receiptPath, root, sidecar };
}

test("release audit accepts only the authorized Developer ID signature chain", () => {
  const {
    assertAuthorizedInstallerSignature,
    installerSignatureVerificationArguments,
  } = require(auditPath);
  const externalRequirement = '=anchor apple generic and certificate leaf[subject.OU] = "HKCH65M45F" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  assert.equal(typeof assertAuthorizedInstallerSignature, "function");
  assert.equal(typeof installerSignatureVerificationArguments, "function");
  assert.deepEqual(installerSignatureVerificationArguments("/tmp/Install OpenBot.app"), [
    "--verify", "--deep", "--strict",
    "--test-requirement", externalRequirement,
    "/tmp/Install OpenBot.app",
  ]);
  const authorizedDisplay = [
    "Executable=/private/tmp/Install OpenBot DEVELOPMENT.app/Contents/MacOS/InstallCodexBot",
    "Authority=Developer ID Application: Harlin Sidwell (HKCH65M45F)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "TeamIdentifier=HKCH65M45F",
  ].join("\n");
  assert.throws(
    () => assertAuthorizedInstallerSignature(authorizedDisplay),
    /external Apple requirement/i,
  );
  assert.deepEqual(assertAuthorizedInstallerSignature(authorizedDisplay, {
    externalRequirementVerified: true,
  }), {
    authority: "Developer ID Application: Harlin Sidwell (HKCH65M45F)",
    teamIdentifier: "HKCH65M45F",
  });
  assert.throws(
    () => assertAuthorizedInstallerSignature([
      "Authority=Developer ID Application: Locally Forged Lookalike (HKCH65M45F)",
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      "TeamIdentifier=HKCH65M45F",
    ].join("\n")),
    /external Apple requirement/i,
  );
  for (const output of [
    "Signature=adhoc\nTeamIdentifier=not set",
    "Authority=Apple Development: Harlin Sidwell (HKCH65M45F)\nTeamIdentifier=HKCH65M45F",
    "Authority=Developer ID Application: Someone Else (ABCDE12345)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDE12345",
    "Authority=Developer ID Application: Harlin Sidwell (HKCH65M45F)\nTeamIdentifier=HKCH65M45F",
  ]) {
    assert.throws(
      () => assertAuthorizedInstallerSignature(output, { externalRequirementVerified: true }),
      /authorized Developer ID/i,
    );
  }
});

test("release audit rejects an otherwise valid ad-hoc installer before trusting its manifest", (t) => {
  const { auditTree } = require(auditPath);
  const fixture = signedInstallerFixture(t);
  assert.throws(
    () => auditTree(fixture.root, { expectedAppName: path.basename(fixture.app) }),
    /authorized Developer ID|code signature verification failed/i,
  );
});

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

test("release audit accepts every authoritative staged source without credential-shaped assignments", async (t) => {
  const { PATCHER_SOURCE_FILES, PATCHER_SHARED_SOURCE_FILES } = require(buildInstallerPath);
  const { credentialMaterialKind } = require(auditPath);
  const macosSourceRoot = path.resolve(__dirname, "..", "src");
  const sharedSourceRoot = path.resolve(__dirname, "..", "..", "src");
  const sourceFiles = [
    ...PATCHER_SOURCE_FILES.map((relative) => ({
      relative: `macos/src/${relative}`,
      source: path.join(macosSourceRoot, ...relative.split("/")),
    })),
    ...PATCHER_SHARED_SOURCE_FILES.map((relative) => ({
      relative: `src/${relative}`,
      source: path.join(sharedSourceRoot, ...relative.split("/")),
    })),
  ];
  assert.equal(PATCHER_SOURCE_FILES.length, 64);
  assert.equal(PATCHER_SHARED_SOURCE_FILES.length, 1);
  assert.equal(sourceFiles.length, 65);
  const sharedDescriptor = sourceFiles.find(({ relative }) => relative === "src/provider-descriptors.cjs");
  assert.deepEqual(sharedDescriptor, {
    relative: "src/provider-descriptors.cjs",
    source: path.join(sharedSourceRoot, "provider-descriptors.cjs"),
  });
  const sharedBytes = fs.readFileSync(sharedDescriptor.source);
  assert.equal(sharedBytes.byteLength, 8506);
  assert.equal(
    crypto.createHash("sha256").update(sharedBytes).digest("hex"),
    "56f298a06f706ebd5fde1180e2a23ccb26b79e5ecaa6ff534e40ea374b1aba8d",
  );
  for (const { relative, source } of sourceFiles) {
    await t.test(relative, () => {
      const contents = fs.readFileSync(source, "latin1");
      assert.equal(credentialMaterialKind(contents), null, relative);
    });
  }
});

test("public CI path exemptions require a sealed exact provenance receipt", (t) => {
  const {
    credentialMaterialKind,
    loadInstallerProvenance,
    reviewedRootsForMember,
  } = require(auditPath);
  const fixture = provenanceFixture(t);
  const cliRelative = "Contents/Resources/CLIProxy/cli-proxy-api";
  const codexRelative = "Contents/Resources/CodexRuntime/codex";
  const identity = (file) => ({
    bytes: fs.statSync(file).size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  });
  const cliIdentity = identity(fixture.sidecar);
  const codexIdentity = identity(fixture.codex);
  const trustedMembers = loadInstallerProvenance(fixture.app, fixture.expected);
  const cliPublic = Buffer.from([
    "/Users/runner/hostedtoolcache/go/1.26.4/arm64",
    "/Users/runner/work/CLIProxyAPI/CLIProxyAPI/internal/home/certificate.go",
  ].join("\x00"), "latin1").toString("latin1");
  const codexPublic = "/Users/runner/.cargo/registry/src/package/src/lib.rsOTELhttp://localhost:4317";

  assert.equal(reviewedRootsForMember(cliRelative, cliIdentity, trustedMembers).length > 0, true);
  assert.equal(reviewedRootsForMember(codexRelative, codexIdentity, trustedMembers).length > 0, true);
  assert.equal(credentialMaterialKind(cliPublic, {
    relative: cliRelative, memberIdentity: cliIdentity, trustedMembers,
  }), null);
  assert.equal(credentialMaterialKind(codexPublic, {
    relative: codexRelative, memberIdentity: codexIdentity, trustedMembers,
  }), null);

  const mutatedHash = `${cliIdentity.sha256[0] === "0" ? "1" : "0"}${cliIdentity.sha256.slice(1)}`;
  assert.equal(reviewedRootsForMember(
    cliRelative,
    { ...cliIdentity, sha256: mutatedHash },
    trustedMembers,
  ).length, 0);
  assert.equal(credentialMaterialKind(cliPublic, {
    relative: cliRelative,
    memberIdentity: { ...cliIdentity, sha256: mutatedHash },
    trustedMembers,
  }), "strict");
  assert.equal(credentialMaterialKind(cliPublic, {
    relative: "Contents/Resources/Notices/copied.bin",
    memberIdentity: cliIdentity,
    trustedMembers,
  }), "strict");
  assert.equal(credentialMaterialKind(`${cliPublic}\x00/Users/private-developer/file`, {
    relative: cliRelative,
    memberIdentity: cliIdentity,
    trustedMembers,
  }), "strict");
});

test("provenance validation rejects missing edited unpinned and mutated members", async (t) => {
  const { loadInstallerProvenance } = require(auditPath);

  await t.test("missing receipt", (subtest) => {
    const fixture = provenanceFixture(subtest);
    fs.rmSync(fixture.receiptPath);
    assert.throws(
      () => loadInstallerProvenance(fixture.app, fixture.expected),
      /provenance receipt is missing/i,
    );
  });

  await t.test("wrong source pin", (subtest) => {
    const fixture = provenanceFixture(subtest, (receipt) => {
      receipt.sourcePins.cliProxyApi.sha256 = "0".repeat(64);
      return receipt;
    });
    assert.throws(
      () => loadInstallerProvenance(fixture.app, fixture.expected),
      /provenance receipt is invalid/i,
    );
  });

  await t.test("wrong member path", (subtest) => {
    const fixture = provenanceFixture(subtest, (receipt) => {
      receipt.members[0].path = "Contents/Resources/Notices/copied.bin";
      return receipt;
    });
    assert.throws(
      () => loadInstallerProvenance(fixture.app, fixture.expected),
      /provenance receipt is invalid/i,
    );
  });

  await t.test("one-byte packaged mutation", (subtest) => {
    const fixture = provenanceFixture(subtest);
    fs.appendFileSync(fixture.sidecar, Buffer.from([0xff]));
    assert.throws(
      () => loadInstallerProvenance(fixture.app, fixture.expected),
      /provenance member mismatch/i,
    );
  });

  await t.test("manifest disagreement", (subtest) => {
    const fixture = provenanceFixture(subtest);
    const entry = fixture.expected.get("Contents/Resources/CLIProxy/cli-proxy-api");
    fixture.expected.set(entry.path, { ...entry, sha256: "f".repeat(64) });
    assert.throws(
      () => loadInstallerProvenance(fixture.app, fixture.expected),
      /provenance member mismatch/i,
    );
  });
});

test("untrusted member paths never receive the public CI provenance exemption", (t) => {
  const fixture = auditFixture(t, [[
    "Resources/Notices/copied-upstream.bin",
    Buffer.from("/Users/runner/.cargo/registry/src/package/src/lib.rs\\0"),
  ]]);
  assert.throws(fixture.audit, /privacy audit.*personal absolute path/i);
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
      [
        "Resources/src/provider-descriptors.cjs",
        '"use strict";\nmodule.exports = {};\n',
      ],
    ]);
    assert.doesNotThrow(fixture.audit);
  });
  await t.test("actual User Data store", (subtest) => {
    const fixture = auditFixture(subtest, [["Resources/User Data/Preferences", "safe\n"]]);
    assert.throws(fixture.audit, /privacy audit.*state/i);
  });
});

test("release audit narrowly permits only the manifest-bound patcher keychain source filename", async (t) => {
  const keychainSource = "Resources/Patcher/src/desktop/keychain-secret-store.cjs";

  await t.test("exact regular file remains content-scanned", (subtest) => {
    const fixture = auditFixture(subtest, [[
      keychainSource,
      '"use strict";\nmodule.exports = {};\n',
    ]]);
    assert.doesNotThrow(fixture.audit);
  });

  await t.test("same basename outside the exact path remains forbidden", (subtest) => {
    const fixture = auditFixture(subtest, [[
      "Resources/Patcher/src/renderer/keychain-secret-store.cjs",
      '"use strict";\nmodule.exports = {};\n',
    ]]);
    assert.throws(fixture.audit, /privacy audit.*(?:development|credential|user-state).*keychain-secret-store/i);
  });

  await t.test("exact regular file with credential material remains forbidden", (subtest) => {
    const fixture = auditFixture(subtest, [[keychainSource, "password=huntertwo\n"]]);
    assert.throws(fixture.audit, /privacy audit.*credential material.*keychain-secret-store/i);
  });

  await t.test("exact path symlink remains forbidden", (subtest) => {
    const fixture = auditFixture(subtest, [[
      "Resources/Patcher/src/desktop/placeholder.cjs",
      "safe\n",
    ]]);
    const target = path.join(fixture.app, "Contents", ...keychainSource.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync("../../../../Info.plist", target);
    assert.throws(fixture.audit, /privacy audit.*symlink.*keychain-secret-store/i);
  });

  await t.test("exact path absent from the manifest remains forbidden", (subtest) => {
    const fixture = auditFixture(subtest, [[
      "Resources/Patcher/src/desktop/placeholder.cjs",
      "safe\n",
    ]]);
    const target = path.join(fixture.app, "Contents", ...keychainSource.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '"use strict";\nmodule.exports = {};\n');
    assert.throws(fixture.audit, /privacy audit.*unexpected installer member.*keychain-secret-store/i);
  });

  await t.test("exact path with a manifest type mismatch remains forbidden", (subtest) => {
    const fixture = auditFixture(subtest, [[keychainSource, "safe\n"]]);
    const target = path.join(fixture.app, "Contents", ...keychainSource.split("/"));
    fs.rmSync(target);
    fs.mkdirSync(target);
    assert.throws(fixture.audit, /privacy audit.*installer member type mismatch.*keychain-secret-store/i);
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

test("release audit rejects a root app symlink before traversal", (t) => {
  const { auditPayloadTree } = require(auditPath);
  const external = auditFixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-root-app-symlink-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expectedAppName = path.basename(external.app);
  fs.symlinkSync(external.app, path.join(root, expectedAppName));
  assert.throws(
    () => auditPayloadTree(root, { expectedAppName }),
    /installer app must be a real directory/i,
  );
});

test("installer preflight binds bytes and rejects an unauthorized ad-hoc signature", (t) => {
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
  assert.throws(
    () => preflightInstallerApp({
      installerApp: fixture.app,
      expectedAppName: path.basename(fixture.app),
    }),
    /authorized Developer ID|code signature verification failed/i,
  );

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
