"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const patchPath = path.join(macRoot, "src", "patch", "renderer.cjs");
const cssPath = path.join(macRoot, "src", "renderer", "codex-ui.css");
const botUiPath = path.join(macRoot, "src", "renderer", "bot-runtime-ui.js");
const visualRuntimePath = path.join(macRoot, "test", "visual", "renderer-panel-runtime.cjs");
const visualFixturePath = path.join(macRoot, "test", "fixtures", "renderer-panel.html");

const STOCK_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Grok Bot</title>
    <script type="module" crossorigin src="./assets/index-CphCyQnY.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-DTIy1z2L.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const STOCK_NATIVE_SHELL_GATE = 'function MHn(){const n=wLt(),{phase:e,onboardingRunId:t,completeOnboarding:s}=RFn();return n?p.jsxs(p.Fragment,{children:[p.jsx(Upe,{}),p.jsx(ggt,{})]}):e==="checking"?null:p.jsx(TDn,{chrome:JHn,children:e==="onboarding"?p.jsx(qFn,{onComplete:s,presentation:KUn},t):p.jsx(BHn,{})})}';
const STOCK_SEND_JOURNAL_DEFINITION = 'const Bgt={slice:"send-journal",schemaVersion:2,scope:"client-persisted",accountSensitive:!0}';
const STOCK_SEND_JOURNAL_PERSIST_GATE = 'L=()=>{if(S==null)return Promise.resolve($Ke);';
const STOCK_SEND_JOURNAL_RESTORE_GATE = 'restore:async he=>{if(S=he,E||he==null)return;';
const STOCK_COORDINATOR_FACTORY = 'const Whe=VKn({portBridge:HKn()}),UPe=wKn()';
const STOCK_RECONNECT_GATE = 'bt=()=>{if(!(Ge||t.get().status!=="ready"||s==null)){';
const STOCK_FOCUS_GATE = 'mt=()=>{if(Ge||t.get().status!=="ready"||s==null)return;';
const STOCK_COMPOSER_ACCOUNT_GATE = ':s?f!=null?W._(mbn(f)):i.length>0?U({id:"I/1BxG"}):C??W._(dht):U({id:"622+sP"})';
const STOCK_PROMPT_TRAILING = 'se=p.jsx("div",{className:ne,ref:d,style:X.style,children:Q})';
const STOCK_NEW_BOT_RECIPIENT = 'function q2e(n){return n.kind==="agent"?{kind:"agent",id:n.agent.id,name:n.agent.name,avatarDataUrl:n.agent.avatarDataUrl}:{kind:"new",name:n.kind==="create"?n.name:Jut}}';
const STOCK_NEW_BOT_COMMIT = 'he=x.useCallback(Ee=>{if(Ee.type==="noop")return;const Me=Ie(),Ae=Me.prompt.trim().length>0||Me.attachmentPaths.length>0;if(S(),r(),Ee.type==="single"){if(Ee.recipient.kind==="new"){Ae?Ne(Ee.recipient.name,Me):Te(Ee.recipient,"");return}Ae&&ve(Ee.recipient.id,Me),t(Ee.recipient.id);return}xe(Ee.recipients,"",[],Ae?Me:void 0)},[Ie,S,r,Ne,Te,xe,ve,t]';
const STOCK_BOT_SETTINGS_ROOT = 'let q;return e[43]!==j||e[44]!==B?(q=p.jsxs("div",{className:m,children:[j,B]}),e[43]=j,e[44]=B,e[45]=q):q=e[45],q}';
const STOCK_SETTINGS_ROOT = 'let h;return e[13]!==o?(h=t.jsxs("div",{className:d,children:[o,f,m,r,u,c]}),e[13]=o,e[14]=h):h=e[14],h}';
const STOCK_ROSTER_CONNECT_GATE = 'Ve!=null&&F.connect()';
const STOCK_ACCOUNT_SCOPED_CONNECT_GATE = 'for(const it of Ee)(Ve!=null||!Me.has(it))&&it.connect?.()';
const STOCK_POST_RESTORE_GATE = 'Ve!=null&&(B.loadPinnedAgentsFromBox(),q.loadFromBox(),ke.reconcileWithHost())';
const STOCK_IDENTITY_PORT_GATE = 'onIdentityRestoreComplete:({accountSlot:n})=>Whe.completeIdentityChange({acceptPort:n!=null})';
const STOCK_CURSOR_IDENTITY = 'resolveAccountSlot:()=>jHn(()=>fm.getCursorAuthStatus())';
const STOCK_ACCOUNT_SLOT_GETTER = 'get accountSlot(){return s}';
const STOCK_CLIENT_RESTORE = 'if(await j.write({accountSlot:null,value:Ve}),!Ye()||(await B.restore(Ve),!Ye())||(await q.restore(Ve),!Ye())||(await K.restore(Ve),!Ye())||(await F.restore(Ve),!Ye())||(await ne.restore(Ve),!Ye())||(await Z.restore(Ve),!Ye())||(await ke.restore(Ve),!Ye()))return;';
const STOCK_AUTH_OBSERVER = 'function Nt($e){if($e.kind==="logging-in"||!Je||Ge)return;const Ye=bde($e);$e.kind==="logged-in"&&Ye==null||t.get().status==="ready"&&Ye===s||(n.onIdentityRestoreBegin?.(),ot={assertedSlot:Ye},xt())}';
const SYNTHETIC_VENDOR_RENDERER = [
  'const before=p.jsx(DHn,{children:"kept"});',
  STOCK_NATIVE_SHELL_GATE,
  STOCK_SEND_JOURNAL_DEFINITION,
  STOCK_SEND_JOURNAL_PERSIST_GATE,
  'o.write({accountSlot:S,value:P()})};',
  STOCK_SEND_JOURNAL_RESTORE_GATE,
  'o.read(he)};',
  STOCK_COORDINATOR_FACTORY,
  STOCK_CURSOR_IDENTITY,
  STOCK_RECONNECT_GATE,
  'F.noteReconnect()}};',
  STOCK_FOCUS_GATE,
  'F.noteWindowFocus()};',
  STOCK_COMPOSER_ACCOUNT_GATE,
  STOCK_PROMPT_TRAILING,
  STOCK_NEW_BOT_RECIPIENT,
  STOCK_NEW_BOT_COMMIT,
  STOCK_BOT_SETTINGS_ROOT,
  STOCK_CLIENT_RESTORE,
  STOCK_ROSTER_CONNECT_GATE,
  STOCK_ACCOUNT_SCOPED_CONNECT_GATE,
  STOCK_POST_RESTORE_GATE,
  STOCK_ACCOUNT_SLOT_GETTER,
  STOCK_AUTH_OBSERVER,
  STOCK_IDENTITY_PORT_GATE,
  'const after="kept";',
].join("");

function sha256Text(source) {
  return crypto.createHash("sha256").update(source, "utf8").digest("hex");
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-renderer-patch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSyntheticRendererTree(root, {
  index = STOCK_INDEX,
  asset = SYNTHETIC_VENDOR_RENDERER,
  settingsAsset = STOCK_SETTINGS_ROOT,
} = {}) {
  fs.mkdirSync(path.join(root, "dist", "renderer", "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "renderer", "index.html"), index);
  if (asset !== null) {
    fs.writeFileSync(
      path.join(root, "dist", "renderer", "assets", "index-CphCyQnY.js"),
      asset,
    );
  }
  if (settingsAsset !== null) {
    fs.writeFileSync(
      path.join(root, "dist", "renderer", "assets", "index-d9mfdYoh.js"),
      settingsAsset,
    );
  }
}

test("the explicit local protocol bypasses only the native onboarding child", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );
  assert.equal(patched.startsWith('const before=p.jsx(DHn,{children:"kept"});function MHn(){'), true);
  assert.equal(patched.endsWith('const after="kept";'), true);
  assert.match(patched, /function MHn\(\)\{const n=wLt\(\),\{phase:e,onboardingRunId:t,completeOnboarding:s\}=RFn\(\);return n\?p\.jsxs/);
  assert.match(patched, /:e==="checking"\?null:p\.jsx\(TDn,\{chrome:JHn,children:/);
  assert.match(
    patched,
    /children:e==="onboarding"&&!\(window\.openbotProtocol\?\.schemaVersion===1&&window\.openbotProtocol\?\.mode==="local-protocol"\)\?p\.jsx\(qFn,\{onComplete:s,presentation:KUn\},t\):p\.jsx\(BHn,\{\}\)/,
  );
  for (const preserved of ["DHn", "wLt()", "RFn()", 'e==="checking"', "TDn", "JHn", "BHn"]) {
    assert.equal(
      (patched.match(new RegExp(preserved.replace(/[()]/g, "\\$&"), "g")) ?? []).length,
      (SYNTHETIC_VENDOR_RENDERER.match(new RegExp(preserved.replace(/[()]/g, "\\$&"), "g")) ?? []).length,
      preserved,
    );
  }
  assert.equal((patched.match(/mode==="local-protocol"/g) ?? []).length, 2);
  assert.doesNotMatch(patched, /window\.openbotProtocol[^}]+Upe|window\.openbotProtocol[^}]+checking/);
});

test("the explicit local coordinator survives a null Cursor identity without unlocking account-only modules", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  assert.equal(
    (patched.match(/const hasLocalCoordinator=\(\)=>window\.openbotProtocol\?\.schemaVersion===1&&window\.openbotProtocol\?\.mode==="local-protocol"/g) ?? []).length,
    1,
  );
  assert.match(
    patched,
    /onIdentityRestoreComplete:\(\{accountSlot:n\}\)=>Whe\.completeIdentityChange\(\{acceptPort:n!=null\|\|hasLocalCoordinator\(\)\}\)/,
  );
  assert.match(
    patched,
    /,Bgt=\{slice:"send-journal",schemaVersion:2,scope:"client-persisted",accountSensitive:!0\}/,
  );
  assert.match(patched, new RegExp(STOCK_SEND_JOURNAL_PERSIST_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(patched, new RegExp(STOCK_SEND_JOURNAL_RESTORE_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    patched,
    /const openbotPersistenceSlot=Ve\?\?\(hasLocalCoordinator\(\)\?"openbot-local-v1":null\);if\(await j\.write\(\{accountSlot:null,value:Ve\}\),!Ye\(\)\|\|\(await B\.restore\(openbotPersistenceSlot\),!Ye\(\)\)\|\|\(await q\.restore\(openbotPersistenceSlot\),!Ye\(\)\)\|\|\(await K\.restore\(openbotPersistenceSlot\),!Ye\(\)\)\|\|\(await F\.restore\(openbotPersistenceSlot\),!Ye\(\)\)\|\|\(await ne\.restore\(openbotPersistenceSlot\),!Ye\(\)\)\|\|\(await Z\.restore\(openbotPersistenceSlot\),!Ye\(\)\)\|\|\(await ke\.restore\(openbotPersistenceSlot\),!Ye\(\)\)\)return;/,
  );
  assert.match(
    patched,
    /bt=\(\)=>\{if\(!\(Ge\|\|t\.get\(\)\.status!=="ready"\|\|\(s==null&&!hasLocalCoordinator\(\)\)\)\)\{/,
  );
  assert.match(
    patched,
    /mt=\(\)=>\{if\(Ge\|\|t\.get\(\)\.status!=="ready"\|\|\(s==null&&!hasLocalCoordinator\(\)\)\)return;/,
  );
  assert.match(patched, /\(Ve!=null\|\|hasLocalCoordinator\(\)\)&&F\.connect\(\)/);
  assert.match(
    patched,
    /:\(s\|\|hasLocalCoordinator\(\)\)\?f!=null\?W\._\(mbn\(f\)\):i\.length>0\?U\(\{id:"I\/1BxG"\}\):C\?\?W\._\(dht\):U\(\{id:"622\+sP"\}\)/,
  );
  assert.match(
    patched,
    /\(Ve!=null\|\|hasLocalCoordinator\(\)\)&&\(B\.loadPinnedAgentsFromBox\(\),q\.loadFromBox\(\),ke\.reconcileWithHost\(\)\)/,
  );

  // Cursor remains truthfully signed out: the identity resolver/getter and the
  // vendor account-scoped module gate stay byte-identical.
  for (const preserved of [
    STOCK_CURSOR_IDENTITY,
    STOCK_ACCOUNT_SLOT_GETTER,
    STOCK_ACCOUNT_SCOPED_CONNECT_GATE,
    STOCK_AUTH_OBSERVER,
  ]) {
    assert.equal((patched.match(new RegExp(preserved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  }
  assert.equal((patched.match(/openbot-local-v1/g) ?? []).length, 1);
  assert.doesNotMatch(patched, /(?:accountSlot|assertedSlot|s=)\s*[:=]\s*"openbot-local-v1"/);
});

test("the pinned renderer adds one composer model picker host immediately before voice and send", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  assert.match(
    patched,
    /se=p\.jsx\("div",\{className:ne,ref:d,style:X\.style,children:\[p\.jsx\("div",\{"data-openbot-model-picker-host":!0\}\),Q\]\}\)/,
  );
  assert.equal((patched.match(/data-openbot-model-picker-host/g) ?? []).length, 1);
  assert.doesNotMatch(
    patched,
    new RegExp(STOCK_PROMPT_TRAILING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.throws(
    () => patchVendorRendererSource(patched, sha256Text(patched)),
    /already|anchor|not found/i,
  );
});

test("the pinned renderer restores Grok New Bot and adds the bot-scoped Computer host", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  assert.match(
    patched,
    /function q2e\(n\)\{return n\.kind==="agent"\?\{kind:"agent",id:n\.agent\.id,name:n\.agent\.name,avatarDataUrl:n\.agent\.avatarDataUrl\}:n\.kind==="create-new"\?\{kind:"picker"\}:\{kind:"new",name:n\.name\}\}/,
  );
  assert.match(
    patched,
    /if\(Ee\.type==="single"&&Ee\.recipient\.kind==="picker"\)\{S\(\),r\(\),W\.openPicker\(\);return\}/,
  );
  assert.match(patched, /\[Ie,S,r,W,Ne,Te,xe,ve,t\]/);
  assert.equal((patched.match(/data-openbot-bot-settings-host/g) ?? []).length, 1);
  assert.match(
    patched,
    /children:\[j,B,p\.jsx\("div",\{"data-openbot-bot-settings-host":!0\}\)\]/,
  );
  assert.doesNotMatch(patched, new RegExp(STOCK_NEW_BOT_RECIPIENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(patched, new RegExp(STOCK_NEW_BOT_COMMIT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("renderer onboarding has no local storage authority and the native Power subtree has no Computer controls", () => {
  const source = fs.readFileSync(botUiPath, "utf8");
  const patchSource = fs.readFileSync(patchPath, "utf8");
  assert.doesNotMatch(source, /openbot\.first-connection\.v1|localStorage/);
  for (const providerId of [
    "openai-codex",
    "anthropic-claude",
    "google-antigravity",
    "moonshot-kimi",
    "xai",
    "google-vertex-ai",
    "openai-api-key",
    "local-openai-compatible",
  ]) assert.match(source, new RegExp(providerId.replaceAll("-", "\\-")));
  assert.match(source, /if \(nativeProtocolMode\) \{\s*popover\.append\(\s*pickerMenu/);
  assert.doesNotMatch(source, /nativeProtocolMode\) \{[\s\S]{0,160}codex-computer-row/);
  assert.match(patchSource, /W\.openPicker\(\)/);
});

test("the pinned lazy General Settings asset adds one AI Connections host after Account", () => {
  const { patchVendorSettingsSource } = require(patchPath);
  const patched = patchVendorSettingsSource(STOCK_SETTINGS_ROOT, sha256Text(STOCK_SETTINGS_ROOT));
  assert.equal((patched.match(/data-openbot-connections-host/g) ?? []).length, 1);
  assert.match(
    patched,
    /children:\[o,t\.jsx\("div",\{"data-openbot-connections-host":!0\}\),f,m,r,u,c\]/,
  );
  assert.throws(
    () => patchVendorSettingsSource(patched, sha256Text(patched)),
    /already|anchor|not found/i,
  );
});

test("the pinned native renderer patch fails closed on hash drift and every ambiguous anchor", async (t) => {
  const { patchVendorRendererSource } = require(patchPath);
  assert.throws(
    () => patchVendorRendererSource(SYNTHETIC_VENDOR_RENDERER, "0".repeat(64)),
    /renderer.*hash|hash.*renderer/i,
  );
  const missing = 'const renderer="drifted";';
  assert.throws(
    () => patchVendorRendererSource(missing, sha256Text(missing)),
    /anchor.*not found|not found.*anchor/i,
  );
  const requiredAnchors = [
    ["native shell", STOCK_NATIVE_SHELL_GATE],
    ["local capability", STOCK_SEND_JOURNAL_DEFINITION],
    ["reconnect", STOCK_RECONNECT_GATE],
    ["focus", STOCK_FOCUS_GATE],
    ["composer", STOCK_COMPOSER_ACCOUNT_GATE],
    ["composer model picker host", STOCK_PROMPT_TRAILING],
    ["new bot recipient", STOCK_NEW_BOT_RECIPIENT],
    ["new bot commit", STOCK_NEW_BOT_COMMIT],
    ["bot settings host", STOCK_BOT_SETTINGS_ROOT],
    ["client restore", STOCK_CLIENT_RESTORE],
    ["roster connect", STOCK_ROSTER_CONNECT_GATE],
    ["post restore", STOCK_POST_RESTORE_GATE],
    ["identity port", STOCK_IDENTITY_PORT_GATE],
  ];
  for (const [label, anchor] of requiredAnchors) {
    await t.test(`${label} missing`, () => {
      const changed = SYNTHETIC_VENDOR_RENDERER.replace(anchor, "");
      assert.throws(
        () => patchVendorRendererSource(changed, sha256Text(changed)),
        /anchor.*not found|not found.*anchor/i,
      );
    });
    await t.test(`${label} ambiguous`, () => {
      const changed = `${SYNTHETIC_VENDOR_RENDERER}${anchor}`;
      assert.throws(
        () => patchVendorRendererSource(changed, sha256Text(changed)),
        /anchor.*ambiguous|ambiguous.*anchor/i,
      );
    });
  }
});

test("stock renderer index receives one self-hosted Codex control layer", () => {
  const { patchRendererIndexSource } = require(patchPath);
  const patched = patchRendererIndexSource(STOCK_INDEX);
  assert.match(patched, /<title>OpenBot<\/title>/);
  assert.equal((patched.match(/\.\/codex\/codex-ui\.css/g) ?? []).length, 1);
  for (const file of [
    "model-controls.js", "reasoning-control.js", "openbot-local-desktop-view.js", "bot-runtime-ui.js",
  ]) {
    assert.equal((patched.match(new RegExp(`\\.\\/codex\\/${file.replace(".", "\\.")}`, "g")) ?? []).length, 1);
  }
  assert.match(patched, /assets\/index-CphCyQnY\.js/);
  assert.match(patched, /assets\/index-DTIy1z2L\.css/);
  assert.match(patched, /<div id="root"><\/div>/);
  assert.throws(() => patchRendererIndexSource(patched), /already|anchor|Codex/i);
  assert.throws(
    () => patchRendererIndexSource(STOCK_INDEX.replace("Grok Bot", "Other")),
    /title|anchor|Grok/i,
  );
});

test("renderer patch copies only the reviewed control assets into a synthetic stock tree", (t) => {
  const { patchRenderer } = require(patchPath);
  const root = tempRoot(t);
  writeSyntheticRendererTree(root);
  patchRenderer(root, {
    expectedVendorRendererSha256: sha256Text(SYNTHETIC_VENDOR_RENDERER),
    expectedVendorSettingsSha256: sha256Text(STOCK_SETTINGS_ROOT),
  });
  const target = path.join(root, "dist", "renderer", "codex");
  assert.deepEqual(fs.readdirSync(target).sort(), [
    "bot-runtime-ui.js",
    "codex-ui.css",
    "model-controls.js",
    "openbot-local-desktop-view.css",
    "openbot-local-desktop-view.js",
    "reasoning-control.js",
  ]);
  for (const file of fs.readdirSync(target)) {
    assert.deepEqual(
      fs.readFileSync(path.join(target, file)),
      fs.readFileSync(path.join(macRoot, "src", "renderer", file)),
    );
  }
  const vendorRenderer = fs.readFileSync(
    path.join(root, "dist", "renderer", "assets", "index-CphCyQnY.js"),
    "utf8",
  );
  assert.match(vendorRenderer, /window\.openbotProtocol\?\.schemaVersion===1/);
  assert.doesNotMatch(vendorRenderer, new RegExp(STOCK_NATIVE_SHELL_GATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(
    fs.readFileSync(path.join(root, "dist", "renderer", "assets", "index-d9mfdYoh.js"), "utf8"),
    /data-openbot-connections-host/,
  );
});

test("renderer patch pins the reviewed asset path, hash, and unique script reference", async (t) => {
  const { patchRenderer } = require(patchPath);
  await t.test("missing asset", () => {
    const root = tempRoot(t);
    writeSyntheticRendererTree(root, { asset: null });
    assert.throws(
      () => patchRenderer(root, { expectedVendorRendererSha256: sha256Text(SYNTHETIC_VENDOR_RENDERER) }),
      /renderer.*asset|asset.*renderer/i,
    );
  });
  await t.test("drifted asset hash", () => {
    const root = tempRoot(t);
    writeSyntheticRendererTree(root);
    assert.throws(() => patchRenderer(root), /renderer.*hash|hash.*renderer/i);
  });
  await t.test("missing script reference", () => {
    const root = tempRoot(t);
    writeSyntheticRendererTree(root, {
      index: STOCK_INDEX.replace("./assets/index-CphCyQnY.js", "./assets/index-other.js"),
    });
    assert.throws(
      () => patchRenderer(root, { expectedVendorRendererSha256: sha256Text(SYNTHETIC_VENDOR_RENDERER) }),
      /script.*not found|not found.*script/i,
    );
  });
  await t.test("duplicate script reference", () => {
    const root = tempRoot(t);
    const script = '    <script type="module" crossorigin src="./assets/index-CphCyQnY.js"></script>\n';
    writeSyntheticRendererTree(root, { index: STOCK_INDEX.replace(script, `${script}${script}`) });
    assert.throws(
      () => patchRenderer(root, { expectedVendorRendererSha256: sha256Text(SYNTHETIC_VENDOR_RENDERER) }),
      /script.*ambiguous|ambiguous.*script/i,
    );
  });
});

test("approved CSS docks management in the sidebar and opens native Power from the composer trigger", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const botUi = fs.readFileSync(botUiPath, "utf8");
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*position:\s*relative[^}]*width:\s*100%/s);
  assert.match(css, /\.codex-bot-controls\s*\{[^}]*color:\s*var\(--codex-text\)[^}]*background:\s*var\(--codex-surface\)/s);
  assert.match(css, /\.codex-model-dock\s*\{[^}]*position:\s*relative[^}]*width:\s*max-content/s);
  assert.match(css, /\.codex-model-trigger\s*\{[^}]*max-width:\s*210px/s);
  assert.match(css, /\.codex-power-popover\s*\{[^}]*position:\s*fixed[^}]*width:\s*224px[^}]*overflow:\s*clip/s);
  assert.match(css, /\.codex-power-popover\s*\{[^}]*animation:\s*codex-power-popover-enter 320ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\) 30ms both/s);
  assert.match(css, /\.codex-power-popover\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\[data-codex-mount-state="pending"\][^}]*display:\s*none/s);
  assert.doesNotMatch(css, /\.codex-bot-controls\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(css, /\.codex-bot-controls\s*\{[^}]*top:\s*12px/s);
  assert.doesNotMatch(css, /\bCanvas(?:Text)?\b/);
  assert.match(css, /\.codex-power-shell\s*\{[^}]*height:\s*32px/s);
  assert.match(css, /\.codex-power-control\s*\{[^}]*height:\s*28px/s);
  assert.match(css, /\.codex-power-track\s*\{[^}]*height:\s*24px/s);
  assert.match(css, /\.codex-power-thumb\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s);
  assert.match(css, /\.codex-power-tick\s*\{[^}]*width:\s*4px[^}]*height:\s*4px/s);
  assert.match(css, /\.codex-power-control\.is-max[^}]*#2383ff/s);
  assert.match(css, /\.codex-power-control\.is-disabled\s*\{[^}]*opacity:\s*0\.5[0-9]/s);
  assert.match(css, /\.codex-power-ultra-field\s*\{[^}]*z-index:\s*2[^}]*pointer-events:\s*none[^}]*position:\s*absolute[^}]*inset:\s*-1px/s);
  assert.match(css, /\.codex-power-ultra-mask\s*\{[^}]*--codex-power-ultra-mask-position:\s*0%[^}]*contain:\s*paint[^}]*isolation:\s*isolate[^}]*linear-gradient\(\s*90deg[^}]*color-mix\([^)]*var\(--codex-blue\)[^)]*var\(--codex-purple\)[^}]*mask-image:/s);
  assert.match(css, /\.codex-power-ultra-canvas\s*\{[^}]*mix-blend-mode:\s*luminosity[^}]*width:\s*100%[^}]*height:\s*100%[^}]*display:\s*block/s);
  assert.doesNotMatch(css, /\.codex-power-ultra-field::(?:before|after)/);
  assert.doesNotMatch(css, /\.codex-power-control\.is-ultra\s+\.codex-power-particles,[^}]*\.codex-power-control\.is-ultra\s+\.codex-power-burst\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.codex-power-control\.is-ultra\s+\.codex-power-particles\s*\{[^}]*opacity:\s*1/s);
  assert.match(css, /\.codex-power-particles\s*\{[^}]*height:\s*24px[^}]*top:\s*50%[^}]*transform:\s*translateY\(-50%\)/s);
  assert.match(css, /\.codex-power-particle\s*\{[^}]*transition-property:\s*left,\s*top[^}]*cubic-bezier\(0\.45,\s*0,\s*0\.55,\s*1\)/s);
  assert.doesNotMatch(css, /codex-power-ultra-particle-drift|codex-power-track-particle/);
  assert.match(css, /\.codex-power-control\.is-ultra-entering\s+\.codex-power-ultra-mask\s*\{[^}]*animation:\s*2s\s+both\s+codex-power-ultra-reveal/s);
  assert.match(css, /@keyframes\s+codex-power-ultra-reveal\s*\{[^}]*--codex-power-ultra-mask-position:\s*100%[^}]*\}[^}]*--codex-power-ultra-mask-position:\s*0%/s);
  assert.match(css, /@property\s+--codex-power-ultra-mask-position\s*\{[^}]*syntax:\s*"<percentage>"[^}]*inherits:\s*false[^}]*initial-value:\s*0%/s);
  assert.match(css, /\.codex-power-compact-controls\s*\{[^}]*position:\s*relative[^}]*height:\s*36px/s);
  assert.match(css, /\.codex-power-fast-toggle\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(css, /\.codex-power-endpoints\s*\{[^}]*font-size:\s*14px[^}]*line-height:\s*20px/s);
  assert.match(
    css,
    /\.codex-power-warning\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*font-size:\s*14px[^}]*line-height:\s*20px/s,
  );
  assert.match(css, /\.codex-power-warning:not\(\[hidden\]\)\s*\{[^}]*background-clip:\s*text[^}]*animation:\s*codex-power-warning-shimmer\s+1\.1s\s+ease-out\s+both/s);
  assert.doesNotMatch(css, /\.codex-power-warning(?:[^{}]|\{[^}]*\})*animation:[^;}]*infinite/s);
  assert.match(css, /@keyframes\s+codex-power-warning-shimmer/);
  assert.match(css, /\.codex-model-dock\.is-warning[^}]*\.codex-power-(?:advanced|fast)-toggle/s);
  assert.match(css, /\.codex-power-menu\s*\{[^}]*position:\s*relative[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.codex-power-menu\.transitions-ready\s*\{[^}]*transition:\s*height 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)/s);
  assert.match(css, /\.codex-power-menu\.transitions-ready \.codex-power-view-track\s*\{[^}]*transition:\s*transform 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)/s);
  assert.match(css, /\.codex-power-view-simple\s*\{[^}]*display:\s*flex[^}]*align-items:\s*flex-start[^}]*padding:\s*8px 6px/s);
  assert.doesNotMatch(css, /\.codex-power-view-simple\s*\{[^}]*min-height:\s*121px/s);
  assert.doesNotMatch(css, /\.codex-power-view-simple\s*\{[^}]*55px/s);
  assert.match(css, /\.codex-power-view-panel\s*\{[^}]*width:\s*100%[^}]*opacity:\s*1[^}]*transition:\s*opacity 200ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)/s);
  assert.match(css, /\.codex-power-view-panel\[aria-hidden="true"\]\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.codex-power-view-controls::before\s*\{[^}]*right:\s*6px[^}]*left:\s*6px/s);
  assert.match(css, /\.codex-power-advanced-row\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /\.codex-power-flyout\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(css, /codex-power-advanced-field\s+select/);
  assert.doesNotMatch(css, /\.codex-model-row[^}]*112px/s);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none\s*!important/);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.codex-power-particles,[\s\S]*\.codex-power-burst\s*\{[^}]*display:\s*none\s*!important/s,
  );
  assert.doesNotMatch(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.codex-power-ultra-(?:field|mask|canvas)\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.codex-power-warning:not\(\[hidden\]\)\s*\{[^}]*background:\s*none[^}]*-webkit-text-fill-color:\s*currentColor/s,
  );
  assert.match(css, /:root\[data-theme="light"\][\s\S]*--codex-surface:\s*#f[0-9a-f]{5}/i);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*light\)/);
  assert.match(css, /\.codex-power-fast-toggle\.is-active\s*\{[^}]*var\(--codex-blue\)/s);
  assert.doesNotMatch(css, /\.codex-model-dock\s*\{[^}]*container-type:\s*inline-size/s);
  assert.match(css, /@media\s*\(max-width:\s*1100px\)/);
  assert.match(css, /\.codex-bot-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/s);
  assert.match(css, /\.codex-bot-new\s*\{[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(css, /url\(|data:image|\/Users\/|\/private\/tmp\//);
  assert.match(botUi, /"button",\s*"codex-bot-rename-action",\s*"Rename"/);
  assert.match(botUi, /rename\.addEventListener\("keydown"[\s\S]*event\.key === "Enter"/);
  assert.match(botUi, /findUiMounts/);
  assert.match(botUi, /MutationObserver/);
  assert.match(botUi, /modelTrigger\.setAttribute\("aria-haspopup",\s*"dialog"\)/);
  assert.match(
    botUi,
    /const targetComposerHost = nativeProtocolMode \? nativeComposerHost : composerHost;/,
  );
  assert.match(botUi, /targetComposerHost\.append\?\.\(modelDock\)/);
  assert.doesNotMatch(botUi, /composerHost\.append\?\.\(modelDock\)/);
  assert.match(botUi, /reasoningView\.control\.classList\.toggle\("is-disabled",\s*snapshot\.disabled\)/s);
  assert.match(botUi, /compactControls\.append\(advancedToggle,\s*fastToggle,\s*reasoningView\.warning\)/s);
  assert.match(botUi, /viewTrack\.append\(simplePanel,\s*advancedPanel\)/s);
  assert.match(botUi, /pickerMenu\.append\(viewTrack,\s*viewControls\)/s);
  assert.match(botUi, /pickerMenu\.classList\.add\("transitions-ready"\)/s);
  assert.match(botUi, /modelDock\.append\(modelTrigger,\s*popover,\s*advancedFlyout\)/s);
  assert.doesNotMatch(botUi, /advancedPanel\.append\([^;]*advancedFlyout/s);
  assert.doesNotMatch(botUi, /codex-power-(?:model|effort|speed)-select/);
  assert.match(
    botUi,
    /nativeBotSettings\.append\([\s\S]*statusRow,[\s\S]*computerRow,[\s\S]*computerGrants,[\s\S]*desktopHost/s,
  );
  assert.doesNotMatch(botUi, /popover\.append\([^;]*(?:statusRow|computerRow|computerGrants)/s);
  assert.match(botUi, /nativeBotSettingsHost\.append\?\.\(nativeBotSettings\)/);
  assert.match(botUi, /nativeConnectionsHost\.append\?\.\(connectionsSettings\)/);
  assert.doesNotMatch(botUi, /popover\.append\([^;]*reasoningView\.warning/s);
});

test("Codex Advanced view replaces raw selects and suppresses the native legacy setup dialog", () => {
  const botUi = fs.readFileSync(botUiPath, "utf8");
  assert.match(botUi, /"div",\s*"codex-power-menu"/);
  assert.match(botUi, /"div",\s*"codex-power-view-track"/);
  assert.match(botUi, /"div",\s*"codex-power-view-panel codex-power-view-simple"/);
  assert.match(botUi, /"div",\s*"codex-power-view-panel codex-power-view-advanced"/);
  assert.match(botUi, /"div",\s*"codex-power-view-controls"/);
  assert.match(botUi, /row\.dataset\.kind\s*=\s*kind/);
  assert.match(botUi, /function setAdvancedView\(expanded\)/);
  assert.match(botUi, /function measurePickerViews\(\)/);
  assert.doesNotMatch(botUi, /"select",\s*"codex-power-(?:model|effort|speed)-select"/);
  assert.doesNotMatch(
    botUi,
    /documentRef\.body\.append\(newBotSetup,\s*computerSetup,\s*permissionSheet\)/,
  );
});

test("signed Ultra burst keeps all sixteen Codex vectors and the exact 76px 620ms burst", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  assert.match(
    css,
    /\.codex-power-burst\s*\{[^}]*width:\s*76px[^}]*height:\s*76px[^}]*top:\s*50%[^}]*transform:\s*translate\(-50%,\s*-50%\)/s,
  );
  assert.match(
    css,
    /\.codex-power-burst\s*>\s*i\s*\{[^}]*width:\s*5px[^}]*height:\s*5px[^}]*translate\(-50%,\s*-50%\)\s*scale\(0\.2\)/s,
  );
  assert.match(
    css,
    /\.codex-power-control\.is-ultra-entering\s+\.codex-power-burst\s*>\s*i\s*\{[^}]*animation:\s*0\.62s\s+cubic-bezier\(0\.25,\s*1,\s*0\.5,\s*1\)\s+both\s+codex-power-burst-particle/s,
  );
  const vectors = [
    [-3, -34], [15, -29], [30, -19], [34, -2],
    [26, 20], [12, 31], [-6, 34], [-22, 26],
    [-32, 9], [-32, -10], [-21, -26], [7, -24],
    [24, -9], [20, 10], [-9, 21], [-25, -5],
  ];
  for (const [offset, [x, y]] of vectors.entries()) {
    const selector = offset === 0 ? "first-child" : `nth-child\\(${offset + 1}\\)`;
    assert.match(
      css,
      new RegExp(`\\.codex-power-burst\\s*>\\s*i:${selector}\\s*\\{[^}]*--burst-x:\\s*${x}px[^}]*--burst-y:\\s*${y}px`, "s"),
    );
  }
  assert.match(
    css,
    /@keyframes\s+codex-power-burst-particle\s*\{\s*0%\s*\{[^}]*opacity:\s*0[^}]*translate\(-50%,\s*-50%\)\s*scale\(0\.25\)[^}]*\}\s*22%\s*\{[^}]*opacity:\s*1[^}]*scale\(1\.28\)[^}]*\}\s*(?:to|100%)\s*\{[^}]*opacity:\s*0[^}]*calc\(-50%\s*\+\s*var\(--burst-x\)\)[^}]*calc\(-50%\s*\+\s*var\(--burst-y\)\)[^}]*scale\(0\.55\)/s,
  );
});

test("Computer status and actions remain legible in the dark compact panel", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const root = css.match(/:root\s*\{(?<body>[\s\S]*?)\}/)?.groups?.body ?? "";
  const color = (name) => root.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255)
      .map((part) => part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const foreground = luminance(color("codex-blue-strong"));
  const background = luminance(color("codex-surface"));
  const contrast = (Math.max(foreground, background) + 0.05)
    / (Math.min(foreground, background) + 0.05);
  assert.ok(contrast >= 4.5, `dark action contrast must be at least 4.5:1, got ${contrast.toFixed(2)}:1`);
  assert.match(
    css,
    /\.codex-computer-status\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*visible[^}]*overflow-wrap:\s*anywhere[^}]*text-overflow:\s*clip[^}]*white-space:\s*normal/s,
  );
  assert.match(
    css,
    /\.codex-computer-setup-actions\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*flex-end[^}]*gap:\s*[4-9]px/s,
  );
});

test("visual disabled and later-Ultra evidence comes from production state instead of DOM mutation", () => {
  const runtime = fs.readFileSync(visualRuntimePath, "utf8");
  const fixture = fs.readFileSync(visualFixturePath, "utf8");
  assert.match(runtime, /phase === "disabled"[\s\S]*trigger\.disabled[\s\S]*popover[^\n]*hidden/s);
  assert.match(runtime, /disabled:\s*phase === "disabled"\s*\?\s*"true"\s*:\s*"false"/s);
  assert.match(runtime, /phase === "later"[\s\S]*3300/s);
  assert.match(
    runtime,
    /phase === "entry"[\s\S]*KeyboardEvent\("keydown",\s*\{[^}]*key:\s*"End"[^}]*\}\)[\s\S]*Keyboard Ultra must remain steady[\s\S]*PointerEvent\("pointerdown"[\s\S]*slider\.value\s*=\s*slider\.max[\s\S]*Event\("input"[\s\S]*PointerEvent\("pointerup"[\s\S]*is-ultra-entering[\s\S]*codex-power-warning/s,
  );
  assert.doesNotMatch(runtime, /slider\.disabled\s*=|classList\.add\("is-disabled"\)/);
  assert.match(fixture, /params\.get\("disabled"\) === "true"/);
  assert.match(fixture, /selectBot\(\)[\s\S]*new Promise\(\(\) => \{\}\)/s);
  assert.match(runtime, /new-bot-setup/);
  assert.match(runtime, /New Bot profile setup did not originate from production state/);
  assert.match(runtime, /codex-new-bot-continue/);
  assert.match(runtime, /computer-setup/);
  assert.match(runtime, /computer-change/);
  assert.match(runtime, /Permission sheet did not originate from production state/);
  assert.match(fixture, /async updateProfile/);
  assert.match(fixture, /setupStage:\s*"complete"/);
  assert.match(fixture, /async create\(\)[\s\S]*setupStage:\s*"profile-model"/s);
  assert.match(fixture, /async advanceSetup\([^)]+\)[\s\S]*expectedStage[\s\S]*nextStage/s);
  assert.match(fixture, /window\.openbotComputer/);
});
