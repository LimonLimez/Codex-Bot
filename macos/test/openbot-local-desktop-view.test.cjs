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
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function fixture({ decode, htmlCollection = false } = {}) {
  const calls = { clear: [], clearRect: [], drawImage: [], select: [] };
  let frameListener = null;
  const context = {
    clearRect(...args) { calls.clearRect.push(args); },
    drawImage(...args) { calls.drawImage.push(args); },
  };
  function element(tagName) {
    const children = [];
    if (htmlCollection) Object.defineProperty(children, "at", { value: undefined });
    return {
      tagName: tagName.toUpperCase(),
      children,
      attributes: {},
      className: "",
      dataset: {},
      hidden: false,
      width: 0,
      height: 0,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getContext(kind) { return tagName === "canvas" && kind === "2d" ? context : null; },
      remove() { this.removed = true; },
    };
  }
  const documentRef = { createElement: element };
  const container = element("div");
  const openbotLocalDesktop = {
    async select(value) { calls.select.push(value); },
    async clear(value) { calls.clear.push(value); },
    onFrame(callback) { frameListener = callback; return () => { if (frameListener === callback) frameListener = null; }; },
  };
  const objectUrls = [];
  const windowRef = {
    Blob,
    openbotLocalDesktop,
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
    frameListener: () => frameListener,
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

  value.emitFrame(frame({ targetGeneration: 2, sequence: 1, byte: 9 }));
  await tick();
  assert.equal(value.calls.drawImage.length, 2);
  assert.equal(value.calls.clearRect.length >= 2, true);
  assert.equal(value.objectUrls.length, 0);
  mounted.dispose();
  assert.equal(value.frameListener(), null);
  assert.equal(value.calls.clear.at(-1).viewGeneration, 2);
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
