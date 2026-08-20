"use strict";

const assert = require("node:assert/strict");
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
  OPENBOT_GEOMETRY_TAIL,
  OPENBOT_NEW_BOT_COMMIT,
  OPENBOT_NEW_BOT_AVATAR_PICKER,
  OPENBOT_NEW_BOT_CREATE_DISPATCH,
  OPENBOT_NEW_BOT_CREATE_RESOLVE,
  OPENBOT_VISIBLE_SHAPES,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarCatalogSource,
  patchNewBotAvatarPickerSource,
  mergeNewBotAvatarSelection,
  reverseAvatarCatalogSource,
  reverseNewBotCharacterEditorSource,
  reverseNewBotAvatarPickerSource,
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

function parseRelativeCoordinate(token) {
  const match = /^ze(?:(?<sign>[+-])(?<magnitude>\d+))?$/.exec(token.trim());
  assert.ok(match, `unexpected coordinate token: ${token}`);
  return match.groups.sign === "-" ? -Number(match.groups.magnitude) : Number(match.groups.magnitude ?? 0);
}

function parseRoundedGeometryEntries(source) {
  const entries = [];
  const entryPattern = /([a-z]+):qo\("[^"]+",Ost\(\[\[/g;
  let match;
  while ((match = entryPattern.exec(source)) !== null) {
    const pointsStart = entryPattern.lastIndex;
    const pointsEnd = source.indexOf("]],", pointsStart);
    assert.ok(pointsEnd >= pointsStart, `missing points terminator for ${match[1]}`);
    const points = source
      .slice(pointsStart, pointsEnd)
      .split("],[")
      .map((pair) => {
        const [x, y] = pair.replace(/\]$/, "").split(",");
        assert.notEqual(y, undefined, `malformed point for ${match[1]}`);
        return { x: parseRelativeCoordinate(x), y: parseRelativeCoordinate(y) };
      });
    const radiiStart = pointsEnd + 3;
    const radiiEnd = source.indexOf("))", radiiStart);
    assert.ok(radiiEnd >= radiiStart, `missing radii terminator for ${match[1]}`);
    const radiiSource = source.slice(radiiStart, radiiEnd);
    const radii = radiiSource.startsWith("[")
      ? radiiSource.slice(1, -1).split(",").map((radius) => Number(radius))
      : Array(points.length).fill(Number(radiiSource));
    entries.push({ name: match[1], points, radii });
    entryPattern.lastIndex = radiiEnd + 3;
  }
  return entries;
}

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

function roundedGeometryViolations(entry) {
  const violations = [];
  const { name, points, radii } = entry;
  if (points.length !== radii.length) {
    violations.push(`${name}: point/radius count mismatch`);
    return violations;
  }
  for (let first = 0; first < points.length; first += 1) {
    if (Math.abs(points[first].x) > 116 || Math.abs(points[first].y) > 116) {
      violations.push(`${name}: point ${first} exceeds the identity view box`);
    }
    for (let second = first + 1; second < points.length; second += 1) {
      if (points[first].x === points[second].x && points[first].y === points[second].y) {
        violations.push(`${name}: duplicate points ${first}/${second}`);
      }
    }
  }
  const segments = [];
  const originalSegments = [];
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    const edgeLength = distance(points[index], points[next]);
    if (edgeLength <= GEOMETRY_EPSILON) violations.push(`${name}: zero edge ${index}`);
    if (!Number.isFinite(radii[index]) || radii[index] < 0) {
      violations.push(`${name}: invalid radius ${index}`);
    }
    if (Number.isFinite(radii[index]) && Number.isFinite(radii[next]) &&
      radii[index] + radii[next] > edgeLength + GEOMETRY_EPSILON) {
      violations.push(`${name}: radii ${index}/${next} overlap (${radii[index] + radii[next]} > ${edgeLength})`);
    }
    if (edgeLength > GEOMETRY_EPSILON) {
      const unit = {
        x: (points[next].x - points[index].x) / edgeLength,
        y: (points[next].y - points[index].y) / edgeLength,
      };
      segments.push([
        { x: points[index].x + unit.x * radii[index], y: points[index].y + unit.y * radii[index] },
        { x: points[next].x - unit.x * radii[next], y: points[next].y - unit.y * radii[next] },
      ]);
      originalSegments.push([points[index], points[next]]);
    } else {
      segments.push(null);
      originalSegments.push(null);
    }
  }
  for (let first = 0; first < segments.length; first += 1) {
    for (let second = first + 1; second < segments.length; second += 1) {
      if (second === first + 1 || (first === 0 && second === segments.length - 1)) continue;
      if (originalSegments[first] && originalSegments[second] &&
        segmentsIntersect(originalSegments[first], originalSegments[second])) {
        violations.push(`${name}: non-adjacent polygon edges ${first}/${second} cross`);
      }
      if (segments[first] && segments[second] && segmentsIntersect(segments[first], segments[second])) {
        violations.push(`${name}: non-adjacent rounded path segments ${first}/${second} cross`);
      }
    }
  }
  return violations;
}

const IDENTITY_BOUND = 116;
const PATH_EPSILON = 1e-6;

function pathNumber(value) {
  return Math.round(value * 100) / 100;
}

function normalizeVector(from, to) {
  const dx = from[0] - to[0];
  const dy = from[1] - to[1];
  const length = Math.hypot(dx, dy) || 1;
  return [dx / length, dy / length];
}

// Independent copy of the pinned Grok eX.corner/Ost math. This intentionally
// does not call production helpers: it proves the emitted Q paths from the
// exact vendor algorithm rather than only checking source vertices.
function pinnedOstPath(points, radii) {
  let path = "";
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const incoming = normalizeVector(previous, current);
    const outgoing = normalizeVector(next, current);
    const from = [current[0] + incoming[0] * radii[index], current[1] + incoming[1] * radii[index]];
    const to = [current[0] + outgoing[0] * radii[index], current[1] + outgoing[1] * radii[index]];
    path += path.length === 0
      ? `M${pathNumber(from[0])} ${pathNumber(from[1])}`
      : `L${pathNumber(from[0])} ${pathNumber(from[1])}`;
    path += `Q${pathNumber(current[0])} ${pathNumber(current[1])} ${pathNumber(to[0])} ${pathNumber(to[1])}`;
  }
  return `${path}Z`;
}

// Independent copy of the pinned Grok Mst helper, including its two-decimal
// Lr rounding. dBt's exact 160 radial samples feed this cubic path builder.
function pinnedMstPath(points) {
  let path = `M${pathNumber(points[0][0])} ${pathNumber(points[0][1])}`;
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const nextNext = points[(index + 2) % points.length];
    path += `C${pathNumber(current[0] + (next[0] - previous[0]) / 6)} ${pathNumber(current[1] + (next[1] - previous[1]) / 6)} `;
    path += `${pathNumber(next[0] - (nextNext[0] - current[0]) / 6)} ${pathNumber(next[1] - (nextNext[1] - current[1]) / 6)} `;
    path += `${pathNumber(next[0])} ${pathNumber(next[1])}`;
  }
  return `${path}Z`;
}

function pinnedDBtPath(circles, sampleCount = 160) {
  const points = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = index / sampleCount * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    let radius = 0;
    for (const [centerX, centerY, circleRadius] of circles) {
      const projection = cosine * centerX + sine * centerY;
      const discriminant = projection * projection - (centerX * centerX + centerY * centerY) + circleRadius * circleRadius;
      if (discriminant <= 0) continue;
      const hit = projection + Math.sqrt(discriminant);
      if (hit > radius) radius = hit;
    }
    points.push([cosine * radius, sine * radius]);
  }
  return pinnedMstPath(points);
}

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

function assertSimplePath(path, label) {
  const bounds = pathExtrema(path);
  assert.ok(bounds.minX >= -IDENTITY_BOUND - PATH_EPSILON, `${label} exceeds -ze-${IDENTITY_BOUND}: ${bounds.minX}`);
  assert.ok(bounds.maxX <= IDENTITY_BOUND + PATH_EPSILON, `${label} exceeds ze+${IDENTITY_BOUND}: ${bounds.maxX}`);
  assert.ok(bounds.minY >= -IDENTITY_BOUND - PATH_EPSILON, `${label} exceeds -ze-${IDENTITY_BOUND}: ${bounds.minY}`);
  assert.ok(bounds.maxY <= IDENTITY_BOUND + PATH_EPSILON, `${label} exceeds ze+${IDENTITY_BOUND}: ${bounds.maxY}`);
  const samples = pathSamples(path);
  assert.ok(samples.length >= 4, `${label} is degenerate`);
  const segments = samples.slice(1).map((point, index) => [samples[index], point]);
  const closureWindow = segments.length > 24 ? 12 : 1;
  for (let index = 0; index < segments.length; index += 1) {
    const segmentLength = distance(...segments[index]);
    const isZeroLengthClose = index === segments.length - 1 && segmentLength <= PATH_EPSILON;
    if (!isZeroLengthClose) assert.ok(segmentLength > PATH_EPSILON, `${label} has a degenerate segment ${index}`);
    for (let other = index + 1; other < segments.length; other += 1) {
      if (other === index + 1 || (index === 0 && other === segments.length - 1)) continue;
      if (index < closureWindow && other >= segments.length - closureWindow) continue;
      assert.equal(segmentsIntersect(segments[index], segments[other]), false, `${label} self-intersects at ${index}/${other}`);
    }
  }
  return bounds;
}

function parseBearCircles(source) {
  const match = /bear:qo\("Bear",dBt\(\[\[([\s\S]*?)\]\]\)\)/.exec(source);
  assert.ok(match, "bear dBt geometry is missing");
  return match[1].split("],[").map((tuple) => {
    const [x, y, radius] = tuple.replace(/^\[|\]$/g, "").split(",");
    return [parseRelativeCoordinate(x), parseRelativeCoordinate(y), Number(radius)];
  });
}

test("pinned Sand helper paths stay inside ze plus or minus 116 with real extrema", () => {
  const entries = parseRoundedGeometryEntries(OPENBOT_GEOMETRY_TAIL);
  assert.equal(entries.length, 11);
  for (const entry of entries) {
    const path = pinnedOstPath(
      entry.points.map(({ x, y }) => [x, y]),
      entry.radii,
    );
    assert.match(path, /Q/, `${entry.name} must contain quadratic corners`);
    const bounds = assertSimplePath(path, `${entry.name} Ost`);
    assert.ok(Number.isFinite(bounds.minX + bounds.maxX + bounds.minY + bounds.maxY));
  }
  const bearPath = pinnedDBtPath(parseBearCircles(OPENBOT_GEOMETRY_TAIL));
  assert.match(bearPath, /C/, "bear must contain the pinned Mst cubic path");
  const bearBounds = assertSimplePath(bearPath, "bear dBt/Mst");
  assert.ok(Number.isFinite(bearBounds.minX + bearBounds.maxX + bearBounds.minY + bearBounds.maxY));
});

test("the pinned path validator rejects degenerate and self-intersecting paths", () => {
  assert.throws(() => assertSimplePath("M0 0L0 0Z", "degenerate fixture"), /degenerate/);
  assert.throws(() => assertSimplePath("M-10 -10L10 10L-10 10L10 -10Z", "crossing fixture"), /self-intersects/);
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

test("avatar rounded geometry has safe radii and no non-adjacent crossings", () => {
  const entries = parseRoundedGeometryEntries(OPENBOT_GEOMETRY_TAIL);
  assert.equal(entries.length, 11);
  assert.notDeepEqual(
    entries.find(({ name }) => name === "dog")?.points,
    entries.find(({ name }) => name === "wolf")?.points,
  );
  const violations = entries.flatMap(roundedGeometryViolations);
  assert.deepEqual(violations, []);
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
  assert.equal((patched.match(/mode==="local-protocol"/g) ?? []).length, 3);
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
  assert.match(patched, /shapeIsExplicit:a=i,colorIsExplicit:c=i/);
  assert.match(patched, /const O=a&&f===M/);
  assert.equal((patched.match(/c&&d===M\.id/g) ?? []).length, 3);
  assert.equal((patched.match(/i&&d===M\.id/g) ?? []).length, 0);
  assert.match(patched, /e\[11\]!==i\+"\|"\+a/);
  assert.match(patched, /e\[11\]=i\+"\|"\+a/);
  assert.match(patched, /e\[23\]!==i\+"\|"\+c/);
  assert.match(patched, /e\[23\]=i\+"\|"\+c/);
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
