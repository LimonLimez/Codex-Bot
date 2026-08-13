"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  ApprovalBindingError,
  BrowserActionApprovalCoordinator,
  classifyBrowserAction,
  classifyBrowserActionBatch,
  normalizeOrigin,
} = require(
  path.resolve(
    __dirname,
    "..",
    "src",
    "browser-seats",
    "browser-action-approval.cjs",
  ),
);

function harness({ pendingTtlMs = 1_000 } = {}) {
  let currentTime = 1_700_000_000_000;
  let nextTimer = 1;
  const timers = new Map();
  const coordinator = new BrowserActionApprovalCoordinator({
    now: () => currentTime,
    pendingTtlMs,
    setTimer: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, due: currentTime + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    coordinator,
    approver: coordinator.createTrustedUserApprover(),
    now: () => currentTime,
    advance(ms) {
      currentTime += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= currentTime) {
          timers.delete(id);
          timer.callback();
        }
      }
      coordinator.expirePending();
    },
  };
}

const ordinaryFieldEdit = (text = "draft") => ({
  kind: "type",
  text,
  target: { tagName: "input", inputType: "text", role: "textbox" },
});
const highPublish = () => ({
  kind: "click",
  coordinate: { x: 50, y: 80 },
  target: { tagName: "button", accessibleName: "Publish" },
});

test("normalizes approval binding to an HTTP(S) origin without path, query, or credentials", () => {
  const credentialed = new URL(
    "https://example.com:443/path?token=secret#part",
  );
  credentialed.username = "User";
  credentialed.password = "Secret";
  assert.equal(normalizeOrigin(credentialed.href), "https://example.com");
  assert.equal(
    normalizeOrigin("http://example.com:8080/a"),
    "http://example.com:8080",
  );
  assert.throws(
    () => normalizeOrigin("file:///C:/secret.txt"),
    /HTTP\(S\) origin/,
  );
});

test("deterministic classification keeps only observation, view, and focus actions automatic", () => {
  for (const action of [
    { kind: "screenshot" },
    { kind: "scroll", amount: 3 },
    { kind: "mouseMove", coordinate: { x: 10, y: 10 } },
    { kind: "wait", durationMs: 50 },
    { kind: "key", key: "CTRL+L" },
    { kind: "key", key: "TAB" },
    { kind: "key", key: "SHIFT+TAB" },
    { kind: "key", key: "ESCAPE" },
  ]) {
    assert.equal(
      classifyBrowserAction(action).riskClass,
      "automatic",
      action.kind,
    );
  }
  for (const action of [
    { kind: "navigate", url: "https://example.com/" },
    { kind: "type", text: "https://example.com/", surface: "address" },
    { kind: "key", key: "ENTER", surface: "address" },
    {
      kind: "click",
      target: { tagName: "a", href: "https://example.com/page" },
    },
  ]) {
    assert.equal(classifyBrowserAction(action).riskClass, "high");
  }
});

test("password, OTP, payment, submission, button, form, and consequential controls are high risk", () => {
  const actions = [
    {
      kind: "type",
      text: "secret",
      target: { tagName: "input", type: "password" },
    },
    {
      kind: "type",
      text: "123456",
      target: { tagName: "input", autocomplete: "one-time-code" },
    },
    {
      kind: "type",
      text: "4111111111111111",
      target: { tagName: "input", autocomplete: "cc-number" },
    },
    {
      kind: "type",
      text: "4111111111111111",
      target: { tagName: "input", name: "cardNumber" },
    },
    {
      kind: "type",
      text: "123456",
      target: { tagName: "input", ariaLabel: "oneTimeCode" },
    },
    {
      kind: "click",
      target: { tagName: "button", accessibleName: "Continue" },
    },
    { kind: "click", target: { tagName: "form" } },
    {
      kind: "click",
      target: {
        tagName: "a",
        href: "https://example.com/delete",
        accessibleName: "Delete item",
      },
    },
    { kind: "submit" },
  ];
  for (const action of actions)
    assert.equal(classifyBrowserAction(action).riskClass, "high");
});

test("ordinary typing, every click or drag, submit, and mutating keys require approval", () => {
  assert.deepEqual(classifyBrowserAction(ordinaryFieldEdit()), {
    riskClass: "high",
    actionClass: "field-edit",
    summary: "Edit a page field",
    reason: "typing changes page or address state",
  });
  for (const action of [
    {
      kind: "click",
      target: { tagName: "input", type: "checkbox" },
    },
    { kind: "click", coordinate: { x: 1, y: 1 } },
    {
      kind: "drag",
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
    },
    { kind: "submit" },
    { kind: "key", key: "ENTER" },
    { kind: "key", key: "SPACE" },
    { kind: "key", key: "CTRL+V" },
    { kind: "key", key: "ARROWDOWN" },
    { kind: "key", key: "BACKSPACE", surface: "address" },
  ]) {
    assert.equal(classifyBrowserAction(action).riskClass, "high");
  }
});

test("pending approval is bound to seat, normalized origin, and exact action digest", async () => {
  const { coordinator, approver } = harness();
  const decisionPromise = coordinator.requestAgentAction(
    {
      seatId: "seat-a",
      origin: "https://EXAMPLE.com:443/draft?private=yes",
      actions: [highPublish()],
    },
    {
      actions: [{ target: { tagName: "button", accessibleName: "Publish" } }],
    },
  );
  const status = coordinator.getPendingStatus("seat-a");
  assert.equal(status.origin, "https://example.com");

  assert.throws(
    () => approver.allowOnce({ ...status, seatId: "seat-b" }),
    ApprovalBindingError,
  );
  assert.throws(
    () =>
      approver.allowOnce({ ...status, origin: "https://attacker.example/" }),
    ApprovalBindingError,
  );
  assert.throws(
    () => approver.allowOnce({ ...status, actionDigest: "0".repeat(64) }),
    ApprovalBindingError,
  );
  assert.equal(
    coordinator.getPendingStatus("seat-a").requestId,
    status.requestId,
  );

  assert.equal(
    approver.allowOnce({
      ...status,
      origin: "https://example.com/another/path",
    }),
    true,
  );
  assert.deepEqual(await decisionPromise, {
    allowed: true,
    decision: "allow-once",
    source: "trusted-user",
    requestId: status.requestId,
    seatId: "seat-a",
    origin: "https://example.com",
    actionDigest: status.actionDigest,
    riskClass: "high",
    summary: "Activate a high-impact page control",
  });
});

test("safe observation completes automatically without creating a pending approval", async () => {
  const { coordinator } = harness();
  const decision = await coordinator.requestAgentAction({
    seatId: "seat-observe",
    origin: "https://example.com/",
    actions: [{ kind: "screenshot" }, { kind: "scroll", amount: 2 }],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.decision, "automatic");
  assert.equal(decision.source, "policy");
  assert.equal(coordinator.getPendingStatus("seat-observe"), null);
});

test("approval expires, resolves denial, and cannot be granted afterward", async () => {
  const { coordinator, approver, advance } = harness({ pendingTtlMs: 500 });
  const decisionPromise = coordinator.requestAgentAction({
    seatId: "seat-expiry",
    origin: "https://example.com/",
    actions: [highPublish()],
  });
  const status = coordinator.getPendingStatus("seat-expiry");
  advance(501);
  const decision = await decisionPromise;
  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "expired");
  assert.equal(coordinator.getPendingStatus("seat-expiry"), null);
  assert.equal(approver.allowOnce(status), false);
});

test("allow-once is consumed exactly once and replay is denied", async () => {
  const { coordinator, approver } = harness();
  const decisionPromise = coordinator.requestAgentAction({
    seatId: "seat-replay",
    origin: "https://example.com/",
    actions: [highPublish()],
  });
  const status = coordinator.getPendingStatus("seat-replay");
  assert.equal(approver.allowOnce(status), true);
  assert.equal(approver.allowOnce(status), false);
  assert.equal((await decisionPromise).allowed, true);

  const nextPromise = coordinator.requestAgentAction({
    seatId: "seat-replay",
    origin: "https://example.com/",
    actions: [highPublish()],
  });
  const nextStatus = coordinator.getPendingStatus("seat-replay");
  assert.notEqual(nextStatus.requestId, status.requestId);
  assert.throws(() => approver.allowOnce(status), ApprovalBindingError);
  approver.deny(nextStatus);
  assert.equal((await nextPromise).allowed, false);
});

test("a duplicate concurrent request cannot share one allow-once decision", async () => {
  const { coordinator, approver } = harness();
  const request = {
    seatId: "seat-concurrent",
    origin: "https://example.com/",
    actions: [highPublish()],
  };
  const firstPromise = coordinator.requestAgentAction(request);
  assert.throws(
    () => coordinator.requestAgentAction(request),
    /already has an action/,
  );
  const status = coordinator.getPendingStatus("seat-concurrent");
  approver.allowOnce(status);
  assert.equal((await firstPromise).allowed, true);
});

test("trusted denial releases the waiting agent without executing the action", async () => {
  const { coordinator, approver } = harness();
  const decisionPromise = coordinator.requestAgentAction(
    {
      seatId: "seat-deny",
      origin: "https://example.com/",
      actions: [ordinaryFieldEdit()],
    },
    {
      actions: [
        {
          target: {
            tagName: "input",
            inputType: "text",
            role: "textbox",
          },
        },
      ],
    },
  );
  const status = coordinator.getPendingStatus("seat-deny");
  assert.equal(approver.deny(status), true);
  const decision = await decisionPromise;
  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "deny");
  assert.equal(decision.source, "trusted-user-denial");
});

test("UI-facing status and summaries never expose typed secrets", async () => {
  const { coordinator, approver } = harness();
  const secret = "CorrectHorseBatteryStaple-7391";
  const credentialedOrigin = new URL(
    `https://example.com/account?token=${secret}`,
  );
  credentialedOrigin.username = "user";
  credentialedOrigin.password = secret;
  const decisionPromise = coordinator.requestAgentAction(
    {
      seatId: "seat-secret",
      origin: credentialedOrigin.href,
      actions: [
        {
          kind: "type",
          text: secret,
          target: {
            tagName: "input",
            type: "text",
            accessibleName: "untrusted harmless claim",
          },
        },
      ],
    },
    {
      actions: [
        {
          target: {
            tagName: "input",
            type: "password",
            role: secret,
            accessibleName: secret,
            value: secret,
          },
        },
      ],
    },
  );
  const status = coordinator.getPendingStatus("seat-secret");
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(status.summary, "Enter sensitive information");
  assert.equal(Object.hasOwn(status, "actions"), false);
  assert.deepEqual(status.presentation.actions[0], {
    kind: "type",
    target: {
      name: "[redacted]",
      role: "input",
      fieldType: "password",
    },
    typedContent: {
      category: "password",
      length: Array.from(secret).length,
    },
  });
  approver.deny(status);
  assert.doesNotMatch(
    JSON.stringify(await decisionPromise),
    new RegExp(secret),
  );
});

test("approval presentation identifies safe destination, live target, form, and typed-content metadata", async () => {
  const { coordinator, approver } = harness();
  const secret = "do-not-render-this-password";
  const credentialedFormAction = new URL(
    `https://accounts.example/session/reset?token=${secret}#confirm`,
  );
  credentialedFormAction.username = "user";
  credentialedFormAction.password = secret;
  const passwordPromise = coordinator.requestAgentAction(
    {
      seatId: "seat-informed-password",
      origin: "https://accounts.example/sign-in?session=private#step",
      actions: [{ kind: "type", text: secret }],
    },
    {
      actions: [{
        target: {
          tagName: "input",
          role: "textbox",
          inputType: "password",
          accessibleName: `Account password ${secret}`,
          formMethod: "post",
          formAction: credentialedFormAction.href,
        },
      }],
    },
  );
  const passwordStatus = coordinator.getPendingStatus("seat-informed-password");
  assert.deepEqual(passwordStatus.presentation.actions[0], {
    kind: "type",
    target: {
      name: "Account password [redacted]",
      role: "textbox",
      fieldType: "password",
    },
    form: {
      method: "POST",
      destination: "https://accounts.example/session/reset",
    },
    typedContent: {
      category: "password",
      length: Array.from(secret).length,
    },
  });
  assert.doesNotMatch(JSON.stringify(passwordStatus.presentation), new RegExp(secret));
  approver.deny(passwordStatus);
  await passwordPromise;

  const credentialedDestination = new URL(
    "https://destination.example/work/item?access_token=private#section",
  );
  credentialedDestination.username = "operator";
  credentialedDestination.password = "private";
  const navigationPromise = coordinator.requestAgentAction(
    {
      seatId: "seat-informed-navigation",
      origin: "https://source.example/",
      actions: [{
        kind: "navigate",
        url: credentialedDestination.href,
      }],
    },
    { actions: [{}] },
  );
  const navigationStatus = coordinator.getPendingStatus("seat-informed-navigation");
  assert.deepEqual(navigationStatus.presentation.actions[0], {
    kind: "navigate",
    destination: "https://destination.example/work/item",
  });
  assert.doesNotMatch(JSON.stringify(navigationStatus.presentation), /operator|access_token|section|private/);
  approver.deny(navigationStatus);
  await navigationPromise;

  const clickPromise = coordinator.requestAgentAction(
    {
      seatId: "seat-informed-click",
      origin: "https://shop.example/cart",
      actions: [{ kind: "click", coordinate: { x: 25, y: 40 } }],
    },
    {
      actions: [{
        target: {
          tagName: "a",
          role: "link",
          accessibleName: "Review checkout",
          href: "https://shop.example/checkout/review?cart=private#payment",
          formMethod: "get",
          formAction: "https://shop.example/checkout/submit?cart=private#payment",
        },
      }],
    },
  );
  const clickStatus = coordinator.getPendingStatus("seat-informed-click");
  assert.deepEqual(clickStatus.presentation.actions[0], {
    kind: "click",
    destination: "https://shop.example/checkout/review",
    target: {
      name: "Review checkout",
      role: "link",
    },
    form: {
      method: "GET",
      destination: "https://shop.example/checkout/submit",
    },
  });
  approver.deny(clickStatus);
  await clickPromise;
});

test("UI action digests are keyed per trusted coordinator", async () => {
  const first = harness();
  const second = harness();
  const request = {
    seatId: "seat-digest",
    origin: "https://example.com/",
    actions: [
      {
        kind: "type",
        text: "123456",
        target: { autocomplete: "one-time-code" },
      },
    ],
  };
  const firstPromise = first.coordinator.requestAgentAction(request);
  const secondPromise = second.coordinator.requestAgentAction(request);
  const firstStatus = first.coordinator.getPendingStatus("seat-digest");
  const secondStatus = second.coordinator.getPendingStatus("seat-digest");
  assert.notEqual(firstStatus.actionDigest, secondStatus.actionDigest);
  first.approver.deny(firstStatus);
  second.approver.deny(secondStatus);
  await Promise.all([firstPromise, secondPromise]);
});

test("trusted DOM context is included in the keyed action digest", async () => {
  const { coordinator, approver } = harness();
  const request = {
    seatId: "seat-context-digest",
    origin: "https://example.com/",
    actions: [ordinaryFieldEdit("same value")],
  };
  const firstPromise = coordinator.requestAgentAction(request, {
    actions: [{ target: { tagName: "input", name: "subject" } }],
  });
  const firstStatus = coordinator.getPendingStatus("seat-context-digest");
  approver.deny(firstStatus);
  await firstPromise;

  const secondPromise = coordinator.requestAgentAction(request, {
    actions: [{ target: { tagName: "textarea", name: "message" } }],
  });
  const secondStatus = coordinator.getPendingStatus("seat-context-digest");
  assert.notEqual(firstStatus.actionDigest, secondStatus.actionDigest);
  approver.deny(secondStatus);
  await secondPromise;
});

test("site lease compatibility API never authorizes typing, credentials, navigation, send, submit, or unknown mutation", async () => {
  const { coordinator, approver } = harness();
  const cases = [
    {
      actions: [ordinaryFieldEdit("first draft")],
      context: {
        actions: [
          {
            target: {
              tagName: "input",
              inputType: "text",
              role: "textbox",
            },
          },
        ],
      },
    },
    {
      actions: [{ kind: "type", text: "secret" }],
      context: {
        actions: [{ target: { tagName: "input", type: "password" } }],
      },
    },
    { actions: [{ kind: "navigate", url: "https://other.example/" }] },
    {
      actions: [{ kind: "click", coordinate: { x: 20, y: 20 } }],
      context: {
        actions: [
          { target: { tagName: "button", accessibleName: "Send message" } },
        ],
      },
    },
    { actions: [{ kind: "submit" }] },
    { actions: [{ kind: "unknown-model-mutation" }] },
  ];

  for (const [index, candidate] of cases.entries()) {
    const promise = coordinator.requestAgentAction(
      {
        seatId: `seat-no-lease-${index}`,
        origin: "https://example.com/editor",
        actions: candidate.actions,
      },
      candidate.context || {},
    );
    const status = coordinator.getPendingStatus(`seat-no-lease-${index}`);
    assert.equal(status.siteLeaseAvailable, false);
    assert.equal(approver.allowSiteLease(status), false);
    assert.equal(
      coordinator.getPendingStatus(`seat-no-lease-${index}`).requestId,
      status.requestId,
    );
    approver.deny(status);
    assert.equal((await promise).allowed, false);
  }

  assert.equal(
    coordinator.getSiteLeaseStatus("seat-no-lease-0", "https://example.com/"),
    null,
  );
});

test("clearing a seat cancels pending approval and a relaunched seat gets no prior authorization", async () => {
  const { coordinator, approver } = harness();
  const firstPromise = coordinator.requestAgentAction({
    seatId: "seat-relaunch",
    origin: "https://example.com/",
    actions: [highPublish()],
  });
  const staleStatus = coordinator.getPendingStatus("seat-relaunch");
  assert.equal(coordinator.clearSeatAuthorizations("seat-relaunch"), true);
  assert.equal(coordinator.getPendingStatus("seat-relaunch"), null);
  const cleared = await firstPromise;
  assert.equal(cleared.allowed, false);
  assert.equal(cleared.decision, "cancelled");
  assert.equal(cleared.source, "seat-cleared");
  assert.equal(approver.allowOnce(staleStatus), false);

  const relaunchedPromise = coordinator.requestAgentAction({
    seatId: "seat-relaunch",
    origin: "https://example.com/",
    actions: [highPublish()],
  });
  const relaunchedStatus = coordinator.getPendingStatus("seat-relaunch");
  assert.notEqual(relaunchedStatus.requestId, staleStatus.requestId);
  approver.deny(relaunchedStatus);
  assert.equal((await relaunchedPromise).allowed, false);
});

test("agent payloads cannot claim user identity or approval while trusted direct takeover bypasses the queue", async () => {
  const { coordinator, approver } = harness();
  assert.throws(
    () =>
      coordinator.requestAgentAction({
        actor: "user",
        seatId: "seat-model",
        origin: "https://example.com/",
        actions: [highPublish()],
      }),
    /cannot provide approval/,
  );
  assert.throws(
    () =>
      coordinator.requestAgentAction({
        decision: "allow-once",
        seatId: "seat-model",
        origin: "https://example.com/",
        actions: [highPublish()],
      }),
    /cannot provide approval/,
  );
  assert.throws(
    () =>
      coordinator.requestAgentAction({
        context: { surface: "address" },
        seatId: "seat-model",
        origin: "https://example.com/",
        actions: [{ kind: "type", text: "secret" }],
      }),
    /cannot provide approval/,
  );

  const liedAboutTarget = coordinator.requestAgentAction({
    seatId: "seat-model",
    origin: "https://example.com/",
    actions: [
      {
        kind: "click",
        surface: "address",
        target: { tagName: "a", href: "https://example.com/safe" },
      },
    ],
  });
  const liedStatus = coordinator.getPendingStatus("seat-model");
  assert.equal(liedStatus.riskClass, "high");
  approver.deny(liedStatus);
  assert.equal((await liedAboutTarget).allowed, false);

  const direct = approver.authorizeUserAction({
    seatId: "seat-user",
    origin: "https://example.com/",
    actions: [highPublish()],
  });
  assert.equal(direct.allowed, true);
  assert.equal(direct.source, "user-takeover");
  assert.equal(coordinator.getPendingStatus("seat-user"), null);
});

test("batch risk is the highest constituent risk and its UI summary contains no action text", () => {
  const secret = "do-not-display-this";
  const batch = classifyBrowserActionBatch([
    { kind: "screenshot" },
    ordinaryFieldEdit(secret),
    {
      kind: "type",
      text: secret,
      target: { tagName: "input", autocomplete: "one-time-code" },
    },
  ]);
  assert.equal(batch.riskClass, "high");
  assert.doesNotMatch(batch.summary, new RegExp(secret));
});
