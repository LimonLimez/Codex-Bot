"use strict";

const port = process.parentPort;
if (!port) {
  process.exitCode = 1;
} else {
  port.postMessage({ type: "ready" });
  setTimeout(() => process.exit(1), 0);
}
