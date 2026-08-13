"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");

test("every browser seat launches behind the authenticated pinned-DNS proxy", () => {
  const manager = read("src/browser-seats/browser-seat-manager.cjs");
  assert.match(manager, /createPublicWebProxy\(\)/);
  assert.match(manager, /const proxyConfig = await publicWebProxy\.listen\(\)/);
  assert.match(manager, /proxy:\s*\{\s*server: proxyConfig\.server,\s*username: proxyConfig\.username,\s*password: proxyConfig\.password/s);
  assert.match(manager, /await seat\.publicWebProxy\?\.close\(\)/);
  assert.match(manager, /void publicWebProxy\.close\(\)\.catch/);
  assert.match(manager, /installBrowserPageHardening\(context\)/);
  assert.match(manager, /context\.clearPermissions\(\)/);
  assert.match(manager, /acceptDownloads: false/);
  assert.match(manager, /download\.cancel\(\)/);
  assert.match(manager, /\.\.\.CHROMIUM_HARDENING_ARGS/);
});

test("agent browser input is approval-gated while direct takeover is a trusted user actor", () => {
  const manager = read("src/browser-seats/browser-seat-manager.cjs");
  const bridge = read("src/browser-seat-bridge.cjs");
  assert.match(manager, /await actionApprovals\.requestAgentAction/);
  assert.match(manager, /immutableActionSnapshot/);
  assert.match(manager, /seat\.navigationEpoch === expectedEpoch/);
  assert.match(manager, /JSON\.stringify\(currentContext\) === expectedContext/);
  assert.match(manager, /approvalOriginForPage\(current\) === decision\.origin/);
  assert.match(manager, /if \(!decision\.allowed\)/);
  assert.match(bridge, /executeSeatActions\(seatKey, actions, \{ actor: "agent" \}\)/);
  assert.match(bridge, /actor: "user"/);
  assert.match(bridge, /controlId: String\(body\.controlId/);
  assert.match(manager, /browserControls\.assertAgentAllowed/);
  assert.match(manager, /browserControls\.authorizeUser/);
  assert.match(manager, /acquireUserControl/);
});

test("approval UI exposes safe status and authenticated allow or deny decisions", () => {
  const bridge = read("src/browser-seat-bridge.cjs");
  const renderer = read("src/renderer/live-seat-component.jsfrag");
  assert.match(bridge, /\/api\/approval/);
  assert.match(bridge, /manager\.pendingApprovalForSeat/);
  assert.match(bridge, /manager\.decidePendingApproval/);
  assert.match(renderer, /Browser action approval/);
  assert.match(renderer, /Allow once/);
  assert.match(renderer, /Allow this site briefly/);
  assert.match(renderer, /Deny/);
  assert.match(renderer, /Action:/);
  assert.match(renderer, /Destination:/);
  assert.match(renderer, /Target:/);
  assert.match(renderer, /Form:/);
  assert.match(renderer, /Content:/);
  const framePoll = renderer.slice(renderer.indexOf("const g = T.useCallback"), renderer.indexOf("const j = T.useCallback"));
  const approvalPoll = renderer.slice(renderer.indexOf("const j = T.useCallback"), renderer.indexOf("T.useEffect", renderer.indexOf("const j = T.useCallback")));
  assert.doesNotMatch(framePoll, /\/api\/approval/);
  assert.match(approvalPoll, /\/api\/approval/);
  assert.match(renderer, /setInterval\(\(\) => a && j\(\), 350\)/);
  assert.match(renderer, /action: "acquire"/);
  assert.match(renderer, /action: "heartbeat"/);
  assert.match(renderer, /action: "release"/);
  assert.match(renderer, /data-gb-overlay/);
});

test("installer explicitly packages both browser security modules", () => {
  const installer = read("installer/CodexBot.iss");
  assert.match(installer, /public-web-proxy\.cjs/);
  assert.match(installer, /browser-action-approval\.cjs/);
  assert.match(installer, /browser-control-lease\.cjs/);
  assert.match(installer, /browser-page-hardening\.cjs/);
});
