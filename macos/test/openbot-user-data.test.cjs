"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const modulePath = path.join(__dirname, "..", "src", "desktop", "openbot-user-data.cjs");
let publisherRoot;
let publisherPath;

test.before(() => {
  publisherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-publisher-test-"));
  publisherPath = path.join(publisherRoot, "openbot-profile-publish");
  const result = childProcess.spawnSync("/usr/bin/cc", [
    "-std=c11", "-Oz", "-arch", "arm64", "-mmacosx-version-min=13.0",
    path.join(__dirname, "..", "native", "openbot-profile-publish.c"),
    "-o", publisherPath,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, "profile publisher fixture must compile");
  fs.chmodSync(publisherPath, 0o755);
});

test.after(() => {
  if (publisherRoot) fs.rmSync(publisherRoot, { recursive: true, force: true });
});

function migrationOptions(appDataPath, extra = {}) {
  return { appDataPath, publisherPath, ...extra };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-user-data-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function loadMigration() {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test("fresh OpenBot profile is private and migration receipt exposes no local path", (t) => {
  const appDataPath = fixture(t);
  const { prepareOpenBotUserData } = loadMigration();
  const receipt = prepareOpenBotUserData(migrationOptions(appDataPath));
  const target = path.join(appDataPath, "OpenBot");

  assert.equal(receipt.userDataPath, target);
  assert.equal(receipt.migrated, false);
  assert.equal(receipt.legacyRetained, false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Object.keys(receipt), ["userDataPath", "migrated", "legacyRetained"]);
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.equal(fs.statSync(target).mode & 0o077, 0);
});

test("first launch atomically copies the complete legacy profile and retains the source", (t) => {
  const appDataPath = fixture(t);
  const legacy = path.join(appDataPath, "Codex Bot");
  fs.mkdirSync(path.join(legacy, "codex-bot", "bots"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(legacy, "Partitions", "default"), { recursive: true, mode: 0o700 });
  const bots = Buffer.from('{"botId":"bot-a","provider":"openai-codex"}\n');
  const auth = Buffer.concat([Buffer.from("opaque-browser-profile-bytes"), Buffer.from([0, 1, 2])]);
  fs.writeFileSync(path.join(legacy, "codex-bot", "bots", "bots.json"), bots, { mode: 0o600 });
  fs.writeFileSync(path.join(legacy, "Partitions", "default", "state.bin"), auth, { mode: 0o600 });

  const { prepareOpenBotUserData } = loadMigration();
  const receipt = prepareOpenBotUserData(migrationOptions(appDataPath));
  const target = path.join(appDataPath, "OpenBot");

  assert.equal(receipt.migrated, true);
  assert.equal(receipt.legacyRetained, true);
  assert.deepEqual(fs.readFileSync(path.join(target, "codex-bot", "bots", "bots.json")), bots);
  assert.deepEqual(fs.readFileSync(path.join(target, "Partitions", "default", "state.bin")), auth);
  assert.deepEqual(fs.readFileSync(path.join(legacy, "Partitions", "default", "state.bin")), auth);
  assert.deepEqual(
    fs.readdirSync(appDataPath).sort(),
    ["Codex Bot", "OpenBot"],
    "the transaction must leave no sibling staging directory",
  );
});

test("an existing OpenBot profile is authoritative and is never merged or overwritten", (t) => {
  const appDataPath = fixture(t);
  const legacy = path.join(appDataPath, "Codex Bot");
  const target = path.join(appDataPath, "OpenBot");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "state"), "legacy", { mode: 0o600 });
  fs.writeFileSync(path.join(target, "state"), "openbot", { mode: 0o600 });

  const { prepareOpenBotUserData } = loadMigration();
  const receipt = prepareOpenBotUserData(migrationOptions(appDataPath));
  assert.equal(receipt.migrated, false);
  assert.equal(receipt.legacyRetained, true);
  assert.equal(fs.readFileSync(path.join(target, "state"), "utf8"), "openbot");
  assert.equal(fs.readFileSync(path.join(legacy, "state"), "utf8"), "legacy");
});

test("symlinked target, source, or nested legacy member fails closed", async (t) => {
  const { prepareOpenBotUserData } = loadMigration();
  for (const kind of ["target", "source", "nested"]) {
    await t.test(kind, () => {
      const appDataPath = fixture(t);
      const outside = path.join(appDataPath, "outside");
      fs.mkdirSync(outside, { mode: 0o700 });
      if (kind === "target") fs.symlinkSync(outside, path.join(appDataPath, "OpenBot"));
      if (kind === "source") fs.symlinkSync(outside, path.join(appDataPath, "Codex Bot"));
      if (kind === "nested") {
        fs.mkdirSync(path.join(appDataPath, "Codex Bot"), { mode: 0o700 });
        fs.symlinkSync(outside, path.join(appDataPath, "Codex Bot", "escape"));
      }
      assert.throws(() => prepareOpenBotUserData(migrationOptions(appDataPath)), (error) => {
        assert.equal(error.code, "OPENBOT_USER_DATA_MIGRATION_FAILED");
        assert.doesNotMatch(error.message, new RegExp(appDataPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
      if (kind !== "target") assert.equal(fs.existsSync(path.join(appDataPath, "OpenBot")), false);
    });
  }
});

test("copy failure removes only the exact staging tree and never launches a blank target", (t) => {
  const appDataPath = fixture(t);
  const legacy = path.join(appDataPath, "Codex Bot");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "state"), "must-survive", { mode: 0o600 });
  const { prepareOpenBotUserData } = loadMigration();
  const realFs = fs;
  const fsApi = Object.create(realFs);
  fsApi.cpSync = () => {
    const error = new Error("/Users/private/development/token copy failed");
    error.code = "EIO";
    throw error;
  };

  assert.throws(() => prepareOpenBotUserData(migrationOptions(appDataPath, { fsApi })), (error) => {
    assert.equal(error.code, "OPENBOT_USER_DATA_MIGRATION_FAILED");
    assert.equal(error.message, "OpenBot could not migrate the existing profile safely.");
    assert.doesNotMatch(JSON.stringify(error), /private|development|token|Codex Bot/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(appDataPath, "OpenBot")), false);
  assert.equal(fs.readFileSync(path.join(legacy, "state"), "utf8"), "must-survive");
  assert.deepEqual(fs.readdirSync(appDataPath), ["Codex Bot"]);
});

test("desktop production startup selects the migrated OpenBot path before dependency construction", (t) => {
  const appDataPath = fixture(t);
  const legacy = path.join(appDataPath, "Codex Bot");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "Preferences"), "legacy-preferences", { mode: 0o600 });
  const calls = [];
  const electron = {
    app: {
      getPath(name) {
        calls.push(["getPath", name]);
        assert.equal(name, "appData");
        return appDataPath;
      },
      setPath(name, value) { calls.push(["setPath", name, value]); },
    },
  };
  const runtimePath = path.join(__dirname, "..", "src", "desktop", "runtime.cjs");
  delete require.cache[require.resolve(runtimePath)];
  const { prepareProductionUserData } = require(runtimePath);
  const receipt = prepareProductionUserData(electron, publisherPath);
  const target = path.join(appDataPath, "OpenBot");
  assert.equal(receipt.userDataPath, target);
  assert.equal(receipt.migrated, true);
  assert.deepEqual(calls, [
    ["getPath", "appData"],
    ["setPath", "userData", target],
  ]);
  assert.equal(fs.readFileSync(path.join(target, "Preferences"), "utf8"), "legacy-preferences");
});

test("an exact acceptance flag isolates app data while preserving the real account home", (t) => {
  const appDataPath = fs.realpathSync(fixture(t));
  fs.chmodSync(appDataPath, 0o700);
  const calls = [];
  const electron = {
    app: {
      getPath(name) {
        calls.push(["getPath", name]);
        throw new Error("personal appData must not be read");
      },
      setPath(name, value) { calls.push(["setPath", name, value]); },
    },
  };
  const runtimePath = path.join(__dirname, "..", "src", "desktop", "runtime.cjs");
  delete require.cache[require.resolve(runtimePath)];
  const { prepareProductionUserData } = require(runtimePath);
  const accountEnvironment = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  const receipt = prepareProductionUserData(electron, publisherPath, {
    argv: ["OpenBot", `--openbot-acceptance-app-data=${appDataPath}`],
    currentUid: process.getuid(),
    fsApi: fs,
    tempDirectory: fs.realpathSync(os.tmpdir()),
  });

  assert.equal(receipt.userDataPath, path.join(appDataPath, "OpenBot"));
  assert.deepEqual(calls, [["setPath", "userData", path.join(appDataPath, "OpenBot")]]);
  assert.deepEqual({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }, accountEnvironment);
});

test("malformed acceptance app-data intent fails before personal appData fallback", async (t) => {
  const root = fs.realpathSync(fixture(t));
  fs.chmodSync(root, 0o700);
  const good = path.join(root, "good");
  const loose = path.join(root, "loose");
  const file = path.join(root, "file");
  const parent = path.join(root, "parent");
  const linkedParent = path.join(root, "linked-parent");
  fs.mkdirSync(good, { mode: 0o700 });
  fs.mkdirSync(loose, { mode: 0o755 });
  fs.writeFileSync(file, "not a directory", { mode: 0o600 });
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.mkdirSync(path.join(parent, "child"), { mode: 0o700 });
  fs.symlinkSync(parent, linkedParent);
  const outside = fs.realpathSync(process.cwd());
  const runtimePath = path.join(__dirname, "..", "src", "desktop", "runtime.cjs");
  delete require.cache[require.resolve(runtimePath)];
  const { prepareProductionUserData } = require(runtimePath);
  const invalidCases = [
    { argv: ["OpenBot", "--openbot-acceptance-app-data"], currentUid: process.getuid() },
    { argv: ["OpenBot", "--openbot-acceptance-app-data="], currentUid: process.getuid() },
    { argv: ["OpenBot", "--openbot-acceptance-app-data=relative"], currentUid: process.getuid() },
    { argv: ["OpenBot", `--openbot-acceptance-app-data=${outside}`], currentUid: process.getuid() },
    { argv: ["OpenBot", `--openbot-acceptance-app-data=${file}`], currentUid: process.getuid() },
    { argv: ["OpenBot", `--openbot-acceptance-app-data=${loose}`], currentUid: process.getuid() },
    { argv: ["OpenBot", `--openbot-acceptance-app-data=${linkedParent}/child`], currentUid: process.getuid() },
    { argv: ["OpenBot", `--openbot-acceptance-app-data=${good}`, `--openbot-acceptance-app-data=${good}`], currentUid: process.getuid() },
    { argv: ["OpenBot", `--openbot-acceptance-app-data=${good}`], currentUid: process.getuid() + 1 },
  ];
  const overriddenIntentScan = ["OpenBot", `--openbot-acceptance-app-data=${good}`];
  Object.defineProperty(overriddenIntentScan, "some", {
    configurable: false,
    enumerable: false,
    value: () => false,
    writable: false,
  });
  invalidCases.push({ argv: overriddenIntentScan, currentUid: process.getuid() });

  for (const invalid of invalidCases) {
    await t.test(invalid.argv.join(" "), () => {
      let appDataReads = 0;
      const electron = {
        app: {
          getPath() { appDataReads += 1; return root; },
          setPath() { throw new Error("invalid acceptance path must not be selected"); },
        },
      };
      assert.throws(() => prepareProductionUserData(electron, publisherPath, {
        ...invalid,
        fsApi: fs,
        tempDirectory: fs.realpathSync(os.tmpdir()),
      }), { code: "OPENBOT_USER_DATA_MIGRATION_FAILED" });
      assert.equal(appDataReads, 0);
    });
  }
});

test("a file replaced by a symlink between inspection and copy can never cross into OpenBot", (t) => {
  const appDataPath = fixture(t);
  const legacy = path.join(appDataPath, "Codex Bot");
  const outside = path.join(appDataPath, "outside-private");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "state"), "reviewed-state", { mode: 0o600 });
  fs.writeFileSync(outside, "outside-private-bytes", { mode: 0o600 });
  const fsApi = Object.create(fs);
  let attacked = false;
  const attack = () => {
    if (attacked) return;
    attacked = true;
    fs.renameSync(path.join(legacy, "state"), path.join(legacy, "state.before-race"));
    fs.symlinkSync(outside, path.join(legacy, "state"));
  };
  fsApi.copyFileSync = (...args) => { attack(); return fs.copyFileSync(...args); };
  fsApi.cpSync = (...args) => { attack(); return fs.cpSync(...args); };
  const { prepareOpenBotUserData } = loadMigration();

  assert.throws(() => prepareOpenBotUserData(migrationOptions(appDataPath, { fsApi })), {
    code: "OPENBOT_USER_DATA_MIGRATION_FAILED",
  });
  assert.equal(fs.existsSync(path.join(appDataPath, "OpenBot")), false);
});

test("dangling legacy and target links are unsafe, never absent", async (t) => {
  const { prepareOpenBotUserData } = loadMigration();
  for (const name of ["Codex Bot", "OpenBot"]) {
    await t.test(name, () => {
      const appDataPath = fixture(t);
      fs.symlinkSync(path.join(appDataPath, "missing"), path.join(appDataPath, name));
      assert.throws(() => prepareOpenBotUserData(migrationOptions(appDataPath)), {
        code: "OPENBOT_USER_DATA_MIGRATION_FAILED",
      });
      if (name === "Codex Bot") assert.equal(fs.existsSync(path.join(appDataPath, "OpenBot")), false);
    });
  }
});

test("migration refuses a mixed snapshot when legacy state changes during copy", (t) => {
  const appDataPath = fixture(t);
  const legacy = path.join(appDataPath, "Codex Bot");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "a"), "old", { mode: 0o600 });
  fs.writeFileSync(path.join(legacy, "b"), "old", { mode: 0o600 });
  const fsApi = Object.create(fs);
  let copied = 0;
  fsApi.copyFileSync = (...args) => {
    fs.copyFileSync(...args);
    copied += 1;
    if (copied === 1) {
      fs.writeFileSync(path.join(legacy, "a"), "new", { mode: 0o600 });
      fs.writeFileSync(path.join(legacy, "b"), "new", { mode: 0o600 });
    }
  };
  fsApi.cpSync = (...args) => {
    fs.cpSync(...args);
    fs.writeFileSync(path.join(legacy, "a"), "new", { mode: 0o600 });
    fs.writeFileSync(path.join(legacy, "b"), "new", { mode: 0o600 });
  };
  const { prepareOpenBotUserData } = loadMigration();

  assert.throws(() => prepareOpenBotUserData(migrationOptions(appDataPath, { fsApi })), {
    code: "OPENBOT_USER_DATA_MIGRATION_FAILED",
  });
  assert.equal(fs.existsSync(path.join(appDataPath, "OpenBot")), false);
});

test("exclusive publication cannot overwrite a concurrently created OpenBot profile", (t) => {
  const appDataPath = fixture(t);
  const legacy = path.join(appDataPath, "Codex Bot");
  const target = path.join(appDataPath, "OpenBot");
  fs.mkdirSync(legacy, { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "state"), "legacy", { mode: 0o600 });
  const fsApi = Object.create(fs);
  fsApi.renameSync = (source, destination) => {
    fs.mkdirSync(destination, { mode: 0o700 });
    return fs.renameSync(source, destination);
  };
  fsApi.renameExclusiveSync = () => {
    fs.mkdirSync(target, { mode: 0o700 });
    const error = new Error("exists");
    error.code = "EEXIST";
    throw error;
  };
  const { prepareOpenBotUserData } = loadMigration();

  assert.throws(() => prepareOpenBotUserData(migrationOptions(appDataPath, { fsApi })), {
    code: "OPENBOT_USER_DATA_MIGRATION_FAILED",
  });
  assert.equal(fs.lstatSync(target).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(target, "state")), false);
});

test("the compiled native publisher preserves both trees when the target already exists", (t) => {
  const root = fixture(t);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "state"), "source", { mode: 0o600 });
  fs.writeFileSync(path.join(target, "state"), "target", { mode: 0o600 });

  const result = childProcess.spawnSync(publisherPath, [source, target], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 3);
  assert.equal(fs.readFileSync(path.join(source, "state"), "utf8"), "source");
  assert.equal(fs.readFileSync(path.join(target, "state"), "utf8"), "target");
  const architecture = childProcess.spawnSync("/usr/bin/lipo", ["-archs", publisherPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(architecture.status, 0);
  assert.equal(architecture.stdout.trim(), "arm64");
});
