"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { publicOriginForLog, redactError, redactLogDetails } = require(path.join(__dirname, "..", "codex-connection.cjs"));
const { createPublicWebProxy } = require(path.join(__dirname, "public-web-proxy.cjs"));
const { BrowserActionApprovalCoordinator } = require(path.join(__dirname, "browser-action-approval.cjs"));
const { BrowserControlLeaseCoordinator } = require(path.join(__dirname, "browser-control-lease.cjs"));
const {
  CHROMIUM_HARDENING_ARGS,
  installBrowserPageHardening,
} = require(path.join(__dirname, "browser-page-hardening.cjs"));

const WIDTH = 1280;
const HEIGHT = 800;
const MAX_ACTIVE = Math.max(1, Math.min(3, Number(process.env.GROK_BOT_BROWSER_SEAT_LIMIT || 3)));
const DATA_ROOT = process.env.GROK_BOT_BROWSER_SEAT_DATA || path.join(process.env.LOCALAPPDATA || __dirname, "Codex Bot Bridge", "browser-seats");
const CHROME_CANDIDATES = [
  process.env.GROK_BOT_BROWSER_EXECUTABLE,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const LOG_PATH = path.join(DATA_ROOT, "browser-seats.log");
const DEFAULT_START_URL = process.env.GROK_BOT_BROWSER_START_URL || "https://www.google.com/";
const SESSION_STATE_VERSION = 1;
const MAX_RESTORED_TABS = 8;

const activeSeats = new Map();
let allocationTail = Promise.resolve();
const actionApprovals = new BrowserActionApprovalCoordinator();
const trustedUserApprover = actionApprovals.createTrustedUserApprover();
const browserControls = new BrowserControlLeaseCoordinator({
  onAcquire: (seatId) => actionApprovals.cancelAgentAction(seatId),
});

const BLOCKED_NETWORKS = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) BLOCKED_NETWORKS.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) BLOCKED_NETWORKS.addSubnet(network, prefix, "ipv6");

function log(event, detail = {}) {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), event, ...redactLogDetails(detail) })}\n`);
  } catch {}
}

function hostnameAddress(value) {
  const hostname = String(value || "").toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function mappedIpv4Address(hostname) {
  const address = hostnameAddress(hostname);
  if (!address.startsWith("::ffff:")) return null;
  const tail = address.slice("::ffff:".length);
  if (net.isIP(tail) === 4) return tail;
  const words = tail.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const high = Number.parseInt(words[0], 16);
  const low = Number.parseInt(words[1], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isBlockedNavigationHostname(value) {
  const hostname = hostnameAddress(value).replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "localhost.localdomain") return true;
  const version = net.isIP(hostname);
  if (version === 4) return BLOCKED_NETWORKS.check(hostname, "ipv4");
  if (version !== 6) return false;
  const mapped = mappedIpv4Address(hostname);
  return mapped ? BLOCKED_NETWORKS.check(mapped, "ipv4") : BLOCKED_NETWORKS.check(hostname, "ipv6");
}

function publicWebUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Isolated browser seats can open only public HTTP(S) pages.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname || isBlockedNavigationHostname(parsed.hostname)) {
    throw new Error("Isolated browser seats can open only public HTTP(S) pages.");
  }
  return parsed.href;
}

function isAllowedLoadedPageUrl(value) {
  const url = String(value || "");
  if (url === "about:blank" || url === "chrome-error://chromewebdata/" || url === "edge-error://edgewebdata/") return true;
  try {
    publicWebUrl(url);
    return true;
  } catch {
    return false;
  }
}

function assertSafePageForCapture(page) {
  if (!isAllowedLoadedPageUrl(page.url())) {
    throw new Error("Isolated browser navigation was blocked before page capture.");
  }
}

function isTopLevelNavigationRequest(request) {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() == null;
  } catch {
    return true;
  }
}

async function enforceNavigationRoute(route, request) {
  const target = request.url();
  let blocked = false;
  if (isTopLevelNavigationRequest(request)) {
    try {
      publicWebUrl(target);
    } catch {
      blocked = true;
    }
  } else {
    try {
      const parsed = new URL(target);
      blocked = (parsed.protocol === "http:" || parsed.protocol === "https:") && isBlockedNavigationHostname(parsed.hostname);
    } catch {}
  }
  if (blocked) {
    await route.abort("blockedbyclient");
    return false;
  }
  await route.continue();
  return true;
}

function navigationLogTarget(value) {
  return publicOriginForLog(value);
}

function profileIdFor(key) {
  return crypto.createHash("sha256").update(String(key || "default-seat")).digest("hex").slice(0, 20);
}

function profileRootFor(key) {
  return path.join(DATA_ROOT, "profiles", profileIdFor(key));
}

function sessionStatePathFor(key) {
  return path.join(profileRootFor(key), "session-state.json");
}

function restorableUrl(value) {
  try {
    const parsed = new URL(publicWebUrl(value));
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeSessionState(value) {
  if (!value || value.version !== SESSION_STATE_VERSION || !Array.isArray(value.tabs)) return null;
  const requestedIndex = Math.max(0, Math.min(value.tabs.length - 1, Number.isInteger(value.activeIndex) ? value.activeIndex : value.tabs.length - 1));
  const entries = [];
  for (let originalIndex = 0; originalIndex < value.tabs.length && entries.length < MAX_RESTORED_TABS; originalIndex += 1) {
    const url = restorableUrl(value.tabs[originalIndex]);
    if (url) entries.push({ originalIndex, url });
  }
  if (entries.length === 0) return null;
  let activeIndex = entries.findIndex((entry) => entry.originalIndex === requestedIndex);
  if (activeIndex < 0) {
    activeIndex = 0;
    for (let index = 0; index < entries.length && entries[index].originalIndex <= requestedIndex; index += 1) activeIndex = index;
  }
  return { version: SESSION_STATE_VERSION, tabs: entries.map((entry) => entry.url), activeIndex };
}

function readSessionState(key) {
  try {
    return normalizeSessionState(JSON.parse(fs.readFileSync(sessionStatePathFor(key), "utf8")));
  } catch {
    return null;
  }
}

function createSessionStateSnapshot(pages, activePage, allowUrls = true) {
  const entries = [];
  for (const page of pages || []) {
    try {
      if (!page || page.isClosed()) continue;
      const url = allowUrls ? restorableUrl(page.url()) : null;
      if (url) entries.push({ page, url });
      if (entries.length >= MAX_RESTORED_TABS) break;
    } catch {}
  }
  if (entries.length === 0) return null;
  const selectedIndex = entries.findIndex((entry) => entry.page === activePage);
  return {
    version: SESSION_STATE_VERSION,
    tabs: entries.map((entry) => entry.url),
    activeIndex: selectedIndex >= 0 ? selectedIndex : entries.length - 1,
  };
}

function writeSessionState(seat) {
  if (seat.restoringSession || seat.closing || seat.context == null) return;
  const pages = seat.context.pages().filter((page) => !page.isClosed());
  const destination = seat.sessionStatePath;
  // Persist sanitized public tab URLs so each coworker returns to its open
  // work after a restart. restorableUrl() retains only public origin + path;
  // credentials, every query, and fragments are removed before disk writes.
  const snapshot = createSessionStateSnapshot(pages, seat.page);
  if (snapshot == null) {
    try { fs.rmSync(destination, { force: true }); } catch {}
    return;
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify({ ...snapshot, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    log("session_state_error", { profileId: seat.profileId, error: error instanceof Error ? error.message : String(error) });
  }
}

function attachPage(seat, page) {
  page.setDefaultTimeout(15000);
  page.on("download", (download) => {
    void download.cancel().catch(() => {});
    log("download_blocked", { profileId: seat.profileId });
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      seat.navigationEpoch += 1;
      if (!isAllowedLoadedPageUrl(frame.url())) {
        log("navigation_blocked_after_commit", { profileId: seat.profileId, target: navigationLogTarget(frame.url()) });
        if (seat.page === page) seat.page = null;
        void page.close().catch(() => {});
        return;
      }
      seat.page = page;
      writeSessionState(seat);
    }
  });
  page.on("close", () => setImmediate(() => {
    if (!seat.closing && activeSeats.get(seat.key) === seat) writeSessionState(seat);
  }));
}

function resolveChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("No compatible Chrome or Edge executable was found for isolated browser seats.");
  return found;
}

function buttonName(button) {
  if (button === 2) return "right";
  if (button === 3) return "middle";
  return "left";
}

function isChord(key, expected) {
  return String(key || "").replace(/CONTROL/gi, "CTRL").replace(/\s/g, "").toUpperCase() === expected;
}

function playwrightKey(key) {
  const aliases = {
    CTRL: "Control",
    CONTROL: "Control",
    ALT: "Alt",
    SHIFT: "Shift",
    WIN: "Meta",
    WINDOWS: "Meta",
    META: "Meta",
    SUPER: "Meta",
    ENTER: "Enter",
    RETURN: "Enter",
    ESC: "Escape",
    ESCAPE: "Escape",
    BACKSPACE: "Backspace",
    DELETE: "Delete",
    SPACE: " ",
    PAGEUP: "PageUp",
    PAGEDOWN: "PageDown",
    HOME: "Home",
    END: "End",
    TAB: "Tab",
    LEFT: "ArrowLeft",
    RIGHT: "ArrowRight",
    UP: "ArrowUp",
    DOWN: "ArrowDown",
  };
  return String(key || "").split("+").map((part) => aliases[part.toUpperCase()] || (part.length === 1 ? part.toUpperCase() : part)).join("+");
}

async function withAllocationLock(fn) {
  const previous = allocationTail;
  let release;
  allocationTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function currentPage(seat) {
  if (seat.page && !seat.page.isClosed() && !isAllowedLoadedPageUrl(seat.page.url())) {
    const unsafePage = seat.page;
    seat.page = null;
    await unsafePage.close().catch(() => {});
  }
  const pages = seat.context.pages().filter((page) => !page.isClosed() && isAllowedLoadedPageUrl(page.url()));
  if (seat.page && !seat.page.isClosed()) return seat.page;
  seat.page = pages.at(-1) || await seat.context.newPage();
  return seat.page;
}

async function closeSeat(seat, reason) {
  if (seat.closePromise) return await seat.closePromise;
  seat.closePromise = (async () => {
    writeSessionState(seat);
    seat.closing = true;
    try {
      await seat.context.close();
    } catch {}
    try {
      await seat.publicWebProxy?.close();
    } catch {}
    actionApprovals.clearSeatAuthorizations?.(seat.key);
    actionApprovals.cancelAgentAction(seat.key);
    browserControls.clearSeat(seat.key);
    if (activeSeats.get(seat.key) === seat) activeSeats.delete(seat.key);
    log("seat_closed", { profileId: seat.profileId, reason });
  })();
  return await seat.closePromise;
}

async function launchSeat(key) {
  const profileId = profileIdFor(key);
  const profileRoot = profileRootFor(key);
  const profileDir = path.join(profileRoot, "chrome-profile");
  const downloadsDir = path.join(profileRoot, "downloads");
  const restoredSession = readSessionState(key);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  const publicWebProxy = createPublicWebProxy();
  const proxyConfig = await publicWebProxy.listen();
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
    executablePath: resolveChrome(),
    // A real headful Chrome window avoids reduced web-platform support and
    // bot challenges used by apps such as Canva. The window lives off-screen;
    // all input and screenshots still travel through DevTools, never SendInput.
    headless: process.env.GROK_BOT_BROWSER_HEADLESS === "1",
    viewport: { width: WIDTH, height: HEIGHT },
    screen: { width: WIDTH, height: HEIGHT },
    // Automated downloads are blocked because a harmless-looking link can
    // otherwise write files without a trusted decision. Direct user uploads
    // and normal in-page editing continue to work.
    acceptDownloads: false,
    downloadsPath: downloadsDir,
    locale: "en-US",
    colorScheme: "dark",
    deviceScaleFactor: 1,
    // The context route below must observe navigations and redirects rather
    // than allowing a persisted service worker to satisfy them first.
    serviceWorkers: "block",
    proxy: {
      server: proxyConfig.server,
      username: proxyConfig.username,
      password: proxyConfig.password,
    },
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
      "--force-device-scale-factor=1",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--window-position=-32000,-32000",
      ...CHROMIUM_HARDENING_ARGS,
    ],
    });
  } catch (error) {
    await publicWebProxy.close().catch(() => {});
    throw error;
  }
  await installBrowserPageHardening(context);
  await context.clearPermissions().catch(() => {});
  await context.route("**/*", async (route, request) => {
    const allowed = await enforceNavigationRoute(route, request);
    if (!allowed) log("navigation_blocked", { profileId, target: navigationLogTarget(request.url()) });
  });
  const seat = {
    key,
    profileId,
    profileDir,
    downloadsDir,
    sessionStatePath: sessionStatePathFor(key),
    context,
    publicWebProxy,
    page: context.pages().at(-1),
    cursor: { x: Math.round(WIDTH / 2), y: Math.round(HEIGHT / 2) },
    address: null,
    navigationEpoch: 0,
    queue: Promise.resolve(),
    pending: 0,
    lastUsed: Date.now(),
    lastPageInfo: { state: "blank", title: "", bodyPreview: "" },
    restoringSession: true,
    closing: false,
    closePromise: null,
  };
  context.on("page", (page) => {
    seat.page = page;
    attachPage(seat, page);
  });
  context.on("close", () => {
    actionApprovals.clearSeatAuthorizations?.(key);
    actionApprovals.cancelAgentAction(key);
    browserControls.clearSeat(key);
    void publicWebProxy.close().catch(() => {});
    if (activeSeats.get(key) === seat) activeSeats.delete(key);
  });
  for (const page of context.pages()) attachPage(seat, page);
  await Promise.all(context.pages()
    .filter((page) => !isAllowedLoadedPageUrl(page.url()))
    .map((page) => page.close().catch(() => {})));
  activeSeats.set(key, seat);
  log("seat_launched", { profileId, activeCount: activeSeats.size, profileDir });
  try {
    const firstPage = await currentPage(seat);
    if (restoredSession != null) {
      // Chrome can reopen crash-recovery tabs before Playwright attaches. The
      // explicit snapshot is canonical, so remove those extras before restore.
      await Promise.all(context.pages().filter((page) => page !== firstPage).map((page) => page.close().catch(() => {})));
      const restoredPages = [firstPage];
      for (let index = 1; index < restoredSession.tabs.length; index += 1) {
        try {
          restoredPages.push(await context.newPage());
        } catch {
          break;
        }
      }
      const results = await Promise.allSettled(restoredPages.map((page, index) => (
        page.goto(publicWebUrl(restoredSession.tabs[index]), { waitUntil: "domcontentloaded", timeout: 45000 })
      )));
      const failedCount = results.filter((result) => result.status === "rejected").length;
      seat.page = restoredPages[Math.min(restoredSession.activeIndex, restoredPages.length - 1)];
      seat.lastPageInfo = await classifyPage(seat.page).catch(() => ({ state: "error", title: "", bodyPreview: "" }));
      log("session_restored", { profileId, tabCount: restoredPages.length, failedCount, target: navigationLogTarget(seat.page.url()) });
    } else if (firstPage.url() === "about:blank") {
      try {
        await firstPage.goto(publicWebUrl(DEFAULT_START_URL), { waitUntil: "domcontentloaded", timeout: 45000 });
        seat.lastPageInfo = await classifyPage(firstPage);
      } catch (error) {
        seat.lastPageInfo = { state: "error", title: "", bodyPreview: "" };
        log("start_page_error", { profileId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    seat.restoringSession = false;
    writeSessionState(seat);
    return seat;
  } catch (error) {
    seat.closing = true;
    if (activeSeats.get(key) === seat) activeSeats.delete(key);
    try { await context.close(); } catch {}
    try { await publicWebProxy.close(); } catch {}
    throw error;
  }
}

async function ensureSeat(key) {
  return await withAllocationLock(async () => {
    const existing = activeSeats.get(key);
    if (existing && !existing.closing) return existing;
    if (existing?.closePromise) await existing.closePromise;
    if (activeSeats.size >= MAX_ACTIVE) {
      const idle = [...activeSeats.values()].filter((seat) => seat.pending === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new Error(`All ${MAX_ACTIVE} isolated browser seats are busy. Retry when one finishes.`);
      await closeSeat(idle, "idle_lru_eviction");
    }
    return await launchSeat(key);
  });
}

async function navigateAddress(seat, page) {
  let target = String(seat.address?.text || "").trim();
  seat.address = null;
  if (!target) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(target)) target = `https://${target}`;
    else target = `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  }
  await page.goto(publicWebUrl(target), { waitUntil: "domcontentloaded", timeout: 45000 });
}

async function describeActionTarget(page, action) {
  const kind = String(action?.kind || "").toLowerCase();
  if (action?.surface === "address") return { surface: "address" };
  if (seatAddressAction(action)) return { surface: "address" };
  if (kind === "screenshot" || kind === "scroll" || kind === "mousemove" || kind === "wait") return {};
  const coordinate = action?.coordinate || (Array.isArray(action?.path) ? action.path.at(-1) : null);
  const useActiveElement = !coordinate && (kind === "type" || kind === "key");
  if (!coordinate && !useActiveElement) return {};
  try {
    return await page.evaluate(({ x, y, useActive }) => {
      const element = useActive ? document.activeElement : document.elementFromPoint(Number(x || 0), Number(y || 0));
      if (!element) return {};
      const target = element.closest?.("button,input,textarea,select,a,[role],[contenteditable],form") || element;
      const label = target.labels?.[0]?.innerText || target.getAttribute?.("aria-label") || target.getAttribute?.("title") || target.innerText || "";
      return {
        tagName: String(target.tagName || "").toLowerCase(),
        role: target.getAttribute?.("role") || "",
        type: target.getAttribute?.("type") || "",
        inputType: target.getAttribute?.("type") || "",
        autocomplete: target.getAttribute?.("autocomplete") || "",
        accessibleName: String(label).trim().slice(0, 240),
        href: target.href || "",
        contentEditable: target.isContentEditable === true,
        editable: target.matches?.("input,textarea,[contenteditable]") === true,
        formAction: target.formAction || target.closest?.("form")?.action || "",
        formMethod: target.formMethod || target.closest?.("form")?.method || "",
      };
    }, {
      x: Number(coordinate?.x || 0),
      y: Number(coordinate?.y || 0),
      useActive: useActiveElement,
    });
  } catch {
    return {};
  }
}

function seatAddressAction(action) {
  return String(action?.kind || "").toLowerCase() === "key" && /^(?:CTRL|CONTROL)\+L$/i.test(String(action?.key || ""));
}

async function approvalContextForActions(page, actions, options = {}) {
  let addressMode = options.addressMode === true;
  let lastPointTarget = null;
  const contexts = [];
  for (const action of actions || []) {
    if (seatAddressAction(action)) addressMode = true;
    const kind = String(action?.kind || "").toLowerCase();
    const hasPoint = Boolean(action?.coordinate || (Array.isArray(action?.path) && action.path.length > 0));
    let target = addressMode
      ? {
          surface: "address",
          href: String(options.addressText || ""),
          selected: options.addressSelected === true,
        }
      : await describeActionTarget(page, action);
    if (!addressMode && (kind === "type" || kind === "key") && lastPointTarget) target = lastPointTarget;
    contexts.push({
      surface: addressMode ? "address" : undefined,
      target,
    });
    if (!addressMode && hasPoint && Object.keys(target || {}).length > 0) lastPointTarget = target;
    else if (!addressMode && kind !== "type" && kind !== "key") lastPointTarget = null;
    if (addressMode && String(action?.kind || "").toLowerCase() === "key" && /^(ENTER|RETURN|ESC|ESCAPE)$/i.test(String(action?.key || ""))) {
      addressMode = false;
      lastPointTarget = null;
    }
  }
  return { actions: contexts };
}

function cloneActionData(value, seen = new Set()) {
  if (value === null || ["string", "boolean", "number", "undefined"].includes(typeof value)) return value;
  if (typeof value !== "object") throw new TypeError("Browser actions must contain only data values.");
  if (seen.has(value)) throw new TypeError("Browser actions cannot contain circular data.");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Browser actions must contain only plain data objects.");
  }
  seen.add(value);
  const clone = Array.isArray(value)
    ? value.map((item) => cloneActionData(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneActionData(item, seen)]));
  seen.delete(value);
  return Object.freeze(clone);
}

function immutableActionSnapshot(actions) {
  if (!Array.isArray(actions)) throw new TypeError("Browser actions must be an array.");
  return cloneActionData(actions);
}

function approvalOriginForPage(page) {
  try {
    const parsed = new URL(page.url());
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {}
  // This origin exists only as an approval binding for about:blank and browser
  // error pages. It is never sent to Chrome or the network.
  return "https://browser-seat.invalid";
}

async function executeAction(seat, page, action) {
  const kind = action?.kind;
  switch (kind) {
    case "click": {
      seat.address = null;
      seat.cursor = { x: Number(action.coordinate?.x || 0), y: Number(action.coordinate?.y || 0) };
      await page.mouse.click(seat.cursor.x, seat.cursor.y, {
        button: buttonName(action.button),
        clickCount: Math.max(1, Number(action.count || 1)),
        delay: 50,
      });
      break;
    }
    case "mouseMove": {
      seat.cursor = { x: Number(action.coordinate?.x || 0), y: Number(action.coordinate?.y || 0) };
      await page.mouse.move(seat.cursor.x, seat.cursor.y);
      break;
    }
    case "drag": {
      const points = Array.isArray(action.path) ? action.path : [];
      if (points.length < 2) break;
      seat.address = null;
      seat.cursor = { x: Number(points[0].x || 0), y: Number(points[0].y || 0) };
      await page.mouse.move(seat.cursor.x, seat.cursor.y);
      await page.mouse.down({ button: buttonName(action.button) });
      for (const point of points.slice(1)) {
        seat.cursor = { x: Number(point.x || 0), y: Number(point.y || 0) };
        await page.mouse.move(seat.cursor.x, seat.cursor.y, { steps: 4 });
      }
      await page.mouse.up({ button: buttonName(action.button) });
      break;
    }
    case "type": {
      const text = String(action.text || "");
      if (seat.address) {
        seat.address.text = seat.address.selected ? text : seat.address.text + text;
        seat.address.selected = false;
      } else {
        await page.keyboard.insertText(text);
      }
      break;
    }
    case "key": {
      const key = String(action.key || "");
      // Some model/tool adapters can emit an empty key action while splitting
      // a multi-action batch. Treat it as a harmless no-op instead of forcing
      // the employee to retry the whole browser step.
      if (!key.trim()) break;
      if (isChord(key, "CTRL+L")) {
        seat.address = { text: page.url() === "about:blank" ? "" : page.url(), selected: true };
      } else if (seat.address && isChord(key, "CTRL+A")) {
        seat.address.selected = true;
      } else if (seat.address && /^(ENTER|RETURN)$/i.test(key)) {
        await navigateAddress(seat, page);
      } else if (seat.address && /^(ESC|ESCAPE)$/i.test(key)) {
        seat.address = null;
      } else if (seat.address && /^BACKSPACE$/i.test(key)) {
        seat.address.text = seat.address.selected ? "" : seat.address.text.slice(0, -1);
        seat.address.selected = false;
      } else {
        await page.keyboard.press(playwrightKey(key));
      }
      break;
    }
    case "scroll": {
      seat.address = null;
      seat.cursor = { x: Number(action.coordinate?.x ?? seat.cursor.x), y: Number(action.coordinate?.y ?? seat.cursor.y) };
      await page.mouse.move(seat.cursor.x, seat.cursor.y);
      const amount = Math.max(1, Number(action.amount || 3)) * 180;
      const direction = Number(action.direction || 2);
      await page.mouse.wheel(direction === 3 ? -amount : direction === 4 ? amount : 0, direction === 1 ? -amount : direction === 2 ? amount : 0);
      break;
    }
    case "wait":
      await page.waitForTimeout(Math.max(0, Math.min(30000, Number(action.durationMs || 1000))));
      break;
    case "screenshot":
      break;
    default:
      throw new Error(`Unsupported isolated-browser computer action: ${String(kind || "unknown")}`);
  }
}

async function classifyPage(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  if (url === "about:blank") return { state: "blank", title, bodyPreview: "" };
  if (/^(chrome-error|edge-error):/i.test(url)) return { state: "error", title, bodyPreview: "" };
  const bodyPreview = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  const challengeText = `${title}\n${bodyPreview}`;
  if (/cloudflare|verifying(?:\.\.\.)?|just a moment|security check|required|we(?:'|’|\u2019)ll have you designing again soon|checking your browser/i.test(challengeText)) {
    return { state: "challenge", title, bodyPreview: bodyPreview.slice(0, 500) };
  }
  if (bodyPreview.trim().length === 0) return { state: "empty", title, bodyPreview: "" };
  return { state: "loaded", title, bodyPreview: bodyPreview.slice(0, 500) };
}

async function executeSeatActions(key, actions, options = {}) {
  const actionSnapshot = immutableActionSnapshot(actions);
  const actor = options.actor === "user" ? "user" : "agent";
  const controlId = String(options.controlId || "");
  if (actor === "agent") browserControls.assertAgentAllowed(String(key || "default-seat"));
  else browserControls.authorizeUser(String(key || "default-seat"), controlId);
  const seat = await ensureSeat(String(key || "default-seat"));
  seat.pending += 1;
  const run = seat.queue.then(async () => {
    const started = Date.now();
    let page = await currentPage(seat);
    try {
      for (let index = 0; index < actionSnapshot.length; index += 1) {
        const action = actionSnapshot[index];
        if (actor === "user") {
          browserControls.authorizeUser(seat.key, controlId);
          page = await currentPage(seat);
          await executeAction(seat, page, action);
          continue;
        }

        let stable = false;
        for (let attempt = 0; attempt < 4 && !stable; attempt += 1) {
          browserControls.assertAgentAllowed(seat.key);
          page = await currentPage(seat);
          const origin = approvalOriginForPage(page);
          const expectedPage = page;
          const expectedUrl = page.url();
          const expectedEpoch = seat.navigationEpoch;
          const contextOptions = {
            addressMode: Boolean(seat.address),
            addressText: seat.address?.text || "",
            addressSelected: seat.address?.selected === true,
          };
          const approvalContext = await approvalContextForActions(page, [action], contextOptions);
          const expectedContext = JSON.stringify(approvalContext);
          const decision = await actionApprovals.requestAgentAction(
            { seatId: seat.key, origin, actions: Object.freeze([action]) },
            approvalContext,
          );
          if (!decision.allowed) {
            throw new Error(decision.decision === "deny"
              ? "The user denied this browser action."
              : "This browser action was not approved before the request expired.");
          }
          browserControls.assertAgentAllowed(seat.key);
          const current = await currentPage(seat);
          const currentContext = await approvalContextForActions(current, [action], {
            addressMode: Boolean(seat.address),
            addressText: seat.address?.text || "",
            addressSelected: seat.address?.selected === true,
          });
          stable = current === expectedPage
            && current.url() === expectedUrl
            && seat.navigationEpoch === expectedEpoch
            && approvalOriginForPage(current) === decision.origin
            && JSON.stringify(currentContext) === expectedContext;
        }
        if (!stable) throw new Error("The page changed while this browser action was awaiting approval. Please retry it on the current page.");
        browserControls.assertAgentAllowed(seat.key);
        page = await currentPage(seat);
        await executeAction(seat, page, action);
      }
      page = await currentPage(seat);
      if (actor === "user") {
        seat.lastUsed = Date.now();
        writeSessionState(seat);
        return {
          screenshotBase64: "",
          cursorPosition: seat.cursor,
          url: page.url(),
          title: await page.title().catch(() => seat.lastPageInfo?.title || ""),
          pageState: seat.lastPageInfo?.state || (page.url() === "about:blank" ? "blank" : "loaded"),
          bodyPreview: "",
          profileId: seat.profileId,
          profileDir: seat.profileDir,
          downloadsDir: seat.downloadsDir,
          activeSeatCount: activeSeats.size,
          durationMs: Date.now() - started,
        };
      }
      await page.waitForTimeout(250);
      assertSafePageForCapture(page);
      const screenshot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
      assertSafePageForCapture(page);
      const pageInfo = await classifyPage(page);
      assertSafePageForCapture(page);
      seat.lastPageInfo = pageInfo;
      seat.lastUsed = Date.now();
      writeSessionState(seat);
      const result = {
        screenshotBase64: screenshot.toString("base64"),
        cursorPosition: seat.cursor,
        url: page.url(),
        title: pageInfo.title,
        pageState: pageInfo.state,
        bodyPreview: pageInfo.bodyPreview,
        profileId: seat.profileId,
        profileDir: seat.profileDir,
        downloadsDir: seat.downloadsDir,
        activeSeatCount: activeSeats.size,
        durationMs: Date.now() - started,
      };
      log("actions_complete", { profileId: seat.profileId, actionCount: actionSnapshot.length, target: navigationLogTarget(result.url), title: result.title, pageState: result.pageState, durationMs: result.durationMs });
      return result;
    } catch (error) {
      const safeError = redactError(error);
      log("actions_error", { profileId: seat.profileId, error: safeError.message });
      throw safeError;
    }
  });
  seat.queue = run.catch(() => {});
  try {
    return await run;
  } finally {
    seat.pending -= 1;
  }
}

function pendingApprovalForSeat(key) {
  return actionApprovals.getPendingStatus(String(key || ""));
}

function decidePendingApproval(key, decision, binding) {
  const seatKey = String(key || "");
  if (seatKey !== String(binding?.seatId || "")) throw new Error("Browser approval does not match this employee.");
  if (decision === "allow-once") return trustedUserApprover.allowOnce(binding);
  if (decision === "allow-site") return trustedUserApprover.allowSiteLease(binding);
  if (decision === "deny") return trustedUserApprover.deny(binding);
  throw new Error("Unknown browser approval decision.");
}

async function acquireUserControl(key, ownerId) {
  const seatKey = String(key || "");
  browserControls.acquire(seatKey, ownerId);
  const seat = activeSeats.get(seatKey);
  if (seat) await seat.queue.catch(() => {});
  return browserControls.heartbeat(seatKey, ownerId);
}

function heartbeatUserControl(key, ownerId) {
  return browserControls.heartbeat(String(key || ""), ownerId);
}

function releaseUserControl(key, ownerId) {
  return browserControls.release(String(key || ""), ownerId);
}

function controlStatusForSeat(key) {
  return browserControls.status(String(key || ""));
}

async function captureSeat(key) {
  const seat = await ensureSeat(String(key || "default-seat"));
  seat.pending += 1;
  const run = seat.queue.then(async () => {
    const page = await currentPage(seat);
    assertSafePageForCapture(page);
    const screenshot = await page.screenshot({ type: "png", animations: "disabled", caret: "hide" });
    assertSafePageForCapture(page);
    const title = await page.title().catch(() => seat.lastPageInfo?.title || "");
    assertSafePageForCapture(page);
    seat.lastUsed = Date.now();
    writeSessionState(seat);
    return {
      screenshotBase64: screenshot.toString("base64"),
      cursorPosition: seat.cursor,
      url: page.url(),
      title,
      pageState: seat.lastPageInfo?.state || (page.url() === "about:blank" ? "blank" : "loaded"),
      profileId: seat.profileId,
      activeSeatCount: activeSeats.size,
    };
  });
  seat.queue = run.catch(() => {});
  try {
    return await run;
  } finally {
    seat.pending -= 1;
  }
}

async function closeAllSeats() {
  await withAllocationLock(async () => {
    await Promise.all([...activeSeats.values()].map((seat) => closeSeat(seat, "shutdown")));
  });
}

async function closeSeatForKey(key, reason = "agent_deleted") {
  return await withAllocationLock(async () => {
    const seat = activeSeats.get(String(key || ""));
    if (!seat) return false;
    await closeSeat(seat, reason);
    return true;
  });
}

function status() {
  return [...activeSeats.values()].map((seat) => ({
    profileId: seat.profileId,
    pending: seat.pending,
    lastUsed: seat.lastUsed,
    url: seat.page && !seat.page.isClosed() ? seat.page.url() : null,
    profileDir: seat.profileDir,
    downloadsDir: seat.downloadsDir,
    sessionStatePath: seat.sessionStatePath,
    pendingApproval: actionApprovals.getPendingStatus(seat.key),
    userControl: browserControls.status(seat.key),
  }));
}

module.exports = {
  executeSeatActions,
  captureSeat,
  ensureSeat,
  closeSeatForKey,
  closeAllSeats,
  status,
  profileIdFor,
  sessionStatePathFor,
  normalizeSessionState,
  createSessionStateSnapshot,
  publicWebUrl,
  enforceNavigationRoute,
  immutableActionSnapshot,
  approvalOriginForPage,
  approvalContextForActions,
  pendingApprovalForSeat,
  decidePendingApproval,
  acquireUserControl,
  heartbeatUserControl,
  releaseUserControl,
  controlStatusForSeat,
  WIDTH,
  HEIGHT,
  MAX_ACTIVE,
};
