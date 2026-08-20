"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ADDED_AVATAR_SHAPES,
  AVATAR_CATALOG_VERSION,
  AVATAR_COLORS,
  STOCK_VISIBLE_AVATAR_SHAPES,
  VISIBLE_AVATAR_SHAPES,
  defaultAvatarIdentity,
} = require("../src/bots/avatar-catalog.cjs");

const IDS = Object.freeze([
  "bot-11111111-1111-4111-8111-111111111111",
  "bot-22222222-2222-4222-8222-222222222222",
  "bot-33333333-3333-4333-8333-333333333333",
  "bot-44444444-4444-4444-8444-444444444444",
  "bot-55555555-5555-4555-8555-555555555555",
  "bot-66666666-6666-4666-8666-666666666666",
]);

test("avatar catalog is safe unique ordered and complete", () => {
  assert.equal(AVATAR_CATALOG_VERSION, 1);
  assert.deepEqual(STOCK_VISIBLE_AVATAR_SHAPES, [
    "blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop",
  ]);
  assert.deepEqual(ADDED_AVATAR_SHAPES, [
    "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
    "terminal", "robot", "microchip", "drone",
  ]);
  assert.deepEqual(VISIBLE_AVATAR_SHAPES, [...STOCK_VISIBLE_AVATAR_SHAPES, ...ADDED_AVATAR_SHAPES]);
  assert.deepEqual(AVATAR_COLORS, [
    "black", "brown", "red", "orange", "yellow", "green",
    "cyan", "blue", "violet", "magenta", "gray",
  ]);
  assert.equal(new Set(VISIBLE_AVATAR_SHAPES).size, VISIBLE_AVATAR_SHAPES.length);
  for (const value of [...VISIBLE_AVATAR_SHAPES, ...AVATAR_COLORS]) {
    assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
  }
  assert.equal(Object.isFrozen(VISIBLE_AVATAR_SHAPES), true);
});

test("default avatar identity is deterministic separated and varied", () => {
  for (const id of IDS) assert.deepEqual(defaultAvatarIdentity(id), defaultAvatarIdentity(id));
  const identities = IDS.map(defaultAvatarIdentity);
  assert.ok(new Set(identities.map(({ shape }) => shape)).size >= 3);
  assert.ok(new Set(identities.map(({ color }) => color)).size >= 3);
  for (const identity of identities) {
    assert.ok(VISIBLE_AVATAR_SHAPES.includes(identity.shape));
    assert.ok(AVATAR_COLORS.includes(identity.color));
    assert.equal(Object.isFrozen(identity), true);
  }
  assert.throws(() => defaultAvatarIdentity("not-a-bot"), /bot ID/i);
});
