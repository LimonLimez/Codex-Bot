"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const viewPath = "../src/renderer/openbot-local-desktop-view.js";
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const LOCAL_A = "local-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL_B = "local-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function fixture({
  decode,
  htmlCollection = false,
  select,
  retry,
  clear,
  presentation,
  acquireControl,
  releaseControl,
  navigate,
  goBack,
  goForward,
  reload,
  sendInput,
} = {}) {
  const calls = {
    acquireControl: [],
    clear: [],
    clearRect: [],
    drawImage: [],
    events: [],
    goBack: [],
    goForward: [],
    navigate: [],
    navigation: [],
    presentation: [],
    releaseControl: [],
    reload: [],
    retry: [],
    select: [],
    sendInput: [],
    status: [],
  };
  let frameListener = null;
  let statusListener = null;
  let navigationListener = null;
  const nodes = [];
  const context = {
    clearRect(...args) { calls.clearRect.push(args); },
    drawImage(...args) { calls.drawImage.push(args); },
  };
  function element(tagName) {
    const children = [];
    if (htmlCollection) Object.defineProperty(children, "at", { value: undefined });
    const value = {
      tagName: tagName.toUpperCase(),
      children,
      attributes: {},
      className: "",
      classList: {
        toggle() {},
        add() {},
        remove() {},
      },
      dataset: {},
      style: { setProperty() {} },
      hidden: false,
      width: 0,
      height: 0,
      value: "",
      disabled: false,
      tabIndex: 0,
      parentElement: null,
      listeners: new Map(),
      textContent: "",
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return this.attributes[name]; },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); },
      click() { this.listeners?.get("click")?.({ currentTarget: this }); },
      focus() { this.ownerDocument && (this.ownerDocument.activeElement = this); this.listeners.get("focus")?.({ currentTarget: this }); },
      blur() { this.listeners.get("blur")?.({ currentTarget: this }); },
      dispatchEvent(event) {
        event.currentTarget ??= this;
        this.listeners.get(event.type)?.(event);
        return true;
      },
      getBoundingClientRect() { return this.rect ?? { left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400 }; },
      contains(candidate) { return candidate === this || this.children.some((child) => child.contains?.(candidate)); },
      getContext(kind) { return tagName === "canvas" && kind === "2d" ? context : null; },
      remove() { this.removed = true; },
    };
    value.ownerDocument = documentRef;
    nodes.push(value);
    return value;
  }
  const documentRef = {
    activeElement: null,
    listeners: new Map(),
    createElement: element,
    addEventListener(name, listener) { this.listeners.set(name, listener); },
    removeEventListener(name, listener) { if (this.listeners.get(name) === listener) this.listeners.delete(name); },
    exitFullscreen() { this.fullscreenElement = null; this.listeners.get("fullscreenchange")?.({}); },
    body: null,
  };
  documentRef.body = element("body");
  const container = element("div");
  documentRef.body.append(container);
  const openbotLocalDesktop = {
    async select(value) {
      calls.select.push(value);
      calls.events.push({ type: "select", value });
      return select ? select(value) : undefined;
    },
    async retry(value) {
      calls.retry.push(value);
      return retry ? retry(value) : undefined;
    },
    async clear(value) {
      calls.clear.push(value);
      calls.events.push({ type: "clear", value });
      return clear ? clear(value) : undefined;
    },
    presentation(value) {
      calls.presentation.push(value);
      const result = presentation ? presentation(value) : {
        botId: value.botId,
        targetId: value.targetId,
        targetGeneration: value.targetGeneration,
        sessionGeneration: value.sessionGeneration,
        pageGeneration: value.pageGeneration,
        viewGeneration: value.viewGeneration,
        frameId: "frame-presentation",
        frameSequence: 1,
        inputSequence: 0,
        presentation: value.presentation,
        state: "live",
        code: null,
      };
      return Promise.resolve(result);
    },
    navigate(value) {
      calls.navigate.push(value);
      calls.events.push({ type: "navigate", value });
      return Promise.resolve(navigate ? navigate(value) : {
        ...value,
        pageGeneration: value.pageGeneration + 1,
        frameId: "frame-navigate",
        frameSequence: 1,
        inputSequence: 0,
        action: "navigate",
      });
    },
    goBack(value) {
      calls.goBack.push(value);
      calls.events.push({ type: "goBack", value });
      return Promise.resolve(goBack ? goBack(value) : { ...value, pageGeneration: value.pageGeneration + 1, action: "goBack", url: null, frameId: "frame-back", frameSequence: 1, inputSequence: 0 });
    },
    goForward(value) {
      calls.goForward.push(value);
      calls.events.push({ type: "goForward", value });
      return Promise.resolve(goForward ? goForward(value) : { ...value, pageGeneration: value.pageGeneration + 1, action: "goForward", url: null, frameId: "frame-forward", frameSequence: 1, inputSequence: 0 });
    },
    reload(value) {
      calls.reload.push(value);
      calls.events.push({ type: "reload", value });
      return Promise.resolve(reload ? reload(value) : { ...value, pageGeneration: value.pageGeneration + 1, action: "reload", url: null, frameId: "frame-reload", frameSequence: 1, inputSequence: 0 });
    },
    acquireControl(value) {
      calls.acquireControl.push(value);
      return Promise.resolve(acquireControl ? acquireControl(value) : {
        ...value,
        frameId: value.frameId || "frame-interactive",
        frameSequence: value.frameSequence || 2,
        inputSequence: 0,
        controlGeneration: 7,
      });
    },
    releaseControl(value) {
      calls.releaseControl.push(value);
      calls.events.push({ type: "releaseControl", value });
      return Promise.resolve(releaseControl ? releaseControl(value) : value);
    },
    sendInput(value) {
      calls.sendInput.push(value);
      calls.events.push({ type: "sendInput", value });
      return sendInput ? sendInput(value) : Promise.resolve({
        botId: value.botId,
        targetId: value.targetId,
        targetGeneration: value.targetGeneration,
        sessionGeneration: value.sessionGeneration,
        pageGeneration: value.pageGeneration,
        viewGeneration: value.viewGeneration,
        frameId: value.frameId,
        frameSequence: value.frameSequence,
        inputSequence: value.inputSequence,
      });
    },
    onFrame(callback) { frameListener = callback; return () => { if (frameListener === callback) frameListener = null; }; },
    onStatus(callback) { statusListener = callback; return () => { if (statusListener === callback) statusListener = null; }; },
    onNavigation(callback) { navigationListener = callback; return () => { if (navigationListener === callback) navigationListener = null; }; },
  };
  const objectUrls = [];
  const windowRef = {
    Blob,
    openbotLocalDesktop,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    URL: {
      createObjectURL(value) { objectUrls.push(value); throw new Error("object URLs are forbidden"); },
      revokeObjectURL() {},
    },
    createImageBitmap: decode ?? (async () => ({ close() {} })),
  };
  return {
    calls,
    container,
    documentRef,
    emitFrame(value) { return frameListener?.(value); },
    emitStatus(value) { return statusListener?.(value); },
    emitNavigation(value) { return navigationListener?.(value); },
    frameListener: () => frameListener,
    navigationListener: () => navigationListener,
    nodes,
    objectUrls,
    windowRef,
  };
}

function frame({
  botId = BOT_A,
  targetId = LOCAL_A,
  targetGeneration = 1,
  viewGeneration = 1,
  sequence = 1,
  byte = 1,
} = {}) {
  return Object.freeze({
    botId,
    targetId,
    targetGeneration,
    viewGeneration,
    sequence,
    width: 640,
    height: 400,
    mimeType: "image/png",
    bytes: Uint8Array.from([byte, byte + 1, byte + 2]),
  });
}

function richFrame({
  botId = BOT_A,
  targetId = LOCAL_A,
  targetGeneration = 1,
  sessionGeneration = 4,
  pageGeneration = 2,
  viewGeneration = 1,
  frameId = "frame-preview-1",
  frameSequence = 1,
  inputSequence = 0,
  presentation = "preview",
  byte = 1,
} = {}) {
  return Object.freeze({
    botId,
    targetId,
    targetGeneration,
    sessionGeneration,
    pageGeneration,
    frameId,
    frameSequence,
    inputSequence,
    presentation,
    width: presentation === "interactive" ? 960 : 640,
    height: presentation === "interactive" ? 600 : 400,
    mimeType: "image/png",
    bytes: Uint8Array.from([byte, byte + 1, byte + 2]),
    surface: Object.freeze({ cssWidth: 1280, cssHeight: 800 }),
    presentations: Object.freeze({
      preview: Object.freeze({ width: 640, height: 400, fps: 1 }),
      interactive: Object.freeze({ width: 960, height: 600 }),
    }),
    viewGeneration,
  });
}

function richStatus({
  botId = BOT_A,
  targetId = LOCAL_A,
  targetGeneration = 1,
  sessionGeneration = 4,
  pageGeneration = 2,
  viewGeneration = 1,
  frameId = "frame-interactive-1",
  frameSequence = 1,
  inputSequence = 0,
  presentation = "interactive",
  state = "live",
  code = null,
} = {}) {
  return Object.freeze({
    botId,
    targetId,
    targetGeneration,
    sessionGeneration,
    pageGeneration,
    viewGeneration,
    frameId,
    frameSequence,
    inputSequence,
    presentation,
    state,
    code,
  });
}

function richNavigation({
  botId = BOT_A,
  targetId = LOCAL_A,
  targetGeneration = 1,
  sessionGeneration = 4,
  pageGeneration = 3,
  viewGeneration = 1,
  frameId = "frame-nav-1",
  frameSequence = 1,
  inputSequence = 0,
  action = "navigate",
  url = "https://example.com/next",
} = {}) {
  return Object.freeze({
    botId,
    targetId,
    targetGeneration,
    sessionGeneration,
    pageGeneration,
    viewGeneration,
    frameId,
    frameSequence,
    inputSequence,
    action,
    url,
  });
}

function findNode(value, className) {
  const seen = new Set();
  const visit = (node) => {
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (node.className?.split?.(/\s+/).includes(className)) return node;
    for (const child of node.children ?? []) {
      const match = visit(child);
      if (match) return match;
    }
    return null;
  };
  return visit(value.container) ?? visit(value.documentRef?.body);
}

test("canvas view does not require Array methods on the browser HTMLCollection", () => {
  const value = fixture({ htmlCollection: true });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  assert.equal(value.container.children.length, 1);
  mounted.dispose();
});

test("canvas view selects exact bot generations, draws only increasing current frames, and never creates object URLs", async () => {
  const bitmaps = [];
  const value = fixture({
    async decode() {
      const bitmap = { closed: 0, close() { this.closed += 1; } };
      bitmaps.push(bitmap);
      return bitmap;
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  await tick();
  assert.deepEqual(value.calls.select, [{ botId: BOT_A, viewGeneration: 1 }]);
  assert.equal(value.calls.clearRect.length >= 1, true);

  value.emitFrame(frame());
  await tick();
  assert.equal(value.calls.drawImage.length, 1);
  assert.equal(bitmaps[0].closed, 1);
  value.emitFrame(frame());
  value.emitFrame(frame({ sequence: 0 }));
  value.emitFrame(frame({ botId: BOT_B, targetId: LOCAL_B, sequence: 2 }));
  await tick();
  assert.equal(value.calls.drawImage.length, 1);

  mounted.selectBot(BOT_A);
  value.emitFrame(frame({ targetGeneration: 2, viewGeneration: 2, sequence: 1, byte: 9 }));
  await tick();
  assert.equal(value.calls.drawImage.length, 2);
  assert.equal(value.calls.clearRect.length >= 2, true);
  assert.equal(value.objectUrls.length, 0);
  mounted.dispose();
  assert.equal(value.frameListener(), null);
  assert.equal(value.calls.clear.at(-1).viewGeneration, 3);
});

test("status states expose four labels and retry is offered only when unavailable", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  const status = value.nodes.find((node) => node.className === "openbot-local-desktop-view-status");
  const retry = value.nodes.find((node) => node.className === "openbot-local-desktop-retry");
  assert.equal(status.textContent, "Connecting…");
  assert.equal(retry.hidden, true);

  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "unavailable",
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  assert.equal(status.textContent, "Unavailable");
  assert.equal(retry.hidden, false);
  retry.click();
  assert.deepEqual(value.calls.retry, [{ botId: BOT_A, viewGeneration: 2 }]);
  assert.equal(retry.disabled, true);

  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 2,
    state: "retrying",
    code: null,
  });
  assert.equal(status.textContent, "Retrying…");
  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 2,
    state: "live",
    code: null,
  });
  assert.equal(status.textContent, "Live");
  assert.equal(retry.hidden, true);
  mounted.dispose();
});

test("a stale rejected selection cannot overwrite the current bot generation", async () => {
  const stale = deferred();
  const value = fixture({
    select(request) {
      return request.botId === BOT_A ? stale.promise : Promise.resolve();
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  mounted.selectBot(BOT_B);
  const status = value.nodes.find((node) => node.className === "openbot-local-desktop-view-status");
  const retry = value.nodes.find((node) => node.className === "openbot-local-desktop-retry");
  assert.equal(status.textContent, "Connecting…");
  assert.equal(retry.hidden, true);
  stale.reject(new Error("stale private /Users/token=secret"));
  await tick();
  assert.equal(status.textContent, "Connecting…");
  assert.equal(retry.hidden, true);
  mounted.dispose();
});

test("renderer rejects a transparent Proxy status without changing the current state", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  const status = value.nodes.find((node) => node.className === "openbot-local-desktop-view-status");
  const valid = {
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "live",
    code: null,
  };
  value.emitStatus(new Proxy(valid, {}));
  await tick();
  assert.equal(status.textContent, "Connecting…");
  mounted.dispose();
});

test("synchronous select reentry and throw cannot mark the reentrant selection unavailable", async () => {
  let mounted;
  const value = fixture({
    select(request) {
      if (request.botId === BOT_A) {
        mounted.selectBot(BOT_B);
        throw new Error("stale select failure");
      }
      return undefined;
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  const status = value.nodes.find((node) => node.className === "openbot-local-desktop-view-status");
  await tick();
  assert.equal(status.textContent, "Connecting…");
  mounted.dispose();
});

test("synchronous retry reentry and throw cannot mark the reentrant selection unavailable", async () => {
  let mounted;
  const value = fixture({
    retry() {
      mounted.selectBot(BOT_B);
      throw new Error("stale retry failure");
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "unavailable",
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  mounted.retry();
  const status = value.nodes.find((node) => node.className === "openbot-local-desktop-view-status");
  await tick();
  assert.equal(status.textContent, "Connecting…");
  mounted.dispose();
});

test("selection invalidates before decode so late bitmaps close without drawing and disposal clears immediately", async () => {
  const waiting = deferred();
  const bitmap = { closed: 0, close() { this.closed += 1; } };
  const value = fixture({ decode: () => waiting.promise });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(frame());
  await tick();
  mounted.selectBot(BOT_B);
  assert.deepEqual(value.calls.select.at(-1), { botId: BOT_B, viewGeneration: 2 });
  waiting.resolve(bitmap);
  await tick();
  assert.equal(bitmap.closed, 1);
  assert.equal(value.calls.drawImage.length, 0);
  assert.equal(value.calls.clearRect.length >= 2, true);

  value.emitFrame(frame({
    botId: BOT_B,
    targetId: LOCAL_B,
    viewGeneration: 2,
    sequence: 1,
    byte: 7,
  }));
  mounted.dispose();
  await tick();
  assert.equal(value.calls.drawImage.length, 0);
  assert.equal(value.objectUrls.length, 0);
});

test("hostile or oversized frame DTOs are rejected before Blob decoding", async () => {
  let decodes = 0;
  const value = fixture({ decode: async () => { decodes += 1; return { close() {} }; } });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame({ ...frame(), url: "https://example.com/?token=private" });
  value.emitFrame({ ...frame(), bytes: new Uint8Array(1_048_577) });
  value.emitFrame(new Proxy({}, { ownKeys() { throw new Error("/Users/private"); } }));
  const hostileBytes = [
    new Proxy(Uint8Array.from([1, 2, 3]), {}),
    new Proxy(Uint8Array.from([1, 2, 3]), {
      getPrototypeOf() { throw new Error("private instanceof trap"); },
    }),
    new Proxy(Uint8Array.from([1, 2, 3]), {
      get(target, property) {
        if (property === "byteLength") return target.byteLength;
        if (property === Symbol.iterator) throw new Error("private copy trap");
        return Reflect.get(target, property, target);
      },
    }),
  ];
  for (const bytes of hostileBytes) {
    await assert.doesNotReject(async () => value.emitFrame({ ...frame(), bytes }));
  }
  await tick();
  assert.equal(decodes, 0);
  assert.equal(value.calls.drawImage.length, 0);
  mounted.dispose();
});

test("Desktop preview uses the product anatomy and never owns pointer or keyboard input", () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  const surface = findNode(value, "openbot-local-desktop-view");
  const previewCanvas = findNode(value, "openbot-local-desktop-preview-canvas");
  const text = value.nodes.map((node) => node.textContent).join(" ");
  assert.match(text, /Desktop/);
  assert.match(text, /Runs on this Mac/);
  assert.match(text, /Open Desktop/);
  assert.doesNotMatch(text, /Free Local Desktop/);
  assert.equal(surface.attributes["aria-label"], "Desktop");
  assert.equal(previewCanvas.listeners.has("pointerdown"), false);
  assert.equal(previewCanvas.listeners.has("keydown"), false);
  previewCanvas.dispatchEvent({ type: "pointerdown", clientX: 10, clientY: 10 });
  assert.equal(value.calls.acquireControl.length, 0);
  assert.equal(value.calls.sendInput.length, 0);
  mounted.dispose();
});

test("opening Desktop reuses one view subscription and one selected session across preview and stage", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  const previewFrameListener = value.frameListener();
  const previewStatusListener = value.navigationListener();
  mounted.selectBot(BOT_A);
  await tick();
  await value.emitFrame(richFrame());
  await tick();
  const open = findNode(value, "openbot-local-desktop-open");
  const stage = findNode(value, "openbot-local-desktop-stage");
  const back = findNode(value, "openbot-local-desktop-back");
  assert.equal(typeof open.listeners.get("click"), "function");
  open.click();
  await tick();
  assert.equal(stage.hidden, false);
  assert.deepEqual(value.calls.select, [{ botId: BOT_A, viewGeneration: 1 }]);
  assert.equal(value.calls.presentation.length, 1);
  assert.equal(value.calls.presentation[0].presentation, "interactive");
  assert.equal(value.frameListener(), previewFrameListener);
  assert.equal(value.navigationListener(), previewStatusListener);
  back.click();
  await tick();
  assert.equal(stage.hidden, true);
  assert.equal(value.calls.presentation.length, 2);
  assert.equal(value.calls.presentation[1].presentation, "preview");
  assert.deepEqual(value.calls.select, [{ botId: BOT_A, viewGeneration: 1 }]);
  mounted.dispose();
});

test("rich frame, status, and navigation DTOs are exact-current and stale generations are silent", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  await value.emitFrame(richFrame());
  await tick();
  const previewCanvas = findNode(value, "openbot-local-desktop-preview-canvas");
  const initialDraws = value.calls.drawImage.length;
  value.emitFrame(richFrame({ frameSequence: 1, byte: 9 }));
  value.emitFrame(richFrame({ pageGeneration: 1, frameSequence: 2, byte: 10 }));
  value.emitFrame({ ...richFrame({ frameSequence: 2 }), unexpected: true });
  value.emitStatus(richStatus({ frameSequence: 1, state: "connecting" }));
  value.emitNavigation(richNavigation({ pageGeneration: 3 }));
  await tick();
  assert.equal(value.calls.drawImage.length, initialDraws);
  assert.equal(previewCanvas.attributes["aria-label"], "Passive Desktop preview");
  assert.equal(value.calls.releaseControl.length, 0);
  mounted.dispose();
});

test("letterbox geometry maps only content pixels to the fixed 1280x800 surface", () => {
  const { computeLetterbox, mapPointerToSurface } = require(viewPath);
  const layout = computeLetterbox({ left: 0, top: 0, width: 1000, height: 700 }, 1280, 800);
  assert.deepEqual(layout, { left: 0, top: 37.5, width: 1000, height: 625 });
  assert.equal(mapPointerToSurface(layout, { clientX: 20, clientY: 20 }), null);
  assert.deepEqual(mapPointerToSurface(layout, { clientX: 0, clientY: 37.5 }), { x: 0, y: 0 });
  assert.deepEqual(mapPointerToSurface(layout, { clientX: 1000, clientY: 662.5 }), { x: 1280, y: 800 });
  assert.deepEqual(mapPointerToSurface(layout, { clientX: 500, clientY: 350 }), { x: 640, y: 400 });
});

test("mouse, double-click, drag, and wheel inputs preserve ordered exact currentness", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame());
  const open = findNode(value, "openbot-local-desktop-open");
  open.click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const stageCanvas = findNode(value, "openbot-local-desktop-stage-canvas");
  stageCanvas.rect = { left: 100, top: 50, width: 960, height: 600, right: 1060, bottom: 650 };
  stageCanvas.dispatchEvent({ type: "pointerdown", clientX: 200, clientY: 150, button: 0, buttons: 1, detail: 1, pointerId: 1, preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "pointermove", clientX: 300, clientY: 250, button: 0, buttons: 1, pointerId: 1, preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "pointerup", clientX: 300, clientY: 250, button: 0, buttons: 0, detail: 1, pointerId: 1, preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "dblclick", clientX: 300, clientY: 250, button: 0, buttons: 0, detail: 2, preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "wheel", clientX: 400, clientY: 300, deltaX: 0, deltaY: -120, preventDefault() {} });
  await tick();
  assert.equal(value.calls.acquireControl.length, 1);
  assert.deepEqual(value.calls.sendInput.map((entry) => entry.type), [
    "mousePressed", "mouseMoved", "mouseReleased", "mousePressed", "mouseReleased", "mouseWheel",
  ]);
  assert.ok(Math.abs(value.calls.sendInput[0].x - 133.33333333333334) < 1e-9);
  assert.ok(Math.abs(value.calls.sendInput[0].y - 133.33333333333334) < 1e-9);
  assert.equal(value.calls.sendInput[3].clickCount, 2);
  assert.equal(value.calls.sendInput[5].deltaY, -120);
  assert.deepEqual(value.calls.sendInput.map((entry) => entry.inputSequence), [1, 2, 3, 4, 5, 6]);
  mounted.dispose();
});

test("keyboard, text, paste, and IME input use the facade contract without reading host clipboard", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame());
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const stageCanvas = findNode(value, "openbot-local-desktop-stage-canvas");
  const throwingClipboard = Object.create(null, {
    getData: { get() { throw new Error("host clipboard read"); } },
  });
  stageCanvas.dispatchEvent({ type: "keydown", key: "Tab", code: "Tab", preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "keyup", key: "Tab", code: "Tab", preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "beforeinput", inputType: "insertText", data: "typed", preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "paste", data: "pasted", clipboardData: throwingClipboard, preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "compositionupdate", data: "かな", preventDefault() {} });
  await tick();
  assert.deepEqual(value.calls.sendInput.map((entry) => entry.type), [
    "keyDown", "keyUp", "insertText", "insertText", "imeSetComposition",
  ]);
  assert.equal(value.calls.sendInput[2].text, "typed");
  assert.equal(value.calls.sendInput[3].text, "pasted");
  assert.equal(value.calls.sendInput[4].selectionStart, 0);
  assert.equal(value.calls.sendInput[4].selectionEnd, 2);
  mounted.dispose();
});

test("control lease is acquired only on stage focus, released on blur, and Escape follows fullscreen-control-close hierarchy", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame());
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const stage = findNode(value, "openbot-local-desktop-stage");
  const stageCanvas = findNode(value, "openbot-local-desktop-stage-canvas");
  assert.equal(value.calls.acquireControl.length, 0);
  stageCanvas.dispatchEvent({ type: "focus" });
  await tick();
  assert.equal(value.calls.acquireControl.length, 1);
  stageCanvas.dispatchEvent({ type: "blur" });
  await tick();
  assert.equal(value.calls.releaseControl.length, 1);
  stage.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  await tick();
  assert.equal(stage.hidden, true);
  mounted.dispose();
});

test("navigation controls validate bounded public HTTPS addresses before IPC and retain history/reload currentness", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame());
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const stageCanvas = findNode(value, "openbot-local-desktop-stage-canvas");
  stageCanvas.dispatchEvent({ type: "focus" });
  await tick();
  stageCanvas.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  stageCanvas.dispatchEvent({ type: "keydown", key: "a", code: "KeyA", preventDefault() {} });
  await tick();
  const address = findNode(value, "openbot-local-desktop-address");
  const form = findNode(value, "openbot-local-desktop-address-form");
  address.value = "http://insecure.example/";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(value.calls.navigate.length, 0);
  assert.match(findNode(value, "openbot-local-desktop-address-error").textContent, /HTTPS/);
  address.value = "https://example.com/next";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  assert.equal(value.calls.navigate.length, 1);
  assert.equal(value.calls.navigate[0].url, "https://example.com/next");
  assert.equal(value.calls.sendInput.some((input) => input.type === "mouseReleased" && input.button === "left"), true);
  assert.equal(value.calls.sendInput.some((input) => input.type === "keyUp" && input.key === "a"), true);
  const navigateIndex = value.calls.events.findIndex((event) => event.type === "navigate");
  const releaseIndex = value.calls.events.findIndex((event) => event.type === "releaseControl");
  assert.equal(releaseIndex < navigateIndex, true);
  findNode(value, "openbot-local-desktop-go-back").click();
  await tick();
  findNode(value, "openbot-local-desktop-go-forward").click();
  await tick();
  findNode(value, "openbot-local-desktop-reload").click();
  await tick();
  assert.equal(value.calls.goBack.length, 1);
  assert.equal(value.calls.goForward.length, 1);
  assert.equal(value.calls.reload.length, 1);
  assert.equal(value.calls.navigate[0].botId, BOT_A);
  mounted.dispose();
});

test("navigation rejects same-page and malformed current results without clearing a current operation incorrectly", async () => {
  const pending = deferred();
  const value = fixture({ navigate: () => pending.promise });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const address = findNode(value, "openbot-local-desktop-address");
  const form = findNode(value, "openbot-local-desktop-address-form");
  address.value = "https://example.com/same-page";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  pending.resolve(richNavigation({
    action: "navigate",
    pageGeneration: 2,
    frameId: null,
    frameSequence: 0,
    url: "https://example.com/same-page",
  }));
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Unavailable");

  const malformed = fixture({
    navigate: () => richNavigation({
      action: "navigate",
      pageGeneration: 3,
      frameId: null,
      frameSequence: 0,
      url: null,
    }),
  });
  const malformedMounted = createLocalDesktopView(malformed);
  malformedMounted.selectBot(BOT_A);
  malformed.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(malformed, "openbot-local-desktop-open").click();
  await tick();
  malformed.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const malformedAddress = findNode(malformed, "openbot-local-desktop-address");
  malformedAddress.value = "https://example.com/malformed";
  findNode(malformed, "openbot-local-desktop-address-form").dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  assert.equal(findNode(malformed, "openbot-local-desktop-stage-status").textContent, "Unavailable");
  malformedMounted.dispose();
  mounted.dispose();
});

test("history navigation clears an unknown address instead of leaving stale URL text", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const address = findNode(value, "openbot-local-desktop-address");
  address.value = "https://example.com/current";
  findNode(value, "openbot-local-desktop-address-form").dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  assert.equal(address.value, "https://example.com/current");
  findNode(value, "openbot-local-desktop-go-back").click();
  await tick();
  assert.equal(address.value, "");
  mounted.dispose();
});

test("public IPv6 navigation is accepted asynchronously while private IPv6 stays no-IPC", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const address = findNode(value, "openbot-local-desktop-address");
  const form = findNode(value, "openbot-local-desktop-address-form");
  address.value = "https://[2001:4860:4860::8888]/";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  assert.equal(value.calls.navigate.length, 1);
  assert.equal(value.calls.navigate[0].url, "https://[2001:4860:4860::8888]/");
  address.value = "https://[feff::1]/";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  assert.equal(value.calls.navigate.length, 2);
  assert.equal(value.calls.navigate[1].url, "https://[feff::1]/");
  for (const candidate of ["https://[::1]/", "https://[::]/", "https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/"]) {
    address.value = candidate;
    form.dispatchEvent({ type: "submit", preventDefault() {} });
  }
  assert.equal(value.calls.navigate.length, 2);
  mounted.dispose();
});

test("unavailable stage shows retry only, decode failure fences the frame, and disposal removes stage listeners", async () => {
  const value = fixture({ decode: async () => { throw new Error("decode failed"); } });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "unavailable",
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  const retry = findNode(value, "openbot-local-desktop-retry");
  assert.equal(retry.hidden, false);
  const open = findNode(value, "openbot-local-desktop-open");
  open.click();
  await tick();
  const stageRetry = findNode(value, "openbot-local-desktop-stage-retry");
  assert.equal(stageRetry.hidden, false);
  value.emitFrame(richFrame());
  await tick();
  assert.equal(value.calls.drawImage.length, 0);
  mounted.dispose();
  assert.equal(value.frameListener(), null);
  assert.equal(value.navigationListener(), null);
});

test("late input acknowledgement from an old frame is rejected after a page/frame replacement", async () => {
  const pending = deferred();
  let submitted = null;
  const value = fixture({
    sendInput(request) {
      submitted = request;
      return pending.promise;
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ frameId: "frame-old", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.rect = { left: 0, top: 0, width: 960, height: 600, right: 960, bottom: 600 };
  canvas.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  await tick();
  assert.equal(value.calls.sendInput.length, 1);
  value.emitFrame(richFrame({ frameId: "frame-new", frameSequence: 3, byte: 9 }));
  pending.resolve({
    botId: submitted.botId,
    targetId: submitted.targetId,
    targetGeneration: submitted.targetGeneration,
    sessionGeneration: submitted.sessionGeneration,
    pageGeneration: submitted.pageGeneration,
    viewGeneration: submitted.viewGeneration,
    frameId: submitted.frameId,
    frameSequence: submitted.frameSequence,
    inputSequence: submitted.inputSequence,
  });
  await tick();
  assert.equal(value.calls.sendInput.length, 1);
  assert.equal(findNode(value, "openbot-local-desktop-control-state").textContent, "Controlling Desktop");
  mounted.dispose();
});

test("rapid stage and bot transitions close the stage and release the shared owner before the next selection", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ frameId: "frame-a" }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const stage = findNode(value, "openbot-local-desktop-stage");
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "focus" });
  await tick();
  assert.equal(value.calls.acquireControl.length, 1);
  canvas.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "keydown", key: "a", code: "KeyA", preventDefault() {} });
  await tick();
  mounted.selectBot(BOT_B);
  await tick();
  assert.equal(stage.hidden, true);
  assert.equal(value.calls.releaseControl.length, 1);
  assert.equal(value.calls.sendInput.some((input) => input.type === "mouseReleased" && input.button === "left"), true);
  assert.equal(value.calls.sendInput.some((input) => input.type === "keyUp" && input.key === "a"), true);
  const switchIndex = value.calls.events.findIndex((event) => event.type === "select" && event.value.botId === BOT_B);
  const releaseIndex = value.calls.events.findIndex((event) => event.type === "releaseControl");
  assert.equal(releaseIndex < switchIndex, true);
  assert.deepEqual(value.calls.select.at(-1), { botId: BOT_B, viewGeneration: 2 });
  mounted.dispose();
});

test("Escape leaves fullscreen before releasing control and only then closes the stage", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame());
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const stage = findNode(value, "openbot-local-desktop-stage");
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "focus" });
  await tick();
  findNode(value, "openbot-local-desktop-full-screen").click();
  stage.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  await tick();
  assert.equal(stage.hidden, false);
  assert.equal(value.calls.releaseControl.length, 0);
  stage.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  await tick();
  assert.equal(stage.hidden, false);
  assert.equal(value.calls.releaseControl.length, 1);
  stage.dispatchEvent({ type: "keydown", key: "Escape", preventDefault() {} });
  await tick();
  assert.equal(stage.hidden, true);
  mounted.dispose();
});

test("real legacy preview selection establishes an authoritative session before opening the interactive stage", async () => {
  const value = fixture({
    select: () => ({
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      viewGeneration: 1,
      state: "live",
      code: null,
    }),
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  await tick();
  value.emitFrame(frame());
  await tick();
  const open = findNode(value, "openbot-local-desktop-open");
  const stage = findNode(value, "openbot-local-desktop-stage");
  assert.equal(open.disabled, true, "legacy preview must not pretend it has an interactive session");
  open.click();
  await tick();
  assert.equal(stage.hidden, true, "stage remains closed while the authoritative handoff is pending");
  assert.equal(value.calls.presentation.length, 0, "renderer must not invent session/page generations");
  mounted.dispose();
});

test("opening while selection is still connecting stays pending instead of showing a blank stage", async () => {
  const selection = deferred();
  const value = fixture({ select: () => selection.promise });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  await tick();
  const open = findNode(value, "openbot-local-desktop-open");
  const stage = findNode(value, "openbot-local-desktop-stage");
  assert.equal(open.disabled, true);
  open.click();
  await tick();
  assert.equal(stage.hidden, true);
  selection.resolve({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "connecting",
    code: null,
  });
  await tick();
  assert.equal(stage.hidden, true);
  mounted.dispose();
});

test("Open represents the interactive presentation as pending until its first rich frame", async () => {
  const presentation = deferred();
  const value = fixture({
    select: () => ({
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 2,
      viewGeneration: 1,
      frameId: "frame-preview-selection",
      frameSequence: 1,
      inputSequence: 0,
      presentation: "preview",
      state: "live",
      code: null,
    }),
    presentation: (request) => request.presentation === "interactive" ? presentation.promise : null,
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  await tick();
  value.emitFrame(frame());
  await tick();
  assert.equal(value.calls.drawImage.length >= 1, true, "legacy preview remains visible after rich selection handoff");
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  const stage = findNode(value, "openbot-local-desktop-stage");
  assert.equal(stage.hidden, false);
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Connecting…");
  assert.equal(findNode(value, "openbot-local-desktop-go-back").disabled, true);
  assert.equal(value.calls.presentation.filter((request) => request.presentation === "interactive").length, 1);
  presentation.resolve(richStatus({ frameId: "frame-preview-selection", frameSequence: 1 }));
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Live");
  assert.equal(findNode(value, "openbot-local-desktop-go-back").disabled, false);
  mounted.dispose();
});

test("rapid Open/Back/Open fences the first presentation and surfaces a current rejection", async () => {
  const first = deferred();
  const second = deferred();
  let interactiveCalls = 0;
  const value = fixture({
    select: () => ({
      botId: BOT_A,
      targetId: LOCAL_A,
      targetGeneration: 1,
      sessionGeneration: 4,
      pageGeneration: 2,
      viewGeneration: 1,
      frameId: "frame-preview-selection",
      frameSequence: 1,
      inputSequence: 0,
      presentation: "preview",
      state: "live",
      code: null,
    }),
    presentation: (request) => {
      if (request.presentation !== "interactive") return null;
      interactiveCalls += 1;
      return interactiveCalls === 1 ? first.promise : second.promise;
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  await tick();
  const open = findNode(value, "openbot-local-desktop-open");
  open.click();
  await tick();
  mounted.closeDesktop();
  open.click();
  await tick();
  assert.equal(interactiveCalls, 2);
  first.resolve(richStatus({ frameId: "frame-preview-selection", frameSequence: 1 }));
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Connecting…");
  second.reject(new Error("presentation failed"));
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Unavailable");
  assert.equal(findNode(value, "openbot-local-desktop-stage-retry").hidden, false);
  mounted.dispose();
});

test("a pending acquire is fenced by blur and stale success releases with the exact release DTO", async () => {
  const acquire = deferred();
  const value = fixture({ acquireControl: () => acquire.promise });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.focus();
  await tick();
  assert.equal(value.calls.acquireControl.length, 1);
  canvas.blur();
  acquire.resolve({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    sessionGeneration: 4,
    pageGeneration: 2,
    viewGeneration: 1,
    frameId: "frame-interactive",
    frameSequence: 2,
    inputSequence: 0,
    controlGeneration: 41,
  });
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-control-state").textContent, "View only");
  assert.equal(value.calls.releaseControl.length, 1);
  assert.deepEqual(Object.keys(value.calls.releaseControl[0]).sort(), [
    "botId", "controlGeneration", "pageGeneration", "sessionGeneration", "targetGeneration", "targetId", "viewGeneration",
  ]);
  mounted.dispose();
});

test("blur and pointer cancellation release every held button and key before releasing control", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "keydown", key: "a", code: "KeyA", preventDefault() {} });
  await tick();
  canvas.dispatchEvent({ type: "pointercancel", clientX: 100, clientY: 100, button: 0, buttons: 0, detail: 0, preventDefault() {} });
  canvas.blur();
  await tick();
  const inputs = value.calls.sendInput;
  assert.equal(inputs.some((input) => input.type === "mouseReleased" && input.button === "left"), true);
  assert.equal(inputs.some((input) => input.type === "keyUp" && input.key === "a"), true);
  assert.equal(inputs.filter((input) => input.type === "mouseReleased").every((input) => input.button === "left"), true);
  assert.equal(value.calls.releaseControl.length, 1);
  const releaseIndex = value.calls.events.findIndex((event) => event.type === "releaseControl");
  assert.equal(value.calls.events.findIndex((event) => event.type === "sendInput" && event.value.type === "mouseReleased") < releaseIndex, true);
  assert.equal(value.calls.events.findIndex((event) => event.type === "sendInput" && event.value.type === "keyUp") < releaseIndex, true);
  mounted.dispose();
});

test("held-input cleanup remains fenced when lease release rejects", async () => {
  const value = fixture({ releaseControl: () => Promise.reject(new Error("release failed")) });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "keydown", key: "a", code: "KeyA", preventDefault() {} });
  await tick();
  canvas.blur();
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-control-state").textContent, "View only");
  assert.equal(value.calls.releaseControl.length, 1);
  assert.deepEqual(value.calls.sendInput.filter((input) => input.type === "mouseReleased").map((input) => input.button), ["left"]);
  assert.deepEqual(value.calls.sendInput.filter((input) => input.type === "keyUp").map((input) => input.key), ["a"]);
  mounted.dispose();
});

test("selection clear preserves a monotonic old-session sequence across rejected held-input compensation", async () => {
  let rejectedMouseRelease = false;
  const value = fixture({
    sendInput(request) {
      if (request.type === "mouseReleased" && !rejectedMouseRelease) {
        rejectedMouseRelease = true;
        return Promise.reject(new Error("mouse release rejected"));
      }
      return Promise.resolve({
        botId: request.botId,
        targetId: request.targetId,
        targetGeneration: request.targetGeneration,
        sessionGeneration: request.sessionGeneration,
        pageGeneration: request.pageGeneration,
        viewGeneration: request.viewGeneration,
        frameId: request.frameId,
        frameSequence: request.frameSequence,
        inputSequence: request.inputSequence,
      });
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "pointerdown", clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "keydown", key: "a", code: "KeyA", preventDefault() {} });
  await tick();
  mounted.selectBot(null);
  await tick();
  const releaseInputs = value.calls.sendInput.filter((input) => input.type === "mouseReleased" || input.type === "keyUp");
  assert.deepEqual(releaseInputs.map((input) => input.type), ["mouseReleased", "keyUp"]);
  assert.equal(releaseInputs[1].inputSequence > releaseInputs[0].inputSequence, true);
  const releaseInputEvents = value.calls.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "sendInput" && (event.value.type === "mouseReleased" || event.value.type === "keyUp"));
  const clearIndex = value.calls.events.findIndex((event) => event.type === "clear");
  assert.equal(releaseInputEvents.every(({ index }) => index < clearIndex), true);
  mounted.dispose();
});

test("same-session reacquire starts above every prior held-input compensation sequence", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "keydown", key: "a", code: "KeyA", preventDefault() {} });
  await tick();
  canvas.blur();
  await tick();
  const keyRelease = value.calls.sendInput.find((input) => input.type === "keyUp" && input.key === "a");
  assert.ok(keyRelease);
  canvas.focus();
  await tick();
  canvas.dispatchEvent({ type: "keydown", key: "b", code: "KeyB", preventDefault() {} });
  await tick();
  const keyDown = value.calls.sendInput.find((input) => input.type === "keyDown" && input.key === "b");
  assert.ok(keyDown);
  assert.equal(keyDown.inputSequence > keyRelease.inputSequence, true);
  mounted.dispose();
});

test("pointerup and pointercancel outside the letterboxed content release each actual held pointer at its last valid point", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.rect = { left: 0, top: 0, width: 960, height: 600, right: 960, bottom: 600 };
  canvas.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "pointerdown", pointerId: 2, clientX: 200, clientY: 150, button: 2, buttons: 4, detail: 1, preventDefault() {} });
  await tick();
  canvas.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 1200, clientY: 700, button: 0, buttons: 0, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "pointercancel", pointerId: 2, clientX: 1200, clientY: 700, button: 2, buttons: 0, detail: 0, preventDefault() {} });
  await tick();
  const releases = value.calls.sendInput.filter((input) => input.type === "mouseReleased");
  assert.deepEqual(releases.map((input) => input.button), ["left", "right"]);
  assert.equal(releases.every((input) => input.button !== "none"), true);
  assert.equal(releases[0].x, 100 / 960 * 1280);
  assert.equal(releases[0].y, 100 / 600 * 800);
  assert.equal(releases[1].x, 200 / 960 * 1280);
  assert.equal(releases[1].y, 150 / 600 * 800);
  mounted.dispose();
});

test("rich frames with an equal sequence and a different frame id are rejected in the same session and page", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-current", frameSequence: 2 }));
  await tick();
  const drawCount = value.calls.drawImage.length;
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-different", frameSequence: 2, byte: 9 }));
  await tick();
  assert.equal(value.calls.drawImage.length, drawCount);
  mounted.dispose();
});

test("a rejected input fences the local lease and the next input reacquires control", async () => {
  let rejected = false;
  const value = fixture({
    sendInput(request) {
      if (request.type === "keyDown" && request.key === "a" && !rejected) {
        rejected = true;
        return Promise.reject(new Error("input rejected"));
      }
      return undefined;
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "keydown", key: "a", code: "KeyA", preventDefault() {} });
  await tick();
  canvas.dispatchEvent({ type: "keydown", key: "b", code: "KeyB", preventDefault() {} });
  await tick();
  assert.equal(value.calls.acquireControl.length, 2);
  assert.equal(value.calls.releaseControl.length, 1);
  const firstRelease = value.calls.events.findIndex((event) => event.type === "releaseControl");
  const secondAcquire = value.calls.acquireControl[1];
  assert.equal(firstRelease >= 0, true);
  assert.equal(secondAcquire !== undefined, true);
  canvas.blur();
  await tick();
  mounted.dispose();
});

test("legacy preview status cannot downgrade an active rich interactive stage", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "unavailable",
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Live");
  mounted.dispose();
});

test("synchronous pointerdown then cancel/up records each pending button before queueing and never duplicates cancel", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.rect = { left: 0, top: 0, width: 960, height: 600, right: 960, bottom: 600 };
  canvas.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "pointercancel", pointerId: 1, clientX: 1200, clientY: 700, button: 0, buttons: 0, detail: 0, preventDefault() {} });
  canvas.dispatchEvent({ type: "pointercancel", pointerId: 1, clientX: 1200, clientY: 700, button: 0, buttons: 0, detail: 0, preventDefault() {} });
  canvas.dispatchEvent({ type: "pointerdown", pointerId: 2, clientX: 200, clientY: 150, button: 2, buttons: 4, detail: 1, preventDefault() {} });
  canvas.dispatchEvent({ type: "pointerup", pointerId: 2, clientX: 1200, clientY: 700, button: 2, buttons: 0, detail: 1, preventDefault() {} });
  await tick();
  const pointerInputs = value.calls.sendInput.filter((input) => input.type === "mousePressed" || input.type === "mouseReleased");
  assert.deepEqual(pointerInputs.map((input) => `${input.type}:${input.button}`), [
    "mousePressed:left", "mouseReleased:left", "mousePressed:right", "mouseReleased:right",
  ]);
  assert.equal(pointerInputs.filter((input) => input.type === "mouseReleased" && input.button === "left").length, 1);
  assert.equal(pointerInputs.find((input) => input.type === "mouseReleased" && input.button === "left").x, 100 / 960 * 1280);
  mounted.dispose();
});

test("stage close before a queued pointer press sends neither a release-before-press nor a late press", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 100, clientY: 100, button: 0, buttons: 1, detail: 1, preventDefault() {} });
  mounted.closeDesktop();
  await tick();
  assert.deepEqual(value.calls.sendInput.filter((input) => input.type === "mousePressed" || input.type === "mouseReleased"), []);
  mounted.dispose();
});

test("close then reopen invalidates the old interactive frame while preview presentation is deferred", async () => {
  const preview = deferred();
  let interactiveCalls = 0;
  const value = fixture({
    presentation(request) {
      if (request.presentation === "preview") return preview.promise;
      interactiveCalls += 1;
      return null;
    },
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive-old", frameSequence: 2 }));
  await tick();
  const stage = findNode(value, "openbot-local-desktop-stage");
  const drawCount = value.calls.drawImage.length;
  mounted.closeDesktop();
  await tick();
  assert.equal(value.calls.presentation.some((request) => request.presentation === "preview"), true);
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  assert.equal(stage.hidden, false);
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Connecting…");
  assert.equal(findNode(value, "openbot-local-desktop-go-back").disabled, true);
  assert.equal(value.calls.drawImage.length, drawCount, "reopen must not redraw the old interactive frame");
  assert.equal(interactiveCalls, 2);
  preview.resolve(null);
  await tick();
  mounted.dispose();
});

test("preview failure after close updates legacy header status and retry despite the old interactive frame", async () => {
  const preview = deferred();
  const value = fixture({ presentation: (request) => request.presentation === "preview" ? preview.promise : null });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive-old", frameSequence: 2 }));
  await tick();
  mounted.closeDesktop();
  await tick();
  preview.reject(new Error("preview capture failed"));
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-view-status").textContent, "Unavailable");
  assert.equal(findNode(value, "openbot-local-desktop-retry").hidden, false);
  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "connecting",
    code: null,
  });
  value.emitStatus({
    botId: BOT_A,
    targetId: LOCAL_A,
    targetGeneration: 1,
    viewGeneration: 1,
    state: "unavailable",
    code: "OPENBOT_LOCAL_CAPTURE_FAILED",
  });
  assert.equal(findNode(value, "openbot-local-desktop-view-status").textContent, "Unavailable");
  assert.equal(findNode(value, "openbot-local-desktop-retry").hidden, false);
  mounted.dispose();
});

test("real ClipboardEvent-shaped paste forwards bounded text without synthesizing a duplicate key input", async () => {
  let reads = 0;
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.dispatchEvent({ type: "keydown", key: "v", code: "KeyV", metaKey: true, preventDefault() {} });
  canvas.dispatchEvent({
    type: "paste",
    clipboardData: {
      getData(kind) {
        reads += 1;
        assert.equal(kind, "text/plain");
        return "clipboard text";
      },
    },
    preventDefault() {},
  });
  await tick();
  assert.equal(reads, 1);
  assert.equal(value.calls.sendInput.filter((input) => input.type === "insertText").length, 1);
  assert.equal(value.calls.sendInput.filter((input) => input.type === "insertText")[0].text, "clipboard text");
  assert.equal(value.calls.sendInput.filter((input) => input.type === "keyDown" && input.key === "v").length, 0);
  mounted.dispose();
});

test("stale navigation completion cannot strand navigation controls after a bot transition", async () => {
  const firstNavigation = deferred();
  const secondNavigation = deferred();
  const value = fixture({ navigate: (request) => value.calls.navigate.length === 1 ? firstNavigation.promise : secondNavigation.promise });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-a-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-a", frameSequence: 2 }));
  await tick();
  const address = findNode(value, "openbot-local-desktop-address");
  const form = findNode(value, "openbot-local-desktop-address-form");
  address.value = "https://example.com/a";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  mounted.selectBot(BOT_B);
  value.emitFrame(richFrame({ botId: BOT_B, targetId: LOCAL_B, presentation: "preview", frameId: "frame-b-preview", frameSequence: 1, viewGeneration: 2 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ botId: BOT_B, targetId: LOCAL_B, presentation: "interactive", frameId: "frame-b", frameSequence: 2, viewGeneration: 2 }));
  await tick();
  address.value = "https://example.com/b";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  await tick();
  assert.equal(value.calls.navigate.length, 2);
  firstNavigation.resolve(richNavigation({ botId: BOT_A, targetId: LOCAL_A, viewGeneration: 1, frameId: null, frameSequence: 0, pageGeneration: 3, url: "https://example.com/a" }));
  await tick();
  assert.equal(value.calls.navigate.length, 2);
  secondNavigation.resolve(richNavigation({ botId: BOT_B, targetId: LOCAL_B, viewGeneration: 2, frameId: null, frameSequence: 0, pageGeneration: 3, url: "https://example.com/b" }));
  await tick();
  mounted.dispose();
});

test("same-sequence status and acquire acknowledgements with a different frame id are rejected", async () => {
  const value = fixture({
    acquireControl: (request) => ({ ...request, frameId: "frame-wrong", frameSequence: 2, inputSequence: 0, controlGeneration: 42 }),
  });
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-current", frameSequence: 2 }));
  await tick();
  value.emitStatus(richStatus({ frameId: "frame-wrong", frameSequence: 2, state: "unavailable", code: "OPENBOT_LOCAL_CAPTURE_FAILED" }));
  assert.equal(findNode(value, "openbot-local-desktop-stage-status").textContent, "Live");
  const canvas = findNode(value, "openbot-local-desktop-stage-canvas");
  canvas.focus();
  await tick();
  assert.equal(findNode(value, "openbot-local-desktop-control-state").textContent, "View only");
  assert.equal(value.calls.releaseControl.length, 1);
  assert.deepEqual(Object.keys(value.calls.releaseControl[0]).sort(), [
    "botId", "controlGeneration", "pageGeneration", "sessionGeneration", "targetGeneration", "targetId", "viewGeneration",
  ]);
  assert.equal(value.calls.releaseControl[0].controlGeneration, 42);
  mounted.dispose();
});

test("renderer rejects private, loopback, link-local, and credentialed HTTPS addresses before IPC", async () => {
  const value = fixture();
  const { createLocalDesktopView } = require(viewPath);
  const mounted = createLocalDesktopView(value);
  mounted.selectBot(BOT_A);
  value.emitFrame(richFrame({ presentation: "preview", frameId: "frame-preview", frameSequence: 1 }));
  findNode(value, "openbot-local-desktop-open").click();
  await tick();
  value.emitFrame(richFrame({ presentation: "interactive", frameId: "frame-interactive", frameSequence: 2 }));
  await tick();
  const address = findNode(value, "openbot-local-desktop-address");
  const form = findNode(value, "openbot-local-desktop-address-form");
  for (const candidate of [
    "https://localhost/", "https://foo.localhost/", "https://127.0.0.1/", "https://0.0.0.0/",
    "https://10.0.0.2/", "https://172.16.0.1/", "https://172.31.255.255/", "https://192.168.1.2/",
    "https://169.254.1.1/", "https://[::1]/", "https://[::]/", "https://[fc00::1]/",
    "https://[fd00::1]/", "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://user:pass@example.com/",
  ]) {
    address.value = candidate;
    form.dispatchEvent({ type: "submit", preventDefault() {} });
  }
  assert.equal(value.calls.navigate.length, 0);
  assert.match(findNode(value, "openbot-local-desktop-address-error").textContent, /HTTPS/);
  mounted.dispose();
});
