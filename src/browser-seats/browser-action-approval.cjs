"use strict";

const crypto = require("node:crypto");

const DEFAULT_PENDING_TTL_MS = 60_000;
const MAX_PENDING_TTL_MS = 120_000;

const RISK_RANK = Object.freeze({ automatic: 0, high: 1 });
const HIGH_IMPACT_WORDS =
  /\b(?:send|post|publish|purchase|pay|order|delete|remove|authori[sz]e|allow|grant|submit)\b/i;
const PASSWORD_WORDS = /\b(?:password|passphrase|passwd|passcode)\b/i;
const OTP_WORDS =
  /\b(?:otp|one[\s_-]*time(?:[\s_-]*(?:code|password))?|verification[\s_-]*code|security[\s_-]*code|2fa|mfa|authenticator[\s_-]*code)\b/i;
const PAYMENT_WORDS =
  /\b(?:credit[\s_-]*card|debit[\s_-]*card|card[\s_-]*(?:number|holder)|payment|billing|cvv|cvc|ccv|card[\s_-]*security|expiration|expiry|routing[\s_-]*number|bank[\s_-]*account)\b/i;
const SENSITIVE_AUTOCOMPLETE =
  /^(?:current-password|new-password|one-time-code|cc-(?:name|given-name|additional-name|family-name|number|exp|exp-month|exp-year|csc|type)|transaction-(?:currency|amount))$/i;
const SAFE_FOCUS_KEYS = /^(?:TAB|SHIFT\+TAB|ESC|ESCAPE)$/i;
const ADDRESS_FOCUS_KEY = /^(?:(?:CTRL|CONTROL)\+L)$/i;
const ADDRESS_SELECT_KEY = /^(?:(?:CTRL|CONTROL)\+A)$/i;
const PRESENTATION_KINDS = new Set([
  "click",
  "drag",
  "key",
  "navigate",
  "screenshot",
  "scroll",
  "submit",
  "type",
  "wait",
]);
const FIELD_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "email",
  "file",
  "hidden",
  "image",
  "month",
  "number",
  "password",
  "radio",
  "range",
  "reset",
  "search",
  "submit",
  "tel",
  "text",
  "time",
  "url",
  "week",
]);
const TARGET_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "gridcell",
  "link",
  "listbox",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);
const TARGET_TAGS = new Set([
  "a",
  "button",
  "form",
  "input",
  "select",
  "textarea",
]);

class ApprovalBindingError extends Error {
  constructor(
    message = "The approval response does not match the pending browser action.",
  ) {
    super(message);
    this.name = "ApprovalBindingError";
  }
}

function normalizeOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new TypeError("Browser approval requires a valid HTTP(S) origin.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("Browser approval requires a valid HTTP(S) origin.");
  }
  return parsed.origin;
}

function normalizedToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function semanticValue(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

function targetSemanticText(action, context) {
  const target =
    action?.target && typeof action.target === "object" ? action.target : {};
  const dom =
    context?.target && typeof context.target === "object" ? context.target : {};
  return [
    action?.intent,
    action?.semanticAction,
    target.name,
    target.label,
    target.ariaLabel,
    target.accessibleName,
    target.placeholder,
    target.text,
    target.formAction,
    target.formMethod,
    dom.name,
    dom.label,
    dom.ariaLabel,
    dom.accessibleName,
    dom.placeholder,
    dom.text,
    dom.formAction,
    dom.formMethod,
  ]
    .map(semanticValue)
    .join(" ");
}

function combinedTarget(action, context) {
  return {
    ...(action?.target && typeof action.target === "object"
      ? action.target
      : {}),
    ...(context?.target && typeof context.target === "object"
      ? context.target
      : {}),
  };
}

function sensitiveFieldClass(action, context) {
  const target = combinedTarget(action, context);
  const type = normalizedToken(target.type || target.inputType);
  const autocomplete = normalizedToken(target.autocomplete);
  const semantics = targetSemanticText(action, context);
  if (
    type === "password" ||
    PASSWORD_WORDS.test(semantics) ||
    /password/.test(autocomplete)
  )
    return "password";
  if (autocomplete === "one-time-code" || OTP_WORDS.test(semantics))
    return "otp";
  if (
    SENSITIVE_AUTOCOMPLETE.test(autocomplete) ||
    PAYMENT_WORDS.test(semantics)
  )
    return "payment";
  return null;
}

function result(riskClass, actionClass, summary, reason) {
  return Object.freeze({ riskClass, actionClass, summary, reason });
}

function classifyBrowserAction(action, context = {}) {
  const item = action && typeof action === "object" ? action : {};
  const kind = normalizedToken(item.kind || item.action || item.type);
  const target = combinedTarget(item, context);
  const tagName = normalizedToken(target.tagName || target.tag);
  const role = normalizedToken(target.role);
  const inputType = normalizedToken(target.inputType || target.type);
  const surface = normalizedToken(
    item.surface || target.surface || context.surface,
  );
  const semantics = targetSemanticText(item, context);

  const sensitiveClass = sensitiveFieldClass(item, context);
  if (sensitiveClass) {
    return result(
      "high",
      `sensitive-${sensitiveClass}`,
      "Enter sensitive information",
      `${sensitiveClass} field`,
    );
  }

  if (
    item.submit === true ||
    item.formSubmit === true ||
    kind === "submit" ||
    tagName === "form" ||
    tagName === "button" ||
    role === "button" ||
    inputType === "submit" ||
    inputType === "button" ||
    inputType === "image" ||
    HIGH_IMPACT_WORDS.test(semantics)
  ) {
    return result(
      "high",
      "high-impact-control",
      "Activate a high-impact page control",
      "submission or consequential control",
    );
  }

  if (["screenshot", "scroll", "mousemove", "wait"].includes(kind)) {
    const summaries = {
      screenshot: "Capture the current page",
      scroll: "Scroll the current page",
      mousemove: "Move the virtual pointer",
      wait: "Wait for the current page",
    };
    return result(
      "automatic",
      "page-observation",
      summaries[kind],
      "non-mutating page observation",
    );
  }

  if (kind === "key") {
    const key = String(item.key || "").trim();
    if (!key) {
      return result(
        "automatic",
        "no-op",
        "Ignore an empty key action",
        "empty key action cannot change browser state",
      );
    }
    if (ADDRESS_FOCUS_KEY.test(key)) {
      return result(
        "automatic",
        "browser-focus",
        "Focus the browser address",
        "browser focus action",
      );
    }
    if (surface === "address" && ADDRESS_SELECT_KEY.test(key)) {
      return result(
        "automatic",
        "browser-focus",
        "Select the browser address",
        "browser focus action",
      );
    }
    if (SAFE_FOCUS_KEYS.test(key)) {
      return result(
        "automatic",
        "browser-focus",
        "Move or dismiss browser focus",
        "non-mutating focus key",
      );
    }
    return result(
      "high",
      "key-action",
      "Use a page or address key",
      "keys can activate controls or change page state",
    );
  }

  if (
    ["navigate", "navigation", "address", "openurl", "goto"].includes(kind) ||
    surface === "address" ||
    item.addressBar === true
  ) {
    return result(
      "high",
      "navigation",
      "Navigate to another page",
      "address navigation changes the browser destination",
    );
  }

  if (kind === "type") {
    return result(
      "high",
      "field-edit",
      "Edit a page field",
      "typing changes page or address state",
    );
  }

  if (kind === "click") {
    return result(
      "high",
      "page-click",
      "Click the current page",
      "clicks can navigate or change page state",
    );
  }

  if (kind === "drag") {
    return result(
      "high",
      "page-drag",
      "Drag on the current page",
      "dragging can change page state",
    );
  }

  return result(
    "high",
    "unknown-mutation",
    "Perform an unclassified interactive page action",
    "unknown interactive mutation",
  );
}

function classifyBrowserActionBatch(actions, context = {}) {
  if (!Array.isArray(actions))
    throw new TypeError("Browser actions must be an array.");
  const classifications = actions.map((action, index) =>
    classifyBrowserAction(action, context?.actions?.[index] || context),
  );
  const riskClass = classifications.reduce(
    (highest, classification) =>
      RISK_RANK[classification.riskClass] > RISK_RANK[highest]
        ? classification.riskClass
        : highest,
    "automatic",
  );
  const actionClasses = [
    ...new Set(
      classifications
        .filter((classification) => classification.riskClass !== "automatic")
        .map((classification) => classification.actionClass),
    ),
  ].sort();
  const summaries = [
    ...new Set(classifications.map((classification) => classification.summary)),
  ];
  let summary = "Observe the current page";
  if (summaries.length === 1) summary = summaries[0];
  else if (summaries.length > 1)
    summary = `${summaries.slice(0, 3).join("; ")}${summaries.length > 3 ? `; plus ${summaries.length - 3} more action types` : ""}`;
  return Object.freeze({
    riskClass,
    actionClasses: Object.freeze(actionClasses),
    summary,
    classifications: Object.freeze(classifications),
  });
}

function redactTypedEcho(value, typedValues) {
  let output = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  for (const typed of typedValues) {
    if (!typed) continue;
    if (output === typed) {
      output = "[redacted]";
      continue;
    }
    output = output.split(typed).join("[redacted]");
  }
  return output;
}

function sanitizePresentationUrl(value, baseOrigin, typedValues = []) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw, normalizeOrigin(baseOrigin));
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  return redactTypedEcho(
    `${parsed.origin}${parsed.pathname || "/"}`,
    typedValues,
  );
}

function presentationKind(action) {
  const raw = normalizedToken(action?.kind || action?.action || action?.type);
  if (["navigation", "address", "openurl", "goto"].includes(raw))
    return "navigate";
  if (raw === "mousemove") return "mouse move";
  return PRESENTATION_KINDS.has(raw) ? raw : "interactive action";
}

function safeToken(value) {
  const token = normalizedToken(value);
  return /^[a-z][a-z0-9_-]{0,31}$/.test(token) ? token : "";
}

function typedValuesFor(actions) {
  return actions
    .filter((action) => normalizedToken(action?.kind) === "type")
    .map((action) => String(action?.text || ""))
    .filter(Boolean);
}

function targetPresentation(target, typedValues) {
  if (!target || typeof target !== "object") return null;
  const name = redactTypedEcho(
    target.accessibleName ||
      target.ariaLabel ||
      target.label ||
      target.placeholder ||
      target.name ||
      target.text,
    typedValues,
  );
  const rawTagName = safeToken(target.tagName || target.tag);
  const tagName = TARGET_TAGS.has(rawTagName) ? rawTagName : "";
  const rawRole = safeToken(target.role);
  const role = (TARGET_ROLES.has(rawRole) ? rawRole : "") || tagName;
  const rawFieldType = safeToken(target.inputType || target.type);
  const fieldType = FIELD_TYPES.has(rawFieldType) ? rawFieldType : "";
  if (!name && !role && !fieldType) return null;
  return Object.freeze({
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
    ...(fieldType ? { fieldType } : {}),
  });
}

function typedContentPresentation(action, context) {
  if (normalizedToken(action?.kind) !== "type") return null;
  const text = String(action?.text || "");
  const sensitiveClass = sensitiveFieldClass(action, context);
  const target =
    context?.target && typeof context.target === "object" ? context.target : {};
  const inputType = safeToken(target.inputType || target.type);
  const autocomplete = safeToken(target.autocomplete);
  let category = sensitiveClass;
  if (category === "otp") category = "one-time code";
  else if (!category && (inputType === "email" || autocomplete === "email"))
    category = "email";
  else if (!category && inputType === "search") category = "search text";
  else if (!category && inputType === "url") category = "URL";
  else if (!category && inputType === "tel") category = "telephone number";
  else if (!category && inputType === "number") category = "number";
  else if (!category && /\r|\n/.test(text)) category = "multi-line text";
  else if (!category) category = "text";
  return Object.freeze({ category, length: Array.from(text).length });
}

function addressCandidate(action, target) {
  const kind = normalizedToken(action?.kind);
  const current = String(target?.href || "");
  let value = current;
  if (kind === "type") {
    value =
      target?.selected === true
        ? String(action?.text || "")
        : current + String(action?.text || "");
  }
  value = value.trim();
  if (!value) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)
      ? `https://${value}`
      : `https://www.google.com/search?q=${encodeURIComponent(value)}`;
  }
  return value;
}

function actionDestination(action, context, origin, typedValues) {
  const target =
    context?.target && typeof context.target === "object" ? context.target : {};
  const kind = presentationKind(action);
  const surface = normalizedToken(context?.surface || target.surface);
  let candidate = "";
  if (surface === "address") candidate = addressCandidate(action, target);
  else if (kind === "navigate")
    candidate = action?.url || action?.href || action?.address || action?.value;
  else if (kind === "click") candidate = target.href;
  else if (kind === "submit") candidate = target.formAction;
  return sanitizePresentationUrl(candidate, origin, typedValues);
}

function formPresentation(target, origin, typedValues) {
  if (!target || typeof target !== "object") return null;
  const destination = sanitizePresentationUrl(
    target.formAction,
    origin,
    typedValues,
  );
  const rawMethod = safeToken(target.formMethod).toUpperCase();
  const method = ["GET", "POST", "DIALOG"].includes(rawMethod) ? rawMethod : "";
  if (!method && !destination) return null;
  return Object.freeze({
    ...(method ? { method } : {}),
    ...(destination ? { destination } : {}),
  });
}

function buildApprovalPresentation(actions, trustedContext = {}, origin) {
  const typedValues = typedValuesFor(actions);
  const items = actions.map((action, index) => {
    const context = trustedContext?.actions?.[index] || {};
    const trustedTarget =
      context?.target && typeof context.target === "object"
        ? context.target
        : {};
    const destination = actionDestination(action, context, origin, typedValues);
    const target = targetPresentation(trustedTarget, typedValues);
    const form = formPresentation(trustedTarget, origin, typedValues);
    const typedContent = typedContentPresentation(action, context);
    return Object.freeze({
      kind: presentationKind(action),
      ...(destination ? { destination } : {}),
      ...(target ? { target } : {}),
      ...(form ? { form } : {}),
      ...(typedContent ? { typedContent } : {}),
    });
  });
  return Object.freeze({ actions: Object.freeze(items) });
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isFinite(value)
      ? JSON.stringify(value)
      : JSON.stringify(String(value));
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (typeof value === "undefined") return JSON.stringify("[undefined]");
  if (typeof value !== "object")
    throw new TypeError("Browser actions must contain only data values.");
  if (seen.has(value))
    throw new TypeError("Browser actions cannot contain circular data.");
  seen.add(value);
  let encoded;
  if (Array.isArray(value)) {
    encoded = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(
        "Browser actions must contain only plain data objects.",
      );
    encoded = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`)
      .join(",")}}`;
  }
  seen.delete(value);
  return encoded;
}

function digestActionBatch(
  { seatId, origin, actions, trustedContext = {} },
  digestKey,
) {
  if (!Buffer.isBuffer(digestKey) || digestKey.length < 32) {
    throw new TypeError(
      "Browser action digests require a private key of at least 32 bytes.",
    );
  }
  const canonical = canonicalJson({
    seatId: String(seatId),
    origin: normalizeOrigin(origin),
    actions,
    trustedContext,
  });
  return crypto.createHmac("sha256", digestKey).update(canonical).digest("hex");
}

function untrustedActionShape(action) {
  const item = action && typeof action === "object" ? action : {};
  return { kind: item.kind, key: item.key };
}

function frozenDecision(pending, allowed, decision, source) {
  return Object.freeze({
    allowed,
    decision,
    source,
    requestId: pending.requestId,
    seatId: pending.seatId,
    origin: pending.origin,
    actionDigest: pending.actionDigest,
    riskClass: pending.riskClass,
    summary: pending.summary,
  });
}

class BrowserActionApprovalCoordinator {
  #pendingBySeat = new Map();
  #leasesBySeat = new Map();
  #now;
  #setTimer;
  #clearTimer;
  #pendingTtlMs;
  #digestKey = crypto.randomBytes(32);
  #trustedCapability = Symbol("trusted-browser-approval-ui");

  constructor({
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    pendingTtlMs = DEFAULT_PENDING_TTL_MS,
  } = {}) {
    if (
      typeof now !== "function" ||
      typeof setTimer !== "function" ||
      typeof clearTimer !== "function"
    ) {
      throw new TypeError("Browser approval clock options must be functions.");
    }
    const requestedTtl = Number(pendingTtlMs);
    if (!Number.isFinite(requestedTtl) || requestedTtl <= 0)
      throw new RangeError("Browser approval expiry must be positive.");
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#pendingTtlMs = Math.min(Math.floor(requestedTtl), MAX_PENDING_TTL_MS);
  }

  createTrustedUserApprover() {
    const capability = this.#trustedCapability;
    return Object.freeze({
      allowOnce: (binding) => this.#decide(capability, "allow-once", binding),
      deny: (binding) => this.#decide(capability, "deny", binding),
      allowSiteLease: (binding) => this.#allowSiteLease(capability, binding),
      authorizeUserAction: (request) =>
        this.#authorizeUserAction(capability, request),
    });
  }

  requestAgentAction(request, trustedContext = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new TypeError("Browser approval request must be an object.");
    for (const key of [
      "actor",
      "approval",
      "approved",
      "decision",
      "leaseMs",
      "source",
      "trusted",
      "context",
      "trustedContext",
      "domContext",
    ]) {
      if (Object.hasOwn(request, key))
        throw new TypeError(
          "Agent requests cannot provide approval decisions or user identity.",
        );
    }
    const prepared = this.#prepareRequest(request, trustedContext, true);
    if (prepared.riskClass === "automatic") {
      return Promise.resolve(
        frozenDecision(prepared, true, "automatic", "policy"),
      );
    }
    const existing = this.#pendingBySeat.get(prepared.seatId);
    if (existing) {
      throw new Error(
        "This browser seat already has an action awaiting user approval.",
      );
    }

    let resolveDecision;
    const promise = new Promise((resolve) => {
      resolveDecision = resolve;
    });
    const pending = { ...prepared, resolveDecision, promise, timer: null };
    const delay = Math.max(1, pending.expiresAt - this.#now());
    pending.timer = this.#setTimer(
      () => this.#expireOne(pending.seatId, pending.requestId),
      delay,
    );
    pending.timer?.unref?.();
    this.#pendingBySeat.set(pending.seatId, pending);
    return promise;
  }

  getPendingStatus(seatId) {
    this.expirePending();
    const pending = this.#pendingBySeat.get(String(seatId || ""));
    if (!pending) return null;
    return Object.freeze({
      requestId: pending.requestId,
      seatId: pending.seatId,
      origin: pending.origin,
      actionDigest: pending.actionDigest,
      riskClass: pending.riskClass,
      summary: pending.summary,
      presentation: pending.presentation,
      expiresAt: pending.expiresAt,
      siteLeaseAvailable: false,
    });
  }

  getSiteLeaseStatus(seatId, origin) {
    String(seatId || "");
    normalizeOrigin(origin);
    return null;
  }

  expirePending() {
    const now = this.#now();
    let expired = 0;
    for (const pending of [...this.#pendingBySeat.values()]) {
      if (
        pending.expiresAt <= now &&
        this.#settle(pending, false, "expired", "expiry")
      )
        expired += 1;
    }
    return expired;
  }

  clearSeatAuthorizations(seatId) {
    const normalizedSeat = String(seatId || "").trim();
    if (!normalizedSeat)
      throw new TypeError(
        "Browser authorization cleanup requires a seat identifier.",
      );
    const pending = this.#pendingBySeat.get(normalizedSeat);
    const pendingCleared = pending
      ? this.#settle(pending, false, "cancelled", "seat-cleared")
      : false;
    const leasesCleared = this.#leasesBySeat.delete(normalizedSeat);
    return pendingCleared || leasesCleared;
  }

  cancelAgentAction(seatId) {
    const pending = this.#pendingBySeat.get(String(seatId || ""));
    return pending
      ? this.#settle(pending, false, "deny", "agent-cancelled")
      : false;
  }

  dispose() {
    for (const pending of [...this.#pendingBySeat.values()])
      this.#settle(pending, false, "deny", "coordinator-disposed");
    this.#leasesBySeat.clear();
  }

  #prepareRequest(
    { seatId, origin, actions },
    trustedContext = {},
    untrustedAgent = false,
  ) {
    const normalizedSeat = String(seatId || "").trim();
    if (!normalizedSeat)
      throw new TypeError("Browser approval requires a seat identifier.");
    const normalizedSite = normalizeOrigin(origin);
    if (!Array.isArray(actions))
      throw new TypeError("Browser actions must be an array.");
    const classification = classifyBrowserActionBatch(
      untrustedAgent ? actions.map(untrustedActionShape) : actions,
      trustedContext,
    );
    return {
      requestId: crypto.randomUUID(),
      seatId: normalizedSeat,
      origin: normalizedSite,
      actionDigest: digestActionBatch(
        {
          seatId: normalizedSeat,
          origin: normalizedSite,
          actions,
          trustedContext,
        },
        this.#digestKey,
      ),
      riskClass: classification.riskClass,
      actionClasses: classification.actionClasses,
      summary: classification.summary,
      presentation: buildApprovalPresentation(
        actions,
        trustedContext,
        normalizedSite,
      ),
      expiresAt: this.#now() + this.#pendingTtlMs,
    };
  }

  #authorizeUserAction(capability, request) {
    this.#assertTrusted(capability);
    const trustedContext = request?.trustedContext || request?.context || {};
    const prepared = this.#prepareRequest(request || {}, trustedContext);
    return frozenDecision(prepared, true, "allow", "user-takeover");
  }

  #assertTrusted(capability) {
    if (capability !== this.#trustedCapability)
      throw new Error("Browser approval requires the trusted user interface.");
  }

  #boundPending(binding) {
    if (!binding || typeof binding !== "object")
      throw new ApprovalBindingError();
    this.expirePending();
    const seatId = String(binding.seatId || "");
    const pending = this.#pendingBySeat.get(seatId);
    if (!pending) {
      const requestId = String(binding.requestId || "");
      if (
        [...this.#pendingBySeat.values()].some(
          (candidate) => candidate.requestId === requestId,
        )
      ) {
        throw new ApprovalBindingError();
      }
      return null;
    }
    let origin;
    try {
      origin = normalizeOrigin(binding.origin);
    } catch {
      throw new ApprovalBindingError();
    }
    const matches =
      pending.requestId === String(binding.requestId || "") &&
      pending.origin === origin &&
      pending.actionDigest === String(binding.actionDigest || "");
    if (!matches) throw new ApprovalBindingError();
    return pending;
  }

  #decide(capability, decision, binding) {
    this.#assertTrusted(capability);
    const pending = this.#boundPending(binding);
    if (!pending) return false;
    return this.#settle(
      pending,
      decision === "allow-once",
      decision,
      decision === "allow-once" ? "trusted-user" : "trusted-user-denial",
    );
  }

  #allowSiteLease(capability, binding) {
    this.#assertTrusted(capability);
    this.#boundPending(binding);
    return false;
  }

  #expireOne(seatId, requestId) {
    const pending = this.#pendingBySeat.get(seatId);
    if (!pending || pending.requestId !== requestId) return false;
    if (pending.expiresAt > this.#now()) return false;
    return this.#settle(pending, false, "expired", "expiry");
  }

  #settle(pending, allowed, decision, source) {
    if (this.#pendingBySeat.get(pending.seatId) !== pending) return false;
    this.#pendingBySeat.delete(pending.seatId);
    if (pending.timer !== null && pending.timer !== undefined)
      this.#clearTimer(pending.timer);
    pending.resolveDecision(frozenDecision(pending, allowed, decision, source));
    return true;
  }
}

module.exports = {
  ApprovalBindingError,
  BrowserActionApprovalCoordinator,
  DEFAULT_PENDING_TTL_MS,
  MAX_PENDING_TTL_MS,
  classifyBrowserAction,
  classifyBrowserActionBatch,
  buildApprovalPresentation,
  digestActionBatch,
  normalizeOrigin,
  sanitizePresentationUrl,
};
