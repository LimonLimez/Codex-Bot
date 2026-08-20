"use strict";

const { createHash } = require("node:crypto");
const BOT_ID_PATTERN = /^bot-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AVATAR_CATALOG_VERSION = 1;
const SHAPE_SALT = `openbot-avatar-shape-v${AVATAR_CATALOG_VERSION}`;
const COLOR_SALT = `openbot-avatar-color-v${AVATAR_CATALOG_VERSION}`;
const STOCK_VISIBLE_AVATAR_SHAPES = Object.freeze([
  "blob", "pebble", "squircle", "tablet", "wedge", "hex", "cloud", "teardrop",
]);
const ADDED_AVATAR_SHAPES = Object.freeze([
  "cat", "dog", "wolf", "bunny", "fox", "bear", "owl", "jelly",
  "terminal", "robot", "microchip", "drone",
]);
const VISIBLE_AVATAR_SHAPES = Object.freeze([
  ...STOCK_VISIBLE_AVATAR_SHAPES,
  ...ADDED_AVATAR_SHAPES,
]);
const AVATAR_COLORS = Object.freeze([
  "black", "brown", "red", "orange", "yellow", "green",
  "cyan", "blue", "violet", "magenta", "gray",
]);

function catalogIndex(botId, salt, length) {
  if (typeof botId !== "string" || !BOT_ID_PATTERN.test(botId)) {
    throw new TypeError("Avatar defaults require a canonical bot ID.");
  }
  const digest = createHash("sha256").update(salt).update("\0").update(botId).digest();
  return digest.readUInt32BE(0) % length;
}

function defaultAvatarIdentity(botId) {
  return Object.freeze({
    shape: VISIBLE_AVATAR_SHAPES[catalogIndex(botId, SHAPE_SALT, VISIBLE_AVATAR_SHAPES.length)],
    color: AVATAR_COLORS[catalogIndex(botId, COLOR_SALT, AVATAR_COLORS.length)],
  });
}

module.exports = {
  ADDED_AVATAR_SHAPES,
  AVATAR_CATALOG_VERSION,
  AVATAR_COLORS,
  STOCK_VISIBLE_AVATAR_SHAPES,
  VISIBLE_AVATAR_SHAPES,
  defaultAvatarIdentity,
};
