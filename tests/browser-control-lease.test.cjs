"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { BrowserControlLeaseCoordinator } = require(
  path.resolve(
    __dirname,
    "..",
    "src",
    "browser-seats",
    "browser-control-lease.cjs",
  ),
);

test("trusted takeover is exclusive, refreshable, and blocks agent work", () => {
  let now = 1_000;
  const acquired = [];
  const coordinator = new BrowserControlLeaseCoordinator({
    now: () => now,
    ttlMs: 5_000,
    onAcquire: (seat) => acquired.push(seat),
  });
  const first = coordinator.acquire("seat-a", "trusted-view-owner-1");
  assert.equal(first.expiresAt, 6_000);
  assert.deepEqual(acquired, ["seat-a"]);
  assert.throws(
    () => coordinator.assertAgentAllowed("seat-a"),
    /direct control/,
  );
  assert.throws(
    () => coordinator.acquire("seat-a", "trusted-view-owner-2"),
    /Another trusted view/,
  );
  assert.equal(
    coordinator.authorizeUser("seat-a", "trusted-view-owner-1"),
    true,
  );
  now = 2_000;
  assert.equal(
    coordinator.heartbeat("seat-a", "trusted-view-owner-1").expiresAt,
    7_000,
  );
  assert.deepEqual(acquired, ["seat-a"]);
});

test("release and expiry restore agent access and reject stale owners", () => {
  let now = 100;
  const coordinator = new BrowserControlLeaseCoordinator({
    now: () => now,
    ttlMs: 1_000,
  });
  coordinator.acquire("seat-a", "trusted-view-owner-1");
  assert.equal(coordinator.release("seat-a", "trusted-view-owner-1"), true);
  assert.equal(coordinator.assertAgentAllowed("seat-a"), true);
  assert.throws(
    () => coordinator.authorizeUser("seat-a", "trusted-view-owner-1"),
    /Take control/,
  );

  coordinator.acquire("seat-a", "trusted-view-owner-1");
  now = 1_101;
  assert.equal(coordinator.status("seat-a").controlled, false);
  assert.equal(coordinator.assertAgentAllowed("seat-a"), true);
  assert.throws(
    () => coordinator.heartbeat("seat-a", "trusted-view-owner-1"),
    /does not own/,
  );
});

test("seat cleanup clears control without affecting another employee", () => {
  const coordinator = new BrowserControlLeaseCoordinator();
  coordinator.acquire("seat-a", "trusted-view-owner-1");
  coordinator.acquire("seat-b", "trusted-view-owner-2");
  assert.equal(coordinator.clearSeat("seat-a"), true);
  assert.equal(coordinator.status("seat-a").controlled, false);
  assert.equal(coordinator.status("seat-b").controlled, true);
});
