"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const ui = fs.readFileSync(
  path.join(root, "src", "renderer", "codex-ui.js"),
  "utf8",
);
const liveSeat = fs.readFileSync(
  path.join(root, "src", "renderer", "live-seat-component.jsfrag"),
  "utf8",
);
const { verifyLiveSeatAliasIsolationSource } = require(
  path.join(root, "scripts", "patch-app.cjs"),
);

function transformedLiveSeatSource() {
  return liveSeat
    .replaceAll("__CODEX_VIEW_PORT__", "18318")
    .replace(/\bT\./g, "S.")
    .replace(/\bh\./g, "p.");
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const validatorSource = sourceBetween(
  ui,
  "function validateOfficialLoginUrl",
  "function openOfficialLoginLink",
);
const openerSource = sourceBetween(
  ui,
  "function openOfficialLoginLink",
  "function setOfficialComputerNotice",
);
const validateOfficialLoginUrl = Function(
  `"use strict"; ${validatorSource}; return validateOfficialLoginUrl;`,
)();
const officialComputerHtml = Function(
  `"use strict";
   let officialComputerOperationInFlight = false;
   let officialComputerNotice = { message: "", tone: "info" };
   ${sourceBetween(ui, "function escapeHtml", "function initials")}
   ${sourceBetween(ui, "function officialComputerState", "function defaultInferenceHtml")}
   return officialComputerHtml;`,
)();
const liveSeatState = Function(
  `"use strict";
   ${sourceBetween(liveSeat, "function GBSeatProvider", "function GBLiveSeat")}
  return {
    GBSeatProvider,
    GBUnavailableSeatState,
    GBSeatFrameStyle,
    GBSeatEventIsInsideFrame,
  };`,
)();

function virtualDescendants(node) {
  if (node == null || typeof node !== "object") return [];
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : [node.props?.children];
  return [node, ...children.flatMap(virtualDescendants)];
}

function createLiveSeatHarness({
  statusProvider = "private",
  frameProvider = statusProvider,
  frameError = null,
  inputError = null,
  heartbeatError = null,
  approvalPending = null,
} = {}) {
  const stateSlots = [];
  const refSlots = [];
  const requests = [];
  const intervals = [];
  const documentListeners = new Map();
  const focusOrigin = {
    isConnected: true,
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
  };
  const documentMock = {
    activeElement: focusOrigin,
    body: { style: { overflow: "auto" } },
    addEventListener(type, listener, capture) {
      documentListeners.set(`${type}:${Boolean(capture)}`, listener);
    },
    removeEventListener(type, listener, capture) {
      const key = `${type}:${Boolean(capture)}`;
      if (documentListeners.get(key) === listener)
        documentListeners.delete(key);
    },
  };
  let stateIndex = 0;
  let refIndex = 0;
  let effects = [];
  const T = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in stateSlots)) stateSlots[index] = initial;
      return [
        stateSlots[index],
        (next) => {
          stateSlots[index] =
            typeof next === "function" ? next(stateSlots[index]) : next;
        },
      ];
    },
    useRef(initial) {
      const index = refIndex++;
      if (!(index in refSlots)) refSlots[index] = { current: initial };
      return refSlots[index];
    },
    useCallback(callback) {
      return callback;
    },
    useEffect(callback) {
      effects.push(callback);
    },
  };
  const makeNode = (type, props, key) => {
    const node = {
      type,
      props,
      key,
      isConnected: true,
      open: false,
      showModalCount: 0,
      closeCount: 0,
      focusCount: 0,
      showModal() {
        this.open = true;
        this.showModalCount += 1;
      },
      close() {
        this.open = false;
        this.closeCount += 1;
      },
      setAttribute(name) {
        if (name === "open") this.open = true;
      },
      removeAttribute(name) {
        if (name === "open") this.open = false;
      },
      focus() {
        this.focusCount += 1;
      },
      contains(target) {
        return target === this;
      },
      getBoundingClientRect() {
        return {
          left: 0,
          top: 0,
          right: 1280,
          bottom: 800,
          width: 1280,
          height: 800,
        };
      },
    };
    if (props?.ref) props.ref.current = node;
    return node;
  };
  const h = {
    jsx: makeNode,
    jsxs: makeNode,
  };
  const request = async (requestPath, body) => {
    requests.push({ requestPath, body });
    if (requestPath.startsWith("/api/codex/status?")) {
      return { officialComputer: { mode: statusProvider } };
    }
    if (requestPath.startsWith("/api/frame?")) {
      if (frameError) throw frameError;
      return {
        screenshotBase64: "frame",
        provider: frameProvider,
        pageState: "loaded",
        url:
          frameProvider === "official"
            ? "official-computer://shared-primary"
            : "https://example.test",
      };
    }
    if (requestPath.startsWith("/api/approval?") && body == null) {
      return { pending: approvalPending };
    }
    if (requestPath === "/api/control") {
      if (body?.action === "heartbeat" && heartbeatError) throw heartbeatError;
      return { ok: true };
    }
    if (requestPath === "/api/input") {
      if (inputError) throw inputError;
      return { pageState: "loaded", url: "https://example.test" };
    }
    throw new Error(`Unexpected request: ${requestPath}`);
  };
  const GBLiveSeat = Function(
    "T",
    "h",
    "globalThis",
    "document",
    "setInterval",
    "clearInterval",
    "setTimeout",
    `${liveSeat}; return GBLiveSeat;`,
  )(
    T,
    h,
    {
      crypto: { randomUUID: () => "control-id" },
      __CODEX_BOT_VIEW_REQUEST__: request,
    },
    documentMock,
    (callback, delay) => {
      intervals.push({ callback, delay });
      return intervals.length;
    },
    () => {},
    (callback) => {
      callback();
      return 1;
    },
  );
  return {
    stateSlots,
    requests,
    intervals,
    documentListeners,
    documentMock,
    focusOrigin,
    effects: () => effects,
    render() {
      stateIndex = 0;
      refIndex = 0;
      effects = [];
      return GBLiveSeat({ agentId: "employee-a", subjectLabel: "Alex" });
    },
  };
}
const enableContinuationSource = `${sourceBetween(
  ui,
  "function clearOfficialEnableIntent",
  "function startOfficialConnectionPolling",
)}\n${sourceBetween(
  ui,
  "function officialComputerState",
  "function officialComputerHtml",
)}`;
const officialInteractionSource = sourceBetween(
  ui,
  "function requireOfficialComputerAcknowledgement",
  "function wireConnectionPanel",
);
const replaceVisibleBranding = Function(
  "document",
  "NodeFilter",
  `"use strict";
   ${sourceBetween(ui, "function replaceVisibleBranding", "function hideUnavailableSurfaces")}
   return replaceVisibleBranding;`,
)(
  {
    body: {},
    title: "",
    createTreeWalker(root) {
      let index = -1;
      return {
        nextNode() {
          index += 1;
          this.currentNode = root.nodes[index];
          return Boolean(this.currentNode);
        },
        currentNode: null,
      };
    },
  },
  { SHOW_TEXT: 4 },
);

function createEnableContinuationHarness(requestImpl) {
  const notices = [];
  let applyCount = 0;
  const harness = Function(
    "request",
    "notices",
    "onApply",
    `"use strict";
     let officialEnableAfterCursorLogin = false;
     let officialEnableContinuationInFlight = false;
     let officialComputerOperationInFlight = false;
     function setOfficialComputerNotice(message, tone = "info") {
       notices.push({ message, tone });
     }
     function applyUi() { onApply(); }
     ${enableContinuationSource}
     return {
       requestIntent() { officialEnableAfterCursorLogin = true; },
       clearOfficialEnableIntent,
       completeOfficialEnableAfterCursorLogin,
       flags() {
         return {
           requested: officialEnableAfterCursorLogin,
           continuing: officialEnableContinuationInFlight,
           busy: officialComputerOperationInFlight,
         };
       },
     };`,
  )(requestImpl, notices, () => {
    applyCount += 1;
  });
  return { ...harness, notices, applyCount: () => applyCount };
}

function createOfficialInteractionHarness({ requestImpl, openImpl } = {}) {
  const notices = [];
  let officialEnableAfterCursorLogin = false;
  let status = {
    officialComputer: {
      mode: "private",
      connected: false,
      state: "disconnected",
    },
  };
  const harness = Function(
    "request",
    "openOfficialLoginLink",
    "notices",
    "getStatus",
    "setIntent",
    `"use strict";
     let officialEnableAfterCursorLogin = false;
     let officialConnectionPollTimer = 1;
     let pollCount = 0;
     let refreshErrorCount = 0;
     let finishCount = 0;
     function clearOfficialEnableIntent() {
       officialEnableAfterCursorLogin = false;
       setIntent(false);
     }
     function beginOfficialComputerOperation() { return true; }
     function finishOfficialComputerOperation() { finishCount += 1; }
     function setOfficialComputerNotice(message, tone = "info") {
       notices.push({ message, tone });
     }
     function startOfficialConnectionPolling() { pollCount += 1; }
     async function loadStatus() {}
     async function refreshAfterOfficialComputerError(error) {
       clearOfficialEnableIntent();
       refreshErrorCount += 1;
       notices.push({ message: error.message, tone: "error" });
     }
     function officialComputerState(value) {
       return value?.officialComputer || {};
     }
     let lastStatus = getStatus();
     ${officialInteractionSource}
     return {
       async start(panel) {
         const result = await startCursorSignInAndEnable(panel);
         setIntent(officialEnableAfterCursorLogin);
         return result;
       },
       async cancel(panel) {
         const result = await cancelCursorSignIn(panel);
         setIntent(officialEnableAfterCursorLogin);
         return result;
       },
       async selectPrivate(panel) {
         lastStatus = getStatus();
         const result = await selectPrivateComputer(panel);
         setIntent(officialEnableAfterCursorLogin);
         return result;
       },
       forceIntent() {
         officialEnableAfterCursorLogin = true;
         setIntent(true);
       },
       metrics() { return { pollCount, refreshErrorCount, finishCount }; },
     };`,
  )(
    requestImpl || (async () => ({})),
    openImpl || (() => {}),
    notices,
    () => status,
    (value) => {
      officialEnableAfterCursorLogin = value;
    },
  );
  return {
    ...harness,
    notices,
    get intent() {
      return officialEnableAfterCursorLogin;
    },
    setStatus(value) {
      status = value;
    },
  };
}

function acknowledgementPanel(checked = true) {
  const acknowledgement = {
    checked,
    focused: false,
    attributes: new Map(),
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    focus() {
      this.focused = true;
    },
  };
  return {
    acknowledgement,
    querySelector(selector) {
      return selector === "[data-codex-official-ack]" ? acknowledgement : null;
    },
  };
}

function officialLoginUrl(mutator) {
  const value = new URL("https://cursor.com/loginDeepControl");
  value.searchParams.set("challenge", "A".repeat(43));
  value.searchParams.set("uuid", "123e4567-e89b-42d3-a456-426614174000");
  value.searchParams.set("mode", "login");
  value.searchParams.set("redirectTarget", "sand");
  mutator?.(value);
  return value.href;
}

test("the stock-branding sweep preserves Cursor wording in Codex-owned UI", () => {
  const stockNode = {
    nodeValue: "Sign in to Cursor with your Cursor account",
    parentElement: { closest: () => null },
  };
  const ownedNode = {
    nodeValue: "Sign in to Cursor with your Cursor account",
    parentElement: {
      closest(selector) {
        return selector.includes("[data-codex-local]") ? {} : null;
      },
    },
  };

  replaceVisibleBranding({ nodes: [stockNode, ownedNode] });

  assert.equal(stockNode.nodeValue, "Connect an AI provider");
  assert.equal(
    ownedNode.nodeValue,
    "Sign in to Cursor with your Cursor account",
  );
});

test("official vendor login links are accepted only at the exact trusted route", () => {
  const safe = officialLoginUrl();
  assert.equal(validateOfficialLoginUrl(safe), safe);

  const invalid = [
    safe.replace("https://", "http://"),
    safe.replace("cursor.com", "cursor.com.evil.example"),
    safe.replace("cursor.com", "cursor.com:443"),
    safe.replace("cursor.com", "cursor.com:444"),
    safe.replace("cursor.com", "CURSOR.COM"),
    safe.replace("/loginDeepControl", "/loginDeepControl/extra"),
    safe.replace("challenge=", "%63hallenge="),
    `${safe}&`,
    `${safe}#continue`,
    ` ${safe}`,
    officialLoginUrl((value) => value.searchParams.delete("challenge")),
    officialLoginUrl((value) =>
      value.searchParams.append("challenge", "B".repeat(43)),
    ),
    officialLoginUrl((value) => value.searchParams.set("extra", "1")),
    officialLoginUrl((value) =>
      value.searchParams.set("challenge", "too-short"),
    ),
    officialLoginUrl((value) =>
      value.searchParams.set("uuid", "123e4567-e89b-12d3-a456-426614174000"),
    ),
    officialLoginUrl((value) => value.searchParams.set("mode", "signup")),
    officialLoginUrl((value) =>
      value.searchParams.set("redirectTarget", "desktop"),
    ),
  ];
  for (const value of invalid)
    assert.throws(() => validateOfficialLoginUrl(value), /unsafe link/, value);
});

test("official sign-in validates the bridge-opened Cursor URL without a popup", () => {
  const openOfficialLoginLink = Function(
    `"use strict"; ${validatorSource}; ${openerSource}; return openOfficialLoginLink;`,
  )();
  const safe = officialLoginUrl();
  assert.equal(openOfficialLoginLink(safe), safe);
  assert.throws(
    () => openOfficialLoginLink(safe.replace("cursor.com", "evil.example")),
    /unsafe link/,
  );
  assert.doesNotMatch(openerSource, /createElement|\.click\s*\(/);
  assert.doesNotMatch(ui, /window\.open\s*\(/);
});

test("fresh consent starts one Cursor login and cancel or Private clears the in-memory enable intent", async () => {
  const loginUrl = officialLoginUrl();
  const calls = [];
  const opened = [];
  const harness = createOfficialInteractionHarness({
    requestImpl: async (requestPath, body) => {
      calls.push({ requestPath, body });
      if (body?.action === "login")
        return { result: { loginUrl, state: "signing-in" } };
      return { status: { mode: "private", connected: false } };
    },
    openImpl: (value) => opened.push(value),
  });
  const panel = acknowledgementPanel(true);
  const unchecked = acknowledgementPanel(false);

  assert.equal(await harness.start(unchecked), false);
  assert.equal(unchecked.acknowledgement.focused, true);
  assert.equal(
    unchecked.acknowledgement.attributes.get("aria-invalid"),
    "true",
  );
  assert.equal(calls.length, 0);
  assert.equal(harness.intent, false);

  assert.equal(await harness.start(panel), true);
  assert.deepEqual(calls, [
    {
      requestPath: "/api/official-computer",
      body: { action: "login" },
    },
  ]);
  assert.deepEqual(opened, [loginUrl]);
  assert.equal(harness.intent, true);
  assert.equal(harness.metrics().pollCount, 1);

  assert.equal(await harness.cancel(panel), true);
  assert.deepEqual(calls[1], {
    requestPath: "/api/official-computer",
    body: { action: "cancel-login" },
  });
  assert.equal(harness.intent, false);

  harness.forceIntent();
  harness.setStatus({
    officialComputer: {
      mode: "private",
      connected: false,
      state: "disconnected",
    },
  });
  assert.equal(await harness.selectPrivate(panel), false);
  assert.equal(harness.intent, false);
  assert.equal(calls.length, 2);
});

test("Cursor login errors and rejected login links cannot leave an enable intent behind", async () => {
  const panel = acknowledgementPanel(true);
  const networkFailure = createOfficialInteractionHarness({
    requestImpl: async () => {
      throw new Error("login unavailable");
    },
  });
  assert.equal(await networkFailure.start(panel), false);
  assert.equal(networkFailure.intent, false);
  assert.equal(networkFailure.metrics().refreshErrorCount, 1);

  const calls = [];
  const unsafeLink = createOfficialInteractionHarness({
    requestImpl: async (requestPath, body) => {
      calls.push({ requestPath, body });
      return {
        result: { loginUrl: "https://evil.example/login" },
      };
    },
    openImpl: () => {
      throw new Error("Official sign-in returned an unsafe link.");
    },
  });
  assert.equal(await unsafeLink.start(acknowledgementPanel(true)), false);
  assert.deepEqual(
    calls.map((entry) => entry.body.action),
    ["login", "cancel-login"],
  );
  assert.equal(unsafeLink.intent, false);
});

test("a completed Cursor login consumes consent and enables official mode exactly once", async () => {
  let enableCalls = 0;
  let resolveEnable;
  const pendingEnable = new Promise((resolve) => {
    resolveEnable = resolve;
  });
  const harness = createEnableContinuationHarness(async (requestPath, body) => {
    enableCalls += 1;
    assert.equal(requestPath, "/api/official-computer");
    assert.deepEqual(body, {
      action: "mode",
      mode: "official",
      acknowledged: true,
    });
    return pendingEnable;
  });
  const signingIn = {
    officialComputer: {
      mode: "private",
      connected: false,
      state: "signing-in",
    },
  };
  const connected = {
    officialComputer: {
      mode: "private",
      connected: true,
      state: "signed-in",
    },
  };

  harness.requestIntent();
  assert.equal(
    await harness.completeOfficialEnableAfterCursorLogin(signingIn),
    signingIn,
  );
  assert.equal(enableCalls, 0);
  assert.equal(harness.flags().requested, true);

  const first = harness.completeOfficialEnableAfterCursorLogin(connected);
  const overlapping =
    await harness.completeOfficialEnableAfterCursorLogin(connected);
  assert.equal(overlapping, connected);
  assert.equal(enableCalls, 1);
  assert.deepEqual(harness.flags(), {
    requested: false,
    continuing: true,
    busy: true,
  });

  resolveEnable({
    status: {
      mode: "official",
      connected: true,
      ready: true,
      state: "ready",
    },
  });
  const enabled = await first;
  assert.equal(enabled.officialComputer.mode, "official");
  assert.equal(enabled.officialComputer.ready, true);
  assert.equal(enableCalls, 1);
  assert.deepEqual(harness.flags(), {
    requested: false,
    continuing: false,
    busy: false,
  });
  await harness.completeOfficialEnableAfterCursorLogin(connected);
  assert.equal(enableCalls, 1);
  assert.equal(harness.applyCount(), 1);
});

test("an automatic enable error consumes the intent and never retries by itself", async () => {
  let enableCalls = 0;
  let statusReads = 0;
  const harness = createEnableContinuationHarness(
    async (_requestPath, body) => {
      if (body?.action === "mode") {
        enableCalls += 1;
        throw new Error("plan capacity unavailable");
      }
      statusReads += 1;
      return connected;
    },
  );
  const connected = {
    officialComputer: {
      mode: "private",
      connected: true,
      state: "signed-in",
    },
  };
  harness.requestIntent();
  assert.equal(
    await harness.completeOfficialEnableAfterCursorLogin(connected),
    connected,
  );
  assert.equal(enableCalls, 1);
  assert.equal(statusReads, 1);
  assert.equal(harness.flags().requested, false);
  await harness.completeOfficialEnableAfterCursorLogin(connected);
  assert.equal(enableCalls, 1);
  assert.match(harness.notices.at(-1).message, /plan capacity unavailable/);
  assert.equal(harness.notices.at(-1).tone, "error");
});

test("official computer settings require explicit consent and expose recovery states", () => {
  assert.match(ui, /action: "login"/);
  assert.match(ui, /action: "cancel-login"/);
  assert.match(ui, /action: "mode",\s*mode: "official",\s*acknowledged: true/s);
  assert.match(ui, /action: "mode",\s*mode: "private"/s);
  assert.match(ui, /action: "disconnect"/);
  assert.match(ui, /Read the vendor warning and check the acknowledgement/);
  assert.match(
    ui,
    /does not delete the vendor cloud computer or verify deletion of remote data/,
  );
  assert.match(ui, /Remote cloud-computer deletion was not verified/);
  assert.match(ui, /startOfficialConnectionPolling/);
  assert.match(ui, /setInterval\(loadStatus, 2_000\)/);
  assert.match(ui, /syncOfficialConnectionPolling\(lastStatus\)/);
  assert.match(ui, /aria-describedby="codex-official-warning"/);
  assert.match(ui, /This is not a free or Codex-only computer/);
  assert.match(
    ui,
    /zero vendor-model activity, zero telemetry, and zero charges cannot be guaranteed/,
  );
  assert.match(
    ui,
    /Vendor cloud &middot; Experimental &middot; billing possible/,
  );
  assert.match(
    ui,
    /Sign in at <strong>cursor\.com<\/strong> with the Cursor account that has cloud-computer access/,
  );
  assert.match(
    ui,
    /No separate Grok Bot installation or saved Grok Bot sign-in is required/,
  );
  assert.match(ui, /role="status" aria-live="polite"/);
});

test("official computer card renders safe mode-specific controls", () => {
  const disconnected = officialComputerHtml({
    officialComputer: {
      mode: "private",
      connected: false,
      state: "disconnected",
    },
  });
  assert.match(disconnected, /Private browser/);
  assert.match(disconnected, /data-codex-official-login/);
  assert.match(disconnected, /data-codex-official-ack/);
  assert.match(disconnected, /Sign in to Cursor and enable vendor computer/);
  assert.match(disconnected, /cursor\.com/);
  assert.match(disconnected, /No separate Grok Bot installation/);
  assert.match(disconnected, /This is not a free or Codex-only computer/);
  assert.doesNotMatch(disconnected, /Connect official account/);
  assert.doesNotMatch(disconnected, /data-codex-computer-official/);

  const signingIn = officialComputerHtml({
    officialComputer: {
      mode: "private",
      connected: false,
      state: "signing-in",
    },
  });
  assert.match(signingIn, /Waiting for Cursor sign-in/);
  assert.match(signingIn, /data-codex-official-cancel/);
  assert.doesNotMatch(signingIn, /data-codex-official-ack/);

  const connectedPrivate = officialComputerHtml({
    officialComputer: {
      mode: "private",
      connected: true,
      state: "signed-in",
    },
  });
  assert.match(connectedPrivate, /data-codex-official-ack/);
  assert.match(connectedPrivate, /data-codex-computer-official/);
  assert.match(
    connectedPrivate,
    /vendor credits, telemetry, and background services/,
  );

  const active = officialComputerHtml({
    officialComputer: {
      mode: "official",
      connected: true,
      ready: true,
      state: "ready",
    },
  });
  assert.match(
    active,
    /Vendor cloud &middot; Experimental &middot; billing possible/,
  );
  assert.match(active, /data-codex-official-disconnect/);
  assert.doesNotMatch(active, /data-codex-computer-official/);
  assert.equal(active.match(/data-codex-computer-private/g)?.length, 1);

  const recovering = officialComputerHtml({
    officialComputer: {
      mode: "official",
      connected: true,
      ready: false,
      state: "unavailable",
      retrying: true,
      retryStage: "viewer",
      lastError: "The display connection closed.",
    },
  });
  assert.match(recovering, /Recovering automatically/);
  assert.match(recovering, /Automatic retries are throttled/);
  assert.match(recovering, /recovering the viewer/);
  assert.match(recovering, /The display connection closed/);

  const unavailable = officialComputerHtml({
    officialComputer: {
      mode: "unknown",
      connected: false,
      state: "helper-unavailable",
      lastError: "The isolated provider helper is unavailable.",
    },
  });
  assert.match(unavailable, /Provider unavailable &middot; mode unknown/);
  assert.match(unavailable, /Official provider unavailable/);
  assert.match(unavailable, /The isolated provider helper is unavailable/);
  assert.doesNotMatch(unavailable, /Auto &middot; Private/);
  assert.doesNotMatch(unavailable, /data-codex-official-login/);
  assert.doesNotMatch(unavailable, /codex-computer-option is-selected/);
});

test("live seats distinguish the shared vendor display without weakening takeover", () => {
  assert.match(liveSeat, /r\?\.provider === "official"/);
  assert.match(liveSeat, /shared official vendor cloud computer/);
  assert.match(
    liveSeat,
    /Vendor cloud \\u00b7 Experimental \\u00b7 billing possible/,
  );
  assert.match(liveSeat, /billing possible/);
  assert.match(liveSeat, /whiteSpace: "normal"/);
  assert.doesNotMatch(liveSeat, /textOverflow: "ellipsis"/);
  assert.match(
    liveSeat,
    /i\(\(v\) => \(\{\s*\.\.\.v,\s*pageState: "unavailable"/s,
  );
  assert.match(liveSeat, /W = r\?\.provider === "private"/);
  assert.match(liveSeat, /o && W\s*\? h\.jsx\("input"/s);
  assert.match(liveSeat, /aria-label": "Browser address"/);
  assert.match(liveSeat, /children: o \? "Release control" : "Take control"/);
  assert.match(liveSeat, /action: "acquire"/);
  assert.match(liveSeat, /action: "heartbeat"/);
  assert.match(liveSeat, /action: "release"/);
  assert.match(liveSeat, /this employee's private browser/);
});

test("all computer approvals render in chat instead of competing with the live-view surface", async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const pending = {
    requestId: "request-1",
    seatId: "employee-a",
    origin: "https://example.test",
    actionDigest: "a".repeat(64),
    presentation: { actions: [{ kind: "click" }] },
  };

  const official = createLiveSeatHarness({
    statusProvider: "official",
    frameProvider: "official",
    approvalPending: pending,
  });
  official.render();
  official.effects()[0]();
  await flush();
  let officialTree = official.render();
  official.effects()[1]();
  await flush();
  officialTree = official.render();
  assert.equal(
    official.requests.some(({ requestPath }) =>
      requestPath.startsWith("/api/approval?"),
    ),
    false,
  );
  assert.equal(
    virtualDescendants(officialTree).some(
      (node) => node.props?.["aria-label"] === "Browser action approval",
    ),
    false,
  );

  const privateSeat = createLiveSeatHarness({
    statusProvider: "private",
    frameProvider: "private",
    approvalPending: pending,
  });
  privateSeat.render();
  privateSeat.effects()[0]();
  await flush();
  privateSeat.render();
  privateSeat.effects()[1]();
  await flush();
  const privateTree = privateSeat.render();
  assert.equal(
    privateSeat.requests.some(({ requestPath }) =>
      requestPath.startsWith("/api/approval?"),
    ),
    false,
  );
  assert.equal(
    virtualDescendants(privateTree).some(
      (node) => node.props?.["aria-label"] === "Browser action approval",
    ),
    false,
  );
});

test("live-seat errors merge into provider state without erasing private mode", () => {
  assert.equal(
    liveSeatState.GBSeatProvider({ officialComputer: { mode: "private" } }),
    "private",
  );
  assert.equal(
    liveSeatState.GBSeatProvider({ officialComputer: { mode: "official" } }),
    "official",
  );
  assert.equal(
    liveSeatState.GBSeatProvider({ officialComputer: { mode: "unknown" } }),
    null,
  );
  const previous = {
    provider: "private",
    url: "https://example.com/kept",
    title: "Kept frame",
    pageState: "loaded",
  };
  assert.deepEqual(
    liveSeatState.GBUnavailableSeatState(
      previous,
      null,
      new Error("Temporary frame failure"),
    ),
    {
      ...previous,
      pageState: "unavailable",
      error: "Temporary frame failure",
    },
  );
  assert.deepEqual(
    liveSeatState.GBUnavailableSeatState(
      previous,
      "official",
      new Error("Official frame failure"),
    ),
    {
      ...previous,
      provider: "official",
      pageState: "unavailable",
      error: "Official frame failure",
    },
  );
});

test("Take control expands private and official computers, then Release control restores the preview", async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  for (const provider of ["private", "official"]) {
    const harness = createLiveSeatHarness({
      statusProvider: provider,
      frameProvider: provider,
    });
    let tree = harness.render();
    harness.stateSlots[1] = { provider, pageState: "loaded" };
    const takeControl = virtualDescendants(tree).find(
      (node) =>
        node.type === "button" && node.props?.children === "Take control",
    );
    takeControl.props.onClick({ stopPropagation() {} });
    await flush();

    tree = harness.render();
    let nodes = virtualDescendants(tree);
    assert.equal(harness.stateSlots[2], true);
    assert.equal(tree.type, "dialog");
    assert.equal(tree.props.role, "dialog");
    assert.equal(tree.props["aria-modal"], true);
    assert.equal(tree.props["aria-keyshortcuts"], "Escape");
    assert.equal(tree.props.style.position, "fixed");
    assert.equal(tree.props.style.inset, 0);
    assert.equal(tree.props.style.zIndex, 2147483000);
    assert.match(tree.props["aria-label"], /Press Escape to release control/);
    assert.ok(
      nodes.some((node) =>
        String(node.props?.style?.width).includes("calc(100vw - 24px)"),
      ),
    );
    assert.equal(
      nodes.some((node) => node.props?.["aria-label"] === "Browser address"),
      provider === "private",
    );
    const releaseControl = nodes.find(
      (node) =>
        node.type === "button" && node.props?.children === "Release control",
    );
    assert.equal(releaseControl.props.style.minHeight, 44);
    releaseControl.props.onClick({ stopPropagation() {} });
    await flush();

    tree = harness.render();
    nodes = virtualDescendants(tree);
    assert.equal(harness.stateSlots[2], false);
    assert.equal(tree.props.role, "application");
    assert.equal(tree.props["aria-modal"], undefined);
    assert.equal(tree.props.style.position, "absolute");
    assert.ok(
      nodes.some(
        (node) =>
          node.type === "button" && node.props?.children === "Take control",
      ),
    );
    assert.deepEqual(
      harness.requests
        .filter(({ requestPath }) => requestPath === "/api/control")
        .map(({ body }) => body.action),
      ["acquire", "release"],
    );
  }
});

test("Escape closes the modal, unlocks the page, and restores takeover-button focus", async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const harness = createLiveSeatHarness();
  let tree = harness.render();
  const takeControl = virtualDescendants(tree).find(
    (node) => node.type === "button" && node.props?.children === "Take control",
  );
  takeControl.props.onClick({ stopPropagation() {} });
  await flush();

  tree = harness.render();
  const releaseControl = virtualDescendants(tree).find(
    (node) =>
      node.type === "button" && node.props?.children === "Release control",
  );
  const closeModalEffect = harness.effects()[2];
  const cleanupModal = closeModalEffect();
  assert.equal(harness.documentMock.body.style.overflow, "hidden");
  assert.equal(harness.documentListeners.has("keydown:true"), true);
  assert.equal(tree.showModalCount, 1);
  assert.equal(tree.open, true);
  assert.equal(tree.focusCount, 1);

  const keyboardEvent = {
    key: "Escape",
    target: { closest: () => null },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
  tree.props.onKeyDown(keyboardEvent);
  await flush();
  cleanupModal();
  assert.equal(keyboardEvent.defaultPrevented, true);
  assert.equal(keyboardEvent.propagationStopped, true);
  assert.equal(harness.stateSlots[2], false);
  assert.equal(harness.documentMock.body.style.overflow, "auto");
  assert.equal(harness.documentListeners.size, 0);
  assert.equal(tree.closeCount, 1);
  assert.equal(tree.open, false);
  assert.equal(releaseControl.focusCount, 1);
  assert.equal(harness.render().props.style.position, "absolute");
});

test("provider switches and control failures always collapse the expanded seat", async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  for (const [statusProvider, frameProvider] of [
    ["private", "official"],
    ["official", "private"],
  ]) {
    const harness = createLiveSeatHarness({ statusProvider, frameProvider });
    harness.stateSlots[2] = true;
    harness.render();
    harness.effects()[0]();
    await flush();
    await flush();
    assert.equal(harness.stateSlots[2], false);
    assert.ok(
      harness.requests.some(
        ({ requestPath, body }) =>
          requestPath === "/api/control" && body.action === "release",
      ),
    );
  }

  const failedFrame = createLiveSeatHarness({
    statusProvider: "official",
    frameError: new Error("Viewer disconnected"),
  });
  failedFrame.stateSlots[2] = true;
  failedFrame.render();
  failedFrame.effects()[0]();
  await flush();
  await flush();
  assert.equal(failedFrame.stateSlots[2], false);
  assert.equal(failedFrame.stateSlots[1].pageState, "unavailable");
  assert.match(failedFrame.stateSlots[1].error, /Viewer disconnected/);

  const failedInput = createLiveSeatHarness({
    inputError: new Error("Remote input rejected"),
  });
  failedInput.stateSlots[1] = { provider: "private", pageState: "loaded" };
  failedInput.stateSlots[2] = true;
  const controlledTree = failedInput.render();
  controlledTree.props.onKeyDown({
    key: "a",
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  await flush();
  await flush();
  assert.equal(failedInput.stateSlots[2], false);
  assert.equal(failedInput.stateSlots[1].pageState, "unavailable");
  assert.match(failedInput.stateSlots[1].error, /Remote input rejected/);

  const lostLease = createLiveSeatHarness({
    heartbeatError: new Error("Control lease lost"),
  });
  lostLease.stateSlots[2] = true;
  lostLease.render();
  lostLease.effects()[3]();
  const heartbeat = lostLease.intervals.find(({ delay }) => delay === 5000);
  await heartbeat.callback();
  await flush();
  assert.equal(lostLease.stateSlots[2], false);
  assert.ok(
    lostLease.requests.some(
      ({ requestPath, body }) =>
        requestPath === "/api/control" && body.action === "release",
    ),
  );
});

test("expanded frame geometry responds to portrait and landscape viewport resizes", () => {
  const expanded = liveSeatState.GBSeatFrameStyle(true);
  assert.equal(expanded.width, "min(calc(100vw - 24px), calc(160vh - 38.4px))");
  assert.equal(expanded.height, "min(calc(100vh - 24px), calc(62.5vw - 15px))");
  assert.equal(expanded.transform, "translate(-50%, -50%)");
  assert.deepEqual(liveSeatState.GBSeatFrameStyle(false), {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
  });
  assert.equal(
    liveSeatState.GBSeatEventIsInsideFrame(
      { clientX: 640, clientY: 400 },
      {
        getBoundingClientRect: () => ({
          left: 100,
          top: 100,
          right: 1180,
          bottom: 700,
        }),
      },
    ),
    true,
  );
  assert.equal(
    liveSeatState.GBSeatEventIsInsideFrame(
      { clientX: 20, clientY: 20 },
      {
        getBoundingClientRect: () => ({
          left: 100,
          top: 100,
          right: 1180,
          bottom: 700,
        }),
      },
    ),
    false,
  );
});

test("transformed live-seat aliases execute without local TDZ or JSX shadowing", () => {
  const transformed = transformedLiveSeatSource();
  assert.doesNotThrow(() => verifyLiveSeatAliasIsolationSource(transformed));
  assert.throws(
    () =>
      verifyLiveSeatAliasIsolationSource(
        transformed.replace("aF = S.useRef(!1)", "p = S.useRef(!1)"),
      ),
    /cannot shadow renderer aliases S or p/,
  );
  assert.throws(
    () =>
      verifyLiveSeatAliasIsolationSource(
        transformed.replace("zM = S.useCallback", "S = S.useCallback"),
      ),
    /cannot shadow renderer aliases S or p/,
  );
  const state = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  const S = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [state[index], (value) => (state[index] = value)];
    },
    useRef(initial) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useCallback(callback) {
      return callback;
    },
    useEffect() {},
  };
  const p = {
    jsx(type, props, key) {
      return { type, props, key };
    },
    jsxs(type, props, key) {
      return { type, props, key };
    },
  };
  const GBLiveSeat = Function(
    "S",
    "p",
    "globalThis",
    "document",
    "setInterval",
    "clearInterval",
    "setTimeout",
    `"use strict"; ${transformed}; return GBLiveSeat;`,
  )(
    S,
    p,
    {
      crypto: { randomUUID: () => "control-id" },
      __CODEX_BOT_VIEW_REQUEST__: async () => ({}),
    },
    { activeElement: null },
    () => 1,
    () => {},
    () => 1,
  );

  const tree = GBLiveSeat({
    agentId: "employee-a",
    subjectLabel: "Alex",
  });
  assert.equal(tree.type, "div");
  assert.equal(typeof tree.props.onPointerMove, "function");
});

test("a first official frame failure keeps vendor identity and hides the private address", async () => {
  const stateSlots = [];
  const refSlots = [];
  let stateIndex = 0;
  let refIndex = 0;
  let collectEffects = true;
  let effects = [];
  const T = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in stateSlots)) stateSlots[index] = initial;
      return [
        stateSlots[index],
        (next) => {
          stateSlots[index] =
            typeof next === "function" ? next(stateSlots[index]) : next;
        },
      ];
    },
    useRef(initial) {
      const index = refIndex++;
      if (!(index in refSlots)) refSlots[index] = { current: initial };
      return refSlots[index];
    },
    useCallback(callback) {
      return callback;
    },
    useEffect(callback) {
      if (collectEffects) effects.push(callback);
    },
  };
  const h = {
    jsx(type, props, key) {
      return { type, props, key };
    },
    jsxs(type, props, key) {
      return { type, props, key };
    },
  };
  let rejectFrame;
  const frame = new Promise((_resolve, reject) => {
    rejectFrame = reject;
  });
  const requests = [];
  const request = async (requestPath) => {
    requests.push(requestPath);
    if (requestPath.startsWith("/api/codex/status?")) {
      return { officialComputer: { mode: "official" } };
    }
    if (requestPath.startsWith("/api/frame?")) return frame;
    if (requestPath.startsWith("/api/approval?")) return { pending: null };
    throw new Error(`Unexpected request: ${requestPath}`);
  };
  const GBLiveSeat = Function(
    "T",
    "h",
    "globalThis",
    "document",
    "setInterval",
    "clearInterval",
    "setTimeout",
    `${liveSeat}; return GBLiveSeat;`,
  )(
    T,
    h,
    {
      crypto: { randomUUID: () => "control-id" },
      __CODEX_BOT_VIEW_REQUEST__: request,
    },
    { activeElement: null },
    () => 1,
    () => {},
    () => 1,
  );
  const render = () => {
    stateIndex = 0;
    refIndex = 0;
    return GBLiveSeat({ agentId: "employee-a", subjectLabel: "Alex" });
  };
  const descendants = (node) => {
    if (node == null || typeof node !== "object") return [];
    const children = Array.isArray(node.props?.children)
      ? node.props.children
      : [node.props?.children];
    return [node, ...children.flatMap(descendants)];
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  render();
  collectEffects = false;
  for (const effect of effects) effect();
  await flush();

  // Exercise the address-field branch as if takeover were already active. The
  // official identity must suppress it even before the first frame settles.
  stateSlots[2] = true;
  let tree = render();
  let nodes = descendants(tree);
  assert.ok(
    nodes.some(
      (node) =>
        node.type === "span" &&
        String(node.props?.children).includes(
          "Vendor cloud \u00b7 Experimental \u00b7 billing possible",
        ),
    ),
  );
  assert.equal(
    nodes.some((node) => node.props?.["aria-label"] === "Browser address"),
    false,
  );

  rejectFrame(new Error("The official viewer timed out."));
  await flush();
  tree = render();
  nodes = descendants(tree);
  assert.ok(
    nodes.some(
      (node) =>
        node.type === "span" &&
        String(node.props?.children).includes(
          "Vendor cloud \u00b7 Experimental \u00b7 billing possible",
        ) &&
        String(node.props?.children).includes("View unavailable"),
    ),
  );
  assert.equal(
    nodes.some((node) => node.props?.["aria-label"] === "Browser address"),
    false,
  );
  assert.deepEqual(requests.slice(0, 2), [
    "/api/codex/status?agentId=employee-a",
    "/api/frame?seatKey=employee-a",
  ]);
  assert.equal(
    requests.some((requestPath) => requestPath.startsWith("/api/approval?")),
    false,
  );
  assert.ok(requests.includes("/api/frame?seatKey=employee-a"));
});

test("private live view leaves approval decisions to the chat-adjacent permission card", () => {
  assert.equal(liveSeat.includes("/api/approval?seatKey="), false);
  assert.match(liveSeat, /Computer approvals belong beside the conversation/);
});
