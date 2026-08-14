"use strict";

function replaceUnique(source, before, after, label) {
  if (
    typeof source !== "string" ||
    typeof before !== "string" ||
    before.length === 0 ||
    typeof after !== "string" ||
    typeof label !== "string" ||
    label.length === 0
  ) {
    throw new TypeError("replaceUnique requires source, anchor, replacement, and label strings");
  }
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Patch anchor is ambiguous: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

module.exports = { replaceUnique };
