"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { replaceUnique } = require("./anchors.cjs");
const {
  ADDED_AVATAR_SHAPES,
  VISIBLE_AVATAR_SHAPES,
} = require("../bots/avatar-catalog.cjs");

const ASSETS = Object.freeze([
  "bot-runtime-ui.js",
  "codex-ui.css",
  "model-controls.js",
  "openbot-local-desktop-view.css",
  "openbot-local-desktop-view.js",
  "reasoning-control.js",
]);
const VENDOR_VISIBLE_SHAPES = 'const Pq=["blob","pebble","squircle","tablet","wedge","hex","cloud","teardrop"]';
const OPENBOT_VISIBLE_SHAPES = `const Pq=${JSON.stringify(VISIBLE_AVATAR_SHAPES)}`;
const VENDOR_GEOMETRY_TAIL = 'teardrop:qo("Teardrop",wBt(88,ze-114,ze+26,18)),leaf:qo("Leaf",vBt(88,113,1.5))};Fo.wedge.face.leftDX=-6;const Jst=Object.keys(Fo)';
const OPENBOT_ADDED_GEOMETRIES = `
cat:qo("Cat",Ost([[ze-96,ze+72],[ze-94,ze-42],[ze-72,ze-104],[ze-38,ze-78],[ze,ze-92],[ze+38,ze-78],[ze+72,ze-104],[ze+94,ze-42],[ze+96,ze+72],[ze+58,ze+104],[ze-58,ze+104]],[18,10,8,18,22,18,8,10,18,24,24])),
dog:qo("Dog",Ost([[ze-100,ze-70],[ze-66,ze-92],[ze-46,ze-62],[ze,ze-82],[ze+46,ze-62],[ze+66,ze-92],[ze+100,ze-70],[ze+88,ze+70],[ze+52,ze+104],[ze-52,ze+104],[ze-88,ze+70]],[16,20,18,24,18,20,16,26,24,24,26])),
wolf:qo("Wolf",Ost([[ze-104,ze+52],[ze-88,ze-54],[ze-54,ze-112],[ze-24,ze-72],[ze,ze-98],[ze+24,ze-72],[ze+54,ze-112],[ze+88,ze-54],[ze+104,ze+52],[ze+66,ze+98],[ze+28,ze+82],[ze,ze+112],[ze-28,ze+82],[ze-66,ze+98]],[12,10,6,12,10,12,6,10,12,18,12,8,12,18])),
bunny:qo("Bunny",Ost([[ze-78,ze+96],[ze-72,ze-22],[ze-58,ze-112],[ze-28,ze-108],[ze-16,ze-42],[ze+16,ze-42],[ze+28,ze-108],[ze+58,ze-112],[ze+72,ze-22],[ze+78,ze+96],[ze+42,ze+112],[ze-42,ze+112]],[22,14,12,12,18,18,12,12,14,22,20,20])),
fox:qo("Fox",Ost([[ze-102,ze+56],[ze-88,ze-54],[ze-50,ze-108],[ze-30,ze-64],[ze,ze-88],[ze+30,ze-64],[ze+50,ze-108],[ze+88,ze-54],[ze+102,ze+56],[ze+48,ze+88],[ze,ze+114],[ze-48,ze+88]],[12,8,6,14,18,14,6,8,12,16,8,16])),
bear:qo("Bear",dBt([[ze-70,ze-66,40],[ze+70,ze-66,40],[ze,ze+12,104],[ze,ze+78,72]])),
owl:qo("Owl",Ost([[ze-92,ze+88],[ze-90,ze-42],[ze-62,ze-98],[ze-24,ze-72],[ze,ze-108],[ze+24,ze-72],[ze+62,ze-98],[ze+90,ze-42],[ze+92,ze+88],[ze+44,ze+108],[ze,ze+84],[ze-44,ze+108]],[18,14,8,16,8,16,8,14,18,16,12,16])),
jelly:qo("Jelly",Ost([[ze-98,ze+54],[ze-92,ze-26],[ze-62,ze-82],[ze,ze-108],[ze+62,ze-82],[ze+92,ze-26],[ze+98,ze+54],[ze+76,ze+98],[ze+38,ze+72],[ze,ze+106],[ze-38,ze+72],[ze-76,ze+98]],[18,18,24,28,24,18,18,16,12,12,12,16])),
terminal:qo("Terminal",Ost([[ze-104,ze-82],[ze+104,ze-82],[ze+104,ze+58],[ze+42,ze+58],[ze+58,ze+98],[ze+78,ze+98],[ze+78,ze+112],[ze-78,ze+112],[ze-78,ze+98],[ze-58,ze+98],[ze-42,ze+58],[ze-104,ze+58]],[14,14,14,10,8,6,6,6,6,8,10,14])),
robot:qo("Robot",Ost([[ze-76,ze-96],[ze-18,ze-96],[ze-10,ze-116],[ze+10,ze-116],[ze+18,ze-96],[ze+76,ze-96],[ze+76,ze-72],[ze+104,ze-72],[ze+104,ze+78],[ze+76,ze+78],[ze+76,ze+104],[ze-76,ze+104],[ze-76,ze+78],[ze-104,ze+78],[ze-104,ze-72],[ze-76,ze-72]],[12,8,6,6,8,12,8,10,12,8,12,12,8,12,10,8])),
microchip:qo("Microchip",Ost([[ze-62,ze-108],[ze-38,ze-108],[ze-38,ze-88],[ze-12,ze-88],[ze-12,ze-108],[ze+12,ze-108],[ze+12,ze-88],[ze+38,ze-88],[ze+38,ze-108],[ze+62,ze-108],[ze+62,ze-84],[ze+88,ze-84],[ze+88,ze-58],[ze+108,ze-58],[ze+108,ze-32],[ze+88,ze-32],[ze+88,ze+32],[ze+108,ze+32],[ze+108,ze+58],[ze+88,ze+58],[ze+88,ze+84],[ze+62,ze+84],[ze+62,ze+108],[ze+38,ze+108],[ze+38,ze+88],[ze+12,ze+88],[ze+12,ze+108],[ze-12,ze+108],[ze-12,ze+88],[ze-38,ze+88],[ze-38,ze+108],[ze-62,ze+108],[ze-62,ze+84],[ze-88,ze+84],[ze-88,ze+58],[ze-108,ze+58],[ze-108,ze+32],[ze-88,ze+32],[ze-88,ze-32],[ze-108,ze-32],[ze-108,ze-58],[ze-88,ze-58],[ze-88,ze-84],[ze-62,ze-84]],6)),
drone:qo("Drone",Ost([[ze-112,ze-72],[ze-58,ze-72],[ze-42,ze-34],[ze-24,ze-22],[ze-18,ze-48],[ze+18,ze-48],[ze+24,ze-22],[ze+42,ze-34],[ze+58,ze-72],[ze+112,ze-72],[ze+112,ze-42],[ze+70,ze-42],[ze+54,ze-8],[ze+90,ze+42],[ze+90,ze+72],[ze+42,ze+72],[ze+18,ze+38],[ze-18,ze+38],[ze-42,ze+72],[ze-90,ze+72],[ze-90,ze+42],[ze-54,ze-8],[ze-70,ze-42],[ze-112,ze-42]],8))`;
const OPENBOT_GEOMETRY_TAIL = VENDOR_GEOMETRY_TAIL.replace(
  'leaf:qo("Leaf",vBt(88,113,1.5))};',
  `leaf:qo("Leaf",vBt(88,113,1.5)),${OPENBOT_ADDED_GEOMETRIES}};`,
);
const TITLE = "<title>Grok Bot</title>";
const CODEX_TITLE = "<title>OpenBot</title>";
const HEAD_END = "  </head>";
const CODEX_HEAD = `    <link rel="stylesheet" href="./codex/codex-ui.css">
    <link rel="stylesheet" href="./codex/openbot-local-desktop-view.css">
    <script src="./codex/model-controls.js" defer></script>
    <script src="./codex/reasoning-control.js" defer></script>
    <script src="./codex/openbot-local-desktop-view.js" defer></script>
    <script src="./codex/bot-runtime-ui.js" defer></script>
  </head>`;
const VENDOR_RENDERER_ASSET = "index-CphCyQnY.js";
const VENDOR_RENDERER_ASSET_SHA256 =
  "097b53e7c7e481022b393228b65104b3cd548881281b6adf0cb255a4b3e5b038";
const VENDOR_SETTINGS_ASSET = "index-d9mfdYoh.js";
const VENDOR_SETTINGS_ASSET_SHA256 =
  "e30ee380b429519be8748ec7294c618d37db6c84ddf72e79d4f3d218245dfbae";
const VENDOR_RENDERER_SCRIPT = `./assets/${VENDOR_RENDERER_ASSET}`;
const VENDOR_NATIVE_SHELL_GATE = 'function MHn(){const n=wLt(),{phase:e,onboardingRunId:t,completeOnboarding:s}=RFn();return n?p.jsxs(p.Fragment,{children:[p.jsx(Upe,{}),p.jsx(ggt,{})]}):e==="checking"?null:p.jsx(TDn,{chrome:JHn,children:e==="onboarding"?p.jsx(qFn,{onComplete:s,presentation:KUn},t):p.jsx(BHn,{})})}';
const OPENBOT_NATIVE_SHELL_GATE = 'function MHn(){const n=wLt(),{phase:e,onboardingRunId:t,completeOnboarding:s}=RFn();return n?p.jsxs(p.Fragment,{children:[p.jsx(Upe,{}),p.jsx(ggt,{})]}):e==="checking"?null:p.jsx(TDn,{chrome:JHn,children:e==="onboarding"&&!(window.openbotProtocol?.schemaVersion===1&&window.openbotProtocol?.mode==="local-protocol")?p.jsx(qFn,{onComplete:s,presentation:KUn},t):p.jsx(BHn,{})})}';
const OPENBOT_LOCAL_COORDINATOR_PREDICATE =
  'window.openbotProtocol?.schemaVersion===1&&window.openbotProtocol?.mode==="local-protocol"';
const VENDOR_SEND_JOURNAL_DEFINITION =
  'const Bgt={slice:"send-journal",schemaVersion:2,scope:"client-persisted",accountSensitive:!0}';
const OPENBOT_SEND_JOURNAL_DEFINITION =
  `const hasLocalCoordinator=()=>${OPENBOT_LOCAL_COORDINATOR_PREDICATE},Bgt={slice:"send-journal",schemaVersion:2,scope:"client-persisted",accountSensitive:!0}`;
const VENDOR_RECONNECT_GATE = 'bt=()=>{if(!(Ge||t.get().status!=="ready"||s==null)){';
const OPENBOT_RECONNECT_GATE =
  'bt=()=>{if(!(Ge||t.get().status!=="ready"||(s==null&&!hasLocalCoordinator()))){';
const VENDOR_FOCUS_GATE = 'mt=()=>{if(Ge||t.get().status!=="ready"||s==null)return;';
const OPENBOT_FOCUS_GATE =
  'mt=()=>{if(Ge||t.get().status!=="ready"||(s==null&&!hasLocalCoordinator()))return;';
const VENDOR_COMPOSER_ACCOUNT_GATE =
  ':s?f!=null?W._(mbn(f)):i.length>0?U({id:"I/1BxG"}):C??W._(dht):U({id:"622+sP"})';
const OPENBOT_COMPOSER_ACCOUNT_GATE =
  ':(s||hasLocalCoordinator())?f!=null?W._(mbn(f)):i.length>0?U({id:"I/1BxG"}):C??W._(dht):U({id:"622+sP"})';
const VENDOR_PROMPT_TRAILING =
  'se=p.jsx("div",{className:ne,ref:d,style:X.style,children:Q})';
const OPENBOT_PROMPT_TRAILING =
  'se=p.jsx("div",{className:ne,ref:d,style:X.style,children:[p.jsx("div",{"data-openbot-model-picker-host":!0}),Q]})';
const VENDOR_NEW_BOT_RECIPIENT =
  'function q2e(n){return n.kind==="agent"?{kind:"agent",id:n.agent.id,name:n.agent.name,avatarDataUrl:n.agent.avatarDataUrl}:{kind:"new",name:n.kind==="create"?n.name:Jut}}';
const OPENBOT_NEW_BOT_RECIPIENT =
  'function q2e(n){return n.kind==="agent"?{kind:"agent",id:n.agent.id,name:n.agent.name,avatarDataUrl:n.agent.avatarDataUrl}:n.kind==="create-new"?{kind:"picker"}:{kind:"new",name:n.name}}';
const VENDOR_NEW_BOT_COMMIT =
  'he=x.useCallback(Ee=>{if(Ee.type==="noop")return;const Me=Ie(),Ae=Me.prompt.trim().length>0||Me.attachmentPaths.length>0;if(S(),r(),Ee.type==="single"){if(Ee.recipient.kind==="new"){Ae?Ne(Ee.recipient.name,Me):Te(Ee.recipient,"");return}Ae&&ve(Ee.recipient.id,Me),t(Ee.recipient.id);return}xe(Ee.recipients,"",[],Ae?Me:void 0)},[Ie,S,r,Ne,Te,xe,ve,t]';
const OPENBOT_NEW_BOT_COMMIT =
  'he=x.useCallback(Ee=>{if(Ee.type==="noop")return;if(Ee.type==="single"&&Ee.recipient.kind==="picker"){S(),r(),W.openPicker();return}const Me=Ie(),Ae=Me.prompt.trim().length>0||Me.attachmentPaths.length>0;if(S(),r(),Ee.type==="single"){if(Ee.recipient.kind==="new"){Ae?Ne(Ee.recipient.name,Me):Te(Ee.recipient,"");return}Ae&&ve(Ee.recipient.id,Me),t(Ee.recipient.id);return}xe(Ee.recipients,"",[],Ae?Me:void 0)},[Ie,S,r,W,Ne,Te,xe,ve,t]';
const VENDOR_BOT_SETTINGS_ROOT =
  'let q;return e[43]!==j||e[44]!==B?(q=p.jsxs("div",{className:m,children:[j,B]}),e[43]=j,e[44]=B,e[45]=q):q=e[45],q}';
const OPENBOT_BOT_SETTINGS_ROOT =
  'let q;return e[43]!==j||e[44]!==B?(q=p.jsxs("div",{className:m,children:[j,B,p.jsx("div",{"data-openbot-bot-settings-host":!0})]}),e[43]=j,e[44]=B,e[45]=q):q=e[45],q}';
const VENDOR_SETTINGS_ROOT =
  'let h;return e[13]!==o?(h=t.jsxs("div",{className:d,children:[o,f,m,r,u,c]}),e[13]=o,e[14]=h):h=e[14],h}';
const OPENBOT_SETTINGS_ROOT =
  'let h;return e[13]!==o?(h=t.jsxs("div",{className:d,children:[o,t.jsx("div",{"data-openbot-connections-host":!0}),f,m,r,u,c]}),e[13]=o,e[14]=h):h=e[14],h}';
const VENDOR_CLIENT_RESTORE = 'if(await j.write({accountSlot:null,value:Ve}),!Ye()||(await B.restore(Ve),!Ye())||(await q.restore(Ve),!Ye())||(await K.restore(Ve),!Ye())||(await F.restore(Ve),!Ye())||(await ne.restore(Ve),!Ye())||(await Z.restore(Ve),!Ye())||(await ke.restore(Ve),!Ye()))return;';
const OPENBOT_CLIENT_RESTORE = 'const openbotPersistenceSlot=Ve??(hasLocalCoordinator()?"openbot-local-v1":null);if(await j.write({accountSlot:null,value:Ve}),!Ye()||(await B.restore(openbotPersistenceSlot),!Ye())||(await q.restore(openbotPersistenceSlot),!Ye())||(await K.restore(openbotPersistenceSlot),!Ye())||(await F.restore(openbotPersistenceSlot),!Ye())||(await ne.restore(openbotPersistenceSlot),!Ye())||(await Z.restore(openbotPersistenceSlot),!Ye())||(await ke.restore(openbotPersistenceSlot),!Ye()))return;';
const VENDOR_ROSTER_CONNECT_GATE = 'Ve!=null&&F.connect()';
const OPENBOT_ROSTER_CONNECT_GATE = '(Ve!=null||hasLocalCoordinator())&&F.connect()';
const VENDOR_POST_RESTORE_GATE =
  'Ve!=null&&(B.loadPinnedAgentsFromBox(),q.loadFromBox(),ke.reconcileWithHost())';
const OPENBOT_POST_RESTORE_GATE =
  '(Ve!=null||hasLocalCoordinator())&&(B.loadPinnedAgentsFromBox(),q.loadFromBox(),ke.reconcileWithHost())';
const VENDOR_IDENTITY_PORT_GATE =
  'onIdentityRestoreComplete:({accountSlot:n})=>Whe.completeIdentityChange({acceptPort:n!=null})';
const OPENBOT_IDENTITY_PORT_GATE =
  'onIdentityRestoreComplete:({accountSlot:n})=>Whe.completeIdentityChange({acceptPort:n!=null||hasLocalCoordinator()})';

function patchAvatarCatalogSource(source) {
  let patched = replaceUnique(
    source,
    VENDOR_GEOMETRY_TAIL,
    OPENBOT_GEOMETRY_TAIL,
    "Grok avatar geometry registry",
  );
  patched = replaceUnique(
    patched,
    VENDOR_VISIBLE_SHAPES,
    OPENBOT_VISIBLE_SHAPES,
    "Grok visible avatar registry",
  );
  return patched;
}

function reverseAvatarCatalogSource(source) {
  let reversed = replaceUnique(
    source,
    OPENBOT_VISIBLE_SHAPES,
    VENDOR_VISIBLE_SHAPES,
    "OpenBot visible avatar registry",
  );
  reversed = replaceUnique(
    reversed,
    OPENBOT_GEOMETRY_TAIL,
    VENDOR_GEOMETRY_TAIL,
    "OpenBot avatar geometry registry",
  );
  return reversed;
}

function patchVendorRendererSource(source, expectedSha256 = VENDOR_RENDERER_ASSET_SHA256) {
  if (typeof source !== "string" || source.length < 1) {
    throw new Error("Grok renderer asset is invalid");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Expected Grok renderer asset hash is invalid");
  }
  const actualSha256 = crypto.createHash("sha256").update(source, "utf8").digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Unsupported Grok renderer asset hash: ${actualSha256}`);
  }
  let patched = patchAvatarCatalogSource(source);
  patched = replaceUnique(
    patched,
    VENDOR_NATIVE_SHELL_GATE,
    OPENBOT_NATIVE_SHELL_GATE,
    "Grok native shell onboarding child",
  );
  patched = replaceUnique(
    patched,
    VENDOR_SEND_JOURNAL_DEFINITION,
    OPENBOT_SEND_JOURNAL_DEFINITION,
    "Grok local coordinator capability",
  );
  patched = replaceUnique(
    patched,
    VENDOR_RECONNECT_GATE,
    OPENBOT_RECONNECT_GATE,
    "Grok coordinator reconnect account gate",
  );
  patched = replaceUnique(
    patched,
    VENDOR_FOCUS_GATE,
    OPENBOT_FOCUS_GATE,
    "Grok coordinator focus account gate",
  );
  patched = replaceUnique(
    patched,
    VENDOR_COMPOSER_ACCOUNT_GATE,
    OPENBOT_COMPOSER_ACCOUNT_GATE,
    "Grok composer account placeholder gate",
  );
  patched = replaceUnique(
    patched,
    VENDOR_CLIENT_RESTORE,
    OPENBOT_CLIENT_RESTORE,
    "Grok local client persistence restore",
  );
  patched = replaceUnique(
    patched,
    VENDOR_ROSTER_CONNECT_GATE,
    OPENBOT_ROSTER_CONNECT_GATE,
    "Grok roster connect account gate",
  );
  patched = replaceUnique(
    patched,
    VENDOR_POST_RESTORE_GATE,
    OPENBOT_POST_RESTORE_GATE,
    "Grok client post-restore account gate",
  );
  patched = replaceUnique(
    patched,
    VENDOR_IDENTITY_PORT_GATE,
    OPENBOT_IDENTITY_PORT_GATE,
    "Grok coordinator identity port account gate",
  );
  patched = replaceUnique(
    patched,
    VENDOR_PROMPT_TRAILING,
    OPENBOT_PROMPT_TRAILING,
    "Grok composer model picker host",
  );
  patched = replaceUnique(
    patched,
    VENDOR_NEW_BOT_RECIPIENT,
    OPENBOT_NEW_BOT_RECIPIENT,
    "Grok native New Bot picker route",
  );
  patched = replaceUnique(
    patched,
    VENDOR_NEW_BOT_COMMIT,
    OPENBOT_NEW_BOT_COMMIT,
    "Grok native New Bot picker commit",
  );
  return replaceUnique(
    patched,
    VENDOR_BOT_SETTINGS_ROOT,
    OPENBOT_BOT_SETTINGS_ROOT,
    "Grok View Bot settings host",
  );
}

function patchVendorSettingsSource(source, expectedSha256 = VENDOR_SETTINGS_ASSET_SHA256) {
  if (typeof source !== "string" || source.length < 1) {
    throw new Error("Grok settings asset is invalid");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Expected Grok settings asset hash is invalid");
  }
  const actualSha256 = crypto.createHash("sha256").update(source, "utf8").digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Unsupported Grok settings asset hash: ${actualSha256}`);
  }
  return replaceUnique(
    source,
    VENDOR_SETTINGS_ROOT,
    OPENBOT_SETTINGS_ROOT,
    "Grok General Settings AI Connections host",
  );
}

function patchRendererIndexSource(source) {
  if (typeof source !== "string" || source.length < 1 || source.length > 1_000_000) {
    throw new Error("Grok renderer index is invalid");
  }
  if (source.includes("./codex/") || source.includes(CODEX_TITLE)) {
    throw new Error("Codex renderer controls are already installed");
  }
  let patched = replaceUnique(source, TITLE, CODEX_TITLE, "Grok renderer title");
  patched = replaceUnique(patched, HEAD_END, CODEX_HEAD, "Grok renderer head");
  return patched;
}

function realDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function patchRenderer(extractedRoot, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Grok renderer patch options are invalid");
  }
  const optionKeys = Object.keys(options);
  if (optionKeys.some((key) => ![
    "expectedVendorRendererSha256", "expectedVendorSettingsSha256",
  ].includes(key))) {
    throw new Error("Unsupported Grok renderer patch option");
  }
  const expectedVendorRendererSha256 =
    options.expectedVendorRendererSha256 ?? VENDOR_RENDERER_ASSET_SHA256;
  const expectedVendorSettingsSha256 =
    options.expectedVendorSettingsSha256 ?? VENDOR_SETTINGS_ASSET_SHA256;
  const root = path.resolve(extractedRoot);
  const renderer = path.join(root, "dist", "renderer");
  realDirectory(root, "Extracted app");
  realDirectory(renderer, "Grok renderer");
  const index = path.join(renderer, "index.html");
  const indexStat = fs.lstatSync(index);
  if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
    throw new Error("Grok renderer index must be a real file");
  }
  const indexSource = fs.readFileSync(index, "utf8");
  replaceUnique(
    indexSource,
    VENDOR_RENDERER_SCRIPT,
    VENDOR_RENDERER_SCRIPT,
    "Grok renderer script reference",
  );
  const patchedIndex = patchRendererIndexSource(indexSource);
  const vendorAssets = path.join(renderer, "assets");
  realDirectory(vendorAssets, "Grok renderer assets");
  const vendorRenderer = path.join(vendorAssets, VENDOR_RENDERER_ASSET);
  const vendorRendererStat = fs.lstatSync(vendorRenderer);
  if (!vendorRendererStat.isFile() || vendorRendererStat.isSymbolicLink()) {
    throw new Error("Grok renderer asset must be a real file");
  }
  const patchedVendorRenderer = patchVendorRendererSource(
    fs.readFileSync(vendorRenderer, "utf8"),
    expectedVendorRendererSha256,
  );
  const vendorSettings = path.join(vendorAssets, VENDOR_SETTINGS_ASSET);
  const vendorSettingsStat = fs.lstatSync(vendorSettings);
  if (!vendorSettingsStat.isFile() || vendorSettingsStat.isSymbolicLink()) {
    throw new Error("Grok settings asset must be a real file");
  }
  const patchedVendorSettings = patchVendorSettingsSource(
    fs.readFileSync(vendorSettings, "utf8"),
    expectedVendorSettingsSha256,
  );
  const target = path.join(renderer, "codex");
  if (fs.existsSync(target)) throw new Error("Codex renderer asset target already exists");
  const sourceRoot = path.resolve(__dirname, "..", "renderer");
  realDirectory(sourceRoot, "Codex renderer source");
  fs.mkdirSync(target, { mode: 0o755 });
  for (const asset of ASSETS) {
    const source = path.join(sourceRoot, asset);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Codex renderer asset is invalid: ${asset}`);
    }
    fs.copyFileSync(source, path.join(target, asset), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(target, asset), 0o644);
  }
  fs.writeFileSync(vendorRenderer, patchedVendorRenderer, {
    encoding: "utf8",
    mode: vendorRendererStat.mode & 0o777,
  });
  fs.writeFileSync(vendorSettings, patchedVendorSettings, {
    encoding: "utf8",
    mode: vendorSettingsStat.mode & 0o777,
  });
  fs.writeFileSync(index, patchedIndex, { encoding: "utf8", mode: indexStat.mode & 0o777 });
}

module.exports = {
  ASSETS,
  OPENBOT_GEOMETRY_TAIL,
  OPENBOT_VISIBLE_SHAPES,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_RENDERER_ASSET,
  VENDOR_RENDERER_ASSET_SHA256,
  VENDOR_SETTINGS_ASSET,
  VENDOR_SETTINGS_ASSET_SHA256,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarCatalogSource,
  patchRenderer,
  patchRendererIndexSource,
  patchVendorRendererSource,
  patchVendorSettingsSource,
  reverseAvatarCatalogSource,
};
