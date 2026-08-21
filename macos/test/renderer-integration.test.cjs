"use strict";

const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const macRoot = path.resolve(__dirname, "..");
const patchPath = path.join(macRoot, "src", "patch", "renderer.cjs");
const cssPath = path.join(macRoot, "src", "renderer", "codex-ui.css");
const botUiPath = path.join(macRoot, "src", "renderer", "bot-runtime-ui.js");
const visualRuntimePath = path.join(macRoot, "test", "visual", "renderer-panel-runtime.cjs");
const visualFixturePath = path.join(macRoot, "test", "fixtures", "renderer-panel.html");
const { ADDED_AVATAR_SHAPES } = require("../src/bots/avatar-catalog.cjs");
const {
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
  VENDOR_AVATAR_ACCENT_FACE,
  VENDOR_AVATAR_ACCENT_MORPH,
  VENDOR_AVATAR_ACCENT_REF,
  VENDOR_AVATAR_ACCENT_STATIC,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_RENDERER_ASSET_SHA256,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarCatalogSource,
  patchAvatarAccentSource,
  patchNewBotAvatarPickerSource,
  mergeNewBotAvatarSelection,
  reverseAvatarCatalogSource,
  reverseAvatarAccentSource,
  reverseNewBotCharacterEditorSource,
  reverseNewBotAvatarPickerSource,
  validateAvatarAccentPath,
} = require(patchPath);

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
const STOCK_NEW_BOT_CREATE_RESOLVE = 'const Me=await Ee.resolveAvatar(),Ae=await re({name:Ee.name,description:Ee.description,avatarPngBase64:Me,...Ee.templateId!=null?{templateId:Ee.templateId}:{}});';
const STOCK_NEW_BOT_CREATE_DISPATCH = 'ee=x.useCallback(Ee=>{ae({name:Ee.name,description:Ee.description,resolveAvatar:()=>Promise.resolve(Ee.avatarPngBase64)})},[ae])';
const STOCK_M4N_FRAGMENT = 'function M4n(n){const e=ye.c(32),{agent:t,character:s,staged:r,isCharacterActive:i}=n,{commitCharacter:l}=s,f=r?.avatarShape??t.avatarShape??null,d=r?.avatarColor??t.avatarColor??null,o=()=>"";let b;e[9]!==o||e[10]!==l||e[11]!==i||e[12]!==d||e[13]!==f?(b=Pq.map(M=>{const O=i&&f===M;return p.jsx("button",{"aria-pressed":O,onClick:()=>l({avatarShape:M})},M)}),e[9]=o,e[10]=l,e[11]=i,e[12]=d,e[13]=f,e[14]=b):b=e[14];let C;e[21]!==o||e[22]!==l||e[23]!==i||e[24]!==d?(C=DQ.map(M=>{const R=i&&d===M.id,S=i&&d===M.id,T=i&&d===M.id;return p.jsx("button",{"aria-pressed":R,onClick:()=>l({avatarColor:M.id}),className:S?"selected":"",title:T?"selected":""},M.id)}),e[21]=o,e[22]=l,e[23]=i,e[24]=d,e[25]=C):C=e[25];return p.jsxs("div",{children:[b,C]})}class O4n{}';
const STOCK_BOT_SETTINGS_ROOT = 'let q;return e[43]!==j||e[44]!==B?(q=p.jsxs("div",{className:m,children:[j,B]}),e[43]=j,e[44]=B,e[45]=q):q=e[45],q}';
const STOCK_BOT_OVERVIEW_COMPUTER = 'children:[l,S?p.jsx(b4n,{agent:t,onOpenAgentChat:f}):null';
const OPENBOT_BOT_OVERVIEW_COMPUTER = 'children:[window.openbotProtocol?.schemaVersion===1&&window.openbotProtocol?.mode==="local-protocol"?p.jsx("div",{"data-openbot-bot-overview-computer-host":!0}):l,S?p.jsx(b4n,{agent:t,onOpenAgentChat:f}):null';
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
  STOCK_NEW_BOT_CREATE_RESOLVE,
  STOCK_NEW_BOT_CREATE_DISPATCH,
  STOCK_BOT_OVERVIEW_COMPUTER,
  STOCK_M4N_FRAGMENT,
  STOCK_BOT_SETTINGS_ROOT,
  STOCK_CLIENT_RESTORE,
  STOCK_ROSTER_CONNECT_GATE,
  STOCK_ACCOUNT_SCOPED_CONNECT_GATE,
  STOCK_POST_RESTORE_GATE,
  STOCK_ACCOUNT_SLOT_GETTER,
  STOCK_AUTH_OBSERVER,
  STOCK_IDENTITY_PORT_GATE,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_VISIBLE_SHAPES,
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

function createPickerBrowserHarness() {
  const componentStates = new Map();
  let currentComponent = null;
  let filePickerCalls = 0;
  let focusCalls = [];
  let createdArgs = null;
  const protocol = { value: { schemaVersion: 1, mode: "local-protocol" } };
  const formValues = { name: "Luna", description: "Preserve me" };
  const translations = { "5XRPbV": "Editar avatar" };

  function renderComponent(component, props) {
    const previous = currentComponent;
    const state = componentStates.get(component) ?? { values: [], count: null };
    componentStates.set(component, state);
    currentComponent = { component, state, index: 0 };
    const result = component(props);
    const count = currentComponent.index;
    if (state.count !== null && state.count !== count) {
      throw new Error(`hook count changed for ${component.name}: ${state.count} -> ${count}`);
    }
    state.count = count;
    currentComponent = previous;
    return result;
  }

  const x = {
    useState(initial) {
      assert.ok(currentComponent, "useState must run inside a component");
      const slot = currentComponent.index++;
      const state = currentComponent.state;
      if (!(slot in state.values)) state.values[slot] = typeof initial === "function" ? initial() : initial;
      return [
        state.values[slot],
        (next) => {
          state.values[slot] = typeof next === "function" ? next(state.values[slot]) : next;
        },
      ];
    },
    useRef(initial) {
      assert.ok(currentComponent, "useRef must run inside a component");
      const slot = currentComponent.index++;
      const state = currentComponent.state;
      if (!(slot in state.values)) state.values[slot] = { current: initial };
      return state.values[slot];
    },
    useCallback(callback) {
      assert.ok(currentComponent, "useCallback must run inside a component");
      currentComponent.index += 1;
      return callback;
    },
    useEffect(effect) {
      assert.ok(currentComponent, "useEffect must run inside a component");
      currentComponent.index += 1;
      effect();
    },
  };

  function element(type, props = {}, children = []) {
    const node = { type, props: { ...props, children } };
    if (props.ref && typeof props.ref === "object") props.ref.current = {
      focus(options) { focusCalls.push(options ?? null); },
      querySelector() { return { focus(options) { focusCalls.push(options ?? null); } }; },
    };
    return node;
  }

  const p = {
    jsx(type, props = {}) {
      return typeof type === "function" ? renderComponent(type, props) : element(type, props);
    },
    jsxs(type, props = {}) {
      return typeof type === "function" ? renderComponent(type, props) : element(type, props, props.children ?? []);
    },
  };
  const Zt = {
    Root: (props) => element("Zt.Root", props, props.children ?? []),
    Header: (props) => element("Zt.Header", props, props.children ?? []),
    Title: (props) => element("Zt.Title", props, props.children ?? []),
    CloseButton: (props) => element("Zt.CloseButton", props),
    Body: (props) => element("Zt.Body", props, props.children ?? []),
  };
  const originalEyn = (props) => {
    const [name, setName] = x.useState(formValues.name);
    const [description, setDescription] = x.useState(formValues.description);
    return element("stock-form", {
      trigger: element("button", { "aria-label": "Add a Bot photo", onClick: () => { filePickerCalls += 1; } }),
      submit: element("button", { onClick: () => props.onCreate({
        name,
        description,
        avatarPngBase64: null,
      }) }),
      name,
      description,
      setName,
      setDescription,
    });
  };
  const context = {
    window: { get openbotProtocol() { return protocol.value; } },
    Eyn: originalEyn,
    M4n: (props) => element("M4n", props),
    Jee: () => "blob",
    Lee: () => "black",
    rd: "SandRenderer",
    Re: (props) => element("Re", { ...props, translatedText: translations[props.id] }),
    Zt,
    p,
    x,
    Pq: ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop", "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly", "terminal", "robot", "microchip", "drone"],
    DQ: ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"].map((id) => ({ id })),
  };
  vm.runInNewContext(OPENBOT_NEW_BOT_AVATAR_PICKER, context, { filename: "openbot-avatar-picker.cjs" });

  function find(node, predicate) {
    if (node == null || typeof node !== "object") return null;
    if (predicate(node)) return node;
    const children = node.props?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = find(child, predicate);
        if (found) return found;
      }
    } else if (children != null) {
      const found = find(children, predicate);
      if (found) return found;
    }
    for (const value of Object.values(node.props ?? {})) {
      if (value === children || typeof value === "function") continue;
      const found = find(value, predicate);
      if (found) return found;
    }
    return null;
  }

  const parentCreate = (values) => {
    const forwarded = mergeNewBotAvatarSelection({
      name: values.name,
      description: values.description,
      avatarPngBase64: values.avatarPngBase64,
    }, {
      ...(values.avatarShape !== undefined ? { avatarShape: values.avatarShape } : {}),
      ...(values.avatarColor !== undefined ? { avatarColor: values.avatarColor } : {}),
    });
    createdArgs = {
      name: forwarded.name,
      description: forwarded.description,
      avatarPngBase64: forwarded.avatarPngBase64,
      ...(forwarded.avatarShape != null ? { avatarShape: forwarded.avatarShape } : {}),
      ...(forwarded.avatarColor != null ? { avatarColor: forwarded.avatarColor } : {}),
    };
  };

  return {
    context,
    render() {
      return renderComponent(context.Eyn, { onCreate: parentCreate });
    },
    find,
    protocol,
    focusCalls: () => focusCalls,
    filePickerCalls: () => filePickerCalls,
    createdArgs: () => createdArgs,
    originalEyn,
  };
}

// This harness intentionally reconciles by element type/key/path instead of
// keying state by component function alone.  The previous browser-like helper
// could therefore miss the real React reset when the wrapper's returned root
// changes from Eyn to a div.
function createReconciledPickerBrowserHarness() {
  const fiberStates = new Map();
  let currentFiber = null;
  let pendingEffects = [];
  let didUpdate = false;
  let filePickerCalls = 0;
  let focusCalls = [];
  let createdArgs = null;
  const protocol = { value: { schemaVersion: 1, mode: "local-protocol" } };
  const formValues = { name: "Luna", description: "Preserve me" };
  const translations = { "5XRPbV": "Editar avatar" };

  function typeName(type) {
    return typeof type === "function" ? (type.name || "anonymous") : String(type);
  }

  function fiberKey(element, path) {
    return `${path}|${typeName(element.type)}|${element.key ?? ""}`;
  }

  function renderComponent(element, path) {
    const key = fiberKey(element, path);
    const state = fiberStates.get(key) ?? { values: [], deps: [], count: null };
    fiberStates.set(key, state);
    const previous = currentFiber;
    currentFiber = { element, path, state, index: 0 };
    const output = element.type(element.props);
    const count = currentFiber.index;
    if (state.count !== null && state.count !== count) {
      throw new Error(`hook count changed for ${typeName(element.type)}: ${state.count} -> ${count}`);
    }
    state.count = count;
    currentFiber = previous;
    return reconcile(output, `${path}.out`);
  }

  function hostNode(type, props, children) {
    const node = { type, props: { ...props, children } };
    node.querySelector = (selector) => {
      const found = find(node, (candidate) => candidate.type === "button"
        && (selector.includes("Bot photo")
          ? String(candidate.props["aria-label"] ?? "").includes("Bot photo")
          : candidate.props.className === "sand-editable-avatar__button"));
      return found ?? null;
    };
    node.focus = (options) => focusCalls.push(options ?? null);
    if (props.ref && typeof props.ref === "object") props.ref.current = node;
    return node;
  }

  function reconcile(value, path) {
    if (value == null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((child, index) => reconcile(child, `${path}.${index}`));
    }
    if (typeof value.type === "function") return renderComponent(value, path);
    const rawChildren = value.props?.children;
    const children = Array.isArray(rawChildren)
      ? rawChildren.map((child, index) => reconcile(child, `${path}.${index}`))
      : rawChildren == null ? rawChildren : reconcile(rawChildren, `${path}.0`);
    return hostNode(value.type, value.props ?? {}, children);
  }

  const x = {
    useState(initial) {
      assert.ok(currentFiber, "useState must run inside a component");
      const slot = currentFiber.index++;
      const state = currentFiber.state;
      if (!(slot in state.values)) state.values[slot] = typeof initial === "function" ? initial() : initial;
      return [
        state.values[slot],
        (next) => {
          const value = typeof next === "function" ? next(state.values[slot]) : next;
          if (!Object.is(value, state.values[slot])) didUpdate = true;
          state.values[slot] = value;
        },
      ];
    },
    useRef(initial) {
      assert.ok(currentFiber, "useRef must run inside a component");
      const slot = currentFiber.index++;
      const state = currentFiber.state;
      if (!(slot in state.values)) state.values[slot] = { current: initial };
      return state.values[slot];
    },
    useCallback(callback) {
      assert.ok(currentFiber, "useCallback must run inside a component");
      currentFiber.index += 1;
      return callback;
    },
    useEffect(effect, deps) {
      assert.ok(currentFiber, "useEffect must run inside a component");
      const slot = currentFiber.index++;
      const state = currentFiber.state;
      const previous = state.deps[slot];
      const changed = previous === undefined || deps === undefined || deps.some((value, index) => !Object.is(value, previous[index]));
      state.deps[slot] = deps;
      if (changed) pendingEffects.push(effect);
    },
  };

  function element(type, props = {}, children = [], key) {
    return { type, key, props: { ...props, children } };
  }
  const p = {
    jsx(type, props = {}, key) { return element(type, props, props.children ?? [], key); },
    jsxs(type, props = {}, key) { return element(type, props, props.children ?? [], key); },
  };
  const Zt = {
    Root: (props) => element("Zt.Root", props, props.children ?? []),
    Header: (props) => element("Zt.Header", props, props.children ?? []),
    Title: (props) => element("Zt.Title", props, props.children ?? []),
    CloseButton: (props) => element("Zt.CloseButton", props),
    Body: (props) => element("Zt.Body", props, props.children ?? []),
  };
  const originalEyn = (props) => {
    const [name, setName] = x.useState(formValues.name);
    const [description, setDescription] = x.useState(formValues.description);
    return element("stock-form", {
      trigger: element("button", { "aria-label": "Add a Bot photo", onClick: () => { filePickerCalls += 1; } }),
      submit: element("button", { onClick: () => props.onCreate({ name, description, avatarPngBase64: null }) }),
      name,
      description,
      setName,
      setDescription,
    });
  };
  const context = {
    window: { get openbotProtocol() { return protocol.value; } },
    Eyn: originalEyn,
    M4n: (props) => element("M4n", props),
    Jee: () => "blob",
    Lee: () => "black",
    rd: "SandRenderer",
    Re: (props) => element("Re", { ...props, translatedText: translations[props.id] }),
    Zt,
    p,
    x,
    Pq: ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop", "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly", "terminal", "robot", "microchip", "drone"],
    DQ: ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"].map((id) => ({ id })),
  };
  vm.runInNewContext(OPENBOT_NEW_BOT_AVATAR_PICKER, context, { filename: "openbot-avatar-picker-reconciled.cjs" });

  function find(node, predicate) {
    if (node == null || typeof node !== "object") return null;
    if (predicate(node)) return node;
    const children = node.props?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = find(child, predicate);
        if (found) return found;
      }
    } else if (children != null) {
      const found = find(children, predicate);
      if (found) return found;
    }
    for (const value of Object.values(node.props ?? {})) {
      if (value === children || typeof value === "function") continue;
      const found = find(value, predicate);
      if (found) return found;
    }
    return null;
  }

  const parentCreate = (values) => {
    createdArgs = values;
  };

  return {
    context,
    render() {
      let tree;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        didUpdate = false;
        pendingEffects = [];
        tree = reconcile(element(context.Eyn, { onCreate: parentCreate }), "0");
        const effects = pendingEffects;
        pendingEffects = [];
        for (const effect of effects) effect();
        if (!didUpdate) return tree;
      }
      throw new Error("reconciler did not settle");
    },
    find,
    protocol,
    focusCalls: () => focusCalls,
    filePickerCalls: () => filePickerCalls,
    createdArgs: () => createdArgs,
  };
}

async function executeNewBotCreateFragments(resolveFragment, dispatchFragment, values) {
  const source = `(async function run(Ee, spy) {
    const x = { useCallback: (callback) => callback };
    const roster = { createAgent: async (request) => { spy(request); return { agent: { id: "created" } }; } };
    const launcher = { beginCreation: () => ({}), teammateContext: () => null };
    const Jyn = async (n, e, t) => n.createAgent({
      name: t.name,
      description: t.description,
      origin: "user",
      isKickstartRequested: true,
      ...t.templateId != null ? { templateId: t.templateId } : {},
      ...t.avatarShape != null ? { avatarShape: t.avatarShape } : {},
      ...t.avatarColor != null ? { avatarColor: t.avatarColor } : {},
    });
    const re = async (request) => Jyn(roster, launcher, request);
    const ae = async (Ee) => { ${resolveFragment} return Ae; };
    ${dispatchFragment}
    return ee(Ee);
  })`;
  const run = vm.runInNewContext(source, {}, { filename: "new-bot-create-fragments.cjs" });
  let captured = null;
  await run(values, (request) => { captured = request; });
  return captured;
}

function createEvaluatedM4nHarness(patched) {
  const start = patched.indexOf("function M4n(n){");
  const end = patched.indexOf("class O4n", start);
  assert.ok(start >= 0, "patched M4n function is missing");
  assert.ok(end > start, "patched M4n end anchor is missing");
  const segment = patched.slice(start, end);
  const cache = [];
  const context = {
    ye: { c: () => cache },
    Pq: ["blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop", "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly", "terminal", "robot", "microchip", "drone"],
    DQ: ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"].map((id) => ({ id })),
    p: {
      jsx(type, props = {}, key) { return { type, props: { ...props, key } }; },
      jsxs(type, props = {}, key) { return { type, props: { ...props, key } }; },
    },
  };
  vm.runInNewContext(`${segment};globalThis.M4n=M4n;`, context, { filename: "evaluated-m4n.cjs" });
  return {
    cache,
    render(props) { return context.M4n(props); },
  };
}

const GEOMETRY_EPSILON = 1e-6;

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a, b, point) {
  return point.x >= Math.min(a.x, b.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(a.x, b.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(a.y, b.y) - GEOMETRY_EPSILON &&
    point.y <= Math.max(a.y, b.y) + GEOMETRY_EPSILON;
}

function segmentsIntersect(first, second) {
  const [a, b] = first;
  const [c, d] = second;
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) ||
    (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON)) &&
    ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) ||
      (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))) return true;
  return Math.abs(abC) <= GEOMETRY_EPSILON && onSegment(a, b, c) ||
    Math.abs(abD) <= GEOMETRY_EPSILON && onSegment(a, b, d) ||
    Math.abs(cdA) <= GEOMETRY_EPSILON && onSegment(c, d, a) ||
    Math.abs(cdB) <= GEOMETRY_EPSILON && onSegment(c, d, b);
}

const IDENTITY_BOUND = 116;
const PATH_EPSILON = 1e-6;

function parsePathCommands(path) {
  const commands = [];
  const commandPattern = /([MLCQZ])([^MLCQZ]*)/g;
  const arities = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  let match;
  while ((match = commandPattern.exec(path)) !== null) {
    const values = (match[2].match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? []).map(Number);
    assert.equal(values.length, arities[match[1]], `malformed ${match[1]} path command`);
    commands.push({ type: match[1], values });
  }
  assert.ok(commands.length > 0, "path has no commands");
  return commands;
}

const AUTHORED_CONTOUR_NAMES = Object.freeze([
  "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
  "terminal", "robot", "microchip", "drone",
]);
const AUTHORED_CONTOUR_CENTER = 114.2705;
const AUTHORED_CONTOUR_VIEWBOX = 228.44;
const EXACT_STOCK_SHAPE_NAMES = Object.freeze([
  "blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop",
]);
const STOCK_PAIR_FLOORS = Object.freeze({
  blob: 0.08,
  pebble: 0.08,
  squircle: 0.08,
  tablet: 0.08,
  wedge: 0.08,
  hex: 0.11,
  cloud: 0.14,
  teardrop: 0.08,
});
const DOG_STOCK_CLOUD_FLOOR = 0.12;
const EXACT_VENDOR_ARCHIVE = "/Applications/Grok Bot original 20260811.app/Contents/Resources/app.asar";
let exactSandRuntimeCache = null;
let exactPatchedSandRuntimeCache = null;

function exactSandRuntime() {
  if (exactSandRuntimeCache !== null) return exactSandRuntimeCache;
  const source = asar.extractFile(EXACT_VENDOR_ARCHIVE, "dist/renderer/assets/index-CphCyQnY.js").toString("utf8");
  assert.equal(sha256Text(source), VENDOR_RENDERER_ASSET_SHA256, "pinned vendor asset hash drifted");
  const start = source.indexOf("const Cst=");
  const end = source.indexOf("const C9e=", start);
  assert.ok(start >= 0 && end > start, "pinned Sand geometry/face section anchors are missing");
  const context = { Math, Float64Array, Array };
  vm.runInNewContext(
    `${source.slice(start, end)};globalThis.__sand={Fo,qo,MBt,Oje,E9e,c3,Cst,Ist,Ast,_st};`,
    context,
    { filename: "pinned-sand-geometry.cjs" },
  );
  const entries = parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL);
  const accents = new Map(parseAuthoredAccentEntries(OPENBOT_GEOMETRY_TAIL)
    .map((entry) => [entry.name, entry.path]));
  for (const entry of entries) {
    const accentPath = accents.get(entry.name);
    context.__sand.Fo[entry.name] = context.__sand.qo(
      entry.name,
      entry.path,
      accentPath === undefined ? undefined : { accentPath },
    );
  }
  exactSandRuntimeCache = context.__sand;
  return exactSandRuntimeCache;
}

function exactPatchedSandRuntime() {
  if (exactPatchedSandRuntimeCache !== null) return exactPatchedSandRuntimeCache;
  const source = asar.extractFile(EXACT_VENDOR_ARCHIVE, "dist/renderer/assets/index-CphCyQnY.js").toString("utf8");
  const patched = patchAvatarAccentSource(patchAvatarCatalogSource(source));
  const start = patched.indexOf("const Cst=");
  const end = patched.indexOf("const C9e=", start);
  assert.ok(start >= 0 && end > start, "patched Sand geometry/face section anchors are missing");
  const context = { Math, Float64Array, Array };
  vm.runInNewContext(
    `${patched.slice(start, end)};globalThis.__sand={Fo,MBt,Oje,OBt,E9e,c3,Cst,Ist,Ast,_st};`,
    context,
    { filename: "patched-sand-geometry.cjs" },
  );
  exactPatchedSandRuntimeCache = context.__sand;
  return exactPatchedSandRuntimeCache;
}

function parseAuthoredContourEntries(source) {
  const entries = [];
  const pattern = /([a-z]+):qo\("[^\"]+","([MLCQZ0-9 .-]+)"(?:,\{[^)]*\})?\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    entries.push({ name: match[1], path: match[2] });
  }
  return entries;
}

function parseAuthoredAccentEntries(source) {
  const entries = [];
  const pattern = /([a-z]+):qo\("[^\"]+","[MLCQZ0-9 .-]+",\{accentPath:"([MLCQZ0-9 .-]+)"\}\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    entries.push({ name: match[1], path: match[2] });
  }
  return entries;
}

function authoredContourSamples(path, steps = 24) {
  return pathSamples(path, steps);
}

function authoredQoPath(path) {
  // Independent copy of Sand's qo normalization: PBt centers the exact
  // quadratic/cubic extrema, clamps its scale to [.9, 1.35], and IBt rounds
  // each coordinate to the same two decimals as the vendor renderer.
  const bounds = pathExtrema(path);
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const scale = Math.min(1.35, Math.max(0.9, AUTHORED_CONTOUR_VIEWBOX / span));
  const offsetX = AUTHORED_CONTOUR_CENTER - (bounds.minX + bounds.maxX) / 2;
  const offsetY = AUTHORED_CONTOUR_CENTER - (bounds.minY + bounds.maxY) / 2;
  const round = (value) => Math.round(value * 100) / 100;
  return parsePathCommands(path).map(({ type, values }) => {
    const transformed = [];
    for (let index = 0; index < values.length; index += 2) {
      transformed.push(round(AUTHORED_CONTOUR_CENTER + (values[index] + offsetX - AUTHORED_CONTOUR_CENTER) * scale));
      transformed.push(round(AUTHORED_CONTOUR_CENTER + (values[index + 1] + offsetY - AUTHORED_CONTOUR_CENTER) * scale));
    }
    return { type, values: transformed };
  }).map(({ type, values }) => `${type}${values.join(" ")}`).join("");
}

function rasterizeQoPath(qoPath, size) {
  const samples = authoredContourSamples(qoPath);
  const bounds = pathExtrema(qoPath);
  const normalized = samples.map((point) => ({
    x: (point.x - AUTHORED_CONTOUR_CENTER) / AUTHORED_CONTOUR_VIEWBOX,
    y: (point.y - AUTHORED_CONTOUR_CENTER) / AUTHORED_CONTOUR_VIEWBOX,
  }));
  const contains = (x, y) => {
    let inside = false;
    for (let first = 0, second = normalized.length - 1; first < normalized.length; second = first++) {
      const a = normalized[first];
      const b = normalized[second];
      const intersects = ((a.y > y) !== (b.y > y)) &&
        (x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x);
      if (intersects) inside = !inside;
    }
    return inside;
  };
  const cells = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const x = (column + 0.5) / size - 0.5;
      const y = (row + 0.5) / size - 0.5;
      cells.push(contains(x, y));
    }
  }
  return { cells, samples: normalized, bounds };
}

function authoredContourRaster(path, size) {
  return rasterizeQoPath(authoredQoPath(path), size);
}

function exactSandFaceRaster(name, size, pose = { turn: 0, tilt: 0, roll: 0 }) {
  const exactSand = exactSandRuntime();
  const shape = exactSand.Fo[name];
  const cells = [...rasterizeQoPath(shape.path, size).cells];
  const transforms = exactSand.MBt(name, {
    faceTune: exactSand.Cst,
    eyeScale: exactSand._st(name),
    pose,
    poseHome: exactSand.Ast,
  });
  const holes = exactSand.c3[0].map((eye, index) => exactSand.Oje(eye, transforms[index]));
  if (shape.accentPath) holes.unshift(shape.accentPath);
  for (const hole of holes) {
    const holeCells = rasterizeQoPath(hole, size).cells;
    for (let index = 0; index < cells.length; index += 1) {
      if (holeCells[index]) cells[index] = false;
    }
  }
  return cells;
}

function continuousContourSpanAt(path, ratio) {
  const bounds = pathExtrema(path);
  const y = bounds.minY + (bounds.maxY - bounds.minY) * ratio;
  const samples = pathSamples(path, 48);
  const crossings = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (!((previous.y <= y && current.y > y) || (current.y <= y && previous.y > y))) continue;
    const t = (y - previous.y) / (current.y - previous.y);
    crossings.push(previous.x + (current.x - previous.x) * t);
  }
  crossings.sort((left, right) => left - right);
  return {
    crossings,
    width: crossings.length < 2 ? 0 : crossings.at(-1) - crossings[0],
    y,
  };
}

function authoredRasterDifference(first, second) {
  let different = 0;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) different += 1;
  }
  return different / first.length;
}

function authoredConnectedComponents(cells, size) {
  const visited = new Set();
  let components = 0;
  for (let index = 0; index < cells.length; index += 1) {
    if (!cells[index] || visited.has(index)) continue;
    components += 1;
    const queue = [index];
    visited.add(index);
    while (queue.length > 0) {
      const current = queue.shift();
      const row = Math.floor(current / size);
      const column = current % size;
      for (const [nextRow, nextColumn] of [[row - 1, column], [row + 1, column], [row, column - 1], [row, column + 1]]) {
        if (nextRow < 0 || nextRow >= size || nextColumn < 0 || nextColumn >= size) continue;
        const next = nextRow * size + nextColumn;
        if (cells[next] && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
  }
  return components;
}

function pointInPolygon(points, x, y) {
  let inside = false;
  for (let first = 0, second = points.length - 1; first < points.length; second = first++) {
    const a = points[first];
    const b = points[second];
    if (((a.y > y) !== (b.y > y)) &&
      x < (b.x - a.x) * (y - a.y) / ((b.y - a.y) || Number.EPSILON) + a.x) inside = !inside;
  }
  return inside;
}

function authoredProfile(raster, size, row) {
  const start = Math.max(0, Math.min(size - 1, Math.round(row * (size - 1)))) * size;
  const filled = raster.slice(start, start + size);
  const columns = filled.flatMap((value, index) => value ? [index] : []);
  return {
    width: columns.length,
    min: columns[0] ?? size,
    max: columns.at(-1) ?? -1,
  };
}

function authoredRunsAtRow(raster, size, row) {
  const index = Math.max(0, Math.min(size - 1, Math.round(row * (size - 1))));
  const runs = [];
  let start = null;
  for (let column = 0; column <= size; column += 1) {
    const filled = column < size && raster[index * size + column];
    if (filled && start === null) start = column;
    if (!filled && start !== null) {
      runs.push({ min: start, max: column - 1, width: column - start });
      start = null;
    }
  }
  return runs;
}

function authoredTopPeakCount(raster, size) {
  return authoredTopPeakPositions(raster, size).length;
}

function authoredTopPeakPositions(raster, size) {
  const tops = [];
  for (let column = 0; column < size; column += 1) {
    let firstFilled = size;
    for (let row = 0; row < size; row += 1) {
      if (raster[row * size + column]) {
        firstFilled = row;
        break;
      }
    }
    tops.push(firstFilled);
  }
  const peaks = [];
  for (let column = 2; column < size - 2; column += 1) {
    const local = tops[column];
    if (local >= size || local > tops[column - 1] || local > tops[column + 1]) continue;
    if (local <= tops[column - 2] && local <= tops[column + 2]) peaks.push(column);
  }
  return peaks;
}

function authoredBottomLobeCount(raster, size) {
  const bottoms = [];
  for (let column = 0; column < size; column += 1) {
    let lastFilled = -1;
    for (let row = size - 1; row >= 0; row -= 1) {
      if (raster[row * size + column]) {
        lastFilled = row;
        break;
      }
    }
    bottoms.push(lastFilled);
  }
  let lobes = 0;
  for (let column = 2; column < size - 2; column += 1) {
    const local = bottoms[column];
    if (local < 0 || local < bottoms[column - 1] || local < bottoms[column + 1]) continue;
    if (local >= bottoms[column - 2] && local >= bottoms[column + 2]) lobes += 1;
  }
  return lobes;
}

function assertAuthoredSimplePath(path, label) {
  const normalizedPath = authoredQoPath(path);
  const extrema = pathExtrema(normalizedPath);
  const bounds = {
    minX: extrema.minX - AUTHORED_CONTOUR_CENTER,
    maxX: extrema.maxX - AUTHORED_CONTOUR_CENTER,
    minY: extrema.minY - AUTHORED_CONTOUR_CENTER,
    maxY: extrema.maxY - AUTHORED_CONTOUR_CENTER,
  };
  assert.ok(bounds.minX >= -IDENTITY_BOUND - PATH_EPSILON, `${label} exceeds -ze-${IDENTITY_BOUND}: ${bounds.minX}`);
  assert.ok(bounds.maxX <= IDENTITY_BOUND + PATH_EPSILON, `${label} exceeds ze+${IDENTITY_BOUND}: ${bounds.maxX}`);
  assert.ok(bounds.minY >= -IDENTITY_BOUND - PATH_EPSILON, `${label} exceeds -ze-${IDENTITY_BOUND}: ${bounds.minY}`);
  assert.ok(bounds.maxY <= IDENTITY_BOUND + PATH_EPSILON, `${label} exceeds ze+${IDENTITY_BOUND}: ${bounds.maxY}`);
  const segments = assertNoAdaptiveSelfCrossings(normalizedPath, label);
  for (const [index, segment] of segments.entries()) {
    for (let point = 1; point < segment.points.length; point += 1) {
      assert.ok(distance(segment.points[point - 1], segment.points[point]) > PATH_EPSILON,
        `${label} has a degenerate segment ${index}`);
    }
  }
  return bounds;
}

function quadraticPoint(start, control, end, time) {
  const inverse = 1 - time;
  return {
    x: inverse * inverse * start.x + 2 * inverse * time * control.x + time * time * end.x,
    y: inverse * inverse * start.y + 2 * inverse * time * control.y + time * time * end.y,
  };
}

function cubicPoint(start, firstControl, secondControl, end, time) {
  const inverse = 1 - time;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * time * firstControl.x +
      3 * inverse * time ** 2 * secondControl.x + time ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * time * firstControl.y +
      3 * inverse * time ** 2 * secondControl.y + time ** 3 * end.y,
  };
}

function curveExtrema(bounds, pointAt, derivativeRoots) {
  const times = [0, 1, ...derivativeRoots.filter((time) => time > 0 && time < 1)];
  for (const time of times) {
    const point = pointAt(time);
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
}

function quadraticDerivativeRoots(start, control, end, axis) {
  const denominator = start[axis] - 2 * control[axis] + end[axis];
  if (Math.abs(denominator) <= PATH_EPSILON) return [];
  return [(start[axis] - control[axis]) / denominator];
}

function cubicDerivativeRoots(start, firstControl, secondControl, end, axis) {
  const a = 3 * (-start[axis] + 3 * firstControl[axis] - 3 * secondControl[axis] + end[axis]);
  const b = 6 * (start[axis] - 2 * firstControl[axis] + secondControl[axis]);
  const c = 3 * (firstControl[axis] - start[axis]);
  if (Math.abs(a) <= PATH_EPSILON) return Math.abs(b) <= PATH_EPSILON ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -PATH_EPSILON) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

function pathExtrema(path) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const commands = parsePathCommands(path);
  let current = null;
  let start = null;
  for (const { type, values } of commands) {
    if (type === "M") {
      current = { x: values[0], y: values[1] };
      start = current;
      curveExtrema(bounds, () => current, []);
      continue;
    }
    if (type === "Z") {
      if (current && start) {
        curveExtrema(bounds, (time) => ({
          x: current.x + (start.x - current.x) * time,
          y: current.y + (start.y - current.y) * time,
        }), []);
        current = start;
      }
      continue;
    }
    assert.ok(current, `path ${type} command precedes move`);
    const startPoint = current;
    if (type === "L") {
      current = { x: values[0], y: values[1] };
      curveExtrema(bounds, (time) => ({
        x: startPoint.x + (current.x - startPoint.x) * time,
        y: startPoint.y + (current.y - startPoint.y) * time,
      }), []);
      continue;
    }
    if (type === "Q") {
      const control = { x: values[0], y: values[1] };
      const end = { x: values[2], y: values[3] };
      curveExtrema(
        bounds,
        (time) => quadraticPoint(startPoint, control, end, time),
        [...quadraticDerivativeRoots([startPoint.x, startPoint.y], [control.x, control.y], [end.x, end.y], 0),
          ...quadraticDerivativeRoots([startPoint.x, startPoint.y], [control.x, control.y], [end.x, end.y], 1)],
      );
      current = end;
      continue;
    }
    const firstControl = { x: values[0], y: values[1] };
    const secondControl = { x: values[2], y: values[3] };
    const end = { x: values[4], y: values[5] };
    curveExtrema(
      bounds,
      (time) => cubicPoint(startPoint, firstControl, secondControl, end, time),
      [...cubicDerivativeRoots([startPoint.x, startPoint.y], [firstControl.x, firstControl.y], [secondControl.x, secondControl.y], [end.x, end.y], 0),
        ...cubicDerivativeRoots([startPoint.x, startPoint.y], [firstControl.x, firstControl.y], [secondControl.x, secondControl.y], [end.x, end.y], 1)],
    );
    current = end;
  }
  return bounds;
}

function pathSamples(path, steps = 12) {
  const samples = [];
  const commands = parsePathCommands(path);
  let current = null;
  let start = null;
  for (const { type, values } of commands) {
    if (type === "M") {
      current = { x: values[0], y: values[1] };
      start = current;
      samples.push(current);
      continue;
    }
    if (type === "Z") {
      if (current && start) samples.push(start);
      current = start;
      continue;
    }
    assert.ok(current, `path ${type} command precedes move`);
    const from = current;
    if (type === "L") {
      current = { x: values[0], y: values[1] };
      samples.push(current);
      continue;
    }
    const points = type === "Q"
      ? [from, { x: values[0], y: values[1] }, { x: values[2], y: values[3] }]
      : [from, { x: values[0], y: values[1] }, { x: values[2], y: values[3] }, { x: values[4], y: values[5] }];
    for (let index = 1; index <= steps; index += 1) {
      const time = index / steps;
      samples.push(type === "Q"
        ? quadraticPoint(points[0], points[1], points[2], time)
        : cubicPoint(points[0], points[1], points[2], points[3], time));
    }
    current = points.at(-1);
  }
  return samples;
}

function curvePoint(points, time) {
  const inverse = 1 - time;
  if (points.length === 3) {
    return {
      x: inverse * inverse * points[0].x + 2 * inverse * time * points[1].x + time * time * points[2].x,
      y: inverse * inverse * points[0].y + 2 * inverse * time * points[1].y + time * time * points[2].y,
    };
  }
  return {
    x: inverse ** 3 * points[0].x + 3 * inverse ** 2 * time * points[1].x +
      3 * inverse * time ** 2 * points[2].x + time ** 3 * points[3].x,
    y: inverse ** 3 * points[0].y + 3 * inverse ** 2 * time * points[1].y +
      3 * inverse * time ** 2 * points[2].y + time ** 3 * points[3].y,
  };
}

function adaptiveCurveSamples(points, tolerance = 0.15) {
  const samples = [points[0]];
  const recurse = (fromTime, fromPoint, toTime, toPoint, depth) => {
    const middleTime = (fromTime + toTime) / 2;
    const middlePoint = curvePoint(points, middleTime);
    const chord = distance(fromPoint, toPoint);
    const controlLength = points.slice(1, -1).reduce(
      (total, control) => total + distance(fromPoint, control) + distance(control, toPoint),
      0,
    );
    if (depth >= 9 || controlLength - chord <= tolerance) {
      samples.push(toPoint);
      return;
    }
    recurse(fromTime, fromPoint, middleTime, middlePoint, depth + 1);
    recurse(middleTime, middlePoint, toTime, toPoint, depth + 1);
  };
  recurse(0, points[0], 1, points.at(-1), 0);
  return samples;
}

function adaptivePathSegments(path) {
  const segments = [];
  let current = null;
  let start = null;
  for (const { type, values } of parsePathCommands(path)) {
    if (type === "M") {
      current = { x: values[0], y: values[1] };
      start = current;
      continue;
    }
    if (type === "Z") {
      if (current && start && distance(current, start) > PATH_EPSILON) segments.push({ points: [current, start] });
      current = start;
      continue;
    }
    assert.ok(current, `path ${type} command precedes move`);
    const from = current;
    if (type === "L") {
      current = { x: values[0], y: values[1] };
      segments.push({ points: [from, current] });
      continue;
    }
    const points = type === "Q"
      ? [from, { x: values[0], y: values[1] }, { x: values[2], y: values[3] }]
      : [from, { x: values[0], y: values[1] }, { x: values[2], y: values[3] }, { x: values[4], y: values[5] }];
    current = points.at(-1);
    segments.push({ points: adaptiveCurveSamples(points) });
  }
  return segments;
}

function endpointShared(first, second) {
  return [
    [first[0], second[0]], [first[0], second.at(-1)],
    [first.at(-1), second[0]], [first.at(-1), second.at(-1)],
  ].some(([left, right]) => distance(left, right) <= 1e-5);
}

function polylinesCross(first, second) {
  for (let left = 1; left < first.length; left += 1) {
    const firstEdge = [first[left - 1], first[left]];
    for (let right = 1; right < second.length; right += 1) {
      const secondEdge = [second[right - 1], second[right]];
      if (segmentsIntersect(firstEdge, secondEdge) && !endpointShared(firstEdge, secondEdge)) return true;
    }
  }
  return false;
}

function assertNoAdaptiveSelfCrossings(path, label) {
  const segments = adaptivePathSegments(path);
  assert.ok(segments.length >= 2, `${label} has too few path segments`);
  for (let first = 0; first < segments.length; first += 1) {
    for (let second = first + 1; second < segments.length; second += 1) {
      const adjacent = second === first + 1 || (first === 0 && second === segments.length - 1);
      assert.equal(polylinesCross(segments[first].points, segments[second].points), false,
        `${label} self-intersects between segments ${first}/${second}${adjacent ? " at a non-endpoint" : ""}`);
      if (!adjacent) {
        const duplicateEndpoint = [
          [segments[first].points[0], segments[second].points[0]],
          [segments[first].points[0], segments[second].points.at(-1)],
          [segments[first].points.at(-1), segments[second].points[0]],
          [segments[first].points.at(-1), segments[second].points.at(-1)],
        ].some(([left, right]) => distance(left, right) <= 1e-5);
        assert.equal(duplicateEndpoint, false, `${label} has non-adjacent duplicate endpoints ${first}/${second}`);
      }
    }
  }
  return segments;
}

function assertSimplePath(path, label) {
  const bounds = pathExtrema(path);
  assert.ok(bounds.minX >= -IDENTITY_BOUND - PATH_EPSILON, `${label} exceeds -ze-${IDENTITY_BOUND}: ${bounds.minX}`);
  assert.ok(bounds.maxX <= IDENTITY_BOUND + PATH_EPSILON, `${label} exceeds ze+${IDENTITY_BOUND}: ${bounds.maxX}`);
  assert.ok(bounds.minY >= -IDENTITY_BOUND - PATH_EPSILON, `${label} exceeds -ze-${IDENTITY_BOUND}: ${bounds.minY}`);
  assert.ok(bounds.maxY <= IDENTITY_BOUND + PATH_EPSILON, `${label} exceeds ze+${IDENTITY_BOUND}: ${bounds.maxY}`);
  const segments = assertNoAdaptiveSelfCrossings(path, label);
  for (const [index, segment] of segments.entries()) {
    for (let point = 1; point < segment.points.length; point += 1) {
      assert.ok(distance(segment.points[point - 1], segment.points[point]) > PATH_EPSILON,
        `${label} has a degenerate segment ${index}`);
    }
  }
  return bounds;
}

test("authored Sand contour paths stay inside ze plus or minus 116 with real sampled extrema", () => {
  const entries = parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL);
  assert.equal(entries.length, AUTHORED_CONTOUR_NAMES.length);
  for (const entry of entries) {
    const commands = parsePathCommands(entry.path);
    assert.ok(commands.some(({ type }) => type === "Q" || type === "C"), `${entry.name} must contain a continuous curve`);
    const bounds = assertAuthoredSimplePath(entry.path, `${entry.name} authored contour`);
    assert.ok(Number.isFinite(bounds.minX + bounds.maxX + bounds.minY + bounds.maxY));
  }
});

test("the pinned path validator rejects degenerate and self-intersecting paths", () => {
  assert.throws(() => assertSimplePath("M0 0L0 0Z", "degenerate fixture"), /degenerate/);
  assert.throws(() => assertSimplePath("M-10 -10L10 10L-10 10L10 -10Z", "crossing fixture"), /self-intersects/);
  assert.throws(() => assertSimplePath("M-30 -30C30 30 30 30 -30 30L30 -30Z", "crossing cubic fixture"), /self-intersects/);
  assert.doesNotThrow(() => assertSimplePath("M-20 0Q0 -20 20 0Q0 20-20 0Z", "shared-endpoint curve fixture"));
});

function countExact(source, anchor) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(anchor, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + anchor.length;
  }
}

test("avatar patch adds every geometry and visible choice and reverses exactly", () => {
  const stockFallback = 'function Jee(n){return Jst.find(t=>t===n.avatarShape)??I4e(n.id)}';
  const source = `before;${VENDOR_GEOMETRY_TAIL};middle;${VENDOR_VISIBLE_SHAPES};${stockFallback};after`;
  const patched = patchAvatarCatalogSource(source);
  assert.equal(countExact(source, VENDOR_GEOMETRY_TAIL), 1);
  assert.equal(countExact(source, VENDOR_VISIBLE_SHAPES), 1);
  assert.equal(countExact(patched, OPENBOT_GEOMETRY_TAIL), 1);
  assert.equal(countExact(patched, OPENBOT_VISIBLE_SHAPES), 1);
  for (const shape of ADDED_AVATAR_SHAPES) {
    assert.equal(countExact(patched, `${shape}:qo(`), 1);
    assert.match(patched, new RegExp(`${shape}:qo\\(`));
  }
  assert.match(
    patched,
    new RegExp(OPENBOT_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal((patched.match(/function Jee\(n\)/g) ?? []).length, 1);
  assert.match(
    patched,
    new RegExp(stockFallback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(reverseAvatarCatalogSource(patched), source);
  assert.throws(() => patchAvatarCatalogSource(source + VENDOR_VISIBLE_SHAPES), /ambiguous/i);
  assert.throws(() => patchAvatarCatalogSource("missing"), /not found/i);
});

test("avatar registry exposes the exact full twenty-shape Sand choice list", () => {
  const visibleShapes = JSON.parse(OPENBOT_VISIBLE_SHAPES.slice("const Pq=".length));
  assert.deepEqual(visibleShapes, [
    "blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop",
    "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
    "terminal", "robot", "microchip", "drone",
  ]);
  assert.equal(visibleShapes.length, 20);
});

test("avatar contours use no weak Ost or dBt animal blockouts", () => {
  assert.equal((OPENBOT_GEOMETRY_TAIL.match(/Ost\(|dBt\(/g) ?? []).length, 0);
  for (const name of AUTHORED_CONTOUR_NAMES) {
    assert.match(OPENBOT_GEOMETRY_TAIL, new RegExp(`${name}:qo\\("[^\\"]+","M`));
  }
});

test("avatar accent transform patches four exact Sand anchors and reverses byte-for-byte", () => {
  assert.equal(typeof patchAvatarAccentSource, "function");
  assert.equal(typeof reverseAvatarAccentSource, "function");
  const anchors = [
    VENDOR_AVATAR_ACCENT_REF,
    VENDOR_AVATAR_ACCENT_MORPH,
    VENDOR_AVATAR_ACCENT_FACE,
    VENDOR_AVATAR_ACCENT_STATIC,
  ];
  assert.ok(anchors.every((anchor) => typeof anchor === "string" && anchor.length > 20));
  const source = `before;${anchors.join(";middle;")};after`;
  const patched = patchAvatarAccentSource(source);
  for (const anchor of anchors) assert.equal(patched.includes(anchor), false);
  for (const anchor of [
    OPENBOT_AVATAR_ACCENT_REF,
    OPENBOT_AVATAR_ACCENT_MORPH,
    OPENBOT_AVATAR_ACCENT_FACE,
    OPENBOT_AVATAR_ACCENT_STATIC,
  ]) assert.equal(patched.includes(anchor), true);
  assert.equal(reverseAvatarAccentSource(patched), source);

  for (const [index, anchor] of anchors.entries()) {
    assert.throws(
      () => patchAvatarAccentSource(source.replace(anchor, "missing")),
      /accent.*missing|not found/i,
      `missing anchor ${index}`,
    );
    assert.throws(
      () => patchAvatarAccentSource(`${source};${anchor}`),
      /accent.*ambiguous/i,
      `duplicate anchor ${index}`,
    );
  }
  assert.throws(() => patchAvatarAccentSource(patched), /already|mixed/i);
  assert.throws(() => reverseAvatarAccentSource(source), /already|requires|not found/i);
});

test("pre-effect Sand render hides a target accent until the current body reaches that shape", () => {
  const displayMatch = /display:([^}]+)},d:ae\.accentPath/.exec(OPENBOT_AVATAR_ACCENT_FACE);
  assert.ok(displayMatch, "Sand accent initial display expression is missing");
  const renderDisplay = vm.runInNewContext(
    `(function({ accentPath, currentPath, targetPath, paused, reduced, mounted = true }) {
      const ae = { accentPath, path: targetPath };
      const K = { current: mounted ? { getAttribute(name) { return name === "d" ? currentPath : null; } } : null };
      const d = paused;
      const window = { matchMedia() { return { matches: reduced }; } };
      return ${displayMatch[1]};
    })`,
  );
  const target = "M0 0L10 0L10 10Z";
  const previous = "M0 0L8 0L8 8Z";
  const accentPath = "M3 6L7 6L5 9Z";
  assert.equal(renderDisplay({ accentPath, currentPath: previous, targetPath: target, paused: false, reduced: false }), "none",
    "target change must not flash the accent before the animation effect hides it");
  assert.equal(renderDisplay({ accentPath, currentPath: target, targetPath: target, paused: false, reduced: false }), "",
    "settled target must show its accent");
  assert.equal(renderDisplay({ accentPath, currentPath: previous, targetPath: target, paused: true, reduced: false }), "",
    "paused target must show immediately");
  assert.equal(renderDisplay({ accentPath, currentPath: previous, targetPath: target, paused: false, reduced: true }), "",
    "reduced-motion target must show immediately");
  assert.equal(renderDisplay({ accentPath, currentPath: null, targetPath: target, paused: false, reduced: false, mounted: false }), "",
    "first mount has no previous body to morph from");
  assert.equal(renderDisplay({ accentPath: "", currentPath: target, targetPath: target, paused: false, reduced: false }), "none",
    "accent-free identities stay hidden");
});

test("dog and owl accent metadata are bounded face-safe subpaths and stock shapes stay accent-free", () => {
  assert.equal(typeof validateAvatarAccentPath, "function");
  const accents = parseAuthoredAccentEntries(OPENBOT_GEOMETRY_TAIL);
  assert.deepEqual(accents.map(({ name }) => name), ["dog", "owl"]);
  const contours = new Map(parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL)
    .map((entry) => [entry.name, entry.path]));
  for (const accent of accents) {
    assert.doesNotThrow(() => validateAvatarAccentPath(accent.path, accent.name));
    const commands = parsePathCommands(accent.path);
    assert.equal(commands.filter(({ type }) => type === "M").length, 1);
    assert.equal(commands.filter(({ type }) => type === "Z").length, 1);
    assert.equal(commands.at(-1).type, "Z");
    const outerPoints = pathSamples(authoredQoPath(contours.get(accent.name)), 24);
    for (const point of pathSamples(accent.path, 16)) {
      assert.equal(pointInPolygon(outerPoints, point.x, point.y), true,
        `${accent.name} accent must stay inside its silhouette`);
    }
  }
  for (const invalid of [
    "M90 100L110 100ZM120 100L140 100Z",
    "M90 100L110 100L100 120",
    "M0 0L20 0L20 20Z",
    "M90 100A10 10 0 0 1 110 100Z",
  ]) assert.throws(() => validateAvatarAccentPath(invalid, "fixture"), /accent/i);
  for (const stock of EXACT_STOCK_SHAPE_NAMES) {
    assert.equal(exactSandRuntime().Fo[stock].accentPath, undefined, `${stock} must remain accent-free`);
  }
});

test("exact Sand accent patch covers dynamic morph reduced-motion and static parity without changing E9e masks", () => {
  assert.equal(typeof patchAvatarAccentSource, "function");
  const source = asar.extractFile(EXACT_VENDOR_ARCHIVE, "dist/renderer/assets/index-CphCyQnY.js").toString("utf8");
  const catalogPatched = patchAvatarCatalogSource(source);
  const patched = patchAvatarAccentSource(catalogPatched);
  assert.equal((patched.match(/openbotAccentRef/g) ?? []).length >= 3, true);
  assert.match(OPENBOT_AVATAR_ACCENT_MORPH, /Mn&&!oe/);
  assert.match(OPENBOT_AVATAR_ACCENT_MORPH, /yn\.accentPath/);
  assert.match(OPENBOT_AVATAR_ACCENT_FACE, /display:ae\.accentPath&&/);
  assert.match(OPENBOT_AVATAR_ACCENT_FACE, /K\.current\.getAttribute\("d"\)===ae\.path/);
  assert.match(OPENBOT_AVATAR_ACCENT_STATIC, /o\.accentPath\?\?""/);
  assert.equal(patched.includes('function E9e(n){const{shape:e="blob",scale:t=1'), true);

  const runMorph = vm.runInNewContext(`(function(Mn,oe,accentPath) {
    const node = { attrs: {}, style: {}, setAttribute(name, value) { this.attrs[name] = value; } };
    const openbotAccentRef = { current: node };
    const yn = { accentPath };
    ${OPENBOT_AVATAR_ACCENT_MORPH.slice(OPENBOT_AVATAR_ACCENT_MORPH.indexOf("openbotAccentRef.current"))}
    return node;
  })`);
  assert.equal(runMorph(true, false, "M1 1L2 2Z").style.display, "none", "animated morph hides accent");
  assert.equal(runMorph(false, false, "M1 1L2 2Z").style.display, "", "settled accent is visible");
  assert.equal(runMorph(true, true, "M1 1L2 2Z").style.display, "", "reduced motion shows target accent immediately");
  assert.equal(runMorph(false, false, "").style.display, "none", "accent-free shapes remain hidden");

  const patchedSand = exactPatchedSandRuntime();
  const authoredAccents = new Map(parseAuthoredAccentEntries(OPENBOT_GEOMETRY_TAIL)
    .map((entry) => [entry.name, entry.path]));
  for (const name of ["dog", "owl"]) {
    assert.equal(patchedSand.Fo[name].accentPath, authoredAccents.get(name));
    const staticAvatar = patchedSand.OBt({ shape: name, fill: "#111", size: 64 });
    assert.equal(staticAvatar.includes(patchedSand.Fo[name].accentPath), true,
      `static Sand ${name} must include the accent hole`);
    const mask = patchedSand.E9e({ shape: name, sizePx: 64, inflatePx: 0, fill: "#111" });
    assert.equal(mask.includes(patchedSand.Fo[name].accentPath), false, "E9e must stay a pure outer mask");
  }
  for (const stock of EXACT_STOCK_SHAPE_NAMES) {
    assert.equal(patchedSand.OBt({ shape: stock, fill: "#111", size: 64 }).includes("undefined"), false);
  }

  for (const name of ["dog", "owl"]) {
    const accentPoints = pathSamples(patchedSand.Fo[name].accentPath, 20);
    for (const pose of [
      { name: "home", value: { turn: 0, tilt: 0, roll: 0 } },
      { name: "idle", value: patchedSand.Ist },
      { name: "working", value: { turn: 4, tilt: 3, roll: 1.5 } },
    ]) {
      const eyeTransforms = patchedSand.MBt(name, {
        faceTune: patchedSand.Cst,
        eyeScale: patchedSand._st(name),
        pose: pose.value,
        poseHome: patchedSand.Ast,
      });
      for (let eye = 0; eye < eyeTransforms.length; eye += 1) {
        const eyePoints = pathSamples(patchedSand.Oje(patchedSand.c3[0][eye], eyeTransforms[eye]), 8);
        const clearance = Math.min(...accentPoints.flatMap((accent) => eyePoints.map((point) => distance(accent, point))));
        assert.ok(clearance >= 1.5, `${name} accent collides with ${pose.name} eye ${eye} (${clearance.toFixed(2)})`);
      }
    }
  }
});

test("exact patched static Sand renderer executes the complete twenty-identity order", () => {
  const expected = [
    "blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop",
    "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
    "terminal", "robot", "microchip", "drone",
  ];
  const identityIds = JSON.parse(OPENBOT_VISIBLE_SHAPES.slice("const Pq=".length));
  assert.deepEqual(identityIds, expected);
  const patchedSand = exactPatchedSandRuntime();
  for (const identity of identityIds) {
    assert.ok(patchedSand.Fo[identity], `${identity} is absent from the exact patched Fo catalog`);
    const rendered = patchedSand.OBt({ shape: identity, fill: "#111", size: 64 });
    assert.match(rendered, /^<svg/);
    assert.equal(rendered.includes(patchedSand.Fo[identity].path), true,
      `${identity} static renderer omitted its exact outer path`);
  }
  for (const identity of ["dog", "owl"]) {
    assert.equal(patchedSand.OBt({ shape: identity, fill: "#111", size: 64 })
      .includes(patchedSand.Fo[identity].accentPath), true,
    `${identity} static renderer omitted its exact accent`);
  }
});

test("native-size avatar contours are authored SVG paths with separated silhouettes and identifying features", () => {
  const entries = parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL);
  assert.deepEqual(entries.map(({ name }) => name), AUTHORED_CONTOUR_NAMES);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const name of AUTHORED_CONTOUR_NAMES) {
    const entry = byName.get(name);
    assert.ok(entry, `${name} contour is missing`);
    const commands = parsePathCommands(entry.path);
    assert.ok(commands.some(({ type }) => type === "Q" || type === "C"), `${name} needs continuous curves`);
    assertAuthoredSimplePath(entry.path, `${name} authored contour`);
  }

  const rastersBySize = new Map();
  for (const size of [22, 36]) {
    const rasters = new Map();
    for (const name of AUTHORED_CONTOUR_NAMES) {
      const raster = authoredContourRaster(byName.get(name).path, size);
      const filled = raster.cells.filter(Boolean).length;
      assert.ok(raster.bounds.minX >= AUTHORED_CONTOUR_CENTER - IDENTITY_BOUND &&
        raster.bounds.maxX <= AUTHORED_CONTOUR_CENTER + IDENTITY_BOUND &&
        raster.bounds.minY >= AUTHORED_CONTOUR_CENTER - IDENTITY_BOUND &&
        raster.bounds.maxY <= AUTHORED_CONTOUR_CENTER + IDENTITY_BOUND,
      `${name} sampled qo bounds exceed the Sand face-safe viewbox`);
      assert.ok(filled >= size * size * 0.26, `${name} has too little native-size fill at ${size}px`);
      assert.ok(filled <= size * size * 0.94, `${name} has no negative space at ${size}px`);
      assert.equal(authoredConnectedComponents(raster.cells, size), 1, `${name} must have one connected fill at ${size}px`);
      rasters.set(name, raster);
    }
    const exactSand = exactSandRuntime();
    const stockRasters = new Map(EXACT_STOCK_SHAPE_NAMES.map((name) => [
      name,
      rasterizeQoPath(exactSand.Fo[name].path, size),
    ]));
    for (const name of AUTHORED_CONTOUR_NAMES) {
      for (const [stockName, stockRaster] of stockRasters) {
        const difference = authoredRasterDifference(rasters.get(name).cells, stockRaster.cells);
        const floor = name === "dog" && stockName === "cloud" ? DOG_STOCK_CLOUD_FLOOR : STOCK_PAIR_FLOORS[stockName];
        assert.ok(difference >= floor, `${name}/${stockName} silhouettes merge at ${size}px (${difference.toFixed(3)} < ${floor})`);
      }
    }
    for (let first = 0; first < AUTHORED_CONTOUR_NAMES.length; first += 1) {
      for (let second = first + 1; second < AUTHORED_CONTOUR_NAMES.length; second += 1) {
        const left = AUTHORED_CONTOUR_NAMES[first];
        const right = AUTHORED_CONTOUR_NAMES[second];
        const difference = authoredRasterDifference(rasters.get(left).cells, rasters.get(right).cells);
        assert.ok(difference >= 0.1, `${left}/${right} silhouettes merge at ${size}px (${difference.toFixed(3)})`);
      }
    }
    rastersBySize.set(size, rasters);
  }

  for (const size of [16, 28, 64, 72, 96]) {
    for (const name of AUTHORED_CONTOUR_NAMES) {
      const filled = authoredContourRaster(byName.get(name).path, size).cells.filter(Boolean).length;
      assert.ok(filled >= size * size * 0.2, `${name} clips or collapses at ${size}px`);
    }
  }

  const at22 = rastersBySize.get(22);
  const catTop = authoredTopPeakCount(at22.get("cat").cells, 22);
  const bunnyTop = authoredTopPeakCount(at22.get("bunny").cells, 22);
  const wolfTop = authoredTopPeakCount(at22.get("wolf").cells, 22);
  assert.ok(catTop >= 2, `cat needs two readable ear peaks, got ${catTop}`);
  assert.ok(bunnyTop >= 2, `bunny needs two separated ear peaks, got ${bunnyTop}`);
  assert.ok(wolfTop >= 2, `wolf needs two tall ear peaks, got ${wolfTop}`);
  assert.ok(authoredProfile(at22.get("dog").cells, 22, 0.28).width >= 14, `dog needs a broad upper skull (${authoredProfile(at22.get("dog").cells, 22, 0.28).width})`);
  assert.ok(authoredProfile(at22.get("wolf").cells, 22, 0.78).width <= 16, `wolf needs a tapered lower face (${authoredProfile(at22.get("wolf").cells, 22, 0.78).width})`);
  assert.ok(authoredProfile(at22.get("fox").cells, 22, 0.78).width <= 14, `fox needs a pointed lower face (${authoredProfile(at22.get("fox").cells, 22, 0.78).width})`);
  assert.ok(authoredProfile(at22.get("bear").cells, 22, 0.22).width >= 10, `bear needs a broad dome (${authoredProfile(at22.get("bear").cells, 22, 0.22).width})`);
  assert.ok(authoredBottomLobeCount(at22.get("jelly").cells, 22) >= 3, `jelly needs four lower lobes (${authoredBottomLobeCount(at22.get("jelly").cells, 22)})`);
  assert.ok(authoredProfile(at22.get("terminal").cells, 22, 0.82).width <= 13, `terminal needs a stable narrow base (${authoredProfile(at22.get("terminal").cells, 22, 0.82).width})`);
  assert.ok(authoredProfile(at22.get("microchip").cells, 22, 0.15).width >= 13, `microchip needs deliberate top pins (${authoredProfile(at22.get("microchip").cells, 22, 0.15).width})`);
  const droneUpper = authoredProfile(at22.get("drone").cells, 22, 0.3).width;
  const droneLower = authoredProfile(at22.get("drone").cells, 22, 0.7).width;
  assert.ok(droneUpper >= 17 && droneLower >= 17, `drone needs four readable outer terminals (${droneUpper}/${droneLower})`);
});

test("dog contour integrates lateral ear shoulders into one broad canine face", () => {
  const dogEntry = parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL)
    .find(({ name }) => name === "dog");
  const dogPath = authoredQoPath(dogEntry.path);
  const dogBounds = pathExtrema(dogPath);
  const width = dogBounds.maxX - dogBounds.minX;
  const height = dogBounds.maxY - dogBounds.minY;
  const samples = pathSamples(dogPath, 48);
  const leftmost = samples.reduce((result, point) => point.x < result.x ? point : result);
  const rightmost = samples.reduce((result, point) => point.x > result.x ? point : result);
  const leftEarHeight = (leftmost.y - dogBounds.minY) / height;
  const rightEarHeight = (rightmost.y - dogBounds.minY) / height;
  assert.ok(leftEarHeight > 0.25 && leftEarHeight < 0.7,
    `dog left ear must sweep laterally from the skull shoulder (${leftEarHeight.toFixed(3)})`);
  assert.ok(rightEarHeight > 0.25 && rightEarHeight < 0.7,
    `dog right ear must sweep laterally from the skull shoulder (${rightEarHeight.toFixed(3)})`);

  const skull = continuousContourSpanAt(dogPath, 0.14);
  const earBand = continuousContourSpanAt(dogPath, 0.46);
  const chin = continuousContourSpanAt(dogPath, 0.88);
  assert.ok(earBand.width >= skull.width * 1.45,
    `dog rooted ear sweep must extend beyond its broad skull (${earBand.width.toFixed(2)}/${skull.width.toFixed(2)})`);
  assert.ok(chin.width >= width * 0.2,
    `dog needs one short broad chin plane, not a dangling center lobe (${chin.width.toFixed(2)})`);
  assert.ok(Math.abs(leftEarHeight - rightEarHeight) <= 0.03, "dog ear shoulders must remain balanced");
  assert.ok(parsePathCommands(dogEntry.path).every(({ type }) => type !== "L"),
    "dog outer contour must remain a continuous curved perimeter");

  for (const size of [22, 36]) {
    const dog = authoredContourRaster(dogEntry.path, size);
    let mirrorDifferences = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < Math.floor(size / 2); column += 1) {
        if (dog.cells[row * size + column] !== dog.cells[row * size + size - 1 - column]) {
          mirrorDifferences += 1;
        }
      }
    }
    assert.ok(mirrorDifferences / (size * size) <= 0.035,
      `dog continuous contour loses bilateral integration at ${size}px`);
    const jelly = authoredContourRaster(
      parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL).find(({ name }) => name === "jelly").path,
      size,
    );
    assert.ok(authoredRasterDifference(dog.cells, jelly.cells) >= 0.18,
      `dog/jelly must remain structurally distinct at ${size}px`);
  }
});

test("owl contour has an outward horned brow, broad facial disc, and compact feather base", () => {
  const owlEntry = parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL)
    .find(({ name }) => name === "owl");
  const owlPath = authoredQoPath(owlEntry.path);
  const bounds = pathExtrema(owlPath);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const commands = parsePathCommands(owlEntry.path);
  const brow = commands[0].values;
  assert.ok(Math.abs(brow[0] - AUTHORED_CONTOUR_CENTER) <= 1,
    "owl concave brow must stay centered between the tufts");
  assert.ok((brow[1] - pathExtrema(owlEntry.path).minY) / (pathExtrema(owlEntry.path).maxY - pathExtrema(owlEntry.path).minY) >= 0.25,
    "owl brow must be visibly concave below its outward tufts");

  const samples = pathSamples(owlPath, 48);
  const tuftBand = samples.filter((point) => point.y <= bounds.minY + height * 0.16);
  assert.ok(tuftBand.some((point) => point.x < AUTHORED_CONTOUR_CENTER - width * 0.22),
    "owl needs a left outward horn tuft");
  assert.ok(tuftBand.some((point) => point.x > AUTHORED_CONTOUR_CENTER + width * 0.22),
    "owl needs a right outward horn tuft");
  const disc = continuousContourSpanAt(owlPath, 0.53);
  const base = continuousContourSpanAt(owlPath, 0.88);
  assert.ok(disc.width >= width * 0.86, `owl facial disc is not broad enough (${disc.width.toFixed(2)})`);
  assert.ok(base.width >= width * 0.36 && base.width <= width * 0.72,
    `owl feather base must stay compact and shallow (${base.width.toFixed(2)})`);

  for (const size of [22, 36]) {
    const owl = authoredContourRaster(owlEntry.path, size);
    const jelly = authoredContourRaster(
      parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL).find(({ name }) => name === "jelly").path,
      size,
    );
    assert.ok(authoredRasterDifference(owl.cells, jelly.cells) >= 0.18,
      `owl/jelly must remain structurally distinct at ${size}px`);
    const owlFace = exactSandFaceRaster("owl", size);
    for (const comparison of ["cat", "bear", "jelly", "cloud"]) {
      assert.ok(authoredRasterDifference(owlFace, exactSandFaceRaster(comparison, size)) >= 0.115,
        `actual Sand owl face must remain distinct from ${comparison} at ${size}px`);
    }
  }
});

test("added silhouettes preserve species and machine landmarks at 22px and 36px", () => {
  const entries = new Map(parseAuthoredContourEntries(OPENBOT_GEOMETRY_TAIL).map((entry) => [entry.name, entry.path]));
  const exactSand = exactSandRuntime();
  for (const size of [22, 36]) {
    const raster = (name) => authoredContourRaster(entries.get(name), size);
    const dog = raster("dog");
    const cloud = rasterizeQoPath(exactSand.Fo.cloud.path, size);
    const bear = rasterizeQoPath(exactSand.Fo.bear.path, size);
    assert.ok(authoredRasterDifference(dog.cells, cloud.cells) >= DOG_STOCK_CLOUD_FLOOR, `dog/cloud must remain separated at ${size}px`);
    assert.ok(authoredRasterDifference(dog.cells, bear.cells) >= 0.12, `dog/bear must remain separated at ${size}px`);
    const dogFace = exactSandFaceRaster("dog", size);
    for (const comparison of ["cat", "bear", "cloud"]) {
      assert.ok(authoredRasterDifference(dogFace, exactSandFaceRaster(comparison, size)) >= 0.115,
        `actual Sand dog face must remain distinct from ${comparison} at ${size}px`);
    }

    const wolf = raster("wolf");
    const wolfCheek = authoredProfile(wolf.cells, size, 0.45);
    const wolfRuff = authoredProfile(wolf.cells, size, 0.6);
    const wolfTaper = authoredProfile(wolf.cells, size, 0.82);
    assert.ok(wolfRuff.width - wolfCheek.width >= 2, `wolf needs lateral cheek ruffs at ${size}px`);
    assert.ok(wolfTaper.width <= Math.round(size * 0.7), `wolf needs a long tapered lower face at ${size}px`);

    const fox = raster("fox");
    const foxPeaks = authoredTopPeakPositions(fox.cells, size);
    assert.ok(foxPeaks.length >= 2 && foxPeaks.at(-1) - foxPeaks[0] >= Math.round(size * 0.35), `fox needs wide diagonal ears at ${size}px`);
    assert.ok(authoredProfile(fox.cells, size, 0.82).width <= Math.round(size * 0.65), `fox needs a narrow pointed lower face at ${size}px`);
    assert.ok(authoredProfile(fox.cells, size, 0.58).width <= Math.round(size * 0.9), `fox must not grow wolf-like cheek ruffs at ${size}px`);

    const owl = raster("owl");
    assert.ok(authoredRasterDifference(owl.cells, wolf.cells) >= 0.14, `owl/wolf must remain separated at ${size}px`);

    const robot = raster("robot");
    const robotTop = authoredProfile(robot.cells, size, 0.05);
    const robotHead = authoredProfile(robot.cells, size, 0.75);
    const robotEarBand = authoredProfile(robot.cells, size, 0.45);
    assert.ok(robotTop.width <= Math.max(3, Math.round(size * 0.24)), `robot needs one narrow antenna at ${size}px`);
    assert.ok(robotEarBand.width - robotHead.width >= Math.max(2, Math.round(size * 0.08)), `robot needs paired ear blocks at ${size}px (${robotEarBand.width}/${robotHead.width})`);

    const drone = raster("drone");
    const droneUpper = authoredProfile(drone.cells, size, 0.3);
    const droneMiddle = authoredProfile(drone.cells, size, 0.52);
    const droneLower = authoredProfile(drone.cells, size, 0.7);
    assert.ok(droneUpper.width - droneMiddle.width >= 3, `drone needs a negative gap below upper terminals at ${size}px`);
    assert.ok(droneLower.width - droneMiddle.width >= 3, `drone needs a negative gap above lower terminals at ${size}px`);
  }
});

test("exact pinned Sand MBt/E9e eye cutouts remain face-safe across home, idle, and working poses", () => {
  const exactSand = exactSandRuntime();
  const poses = [
    { name: "home", pose: { turn: 0, tilt: 0, roll: 0 }, poseHome: exactSand.Ast },
    { name: "idle", pose: exactSand.Ist, poseHome: exactSand.Ast },
    { name: "working", pose: { turn: 4, tilt: 3, roll: 1.5 }, poseHome: exactSand.Ast },
  ];
  for (const name of AUTHORED_CONTOUR_NAMES) {
    const silhouette = pathSamples(exactSand.Fo[name].path, 24);
    const rendered = exactSand.E9e({ shape: name, sizePx: 36, inflatePx: 0, fill: "#000" });
    assert.match(rendered, /<path d="/);
    for (const pose of poses) {
      const eyeTransforms = exactSand.MBt(name, {
        faceTune: exactSand.Cst,
        eyeScale: exactSand._st(name),
        pose: pose.pose,
        poseHome: pose.poseHome,
      });
      for (let eyeIndex = 0; eyeIndex < eyeTransforms.length; eyeIndex += 1) {
        const eyePath = exactSand.Oje(exactSand.c3[0][eyeIndex], eyeTransforms[eyeIndex]);
        for (const point of pathSamples(eyePath, 4)) {
          assert.equal(pointInPolygon(silhouette, point.x, point.y), true, `${name} ${pose.name} exact eye cutout clips the silhouette`);
        }
      }
    }
  }
});

test("avatar patch and reverse reject mixed or duplicate replacement anchors", () => {
  const stock = `before;${VENDOR_GEOMETRY_TAIL};${VENDOR_VISIBLE_SHAPES};after`;
  const open = `before;${OPENBOT_GEOMETRY_TAIL};${OPENBOT_VISIBLE_SHAPES};after`;
  for (const mixed of [
    stock.replace(VENDOR_GEOMETRY_TAIL, OPENBOT_GEOMETRY_TAIL),
    stock.replace(VENDOR_VISIBLE_SHAPES, OPENBOT_VISIBLE_SHAPES),
    `${stock};${OPENBOT_GEOMETRY_TAIL};${OPENBOT_VISIBLE_SHAPES}`,
  ]) {
    assert.throws(() => patchAvatarCatalogSource(mixed), /mixed|partial|already patched|ambiguous/i);
  }
  assert.throws(
    () => patchAvatarCatalogSource(`${stock};${OPENBOT_GEOMETRY_TAIL}${OPENBOT_GEOMETRY_TAIL}`),
    /ambiguous|mixed|already patched/i,
  );
  for (const mixed of [
    open.replace(OPENBOT_GEOMETRY_TAIL, VENDOR_GEOMETRY_TAIL),
    open.replace(OPENBOT_VISIBLE_SHAPES, VENDOR_VISIBLE_SHAPES),
    `${open};${VENDOR_GEOMETRY_TAIL};${VENDOR_VISIBLE_SHAPES}`,
  ]) {
    assert.throws(() => reverseAvatarCatalogSource(mixed), /mixed|partial|already patched|ambiguous/i);
  }
  assert.throws(
    () => reverseAvatarCatalogSource(`${open};${OPENBOT_VISIBLE_SHAPES}${OPENBOT_VISIBLE_SHAPES}`),
    /ambiguous|mixed|partial/i,
  );
});

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
  assert.equal((patched.match(/mode==="local-protocol"/g) ?? []).length, 4);
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

test("local Create-your-own photo control opens the native Sand character chooser", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  assert.match(patched, /openbotNewBotAvatarPickerLocalProtocol/);
  assert.match(patched, /window\.openbotProtocol\?\.schemaVersion===1&&window\.openbotProtocol\?\.mode==="local-protocol"/);
  assert.match(patched, /openbotNewBotAvatarPickerMenu/);
  assert.match(patched, /M4n/);
  assert.match(patched, /event\.preventDefault\(\),event\.stopPropagation\(\)/);
  assert.match(patched, /avatarShape/);
  assert.match(patched, /avatarColor/);
  assert.equal((patched.match(/openbotNewBotAvatarPickerLocalProtocol/g) ?? []).length, 2);
});

test("native Ozn dispatch and resolve fragments preserve explicit shape and color through Jyn", async () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  const patchedResolveAt = patched.indexOf(OPENBOT_NEW_BOT_CREATE_RESOLVE);
  const patchedDispatchAt = patched.indexOf(OPENBOT_NEW_BOT_CREATE_DISPATCH);
  assert.ok(patchedResolveAt >= 0);
  assert.ok(patchedDispatchAt >= 0);
  const createArgs = await executeNewBotCreateFragments(
    patched.slice(patchedResolveAt, patchedResolveAt + OPENBOT_NEW_BOT_CREATE_RESOLVE.length),
    patched.slice(patchedDispatchAt, patchedDispatchAt + OPENBOT_NEW_BOT_CREATE_DISPATCH.length),
    {
      name: "Luna",
      description: "Preserve me",
      avatarPngBase64: "data:image/png;base64,avatar",
      avatarShape: "cat",
      avatarColor: "violet",
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(createArgs)), {
    name: "Luna",
    description: "Preserve me",
    origin: "user",
    isKickstartRequested: true,
    avatarShape: "cat",
    avatarColor: "violet",
  });
  assert.match(patched, /avatarShape:Ee\.avatarShape/);
  assert.match(patched, /avatarColor:Ee\.avatarColor/);
  assert.doesNotMatch(
    patched,
    new RegExp(STOCK_NEW_BOT_CREATE_RESOLVE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(
    patched,
    new RegExp(STOCK_NEW_BOT_CREATE_DISPATCH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("native Ozn/Jyn create path omits the unselected one-sided avatar field", async () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );
  const resolve = patched.slice(
    patched.indexOf(OPENBOT_NEW_BOT_CREATE_RESOLVE),
    patched.indexOf(OPENBOT_NEW_BOT_CREATE_RESOLVE) + OPENBOT_NEW_BOT_CREATE_RESOLVE.length,
  );
  const dispatch = patched.slice(
    patched.indexOf(OPENBOT_NEW_BOT_CREATE_DISPATCH),
    patched.indexOf(OPENBOT_NEW_BOT_CREATE_DISPATCH) + OPENBOT_NEW_BOT_CREATE_DISPATCH.length,
  );
  const common = {
    name: "Luna",
    description: "Preserve me",
    avatarPngBase64: "data:image/png;base64,avatar",
  };
  const shapeOnly = await executeNewBotCreateFragments(
    resolve,
    dispatch,
    { ...common, avatarShape: "cat" },
  );
  assert.equal(Object.hasOwn(shapeOnly, "avatarShape"), true);
  assert.equal(Object.hasOwn(shapeOnly, "avatarColor"), false);
  const colorOnly = await executeNewBotCreateFragments(
    resolve,
    dispatch,
    { ...common, avatarColor: "violet" },
  );
  assert.equal(Object.hasOwn(colorOnly, "avatarShape"), false);
  assert.equal(Object.hasOwn(colorOnly, "avatarColor"), true);
});

test("avatar picker definition is module-scope adjacent to the registry, not inside Ozn commit rendering", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );
  const registryAt = patched.indexOf(OPENBOT_VISIBLE_SHAPES);
  const pickerAt = patched.indexOf(OPENBOT_NEW_BOT_AVATAR_PICKER);
  const commitAt = patched.indexOf(OPENBOT_NEW_BOT_COMMIT);
  assert.equal(registryAt >= 0, true);
  assert.equal(pickerAt, registryAt + OPENBOT_VISIBLE_SHAPES.length);
  assert.notEqual(pickerAt, commitAt + OPENBOT_NEW_BOT_COMMIT.length);
  assert.doesNotMatch(
    patched,
    /openbotNewBotAvatarPickerLocalProtocol\(\)\)return openbotOriginalCreateOwnForm\(n\);const \{onCreate\}=n,\[staged/,
  );
});

test("avatar picker keeps hook order stable across local and non-local rerenders and validates registry values at runtime", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );
  assert.match(patched, /const \[staged,setStaged\]=x\.useState\(null\)/);
  assert.match(patched, /Pq\.includes\(staged\.avatarShape\)/);
  assert.match(patched, /DQ\.some\(.*staged\.avatarColor/s);
  assert.match(patched, /throw new Error\("New Bot avatar shape is unavailable"\)/);
  assert.match(patched, /throw new Error\("New Bot avatar color is unavailable"\)/);
  assert.match(patched, /isCharacterActive:active/);
  assert.match(patched, /active=Boolean\(staged\?\.avatarShape!=null&&staged\?\.avatarColor!=null\)/);
});

test("stock M4n keeps independent explicit shape and color pressed states", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );
  assert.match(patched, /shapeIsExplicit:a=i,colorIsExplicit:v=i/);
  assert.match(patched, /const O=a&&f===M/);
  assert.equal((patched.match(/v&&d===M\.id/g) ?? []).length, 3);
  assert.equal((patched.match(/i&&d===M\.id/g) ?? []).length, 0);
  assert.match(patched, /e\[11\]!==i\+"\|"\+a/);
  assert.match(patched, /e\[11\]=i\+"\|"\+a/);
  assert.match(patched, /e\[23\]!==i\+"\|"\+v/);
  assert.match(patched, /e\[23\]=i\+"\|"\+v/);
  assert.match(patched, /shapeIsExplicit:staged\?\.avatarShape!=null/);
  assert.match(patched, /colorIsExplicit:staged\?\.avatarColor!=null/);
});

test("evaluated transformed M4n renders independent pressed states and refreshes memoized choices", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );
  const harness = createEvaluatedM4nHarness(patched);
  const commits = [];
  const base = {
    agent: { id: "create-your-own", avatarShape: null, avatarColor: null },
    character: { commitCharacter: (value) => commits.push(value) },
    isCharacterActive: false,
  };
  const shapeOnly = {
    ...base,
    staged: { avatarShape: "cat" },
    shapeIsExplicit: true,
    colorIsExplicit: false,
  };
  let tree = harness.render(shapeOnly);
  let shapeButtons = tree.props.children[0];
  let colorButtons = tree.props.children[1];
  assert.equal(shapeButtons.find((button) => button.props.key === "cat").props["aria-pressed"], true);
  assert.equal(colorButtons.filter((button) => button.props["aria-pressed"]).length, 0);
  shapeButtons.find((button) => button.props.key === "cat").props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(commits.at(-1))), { avatarShape: "cat" });

  tree = harness.render({ ...shapeOnly, shapeIsExplicit: false });
  assert.equal(tree.props.children[0].filter((button) => button.props["aria-pressed"]).length, 0);
  tree = harness.render(shapeOnly);
  assert.equal(tree.props.children[0].find((button) => button.props.key === "cat").props["aria-pressed"], true);

  const colorOnly = {
    ...base,
    staged: { avatarColor: "violet" },
    shapeIsExplicit: false,
    colorIsExplicit: true,
  };
  tree = harness.render(colorOnly);
  shapeButtons = tree.props.children[0];
  colorButtons = tree.props.children[1];
  assert.equal(shapeButtons.filter((button) => button.props["aria-pressed"]).length, 0);
  assert.equal(colorButtons.find((button) => button.props.key === "violet").props["aria-pressed"], true);
  assert.equal(colorButtons.filter((button) => button.props["aria-pressed"]).length, 1);
  colorButtons.find((button) => button.props.key === "violet").props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(commits.at(-1))), { avatarColor: "violet" });

  tree = harness.render({ ...colorOnly, colorIsExplicit: false });
  assert.equal(tree.props.children[1].filter((button) => button.props["aria-pressed"]).length, 0);
  tree = harness.render(colorOnly);
  assert.equal(tree.props.children[1].find((button) => button.props.key === "violet").props["aria-pressed"], true);
});

test("avatar picker uses the stock Sand modal primitives and preventScroll focus restoration", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );
  assert.match(patched, /Zt\.Root/);
  assert.match(patched, /Zt\.Header/);
  assert.match(patched, /Zt\.Title/);
  assert.match(patched, /Zt\.CloseButton/);
  assert.match(patched, /Zt\.Body/);
  assert.match(patched, /onOpenChange/);
  assert.match(patched, /p\.jsx\(Re,\{id:"5XRPbV"\}\)/);
  assert.match(patched, /focus\?\.\(\{preventScroll:!0\}\)/);
  assert.doesNotMatch(patched, /aria-label:"Back"/);
  assert.doesNotMatch(patched, /["']aria-label["']:\"Character\"/);
});

test("executable picker harness covers local/non-local click paths, staging, rerender, dismissal, focus, and final create args", () => {
  const harness = createPickerBrowserHarness();
  let tree = harness.render();
  const root = tree;
  const trigger = harness.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
  assert.ok(trigger);
  const localEvent = {
    target: { closest: () => trigger },
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  root.props.onClickCapture(localEvent);
  assert.equal(localEvent.prevented, true);
  assert.equal(localEvent.stopped, true);
  tree = harness.render();
  let modal = harness.find(tree, (node) => node.type === "Zt.Root");
  assert.ok(modal);
  const title = harness.find(modal, (node) => node.type === "Zt.Title");
  const localizedTitle = harness.find(title, (node) => node.type === "Re");
  assert.equal(localizedTitle.props.id, "5XRPbV");
  assert.equal(localizedTitle.props.translatedText, "Editar avatar");
  let character = harness.find(tree, (node) => node.type === "M4n");
  assert.ok(character);
  assert.equal(character.props.isCharacterActive, false);
  assert.equal(harness.find(tree, (node) => node.type === "SandRenderer"), null);
  character.props.character.commitCharacter({ avatarShape: "cat" });
  tree = harness.render();
  character = harness.find(tree, (node) => node.type === "M4n");
  assert.equal(character.props.isCharacterActive, false);
  assert.equal(character.props.shapeIsExplicit, true);
  assert.equal(character.props.colorIsExplicit, false);
  character.props.character.commitCharacter({ avatarColor: "violet" });
  tree = harness.render();
  character = harness.find(tree, (node) => node.type === "M4n");
  assert.equal(character.props.isCharacterActive, true);
  assert.equal(character.props.shapeIsExplicit, true);
  assert.equal(character.props.colorIsExplicit, true);
  const preview = harness.find(tree, (node) => node.type === "SandRenderer");
  assert.deepEqual(
    (({ color, paused, shape, sizePx }) => ({ color, paused, shape, sizePx }))(preview.props),
    { color: "violet", paused: true, shape: "cat", sizePx: 64 },
  );
  modal = harness.find(tree, (node) => node.type === "Zt.Root");
  assert.ok(harness.find(modal, (node) => node.type === "Zt.CloseButton"));
  let closeButtonResult;
  const closeButtonOnOpenChange = modal.props.onOpenChange;
  modal.props.onOpenChange = (open) => {
    closeButtonResult = open;
    closeButtonOnOpenChange(open);
  };
  // CloseButton is the stock primitive; this invokes the callback boundary it owns.
  modal.props.onOpenChange(false);
  assert.equal(closeButtonResult, false);
  tree = harness.render();
  assert.equal(harness.find(tree, (node) => node.type === "Zt.Root"), null);
  assert.equal(harness.focusCalls().at(-1)?.preventScroll, true);
  const form = harness.find(tree, (node) => node.type === "stock-form");
  assert.equal(form.props.name, "Luna");
  assert.equal(form.props.description, "Preserve me");
  form.props.submit.props.onClick();
  assert.deepEqual(harness.createdArgs(), {
    name: "Luna",
    description: "Preserve me",
    avatarPngBase64: null,
    avatarShape: "cat",
    avatarColor: "violet",
  });
  harness.protocol.value = { schemaVersion: 1, mode: "local-protocol" };
  tree = harness.render();
  const reopenTrigger = harness.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
  const reopenEvent = {
    target: { closest: () => reopenTrigger },
    preventDefault() {},
    stopPropagation() {},
  };
  tree.props.onClickCapture(reopenEvent);
  tree = harness.render();
  modal = harness.find(tree, (node) => node.type === "Zt.Root");
  // The genuine Sand Root turns Escape into onOpenChange(false).
  let escapeResult;
  const escapeOnOpenChange = modal.props.onOpenChange;
  modal.props.onOpenChange = (open) => {
    escapeResult = open;
    escapeOnOpenChange(open);
  };
  modal.props.onOpenChange(false);
  assert.equal(escapeResult, false);
  tree = harness.render();
  assert.equal(harness.find(tree, (node) => node.type === "Zt.Root"), null);
  assert.equal(harness.focusCalls().at(-1)?.preventScroll, true);
  const backdropTrigger = harness.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
  tree.props.onClickCapture({
    target: { closest: () => backdropTrigger },
    preventDefault() {},
    stopPropagation() {},
  });
  tree = harness.render();
  modal = harness.find(tree, (node) => node.type === "Zt.Root");
  let backdropResult;
  const backdropOnOpenChange = modal.props.onOpenChange;
  modal.props.onOpenChange = (open) => {
    backdropResult = open;
    backdropOnOpenChange(open);
  };
  modal.props.onOpenChange(false);
  assert.equal(backdropResult, false);
  tree = harness.render();
  assert.equal(harness.find(tree, (node) => node.type === "Zt.Root"), null);
  assert.equal(harness.focusCalls().at(-1)?.preventScroll, true);
  harness.protocol.value = { schemaVersion: 1, mode: "remote" };
  tree = harness.render();
  const nonLocalTrigger = harness.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
  nonLocalTrigger.props.onClick();
  assert.equal(harness.filePickerCalls(), 1);

  const hostile = createPickerBrowserHarness();
  tree = hostile.render();
  const hostileTrigger = hostile.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
  tree.props.onClickCapture({
    target: { closest: () => hostileTrigger },
    preventDefault() {},
    stopPropagation() {},
  });
  tree = hostile.render();
  character = hostile.find(tree, (node) => node.type === "M4n");
  character.props.character.commitCharacter({ avatarShape: "hostile-shape" });
  tree = hostile.render();
  const hostileForm = hostile.find(tree, (node) => node.type === "stock-form");
  assert.throws(() => hostileForm.props.submit.props.onClick(), /shape.*unavailable/i);
  assert.equal(hostile.createdArgs(), null);
});

test("one-sided shape and color choices remain pressed across reopen and send only explicit fields", () => {
  const exercise = (field, value, expectedFlags, expectedArgs) => {
    const harness = createPickerBrowserHarness();
    let tree = harness.render();
    const trigger = harness.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
    tree.props.onClickCapture({
      target: { closest: () => trigger },
      preventDefault() {},
      stopPropagation() {},
    });
    tree = harness.render();
    let character = harness.find(tree, (node) => node.type === "M4n");
    character.props.character.commitCharacter({ [field]: value });
    tree = harness.render();
    character = harness.find(tree, (node) => node.type === "M4n");
    assert.equal(character.props.isCharacterActive, false);
    assert.deepEqual(
      { shapeIsExplicit: character.props.shapeIsExplicit, colorIsExplicit: character.props.colorIsExplicit },
      expectedFlags,
    );

    const modal = harness.find(tree, (node) => node.type === "Zt.Root");
    modal.props.onOpenChange(false);
    tree = harness.render();
    const form = harness.find(tree, (node) => node.type === "stock-form");
    form.props.submit.props.onClick();
    assert.deepEqual(harness.createdArgs(), expectedArgs);

    const reopen = harness.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
    tree.props.onClickCapture({
      target: { closest: () => reopen },
      preventDefault() {},
      stopPropagation() {},
    });
    tree = harness.render();
    character = harness.find(tree, (node) => node.type === "M4n");
    assert.deepEqual(
      { shapeIsExplicit: character.props.shapeIsExplicit, colorIsExplicit: character.props.colorIsExplicit },
      expectedFlags,
    );
  };

  exercise(
    "avatarShape",
    "cat",
    { shapeIsExplicit: true, colorIsExplicit: false },
    { name: "Luna", description: "Preserve me", avatarPngBase64: null, avatarShape: "cat" },
  );
  exercise(
    "avatarColor",
    "violet",
    { shapeIsExplicit: false, colorIsExplicit: true },
    { name: "Luna", description: "Preserve me", avatarPngBase64: null, avatarColor: "violet" },
  );
});

test("local character choice stages only explicit shape/color and preserves form values on back", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  assert.match(patched, /openbotNewBotAvatarPickerMerge/);
  assert.match(patched, /onCreate:openbotNewBotAvatarPickerMerge/);
  assert.match(patched, /n\.onCreate\(openbotNewBotAvatarPickerMerge\(value,staged\)\)/);
  assert.match(patched, /staged/);
  assert.match(patched, /openbotNewBotAvatarPickerBack/);
  assert.match(patched, /querySelector\('button\[aria-label\*="Bot photo"\]'\)/);
  assert.match(patched, /\.focus\?\.\(\{preventScroll:!0\}\)/);
  assert.match(patched, /next\.avatarShape=staged\.avatarShape/);
  assert.match(patched, /next\.avatarColor=staged\.avatarColor/);
});

test("stock Create-your-own keeps the original file-photo form behind the local predicate", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  assert.match(patched, /style:\{display:"contents"\}/);
  assert.match(patched, /onClickCapture:local\?openPicker:void 0/);
  assert.match(
    patched,
    /p\.jsx\(openbotOriginalCreateOwnForm,local\?\{\.\.\.n,onCreate:openbotNewBotAvatarPickerMergeForCreate\}:n,"openbot-new-bot-create-own-form"\)/,
  );
  assert.match(patched, /openbotOriginalCreateOwnForm/);
  assert.doesNotMatch(patched, /pickAvatarSource\(\).*openbotNewBotAvatarPickerMenu/);
});

test("wrapper keeps the original Create-your-own child boundary and form hooks stable across protocol transitions", () => {
  const exercise = (modes) => {
    const harness = createPickerBrowserHarness();
    let tree;
    for (const [index, mode] of modes.entries()) {
      harness.protocol.value = { schemaVersion: 1, mode };
      tree = harness.render();
      const form = harness.find(tree, (node) => node.type === "stock-form");
      assert.ok(form);
      if (index === 0) {
        form.props.setName("Nova");
        form.props.setDescription("State survives");
        tree = harness.render();
      }
      const currentForm = harness.find(tree, (node) => node.type === "stock-form");
      assert.deepEqual(
        { name: currentForm.props.name, description: currentForm.props.description },
        { name: "Nova", description: "State survives" },
      );
    }
  };

  exercise(["remote", "local", "remote"]);
  exercise(["local", "remote", "local"]);
});

test("real reconciliation keeps one layout-neutral root, form state, and staged choices across protocol transitions", () => {
  const { patchVendorRendererSource } = require(patchPath);
  const patched = patchVendorRendererSource(
    SYNTHETIC_VENDOR_RENDERER,
    sha256Text(SYNTHETIC_VENDOR_RENDERER),
  );

  function openAndStage(harness, tree) {
    const trigger = harness.find(tree, (node) => node.type === "button" && node.props["aria-label"] === "Add a Bot photo");
    assert.ok(trigger);
    const event = {
      target: { closest: () => trigger },
      preventDefault() {},
      stopPropagation() {},
    };
    assert.equal(typeof tree.props.onClickCapture, "function");
    tree.props.onClickCapture(event);
    tree = harness.render();
    let character = harness.find(tree, (node) => node.type === "M4n");
    assert.ok(character);
    character.props.character.commitCharacter({ avatarShape: "cat" });
    tree = harness.render();
    character = harness.find(tree, (node) => node.type === "M4n");
    character.props.character.commitCharacter({ avatarColor: "violet" });
    return harness.render();
  }

  function exercise(modes, stageBeforeTransition) {
    const harness = createReconciledPickerBrowserHarness();
    let tree;
    harness.protocol.value = { schemaVersion: 1, mode: modes[0] };
    tree = harness.render();
    let form = harness.find(tree, (node) => node.type === "stock-form");
    assert.ok(form);
    form.props.setName("Nova");
    form.props.setDescription("State survives");
    tree = harness.render();
    if (stageBeforeTransition) tree = openAndStage(harness, tree);

    for (const mode of modes.slice(1)) {
      harness.protocol.value = { schemaVersion: 1, mode };
      tree = harness.render();
      assert.equal(tree.type, "div");
      assert.equal(tree.props.style.display, "contents");
      form = harness.find(tree, (node) => node.type === "stock-form");
      assert.deepEqual(
        { name: form.props.name, description: form.props.description },
        { name: "Nova", description: "State survives" },
      );
      if (mode !== "local-protocol") {
        assert.equal(harness.find(tree, (node) => node.type === "Zt.Root"), null);
        assert.equal(tree.props.onClickCapture, undefined);
      }
      if (mode === "local-protocol") {
        const character = harness.find(tree, (node) => node.type === "M4n");
        assert.equal(character, null, "local reopening must wait for the photo trigger");
        tree = openAndStage(harness, tree);
      }
    }

    if (modes.at(-1) === "local-protocol") {
      const character = harness.find(tree, (node) => node.type === "M4n");
      assert.equal(character.props.staged.avatarShape, "cat");
      assert.equal(character.props.staged.avatarColor, "violet");
    }
  }

  // The first route exercises remote -> local -> remote and local reopening;
  // the second exercises the inverse local -> remote -> local route.
  exercise(["remote", "local-protocol", "remote", "local-protocol"], false);
  exercise(["local-protocol", "remote", "local-protocol"], true);

  assert.match(patched, /style:\{display:"contents"\}/);
  assert.match(patched, /onClickCapture:local\?openPicker/);
  assert.doesNotMatch(patched, /if\(!local\)return p\.jsx\(openbotOriginalCreateOwnForm,n\)/);
  assert.match(patched, /p\.jsx\(openbotOriginalCreateOwnForm,local\?\{\.\.\.n,onCreate:openbotNewBotAvatarPickerMergeForCreate\}:n,"openbot-new-bot-create-own-form"\)/);
});

test("new-bot avatar picker staging omits defaults and preserves explicit form values", () => {
  const form = { name: "Luna", description: "A focused helper", avatarPngBase64: null };
  const untouched = mergeNewBotAvatarSelection(form, null);
  assert.deepEqual(untouched, form);
  assert.equal(Object.hasOwn(untouched, "avatarShape"), false);
  assert.equal(Object.hasOwn(untouched, "avatarColor"), false);
  assert.deepEqual(
    mergeNewBotAvatarSelection(form, { avatarShape: "cat", avatarColor: "violet" }),
    { ...form, avatarShape: "cat", avatarColor: "violet" },
  );
  assert.throws(
    () => mergeNewBotAvatarSelection(form, { avatarShape: "not-a-shape" }),
    /shape.*unavailable/i,
  );
  assert.throws(
    () => mergeNewBotAvatarSelection(form, { avatarColor: "not-a-color" }),
    /color.*unavailable/i,
  );
});

test("new-bot avatar picker transform is byte-reversible and fails closed on anchor drift", () => {
  const source = `before;${OPENBOT_VISIBLE_SHAPES};after`;
  const patched = patchNewBotAvatarPickerSource(source);
  assert.equal((patched.match(new RegExp(OPENBOT_NEW_BOT_AVATAR_PICKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  assert.equal(reverseNewBotAvatarPickerSource(patched), source);
  assert.throws(
    () => patchNewBotAvatarPickerSource(`${patched}${OPENBOT_VISIBLE_SHAPES}`),
    /already|ambiguous/i,
  );
  assert.throws(
    () => patchNewBotAvatarPickerSource(source.replace(OPENBOT_VISIBLE_SHAPES, "missing")),
    /not found|ambiguous/i,
  );
  assert.throws(() => reverseNewBotAvatarPickerSource(source), /adjacent|not found|ambiguous/i);
  assert.throws(
    () => reverseNewBotAvatarPickerSource(`${patched}${OPENBOT_NEW_BOT_AVATAR_PICKER}`),
    /adjacent|not found|ambiguous/i,
  );
  assert.throws(
    () => patchNewBotAvatarPickerSource(`${VENDOR_VISIBLE_SHAPES};${OPENBOT_VISIBLE_SHAPES}`),
    /mixed|ambiguous/i,
  );
});

test("new-bot avatar picker inverse requires exact registry/picker adjacency", () => {
  const source = `before;${OPENBOT_VISIBLE_SHAPES};after`;
  let patched;
  assert.doesNotThrow(() => { patched = patchNewBotAvatarPickerSource(source); });
  assert.equal(reverseNewBotAvatarPickerSource(patched), source);
  assert.throws(
    () => reverseNewBotAvatarPickerSource(`${OPENBOT_VISIBLE_SHAPES}gap${OPENBOT_NEW_BOT_AVATAR_PICKER}`),
    /adjacent/i,
  );
  assert.throws(
    () => reverseNewBotAvatarPickerSource(`${OPENBOT_VISIBLE_SHAPES}${OPENBOT_NEW_BOT_AVATAR_PICKER}moved${OPENBOT_NEW_BOT_AVATAR_PICKER}`),
    /ambiguous|adjacent/i,
  );
});

test("new-bot create payload inverse round-trips adjacent resolve and dispatch anchors exactly", () => {
  const rendererPatch = require(patchPath);
  assert.equal(typeof rendererPatch.reverseNewBotCreatePayloadSource, "function");
  const source = `before;${STOCK_NEW_BOT_CREATE_RESOLVE}middle;${STOCK_NEW_BOT_CREATE_DISPATCH};after`;
  const patched = rendererPatch.patchNewBotCreatePayloadSource(source);
  assert.equal(rendererPatch.reverseNewBotCreatePayloadSource(patched), source);

  const duplicateResolve = `before;${STOCK_NEW_BOT_CREATE_RESOLVE}${STOCK_NEW_BOT_CREATE_RESOLVE}${STOCK_NEW_BOT_CREATE_DISPATCH};after`;
  const duplicateDispatch = `before;${STOCK_NEW_BOT_CREATE_RESOLVE}${STOCK_NEW_BOT_CREATE_DISPATCH}${STOCK_NEW_BOT_CREATE_DISPATCH};after`;
  const mixed = `before;${OPENBOT_NEW_BOT_CREATE_RESOLVE}${STOCK_NEW_BOT_CREATE_DISPATCH};after`;
  const alreadyReversed = source;
  for (const invalid of [
    "before;missing;after",
    `before;${STOCK_NEW_BOT_CREATE_RESOLVE};after`,
    `before;${STOCK_NEW_BOT_CREATE_DISPATCH};after`,
    duplicateResolve,
    duplicateDispatch,
    mixed,
    alreadyReversed,
  ]) {
    assert.throws(
      () => rendererPatch.reverseNewBotCreatePayloadSource(invalid),
      /missing|not found|ambiguous|mixed|already|patched/i,
    );
  }
  assert.throws(
    () => rendererPatch.patchNewBotCreatePayloadSource(`${source}${STOCK_NEW_BOT_CREATE_RESOLVE}`),
    /ambiguous|already|mixed/i,
  );
});

test("M4n transform has an exact inverse and fails closed on every segment anchor state", () => {
  const rendererPatch = require(patchPath);
  assert.equal(typeof rendererPatch.patchNewBotCharacterEditorSource, "function");
  assert.equal(typeof reverseNewBotCharacterEditorSource, "function");
  const stock = `before;${STOCK_M4N_FRAGMENT};after`;
  const patched = rendererPatch.patchNewBotCharacterEditorSource(stock);
  assert.equal(reverseNewBotCharacterEditorSource(patched), stock);
  assert.throws(
    () => rendererPatch.patchNewBotCharacterEditorSource(patched),
    /already|ambiguous|patched/i,
  );
  assert.throws(
    () => reverseNewBotCharacterEditorSource(stock),
    /already|reversed|ambiguous/i,
  );
  assert.throws(
    () => rendererPatch.patchNewBotCharacterEditorSource(`${stock}${STOCK_M4N_FRAGMENT}`),
    /ambiguous|duplicate/i,
  );
  assert.throws(
    () => reverseNewBotCharacterEditorSource(`${patched}${patched}`),
    /ambiguous|duplicate/i,
  );
  assert.throws(
    () => rendererPatch.patchNewBotCharacterEditorSource(`${stock}class O4n`),
    /ambiguous|duplicate|end anchor/i,
  );
  assert.throws(
    () => reverseNewBotCharacterEditorSource(`${patched}class O4n`),
    /ambiguous|duplicate|end anchor/i,
  );
  assert.throws(
    () => rendererPatch.patchNewBotCharacterEditorSource("missing"),
    /not found|anchor/i,
  );
  assert.throws(
    () => reverseNewBotCharacterEditorSource("missing"),
    /not found|anchor/i,
  );
  const duplicateShape = stock.replace("const O=i&&f===M", "const O=i&&f===M;const O=i&&f===M");
  assert.throws(
    () => rendererPatch.patchNewBotCharacterEditorSource(duplicateShape),
    /ambiguous|duplicate/i,
  );
});

test("native View Bot overview mounts one local Computer host and round-trips its exact anchor", () => {
  const rendererPatch = require(patchPath);
  assert.equal(typeof rendererPatch.patchBotOverviewSource, "function");
  assert.equal(typeof rendererPatch.reverseBotOverviewSource, "function");
  const stock = `before;${STOCK_BOT_OVERVIEW_COMPUTER};after`;
  const patched = rendererPatch.patchBotOverviewSource(stock);
  assert.equal((patched.match(/data-openbot-bot-overview-computer-host/g) ?? []).length, 1);
  assert.match(patched, /window\.openbotProtocol\?\.schemaVersion===1&&window\.openbotProtocol\?\.mode==="local-protocol"/);
  assert.equal(rendererPatch.reverseBotOverviewSource(patched), stock);
  assert.throws(() => rendererPatch.patchBotOverviewSource(patched), /already|patched|anchor/i);
  assert.throws(() => rendererPatch.reverseBotOverviewSource(stock), /already|stock|anchor/i);
  for (const invalid of [
    "before;missing;after",
    `before;${STOCK_BOT_OVERVIEW_COMPUTER}${STOCK_BOT_OVERVIEW_COMPUTER};after`,
    `before;${STOCK_BOT_OVERVIEW_COMPUTER};${OPENBOT_BOT_OVERVIEW_COMPUTER};after`,
  ]) {
    assert.throws(
      () => rendererPatch.patchBotOverviewSource(invalid),
      /missing|not found|ambiguous|mixed|already|patched/i,
    );
  }
  assert.throws(
    () => rendererPatch.reverseBotOverviewSource(`${patched}${OPENBOT_BOT_OVERVIEW_COMPUTER}`),
    /ambiguous|duplicate|mixed/i,
  );
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
    ["avatar geometry", VENDOR_GEOMETRY_TAIL],
    ["visible avatar registry", VENDOR_VISIBLE_SHAPES],
    ["native shell", STOCK_NATIVE_SHELL_GATE],
    ["local capability", STOCK_SEND_JOURNAL_DEFINITION],
    ["reconnect", STOCK_RECONNECT_GATE],
    ["focus", STOCK_FOCUS_GATE],
    ["composer", STOCK_COMPOSER_ACCOUNT_GATE],
    ["composer model picker host", STOCK_PROMPT_TRAILING],
    ["new bot recipient", STOCK_NEW_BOT_RECIPIENT],
    ["new bot commit", STOCK_NEW_BOT_COMMIT],
    ["View Bot overview Computer host", STOCK_BOT_OVERVIEW_COMPUTER],
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
  for (const shape of ADDED_AVATAR_SHAPES) {
    assert.match(vendorRenderer, new RegExp(`${shape}:qo\\(`));
  }
  assert.match(
    vendorRenderer,
    new RegExp(OPENBOT_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const reversedAvatarRenderer = reverseAvatarCatalogSource(vendorRenderer);
  assert.match(
    reversedAvatarRenderer,
    new RegExp(VENDOR_GEOMETRY_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    reversedAvatarRenderer,
    new RegExp(VENDOR_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
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
  assert.match(css, /\.codex-power-view-track\s*\{[^}]*align-items:\s*flex-start/s);
  assert.match(css, /\.codex-power-view-track\s*\{[^}]*height:\s*var\(--simple-view-height,\s*auto\)/s);
  assert.match(css, /\.codex-power-menu\[data-view="advanced"\]\s+\.codex-power-view-track\s*\{[^}]*height:\s*var\(--advanced-view-height,\s*auto\)/s);
  assert.match(
    css,
    /\.codex-power-menu\.transitions-ready \.codex-power-view-track\s*\{[^}]*transition:\s*(?:transform 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\),\s*height 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\)|height 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\),\s*transform 300ms cubic-bezier\(\.23,\s*1,\s*\.32,\s*1\))/s,
  );
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
  const reducedMotionCss = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(
    reducedMotionCss,
    /\.codex-model-dock\s*,\s*\.codex-model-dock \*\s*\{[^}]*transition:\s*none\s*!important/s,
  );
  for (const pickerSurface of ["codex-power-menu", "codex-power-popover", "codex-power-flyout"]) {
    assert.match(css, new RegExp(`\\.${pickerSurface}\\b`));
    assert.match(reducedMotionCss, /\.codex-model-dock \*/);
  }
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
