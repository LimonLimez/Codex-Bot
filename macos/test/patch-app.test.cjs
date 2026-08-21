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
const rendererPatchPath = path.join(macRoot, "src", "patch", "renderer.cjs");
const STOCK_NATIVE_SHELL_GATE = 'function MHn(){const n=wLt(),{phase:e,onboardingRunId:t,completeOnboarding:s}=RFn();return n?p.jsxs(p.Fragment,{children:[p.jsx(Upe,{}),p.jsx(ggt,{})]}):e==="checking"?null:p.jsx(TDn,{chrome:JHn,children:e==="onboarding"?p.jsx(qFn,{onComplete:s,presentation:KUn},t):p.jsx(BHn,{})})}';
const STOCK_PROMPT_TRAILING = 'se=p.jsx("div",{className:ne,ref:d,style:X.style,children:Q})';
const STOCK_NEW_BOT_RECIPIENT = 'function q2e(n){return n.kind==="agent"?{kind:"agent",id:n.agent.id,name:n.agent.name,avatarDataUrl:n.agent.avatarDataUrl}:{kind:"new",name:n.kind==="create"?n.name:Jut}}';
const STOCK_NEW_BOT_COMMIT = 'he=x.useCallback(Ee=>{if(Ee.type==="noop")return;const Me=Ie(),Ae=Me.prompt.trim().length>0||Me.attachmentPaths.length>0;if(S(),r(),Ee.type==="single"){if(Ee.recipient.kind==="new"){Ae?Ne(Ee.recipient.name,Me):Te(Ee.recipient,"");return}Ae&&ve(Ee.recipient.id,Me),t(Ee.recipient.id);return}xe(Ee.recipients,"",[],Ae?Me:void 0)},[Ie,S,r,Ne,Te,xe,ve,t]';
const STOCK_BOT_SETTINGS_ROOT = 'let q;return e[43]!==j||e[44]!==B?(q=p.jsxs("div",{className:m,children:[j,B]}),e[43]=j,e[44]=B,e[45]=q):q=e[45],q}';
const STOCK_SETTINGS_ROOT = 'let h;return e[13]!==o?(h=t.jsxs("div",{className:d,children:[o,f,m,r,u,c]}),e[13]=o,e[14]=h):h=e[14],h}';
const STOCK_LOCAL_IDENTITY_ANCHORS = [
  'const Bgt={slice:"send-journal",schemaVersion:2,scope:"client-persisted",accountSensitive:!0}',
  'bt=()=>{if(!(Ge||t.get().status!=="ready"||s==null)){',
  'mt=()=>{if(Ge||t.get().status!=="ready"||s==null)return;',
  ':s?f!=null?W._(mbn(f)):i.length>0?U({id:"I/1BxG"}):C??W._(dht):U({id:"622+sP"})',
  'if(await j.write({accountSlot:null,value:Ve}),!Ye()||(await B.restore(Ve),!Ye())||(await q.restore(Ve),!Ye())||(await K.restore(Ve),!Ye())||(await F.restore(Ve),!Ye())||(await ne.restore(Ve),!Ye())||(await Z.restore(Ve),!Ye())||(await ke.restore(Ve),!Ye()))return;',
  'Ve!=null&&F.connect()',
  'Ve!=null&&(B.loadPinnedAgentsFromBox(),q.loadFromBox(),ke.reconcileWithHost())',
  'onIdentityRestoreComplete:({accountSlot:n})=>Whe.completeIdentityChange({acceptPort:n!=null})',
].join(";");
const rendererPatch = require(rendererPatchPath);
const { ADDED_AVATAR_SHAPES } = require("../src/bots/avatar-catalog.cjs");
const {
  OPENBOT_AVATAR_ACCENT_FACE,
  OPENBOT_AVATAR_ACCENT_MORPH,
  OPENBOT_AVATAR_ACCENT_REF,
  OPENBOT_AVATAR_ACCENT_STATIC,
  OPENBOT_GEOMETRY_TAIL,
  OPENBOT_VISIBLE_SHAPES,
  VENDOR_AVATAR_ACCENT_FACE,
  VENDOR_AVATAR_ACCENT_MORPH,
  VENDOR_AVATAR_ACCENT_REF,
  VENDOR_AVATAR_ACCENT_STATIC,
  VENDOR_GEOMETRY_TAIL,
  VENDOR_VISIBLE_SHAPES,
  patchAvatarAccentSource,
  patchAvatarCatalogSource,
  patchVendorRendererSource,
  reverseAvatarAccentSource,
  reverseAvatarCatalogSource,
  validateAvatarAccentPath,
} = rendererPatch;
const SYNTHETIC_VENDOR_RENDERER = `const before="kept";${STOCK_NATIVE_SHELL_GATE}${STOCK_LOCAL_IDENTITY_ANCHORS}${STOCK_PROMPT_TRAILING}${STOCK_NEW_BOT_RECIPIENT}${STOCK_NEW_BOT_COMMIT}${STOCK_BOT_SETTINGS_ROOT}${VENDOR_GEOMETRY_TAIL}${VENDOR_VISIBLE_SHAPES}const after="kept";`;
const SYNTHETIC_VENDOR_RENDERER_SHA256 = crypto
  .createHash("sha256")
  .update(SYNTHETIC_VENDOR_RENDERER, "utf8")
  .digest("hex");
const SYNTHETIC_VENDOR_SETTINGS_SHA256 = crypto
  .createHash("sha256")
  .update(STOCK_SETTINGS_ROOT, "utf8")
  .digest("hex");
const STOCK_MACHINE_ID_MAIN = `async function Ds(){let t=await xgt(Ihr);if(t!=null)return t;await $9t();let e=await xgt(Ihr);if(e!=null)return e;let r=(0,j5n.randomUUID)();return await j9t(Ihr,r),r}
Ic.markPhase("update_service"),Ic.armStuckWatchdog(),F5n();let e=uJt(),r=await Ds().catch(F=>(xe("update","machine-id",F),crypto.randomUUID()))
Ic.markPhase("telemetry");let x=await Ds(),C=hHn(`;
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
  fs.mkdirSync(path.join(tree, "dist", "renderer", "assets"), { recursive: true });
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
    'const stock="kept";const L=M({invokeRequest:()=>{s.ipcRenderer.invoke("sand:coordinator-port-request")}});s.contextBridge.exposeInMainWorld("desktop",Q);s.contextBridge.exposeInMainWorld("coordinatorPort",X);s.ipcRenderer.on("sand:coordinator-port",e=>{});\n',
  );
  fs.writeFileSync(
    path.join(tree, "dist", "electron-main", "main.cjs"),
    `const setup="kept";\n"use strict";var fjn=Object.create;jEr=F=>o.emit("mcp-auth-completed",F),mh=Rzn(remoteReady);aJn(),Ic.markPhase("auth_service");let $=Dzn({});qEr=$,s={pipes:{}};VOn({ipcMain:xt.ipcMain,getExperimentService:cJt});qEr?.hardenWebviewAttach(r.webContents),bu=r;UOn({}),Ic.markPhase("window"),ijn=!0,await mjn(),Ic.noteReady(),xt.app.on("activate",()=>{xt.BrowserWindow.getAllWindows().length===0&&sjn()});const stockFeature="kept";\n${STOCK_MACHINE_ID_MAIN}\n`,
  );
  fs.writeFileSync(
    path.join(tree, "dist", "host", "host-main.cjs"),
    '"use strict";function E4i(t){let e,n=qdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId});return{resolvePrivacyMode:()=>Jdi({getAccessToken:t.getAccessToken,getMachineId:t.getMachineId}),createSession(o,s){return Qdi({getAccessToken:t.getAccessToken,onRequestId:o})},recordPostTurnLabeling(o){}}}function T4i(t){return E4i(t)}ye={modelId:t.subagentModelId,inferenceReason:t.subagentType};t.inference.createSession(pn=>{t.emitUpdate({type:"request-id",requestId:pn})},{modelId:dXt,isSummarizationSession:!0);var b4i={start:t=>{let e=new Set,n=t.deps.auth;return{isReady:async()=>process.env.SAND_AGENT_MOCK_RESPONSE!=null||n.peekAccessToken()!==null,port:T4i(t)}}};\n',
  );
  fs.writeFileSync(
    path.join(tree, "dist", "renderer", "index.html"),
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Grok Bot</title>\n    <script type="module" crossorigin src="./assets/index-CphCyQnY.js"></script>\n    <link rel="stylesheet" crossorigin href="./assets/index-DTIy1z2L.css">\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n',
  );
  fs.writeFileSync(
    path.join(tree, "dist", "renderer", "assets", "index-CphCyQnY.js"),
    SYNTHETIC_VENDOR_RENDERER,
  );
  fs.writeFileSync(
    path.join(tree, "dist", "renderer", "assets", "index-d9mfdYoh.js"),
    STOCK_SETTINGS_ROOT,
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
  require.cache[require.resolve(rendererPatchPath)].exports = {
    ...rendererPatch,
    patchRenderer(extractedRoot) {
      return rendererPatch.patchRenderer(extractedRoot, {
        expectedVendorRendererSha256: SYNTHETIC_VENDOR_RENDERER_SHA256,
        expectedVendorSettingsSha256: SYNTHETIC_VENDOR_SETTINGS_SHA256,
      });
    },
  };
  return require(patcherPath);
}

const PATCH_GEOMETRY_EPSILON = 1e-6;

function patchDistance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function patchCross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function patchOnSegment(a, b, point) {
  return point.x >= Math.min(a.x, b.x) - PATCH_GEOMETRY_EPSILON &&
    point.x <= Math.max(a.x, b.x) + PATCH_GEOMETRY_EPSILON &&
    point.y >= Math.min(a.y, b.y) - PATCH_GEOMETRY_EPSILON &&
    point.y <= Math.max(a.y, b.y) + PATCH_GEOMETRY_EPSILON;
}

function patchSegmentsIntersect(first, second) {
  const [a, b] = first;
  const [c, d] = second;
  const abC = patchCross(a, b, c);
  const abD = patchCross(a, b, d);
  const cdA = patchCross(c, d, a);
  const cdB = patchCross(c, d, b);
  const opposite = (left, right) => (left > PATCH_GEOMETRY_EPSILON && right < -PATCH_GEOMETRY_EPSILON) ||
    (left < -PATCH_GEOMETRY_EPSILON && right > PATCH_GEOMETRY_EPSILON);
  return (opposite(abC, abD) && opposite(cdA, cdB)) ||
    (Math.abs(abC) <= PATCH_GEOMETRY_EPSILON && patchOnSegment(a, b, c)) ||
    (Math.abs(abD) <= PATCH_GEOMETRY_EPSILON && patchOnSegment(a, b, d)) ||
    (Math.abs(cdA) <= PATCH_GEOMETRY_EPSILON && patchOnSegment(c, d, a)) ||
    (Math.abs(cdB) <= PATCH_GEOMETRY_EPSILON && patchOnSegment(c, d, b));
}

const PATCH_IDENTITY_BOUND = 116;

function patchParsePath(path) {
  const commands = [];
  const arities = { M: 2, L: 2, Q: 4, C: 6, Z: 0 };
  const pattern = /([MLCQZ])([^MLCQZ]*)/g;
  let match;
  while ((match = pattern.exec(path)) !== null) {
    const values = (match[2].match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g) ?? []).map(Number);
    assert.equal(values.length, arities[match[1]], `malformed ${match[1]} path command`);
    commands.push({ type: match[1], values });
  }
  assert.ok(commands.length > 0, "path has no commands");
  return commands;
}

function patchQuadraticPoint(start, control, end, time) {
  const inverse = 1 - time;
  return {
    x: inverse * inverse * start.x + 2 * inverse * time * control.x + time * time * end.x,
    y: inverse * inverse * start.y + 2 * inverse * time * control.y + time * time * end.y,
  };
}

function patchCubicPoint(start, firstControl, secondControl, end, time) {
  const inverse = 1 - time;
  return {
    x: inverse ** 3 * start.x + 3 * inverse ** 2 * time * firstControl.x + 3 * inverse * time ** 2 * secondControl.x + time ** 3 * end.x,
    y: inverse ** 3 * start.y + 3 * inverse ** 2 * time * firstControl.y + 3 * inverse * time ** 2 * secondControl.y + time ** 3 * end.y,
  };
}

function patchQuadraticRoots(start, control, end, axis) {
  const denominator = start[axis] - 2 * control[axis] + end[axis];
  return Math.abs(denominator) <= PATCH_GEOMETRY_EPSILON
    ? []
    : [(start[axis] - control[axis]) / denominator];
}

function patchCubicRoots(start, firstControl, secondControl, end, axis) {
  const a = 3 * (-start[axis] + 3 * firstControl[axis] - 3 * secondControl[axis] + end[axis]);
  const b = 6 * (start[axis] - 2 * firstControl[axis] + secondControl[axis]);
  const c = 3 * (firstControl[axis] - start[axis]);
  if (Math.abs(a) <= PATCH_GEOMETRY_EPSILON) return Math.abs(b) <= PATCH_GEOMETRY_EPSILON ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -PATCH_GEOMETRY_EPSILON) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

function patchPathExtrema(path) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const include = (point) => {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  };
  const includeCurve = (pointAt, roots) => {
    for (const time of [0, 1, ...roots.filter((value) => value > 0 && value < 1)]) include(pointAt(time));
  };
  let current = null;
  let start = null;
  for (const { type, values } of patchParsePath(path)) {
    if (type === "M") {
      current = { x: values[0], y: values[1] };
      start = current;
      include(current);
      continue;
    }
    if (type === "Z") {
      if (current && start) include({ x: current.x, y: current.y });
      current = start;
      continue;
    }
    assert.ok(current, `path ${type} command precedes move`);
    const from = current;
    if (type === "L") {
      current = { x: values[0], y: values[1] };
      include(from);
      include(current);
      continue;
    }
    if (type === "Q") {
      const control = { x: values[0], y: values[1] };
      const end = { x: values[2], y: values[3] };
      includeCurve(
        (time) => patchQuadraticPoint(from, control, end, time),
        [...patchQuadraticRoots([from.x, from.y], [control.x, control.y], [end.x, end.y], 0),
          ...patchQuadraticRoots([from.x, from.y], [control.x, control.y], [end.x, end.y], 1)],
      );
      current = end;
      continue;
    }
    const firstControl = { x: values[0], y: values[1] };
    const secondControl = { x: values[2], y: values[3] };
    const end = { x: values[4], y: values[5] };
    includeCurve(
      (time) => patchCubicPoint(from, firstControl, secondControl, end, time),
      [...patchCubicRoots([from.x, from.y], [firstControl.x, firstControl.y], [secondControl.x, secondControl.y], [end.x, end.y], 0),
        ...patchCubicRoots([from.x, from.y], [firstControl.x, firstControl.y], [secondControl.x, secondControl.y], [end.x, end.y], 1)],
    );
    current = end;
  }
  return bounds;
}

function patchPathSamples(path, steps = 12) {
  const samples = [];
  let current = null;
  let start = null;
  for (const { type, values } of patchParsePath(path)) {
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
        ? patchQuadraticPoint(points[0], points[1], points[2], time)
        : patchCubicPoint(points[0], points[1], points[2], points[3], time));
    }
    current = points.at(-1);
  }
  return samples;
}

function patchAssertSimplePath(path, label) {
  const bounds = patchPathExtrema(path);
  assert.ok(bounds.minX >= -PATCH_IDENTITY_BOUND - PATCH_GEOMETRY_EPSILON, `${label} exceeds -ze-${PATCH_IDENTITY_BOUND}: ${bounds.minX}`);
  assert.ok(bounds.maxX <= PATCH_IDENTITY_BOUND + PATCH_GEOMETRY_EPSILON, `${label} exceeds ze+${PATCH_IDENTITY_BOUND}: ${bounds.maxX}`);
  assert.ok(bounds.minY >= -PATCH_IDENTITY_BOUND - PATCH_GEOMETRY_EPSILON, `${label} exceeds -ze-${PATCH_IDENTITY_BOUND}: ${bounds.minY}`);
  assert.ok(bounds.maxY <= PATCH_IDENTITY_BOUND + PATCH_GEOMETRY_EPSILON, `${label} exceeds ze+${PATCH_IDENTITY_BOUND}: ${bounds.maxY}`);
  const samples = patchPathSamples(path);
  assert.ok(samples.length >= 4, `${label} is degenerate`);
  const segments = samples.slice(1).map((point, index) => [samples[index], point]);
  const closureWindow = segments.length > 24 ? 12 : 1;
  for (let index = 0; index < segments.length; index += 1) {
    const segmentLength = patchDistance(...segments[index]);
    const isZeroLengthClose = index === segments.length - 1 && segmentLength <= PATCH_GEOMETRY_EPSILON;
    if (!isZeroLengthClose) assert.ok(segmentLength > PATCH_GEOMETRY_EPSILON, `${label} has a degenerate segment ${index}`);
    for (let other = index + 1; other < segments.length; other += 1) {
      if (other === index + 1 || (index === 0 && other === segments.length - 1)) continue;
      if (index < closureWindow && other >= segments.length - closureWindow) continue;
      assert.equal(patchSegmentsIntersect(segments[index], segments[other]), false, `${label} self-intersects at ${index}/${other}`);
    }
  }
  return bounds;
}

test("patch-app validates authored contour grammar and rejects the old blockout helpers", () => {
  const names = [
    "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
    "terminal", "robot", "microchip", "drone",
  ];
  assert.equal((OPENBOT_GEOMETRY_TAIL.match(/Ost\(|dBt\(/g) ?? []).length, 0);
  for (const name of names) {
    const match = new RegExp(`${name}:qo\\("[^\\"]+","([MLCQZ0-9 .-]+)"(?:,\\{[^)]*\\})?\\)`).exec(OPENBOT_GEOMETRY_TAIL);
    assert.ok(match, `${name} authored path is missing`);
    assert.match(match[1], /^M/);
    assert.match(match[1], /[CQ]/, `${name} must contain a continuous curve`);
  }
});

test("patch-app path validator rejects degenerate and self-intersecting fixtures", () => {
  assert.throws(() => patchAssertSimplePath("M0 0L0 0Z", "degenerate fixture"), /degenerate/);
  assert.throws(() => patchAssertSimplePath("M-10 -10L10 10L-10 10L10 -10Z", "crossing fixture"), /self-intersects/);
});

test("patch-app renderer fixture carries the exact avatar registry contract", () => {
  const patched = patchAvatarCatalogSource(SYNTHETIC_VENDOR_RENDERER);
  assert.equal((SYNTHETIC_VENDOR_RENDERER.match(new RegExp(VENDOR_GEOMETRY_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  assert.equal((SYNTHETIC_VENDOR_RENDERER.match(new RegExp(VENDOR_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  assert.equal((patched.match(new RegExp(OPENBOT_GEOMETRY_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  assert.equal((patched.match(new RegExp(OPENBOT_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
  for (const shape of ADDED_AVATAR_SHAPES) {
    assert.equal((patched.match(new RegExp(`${shape}:qo\\(`, "g")) ?? []).length, 1);
    assert.match(patched, new RegExp(`${shape}:qo\\(`));
  }
  assert.match(
    patched,
    new RegExp(OPENBOT_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal(reverseAvatarCatalogSource(patched), SYNTHETIC_VENDOR_RENDERER);
});

test("patch-app carries one reversible face-safe Sand accent contract", () => {
  const vendorAnchors = [
    VENDOR_AVATAR_ACCENT_REF,
    VENDOR_AVATAR_ACCENT_MORPH,
    VENDOR_AVATAR_ACCENT_FACE,
    VENDOR_AVATAR_ACCENT_STATIC,
  ];
  const source = `before;${vendorAnchors.join(";between;")};after`;
  const patched = patchAvatarAccentSource(source);
  for (const anchor of vendorAnchors) assert.equal(patched.includes(anchor), false);
  for (const anchor of [
    OPENBOT_AVATAR_ACCENT_REF,
    OPENBOT_AVATAR_ACCENT_MORPH,
    OPENBOT_AVATAR_ACCENT_FACE,
    OPENBOT_AVATAR_ACCENT_STATIC,
  ]) assert.equal(patched.includes(anchor), true);
  assert.equal(reverseAvatarAccentSource(patched), source);

  const match = /dog:qo\("Dog","[MLCQZ0-9 .-]+",\{accentPath:"([MLCQZ0-9 .-]+)"\}\)/.exec(OPENBOT_GEOMETRY_TAIL);
  assert.ok(match, "dog Sand accent metadata is missing");
  assert.doesNotThrow(() => validateAvatarAccentPath(match[1], "dog"));
  for (const invalid of [
    "M90 140L110 140ZM120 140L140 140Z",
    "M90 140L110 140L100 160",
    "M0 0L20 0L20 20Z",
    "M90 140A10 10 0 0 1 110 140Z",
  ]) assert.throws(() => validateAvatarAccentPath(invalid, "fixture"), /accent/i);
});

test("patch-app contour registry keeps every authored path unique", () => {
  const names = [
    "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
    "terminal", "robot", "microchip", "drone",
  ];
  for (const name of names) {
    assert.equal((OPENBOT_GEOMETRY_TAIL.match(new RegExp(`${name}:qo\\(`, "g")) ?? []).length, 1);
  }
});

test("patch-app avatar registry anchors fail closed when missing or ambiguous", () => {
  const requiredAnchors = [
    ["avatar geometry", VENDOR_GEOMETRY_TAIL],
    ["visible avatar registry", VENDOR_VISIBLE_SHAPES],
  ];
  for (const [label, anchor] of requiredAnchors) {
    const missing = SYNTHETIC_VENDOR_RENDERER.replace(anchor, "");
    assert.throws(
      () => patchVendorRendererSource(missing, crypto.createHash("sha256").update(missing, "utf8").digest("hex")),
      /anchor.*not found|not found.*anchor/i,
      `${label} missing`,
    );
    const ambiguous = `${SYNTHETIC_VENDOR_RENDERER}${anchor}`;
    assert.throws(
      () => patchVendorRendererSource(ambiguous, crypto.createHash("sha256").update(ambiguous, "utf8").digest("hex")),
      /anchor.*ambiguous|ambiguous.*anchor/i,
      `${label} ambiguous`,
    );
  }
});

test("patch-app rejects mixed or duplicate avatar replacement anchors", () => {
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

test("the patch engine rebrands an exact ASAR, stages Advanced renderer assets, and preserves stock/unpacked bytes", async (t) => {
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
      releaseVersion: "0.2.0-macos.1",
      mutations: [
        "dist/codex/bots/avatar-catalog.cjs",
        "dist/codex/bots/bot-store.cjs",
        "dist/codex/bots/chatgpt-relay-codec.cjs",
        "dist/codex/bots/conversation-router.cjs",
        "dist/codex/bots/remote-app-server-client.cjs",
        "dist/codex/bots/reviewed-adapter-loader.cjs",
        "dist/codex/bots/reviewed-adapter-worker-source.cjs",
        "dist/codex/bots/runtime-controller.cjs",
        "dist/codex/bots/runtime-provider.cjs",
        "dist/codex/bridge/codex-client.cjs",
        "dist/codex/bridge/inference-socket-client.cjs",
        "dist/codex/bridge/message-codec.cjs",
        "dist/codex/bridge/redaction.cjs",
        "dist/codex/bridge/runtime-config.cjs",
        "dist/codex/bridge/server.cjs",
        "dist/codex/computer/computer-target-router.cjs",
        "dist/codex/desktop/bot-deletion-coordinator.cjs",
        "dist/codex/desktop/cliproxy-inference-transport.cjs",
        "dist/codex/desktop/cliproxy-manager.cjs",
        "dist/codex/desktop/codex-account-controller.cjs",
        "dist/codex/desktop/codex-app-server-manager.cjs",
        "dist/codex/desktop/codex-direct-inference-transport.cjs",
        "dist/codex/desktop/codex-runtime-integrity.cjs",
        "dist/codex/desktop/inference-bridge-server.cjs",
        "dist/codex/desktop/inference-provider-router.cjs",
        "dist/codex/desktop/keychain-secret-store.cjs",
        "dist/codex/desktop/local-automation-controller.cjs",
        "dist/codex/desktop/local-automation-native-io.cjs",
        "dist/codex/desktop/local-automation-store.cjs",
        "dist/codex/desktop/local-cron-schedule.cjs",
        "dist/codex/desktop/local-desktop-frame-ipc.cjs",
        "dist/codex/desktop/model-selection-store.cjs",
        "dist/codex/desktop/openai-compatible-inference-transport.cjs",
        "dist/codex/desktop/openai-compatible-provider.cjs",
        "dist/codex/desktop/openbot-machine-id.cjs",
        "dist/codex/desktop/openbot-native-coordinator-ipc.cjs",
        "dist/codex/desktop/openbot-native-coordinator.cjs",
        "dist/codex/desktop/openbot-user-data.cjs",
        "dist/codex/desktop/provider-controller.cjs",
        "dist/codex/desktop/provider-state-store.cjs",
        "dist/codex/desktop/runtime.cjs",
        "dist/codex/desktop/standalone-conversation-controller.cjs",
        "dist/codex/desktop/standalone-conversation-ipc.cjs",
        "dist/codex/desktop/standalone-conversation-store.cjs",
        "dist/codex/desktop/standalone-subagent-runner.cjs",
        "dist/codex/local/local-computer-boundary.cjs",
        "dist/codex/local/local-computer-runtime.cjs",
        "dist/codex/local/local-desktop-manager.cjs",
        "dist/codex/local/local-helper-child.cjs",
        "dist/codex/local/local-helper-protocol.cjs",
        "dist/codex/local/local-helper-transport.cjs",
        "dist/codex/local/local-permission-broker.cjs",
        "dist/codex/local/local-permission-store.cjs",
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
        "dist/codex/provider-descriptors.cjs",
        "dist/codex/renderer/chat-content.js",
        "dist/electron-main/main.cjs",
        "dist/electron-preload/preload.cjs",
        "dist/host/host-main.cjs",
        "dist/renderer/assets/index-CphCyQnY.js",
        "dist/renderer/assets/index-d9mfdYoh.js",
        "dist/renderer/codex/bot-runtime-ui.js",
        "dist/renderer/codex/codex-ui.css",
        "dist/renderer/codex/model-controls.js",
        "dist/renderer/codex/openbot-local-desktop-view.css",
        "dist/renderer/codex/openbot-local-desktop-view.js",
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
  const advancedPickerCss = fs.readFileSync(
    path.join(extracted, "dist", "renderer", "codex", "codex-ui.css"),
    "utf8",
  );
  const advancedPickerUi = fs.readFileSync(
    path.join(extracted, "dist", "renderer", "codex", "bot-runtime-ui.js"),
    "utf8",
  );
  assert.match(advancedPickerCss, /\.codex-power-menu\s*\{/);
  assert.match(advancedPickerCss, /\.codex-power-menu\.transitions-ready\s*\{/);
  assert.match(advancedPickerCss, /\.codex-power-flyout\s*\{/);
  assert.doesNotMatch(advancedPickerCss, /codex-power-advanced-field\s+select/);
  assert.match(advancedPickerUi, /data-openbot-model-picker-host/);
  assert.match(advancedPickerUi, /modelDock\.append\(modelTrigger,\s*popover,\s*advancedFlyout\)/s);
  assert.doesNotMatch(advancedPickerUi, /codex-power-(?:model|effort|speed)-select/);
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
      productName: "OpenBot",
      version: "0.2.0-macos.1",
      description: "OpenBot desktop agent",
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
  assert.match(patchedPreload, /retry:value=>s\.ipcRenderer\.invoke\("openbot-local-frame:retry",value\)/);
  assert.match(patchedPreload, /onStatus:callback/);
  const patchedMain = fs.readFileSync(
    path.join(extracted, "dist", "electron-main", "main.cjs"),
    "utf8",
  );
  assert.match(patchedMain, /stockFeature="kept"/);
  assert.match(patchedMain, /codex\/desktop\/runtime\.cjs/);
  assert.match(patchedMain, /async function Ds\(\)\{return __openbotDesktopRuntime\.readMachineId\(\)\}/);
  assert.match(patchedMain, /let e=uJt\(\),r=await __openbotDesktopRuntime\.readMachineId\(\)\.catch\(F=>\(xe\("update","machine-id",F\),crypto\.randomUUID\(\)\)\)/);
  assert.match(patchedMain, /Ic\.markPhase\("telemetry"\);let x=r,C=hHn\(/);
  assert.doesNotMatch(patchedMain, /F5n\(\);let e=uJt\(\)/);
  for (const relative of [
    "provider-descriptors.cjs",
    "desktop/runtime.cjs",
    "desktop/provider-controller.cjs",
    "desktop/provider-state-store.cjs",
    "desktop/keychain-secret-store.cjs",
    "desktop/openbot-machine-id.cjs",
    "desktop/openai-compatible-provider.cjs",
    "desktop/openai-compatible-inference-transport.cjs",
    "desktop/model-selection-store.cjs",
    "desktop/openbot-user-data.cjs",
    "bots/avatar-catalog.cjs",
    "bots/bot-store.cjs",
    "bots/runtime-controller.cjs",
    "bots/runtime-provider.cjs",
    "bots/remote-app-server-client.cjs",
    "bots/conversation-router.cjs",
    "bots/chatgpt-relay-codec.cjs",
    "bots/reviewed-adapter-loader.cjs",
    "bots/reviewed-adapter-worker-source.cjs",
  ]) {
    assert.equal(fs.lstatSync(path.join(extracted, "dist", "codex", relative)).isFile(), true);
  }
  assert.deepEqual(
    fs.readFileSync(path.join(extracted, "dist", "codex", "provider-descriptors.cjs")),
    fs.readFileSync(path.join(__dirname, "..", "..", "src", "provider-descriptors.cjs")),
  );
  assert.equal(
    sha256File(path.join(extracted, "dist", "codex", "provider-descriptors.cjs")),
    sha256File(path.join(__dirname, "..", "..", "src", "provider-descriptors.cjs")),
  );
  const avatarCatalog = path.join(extracted, "dist", "codex", "bots", "avatar-catalog.cjs");
  const avatarCatalogSource = path.join(__dirname, "..", "src", "bots", "avatar-catalog.cjs");
  assert.deepEqual(fs.readFileSync(avatarCatalog), fs.readFileSync(avatarCatalogSource));
  assert.equal(sha256File(avatarCatalog), sha256File(avatarCatalogSource));
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
  const conversationRouterPath = path.join(
    extracted,
    "dist",
    "codex",
    "bots",
    "conversation-router.cjs",
  );
  delete require.cache[require.resolve(conversationRouterPath)];
  const conversationRouter = require(conversationRouterPath);
  assert.equal(typeof conversationRouter.ConversationRouter, "function");
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
  assert.match(
    fs.readFileSync(
      path.join(extracted, "dist", "renderer", "assets", "index-CphCyQnY.js"),
      "utf8",
    ),
    /window\.openbotProtocol\?\.schemaVersion===1/,
  );
  assert.match(
    fs.readFileSync(
      path.join(extracted, "dist", "renderer", "assets", "index-CphCyQnY.js"),
      "utf8",
    ),
    /children:\[p\.jsx\("div",\{"data-openbot-model-picker-host":!0\}\),Q\]/,
  );
  const patchedVendorRenderer = fs.readFileSync(
    path.join(extracted, "dist", "renderer", "assets", "index-CphCyQnY.js"),
    "utf8",
  );
  for (const shape of ADDED_AVATAR_SHAPES) {
    assert.match(patchedVendorRenderer, new RegExp(`${shape}:qo\\(`));
  }
  assert.match(
    patchedVendorRenderer,
    new RegExp(OPENBOT_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  const reversedAvatarRenderer = reverseAvatarCatalogSource(patchedVendorRenderer);
  assert.match(
    reversedAvatarRenderer,
    new RegExp(VENDOR_GEOMETRY_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(
    reversedAvatarRenderer,
    new RegExp(VENDOR_VISIBLE_SHAPES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
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
