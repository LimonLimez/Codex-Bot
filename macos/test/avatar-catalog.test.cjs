"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const avatarCatalog = require("../src/bots/avatar-catalog.cjs");
const {
  ADDED_AVATAR_SHAPES,
  AVATAR_CATALOG_VERSION,
  AVATAR_COLORS,
  STOCK_VISIBLE_AVATAR_SHAPES,
  VISIBLE_AVATAR_SHAPES,
  defaultAvatarIdentity,
} = avatarCatalog;

const EXPECTED_EXPORT_KEYS = Object.freeze([
  "ADDED_AVATAR_SHAPES",
  "AVATAR_CATALOG_VERSION",
  "AVATAR_COLORS",
  "STOCK_VISIBLE_AVATAR_SHAPES",
  "VISIBLE_AVATAR_SHAPES",
  "defaultAvatarIdentity",
]);

const IDS = Object.freeze([
  "bot-11111111-1111-4111-8111-111111111111",
  "bot-22222222-2222-4222-8222-222222222222",
  "bot-33333333-3333-4333-8333-333333333333",
  "bot-44444444-4444-4444-8444-444444444444",
  "bot-55555555-5555-4555-8555-555555555555",
  "bot-66666666-6666-4666-8666-666666666666",
]);

const GOLDEN_VECTORS = Object.freeze([
  Object.freeze({
    botId: IDS[0],
    shapeSalt: "openbot-avatar-shape-v1",
    colorSalt: "openbot-avatar-color-v1",
    shapeDigest: "b8b680bb6daea9ee8a80196319b56180b1af04abab0fe1f6f4bbe52bbf352efc",
    colorDigest: "60215f48a9d2cd09de4e008ce46a9e29aeb14903dae0bf5f9e660af8c9a6ed89",
    shapeWord: 3098968251,
    colorWord: 1612799816,
    shapeIndex: 11,
    colorIndex: 1,
    shape: "bunny",
    color: "brown",
  }),
  Object.freeze({
    botId: IDS[1],
    shapeSalt: "openbot-avatar-shape-v1",
    colorSalt: "openbot-avatar-color-v1",
    shapeDigest: "d5a1d1321bc4f41c12f829bc4f62c3f1aa32fb0dd65f3b91b2908026b2e70626",
    colorDigest: "bd5d04493a5a2c0871f45ba182091f8929869eb232d3c936cf7ccdbd3d40a024",
    shapeWord: 3584151858,
    colorWord: 3176989769,
    shapeIndex: 18,
    colorIndex: 8,
    shape: "microchip",
    color: "violet",
  }),
  Object.freeze({
    botId: IDS[2],
    shapeSalt: "openbot-avatar-shape-v1",
    colorSalt: "openbot-avatar-color-v1",
    shapeDigest: "cca4ecee7ce5be43f6bd73a46a508b7497d0652ac6c2b1dc4a9150abff271b98",
    colorDigest: "104bcb47af75cd169c2641bc1c630cc27240799a9de8c7fc298e4c2c91aef7f2",
    shapeWord: 3433360622,
    colorWord: 273402695,
    shapeIndex: 2,
    colorIndex: 5,
    shape: "squircle",
    color: "green",
  }),
]);

const CANONICAL_LETTERED_ID = "bot-abcdefab-cdef-4abc-8def-abcdefabcdef";
const MALFORMED_IDS = Object.freeze([
  ["wrong UUID version", "bot-abcdefab-cdef-6abc-8def-abcdefabcdef"],
  ["wrong UUID variant", "bot-abcdefab-cdef-4abc-7def-abcdefabcdef"],
  ["uppercase noncanonical", CANONICAL_LETTERED_ID.toUpperCase()],
  ["missing bot prefix", CANONICAL_LETTERED_ID.slice(4)],
  ["trailing data", `${CANONICAL_LETTERED_ID}-trailing`],
  ["leading and trailing whitespace", ` ${CANONICAL_LETTERED_ID} `],
  ["null", null],
  ["undefined", undefined],
  ["number", 42],
  ["symbol", Symbol("bot-id")],
  ["prototype-less object", Object.create(null)],
  ["string object", new String(CANONICAL_LETTERED_ID)],
  ["coercible hostile object", { toString: () => CANONICAL_LETTERED_ID }],
]);

test("avatar catalog is safe unique ordered and complete", () => {
  assert.deepEqual(Object.keys(avatarCatalog).sort(), [...EXPECTED_EXPORT_KEYS].sort());
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
  for (const collection of [
    STOCK_VISIBLE_AVATAR_SHAPES,
    ADDED_AVATAR_SHAPES,
    VISIBLE_AVATAR_SHAPES,
    AVATAR_COLORS,
  ]) {
    assert.equal(Object.isFrozen(collection), true);
  }
});

test("default avatar identity pins SHA-256 framing, salts, endian, and modulo vectors", () => {
  assert.deepEqual([...new Set(GOLDEN_VECTORS.map(({ shapeSalt }) => shapeSalt))], ["openbot-avatar-shape-v1"]);
  assert.deepEqual([...new Set(GOLDEN_VECTORS.map(({ colorSalt }) => colorSalt))], ["openbot-avatar-color-v1"]);

  for (const vector of GOLDEN_VECTORS) {
    assert.notEqual(vector.shapeSalt, vector.colorSalt);
    const shapeDigest = createHash("sha256")
      .update(vector.shapeSalt)
      .update("\0")
      .update(vector.botId)
      .digest();
    const colorDigest = createHash("sha256")
      .update(vector.colorSalt)
      .update("\0")
      .update(vector.botId)
      .digest();
    assert.equal(shapeDigest.toString("hex"), vector.shapeDigest, vector.botId);
    assert.equal(colorDigest.toString("hex"), vector.colorDigest, vector.botId);
    assert.equal(shapeDigest.readUInt32BE(0), vector.shapeWord, vector.botId);
    assert.equal(colorDigest.readUInt32BE(0), vector.colorWord, vector.botId);
    assert.equal(vector.shapeWord % VISIBLE_AVATAR_SHAPES.length, vector.shapeIndex, vector.botId);
    assert.equal(vector.colorWord % AVATAR_COLORS.length, vector.colorIndex, vector.botId);
    assert.deepEqual(defaultAvatarIdentity(vector.botId), {
      shape: vector.shape,
      color: vector.color,
    });
  }
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

test("default avatar identity rejects malformed and hostile IDs", () => {
  for (const [label, value] of MALFORMED_IDS) {
    assert.throws(() => defaultAvatarIdentity(value), { name: "TypeError" }, label);
  }
});
