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
const DOG_AVATAR_ACCENT_PATH = "M104 156Q114 150 124 156Q123 166 114 171Q105 166 104 156Z";
const OWL_AVATAR_ACCENT_PATH = "M107 168L121 168L114 184Z";
const OPENBOT_ADDED_GEOMETRIES = `
cat:qo("Cat","M40 130Q38 112 40 86L45 48Q46 42 51 47L76 71Q94 62 114 64Q134 62 152 71L177 47Q182 42 183 48L188 86Q190 112 188 130Q182 153 161 164Q139 175 114 176Q89 175 67 164Q46 153 40 130Z"),
dog:qo("Dog","M114 28C88 26 72 42 68 64C52 52 36 54 24 68C12 84 14 112 28 134Q38 150 52 138Q62 128 66 110C62 140 72 168 92 184C100 192 128 192 136 184C156 168 166 140 162 110Q166 128 176 138Q190 150 200 134C214 112 216 84 204 68C192 54 176 52 160 64C156 42 140 26 114 28Z",{accentPath:"${DOG_AVATAR_ACCENT_PATH}"}),
wolf:qo("Wolf","M50 124Q42 104 46 82L56 40Q58 30 66 40L84 66Q98 58 114 60Q130 58 144 66L162 40Q170 30 172 40L182 82Q186 104 178 124Q190 132 198 144Q201 154 186 160Q176 166 158 166Q152 188 138 182Q130 208 114 216Q98 208 90 182Q76 188 70 166Q52 166 42 160Q27 154 30 144Q38 132 50 124Z"),
bunny:qo("Bunny","M57 120Q52 106 54 86L56 34Q56 20 64 27Q79 41 84 75Q98 67 114 67Q130 67 144 75Q149 41 164 27Q172 20 172 34L174 86Q176 106 171 120Q186 130 181 146Q172 169 149 180Q132 189 114 191Q96 189 79 180Q56 169 47 146Q42 130 57 120Z"),
fox:qo("Fox","M44 124Q34 102 46 80L34 28Q32 18 43 24L84 62Q99 52 114 56Q129 52 144 62L185 24Q196 18 194 28L182 80Q194 102 184 124Q180 150 164 170Q150 186 130 194Q121 203 114 208Q107 203 98 194Q78 186 64 170Q48 150 44 124Z"),
bear:qo("Bear","M70 75Q54 68 56 50Q58 34 70 34Q82 34 89 48Q100 42 114 42Q128 42 139 48Q146 34 158 34Q170 34 172 50Q174 68 158 75Q181 92 188 119Q195 148 176 171Q157 191 136 188Q125 198 114 198Q103 198 92 188Q71 191 52 171Q33 148 40 119Q47 92 70 75Z"),
owl:qo("Owl","M114 64Q92 28 74 42Q62 34 54 32Q44 28 46 40Q48 50 56 58L52 58Q14 108 22 126Q32 138 44 140Q26 154 34 170Q46 186 70 202Q88 206 102 202Q114 210 126 202Q140 206 158 202Q182 186 194 170Q202 154 184 140Q196 138 204 126Q214 108 204 90Q198 66 176 58Q178 50 180 40Q182 28 172 32Q164 34 152 42Q136 28 114 64Z",{accentPath:"${OWL_AVATAR_ACCENT_PATH}"}),
jelly:qo("Jelly","M32 118Q32 82 56 56Q80 28 114 28Q148 28 172 56Q196 82 196 118Q196 132 186 140Q178 146 170 142Q166 158 166 176Q164 194 154 194Q144 194 142 176Q140 158 134 148Q128 166 128 188Q126 208 116 208Q106 204 106 184Q106 164 100 148Q94 158 92 176Q90 194 80 194Q70 194 68 176Q66 158 64 142Q56 146 48 140Q38 132 32 118Z"),
terminal:qo("Terminal","M50 32Q36 32 36 46L36 138Q36 152 50 152L82 152L76 176Q74 184 84 184L144 184Q154 184 152 176L146 152L178 152Q192 152 192 138L192 46Q192 32 178 32Z"),
robot:qo("Robot","M108 22Q114 15 120 22L120 38L146 38Q160 38 168 52L168 62L180 62Q192 62 192 74L192 104Q192 116 180 116L164 116L164 150Q164 164 152 170L138 170L138 194Q138 202 130 202L98 202Q90 202 90 194L90 170L76 170Q64 164 64 150L64 116L48 116Q36 116 36 104L36 74Q36 62 48 62L58 62L58 52Q66 38 82 38L108 38Z"),
microchip:qo("Microchip","M62 38Q48 38 48 52L48 64L34 64L34 76L48 76L48 92L34 92L34 104L48 104L48 120L34 120L34 132L48 132L48 146L34 146L34 158L48 158L48 170Q48 184 62 184L76 184L76 198L88 198L88 184L104 184L104 198L116 198L116 184L132 184L132 198L144 198L144 184L160 184L160 198L172 198L172 184Q186 184 186 170L186 158L200 158L200 146L186 146L186 132L200 132L200 120L186 120L186 104L200 104L200 92L186 92L186 76L200 76L200 64L186 64L186 52Q186 38 172 38L160 38L160 24L148 24L148 38L132 38L132 24L120 24L120 38L104 38L104 24L92 24L92 38L76 38L76 24L64 24L64 38Z"),
drone:qo("Drone","M98 46Q114 34 130 46L136 62L160 62Q164 48 178 48Q194 48 198 64Q202 80 190 90Q180 98 166 92L150 108L150 120L166 136Q180 130 190 138Q202 148 198 164Q194 180 178 180Q164 180 160 166L136 166L130 184Q114 196 98 184L92 166L68 166Q64 180 50 180Q34 180 30 164Q26 148 38 138Q48 130 62 136L78 120L78 108L62 92Q48 98 38 90Q26 80 30 64Q34 48 50 48Q64 48 68 62L92 62Z")`;
const OPENBOT_GEOMETRY_TAIL = VENDOR_GEOMETRY_TAIL.replace(
  'leaf:qo("Leaf",vBt(88,113,1.5))};',
  `leaf:qo("Leaf",vBt(88,113,1.5)),${OPENBOT_ADDED_GEOMETRIES}};`,
);
const VENDOR_AVATAR_ACCENT_REF = 'const K=x.useRef(null),G=x.useRef(null);';
const OPENBOT_AVATAR_ACCENT_REF =
  'const K=x.useRef(null),G=x.useRef(null),openbotAccentRef=x.useRef(null);';
const VENDOR_AVATAR_ACCENT_MORPH = 'const Jn=e3(Wn(Ee.x,0,1)),Mn=Jn<.999;';
const OPENBOT_AVATAR_ACCENT_MORPH =
  'const Jn=e3(Wn(Ee.x,0,1));const Mn=Jn<.999;openbotAccentRef.current&&(openbotAccentRef.current.setAttribute("d",yn.accentPath??""),openbotAccentRef.current.style.display=Mn&&!oe||!yn.accentPath?"none":"");';
const VENDOR_AVATAR_ACCENT_FACE =
  'p.jsxs("g",{clipPath:`url(#${N})`,children:[p.jsx("path",{style:fze,ref:oe=>{Q.current[0]=oe}}),p.jsx("path",{style:fze,ref:oe=>{Q.current[1]=oe}})]})';
const OPENBOT_AVATAR_ACCENT_FACE =
  'p.jsx("path",{ref:openbotAccentRef,style:{...fze,display:ae.accentPath&&(d||window.matchMedia("(prefers-reduced-motion: reduce)").matches||K.current==null||K.current.getAttribute("d")===ae.path)?"":"none"},d:ae.accentPath??""}),p.jsxs("g",{children:[p.jsx("path",{style:fze,ref:oe=>{Q.current[0]=oe}}),p.jsx("path",{style:fze,ref:oe=>{Q.current[1]=oe}})],clipPath:`url(#${N})`})';
const VENDOR_AVATAR_ACCENT_STATIC = 'm=`${o.path} ${Oje(l,u)} ${Oje(c,d)}`';
const OPENBOT_AVATAR_ACCENT_STATIC = 'm=`${o.path} ${o.accentPath??""} ${Oje(l,u)} ${Oje(c,d)}`';
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
const VENDOR_UPDATE_BLOCKER = 'function NYn(){const{status:n}=eme(),{check:e,isPending:t}=Qnt(),{quitAndInstall:s,isPending:r}=bJt();if(n==null||!n.isBelowMinimumVersion)return null;const i=n.state;let o;if(i.type==="ready"){const d=i.version;o=p.jsx(Ls,{disabled:r,onClick:()=>{Yf({surface:"blocker",action:"clicked",kind:"ready",targetVersion:d}),s(d)},type:"button",variant:"primary",children:r?p.jsx(Re,{id:"fvg2KT"}):p.jsx(Re,{id:"FzpXvM"})})}else if(SYn(i)){const d=xYn(i),m={className:"sand-78zum5 sand-6s0dn4 sand-ehausa sand-e0p6wg"};o=p.jsxs("div",{...m,"aria-label":d,role:"status",children:[p.jsx(_Z,{size:16}),p.jsx(yt,{color:"tertiary",size:"sm",children:d})]})}else{const d=i.type==="idle"&&i.lastCheck?.result==="error";o=p.jsxs(p.Fragment,{children:[d?p.jsx(yt,{as:"p",color:"tertiary",size:"sm",children:p.jsx(Re,{id:"QAfOI6"})}):null,p.jsx(Ls,{disabled:t,onClick:()=>{Yf({surface:"blocker",action:"clicked",kind:d?"error":"check"}),e()},type:"button",variant:"primary",children:d?p.jsx(Re,{id:"KDw4GX"}):p.jsx(Re,{id:"EkH9pt"})})]})}const l={className:"sand-ixxii4 sand-10a8y8t sand-1q2oy4v sand-78zum5 sand-6s0dn4 sand-l56j7k sand-jcuf1o sand-9f619 sand-1ua6jya"},c={className:"sand-78zum5 sand-dt5ytf sand-6s0dn4 sand-2b8uid sand-1jlwbde sand-1j9u4d2 sand-1h75b27 sand-1vnydn9 sand-1pkpdue sand-mkeg23 sand-1y0btm7 sand-13747pv sand-cq4si4"},u={className:"sand-78zum5 sand-dt5ytf sand-6s0dn4 sand-11twubx"};return p.jsx("div",{...l,className:ie("sand-update-required",l.className),children:p.jsxs("div",{...c,role:"alert",children:[p.jsxs("div",{...u,children:[p.jsx(yt,{as:"p",size:"lg",weight:"medium",children:p.jsx(Re,{id:"zBrSTo"})}),p.jsx(yt,{as:"p",color:"tertiary",size:"sm",children:p.jsx(Re,{id:"iZCiGL",values:{0:n.currentVersion,SAND_PRODUCT_DISPLAY_NAME:cZ}})})]}),o]})})}Hqn();';
const OPENBOT_UPDATE_BLOCKER = `function NYn(){if(${OPENBOT_LOCAL_COORDINATOR_PREDICATE})return null;${VENDOR_UPDATE_BLOCKER.slice('function NYn(){'.length)}`;
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
  'function M4n(n){const e=ye.c(32),{agent:t,character:s,staged:r,isCharacterActive:i,shapeIsExplicit:a=i,colorIsExplicit:v=i}=n';
const VENDOR_NEW_BOT_CHARACTER_SHAPE_ACTIVE = 'const O=i&&f===M';
const OPENBOT_NEW_BOT_CHARACTER_SHAPE_ACTIVE = 'const O=a&&f===M';
const VENDOR_NEW_BOT_CHARACTER_COLOR_ACTIVE = 'i&&d===M.id';
const OPENBOT_NEW_BOT_CHARACTER_COLOR_ACTIVE = 'v&&d===M.id';
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
  'e[21]!==o||e[22]!==l||e[23]!==i+"|"+v||e[24]!==d?';
const VENDOR_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN =
  'e[21]=o,e[22]=l,e[23]=i,e[24]=d,e[25]=C';
const OPENBOT_NEW_BOT_CHARACTER_COLOR_CACHE_ASSIGN =
  'e[21]=o,e[22]=l,e[23]=i+"|"+v,e[24]=d,e[25]=C';
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
const VENDOR_BOT_OVERVIEW_COMPUTER =
  'children:[l,S?p.jsx(b4n,{agent:t,onOpenAgentChat:f}):null';
const OPENBOT_BOT_OVERVIEW_COMPUTER =
  'children:[window.openbotProtocol?.schemaVersion===1&&window.openbotProtocol?.mode==="local-protocol"?p.jsx("div",{"data-openbot-bot-overview-computer-host":!0}):l,S?p.jsx(b4n,{agent:t,onOpenAgentChat:f}):null';
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

function parseAvatarAccentPath(pathSource, label) {
  if (typeof pathSource !== "string" || pathSource.length < 8 || pathSource.length > 512) {
    throw new TypeError(`Avatar accent path is invalid for ${label}`);
  }
  const compact = pathSource.replace(/[\s,]+/g, "");
  const tokens = pathSource.match(/[MLQCZ]|-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? [];
  if (tokens.join("") !== compact) {
    throw new Error(`Avatar accent path contains unsupported syntax for ${label}`);
  }
  const arity = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  const commands = [];
  let index = 0;
  while (index < tokens.length) {
    const type = tokens[index++];
    if (!(type in arity)) {
      throw new Error(`Avatar accent path contains an unsupported command for ${label}`);
    }
    const values = [];
    for (let valueIndex = 0; valueIndex < arity[type]; valueIndex += 1) {
      const token = tokens[index++];
      if (token === undefined || token in arity) {
        throw new Error(`Avatar accent path has invalid command arity for ${label}`);
      }
      const value = Number(token);
      if (!Number.isFinite(value)) {
        throw new Error(`Avatar accent path has a non-finite coordinate for ${label}`);
      }
      values.push(value);
    }
    if (index < tokens.length && !(tokens[index] in arity)) {
      throw new Error(`Avatar accent path uses implicit coordinates for ${label}`);
    }
    commands.push({ type, values });
  }
  return commands;
}

function avatarAccentSamples(commands, steps = 12) {
  const samples = [];
  let start = null;
  let current = null;
  for (const { type, values } of commands) {
    if (type === "M") {
      current = { x: values[0], y: values[1] };
      start = { ...current };
      samples.push({ ...current });
      continue;
    }
    if (type === "Z") {
      samples.push({ ...start });
      current = { ...start };
      continue;
    }
    const from = current;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const inverse = 1 - t;
      if (type === "L") {
        current = { x: from.x + (values[0] - from.x) * t, y: from.y + (values[1] - from.y) * t };
      } else if (type === "Q") {
        current = {
          x: inverse * inverse * from.x + 2 * inverse * t * values[0] + t * t * values[2],
          y: inverse * inverse * from.y + 2 * inverse * t * values[1] + t * t * values[3],
        };
      } else {
        current = {
          x: inverse ** 3 * from.x + 3 * inverse * inverse * t * values[0]
            + 3 * inverse * t * t * values[2] + t ** 3 * values[4],
          y: inverse ** 3 * from.y + 3 * inverse * inverse * t * values[1]
            + 3 * inverse * t * t * values[3] + t ** 3 * values[5],
        };
      }
      samples.push({ ...current });
    }
  }
  return samples;
}

function avatarAccentSegmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const a = cross(firstStart, firstEnd, secondStart);
  const b = cross(firstStart, firstEnd, secondEnd);
  const c = cross(secondStart, secondEnd, firstStart);
  const d = cross(secondStart, secondEnd, firstEnd);
  return ((a > 1e-7 && b < -1e-7) || (a < -1e-7 && b > 1e-7))
    && ((c > 1e-7 && d < -1e-7) || (c < -1e-7 && d > 1e-7));
}

function validateAvatarAccentPath(pathSource, label = "avatar") {
  const commands = parseAvatarAccentPath(pathSource, label);
  if (commands[0]?.type !== "M" || commands.at(-1)?.type !== "Z"
    || commands.filter(({ type }) => type === "M").length !== 1
    || commands.filter(({ type }) => type === "Z").length !== 1) {
    throw new Error(`Avatar accent must be one closed subpath for ${label}`);
  }
  const coordinates = commands.flatMap(({ values }) => values);
  for (let index = 0; index < coordinates.length; index += 2) {
    const x = coordinates[index];
    const y = coordinates[index + 1];
    if (x < 54 || x > 174 || y < 120 || y > 184) {
      throw new Error(`Avatar accent exceeds the face-safe bounds for ${label}`);
    }
  }
  const samples = avatarAccentSamples(commands);
  const segments = samples.slice(1).map((point, index) => [samples[index], point]);
  for (let first = 0; first < segments.length; first += 1) {
    for (let second = first + 1; second < segments.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === segments.length - 1)) continue;
      if (avatarAccentSegmentsIntersect(...segments[first], ...segments[second])) {
        throw new Error(`Avatar accent self-intersects for ${label}`);
      }
    }
  }
  let area = 0;
  for (let index = 0; index < samples.length - 1; index += 1) {
    area += samples[index].x * samples[index + 1].y - samples[index + 1].x * samples[index].y;
  }
  if (Math.abs(area) / 2 < 20) {
    throw new Error(`Avatar accent is degenerate for ${label}`);
  }
  return pathSource;
}

function assertAvatarAccentSourceState(source, direction, allowAbsent) {
  if (typeof source !== "string") throw new TypeError("Avatar accent source must be a string");
  const vendor = [
    VENDOR_AVATAR_ACCENT_REF,
    VENDOR_AVATAR_ACCENT_MORPH,
    VENDOR_AVATAR_ACCENT_FACE,
    VENDOR_AVATAR_ACCENT_STATIC,
  ].map((anchor) => countAnchorOccurrences(source, anchor));
  const open = [
    OPENBOT_AVATAR_ACCENT_REF,
    OPENBOT_AVATAR_ACCENT_MORPH,
    OPENBOT_AVATAR_ACCENT_FACE,
    OPENBOT_AVATAR_ACCENT_STATIC,
  ].map((anchor) => countAnchorOccurrences(source, anchor));
  if (vendor.some((count) => count > 1) || open.some((count) => count > 1)) {
    throw new Error("Avatar accent anchor is ambiguous");
  }
  const vendorCount = vendor.reduce((sum, count) => sum + count, 0);
  const openCount = open.reduce((sum, count) => sum + count, 0);
  if (direction === "patch") {
    if (vendorCount === 0 && openCount === 0 && allowAbsent) return false;
    if (vendorCount === 4 && openCount === 0) return true;
    if (vendorCount === 0 && openCount === 4) throw new Error("Avatar accent is already patched");
    if (vendorCount === 0 && openCount === 0) throw new Error("Avatar accent anchors not found");
    throw new Error("Avatar accent anchors are mixed or missing");
  }
  if (openCount === 4 && vendorCount === 0) return true;
  if (vendorCount === 4 && openCount === 0) throw new Error("Avatar accent inverse requires patched anchors");
  if (vendorCount === 0 && openCount === 0) throw new Error("Avatar accent inverse anchors not found");
  throw new Error("Avatar accent inverse anchors are mixed or missing");
}

function patchAvatarAccentSource(source, allowAbsent = false) {
  if (!assertAvatarAccentSourceState(source, "patch", allowAbsent)) return source;
  validateAvatarAccentPath(DOG_AVATAR_ACCENT_PATH, "dog");
  validateAvatarAccentPath(OWL_AVATAR_ACCENT_PATH, "owl");
  let patched = source;
  for (const [vendor, open, label] of [
    [VENDOR_AVATAR_ACCENT_REF, OPENBOT_AVATAR_ACCENT_REF, "Sand accent ref"],
    [VENDOR_AVATAR_ACCENT_MORPH, OPENBOT_AVATAR_ACCENT_MORPH, "Sand accent morph"],
    [VENDOR_AVATAR_ACCENT_FACE, OPENBOT_AVATAR_ACCENT_FACE, "Sand accent face"],
    [VENDOR_AVATAR_ACCENT_STATIC, OPENBOT_AVATAR_ACCENT_STATIC, "Sand accent static"],
  ]) patched = replaceUnique(patched, vendor, open, label);
  return patched;
}

function reverseAvatarAccentSource(source) {
  assertAvatarAccentSourceState(source, "reverse", false);
  let reversed = source;
  for (const [open, vendor, label] of [
    [OPENBOT_AVATAR_ACCENT_STATIC, VENDOR_AVATAR_ACCENT_STATIC, "OpenBot Sand accent static"],
    [OPENBOT_AVATAR_ACCENT_FACE, VENDOR_AVATAR_ACCENT_FACE, "OpenBot Sand accent face"],
    [OPENBOT_AVATAR_ACCENT_MORPH, VENDOR_AVATAR_ACCENT_MORPH, "OpenBot Sand accent morph"],
    [OPENBOT_AVATAR_ACCENT_REF, VENDOR_AVATAR_ACCENT_REF, "OpenBot Sand accent ref"],
  ]) reversed = replaceUnique(reversed, open, vendor, label);
  return reversed;
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

function patchBotOverviewSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("Bot overview source must be a string");
  }
  const stock = countAnchorOccurrences(source, VENDOR_BOT_OVERVIEW_COMPUTER);
  const openbot = countAnchorOccurrences(source, OPENBOT_BOT_OVERVIEW_COMPUTER);
  if (stock > 1 || openbot > 1) {
    throw new Error("Bot overview anchor is ambiguous");
  }
  if (openbot > 0) {
    throw new Error("Bot overview is already patched or mixed");
  }
  if (stock !== 1) {
    throw new Error("Bot overview anchor not found");
  }
  return replaceUnique(
    source,
    VENDOR_BOT_OVERVIEW_COMPUTER,
    OPENBOT_BOT_OVERVIEW_COMPUTER,
    "Grok native View Bot overview Computer host",
  );
}

function reverseBotOverviewSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("Bot overview source must be a string");
  }
  const stock = countAnchorOccurrences(source, VENDOR_BOT_OVERVIEW_COMPUTER);
  const openbot = countAnchorOccurrences(source, OPENBOT_BOT_OVERVIEW_COMPUTER);
  if (stock > 1 || openbot > 1) {
    throw new Error("Bot overview inverse anchor is ambiguous");
  }
  if (stock > 0 && openbot > 0) {
    throw new Error("Bot overview inverse anchors are mixed");
  }
  if (stock === 1) {
    throw new Error("Bot overview is already reversed");
  }
  if (openbot !== 1) {
    throw new Error("Bot overview inverse anchor not found");
  }
  return replaceUnique(
    source,
    OPENBOT_BOT_OVERVIEW_COMPUTER,
    VENDOR_BOT_OVERVIEW_COMPUTER,
    "OpenBot native View Bot overview Computer host",
  );
}

function patchVendorUpdateBlockerSource(source, allowAbsent = false) {
  if (typeof source !== "string") {
    throw new TypeError("Grok update blocker source must be a string");
  }
  const stock = source.split(VENDOR_UPDATE_BLOCKER).length - 1;
  const openbot = source.split(OPENBOT_UPDATE_BLOCKER).length - 1;
  if (stock > 1 || openbot > 1) {
    throw new Error("Grok update blocker anchor is ambiguous");
  }
  if (stock === 1 && openbot === 0) {
    return replaceUnique(
      source,
      VENDOR_UPDATE_BLOCKER,
      OPENBOT_UPDATE_BLOCKER,
      "Grok NYn update blocker",
    );
  }
  if (stock === 0 && openbot === 1) {
    throw new Error("Grok update blocker is already patched");
  }
  if (stock === 0 && openbot === 0 && allowAbsent) return source;
  if (stock === 0 && openbot === 0) {
    throw new Error("Grok NYn update blocker anchor not found");
  }
  throw new Error("Grok update blocker anchors are mixed");
}

function reverseVendorUpdateBlockerSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("OpenBot update blocker source must be a string");
  }
  const stock = source.split(VENDOR_UPDATE_BLOCKER).length - 1;
  const openbot = source.split(OPENBOT_UPDATE_BLOCKER).length - 1;
  if (stock > 1 || openbot > 1) {
    throw new Error("OpenBot update blocker inverse anchor is ambiguous");
  }
  if (stock === 1 && openbot === 0) {
    throw new Error("Grok update blocker is already reversed");
  }
  if (stock === 0 && openbot === 1) {
    return replaceUnique(
      source,
      OPENBOT_UPDATE_BLOCKER,
      VENDOR_UPDATE_BLOCKER,
      "OpenBot NYn update blocker",
    );
  }
  if (stock === 0 && openbot === 0) {
    throw new Error("OpenBot update blocker inverse anchor not found");
  }
  throw new Error("OpenBot update blocker inverse anchors are mixed");
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
  let patched = patchVendorUpdateBlockerSource(
    source,
    expectedSha256 !== VENDOR_RENDERER_ASSET_SHA256,
  );
  patched = patchAvatarCatalogSource(patched);
  patched = patchAvatarAccentSource(
    patched,
    expectedSha256 !== VENDOR_RENDERER_ASSET_SHA256,
  );
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
  patched = patchBotOverviewSource(patched);
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
  DOG_AVATAR_ACCENT_PATH,
  OPENBOT_AVATAR_ACCENT_FACE,
  OPENBOT_AVATAR_ACCENT_MORPH,
  OPENBOT_AVATAR_ACCENT_REF,
  OPENBOT_AVATAR_ACCENT_STATIC,
  OPENBOT_GEOMETRY_TAIL,
  OPENBOT_NEW_BOT_COMMIT,
  OPENBOT_NEW_BOT_AVATAR_PICKER,
  OPENBOT_NEW_BOT_CREATE_DISPATCH,
  OPENBOT_NEW_BOT_CREATE_RESOLVE,
  OPENBOT_VISIBLE_SHAPES,
  OWL_AVATAR_ACCENT_PATH,
  VENDOR_AVATAR_ACCENT_FACE,
  VENDOR_AVATAR_ACCENT_MORPH,
  VENDOR_AVATAR_ACCENT_REF,
  VENDOR_AVATAR_ACCENT_STATIC,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_RENDERER_ASSET,
  VENDOR_RENDERER_ASSET_SHA256,
  VENDOR_SETTINGS_ASSET,
  VENDOR_SETTINGS_ASSET_SHA256,
  VENDOR_UPDATE_BLOCKER,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarAccentSource,
  patchAvatarCatalogSource,
  patchNewBotCharacterEditorSource,
  patchNewBotAvatarPickerSource,
  patchNewBotCreatePayloadSource,
  patchBotOverviewSource,
  patchRenderer,
  patchRendererIndexSource,
  patchVendorRendererSource,
  patchVendorSettingsSource,
  patchVendorUpdateBlockerSource,
  reverseAvatarAccentSource,
  reverseAvatarCatalogSource,
  reverseNewBotCharacterEditorSource,
  reverseNewBotCreatePayloadSource,
  reverseNewBotAvatarPickerSource,
  reverseBotOverviewSource,
  reverseVendorUpdateBlockerSource,
  OPENBOT_UPDATE_BLOCKER,
  validateAvatarAccentPath,
  mergeNewBotAvatarSelection,
};
