"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "src", "official-computer-helper.cjs");
const clientPath = path.join(root, "src", "official-computer-client.cjs");
const helperSource = fs.readFileSync(helperPath, "utf8");
const {
  ACCESS_PATH,
  API_ORIGIN,
  ENSURE_PATH,
  MAX_ACTION_BATCH_RUNTIME_MS,
  MAX_DECLARED_ACTION_BUDGET_MS,
  OFFICIAL_RETRY_BASE_MS,
  OFFICIAL_RETRY_MAX_MS,
  MAX_WAIT_ACTION_MS,
  OFFICIAL_ACTION_APPROVAL_TTL_MS,
  OfficialComputerError,
  assertAllowedVendorRequest,
  createCursorChecksum,
  createOfficialComputerCore,
  decodeAccessStatus,
  decodeEnsureSandbox,
  hardenNoVncSource,
  immutableActions,
  readBoundedJsonResponse,
  rfbKeyChord,
  sendRfbKeyChord,
  startNoVncViewer,
  unicodeKeysymForCodePoint,
  validateLoginUrl,
  validateVncDescriptor,
} = require(helperPath);
const officialClient = require(clientPath);

const FIXED_NOW = 1_800_000_000_000;
const MACHINE_ID = "123e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174001";
const NETWORK_TOKEN = "network-token-0123456789";

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function enumField(number, value) {
  return Buffer.concat([varint((BigInt(number) << 3n) | 0n), varint(value)]);
}

function stringField(number, value) {
  const body = Buffer.from(String(value));
  return Buffer.concat([
    varint((BigInt(number) << 3n) | 2n),
    varint(body.length),
    body,
  ]);
}

function futureJwt(now = FIXED_NOW) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(now / 1000) + 3600 }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

function expiredJwt(now = FIXED_NOW) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(now / 1000) - 3600 }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
}

function buildVncUrl(token = NETWORK_TOKEN) {
  const nested = new URLSearchParams();
  nested.set("network_token", token);
  nested.set("resume_lower_s", "900");
  nested.set("resume_upper_s", "18000");
  const url = new URL("https://computer.vendor.example/vnc.html");
  url.searchParams.set("network_token", token);
  url.searchParams.set("resume_lower_s", "900");
  url.searchParams.set("resume_upper_s", "18000");
  url.searchParams.set("path", `websockify?${nested}`);
  return url.toString();
}

function accessResponse(state = 1) {
  return Buffer.concat([
    enumField(1, state),
    enumField(2, 7),
    enumField(3, 0),
    stringField(22, "ignored-status-extension"),
  ]);
}

function ensureResponse() {
  return Buffer.concat([
    stringField(1, "gateway-credential-must-be-discarded"),
    stringField(2, "exec-credential-must-be-discarded"),
    stringField(3, "fork-credential-must-be-discarded"),
    stringField(4, NETWORK_TOKEN),
    stringField(5, "another-discarded-secret"),
    stringField(6, "another-fork-secret"),
    stringField(7, buildVncUrl()),
  ]);
}

function protoResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/proto",
      "Content-Length": String(body.length),
    },
  });
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sealed(value) {
  return `dpapi:${Buffer.from(String(value)).toString("base64url")}`;
}

function unsealed(value) {
  const text = String(value);
  if (!text.startsWith("dpapi:")) throw new Error("not protected");
  return Buffer.from(text.slice(6), "base64url").toString("utf8");
}

async function waitFor(predicate, message = "condition", timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function presentedApproval(pending) {
  return {
    requestId: pending.requestId,
    seatId: pending.seatId,
    origin: pending.origin,
    actionDigest: pending.actionDigest,
    presentedFrame: {
      generation: pending.frame.generation,
      sequence: pending.frame.sequence,
      sha256: pending.frame.sha256,
    },
  };
}

function pngCrc32(value) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const chunk = Buffer.alloc(12 + body.length);
  chunk.writeUInt32BE(body.length, 0);
  name.copy(chunk, 4);
  body.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([name, body])), 8 + body.length);
  return chunk;
}

function pngPaeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance)
    return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function rgbPng(width, height, changedPixels = [], filter = 0) {
  const pixels = Buffer.alloc(width * height * 3, 255);
  for (const { x, y, rgb = [0, 0, 0] } of changedPixels) {
    const offset = (y * width + x) * 3;
    pixels[offset] = rgb[0];
    pixels[offset + 1] = rgb[1];
    pixels[offset + 2] = rgb[2];
  }
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const outputRow = y * (stride + 1);
    const pixelRow = y * stride;
    rows[outputRow] = filter;
    for (let x = 0; x < stride; x += 1) {
      const raw = pixels[pixelRow + x];
      const left = x >= 3 ? pixels[pixelRow + x - 3] : 0;
      const above = y > 0 ? pixels[pixelRow + x - stride] : 0;
      const upperLeft = y > 0 && x >= 3 ? pixels[pixelRow + x - stride - 3] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : pngPaeth(left, above, upperLeft);
      rows[outputRow + 1 + x] = (raw - predictor) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function tempState(t) {
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-bot-official-test-"),
  );
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function rpcHeaders() {
  return {
    Authorization: `Bearer ${futureJwt()}`,
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-es/1.6.1",
    "x-cursor-checksum": createCursorChecksum(MACHINE_ID, () => FIXED_NOW),
    "x-cursor-client-type": "sand",
    "x-cursor-client-version": "0.18.0",
    "x-sand-box-namespace": "prod",
    "x-ghost-mode": "true",
    "x-request-id": REQUEST_ID,
  };
}

test("the vendor request firewall accepts only the four exact capabilities", () => {
  const authUrl = new URL("/auth/poll", API_ORIGIN);
  authUrl.searchParams.set("uuid", MACHINE_ID);
  authUrl.searchParams.set("verifier", "v".repeat(43));
  assert.doesNotThrow(() =>
    assertAllowedVendorRequest(
      authUrl,
      { method: "GET", headers: { "Content-Type": "application/json" } },
      "auth-poll",
    ),
  );

  assert.doesNotThrow(() =>
    assertAllowedVendorRequest(
      new URL("/oauth/token", API_ORIGIN),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB",
          grant_type: "refresh_token",
          refresh_token: "refresh-token",
        }),
      },
      "token-refresh",
    ),
  );

  for (const [pathname, capability] of [
    [ACCESS_PATH, "access-status"],
    [ENSURE_PATH, "ensure-box"],
  ]) {
    assert.doesNotThrow(() =>
      assertAllowedVendorRequest(
        new URL(pathname, API_ORIGIN),
        { method: "POST", headers: rpcHeaders(), body: Buffer.alloc(0) },
        capability,
      ),
    );
  }

  const blocked = [
    () =>
      assertAllowedVendorRequest(
        "https://x.ai/auth/poll?uuid=x&verifier=y",
        { method: "GET", headers: { "Content-Type": "application/json" } },
        "auth-poll",
      ),
    () =>
      assertAllowedVendorRequest(
        `${authUrl}&extra=1`,
        { method: "GET", headers: { "Content-Type": "application/json" } },
        "auth-poll",
      ),
    () =>
      assertAllowedVendorRequest(
        `${authUrl}&uuid=${MACHINE_ID}`,
        { method: "GET", headers: { "Content-Type": "application/json" } },
        "auth-poll",
      ),
    () =>
      assertAllowedVendorRequest(
        `${authUrl}#ignored-by-fetch`,
        { method: "GET", headers: { "Content-Type": "application/json" } },
        "auth-poll",
      ),
    () =>
      assertAllowedVendorRequest(
        new URL("/aiserver.v1.InferenceService/Stream", API_ORIGIN),
        { method: "POST", headers: rpcHeaders(), body: Buffer.alloc(0) },
        "ensure-box",
      ),
    () =>
      assertAllowedVendorRequest(
        new URL(ACCESS_PATH, API_ORIGIN),
        {
          method: "POST",
          headers: { ...rpcHeaders(), "x-secret-canary": "must-not-leak" },
          body: Buffer.alloc(0),
        },
        "access-status",
      ),
    () =>
      assertAllowedVendorRequest(
        new URL(ENSURE_PATH, API_ORIGIN),
        { method: "POST", headers: rpcHeaders(), body: Buffer.from([0]) },
        "ensure-box",
      ),
    () =>
      assertAllowedVendorRequest(
        new URL(ACCESS_PATH, API_ORIGIN),
        { method: "POST", headers: rpcHeaders(), body: Buffer.alloc(0) },
        "inference",
      ),
  ];
  for (const candidate of blocked)
    assert.throws(
      candidate,
      (error) => error?.code === "NETWORK_POLICY_BLOCKED",
    );
});

test("login uses exact PKCE parameters and stores no raw auth material", async (t) => {
  const stateDir = tempState(t);
  const calls = [];
  const accessToken = futureJwt();
  const refreshToken = ["refresh", "test", "value"].join("-");
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ accessToken, refreshToken });
    },
  });
  t.after(() => core.shutdown());

  const started = await core.startLogin();
  const login = new URL(started.loginUrl);
  assert.equal(login.origin, "https://cursor.com");
  assert.equal(login.pathname, "/loginDeepControl");
  assert.deepEqual([...login.searchParams.keys()].sort(), [
    "challenge",
    "mode",
    "redirectTarget",
    "uuid",
  ]);
  assert.equal(login.searchParams.get("mode"), "login");
  assert.equal(login.searchParams.get("redirectTarget"), "sand");
  assert.equal(validateLoginUrl(login), login.toString());

  const poll = new URL(calls[0].url);
  const verifier = poll.searchParams.get("verifier");
  const challenge = require("node:crypto")
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  assert.equal(login.searchParams.get("uuid"), poll.searchParams.get("uuid"));
  assert.equal(login.searchParams.get("challenge"), challenge);
  assert.equal(verifier.length, 43);

  await waitFor(() => core.status().connected, "official sign-in");
  const configText = fs.readFileSync(
    path.join(stateDir, "credentials.json"),
    "utf8",
  );
  const stored = JSON.parse(configText);
  assert.doesNotMatch(
    configText,
    new RegExp(accessToken.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(configText, new RegExp(refreshToken));
  assert.equal(Object.hasOwn(stored, "machineId"), false);
  assert.match(stored.protectedMachineId, /^dpapi:/);
  assert.match(stored.protectedAccessToken, /^dpapi:/);
  assert.match(stored.protectedRefreshToken, /^dpapi:/);

  for (const rejected of [
    started.loginUrl.replace("https://", "http://"),
    `${started.loginUrl}&next=https://evil.example`,
    `${started.loginUrl}#fragment`,
    started.loginUrl.replace(/challenge=[^&]+/, "challenge=short"),
    started.loginUrl.replace(
      /uuid=[^&]+/,
      "uuid=------------------------------------",
    ),
    ` ${started.loginUrl}`,
  ])
    assert.throws(() => validateLoginUrl(rejected));
});

test("private/default mode performs zero vendor requests", async (t) => {
  const stateDir = tempState(t);
  let requests = 0;
  const core = createOfficialComputerCore({
    stateDir,
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected vendor request");
    },
  });
  t.after(() => core.shutdown());
  assert.deepEqual(core.status(), {
    mode: "private",
    connected: false,
    state: "disconnected",
    ready: false,
    generation: 0,
    shared: true,
    provider: "official-grok-cloud",
    experimental: true,
    billingPossible: true,
    permissions: {
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: false,
    },
    lastError: null,
    retrying: false,
    retryAfterMs: 0,
    retryAttempt: 0,
    retryStage: null,
  });
  await core.setMode("private");
  await core.logout();
  assert.equal(requests, 0);
});

test("a fresh official enable fails closed until the user signs in to Cursor", async (t) => {
  const stateDir = tempState(t);
  let requests = 0;
  const core = createOfficialComputerCore({
    stateDir,
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unexpected vendor request");
    },
  });
  t.after(() => core.shutdown());

  await assert.rejects(
    core.setMode("official", true),
    (error) =>
      error?.code === "OFFICIAL_SIGN_IN_REQUIRED" &&
      error?.statusCode === 401 &&
      /Connect a Cursor account first/.test(error.message),
  );
  assert.equal(requests, 0);
  assert.deepEqual(fs.readdirSync(stateDir), []);
  assert.equal(core.status().mode, "private");
  assert.equal(core.status().connected, false);
  assert.equal(core.status().ready, false);
});

test(
  "logout fails closed when the protected credential file cannot be removed",
  { concurrency: false },
  async (t) => {
    const stateDir = tempState(t);
    const credentialFile = path.join(stateDir, "credentials.json");
    fs.writeFileSync(
      credentialFile,
      `${JSON.stringify({
        version: 1,
        mode: "official",
        experimentalAcceptedAt: new Date(FIXED_NOW).toISOString(),
        protectedMachineId: sealed(MACHINE_ID),
        protectedAccessToken: sealed(futureJwt()),
        protectedRefreshToken: sealed(
          ["logout", "failure", "fixture"].join("-"),
        ),
        updatedAt: new Date(FIXED_NOW).toISOString(),
      })}\n`,
    );
    const core = createOfficialComputerCore({
      stateDir,
      now: () => FIXED_NOW,
      protectSecret: sealed,
      unprotectSecret: unsealed,
    });
    t.after(() => core.shutdown());
    assert.equal(core.status().connected, true);

    const originalRemove = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (path.resolve(target) === path.resolve(credentialFile)) {
        const error = new Error("simulated file lock");
        error.code = "EBUSY";
        throw error;
      }
      return originalRemove(target, options);
    };
    try {
      await assert.rejects(
        core.logout(),
        (error) =>
          error?.code === "CREDENTIAL_ERASURE_FAILED" &&
          /could not remove/i.test(error.message),
      );
    } finally {
      fs.rmSync = originalRemove;
    }

    assert.equal(fs.existsSync(credentialFile), true);
    assert.equal(core.status().connected, true);
    assert.equal(core.status().mode, "official");
  },
);

test("declared action, approval, helper, and IPC budgets leave a safety margin", () => {
  assert.equal(
    officialClient.ACTION_EXECUTION_DEADLINE_MS,
    MAX_ACTION_BATCH_RUNTIME_MS,
  );
  assert.equal(
    MAX_ACTION_BATCH_RUNTIME_MS >=
      OFFICIAL_ACTION_APPROVAL_TTL_MS + MAX_DECLARED_ACTION_BUDGET_MS + 15000,
    true,
  );
  assert.equal(
    officialClient.INPUT_REQUEST_TIMEOUT_MS >=
      MAX_ACTION_BATCH_RUNTIME_MS + 10000,
    true,
  );
  assert.doesNotThrow(() =>
    immutableActions([
      { kind: "wait", durationMs: MAX_WAIT_ACTION_MS },
      { kind: "wait", durationMs: MAX_WAIT_ACTION_MS },
    ]),
  );
  assert.throws(
    () =>
      immutableActions([{ kind: "wait", durationMs: MAX_WAIT_ACTION_MS + 1 }]),
    (error) => error?.code === "INVALID_ACTIONS",
  );
  assert.throws(
    () =>
      immutableActions([
        { kind: "wait", durationMs: MAX_WAIT_ACTION_MS },
        { kind: "wait", durationMs: MAX_WAIT_ACTION_MS },
        { kind: "wait", durationMs: MAX_WAIT_ACTION_MS },
      ]),
    (error) => error?.code === "ACTION_BUDGET_EXCEEDED",
  );
});

test("legacy plaintext machine identifiers are migrated into protected storage", async (t) => {
  const stateDir = tempState(t);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "credentials.json"),
    `${JSON.stringify({
      version: 1,
      mode: "private",
      machineId: MACHINE_ID,
      protectedAccessToken: sealed(futureJwt()),
      protectedRefreshToken: sealed("refresh-token"),
    })}\n`,
  );
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async () => {
      throw new Error("migration must not use the network");
    },
  });
  t.after(() => core.shutdown());
  assert.equal(core.status().connected, true);
  const migratedText = fs.readFileSync(
    path.join(stateDir, "credentials.json"),
    "utf8",
  );
  const migrated = JSON.parse(migratedText);
  assert.equal(Object.hasOwn(migrated, "machineId"), false);
  assert.equal(unsealed(migrated.protectedMachineId), MACHINE_ID);
  assert.equal(migratedText.includes(MACHINE_ID), false);
});

test("protobuf decoding rejects ambiguity and discards non-VNC credentials", () => {
  assert.deepEqual(decodeAccessStatus(accessResponse(1)), {
    state: 1,
    purchaseChannel: 7,
    blockReason: 0,
  });
  assert.deepEqual(decodeEnsureSandbox(ensureResponse()), {
    networkToken: NETWORK_TOKEN,
    vncUrl: buildVncUrl(),
  });
  assert.throws(
    () =>
      decodeEnsureSandbox(
        Buffer.concat([
          stringField(4, NETWORK_TOKEN),
          stringField(4, "second-network-token"),
        ]),
      ),
    (error) => error?.code === "INVALID_VENDOR_RESPONSE",
  );
  assert.throws(
    () => decodeAccessStatus(Buffer.concat([enumField(1, 1), enumField(1, 2)])),
    (error) => error?.code === "INVALID_VENDOR_RESPONSE",
  );
  assert.throws(
    () => decodeEnsureSandbox(Buffer.from([0x22, 0x03, 0xff, 0xff, 0xff])),
    (error) => error?.code === "INVALID_VENDOR_RESPONSE",
  );
});

test("access denial blocks EnsureSandBox while preserving official selection", async (t) => {
  const stateDir = tempState(t);
  const paths = [];
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (parsed.pathname === ACCESS_PATH)
        return protoResponse(accessResponse(2));
      throw new Error(`unexpected request: ${parsed.pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await assert.rejects(
    core.setMode("official", true),
    (error) => error?.code === "OFFICIAL_UNAVAILABLE",
  );
  assert.equal(paths.includes(ENSURE_PATH), false);
  assert.equal(core.status().mode, "official");
  assert.equal(core.status().ready, false);
});

test("official recovery circuit throttles access failures and retries when due", async (t) => {
  const stateDir = tempState(t);
  let clock = FIXED_NOW;
  let accessCalls = 0;
  let ensureCalls = 0;
  let viewerLaunches = 0;
  let vendorHealthy = false;
  const core = createOfficialComputerCore({
    stateDir,
    now: () => clock,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => {
      viewerLaunches += 1;
      return {
        async capture() {
          return { screenshotBase64: "cG5n", cursorPosition: { x: 4, y: 5 } };
        },
        async execute() {},
        async close() {},
      };
    },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) {
        accessCalls += 1;
        return vendorHealthy
          ? protoResponse(accessResponse(1))
          : protoResponse(Buffer.alloc(0), 503);
      }
      if (pathname === ENSURE_PATH) {
        ensureCalls += 1;
        return protoResponse(ensureResponse());
      }
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());

  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await assert.rejects(
    core.setMode("official", true),
    (error) => error?.code === "VENDOR_UNAVAILABLE",
  );
  assert.equal(accessCalls, 1);
  assert.equal(ensureCalls, 0);
  assert.equal(viewerLaunches, 0);
  assert.deepEqual(
    {
      retrying: core.status().retrying,
      retryAfterMs: core.status().retryAfterMs,
      retryAttempt: core.status().retryAttempt,
      retryStage: core.status().retryStage,
    },
    {
      retrying: true,
      retryAfterMs: OFFICIAL_RETRY_BASE_MS,
      retryAttempt: 1,
      retryStage: "access",
    },
  );

  await assert.rejects(
    core.captureSeat(),
    (error) => error?.code === "OFFICIAL_RETRY_PENDING",
  );
  clock += OFFICIAL_RETRY_BASE_MS - 1;
  await assert.rejects(
    core.captureSeat(),
    (error) => error?.code === "OFFICIAL_RETRY_PENDING",
  );
  assert.equal(accessCalls, 1);

  clock += 1;
  vendorHealthy = true;
  const recovered = await core.captureSeat();
  assert.deepEqual(recovered.cursorPosition, { x: 4, y: 5 });
  assert.equal(accessCalls, 2);
  assert.equal(ensureCalls, 1);
  assert.equal(viewerLaunches, 1);
  assert.deepEqual(
    {
      retrying: core.status().retrying,
      retryAfterMs: core.status().retryAfterMs,
      retryAttempt: core.status().retryAttempt,
      retryStage: core.status().retryStage,
    },
    {
      retrying: false,
      retryAfterMs: 0,
      retryAttempt: 0,
      retryStage: null,
    },
  );
});

test("official recovery delay grows to a fixed cap and explicit auth or mode actions reset it", async (t) => {
  const stateDir = tempState(t);
  let clock = FIXED_NOW;
  let accessCalls = 0;
  let loginPolls = 0;
  const core = createOfficialComputerCore({
    stateDir,
    now: () => clock,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll") {
        loginPolls += 1;
        return jsonResponse({
          accessToken: futureJwt(clock),
          refreshToken: `refresh-token-${loginPolls}`,
        });
      }
      if (pathname === ACCESS_PATH) {
        accessCalls += 1;
        return protoResponse(Buffer.alloc(0), 503);
      }
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());

  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await assert.rejects(core.setMode("official", true));

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const expectedDelay = Math.min(
      OFFICIAL_RETRY_BASE_MS * 2 ** (attempt - 1),
      OFFICIAL_RETRY_MAX_MS,
    );
    const recovery = core.status();
    assert.equal(recovery.retrying, true);
    assert.equal(recovery.retryAttempt, attempt);
    assert.equal(recovery.retryAfterMs, expectedDelay);
    assert.equal(recovery.retryStage, "access");
    await assert.rejects(
      core.captureSeat(),
      (error) => error?.code === "OFFICIAL_RETRY_PENDING",
    );
    assert.equal(accessCalls, attempt);
    clock += expectedDelay;
    await assert.rejects(
      core.captureSeat(),
      (error) => error?.code === "VENDOR_UNAVAILABLE",
    );
  }

  const beforeExplicitModeRetry = accessCalls;
  await assert.rejects(
    core.setMode("official", true),
    (error) => error?.code === "VENDOR_UNAVAILABLE",
  );
  assert.equal(accessCalls, beforeExplicitModeRetry + 1);
  assert.equal(core.status().retryAttempt, 1);
  assert.equal(core.status().retryAfterMs, OFFICIAL_RETRY_BASE_MS);

  await core.setMode("private");
  assert.equal(core.status().retrying, false);
  assert.equal(core.status().retryAttempt, 0);
  const beforeModeChangeRetry = accessCalls;
  await assert.rejects(
    core.setMode("official", true),
    (error) => error?.code === "VENDOR_UNAVAILABLE",
  );
  assert.equal(accessCalls, beforeModeChangeRetry + 1);
  assert.equal(core.status().retryAttempt, 1);

  await core.startLogin();
  assert.equal(core.status().retrying, false);
  assert.equal(core.status().retryAttempt, 0);
  await waitFor(() => loginPolls === 2, "replacement account sign-in");
  assert.equal(core.status().retrying, false);
});

test("provision and viewer launch failures are fenced from frame-poll hammering", async (t) => {
  for (const scenario of [
    {
      name: "provision",
      stage: "provision",
      failProvision: true,
      expectedViewerLaunches: 0,
    },
    {
      name: "viewer",
      stage: "viewer",
      failProvision: false,
      expectedViewerLaunches: 1,
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const stateDir = tempState(t);
      let accessCalls = 0;
      let ensureCalls = 0;
      let viewerLaunches = 0;
      const core = createOfficialComputerCore({
        stateDir,
        now: () => FIXED_NOW,
        sleep: async () => {},
        protectSecret: sealed,
        unprotectSecret: unsealed,
        viewerFactory: async () => {
          viewerLaunches += 1;
          throw new Error(`viewer launch failed ${NETWORK_TOKEN}`);
        },
        fetchImpl: async (url) => {
          const pathname = new URL(url).pathname;
          if (pathname === "/auth/poll")
            return jsonResponse({
              accessToken: futureJwt(),
              refreshToken: "refresh-token",
            });
          if (pathname === ACCESS_PATH) {
            accessCalls += 1;
            return protoResponse(accessResponse(1));
          }
          if (pathname === ENSURE_PATH) {
            ensureCalls += 1;
            return scenario.failProvision
              ? protoResponse(Buffer.alloc(0), 503)
              : protoResponse(ensureResponse());
          }
          throw new Error(`unexpected request: ${pathname}`);
        },
      });
      t.after(() => core.shutdown());

      await core.startLogin();
      await waitFor(() => core.status().connected, "official sign-in");
      await assert.rejects(core.setMode("official", true));
      assert.equal(accessCalls, 1);
      assert.equal(ensureCalls, 1);
      assert.equal(viewerLaunches, scenario.expectedViewerLaunches);
      assert.equal(core.status().retryStage, scenario.stage);
      assert.equal(
        JSON.stringify(core.status()).includes(NETWORK_TOKEN),
        false,
      );

      await assert.rejects(
        core.captureSeat(),
        (error) => error?.code === "OFFICIAL_RETRY_PENDING",
      );
      assert.equal(accessCalls, 1);
      assert.equal(ensureCalls, 1);
      assert.equal(viewerLaunches, scenario.expectedViewerLaunches);
    });
  }
});

test("a disconnected live viewer backs off and then recovers through a fresh provision", async (t) => {
  const stateDir = tempState(t);
  let clock = FIXED_NOW;
  let accessCalls = 0;
  let ensureCalls = 0;
  let viewerLaunches = 0;
  let viewerCloses = 0;
  const core = createOfficialComputerCore({
    stateDir,
    now: () => clock,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => {
      viewerLaunches += 1;
      const launch = viewerLaunches;
      return {
        async capture() {
          if (launch === 1)
            throw new Error(`viewer disconnected ${NETWORK_TOKEN}`);
          return { screenshotBase64: "cG5n", cursorPosition: { x: 8, y: 9 } };
        },
        async execute() {},
        async close() {
          viewerCloses += 1;
        },
      };
    },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) {
        accessCalls += 1;
        return protoResponse(accessResponse(1));
      }
      if (pathname === ENSURE_PATH) {
        ensureCalls += 1;
        return protoResponse(ensureResponse());
      }
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());

  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);
  await assert.rejects(core.captureSeat(), /viewer disconnected/);
  assert.equal(viewerCloses, 1);
  assert.equal(core.status().ready, false);
  assert.equal(core.status().retryStage, "viewer");
  assert.equal(core.status().retryAfterMs, OFFICIAL_RETRY_BASE_MS);
  assert.equal(JSON.stringify(core.status()).includes(NETWORK_TOKEN), false);

  await assert.rejects(
    core.captureSeat(),
    (error) => error?.code === "OFFICIAL_RETRY_PENDING",
  );
  assert.equal(accessCalls, 1);
  assert.equal(ensureCalls, 1);
  assert.equal(viewerLaunches, 1);

  clock += OFFICIAL_RETRY_BASE_MS;
  const recovered = await core.captureSeat();
  assert.deepEqual(recovered.cursorPosition, { x: 8, y: 9 });
  assert.equal(accessCalls, 2);
  assert.equal(ensureCalls, 2);
  assert.equal(viewerLaunches, 2);
  assert.equal(core.status().retrying, false);
  assert.equal(core.status().retryAttempt, 0);
});

test("sign-in refresh preserves official selection and blocks the old account while pending", async (t) => {
  const stateDir = tempState(t);
  let authPollCount = 0;
  let resolveSecondPoll;
  const secondPoll = new Promise((resolve) => {
    resolveSecondPoll = resolve;
  });
  let closeCount = 0;
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => ({
      async capture() {
        return { screenshotBase64: "cG5n", cursorPosition: { x: 0, y: 0 } };
      },
      async execute() {},
      async close() {
        closeCount += 1;
      },
    }),
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll") {
        authPollCount += 1;
        if (authPollCount === 1)
          return jsonResponse({
            accessToken: futureJwt(),
            refreshToken: "first-refresh-token",
          });
        return secondPoll;
      }
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "initial sign-in");
  await core.setMode("official", true);
  assert.equal(core.status().ready, true);

  await core.startLogin();
  assert.equal(core.status().mode, "official");
  assert.equal(core.status().state, "signing-in");
  assert.equal(core.status().ready, false);
  assert.equal(closeCount, 1);
  await assert.rejects(
    core.captureSeat("employee-one"),
    (error) => error?.code === "OFFICIAL_SIGN_IN_PENDING",
  );

  resolveSecondPoll(
    jsonResponse({
      accessToken: futureJwt(FIXED_NOW + 1000),
      refreshToken: ["second", "refresh", "token"].join("-"),
    }),
  );
  await waitFor(
    () => core.status().state === "signed-in",
    "refreshed account sign-in",
  );
  assert.equal(core.status().mode, "official");
  assert.equal(core.status().connected, true);
  const storedText = fs.readFileSync(
    path.join(stateDir, "credentials.json"),
    "utf8",
  );
  assert.equal(storedText.includes("second-refresh-token"), false);

  await core.setMode("private");
  assert.equal(core.status().mode, "private");
});

test("provider opt-out aborts and awaits every pending setup stage", async (t) => {
  const scenarios = [
    { name: "private during access", stage: "access", transition: "private" },
    { name: "logout during Ensure", stage: "ensure", transition: "logout" },
    {
      name: "shutdown during viewer startup",
      stage: "viewer",
      transition: "shutdown",
    },
    {
      name: "account rotation during viewer startup",
      stage: "viewer",
      transition: "rotation",
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const stateDir = tempState(t);
      const setupStarted = deferred();
      const cleanupRelease = deferred();
      let abortObserved = false;
      let cleanupComplete = false;
      let authPolls = 0;
      let core;

      function pendingSetup(signal) {
        assert.ok(signal instanceof AbortSignal);
        setupStarted.resolve();
        return new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            async () => {
              abortObserved = true;
              await cleanupRelease.promise;
              cleanupComplete = true;
              const error = new Error("setup aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      }

      core = createOfficialComputerCore({
        stateDir,
        now: () => FIXED_NOW,
        sleep: async () => {},
        protectSecret: sealed,
        unprotectSecret: unsealed,
        viewerFactory: async (_descriptor, viewerOptions) => {
          if (scenario.stage === "viewer")
            return pendingSetup(viewerOptions.signal);
          return {
            async capture() {
              return {
                screenshotBase64: "cG5n",
                cursorPosition: { x: 0, y: 0 },
              };
            },
            async execute() {},
            async close() {},
          };
        },
        fetchImpl: async (url, init = {}) => {
          const pathname = new URL(url).pathname;
          if (pathname === "/auth/poll") {
            authPolls += 1;
            return jsonResponse({
              accessToken: futureJwt(FIXED_NOW + authPolls * 1000),
              refreshToken: `refresh-token-${authPolls}`,
            });
          }
          if (pathname === ACCESS_PATH) {
            if (scenario.stage === "access") return pendingSetup(init.signal);
            return protoResponse(accessResponse(1));
          }
          if (pathname === ENSURE_PATH) {
            if (scenario.stage === "ensure") return pendingSetup(init.signal);
            return protoResponse(ensureResponse());
          }
          throw new Error(`unexpected request: ${pathname}`);
        },
      });
      t.after(async () => {
        cleanupRelease.resolve();
        await core.shutdown();
      });

      await core.startLogin();
      await waitFor(() => core.status().connected, "official sign-in");
      const enabling = core.setMode("official", true);
      const enablingRejected = assert.rejects(
        enabling,
        (error) => error?.code === "CANCELLED",
      );
      await setupStarted.promise;
      let transitionSettled = false;
      let transition;
      if (scenario.transition === "private")
        transition = core.setMode("private");
      else if (scenario.transition === "logout") transition = core.logout();
      else if (scenario.transition === "shutdown") transition = core.shutdown();
      else transition = core.startLogin();
      transition.then(
        () => {
          transitionSettled = true;
        },
        () => {
          transitionSettled = true;
        },
      );
      await waitFor(() => abortObserved, `${scenario.name} abort`);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(transitionSettled, false);
      assert.equal(cleanupComplete, false);

      cleanupRelease.resolve();
      const transitionResult = await transition;
      assert.equal(cleanupComplete, true);
      await enablingRejected;
      if (scenario.transition === "private")
        assert.equal(transitionResult.mode, "private");
      if (scenario.transition === "logout") {
        assert.equal(transitionResult.connected, false);
        assert.equal(
          fs.existsSync(path.join(stateDir, "credentials.json")),
          false,
        );
      }
      if (scenario.transition === "rotation") {
        assert.match(transitionResult.loginUrl, /^https:\/\/cursor\.com\//);
        assert.equal(transitionResult.state, "signing-in");
      }
    });
  }
});

test("expired refresh removes credentials but preserves official selection", async (t) => {
  const stateDir = tempState(t);
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: expiredJwt(),
          refreshToken: ["expired", "refresh", "token"].join("-"),
        });
      if (pathname === "/oauth/token")
        return jsonResponse({ shouldLogout: true }, 401);
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "expired sign-in storage");
  await assert.rejects(
    core.setMode("official", true),
    (error) => error?.code === "OFFICIAL_SIGN_IN_REQUIRED",
  );
  assert.equal(core.status().mode, "official");
  assert.equal(core.status().connected, false);
  assert.equal(core.status().ready, false);
  const stored = JSON.parse(
    fs.readFileSync(path.join(stateDir, "credentials.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(stored).sort(),
    ["experimentalAcceptedAt", "mode", "updatedAt", "version"].sort(),
  );
  assert.equal(stored.mode, "official");

  await core.setMode("private");
  assert.equal(core.status().mode, "private");
});

test("viewer launch failure preserves official selection for recovery", async (t) => {
  const stateDir = tempState(t);
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => {
      throw new Error("viewer launch failed");
    },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await assert.rejects(core.setMode("official", true), /viewer launch failed/);
  assert.equal(core.status().mode, "official");
  assert.equal(core.status().ready, false);
  assert.equal(core.status().state, "error");
});

test("invalid provision response preserves official selection and launches no viewer", async (t) => {
  const stateDir = tempState(t);
  let viewerLaunches = 0;
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => {
      viewerLaunches += 1;
      throw new Error("must not launch");
    },
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH)
        return protoResponse(stringField(1, "discard-only"));
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await assert.rejects(
    core.setMode("official", true),
    (error) => error?.code === "INVALID_VNC_DESCRIPTOR",
  );
  assert.equal(viewerLaunches, 0);
  assert.equal(core.status().mode, "official");
  assert.equal(core.status().ready, false);
});

test("official mode shares one viewer, gates actions, and never persists box credentials", async (t) => {
  const stateDir = tempState(t);
  const paths = [];
  const executed = [];
  let viewerDescriptor;
  let closeCount = 0;
  const viewer = {
    async capture() {
      return {
        screenshotBase64: Buffer.from("png").toString("base64"),
        cursor: { x: 41, y: 42 },
      };
    },
    async execute(actions) {
      executed.push(...actions.map((action) => action.kind));
    },
    async close() {
      closeCount += 1;
    },
  };
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async (descriptor) => {
      viewerDescriptor = descriptor;
      return viewer;
    },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      paths.push(parsed.pathname);
      if (parsed.pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (parsed.pathname === ACCESS_PATH)
        return protoResponse(accessResponse(1));
      if (parsed.pathname === ENSURE_PATH)
        return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${parsed.pathname}`);
    },
  });
  t.after(() => core.shutdown());

  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await assert.rejects(
    core.setMode("official", false),
    (error) => error?.code === "ACKNOWLEDGEMENT_REQUIRED",
  );
  const enabled = await core.setMode("official", true);
  assert.equal(enabled.ready, true);
  assert.equal(enabled.mode, "official");
  assert.deepEqual(Object.keys(viewerDescriptor).sort(), [
    "networkToken",
    "origin",
    "vncUrl",
  ]);
  assert.equal(
    JSON.stringify(viewerDescriptor).includes("gateway-credential"),
    false,
  );
  assert.equal(paths.filter((value) => value === ENSURE_PATH).length, 1);

  const first = await core.captureSeat("employee-one");
  const second = await core.captureSeat("employee-two");
  assert.equal(first.provider, "official");
  assert.equal(first.shared, true);
  assert.deepEqual(first.cursorPosition, { x: 41, y: 42 });
  assert.equal(second.generation, first.generation);
  assert.equal(paths.filter((value) => value === ENSURE_PATH).length, 1);

  await core.executeSeatActions("employee-one", [{ kind: "screenshot" }]);
  assert.deepEqual(executed, ["screenshot"]);

  const actionPromise = core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 10, y: 20 } },
  ]);
  const pending = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "official action approval",
  );
  assert.equal(
    core.decidePendingApproval(
      "employee-one",
      "allow-once",
      presentedApproval(pending),
    ),
    true,
  );
  await actionPromise;
  assert.deepEqual(executed, ["screenshot", "click"]);

  const deniedAction = core.executeSeatActions("employee-one", [
    { kind: "key", key: "ENTER" },
  ]);
  const deniedPending = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "official action denial",
  );
  assert.equal(
    core.decidePendingApproval("employee-one", "deny", {
      requestId: deniedPending.requestId,
      seatId: deniedPending.seatId,
      origin: deniedPending.origin,
      actionDigest: deniedPending.actionDigest,
    }),
    true,
  );
  await assert.rejects(
    deniedAction,
    (error) => error?.code === "ACTION_NOT_APPROVED",
  );
  assert.deepEqual(executed, ["screenshot", "click"]);
  assert.equal(core.status().ready, true);

  const owner = "trusted-view-owner-0001";
  await core.acquireUserControl("employee-one", owner);
  assert.equal(core.controlStatusForSeat("employee-two").controlled, true);
  await assert.rejects(
    core.executeSeatActions("employee-two", [{ kind: "screenshot" }]),
    /direct control/,
  );
  await core.executeSeatActions(
    "employee-two",
    [{ kind: "mouseMove", coordinate: { x: 2, y: 3 } }],
    { actor: "user", controlId: owner },
  );
  assert.equal(core.releaseUserControl("employee-two", owner), true);

  const configText = fs.readFileSync(
    path.join(stateDir, "credentials.json"),
    "utf8",
  );
  for (const forbidden of [
    NETWORK_TOKEN,
    buildVncUrl(),
    "gateway-credential-must-be-discarded",
    "exec-credential-must-be-discarded",
    "fork-credential-must-be-discarded",
  ])
    assert.equal(configText.includes(forbidden), false, forbidden);

  await core.logout();
  assert.equal(closeCount, 1);
  assert.equal(fs.existsSync(path.join(stateDir, "credentials.json")), false);
});

test("official Always allow is DPAPI-protected, provider-scoped, persistent, and fail-closed", async (t) => {
  const stateDir = tempState(t);
  const executed = [];
  const frame = Buffer.from("stable-permission-frame").toString("base64");
  const viewer = {
    async capture() {
      return {
        screenshotBase64: frame,
        cursorPosition: { x: 0, y: 0 },
      };
    },
    async execute(actions) {
      executed.push(...actions.map((action) => action.kind));
    },
    async close() {},
  };
  const options = {
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => viewer,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  };
  const core = createOfficialComputerCore(options);
  t.after(() => core.shutdown());
  assert.deepEqual(core.computerPermissions(), {
    provider: "official-grok-cloud",
    alwaysAllowComputerActions: false,
  });
  assert.throws(
    () => core.setComputerPermissions(true, false, "official-grok-cloud"),
    (error) => error?.code === "PERMISSION_ACKNOWLEDGEMENT_REQUIRED",
  );
  assert.throws(
    () => core.setComputerPermissions(true, true, "private"),
    (error) => error?.code === "INVALID_PERMISSION",
  );
  assert.throws(
    () => core.setComputerPermissions(true, true, "official-grok-cloud"),
    (error) => error?.code === "OFFICIAL_SIGN_IN_REQUIRED",
  );

  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);
  const gated = core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 20, y: 30 } },
  ]);
  const pending = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "default permission prompt",
  );
  core.decidePendingApproval("employee-one", "deny", {
    requestId: pending.requestId,
    seatId: pending.seatId,
    origin: pending.origin,
    actionDigest: pending.actionDigest,
  });
  await assert.rejects(gated, (error) => error?.code === "ACTION_NOT_APPROVED");

  assert.deepEqual(
    core.setComputerPermissions(true, true, "official-grok-cloud"),
    {
      provider: "official-grok-cloud",
      alwaysAllowComputerActions: true,
    },
  );
  const permissionPath = path.join(stateDir, "permissions.json");
  const protectedText = fs.readFileSync(permissionPath, "utf8");
  assert.equal(protectedText.includes("alwaysAllowComputerActions"), false);
  assert.match(protectedText, /"provider": "official-grok-cloud"/);
  assert.match(protectedText, /"protectedPolicy": "dpapi:/);

  await core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 20, y: 30 } },
  ]);
  assert.deepEqual(executed, ["click"]);
  assert.equal(core.pendingApprovalForSeat("employee-one"), null);

  const owner = "permission-takeover-owner";
  await core.acquireUserControl("employee-one", owner);
  await assert.rejects(
    core.executeSeatActions("employee-one", [{ kind: "key", key: "ENTER" }]),
    /direct control/,
  );
  assert.equal(core.releaseUserControl("employee-one", owner), true);

  await core.shutdown();
  const restarted = createOfficialComputerCore(options);
  assert.deepEqual(restarted.computerPermissions(), {
    provider: "official-grok-cloud",
    alwaysAllowComputerActions: true,
  });
  await restarted.shutdown();

  const stored = JSON.parse(fs.readFileSync(permissionPath, "utf8"));
  stored.provider = "private";
  fs.writeFileSync(permissionPath, `${JSON.stringify(stored)}\n`);
  const tampered = createOfficialComputerCore(options);
  assert.deepEqual(tampered.computerPermissions(), {
    provider: "official-grok-cloud",
    alwaysAllowComputerActions: false,
  });
  tampered.setComputerPermissions(false, false, "official-grok-cloud");
  assert.equal(fs.existsSync(permissionPath), false);
  await tampered.shutdown();

  const accountLifecycle = createOfficialComputerCore(options);
  assert.equal(accountLifecycle.status().connected, true);
  accountLifecycle.setComputerPermissions(true, true, "official-grok-cloud");
  assert.equal(fs.existsSync(permissionPath), true);
  await accountLifecycle.startLogin();
  assert.equal(
    accountLifecycle.computerPermissions().alwaysAllowComputerActions,
    false,
  );
  assert.equal(fs.existsSync(permissionPath), false);
  accountLifecycle.cancelLogin();
  accountLifecycle.setComputerPermissions(true, true, "official-grok-cloud");
  await accountLifecycle.logout();
  assert.equal(
    accountLifecycle.computerPermissions().alwaysAllowComputerActions,
    false,
  );
  assert.equal(fs.existsSync(permissionPath), false);
  await accountLifecycle.shutdown();
});

test("mutating approvals bind the trusted framebuffer hash and sequence", async (t) => {
  const stateDir = tempState(t);
  const executed = [];
  let currentFrame = "initial";
  const viewer = {
    async capture() {
      return {
        screenshotBase64: Buffer.from(currentFrame).toString("base64"),
        cursorPosition: { x: 0, y: 0 },
      };
    },
    async execute(actions) {
      executed.push(
        ...actions.map((action) => ({
          kind: action.kind,
          frame: currentFrame,
        })),
      );
    },
    async close() {},
  };
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => viewer,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);

  const cases = [
    { kind: "click", coordinate: { x: 10, y: 20 } },
    {
      kind: "drag",
      path: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    },
    { kind: "type", text: "frame-bound text" },
    { kind: "key", key: "ENTER" },
  ];
  for (const action of cases) {
    currentFrame = `${action.kind}-A`;
    const staleAction = core.executeSeatActions("employee-one", [action]);
    const stalePending = await waitFor(
      () => core.pendingApprovalForSeat("employee-one"),
      `${action.kind} stale approval`,
    );
    assert.deepEqual(Object.keys(stalePending.frame).sort(), [
      "generation",
      "screenshotBase64",
      "sequence",
      "sha256",
    ]);
    assert.equal(
      stalePending.frame.screenshotBase64,
      Buffer.from(currentFrame).toString("base64"),
    );
    if (action.kind === "click") {
      assert.throws(
        () =>
          core.decidePendingApproval("employee-one", "allow-once", {
            requestId: stalePending.requestId,
            seatId: stalePending.seatId,
            origin: stalePending.origin,
            actionDigest: stalePending.actionDigest,
          }),
        (error) => error?.code === "APPROVAL_FRAME_NOT_PRESENTED",
      );
      const mismatched = presentedApproval(stalePending);
      mismatched.presentedFrame.sha256 = "0".repeat(64);
      assert.throws(
        () =>
          core.decidePendingApproval("employee-one", "allow-once", mismatched),
        (error) => error?.code === "APPROVAL_FRAME_MISMATCH",
      );
      assert.equal(
        core.pendingApprovalForSeat("employee-one").requestId,
        stalePending.requestId,
      );
    }
    let pending = stalePending;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (action.kind === "key" && attempt === 0) {
        currentFrame = "key-intermediate";
        await core.captureSeat("employee-one");
        currentFrame = "key-A";
      } else {
        currentFrame = `${action.kind}-drift-${attempt + 1}`;
      }
      const previousRequestId = pending.requestId;
      assert.equal(
        core.decidePendingApproval(
          "employee-one",
          "allow-once",
          presentedApproval(pending),
        ),
        true,
      );
      if (attempt < 2)
        pending = await waitFor(
          () => {
            const refreshed = core.pendingApprovalForSeat("employee-one");
            return refreshed?.requestId !== previousRequestId
              ? refreshed
              : null;
          },
          `${action.kind} bounded stale retry ${attempt + 2}`,
        );
    }
    await assert.rejects(
      staleAction,
      (error) => error?.code === "ACTION_APPROVAL_STALE",
    );
    assert.equal(
      executed.some((item) => item.kind === action.kind),
      false,
      action.kind,
    );
    assert.equal(core.status().ready, true);

    const retry = core.executeSeatActions("employee-one", [action]);
    const retryPending = await waitFor(
      () => core.pendingApprovalForSeat("employee-one"),
      `${action.kind} refreshed approval`,
    );
    assert.notEqual(retryPending.actionDigest, stalePending.actionDigest);
    assert.equal(
      core.decidePendingApproval(
        "employee-one",
        "allow-once",
        presentedApproval(retryPending),
      ),
      true,
    );
    await retry;
    assert.deepEqual(executed.at(-1), {
      kind: action.kind,
      frame: currentFrame,
    });
  }
});

test("official approvals tolerate only tiny keyboard drift, keep pointer actions exact, and preserve automatic CTRL+L", async (t) => {
  const stateDir = tempState(t);
  const baseFrame = rgbPng(1280, 800, [], 4);
  const tinyDriftFrame = rgbPng(1280, 800, [{ x: 5, y: 6 }], 1);
  const cursorDriftFrame = rgbPng(
    1280,
    800,
    Array.from({ length: 100 }, (_, pixel) => ({
      x: 640 + (pixel % 10),
      y: 400 + Math.floor(pixel / 10),
    })),
    3,
  );
  const materialDriftFrame = rgbPng(
    1280,
    800,
    Array.from({ length: 100 }, (_, pixel) => ({
      x: pixel % 10,
      y: 12 + Math.floor(pixel / 10),
    })),
    2,
  );
  let currentFrame = baseFrame;
  const executed = [];
  const viewer = {
    async capture() {
      return {
        screenshotBase64: currentFrame,
        cursorPosition: { x: 640, y: 400 },
      };
    },
    async execute(actions) {
      executed.push(...actions.map((action) => action.kind));
    },
    async close() {},
  };
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => viewer,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);

  const typed = core.executeSeatActions("employee-one", [
    { kind: "type", text: "safe keyboard drift" },
  ]);
  const typeApproval = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "type approval",
  );
  currentFrame = tinyDriftFrame;
  assert.equal(
    core.decidePendingApproval(
      "employee-one",
      "allow-once",
      presentedApproval(typeApproval),
    ),
    true,
  );
  await typed;
  assert.deepEqual(executed, ["type"]);
  assert.equal(core.pendingApprovalForSeat("employee-one"), null);

  currentFrame = baseFrame;
  const cursorKeyed = core.executeSeatActions("employee-one", [
    { kind: "key", key: "META" },
  ]);
  const cursorKeyApproval = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "key approval before cursor drift",
  );
  currentFrame = cursorDriftFrame;
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(cursorKeyApproval),
  );
  await cursorKeyed;
  assert.deepEqual(executed, ["type", "key"]);

  currentFrame = baseFrame;
  const keyed = core.executeSeatActions("employee-one", [
    { kind: "key", key: "ENTER" },
  ]);
  const keyApprovalA = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "key approval before material drift",
  );
  currentFrame = materialDriftFrame;
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(keyApprovalA),
  );
  const keyApprovalB = await waitFor(() => {
    const pending = core.pendingApprovalForSeat("employee-one");
    return pending?.requestId !== keyApprovalA.requestId ? pending : null;
  }, "fresh key approval after material drift");
  assert.deepEqual(executed, ["type", "key"]);
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(keyApprovalB),
  );
  await keyed;
  assert.deepEqual(executed, ["type", "key", "key"]);

  currentFrame = baseFrame;
  const clicked = core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 10, y: 20 } },
  ]);
  const clickApprovalA = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "click approval before tiny drift",
  );
  currentFrame = tinyDriftFrame;
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(clickApprovalA),
  );
  const clickApprovalB = await waitFor(() => {
    const pending = core.pendingApprovalForSeat("employee-one");
    return pending?.requestId !== clickApprovalA.requestId ? pending : null;
  }, "fresh click approval after tiny drift");
  assert.deepEqual(executed, ["type", "key", "key"]);
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(clickApprovalB),
  );
  await clicked;
  assert.deepEqual(executed, ["type", "key", "key", "click"]);

  currentFrame = baseFrame;
  await core.executeSeatActions("employee-one", [
    { kind: "key", key: "CTRL+L" },
  ]);
  assert.deepEqual(executed, ["type", "key", "key", "click", "key"]);
  assert.equal(core.pendingApprovalForSeat("employee-one"), null);
});

test("stale frames require fresh approval and honor every stop control", async (t) => {
  const stateDir = tempState(t);
  const captures = [];
  const executed = [];
  let currentFrame = "frame-A";
  let actionClock = FIXED_NOW;
  const viewer = {
    async capture() {
      captures.push(currentFrame);
      return {
        screenshotBase64: Buffer.from(currentFrame).toString("base64"),
        cursorPosition: { x: 0, y: 0 },
      };
    },
    async execute(actions) {
      executed.push({ kind: actions[0].kind, frame: currentFrame });
    },
    async close() {},
  };
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    actionNow: () => actionClock,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => viewer,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);

  const action = core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 10, y: 20 } },
  ]);
  const frameAApproval = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "frame A approval",
  );
  currentFrame = "frame-B";
  assert.equal(
    core.decidePendingApproval(
      "employee-one",
      "allow-once",
      presentedApproval(frameAApproval),
    ),
    true,
  );

  const frameBApproval = await waitFor(() => {
    const pending = core.pendingApprovalForSeat("employee-one");
    return pending?.requestId !== frameAApproval.requestId ? pending : null;
  }, "fresh frame B approval");
  assert.equal(
    frameBApproval.frame.sequence > frameAApproval.frame.sequence,
    true,
  );
  assert.equal(
    frameBApproval.frame.screenshotBase64,
    Buffer.from("frame-B").toString("base64"),
  );
  assert.notEqual(frameBApproval.actionDigest, frameAApproval.actionDigest);
  assert.deepEqual(executed, []);
  assert.equal(
    core.decidePendingApproval(
      "employee-one",
      "allow-once",
      presentedApproval(frameBApproval),
    ),
    true,
  );
  await action;
  assert.deepEqual(executed, [{ kind: "click", frame: "frame-B" }]);
  assert.deepEqual(captures, [
    "frame-A",
    "frame-B",
    "frame-B",
    "frame-B",
    "frame-B",
  ]);

  currentFrame = "deny-A";
  const denied = core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 30, y: 40 } },
  ]);
  const denyA = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "deny frame A approval",
  );
  currentFrame = "deny-B";
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(denyA),
  );
  const denyB = await waitFor(() => {
    const pending = core.pendingApprovalForSeat("employee-one");
    return pending?.requestId !== denyA.requestId ? pending : null;
  }, "deny frame B approval");
  assert.equal(
    core.decidePendingApproval("employee-one", "deny", {
      requestId: denyB.requestId,
      seatId: denyB.seatId,
      origin: denyB.origin,
      actionDigest: denyB.actionDigest,
    }),
    true,
  );
  await assert.rejects(
    denied,
    (error) => error?.code === "ACTION_NOT_APPROVED",
  );
  assert.deepEqual(executed, [{ kind: "click", frame: "frame-B" }]);

  currentFrame = "takeover-A";
  const interrupted = core.executeSeatActions("employee-one", [
    { kind: "key", key: "ENTER" },
  ]);
  const takeoverA = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "takeover frame A approval",
  );
  currentFrame = "takeover-B";
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(takeoverA),
  );
  const takeoverB = await waitFor(() => {
    const pending = core.pendingApprovalForSeat("employee-one");
    return pending?.requestId !== takeoverA.requestId ? pending : null;
  }, "takeover frame B approval");
  assert.equal(takeoverB.frame.screenshotBase64.length > 0, true);
  const takeover = core.acquireUserControl(
    "employee-one",
    "trusted-view-owner-retry-test",
  );
  await assert.rejects(
    interrupted,
    (error) => error?.code === "ACTION_INTERRUPTED",
  );
  await takeover;
  assert.equal(
    core.releaseUserControl("employee-one", "trusted-view-owner-retry-test"),
    true,
  );
  assert.deepEqual(executed, [{ kind: "click", frame: "frame-B" }]);

  currentFrame = "deadline-A";
  const expired = core.executeSeatActions("employee-one", [
    { kind: "type", text: "must-not-run" },
  ]);
  const deadlineA = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "deadline frame A approval",
  );
  currentFrame = "deadline-B";
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(deadlineA),
  );
  const deadlineB = await waitFor(() => {
    const pending = core.pendingApprovalForSeat("employee-one");
    return pending?.requestId !== deadlineA.requestId ? pending : null;
  }, "deadline frame B approval");
  actionClock = FIXED_NOW + MAX_ACTION_BATCH_RUNTIME_MS;
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(deadlineB),
  );
  await assert.rejects(
    expired,
    (error) => error?.code === "ACTION_DEADLINE_EXCEEDED",
  );
  assert.deepEqual(executed, [{ kind: "click", frame: "frame-B" }]);
});

test("each mutating primitive receives a fresh displayed-frame approval", async (t) => {
  const stateDir = tempState(t);
  const executed = [];
  let currentFrame = "frame-A";
  const viewer = {
    async capture() {
      return {
        screenshotBase64: Buffer.from(currentFrame).toString("base64"),
        cursorPosition: { x: 0, y: 0 },
      };
    },
    async execute(actions) {
      const action = actions[0];
      executed.push({ kind: action.kind, frame: currentFrame });
      if (action.kind === "click") currentFrame = "frame-B";
    },
    async close() {},
  };
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => viewer,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);

  const batch = core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 10, y: 20 } },
    { kind: "wait", durationMs: 1 },
    { kind: "type", text: "must-use-frame-B" },
  ]);
  const clickApproval = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "click approval",
  );
  assert.equal(
    clickApproval.frame.screenshotBase64,
    Buffer.from("frame-A").toString("base64"),
  );
  assert.equal(clickApproval.presentation.actions.length, 1);
  assert.equal(
    core.decidePendingApproval(
      "employee-one",
      "allow-once",
      presentedApproval(clickApproval),
    ),
    true,
  );

  const typeApproval = await waitFor(() => {
    const pending = core.pendingApprovalForSeat("employee-one");
    return pending?.requestId !== clickApproval.requestId ? pending : null;
  }, "fresh type approval");
  assert.deepEqual(executed, [
    { kind: "click", frame: "frame-A" },
    { kind: "wait", frame: "frame-B" },
  ]);
  assert.equal(
    typeApproval.frame.screenshotBase64,
    Buffer.from("frame-B").toString("base64"),
  );
  assert.equal(typeApproval.presentation.actions.length, 1);
  assert.equal(
    core.decidePendingApproval(
      "employee-one",
      "allow-once",
      presentedApproval(typeApproval),
    ),
    true,
  );
  await batch;
  assert.deepEqual(executed.at(-1), {
    kind: "type",
    frame: "frame-B",
  });
});

test("takeover fences an in-flight agent batch before the next primitive", async (t) => {
  const stateDir = tempState(t);
  const executed = [];
  let releaseWaitStarted;
  const waitStarted = new Promise((resolve) => {
    releaseWaitStarted = resolve;
  });
  const viewer = {
    async capture() {
      return { screenshotBase64: "cG5n", cursorPosition: { x: 0, y: 0 } };
    },
    async execute(actions, options) {
      const action = actions[0];
      executed.push(action.kind);
      if (action.kind !== "wait") return;
      releaseWaitStarted();
      while (true) {
        options.assertContinue();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async close() {},
  };
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => viewer,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);

  const agent = core.executeSeatActions("employee-one", [
    { kind: "click", coordinate: { x: 1, y: 1 } },
    { kind: "wait", durationMs: 1000 },
    { kind: "screenshot" },
  ]);
  const pending = await waitFor(
    () => core.pendingApprovalForSeat("employee-one"),
    "batch approval",
  );
  core.decidePendingApproval(
    "employee-one",
    "allow-once",
    presentedApproval(pending),
  );
  await waitStarted;
  const takeover = core.acquireUserControl(
    "employee-one",
    "trusted-view-owner-0001",
  );
  await assert.rejects(agent, (error) => error?.code === "ACTION_INTERRUPTED");
  await takeover;
  assert.deepEqual(executed, ["click", "wait"]);
  assert.equal(core.status().ready, true);
});

test("a short helper deadline races a hung primitive and prevents the later primitive", async (t) => {
  const stateDir = tempState(t);
  const executed = [];
  let closeCount = 0;
  const viewer = {
    async capture() {
      return { screenshotBase64: "cG5n", cursorPosition: { x: 0, y: 0 } };
    },
    async execute(actions) {
      const action = actions[0];
      executed.push(action.kind);
      if (action.kind === "click") await new Promise(() => {});
    },
    async close() {
      closeCount += 1;
    },
  };
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => viewer,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) return protoResponse(accessResponse(1));
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);
  const owner = "trusted-view-owner-0001";
  await core.acquireUserControl("employee-one", owner);
  const action = core.executeSeatActions(
    "employee-one",
    [
      { kind: "click", coordinate: { x: 1, y: 1 } },
      { kind: "type", text: "must-not-run-after-deadline" },
    ],
    {
      actor: "user",
      controlId: owner,
      deadlineMs: Date.now() + 40,
    },
  );
  await assert.rejects(
    action,
    (error) =>
      error?.code === "ACTION_OUTCOME_UNCERTAIN" &&
      /inspect the fresh screen before retrying/i.test(error.message),
  );
  assert.deepEqual(executed, ["click"]);
  assert.equal(closeCount, 1);
  assert.equal(core.status().ready, false);
});

test("logout aborts refresh and a late response cannot resurrect credentials", async (t) => {
  const stateDir = tempState(t);
  let resolveRefresh;
  let refreshStarted = false;
  const refreshResponse = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const paths = [];
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: expiredJwt(),
          refreshToken: "old-refresh-token",
        });
      if (pathname === "/oauth/token") {
        refreshStarted = true;
        return Promise.race([
          refreshResponse,
          new Promise((resolve, reject) => {
            const cancel = () => {
              const error = new Error("refresh aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (init.signal?.aborted) cancel();
            else init.signal?.addEventListener("abort", cancel, { once: true });
          }),
        ]);
      }
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());
  await core.startLogin();
  await waitFor(() => core.status().connected, "expired sign-in storage");
  const enabling = core.setMode("official", true);
  const enablingRejected = assert.rejects(
    enabling,
    (error) => error?.code === "CANCELLED",
  );
  await waitFor(() => refreshStarted, "token refresh");
  await core.logout();
  resolveRefresh(
    jsonResponse({
      access_token: futureJwt(),
      refresh_token: ["new", "refresh", "must", "not", "persist"].join("-"),
    }),
  );
  await enablingRejected;
  assert.equal(core.status().connected, false);
  assert.equal(core.status().mode, "private");
  assert.equal(fs.existsSync(path.join(stateDir, "credentials.json")), false);
  assert.equal(paths.includes(ACCESS_PATH), false);
});

test("the shared response reader enforces streaming limits without over-retaining", async () => {
  const limit = 256 * 1024;
  let earlyCancelled = false;
  await assert.rejects(
    readBoundedJsonResponse({
      headers: new Headers({ "Content-Length": String(limit + 1) }),
      body: {
        async cancel() {
          earlyCancelled = true;
        },
      },
    }),
    (error) => error?.code === "VENDOR_RESPONSE_TOO_LARGE",
  );
  assert.equal(earlyCancelled, true);

  function instrumentedResponse(declaredLength) {
    const chunks = [
      ...Array.from({ length: 4 }, () => new Uint8Array(64 * 1024).fill(0x20)),
      new Uint8Array([0x20]),
      new Uint8Array([0x20]),
    ];
    const state = { reads: 0, cancelled: false };
    return {
      state,
      response: {
        headers: new Headers(
          declaredLength == null
            ? {}
            : { "Content-Length": String(declaredLength) },
        ),
        body: {
          getReader() {
            return {
              async read() {
                const value = chunks[state.reads++];
                return value ? { done: false, value } : { done: true };
              },
              async cancel() {
                state.cancelled = true;
              },
              releaseLock() {},
            };
          },
        },
      },
    };
  }

  for (const declaredLength of [null, 1]) {
    const streamed = instrumentedResponse(declaredLength);
    await assert.rejects(
      readBoundedJsonResponse(streamed.response),
      (error) => error?.code === "VENDOR_RESPONSE_TOO_LARGE",
    );
    assert.deepEqual(
      streamed.response.headers.has("content-length"),
      declaredLength != null,
    );
    assert.equal(streamed.state.reads, 5);
    assert.equal(streamed.state.cancelled, true);
  }

  const framingBytes = Buffer.byteLength('{"padding":""}');
  const exactJson = `{"padding":"${"x".repeat(limit - framingBytes)}"}`;
  assert.equal(Buffer.byteLength(exactJson), limit);
  const exact = await readBoundedJsonResponse(new Response(exactJson));
  assert.equal(exact.padding.length, limit - framingBytes);
  assert.deepEqual(await readBoundedJsonResponse(jsonResponse({ ok: true })), {
    ok: true,
  });
  assert.equal(
    (helperSource.match(/readBoundedResponseBody\(/g) || []).length >= 3,
    true,
  );
  assert.doesNotMatch(helperSource, /response\.arrayBuffer\(\)/);
  assert.doesNotMatch(helperSource, /response\.json\(\)/);
});

test("Connect responses share the incremental cap and accept exactly one MiB", async (t) => {
  const stateDir = tempState(t);
  const connectLimit = 1024 * 1024;
  const accessPrefix = accessResponse(1);
  const paddingTag = varint((23n << 3n) | 2n);
  let paddingLength =
    connectLimit - accessPrefix.length - paddingTag.length - 3;
  while (
    accessPrefix.length +
      paddingTag.length +
      varint(paddingLength).length +
      paddingLength !==
    connectLimit
  ) {
    paddingLength -= 1;
  }
  const exactAccess = Buffer.concat([
    accessPrefix,
    paddingTag,
    varint(paddingLength),
    Buffer.alloc(paddingLength, 0x20),
  ]);
  assert.equal(exactAccess.length, connectLimit);
  let accessCalls = 0;
  let oversizeCancelled = false;
  let oversizeReads = 0;
  const core = createOfficialComputerCore({
    stateDir,
    now: () => FIXED_NOW,
    sleep: async () => {},
    protectSecret: sealed,
    unprotectSecret: unsealed,
    viewerFactory: async () => ({
      async capture() {
        return { screenshotBase64: "cG5n", cursorPosition: { x: 0, y: 0 } };
      },
      async execute() {},
      async close() {},
    }),
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/auth/poll")
        return jsonResponse({
          accessToken: futureJwt(),
          refreshToken: "refresh-token",
        });
      if (pathname === ACCESS_PATH) {
        accessCalls += 1;
        if (accessCalls === 1) return protoResponse(exactAccess);
        const chunks = [
          ...Array.from({ length: 16 }, () =>
            new Uint8Array(64 * 1024).fill(0),
          ),
          new Uint8Array([0]),
          new Uint8Array([0]),
        ];
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Length": "1" }),
          body: {
            getReader() {
              return {
                async read() {
                  const value = chunks[oversizeReads++];
                  return value ? { done: false, value } : { done: true };
                },
                async cancel() {
                  oversizeCancelled = true;
                },
                releaseLock() {},
              };
            },
          },
        };
      }
      if (pathname === ENSURE_PATH) return protoResponse(ensureResponse());
      throw new Error(`unexpected request: ${pathname}`);
    },
  });
  t.after(() => core.shutdown());

  await core.startLogin();
  await waitFor(() => core.status().connected, "official sign-in");
  await core.setMode("official", true);
  assert.equal(core.status().ready, true);
  await core.setMode("private");
  await assert.rejects(
    core.setMode("official", true),
    (error) => error?.code === "VENDOR_RESPONSE_TOO_LARGE",
  );
  assert.equal(oversizeReads, 17);
  assert.equal(oversizeCancelled, true);
});

test("VNC descriptors reject parser tricks, wake changes, and fork tokens", () => {
  const valid = { networkToken: NETWORK_TOKEN, vncUrl: buildVncUrl() };
  const descriptor = validateVncDescriptor(valid);
  assert.equal(descriptor.origin, "https://computer.vendor.example");
  assert.match(
    descriptor.webSocketUrl,
    /^wss:\/\/computer\.vendor\.example\/websockify\?/,
  );

  function changed(mutator) {
    const url = new URL(buildVncUrl());
    mutator(url);
    return { networkToken: NETWORK_TOKEN, vncUrl: url.toString() };
  }

  const rejected = [
    {
      networkToken: "token with spaces 123",
      vncUrl: buildVncUrl("token with spaces 123"),
    },
    {
      networkToken: NETWORK_TOKEN,
      vncUrl: buildVncUrl().replace("https:", "http:"),
    },
    changed((url) => (url.port = "444")),
    changed((url) => (url.hash = "ignored")),
    changed((url) => (url.pathname = "/viewer.html")),
    changed((url) => url.searchParams.append("network_token", NETWORK_TOKEN)),
    changed((url) => url.searchParams.set("resume_lower_s", "899")),
    changed((url) => url.searchParams.set("extra", "1")),
    changed((url) =>
      url.searchParams.set(
        "path",
        `${url.searchParams.get("path")}&token=fork-token-must-be-rejected`,
      ),
    ),
    changed((url) =>
      url.searchParams.set(
        "path",
        url.searchParams
          .get("path")
          .replace(NETWORK_TOKEN, "different-network-token"),
      ),
    ),
    changed((url) =>
      url.searchParams.set(
        "path",
        `\\websockify?network_token=${NETWORK_TOKEN}`,
      ),
    ),
    { networkToken: NETWORK_TOKEN, vncUrl: ` ${buildVncUrl()}` },
  ];
  for (const candidate of rejected)
    assert.throws(
      () => validateVncDescriptor(candidate),
      (error) => error?.code === "INVALID_VNC_DESCRIPTOR",
    );
});

test("the local noVNC starter waits for its module before invoking RFB", async () => {
  const calls = [];
  let moduleReady = false;
  let releaseModule;
  const moduleLoaded = new Promise((resolve) => {
    releaseModule = resolve;
  });
  const page = {
    async waitForFunction(predicate, argument, options) {
      calls.push("wait");
      assert.equal(typeof predicate, "function");
      assert.equal(argument, null);
      assert.deepEqual(options, { timeout: 15000 });
      await moduleLoaded;
      moduleReady = true;
    },
    async evaluate(starter, relayUrl) {
      calls.push("start");
      assert.equal(typeof starter, "function");
      assert.equal(moduleReady, true);
      assert.equal(relayUrl, "ws://127.0.0.1:43111/rfb/session");
    },
  };

  const starting = startNoVncViewer(page, "ws://127.0.0.1:43111/rfb/session");
  await Promise.resolve();
  assert.deepEqual(calls, ["wait"]);
  releaseModule();
  await starting;
  assert.deepEqual(calls, ["wait", "start"]);
});

test("pinned noVNC is hardened for clipboard, framebuffer, direct RFB input, and verification", () => {
  const noVncSource = fs.readFileSync(require.resolve("@novnc/novnc"), "utf8");
  const hardened = hardenNoVncSource("core/rfb.js", noVncSource);
  const clipboard = hardened.slice(
    hardened.indexOf("    _handleServerCutText() {"),
    hardened.indexOf("    _handleServerFenceMsg() {"),
  );
  assert.match(clipboard, /Server clipboard payload exceeds the safety limit/);
  assert.match(clipboard, /rQskipBytes\(Math\.abs\(length\)\)/);
  assert.doesNotMatch(clipboard, /dispatchEvent|Inflator|extendedClipboard/);
  assert.match(hardened, /Framebuffer dimensions exceed the safety limit/);
  assert.match(hardened, /width > 4096/);
  assert.match(hardened, /height > 2160/);

  assert.equal(unicodeKeysymForCodePoint("A".codePointAt(0)), 0x41);
  assert.equal(unicodeKeysymForCodePoint("é".codePointAt(0)), 0xe9);
  assert.equal(unicodeKeysymForCodePoint("🙂".codePointAt(0)), 0x0101f642);
  assert.equal(unicodeKeysymForCodePoint(0x0a), 0xff0d);
  assert.equal(unicodeKeysymForCodePoint(0x09), 0xff09);
  assert.match(helperSource, /__officialVncType/);
  assert.match(helperSource, /rfb\.sendKey\(keysym,null,true\)/);
  assert.match(helperSource, /rfb\.sendKey\(keysym,null,false\)/);
  assert.match(helperSource, /__officialVncKey/);
  assert.match(helperSource, /sendRfbKeyChord\(rfb,state\.phase,chord\)/);
  assert.match(helperSource, /serververification/);
  assert.match(helperSource, /state\.detail="server-verification"/);
  assert.doesNotMatch(
    helperSource,
    /canvas\.click\(\{ position: \{ x: 4, y: 4 \} \}\)/,
  );
  assert.doesNotMatch(helperSource, /page\.keyboard\.(?:press|down|up)/);
  assert.doesNotMatch(helperSource, /await canvas\.focus\(\)/);
  assert.match(helperSource, /finally \{[\s\S]*?page\.mouse\.up/);
});

test("CTRL+L is sent as an exact direct-RFB chord and held keys are always released", () => {
  const chord = rfbKeyChord("CTRL+L");
  assert.deepEqual(chord, [
    { keysym: 0xffe3, code: "ControlLeft" },
    { keysym: 0x6c, code: "KeyL" },
  ]);
  const calls = [];
  sendRfbKeyChord(
    {
      sendKey(keysym, code, down) {
        calls.push({ keysym, code, down });
      },
    },
    "connected",
    chord,
  );
  assert.deepEqual(calls, [
    { keysym: 0xffe3, code: "ControlLeft", down: true },
    { keysym: 0x6c, code: "KeyL", down: true },
    { keysym: 0x6c, code: "KeyL", down: false },
    { keysym: 0xffe3, code: "ControlLeft", down: false },
  ]);

  const interrupted = [];
  assert.throws(
    () =>
      sendRfbKeyChord(
        {
          sendKey(keysym, code, down) {
            interrupted.push({ keysym, code, down });
            if (keysym === 0x6c && down) throw new Error("send failed");
          },
        },
        "connected",
        chord,
      ),
    /send failed/,
  );
  assert.deepEqual(interrupted.slice(-2), [
    { keysym: 0x6c, code: "KeyL", down: false },
    { keysym: 0xffe3, code: "ControlLeft", down: false },
  ]);
});

test("direct-RFB key parsing accepts only exact DOM Arrow aliases while Meta and Cmd remain explicit chords", () => {
  assert.deepEqual(rfbKeyChord("META+L"), [
    { keysym: 0xffeb, code: "MetaLeft" },
    { keysym: 0x6c, code: "KeyL" },
  ]);
  assert.deepEqual(rfbKeyChord("CMD+L"), rfbKeyChord("META+L"));
  assert.deepEqual(rfbKeyChord("SHIFT+TAB"), [
    { keysym: 0xffe1, code: "ShiftLeft" },
    { keysym: 0xff09, code: "Tab" },
  ]);
  assert.deepEqual(rfbKeyChord("ArrowLeft"), [
    { keysym: 0xff51, code: "ArrowLeft" },
  ]);
  assert.deepEqual(rfbKeyChord("ArrowUp"), [
    { keysym: 0xff52, code: "ArrowUp" },
  ]);
  assert.deepEqual(rfbKeyChord("ArrowRight"), [
    { keysym: 0xff53, code: "ArrowRight" },
  ]);
  assert.deepEqual(rfbKeyChord("ArrowDown"), [
    { keysym: 0xff54, code: "ArrowDown" },
  ]);
  for (const invalid of [
    "",
    "CTRL+CTRL+L",
    "Arrow",
    "ArrowDiagonal",
    "ArrowDownExtra",
    "L+CTRL",
    "CTRL+UnknownNamedKey",
    "CTRL++L",
    "CTRL +L",
  ])
    assert.throws(
      () => rfbKeyChord(invalid),
      (error) => error?.code === "INVALID_ACTIONS",
      invalid,
    );
});

test("the child environment is scrubbed of Codex and vendor credentials", () => {
  const canaries = {
    OPENAI_API_KEY: "openai-canary",
    CLIPROXY_API_KEY: "cliproxy-canary",
    CURSOR_ACCESS_TOKEN: "cursor-canary",
    XAI_API_KEY: "xai-canary",
    GROK_BOT_BROWSER_EXECUTABLE: "C:\\safe-browser\\chrome.exe",
  };
  const previous = Object.fromEntries(
    Object.keys(canaries).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, canaries);
    const env = officialClient.helperEnvironment();
    for (const key of [
      "OPENAI_API_KEY",
      "CLIPROXY_API_KEY",
      "CURSOR_ACCESS_TOKEN",
      "XAI_API_KEY",
    ])
      assert.equal(Object.hasOwn(env, key), false, key);
    assert.equal(
      env.CODEX_OFFICIAL_CHROME,
      canaries.GROK_BOT_BROWSER_EXECUTABLE,
    );
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.NODE_ENV, "production");
    assert.match(env.CODEX_OFFICIAL_COMPUTER_STATE, /official-computer$/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a short client timeout kills the helper before a later primitive can run", async () => {
  const childKey = Symbol.for("codexbot.officialComputer.child");
  const originalFork = childProcess.fork;
  const originalTimeout = process.env.CODEX_OFFICIAL_INPUT_TIMEOUT_MS;
  const originalState = globalThis[childKey];
  const cachedClient = require.cache[clientPath];
  const executed = [];
  let fakeChild;
  let shortClient;

  class FakeHelperChild extends EventEmitter {
    constructor() {
      super();
      this.connected = true;
      this.killed = false;
      this.channel = { ref() {}, unref() {} };
    }

    ref() {}
    unref() {}

    send(message, callback) {
      callback?.();
      if (message?.method !== "input.send") return;
      executed.push(message.args.actions[0].kind);
      setTimeout(() => {
        if (!this.killed) executed.push(message.args.actions[1].kind);
      }, 80);
    }

    kill() {
      this.killed = true;
      this.connected = false;
      queueMicrotask(() => this.emit("exit", 1, "SIGTERM"));
      return true;
    }

    disconnect() {
      this.connected = false;
    }
  }

  try {
    process.env.CODEX_OFFICIAL_INPUT_TIMEOUT_MS = "40";
    delete require.cache[clientPath];
    delete globalThis[childKey];
    childProcess.fork = () => {
      fakeChild = new FakeHelperChild();
      queueMicrotask(() => fakeChild.emit("spawn"));
      return fakeChild;
    };
    shortClient = require(clientPath);
    assert.equal(shortClient.INPUT_REQUEST_TIMEOUT_MS, 40);
    await assert.rejects(
      shortClient.executeSeatActions("employee-one", [
        { kind: "click", coordinate: { x: 1, y: 1 } },
        { kind: "type", text: "must-not-run" },
      ]),
      (error) =>
        error?.code === "ACTION_OUTCOME_UNCERTAIN" &&
        /inspect the fresh screen before retrying/i.test(error.message),
    );
    assert.equal(fakeChild.killed, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(executed, ["click"]);
  } finally {
    childProcess.fork = originalFork;
    if (originalTimeout == null)
      delete process.env.CODEX_OFFICIAL_INPUT_TIMEOUT_MS;
    else process.env.CODEX_OFFICIAL_INPUT_TIMEOUT_MS = originalTimeout;
    delete require.cache[clientPath];
    if (cachedClient) require.cache[clientPath] = cachedClient;
    if (originalState === undefined) delete globalThis[childKey];
    else globalThis[childKey] = originalState;
  }
});

test("an idle helper IPC channel does not keep its parent process alive", (t) => {
  const stateRoot = tempState(t);
  const script = `require(${JSON.stringify(clientPath)}).status().then((status)=>{if(status.mode!=="private")process.exitCode=2;}).catch(()=>{process.exitCode=3;});`;
  const result = childProcess.spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    env: { ...process.env, CODEX_BOT_STATE_ROOT: stateRoot },
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
  });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
