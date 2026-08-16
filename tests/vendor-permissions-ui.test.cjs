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

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const approvalHelpers = Function(
  `"use strict";
   ${sourceBetween(
     ui,
     "function officialApprovalKey",
     "function removeOfficialApprovalCardForForm",
   )}
   return { officialApprovalKey, officialApprovalBinding, approvalActionLabel };`,
)();

const vendorComputerPermissionsHtml = Function(
  `"use strict";
   let officialPermissionOperationInFlight = false;
   let officialPermissionNotice = { message: "", tone: "info" };
   ${sourceBetween(ui, "function boltIcon", "function closeIcon")}
   ${sourceBetween(ui, "function escapeHtml", "function initials")}
   ${sourceBetween(
     ui,
     "function officialComputerState",
     "async function completeOfficialEnableAfterCursorLogin",
   )}
   ${sourceBetween(
     ui,
     "function vendorComputerPermissionsHtml",
     "function defaultInferenceHtml",
   )}
   return vendorComputerPermissionsHtml;`,
)();

test("Settings has a dedicated, warned, provider-scoped Permissions section", () => {
  const disabled = vendorComputerPermissionsHtml({
    officialComputer: {
      mode: "private",
      permissions: {
        provider: "official-grok-cloud",
        alwaysAllowComputerActions: false,
      },
    },
  });
  assert.match(disabled, /<h2 id="codex-permissions-title">Permissions<\/h2>/);
  assert.match(disabled, /Always allow computer actions/);
  assert.match(disabled, /broad control of the shared vendor computer/);
  assert.match(disabled, /does not grant access to the Private browser/);
  assert.match(disabled, /session and screen-generation changes/);
  assert.match(disabled, /Windows DPAPI/);
  assert.match(disabled, /data-codex-vendor-permission-ack/);
  assert.match(disabled, /data-codex-vendor-always-allow disabled/);

  const enabled = vendorComputerPermissionsHtml({
    officialComputer: {
      mode: "official",
      connected: true,
      permissions: {
        provider: "official-grok-cloud",
        alwaysAllowComputerActions: true,
      },
    },
  });
  assert.match(enabled, /Always allow is on/);
  assert.match(enabled, /role="switch" aria-checked="true"/);
  assert.match(enabled, /On for this connected official vendor account/);
  assert.match(enabled, /restore Allow once or Deny cards/);
  assert.match(enabled, /Signing out or starting another sign-in turns it off/);
  assert.doesNotMatch(enabled, /data-codex-vendor-permission-ack/);

  const enabledWhileDisconnected = vendorComputerPermissionsHtml({
    officialComputer: {
      mode: "private",
      connected: false,
      permissions: {
        provider: "official-grok-cloud",
        alwaysAllowComputerActions: true,
      },
    },
  });
  assert.match(enabledWhileDisconnected, /role="switch" aria-checked="true"/);
  assert.doesNotMatch(
    enabledWhileDisconnected,
    /data-codex-vendor-always-allow disabled/,
  );
  assert.match(
    enabledWhileDisconnected,
    /It is not active while the vendor computer is disconnected/,
  );
  assert.match(
    enabledWhileDisconnected,
    /Always allow is still stored locally\. Turn it off here or reconnect/,
  );
  assert.doesNotMatch(enabledWhileDisconnected, /signed-in official vendor/);

  const enabledWhileHelperUnavailable = vendorComputerPermissionsHtml({
    officialComputer: {
      mode: "unknown",
      connected: false,
      permissions: {
        provider: "official-grok-cloud",
        alwaysAllowComputerActions: true,
      },
    },
  });
  assert.match(
    enabledWhileHelperUnavailable,
    /Always allow remains stored and cannot be changed until the helper returns/,
  );
  assert.doesNotMatch(enabledWhileHelperUnavailable, /locked off/);
});

test("inline chat approval bindings include only the exact displayed frame identity", () => {
  const pending = {
    requestId: "request-1",
    seatId: "employee-1",
    origin: "https://official-cloud-computer.invalid",
    actionDigest: "digest-1",
    frame: {
      generation: 4,
      sequence: 9,
      sha256: "a".repeat(64),
      screenshotBase64: "secret-frame-bytes",
    },
  };
  assert.deepEqual(approvalHelpers.officialApprovalBinding(pending, false), {
    requestId: "request-1",
    seatId: "employee-1",
    origin: "https://official-cloud-computer.invalid",
    actionDigest: "digest-1",
  });
  const presented = approvalHelpers.officialApprovalBinding(pending, true);
  assert.deepEqual(presented.presentedFrame, {
    generation: 4,
    sequence: 9,
    sha256: "a".repeat(64),
  });
  assert.equal(JSON.stringify(presented).includes("secret-frame-bytes"), false);
  assert.notEqual(
    approvalHelpers.officialApprovalKey(pending),
    approvalHelpers.officialApprovalKey({
      ...pending,
      frame: { ...pending.frame, sequence: 10 },
    }),
  );
});

test("private and vendor approval cards share one chat-adjacent decision surface", () => {
  const renderer = sourceBetween(
    ui,
    "function renderOfficialApprovalCard",
    "async function refreshOfficialApprovalForForm",
  );
  assert.match(renderer, /host\.insertBefore\(card, anchor\)/);
  assert.match(renderer, /Computer action needs your permission/);
  assert.match(
    renderer,
    /data-codex-chat-allow \$\{requiresExactFrame \? "disabled" : ""\}/,
  );
  assert.match(renderer, /data-codex-chat-deny>Deny/);
  assert.match(renderer, /image\.addEventListener\("load"/);
  assert.match(renderer, /image\.getAttribute\("src"\) !== expectedSource/);
  assert.match(renderer, /card\.dataset\.framePresented = "true"/);
  assert.match(renderer, /Private browser/);
  assert.match(renderer, /This employee\\'s browser/);
  assert.match(renderer, /Browser access is on\. Review this one action/);
  assert.match(renderer, /requiresExactFrame && card\.dataset\.framePresented/);
  assert.match(
    renderer,
    /binding: officialApprovalBinding\(pending, presented\)/,
  );
  assert.match(renderer, /decision === "allow-once"/);
  assert.doesNotMatch(renderer, /always-allow|allow-site|allow-all/);
  assert.doesNotMatch(
    ui,
    /\[aria-label[^\n]*Browser action approval[^\n]*\]\s*\{[^}]*display\s*:\s*none/i,
  );
});

function createApprovalFailureHarness({
  presentFrame,
  privateApproval = false,
}) {
  const listeners = new Map();
  const image = {
    source: "",
    addEventListener(type, listener) {
      listeners.set(`image:${type}`, listener);
    },
    getAttribute(name) {
      return name === "src" ? this.source : null;
    },
    set src(value) {
      this.source = value;
    },
  };
  const allow = {
    disabled: true,
    addEventListener(type, listener) {
      listeners.set(`allow:${type}`, listener);
    },
  };
  const deny = {
    disabled: false,
    addEventListener(type, listener) {
      listeners.set(`deny:${type}`, listener);
    },
  };
  const status = { textContent: "" };
  let card;
  const host = {
    cards: [],
    querySelectorAll() {
      return this.cards;
    },
    insertBefore(item) {
      this.cards.push(item);
    },
  };
  const anchor = { parentElement: host };
  const form = {
    dataset: { codexAgentId: "employee-1" },
    parentElement: anchor,
  };
  const pending = {
    requestId: "request-1",
    seatId: "employee-1",
    actionDigest: "digest-1",
    ...(privateApproval
      ? {}
      : {
          frame: {
            generation: 1,
            sequence: 2,
            sha256: "a".repeat(64),
            screenshotBase64: "frame-bytes",
          },
        }),
  };
  const requestCalls = [];
  let refreshCount = 0;
  let render;
  const refreshOfficialApprovalForForm = async () => {
    refreshCount += 1;
    render(form, pending);
  };
  render = Function(
    "document",
    "crypto",
    "request",
    "refreshOfficialApprovalForForm",
    "officialApprovalKey",
    "officialApprovalBinding",
    "approvalActionLabel",
    "escapeHtml",
    "removeOfficialApprovalCardForForm",
    `"use strict";
     ${sourceBetween(
       ui,
       "function renderOfficialApprovalCard",
       "async function refreshOfficialApprovalForForm",
     )}
     return renderOfficialApprovalCard;`,
  )(
    {
      createElement() {
        card = {
          dataset: {},
          className: "",
          removed: false,
          setAttribute() {},
          set innerHTML(value) {
            this.html = value;
            allow.disabled = !privateApproval;
          },
          querySelector(selector) {
            return {
              "[data-codex-chat-approval-frame]": privateApproval
                ? null
                : image,
              "[data-codex-chat-allow]": allow,
              "[data-codex-chat-deny]": deny,
              "[data-codex-chat-approval-status]": status,
            }[selector];
          },
          remove() {
            this.removed = true;
            host.cards = host.cards.filter((item) => item !== this);
          },
        };
        return card;
      },
    },
    { randomUUID: () => "approval-title" },
    async (requestPath, body) => {
      requestCalls.push({ requestPath, body });
      throw new Error("The approval service is temporarily unavailable.");
    },
    refreshOfficialApprovalForForm,
    (value) =>
      value.frame
        ? `${value.requestId}:${value.frame.generation}:${value.frame.sequence}:${value.frame.sha256}`
        : value.requestId,
    (_value, presented) => ({ presented }),
    ({ kind }) => kind,
    (value) => String(value),
    () => {},
  );

  render(form, pending);
  if (presentFrame && !privateApproval) listeners.get("image:load")();
  return {
    allow,
    deny,
    status,
    requestCalls,
    get refreshCount() {
      return refreshCount;
    },
    click(button) {
      listeners.get(`${button}:click`)();
    },
  };
}

test("a transient approval send failure restores only actions safe for the still-presented exact frame", async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const presented = createApprovalFailureHarness({ presentFrame: true });
  assert.equal(presented.allow.disabled, false);
  presented.click("allow");
  assert.equal(presented.allow.disabled, true);
  assert.equal(presented.deny.disabled, true);
  await flush();
  assert.equal(presented.refreshCount, 1);
  assert.equal(presented.allow.disabled, false);
  assert.equal(presented.deny.disabled, false);
  assert.match(presented.status.textContent, /temporarily unavailable/);
  assert.deepEqual(presented.requestCalls[0], {
    requestPath: "/api/approval",
    body: {
      seatKey: "employee-1",
      decision: "allow-once",
      binding: { presented: true },
    },
  });

  const notPresented = createApprovalFailureHarness({ presentFrame: false });
  notPresented.click("deny");
  assert.equal(notPresented.allow.disabled, true);
  assert.equal(notPresented.deny.disabled, true);
  await flush();
  assert.equal(notPresented.refreshCount, 1);
  assert.equal(notPresented.allow.disabled, true);
  assert.equal(notPresented.deny.disabled, false);
  assert.match(notPresented.status.textContent, /temporarily unavailable/);

  const privateApproval = createApprovalFailureHarness({
    presentFrame: false,
    privateApproval: true,
  });
  assert.equal(privateApproval.allow.disabled, false);
  privateApproval.click("allow");
  await flush();
  assert.deepEqual(privateApproval.requestCalls[0], {
    requestPath: "/api/approval",
    body: {
      seatKey: "employee-1",
      decision: "allow-once",
      binding: { presented: false },
    },
  });
  assert.equal(privateApproval.allow.disabled, false);
});

test("renderer polls one approval list in both computer modes and saves an exact vendor policy", () => {
  const polling = sourceBetween(
    ui,
    "async function refreshOfficialApprovalForForm",
    "function applyUi",
  );
  assert.match(polling, /!\["private", "official"\]\.includes\(mode\)/);
  assert.match(polling, /request\("\/api\/approvals"\)/);
  assert.match(polling, /for \(const approval of pending\)/);
  assert.match(polling, /renderOfficialApprovalCard\(form, approval\)/);
  assert.match(polling, /form\.getClientRects\(\)\.length > 0/);
  assert.match(polling, /setInterval\([\s\S]*?1_000/);
  assert.match(polling, /if \(!stillOwned\) card\.remove\(\)/);

  const wiring = sourceBetween(
    ui,
    "function wireConnectionPanel",
    "function installConnectionPanel",
  );
  assert.match(wiring, /action: "permissions"/);
  assert.match(wiring, /provider: "official-grok-cloud"/);
  assert.match(wiring, /alwaysAllowComputerActions: next/);
  assert.match(wiring, /acknowledged: next/);
});
