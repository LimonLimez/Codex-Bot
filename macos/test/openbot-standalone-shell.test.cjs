"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const shellPath = "../src/renderer/openbot-standalone-shell.js";
const BOT_A = "bot-11111111-1111-4111-8111-111111111111";
const BOT_B = "bot-22222222-2222-4222-8222-222222222222";
const CONVERSATION = "conversation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "conversation-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INVOCATION_A = "invocation-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVOCATION_B = "invocation-cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function documentFixture({ vendor = false, owned = false } = {}) {
  const roots = new Map();
  const body = {
    children: [],
    append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; },
  };
  const vendorSidebar = vendor ? { id: "vendor-sidebar" } : null;
  const vendorComposer = vendor ? { id: "vendor-composer" } : null;
  const ownedControls = { id: "codex-bot-controls" };
  const ownedSidebar = {
    id: "codex-owned-sidebar",
    closest(selector) { return selector === "#codex-bot-controls" ? ownedControls : null; },
  };
  const createElement = (tagName) => ({
    tagName: tagName.toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    className: "",
    hidden: false,
    parentElement: null,
    append(...children) { this.children.push(...children); for (const child of children) child.parentElement = this; },
    replaceChildren(...children) { this.children = []; this.append(...children); },
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === "id") roots.set(String(value), this); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; },
    listeners: new Map(),
    addEventListener(name, callback) { this.listeners.set(name, callback); },
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; },
    focus() {},
  });
  const root = createElement("div");
  root.setAttribute("id", "root");
  roots.set("root", root);
  return {
    body,
    createElement,
    getElementById(id) { return roots.get(id) ?? null; },
    querySelector(selector) {
      if (selector === "#root") return root;
      if (selector === "[data-codex-bot-sidebar-host]") return this.owned ? ownedSidebar : vendorSidebar;
      if (selector === "[data-codex-bot-composer-host]") return vendorComposer;
      if (selector.includes("aside") || selector.includes("nav")) return vendorSidebar;
      if (selector.includes("textarea") || selector.includes("form")) return vendorComposer;
      return null;
    },
    querySelectorAll() { return []; },
    root,
    installControls(botId = "") {
      ownedControls.dataset = { activeBotId: botId };
      roots.set("codex-bot-controls", ownedControls);
      return ownedControls;
    },
    owned,
  };
}

function byClass(root, className) {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (String(node.className || "").split(/\s+/).includes(className)) found.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  return found;
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function windowFixture(overrides = {}) {
  const listeners = new Map();
  const windowRef = {
    desktop: { async getCursorAuthStatus() { return { kind: "logged-out", freshness: 0 }; } },
    codexAccount: {
      async read() { return { generation: 2, status: "ready", authMode: "chatgpt", planType: "plus", requiresOpenaiAuth: true, login: null, rateLimits: null }; },
      async catalog() { return { generation: 3, status: "ready", models: [{ id: "gpt-5.6-sol" }] }; },
      onChanged(callback) { listeners.set("account", callback); return () => listeners.delete("account"); },
      onCatalogChanged(callback) { listeners.set("catalog", callback); return () => listeners.delete("catalog"); },
    },
    codexBots: { async list() { return []; }, onChanged() { return () => {}; } },
    openbotConversations: { onChanged() { return () => {}; }, onEvent() { return () => {}; } },
    OpenBotLocalDesktopView: {
      createLocalDesktopView() { return { selectBot() {}, dispose() {} }; },
    },
    addEventListener(name, callback) { listeners.set(`window:${name}`, callback); },
    removeEventListener(name, callback) {
      if (listeners.get(`window:${name}`) === callback) listeners.delete(`window:${name}`);
    },
    dispatchEvent(event) { listeners.get(`window:${event.type}`)?.(event); },
    ...overrides,
  };
  return windowRef;
}

test("standalone shell mounts the Free Local Desktop canvas and forwards only current bot selections", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  documentRef.installControls(BOT_A);
  const calls = [];
  const desktopView = { selectBot(botId) { calls.push(["select", botId]); }, dispose() { calls.push(["dispose"]); } };
  const windowRef = windowFixture({
    codexBots: { async list() { return [{ botId: BOT_A }, { botId: BOT_B }]; }, onChanged() { return () => {}; } },
    OpenBotLocalDesktopView: {
      createLocalDesktopView(options) {
        calls.push(["mount", options.container.className]);
        return desktopView;
      },
    },
  });
  const mounted = createHostController({ windowRef, documentRef });
  assert.equal(await mounted.start(), "standalone");
  await tick();
  const shell = documentRef.body.children[0];
  assert.equal(byClass(shell, "openbot-local-desktop-host").length, 1);
  assert.deepEqual(calls.slice(0, 2), [
    ["mount", "openbot-local-desktop-host"],
    ["select", BOT_A],
  ]);

  documentRef.installControls(BOT_B);
  windowRef.dispatchEvent({ type: "codex-bot-selection-changing" });
  assert.deepEqual(calls.at(-1), ["select", BOT_B]);
  mounted.dispose();
  assert.deepEqual(calls.at(-1), ["dispose"]);
});

test("vendor mounts win and no standalone shell is created", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture({ vendor: true });
  const mounted = createHostController({ windowRef: windowFixture(), documentRef });
  assert.equal(await mounted.start(), "vendor");
  assert.equal(mounted.snapshot().host, "vendor");
  assert.equal(documentRef.body.children.length, 0);
  assert.equal(documentRef.root.hidden, false);
  mounted.dispose();
});

test("OpenBot-owned controls appearing during account reads do not steal host selection", async () => {
  const { createHostController } = require(shellPath);
  const waiting = deferred();
  const documentRef = documentFixture();
  const mounted = createHostController({
    documentRef,
    windowRef: windowFixture({
      desktop: { async getCursorAuthStatus() { return waiting.promise; } },
    }),
  });
  const selecting = mounted.start();
  documentRef.owned = true;
  waiting.resolve({ kind: "logged-out" });
  assert.equal(await selecting, "standalone");
  assert.equal(documentRef.body.children.length, 1);
  mounted.dispose();
});

test("logged-out Cursor plus healthy direct Codex selects one stable standalone host", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  const mounted = createHostController({ windowRef: windowFixture(), documentRef });
  assert.equal(await mounted.start(), "standalone");
  assert.equal(mounted.snapshot().host, "standalone");
  assert.equal(documentRef.body.children.length, 1);
  const shell = documentRef.body.children[0];
  assert.equal(shell.attributes.id, "openbot-standalone-shell");
  assert.equal(shell.dataset.openbotHost, "standalone");
  assert.equal(shell.children[0].attributes["data-codex-bot-sidebar-host"], "");
  assert.equal(shell.children[1].children.at(-1).attributes["data-codex-bot-composer-host"], "");
  assert.equal(documentRef.root.hidden, true);
  assert.equal(documentRef.root.attributes["aria-hidden"], "true");
  assert.equal(await mounted.start(), "standalone");
  assert.equal(documentRef.body.children.length, 1);
  mounted.dispose();
  mounted.dispose();
  assert.equal(documentRef.body.children.length, 0);
  assert.equal(documentRef.root.hidden, false);
  assert.equal(documentRef.root.getAttribute("aria-hidden"), null);
});

test("fresh signed-out direct Codex account still mounts the standalone sign-in host", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  const windowRef = windowFixture();
  windowRef.codexAccount.read = async () => ({
    generation: 2,
    status: "signed-out",
    authMode: null,
    planType: null,
    requiresOpenaiAuth: true,
    login: null,
    rateLimits: null,
  });
  const mounted = createHostController({ windowRef, documentRef });
  assert.equal(await mounted.start(), "standalone");
  assert.equal(mounted.snapshot().host, "standalone");
  assert.equal(documentRef.body.children[0].attributes.id, "openbot-standalone-shell");
  assert.equal(byClass(documentRef.body.children[0], "openbot-standalone-status")[0].textContent, "OpenAI Codex");
  mounted.dispose();
});

test("pending account work cannot mount after disposal and does not self-mount on Cursor login", async () => {
  const { createHostController } = require(shellPath);
  const waiting = deferred();
  const documentRef = documentFixture();
  const windowRef = windowFixture({
    desktop: { async getCursorAuthStatus() { return waiting.promise; } },
  });
  const mounted = createHostController({ windowRef, documentRef });
  const start = mounted.start();
  mounted.dispose();
  waiting.resolve({ kind: "logged-out" });
  assert.equal(await start, "disposed");
  assert.equal(documentRef.body.children.length, 0);

  const signedInDocument = documentFixture();
  const signedIn = createHostController({
    documentRef: signedInDocument,
    windowRef: windowFixture({ desktop: { async getCursorAuthStatus() { return { kind: "logged-in" }; } } }),
  });
  assert.equal(await signedIn.start(), "pending");
  assert.equal(signedIn.snapshot().host, "pending");
  assert.equal(signedInDocument.body.children.length, 0);
  signedIn.dispose();
});

test("unhealthy Codex catalog never activates the standalone lane", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  const windowRef = windowFixture();
  windowRef.codexAccount.catalog = async () => ({ generation: 3, status: "loading", models: [] });
  const mounted = createHostController({ windowRef, documentRef });
  assert.equal(await mounted.start(), "pending");
  assert.equal(documentRef.body.children.length, 0);
  mounted.dispose();
});

test("standalone shell hydrates and refreshes then keeps follow-ups editable and cancels the exact invocation", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  const sends = [];
  const cancels = [];
  let reads = 0;
  let changedListener = null;
  let eventListener = null;
  const windowRef = windowFixture({
    codexBots: {
      async list() { return [{ botId: BOT_A, name: "New Bot" }]; },
      onChanged() { return () => {}; },
    },
    openbotConversations: {
      async list(botId) {
        assert.equal(botId, BOT_A);
        return [{ botId, conversationId: CONVERSATION, updatedAt: "2026-08-16T12:00:00.000Z" }];
      },
      async read(value) {
        reads += 1;
        assert.deepEqual(value, { botId: BOT_A, conversationId: CONVERSATION });
        return {
          botId: BOT_A,
          conversationId: CONVERSATION,
          createdAt: "2026-08-16T12:00:00.000Z",
          updatedAt: "2026-08-16T12:00:00.000Z",
          status: "idle",
          preview: "Prior reply",
          messages: [
            { messageId: "message-dddddddd-dddd-4ddd-8ddd-dddddddddddd", role: "user", text: "Prior question", createdAt: "2026-08-16T12:00:00.000Z" },
            { messageId: "message-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", role: "assistant", text: "Prior reply", createdAt: "2026-08-16T12:00:00.000Z" },
          ],
        };
      },
      async create() { throw new Error("existing conversation must hydrate"); },
      async send(value) {
        sends.push(value);
        return {
          botId: BOT_A,
          conversationId: CONVERSATION,
          invocationId: sends.length === 1 ? INVOCATION_A : INVOCATION_B,
          generation: 7,
          status: "streaming",
        };
      },
      async cancel(value) { cancels.push(value); return { ...value, generation: 7, status: "cancelled" }; },
      onChanged(callback) { changedListener = callback; return () => { changedListener = null; }; },
      onEvent(callback) { eventListener = callback; return () => { eventListener = null; }; },
    },
  });
  const mounted = createHostController({ windowRef, documentRef });
  assert.equal(await mounted.start(), "standalone");
  await tick();
  const shell = documentRef.body.children[0];
  const transcript = byClass(shell, "openbot-standalone-transcript")[0];
  assert.deepEqual(byClass(transcript, "openbot-standalone-message")
    .map((row) => row.children.at(-1).textContent), ["Prior question", "Prior reply"]);
  assert.equal(reads, 1);
  changedListener?.({ botId: BOT_A, conversationId: CONVERSATION });
  await tick();
  assert.equal(reads, 2);

  const composer = byClass(shell, "openbot-standalone-composer")[0];
  const input = byClass(shell, "openbot-standalone-input")[0];
  const stop = byClass(shell, "openbot-standalone-stop")[0];
  input.value = "First live task";
  await composer.listeners.get("submit")({ preventDefault() {} });
  input.value = "x".repeat((64 * 1024) + 1);
  await input.listeners.get("keydown")({ key: "Enter", shiftKey: false, preventDefault() {} });
  assert.equal(sends.length, 1);
  assert.equal(input.value.length, (64 * 1024) + 1);
  input.value = "Editable follow-up";
  await input.listeners.get("keydown")({ key: "Enter", shiftKey: false, preventDefault() {} });
  assert.equal(Boolean(input.disabled), false);
  assert.equal(sends.length, 1);
  assert.equal(input.value, "");

  eventListener({
    type: "completed", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION_A, generation: 7,
  });
  await tick();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].text, "Editable follow-up");

  await input.listeners.get("keydown")({ key: "Escape", shiftKey: false, preventDefault() {} });
  assert.deepEqual(cancels, [{ botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION_B }]);
  assert.equal(stop.disabled, true);
  mounted.dispose();
});

test("selection epochs keep deferred hydration streams completion and Stop scoped to the current bot", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  const controls = documentRef.installControls(BOT_A);
  const deferredA = deferred();
  const sends = [];
  const cancels = [];
  let eventListener;
  const windowRef = windowFixture({
    codexBots: {
      async list() { return [{ botId: BOT_A }, { botId: BOT_B }]; },
      onChanged() { return () => {}; },
    },
    openbotConversations: {
      async list(botId) { return [{ botId, conversationId: botId === BOT_A ? CONVERSATION : CONVERSATION_B }]; },
      async read({ botId, conversationId }) {
        if (botId === BOT_A) return deferredA.promise;
        return {
          botId, conversationId, createdAt: "2026-08-16T12:00:00.000Z",
          updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "Bot B prior",
          messages: [{
            messageId: "message-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", role: "assistant",
            text: "Bot B prior", createdAt: "2026-08-16T12:00:00.000Z",
          }],
        };
      },
      async send(value) {
        sends.push(value);
        if (value.botId === BOT_B) {
          eventListener({
            type: "text-delta", botId: BOT_B, conversationId: CONVERSATION_B,
            invocationId: INVOCATION_B, generation: 8, text: "wrong early",
          });
          eventListener({
            type: "text-delta", botId: BOT_B, conversationId: CONVERSATION_B,
            invocationId: INVOCATION_B, generation: 7, text: "right early",
          });
        }
        return {
          botId: value.botId, conversationId: value.conversationId,
          invocationId: value.botId === BOT_A ? INVOCATION_A : INVOCATION_B,
          generation: 7, status: "streaming",
        };
      },
      async cancel(value) { cancels.push(value); return { ...value, generation: 7, status: "cancelled" }; },
      onChanged() { return () => {}; },
      onEvent(callback) { eventListener = callback; return () => {}; },
    },
  });
  const mounted = createHostController({ windowRef, documentRef });
  assert.equal(await mounted.start(), "standalone");
  await tick();
  const shell = documentRef.body.children[0];
  const transcript = byClass(shell, "openbot-standalone-transcript")[0];
  const composer = byClass(shell, "openbot-standalone-composer")[0];
  const input = byClass(shell, "openbot-standalone-input")[0];
  const stop = byClass(shell, "openbot-standalone-stop")[0];
  const status = byClass(shell, "openbot-standalone-status")[0];

  controls.dataset.activeBotId = "";
  windowRef.dispatchEvent({ type: "codex-bot-selection-changing" });
  assert.deepEqual(byClass(transcript, "openbot-standalone-message"), []);
  controls.dataset.activeBotId = BOT_B;
  windowRef.dispatchEvent({ type: "codex-bot-selection-changing" });
  await tick();
  assert.deepEqual(byClass(transcript, "openbot-standalone-message").map((row) => row.children.at(-1).textContent), ["Bot B prior"]);
  controls.dataset.activeBotId = BOT_A;
  windowRef.dispatchEvent({ type: "codex-bot-selection-changing" });
  deferredA.resolve({
    botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "Late A",
    messages: [{ messageId: "message-ffffffff-ffff-4fff-8fff-ffffffffffff", role: "assistant", text: "Late A", createdAt: "2026-08-16T12:00:00.000Z" }],
  });
  await tick();
  assert.deepEqual(byClass(transcript, "openbot-standalone-message").map((row) => row.children.at(-1).textContent), ["Late A"]);

  controls.dataset.activeBotId = BOT_B;
  windowRef.dispatchEvent({ type: "codex-bot-selection-changing" });
  await tick();
  assert.deepEqual(byClass(transcript, "openbot-standalone-message").map((row) => row.children.at(-1).textContent), ["Bot B prior"]);

  controls.dataset.activeBotId = BOT_A;
  windowRef.dispatchEvent({ type: "codex-bot-selection-changing" });
  await tick();
  input.value = "A live";
  await composer.listeners.get("submit")({ preventDefault() {} });
  controls.dataset.activeBotId = BOT_B;
  windowRef.dispatchEvent({ type: "codex-bot-selection-changing" });
  input.value = "B live";
  await composer.listeners.get("submit")({ preventDefault() {} });
  assert.deepEqual(sends.map(({ botId }) => botId), [BOT_A, BOT_B]);
  assert.equal(byClass(transcript, "openbot-standalone-message")
    .some((row) => row.children.at(-1).textContent.includes("wrong early")), false);
  assert.equal(byClass(transcript, "openbot-standalone-message")
    .some((row) => row.children.at(-1).textContent.includes("right early")), true);
  eventListener({
    type: "text-delta", botId: BOT_B, conversationId: CONVERSATION_B,
    invocationId: INVOCATION_B, generation: 8, text: "wrong late",
  });
  eventListener({
    type: "completed", botId: BOT_B, conversationId: CONVERSATION_B,
    invocationId: INVOCATION_B, generation: 8,
  });
  assert.equal(stop.hidden, false);
  assert.equal(status.textContent, "OpenBot is thinking…");
  assert.equal(byClass(transcript, "openbot-standalone-message")
    .some((row) => row.children.at(-1).textContent.includes("wrong late")), false);
  eventListener({
    type: "text-delta", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION_A, generation: 7, text: "A secret",
  });
  eventListener({
    type: "completed", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION_A, generation: 7,
  });
  assert.equal(stop.hidden, false);
  assert.equal(status.textContent, "OpenBot is thinking…");
  assert.equal(byClass(transcript, "openbot-standalone-message")
    .some((row) => row.children.at(-1).textContent.includes("A secret")), false);
  await stop.listeners.get("click")({ preventDefault() {} });
  assert.deepEqual(cancels, [{ botId: BOT_B, conversationId: CONVERSATION_B, invocationId: INVOCATION_B }]);
  mounted.dispose();
});

test("the four-item 64KiB follow-up queue is visible editable removable and lossless on failure", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  let eventListener;
  const windowRef = windowFixture({
    codexBots: { async list() { return [{ botId: BOT_A }]; }, onChanged() { return () => {}; } },
    openbotConversations: {
      async list() { return [{ botId: BOT_A, conversationId: CONVERSATION }]; },
      async read() { return {
        botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
        updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "", messages: [],
      }; },
      async send(value) { return { ...value, invocationId: INVOCATION_A, generation: 7, status: "streaming" }; },
      async cancel(value) { return { ...value, generation: 7, status: "cancelled" }; },
      onChanged() { return () => {}; },
      onEvent(callback) { eventListener = callback; return () => {}; },
    },
  });
  const mounted = createHostController({ windowRef, documentRef });
  await mounted.start();
  await tick();
  const shell = documentRef.body.children[0];
  const composer = byClass(shell, "openbot-standalone-composer")[0];
  const input = byClass(shell, "openbot-standalone-input")[0];
  input.value = "running";
  await composer.listeners.get("submit")({ preventDefault() {} });
  for (const value of ["one", "two", "three", "four"]) {
    input.value = value;
    await composer.listeners.get("submit")({ preventDefault() {} });
  }
  input.value = "five";
  await composer.listeners.get("submit")({ preventDefault() {} });
  assert.equal(input.value, "five");
  let rows = byClass(shell, "openbot-standalone-queue-item");
  assert.equal(rows.length, 4);
  const editor = rows[0].children[0];
  editor.value = "one edited";
  editor.listeners.get("input")({});
  rows[1].children[1].listeners.get("click")({ preventDefault() {} });
  rows = byClass(shell, "openbot-standalone-queue-item");
  assert.deepEqual(rows.map((row) => row.children[0].value), ["one edited", "three", "four"]);
  eventListener({
    type: "failed", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION_A, generation: 7, code: "OPENBOT_CONVERSATION_OPERATION_FAILED",
  });
  rows = byClass(shell, "openbot-standalone-queue-item");
  assert.deepEqual(rows.map((row) => row.children[0].value), ["one edited", "three", "four"]);
  mounted.dispose();
});

test("renderer ignores wrong-generation early live and terminal events", async () => {
  const { createHostController } = require(shellPath);
  const documentRef = documentFixture();
  let eventListener;
  const windowRef = windowFixture({
    codexBots: { async list() { return [{ botId: BOT_A }]; }, onChanged() { return () => {}; } },
    openbotConversations: {
      async list() { return [{ botId: BOT_A, conversationId: CONVERSATION }]; },
      async read() { return {
        botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
        updatedAt: "2026-08-16T12:00:00.000Z", status: "idle", preview: "", messages: [],
      }; },
      async send(value) {
        eventListener({ type: "text-delta", botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION_A, generation: 8, text: "wrong early" });
        eventListener({ type: "text-delta", botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION_A, generation: 7, text: "right early" });
        return { ...value, invocationId: INVOCATION_A, generation: 7, status: "streaming" };
      },
      async cancel(value) { return { ...value, generation: 7, status: "cancelled" }; },
      onChanged() { return () => {}; },
      onEvent(callback) { eventListener = callback; return () => {}; },
    },
  });
  const mounted = createHostController({ windowRef, documentRef });
  await mounted.start();
  await tick();
  const shell = documentRef.body.children[0];
  const input = byClass(shell, "openbot-standalone-input")[0];
  const composer = byClass(shell, "openbot-standalone-composer")[0];
  const stop = byClass(shell, "openbot-standalone-stop")[0];
  input.value = "start";
  await composer.listeners.get("submit")({ preventDefault() {} });
  const transcript = byClass(shell, "openbot-standalone-transcript")[0];
  assert.deepEqual(byClass(transcript, "openbot-standalone-message").map((row) => row.children.at(-1).textContent), ["start", "right early"]);
  eventListener({ type: "text-delta", botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION_A, generation: 8, text: "wrong late" });
  eventListener({ type: "completed", botId: BOT_A, conversationId: CONVERSATION, invocationId: INVOCATION_A, generation: 8 });
  assert.equal(stop.hidden, false);
  assert.equal(byClass(transcript, "openbot-standalone-message").some((row) => row.children.at(-1).textContent.includes("wrong late")), false);
  mounted.dispose();
});

test("a passive selected window refreshes completed durable text without disturbing the initiating stream", async () => {
  const { createHostController } = require(shellPath);
  const documents = [documentFixture(), documentFixture()];
  const reads = [0, 0];
  const changed = [null, null];
  const events = [null, null];
  let durableMessages = [];
  function conversationApi(index) {
    return {
      async list() { return [{ botId: BOT_A, conversationId: CONVERSATION }]; },
      async read() {
        reads[index] += 1;
        return {
          botId: BOT_A, conversationId: CONVERSATION,
          createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:01:00.000Z",
          status: "idle", preview: durableMessages.at(-1)?.text ?? "", messages: structuredClone(durableMessages),
        };
      },
      async send(value) {
        return { ...value, invocationId: INVOCATION_A, generation: 7, status: "streaming" };
      },
      async cancel(value) { return { ...value, generation: 7, status: "cancelled" }; },
      onChanged(callback) { changed[index] = callback; return () => { changed[index] = null; }; },
      onEvent(callback) { events[index] = callback; return () => { events[index] = null; }; },
    };
  }
  const windows = [0, 1].map((index) => windowFixture({
    codexBots: { async list() { return [{ botId: BOT_A }]; }, onChanged() { return () => {}; } },
    openbotConversations: conversationApi(index),
  }));
  const mounted = documents.map((documentRef, index) => createHostController({ documentRef, windowRef: windows[index] }));
  await Promise.all(mounted.map((entry) => entry.start()));
  await tick();
  assert.deepEqual(reads, [1, 1]);
  const shell1 = documents[0].body.children[0];
  const input1 = byClass(shell1, "openbot-standalone-input")[0];
  const composer1 = byClass(shell1, "openbot-standalone-composer")[0];
  input1.value = "Do it";
  await composer1.listeners.get("submit")({ preventDefault() {} });
  durableMessages = [
    { messageId: "message-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", role: "user", text: "Do it", createdAt: "2026-08-16T12:00:00.000Z" },
    { messageId: "message-ffffffff-ffff-4fff-8fff-ffffffffffff", role: "assistant", text: "Done", createdAt: "2026-08-16T12:01:00.000Z" },
  ];
  const summary = {
    botId: BOT_A, conversationId: CONVERSATION, createdAt: "2026-08-16T12:00:00.000Z",
    updatedAt: "2026-08-16T12:01:00.000Z", status: "idle", preview: "Done", messageCount: 2,
  };
  changed[0](summary);
  changed[1](summary);
  await tick();
  assert.deepEqual(reads, [1, 2]);
  const transcript2 = byClass(documents[1].body.children[0], "openbot-standalone-transcript")[0];
  assert.deepEqual(byClass(transcript2, "openbot-standalone-message").map((row) => row.children.at(-1).textContent), ["Do it", "Done"]);
  changed[1]({ ...summary, botId: BOT_B, preview: "private B" });
  await tick();
  assert.deepEqual(reads, [1, 2]);
  assert.equal(byClass(transcript2, "openbot-standalone-message")
    .some((row) => row.children.at(-1).textContent.includes("private B")), false);
  events[0]({
    type: "completed", botId: BOT_A, conversationId: CONVERSATION,
    invocationId: INVOCATION_A, generation: 7,
  });
  mounted.forEach((entry) => entry.dispose());
});
