"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const verifierPath = path.join(macRoot, "scripts", "verify-vendor-app.cjs");
const manifestPath = path.join(
  macRoot,
  "assets",
  "grok-bot-0.20.0-darwin-arm64.manifest.json",
);

const expectedIdentity = Object.freeze({
  bundleIdentifier: "com.anysphere.sand",
  bundleVersion: "0.20.0",
  architecture: "arm64",
  signer: "Developer ID Application: Anysphere Incorporated (DCNK4UB866)",
  teamIdentifier: "DCNK4UB866",
  cdHash: "b6086bbb8fee0954c596997c2f20630be79d8417",
  notarized: true,
});

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-mac-vendor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "Grok Bot.app");
  const files = new Map([
    ["Contents/Info.plist", Buffer.from("fixture plist\n")],
    ["Contents/MacOS/Grok Bot", Buffer.from("fixture executable\n")],
    ["Contents/Resources/app.asar", Buffer.from("fixture asar\n")],
    ["Contents/Frameworks/Versions/A/marker", Buffer.from("framework\n")],
  ]);
  for (const [relative, contents] of files) {
    const target = path.join(app, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  fs.symlinkSync(
    "Versions/A",
    path.join(app, "Contents", "Frameworks", "Current"),
  );
  const entries = [...files]
    .map(([relative, contents]) => ({
      path: relative,
      type: "file",
      bytes: contents.length,
      sha256: sha256(contents),
    }))
    .concat({
      path: "Contents/Frameworks/Current",
      type: "symlink",
      target: "Versions/A",
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    product: "Grok Bot",
    version: "0.20.0",
    platform: "darwin-arm64",
    artifact: {
      url: "https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.20.0/Grok_Bot_0.20.0.dmg",
      bytes: 151151794,
      sha256:
        "73dfc1656a0e122a9a98bdcf1f49da5ec5475e156977c8730d207bfe01281a42",
    },
    identity: { ...expectedIdentity },
    files: entries,
  };
  return { root, app, manifest };
}

function loadVerifier() {
  delete require.cache[require.resolve(verifierPath)];
  return require(verifierPath);
}

test("the canonical Grok Bot 0.20 macOS manifest is complete and path-clean", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(
    {
      schemaVersion: manifest.schemaVersion,
      product: manifest.product,
      version: manifest.version,
      platform: manifest.platform,
    },
    {
      schemaVersion: 1,
      product: "Grok Bot",
      version: "0.20.0",
      platform: "darwin-arm64",
    },
  );
  assert.deepEqual(manifest.artifact, {
    url: "https://downloads.cursor.com/grokbot/stable/darwin-arm64/0.20.0/Grok_Bot_0.20.0.dmg",
    bytes: 151151794,
    sha256:
      "73dfc1656a0e122a9a98bdcf1f49da5ec5475e156977c8730d207bfe01281a42",
  });
  assert.deepEqual(manifest.identity, expectedIdentity);
  assert.ok(manifest.files.length > 500, manifest.files.length);
  const relativePaths = manifest.files.map((entry) => entry.path);
  assert.deepEqual(relativePaths, [...relativePaths].sort());
  assert.equal(new Set(relativePaths).size, relativePaths.length);
  assert.equal(
    new Set(relativePaths.map((relative) => relative.toLowerCase())).size,
    relativePaths.length,
  );
  for (const entry of manifest.files) {
    assert.match(entry.path, /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\0]+$/);
    assert.doesNotMatch(entry.path, /\/Users\/|\/private\/tmp\/|Volumes\//);
    if (entry.type === "file") {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
      assert.equal(Object.hasOwn(entry, "target"), false);
    } else {
      assert.equal(entry.type, "symlink");
      assert.equal(typeof entry.target, "string");
      assert.doesNotMatch(entry.target, /^(?:\/|~)|\0/);
    }
  }
  const asar = manifest.files.find(
    (entry) => entry.path === "Contents/Resources/app.asar",
  );
  assert.equal(
    asar?.sha256,
    "1e41f9da52be5d2ff24892b150a74d3d0145659cf6cbd83e9476d025865fb997",
  );
});

test("the verifier accepts only an exact tree and authoritative identity", async (t) => {
  const { verifyVendorApp } = loadVerifier();
  const exact = fixture(t);
  const result = await verifyVendorApp({
    appPath: exact.app,
    manifest: exact.manifest,
    probeIdentity: async () => ({ ...expectedIdentity }),
  });
  assert.deepEqual(result, {
    ok: true,
    product: "Grok Bot",
    version: "0.20.0",
    platform: "darwin-arm64",
    files: exact.manifest.files.length,
    appAsarSha256: exact.manifest.files.find(
      (entry) => entry.path === "Contents/Resources/app.asar",
    ).sha256,
  });

  const mutations = [
    ["missing file", ({ app }) => fs.rmSync(path.join(app, "Contents/Info.plist")), /missing/i],
    [
      "extra file",
      ({ app }) => fs.writeFileSync(path.join(app, "poison.dylib"), "poison\n"),
      /unexpected/i,
    ],
    [
      "changed file",
      ({ app }) => fs.appendFileSync(path.join(app, "Contents/Resources/app.asar"), "changed\n"),
      /hash|size/i,
    ],
    [
      "changed symlink",
      ({ app }) => {
        const link = path.join(app, "Contents/Frameworks/Current");
        fs.unlinkSync(link);
        fs.symlinkSync("Versions/B", link);
      },
      /symlink/i,
    ],
  ];
  for (const [name, mutate, expected] of mutations) {
    await t.test(name, async (subtest) => {
      const changed = fixture(subtest);
      mutate(changed);
      await assert.rejects(
        verifyVendorApp({
          appPath: changed.app,
          manifest: changed.manifest,
          probeIdentity: async () => ({ ...expectedIdentity }),
        }),
        expected,
      );
    });
  }

  for (const field of Object.keys(expectedIdentity)) {
    await t.test(`identity mismatch: ${field}`, async (subtest) => {
      const changed = fixture(subtest);
      const identity = {
        ...expectedIdentity,
        [field]: field === "notarized" ? false : `wrong-${field}`,
      };
      await assert.rejects(
        verifyVendorApp({
          appPath: changed.app,
          manifest: changed.manifest,
          probeIdentity: async () => identity,
        }),
        /identity|notar|sign|architecture|bundle|CDHash/i,
      );
    });
  }
});

test("the verifier rejects unsafe manifest and filesystem paths before probing", async (t) => {
  const { validateManifest, verifyVendorApp } = loadVerifier();
  for (const unsafe of [
    "/absolute",
    "../outside",
    "Contents/../outside",
    "Contents\\Resources\\app.asar",
    "Contents/\0secret",
  ]) {
    const changed = fixture(t);
    changed.manifest.files[0] = {
      path: unsafe,
      type: "file",
      bytes: 1,
      sha256: "0".repeat(64),
    };
    assert.throws(() => validateManifest(changed.manifest), /path/i, unsafe);
  }

  const escaped = fixture(t);
  const link = path.join(escaped.app, "Contents", "Frameworks", "Current");
  fs.unlinkSync(link);
  fs.symlinkSync("../../../../outside", link);
  escaped.manifest.files.find(
    (entry) => entry.path === "Contents/Frameworks/Current",
  ).target = "../../../../outside";
  let probed = false;
  await assert.rejects(
    verifyVendorApp({
      appPath: escaped.app,
      manifest: escaped.manifest,
      probeIdentity: async () => {
        probed = true;
        return { ...expectedIdentity };
      },
    }),
    /symlink|outside|target/i,
  );
  assert.equal(probed, false);
});

test(
  "the exact mounted vendor app passes the checked-in manifest",
  { skip: process.env.GROK_BOT_020_APP == null },
  async () => {
    const { verifyVendorApp } = loadVerifier();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const result = await verifyVendorApp({
      appPath: process.env.GROK_BOT_020_APP,
      manifest,
    });
    assert.equal(result.ok, true);
    assert.equal(result.version, "0.20.0");
    assert.equal(result.files, manifest.files.length);
  },
);
