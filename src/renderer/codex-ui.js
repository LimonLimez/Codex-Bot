const CODEX_SERVICE = "http://127.0.0.1:__CODEX_VIEW_PORT__";
const CODEX_TOKEN = "__CODEX_VIEW_TOKEN__";
const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
const PROVIDER_LOGIN_TARGETS = Object.freeze({
  codex: Object.freeze({ host: "auth.openai.com", path: "/codex/device" }),
  claude: Object.freeze({ host: "claude.ai", path: "/oauth/authorize" }),
  antigravity: Object.freeze({
    host: "accounts.google.com",
    path: "/o/oauth2/v2/auth",
  }),
  kimi: Object.freeze({
    host: "www.kimi.com",
    path: "/code/authorize_device",
  }),
  xai: Object.freeze({ host: "accounts.x.ai", path: "/oauth2/device" }),
});
globalThis.__CODEX_BOT_VIEW_TOKEN__ = CODEX_TOKEN;
const headers = { "X-Codex-Seat-Token": CODEX_TOKEN };
let lastStatus = null;
let refreshTimer = null;
let connectionPollTimer = null;
let officialConnectionPollTimer = null;
let officialApprovalPollTimer = null;
let groupTaskPollTimer = null;
let officialComputerOperationInFlight = false;
let officialPermissionOperationInFlight = false;
let privatePermissionOperationInFlight = false;
let officialEnableAfterCursorLogin = false;
let officialEnableContinuationInFlight = false;
let providerActivationInFlight = false;
let providerConnectionNotice = { message: "", tone: "info" };
let selectedProviderId = null;
let officialComputerNotice = { message: "", tone: "info" };
let officialPermissionNotice = { message: "", tone: "info" };
let privatePermissionNotice = { message: "", tone: "info" };
let pendingOAuthDevice = null;
let activeModelPicker = null;
let onboardingStep = "providers";
let onboardingComputerChoice = "private";
const PROVIDER_LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const ONBOARDING_STORAGE_KEY = "open-bot.onboarding.v1.complete";
const PROVIDER_ICON_DATA = Object.freeze({
  codex: "__OPEN_BOT_ICON_CODEX__",
  claude: "__OPEN_BOT_ICON_CLAUDE__",
  kimi: "__OPEN_BOT_ICON_KIMI__",
  xai: "__OPEN_BOT_ICON_XAI__",
  vertex: "__OPEN_BOT_ICON_VERTEX__",
});
const agentStatusCache = new Map();
const pendingAgentStatusLoads = new Map();
const officialApprovalLoads = new WeakSet();
const groupTaskLoads = new WeakSet();

const MODEL_FALLBACKS = [
  {
    id: "gpt-5.6-sol",
    label: "5.6 Sol",
    description: "Frontier capability for the hardest work.",
  },
  {
    id: "gpt-5.6-terra",
    label: "5.6 Terra",
    description: "Balanced capability and speed.",
  },
  {
    id: "gpt-5.6-luna",
    label: "5.6 Luna",
    description: "Efficient for quick, routine work.",
  },
];
const REASONING_FALLBACKS = ["none", "low", "medium", "high", "xhigh", "max"];

function boltIcon({ size = 14 } = {}) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none"><path d="M9.25 1.5 3.8 8.35h3.35L6.6 14.5l5.6-7.25H8.85l.4-5.75Z" fill="currentColor"/></svg>`;
}

function closeIcon() {
  return `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}

function inferenceState(status = lastStatus) {
  const value =
    status?.preferences ||
    status?.inference ||
    status?.settings?.inference ||
    {};
  const defaults = value.defaults || {
    model: status?.connection?.model || "gpt-5.6-terra",
    reasoningEffort: status?.connection?.reasoningEffort || "high",
    fastMode: Boolean(status?.connection?.fastMode),
    responseMode: status?.connection?.responseMode || "chat",
  };
  return {
    defaults,
    override: value.override || null,
    effective: value.effective || defaults,
    models:
      value.catalog?.models ||
      value.options?.models ||
      value.models ||
      MODEL_FALLBACKS,
    reasoningEfforts:
      value.catalog?.reasoningEfforts ||
      value.options?.reasoningEfforts ||
      value.reasoningEfforts ||
      REASONING_FALLBACKS,
    fastCapability: value.catalog?.fastMode || value.fastCapability || null,
    responseModes: value.catalog?.responseModes || [
      "chat",
      "search",
      "research",
    ],
  };
}

function modelMeta(modelId, state = inferenceState()) {
  return (
    state.models.find((item) => item.id === modelId) || {
      id: modelId,
      label: String(modelId || "Model").replace(/^gpt-/i, ""),
      description: "",
    }
  );
}

function reasoningLabel(value) {
  const normalized = String(value || "");
  if (normalized === "xhigh") return "Extra high";
  return normalized
    ? normalized[0].toUpperCase() + normalized.slice(1)
    : "Default";
}

function reasoningSliderHtml(
  efforts,
  current,
  { attribute, id, compact = false },
) {
  const values = efforts.length ? efforts : REASONING_FALLBACKS;
  const selectedIndex = Math.max(0, values.indexOf(current));
  const progress =
    values.length <= 1 ? 0 : (selectedIndex / (values.length - 1)) * 100;
  const stops = values
    .map(
      (effort, index) =>
        `<span class="${index <= selectedIndex ? "is-active" : ""}" title="${escapeHtml(reasoningLabel(effort))}"></span>`,
    )
    .join("");
  return `
    <div class="codex-reasoning-slider${compact ? " is-compact" : ""}">
      <div class="codex-reasoning-slider-heading"><span>Reasoning</span><strong id="${id}-value" data-codex-reasoning-value>${escapeHtml(reasoningLabel(values[selectedIndex]))}</strong></div>
      <input id="${id}" type="range" min="0" max="${values.length - 1}" step="1" value="${selectedIndex}" aria-labelledby="${id}-label" aria-valuetext="${escapeHtml(reasoningLabel(values[selectedIndex]))}" data-reasoning-values="${escapeHtml(values.join("|"))}" style="--codex-slider-progress:${progress}%" ${attribute} />
      <span class="codex-visually-hidden" id="${id}-label">Reasoning effort</span>
      <div class="codex-reasoning-stops" aria-hidden="true">${stops}</div>
    </div>`;
}

function updateReasoningSlider(control) {
  if (!control) return null;
  const values = String(control.dataset.reasoningValues || "")
    .split("|")
    .filter(Boolean);
  const index = Math.max(
    0,
    Math.min(values.length - 1, Number(control.value) || 0),
  );
  const value = values[index] || null;
  const progress = values.length <= 1 ? 0 : (index / (values.length - 1)) * 100;
  control.style.setProperty("--codex-slider-progress", `${progress}%`);
  control.setAttribute("aria-valuetext", reasoningLabel(value));
  const root = control.closest(".codex-reasoning-slider");
  const label = root?.querySelector("[data-codex-reasoning-value]");
  if (label) label.textContent = reasoningLabel(value);
  for (const [stopIndex, stop] of [
    ...(root?.querySelectorAll(".codex-reasoning-stops>span") || []),
  ].entries())
    stop.classList.toggle("is-active", stopIndex <= index);
  return value;
}

function hasCodexConnection(status) {
  return Boolean(
    status?.account?.signedIn ||
    status?.connection?.mode === "api-key" ||
    status?.connection?.mode === "local",
  );
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

async function verifyCodexViewServer() {
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const response = await fetch(
    `${CODEX_SERVICE}/api/identity?nonce=${encodeURIComponent(nonce)}`,
    {
      cache: "no-store",
    },
  );
  const value = await response.json().catch(() => ({}));
  if (!response.ok || typeof value.proof !== "string")
    throw new Error("Local browser service identity check failed");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CODEX_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`codex-bot-view:${nonce}`),
  );
  const expected = base64Url(new Uint8Array(signature));
  if (value.proof.length !== expected.length)
    throw new Error("Local browser service identity check failed");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1)
    mismatch |= value.proof.charCodeAt(index) ^ expected.charCodeAt(index);
  if (mismatch !== 0)
    throw new Error("Local browser service identity check failed");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function initials(name) {
  return String(name || "Codex")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
}

function onboardingCompleted() {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function rememberOnboardingCompleted() {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
  } catch {}
}

function providerLogo(providerId) {
  const suppliedIcon = PROVIDER_ICON_DATA[providerId];
  if (suppliedIcon)
    return `<img aria-hidden="true" src="${suppliedIcon}" alt="" />`;
  const common = 'aria-hidden="true" viewBox="0 0 40 40"';
  if (providerId === "antigravity")
    return `<svg ${common}><rect x="2" y="2" width="36" height="36" rx="11" fill="#fff"/><path d="M31.8 20.3c0-1-.1-1.8-.3-2.7H20v4.8h6.7a5.8 5.8 0 0 1-2.5 3.7v3.2h4.1c2.4-2.2 3.5-5.4 3.5-9Z" fill="#4285F4"/><path d="M20 32c3.3 0 6.1-1.1 8.2-2.9l-4.1-3.1a7.5 7.5 0 0 1-11.2-3.9H8.7v3.3A12 12 0 0 0 20 32Z" fill="#34A853"/><path d="M12.9 22.2a7.3 7.3 0 0 1 0-4.5v-3.3H8.7a12 12 0 0 0 0 11l4.2-3.2Z" fill="#FBBC05"/><path d="M20 12.5c1.9 0 3.6.7 4.9 1.9l3.6-3.5A12 12 0 0 0 8.7 14.5l4.2 3.3a7.4 7.4 0 0 1 7.1-5.3Z" fill="#EA4335"/></svg>`;
  if (providerId === "local")
    return `<svg ${common}><rect x="2" y="2" width="36" height="36" rx="11" fill="#2f7d68"/><rect x="9" y="10" width="22" height="15" rx="3" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M14 30h12M20 25v5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="14" cy="17.5" r="1.5" fill="#fff"/><path d="M19 17.5h7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>`;
  return `<svg ${common}><rect x="2" y="2" width="36" height="36" rx="11" fill="#7357ff"/><path d="m20 8 10.5 12L20 32 9.5 20 20 8Zm0 6.4L15.1 20l4.9 5.6 4.9-5.6-4.9-5.6Z" fill="#fff"/></svg>`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return "No completed request yet";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function availabilityHtml(availability, activeOAuth) {
  if (!activeOAuth || !availability || availability.state === "ready")
    return "";
  const reset = availability.resetsAt
    ? ` It resets ${formatDate(availability.resetsAt)}.`
    : "";
  const label =
    availability.state === "usage-limit"
      ? "Provider usage limit reached."
      : availability.state === "model-cooldown"
        ? "This model is temporarily cooling down."
        : "The last provider request failed.";
  return `<div class="codex-availability" role="status"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(availability.message || "")}${escapeHtml(reset)}</span><span>Choose another connected provider or use an OpenAI API key to keep working.</span></div>`;
}

function validateOfficialLoginUrl(value) {
  const exactPrefix = "https://cursor.com/loginDeepControl?";
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    value !== value.trim() ||
    !value.startsWith(exactPrefix)
  )
    throw new Error("Official sign-in returned an unsafe link.");
  let login;
  try {
    login = new URL(value);
  } catch {
    throw new Error("Official sign-in returned an unsafe link.");
  }
  if (
    login.protocol !== "https:" ||
    login.hostname !== "cursor.com" ||
    login.host !== "cursor.com" ||
    login.username ||
    login.password ||
    login.pathname !== "/loginDeepControl" ||
    login.hash
  )
    throw new Error("Official sign-in returned an unsafe link.");
  const allowedKeys = new Set(["challenge", "uuid", "mode", "redirectTarget"]);
  const rawEntries = value.slice(exactPrefix.length).split("&");
  if (
    rawEntries.length !== allowedKeys.size ||
    rawEntries.some((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) return true;
      const key = entry.slice(0, separator);
      const rawValue = entry.slice(separator + 1);
      return !allowedKeys.has(key) || !/^[A-Za-z0-9_-]+$/.test(rawValue);
    })
  )
    throw new Error("Official sign-in returned an unsafe link.");
  const entries = [...login.searchParams.entries()];
  if (
    entries.length !== allowedKeys.size ||
    entries.some(([key]) => !allowedKeys.has(key)) ||
    [...allowedKeys].some(
      (key) => login.searchParams.getAll(key).length !== 1,
    ) ||
    !/^[A-Za-z0-9_-]{43}$/.test(login.searchParams.get("challenge") || "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      login.searchParams.get("uuid") || "",
    ) ||
    login.searchParams.get("mode") !== "login" ||
    login.searchParams.get("redirectTarget") !== "sand"
  )
    throw new Error("Official sign-in returned an unsafe link.");
  return login.href;
}

function openOfficialLoginLink(value) {
  // The authenticated local bridge opens this exact URL through Windows so
  // Electron popup policy cannot silently swallow the sign-in tab. Keep a
  // second renderer-side validation before we begin polling.
  return validateOfficialLoginUrl(value);
}

function setOfficialComputerNotice(message, tone = "info", root = document) {
  officialComputerNotice = {
    message: String(message || ""),
    tone: tone === "error" ? "error" : "info",
  };
  const notice = root.querySelector?.("[data-codex-official-notice]");
  if (!notice) return;
  notice.textContent = officialComputerNotice.message;
  notice.dataset.tone = officialComputerNotice.tone;
}

function setOfficialComputerBusy(panel, busy) {
  const card = panel.querySelector(".codex-computer-card");
  if (!card) return;
  card.setAttribute("aria-busy", busy ? "true" : "false");
  for (const control of card.querySelectorAll("button,input")) {
    if (busy) {
      control.dataset.codexWasDisabled = control.disabled ? "true" : "false";
      control.disabled = true;
    } else if (control.dataset.codexWasDisabled !== undefined) {
      control.disabled = control.dataset.codexWasDisabled === "true";
      delete control.dataset.codexWasDisabled;
    }
  }
}

function setVendorPermissionNotice(message, tone = "info", root = document) {
  officialPermissionNotice = {
    message: String(message || ""),
    tone: tone === "error" ? "error" : "info",
  };
  const notice = root.querySelector?.("[data-codex-permission-notice]");
  if (!notice) return;
  notice.textContent = officialPermissionNotice.message;
  notice.dataset.tone = officialPermissionNotice.tone;
}

function setPrivatePermissionNotice(message, tone = "info", root = document) {
  privatePermissionNotice = {
    message: String(message || ""),
    tone: tone === "error" ? "error" : "info",
  };
  const notice = root.querySelector?.("[data-codex-private-permission-notice]");
  if (!notice) return;
  notice.textContent = privatePermissionNotice.message;
  notice.dataset.tone = privatePermissionNotice.tone;
}

function clearOfficialEnableIntent() {
  officialEnableAfterCursorLogin = false;
}

function startOfficialConnectionPolling() {
  if (officialConnectionPollTimer) return;
  officialConnectionPollTimer = setInterval(loadStatus, 2_000);
}

function syncOfficialConnectionPolling(status) {
  if (officialComputerState(status).state === "signing-in") {
    startOfficialConnectionPolling();
    return;
  }
  clearInterval(officialConnectionPollTimer);
  officialConnectionPollTimer = null;
}

function officialComputerState(status) {
  const value = status?.officialComputer || {};
  return {
    mode:
      value.mode === "official"
        ? "official"
        : value.mode === "private"
          ? "private"
          : "unknown",
    connected: Boolean(value.connected),
    ready: Boolean(value.ready),
    state: String(value.state || "disconnected"),
    retrying: value.retrying === true,
    retryStage: ["access", "provision", "viewer"].includes(value.retryStage)
      ? value.retryStage
      : null,
    lastError: value.lastError ? String(value.lastError) : "",
    permissions: {
      provider: "official-grok-cloud",
      alwaysAllowComputerActions:
        value.permissions?.provider === "official-grok-cloud" &&
        value.permissions?.alwaysAllowComputerActions === true,
    },
  };
}

function privateComputerState(status) {
  const value = status?.privateComputer || {};
  return {
    provider: "private-browser",
    available: value.available !== false,
    permissions: {
      provider: "private-browser",
      alwaysAllowComputerActions:
        value.permissions?.provider === "private-browser" &&
        value.permissions?.alwaysAllowComputerActions === true,
    },
  };
}

async function completeOfficialEnableAfterCursorLogin(status) {
  const computer = officialComputerState(status);
  if (!officialEnableAfterCursorLogin || officialEnableContinuationInFlight)
    return status;
  if (computer.mode === "official") {
    clearOfficialEnableIntent();
    return status;
  }
  if (
    computer.mode !== "private" ||
    !computer.connected ||
    computer.state === "signing-in"
  )
    return status;

  // Consume the user-approved intent before the request so overlapping status
  // polls can never provision the shared computer twice.
  clearOfficialEnableIntent();
  officialEnableContinuationInFlight = true;
  officialComputerOperationInFlight = true;
  setOfficialComputerNotice(
    "Cursor account connected. Checking access and enabling the shared vendor computer...",
  );
  applyUi();
  try {
    const response = await request("/api/official-computer", {
      action: "mode",
      mode: "official",
      acknowledged: true,
    });
    const enabledStatus = response?.status;
    const enabledComputer = officialComputerState({
      officialComputer: enabledStatus,
    });
    if (enabledComputer.mode !== "official" || !enabledComputer.ready)
      throw new Error("The vendor computer did not confirm that it was ready.");
    setOfficialComputerNotice(
      "Cursor account connected. The official vendor computer is live and shared by every employee.",
    );
    return { ...status, officialComputer: enabledStatus };
  } catch (error) {
    setOfficialComputerNotice(
      error?.message ||
        "Cursor sign-in completed, but the vendor computer could not be enabled.",
      "error",
    );
    try {
      const refreshed = await request("/api/codex/status");
      if (refreshed?.officialComputer) return refreshed;
    } catch {}
    return status;
  } finally {
    officialEnableContinuationInFlight = false;
    officialComputerOperationInFlight = false;
  }
}

function officialComputerHtml(status) {
  const computer = officialComputerState(status);
  const active = computer.mode === "official";
  const privateSelected = computer.mode === "private";
  const providerUnavailable = computer.mode === "unknown";
  const stateLabels = {
    disconnected: "Not connected",
    "signed-in": "Connected",
    "signing-in": "Waiting for sign-in",
    "sign-in-error": "Sign-in did not complete",
    "sign-in-blocked": "Sign-in blocked",
    "checking-access": "Checking plan access",
    provisioning: "Starting vendor computer",
    "connecting-view": "Connecting private display relay",
    ready: "Live",
    "payment-required": "Plan or credits required",
    unavailable: "Unavailable",
    "helper-unavailable": "Local helper unavailable",
  };
  const stateLabel = computer.retrying
    ? "Recovering automatically"
    : stateLabels[computer.state] || computer.state;
  const busy =
    [
      "signing-in",
      "checking-access",
      "provisioning",
      "connecting-view",
    ].includes(computer.state) || officialComputerOperationInFlight;
  const disabled = officialComputerOperationInFlight ? " disabled" : "";
  const acknowledgement = `<label class="codex-computer-ack"><input type="checkbox" data-codex-official-ack aria-describedby="codex-official-warning"${busy ? " disabled" : ""} /><span>I understand that vendor credits, telemetry, and background services may apply.</span></label>`;
  const actions = providerUnavailable
    ? '<button type="button" disabled>Official provider unavailable</button>'
    : !computer.connected
      ? computer.state === "signing-in"
        ? `<button type="button" disabled>Waiting for Cursor sign-in...</button><button type="button" data-codex-official-cancel${disabled}>Cancel Cursor sign-in</button>`
        : `${acknowledgement}<button type="button" data-codex-official-login>Sign in to Cursor and enable vendor computer</button>`
      : active
        ? `<button type="button" data-codex-official-disconnect${disabled}>Disconnect official account</button>`
        : `${acknowledgement}<button type="button" data-codex-computer-official${disabled}>Enable experimental vendor computer</button><button type="button" data-codex-official-disconnect${disabled}>Disconnect</button>`;
  const routeBadge = active
    ? "Vendor cloud &middot; Experimental &middot; billing possible"
    : privateSelected
      ? "Auto &middot; Private"
      : "Provider unavailable &middot; mode unknown";
  const routeBadgeClass = active
    ? " is-vendor"
    : providerUnavailable
      ? " is-unavailable"
      : "";
  return `
    <section class="codex-card codex-computer-card" aria-labelledby="codex-computer-mode-title" aria-busy="${officialComputerOperationInFlight ? "true" : "false"}">
      <div class="codex-card-heading">
        <div>
          <h3 id="codex-computer-mode-title">Computer mode</h3>
          <p>Private browser is the default. Official mode is one shared vendor-managed cloud computer for all employees.</p>
        </div>
        <span class="codex-route-badge${routeBadgeClass}">${routeBadge}</span>
      </div>
      <button class="codex-computer-option${privateSelected ? " is-selected" : ""}" type="button" aria-pressed="${privateSelected ? "true" : "false"}" data-codex-computer-private${active && !officialComputerOperationInFlight ? "" : " disabled"}>
        <span class="codex-computer-radio" aria-hidden="true"><span></span></span>
        <span><strong>Private browser</strong><small>Up to three independent persistent browser profiles. Codex plans and acts locally.</small></span>
      </button>
      <div class="codex-official-computer${active ? " is-active" : providerUnavailable ? " is-unavailable" : ""}" aria-labelledby="codex-official-computer-title">
        <div class="codex-official-heading">
          <span><strong id="codex-official-computer-title">Official vendor cloud computer</strong><small>One shared primary screen for every employee &middot; experimental</small></span>
          <span class="codex-official-state" data-state="${escapeHtml(computer.state)}">${escapeHtml(stateLabel)}</span>
        </div>
        <div class="codex-computer-disclosure" id="codex-official-warning" role="note">
          <strong>This is not a free or Codex-only computer.</strong>
          <span>It connects to a vendor-managed VM and may use included or on-demand vendor credits. Authentication, provisioning, and remote-display traffic go to vendor infrastructure.</span>
          <span>Codex remains this app's chat and planning model, and this client sends only screen/input primitives. The vendor VM still contains its own inference, telemetry, transcript, and automation services, so zero vendor-model activity, zero telemetry, and zero charges cannot be guaranteed.</span>
        </div>
        ${computer.lastError ? `<p class="codex-official-error" role="alert">${escapeHtml(computer.lastError)}</p>` : ""}
        ${computer.retrying ? `<p class="codex-settings-notice" data-tone="info" role="status">Automatic retries are throttled to protect your account${computer.retryStage ? ` while recovering the ${escapeHtml(computer.retryStage)}` : ""}.</p>` : ""}
        ${!computer.connected && !providerUnavailable ? '<p class="codex-official-login-domain">Sign in at <strong>cursor.com</strong> with the Cursor account that has cloud-computer access. No separate Grok Bot installation or saved Grok Bot sign-in is required.</p>' : ""}
        <div class="codex-official-actions">${actions}</div>
        <p class="codex-settings-notice" data-codex-official-notice data-tone="${officialComputerNotice.tone}" role="status" aria-live="polite">${escapeHtml(officialComputerNotice.message)}</p>
      </div>
    </section>`;
}

function vendorComputerPermissionsHtml(status) {
  const computer = officialComputerState(status);
  const privateComputer = privateComputerState(status);
  const privateEnabled = privateComputer.permissions.alwaysAllowComputerActions;
  const vendorEnabled = computer.permissions.alwaysAllowComputerActions;
  const unavailable = computer.mode === "unknown";
  const vendorLocked = unavailable || (!computer.connected && !vendorEnabled);
  const privateBusy = privatePermissionOperationInFlight;
  const vendorBusy = officialPermissionOperationInFlight;
  const privateDisabled =
    !privateComputer.available || privateBusy || !privateEnabled;
  const vendorDisabled = vendorLocked || vendorBusy || !vendorEnabled;
  const vendorEnabledDescription =
    computer.mode === "official" && computer.connected
      ? "On for this connected official vendor account. Signing out or starting another sign-in turns it off; you can also turn it off here to restore Allow once or Deny cards."
      : "Stored for this official vendor account on this Windows user. It is not active while the vendor computer is disconnected; you can turn it off here to restore Allow once or Deny cards.";
  return `
    <section class="codex-card codex-permissions-card" aria-labelledby="codex-permissions-title" aria-busy="${privateBusy || vendorBusy ? "true" : "false"}">
      <div class="codex-card-heading">
        <div>
          <h2 id="codex-permissions-title">Computer permissions</h2>
          <p>Choose separately for the Private browser and the vendor cloud computer.</p>
        </div>
        <span class="codex-route-badge">Provider-specific</span>
      </div>
      <div class="codex-permission-scope" data-provider="private-browser">
        <div class="codex-permission-scope-heading">
          <div><strong>Private browser</strong><small>Each employee's isolated local browser</small></div>
          <span class="codex-route-badge${privateEnabled ? " is-active" : ""}">${privateEnabled ? "Always allow" : "Ask each time"}</span>
        </div>
        <div class="codex-permission-warning" id="codex-private-permission-warning" role="note">
          <strong>Always allow lets employees control their Private browsers without asking for every action.</strong>
          <span>Clicks, typing, key presses, form submissions, and navigation will run without an approval card. Take control, session changes, deadlines, and browser safety limits still stop work when needed.</span>
        </div>
        ${
          privateEnabled
            ? ""
            : `<label class="codex-computer-ack"><input type="checkbox" data-codex-private-permission-ack aria-describedby="codex-private-permission-warning"${!privateComputer.available || privateBusy ? " disabled" : ""} /><span>I understand that employees can act in their Private browsers without asking each time.</span></label>`
        }
        <button class="codex-switch-row" type="button" role="switch" aria-checked="${privateEnabled ? "true" : "false"}" aria-describedby="codex-private-permission-warning" data-codex-private-always-allow${privateDisabled ? " disabled" : ""}>
          <span class="codex-switch-icon" aria-hidden="true">${boltIcon({ size: 15 })}</span>
          <span><strong>Always allow Private browser actions</strong><small>${privateEnabled ? "On. Private browser actions run without approval cards; turn this off to ask in chat again." : "Off. Non-automatic Private browser actions ask in the chat."}</small></span>
          <span class="codex-switch-track" aria-hidden="true"><span></span></span>
        </button>
        ${!privateComputer.available ? '<p class="codex-official-error" role="alert">The Private browser service is unavailable, so this permission cannot be changed.</p>' : ""}
        <p class="codex-settings-notice" data-codex-private-permission-notice data-tone="${privatePermissionNotice.tone}" aria-live="polite">${escapeHtml(privatePermissionNotice.message)}</p>
      </div>
      <div class="codex-permission-scope" data-provider="official-grok-cloud">
        <div class="codex-permission-scope-heading">
          <div><strong>Vendor cloud computer</strong><small>One shared remote computer for every employee</small></div>
          <span class="codex-route-badge${vendorEnabled ? " is-vendor" : ""}">${vendorEnabled ? "Always allow" : "Ask each time"}</span>
        </div>
        <div class="codex-permission-warning" id="codex-vendor-permission-warning" role="note">
          <strong>Always allow gives employees broad control of the shared vendor computer.</strong>
          <span>They may click, drag, type, press keys, submit forms, and navigate without showing an approval card for each action. This never changes the Private browser permission above.</span>
          <span>Take control, session and screen-generation changes, action deadlines, and safety stops still interrupt work. This choice is protected for this Windows user with Windows DPAPI.</span>
        </div>
        ${
          vendorEnabled
            ? ""
            : `<label class="codex-computer-ack"><input type="checkbox" data-codex-vendor-permission-ack aria-describedby="codex-vendor-permission-warning"${vendorLocked || vendorBusy ? " disabled" : ""} /><span>I understand that employees can act on the shared vendor computer without asking each time.</span></label>`
        }
        <button class="codex-switch-row" type="button" role="switch" aria-checked="${vendorEnabled ? "true" : "false"}" aria-describedby="codex-vendor-permission-warning" data-codex-vendor-always-allow${vendorDisabled ? " disabled" : ""}>
          <span class="codex-switch-icon" aria-hidden="true">${boltIcon({ size: 15 })}</span>
          <span><strong>Always allow vendor computer actions</strong><small>${vendorEnabled ? vendorEnabledDescription : "Off. Non-automatic vendor actions ask in the chat."}</small></span>
          <span class="codex-switch-track" aria-hidden="true"><span></span></span>
        </button>
        ${vendorLocked ? `<p class="codex-official-error" role="alert">${unavailable ? (vendorEnabled ? "The official provider helper is unavailable. Always allow remains stored and cannot be changed until the helper returns." : "The official provider helper is unavailable, so Always allow cannot be enabled.") : "Connect the official vendor account before enabling this permission."}</p>` : !computer.connected && vendorEnabled ? '<p class="codex-official-error" role="alert">The vendor computer is disconnected, but Always allow is still stored locally. Turn it off here or reconnect the account.</p>' : ""}
        <p class="codex-settings-notice" data-codex-permission-notice data-tone="${officialPermissionNotice.tone}" aria-live="polite">${escapeHtml(officialPermissionNotice.message)}</p>
      </div>
    </section>`;
}

function defaultInferenceHtml(status) {
  const state = inferenceState(status);
  const defaults = state.defaults;
  const modelOptions = state.models
    .map(
      (model) =>
        `<option value="${escapeHtml(model.id)}"${model.id === defaults.model ? " selected" : ""}>${escapeHtml(model.label)}</option>`,
    )
    .join("");
  return `
    <section class="codex-card codex-default-inference" aria-labelledby="codex-default-inference-title">
      <div class="codex-card-heading">
        <div>
          <h3 id="codex-default-inference-title">Default response</h3>
          <p>Used by every employee unless that chat has its own override.</p>
        </div>
        <span class="codex-route-badge">${escapeHtml(modelMeta(defaults.model, state).label)}</span>
      </div>
      <div class="codex-setting-grid">
        <label>Model<select data-codex-default-model>${modelOptions}</select></label>
      </div>
      ${reasoningSliderHtml(state.reasoningEfforts, defaults.reasoningEffort, { attribute: "data-codex-default-reasoning", id: "codex-default-reasoning" })}
      <div class="codex-mode-picker" role="radiogroup" aria-label="Default response mode">
        <button type="button" role="radio" aria-checked="${defaults.responseMode === "chat"}" data-codex-default-mode="chat"><strong>Chat</strong><small>Fast, conversational answers.</small></button>
        <button type="button" role="radio" aria-checked="${defaults.responseMode === "search"}" data-codex-default-mode="search"><strong>Search</strong><small>Quick web lookup with links.</small></button>
        <button type="button" role="radio" aria-checked="${defaults.responseMode === "research"}" data-codex-default-mode="research"><strong>Research</strong><small>Browse, verify, and cite sources.</small></button>
      </div>
      <button class="codex-switch-row" type="button" role="switch" aria-checked="${defaults.fastMode && state.fastCapability?.supported !== false ? "true" : "false"}" data-codex-default-fast${state.fastCapability?.supported === false ? " disabled" : ""}>
        <span class="codex-switch-icon">${boltIcon({ size: 15 })}</span>
        <span><strong>Fast mode</strong><small>${state.fastCapability?.supported === false ? "This provider does not expose Fast mode through CLIProxyAPI." : "Prioritizes lower latency. Direct API keys use premium per-token pricing; Codex OAuth can consume allowance faster."}</small></span>
        <span class="codex-switch-track"><span></span></span>
      </button>
      <p class="codex-settings-notice" data-codex-settings-notice aria-live="polite"></p>
    </section>
    ${officialComputerHtml(status)}
    ${vendorComputerPermissionsHtml(status)}
    ${imageStudioHtml(status)}
    ${alwaysOnHtml(status)}`;
}

function alwaysOnHtml(status) {
  const alwaysOn = status?.settings?.alwaysOn || {};
  const active = alwaysOn.workerActive === true;
  return `
    <section class="codex-card codex-always-on" aria-labelledby="codex-always-on-title">
      <div class="codex-card-heading">
        <div>
          <h3 id="codex-always-on-title">Always On</h3>
          <p>Keeps routines and employees available after the window closes.</p>
        </div>
        <span class="codex-route-badge${active ? "" : " is-unavailable"}">${active ? "Worker active" : "Worker unavailable"}</span>
      </div>
      <ul>
        <li>Missed schedules recover from the last ${escapeHtml(alwaysOn.catchupHours || 24)} hours without replay storms.</li>
        <li>Duplicate scans and duplicate in-flight runs are blocked.</li>
        <li>Windows retries the worker up to ${escapeHtml(alwaysOn.restartAttempts || 10)} times after a crash.</li>
      </ul>
      <p class="codex-settings-notice" data-tone="${active ? "info" : "error"}">${active ? "Routines continue locally while this Windows account is signed in." : "Restart Open Bot to restore the local routine worker."}</p>
    </section>`;
}

function imageStudioHtml(status) {
  const capability = status?.images || {};
  const available = capability.available === true;
  return `
    <section class="codex-card codex-image-studio" aria-labelledby="codex-image-studio-title">
      <div class="codex-card-heading">
        <div>
          <h3 id="codex-image-studio-title">Create images</h3>
          <p>Generate a new image with GPT Image 2.</p>
        </div>
        <span class="codex-route-badge${available ? "" : " is-unavailable"}">${available ? "Ready" : "API key needed"}</span>
      </div>
      ${
        available
          ? `<form data-codex-image-form>
              <label for="codex-image-prompt">Describe the image</label>
              <textarea id="codex-image-prompt" data-codex-image-prompt rows="3" maxlength="4000" placeholder="A documentary photo of..." required></textarea>
              <div class="codex-image-options">
                <label>Canvas<select data-codex-image-size>${(capability.sizes || ["1024x1024"]).map((size) => `<option value="${escapeHtml(size)}">${escapeHtml(size)}</option>`).join("")}</select></label>
                <label>Quality<select data-codex-image-quality>${(capability.qualities || ["low", "medium", "high"]).map((quality) => `<option value="${escapeHtml(quality)}"${quality === "medium" ? " selected" : ""}>${escapeHtml(quality[0].toUpperCase() + quality.slice(1))}</option>`).join("")}</select></label>
              </div>
              <button type="submit" data-codex-image-submit>Generate image</button>
            </form>
            <div class="codex-image-result" data-codex-image-result hidden>
              <img data-codex-image-output src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="Generated image" />
              <a data-codex-image-download download="open-bot-image.png">Download PNG</a>
            </div>`
          : `<p class="codex-image-unavailable">${escapeHtml(capability.reason || "Connect a direct OpenAI API key to use image generation.")}</p>`
      }
      <p class="codex-settings-notice" data-codex-image-notice aria-live="polite"></p>
    </section>`;
}

async function request(path, body) {
  await verifyCodexViewServer();
  const response = await fetch(`${CODEX_SERVICE}${path}`, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: body
      ? { ...headers, "Content-Type": "application/json" }
      : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(value.error || `Codex service returned ${response.status}`);
  return value;
}
globalThis.__CODEX_BOT_VIEW_REQUEST__ = request;

function acceptAuthoritativeStatus(status) {
  const previousProvider = lastStatus?.connection?.provider || null;
  const nextProvider = status?.connection?.provider || null;
  lastStatus = status;
  if (previousProvider && nextProvider && previousProvider !== nextProvider) {
    agentStatusCache.clear();
    pendingAgentStatusLoads.clear();
    if (activeModelPicker) renderActiveModelPicker(status);
  }
  return lastStatus;
}

function clearProviderConnectionPoll() {
  clearInterval(connectionPollTimer);
  connectionPollTimer = null;
}

function providerCredentialReady(status, pending = pendingOAuthDevice) {
  if (!pending?.provider) return false;
  const provider = status?.providers?.find(
    (item) => item.id === pending.provider,
  );
  if (!provider?.signedIn) return false;
  const previous = pending.previousCredentialRevision;
  const current = provider.credentialRevision;
  if (previous == null) return current != null;
  return current != null && Number(current) !== Number(previous);
}

async function cancelPendingProviderLogin(
  panel,
  { message = "Provider sign-in cancelled.", restoreActive = true } = {},
) {
  const pending = pendingOAuthDevice;
  if (!pending?.provider) return false;
  pendingOAuthDevice = null;
  clearProviderConnectionPoll();
  let failure = null;
  try {
    await request("/api/codex/auth", {
      action: "cancel-provider-login",
      provider: pending.provider,
    });
  } catch (error) {
    failure = error;
  }
  const select = panel?.querySelector?.("[data-codex-provider]");
  if (restoreActive && select && lastStatus?.connection?.provider)
    select.value =
      lastStatus.connection.provider === "openai-api-key"
        ? "codex"
        : lastStatus.connection.provider;
  if (panel) syncProviderControls(panel);
  const notice = panel?.querySelector?.("[data-codex-notice]");
  if (notice) {
    notice.textContent = failure?.message || message;
    notice.dataset.tone = failure ? "error" : "info";
  }
  providerConnectionNotice = {
    message: failure?.message || message,
    tone: failure ? "error" : "info",
  };
  return !failure;
}

async function completePendingProviderLogin(status) {
  const pending = pendingOAuthDevice;
  if (!pending?.provider) return status;
  const backendLogin = status?.providerLogin;
  if (backendLogin?.provider === pending.provider) {
    if (backendLogin.state === "connected") {
      pendingOAuthDevice = null;
      selectedProviderId = pending.provider;
      clearProviderConnectionPoll();
      providerConnectionNotice = {
        message:
          backendLogin.message ||
          `${pending.providerLabel || "Provider"} connected. Models and reasoning controls are now updated for this provider.`,
        tone: "info",
      };
      return status;
    }
    if (backendLogin.state === "error" || backendLogin.state === "cancelled") {
      pendingOAuthDevice = null;
      clearProviderConnectionPoll();
      providerConnectionNotice = {
        message:
          backendLogin.message ||
          `${pending.providerLabel || "Provider"} sign-in did not finish locally. Try again.`,
        tone: backendLogin.state === "error" ? "error" : "info",
      };
      return status;
    }
  }
  if (Date.now() >= Number(pending.deadlineAt || 0)) {
    await cancelPendingProviderLogin(null, {
      message: `${pending.providerLabel || "Provider"} sign-in timed out. Try again.`,
    });
    return status;
  }
  if (!providerCredentialReady(status, pending) || providerActivationInFlight)
    return status;
  providerActivationInFlight = true;
  try {
    const result = await request("/api/codex/auth", {
      action: "use-provider",
      provider: pending.provider,
    });
    pendingOAuthDevice = null;
    clearProviderConnectionPoll();
    providerConnectionNotice = {
      message: `${pending.providerLabel || "Provider"} connected. Models and reasoning controls are now updated for this provider.`,
      tone: "info",
    };
    return result.status || status;
  } catch (error) {
    if (pendingOAuthDevice === pending)
      pendingOAuthDevice = { ...pending, error: error.message };
    providerConnectionNotice = { message: error.message, tone: "error" };
    return status;
  } finally {
    providerActivationInFlight = false;
  }
}

async function loadStatus() {
  try {
    const previousOfficial = officialComputerState(lastStatus);
    let status = acceptAuthoritativeStatus(await request("/api/codex/status"));
    status = await completePendingProviderLogin(status);
    acceptAuthoritativeStatus(status);
    let currentOfficial = officialComputerState(lastStatus);
    if (!pendingOAuthDevice && hasCodexConnection(lastStatus))
      clearProviderConnectionPoll();
    if (
      previousOfficial.state === "signing-in" &&
      currentOfficial.connected &&
      currentOfficial.state !== "signing-in"
    ) {
      if (!officialEnableAfterCursorLogin)
        setOfficialComputerNotice(
          "Cursor account connected. Review the warning before enabling its cloud computer.",
        );
    } else if (
      previousOfficial.state === "signing-in" &&
      !currentOfficial.connected &&
      currentOfficial.state !== "signing-in"
    ) {
      clearOfficialEnableIntent();
      setOfficialComputerNotice(
        currentOfficial.lastError ||
          "Cursor sign-in did not complete. Try again.",
        "error",
      );
    }
    if (
      currentOfficial.mode === "unknown" ||
      ["sign-in-error", "sign-in-blocked"].includes(currentOfficial.state)
    )
      clearOfficialEnableIntent();
    lastStatus = await completeOfficialEnableAfterCursorLogin(lastStatus);
    currentOfficial = officialComputerState(lastStatus);
    if (currentOfficial.mode === "official") clearOfficialEnableIntent();
    syncOfficialConnectionPolling(lastStatus);
    applyUi();
    return lastStatus;
  } catch (error) {
    clearOfficialEnableIntent();
    clearInterval(officialConnectionPollTimer);
    officialConnectionPollTimer = null;
    const notice = document.querySelector("[data-codex-notice]");
    if (notice) {
      notice.textContent = `Local Codex service unavailable: ${error.message}`;
      notice.dataset.tone = "error";
    }
    return null;
  }
}

async function loadAgentStatus(agentId, { force = false } = {}) {
  if (!agentId) return lastStatus;
  if (!force && agentStatusCache.has(agentId))
    return agentStatusCache.get(agentId);
  if (pendingAgentStatusLoads.has(agentId))
    return pendingAgentStatusLoads.get(agentId);

  let pending;
  pending = request(`/api/codex/status?agentId=${encodeURIComponent(agentId)}`)
    .then((status) => {
      if (pendingAgentStatusLoads.get(agentId) === pending) {
        agentStatusCache.set(agentId, status);
        updateModelPickerButtons(agentId, status);
      }
      return status;
    })
    .finally(() => {
      if (pendingAgentStatusLoads.get(agentId) === pending)
        pendingAgentStatusLoads.delete(agentId);
    });
  pendingAgentStatusLoads.set(agentId, pending);
  return pending;
}

function refreshAgentStatusIfMissing(agentId) {
  if (!agentId || agentStatusCache.has(agentId)) return;
  void loadAgentStatus(agentId).catch(() => {});
}

function refreshVisibleAgentStatuses() {
  for (const button of document.querySelectorAll("[data-codex-model-picker]")) {
    refreshAgentStatusIfMissing(button.dataset.codexAgentId);
  }
}

function isStatusRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeStatusSnapshot(previous, update) {
  if (!isStatusRecord(previous) || !isStatusRecord(update)) return update;
  const merged = { ...previous, ...update };
  for (const [key, value] of Object.entries(update)) {
    if (
      Object.prototype.hasOwnProperty.call(previous, key) &&
      isStatusRecord(previous[key]) &&
      isStatusRecord(value)
    ) {
      Object.defineProperty(merged, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: mergeStatusSnapshot(previous[key], value),
      });
    }
  }
  return merged;
}

async function saveInferenceSettings(body) {
  const result = await request("/api/codex/settings", body);
  const status = mergeStatusSnapshot(lastStatus, result.status || result);
  if (body.scope === "agent" && body.agentId) {
    pendingAgentStatusLoads.delete(body.agentId);
    agentStatusCache.set(body.agentId, status);
    updateModelPickerButtons(body.agentId, status);
  } else {
    lastStatus = status;
    agentStatusCache.clear();
    pendingAgentStatusLoads.clear();
    installConnectionPanel(status);
    refreshVisibleAgentStatuses();
  }
  return status;
}

function pollForConnection() {
  if (connectionPollTimer) return;
  connectionPollTimer = setInterval(loadStatus, 2_000);
}

function replaceVisibleBranding(root = document.body) {
  if (!root) return;
  const replacements = [
    [/Codex Bot/g, "Open Bot"],
    [/Grok Bot/g, "Open Bot"],
    [
      /Sign (?:In with|in to) Cursor with your Cursor account/g,
      "Connect an AI provider",
    ],
    [/Sign In with Cursor/g, "Connect an AI provider"],
    [/Sign in to Cursor/g, "Connect an AI provider"],
    [/Cursor account/g, "AI provider account"],
    [/Signed in to Cursor/g, "Signed in to Codex"],
  ];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement?.closest("script,style,[data-codex-local]"))
      continue;
    let next = node.nodeValue;
    for (const [pattern, replacement] of replacements)
      next = next.replace(pattern, replacement);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  document.title = "Open Bot";
}

function hideUnavailableSurfaces() {
  for (const element of document.querySelectorAll(
    "button, [role='menuitem'], .sand-agents-sidebar__plugins-entry",
  )) {
    const text = element.textContent?.trim();
    if (
      text === "Plugins" ||
      text === "Usage & Billing" ||
      text === "Updates"
    ) {
      element.style.display = "none";
      element.dataset.codexUnavailable = "true";
    }
  }
  for (const element of document.querySelectorAll(
    "button, [role='menuitem']",
  )) {
    const text = element.textContent?.trim() || "";
    if (
      /Get Codex Bot for iOS|New update available|A new version of the app is available|Weekly usage/i.test(
        text,
      ) ||
      /Downloading update/i.test(element.getAttribute("aria-label") || "")
    ) {
      element.style.setProperty("display", "none", "important");
      element.dataset.codexUnavailable = "true";
    } else if (text === "Log out") {
      element.textContent = "Manage AI provider";
      element.dataset.codexManageConnection = "true";
    }
  }
  const unavailableIntegrations = new Set([
    "Slack message",
    "Git event",
    "Teams message",
    "Linear issue",
    "Sentry alert",
    "PagerDuty incident",
  ]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const unavailableRows = [];
  while (walker.nextNode()) {
    const label = walker.currentNode.nodeValue?.trim() || "";
    if (!unavailableIntegrations.has(label)) continue;
    const parent = walker.currentNode.parentElement;
    const row =
      parent?.closest(
        "button, [role='menuitem'], [role='option'], [data-radix-collection-item]",
      ) || parent;
    if (row) unavailableRows.push(row);
  }
  for (const row of unavailableRows) {
    row.style.setProperty("display", "none", "important");
    row.dataset.codexUnavailable = "true";
  }
}

function updateSidebarIdentity(status) {
  const account = status?.account;
  const activeName = account?.signedIn ? String(account.name || "") : "";
  const displayName =
    (activeName && !/ account$/i.test(activeName) ? activeName : null) ||
    status?.owner?.name ||
    activeName ||
    (status?.connection?.mode === "api-key" ? "OpenAI API" : null);
  if (!displayName) return;
  for (const name of document.querySelectorAll(
    ".sand-agents-sidebar__account-name",
  )) {
    if (name.tagName !== "INPUT") name.textContent = displayName;
  }
  const footer = document.querySelector(".sand-agents-sidebar__account");
  if (!footer) return;
  const walker = document.createTreeWalker(footer, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (
      ["Codex Bot User", "Codex Bot", "Open Bot User", "Open Bot"].includes(
        walker.currentNode.nodeValue?.trim(),
      )
    )
      walker.currentNode.nodeValue = displayName;
  }
  footer.title = `${displayName}${account?.email ? ` - ${account.email}` : ""} - ${status.connection.route}`;
  const image = footer.querySelector("img");
  if (image && account?.avatarUrl) image.src = account.avatarUrl;
  else if (image) {
    const holder = image.parentElement;
    image.remove();
    if (holder) holder.textContent = initials(displayName);
  }
}

function onboardingProviders(status) {
  const account = status?.account || {};
  return Array.isArray(status?.providers) && status.providers.length
    ? status.providers
    : [
        {
          id: "codex",
          label: "OpenAI Codex",
          description: "Use a ChatGPT account with Codex access.",
          loginKind: "device",
          signedIn: Boolean(account.signedIn),
        },
      ];
}

function onboardingProviderStepHtml(status) {
  const providers = onboardingProviders(status);
  const connection = status?.connection || {};
  const account = status?.account || {};
  const selectedId =
    pendingOAuthDevice?.provider ||
    selectedProviderId ||
    connection.provider ||
    account.provider ||
    "codex";
  const selected =
    providers.find((provider) => provider.id === selectedId) || providers[0];
  const options = providers
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}" data-label="${escapeHtml(provider.label)}" data-description="${escapeHtml(provider.description)}" data-login-kind="${escapeHtml(provider.loginKind)}" data-signed-in="${provider.signedIn ? "true" : "false"}" data-local-base-url="${escapeHtml(provider.baseUrl || "")}" data-credential-revision="${provider.credentialRevision == null ? "" : escapeHtml(provider.credentialRevision)}"${provider.id === selected.id ? " selected" : ""}>${escapeHtml(provider.label)}</option>`,
    )
    .join("");
  const tiles = providers
    .map((provider) => {
      const active =
        provider.signedIn &&
        connection.mode !== "api-key" &&
        connection.provider === provider.id;
      const pending = pendingOAuthDevice?.provider === provider.id;
      const state = pending
        ? "Waiting for sign-in"
        : active
          ? "Ready to use"
          : provider.signedIn
            ? "Connected"
            : provider.loginKind === "service-account"
              ? "Import key"
              : provider.loginKind === "local"
                ? "Configure server"
                : "Sign in";
      return `<button class="codex-provider-tile${active ? " is-active" : ""}" type="button" data-codex-onboarding-provider="${escapeHtml(provider.id)}" aria-pressed="${active ? "true" : "false"}"${pending ? " disabled" : ""}>
        <span class="codex-provider-logo">${providerLogo(provider.id)}</span>
        <span class="codex-provider-tile-copy"><strong>${escapeHtml(provider.label)}</strong><small>${escapeHtml(state)}</small></span>
        <span class="codex-provider-state" aria-hidden="true">${active || provider.signedIn ? "✓" : "→"}</span>
      </button>`;
    })
    .join("");
  return `<section class="codex-onboarding-panel" aria-labelledby="codex-connect-title">
    <div class="codex-onboarding-heading">
      <span class="codex-step-count">1 of 3</span>
      <h2 id="codex-connect-title">Connect an AI provider</h2>
      <p>Choose an AI account or a local model server for Open Bot. You can connect more providers later in Settings.</p>
    </div>
    <div class="codex-provider-grid" role="group" aria-label="AI providers">${tiles}</div>
    <select class="codex-visually-hidden" data-codex-provider aria-label="Selected AI provider">${options}</select>
    <button class="codex-visually-hidden" type="button" data-codex-provider-connect>${escapeHtml(selected?.signedIn ? `Use ${selected.label}` : `Connect ${selected.label}`)}</button>
    <div class="codex-onboarding-detail">
      <p data-codex-provider-description>${escapeHtml(selected?.description || "")}</p>
      <button type="button" class="codex-text-action" data-codex-key-toggle>Use an OpenAI API key instead</button>
    </div>
    <form class="codex-vertex-form" data-codex-vertex-form${selected?.loginKind === "service-account" ? "" : " hidden"}>
      <label for="codex-onboarding-vertex-key">Google service-account JSON</label>
      <input id="codex-onboarding-vertex-key" type="file" accept="application/json,.json" required />
      <button type="submit">Verify & import for Vertex AI</button>
      <small>The key is handed only to the bundled local importer and the temporary upload is deleted.</small>
    </form>
    <form class="codex-local-form" data-codex-local-form${selected?.loginKind === "local" ? "" : " hidden"}>
      <label for="codex-onboarding-local-url">Local OpenAI-compatible endpoint</label>
      <input id="codex-onboarding-local-url" data-codex-local-url type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="200" aria-describedby="codex-onboarding-local-help" value="${escapeHtml(selected?.baseUrl || "http://127.0.0.1:11434/v1")}" required />
      <label for="codex-onboarding-local-key">API key <span>(optional)</span></label>
      <input id="codex-onboarding-local-key" data-codex-local-key type="password" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="codex-onboarding-local-help" />
      <button type="submit">Connect & discover models</button>
      <small id="codex-onboarding-local-help">Only a literal 127.0.0.1 address is accepted. Your server and selected model must support OpenAI-compatible streaming and tool calling.</small>
    </form>
    <form class="codex-key-form" data-codex-key-form hidden>
      <label for="codex-onboarding-api-key">OpenAI API key</label>
      <div><input id="codex-onboarding-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." required /><button type="submit">Verify & use</button></div>
    </form>
    <p class="codex-notice" data-codex-notice data-tone="${escapeHtml(providerConnectionNotice.tone)}" aria-live="polite">${escapeHtml(providerConnectionNotice.message)}</p>
    <div class="codex-onboarding-footer">
      <span>${hasCodexConnection(status) ? `${escapeHtml(status.account?.name || status.connection?.providerLabel || "Provider")} is connected.` : "Connect one provider to continue."}</span>
      <button class="codex-primary-action" type="button" data-codex-onboarding-next="computer"${hasCodexConnection(status) ? "" : " disabled"}>Continue</button>
    </div>
  </section>`;
}

function onboardingComputerStepHtml(status) {
  const computer = officialComputerState(status);
  const officialReady = computer.mode === "official" && computer.ready;
  const cloudSelected =
    officialReady || onboardingComputerChoice === "official";
  const privateSelected = !cloudSelected;
  const busy = officialComputerOperationInFlight;
  const cloudAction = !computer.connected
    ? computer.state === "signing-in"
      ? `<button type="button" disabled>Waiting for Cursor sign-in...</button><button type="button" data-codex-official-cancel>Cancel</button>`
      : `<label class="codex-computer-ack"><input type="checkbox" data-codex-official-ack aria-describedby="codex-onboarding-cloud-warning" /><span>I understand vendor credits, telemetry, and background services may apply.</span></label><button type="button" data-codex-official-login>Sign in to Cursor & enable</button>`
    : officialReady
      ? '<span class="codex-onboarding-success">Connected and ready</span>'
      : `<label class="codex-computer-ack"><input type="checkbox" data-codex-official-ack aria-describedby="codex-onboarding-cloud-warning" /><span>I understand vendor credits, telemetry, and background services may apply.</span></label><button type="button" data-codex-computer-official>Enable cloud computer</button>`;
  return `<section class="codex-onboarding-panel" aria-labelledby="codex-computer-title">
    <div class="codex-onboarding-heading">
      <span class="codex-step-count">2 of 3</span>
      <h2 id="codex-computer-title">Choose where employees browse</h2>
      <p>Start with private browser seats on this PC, or connect the experimental shared vendor cloud computer.</p>
    </div>
    <div class="codex-onboarding-computers" role="radiogroup" aria-label="Computer mode">
      <button class="codex-onboarding-computer${privateSelected ? " is-selected" : ""}" type="button" role="radio" aria-checked="${privateSelected ? "true" : "false"}" data-codex-onboarding-private>
        <span class="codex-computer-glyph is-private" aria-hidden="true"><svg viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="17" rx="3"/><path d="M11 27h10M16 23v4"/></svg></span>
        <span><strong>Private browser</strong><small>Recommended · persistent profiles isolated per employee on this PC.</small></span>
        <span class="codex-choice-check" aria-hidden="true"></span>
      </button>
      <div class="codex-onboarding-computer codex-cloud-choice${cloudSelected ? " is-selected" : ""}" role="radio" aria-checked="${cloudSelected ? "true" : "false"}">
        <button class="codex-cloud-choice-main" type="button" data-codex-onboarding-cloud${busy ? " disabled" : ""}>
          <span class="codex-computer-glyph is-cloud" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M9 24h15a5 5 0 0 0 .6-10A8 8 0 0 0 9.5 12 6 6 0 0 0 9 24Z"/><path d="M12 19h8"/></svg></span>
          <span><strong>Vendor cloud computer</strong><small>Experimental · one shared remote screen; vendor billing and telemetry may apply.</small></span>
          <span class="codex-choice-check" aria-hidden="true"></span>
        </button>
        <div class="codex-cloud-setup"${cloudSelected ? "" : " hidden"}>
          <p id="codex-onboarding-cloud-warning">Sign in at cursor.com with an account that has cloud-computer access. This is separate from your AI provider login.</p>
          <div class="codex-official-actions">${cloudAction}</div>
          ${computer.lastError ? `<p class="codex-official-error" role="alert">${escapeHtml(computer.lastError)}</p>` : ""}
          <p class="codex-settings-notice" data-codex-official-notice data-tone="${officialComputerNotice.tone}" aria-live="polite">${escapeHtml(officialComputerNotice.message)}</p>
        </div>
      </div>
    </div>
    <div class="codex-onboarding-footer">
      <button class="codex-text-action" type="button" data-codex-onboarding-back="providers">Back</button>
      <button class="codex-primary-action" type="button" data-codex-onboarding-next="complete"${privateSelected || officialReady ? "" : " disabled"}>Continue</button>
    </div>
  </section>`;
}

function onboardingCompleteStepHtml(status) {
  const provider =
    status?.connection?.providerLabel ||
    status?.account?.providerLabel ||
    "AI provider";
  const computer = officialComputerState(status);
  const computerLabel =
    computer.mode === "official" && computer.ready
      ? "Vendor cloud computer"
      : "Private browser";
  return `<section class="codex-onboarding-panel codex-onboarding-complete" aria-labelledby="codex-complete-title">
    <div class="codex-complete-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="22"/><path d="m14 24 7 7 14-15"/></svg></div>
    <div class="codex-onboarding-heading">
      <span class="codex-step-count">3 of 3</span>
      <h2 id="codex-complete-title">You’re all set</h2>
      <p>Your provider is connected and your computer mode is ready. Create an employee and give it a real outcome to own.</p>
    </div>
    <dl class="codex-onboarding-summary">
      <div><dt>AI provider</dt><dd>${escapeHtml(provider)}</dd></div>
      <div><dt>Computer</dt><dd>${escapeHtml(computerLabel)}</dd></div>
      <div><dt>Account</dt><dd>${escapeHtml(status?.account?.name || "Connected")}</dd></div>
    </dl>
    <div class="codex-onboarding-footer is-complete">
      <button class="codex-text-action" type="button" data-codex-onboarding-back="computer">Back</button>
      <button class="codex-primary-action" type="button" data-codex-onboarding-finish>Enter Open Bot</button>
    </div>
  </section>`;
}

function firstRunOnboardingHtml(status) {
  if (onboardingStep === "computer") return onboardingComputerStepHtml(status);
  if (onboardingStep === "complete") return onboardingCompleteStepHtml(status);
  return onboardingProviderStepHtml(status);
}

function connectionPanelHtml(status, { firstRun = false } = {}) {
  const account = status.account || {};
  const connection = status.connection || {};
  const providers =
    Array.isArray(status.providers) && status.providers.length
      ? status.providers
      : [
          {
            id: "codex",
            label: "OpenAI Codex",
            description: "Use a ChatGPT account with Codex access.",
            loginKind: "device",
            signedIn: Boolean(account.signedIn),
          },
        ];
  const usage = status.usage || {};
  const apiKeyActive = connection.mode === "api-key";
  const localActive = connection.mode === "local";
  const connectedProviderId =
    connection.provider === "openai-api-key"
      ? account.provider || "codex"
      : connection.provider || account.provider || "codex";
  const connectedProvider = providers.find(
    (provider) => provider.id === connectedProviderId,
  ) ||
    providers[0] || {
      id: "codex",
      label: "OpenAI Codex",
      description: "Use a ChatGPT account with Codex access.",
      loginKind: "device",
      signedIn: Boolean(account.signedIn),
    };
  const selectedProvider =
    providers.find(
      (provider) => provider.id === pendingOAuthDevice?.provider,
    ) ||
    providers.find((provider) => provider.id === selectedProviderId) ||
    connectedProvider;
  const providerOptions = providers
    .map(
      (provider) =>
        `<option value="${escapeHtml(provider.id)}" data-label="${escapeHtml(provider.label)}" data-description="${escapeHtml(provider.description)}" data-login-kind="${escapeHtml(provider.loginKind)}" data-signed-in="${provider.signedIn ? "true" : "false"}" data-local-base-url="${escapeHtml(provider.baseUrl || "")}" data-credential-revision="${provider.credentialRevision == null ? "" : escapeHtml(provider.credentialRevision)}"${provider.id === selectedProvider.id ? " selected" : ""}>${escapeHtml(provider.label)}${provider.signedIn ? " — connected" : ""}</option>`,
    )
    .join("");
  const plan = account.plan
    ? account.plan[0].toUpperCase() + account.plan.slice(1)
    : null;
  const accountName = apiKeyActive
    ? "OpenAI API key connected"
    : account.signedIn
      ? account.name
      : "Not connected";
  const accountDetail = apiKeyActive
    ? "Stored securely for this Windows user"
    : localActive
      ? connectedProvider.baseUrl || "Loopback model endpoint"
      : account.signedIn
        ? account.email || `${connectedProvider.label} account`
        : "Choose a provider or use an OpenAI API key";
  const connectionDetail =
    apiKeyActive && !account.signedIn
      ? "Direct OpenAI API"
      : plan || connectedProvider.label;
  const avatar =
    !apiKeyActive && account.avatarUrl
      ? `<img class="codex-avatar" src="${escapeHtml(account.avatarUrl)}" alt="" />`
      : `<span class="codex-avatar codex-initials">${escapeHtml(apiKeyActive ? "OA" : initials(account.name))}</span>`;
  const activeOAuth = !apiKeyActive && !localActive;
  const providerActionLabel = selectedProvider.signedIn
    ? activeOAuth
      ? connectedProvider.id === selectedProvider.id
        ? `Reconnect ${selectedProvider.label}`
        : `Use ${selectedProvider.label}`
      : `Use ${selectedProvider.label}`
    : `Connect ${selectedProvider.label}`;
  const currentAvailability = availabilityHtml(usage.availability, activeOAuth);
  const firstRunIntroduction = firstRun
    ? `<div class="codex-first-run-copy">
        <h2 id="codex-connect-title">Connect an AI provider to start</h2>
        <p>Choose which account or local model family your employees will use. Open Bot stores the connection locally and routes only to your selection.</p>
      </div>`
    : "";
  const firstRunAssurance = firstRun
    ? `<p class="codex-connection-assurance">Hosted-provider sign-ins open only reviewed official authorization pages. API keys, imported credentials, and local-server settings are stored only for this Windows user.</p>`
    : "";
  return `
    <section class="codex-card${firstRun ? " codex-first-run-card" : ""}" aria-label="AI provider connection">
      ${firstRunIntroduction}
      <div class="codex-account-row">
        ${avatar}
        <div class="codex-account-copy">
          <strong>${escapeHtml(accountName)}</strong>
          <span>${escapeHtml(accountDetail)}</span>
          <span>${escapeHtml(connectionDetail)} &middot; ${escapeHtml(connection.route)}</span>
        </div>
      </div>
      ${currentAvailability}
      <div class="codex-provider-picker">
        <label for="codex-provider-select">AI provider</label>
        <select id="codex-provider-select" data-codex-provider>${providerOptions}</select>
        <p data-codex-provider-description>${escapeHtml(selectedProvider.description)}</p>
      </div>
      <div class="codex-actions">
        <button type="button" data-codex-provider-connect${["service-account", "local"].includes(selectedProvider.loginKind) ? " hidden" : ""}>${escapeHtml(providerActionLabel)}</button>
        <button type="button" data-codex-key-toggle>Use OpenAI API key</button>
      </div>
      <form class="codex-vertex-form" data-codex-vertex-form${selectedProvider.loginKind === "service-account" ? "" : " hidden"}>
        <label for="codex-vertex-key">Google service-account JSON</label>
        <input id="codex-vertex-key" type="file" accept="application/json,.json" required />
        <button type="submit">Verify & import for Vertex AI</button>
        <small>The key is handed only to the bundled local CLIProxyAPI importer, then the temporary upload is deleted. It is never written to logs.</small>
      </form>
      <form class="codex-local-form" data-codex-local-form${selectedProvider.loginKind === "local" ? "" : " hidden"}>
        <label for="codex-local-url">Local OpenAI-compatible endpoint</label>
        <input id="codex-local-url" data-codex-local-url type="url" inputmode="url" autocomplete="off" spellcheck="false" maxlength="200" aria-describedby="codex-local-help" value="${escapeHtml(selectedProvider.baseUrl || "http://127.0.0.1:11434/v1")}" required />
        <label for="codex-local-key">API key <span>(optional)</span></label>
        <input id="codex-local-key" data-codex-local-key type="password" autocomplete="off" spellcheck="false" maxlength="4096" aria-describedby="codex-local-help" placeholder="Leave blank to keep the saved key" />
        <button type="submit">Connect & discover models</button>
        <small id="codex-local-help">Works with Ollama, LM Studio, vLLM, and other OpenAI-compatible servers on this PC. Only literal 127.0.0.1 endpoints are allowed; tool calling and streaming are required for employee workflows.</small>
      </form>
      <form class="codex-key-form" data-codex-key-form hidden>
        <label for="codex-api-key">OpenAI API key</label>
        <div><input id="codex-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." required /><button type="submit">Verify & use</button></div>
        <small>Use a direct key from platform.openai.com. Composio project keys belong in Connected apps; OpenRouter keys use a different service. The key is verified with OpenAI, stored with Windows user-level encryption, and never written to logs.</small>
      </form>
      ${firstRunAssurance}
      <p class="codex-notice" data-codex-notice data-tone="${escapeHtml(providerConnectionNotice.tone)}" aria-live="polite">${escapeHtml(providerConnectionNotice.message)}</p>
    </section>
    ${
      firstRun
        ? ""
        : `
    <section class="codex-card" aria-label="Open Bot usage">
      <h3>Local bridge usage</h3>
      <div class="codex-metrics">
        <div><strong>${formatNumber(usage.requests)}</strong><span>requests</span></div>
        <div><strong>${formatNumber(usage.totalTokens)}</strong><span>total tokens</span></div>
        <div><strong>${formatNumber(usage.promptTokens)}</strong><span>input tokens</span></div>
        <div><strong>${formatNumber(usage.completionTokens)}</strong><span>output tokens</span></div>
        <div><strong>${formatNumber(usage.toolCalls)}</strong><span>tool calls</span></div>
      </div>
      <p>${escapeHtml(connection.model)} &middot; reasoning ${escapeHtml(connection.reasoningEffort)} &middot; last completion ${escapeHtml(formatDate(usage.lastCompletedAt))}</p>
      <small>These are measured local bridge totals, not a provider quota. Remaining subscription or account allowance may not be available through the selected route.</small>
    </section>
    ${defaultInferenceHtml(status)}`
    }`;
}

function validateProviderLoginUrl(providerId, value) {
  try {
    const target = PROVIDER_LOGIN_TARGETS[providerId];
    const candidate = new URL(String(value || ""));
    if (
      !target ||
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password ||
      candidate.port ||
      candidate.hash ||
      candidate.hostname !== target.host ||
      (target.path && candidate.pathname.replace(/\/+$/, "") !== target.path) ||
      (!target.path && (!candidate.pathname || candidate.pathname === "/"))
    )
      return null;
    if (providerId === "codex" && (candidate.search || candidate.hash))
      return null;
    return providerId === "codex" ? CODEX_DEVICE_URL : candidate.toString();
  } catch {
    return null;
  }
}

function renderOAuthDevicePrompt(
  notice,
  device = pendingOAuthDevice,
  panel = notice?.closest?.("[data-codex-local]"),
) {
  const trustedUrl = validateProviderLoginUrl(device?.provider, device?.url);
  if (!notice || !trustedUrl) return;
  notice.replaceChildren();
  notice.dataset.tone = device.error ? "error" : "info";
  const message = document.createElement("span");
  message.textContent = `${device.error || device.message || "Complete provider sign-in."} `;
  const link = document.createElement("a");
  link.href = trustedUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = `Open ${device.providerLabel || "provider"} sign-in`;
  notice.append(message, link);
  if (device.code) {
    const code = document.createElement("strong");
    code.textContent = ` Code: ${device.code}`;
    notice.append(code);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.codexProviderCancel = "true";
  cancel.textContent = "Cancel sign-in";
  cancel.addEventListener("click", () => cancelPendingProviderLogin(panel));
  notice.append(" ", cancel);
}

function beginOfficialComputerOperation(panel, message) {
  if (officialComputerOperationInFlight) return false;
  officialComputerOperationInFlight = true;
  setOfficialComputerBusy(panel, true);
  setOfficialComputerNotice(message, "info", panel);
  return true;
}

function finishOfficialComputerOperation(panel) {
  officialComputerOperationInFlight = false;
  if (lastStatus) installConnectionPanel(lastStatus);
  if (panel.isConnected) setOfficialComputerBusy(panel, false);
}

async function refreshAfterOfficialComputerError(error, panel) {
  clearOfficialEnableIntent();
  setOfficialComputerNotice(
    error?.message || "The official computer request did not complete.",
    "error",
    panel,
  );
  await loadStatus();
}

function requireOfficialComputerAcknowledgement(panel) {
  const acknowledgement = panel.querySelector("[data-codex-official-ack]");
  if (acknowledgement?.checked) {
    acknowledgement.removeAttribute("aria-invalid");
    return true;
  }
  acknowledgement?.setAttribute("aria-invalid", "true");
  setOfficialComputerNotice(
    "Read the vendor warning and check the acknowledgement before enabling this computer.",
    "error",
    panel,
  );
  acknowledgement?.focus();
  return false;
}

async function startCursorSignInAndEnable(panel) {
  if (!requireOfficialComputerAcknowledgement(panel)) return false;
  if (
    !beginOfficialComputerOperation(panel, "Preparing secure Cursor sign-in...")
  )
    return false;
  officialEnableAfterCursorLogin = true;
  try {
    const response = await request("/api/official-computer", {
      action: "login",
    });
    try {
      openOfficialLoginLink(response?.result?.loginUrl);
    } catch (error) {
      await request("/api/official-computer", {
        action: "cancel-login",
      }).catch(() => {});
      throw error;
    }
    setOfficialComputerNotice(
      "Finish signing in to Cursor. After sign-in, Open Bot will check access and enable the shared vendor computer.",
      "info",
      panel,
    );
    startOfficialConnectionPolling();
    await loadStatus();
    return true;
  } catch (error) {
    clearOfficialEnableIntent();
    await refreshAfterOfficialComputerError(error, panel);
    return false;
  } finally {
    finishOfficialComputerOperation(panel);
  }
}

async function cancelCursorSignIn(panel) {
  clearOfficialEnableIntent();
  if (!beginOfficialComputerOperation(panel, "Canceling Cursor sign-in..."))
    return false;
  clearInterval(officialConnectionPollTimer);
  officialConnectionPollTimer = null;
  try {
    await request("/api/official-computer", { action: "cancel-login" });
    setOfficialComputerNotice("Cursor sign-in canceled.", "info", panel);
    await loadStatus();
    return true;
  } catch (error) {
    await refreshAfterOfficialComputerError(error, panel);
    return false;
  } finally {
    finishOfficialComputerOperation(panel);
  }
}

async function selectPrivateComputer(panel) {
  clearOfficialEnableIntent();
  if (officialComputerState(lastStatus).mode !== "official") return false;
  if (
    !beginOfficialComputerOperation(
      panel,
      "Returning every employee to a private browser...",
    )
  )
    return false;
  try {
    await request("/api/official-computer", {
      action: "mode",
      mode: "private",
    });
    setOfficialComputerNotice(
      "Private browser restored. The Cursor account remains connected until you disconnect it.",
      "info",
      panel,
    );
    await loadStatus();
    return true;
  } catch (error) {
    await refreshAfterOfficialComputerError(error, panel);
    return false;
  } finally {
    finishOfficialComputerOperation(panel);
  }
}

async function enableConnectedOfficialComputer(panel) {
  clearOfficialEnableIntent();
  if (!requireOfficialComputerAcknowledgement(panel)) return false;
  if (
    !beginOfficialComputerOperation(
      panel,
      "Checking vendor access and starting the shared computer...",
    )
  )
    return false;
  try {
    await request("/api/official-computer", {
      action: "mode",
      mode: "official",
      acknowledged: true,
    });
    setOfficialComputerNotice(
      "Official vendor computer is live and shared by every employee.",
      "info",
      panel,
    );
    await loadStatus();
    return true;
  } catch (error) {
    await refreshAfterOfficialComputerError(error, panel);
    return false;
  } finally {
    finishOfficialComputerOperation(panel);
  }
}

function syncProviderControls(panel) {
  const select = panel.querySelector("[data-codex-provider]");
  const selected = select?.selectedOptions?.[0];
  if (!selected) return null;
  const provider = {
    id: selected.value,
    label: selected.dataset.label || selected.textContent.trim(),
    description: selected.dataset.description || "",
    loginKind: selected.dataset.loginKind || "oauth",
    signedIn: selected.dataset.signedIn === "true",
    baseUrl: selected.dataset.localBaseUrl || "",
    credentialRevision: selected.dataset.credentialRevision
      ? Number(selected.dataset.credentialRevision)
      : null,
  };
  const activeProvider = lastStatus?.connection?.provider;
  const activeOAuth = lastStatus?.connection?.mode !== "api-key";
  const description = panel.querySelector("[data-codex-provider-description]");
  if (description) description.textContent = provider.description;
  const connect = panel.querySelector("[data-codex-provider-connect]");
  const vertexForm = panel.querySelector("[data-codex-vertex-form]");
  const localForm = panel.querySelector("[data-codex-local-form]");
  const vertex = provider.loginKind === "service-account";
  const local = provider.loginKind === "local";
  const pending = pendingOAuthDevice?.provider === provider.id;
  if (connect) {
    connect.hidden = vertex || local;
    connect.disabled = pending;
    connect.textContent = pending
      ? `Waiting for ${provider.label}`
      : provider.signedIn
        ? activeOAuth && activeProvider === provider.id
          ? `Reconnect ${provider.label}`
          : `Use ${provider.label}`
        : `Connect ${provider.label}`;
  }
  if (vertexForm) vertexForm.hidden = !vertex;
  if (localForm) {
    localForm.hidden = !local;
    const endpoint = localForm.querySelector("[data-codex-local-url]");
    if (
      local &&
      endpoint &&
      provider.baseUrl &&
      endpoint !== document.activeElement
    )
      endpoint.value = provider.baseUrl;
  }
  return provider;
}

function wireConnectionPanel(panel) {
  syncProviderControls(panel);
  renderOAuthDevicePrompt(
    panel.querySelector("[data-codex-notice]"),
    pendingOAuthDevice,
    panel,
  );
  const acknowledgement = panel.querySelector("[data-codex-official-ack]");
  acknowledgement?.addEventListener("change", () => {
    if (acknowledgement.checked) {
      acknowledgement.removeAttribute("aria-invalid");
      const notice = panel.querySelector("[data-codex-official-notice]");
      if (
        notice?.dataset.tone === "error" &&
        notice.textContent.startsWith("Read the vendor warning")
      )
        setOfficialComputerNotice("", "info", panel);
    }
  });
  for (const tile of panel.querySelectorAll(
    "[data-codex-onboarding-provider]",
  )) {
    tile.addEventListener("click", async () => {
      const providerId = tile.dataset.codexOnboardingProvider;
      const select = panel.querySelector("[data-codex-provider]");
      if (!providerId || !select) return;
      selectedProviderId = providerId;
      select.value = providerId;
      if (
        pendingOAuthDevice?.provider &&
        pendingOAuthDevice.provider !== providerId
      )
        await cancelPendingProviderLogin(panel, {
          message: "Previous provider sign-in cancelled.",
          restoreActive: false,
        });
      providerConnectionNotice = { message: "", tone: "info" };
      const provider = syncProviderControls(panel);
      if (!["service-account", "local"].includes(provider?.loginKind))
        panel.querySelector("[data-codex-provider-connect]")?.click();
      else if (provider?.loginKind === "local")
        panel.querySelector("[data-codex-local-url]")?.focus();
      else panel.querySelector("[data-codex-vertex-form] input")?.focus();
    });
  }
  panel
    .querySelector("[data-codex-onboarding-private]")
    ?.addEventListener("click", async () => {
      onboardingComputerChoice = "private";
      await selectPrivateComputer(panel);
      if (lastStatus) installCodexOnboarding(lastStatus);
    });
  panel
    .querySelector("[data-codex-onboarding-cloud]")
    ?.addEventListener("click", () => {
      onboardingComputerChoice = "official";
      if (lastStatus) installCodexOnboarding(lastStatus);
    });
  for (const control of panel.querySelectorAll(
    "[data-codex-onboarding-back]",
  )) {
    control.addEventListener("click", () => {
      onboardingStep = control.dataset.codexOnboardingBack || "providers";
      if (lastStatus) installCodexOnboarding(lastStatus);
    });
  }
  for (const control of panel.querySelectorAll(
    "[data-codex-onboarding-next]",
  )) {
    control.addEventListener("click", () => {
      if (control.disabled) return;
      onboardingStep = control.dataset.codexOnboardingNext || "computer";
      if (lastStatus) installCodexOnboarding(lastStatus);
    });
  }
  panel
    .querySelector("[data-codex-onboarding-finish]")
    ?.addEventListener("click", () => {
      rememberOnboardingCompleted();
      if (lastStatus) installCodexOnboarding(lastStatus);
    });
  const privatePermissionAcknowledgement = panel.querySelector(
    "[data-codex-private-permission-ack]",
  );
  const privatePermissionControl = panel.querySelector(
    "[data-codex-private-always-allow]",
  );
  privatePermissionAcknowledgement?.addEventListener("change", () => {
    privatePermissionAcknowledgement.removeAttribute("aria-invalid");
    if (privatePermissionControl)
      privatePermissionControl.disabled =
        !privatePermissionAcknowledgement.checked;
    if (privatePermissionAcknowledgement.checked)
      setPrivatePermissionNotice("", "info", panel);
  });
  privatePermissionControl?.addEventListener("click", async () => {
    const enabled =
      privatePermissionControl.getAttribute("aria-checked") === "true";
    const next = !enabled;
    if (next && !privatePermissionAcknowledgement?.checked) {
      privatePermissionAcknowledgement?.setAttribute("aria-invalid", "true");
      privatePermissionAcknowledgement?.focus();
      setPrivatePermissionNotice(
        "Read the Private browser warning and check the acknowledgement before enabling Always allow.",
        "error",
        panel,
      );
      return;
    }
    if (privatePermissionOperationInFlight) return;
    privatePermissionOperationInFlight = true;
    privatePermissionControl.disabled = true;
    if (privatePermissionAcknowledgement)
      privatePermissionAcknowledgement.disabled = true;
    setPrivatePermissionNotice(
      next
        ? "Saving the Private browser permission..."
        : "Restoring Private browser approval cards...",
      "info",
      panel,
    );
    try {
      const response = await request("/api/private-computer", {
        action: "permissions",
        provider: "private-browser",
        alwaysAllowComputerActions: next,
        acknowledged: next,
      });
      if (!response?.status?.permissions)
        throw new Error(
          "The Private browser did not confirm the permission change.",
        );
      lastStatus = {
        ...lastStatus,
        privateComputer: response.status,
      };
      setPrivatePermissionNotice(
        next
          ? "Always allow is on for Private browsers. New actions will run without approval cards."
          : "Always allow is off for Private browsers. New actions will ask in the chat.",
      );
    } catch (error) {
      setPrivatePermissionNotice(
        error?.message || "The Private browser permission was not changed.",
        "error",
      );
      await loadStatus();
    } finally {
      privatePermissionOperationInFlight = false;
      if (lastStatus) installConnectionPanel(lastStatus);
    }
  });
  const permissionAcknowledgement = panel.querySelector(
    "[data-codex-vendor-permission-ack]",
  );
  const permissionControl = panel.querySelector(
    "[data-codex-vendor-always-allow]",
  );
  permissionAcknowledgement?.addEventListener("change", () => {
    permissionAcknowledgement.removeAttribute("aria-invalid");
    if (permissionControl)
      permissionControl.disabled = !permissionAcknowledgement.checked;
    if (permissionAcknowledgement.checked)
      setVendorPermissionNotice("", "info", panel);
  });
  permissionControl?.addEventListener("click", async () => {
    const enabled = permissionControl.getAttribute("aria-checked") === "true";
    const next = !enabled;
    if (next && !permissionAcknowledgement?.checked) {
      permissionAcknowledgement?.setAttribute("aria-invalid", "true");
      permissionAcknowledgement?.focus();
      setVendorPermissionNotice(
        "Read the warning and check the acknowledgement before enabling Always allow.",
        "error",
        panel,
      );
      return;
    }
    if (officialPermissionOperationInFlight) return;
    officialPermissionOperationInFlight = true;
    permissionControl.disabled = true;
    if (permissionAcknowledgement) permissionAcknowledgement.disabled = true;
    setVendorPermissionNotice(
      next
        ? "Protecting this provider-scoped permission for your Windows account..."
        : "Restoring per-action approval cards...",
      "info",
      panel,
    );
    try {
      const response = await request("/api/official-computer", {
        action: "permissions",
        provider: "official-grok-cloud",
        alwaysAllowComputerActions: next,
        acknowledged: next,
      });
      if (!response?.status?.permissions)
        throw new Error(
          "The official provider did not confirm the permission change.",
        );
      lastStatus = {
        ...lastStatus,
        officialComputer: response.status,
      };
      setVendorPermissionNotice(
        next
          ? "Always allow is on for the vendor cloud computer. The Private browser setting is unchanged."
          : "Always allow is off. Vendor actions will ask in the chat again.",
      );
    } catch (error) {
      setVendorPermissionNotice(
        error?.message || "The vendor computer permission was not changed.",
        "error",
      );
      await loadStatus();
    } finally {
      officialPermissionOperationInFlight = false;
      if (lastStatus) installConnectionPanel(lastStatus);
    }
  });
  panel
    .querySelector("[data-codex-official-login]")
    ?.addEventListener("click", () => startCursorSignInAndEnable(panel));
  panel
    .querySelector("[data-codex-official-cancel]")
    ?.addEventListener("click", () => cancelCursorSignIn(panel));
  for (const control of panel.querySelectorAll(
    "[data-codex-computer-private]",
  )) {
    control.addEventListener("click", () => selectPrivateComputer(panel));
  }
  panel
    .querySelector("[data-codex-computer-official]")
    ?.addEventListener("click", () => enableConnectedOfficialComputer(panel));
  panel
    .querySelector("[data-codex-official-disconnect]")
    ?.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Disconnect this official account? This removes its credentials from this PC and returns employees to private browsers. It does not delete the vendor cloud computer or verify deletion of remote data.",
      );
      if (!confirmed) return;
      if (
        !beginOfficialComputerOperation(
          panel,
          "Removing the official account credentials from this PC...",
        )
      )
        return;
      try {
        await request("/api/official-computer", { action: "disconnect" });
        clearInterval(officialConnectionPollTimer);
        officialConnectionPollTimer = null;
        setOfficialComputerNotice(
          "Local credentials removed. Remote cloud-computer deletion was not verified.",
          "info",
          panel,
        );
        await loadStatus();
      } catch (error) {
        await refreshAfterOfficialComputerError(error, panel);
      } finally {
        finishOfficialComputerOperation(panel);
      }
    });
  panel
    .querySelector("[data-codex-key-toggle]")
    ?.addEventListener("click", () => {
      const form = panel.querySelector("[data-codex-key-form]");
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector("input")?.focus();
    });
  panel
    .querySelector("[data-codex-provider]")
    ?.addEventListener("change", async (event) => {
      const selectControl = event.currentTarget;
      selectedProviderId = selectControl.value;
      if (
        pendingOAuthDevice?.provider &&
        pendingOAuthDevice.provider !== selectedProviderId
      ) {
        await cancelPendingProviderLogin(panel, {
          message: "Previous provider sign-in cancelled.",
          restoreActive: false,
        });
        if (selectControl.isConnected) selectControl.value = selectedProviderId;
      }
      providerConnectionNotice = { message: "", tone: "info" };
      const notice = panel.querySelector("[data-codex-notice]");
      if (notice) {
        notice.textContent = "";
        notice.dataset.tone = "info";
      }
      syncProviderControls(panel);
    });
  panel
    .querySelector("[data-codex-provider-connect]")
    ?.addEventListener("click", async (event) => {
      const connectControl = event.currentTarget;
      const notice = panel.querySelector("[data-codex-notice]");
      const provider = syncProviderControls(panel);
      if (
        !provider ||
        ["service-account", "local"].includes(provider.loginKind)
      )
        return;
      connectControl.disabled = true;
      const canReuseProvider = Boolean(
        provider.signedIn &&
        (lastStatus?.connection?.provider !== provider.id ||
          lastStatus?.connection?.mode === "api-key"),
      );
      notice.textContent = canReuseProvider
        ? `Switching to ${provider.label}...`
        : `Preparing ${provider.label} sign-in...`;
      notice.dataset.tone = "info";
      providerConnectionNotice = {
        message: notice.textContent,
        tone: "info",
      };
      try {
        const action = canReuseProvider ? "use-provider" : "provider-login";
        const result = await request("/api/codex/auth", {
          action,
          provider: provider.id,
        });
        if (result.url) {
          pendingOAuthDevice = {
            ...result,
            startedAt: Date.now(),
            deadlineAt: Date.now() + PROVIDER_LOGIN_TIMEOUT_MS,
          };
          providerConnectionNotice = {
            message: pendingOAuthDevice.message,
            tone: "info",
          };
          renderOAuthDevicePrompt(notice, pendingOAuthDevice, panel);
          pollForConnection();
        } else {
          providerConnectionNotice = {
            message: result.message || `${provider.label} is now selected.`,
            tone: "info",
          };
          notice.textContent = providerConnectionNotice.message;
          if (result.status) {
            acceptAuthoritativeStatus(result.status);
            applyUi();
          }
        }
      } catch (error) {
        notice.textContent = error.message;
        notice.dataset.tone = "error";
        providerConnectionNotice = { message: error.message, tone: "error" };
      } finally {
        if (connectControl.isConnected) syncProviderControls(panel);
      }
    });
  panel
    .querySelector("[data-codex-local-form]")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const provider = syncProviderControls(panel);
      if (provider?.id !== "local") return;
      const form = event.currentTarget;
      const endpoint = form.querySelector("[data-codex-local-url]");
      const key = form.querySelector("[data-codex-local-key]");
      const submit = form.querySelector("button[type='submit']");
      const notice = panel.querySelector("[data-codex-notice]");
      submit.disabled = true;
      notice.textContent = "Connecting and discovering local models...";
      notice.dataset.tone = "info";
      try {
        const result = await request("/api/codex/auth", {
          action: "local-connect",
          baseUrl: endpoint.value,
          apiKey: key.value,
        });
        key.value = "";
        selectedProviderId = "local";
        if (result.status) {
          acceptAuthoritativeStatus(result.status);
          const count = result.status.preferences?.catalog?.models?.length || 0;
          providerConnectionNotice = {
            message: `${count} local model${count === 1 ? "" : "s"} discovered. New requests will stay on this PC.`,
            tone: "info",
          };
          applyUi();
        } else {
          notice.textContent = "Local models connected.";
          await loadStatus();
        }
      } catch (error) {
        notice.textContent = error.message;
        notice.dataset.tone = "error";
        providerConnectionNotice = { message: error.message, tone: "error" };
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
    });
  panel
    .querySelector("[data-codex-vertex-form]")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const provider = syncProviderControls(panel);
      if (provider?.id !== "vertex") return;
      const input = event.currentTarget.querySelector("input[type='file']");
      const submit = event.currentTarget.querySelector("button[type='submit']");
      const notice = panel.querySelector("[data-codex-notice]");
      const file = input?.files?.[0];
      if (!file) {
        notice.textContent = "Choose a Google service-account JSON file.";
        notice.dataset.tone = "error";
        input?.focus();
        return;
      }
      submit.disabled = true;
      notice.textContent = "Verifying and importing the Vertex key locally...";
      notice.dataset.tone = "info";
      try {
        if (file.size > 512_000)
          throw new Error(
            "The Vertex service-account key is unexpectedly large.",
          );
        const serviceAccount = JSON.parse(await file.text());
        const result = await request("/api/codex/auth", {
          action: "vertex-import",
          provider: "vertex",
          serviceAccount,
        });
        input.value = "";
        pendingOAuthDevice = null;
        if (result.status) {
          acceptAuthoritativeStatus(result.status);
          providerConnectionNotice = {
            message:
              "Vertex AI connected. Models and reasoning controls are now updated for Vertex AI.",
            tone: "info",
          };
          applyUi();
        } else {
          notice.textContent = "Vertex AI credentials imported and selected.";
          await loadStatus();
        }
      } catch (error) {
        notice.textContent = error.message;
        notice.dataset.tone = "error";
      } finally {
        submit.disabled = false;
      }
    });
  panel
    .querySelector("[data-codex-key-form]")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = event.currentTarget.querySelector("input");
      const submit = event.currentTarget.querySelector("button[type='submit']");
      const notice = panel.querySelector("[data-codex-notice]");
      submit.disabled = true;
      notice.textContent = "Verifying directly with OpenAI...";
      notice.dataset.tone = "info";
      try {
        const result = await request("/api/codex/auth", {
          action: "api-key",
          apiKey: input.value,
        });
        input.value = "";
        if (pendingOAuthDevice)
          await cancelPendingProviderLogin(panel, {
            message:
              "Provider sign-in cancelled; using the verified OpenAI API key.",
          });
        if (result.status) {
          acceptAuthoritativeStatus(result.status);
          providerConnectionNotice = {
            message: "OpenAI API key verified. New requests will use it.",
            tone: "info",
          };
          applyUi();
        } else {
          notice.textContent =
            "OpenAI API key verified. New requests will use it.";
          await loadStatus();
        }
      } catch (error) {
        notice.textContent = error.message;
        notice.dataset.tone = "error";
      } finally {
        submit.disabled = false;
      }
    });
  const saveDefault = async (control, patch) => {
    const notice = panel.querySelector("[data-codex-settings-notice]");
    control.disabled = true;
    if (notice) {
      notice.textContent = "Saving default...";
      notice.dataset.tone = "info";
    }
    try {
      const status = await saveInferenceSettings({
        scope: "default",
        ...patch,
      });
      if (notice?.isConnected)
        notice.textContent = "Default saved. New turns use it immediately.";
      return status;
    } catch (error) {
      if (notice?.isConnected) {
        notice.textContent = error.message;
        notice.dataset.tone = "error";
      }
      throw error;
    } finally {
      if (control.isConnected) control.disabled = false;
    }
  };
  panel
    .querySelector("[data-codex-default-model]")
    ?.addEventListener("change", (event) => {
      saveDefault(event.currentTarget, {
        model: event.currentTarget.value,
      }).catch(() => loadStatus());
    });
  panel
    .querySelector("[data-codex-default-reasoning]")
    ?.addEventListener("input", (event) =>
      updateReasoningSlider(event.currentTarget),
    );
  panel
    .querySelector("[data-codex-default-reasoning]")
    ?.addEventListener("change", (event) => {
      const reasoningEffort = updateReasoningSlider(event.currentTarget);
      saveDefault(event.currentTarget, { reasoningEffort }).catch(() =>
        loadStatus(),
      );
    });
  panel
    .querySelector("[data-codex-default-fast]")
    ?.addEventListener("click", async (event) => {
      const control = event.currentTarget;
      const next = control.getAttribute("aria-checked") !== "true";
      control.setAttribute("aria-checked", String(next));
      try {
        await saveDefault(control, { fastMode: next });
      } catch {
        control.setAttribute("aria-checked", String(!next));
        loadStatus();
      }
    });
  for (const control of panel.querySelectorAll("[data-codex-default-mode]")) {
    control.addEventListener("click", async () => {
      const responseMode = control.dataset.codexDefaultMode;
      for (const option of panel.querySelectorAll("[data-codex-default-mode]"))
        option.setAttribute(
          "aria-checked",
          String(option.dataset.codexDefaultMode === responseMode),
        );
      try {
        await saveDefault(control, { responseMode });
      } catch {
        loadStatus();
      }
    });
  }
  panel
    .querySelector("[data-codex-image-form]")
    ?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector("[data-codex-image-submit]");
      const notice = panel.querySelector("[data-codex-image-notice]");
      const result = panel.querySelector("[data-codex-image-result]");
      const image = panel.querySelector("[data-codex-image-output]");
      const download = panel.querySelector("[data-codex-image-download]");
      submit.disabled = true;
      if (notice) {
        notice.textContent = "Creating image...";
        notice.dataset.tone = "info";
      }
      if (result) result.hidden = true;
      try {
        const response = await request("/api/codex/images", {
          prompt: form.querySelector("[data-codex-image-prompt]")?.value,
          size: form.querySelector("[data-codex-image-size]")?.value,
          quality: form.querySelector("[data-codex-image-quality]")?.value,
        });
        const dataUrl = response?.result?.dataUrl;
        if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl || ""))
          throw new Error("The image response was not valid.");
        image.src = dataUrl;
        download.href = dataUrl;
        result.hidden = false;
        notice.textContent = "Image ready.";
      } catch (error) {
        if (notice) {
          notice.textContent = error.message;
          notice.dataset.tone = "error";
        }
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
    });
}

function installConnectionPanel(status) {
  for (const settings of document.querySelectorAll(".sand-settings-general")) {
    let panel = settings.querySelector(":scope > [data-codex-local]");
    const accountCard = settings.querySelector(".sand-account-card");
    if (accountCard) {
      const stockSection = [...settings.children].find((child) =>
        child.contains(accountCard),
      );
      if (stockSection) stockSection.style.display = "none";
    }
    if (!panel) {
      panel = document.createElement("div");
      panel.dataset.codexLocal = "true";
      settings.prepend(panel);
    }
    const signature = JSON.stringify({
      status,
      pendingOAuthDevice,
      selectedProviderId,
      providerConnectionNotice,
      officialComputerOperationInFlight,
      officialPermissionOperationInFlight,
      privatePermissionOperationInFlight,
      officialComputerNotice,
      officialPermissionNotice,
      privatePermissionNotice,
    });
    if (panel.dataset.signature !== signature) {
      panel.dataset.signature = signature;
      panel.innerHTML = connectionPanelHtml(status);
      wireConnectionPanel(panel);
    }
  }
}

function setWorkspaceConnectionGate(blocked, onboarding) {
  document.documentElement.toggleAttribute(
    "data-codex-connection-required",
    blocked,
  );
  if (!document.body) return;
  for (const child of document.body.children) {
    if (child === onboarding) continue;
    if (blocked) {
      if (child.dataset.codexGateInert === undefined) {
        child.dataset.codexGateInert = child.inert ? "true" : "false";
        child.dataset.codexGateAria = child.hasAttribute("aria-hidden")
          ? child.getAttribute("aria-hidden")
          : "__missing__";
      }
      child.inert = true;
      child.setAttribute("aria-hidden", "true");
    } else if (child.dataset.codexGateInert !== undefined) {
      child.inert = child.dataset.codexGateInert === "true";
      if (child.dataset.codexGateAria === "__missing__")
        child.removeAttribute("aria-hidden");
      else child.setAttribute("aria-hidden", child.dataset.codexGateAria);
      delete child.dataset.codexGateInert;
      delete child.dataset.codexGateAria;
    }
  }
}

function installCodexOnboarding(status) {
  let onboarding = document.querySelector("[data-codex-onboarding]");
  if (hasCodexConnection(status) && onboardingCompleted()) {
    setWorkspaceConnectionGate(false, onboarding);
    onboarding?.remove();
    return;
  }
  if (!hasCodexConnection(status)) onboardingStep = "providers";
  if (!document.body) return;
  if (!onboarding) {
    onboarding = document.createElement("div");
    onboarding.dataset.codexOnboarding = "true";
    onboarding.innerHTML = `
      <main class="codex-first-run-dialog" role="dialog" aria-modal="true" aria-label="Set up Open Bot">
        <header class="codex-first-run-brand">
          <img src="./assets/app-icon-C7NKj2u7.png" alt="" />
          <div>
            <h1>Open Bot</h1>
            <p>Always-on employees, powered by the AI provider you choose.</p>
          </div>
        </header>
        <div data-codex-local></div>
      </main>`;
    document.body.append(onboarding);
  }
  setWorkspaceConnectionGate(true, onboarding);
  const panel = onboarding.querySelector("[data-codex-local]");
  const signature = status
    ? JSON.stringify({
        status,
        pendingOAuthDevice,
        selectedProviderId,
        providerConnectionNotice,
        onboardingStep,
        onboardingComputerChoice,
        officialComputerOperationInFlight,
        officialComputerNotice,
      })
    : "checking";
  if (panel.dataset.signature !== signature) {
    panel.dataset.signature = signature;
    if (status) {
      panel.innerHTML = firstRunOnboardingHtml(status);
      wireConnectionPanel(panel);
    } else {
      panel.innerHTML = `
        <section class="codex-card codex-first-run-card" aria-busy="true">
          <div class="codex-first-run-copy">
            <h2 id="codex-connect-title">Checking your AI provider connection...</h2>
            <p>Open Bot is confirming the private local bridge before opening your workspace.</p>
          </div>
          <p class="codex-notice" data-codex-notice aria-live="polite">This usually takes a moment.</p>
        </section>`;
    }
  }
  if (status && onboarding.dataset.codexInitialFocus !== onboardingStep) {
    requestAnimationFrame(() => {
      const target = panel.querySelector(
        "[data-codex-onboarding-provider]:not([disabled]), [data-codex-onboarding-private], [data-codex-onboarding-finish], input:not([disabled]), button:not([disabled])",
      );
      if (!target) return;
      onboarding.dataset.codexInitialFocus = onboardingStep;
      target.focus();
    });
  }
}

function composerButtonContent(status) {
  const state = inferenceState(status);
  const effective = state.effective;
  const model = modelMeta(effective.model, state);
  return `${effective.responseMode !== "chat" ? `<span class="codex-research-mark" aria-hidden="true">${effective.responseMode === "research" ? "R" : "S"}</span>` : ""}${effective.fastMode ? `<span class="codex-model-pill-bolt">${boltIcon({ size: 13 })}</span>` : ""}<span>${escapeHtml(model.label)}</span><span class="codex-model-pill-reasoning">${escapeHtml(reasoningLabel(effective.reasoningEffort))}</span>`;
}

function updateModelPickerButtons(agentId, status) {
  for (const button of document.querySelectorAll("[data-codex-model-picker]")) {
    const currentAgentId = button.dataset.codexAgentId;
    if (agentId && currentAgentId !== agentId) continue;
    const currentStatus =
      status || agentStatusCache.get(currentAgentId) || lastStatus;
    if (!currentStatus) continue;
    const state = inferenceState(currentStatus);
    const effective = state.effective;
    const model = modelMeta(effective.model, state);
    button.innerHTML = composerButtonContent(currentStatus);
    button.classList.toggle("is-fast", Boolean(effective.fastMode));
    button.setAttribute(
      "aria-label",
      `Response settings: ${model.label}, ${reasoningLabel(effective.reasoningEffort)} reasoning${effective.fastMode ? ", Fast mode" : ""}${effective.responseMode === "research" ? ", Research mode" : effective.responseMode === "search" ? ", Search mode" : ""}`,
    );
    button.title = button.getAttribute("aria-label");
  }
}

function closeModelPicker({ returnFocus = true } = {}) {
  if (!activeModelPicker) return;
  const { button, element, onViewportChange } = activeModelPicker;
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
  button?.setAttribute("aria-expanded", "false");
  button?.removeAttribute("aria-controls");
  element.remove();
  activeModelPicker = null;
  if (returnFocus && button?.isConnected) button.focus();
}

function positionModelPicker() {
  if (!activeModelPicker) return;
  const { button, element } = activeModelPicker;
  const anchor = button.getBoundingClientRect();
  const panel = element.getBoundingClientRect();
  const margin = 10;
  const left = Math.min(
    Math.max(margin, anchor.right - panel.width),
    window.innerWidth - panel.width - margin,
  );
  const preferredTop = anchor.top - panel.height - 8;
  const top =
    preferredTop >= margin
      ? preferredTop
      : Math.min(window.innerHeight - panel.height - margin, anchor.bottom + 8);
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.max(margin, Math.round(top))}px`;
}

function modelPickerHtml(status) {
  const state = inferenceState(status);
  const effective = state.effective;
  const modelRows = state.models
    .map((model) => {
      const selected = model.id === effective.model;
      return `
    <button type="button" class="codex-model-choice" role="radio" aria-checked="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}" data-codex-pick-model="${escapeHtml(model.id)}">
      <span class="codex-choice-indicator"><span></span></span>
      <span><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.description || "")}</small></span>
    </button>`;
    })
    .join("");
  return `
    <div class="codex-model-popover-heading">
      <div><strong>Response settings</strong><span>${state.override ? "Custom for this employee" : "Using workspace defaults"}</span></div>
      <button type="button" class="codex-model-popover-close" aria-label="Close response settings" data-codex-close-model-picker>${closeIcon()}</button>
    </div>
    <section aria-labelledby="codex-model-options-label">
      <span class="codex-model-popover-label" id="codex-model-options-label">Model</span>
      <div class="codex-model-choices" role="radiogroup" aria-labelledby="codex-model-options-label">${modelRows}</div>
    </section>
    <section>${reasoningSliderHtml(state.reasoningEfforts, effective.reasoningEffort, { attribute: "data-codex-pick-reasoning", id: "codex-agent-reasoning", compact: true })}</section>
    <section aria-labelledby="codex-response-mode-label">
      <span class="codex-model-popover-label" id="codex-response-mode-label">Mode</span>
      <div class="codex-mode-picker is-compact" role="radiogroup" aria-labelledby="codex-response-mode-label">
        <button type="button" role="radio" aria-checked="${effective.responseMode === "chat"}" data-codex-pick-mode="chat"><strong>Chat</strong><small>Direct conversation</small></button>
        <button type="button" role="radio" aria-checked="${effective.responseMode === "search"}" data-codex-pick-mode="search"><strong>Search</strong><small>Quick cited lookup</small></button>
        <button type="button" role="radio" aria-checked="${effective.responseMode === "research"}" data-codex-pick-mode="research"><strong>Research</strong><small>Browse + sources</small></button>
      </div>
    </section>
    <button class="codex-switch-row codex-popover-fast" type="button" role="switch" aria-checked="${effective.fastMode && state.fastCapability?.supported !== false ? "true" : "false"}" data-codex-pick-fast${state.fastCapability?.supported === false ? " disabled" : ""}>
      <span class="codex-switch-icon">${boltIcon({ size: 15 })}</span>
      <span><strong>Fast mode</strong><small>${state.fastCapability?.supported === false ? "Unavailable for this provider." : "Prioritize lower latency. Direct API keys use premium per-token pricing; Codex OAuth can consume allowance faster."}</small></span>
      <span class="codex-switch-track"><span></span></span>
    </button>
    <div class="codex-model-popover-footer">
      <button type="button" data-codex-use-defaults${state.override ? "" : " disabled"}>Use workspace defaults</button>
      <span data-codex-model-save-status aria-live="polite"></span>
    </div>`;
}

const MODEL_PICKER_RADIO_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
]);

function handleModelPickerRadioKeydown(event) {
  if (!activeModelPicker || !MODEL_PICKER_RADIO_KEYS.has(event.key))
    return false;
  const radio = event.target.closest?.('[role="radio"]');
  const group = radio?.closest?.('[role="radiogroup"]');
  if (!radio || !group || !activeModelPicker.element.contains(group))
    return false;
  const radios = [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
  const currentIndex = radios.indexOf(radio);
  if (currentIndex < 0 || radios.length === 0) return false;

  let nextIndex;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = radios.length - 1;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
    nextIndex = (currentIndex - 1 + radios.length) % radios.length;
  else nextIndex = (currentIndex + 1) % radios.length;

  event.preventDefault();
  event.stopImmediatePropagation();
  const nextRadio = radios[nextIndex];
  nextRadio.focus();
  if (nextRadio !== radio) nextRadio.click();
  return true;
}

function focusModelPickerControl(element, focusSelector) {
  const preferred = element.querySelector(
    focusSelector || "[data-codex-close-model-picker]",
  );
  const fallback = element.querySelector(
    '[data-codex-pick-model][aria-checked="true"]:not(:disabled), [data-codex-pick-model]:not(:disabled), [data-codex-close-model-picker]:not(:disabled)',
  );
  (preferred && !preferred.disabled ? preferred : fallback)?.focus();
}

function renderActiveModelPicker(status, { focusSelector } = {}) {
  if (!activeModelPicker) return;
  const { element } = activeModelPicker;
  element.innerHTML = modelPickerHtml(status);
  requestAnimationFrame(() => {
    positionModelPicker();
    focusModelPickerControl(element, focusSelector);
  });
}

async function openModelPicker(button) {
  const agentId = button.dataset.codexAgentId;
  if (!agentId) return;
  if (activeModelPicker?.button === button) {
    closeModelPicker();
    return;
  }
  closeModelPicker({ returnFocus: false });
  const element = document.createElement("div");
  element.className = "codex-model-popover";
  element.id = `codex-model-popover-${crypto.randomUUID()}`;
  element.dataset.codexModelPopover = "true";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", "Response settings for this employee");
  const onViewportChange = () => positionModelPicker();
  activeModelPicker = { agentId, button, element, onViewportChange };
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-controls", element.id);
  element.innerHTML = `<div class="codex-model-popover-loading" aria-busy="true">Loading response settings...</div>`;
  document.body.append(element);
  positionModelPicker();
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  try {
    const status = await loadAgentStatus(agentId, { force: true });
    if (activeModelPicker?.element === element) renderActiveModelPicker(status);
  } catch (error) {
    if (activeModelPicker?.element === element) {
      element.innerHTML = `<div class="codex-model-popover-error" role="alert">${escapeHtml(error.message)}</div>`;
      positionModelPicker();
    }
  }
}

async function updateActiveAgentPreference(patch, focusSelector) {
  if (!activeModelPicker) return;
  const { agentId, element } = activeModelPicker;
  const notice = element.querySelector("[data-codex-model-save-status]");
  for (const control of element.querySelectorAll("button,input,select"))
    control.disabled = true;
  if (notice) notice.textContent = "Saving...";
  try {
    const status = await saveInferenceSettings({
      scope: "agent",
      agentId,
      ...patch,
    });
    if (activeModelPicker?.agentId === agentId)
      renderActiveModelPicker(status, { focusSelector });
  } catch (error) {
    if (notice?.isConnected) {
      notice.textContent = error.message;
      notice.dataset.tone = "error";
      for (const control of element.querySelectorAll("button,input,select"))
        control.disabled = false;
    }
  }
}

function installModelPickers() {
  if (activeModelPicker && !activeModelPicker.button.isConnected) {
    closeModelPicker({ returnFocus: false });
  }
  for (const form of document.querySelectorAll("form[data-codex-agent-id]")) {
    const agentId = form.dataset.codexAgentId;
    if (!agentId) continue;
    const cluster = form.querySelector(".sand-prompt-cta-cluster");
    if (!cluster) continue;
    const existing = cluster.parentElement?.querySelector(
      ":scope > [data-codex-model-picker]",
    );
    if (existing) {
      if (existing.dataset.codexAgentId !== agentId) {
        if (activeModelPicker?.button === existing) {
          closeModelPicker({ returnFocus: false });
        }
        existing.dataset.codexAgentId = agentId;
        existing.removeAttribute("aria-controls");
        existing.setAttribute("aria-expanded", "false");
        updateModelPickerButtons(agentId);
      }
      refreshAgentStatusIfMissing(agentId);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codex-model-pill";
    button.dataset.codexModelPicker = "true";
    button.dataset.codexAgentId = agentId;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = composerButtonContent(
      agentStatusCache.get(agentId) || lastStatus,
    );
    button.addEventListener("click", () => openModelPicker(button));
    cluster.before(button);
    updateModelPickerButtons(agentId);
    refreshAgentStatusIfMissing(agentId);
  }
}

function groupTaskStatusLabel(status) {
  return (
    {
      queued: "Queued",
      working: "Working",
      complete: "Done",
      passed: "No update",
      blocked: "Blocked",
    }[status] || "Queued"
  );
}

function groupTaskSummary(task) {
  const members = Array.isArray(task?.members) ? task.members : [];
  const counts = members.reduce((summary, member) => {
    summary[member.status] = (summary[member.status] || 0) + 1;
    return summary;
  }, {});
  if (counts.working)
    return `${counts.working} working · ${members.length} teammates`;
  if (task?.state === "complete") {
    const done = (counts.complete || 0) + (counts.passed || 0);
    return `${done} of ${members.length} finished`;
  }
  return `${members.length} teammates queued`;
}

function removeGroupTaskTrackerForForm(form) {
  const host = form?.parentElement?.parentElement;
  host
    ?.querySelectorAll(":scope > [data-codex-group-task-tracker]")
    .forEach((tracker) => tracker.remove());
}

function renderGroupTaskTracker(form, task) {
  const groupId = String(task?.groupId || "");
  const host = form?.parentElement?.parentElement;
  if (!groupId || !host) {
    removeGroupTaskTrackerForForm(form);
    return;
  }
  let tracker = host.querySelector(
    `:scope > [data-codex-group-task-tracker][data-codex-group-id="${CSS.escape(groupId)}"]`,
  );
  const taskKey = String(task.id || "");
  const taskSignature = JSON.stringify({
    id: taskKey,
    state: String(task.state || "active"),
    updatedAt: String(task.updatedAt || ""),
    members: (task.members || []).map((member) => [
      member.id,
      member.status,
      member.updatedAt || "",
    ]),
  });
  if (tracker?.dataset.codexTaskSignature === taskSignature) return;
  if (!tracker) {
    host
      .querySelectorAll(":scope > [data-codex-group-task-tracker]")
      .forEach((item) => item.remove());
    tracker = document.createElement("section");
    tracker.dataset.codexGroupTaskTracker = "true";
    tracker.dataset.codexGroupId = groupId;
    tracker.className = "codex-group-task-tracker";
    host.insertBefore(tracker, form.parentElement);
  }
  tracker.dataset.codexTaskKey = taskKey;
  tracker.dataset.codexTaskSignature = taskSignature;
  tracker.dataset.state = String(task.state || "active");
  const titleId = `codex-group-task-${crypto.randomUUID()}`;
  const members = (task.members || [])
    .map(
      (member) => `
        <li data-status="${escapeHtml(member.status)}">
          <span class="codex-group-task-dot" aria-hidden="true"></span>
          <strong>${escapeHtml(member.name)}</strong>
          <span>${escapeHtml(groupTaskStatusLabel(member.status))}</span>
        </li>`,
    )
    .join("");
  tracker.innerHTML = `
    <header>
      <div>
        <span>Group task</span>
        <strong id="${titleId}">${escapeHtml(task.groupName || "Group work")}</strong>
      </div>
      <div class="codex-group-task-actions">
        <span data-codex-group-task-state>${escapeHtml(groupTaskSummary(task))}</span>
        ${
          task.state === "complete"
            ? '<button type="button" data-codex-clear-group-task aria-label="Clear completed group task">Clear</button>'
            : ""
        }
      </div>
    </header>
    <p>${escapeHtml(task.summary || "Working on the latest group request")}</p>
    <ol aria-labelledby="${titleId}">${members}</ol>`;
  const clear = tracker.querySelector("[data-codex-clear-group-task]");
  clear?.addEventListener("click", async () => {
    clear.disabled = true;
    try {
      await request("/api/group-tasks", { action: "clear", groupId });
      tracker.remove();
    } catch (error) {
      clear.disabled = false;
      clear.textContent = "Try again";
    }
  });
}

async function refreshGroupTaskForForm(form) {
  const groupId = String(form?.dataset?.codexAgentId || "");
  if (!groupId || groupTaskLoads.has(form)) return;
  groupTaskLoads.add(form);
  try {
    const response = await request(
      `/api/group-tasks?groupId=${encodeURIComponent(groupId)}`,
    );
    if (!form.isConnected) return;
    if (response?.task?.groupId === groupId)
      renderGroupTaskTracker(form, response.task);
    else removeGroupTaskTrackerForForm(form);
  } catch {
    // A tracker is auxiliary; preserve the conversation if the local bridge is restarting.
  } finally {
    groupTaskLoads.delete(form);
  }
}

function refreshGroupTaskTrackers() {
  const forms = [
    ...document.querySelectorAll("form[data-codex-agent-id]"),
  ].filter(
    (form) =>
      form.isConnected !== false &&
      (typeof form.getClientRects !== "function" ||
        form.getClientRects().length > 0),
  );
  for (const tracker of document.querySelectorAll(
    "[data-codex-group-task-tracker]",
  )) {
    if (
      !forms.some(
        (form) => form.parentElement?.parentElement === tracker.parentElement,
      )
    )
      tracker.remove();
  }
  for (const form of forms) void refreshGroupTaskForForm(form);
}

function syncGroupTaskPolling() {
  if (!groupTaskPollTimer)
    groupTaskPollTimer = setInterval(refreshGroupTaskTrackers, 1_000);
  refreshGroupTaskTrackers();
}

function officialApprovalKey(pending) {
  const frame = pending?.frame || {};
  return [
    pending?.requestId,
    pending?.seatId,
    pending?.actionDigest,
    frame.generation,
    frame.sequence,
    frame.sha256,
  ]
    .map((value) => String(value ?? ""))
    .join(":");
}

function officialApprovalBinding(pending, presented = false) {
  const binding = {
    requestId: String(pending?.requestId || ""),
    seatId: String(pending?.seatId || ""),
    origin: String(pending?.origin || ""),
    actionDigest: String(pending?.actionDigest || ""),
  };
  if (presented) {
    binding.presentedFrame = {
      generation: pending.frame.generation,
      sequence: pending.frame.sequence,
      sha256: pending.frame.sha256,
    };
  }
  return binding;
}

function approvalActionLabel(action) {
  const kind = String(action?.kind || "computer action");
  const target = action?.target?.name ? ` — ${action.target.name}` : "";
  const destination = action?.destination ? ` — ${action.destination}` : "";
  const typed = action?.typedContent
    ? ` — ${action.typedContent.category || "text"}, ${Number(action.typedContent.length) || 0} characters`
    : "";
  return `${kind}${target}${destination}${typed}`;
}

function removeOfficialApprovalCardForForm(form, seatId = null) {
  const anchor = form?.parentElement;
  const host = anchor?.parentElement;
  if (!host) return;
  for (const card of host.querySelectorAll(
    ":scope > [data-codex-chat-approval]",
  )) {
    if (!seatId || card.dataset.codexApprovalAgentId === seatId) card.remove();
  }
}

function renderOfficialApprovalCard(form, pending) {
  const agentId = String(pending?.seatId || "");
  const anchor = form?.parentElement;
  const host = anchor?.parentElement;
  if (!agentId || !host) {
    removeOfficialApprovalCardForForm(form, agentId || null);
    return;
  }
  const requiresExactFrame = Boolean(pending?.frame);
  let card = [
    ...host.querySelectorAll(":scope > [data-codex-chat-approval]"),
  ].find((item) => item.dataset.codexApprovalAgentId === agentId);
  const approvalKey = officialApprovalKey(pending);
  if (card?.dataset.codexApprovalKey === approvalKey) return;
  if (!card) {
    card = document.createElement("article");
    card.dataset.codexChatApproval = "true";
    card.dataset.codexApprovalAgentId = agentId;
    card.className = "codex-chat-approval";
    host.insertBefore(card, anchor);
  }
  card.dataset.codexApprovalKey = approvalKey;
  card.dataset.codexApprovalProvider = requiresExactFrame
    ? "official"
    : "private";
  card.dataset.framePresented = requiresExactFrame ? "false" : "true";
  const titleId = `codex-approval-${crypto.randomUUID()}`;
  card.setAttribute("aria-labelledby", titleId);
  const actions = (pending.presentation?.actions || [])
    .slice(0, 4)
    .map((action) => `<li>${escapeHtml(approvalActionLabel(action))}</li>`)
    .join("");
  const expectedSource = requiresExactFrame
    ? `data:image/png;base64,${pending.frame.screenshotBase64}`
    : "";
  const providerLabel = requiresExactFrame
    ? "Vendor computer"
    : "Private browser";
  const providerBadge = requiresExactFrame
    ? '<span class="codex-route-badge is-vendor">Shared vendor screen</span>'
    : '<span class="codex-route-badge">This employee\'s browser</span>';
  const fallbackSummary = requiresExactFrame
    ? "An employee wants to interact with the shared vendor computer."
    : "An employee wants to use their private browser.";
  const frameHtml = requiresExactFrame
    ? `<figure>
         <img src="${escapeHtml(expectedSource)}" alt="Exact shared vendor screen this action will use" data-codex-chat-approval-frame />
         <figcaption>Allow once unlocks only this exact action on this displayed screen. If the screen or session changes, Open Bot asks again.</figcaption>
       </figure>`
    : "";
  const initialStatus = requiresExactFrame
    ? "Loading the exact approval screen..."
    : "Browser access is on. Review this one action, then choose Allow once or Deny.";
  card.innerHTML = `
    <div class="codex-chat-approval-heading">
      <div><span>${providerLabel}</span><strong id="${titleId}">Computer action needs your permission</strong></div>
      ${providerBadge}
    </div>
    <p>${escapeHtml(pending.summary || fallbackSummary)}</p>
    ${actions ? `<ul>${actions}</ul>` : ""}
    ${frameHtml}
    <div class="codex-chat-approval-actions">
      <button type="button" data-codex-chat-allow ${requiresExactFrame ? "disabled" : ""}>Allow once</button>
      <button type="button" data-codex-chat-deny>Deny</button>
      <span data-codex-chat-approval-status role="status" aria-live="polite">${initialStatus}</span>
    </div>`;
  const image = card.querySelector("[data-codex-chat-approval-frame]");
  const allow = card.querySelector("[data-codex-chat-allow]");
  const deny = card.querySelector("[data-codex-chat-deny]");
  const status = card.querySelector("[data-codex-chat-approval-status]");
  if (image) {
    image.addEventListener("load", () => {
      if (
        card.dataset.codexApprovalKey !== approvalKey ||
        image.getAttribute("src") !== expectedSource
      )
        return;
      card.dataset.framePresented = "true";
      allow.disabled = false;
      status.textContent = "Exact screen displayed. Choose Allow once or Deny.";
    });
    image.addEventListener("error", () => {
      if (card.dataset.codexApprovalKey !== approvalKey) return;
      allow.disabled = true;
      status.textContent =
        "The exact approval screen could not be displayed. Deny or wait for a fresh request.";
    });
    image.src = expectedSource;
  }
  const decide = async (decision) => {
    if (card.dataset.codexApprovalKey !== approvalKey) return;
    const presented = decision === "allow-once" && requiresExactFrame;
    if (presented && card.dataset.framePresented !== "true") return;
    allow.disabled = true;
    deny.disabled = true;
    status.textContent =
      decision === "allow-once" ? "Allowing this action..." : "Denying...";
    try {
      await request("/api/approval", {
        seatKey: agentId,
        decision,
        binding: officialApprovalBinding(pending, presented),
      });
      card.remove();
    } catch (error) {
      if (card.dataset.codexApprovalKey === approvalKey) {
        allow.disabled =
          requiresExactFrame && card.dataset.framePresented !== "true";
        deny.disabled = false;
        status.textContent =
          error?.message ||
          "This choice could not be sent. Try again or deny the request.";
      }
      await refreshOfficialApprovalForForm(form);
    }
  };
  allow.addEventListener("click", () => decide("allow-once"));
  deny.addEventListener("click", () => decide("deny"));
}

async function refreshOfficialApprovalForForm(form) {
  const mode = officialComputerState(lastStatus).mode;
  if (
    !["private", "official"].includes(mode) ||
    officialApprovalLoads.has(form)
  )
    return;
  officialApprovalLoads.add(form);
  try {
    const response = await request("/api/approvals");
    if (
      form.isConnected === false ||
      officialComputerState(lastStatus).mode !== mode
    )
      return;
    const pending = Array.isArray(response?.pending) ? response.pending : [];
    const seatIds = new Set();
    for (const approval of pending) {
      const seatId = String(approval?.seatId || "");
      if (!seatId) continue;
      seatIds.add(seatId);
      renderOfficialApprovalCard(form, approval);
    }
    const anchor = form?.parentElement;
    const host = anchor?.parentElement;
    if (host) {
      for (const card of host.querySelectorAll(
        ":scope > [data-codex-chat-approval]",
      )) {
        if (!seatIds.has(card.dataset.codexApprovalAgentId)) card.remove();
      }
    }
  } catch (error) {
    const anchor = form?.parentElement;
    const host = anchor?.parentElement;
    for (const card of host?.querySelectorAll(
      ":scope > [data-codex-chat-approval]",
    ) || []) {
      const allow = card.querySelector("[data-codex-chat-allow]");
      const status = card.querySelector("[data-codex-chat-approval-status]");
      if (allow) allow.disabled = true;
      if (status)
        status.textContent =
          error?.message || "Could not refresh this approval safely.";
    }
  } finally {
    officialApprovalLoads.delete(form);
  }
}

function refreshOfficialApprovalCards() {
  const forms = [
    ...document.querySelectorAll("form[data-codex-agent-id]"),
  ].filter(
    (form) =>
      form.isConnected !== false &&
      (typeof form.getClientRects !== "function" ||
        form.getClientRects().length > 0),
  );
  for (const card of document.querySelectorAll("[data-codex-chat-approval]")) {
    const stillOwned = forms.some(
      (form) => form.parentElement?.parentElement === card.parentElement,
    );
    if (!stillOwned) card.remove();
  }
  if (
    !["private", "official"].includes(officialComputerState(lastStatus).mode)
  ) {
    for (const form of forms) removeOfficialApprovalCardForForm(form);
    return;
  }
  for (const form of forms) void refreshOfficialApprovalForForm(form);
}

function syncOfficialApprovalPolling() {
  if (
    !["private", "official"].includes(officialComputerState(lastStatus).mode)
  ) {
    clearInterval(officialApprovalPollTimer);
    officialApprovalPollTimer = null;
    refreshOfficialApprovalCards();
    return;
  }
  if (!officialApprovalPollTimer)
    officialApprovalPollTimer = setInterval(
      refreshOfficialApprovalCards,
      1_000,
    );
  refreshOfficialApprovalCards();
}

function applyUi() {
  replaceVisibleBranding();
  hideUnavailableSurfaces();
  installCodexOnboarding(lastStatus);
  if (lastStatus) {
    updateSidebarIdentity(lastStatus);
    installConnectionPanel(lastStatus);
    installModelPickers();
    syncOfficialApprovalPolling();
    syncGroupTaskPolling();
  }
}

document.addEventListener(
  "click",
  (event) => {
    if (
      document.documentElement.hasAttribute("data-codex-connection-required") &&
      !event.target.closest?.("[data-codex-onboarding]")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    setTimeout(applyUi, 0);
    setTimeout(applyUi, 120);
    const control = event.target.closest?.("[data-codex-manage-connection]");
    if (!control) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const settings = [
      ...document.querySelectorAll("button,[role='menuitem']"),
    ].find((item) => item.textContent?.trim() === "Settings");
    settings?.click();
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    if (!activeModelPicker) return;
    const element = activeModelPicker.element;
    const target = event.target;
    if (target.closest?.("[data-codex-close-model-picker]")) {
      closeModelPicker();
      return;
    }
    const modelControl = target.closest?.("[data-codex-pick-model]");
    if (modelControl) {
      updateActiveAgentPreference(
        { model: modelControl.dataset.codexPickModel },
        `[data-codex-pick-model="${CSS.escape(modelControl.dataset.codexPickModel)}"]`,
      );
      return;
    }
    const fastControl = target.closest?.("[data-codex-pick-fast]");
    if (fastControl) {
      updateActiveAgentPreference(
        { fastMode: fastControl.getAttribute("aria-checked") !== "true" },
        "[data-codex-pick-fast]",
      );
      return;
    }
    const modeControl = target.closest?.("[data-codex-pick-mode]");
    if (modeControl) {
      updateActiveAgentPreference(
        { responseMode: modeControl.dataset.codexPickMode },
        `[data-codex-pick-mode="${CSS.escape(modeControl.dataset.codexPickMode)}"]`,
      );
      return;
    }
    if (target.closest?.("[data-codex-use-defaults]")) {
      const { agentId } = activeModelPicker;
      saveInferenceSettings({ scope: "agent", agentId, inherit: true })
        .then((status) => {
          if (activeModelPicker?.agentId === agentId)
            renderActiveModelPicker(status, {
              focusSelector: "[data-codex-pick-model][aria-checked='true']",
            });
        })
        .catch((error) => {
          const notice = activeModelPicker?.element.querySelector(
            "[data-codex-model-save-status]",
          );
          if (notice) {
            notice.textContent = error.message;
            notice.dataset.tone = "error";
          }
        });
      return;
    }
    if (!element.contains(target) && target !== activeModelPicker.button)
      closeModelPicker({ returnFocus: false });
  },
  true,
);

document.addEventListener(
  "input",
  (event) => {
    if (!activeModelPicker) return;
    const control = event.target.closest?.("[data-codex-pick-reasoning]");
    if (control && activeModelPicker.element.contains(control))
      updateReasoningSlider(control);
  },
  true,
);

document.addEventListener(
  "change",
  (event) => {
    if (!activeModelPicker) return;
    const control = event.target.closest?.("[data-codex-pick-reasoning]");
    if (!control || !activeModelPicker.element.contains(control)) return;
    const reasoningEffort = updateReasoningSlider(control);
    updateActiveAgentPreference(
      { reasoningEffort },
      "[data-codex-pick-reasoning]",
    );
  },
  true,
);

document.addEventListener(
  "keydown",
  (event) => {
    if (handleModelPickerRadioKeydown(event)) return;
    if (event.key !== "Escape" || !activeModelPicker) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeModelPicker();
  },
  true,
);

for (const eventName of ["beforeinput", "keydown", "submit"]) {
  document.addEventListener(
    eventName,
    (event) => {
      if (
        !document.documentElement.hasAttribute("data-codex-connection-required")
      )
        return;
      if (event.target.closest?.("[data-codex-onboarding]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}

let connectedAppsDialog = null;
let connectedAppsPollTimer = null;

function connectedAppGlyph(slug) {
  const value = String(slug || "app").replace(/[^a-z0-9]/gi, "");
  return escapeHtml((value.slice(0, 2) || "AP").toUpperCase());
}

function stopConnectedAppsPolling() {
  clearInterval(connectedAppsPollTimer);
  connectedAppsPollTimer = null;
}

function closeConnectedApps() {
  stopConnectedAppsPolling();
  if (!connectedAppsDialog) return;
  if (
    typeof connectedAppsDialog.close === "function" &&
    connectedAppsDialog.open
  )
    connectedAppsDialog.close();
  else connectedAppsDialog.removeAttribute("open");
}

function setConnectedAppsNotice(message, tone = "info") {
  const notice = connectedAppsDialog?.querySelector(
    "[data-openbot-apps-notice]",
  );
  if (!notice) return;
  notice.textContent = String(message || "");
  notice.dataset.tone = tone === "error" ? "error" : "info";
}

async function renderConnectedAppsCatalog(query = "") {
  const body = connectedAppsDialog?.querySelector("[data-openbot-apps-body]");
  if (!body) return;
  body.setAttribute("aria-busy", "true");
  try {
    const status = await request("/api/composio/status");
    if (!status.configured) {
      stopConnectedAppsPolling();
      body.innerHTML = `<section class="openbot-apps-setup">
        <div>
          <span class="openbot-apps-eyebrow">Bring your own Composio project</span>
          <h3>Connect the apps your coworkers use</h3>
          <p>Fully local setup: use your own Composio project key. Open Bot protects it for your Windows account and has no shared plugin backend. App OAuth tokens stay with Composio and never pass through Open Bot.</p>
        </div>
        <form data-openbot-composio-form>
          <label for="openbot-composio-key">Composio project key</label>
          <input id="openbot-composio-key" name="apiKey" type="password" minlength="8" maxlength="512" autocomplete="off" spellcheck="false" placeholder="Your Composio project key" required>
          <button type="submit">Save and load apps</button>
        </form>
        <p class="openbot-apps-fineprint">Your installation connects directly to Composio. Connected apps can access data or perform actions in third-party accounts. Open Bot disables Composio sandbox execution and automatic local-file transfer.</p>
      </section>`;
      body
        .querySelector("[data-openbot-composio-form]")
        ?.addEventListener("submit", async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const submit = form.querySelector("button");
          const field = form.elements.apiKey;
          submit.disabled = true;
          setConnectedAppsNotice(
            "Protecting the key and creating your app session...",
          );
          try {
            await request("/api/composio", {
              action: "configure",
              apiKey: field.value,
            });
            form.reset();
            await renderConnectedAppsCatalog();
            setConnectedAppsNotice("Connected apps are ready.");
          } catch (error) {
            field.value = "";
            setConnectedAppsNotice(error.message, "error");
          } finally {
            submit.disabled = false;
          }
        });
      return;
    }
    const search = String(query || "").trim();
    const catalog = await request(
      `/api/composio/toolkits${search ? `?query=${encodeURIComponent(search)}` : ""}`,
    );
    const items = Array.isArray(catalog.items) ? catalog.items : [];
    body.innerHTML = `<section class="openbot-apps-catalog">
      <div class="openbot-apps-toolbar">
        <label><span class="codex-visually-hidden">Search connected apps</span><input type="search" value="${escapeHtml(search)}" maxlength="100" placeholder="Search Gmail, GitHub, Slack, Notion..."></label>
        <button type="button" data-openbot-composio-disconnect>Remove project</button>
      </div>
      <div class="openbot-apps-grid" role="list">
        ${
          items
            .map(
              (
                item,
              ) => `<article class="openbot-app-card" role="listitem" data-toolkit="${escapeHtml(item.slug)}">
              <span class="openbot-app-glyph" aria-hidden="true">${connectedAppGlyph(item.slug)}</span>
              <div><strong>${escapeHtml(item.name)}</strong><small>${item.connected ? "Connected and available to coworkers" : "Connect with Composio"}</small></div>
              <button type="button" data-openbot-app-connect ${item.connected ? "disabled" : ""}>${item.connected ? "Connected" : "Connect"}</button>
            </article>`,
            )
            .join("") ||
          `<p class="openbot-apps-empty">No apps matched that search.</p>`
        }
      </div>
      <p class="openbot-apps-fineprint">Connections are private to this Open Bot installation. App actions appear only when Composio reports the connection active.</p>
    </section>`;
    const searchField = body.querySelector('input[type="search"]');
    let searchTimer = null;
    searchField?.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(
        () => renderConnectedAppsCatalog(searchField.value),
        250,
      );
    });
    body
      .querySelector("[data-openbot-composio-disconnect]")
      ?.addEventListener("click", async () => {
        setConnectedAppsNotice("Removing the protected Composio project...");
        try {
          await request("/api/composio", { action: "disconnect" });
          await renderConnectedAppsCatalog();
          setConnectedAppsNotice("Composio was removed from Open Bot.");
        } catch (error) {
          setConnectedAppsNotice(error.message, "error");
        }
      });
    for (const button of body.querySelectorAll("[data-openbot-app-connect]")) {
      button.addEventListener("click", async () => {
        const card = button.closest("[data-toolkit]");
        const toolkit = card?.dataset.toolkit || "";
        button.disabled = true;
        setConnectedAppsNotice(
          `Opening ${card?.querySelector("strong")?.textContent || "app"} connection...`,
        );
        try {
          await request("/api/composio", { action: "authorize", toolkit });
          setConnectedAppsNotice(
            "Finish connecting in the secure Composio tab. This list will update automatically.",
          );
          stopConnectedAppsPolling();
          connectedAppsPollTimer = setInterval(
            () => renderConnectedAppsCatalog(search).catch(() => {}),
            3000,
          );
        } catch (error) {
          button.disabled = false;
          setConnectedAppsNotice(error.message, "error");
        }
      });
    }
  } catch (error) {
    body.innerHTML = `<div class="openbot-apps-error"><strong>Connected apps unavailable</strong><p>${escapeHtml(error.message)}</p><button type="button" data-openbot-apps-retry>Try again</button></div>`;
    body
      .querySelector("[data-openbot-apps-retry]")
      ?.addEventListener("click", () => renderConnectedAppsCatalog(query));
  } finally {
    body.removeAttribute("aria-busy");
  }
}

function openConnectedApps() {
  if (!connectedAppsDialog) {
    const dialog = document.createElement("dialog");
    dialog.className = "openbot-apps-dialog";
    dialog.setAttribute("aria-labelledby", "openbot-apps-title");
    dialog.innerHTML = `<div class="openbot-apps-shell">
      <header><div><span class="openbot-apps-eyebrow">Open Bot</span><h2 id="openbot-apps-title">Connected apps</h2><p>Give your coworkers access to the services you choose.</p></div><button type="button" data-openbot-apps-close aria-label="Close connected apps">${closeIcon()}</button></header>
      <main data-openbot-apps-body><div class="openbot-apps-loading">Loading connected apps...</div></main>
      <footer><span data-openbot-apps-notice aria-live="polite"></span><a href="https://docs.composio.dev" target="_blank" rel="noreferrer">Composio documentation</a></footer>
    </div>`;
    dialog
      .querySelector("[data-openbot-apps-close]")
      ?.addEventListener("click", closeConnectedApps);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeConnectedApps();
    });
    dialog.addEventListener("close", stopConnectedAppsPolling);
    document.body.append(dialog);
    connectedAppsDialog = dialog;
  }
  if (typeof connectedAppsDialog.showModal === "function") {
    if (!connectedAppsDialog.open) connectedAppsDialog.showModal();
  } else connectedAppsDialog.setAttribute("open", "");
  void renderConnectedAppsCatalog();
}

globalThis.OpenBotConnectedApps = Object.freeze({ open: openConnectedApps });

const style = document.createElement("style");
style.textContent = `
  [data-codex-local] { display:grid; gap:16px; margin-bottom:16px; color:var(--sand-text-primary,#eee); }
  .codex-card { border:1px solid rgba(127,127,127,.28); background:rgba(127,127,127,.06); border-radius:12px; padding:16px; display:grid; gap:12px; }
  .codex-card h2,.codex-card h3,.codex-card p { margin:0; }
  .codex-card-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
  .codex-card-heading>div { display:grid; gap:4px; }
  .codex-card-heading p { max-width:58ch; color:var(--sand-text-tertiary,#aaa); font-size:12px; line-height:1.45; }
  .codex-route-badge { flex:none; border:1px solid rgba(127,127,127,.3); border-radius:999px; padding:4px 8px; color:var(--sand-text-secondary,#ccc); background:rgba(127,127,127,.08); font-size:11px; }
  .codex-card small,.codex-account-copy span { color:var(--sand-text-tertiary,#aaa); line-height:1.45; }
  .codex-account-row { display:flex; align-items:center; gap:12px; }
  .codex-avatar { width:42px; height:42px; border-radius:50%; object-fit:cover; flex:none; }
  .codex-initials { display:grid; place-items:center; background:#202020; border:1px solid rgba(255,255,255,.16); font-weight:650; }
  .codex-account-copy { display:grid; gap:2px; min-width:0; }
  .codex-actions,.codex-key-form>div { display:flex; flex-wrap:wrap; gap:8px; }
  .codex-provider-picker,.codex-vertex-form,.codex-local-form { display:grid; gap:7px; }
  .codex-provider-picker>label,.codex-vertex-form>label,.codex-local-form>label { color:var(--sand-text-secondary,#d5d5d5); font-size:12px; font-weight:600; }
  .codex-provider-picker>select { width:100%; min-height:40px; border:1px solid rgba(127,127,127,.38); border-radius:10px; padding:0 11px; color:inherit; background:#1d1d1d; color-scheme:dark; }
  .codex-provider-picker>p { color:var(--sand-text-tertiary,#aaa); font-size:12px; line-height:1.45; }
  .codex-vertex-form,.codex-local-form { padding:11px; border:1px solid rgba(127,127,127,.28); border-radius:10px; background:rgba(127,127,127,.055); }
  .codex-vertex-form input[type="file"] { width:100%; min-height:38px; color:var(--sand-text-secondary,#d5d5d5); font-size:12px; }
  .codex-vertex-form input[type="file"]::file-selector-button { margin-inline-end:9px; border:1px solid rgba(127,127,127,.35); border-radius:8px; padding:7px 10px; color:inherit; background:rgba(127,127,127,.14); cursor:pointer; }
  .codex-local-form input { width:100%; min-height:38px; border:1px solid rgba(127,127,127,.35); border-radius:8px; padding:8px 10px; color:inherit; background:rgba(127,127,127,.08); }
  .codex-local-form label span { color:var(--sand-text-tertiary,#9a9a9a); font-weight:400; }
  .codex-card button { border:1px solid rgba(127,127,127,.35); border-radius:999px; color:inherit; background:rgba(127,127,127,.14); padding:7px 12px; cursor:pointer; }
  .codex-card button:hover { background:rgba(127,127,127,.23); }
  .codex-card button:disabled { opacity:.55; cursor:wait; }
  .codex-card button:focus-visible,.codex-card input:focus-visible,.codex-card select:focus-visible,.codex-notice a:focus-visible { outline:2px solid #9dc6ff; outline-offset:2px; }
  .codex-setting-grid { display:grid; grid-template-columns:1fr; gap:10px; }
  .codex-setting-grid label { display:grid; gap:6px; color:var(--sand-text-tertiary,#aaa); font-size:12px; }
  .codex-setting-grid select { width:100%; min-height:36px; border:1px solid rgba(127,127,127,.35); border-radius:9px; padding:0 10px; color:inherit; background:#1d1d1d; color-scheme:dark; }
  .codex-reasoning-slider { display:grid; grid-template-rows:auto 28px; gap:7px; padding:10px 11px 11px; border:1px solid rgba(127,127,127,.28); border-radius:10px; background:rgba(127,127,127,.055); }
  .codex-reasoning-slider-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--sand-text-tertiary,#aaa); font-size:12px; }
  .codex-reasoning-slider-heading strong { color:var(--sand-text-primary,#f4f4f4); font-size:12px; font-weight:650; }
  .codex-reasoning-slider input[type="range"],.codex-reasoning-stops { grid-column:1; grid-row:2; }
  .codex-reasoning-slider input[type="range"] { position:relative; z-index:2; width:100%; height:28px; margin:0; appearance:none; -webkit-appearance:none; background:transparent; cursor:pointer; }
  .codex-reasoning-slider input[type="range"]::-webkit-slider-runnable-track { height:6px; border-radius:999px; background:linear-gradient(90deg,#7fa5ff 0 var(--codex-slider-progress),rgba(127,127,127,.34) var(--codex-slider-progress) 100%); }
  .codex-reasoning-slider input[type="range"]::-webkit-slider-thumb { width:20px; height:20px; margin-top:-7px; appearance:none; -webkit-appearance:none; border:2px solid #f7f9ff; border-radius:50%; background:#5f86eb; box-shadow:0 3px 9px rgba(0,0,0,.38); }
  .codex-reasoning-slider input[type="range"]:focus-visible { outline:2px solid #9dc6ff; outline-offset:4px; border-radius:999px; }
  .codex-reasoning-slider input[type="range"]:disabled { opacity:.48; cursor:not-allowed; }
  .codex-reasoning-stops { z-index:1; display:flex; align-items:center; justify-content:space-between; height:28px; margin-inline:8px; pointer-events:none; }
  .codex-reasoning-stops>span { width:4px; height:4px; border-radius:50%; background:#7b7b7b; box-shadow:0 0 0 2px #1d1d1d; }
  .codex-reasoning-stops>span.is-active { background:#d9e5ff; }
  .codex-reasoning-slider.is-compact { padding:8px 9px 9px; }
  .codex-visually-hidden { position:absolute !important; width:1px !important; height:1px !important; padding:0 !important; margin:-1px !important; overflow:hidden !important; clip:rect(0,0,0,0) !important; white-space:nowrap !important; border:0 !important; }
  .codex-switch-row { width:100%; display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:10px; text-align:left; border-radius:10px !important; padding:10px !important; }
  .codex-switch-row>span:nth-child(2) { display:grid; gap:2px; }
  .codex-switch-icon { display:grid; place-items:center; width:28px; height:28px; border-radius:8px; color:#9cbcff; background:rgba(91,130,255,.14); }
  .codex-switch-track { width:34px; height:20px; padding:2px; border-radius:999px; background:rgba(127,127,127,.36); transition:background 140ms ease; }
  .codex-switch-track>span { display:block; width:16px; height:16px; border-radius:50%; background:#eee; transform:translateX(0); transition:transform 140ms cubic-bezier(.2,.8,.2,1); }
  .codex-switch-row[aria-checked="true"] .codex-switch-track { background:#6b8cff; }
  .codex-switch-row[aria-checked="true"] .codex-switch-track>span { transform:translateX(14px); }
  .codex-settings-notice { min-height:16px; color:#9dc6ff; font-size:11px; line-height:1.45; overflow-wrap:anywhere; }
  .codex-settings-notice[data-tone="error"],[data-codex-model-save-status][data-tone="error"] { color:#ff9b9b; }
  .codex-computer-card { gap:14px; }
  .codex-route-badge.is-vendor { max-width:24ch; border-color:rgba(235,179,87,.42); color:#f3d49b; background:rgba(125,82,21,.2); line-height:1.35; text-align:end; white-space:normal; }
  .codex-route-badge.is-unavailable { max-width:24ch; border-color:rgba(255,142,142,.42); color:#ffb3b3; background:rgba(160,34,34,.16); line-height:1.35; text-align:end; white-space:normal; }
  .codex-computer-option { width:100%; min-width:0; display:grid; grid-template-columns:auto minmax(0,1fr); gap:11px; align-items:center; padding:11px !important; border:1px solid rgba(127,127,127,.3) !important; border-radius:10px !important; background:rgba(127,127,127,.055) !important; text-align:start; }
  .codex-computer-option:hover:not(:disabled) { border-color:rgba(157,198,255,.46) !important; background:rgba(116,151,211,.1) !important; }
  .codex-computer-option.is-selected { border-color:rgba(145,178,255,.54) !important; background:rgba(94,127,197,.12) !important; }
  .codex-computer-option:disabled { opacity:1; cursor:default; }
  .codex-computer-option>span:last-child,.codex-computer-disclosure,.codex-official-heading>span:first-child { min-width:0; display:grid; gap:3px; }
  .codex-computer-option small,.codex-official-heading small { overflow-wrap:anywhere; }
  .codex-computer-radio { display:grid; place-items:center; width:18px; height:18px; border:1px solid rgba(190,190,190,.55); border-radius:50%; }
  .codex-computer-radio span { width:8px; height:8px; border-radius:50%; background:#91b2ff; opacity:0; transform:scale(.7); transition:opacity 140ms ease,transform 140ms cubic-bezier(.2,.8,.2,1); }
  .codex-computer-option.is-selected .codex-computer-radio { border-color:#91b2ff; }
  .codex-computer-option.is-selected .codex-computer-radio span { opacity:1; transform:none; }
  .codex-official-computer { display:grid; gap:11px; padding-block-start:14px; border-block-start:1px solid rgba(127,127,127,.26); }
  .codex-official-computer.is-active { border-block-start-color:rgba(235,179,87,.48); }
  .codex-official-computer.is-unavailable { border-block-start-color:rgba(255,142,142,.42); }
  .codex-official-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
  .codex-official-state { flex:none; max-width:22ch; border:1px solid rgba(127,127,127,.32); border-radius:999px; padding:4px 8px; color:var(--sand-text-secondary,#ccc); background:rgba(127,127,127,.08); font-size:11px; line-height:1.35; text-align:center; overflow-wrap:anywhere; }
  .codex-official-state[data-state="ready"] { border-color:rgba(102,201,137,.42); color:#a8e7bc; background:rgba(38,119,67,.18); }
  .codex-official-state[data-state="signing-in"],.codex-official-state[data-state="checking-access"],.codex-official-state[data-state="provisioning"],.codex-official-state[data-state="connecting-view"] { border-color:rgba(157,198,255,.4); color:#bed8ff; background:rgba(62,102,165,.18); }
  .codex-official-state[data-state="payment-required"],.codex-official-state[data-state="sign-in-error"],.codex-official-state[data-state="sign-in-blocked"],.codex-official-state[data-state="unavailable"],.codex-official-state[data-state="helper-unavailable"] { border-color:rgba(255,142,142,.42); color:#ffb3b3; background:rgba(160,34,34,.16); }
  .codex-computer-disclosure { padding:11px 12px; border:1px solid rgba(235,179,87,.34); border-radius:9px; color:#decba9; background:rgba(125,82,21,.13); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
  .codex-computer-disclosure strong { color:#f4ddb2; }
  .codex-permission-warning { display:grid; gap:4px; padding:11px 12px; border:1px solid rgba(235,179,87,.4); border-radius:9px; color:#decba9; background:rgba(125,82,21,.15); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
  .codex-permission-warning strong { color:#f4ddb2; }
  .codex-permission-scope { display:grid; gap:10px; padding-block:14px; border-top:1px solid rgba(255,255,255,.1); }
  .codex-card-heading + .codex-permission-scope { padding-top:4px; border-top:0; }
  .codex-permission-scope-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .codex-permission-scope-heading>div { min-width:0; display:grid; gap:2px; }
  .codex-permission-scope-heading strong { color:var(--sand-text-primary,#eee); font-size:13px; }
  .codex-permission-scope-heading small { color:var(--sand-text-secondary,#aaa); font-size:11px; line-height:1.4; }
  .codex-official-login-domain { color:var(--sand-text-tertiary,#aaa); font-size:11px; line-height:1.45; overflow-wrap:anywhere; }
  .codex-official-login-domain strong { color:var(--sand-text-secondary,#ccc); }
  .codex-official-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .codex-computer-ack { flex:1 0 100%; display:grid; grid-template-columns:18px minmax(0,1fr); align-items:start; gap:9px; color:var(--sand-text-secondary,#ccc); font-size:12px; line-height:1.45; cursor:pointer; }
  .codex-computer-ack input { width:16px; height:16px; margin:1px 0 0; accent-color:#91b2ff; }
  .codex-computer-ack input[aria-invalid="true"] { outline:2px solid #ff9b9b; outline-offset:2px; }
  .codex-official-error { padding:9px 10px; border:1px solid rgba(255,142,142,.42); border-radius:8px; color:#ffb3b3; background:rgba(160,34,34,.16); font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
  .codex-computer-card[aria-busy="true"] { cursor:progress; }
  .codex-key-form { display:grid; gap:7px; }
  .codex-key-form[hidden] { display:none; }
  .codex-key-form input { min-width:220px; flex:1; border:1px solid rgba(127,127,127,.35); border-radius:8px; color:inherit; background:rgba(0,0,0,.18); padding:8px 10px; }
  .codex-key-form input::placeholder { color:#929292; }
  .codex-notice { min-height:1.4em; color:#9dc6ff; }
  .codex-notice[data-tone="error"] { color:#ff8e8e; }
  .codex-notice a { color:#b9d7ff; text-underline-offset:3px; }
  .codex-availability { display:grid; gap:3px; padding:10px 12px; border:1px solid rgba(255,142,142,.42); border-radius:9px; background:rgba(160,34,34,.16); color:#ffb3b3; }
  .codex-availability span { font-size:12px; line-height:1.4; }
  .codex-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(105px,1fr)); gap:8px; }
  .codex-metrics div { display:grid; gap:2px; padding:9px; border-radius:8px; background:rgba(127,127,127,.1); }
  .codex-metrics strong { font-size:15px; }
  .codex-metrics span { color:var(--sand-text-tertiary,#aaa); font-size:11px; }
  .codex-card dl { display:grid; gap:7px; margin:0; }
  .codex-card dl div { display:flex; justify-content:space-between; gap:16px; }
  .codex-card dt { color:var(--sand-text-tertiary,#aaa); }
  .codex-card dd { margin:0; text-align:right; }
  .codex-model-pill { min-height:30px; display:inline-flex; align-items:center; gap:5px; border:1px solid rgba(127,127,127,.32); border-radius:999px; padding:4px 8px; color:var(--sand-text-secondary,#ccc); background:rgba(127,127,127,.09); font:inherit; font-size:11px; line-height:1; cursor:pointer; }
  .codex-model-pill:hover,.codex-model-pill[aria-expanded="true"] { background:rgba(127,127,127,.18); border-color:rgba(157,198,255,.45); }
  .codex-model-pill:focus-visible { outline:2px solid #9dc6ff; outline-offset:2px; }
  .codex-model-pill-bolt { display:grid; color:#8fb0ff; }
  .codex-research-mark { display:grid; place-items:center; width:16px; height:16px; border-radius:5px; background:#dbe8ff; color:#17243e; font-size:9px; font-weight:800; }
  .codex-model-pill-reasoning { color:var(--sand-text-tertiary,#999); }
  .codex-mode-picker { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin:2px 0; }
  .codex-mode-picker>button { min-width:0; padding:10px 12px; border:1px solid rgba(127,127,127,.28); border-radius:10px; color:var(--sand-text-primary,#eee); background:rgba(127,127,127,.055); text-align:left; cursor:pointer; }
  .codex-mode-picker>button:hover:not(:disabled) { border-color:rgba(157,198,255,.48); background:rgba(116,151,211,.1); }
  .codex-mode-picker>button[aria-checked="true"] { border-color:rgba(157,198,255,.72); background:rgba(116,151,211,.16); box-shadow:0 3px 12px rgba(21,42,79,.18); }
  .codex-mode-picker strong,.codex-mode-picker small { display:block; }
  .codex-mode-picker small { margin-top:3px; color:var(--sand-text-tertiary,#999); font-size:10px; line-height:1.35; }
  .codex-mode-picker.is-compact>button { padding:8px 9px; }
  .codex-image-studio form { display:grid; gap:9px; }
  .codex-image-studio textarea { width:100%; min-height:76px; resize:vertical; }
  .codex-image-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .codex-image-options label { display:grid; gap:5px; }
  .codex-image-result { display:grid; gap:8px; }
  .codex-image-result[hidden] { display:none; }
  .codex-image-result img { display:block; width:min(100%,480px); height:auto; border-radius:12px; background:#111; }
  .codex-image-result a { width:max-content; color:#9dc6ff; text-decoration-thickness:1px; text-underline-offset:3px; }
  .codex-image-unavailable { max-width:68ch; color:var(--sand-text-secondary,#ccc); }
  .codex-always-on ul { display:grid; gap:5px; margin:0; padding-left:19px; color:var(--sand-text-secondary,#ccc); font-size:11px; line-height:1.45; }
  .codex-model-popover { position:fixed; z-index:2147483646; width:min(356px,calc(100vw - 20px)); max-height:min(620px,calc(100vh - 20px)); overflow:auto; display:grid; gap:14px; padding:12px; border:1px solid rgba(255,255,255,.14); border-radius:14px; color:#eee; background:#171717; box-shadow:0 18px 54px rgba(0,0,0,.46); animation:codex-popover-enter 130ms cubic-bezier(.2,.8,.2,1) both; }
  .codex-model-popover-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .codex-model-popover-heading>div { display:grid; gap:2px; }
  .codex-model-popover-heading span,.codex-model-popover small { color:#999; font-size:11px; line-height:1.35; }
  .codex-model-popover button { color:inherit; font:inherit; cursor:pointer; }
  .codex-model-popover button:focus-visible { outline:2px solid #9dc6ff; outline-offset:2px; }
  .codex-model-popover-close { display:grid; place-items:center; width:28px; height:28px; border:0; border-radius:7px; background:transparent; }
  .codex-model-popover-close:hover { background:rgba(255,255,255,.08); }
  .codex-model-popover section { display:grid; gap:7px; }
  .codex-model-popover-label { color:#aaa; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.06em; }
  .codex-model-choices { display:grid; gap:3px; }
  .codex-model-choice { width:100%; display:grid; grid-template-columns:auto 1fr; align-items:center; gap:9px; border:0; border-radius:9px; padding:8px; text-align:left; background:transparent; }
  .codex-model-choice:hover,.codex-model-choice[aria-checked="true"] { background:rgba(255,255,255,.07); }
  .codex-model-choice>span:last-child { display:grid; gap:2px; }
  .codex-choice-indicator { display:grid; place-items:center; width:16px; height:16px; border:1px solid #666; border-radius:50%; }
  .codex-model-choice[aria-checked="true"] .codex-choice-indicator { border-color:#91b2ff; }
  .codex-model-choice[aria-checked="true"] .codex-choice-indicator>span { width:7px; height:7px; border-radius:50%; background:#91b2ff; }
  .codex-popover-fast { border:1px solid rgba(255,255,255,.1) !important; background:rgba(255,255,255,.035) !important; }
  .codex-model-popover-footer { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:30px; }
  .codex-model-popover-footer button { border:0; padding:5px 0; color:#a9c7ff; background:transparent; font-size:11px; }
  .codex-model-popover-footer button:disabled { color:#666; cursor:default; }
  .codex-model-popover-footer span { color:#999; font-size:11px; }
  .codex-model-popover-loading,.codex-model-popover-error { padding:18px 12px; color:#aaa; text-align:center; font-size:12px; }
  .codex-model-popover-error { color:#ff9b9b; }
  .codex-chat-approval { box-sizing:border-box; width:min(680px,calc(100% - 28px)); max-height:min(620px,calc(100vh - 180px)); overflow:auto; display:grid; gap:10px; align-self:flex-start; margin:8px 14px 12px; padding:13px; border:1px solid rgba(235,179,87,.46); border-radius:13px; color:var(--sand-text-primary,#eee); background:rgba(38,29,17,.98); box-shadow:0 12px 34px rgba(0,0,0,.3); }
  .codex-chat-approval-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .codex-chat-approval-heading>div { min-width:0; display:grid; gap:2px; }
  .codex-chat-approval-heading>div>span { color:#e0bf83; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
  .codex-chat-approval p,.codex-chat-approval ul,.codex-chat-approval figure { margin:0; }
  .codex-chat-approval p,.codex-chat-approval li,.codex-chat-approval figcaption { color:#d6c9b3; font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
  .codex-chat-approval ul { display:grid; gap:3px; padding-inline-start:18px; }
  .codex-chat-approval figure { display:grid; gap:6px; }
  .codex-chat-approval img { display:block; width:100%; aspect-ratio:16/10; object-fit:contain; border:1px solid rgba(255,255,255,.15); border-radius:9px; background:#080808; }
  .codex-chat-approval-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .codex-chat-approval-actions button { border:1px solid rgba(255,255,255,.23); border-radius:999px; padding:7px 12px; color:#eee; background:rgba(255,255,255,.1); font:inherit; cursor:pointer; }
  .codex-chat-approval-actions [data-codex-chat-allow] { border-color:#f2f2f2; color:#111; background:#f2f2f2; font-weight:650; }
  .codex-chat-approval-actions button:disabled { opacity:.55; cursor:wait; }
  .codex-chat-approval-actions button:focus-visible { outline:2px solid #9dc6ff; outline-offset:2px; }
  .codex-chat-approval-actions span { flex:1 0 220px; color:#d6c9b3; font-size:11px; line-height:1.4; }
  .codex-group-task-tracker { box-sizing:border-box; width:min(680px,calc(100% - 28px)); display:grid; gap:10px; align-self:flex-start; margin:8px 14px 12px; padding:13px; border:1px solid rgba(127,151,215,.38); border-radius:13px; color:var(--sand-text-primary,#eee); background:rgba(35,42,58,.92); box-shadow:0 12px 34px rgba(0,0,0,.24); }
  .codex-group-task-tracker>header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .codex-group-task-tracker>header>div:first-child { min-width:0; display:grid; gap:2px; }
  .codex-group-task-tracker>header>div:first-child>span { color:#b9d0ff; font-size:11px; font-weight:650; letter-spacing:.05em; text-transform:uppercase; }
  .codex-group-task-tracker>header strong { overflow:hidden; font-size:14px; text-overflow:ellipsis; white-space:nowrap; }
  .codex-group-task-actions { flex:none; display:flex; align-items:center; gap:8px; }
  .codex-group-task-actions>span { color:#b8c4da; font-size:11px; white-space:nowrap; }
  .codex-group-task-actions button { border:0; padding:4px 0; color:#b9d7ff; background:transparent; font:inherit; font-size:11px; cursor:pointer; }
  .codex-group-task-actions button:hover { color:#fff; text-decoration:underline; text-underline-offset:3px; }
  .codex-group-task-actions button:focus-visible { outline:2px solid #9dc6ff; outline-offset:3px; border-radius:4px; }
  .codex-group-task-tracker>p { max-width:68ch; margin:0; color:#d6ddea; font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
  .codex-group-task-tracker>ol { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:5px 12px; padding:0; margin:0; list-style:none; }
  .codex-group-task-tracker li { min-width:0; display:grid; grid-template-columns:8px minmax(0,1fr) auto; align-items:center; gap:7px; color:#bec9dc; font-size:11px; }
  .codex-group-task-tracker li strong { overflow:hidden; color:#eff3ff; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
  .codex-group-task-tracker li>span:last-child { color:#9faec7; white-space:nowrap; }
  .codex-group-task-dot { width:7px; height:7px; border-radius:50%; background:#69748a; }
  .codex-group-task-tracker li[data-status="working"] .codex-group-task-dot { background:#93b7ff; box-shadow:0 0 0 3px rgba(147,183,255,.14); }
  .codex-group-task-tracker li[data-status="complete"] .codex-group-task-dot { background:#8ed5a4; }
  .codex-group-task-tracker li[data-status="passed"] .codex-group-task-dot { background:#97a3b8; }
  .codex-group-task-tracker li[data-status="blocked"] .codex-group-task-dot { background:#f0ae84; }
  .openbot-apps-dialog { width:min(900px,calc(100vw - 36px)); height:min(720px,calc(100vh - 36px)); max-width:none; max-height:none; padding:0; overflow:hidden; border:1px solid rgba(255,255,255,.15); border-radius:16px; color:var(--sand-text-primary,#eee); background:#151515; box-shadow:0 30px 90px rgba(0,0,0,.62); }
  .openbot-apps-dialog::backdrop { background:rgba(0,0,0,.68); backdrop-filter:blur(5px); }
  .openbot-apps-shell { height:100%; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
  .openbot-apps-shell>header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; padding:22px 24px 18px; border-bottom:1px solid rgba(255,255,255,.09); }
  .openbot-apps-shell>header>div { display:grid; gap:4px; }
  .openbot-apps-shell h2,.openbot-apps-shell h3,.openbot-apps-shell p { margin:0; }
  .openbot-apps-shell h2 { font-size:21px; letter-spacing:-.025em; }
  .openbot-apps-shell h3 { max-width:22ch; font-size:24px; line-height:1.15; letter-spacing:-.03em; }
  .openbot-apps-shell>header p,.openbot-apps-setup p { color:#aaa; font-size:12px; line-height:1.5; }
  .openbot-apps-eyebrow { color:#91b8ff; font-size:10px; font-weight:750; letter-spacing:.1em; text-transform:uppercase; }
  .openbot-apps-shell>header>button { width:30px; height:30px; display:grid; place-items:center; flex:none; border:0; border-radius:8px; color:#ddd; background:transparent; cursor:pointer; }
  .openbot-apps-shell>header>button:hover { background:rgba(255,255,255,.08); }
  .openbot-apps-shell>main { overflow:auto; padding:22px 24px; }
  .openbot-apps-shell>footer { min-height:46px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:10px 24px; border-top:1px solid rgba(255,255,255,.09); color:#999; font-size:11px; }
  .openbot-apps-shell>footer span[data-tone="error"] { color:#ff9f9f; }
  .openbot-apps-shell>footer a { color:#abc9ff; }
  .openbot-apps-setup { width:min(600px,100%); min-height:100%; display:grid; align-content:center; gap:20px; margin:auto; }
  .openbot-apps-setup>div { display:grid; gap:7px; }
  .openbot-apps-setup form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; }
  .openbot-apps-setup form label { grid-column:1/-1; color:#aaa; font-size:11px; font-weight:650; }
  .openbot-apps-setup input,.openbot-apps-toolbar input { min-width:0; border:1px solid rgba(255,255,255,.17); border-radius:9px; padding:10px 12px; color:#eee; background:#202020; font:inherit; }
  .openbot-apps-setup button,.openbot-app-card button,.openbot-apps-toolbar button,.openbot-apps-error button { border:1px solid rgba(255,255,255,.2); border-radius:9px; padding:9px 13px; color:#eee; background:#292929; font:inherit; font-weight:650; cursor:pointer; }
  .openbot-apps-setup button { border-color:#f2f2f2; color:#111; background:#f2f2f2; }
  .openbot-apps-setup button:disabled,.openbot-app-card button:disabled { opacity:.62; cursor:default; }
  .openbot-apps-fineprint { color:#888 !important; font-size:10px !important; }
  .openbot-apps-catalog { display:grid; gap:16px; }
  .openbot-apps-toolbar { display:grid; grid-template-columns:minmax(240px,1fr) auto; gap:10px; }
  .openbot-apps-toolbar label { display:grid; }
  .openbot-apps-toolbar button { border:0; color:#aaa; background:transparent; font-weight:500; }
  .openbot-apps-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
  .openbot-app-card { min-width:0; display:grid; grid-template-columns:42px minmax(0,1fr) auto; align-items:center; gap:11px; padding:12px; border:1px solid rgba(255,255,255,.11); border-radius:12px; background:#1d1d1d; }
  .openbot-app-glyph { width:42px; height:42px; display:grid; place-items:center; border-radius:11px; color:#bcd2ff; background:rgba(111,151,223,.14); font-size:12px; font-weight:800; letter-spacing:.04em; }
  .openbot-app-card>div { min-width:0; display:grid; gap:3px; }
  .openbot-app-card strong,.openbot-app-card small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .openbot-app-card strong { font-size:13px; }
  .openbot-app-card small { color:#999; font-size:10px; }
  .openbot-app-card button { min-width:88px; padding:7px 10px; font-size:11px; }
  .openbot-app-card button:disabled { border-color:rgba(105,194,130,.25); color:#9ed7a8; background:rgba(84,162,105,.09); }
  .openbot-apps-empty,.openbot-apps-loading,.openbot-apps-error { grid-column:1/-1; padding:48px 20px; color:#aaa; text-align:center; }
  .openbot-apps-error { display:grid; place-items:center; gap:9px; }
  .openbot-apps-dialog button:focus-visible,.openbot-apps-dialog input:focus-visible,.openbot-apps-dialog a:focus-visible { outline:2px solid #9dc6ff; outline-offset:2px; }
  html[data-codex-connection-required],html[data-codex-connection-required] body { overflow:hidden !important; }
  [data-codex-onboarding] { position:fixed; inset:0; z-index:2147483647; display:grid; place-items:center; overflow:auto; padding:clamp(20px,5vw,56px); background:rgba(11,11,11,.94); backdrop-filter:blur(12px); color:#f5f5f5; animation:codex-connect-enter 320ms cubic-bezier(.16,1,.3,1) both; }
  .codex-first-run-dialog { width:min(860px,100%); display:grid; gap:22px; }
  .codex-first-run-brand { display:flex; align-items:center; gap:14px; }
  .codex-first-run-brand img { width:52px; height:52px; flex:none; }
  .codex-first-run-brand h1 { margin:0 0 3px; font-size:21px; line-height:1.2; letter-spacing:-.02em; }
  .codex-first-run-brand p { margin:0; color:#b8b8b8; line-height:1.45; }
  [data-codex-onboarding] [data-codex-local] { gap:0; margin:0; }
  .codex-first-run-card { gap:16px; padding:clamp(18px,4vw,26px); background:#171717; border-color:rgba(255,255,255,.16); }
  .codex-first-run-copy { display:grid; gap:7px; }
  .codex-first-run-copy h2 { max-width:24ch; font-size:clamp(22px,4vw,28px); line-height:1.14; letter-spacing:-.025em; text-wrap:balance; }
  .codex-first-run-copy p { max-width:62ch; color:#bdbdbd; line-height:1.55; }
  .codex-first-run-card [data-codex-provider-connect] { border-color:#f2f2f2; background:#f2f2f2; color:#111; font-weight:650; }
  .codex-first-run-card [data-codex-provider-connect]:hover { background:#fff; }
  .codex-visually-hidden { position:absolute !important; width:1px !important; height:1px !important; overflow:hidden !important; clip:rect(0 0 0 0) !important; clip-path:inset(50%) !important; white-space:nowrap !important; }
  .codex-vertex-form[hidden],.codex-local-form[hidden],.codex-key-form[hidden] { display:none !important; }
  .codex-onboarding-panel { display:grid; gap:20px; padding:clamp(20px,4vw,30px); border:1px solid rgba(255,255,255,.15); border-radius:18px; background:#171717; box-shadow:0 24px 70px rgba(0,0,0,.32); }
  .codex-onboarding-heading { display:grid; gap:7px; }
  .codex-onboarding-heading h2 { margin:0; max-width:28ch; font-size:clamp(24px,4vw,32px); line-height:1.08; letter-spacing:-.035em; text-wrap:balance; }
  .codex-onboarding-heading p { max-width:62ch; margin:0; color:#bdbdbd; font-size:14px; line-height:1.55; }
  .codex-step-count { color:#91b8ff; font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; }
  .codex-provider-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
  .codex-provider-tile { min-width:0; min-height:78px; display:grid; grid-template-columns:38px minmax(0,1fr) auto; align-items:center; gap:11px; padding:13px; border:1px solid rgba(255,255,255,.13); border-radius:13px; color:#f2f2f2; background:#202020; text-align:left; font:inherit; cursor:pointer; transition:border-color 140ms ease,background 140ms ease,transform 140ms ease; }
  .codex-provider-tile:hover { border-color:rgba(151,190,255,.58); background:#252525; transform:translateY(-1px); }
  .codex-provider-tile.is-active { border-color:#78a9ff; background:#1c2636; box-shadow:inset 0 0 0 1px rgba(120,169,255,.2); }
  .codex-provider-tile:disabled { opacity:.72; cursor:wait; transform:none; }
  .codex-provider-logo { width:38px; height:38px; display:grid; place-items:center; overflow:hidden; border-radius:10px; }
  .codex-provider-logo svg, .codex-provider-logo img { width:100%; height:100%; display:block; object-fit:contain; }
  .codex-provider-tile-copy { min-width:0; display:grid; gap:3px; }
  .codex-provider-tile-copy strong,.codex-provider-tile-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .codex-provider-tile-copy strong { font-size:13px; }
  .codex-provider-tile-copy small { color:#aaa; font-size:11px; }
  .codex-provider-state { color:#91b8ff; font-size:15px; }
  .codex-onboarding-detail { display:flex; align-items:center; justify-content:space-between; gap:14px; min-height:24px; }
  .codex-onboarding-detail p { margin:0; color:#aaa; font-size:12px; line-height:1.45; }
  .codex-text-action { border:0; padding:6px 0; color:#a9c7ff; background:transparent; font:inherit; font-size:12px; cursor:pointer; }
  .codex-onboarding-footer { min-height:44px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding-top:4px; border-top:1px solid rgba(255,255,255,.09); }
  .codex-onboarding-footer>span { color:#aaa; font-size:12px; }
  .codex-primary-action { min-height:40px; border:1px solid #f3f3f3; border-radius:10px; padding:9px 17px; color:#111; background:#f3f3f3; font:inherit; font-weight:700; cursor:pointer; }
  .codex-primary-action:hover { background:#fff; }
  .codex-primary-action:disabled { border-color:#484848; color:#888; background:#303030; cursor:not-allowed; }
  .codex-provider-tile:focus-visible,.codex-primary-action:focus-visible,.codex-text-action:focus-visible,.codex-onboarding-computer:focus-visible,.codex-cloud-choice-main:focus-visible { outline:2px solid #9dc6ff; outline-offset:3px; }
  .codex-onboarding-computers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; align-items:start; }
  .codex-onboarding-computer { min-width:0; display:grid; grid-template-columns:44px minmax(0,1fr) 18px; align-items:start; gap:12px; padding:16px; border:1px solid rgba(255,255,255,.13); border-radius:14px; color:#eee; background:#202020; text-align:left; font:inherit; }
  button.codex-onboarding-computer { cursor:pointer; }
  .codex-onboarding-computer.is-selected { border-color:#78a9ff; background:#1c2636; box-shadow:inset 0 0 0 1px rgba(120,169,255,.18); }
  .codex-onboarding-computer>span:nth-child(2),.codex-cloud-choice-main>span:nth-child(2) { min-width:0; display:grid; gap:5px; }
  .codex-onboarding-computer small,.codex-cloud-choice-main small { color:#aaa; font-size:11px; line-height:1.45; }
  .codex-computer-glyph { width:42px; height:42px; display:grid; place-items:center; border-radius:11px; color:#a9c7ff; background:rgba(124,169,255,.12); }
  .codex-computer-glyph svg { width:25px; height:25px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .codex-computer-glyph.is-cloud { color:#e6bd74; background:rgba(230,189,116,.11); }
  .codex-choice-check { width:16px; height:16px; margin-top:2px; border:1px solid #666; border-radius:50%; }
  .is-selected .codex-choice-check { border:5px solid #78a9ff; }
  .codex-cloud-choice { display:block; padding:0; overflow:hidden; }
  .codex-cloud-choice-main { width:100%; display:grid; grid-template-columns:44px minmax(0,1fr) 18px; align-items:start; gap:12px; padding:16px; border:0; color:inherit; background:transparent; text-align:left; font:inherit; cursor:pointer; }
  .codex-cloud-setup { display:grid; gap:12px; padding:0 16px 16px; border-top:1px solid rgba(255,255,255,.09); }
  .codex-cloud-setup[hidden] { display:none; }
  .codex-cloud-setup>p { margin:12px 0 0; color:#bbb; font-size:11px; line-height:1.5; }
  .codex-cloud-setup .codex-official-actions { display:grid; gap:9px; }
  .codex-cloud-setup button { min-height:36px; border:1px solid rgba(255,255,255,.2); border-radius:9px; color:#eee; background:#292929; font:inherit; cursor:pointer; }
  .codex-computer-ack { display:grid; grid-template-columns:auto 1fr; gap:8px; color:#bbb; font-size:11px; line-height:1.45; }
  .codex-onboarding-success { color:#9ed7a8; font-size:12px; font-weight:650; }
  .codex-onboarding-complete { place-items:center; text-align:center; }
  .codex-onboarding-complete .codex-onboarding-heading { place-items:center; }
  .codex-complete-mark { width:62px; height:62px; color:#9ed7a8; }
  .codex-complete-mark svg { width:100%; height:100%; fill:rgba(100,190,120,.1); stroke:currentColor; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }
  .codex-onboarding-summary { width:min(520px,100%); display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1px; overflow:hidden; margin:0; border:1px solid rgba(255,255,255,.1); border-radius:12px; background:rgba(255,255,255,.1); }
  .codex-onboarding-summary div { display:grid; gap:5px; padding:13px; background:#202020; }
  .codex-onboarding-summary dt { color:#999; font-size:10px; letter-spacing:.06em; text-transform:uppercase; }
  .codex-onboarding-summary dd { margin:0; overflow:hidden; color:#eee; font-size:12px; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
  .codex-onboarding-footer.is-complete { width:100%; }
  .codex-connection-assurance { color:#bdbdbd; font-size:12px; line-height:1.5; }
  [data-codex-onboarding] ::selection { background:#b9d7ff; color:#111; }
  @keyframes codex-connect-enter { from { opacity:.72; transform:translateY(10px); filter:blur(4px); } to { opacity:1; transform:none; filter:none; } }
  @keyframes codex-popover-enter { from { opacity:0; transform:translateY(4px) scale(.985); } to { opacity:1; transform:none; } }
  @media (max-width:560px) {
    [data-codex-onboarding] { place-items:start center; }
    .codex-first-run-brand { align-items:flex-start; }
    .codex-first-run-card .codex-actions,.codex-first-run-card .codex-key-form>div { display:grid; }
    .codex-first-run-card button,.codex-first-run-card input { width:100%; min-width:0; }
    .codex-setting-grid { grid-template-columns:1fr; }
    .codex-card-heading,.codex-official-heading { display:grid; gap:9px; }
    .codex-route-badge,.codex-route-badge.is-vendor,.codex-route-badge.is-unavailable,.codex-official-state { justify-self:start; max-width:100%; text-align:start; }
    .codex-official-actions>button { width:100%; }
    .codex-chat-approval { width:calc(100% - 16px); margin-inline:8px; }
    .codex-group-task-tracker { width:calc(100% - 16px); margin-inline:8px; }
    .codex-chat-approval-heading { display:grid; }
    .codex-group-task-tracker>header { display:grid; }
    .codex-group-task-actions { justify-content:space-between; }
    .codex-chat-approval-actions button { flex:1; }
    .codex-provider-grid,.codex-onboarding-computers,.codex-onboarding-summary { grid-template-columns:1fr; }
    .codex-onboarding-detail,.codex-onboarding-footer { align-items:stretch; flex-direction:column; }
    .codex-onboarding-footer .codex-primary-action { width:100%; }
    .openbot-apps-dialog { width:100vw; height:100vh; max-width:none; max-height:none; border:0; border-radius:0; }
    .openbot-apps-shell>header,.openbot-apps-shell>main,.openbot-apps-shell>footer { padding-inline:16px; }
    .openbot-apps-grid { grid-template-columns:1fr; }
    .openbot-apps-setup form,.openbot-apps-toolbar { grid-template-columns:1fr; }
    .openbot-apps-shell>footer { align-items:flex-start; flex-direction:column; }
  }
  @media (prefers-reduced-motion:reduce) { [data-codex-onboarding],.codex-model-popover { animation:none; } .codex-switch-track,.codex-switch-track>span,.codex-computer-radio span { transition:none; } }
  @media (forced-colors:active) {
    .codex-computer-option.is-selected,.codex-official-computer.is-active,.codex-official-computer.is-unavailable,.codex-computer-disclosure,.codex-official-error,.codex-route-badge.is-vendor,.codex-route-badge.is-unavailable { border-color:Highlight; }
    .codex-computer-radio span { background:Highlight; }
  }
`;
document.head.append(style);

const observer = new MutationObserver(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(applyUi, 40);
});
observer.observe(document.documentElement, { childList: true, subtree: true });
applyUi();
loadStatus();
setInterval(loadStatus, 15000);
