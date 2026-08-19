(function exposeOpenBotLocalDesktopView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpenBotLocalDesktopView = api;
})(typeof window === "object" ? window : null, function createOpenBotLocalDesktopViewApi() {
  "use strict";

  const BOT_ID = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const TARGET_ID = /^local-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const FRAME_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "viewGeneration", "sequence",
    "width", "height", "mimeType", "bytes",
  ]);
  const STATUS_FIELDS = new Set([
    "botId", "targetId", "targetGeneration", "viewGeneration", "state", "code",
  ]);
  const STATUS_STATES = new Set(["connecting", "live", "unavailable", "retrying"]);
  const STATUS_CODES = new Set([null, "OPENBOT_LOCAL_CAPTURE_FAILED", "OPENBOT_LOCAL_DESKTOP_STALE"]);
  const MAX_FRAME_BYTES = 1_048_576;

  function element(documentRef, tag, className, text) {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function structuredCloneBoundary(value) {
    if (typeof structuredClone !== "function") return false;
    try {
      structuredClone(value);
      return true;
    } catch { return false; }
  }

  function exactFrame(value) {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if ((prototype !== Object.prototype && prototype !== null) || keys.length !== FRAME_FIELDS.size
        || keys.some((key) => typeof key !== "string" || !FRAME_FIELDS.has(key)
          || !("value" in descriptors[key]))
        || [...FRAME_FIELDS].some((key) => !descriptors[key])
        || !structuredCloneBoundary(value)) return null;
      const frame = Object.fromEntries([...FRAME_FIELDS].map((key) => [key, descriptors[key].value]));
      if (typeof frame.botId !== "string" || !BOT_ID.test(frame.botId)
        || typeof frame.targetId !== "string" || !TARGET_ID.test(frame.targetId)
        || !Number.isSafeInteger(frame.targetGeneration) || frame.targetGeneration < 0
        || !Number.isSafeInteger(frame.viewGeneration) || frame.viewGeneration < 1
        || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1
        || !Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > 640
        || !Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > 400
        || frame.mimeType !== "image/png" || !(frame.bytes instanceof Uint8Array)
        || frame.bytes.byteLength < 1 || frame.bytes.byteLength > MAX_FRAME_BYTES) return null;
      return Object.freeze({ ...frame, bytes: Uint8Array.from(frame.bytes) });
    } catch { return null; }
  }

  function exactStatus(value) {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if ((prototype !== Object.prototype && prototype !== null) || keys.length !== STATUS_FIELDS.size
        || keys.some((key) => typeof key !== "string" || !STATUS_FIELDS.has(key)
          || !("value" in descriptors[key]))
        || [...STATUS_FIELDS].some((key) => !descriptors[key])
        || !structuredCloneBoundary(value)) return null;
      const status = Object.fromEntries([...STATUS_FIELDS].map((key) => [key, descriptors[key].value]));
      if (typeof status.botId !== "string" || !BOT_ID.test(status.botId)
        || typeof status.targetId !== "string" || !TARGET_ID.test(status.targetId)
        || !Number.isSafeInteger(status.targetGeneration) || status.targetGeneration < 0
        || !Number.isSafeInteger(status.viewGeneration) || status.viewGeneration < 1
        || !STATUS_STATES.has(status.state) || !STATUS_CODES.has(status.code)) return null;
      if ((status.state === "live" || status.state === "connecting" || status.state === "retrying")
        && status.code !== null) return null;
      if (status.state === "unavailable" && status.code === null) return null;
      return Object.freeze(status);
    } catch { return null; }
  }

  function sameTarget(left, right) {
    return Boolean(left && right && left.targetId === right.targetId
      && left.targetGeneration === right.targetGeneration);
  }

  function createLocalDesktopView({ documentRef, windowRef, container } = {}) {
    if (!documentRef || typeof documentRef.createElement !== "function"
      || !windowRef || !container || typeof container.append !== "function") {
      throw new Error("OpenBot Local Desktop view is unavailable.");
    }
    const facade = windowRef.openbotLocalDesktop;
    const BlobClass = windowRef.Blob;
    const decodeBitmap = windowRef.createImageBitmap;
    if (!facade || typeof facade.select !== "function" || typeof facade.retry !== "function"
      || typeof facade.clear !== "function" || typeof facade.onFrame !== "function"
      || typeof facade.onStatus !== "function" || typeof BlobClass !== "function"
      || typeof decodeBitmap !== "function") {
      throw new Error("OpenBot Local Desktop view is unavailable.");
    }

    const surface = element(documentRef, "section", "openbot-local-desktop-view");
    surface.setAttribute("aria-label", "Selected bot Free Local Desktop");
    const header = element(documentRef, "header", "openbot-local-desktop-view-header");
    const status = element(documentRef, "span", "openbot-local-desktop-view-status", "No local desktop selected");
    const retry = element(documentRef, "button", "openbot-local-desktop-retry", "Retry");
    retry.type = "button";
    retry.hidden = true;
    retry.disabled = true;
    retry.setAttribute("aria-label", "Retry local desktop");
    header.append(
      element(documentRef, "strong", "", "Free Local Desktop"),
      status,
      retry,
    );
    const viewport = element(documentRef, "div", "openbot-local-desktop-viewport");
    const canvas = element(documentRef, "canvas", "openbot-local-desktop-canvas");
    canvas.width = 640;
    canvas.height = 400;
    canvas.setAttribute("aria-label", "Live selected bot desktop frame");
    viewport.append(canvas);
    surface.append(header, viewport);
    container.append(surface);
    const context = canvas.getContext("2d");
    if (!context || typeof context.clearRect !== "function" || typeof context.drawImage !== "function") {
      surface.remove?.();
      throw new Error("OpenBot Local Desktop view is unavailable.");
    }

    let disposed = false;
    let selectedBotId = null;
    let viewGeneration = 0;
    let target = null;
    let lastSequence = 0;
    let decodeGeneration = 0;
    let state = "none";
    let retryPending = false;
    let operationToken = 0;

    function clearCanvas() {
      decodeGeneration += 1;
      target = null;
      lastSequence = 0;
      context.clearRect(0, 0, canvas.width, canvas.height);
    }

    function setStatus(nextState) {
      state = nextState;
      status.textContent = nextState === "connecting"
        ? "Connecting to local desktop…"
        : nextState === "retrying"
          ? "Retrying local desktop…"
          : nextState === "live"
            ? "Live local desktop"
            : nextState === "unavailable"
              ? "Local desktop unavailable"
              : "No local desktop selected";
      retry.hidden = !selectedBotId || nextState !== "unavailable";
      retry.disabled = !selectedBotId || retryPending || nextState !== "unavailable";
    }

    function applyStatus(value) {
      const next = exactStatus(value);
      if (!next || disposed || next.botId !== selectedBotId || next.viewGeneration !== viewGeneration) return null;
      const nextTarget = Object.freeze({ targetId: next.targetId, targetGeneration: next.targetGeneration });
      if (target && !sameTarget(target, nextTarget)) return null;
      if (!target) target = nextTarget;
      setStatus(next.state);
      retryPending = next.state === "retrying";
      retry.disabled = !selectedBotId || retryPending || next.state !== "unavailable";
      return next;
    }

    function failedCurrentOperation(botId, generation, token) {
      if (disposed || !selectedBotId || selectedBotId !== botId
        || viewGeneration !== generation || operationToken !== token) return;
      retryPending = false;
      setStatus("unavailable");
    }

    function invokeSelection(operation, botId, generation, token) {
      void Promise.resolve(operation).then((value) => {
        if (value && operationToken === token && selectedBotId === botId && viewGeneration === generation) {
          applyStatus(value);
        }
      }, () => failedCurrentOperation(botId, generation, token));
    }

    function selectBot(value) {
      if (disposed) return;
      viewGeneration += 1;
      selectedBotId = typeof value === "string" && BOT_ID.test(value) ? value : null;
      retryPending = false;
      clearCanvas();
      setStatus(selectedBotId ? "connecting" : "none");
      const botId = selectedBotId;
      const generation = viewGeneration;
      const token = ++operationToken;
      const request = Object.freeze({ viewGeneration: generation });
      let operation;
      try {
        operation = botId
          ? facade.select(Object.freeze({ botId, viewGeneration: generation }))
          : facade.clear(request);
      } catch {
        failedCurrentOperation(botId, generation, token);
        return;
      }
      invokeSelection(operation, botId, generation, token);
    }

    function retrySelectedBot() {
      if (disposed || !selectedBotId || state !== "unavailable" || retryPending) return;
      viewGeneration += 1;
      retryPending = true;
      clearCanvas();
      setStatus("retrying");
      const botId = selectedBotId;
      const generation = viewGeneration;
      const token = ++operationToken;
      try {
        invokeSelection(
          facade.retry(Object.freeze({ botId, viewGeneration: generation })),
          botId,
          generation,
          token,
        );
      } catch {
        failedCurrentOperation(botId, generation, token);
      }
    }

    retry.addEventListener?.("click", retrySelectedBot);

    async function onFrame(value) {
      if (disposed) return;
      const frame = exactFrame(value);
      if (!frame || frame.botId !== selectedBotId || frame.viewGeneration !== viewGeneration) return;
      const nextTarget = Object.freeze({
        targetId: frame.targetId,
        targetGeneration: frame.targetGeneration,
      });
      if (sameTarget(target, nextTarget)) {
        if (frame.sequence <= lastSequence) return;
      } else if (target) {
        return;
      } else {
        clearCanvas();
        target = nextTarget;
      }
      lastSequence = frame.sequence;
      decodeGeneration += 1;
      const pendingGeneration = decodeGeneration;
      let bitmap;
      try {
        const blob = new BlobClass([frame.bytes], { type: "image/png" });
        bitmap = await decodeBitmap(blob);
        if (disposed || pendingGeneration !== decodeGeneration || frame.botId !== selectedBotId
          || frame.viewGeneration !== viewGeneration || !sameTarget(target, nextTarget)
          || lastSequence !== frame.sequence) return;
        canvas.width = frame.width;
        canvas.height = frame.height;
        context.drawImage(bitmap, 0, 0, frame.width, frame.height);
        setStatus("live");
      } catch {
        if (!disposed && pendingGeneration === decodeGeneration) {
          retryPending = false;
          setStatus("unavailable");
        }
      } finally {
        try { bitmap?.close?.(); } catch {}
      }
    }

    const stopFrames = facade.onFrame(onFrame);
    const stopStatus = facade.onStatus(applyStatus);
    const stopComputer = typeof windowRef.openbotComputer?.onChanged === "function"
      ? windowRef.openbotComputer.onChanged((value) => {
        if (disposed) return;
        if (value?.botId === selectedBotId) selectBot(selectedBotId);
        else if (!value && selectedBotId) selectBot(null);
      })
      : () => {};

    return Object.freeze({
      canvas,
      selectBot,
      retry: retrySelectedBot,
      dispose() {
        if (disposed) return;
        disposed = true;
        operationToken += 1;
        viewGeneration += 1;
        selectedBotId = null;
        retryPending = false;
        clearCanvas();
        setStatus("none");
        try { stopFrames?.(); } catch {}
        try { stopStatus?.(); } catch {}
        try { stopComputer?.(); } catch {}
        try { void Promise.resolve(facade.clear(Object.freeze({ viewGeneration }))).catch(() => {}); } catch {}
        surface.remove?.();
      },
    });
  }

  return Object.freeze({ createLocalDesktopView });
});
