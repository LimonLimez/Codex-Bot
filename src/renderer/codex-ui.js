const CODEX_SERVICE = "http://127.0.0.1:__CODEX_VIEW_PORT__";
const CODEX_TOKEN = "__CODEX_VIEW_TOKEN__";
const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
globalThis.__CODEX_BOT_VIEW_TOKEN__ = CODEX_TOKEN;
const headers = { "X-Codex-Seat-Token": CODEX_TOKEN };
let lastStatus = null;
let refreshTimer = null;
let connectionPollTimer = null;
let officialConnectionPollTimer = null;
let officialApprovalPollTimer = null;
let officialComputerOperationInFlight = false;
let officialPermissionOperationInFlight = false;
let officialEnableAfterCursorLogin = false;
let officialEnableContinuationInFlight = false;
let officialComputerNotice = { message: "", tone: "info" };
let officialPermissionNotice = { message: "", tone: "info" };
let pendingOAuthDevice = null;
let activeModelPicker = null;
const agentStatusCache = new Map();
const pendingAgentStatusLoads = new Map();
const officialApprovalLoads = new WeakSet();

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

function hasCodexConnection(status) {
  return Boolean(
    status?.account?.signedIn || status?.connection?.mode === "api-key",
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
      ? "Codex OAuth usage limit reached."
      : availability.state === "model-cooldown"
        ? "This Codex model is temporarily cooling down."
        : "The last Codex request failed.";
  return `<div class="codex-availability" role="status"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(availability.message || "")}${escapeHtml(reset)}</span><span>Use an OpenAI API key below to keep working now.</span></div>`;
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
  const safeUrl = validateOfficialLoginUrl(value);
  const link = document.createElement("a");
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.hidden = true;
  (document.body || document.documentElement).append(link);
  link.click();
  link.remove();
  return safeUrl;
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
  const enabled = computer.permissions.alwaysAllowComputerActions;
  const unavailable = computer.mode === "unknown";
  const permissionLocked = unavailable || (!computer.connected && !enabled);
  const busy = officialPermissionOperationInFlight;
  const disabled = permissionLocked || busy || !enabled;
  const enabledDescription =
    computer.mode === "official" && computer.connected
      ? "On for this connected official vendor account. Signing out or starting another sign-in turns it off; you can also turn it off here to restore Allow once or Deny cards."
      : "Stored for this official vendor account on this Windows user. It is not active while the vendor computer is disconnected; you can turn it off here to restore Allow once or Deny cards.";
  return `
    <section class="codex-card codex-permissions-card" aria-labelledby="codex-permissions-title" aria-busy="${busy ? "true" : "false"}">
      <div class="codex-card-heading">
        <div>
          <h2 id="codex-permissions-title">Permissions</h2>
          <p>Controls for the shared official vendor computer only.</p>
        </div>
        <span class="codex-route-badge${enabled ? " is-vendor" : ""}">${enabled ? "Always allow is on" : "Ask for each action"}</span>
      </div>
      <div class="codex-permission-warning" id="codex-vendor-permission-warning" role="note">
        <strong>Turning this on gives employees broad control of the shared vendor computer.</strong>
        <span>They may click, drag, type, press keys, submit forms, and navigate without showing an approval card for each action. This does not grant access to the Private browser or any other tool.</span>
        <span>Take control, session and screen-generation changes, action deadlines, and safety stops still interrupt work. The provider-scoped choice is protected for this Windows user with Windows DPAPI.</span>
      </div>
      ${
        enabled
          ? ""
          : `<label class="codex-computer-ack"><input type="checkbox" data-codex-vendor-permission-ack aria-describedby="codex-vendor-permission-warning"${permissionLocked || busy ? " disabled" : ""} /><span>I understand that employees can act on the shared vendor computer without asking each time.</span></label>`
      }
      <button class="codex-switch-row" type="button" role="switch" aria-checked="${enabled ? "true" : "false"}" aria-describedby="codex-vendor-permission-warning" data-codex-vendor-always-allow${disabled ? " disabled" : ""}>
        <span class="codex-switch-icon" aria-hidden="true">${boltIcon({ size: 15 })}</span>
          <span><strong>Always allow computer actions</strong><small>${enabled ? enabledDescription : "Off. Each non-automatic vendor action asks in the chat."}</small></span>
        <span class="codex-switch-track" aria-hidden="true"><span></span></span>
      </button>
      ${permissionLocked ? `<p class="codex-official-error" role="alert">${unavailable ? (enabled ? "The official provider helper is unavailable. Always allow remains stored and cannot be changed until the helper returns." : "The official provider helper is unavailable, so Always allow cannot be enabled.") : "Connect the official vendor account before enabling this permission."}</p>` : !computer.connected && enabled ? '<p class="codex-official-error" role="alert">The vendor computer is disconnected, but Always allow is still stored locally. Turn it off here or reconnect the account.</p>' : ""}
      <p class="codex-settings-notice" data-codex-permission-notice data-tone="${officialPermissionNotice.tone}" aria-live="polite">${escapeHtml(officialPermissionNotice.message)}</p>
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
  const reasoningOptions = state.reasoningEfforts
    .map(
      (effort) =>
        `<option value="${escapeHtml(effort)}"${effort === defaults.reasoningEffort ? " selected" : ""}>${escapeHtml(reasoningLabel(effort))}</option>`,
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
        <label>Reasoning<select data-codex-default-reasoning>${reasoningOptions}</select></label>
      </div>
      <button class="codex-switch-row" type="button" role="switch" aria-checked="${defaults.fastMode ? "true" : "false"}" data-codex-default-fast>
        <span class="codex-switch-icon">${boltIcon({ size: 15 })}</span>
        <span><strong>Fast mode</strong><small>Prioritizes lower latency. Direct API keys use premium per-token pricing; OAuth can consume allowance faster.</small></span>
        <span class="codex-switch-track"><span></span></span>
      </button>
      <p class="codex-settings-notice" data-codex-settings-notice aria-live="polite"></p>
    </section>
    ${officialComputerHtml(status)}
    ${vendorComputerPermissionsHtml(status)}`;
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

async function loadStatus() {
  try {
    const previousOfficial = officialComputerState(lastStatus);
    lastStatus = await request("/api/codex/status");
    let currentOfficial = officialComputerState(lastStatus);
    if (hasCodexConnection(lastStatus)) {
      pendingOAuthDevice = null;
      clearInterval(connectionPollTimer);
      connectionPollTimer = null;
    }
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
    [/Codex Bot/g, "Codex Bot"],
    [/Sign In with Cursor/g, "Sign in with Codex"],
    [/Sign in to Cursor/g, "Sign in with Codex"],
    [/Cursor account/g, "Codex account"],
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
  document.title = "Codex Bot";
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
      element.textContent = "Manage Codex connection";
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
  if (!account?.signedIn) return;
  for (const name of document.querySelectorAll(
    ".sand-agents-sidebar__account-name",
  )) {
    if (name.tagName !== "INPUT") name.textContent = account.name;
  }
  const footer = document.querySelector(".sand-agents-sidebar__account");
  if (!footer) return;
  footer.title = `${account.name}${account.email ? ` - ${account.email}` : ""} - ${status.connection.route}`;
  const image = footer.querySelector("img");
  if (image && account.avatarUrl) image.src = account.avatarUrl;
  else if (image) {
    const holder = image.parentElement;
    image.remove();
    if (holder) holder.textContent = initials(account.name);
  }
}

function connectionPanelHtml(status, { firstRun = false } = {}) {
  const account = status.account || {};
  const connection = status.connection || {};
  const usage = status.usage || {};
  const apiKeyActive = connection.mode === "api-key";
  const plan = account.plan
    ? account.plan[0].toUpperCase() + account.plan.slice(1)
    : "Unknown plan";
  const accountName = account.signedIn
    ? account.name
    : apiKeyActive
      ? "OpenAI API key connected"
      : "Not connected";
  const accountDetail = account.signedIn
    ? account.email || "Codex OAuth account"
    : apiKeyActive
      ? "Stored securely for this Windows user"
      : "Connect a Codex account or OpenAI API key";
  const connectionDetail =
    apiKeyActive && !account.signedIn ? "Direct OpenAI API" : plan;
  const avatar = account.avatarUrl
    ? `<img class="codex-avatar" src="${escapeHtml(account.avatarUrl)}" alt="" />`
    : `<span class="codex-avatar codex-initials">${escapeHtml(initials(account.name))}</span>`;
  const activeOAuth = connection.mode === "codex-oauth";
  const oauthLabel =
    activeOAuth && account.signedIn
      ? "Refresh Codex sign-in"
      : account.signedIn
        ? "Switch to Codex OAuth"
        : "Use Codex OAuth";
  const currentAvailability = availabilityHtml(usage.availability, activeOAuth);
  const firstRunIntroduction = firstRun
    ? `<div class="codex-first-run-copy">
        <h2 id="codex-connect-title">Connect Codex to start</h2>
        <p>Choose the account Codex Bot will use for your employees' work. No xAI subscription is required.</p>
      </div>`
    : "";
  const firstRunAssurance = firstRun
    ? `<p class="codex-connection-assurance">Codex OAuth opens the official OpenAI device page. API keys are verified before they are stored.</p>`
    : "";
  return `
    <section class="codex-card${firstRun ? " codex-first-run-card" : ""}" aria-label="Codex account">
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
      <div class="codex-actions">
        <button type="button" data-codex-oauth>${oauthLabel}</button>
        <button type="button" data-codex-key-toggle>Use OpenAI API key</button>
      </div>
      <form class="codex-key-form" data-codex-key-form hidden>
        <label for="codex-api-key">OpenAI API key</label>
        <div><input id="codex-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." required /><button type="submit">Verify & use</button></div>
        <small>The key is verified with OpenAI and stored with Windows user-level encryption. It is never written to logs.</small>
      </form>
      ${firstRunAssurance}
      <p class="codex-notice" data-codex-notice aria-live="polite"></p>
    </section>
    ${
      firstRun
        ? ""
        : `
    <section class="codex-card" aria-label="Codex Bot usage">
      <h3>Actual Codex Bot usage</h3>
      <div class="codex-metrics">
        <div><strong>${formatNumber(usage.requests)}</strong><span>requests</span></div>
        <div><strong>${formatNumber(usage.totalTokens)}</strong><span>total tokens</span></div>
        <div><strong>${formatNumber(usage.promptTokens)}</strong><span>input tokens</span></div>
        <div><strong>${formatNumber(usage.completionTokens)}</strong><span>output tokens</span></div>
        <div><strong>${formatNumber(usage.toolCalls)}</strong><span>tool calls</span></div>
      </div>
      <p>${escapeHtml(connection.model)} &middot; reasoning ${escapeHtml(connection.reasoningEffort)} &middot; last completion ${escapeHtml(formatDate(usage.lastCompletedAt))}</p>
      <small>These are measured bridge totals, not a made-up plan quota. OpenAI does not expose your Codex subscription's remaining allowance through this OAuth route.</small>
    </section>
    ${defaultInferenceHtml(status)}`
    }`;
}

function renderOAuthDevicePrompt(notice, device = pendingOAuthDevice) {
  if (!notice || device?.url !== CODEX_DEVICE_URL || !device?.code) return;
  notice.replaceChildren();
  notice.dataset.tone = "info";
  const message = document.createElement("span");
  message.textContent = `${device.message || "Complete Codex sign-in."} `;
  const link = document.createElement("a");
  link.href = CODEX_DEVICE_URL;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open OpenAI sign-in";
  const code = document.createElement("strong");
  code.textContent = ` Code: ${device.code}`;
  notice.append(message, link, code);
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
      "Finish signing in to Cursor. After sign-in, Codex Bot will check access and enable the shared vendor computer.",
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

function wireConnectionPanel(panel) {
  renderOAuthDevicePrompt(panel.querySelector("[data-codex-notice]"));
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
          ? "Always allow is on for the official vendor computer only."
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
    .querySelector("[data-codex-oauth]")
    ?.addEventListener("click", async (event) => {
      const notice = panel.querySelector("[data-codex-notice]");
      event.currentTarget.disabled = true;
      const canReuseOAuth = Boolean(
        lastStatus?.account?.signedIn &&
        lastStatus?.connection?.mode !== "codex-oauth",
      );
      notice.textContent = canReuseOAuth
        ? "Switching to Codex OAuth..."
        : "Preparing the official OpenAI sign-in...";
      notice.dataset.tone = "info";
      try {
        const action = canReuseOAuth ? "use-oauth" : "oauth";
        const result = await request("/api/codex/auth", { action });
        if (result.url && result.code) {
          pendingOAuthDevice = result;
          renderOAuthDevicePrompt(notice, result);
          pollForConnection();
        } else {
          notice.textContent = result.message || "Codex OAuth selected.";
          if (result.status) {
            lastStatus = result.status;
            applyUi();
          }
        }
      } catch (error) {
        notice.textContent = error.message;
        notice.dataset.tone = "error";
      } finally {
        event.currentTarget.disabled = false;
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
        pendingOAuthDevice = null;
        if (result.status) {
          lastStatus = result.status;
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
    ?.addEventListener("change", (event) => {
      saveDefault(event.currentTarget, {
        reasoningEffort: event.currentTarget.value,
      }).catch(() => loadStatus());
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
      officialComputerOperationInFlight,
      officialPermissionOperationInFlight,
      officialComputerNotice,
      officialPermissionNotice,
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
  if (hasCodexConnection(status)) {
    setWorkspaceConnectionGate(false, onboarding);
    onboarding?.remove();
    return;
  }
  if (!document.body) return;
  if (!onboarding) {
    onboarding = document.createElement("div");
    onboarding.dataset.codexOnboarding = "true";
    onboarding.innerHTML = `
      <main class="codex-first-run-dialog" role="dialog" aria-modal="true" aria-labelledby="codex-connect-title">
        <header class="codex-first-run-brand">
          <img src="./assets/app-icon-C7NKj2u7.png" alt="" />
          <div>
            <h1>Codex Bot</h1>
            <p>Always-on employees, powered by your Codex connection.</p>
          </div>
        </header>
        <div data-codex-local></div>
      </main>`;
    document.body.append(onboarding);
  }
  setWorkspaceConnectionGate(true, onboarding);
  const panel = onboarding.querySelector("[data-codex-local]");
  const signature = status ? JSON.stringify(status) : "checking";
  if (panel.dataset.signature !== signature) {
    panel.dataset.signature = signature;
    if (status) {
      panel.innerHTML = connectionPanelHtml(status, { firstRun: true });
      wireConnectionPanel(panel);
    } else {
      panel.innerHTML = `
        <section class="codex-card codex-first-run-card" aria-busy="true">
          <div class="codex-first-run-copy">
            <h2 id="codex-connect-title">Checking your Codex connection...</h2>
            <p>Codex Bot is confirming the private local service before opening your workspace.</p>
          </div>
          <p class="codex-notice" data-codex-notice aria-live="polite">This usually takes a moment.</p>
        </section>`;
    }
  }
  if (status && onboarding.dataset.codexInitialFocus !== "true") {
    requestAnimationFrame(() => {
      const target = panel.querySelector("[data-codex-oauth], input, button");
      if (!target) return;
      onboarding.dataset.codexInitialFocus = "true";
      target.focus();
    });
  }
}

function composerButtonContent(status) {
  const state = inferenceState(status);
  const effective = state.effective;
  const model = modelMeta(effective.model, state);
  return `${effective.fastMode ? `<span class="codex-model-pill-bolt">${boltIcon({ size: 13 })}</span>` : ""}<span>${escapeHtml(model.label)}</span><span class="codex-model-pill-reasoning">${escapeHtml(reasoningLabel(effective.reasoningEffort))}</span>`;
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
      `Response settings: ${model.label}, ${reasoningLabel(effective.reasoningEffort)} reasoning${effective.fastMode ? ", Fast mode" : ""}`,
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
  const reasoningRows = state.reasoningEfforts
    .map((effort) => {
      const selected = effort === effective.reasoningEffort;
      return `
    <button type="button" role="radio" aria-checked="${selected ? "true" : "false"}" tabindex="${selected ? "0" : "-1"}" data-codex-pick-reasoning="${escapeHtml(effort)}">${escapeHtml(reasoningLabel(effort))}</button>`;
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
    <section aria-labelledby="codex-reasoning-options-label">
      <span class="codex-model-popover-label" id="codex-reasoning-options-label">Reasoning</span>
      <div class="codex-reasoning-choices" role="radiogroup" aria-labelledby="codex-reasoning-options-label">${reasoningRows}</div>
    </section>
    <button class="codex-switch-row codex-popover-fast" type="button" role="switch" aria-checked="${effective.fastMode ? "true" : "false"}" data-codex-pick-fast>
      <span class="codex-switch-icon">${boltIcon({ size: 15 })}</span>
      <span><strong>Fast mode</strong><small>Prioritize lower latency. Direct API keys use premium per-token pricing; OAuth can consume allowance faster.</small></span>
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
  for (const control of element.querySelectorAll("button"))
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
      for (const control of element.querySelectorAll("button"))
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

function removeOfficialApprovalCardForForm(form) {
  const anchor = form?.parentElement;
  const host = anchor?.parentElement;
  if (!host) return;
  for (const card of host.querySelectorAll(
    ":scope > [data-codex-chat-approval]",
  )) {
    if (card.dataset.codexApprovalAgentId === form.dataset.codexAgentId)
      card.remove();
  }
}

function renderOfficialApprovalCard(form, pending) {
  const agentId = String(form?.dataset?.codexAgentId || "");
  const anchor = form?.parentElement;
  const host = anchor?.parentElement;
  if (!agentId || !host || pending?.seatId !== agentId || !pending?.frame) {
    removeOfficialApprovalCardForForm(form);
    return;
  }
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
  card.dataset.framePresented = "false";
  const titleId = `codex-approval-${crypto.randomUUID()}`;
  card.setAttribute("aria-labelledby", titleId);
  const actions = (pending.presentation?.actions || [])
    .slice(0, 4)
    .map((action) => `<li>${escapeHtml(approvalActionLabel(action))}</li>`)
    .join("");
  const expectedSource = `data:image/png;base64,${pending.frame.screenshotBase64}`;
  card.innerHTML = `
    <div class="codex-chat-approval-heading">
      <div><span>Vendor computer</span><strong id="${titleId}">Computer action needs your permission</strong></div>
      <span class="codex-route-badge is-vendor">Shared vendor screen</span>
    </div>
    <p>${escapeHtml(pending.summary || "An employee wants to interact with the shared vendor computer.")}</p>
    ${actions ? `<ul>${actions}</ul>` : ""}
    <figure>
      <img src="${escapeHtml(expectedSource)}" alt="Exact shared vendor screen this action will use" data-codex-chat-approval-frame />
      <figcaption>Allow once unlocks only this exact action on this displayed screen. If the screen or session changes, Codex Bot asks again.</figcaption>
    </figure>
    <div class="codex-chat-approval-actions">
      <button type="button" data-codex-chat-allow disabled>Allow once</button>
      <button type="button" data-codex-chat-deny>Deny</button>
      <span data-codex-chat-approval-status role="status" aria-live="polite">Loading the exact approval screen...</span>
    </div>`;
  const image = card.querySelector("[data-codex-chat-approval-frame]");
  const allow = card.querySelector("[data-codex-chat-allow]");
  const deny = card.querySelector("[data-codex-chat-deny]");
  const status = card.querySelector("[data-codex-chat-approval-status]");
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
  const decide = async (decision) => {
    if (card.dataset.codexApprovalKey !== approvalKey) return;
    const presented = decision === "allow-once";
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
        allow.disabled = card.dataset.framePresented !== "true";
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
  const agentId = String(form?.dataset?.codexAgentId || "");
  if (
    !agentId ||
    officialComputerState(lastStatus).mode !== "official" ||
    officialApprovalLoads.has(form)
  )
    return;
  officialApprovalLoads.add(form);
  try {
    const response = await request(
      `/api/approval?seatKey=${encodeURIComponent(agentId)}`,
    );
    if (
      form.isConnected === false ||
      form.dataset.codexAgentId !== agentId ||
      officialComputerState(lastStatus).mode !== "official"
    )
      return;
    if (response?.pending) renderOfficialApprovalCard(form, response.pending);
    else removeOfficialApprovalCardForForm(form);
  } catch (error) {
    const anchor = form?.parentElement;
    const host = anchor?.parentElement;
    const card = host
      ? [...host.querySelectorAll(":scope > [data-codex-chat-approval]")].find(
          (item) => item.dataset.codexApprovalAgentId === agentId,
        )
      : null;
    const allow = card?.querySelector("[data-codex-chat-allow]");
    const status = card?.querySelector("[data-codex-chat-approval-status]");
    if (allow) allow.disabled = true;
    if (status)
      status.textContent =
        error?.message || "Could not refresh this approval safely.";
  } finally {
    officialApprovalLoads.delete(form);
  }
}

function refreshOfficialApprovalCards() {
  const forms = [...document.querySelectorAll("form[data-codex-agent-id]")];
  for (const card of document.querySelectorAll("[data-codex-chat-approval]")) {
    const stillOwned = forms.some(
      (form) =>
        form.dataset.codexAgentId === card.dataset.codexApprovalAgentId &&
        form.parentElement?.parentElement === card.parentElement,
    );
    if (!stillOwned) card.remove();
  }
  if (officialComputerState(lastStatus).mode !== "official") {
    for (const form of forms) removeOfficialApprovalCardForForm(form);
    return;
  }
  for (const form of forms) void refreshOfficialApprovalForForm(form);
}

function syncOfficialApprovalPolling() {
  if (officialComputerState(lastStatus).mode !== "official") {
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
    const reasoningControl = target.closest?.("[data-codex-pick-reasoning]");
    if (reasoningControl) {
      updateActiveAgentPreference(
        { reasoningEffort: reasoningControl.dataset.codexPickReasoning },
        `[data-codex-pick-reasoning="${CSS.escape(reasoningControl.dataset.codexPickReasoning)}"]`,
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
  .codex-card button { border:1px solid rgba(127,127,127,.35); border-radius:999px; color:inherit; background:rgba(127,127,127,.14); padding:7px 12px; cursor:pointer; }
  .codex-card button:hover { background:rgba(127,127,127,.23); }
  .codex-card button:disabled { opacity:.55; cursor:wait; }
  .codex-card button:focus-visible,.codex-card input:focus-visible,.codex-card select:focus-visible,.codex-notice a:focus-visible { outline:2px solid #9dc6ff; outline-offset:2px; }
  .codex-setting-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  .codex-setting-grid label { display:grid; gap:6px; color:var(--sand-text-tertiary,#aaa); font-size:12px; }
  .codex-setting-grid select { width:100%; min-height:36px; border:1px solid rgba(127,127,127,.35); border-radius:9px; padding:0 10px; color:inherit; background:#1d1d1d; color-scheme:dark; }
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
  .codex-model-pill-reasoning { color:var(--sand-text-tertiary,#999); }
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
  .codex-reasoning-choices { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:4px; padding:3px; border-radius:10px; background:rgba(255,255,255,.055); }
  .codex-reasoning-choices button { min-height:30px; border:0; border-radius:7px; background:transparent; font-size:11px; }
  .codex-reasoning-choices button:hover { background:rgba(255,255,255,.06); }
  .codex-reasoning-choices button[aria-checked="true"] { background:#e8e8e8; color:#111; box-shadow:0 1px 3px rgba(0,0,0,.25); }
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
  html[data-codex-connection-required],html[data-codex-connection-required] body { overflow:hidden !important; }
  [data-codex-onboarding] { position:fixed; inset:0; z-index:2147483647; display:grid; place-items:center; overflow:auto; padding:clamp(20px,5vw,56px); background:rgba(11,11,11,.94); backdrop-filter:blur(12px); color:#f5f5f5; animation:codex-connect-enter 320ms cubic-bezier(.16,1,.3,1) both; }
  .codex-first-run-dialog { width:min(680px,100%); display:grid; gap:22px; }
  .codex-first-run-brand { display:flex; align-items:center; gap:14px; }
  .codex-first-run-brand img { width:52px; height:52px; flex:none; }
  .codex-first-run-brand h1 { margin:0 0 3px; font-size:21px; line-height:1.2; letter-spacing:-.02em; }
  .codex-first-run-brand p { margin:0; color:#b8b8b8; line-height:1.45; }
  [data-codex-onboarding] [data-codex-local] { gap:0; margin:0; }
  .codex-first-run-card { gap:16px; padding:clamp(18px,4vw,26px); background:#171717; border-color:rgba(255,255,255,.16); }
  .codex-first-run-copy { display:grid; gap:7px; }
  .codex-first-run-copy h2 { max-width:24ch; font-size:clamp(22px,4vw,28px); line-height:1.14; letter-spacing:-.025em; text-wrap:balance; }
  .codex-first-run-copy p { max-width:62ch; color:#bdbdbd; line-height:1.55; }
  .codex-first-run-card [data-codex-oauth] { border-color:#f2f2f2; background:#f2f2f2; color:#111; font-weight:650; }
  .codex-first-run-card [data-codex-oauth]:hover { background:#fff; }
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
    .codex-chat-approval-heading { display:grid; }
    .codex-chat-approval-actions button { flex:1; }
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
