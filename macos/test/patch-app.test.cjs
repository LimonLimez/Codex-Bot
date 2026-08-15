"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");

const macRoot = path.resolve(__dirname, "..");
const patcherPath = path.join(macRoot, "scripts", "patch-app.cjs");
const anchorsPath = path.join(macRoot, "src", "patch", "anchors.cjs");

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function ownedTemp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bot-mac-patch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function patchTemps() {
  return new Set(
    fs
      .readdirSync(os.tmpdir())
      .filter((entry) => entry.startsWith("codex-bot-mac-patch-")),
  );
}

async function syntheticAsar(t, overrides = {}) {
  const root = ownedTemp(t);
  const tree = path.join(root, "tree");
  const source = path.join(root, "source.asar");
  fs.mkdirSync(path.join(tree, "dist", "electron-preload"), { recursive: true });
  fs.mkdirSync(path.join(tree, "dist", "electron-main"), { recursive: true });
  fs.mkdirSync(path.join(tree, "dist", "host"), { recursive: true });
  fs.mkdirSync(path.join(tree, "dist", "native"), { recursive: true });
  fs.mkdirSync(path.join(tree, "dist", "renderer"), { recursive: true });
  fs.writeFileSync(
    path.join(tree, "package.json"),
    `${JSON.stringify(
      {
        name: "sand",
        productName: "Grok Bot",
        version: overrides.version ?? "0.20.0",
        description: "Grok Bot desktop agent",
        author: "SpaceXAI",
        homepage: "https://cursor.com",
        main: "dist/electron-main/main.cjs",
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(tree, "dist", "electron-preload", "preload.cjs"),
    'const stock="kept";s.contextBridge.exposeInMainWorld("desktop",Q);s.contextBridge.exposeInMainWorld("coordinatorPort",X);s.ipcRenderer.on("sand:coordinator-port",e=>{});\n',
  );
  fs.writeFileSync(
    path.join(tree, "dist", "electron-main", "main.cjs"),
    'const setup="kept";\n"use strict";var fjn=Object.create;const stockFeature="kept";\n',
  );
  fs.writeFileSync(
    path.join(tree, "dist", "host", "host-main.cjs"),
    '"use strict";function E4i(t){let e,n=qdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId});return{resolvePrivacyMode:()=>Jdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),createSession(o,s){return Qdi({getAccessToken:t.getAccessToken,onRequestId:o})},recordPostTurnLabeling(o){}}}function T4i(t){return E4i(t)}ye={modelId:t.subagentModelId,inferenceReason:t.subagentType};t.inference.createSession(pn=>{t.emitUpdate({type:"request-id",requestId:pn})},{modelId:dXt,isSummarizationSession:!0);var b4i={start:t=>{let e=new Set,n=t.deps.auth;return{isReady:async()=>process.env.SAND_AGENT_MOCK_RESPONSE!=null||n.peekAccessToken()!==null,port:T4i(t)}}};\n',
  );
  fs.writeFileSync(
    path.join(tree, "dist", "renderer", "index.html"),
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Grok Bot</title>\n    <script type="module" crossorigin src="./assets/index-CphCyQnY.js"></script>\n    <link rel="stylesheet" crossorigin href="./assets/index-DTIy1z2L.css">\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n',
  );
  const nativeBytes = Buffer.from("synthetic native helper\n");
  const nativePath = path.join(tree, "dist", "native", "sand-helper");
  fs.writeFileSync(nativePath, nativeBytes, { mode: 0o755 });
  await asar.createPackageWithOptions(tree, source, {
    unpackDir: "{dist/native}",
  });
  return { root, tree, source, nativeBytes };
}

function loadPatcher() {
  delete require.cache[require.resolve(patcherPath)];
  return require(patcherPath);
}

test("the patch engine rebrands an exact ASAR and preserves stock/unpacked bytes", async (t) => {
  const fixture = await syntheticAsar(t);
  const target = path.join(fixture.root, "target.asar");
  const sourceHash = sha256File(fixture.source);
  const sourceBefore = fs.readFileSync(fixture.source);
  const tempBefore = patchTemps();
  const { patchAsar } = loadPatcher();
  const receipt = await patchAsar({
    sourceAsar: fixture.source,
    targetAsar: target,
    expectedSourceHash: sourceHash,
  });
  assert.deepEqual(
    {
      ok: receipt.ok,
      sourceSha256: receipt.sourceSha256,
      targetSha256: receipt.targetSha256,
      vendorVersion: receipt.vendorVersion,
      releaseVersion: receipt.releaseVersion,
      mutations: receipt.mutations,
    },
    {
      ok: true,
      sourceSha256: sourceHash,
      targetSha256: sha256File(target),
      vendorVersion: "0.20.0",
      releaseVersion: "0.1.4-macos.1",
      mutations: [
        "dist/codex/bots/bot-store.cjs",
        "dist/codex/bots/chatgpt-relay-codec.cjs",
        "dist/codex/bots/conversation-router.cjs",
        "dist/codex/bots/remote-app-server-client.cjs",
        "dist/codex/bots/runtime-controller.cjs",
        "dist/codex/bots/runtime-provider.cjs",
        "dist/codex/bridge/codex-client.cjs",
        "dist/codex/bridge/message-codec.cjs",
        "dist/codex/bridge/redaction.cjs",
        "dist/codex/bridge/runtime-config.cjs",
        "dist/codex/bridge/server.cjs",
        "dist/codex/desktop/cliproxy-manager.cjs",
        "dist/codex/desktop/model-selection-store.cjs",
        "dist/codex/desktop/runtime.cjs",
        "dist/codex/node_modules/ws/LICENSE",
        "dist/codex/node_modules/ws/README.md",
        "dist/codex/node_modules/ws/browser.js",
        "dist/codex/node_modules/ws/index.js",
        "dist/codex/node_modules/ws/lib/buffer-util.js",
        "dist/codex/node_modules/ws/lib/constants.js",
        "dist/codex/node_modules/ws/lib/event-target.js",
        "dist/codex/node_modules/ws/lib/extension.js",
        "dist/codex/node_modules/ws/lib/limiter.js",
        "dist/codex/node_modules/ws/lib/permessage-deflate.js",
        "dist/codex/node_modules/ws/lib/receiver.js",
        "dist/codex/node_modules/ws/lib/sender.js",
        "dist/codex/node_modules/ws/lib/stream.js",
        "dist/codex/node_modules/ws/lib/subprotocol.js",
        "dist/codex/node_modules/ws/lib/validation.js",
        "dist/codex/node_modules/ws/lib/websocket-server.js",
        "dist/codex/node_modules/ws/lib/websocket.js",
        "dist/codex/node_modules/ws/package.json",
        "dist/codex/node_modules/ws/wrapper.mjs",
        "dist/electron-main/main.cjs",
        "dist/electron-preload/preload.cjs",
        "dist/host/host-main.cjs",
        "dist/renderer/codex/bot-runtime-ui.js",
        "dist/renderer/codex/codex-ui.css",
        "dist/renderer/codex/model-controls.js",
        "dist/renderer/codex/reasoning-control.js",
        "dist/renderer/index.html",
        "package.json",
      ],
    },
  );
  assert.notEqual(receipt.targetSha256, sourceHash);
  assert.deepEqual(fs.readFileSync(fixture.source), sourceBefore);

  const extracted = path.join(fixture.root, "extracted");
  fs.mkdirSync(extracted);
  asar.extractAll(target, extracted);
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(extracted, "package.json"), "utf8"),
  );
  assert.deepEqual(
    {
      name: packageJson.name,
      productName: packageJson.productName,
      version: packageJson.version,
      description: packageJson.description,
      author: packageJson.author,
      homepage: packageJson.homepage,
      codexBot: packageJson.codexBot,
    },
    {
      name: "sand",
      productName: "Codex Bot",
      version: "0.1.4-macos.1",
      description: "Codex Bot desktop agent",
      author: "SpaceXAI",
      homepage: "https://github.com/LimonLimez/Codex-Bot",
      codexBot: {
        platform: "darwin-arm64",
        vendorProduct: "Grok Bot",
        vendorVersion: "0.20.0",
        vendorAppAsarSha256: sourceHash,
      },
    },
  );
  const patchedPreload = fs.readFileSync(
    path.join(extracted, "dist", "electron-preload", "preload.cjs"),
    "utf8",
  );
  assert.match(patchedPreload, /stock="kept"/);
  assert.match(patchedPreload, /exposeInMainWorld\("desktop",Q\)/);
  assert.match(patchedPreload, /exposeInMainWorld\("codexBots"/);
  assert.match(patchedPreload, /exposeInMainWorld\("codexRuntime"/);
  const patchedMain = fs.readFileSync(
    path.join(extracted, "dist", "electron-main", "main.cjs"),
    "utf8",
  );
  assert.match(patchedMain, /stockFeature="kept"/);
  assert.match(patchedMain, /codex\/desktop\/runtime\.cjs/);
  for (const relative of [
    "desktop/runtime.cjs",
    "desktop/model-selection-store.cjs",
    "bots/bot-store.cjs",
    "bots/runtime-controller.cjs",
    "bots/runtime-provider.cjs",
    "bots/remote-app-server-client.cjs",
    "bots/conversation-router.cjs",
    "bots/chatgpt-relay-codec.cjs",
  ]) {
    assert.equal(fs.lstatSync(path.join(extracted, "dist", "codex", relative)).isFile(), true);
  }
  const remoteClientPath = path.join(
    extracted,
    "dist",
    "codex",
    "bots",
    "remote-app-server-client.cjs",
  );
  delete require.cache[require.resolve(remoteClientPath)];
  const remoteClient = require(remoteClientPath);
  assert.equal(typeof remoteClient.RemoteAppServerClient, "function");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(extracted, "dist", "codex", "node_modules", "ws", "package.json"), "utf8")).version,
    "8.21.3",
  );
  const patchedHost = fs.readFileSync(
    path.join(extracted, "dist", "host", "host-main.cjs"),
    "utf8",
  );
  assert.match(patchedHost, /process\.env\.CODEX_BOT_BRIDGE/);
  assert.match(patchedHost, /createPromptSession/);
  assert.doesNotMatch(
    patchedHost.slice(
      patchedHost.indexOf("function E4i(t){"),
      patchedHost.indexOf("function T4i(t){"),
    ),
    /getAccessToken|SAND_AGENT_MOCK_RESPONSE|Qdi\(/,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(`${target}.unpacked`, "dist", "native", "sand-helper"),
    ),
    fixture.nativeBytes,
  );
  assert.equal(
    fs.statSync(path.join(`${target}.unpacked`, "dist", "native", "sand-helper")).mode &
      0o111,
    0o111,
  );
  assert.deepEqual(patchTemps(), tempBefore);
});

test("the patch engine fails before output for unsupported or unsafe targets", async (t) => {
  const { patchAsar } = loadPatcher();

  await t.test("wrong source hash", async (subtest) => {
    const fixture = await syntheticAsar(subtest);
    const target = path.join(fixture.root, "target.asar");
    await assert.rejects(
      patchAsar({
        sourceAsar: fixture.source,
        targetAsar: target,
        expectedSourceHash: "0".repeat(64),
      }),
      /unsupported.*app\.asar|hash/i,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(`${target}.unpacked`), false);
  });

  await t.test("wrong vendor version", async (subtest) => {
    const fixture = await syntheticAsar(subtest, { version: "0.18.0" });
    const target = path.join(fixture.root, "target.asar");
    await assert.rejects(
      patchAsar({
        sourceAsar: fixture.source,
        targetAsar: target,
        expectedSourceHash: sha256File(fixture.source),
      }),
      /version|0\.20\.0/i,
    );
    assert.equal(fs.existsSync(target), false);
  });

  await t.test("existing output", async (subtest) => {
    const fixture = await syntheticAsar(subtest);
    const target = path.join(fixture.root, "target.asar");
    fs.writeFileSync(target, "owned output\n");
    await assert.rejects(
      patchAsar({
        sourceAsar: fixture.source,
        targetAsar: target,
        expectedSourceHash: sha256File(fixture.source),
      }),
      /already exists|target/i,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "owned output\n");
  });

  await t.test("source equals target", async (subtest) => {
    const fixture = await syntheticAsar(subtest);
    await assert.rejects(
      patchAsar({
        sourceAsar: fixture.source,
        targetAsar: fixture.source,
        expectedSourceHash: sha256File(fixture.source),
      }),
      /source.*target|target.*source/i,
    );
  });

  await t.test("symlinked source", async (subtest) => {
    const fixture = await syntheticAsar(subtest);
    const sourceLink = path.join(fixture.root, "source-link.asar");
    const target = path.join(fixture.root, "target.asar");
    fs.symlinkSync(path.basename(fixture.source), sourceLink);
    await assert.rejects(
      patchAsar({
        sourceAsar: sourceLink,
        targetAsar: target,
        expectedSourceHash: sha256File(fixture.source),
      }),
      /source.*real|source.*symlink/i,
    );
    assert.equal(fs.existsSync(target), false);
  });

  await t.test("symlinked target parent", async (subtest) => {
    const fixture = await syntheticAsar(subtest);
    const realParent = path.join(fixture.root, "real-target");
    const linkedParent = path.join(fixture.root, "linked-target");
    fs.mkdirSync(realParent);
    fs.symlinkSync(path.basename(realParent), linkedParent);
    const target = path.join(linkedParent, "target.asar");
    await assert.rejects(
      patchAsar({
        sourceAsar: fixture.source,
        targetAsar: target,
        expectedSourceHash: sha256File(fixture.source),
      }),
      /target parent.*real|target parent.*symlink/i,
    );
    assert.equal(fs.existsSync(path.join(realParent, "target.asar")), false);
  });
});

test("patch anchors require one and only one reviewed source region", () => {
  const { replaceUnique } = require(anchorsPath);
  assert.equal(
    replaceUnique("before STOCK after", "STOCK", "CODEX", "identity"),
    "before CODEX after",
  );
  assert.throws(
    () => replaceUnique("before after", "STOCK", "CODEX", "identity"),
    /not found.*identity|identity.*not found/i,
  );
  assert.throws(
    () => replaceUnique("STOCK and STOCK", "STOCK", "CODEX", "identity"),
    /ambiguous.*identity|identity.*ambiguous/i,
  );
});
