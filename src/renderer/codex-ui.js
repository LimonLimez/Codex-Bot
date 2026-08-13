const CODEX_SERVICE = "http://127.0.0.1:__CODEX_VIEW_PORT__";
const CODEX_TOKEN = "__CODEX_VIEW_TOKEN__";
const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";
globalThis.__CODEX_BOT_VIEW_TOKEN__ = CODEX_TOKEN;
const headers = { "X-Codex-Seat-Token": CODEX_TOKEN };
let lastStatus = null;
let refreshTimer = null;
let connectionPollTimer = null;
let pendingOAuthDevice = null;

function hasCodexConnection(status) {
  return Boolean(status?.account?.signedIn || status?.connection?.mode === "api-key");
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function verifyCodexViewServer() {
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const response = await fetch(`${CODEX_SERVICE}/api/identity?nonce=${encodeURIComponent(nonce)}`, {
    cache: "no-store",
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || typeof value.proof !== "string") throw new Error("Local browser service identity check failed");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CODEX_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`codex-bot-view:${nonce}`));
  const expected = base64Url(new Uint8Array(signature));
  if (value.proof.length !== expected.length) throw new Error("Local browser service identity check failed");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= value.proof.charCodeAt(index) ^ expected.charCodeAt(index);
  if (mismatch !== 0) throw new Error("Local browser service identity check failed");
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
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function availabilityHtml(availability, activeOAuth) {
  if (!activeOAuth || !availability || availability.state === "ready") return "";
  const reset = availability.resetsAt ? ` It resets ${formatDate(availability.resetsAt)}.` : "";
  const label = availability.state === "usage-limit"
    ? "Codex OAuth usage limit reached."
    : availability.state === "model-cooldown"
      ? "This Codex model is temporarily cooling down."
      : "The last Codex request failed.";
  return `<div class="codex-availability" role="status"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(availability.message || "")}${escapeHtml(reset)}</span><span>Use an OpenAI API key below to keep working now.</span></div>`;
}

async function request(path, body) {
  await verifyCodexViewServer();
  const response = await fetch(`${CODEX_SERVICE}${path}`, {
    method: body ? "POST" : "GET",
    cache: "no-store",
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Codex service returned ${response.status}`);
  return value;
}
globalThis.__CODEX_BOT_VIEW_REQUEST__ = request;

async function loadStatus() {
  try {
    lastStatus = await request("/api/codex/status");
    if (hasCodexConnection(lastStatus)) {
      pendingOAuthDevice = null;
      clearInterval(connectionPollTimer);
      connectionPollTimer = null;
    }
    applyUi();
    return lastStatus;
  } catch (error) {
    const notice = document.querySelector("[data-codex-notice]");
    if (notice) {
      notice.textContent = `Local Codex service unavailable: ${error.message}`;
      notice.dataset.tone = "error";
    }
    return null;
  }
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
    if (node.parentElement?.closest("script,style,[data-codex-local]")) continue;
    let next = node.nodeValue;
    for (const [pattern, replacement] of replacements) next = next.replace(pattern, replacement);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  document.title = "Codex Bot";
}

function hideUnavailableSurfaces() {
  for (const element of document.querySelectorAll("button, [role='menuitem'], .sand-agents-sidebar__plugins-entry")) {
    const text = element.textContent?.trim();
    if (text === "Plugins" || text === "Usage & Billing" || text === "Updates") {
      element.style.display = "none";
      element.dataset.codexUnavailable = "true";
    }
  }
  for (const element of document.querySelectorAll("button, [role='menuitem']")) {
    const text = element.textContent?.trim() || "";
    if (/Get Codex Bot for iOS|New update available|A new version of the app is available|Weekly usage/i.test(text) || /Downloading update/i.test(element.getAttribute("aria-label") || "")) {
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
    const row = parent?.closest("button, [role='menuitem'], [role='option'], [data-radix-collection-item]") || parent;
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
  for (const name of document.querySelectorAll(".sand-agents-sidebar__account-name")) {
    if (name.tagName !== "INPUT") name.textContent = account.name;
  }
  const footer = document.querySelector(".sand-agents-sidebar__account");
  if (!footer) return;
  footer.title = `${account.name}${account.email ? ` · ${account.email}` : ""} · ${status.connection.route}`;
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
  const plan = account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "Unknown plan";
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
  const connectionDetail = apiKeyActive && !account.signedIn ? "Direct OpenAI API" : plan;
  const avatar = account.avatarUrl
    ? `<img class="codex-avatar" src="${escapeHtml(account.avatarUrl)}" alt="" />`
    : `<span class="codex-avatar codex-initials">${escapeHtml(initials(account.name))}</span>`;
  const activeOAuth = connection.mode === "codex-oauth";
  const oauthLabel = activeOAuth && account.signedIn
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
          <span>${escapeHtml(connectionDetail)} · ${escapeHtml(connection.route)}</span>
        </div>
      </div>
      ${currentAvailability}
      <div class="codex-actions">
        <button type="button" data-codex-oauth>${oauthLabel}</button>
        <button type="button" data-codex-key-toggle>Use OpenAI API key</button>
      </div>
      <form class="codex-key-form" data-codex-key-form hidden>
        <label for="codex-api-key">OpenAI API key</label>
        <div><input id="codex-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" required /><button type="submit">Verify & use</button></div>
        <small>The key is verified with OpenAI and stored with Windows user-level encryption. It is never written to logs.</small>
      </form>
      ${firstRunAssurance}
      <p class="codex-notice" data-codex-notice aria-live="polite"></p>
    </section>
    ${firstRun ? "" : `
    <section class="codex-card" aria-label="Codex Bot usage">
      <h3>Actual Codex Bot usage</h3>
      <div class="codex-metrics">
        <div><strong>${formatNumber(usage.requests)}</strong><span>requests</span></div>
        <div><strong>${formatNumber(usage.totalTokens)}</strong><span>total tokens</span></div>
        <div><strong>${formatNumber(usage.promptTokens)}</strong><span>input tokens</span></div>
        <div><strong>${formatNumber(usage.completionTokens)}</strong><span>output tokens</span></div>
        <div><strong>${formatNumber(usage.toolCalls)}</strong><span>tool calls</span></div>
      </div>
      <p>${escapeHtml(connection.model)} · reasoning ${escapeHtml(connection.reasoningEffort)} · last completion ${escapeHtml(formatDate(usage.lastCompletedAt))}</p>
      <small>These are measured bridge totals, not a made-up plan quota. OpenAI does not expose your Codex subscription's remaining allowance through this OAuth route.</small>
    </section>
    <section class="codex-card" aria-label="Local Codex Bot settings">
      <h3>Working local settings</h3>
      <dl>
        <div><dt>Vendor automatic updates</dt><dd>Off</dd></div>
        <div><dt>Private browser seats</dt><dd>${formatNumber(status.settings?.maxBrowserSeats || 3)} maximum</dd></div>
        <div><dt>Verified plugins</dt><dd>${status.verifiedPlugins?.length ? status.verifiedPlugins.map((item) => escapeHtml(item.name || item)).join(", ") : "None connected"}</dd></div>
      </dl>
      <small>Unavailable marketplace entries are hidden. Browser work remains available without pretending a Dropbox, Canva, or other connector is installed.</small>
    </section>`}`;
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

function wireConnectionPanel(panel) {
  renderOAuthDevicePrompt(panel.querySelector("[data-codex-notice]"));
  panel.querySelector("[data-codex-key-toggle]")?.addEventListener("click", () => {
    const form = panel.querySelector("[data-codex-key-form]");
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector("input")?.focus();
  });
  panel.querySelector("[data-codex-oauth]")?.addEventListener("click", async (event) => {
    const notice = panel.querySelector("[data-codex-notice]");
    event.currentTarget.disabled = true;
    const canReuseOAuth = Boolean(lastStatus?.account?.signedIn && lastStatus?.connection?.mode !== "codex-oauth");
    notice.textContent = canReuseOAuth ? "Switching to Codex OAuth…" : "Preparing the official OpenAI sign-in…";
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
  panel.querySelector("[data-codex-key-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input");
    const submit = event.currentTarget.querySelector("button[type='submit']");
    const notice = panel.querySelector("[data-codex-notice]");
    submit.disabled = true;
    notice.textContent = "Verifying directly with OpenAI…";
    notice.dataset.tone = "info";
    try {
      const result = await request("/api/codex/auth", { action: "api-key", apiKey: input.value });
      input.value = "";
      pendingOAuthDevice = null;
      if (result.status) {
        lastStatus = result.status;
        applyUi();
      } else {
        notice.textContent = "OpenAI API key verified. New requests will use it.";
        await loadStatus();
      }
    } catch (error) {
      notice.textContent = error.message;
      notice.dataset.tone = "error";
    } finally {
      submit.disabled = false;
    }
  });
}

function installConnectionPanel(status) {
  for (const settings of document.querySelectorAll(".sand-settings-general")) {
    let panel = settings.querySelector(":scope > [data-codex-local]");
    const accountCard = settings.querySelector(".sand-account-card");
    if (accountCard) {
      const stockSection = [...settings.children].find((child) => child.contains(accountCard));
      if (stockSection) stockSection.style.display = "none";
    }
    if (!panel) {
      panel = document.createElement("div");
      panel.dataset.codexLocal = "true";
      settings.prepend(panel);
    }
    const signature = JSON.stringify(status);
    if (panel.dataset.signature !== signature) {
      panel.dataset.signature = signature;
      panel.innerHTML = connectionPanelHtml(status);
      wireConnectionPanel(panel);
    }
  }
}

function setWorkspaceConnectionGate(blocked, onboarding) {
  document.documentElement.toggleAttribute("data-codex-connection-required", blocked);
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
      if (child.dataset.codexGateAria === "__missing__") child.removeAttribute("aria-hidden");
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
            <h2 id="codex-connect-title">Checking your Codex connection…</h2>
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

function applyUi() {
  replaceVisibleBranding();
  hideUnavailableSurfaces();
  installCodexOnboarding(lastStatus);
  if (lastStatus) {
    updateSidebarIdentity(lastStatus);
    installConnectionPanel(lastStatus);
  }
}

document.addEventListener("click", (event) => {
  if (document.documentElement.hasAttribute("data-codex-connection-required") && !event.target.closest?.("[data-codex-onboarding]")) {
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
  const settings = [...document.querySelectorAll("button,[role='menuitem']")].find((item) => item.textContent?.trim() === "Settings");
  settings?.click();
}, true);

for (const eventName of ["beforeinput", "keydown", "submit"]) {
  document.addEventListener(eventName, (event) => {
    if (!document.documentElement.hasAttribute("data-codex-connection-required")) return;
    if (event.target.closest?.("[data-codex-onboarding]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

const style = document.createElement("style");
style.textContent = `
  [data-codex-local] { display:grid; gap:16px; margin-bottom:16px; color:var(--sand-text-primary,#eee); }
  .codex-card { border:1px solid rgba(127,127,127,.28); background:rgba(127,127,127,.06); border-radius:12px; padding:16px; display:grid; gap:12px; }
  .codex-card h2,.codex-card h3,.codex-card p { margin:0; }
  .codex-card small,.codex-account-copy span { color:var(--sand-text-tertiary,#aaa); line-height:1.45; }
  .codex-account-row { display:flex; align-items:center; gap:12px; }
  .codex-avatar { width:42px; height:42px; border-radius:50%; object-fit:cover; flex:none; }
  .codex-initials { display:grid; place-items:center; background:#202020; border:1px solid rgba(255,255,255,.16); font-weight:650; }
  .codex-account-copy { display:grid; gap:2px; min-width:0; }
  .codex-actions,.codex-key-form>div { display:flex; flex-wrap:wrap; gap:8px; }
  .codex-card button { border:1px solid rgba(127,127,127,.35); border-radius:999px; color:inherit; background:rgba(127,127,127,.14); padding:7px 12px; cursor:pointer; }
  .codex-card button:hover { background:rgba(127,127,127,.23); }
  .codex-card button:disabled { opacity:.55; cursor:wait; }
  .codex-card button:focus-visible,.codex-card input:focus-visible,.codex-notice a:focus-visible { outline:2px solid #9dc6ff; outline-offset:2px; }
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
  @media (max-width:560px) {
    [data-codex-onboarding] { place-items:start center; }
    .codex-first-run-brand { align-items:flex-start; }
    .codex-first-run-card .codex-actions,.codex-first-run-card .codex-key-form>div { display:grid; }
    .codex-first-run-card button,.codex-first-run-card input { width:100%; min-width:0; }
  }
  @media (prefers-reduced-motion:reduce) { [data-codex-onboarding] { animation:none; } }
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
