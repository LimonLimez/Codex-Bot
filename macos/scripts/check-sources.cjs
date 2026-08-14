"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ignored = new Set([
  ".build",
  ".swiftpm",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const files = [];
const pending = [root];

while (pending.length > 0) {
  const directory = pending.pop();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) pending.push(target);
    else if (entry.isFile() && /\.(?:cjs|js)$/.test(entry.name)) files.push(target);
  }
}

files.sort();
for (const file of files) {
  childProcess.execFileSync(process.execPath, ["--check", file], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
process.stdout.write(`Checked ${files.length} JavaScript source files.\n`);
