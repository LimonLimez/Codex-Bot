"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { replaceUnique } = require("./anchors.cjs");
const {
  ADDED_AVATAR_SHAPES,
  AVATAR_COLORS,
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
dog:qo("Dog",Ost([[ze-100,ze-70],[ze-66,ze-92],[ze-46,ze-62],[ze,ze-82],[ze+46,ze-62],[ze+66,ze-92],[ze+100,ze-70],[ze+88,ze+70],[ze+52,ze+104],[ze-52,ze+104],[ze-88,ze+70]],[16,18,18,24,18,18,16,24,24,24,24])),
wolf:qo("Wolf",Ost([[ze-104,ze+52],[ze-88,ze-54],[ze-54,ze-112],[ze-24,ze-72],[ze,ze-98],[ze+24,ze-72],[ze+54,ze-112],[ze+88,ze-54],[ze+104,ze+52],[ze+66,ze+98],[ze+28,ze+82],[ze,ze+112],[ze-28,ze+82],[ze-66,ze+98]],[12,10,6,12,10,12,6,10,12,18,12,8,12,18])),
bunny:qo("Bunny",Ost([[ze-78,ze+96],[ze-72,ze-22],[ze-58,ze-112],[ze-28,ze-108],[ze-16,ze-42],[ze+16,ze-42],[ze+28,ze-108],[ze+58,ze-112],[ze+72,ze-22],[ze+78,ze+96],[ze+42,ze+112],[ze-42,ze+112]],[20,14,12,12,15,15,12,12,14,19,19,19])),
fox:qo("Fox",Ost([[ze-102,ze+56],[ze-88,ze-54],[ze-50,ze-108],[ze-30,ze-64],[ze,ze-88],[ze+30,ze-64],[ze+50,ze-108],[ze+88,ze-54],[ze+102,ze+56],[ze+48,ze+88],[ze,ze+114],[ze-48,ze+88]],[12,8,6,14,18,14,6,8,12,16,8,16])),
bear:qo("Bear",dBt([[ze-70,ze-66,40],[ze+70,ze-66,40],[ze,ze+12,100],[ze,ze+44,72]])),
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
const OPENBOT_NEW_BOT_AVATAR_PICKER = `
function openbotNewBotAvatarPickerLocalProtocol(){return window.openbotProtocol?.schemaVersion===1&&window.openbotProtocol?.mode==="local-protocol"}
function openbotNewBotAvatarPickerMerge(value,staged){const next={...value};if(staged?.avatarShape!=null){if(!Pq.includes(staged.avatarShape))throw new Error("New Bot avatar shape is unavailable");next.avatarShape=staged.avatarShape}if(staged?.avatarColor!=null){if(!DQ.some(entry=>entry.id===staged.avatarColor))throw new Error("New Bot avatar color is unavailable");next.avatarColor=staged.avatarColor}return next}
function openbotNewBotAvatarPickerMenu({menuRef,staged,onCommit,onBack}){const active=Boolean(staged?.avatarShape!=null&&staged?.avatarColor!=null),agent={id:"openbot-create-your-own",avatarShape:active?staged.avatarShape:null,avatarColor:active?staged.avatarColor:null},character={isCommitting:!1,commitCharacter:onCommit},preview=active?p.jsx(rd,{color:staged.avatarColor,paused:!0,shape:staged.avatarShape,sizePx:64}):null;return p.jsxs(Zt.Root,{ref:menuRef,open:!0,onOpenChange:open=>{if(!open)onBack()},variant:"rich",width:360,children:[p.jsxs(Zt.Header,{children:[p.jsx(Zt.Title,{children:p.jsx(Re,{id:"5XRPbV"})}),p.jsx(Zt.CloseButton,{})]}),p.jsx(Zt.Body,{children:p.jsxs("div",{children:[preview,p.jsx(M4n,{agent,character,staged,isCharacterActive:active,shapeIsExplicit:staged?.avatarShape!=null,colorIsExplicit:staged?.avatarColor!=null})]})})]})}
const openbotOriginalCreateOwnForm=Eyn;
function openbotNewBotCreateOwnForm(n){const [staged,setStaged]=x.useState(null),[menuOpen,setMenuOpen]=x.useState(!1),rootRef=x.useRef(null),menuRef=x.useRef(null),local=openbotNewBotAvatarPickerLocalProtocol(),onCommit=x.useCallback(change=>setStaged(current=>({...current,...change})),[]),openbotNewBotAvatarPickerBack=x.useCallback(()=>{setMenuOpen(!1),(rootRef.current?.querySelector('button[aria-label*="Bot photo"]')??rootRef.current?.querySelector("button.sand-editable-avatar__button"))?.focus?.({preventScroll:!0})},[]),openPicker=x.useCallback(event=>{const target=event.target?.closest?.('button[aria-label*="Bot photo"]')??event.target?.closest?.("button.sand-editable-avatar__button");if(target==null)return;event.preventDefault(),event.stopPropagation(),setMenuOpen(!0)},[]),openbotNewBotAvatarPickerMergeForCreate=x.useCallback(value=>n.onCreate(openbotNewBotAvatarPickerMerge(value,staged)),[n.onCreate,staged]);x.useEffect(()=>{if(!local)setMenuOpen(!1);else if(menuOpen)menuRef.current?.focus?.({preventScroll:!0})},[local,menuOpen]);return p.jsxs("div",{ref:rootRef,style:{display:"contents"},onClickCapture:local?openPicker:void 0,children:[p.jsx(openbotOriginalCreateOwnForm,local?{...n,onCreate:openbotNewBotAvatarPickerMergeForCreate}:n,"openbot-new-bot-create-own-form"),local&&menuOpen?p.jsx(openbotNewBotAvatarPickerMenu,{menuRef,staged,onCommit,onBack:openbotNewBotAvatarPickerBack}):null]})}
Eyn=openbotNewBotCreateOwnForm;
`;
const VENDOR_NEW_BOT_CHARACTER_EDITOR_PREFIX =
  'function M4n(n){const e=ye.c(32),{agent:t,character:s,staged:r,isCharacterActive:i}=n';
const OPENBOT_NEW_BOT_CHARACTER_EDITOR_PREFIX =
  'function M4n(n){const e=ye.c(32),{agent:t,character:s,staged:r,isCharacterActive:i,shapeIsExplicit:a=i,colorIsExplicit:c=i}=n';
const VENDOR_NEW_BOT_CHARACTER_SHAPE_ACTIVE = 'const O=i&&f===M';
const OPENBOT_NEW_BOT_CHARACTER_SHAPE_ACTIVE = 'const O=a&&f===M';
const VENDOR_NEW_BOT_CHARACTER_COLOR_ACTIVE = 'i&&d===M.id';
const OPENBOT_NEW_BOT_CHARACTER_COLOR_ACTIVE = 'c&&d===M.id';
const VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK =
  'e[9]!==o||e[10]!==l||e[11]!==i||e[12]!==d||e[13]!==f?';
const OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK =
  'e[9]!==o||e[10]!==l||e[11]!==i+"|"+a||e[12]!==d||e[13]!==f?';
const VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN =
  'e[9]=o,e[10]=l,e[11]=i,e[12]=d,e[13]=f,e[14]=b';
const OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN =
  'e[9]=o,e[10]=l,e[11]=i+"|"+a,e[12]=d,e[13]=f,e[14]=b';
const VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK =
  'e[21]!==o||e[22]!==l||e[23]!==i||e[24]!==d?';
const OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK =
  'e[21]!==o||e[22]!==l||e[23]!==i+"|"+c||e[24]!==d?';
const VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN =
  'e[21]=o,e[22]=l,e[23]=i,e[24]=d,e[25]=C';
const OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN =
  'e[21]=o,e[22]=l,e[23]=i+"|"+c,e[24]=d,e[25]=C';
const NEW_BOT_CHARACTER_EDITOR_END = 'class O4n';
const VENDOR_NEW_BOT_CREATE_RESOLVE =
  'const Me=await Ee.resolveAvatar(),Ae=await re({name:Ee.name,description:Ee.description,avatarPngBase64:Me,...Ee.templateId!=null?{templateId:Ee.templateId}:{}});';
const OPENBOT_NEW_BOT_CREATE_RESOLVE =
  'const Me=await Ee.resolveAvatar(),Ae=await re({name:Ee.name,description:Ee.description,avatarPngBase64:Me,...Ee.templateId!=null?{templateId:Ee.templateId}:{},...Ee.avatarShape!=null?{avatarShape:Ee.avatarShape}:{},...Ee.avatarColor!=null?{avatarColor:Ee.avatarColor}:{}});';
const VENDOR_NEW_BOT_CREATE_DISPATCH =
  'ee=x.useCallback(Ee=>{ae({name:Ee.name,description:Ee.description,resolveAvatar:()=>Promise.resolve(Ee.avatarPngBase64)})},[ae])';
const OPENBOT_NEW_BOT_CREATE_DISPATCH =
  'ee=x.useCallback(Ee=>{ae({name:Ee.name,description:Ee.description,...Ee.avatarShape!=null?{avatarShape:Ee.avatarShape}:{},...Ee.avatarColor!=null?{avatarColor:Ee.avatarColor}:{},resolveAvatar:()=>Promise.resolve(Ee.avatarPngBase64)})},[ae])';
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

function countAnchorOccurrences(source, anchor) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(anchor, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + anchor.length;
  }
}

function assertAvatarCatalogSourceState(source, direction) {
  if (typeof source !== "string") {
    throw new TypeError("Avatar catalog source must be a string");
  }
  const stockGeometry = countAnchorOccurrences(source, VENDOR_GEOMETRY_TAIL);
  const openGeometry = countAnchorOccurrences(source, OPENBOT_GEOMETRY_TAIL);
  const stockVisible = countAnchorOccurrences(source, VENDOR_VISIBLE_SHAPES);
  const openVisible = countAnchorOccurrences(source, OPENBOT_VISIBLE_SHAPES);
  const openDuplicate = openGeometry > 1 || openVisible > 1;
  const stockDuplicate = stockGeometry > 1 || stockVisible > 1;

  if (direction === "patch") {
    if (openDuplicate) {
      throw new Error("Avatar catalog replacement anchor is ambiguous: OpenBot registry");
    }
    if (openGeometry > 0 || openVisible > 0) {
      if (openGeometry === 1 && openVisible === 1 && stockGeometry === 0 && stockVisible === 0) {
        throw new Error("Avatar catalog is already patched");
      }
      throw new Error("Avatar catalog replacement anchors are mixed or partial");
    }
    if (stockDuplicate) {
      throw new Error("Avatar catalog replacement anchor is ambiguous: Grok registry");
    }
    if (stockGeometry !== 1 || stockVisible !== 1) {
      throw new Error("Avatar catalog patch anchor not found: Grok registry");
    }
    return;
  }

  if (stockGeometry > 0 || stockVisible > 0) {
    if (stockDuplicate) {
      throw new Error("Avatar catalog inverse anchor is ambiguous: Grok registry");
    }
    if (openGeometry > 0 || openVisible > 0) {
      throw new Error("Avatar catalog inverse anchors are mixed or partial");
    }
    throw new Error("Avatar catalog inverse requires OpenBot registry anchors");
  }
  if (openDuplicate) {
    throw new Error("Avatar catalog inverse anchor is ambiguous: OpenBot registry");
  }
  if (openGeometry !== 1 || openVisible !== 1) {
    throw new Error("Avatar catalog inverse anchor not found: OpenBot registry");
  }
}

function patchAvatarCatalogSource(source) {
  assertAvatarCatalogSourceState(source, "patch");
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
  assertAvatarCatalogSourceState(source, "reverse");
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

function mergeNewBotAvatarSelection(values, staged) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("New Bot create values must be an object");
  }
  if (staged !== null && staged !== undefined
    && (typeof staged !== "object" || Array.isArray(staged))) {
    throw new TypeError("New Bot avatar selection must be an object");
  }
  const next = { ...values };
  if (staged?.avatarShape !== undefined) {
    if (typeof staged.avatarShape !== "string" || !VISIBLE_AVATAR_SHAPES.includes(staged.avatarShape)) {
      throw new Error("New Bot avatar shape is unavailable");
    }
    next.avatarShape = staged.avatarShape;
  }
  if (staged?.avatarColor !== undefined) {
    if (typeof staged.avatarColor !== "string" || !AVATAR_COLORS.includes(staged.avatarColor)) {
      throw new Error("New Bot avatar color is unavailable");
    }
    next.avatarColor = staged.avatarColor;
  }
  return next;
}

function assertNewBotAvatarPickerSourceState(source, direction) {
  if (typeof source !== "string") {
    throw new TypeError("New Bot avatar picker source must be a string");
  }
  const stockRegistry = countAnchorOccurrences(source, VENDOR_VISIBLE_SHAPES);
  const openRegistry = countAnchorOccurrences(source, OPENBOT_VISIBLE_SHAPES);
  const picker = countAnchorOccurrences(source, OPENBOT_NEW_BOT_AVATAR_PICKER);
  const adjacent = countAnchorOccurrences(source, `${OPENBOT_VISIBLE_SHAPES}${OPENBOT_NEW_BOT_AVATAR_PICKER}`);
  if (stockRegistry > 1 || openRegistry > 1 || (stockRegistry > 0 && openRegistry > 0)) {
    throw new Error("New Bot avatar picker registry anchor is mixed or ambiguous");
  }
  if (direction === "patch") {
    if (picker > 1) throw new Error("New Bot avatar picker anchor is ambiguous");
    if (picker === 1) throw new Error("New Bot avatar picker is already patched");
    if (openRegistry !== 1 || stockRegistry !== 0) {
      throw new Error("New Bot avatar picker registry anchor not found or ambiguous");
    }
    return;
  }
  if (picker !== 1 || adjacent !== 1 || openRegistry !== 1 || stockRegistry !== 0) {
    throw new Error("New Bot avatar picker inverse requires adjacent registry anchor");
  }
}

function patchNewBotAvatarPickerSource(source) {
  assertNewBotAvatarPickerSourceState(source, "patch");
  return replaceUnique(
    source,
    OPENBOT_VISIBLE_SHAPES,
    `${OPENBOT_VISIBLE_SHAPES}${OPENBOT_NEW_BOT_AVATAR_PICKER}`,
    "Grok New Bot avatar picker",
  );
}

function reverseNewBotAvatarPickerSource(source) {
  assertNewBotAvatarPickerSourceState(source, "reverse");
  return replaceUnique(
    source,
    `${OPENBOT_VISIBLE_SHAPES}${OPENBOT_NEW_BOT_AVATAR_PICKER}`,
    OPENBOT_VISIBLE_SHAPES,
    "OpenBot New Bot avatar picker",
  );
}

function patchNewBotCharacterEditorSource(source, allowAbsent = false) {
  if (typeof source !== "string") {
    throw new TypeError("New Bot character editor source must be a string");
  }
  const stockPrefix = countAnchorOccurrences(source, VENDOR_NEW_BOT_CHARACTER_EDITOR_PREFIX);
  const openPrefix = countAnchorOccurrences(source, OPENBOT_NEW_BOT_CHARACTER_EDITOR_PREFIX);
  const endAnchors = countAnchorOccurrences(source, NEW_BOT_CHARACTER_EDITOR_END);
  if (stockPrefix === 0 && openPrefix === 0) {
    if (endAnchors > 0) {
      throw new Error("New Bot character editor end anchor is orphaned or ambiguous");
    }
    if (allowAbsent) return source;
    throw new Error("New Bot character editor anchor not found");
  }
  if (stockPrefix > 1 || openPrefix > 1) {
    throw new Error("New Bot character editor anchor is ambiguous");
  }
  if (openPrefix > 0) {
    if (stockPrefix > 0) throw new Error("New Bot character editor anchors are mixed");
    throw new Error("New Bot character editor is already patched");
  }
  if (endAnchors !== 1) {
    throw new Error(endAnchors === 0
      ? "New Bot character editor end anchor not found"
      : "New Bot character editor end anchor is ambiguous");
  }
  const start = source.indexOf(VENDOR_NEW_BOT_CHARACTER_EDITOR_PREFIX);
  const end = source.indexOf(NEW_BOT_CHARACTER_EDITOR_END, start);
  if (start < 0 || end < start) {
    throw new Error("New Bot character editor end anchor not found");
  }
  const segment = source.slice(start, end);
  const shapeActive = countAnchorOccurrences(segment, VENDOR_NEW_BOT_CHARACTER_SHAPE_ACTIVE);
  const colorActive = countAnchorOccurrences(segment, VENDOR_NEW_BOT_CHARACTER_COLOR_ACTIVE);
  const shapeCacheCheck = countAnchorOccurrences(segment, VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK);
  const shapeCacheAssign = countAnchorOccurrences(segment, VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN);
  const colorCacheCheck = countAnchorOccurrences(segment, VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK);
  const colorCacheAssign = countAnchorOccurrences(segment, VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN);
  if (shapeActive !== 1 || colorActive !== 3
    || shapeCacheCheck !== 1 || shapeCacheAssign !== 1
    || colorCacheCheck !== 1 || colorCacheAssign !== 1) {
    throw new Error("New Bot character editor choice anchors are missing or ambiguous");
  }
  let patchedSegment = replaceUnique(
    segment,
    VENDOR_NEW_BOT_CHARACTER_EDITOR_PREFIX,
    OPENBOT_NEW_BOT_CHARACTER_EDITOR_PREFIX,
    "Grok Sand character editor props",
  );
  patchedSegment = replaceUnique(
    patchedSegment,
    VENDOR_NEW_BOT_CHARACTER_SHAPE_ACTIVE,
    OPENBOT_NEW_BOT_CHARACTER_SHAPE_ACTIVE,
    "Grok Sand shape pressed state",
  );
  patchedSegment = patchedSegment.replaceAll(
    VENDOR_NEW_BOT_CHARACTER_COLOR_ACTIVE,
    OPENBOT_NEW_BOT_CHARACTER_COLOR_ACTIVE,
  );
  patchedSegment = replaceUnique(
    patchedSegment,
    VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK,
    OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK,
    "Grok Sand shape cache dependency",
  );
  patchedSegment = replaceUnique(
    patchedSegment,
    VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN,
    OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN,
    "Grok Sand shape cache key",
  );
  patchedSegment = replaceUnique(
    patchedSegment,
    VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK,
    OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK,
    "Grok Sand color cache dependency",
  );
  patchedSegment = replaceUnique(
    patchedSegment,
    VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN,
    OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN,
    "Grok Sand color cache key",
  );
  return `${source.slice(0, start)}${patchedSegment}${source.slice(end)}`;
}

function reverseNewBotCharacterEditorSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("New Bot character editor source must be a string");
  }
  const stockPrefix = countAnchorOccurrences(source, VENDOR_NEW_BOT_CHARACTER_EDITOR_PREFIX);
  const openPrefix = countAnchorOccurrences(source, OPENBOT_NEW_BOT_CHARACTER_EDITOR_PREFIX);
  const endAnchors = countAnchorOccurrences(source, NEW_BOT_CHARACTER_EDITOR_END);
  if (endAnchors === 0) throw new Error("New Bot character editor end anchor not found");
  if (endAnchors > 1 || stockPrefix > 1 || openPrefix > 1) {
    throw new Error("New Bot character editor inverse anchor is ambiguous");
  }
  if (stockPrefix > 0 && openPrefix > 0) {
    throw new Error("New Bot character editor inverse anchors are mixed");
  }
  if (stockPrefix === 1) {
    throw new Error("New Bot character editor is already reversed");
  }
  if (openPrefix !== 1) {
    throw new Error("New Bot character editor inverse anchor not found");
  }
  const start = source.indexOf(OPENBOT_NEW_BOT_CHARACTER_EDITOR_PREFIX);
  const end = source.indexOf(NEW_BOT_CHARACTER_EDITOR_END, start);
  if (start < 0 || end < start) {
    throw new Error("New Bot character editor inverse end anchor not found");
  }
  const segment = source.slice(start, end);
  const shapeActive = countAnchorOccurrences(segment, OPENBOT_NEW_BOT_CHARACTER_SHAPE_ACTIVE);
  const colorActive = countAnchorOccurrences(segment, OPENBOT_NEW_BOT_CHARACTER_COLOR_ACTIVE);
  const shapeCacheCheck = countAnchorOccurrences(segment, OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK);
  const shapeCacheAssign = countAnchorOccurrences(segment, OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN);
  const colorCacheCheck = countAnchorOccurrences(segment, OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK);
  const colorCacheAssign = countAnchorOccurrences(segment, OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN);
  if (shapeActive !== 1 || colorActive !== 3
    || shapeCacheCheck !== 1 || shapeCacheAssign !== 1
    || colorCacheCheck !== 1 || colorCacheAssign !== 1) {
    throw new Error("New Bot character editor inverse choice anchors are missing or ambiguous");
  }
  let reversedSegment = replaceUnique(
    segment,
    OPENBOT_NEW_BOT_CHARACTER_EDITOR_PREFIX,
    VENDOR_NEW_BOT_CHARACTER_EDITOR_PREFIX,
    "OpenBot Sand character editor props",
  );
  reversedSegment = replaceUnique(
    reversedSegment,
    OPENBOT_NEW_BOT_CHARACTER_SHAPE_ACTIVE,
    VENDOR_NEW_BOT_CHARACTER_SHAPE_ACTIVE,
    "OpenBot Sand shape pressed state",
  );
  reversedSegment = reversedSegment.replaceAll(
    OPENBOT_NEW_BOT_CHARACTER_COLOR_ACTIVE,
    VENDOR_NEW_BOT_CHARACTER_COLOR_ACTIVE,
  );
  reversedSegment = replaceUnique(
    reversedSegment,
    OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK,
    VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_CHECK,
    "OpenBot Sand shape cache dependency",
  );
  reversedSegment = replaceUnique(
    reversedSegment,
    OPENBOT_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN,
    VENDOR_NEW_BOT_CHARACTER_SHAPE_CACHE_ASSIGN,
    "OpenBot Sand shape cache key",
  );
  reversedSegment = replaceUnique(
    reversedSegment,
    OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK,
    VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_CHECK,
    "OpenBot Sand color cache dependency",
  );
  reversedSegment = replaceUnique(
    reversedSegment,
    OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN,
    VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN,
    "OpenBot Sand color cache key",
  );
  return `${source.slice(0, start)}${reversedSegment}${source.slice(end)}`;
}

function patchNewBotCreatePayloadSource(source, allowAbsent = false) {
  if (typeof source !== "string") throw new TypeError("New Bot create payload source must be a string");
  const stockResolve = countAnchorOccurrences(source, VENDOR_NEW_BOT_CREATE_RESOLVE);
  const openResolve = countAnchorOccurrences(source, OPENBOT_NEW_BOT_CREATE_RESOLVE);
  const stockDispatch = countAnchorOccurrences(source, VENDOR_NEW_BOT_CREATE_DISPATCH);
  const openDispatch = countAnchorOccurrences(source, OPENBOT_NEW_BOT_CREATE_DISPATCH);
  const present = stockResolve + openResolve + stockDispatch + openDispatch;
  if (present === 0) {
    if (allowAbsent) return source;
    throw new Error("New Bot create payload anchors not found");
  }
  if ([stockResolve, openResolve, stockDispatch, openDispatch].some((count) => count > 1)) {
    throw new Error("New Bot create payload anchor is ambiguous");
  }
  if (openResolve > 0 || openDispatch > 0) {
    throw new Error("New Bot create payload anchors are already patched or mixed");
  }
  if (stockResolve !== 1 || stockDispatch !== 1) {
    throw new Error("New Bot create payload anchors are missing or mixed");
  }
  let patched = replaceUnique(
    source,
    VENDOR_NEW_BOT_CREATE_RESOLVE,
    OPENBOT_NEW_BOT_CREATE_RESOLVE,
    "Grok New Bot create payload",
  );
  return replaceUnique(
    patched,
    VENDOR_NEW_BOT_CREATE_DISPATCH,
    OPENBOT_NEW_BOT_CREATE_DISPATCH,
    "Grok New Bot create forwarding",
  );
}

function reverseNewBotCreatePayloadSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("New Bot create payload source must be a string");
  }
  const stockResolve = countAnchorOccurrences(source, VENDOR_NEW_BOT_CREATE_RESOLVE);
  const openResolve = countAnchorOccurrences(source, OPENBOT_NEW_BOT_CREATE_RESOLVE);
  const stockDispatch = countAnchorOccurrences(source, VENDOR_NEW_BOT_CREATE_DISPATCH);
  const openDispatch = countAnchorOccurrences(source, OPENBOT_NEW_BOT_CREATE_DISPATCH);
  if ([stockResolve, openResolve, stockDispatch, openDispatch].some((count) => count > 1)) {
    throw new Error("New Bot create payload inverse anchor is ambiguous");
  }
  if (stockResolve === 1 && stockDispatch === 1 && openResolve === 0 && openDispatch === 0) {
    throw new Error("New Bot create payload is already reversed");
  }
  if (openResolve === 1 && openDispatch === 1 && stockResolve === 0 && stockDispatch === 0) {
    let reversed = replaceUnique(
      source,
      OPENBOT_NEW_BOT_CREATE_RESOLVE,
      VENDOR_NEW_BOT_CREATE_RESOLVE,
      "OpenBot New Bot create payload",
    );
    return replaceUnique(
      reversed,
      OPENBOT_NEW_BOT_CREATE_DISPATCH,
      VENDOR_NEW_BOT_CREATE_DISPATCH,
      "OpenBot New Bot create forwarding",
    );
  }
  const present = stockResolve + openResolve + stockDispatch + openDispatch;
  if (present === 0) throw new Error("New Bot create payload inverse anchors not found");
  throw new Error("New Bot create payload inverse anchors are mixed or missing");
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
  patched = patchNewBotAvatarPickerSource(patched);
  patched = patchNewBotCharacterEditorSource(
    patched,
    expectedSha256 !== VENDOR_RENDERER_ASSET_SHA256,
  );
  patched = patchNewBotCreatePayloadSource(
    patched,
    expectedSha256 !== VENDOR_RENDERER_ASSET_SHA256,
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
  OPENBOT_NEW_BOT_COMMIT,
  OPENBOT_NEW_BOT_AVATAR_PICKER,
  OPENBOT_NEW_BOT_CREATE_DISPATCH,
  OPENBOT_NEW_BOT_CREATE_RESOLVE,
  OPENBOT_VISIBLE_SHAPES,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_RENDERER_ASSET,
  VENDOR_RENDERER_ASSET_SHA256,
  VENDOR_SETTINGS_ASSET,
  VENDOR_SETTINGS_ASSET_SHA256,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarCatalogSource,
  patchNewBotCharacterEditorSource,
  patchNewBotAvatarPickerSource,
  patchNewBotCreatePayloadSource,
  patchRenderer,
  patchRendererIndexSource,
  patchVendorRendererSource,
  patchVendorSettingsSource,
  reverseAvatarCatalogSource,
  reverseNewBotCharacterEditorSource,
  reverseNewBotCreatePayloadSource,
  reverseNewBotAvatarPickerSource,
  mergeNewBotAvatarSelection,
};
