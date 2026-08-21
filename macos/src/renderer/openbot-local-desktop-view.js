(function exposeOpenBotLocalDesktopView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenBotLocalDesktopView = api;
})(typeof window === "object" ? window : null, function createOpenBotLocalDesktopViewApi() {
  "use strict";

  const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const FRAME_ID = /^frame-[A-Za-z0-9._:-]{1,128}$/;
  const LEGACY_FRAME_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "viewGeneration", "sequence",
    "width", "height", "mimeType", "bytes",
  ]);
  const RICH_FRAME_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration",
    "frameId", "frameSequence", "inputSequence", "presentation", "width", "height",
    "mimeType", "bytes", "surface", "presentations", "viewGeneration",
  ]);
  const LEGACY_STATUS_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "viewGeneration", "state", "code",
  ]);
  const RICH_STATUS_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration",
    "viewGeneration", "frameId", "frameSequence", "inputSequence", "presentation", "state", "code",
  ]);
  const SELECTION_RESULT_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration",
    "viewGeneration", "frameId", "frameSequence", "inputSequence", "presentation", "state", "code",
  ]);
  const NAVIGATION_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration",
    "viewGeneration", "frameId", "frameSequence", "inputSequence", "action", "url",
  ]);
  const ACK_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration",
    "viewGeneration", "frameId", "frameSequence", "inputSequence",
  ]);
  const CONTROL_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "sessionGeneration", "pageGeneration", "viewGeneration",
  ]);
  const CONTROL_ACK_FIELDS = new Set([...CONTROL_FIELDS, "frameId", "frameSequence", "inputSequence", "controlGeneration"]);
  const STATUS_STATES = new Set(["connecting", "live", "unavailable", "retrying"]);
  const STATUS_CODES = new Set([null, "OPENBOT_LOCAL_CAPTURE_FAILED", "OPENBOT_LOCAL_DESKTOP_STALE"]);
  const PRESENTATIONS = new Set(["preview", "interactive"]);
  const NAVIGATION_ACTIONS = new Set(["navigate", "goBack", "goForward", "reload"]);
  const MAX_FRAME_BYTES = 1_048_576;
  const SURFACE_WIDTH = 1280;
  const SURFACE_HEIGHT = 800;
  const PREVIEW_WIDTH = 640;
  const PREVIEW_HEIGHT = 400;
  const INTERACTIVE_WIDTH = 960;
  const INTERACTIVE_HEIGHT = 600;

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function structuredCloneBoundary(value) {
    if (typeof structuredClone !== "function") return true;
    try {
      structuredClone(value);
      return true;
    } catch { return false; }
  }

  function exactData(value, fields, required = fields) {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if ((prototype !== Object.prototype && prototype !== null)
        || keys.length !== fields.size
        || keys.some((key) => typeof key !== "string" || !fields.has(key) || !("value" in descriptors[key]))
        || [...required].some((key) => !descriptors[key])
        || !structuredCloneBoundary(value)) return null;
      return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
    } catch { return null; }
  }

  function positive(value) { return Number.isSafeInteger(value) && value >= 1; }
  function nonNegative(value) { return Number.isSafeInteger(value) && value >= 0; }
  function identifier(value, pattern) { return typeof value === "string" && pattern.test(value); }
  function boundedMetric(value, maximum) { return Number.isSafeInteger(value) && value >= 1 && value <= maximum; }

  function exactSurface(value) {
    const surface = exactData(value, new Set(["cssWidth", "cssHeight"]));
    return surface && surface.cssWidth === SURFACE_WIDTH && surface.cssHeight === SURFACE_HEIGHT
      ? Object.freeze(surface) : null;
  }

  function exactPresentations(value) {
    const presentations = exactData(value, new Set(["preview", "interactive"]));
    if (!presentations) return null;
    const preview = exactData(presentations.preview, new Set(["width", "height", "fps"]));
    const interactive = exactData(presentations.interactive, new Set(["width", "height"]));
    if (!preview || !interactive || preview.width !== PREVIEW_WIDTH || preview.height !== PREVIEW_HEIGHT
      || preview.fps !== 1 || interactive.width !== INTERACTIVE_WIDTH || interactive.height !== INTERACTIVE_HEIGHT) return null;
    return Object.freeze({ preview: Object.freeze(preview), interactive: Object.freeze(interactive) });
  }

  function exactBytes(value) {
    try {
      if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_FRAME_BYTES
        || !structuredCloneBoundary(value)) return null;
      return Uint8Array.from(value);
    } catch { return null; }
  }

  function exactFrame(value) {
    const legacy = exactData(value, LEGACY_FRAME_FIELDS);
    if (legacy) {
      const bytes = exactBytes(legacy.bytes);
      if (identifier(legacy.botId, BOT_ID) && identifier(legacy.targetId, TARGET_ID)
        && nonNegative(legacy.targetGeneration) && positive(legacy.viewGeneration)
        && positive(legacy.sequence) && boundedMetric(legacy.width, PREVIEW_WIDTH)
        && boundedMetric(legacy.height, PREVIEW_HEIGHT) && legacy.mimeType === "image/png" && bytes) {
        return Object.freeze({ ...legacy, bytes, rich: false, presentation: "preview" });
      }
    }
    const rich = exactData(value, RICH_FRAME_FIELDS);
    if (!rich) return null;
    const bytes = exactBytes(rich.bytes);
    const surface = exactSurface(rich.surface);
    const presentations = exactPresentations(rich.presentations);
    const widthLimit = rich.presentation === "interactive" ? INTERACTIVE_WIDTH : PREVIEW_WIDTH;
    const heightLimit = rich.presentation === "interactive" ? INTERACTIVE_HEIGHT : PREVIEW_HEIGHT;
    if (!identifier(rich.botId, BOT_ID) || !identifier(rich.targetId, TARGET_ID)
      || !nonNegative(rich.targetGeneration) || !positive(rich.sessionGeneration)
      || !positive(rich.pageGeneration) || !positive(rich.viewGeneration)
      || !identifier(rich.frameId, FRAME_ID) || !positive(rich.frameSequence)
      || !nonNegative(rich.inputSequence) || !PRESENTATIONS.has(rich.presentation)
      || !boundedMetric(rich.width, widthLimit) || !boundedMetric(rich.height, heightLimit)
      || rich.mimeType !== "image/png" || !bytes || !surface || !presentations) return null;
    return Object.freeze({ ...rich, bytes, surface, presentations, rich: true });
  }

  function exactStatus(value) {
    const legacy = exactData(value, LEGACY_STATUS_FIELDS);
    if (legacy && identifier(legacy.botId, BOT_ID) && identifier(legacy.targetId, TARGET_ID)
      && nonNegative(legacy.targetGeneration) && positive(legacy.viewGeneration)
      && STATUS_STATES.has(legacy.state) && STATUS_CODES.has(legacy.code)
      && ((legacy.state === "unavailable" && legacy.code !== null)
        || (legacy.state !== "unavailable" && legacy.code === null))) {
      return Object.freeze({ ...legacy, rich: false, presentation: "preview" });
    }
    const rich = exactData(value, RICH_STATUS_FIELDS);
    if (!rich || !identifier(rich.botId, BOT_ID) || !identifier(rich.targetId, TARGET_ID)
      || !nonNegative(rich.targetGeneration) || !positive(rich.sessionGeneration)
      || !positive(rich.pageGeneration) || !positive(rich.viewGeneration)
      || !identifier(rich.frameId, FRAME_ID) || !positive(rich.frameSequence)
      || !nonNegative(rich.inputSequence) || rich.presentation !== "interactive"
      || !STATUS_STATES.has(rich.state) || !STATUS_CODES.has(rich.code)
      || (rich.state === "unavailable" ? rich.code === null : rich.code !== null)) return null;
    return Object.freeze({ ...rich, rich: true });
  }

  function exactSelection(value) {
    const selection = exactData(value, SELECTION_RESULT_FIELDS);
    if (!selection || !identifier(selection.botId, BOT_ID) || !identifier(selection.targetId, TARGET_ID)
      || !nonNegative(selection.targetGeneration) || !positive(selection.sessionGeneration)
      || !positive(selection.pageGeneration) || !positive(selection.viewGeneration)
      || !identifier(selection.frameId, FRAME_ID) || !positive(selection.frameSequence)
      || !nonNegative(selection.inputSequence) || selection.presentation !== "preview"
      || selection.state !== "live" || selection.code !== null) return null;
    return Object.freeze(selection);
  }

  function exactNavigation(value) {
    const navigation = exactData(value, NAVIGATION_FIELDS);
    if (!navigation || !identifier(navigation.botId, BOT_ID) || !identifier(navigation.targetId, TARGET_ID)
      || !nonNegative(navigation.targetGeneration) || !positive(navigation.sessionGeneration)
      || !positive(navigation.pageGeneration) || !positive(navigation.viewGeneration)
      || (navigation.frameId !== null && !identifier(navigation.frameId, FRAME_ID))
      || (!Number.isSafeInteger(navigation.frameSequence) || navigation.frameSequence < 0)
      || !nonNegative(navigation.inputSequence) || !NAVIGATION_ACTIONS.has(navigation.action)
      || (navigation.url !== null && (typeof navigation.url !== "string" || navigation.url.length > 4096))) return null;
    return Object.freeze(navigation);
  }

  function exactControlAck(value) {
    const ack = exactData(value, CONTROL_ACK_FIELDS);
    if (!ack || !identifier(ack.botId, BOT_ID) || !identifier(ack.targetId, TARGET_ID)
      || !nonNegative(ack.targetGeneration) || !positive(ack.sessionGeneration)
      || !positive(ack.pageGeneration) || !positive(ack.viewGeneration)
      || !identifier(ack.frameId, FRAME_ID) || !positive(ack.frameSequence)
      || !nonNegative(ack.inputSequence) || !positive(ack.controlGeneration)) return null;
    return Object.freeze(ack);
  }

  function exactReleaseAck(value) { return exactControlAck(value); }

  function exactInputAck(value) {
    const ack = exactData(value, ACK_FIELDS);
    if (!ack || !identifier(ack.botId, BOT_ID) || !identifier(ack.targetId, TARGET_ID)
      || !nonNegative(ack.targetGeneration) || !positive(ack.sessionGeneration)
      || !positive(ack.pageGeneration) || !positive(ack.viewGeneration)
      || !identifier(ack.frameId, FRAME_ID) || !positive(ack.frameSequence)
      || !positive(ack.inputSequence)) return null;
    return Object.freeze(ack);
  }

  function sameTarget(left, right) {
    return Boolean(left && right) && left.targetId === right.targetId
      && left.targetGeneration === right.targetGeneration;
  }

  function sameCurrent(left, right, includeFrame = false) {
    if (!left || !right || left.botId !== right.botId || left.targetId !== right.targetId
      || left.targetGeneration !== right.targetGeneration || left.sessionGeneration !== right.sessionGeneration
      || left.pageGeneration !== right.pageGeneration || left.viewGeneration !== right.viewGeneration) return false;
    if (includeFrame && (left.frameId !== right.frameId || left.frameSequence !== right.frameSequence)) return false;
    return true;
  }

  function computeLetterbox(viewportRect, surfaceWidth = SURFACE_WIDTH, surfaceHeight = SURFACE_HEIGHT) {
    const left = Number(viewportRect?.left) || 0;
    const top = Number(viewportRect?.top) || 0;
    const width = Math.max(0, Number(viewportRect?.width) || 0);
    const height = Math.max(0, Number(viewportRect?.height) || 0);
    if (width === 0 || height === 0 || surfaceWidth <= 0 || surfaceHeight <= 0) {
      return Object.freeze({ left, top, width: 0, height: 0 });
    }
    const scale = Math.min(width / surfaceWidth, height / surfaceHeight);
    const contentWidth = surfaceWidth * scale;
    const contentHeight = surfaceHeight * scale;
    return Object.freeze({
      left: left + (width - contentWidth) / 2,
      top: top + (height - contentHeight) / 2,
      width: contentWidth,
      height: contentHeight,
    });
  }

  function mapPointerToSurface(contentRect, event, surfaceWidth = SURFACE_WIDTH, surfaceHeight = SURFACE_HEIGHT) {
    const width = Number(contentRect?.width) || 0;
    const height = Number(contentRect?.height) || 0;
    const left = Number(contentRect?.left) || 0;
    const top = Number(contentRect?.top) || 0;
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (width <= 0 || height <= 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)
      || clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
    const x = Math.max(0, Math.min(surfaceWidth, (clientX - left) / width * surfaceWidth));
    const y = Math.max(0, Math.min(surfaceHeight, (clientY - top) / height * surfaceHeight));
    return Object.freeze({ x, y });
  }

  function modifierMask(event) {
    return (event?.altKey ? 1 : 0) | (event?.ctrlKey ? 2 : 0) | (event?.metaKey ? 4 : 0) | (event?.shiftKey ? 8 : 0);
  }

  function mouseButton(value) {
    if (value === "none" || value === "left" || value === "middle" || value === "right"
      || value === "back" || value === "forward") return value;
    return value === 0 ? "left" : value === 1 ? "middle" : value === 2 ? "right" : "none";
  }

  function createLocalDesktopView({ documentRef, windowRef, container } = {}) {
    if (!documentRef || typeof documentRef.createElement !== "function"
      || !windowRef || !container || typeof container.append !== "function") {
      throw new Error("OpenBot Desktop view is unavailable.");
    }
    const facade = windowRef.openbotLocalDesktop;
    const BlobClass = windowRef.Blob;
    const decodeBitmap = windowRef.createImageBitmap;
    if (!facade || typeof facade.select !== "function" || typeof facade.retry !== "function"
      || typeof facade.clear !== "function" || typeof facade.onFrame !== "function"
      || typeof facade.onStatus !== "function" || typeof BlobClass !== "function"
      || typeof decodeBitmap !== "function") throw new Error("OpenBot Desktop view is unavailable.");

    const surface = element(documentRef, "section", "openbot-local-desktop-view");
    surface.setAttribute("aria-label", "Desktop");
    const header = element(documentRef, "header", "openbot-local-desktop-view-header");
    const titleGroup = element(documentRef, "div", "openbot-local-desktop-view-title");
    const title = element(documentRef, "strong", "openbot-local-desktop-title", "Desktop");
    const subtitle = element(documentRef, "span", "openbot-local-desktop-subtitle", "Runs on this Mac");
    titleGroup.append(title, subtitle);
    const status = element(documentRef, "span", "openbot-local-desktop-view-status", "No Desktop selected");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const retry = element(documentRef, "button", "openbot-local-desktop-retry", "Retry");
    retry.type = "button";
    retry.hidden = true;
    retry.disabled = true;
    retry.setAttribute("aria-label", "Retry Desktop");
    const open = element(documentRef, "button", "openbot-local-desktop-open", "Open Desktop");
    open.type = "button";
    open.disabled = true;
    open.setAttribute("aria-label", "Open Desktop");
    const headerActions = element(documentRef, "div", "openbot-local-desktop-view-actions");
    headerActions.append(status, retry, open);
    header.append(titleGroup, headerActions);
    const viewport = element(documentRef, "div", "openbot-local-desktop-viewport");
    const previewCanvas = element(documentRef, "canvas", "openbot-local-desktop-preview-canvas");
    previewCanvas.width = PREVIEW_WIDTH;
    previewCanvas.height = PREVIEW_HEIGHT;
    previewCanvas.setAttribute("aria-label", "Passive Desktop preview");
    previewCanvas.tabIndex = -1;
    viewport.append(previewCanvas);
    surface.append(header, viewport);
    container.append(surface);
    const previewContext = previewCanvas.getContext("2d");
    if (!previewContext || typeof previewContext.clearRect !== "function" || typeof previewContext.drawImage !== "function") {
      surface.remove?.();
      throw new Error("OpenBot Desktop view is unavailable.");
    }

    const stage = element(documentRef, "section", "openbot-local-desktop-stage");
    stage.hidden = true;
    stage.setAttribute("role", "region");
    stage.setAttribute("aria-label", "Desktop interactive stage");
    stage.tabIndex = -1;
    const stageTopbar = element(documentRef, "header", "openbot-local-desktop-stage-topbar");
    const back = element(documentRef, "button", "openbot-local-desktop-back", "Back to View Bot");
    back.type = "button";
    back.setAttribute("aria-label", "Back to View Bot");
    const stageHeading = element(documentRef, "strong", "openbot-local-desktop-stage-title", "Desktop");
    stageHeading.id = "openbot-local-desktop-stage-title";
    stage.setAttribute("aria-labelledby", stageHeading.id);
    const stageStatus = element(documentRef, "span", "openbot-local-desktop-stage-status", "No Desktop selected");
    stageStatus.setAttribute("role", "status");
    stageStatus.setAttribute("aria-live", "polite");
    const stageIdentity = element(documentRef, "div", "openbot-local-desktop-stage-identity");
    stageIdentity.append(stageHeading, stageStatus);
    const toolbar = element(documentRef, "div", "openbot-local-desktop-stage-toolbar");
    const goBack = element(documentRef, "button", "openbot-local-desktop-go-back", "Back");
    const goForward = element(documentRef, "button", "openbot-local-desktop-go-forward", "Forward");
    const reload = element(documentRef, "button", "openbot-local-desktop-reload", "Reload");
    for (const button of [goBack, goForward, reload]) {
      button.type = "button";
      button.disabled = true;
    }
    const addressForm = element(documentRef, "form", "openbot-local-desktop-address-form");
    const address = element(documentRef, "input", "openbot-local-desktop-address");
    address.type = "url";
    address.inputMode = "url";
    address.autocomplete = "off";
    address.spellcheck = false;
    address.maxLength = 4096;
    address.setAttribute("aria-label", "Desktop address");
    addressForm.append(address);
    const addressError = element(documentRef, "span", "openbot-local-desktop-address-error", "");
    addressError.setAttribute("role", "alert");
    addressError.hidden = true;
    const fullScreen = element(documentRef, "button", "openbot-local-desktop-full-screen", "Full Screen");
    fullScreen.type = "button";
    const stageRetry = element(documentRef, "button", "openbot-local-desktop-stage-retry", "Retry");
    stageRetry.type = "button";
    stageRetry.hidden = true;
    stageRetry.disabled = true;
    const toolbarEnd = element(documentRef, "div", "openbot-local-desktop-stage-toolbar-end");
    toolbarEnd.append(fullScreen, stageRetry);
    toolbar.append(goBack, goForward, reload, addressForm, addressError, toolbarEnd);
    stageTopbar.append(back, stageIdentity, toolbar);
    const stageBody = element(documentRef, "div", "openbot-local-desktop-stage-body");
    const stageViewport = element(documentRef, "div", "openbot-local-desktop-stage-viewport");
    stageViewport.setAttribute("aria-label", "Desktop frame viewport");
    const stageCanvas = element(documentRef, "canvas", "openbot-local-desktop-stage-canvas");
    stageCanvas.width = INTERACTIVE_WIDTH;
    stageCanvas.height = INTERACTIVE_HEIGHT;
    stageCanvas.tabIndex = 0;
    stageCanvas.setAttribute("aria-label", "Interactive Desktop canvas. Use pointer, keyboard, or text input. Press Escape to release control or close Desktop.");
    stageViewport.append(stageCanvas);
    const stageFooter = element(documentRef, "div", "openbot-local-desktop-stage-footer");
    const controlState = element(documentRef, "span", "openbot-local-desktop-control-state", "View only");
    controlState.setAttribute("role", "status");
    controlState.setAttribute("aria-live", "polite");
    const sendEscape = element(documentRef, "button", "openbot-local-desktop-send-escape", "Send Escape");
    sendEscape.type = "button";
    stageFooter.append(controlState, sendEscape);
    stageBody.append(stageViewport, stageFooter);
    stage.append(stageTopbar, stageBody);
    (documentRef.body && typeof documentRef.body.append === "function" ? documentRef.body : container).append(stage);
    const stageContext = stageCanvas.getContext("2d");
    if (!stageContext || typeof stageContext.clearRect !== "function" || typeof stageContext.drawImage !== "function") {
      stage.remove?.();
      surface.remove?.();
      throw new Error("OpenBot Desktop view is unavailable.");
    }

    let disposed = false;
    let selectedBotId = null;
    let viewGeneration = 0;
    let target = null;
    let sessionGeneration = null;
    let pageGeneration = null;
    let sessionHandoff = null;
    let state = "none";
    let retryPending = false;
    let operationToken = 0;
    let decodeGeneration = 0;
    let currentFrame = null;
    let latestPreviewFrame = null;
    let lastPreviewSequence = 0;
    let desiredPresentation = "preview";
    let stageOpen = false;
    let presentationPending = false;
    let presentationKey = null;
    let presentationToken = 0;
    let controlGeneration = null;
    let controlFlight = null;
    let controlEpoch = 0;
    let inputSequence = 0;
    let inputQueue = Promise.resolve();
    let interactionToken = 0;
    let fullScreenState = false;
    let heldButtons = new Set();
    let heldKeys = new Map();
    let pointerButtons = new Map();
    let pendingPointerButtons = new Map();
    let pendingPointerReleases = new Set();
    let lastPointerPoints = new Map();
    let lastButtonPoints = new Map();
    let lastPointerUp = null;
    let navigationPending = false;
    let navigationToken = 0;
    let lifecycleCleanupFlight = null;

    function clearCanvas() {
      decodeGeneration += 1;
      target = null;
      sessionGeneration = null;
      pageGeneration = null;
      sessionHandoff = null;
      currentFrame = null;
      latestPreviewFrame = null;
      lastPreviewSequence = 0;
      presentationPending = false;
      inputSequence = 0;
      previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      stageContext.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
      heldKeys = new Map();
      pointerButtons = new Map();
      pendingPointerButtons = new Map();
      pendingPointerReleases = new Set();
      lastPointerPoints = new Map();
      lastButtonPoints = new Map();
    }

    function statusLabel(nextState) {
      return nextState === "connecting" ? "Connecting…"
        : nextState === "retrying" ? "Retrying…"
          : nextState === "live" ? "Live"
            : nextState === "unavailable" ? "Unavailable"
              : "No Desktop selected";
    }

    function setStatus(nextState) {
      state = nextState;
      const label = statusLabel(nextState);
      status.textContent = label;
      stageStatus.textContent = presentationPending && nextState === "live" ? "Connecting…" : label;
      if (surface.dataset) surface.dataset.state = nextState;
      if (stage.dataset) stage.dataset.state = nextState;
      retry.hidden = !selectedBotId || nextState !== "unavailable";
      retry.disabled = !selectedBotId || retryPending || nextState !== "unavailable";
      stageRetry.hidden = !selectedBotId || nextState !== "unavailable";
      stageRetry.disabled = !selectedBotId || retryPending || nextState !== "unavailable";
      open.disabled = !selectedBotId || !currentSession();
      const stagePending = stageOpen && presentationPending;
      const stageUnavailable = nextState !== "live";
      goBack.disabled = !selectedBotId || navigationPending || stagePending || stageUnavailable;
      goForward.disabled = !selectedBotId || navigationPending || stagePending || stageUnavailable;
      reload.disabled = !selectedBotId || navigationPending || stagePending || stageUnavailable;
      address.disabled = stagePending || navigationPending || stageUnavailable;
      fullScreen.disabled = stagePending || stageUnavailable;
      sendEscape.disabled = stagePending || stageUnavailable;
      stageCanvas.setAttribute("aria-busy", String(stagePending));
    }

    function currentSession() {
      const handoff = sessionHandoff;
      const nextTarget = handoff
        ? { targetId: handoff.targetId, targetGeneration: handoff.targetGeneration }
        : target;
      const nextSessionGeneration = handoff?.sessionGeneration ?? sessionGeneration;
      const nextPageGeneration = handoff?.pageGeneration ?? pageGeneration;
      const nextViewGeneration = handoff?.viewGeneration ?? viewGeneration;
      if (!selectedBotId || !nextTarget || !positive(nextSessionGeneration) || !positive(nextPageGeneration)) return null;
      return Object.freeze({
        botId: selectedBotId,
        targetId: nextTarget.targetId,
        targetGeneration: nextTarget.targetGeneration,
        sessionGeneration: nextSessionGeneration,
        pageGeneration: nextPageGeneration,
        viewGeneration: nextViewGeneration,
      });
    }

    function currentRichFrame() {
      return currentFrame?.rich && currentFrame.presentation === "interactive" ? currentFrame : null;
    }
    function currentOperation(botId, generation, token) {
      return !disposed && selectedBotId === botId && viewGeneration === generation && operationToken === token;
    }

    function invalidateInteraction() {
      interactionToken += 1;
      controlEpoch += 1;
      inputQueue = Promise.resolve();
      controlFlight = null;
      pendingPointerButtons = new Map();
      pendingPointerReleases = new Set();
    }

    function pointerIdentity(event, button = mouseButton(event?.button)) {
      return event?.pointerId !== undefined && event?.pointerId !== null
        ? event.pointerId : `button:${button}`;
    }

    function recordPointerAdmission(event, button) {
      const coordinate = mapPointerToSurface(stageContentRect(), event);
      if (!coordinate) return;
      const key = pointerIdentity(event, button);
      lastPointerPoints.set(key, coordinate);
      if (button !== "none") lastButtonPoints.set(button, coordinate);
    }

    function admittedPointerButton(event) {
      const button = mouseButton(event?.button);
      const key = pointerIdentity(event, button);
      return pointerButtons.get(event?.pointerId)
        || pendingPointerButtons.get(key)
        || (button !== "none" && heldButtons.has(button) ? button : null);
    }

    function currentEvent(token) {
      return !disposed && stageOpen && !navigationPending && state === "live"
        && token === interactionToken && desiredPresentation === "interactive";
    }

    function controlRequest() {
      const session = currentSession();
      return session ? Object.freeze({ ...session }) : null;
    }

    function releaseRequest(request, generation) {
      if (!request || !positive(generation)) return null;
      return Object.freeze({
        botId: request.botId,
        targetId: request.targetId,
        targetGeneration: request.targetGeneration,
        sessionGeneration: request.sessionGeneration,
        pageGeneration: request.pageGeneration,
        viewGeneration: request.viewGeneration,
        controlGeneration: generation,
      });
    }

    function applyControlState(active, label = null) {
      controlState.textContent = label || (active ? "Controlling Desktop" : "View only");
      stage.classList?.toggle?.("is-controlling", Boolean(active));
    }

    function applySelectionResult(value) {
      const next = exactSelection(value);
      if (!next || disposed || next.botId !== selectedBotId || next.viewGeneration !== viewGeneration) return null;
      const nextTarget = Object.freeze({ targetId: next.targetId, targetGeneration: next.targetGeneration });
      if (target && !sameTarget(target, nextTarget)) return null;
      target = nextTarget;
      sessionGeneration = next.sessionGeneration;
      pageGeneration = next.pageGeneration;
      sessionHandoff = next;
      retryPending = false;
      setStatus("live");
      return next;
    }

    function applyStatus(value) {
      const next = exactStatus(value);
      if (!next || disposed || next.botId !== selectedBotId || next.viewGeneration !== viewGeneration) return null;
      if (!next.rich && (desiredPresentation === "interactive"
        || currentFrame?.rich && currentFrame.presentation === "interactive"
        || sessionHandoff?.presentation === "interactive")) return null;
      const nextTarget = Object.freeze({ targetId: next.targetId, targetGeneration: next.targetGeneration });
      if (target && !sameTarget(target, nextTarget)) return null;
      if (!target) target = nextTarget;
      if (next.rich) {
        if (sessionGeneration !== null && next.sessionGeneration < sessionGeneration) return null;
        if (pageGeneration !== null && next.pageGeneration < pageGeneration) return null;
        if (next.presentation !== desiredPresentation) return null;
        const currentFrameId = currentFrame?.rich ? currentFrame.frameId : sessionHandoff?.frameId;
        const currentFrameSequence = currentFrame?.rich ? currentFrame.frameSequence : sessionHandoff?.frameSequence;
        if (positive(currentFrameSequence) && next.frameSequence < currentFrameSequence) return null;
        if (positive(currentFrameSequence) && next.frameSequence === currentFrameSequence && next.frameId !== currentFrameId) return null;
        if (pageGeneration !== null && next.pageGeneration > pageGeneration) {
          releaseControl();
          currentFrame = null;
        }
        sessionGeneration = next.sessionGeneration;
        pageGeneration = next.pageGeneration;
        inputSequence = Math.max(inputSequence, next.inputSequence);
        sessionHandoff = Object.freeze({
          botId: next.botId,
          targetId: next.targetId,
          targetGeneration: next.targetGeneration,
          sessionGeneration: next.sessionGeneration,
          pageGeneration: next.pageGeneration,
          viewGeneration: next.viewGeneration,
          frameId: next.frameId,
          frameSequence: next.frameSequence,
          inputSequence: next.inputSequence,
          presentation: next.presentation,
          state: next.state,
          code: next.code,
        });
      }
      retryPending = next.state === "retrying";
      setStatus(next.state);
      if (next.state === "live" && desiredPresentation === "interactive") layoutStage();
      return next;
    }

    function requestPresentation(presentation) {
      desiredPresentation = presentation;
      presentationPending = presentation === "interactive" && stageOpen && !currentRichFrame();
      const token = ++presentationToken;
      if (stageOpen) setStatus(state);
      const session = currentSession();
      if (typeof facade.presentation !== "function" || !session) {
        if (presentationPending) {
          presentationPending = false;
          setStatus("unavailable");
        }
        return Promise.resolve(null);
      }
      const key = `${session.botId}:${session.targetId}:${session.targetGeneration}:${session.sessionGeneration}:${session.pageGeneration}:${session.viewGeneration}:${presentation}`;
      if (presentationKey === key) return Promise.resolve(null);
      presentationKey = key;
      let operation;
      try { operation = facade.presentation(Object.freeze({ ...session, presentation })); }
      catch {
        if (presentationPending && stageOpen && desiredPresentation === presentation) {
          presentationPending = false;
          setStatus("unavailable");
        }
        return Promise.resolve(null);
      }
      return Promise.resolve(operation).then((value) => {
        if (disposed || token !== presentationToken || !currentSession() || desiredPresentation !== presentation) return null;
        const statusValue = exactStatus(value);
        if (statusValue) applyStatus(statusValue);
        return value;
      }, () => {
        if (!disposed && token === presentationToken && desiredPresentation === presentation) {
          presentationKey = null;
          if (presentationPending && stageOpen && presentation === "interactive") {
            presentationPending = false;
            setStatus("unavailable");
          } else if (!stageOpen && presentation === "preview") {
            setStatus("unavailable");
          }
        }
        return null;
      });
    }

    function failedCurrentOperation(botId, generation, token) {
      if (!currentOperation(botId, generation, token)) return;
      retryPending = false;
      setStatus("unavailable");
    }

    function selectBot(value) {
      if (disposed) return;
      if (stageOpen) closeStage({ fromSelection: true });
      navigationToken += 1;
      navigationPending = false;
      invalidateInteraction();
      releaseControl();
      viewGeneration += 1;
      operationToken += 1;
      selectedBotId = typeof value === "string" && BOT_ID.test(value) ? value : null;
      retryPending = false;
      presentationToken += 1;
      presentationKey = null;
      clearCanvas();
      setStatus(selectedBotId ? "connecting" : "none");
      const botId = selectedBotId;
      const generation = viewGeneration;
      const token = operationToken;
      const startSelection = () => {
        if (!currentOperation(botId, generation, token)) return;
        let operation;
        try {
          operation = botId
            ? facade.select(Object.freeze({ botId, viewGeneration: generation }))
            : facade.clear(Object.freeze({ viewGeneration: generation }));
        } catch {
          failedCurrentOperation(botId, generation, token);
          return;
        }
        void Promise.resolve(operation).then((valueResult) => {
          if (!currentOperation(botId, generation, token) || !valueResult) return;
          applySelectionResult(valueResult) || applyStatus(valueResult);
        }, () => failedCurrentOperation(botId, generation, token));
      };
      const cleanup = lifecycleCleanupFlight;
      if (cleanup) void Promise.resolve(cleanup).then(startSelection, startSelection);
      else startSelection();
    }

    function retrySelectedBot() {
      if (disposed || !selectedBotId || state !== "unavailable" || retryPending) return;
      navigationToken += 1;
      navigationPending = false;
      invalidateInteraction();
      releaseControl();
      viewGeneration += 1;
      operationToken += 1;
      retryPending = true;
      presentationToken += 1;
      presentationKey = null;
      clearCanvas();
      setStatus("retrying");
      const botId = selectedBotId;
      const generation = viewGeneration;
      const token = operationToken;
      const startRetry = () => {
        if (!currentOperation(botId, generation, token)) return;
        let operation;
        try { operation = facade.retry(Object.freeze({ botId, viewGeneration: generation })); }
        catch {
          failedCurrentOperation(botId, generation, token);
          return;
        }
        void Promise.resolve(operation).then((valueResult) => {
          if (!currentOperation(botId, generation, token) || !valueResult) return;
          applySelectionResult(valueResult) || applyStatus(valueResult);
          if (stageOpen) void requestPresentation("interactive");
        }, () => failedCurrentOperation(botId, generation, token));
      };
      const cleanup = lifecycleCleanupFlight;
      if (cleanup) void Promise.resolve(cleanup).then(startRetry, startRetry);
      else startRetry();
    }

    function currentFrameForEvent(value) {
      if (disposed || value.botId !== selectedBotId || value.viewGeneration !== viewGeneration) return null;
      const nextTarget = Object.freeze({ targetId: value.targetId, targetGeneration: value.targetGeneration });
      if (target && !sameTarget(target, nextTarget)) return null;
      if (!target) target = nextTarget;
      if (value.rich) {
        if (value.presentation !== desiredPresentation
          && !(stageOpen && desiredPresentation === "interactive" && value.presentation === "preview" && !currentSession())) return null;
        if (sessionGeneration !== null && value.sessionGeneration < sessionGeneration) return null;
        if (pageGeneration !== null && value.pageGeneration < pageGeneration) return null;
        if (currentFrame?.rich && value.sessionGeneration === sessionGeneration
          && value.pageGeneration === pageGeneration
          && value.frameSequence <= currentFrame.frameSequence) return null;
        if (pageGeneration !== null && value.pageGeneration > pageGeneration) {
          releaseControl();
          currentFrame = null;
        }
        sessionGeneration = value.sessionGeneration;
        pageGeneration = value.pageGeneration;
        sessionHandoff = Object.freeze({
          botId: value.botId,
          targetId: value.targetId,
          targetGeneration: value.targetGeneration,
          sessionGeneration: value.sessionGeneration,
          pageGeneration: value.pageGeneration,
          viewGeneration: value.viewGeneration,
          frameId: value.frameId,
          frameSequence: value.frameSequence,
          inputSequence: value.inputSequence,
          presentation: value.presentation,
          state: "live",
          code: null,
        });
      } else {
        if (desiredPresentation !== "preview") return null;
        if (value.sequence <= lastPreviewSequence) return null;
        lastPreviewSequence = value.sequence;
      }
      return value;
    }

    function drawBitmap(bitmap, value) {
      previewCanvas.width = value.width;
      previewCanvas.height = value.height;
      previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      previewContext.drawImage(bitmap, 0, 0, value.width, value.height);
      if (value.rich && value.presentation === "interactive" && stageOpen) {
        stageCanvas.width = value.width;
        stageCanvas.height = value.height;
        stageContext.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
        stageContext.drawImage(bitmap, 0, 0, value.width, value.height);
      }
    }

    async function onFrame(value) {
      if (disposed) return;
      const frame = exactFrame(value);
      if (!frame) return;
      const current = currentFrameForEvent(frame);
      if (!current) return;
      if (frame.rich) currentFrame = frame;
      else latestPreviewFrame = frame;
      decodeGeneration += 1;
      const pendingGeneration = decodeGeneration;
      let bitmap;
      try {
        bitmap = await decodeBitmap(new BlobClass([frame.bytes], { type: "image/png" }));
        if (disposed || pendingGeneration !== decodeGeneration || !selectedBotId
          || frame.viewGeneration !== viewGeneration || !sameTarget(target, { targetId: frame.targetId, targetGeneration: frame.targetGeneration })
          || (frame.rich ? currentFrame !== frame : latestPreviewFrame !== frame)
          || (frame.rich && frame.presentation !== desiredPresentation)) return;
        drawBitmap(bitmap, frame);
        if (stageOpen && frame.rich && frame.presentation === "interactive") presentationPending = false;
        setStatus("live");
        if (stageOpen && frame.rich && frame.presentation === "interactive") layoutStage();
        if (stageOpen && frame.rich && frame.presentation === "preview" && desiredPresentation === "interactive") {
          void requestPresentation("interactive");
        }
      } catch {
        if (!disposed && pendingGeneration === decodeGeneration) {
          retryPending = false;
          setStatus("unavailable");
        }
      } finally {
        try { bitmap?.close?.(); } catch {}
      }
    }

    function stageViewportRect() {
      const candidate = stageCanvas.getBoundingClientRect?.();
      if (candidate && Number(candidate.width) > 0 && Number(candidate.height) > 0) return candidate;
      return stageViewport.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    }

    function layoutStage() {
      const viewportRect = stageViewport.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
      const content = computeLetterbox(viewportRect, SURFACE_WIDTH, SURFACE_HEIGHT);
      stageCanvas.style.width = `${content.width}px`;
      stageCanvas.style.height = `${content.height}px`;
      stageCanvas.dataset.contentLeft = String(content.left);
      stageCanvas.dataset.contentTop = String(content.top);
      stageCanvas.dataset.contentWidth = String(content.width);
      stageCanvas.dataset.contentHeight = String(content.height);
      return content;
    }

    function stageContentRect() {
      const candidate = stageViewportRect();
      if (candidate && Number(candidate.width) > 0 && Number(candidate.height) > 0) return candidate;
      const dataWidth = Number(stageCanvas.dataset.contentWidth);
      const dataHeight = Number(stageCanvas.dataset.contentHeight);
      if (Number.isFinite(dataWidth) && dataWidth > 0 && Number.isFinite(dataHeight) && dataHeight > 0) {
        return {
          left: Number(stageCanvas.dataset.contentLeft) || candidate.left || 0,
          top: Number(stageCanvas.dataset.contentTop) || candidate.top || 0,
          width: dataWidth,
          height: dataHeight,
        };
      }
      return computeLetterbox(candidate, SURFACE_WIDTH, SURFACE_HEIGHT);
    }

    function ensureControl(token) {
      if (!currentEvent(token) || !currentRichFrame()) return Promise.reject(new Error("Desktop control unavailable."));
      if (lifecycleCleanupFlight) return lifecycleCleanupFlight.then(() => ensureControl(token));
      if (controlGeneration !== null) return Promise.resolve(controlGeneration);
      if (controlFlight) return controlFlight;
      const request = controlRequest();
      const epoch = controlEpoch;
      if (!request || typeof facade.acquireControl !== "function") return Promise.reject(new Error("Desktop control unavailable."));
      let operation;
      try { operation = facade.acquireControl(Object.freeze({ ...request })); }
      catch (error) { return Promise.reject(error); }
      const flight = Promise.resolve(operation).then((value) => {
        const ack = exactControlAck(value);
        const frame = currentRichFrame();
        const expected = frame ? Object.freeze({ ...request, frameId: frame.frameId, frameSequence: frame.frameSequence }) : null;
        const matchesFrame = Boolean(ack && expected && sameCurrent(ack, expected, true));
        if (!ack || !matchesFrame) {
          const error = new Error("Desktop control became stale.");
          error.code = "OPENBOT_DESKTOP_STALE";
          if (ack) {
            try { void Promise.resolve(facade.releaseControl(releaseRequest(ack, ack.controlGeneration))).catch(() => {}); } catch {}
          }
          throw error;
        }
        if (currentEvent(token) && epoch === controlEpoch) {
          controlGeneration = ack.controlGeneration;
          inputSequence = Math.max(inputSequence, ack.inputSequence);
          applyControlState(true);
          return controlGeneration;
        }
        try {
          void Promise.resolve(facade.releaseControl(releaseRequest(ack, ack.controlGeneration))).catch(() => {});
        } catch {}
        const error = new Error("Desktop control became stale.");
        error.code = "OPENBOT_DESKTOP_STALE";
        throw error;
      }).finally(() => {
        if (controlFlight === flight) controlFlight = null;
      });
      controlFlight = flight;
      return flight;
    }

    function releaseControl() {
      const generation = controlGeneration;
      const request = controlRequest();
      controlGeneration = null;
      const frame = currentRichFrame();
      const heldButtonValues = [...heldButtons].map((button) => Object.freeze({
        button,
        point: lastButtonPoints.get(button) || null,
      }));
      const heldKeyValues = [...heldKeys.values()];
      heldButtons = new Set();
      heldKeys = new Map();
      pointerButtons = new Map();
      pendingPointerButtons = new Map();
      pendingPointerReleases = new Set();
      lastPointerPoints = new Map();
      lastButtonPoints = new Map();
      applyControlState(false);
      if (generation === null || !request || typeof facade.releaseControl !== "function") {
        return lifecycleCleanupFlight;
      }
      const snapshot = frame ? Object.freeze({ ...request, frameId: frame.frameId, frameSequence: frame.frameSequence }) : null;
      const cleanup = (async () => {
        let cleanupInputSequence = inputSequence;
        if (snapshot && typeof facade.sendInput === "function") {
          for (const held of heldButtonValues) {
            try {
              const releaseInput = Object.freeze({
                ...snapshot,
                inputSequence: ++cleanupInputSequence,
                controlGeneration: generation,
                type: "mouseReleased",
                x: held.point?.x ?? 0,
                y: held.point?.y ?? 0,
                button: held.button,
                buttons: 0,
                clickCount: 0,
                modifiers: 0,
                coordinateSpace: "css-dip",
                deviceScaleFactor: 1,
              });
              const result = await facade.sendInput(releaseInput);
              const ack = exactInputAck(result);
              if (ack && sameCurrent(ack, releaseInput, true) && ack.inputSequence === releaseInput.inputSequence) {
                cleanupInputSequence = ack.inputSequence;
              }
            } catch {}
          }
          for (const key of heldKeyValues) {
            try {
              const releaseInput = Object.freeze({
                ...snapshot,
                inputSequence: ++cleanupInputSequence,
                controlGeneration: generation,
                type: "keyUp",
                key: key.key,
                code: key.code,
                modifiers: key.modifiers,
                autoRepeat: false,
                isKeypad: Boolean(key.isKeypad),
                isSystemKey: Boolean(key.isSystemKey),
                location: Number.isSafeInteger(key.location) ? key.location : 0,
              });
              const result = await facade.sendInput(releaseInput);
              const ack = exactInputAck(result);
              if (ack && sameCurrent(ack, releaseInput, true) && ack.inputSequence === releaseInput.inputSequence) {
                cleanupInputSequence = ack.inputSequence;
              }
            } catch {}
          }
        }
        const release = releaseRequest(request, generation);
        if (!release) return;
        try {
          const value = await facade.releaseControl(release);
          const ack = exactReleaseAck(value);
          const expectedAck = snapshot ? Object.freeze({
            ...request,
            frameId: snapshot.frameId,
            frameSequence: snapshot.frameSequence,
          }) : request;
          if (ack && sameCurrent(ack, expectedAck, Boolean(snapshot))) cleanupInputSequence = Math.max(cleanupInputSequence, ack.inputSequence);
        } catch {}
        const activeSession = currentSession();
        if (activeSession && sameCurrent(activeSession, request)) {
          inputSequence = Math.max(inputSequence, cleanupInputSequence);
        }
      })();
      lifecycleCleanupFlight = cleanup;
      void cleanup.finally(() => {
        if (lifecycleCleanupFlight === cleanup) lifecycleCleanupFlight = null;
      });
      return cleanup;
    }

    function enqueueInput(token, makeInput) {
      const work = async () => {
        if (!currentEvent(token)) return;
        await ensureControl(token);
        if (!currentEvent(token) || !currentRichFrame()) return;
        const frame = currentRichFrame();
        const input = makeInput(frame);
        if (!input) return;
        const request = Object.freeze({
          botId: selectedBotId,
          targetId: target.targetId,
          targetGeneration: target.targetGeneration,
          sessionGeneration,
          pageGeneration,
          viewGeneration,
          frameId: frame.frameId,
          frameSequence: frame.frameSequence,
          inputSequence: ++inputSequence,
          controlGeneration,
          ...input,
        });
        if (typeof facade.sendInput !== "function") return;
        let result;
        try { result = await facade.sendInput(request); }
        catch {
          reconcileInputFailure(input);
          releaseControl();
          if (currentEvent(token)) applyControlState(false, "Control unavailable");
          return;
        }
        const ack = exactInputAck(result);
        if (!ack || !sameCurrent(ack, request, true) || ack.inputSequence !== request.inputSequence) return;
        inputSequence = ack.inputSequence;
      };
      inputQueue = inputQueue.then(work, work).catch(() => undefined);
      return inputQueue;
    }

    function heldKeyId(key, code) {
      return `${code || ""}\0${key || ""}`;
    }

    function reconcileInputFailure(input) {
      if (!input) return;
      if (input.type === "keyDown") {
        heldKeys.delete(heldKeyId(input.key, input.code));
        return;
      }
      if (input.type === "keyUp") {
        heldKeys.set(heldKeyId(input.key, input.code), {
          key: input.key,
          code: input.code,
          modifiers: input.modifiers,
          isKeypad: input.isKeypad,
          isSystemKey: input.isSystemKey,
          location: input.location,
        });
        return;
      }
      if (input.type !== "mousePressed" && input.type !== "mouseReleased") return;
      const button = mouseButton(input.button);
      if (input.type === "mousePressed") {
        heldButtons.delete(button);
        lastButtonPoints.delete(button);
        for (const [pointerKey, pendingButton] of pendingPointerButtons) {
          if (pendingButton === button) pendingPointerButtons.delete(pointerKey);
        }
        pendingPointerReleases = new Set();
        for (const [pointerId, pointerButton] of pointerButtons) {
          if (pointerButton === button) {
            pointerButtons.delete(pointerId);
            lastPointerPoints.delete(pointerId);
          }
        }
        return;
      }
      heldButtons.add(button);
      lastButtonPoints.set(button, Object.freeze({ x: input.x, y: input.y }));
    }

    function pointerInput(event, type) {
      const button = mouseButton(event.button);
      const pointerKey = pointerIdentity(event, button);
      let coordinate = mapPointerToSurface(stageContentRect(), event);
      if (!coordinate && type === "mouseReleased") {
        coordinate = lastPointerPoints.get(pointerKey) || lastButtonPoints.get(button) || null;
      }
      if (!coordinate) return null;
      if (type === "mousePressed" || type === "mouseMoved") {
        lastPointerPoints.set(pointerKey, coordinate);
        const trackedButton = button !== "none"
          ? button : pointerButtons.get(event.pointerId);
        if (trackedButton && trackedButton !== "none") lastButtonPoints.set(trackedButton, coordinate);
      }
      if (type === "mousePressed") {
        pendingPointerButtons.delete(pointerKey);
        pendingPointerReleases.delete(pointerKey);
        heldButtons.add(button);
        if (event.pointerId !== undefined) pointerButtons.set(event.pointerId, button);
      }
      if (type === "mouseReleased") {
        pendingPointerButtons.delete(pointerKey);
        pendingPointerReleases.delete(pointerKey);
        if (event.pointerId !== undefined) pointerButtons.delete(event.pointerId);
        if (![...pointerButtons.values()].includes(button)) {
          heldButtons.delete(button);
          lastButtonPoints.delete(button);
        }
        lastPointerPoints.delete(pointerKey);
      }
      return {
        type,
        x: coordinate.x,
        y: coordinate.y,
        button,
        buttons: Number.isSafeInteger(event.buttons) ? event.buttons : 0,
        clickCount: Number.isSafeInteger(event.detail) ? event.detail : 0,
        modifiers: modifierMask(event),
        coordinateSpace: "css-dip",
        deviceScaleFactor: 1,
      };
    }

    function keyInput(event, type) {
      if (typeof event.key !== "string" && typeof event.code !== "string") return null;
      return {
        type,
        key: typeof event.key === "string" ? event.key : undefined,
        code: typeof event.code === "string" ? event.code : undefined,
        text: type === "keyDown" && typeof event.key === "string" && event.key.length === 1 ? event.key : undefined,
        unmodifiedText: type === "keyDown" && typeof event.key === "string" && event.key.length === 1 ? event.key : undefined,
        modifiers: modifierMask(event),
        autoRepeat: Boolean(event.repeat),
        isKeypad: Boolean(event.keyLocation === 3),
        isSystemKey: false,
        location: Number.isSafeInteger(event.location) ? event.location : 0,
      };
    }

    function sendEscapeToDesktop() {
      const token = interactionToken;
      enqueueInput(token, () => ({
        type: "keyDown", key: "Escape", code: "Escape", modifiers: 0, autoRepeat: false,
        isKeypad: false, isSystemKey: false, location: 0,
      }));
      enqueueInput(token, () => ({
        type: "keyUp", key: "Escape", code: "Escape", modifiers: 0, autoRepeat: false,
        isKeypad: false, isSystemKey: false, location: 0,
      }));
    }

    function leaveFullScreen() {
      fullScreenState = false;
      stage.classList?.remove?.("is-browser-fullscreen");
      try { documentRef.exitFullscreen?.(); } catch {}
    }

    function handleEscape(event) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (fullScreenState) leaveFullScreen();
      else if (controlGeneration !== null) releaseControl();
      else closeStage();
    }

    function enterFullScreen() {
      fullScreenState = true;
      stage.classList?.add?.("is-browser-fullscreen");
      try { void Promise.resolve(stage.requestFullscreen?.()).catch(() => {}); } catch {}
    }

    function invalidateInteractivePresentation() {
      decodeGeneration += 1;
      currentFrame = null;
      stageContext.clearRect(0, 0, stageCanvas.width, stageCanvas.height);
      if (sessionHandoff?.presentation === "interactive") {
        sessionHandoff = Object.freeze({
          ...sessionHandoff,
          frameId: null,
          frameSequence: 0,
          presentation: "preview",
        });
      }
    }

    function openStage() {
      if (disposed || !selectedBotId || !currentSession()) return;
      stageOpen = true;
      desiredPresentation = "interactive";
      presentationPending = !currentRichFrame();
      presentationKey = null;
      stage.hidden = false;
      stage.setAttribute("aria-hidden", "false");
      setStatus(state);
      stage.focus?.();
      layoutStage();
      if (currentSession()) void requestPresentation("interactive");
    }

    function closeStage({ fromSelection = false, skipPresentation = false } = {}) {
      if (!stageOpen && stage.hidden) return;
      navigationToken += 1;
      navigationPending = false;
      stageOpen = false;
      desiredPresentation = "preview";
      presentationPending = false;
      presentationToken += 1;
      presentationKey = null;
      const cleanup = releaseControl();
      invalidateInteractivePresentation();
      invalidateInteraction();
      if (fullScreenState) leaveFullScreen();
      stage.hidden = true;
      stage.setAttribute("aria-hidden", "true");
      if (!fromSelection) open.focus?.();
      if (!fromSelection && !skipPresentation) {
        void Promise.resolve(cleanup).then(() => {
          if (!disposed && !stageOpen && desiredPresentation === "preview" && currentSession()) {
            void requestPresentation("preview");
          }
        });
      }
    }

    function privateAddress(hostname) {
      const address = hostname.startsWith("[") && hostname.endsWith("]")
        ? hostname.slice(1, -1) : hostname;
      const ipv4 = address.split(".");
      if (ipv4.length === 4 && ipv4.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part))) {
        const octets = ipv4.map(Number);
        if (octets.every((octet) => octet >= 0 && octet <= 255)) {
          const [a, b] = octets;
          if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
        }
      }
      const ipv6 = address.toLowerCase();
      if (!ipv6.includes(":")) return false;
      const mapped = /^::ffff:(?:([0-9]{1,3}(?:\.[0-9]{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ipv6);
      if (mapped) {
        const mappedAddress = mapped[1] || (() => {
          const high = Number.parseInt(mapped[2], 16);
          const low = Number.parseInt(mapped[3], 16);
          return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
        })();
        return privateAddress(mappedAddress);
      }
      return ipv6 === "::1" || ipv6 === "::" || /^f[cd]/i.test(ipv6) || /^fe[89ab]/i.test(ipv6);
    }

    function validateAddress(value) {
      if (typeof value !== "string" || value.length === 0 || textByteLength(value) > 4096 || value.includes("\0")) return false;
      try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase();
        const comparableHostname = hostname.replace(/\.+$/, "");
        return parsed.protocol === "https:" && !parsed.username && !parsed.password && Boolean(hostname)
          && comparableHostname !== "localhost" && !comparableHostname.endsWith(".localhost")
          && !privateAddress(comparableHostname);
      } catch { return false; }
    }

    function setAddressError(message) {
      addressError.textContent = message;
      addressError.hidden = !message;
    }

    function applyNavigation(value, expectedToken = null, expectedAction = null) {
      const next = exactNavigation(value);
      const session = currentSession();
      if (!next || (expectedToken !== null && expectedToken !== navigationToken) || !session
        || (expectedAction !== null && next.action !== expectedAction)
        || next.botId !== session.botId || next.targetId !== session.targetId
        || next.targetGeneration !== session.targetGeneration || next.sessionGeneration !== session.sessionGeneration
        || next.viewGeneration !== session.viewGeneration
        || (next.action === "navigate" ? next.url === null || !validateAddress(next.url) : next.url !== null)) return null;
      if (next.pageGeneration <= pageGeneration) return null;
      releaseControl();
      pageGeneration = next.pageGeneration;
      inputSequence = Math.max(inputSequence, next.inputSequence);
      currentFrame = null;
      if (sessionHandoff) {
        sessionHandoff = Object.freeze({
          ...sessionHandoff,
          pageGeneration: next.pageGeneration,
          frameId: next.frameId,
          frameSequence: next.frameSequence,
          inputSequence: next.inputSequence,
        });
      }
      address.value = next.url ?? "";
      navigationPending = false;
      setAddressError("");
      setStatus("connecting");
      return next;
    }

    function navigate(action, value = null) {
      const session = currentSession();
      if (!session || navigationPending) return;
      const token = ++navigationToken;
      navigationPending = true;
      invalidateInteraction();
      const cleanup = releaseControl();
      setStatus("connecting");
      const request = action === "navigate"
        ? Object.freeze({ ...session, url: value })
        : Object.freeze({ ...session });
      const startNavigation = () => {
        if (disposed || token !== navigationToken) return;
        let operation;
        try { operation = facade[action]?.(request); }
        catch { navigationPending = false; setStatus("unavailable"); return; }
        void Promise.resolve(operation).then((result) => {
          if (disposed) return;
          const applied = applyNavigation(result, token, action);
          if (!applied && token === navigationToken) {
            navigationPending = false;
            setStatus("unavailable");
          }
        }, () => {
          if (!disposed && token === navigationToken) {
            navigationPending = false;
            setStatus("unavailable");
          }
        });
      };
      void Promise.resolve(cleanup).then(startNavigation, startNavigation);
    }

    function submitAddress(event) {
      event.preventDefault?.();
      const value = String(address.value ?? "");
      if (!validateAddress(value)) {
        setAddressError("Use a public HTTPS address without credentials.");
        return;
      }
      setAddressError("");
      navigate("navigate", value);
    }

    function onCanvasPointerDown(event) {
      event.preventDefault?.();
      stageCanvas.setPointerCapture?.(event.pointerId);
      const button = mouseButton(event.button);
      const key = pointerIdentity(event, button);
      if (button !== "none") {
        pendingPointerButtons.set(key, button);
        if (event.pointerId !== undefined && event.pointerId !== null) pointerButtons.set(event.pointerId, button);
        recordPointerAdmission(event, button);
      }
      enqueueInput(interactionToken, () => pointerInput(event, "mousePressed"));
    }

    function onCanvasPointerMove(event) {
      event.preventDefault?.();
      const button = mouseButton(event.button);
      const key = pointerIdentity(event, button);
      recordPointerAdmission(event, pendingPointerButtons.get(key) || admittedPointerButton(event) || button);
      enqueueInput(interactionToken, () => pointerInput(event, "mouseMoved"));
    }

    function queuePointerRelease(event) {
      const button = admittedPointerButton(event);
      if (!button || button === "none") return;
      const key = pointerIdentity(event, button);
      if (pendingPointerReleases.has(key)) return;
      pendingPointerReleases.add(key);
      const releaseEvent = { ...event, button };
      enqueueInput(interactionToken, () => pointerInput(releaseEvent, "mouseReleased"));
    }

    function onCanvasPointerUp(event) {
      event.preventDefault?.();
      stageCanvas.releasePointerCapture?.(event.pointerId);
      lastPointerUp = { clientX: event.clientX, clientY: event.clientY, detail: event.detail, at: Date.now() };
      queuePointerRelease(event);
    }

    function onCanvasPointerCancel(event) {
      event.preventDefault?.();
      queuePointerRelease({
        ...event,
        buttons: 0,
      });
    }

    function onCanvasDoubleClick(event) {
      if (event.detail !== 2 || heldButtons.size) return;
      if (lastPointerUp && lastPointerUp.detail === 2 && Date.now() - lastPointerUp.at < 400
        && lastPointerUp.clientX === event.clientX && lastPointerUp.clientY === event.clientY) return;
      event.preventDefault?.();
      const point = {
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button ?? 0,
        buttons: 1,
        detail: 2,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      };
      enqueueInput(interactionToken, () => pointerInput(point, "mousePressed"));
      enqueueInput(interactionToken, () => pointerInput({ ...point, buttons: 0 }, "mouseReleased"));
    }

    function onCanvasClick(event) {
      if (lastPointerUp && Date.now() - lastPointerUp.at < 400
        && lastPointerUp.clientX === event.clientX && lastPointerUp.clientY === event.clientY) return;
      event.preventDefault?.();
      const point = {
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button ?? 0,
        buttons: 1,
        detail: event.detail || 1,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      };
      enqueueInput(interactionToken, () => pointerInput(point, "mousePressed"));
      enqueueInput(interactionToken, () => pointerInput({ ...point, buttons: 0 }, "mouseReleased"));
    }

    function onCanvasWheel(event) {
      event.preventDefault?.();
      enqueueInput(interactionToken, () => {
        const base = pointerInput(event, "mouseWheel");
        return base ? { ...base, button: "none", deltaX: Number(event.deltaX) || 0, deltaY: Number(event.deltaY) || 0 } : null;
      });
    }

    function onCanvasKeyDown(event) {
      if (event.key === "Escape") return handleEscape(event);
      if (isPasteShortcut(event)) return;
      event.preventDefault?.();
      const keyId = heldKeyId(event.key, event.code);
      heldKeys.set(keyId, {
        key: event.key,
        code: event.code,
        modifiers: modifierMask(event),
        isKeypad: event.keyLocation === 3,
        isSystemKey: false,
        location: event.location,
      });
      enqueueInput(interactionToken, () => keyInput(event, "keyDown"));
    }

    function onCanvasKeyUp(event) {
      if (event.key === "Escape") return;
      if (isPasteShortcut(event)) return;
      event.preventDefault?.();
      heldKeys.delete(heldKeyId(event.key, event.code));
      enqueueInput(interactionToken, () => keyInput(event, "keyUp"));
    }

    function isPasteShortcut(event) {
      return Boolean(event?.metaKey || event?.ctrlKey)
        && typeof event?.key === "string" && event.key.toLowerCase() === "v";
    }

    function textByteLength(value) {
      try {
        if (typeof TextEncoder === "function") return new TextEncoder().encode(value).byteLength;
      } catch {}
      return unescape(encodeURIComponent(value)).length;
    }

    function pasteInput(event) {
      let text = typeof event.data === "string" ? event.data : null;
      if (text === null) {
        try {
          text = typeof event.clipboardData?.getData === "function"
            ? event.clipboardData.getData("text/plain") : null;
        } catch { text = null; }
      }
      if (typeof text !== "string" || text.length === 0 || textByteLength(text) > 64 * 1024) return;
      event.preventDefault?.();
      enqueueInput(interactionToken, () => ({ type: "insertText", text }));
    }

    function textInput(event) {
      if (event.type === "paste") return pasteInput(event);
      if (event.inputType === "insertFromPaste") return;
      const text = typeof event.data === "string" ? event.data : (typeof event.text === "string" ? event.text : null);
      if (typeof text !== "string" || text.length === 0 || textByteLength(text) > 64 * 1024) return;
      event.preventDefault?.();
      enqueueInput(interactionToken, () => ({ type: "insertText", text }));
    }

    function compositionInput(event) {
      const text = typeof event.data === "string" ? event.data : "";
      event.preventDefault?.();
      enqueueInput(interactionToken, () => ({ type: "imeSetComposition", text, selectionStart: 0, selectionEnd: text.length }));
    }

    function onCanvasFocus() {
      if (stageOpen) {
        controlEpoch += 1;
        const epoch = controlEpoch;
        void ensureControl(interactionToken).catch((error) => {
          if (epoch === controlEpoch && stageOpen && error?.code !== "OPENBOT_DESKTOP_STALE") {
            applyControlState(false, "Control unavailable");
          }
        });
      }
    }

    function onCanvasBlur() {
      interactionToken += 1;
      controlEpoch += 1;
      inputQueue = Promise.resolve();
      controlFlight = null;
      releaseControl();
    }
    function onStageKeyDown(event) { if (event.key === "Escape") handleEscape(event); }
    const onResize = () => { if (stageOpen) layoutStage(); };
    const onFullscreenChange = () => {
      fullScreenState = documentRef.fullscreenElement === stage;
      stage.classList?.toggle?.("is-browser-fullscreen", fullScreenState);
    };

    retry.addEventListener?.("click", retrySelectedBot);
    stageRetry.addEventListener?.("click", retrySelectedBot);
    open.addEventListener?.("click", openStage);
    back.addEventListener?.("click", () => closeStage());
    fullScreen.addEventListener?.("click", () => fullScreenState ? leaveFullScreen() : enterFullScreen());
    sendEscape.addEventListener?.("click", sendEscapeToDesktop);
    goBack.addEventListener?.("click", () => navigate("goBack"));
    goForward.addEventListener?.("click", () => navigate("goForward"));
    reload.addEventListener?.("click", () => navigate("reload"));
    addressForm.addEventListener?.("submit", submitAddress);
    stage.addEventListener?.("keydown", onStageKeyDown);
    stageCanvas.addEventListener?.("pointerdown", onCanvasPointerDown);
    stageCanvas.addEventListener?.("pointermove", onCanvasPointerMove);
    stageCanvas.addEventListener?.("pointerup", onCanvasPointerUp);
    stageCanvas.addEventListener?.("pointercancel", onCanvasPointerCancel);
    stageCanvas.addEventListener?.("click", onCanvasClick);
    stageCanvas.addEventListener?.("dblclick", onCanvasDoubleClick);
    stageCanvas.addEventListener?.("wheel", onCanvasWheel, { passive: false });
    stageCanvas.addEventListener?.("keydown", onCanvasKeyDown);
    stageCanvas.addEventListener?.("keyup", onCanvasKeyUp);
    stageCanvas.addEventListener?.("beforeinput", textInput);
    stageCanvas.addEventListener?.("paste", textInput);
    stageCanvas.addEventListener?.("compositionstart", compositionInput);
    stageCanvas.addEventListener?.("compositionupdate", compositionInput);
    stageCanvas.addEventListener?.("compositionend", compositionInput);
    stageCanvas.addEventListener?.("focus", onCanvasFocus);
    stageCanvas.addEventListener?.("blur", onCanvasBlur);
    windowRef.addEventListener?.("resize", onResize);
    documentRef.addEventListener?.("fullscreenchange", onFullscreenChange);

    const stopFrames = facade.onFrame(onFrame);
    const stopStatus = facade.onStatus(applyStatus);
    const stopNavigation = typeof facade.onNavigation === "function" ? facade.onNavigation(applyNavigation) : () => {};
    const stopComputer = typeof windowRef.openbotComputer?.onChanged === "function"
      ? windowRef.openbotComputer.onChanged((value) => {
        if (disposed) return;
        if (value?.botId === selectedBotId) selectBot(selectedBotId);
        else if (!value && selectedBotId) selectBot(null);
      }) : () => {};

    return Object.freeze({
      canvas: previewCanvas,
      stageCanvas,
      stage,
      selectBot,
      retry: retrySelectedBot,
      openDesktop: openStage,
      closeDesktop: closeStage,
      dispose() {
        if (disposed) return;
        disposed = true;
        presentationToken += 1;
        navigationToken += 1;
        navigationPending = false;
        operationToken += 1;
        viewGeneration += 1;
        invalidateInteraction();
        releaseControl();
        selectedBotId = null;
        clearCanvas();
        setStatus("none");
        try { stopFrames?.(); } catch {}
        try { stopStatus?.(); } catch {}
        try { stopNavigation?.(); } catch {}
        try { stopComputer?.(); } catch {}
        windowRef.removeEventListener?.("resize", onResize);
        documentRef.removeEventListener?.("fullscreenchange", onFullscreenChange);
        const cleanup = lifecycleCleanupFlight || Promise.resolve();
        const clear = () => {
          try { return facade.clear(Object.freeze({ viewGeneration })); } catch { return null; }
        };
        if (lifecycleCleanupFlight) void Promise.resolve(cleanup).then(clear, () => null).catch(() => {});
        else void Promise.resolve(clear()).catch(() => {});
        stage.remove?.();
        surface.remove?.();
      },
    });
  }

  return Object.freeze({ computeLetterbox, createLocalDesktopView, mapPointerToSurface });
});
