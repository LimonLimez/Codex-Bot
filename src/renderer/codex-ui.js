const CODEX_SERVICE = "http://127.0.0.1:__CODEX_VIEW_PORT__";
const CODEX_TOKEN = "__CODEX_VIEW_TOKEN__";
globalThis.__CODEX_BOT_VIEW_TOKEN__ = CODEX_TOKEN;
const headers = { "X-Codex-Seat-Token": CODEX_TOKEN };
let lastStatus = null;
let refreshTimer = null;

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
    applyUi();
  } catch (error) {
    const notice = document.querySelector("[data-codex-notice]");
    if (notice) {
      notice.textContent = `Local Codex service unavailable: ${error.message}`;
      notice.dataset.tone = "error";
    }
  }
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

function connectionPanelHtml(status) {
  const account = status.account || {};
  const connection = status.connection || {};
  const usage = status.usage || {};
  const plan = account.plan ? account.plan[0].toUpperCase() + account.plan.slice(1) : "Unknown plan";
  const avatar = account.avatarUrl
    ? `<img class="codex-avatar" src="${escapeHtml(account.avatarUrl)}" alt="" />`
    : `<span class="codex-avatar codex-initials">${escapeHtml(initials(account.name))}</span>`;
  const activeOAuth = connection.mode === "codex-oauth";
  const currentAvailability = availabilityHtml(usage.availability, activeOAuth);
  return `
    <section class="codex-card" aria-label="Codex account">
      <div class="codex-account-row">
        ${avatar}
        <div class="codex-account-copy">
          <strong>${escapeHtml(account.signedIn ? account.name : "Not signed in")}</strong>
          <span>${escapeHtml(account.email || "Connect a Codex account or OpenAI API key")}</span>
          <span>${escapeHtml(plan)} · ${escapeHtml(connection.route)}</span>
        </div>
      </div>
      ${currentAvailability}
      <div class="codex-actions">
        <button type="button" data-codex-oauth>${activeOAuth ? "Refresh Codex sign-in" : "Use Codex OAuth"}</button>
        <button type="button" data-codex-key-toggle>Use OpenAI API key</button>
      </div>
      <form class="codex-key-form" data-codex-key-form hidden>
        <label for="codex-api-key">OpenAI API key</label>
        <div><input id="codex-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" required /><button type="submit">Verify & use</button></div>
        <small>The key is verified with OpenAI and stored with Windows user-level encryption. It is never written to logs.</small>
      </form>
      <p class="codex-notice" data-codex-notice aria-live="polite"></p>
    </section>
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
    </section>`;
}

function wireConnectionPanel(panel) {
  panel.querySelector("[data-codex-key-toggle]")?.addEventListener("click", () => {
    const form = panel.querySelector("[data-codex-key-form]");
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector("input")?.focus();
  });
  panel.querySelector("[data-codex-oauth]")?.addEventListener("click", async (event) => {
    const notice = panel.querySelector("[data-codex-notice]");
    event.currentTarget.disabled = true;
    notice.textContent = lastStatus?.connection?.mode === "codex-oauth" ? "Opening Codex sign-in…" : "Switching to Codex OAuth…";
    notice.dataset.tone = "info";
    try {
      const action = lastStatus?.connection?.mode === "codex-oauth" ? "oauth" : "use-oauth";
      const result = await request("/api/codex/auth", { action });
      if (result.url && result.code) {
        notice.replaceChildren();
        const message = document.createElement("span");
        message.textContent = `${result.message || "Complete Codex sign-in."} `;
        const link = document.createElement("a");
        link.href = result.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "Open OpenAI sign-in";
        const code = document.createElement("strong");
        code.textContent = ` Code: ${result.code}`;
        notice.append(message, link, code);
      } else {
        notice.textContent = result.message || "Codex OAuth selected.";
      }
      setTimeout(loadStatus, 1200);
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
      await request("/api/codex/auth", { action: "api-key", apiKey: input.value });
      input.value = "";
      notice.textContent = "OpenAI API key verified. New requests will use it.";
      setTimeout(loadStatus, 500);
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

function installCodexOnboarding(status) {
  const stock = document.querySelector(".sand-onboarding");
  if (!stock) return;
  let onboarding = document.querySelector("[data-codex-onboarding]");
  if (!onboarding) {
    stock.style.display = "none";
    onboarding = document.createElement("main");
    onboarding.dataset.codexOnboarding = "true";
    onboarding.innerHTML = `
      <img src="./assets/app-icon-C7NKj2u7.png" alt="" />
      <h1>Codex Bot</h1>
      <p>Your team of always-on digital coworkers, powered by your Codex OAuth account or OpenAI API key.</p>
      <div data-codex-local></div>`;
    stock.insertAdjacentElement("afterend", onboarding);
  }
  const panel = onboarding.querySelector("[data-codex-local]");
  const signature = JSON.stringify(status);
  if (panel.dataset.signature !== signature) {
    panel.dataset.signature = signature;
    panel.innerHTML = connectionPanelHtml(status);
    wireConnectionPanel(panel);
  }
}

function applyUi() {
  replaceVisibleBranding();
  hideUnavailableSurfaces();
  if (lastStatus) {
    updateSidebarIdentity(lastStatus);
    installConnectionPanel(lastStatus);
  }
}

document.addEventListener("click", (event) => {
  setTimeout(applyUi, 0);
  setTimeout(applyUi, 120);
  const control = event.target.closest?.("[data-codex-manage-connection]");
  if (!control) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const settings = [...document.querySelectorAll("button,[role='menuitem']")].find((item) => item.textContent?.trim() === "Settings");
  settings?.click();
}, true);

const style = document.createElement("style");
style.textContent = `
  [data-codex-local] { display:grid; gap:16px; margin-bottom:16px; color:var(--sand-text-primary,#eee); }
  .codex-card { border:1px solid rgba(127,127,127,.28); background:rgba(127,127,127,.06); border-radius:12px; padding:16px; display:grid; gap:12px; }
  .codex-card h3,.codex-card p { margin:0; }
  .codex-card small,.codex-account-copy span { color:var(--sand-text-tertiary,#aaa); line-height:1.45; }
  .codex-account-row { display:flex; align-items:center; gap:12px; }
  .codex-avatar { width:42px; height:42px; border-radius:50%; object-fit:cover; flex:none; }
  .codex-initials { display:grid; place-items:center; background:#202020; border:1px solid rgba(255,255,255,.16); font-weight:650; }
  .codex-account-copy { display:grid; gap:2px; min-width:0; }
  .codex-actions,.codex-key-form>div { display:flex; flex-wrap:wrap; gap:8px; }
  .codex-card button { border:1px solid rgba(127,127,127,.35); border-radius:999px; color:inherit; background:rgba(127,127,127,.14); padding:7px 12px; cursor:pointer; }
  .codex-card button:hover { background:rgba(127,127,127,.23); }
  .codex-card button:disabled { opacity:.55; cursor:wait; }
  .codex-key-form { display:grid; gap:7px; }
  .codex-key-form[hidden] { display:none; }
  .codex-key-form input { min-width:220px; flex:1; border:1px solid rgba(127,127,127,.35); border-radius:8px; color:inherit; background:rgba(0,0,0,.18); padding:8px 10px; }
  .codex-notice { min-height:1.4em; color:#9dc6ff; }
  .codex-notice[data-tone="error"] { color:#ff8e8e; }
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
  [data-codex-onboarding] { min-height:100vh; display:grid; align-content:center; justify-items:center; gap:14px; padding:32px; background:#0b0b0b; color:#f5f5f5; }
  [data-codex-onboarding]>img { width:72px; height:72px; }
  [data-codex-onboarding]>h1,[data-codex-onboarding]>p { margin:0; text-align:center; }
  [data-codex-onboarding]>p { color:#aaa; max-width:620px; line-height:1.5; }
  [data-codex-onboarding]>[data-codex-local] { width:min(720px,92vw); }
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
