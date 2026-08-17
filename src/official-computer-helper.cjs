"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");
const { chromium } = require("playwright-core");
const { WebSocket, WebSocketServer } = require("ws");
const { resolvePublicAddresses } = require(
  path.join(__dirname, "browser-seats", "public-web-proxy.cjs"),
);
const { BrowserActionApprovalCoordinator } = require(
  path.join(__dirname, "browser-seats", "browser-action-approval.cjs"),
);
const { BrowserControlLeaseCoordinator } = require(
  path.join(__dirname, "browser-seats", "browser-control-lease.cjs"),
);
const { CHROMIUM_HARDENING_ARGS, installBrowserPageHardening } = require(
  path.join(__dirname, "browser-seats", "browser-page-hardening.cjs"),
);

const API_ORIGIN = "https://api2.cursor.sh";
const LOGIN_ORIGIN = "https://cursor.com";
const LOGIN_PATH = "/loginDeepControl";
const AUTH_POLL_PATH = "/auth/poll";
const TOKEN_REFRESH_PATH = "/oauth/token";
const ACCESS_PATH = "/aiserver.v1.DashboardService/GetSandAccessStatus";
const ENSURE_PATH = "/aiserver.v1.GrokBotService/EnsureSandBox";
const AUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const VENDOR_CLIENT_VERSION = "0.18.0";
const CONFIG_VERSION = 1;
const PERMISSION_VERSION = 1;
const OFFICIAL_PERMISSION_PROVIDER = "official-grok-cloud";
const MAX_CONNECT_RESPONSE_BYTES = 1024 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_WAIT_ACTION_MS = 10 * 1000;
const ACTION_STEP_BUDGET_MS = 250;
const MAX_DECLARED_ACTION_BUDGET_MS = 30 * 1000;
const MAX_ACTION_BATCH_RUNTIME_MS = 90 * 1000;
const MAX_STALE_APPROVAL_ATTEMPTS = 3;
const OFFICIAL_ACTION_APPROVAL_TTL_MS = 30 * 1000;
const MAX_DRIFT_COMPARISON_PNG_BYTES = 8 * 1024 * 1024;
const MAX_IMMATERIAL_DRIFT_PIXELS = 256;
const IMMATERIAL_DRIFT_PIXEL_DIVISOR = 4096;
const MAX_IMMATERIAL_DRIFT_EDGE = 48;
const MAX_IMMATERIAL_DRIFT_AREA = 1024;
const OFFICIAL_RETRY_BASE_MS = 2 * 1000;
const OFFICIAL_RETRY_MAX_MS = 60 * 1000;
const OFFICIAL_RETRY_MAX_ATTEMPT = 32;
const WIDTH = 1280;
const HEIGHT = 800;
const SHARED_CONTROL_SEAT = "official-cloud-primary";
const MUTATING_ACTIONS = new Set(["click", "drag", "type", "key"]);
const NON_RECOVERABLE_VIEWER_CODES = new Set([
  "CANCELLED",
  "SESSION_CHANGED",
  "OFFICIAL_SIGN_IN_PENDING",
  "OFFICIAL_SIGN_IN_REQUIRED",
  "OFFICIAL_MODE_DISABLED",
]);
const CHROME_CANDIDATES = [
  process.env.CODEX_OFFICIAL_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA &&
    path.join(
      process.env.LOCALAPPDATA,
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class OfficialComputerError extends Error {
  constructor(message, code = "OFFICIAL_COMPUTER_ERROR", statusCode = 500) {
    super(message);
    this.name = "OfficialComputerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactPresentedFrameBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "generation,sequence,sha256")
    return null;
  const generation = Number(value.generation);
  const sequence = Number(value.sequence);
  const sha256 = String(value.sha256 || "");
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    return null;
  return Object.freeze({ generation, sequence, sha256 });
}

function sameFrameBinding(left, right) {
  return (
    left?.generation === right?.generation &&
    left?.sequence === right?.sequence &&
    left?.sha256 === right?.sha256
  );
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance)
    return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeTrustedChromiumPng(png) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (
    !Buffer.isBuffer(png) ||
    png.length < 45 ||
    png.length > MAX_DRIFT_COMPARISON_PNG_BYTES ||
    !png.subarray(0, 8).equals(signature)
  )
    throw new Error("Unsupported approval framebuffer PNG.");

  let offset = 8;
  let header = null;
  let sawEnd = false;
  const compressed = [];
  let compressedLength = 0;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > png.length)
      throw new Error("Truncated approval framebuffer PNG.");
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IHDR") {
      if (header || length !== 13 || offset !== 8)
        throw new Error("Invalid approval framebuffer PNG header.");
      const width = png.readUInt32BE(dataStart);
      const height = png.readUInt32BE(dataStart + 4);
      const bitDepth = png[dataStart + 8];
      const colorType = png[dataStart + 9];
      const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
      if (
        width < 1 ||
        height < 1 ||
        width * height > WIDTH * HEIGHT ||
        bitDepth !== 8 ||
        !channels ||
        png[dataStart + 10] !== 0 ||
        png[dataStart + 11] !== 0 ||
        png[dataStart + 12] !== 0
      )
        throw new Error("Unsupported approval framebuffer PNG format.");
      header = { width, height, channels };
    } else if (type === "IDAT") {
      if (!header || sawEnd)
        throw new Error("Invalid approval framebuffer PNG data.");
      compressedLength += length;
      if (compressedLength > MAX_DRIFT_COMPARISON_PNG_BYTES)
        throw new Error("Approval framebuffer PNG data is too large.");
      compressed.push(png.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (!header || length !== 0 || !compressed.length)
        throw new Error("Invalid approval framebuffer PNG ending.");
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }
  if (!header || !sawEnd || offset !== png.length)
    throw new Error("Incomplete approval framebuffer PNG.");

  const stride = header.width * header.channels;
  const encodedLength = (stride + 1) * header.height;
  const encoded = zlib.inflateSync(Buffer.concat(compressed), {
    maxOutputLength: encodedLength,
  });
  if (encoded.length !== encodedLength)
    throw new Error("Invalid approval framebuffer pixel length.");
  const pixels = Buffer.allocUnsafe(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const encodedRow = y * (stride + 1);
    const outputRow = y * stride;
    const filter = encoded[encodedRow];
    if (filter > 4)
      throw new Error("Unsupported approval framebuffer PNG filter.");
    for (let x = 0; x < stride; x += 1) {
      const raw = encoded[encodedRow + 1 + x];
      const left =
        x >= header.channels ? pixels[outputRow + x - header.channels] : 0;
      const above = y > 0 ? pixels[outputRow + x - stride] : 0;
      const upperLeft =
        y > 0 && x >= header.channels
          ? pixels[outputRow + x - stride - header.channels]
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upperLeft);
      pixels[outputRow + x] = (raw + predictor) & 0xff;
    }
  }
  return { ...header, pixels };
}

function trustedFrameCursor(frame) {
  const value = frame?.cursorPosition || frame?.cursor;
  const x = Number(value?.x);
  const y = Number(value?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function immaterialKeyboardFrameDrift(
  approvedPng,
  currentPng,
  approvedCursor,
  currentCursor,
) {
  let approved;
  let current;
  try {
    approved = decodeTrustedChromiumPng(approvedPng);
    current = decodeTrustedChromiumPng(currentPng);
  } catch {
    return false;
  }
  if (
    approved.width !== current.width ||
    approved.height !== current.height ||
    approved.channels !== current.channels
  )
    return false;
  const pixelCount = approved.width * approved.height;
  const changedLimit = Math.max(
    1,
    Math.min(
      MAX_IMMATERIAL_DRIFT_PIXELS,
      Math.floor(pixelCount / IMMATERIAL_DRIFT_PIXEL_DIVISOR),
    ),
  );
  let changed = 0;
  let minX = approved.width;
  let minY = approved.height;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * approved.channels;
    let differs = false;
    for (let channel = 0; channel < approved.channels; channel += 1) {
      if (
        approved.pixels[offset + channel] !== current.pixels[offset + channel]
      ) {
        differs = true;
        break;
      }
    }
    if (!differs) continue;
    changed += 1;
    if (changed > changedLimit) return false;
    const x = pixel % approved.width;
    const y = Math.floor(pixel / approved.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (changed === 0) return true;
  const changedWidth = maxX - minX + 1;
  const changedHeight = maxY - minY + 1;
  const bounded =
    changedWidth <= MAX_IMMATERIAL_DRIFT_EDGE &&
    changedHeight <= MAX_IMMATERIAL_DRIFT_EDGE &&
    changedWidth * changedHeight <= MAX_IMMATERIAL_DRIFT_AREA;
  if (!bounded) return false;
  const caretLike = changedWidth <= 4;
  const cursorLike =
    approvedCursor &&
    currentCursor &&
    approvedCursor.x === currentCursor.x &&
    approvedCursor.y === currentCursor.y &&
    minX >= approvedCursor.x - 16 &&
    maxX <= approvedCursor.x + 48 &&
    minY >= approvedCursor.y - 16 &&
    maxY <= approvedCursor.y + 48;
  return Boolean(caretLike || cursorLike);
}

function frameStillMatchesApprovedAction(action, approved, current) {
  if (sameFrameBinding(approved?.binding, current?.binding)) return true;
  if (
    approved?.binding?.generation !== current?.binding?.generation ||
    !["key", "type"].includes(action?.kind)
  )
    return false;
  const approvedCursor = trustedFrameCursor(approved?.frame);
  const currentCursor = trustedFrameCursor(current?.frame);
  return immaterialKeyboardFrameDrift(
    Buffer.from(String(approved?.frame?.screenshotBase64 || ""), "base64"),
    Buffer.from(String(current?.frame?.screenshotBase64 || ""), "base64"),
    approvedCursor,
    currentCursor,
  );
}

function safeError(error) {
  if (error instanceof OfficialComputerError) return error;
  const code = String(error?.code || "");
  if (code === "ABORT_ERR" || error?.name === "AbortError") {
    return new OfficialComputerError(
      "The official computer request was cancelled.",
      "CANCELLED",
      409,
    );
  }
  return new OfficialComputerError(
    "The official cloud computer request failed.",
    "OFFICIAL_COMPUTER_ERROR",
    502,
  );
}

function cancelledError() {
  return new OfficialComputerError(
    "The official computer request was cancelled.",
    "CANCELLED",
    409,
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function isCredentialToken(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= MAX_CREDENTIAL_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

async function readBoundedResponseBody(
  response,
  maxBytes,
  limitMessage,
  signal,
) {
  const tooLarge = () =>
    new OfficialComputerError(limitMessage, "VENDOR_RESPONSE_TOO_LARGE", 502);
  const declaredValue = response.headers.get("content-length");
  const declared = declaredValue == null ? null : Number(declaredValue);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw tooLarge();
  }
  throwIfAborted(signal);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const item = await reader.read();
      throwIfAborted(signal);
      if (item.done) break;
      const value =
        item.value instanceof Uint8Array
          ? item.value
          : new Uint8Array(item.value);
      if (value.byteLength > maxBytes - length) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
      length += value.byteLength;
    }
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function readBoundedJsonResponse(response, signal) {
  const body = await readBoundedResponseBody(
    response,
    MAX_AUTH_RESPONSE_BYTES,
    "The vendor authentication response exceeded the safety limit.",
    signal,
  );
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function createCursorChecksum(machineId, now = Date.now) {
  const unixKiloSeconds = Math.floor(now() / 1e6);
  const bytes = new Uint8Array([
    (unixKiloSeconds >> 40) & 255,
    (unixKiloSeconds >> 32) & 255,
    (unixKiloSeconds >> 24) & 255,
    (unixKiloSeconds >> 16) & 255,
    (unixKiloSeconds >> 8) & 255,
    unixKiloSeconds & 255,
  ]);
  let lastByte = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (bytes[index] ^ lastByte) + (index % 256);
    lastByte = bytes[index];
  }
  return `${base64url(bytes)}${machineId}`;
}

function parseJwtPayload(token) {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return null;
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function tokenNeedsRefresh(token, now = Date.now) {
  const exp = Number(parseJwtPayload(token)?.exp);
  return !Number.isFinite(exp) || exp * 1000 - now() < 5 * 60 * 1000;
}

function powershellDataProtection(script, input) {
  if (!fs.existsSync(WINDOWS_POWERSHELL)) {
    throw new OfficialComputerError(
      "Windows credential protection is unavailable.",
      "CREDENTIAL_PROTECTION_UNAVAILABLE",
      500,
    );
  }
  const result = childProcess.spawnSync(
    WINDOWS_POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new OfficialComputerError(
      "Windows could not protect the official-computer credential.",
      "CREDENTIAL_PROTECTION_FAILED",
      500,
    );
  }
  return String(result.stdout || "").trim();
}

function protectSecret(secret) {
  return powershellDataProtection(
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))",
    secret,
  );
}

function unprotectSecret(value) {
  return powershellDataProtection(
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))",
    value,
  );
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readVarint(buffer, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  for (let count = 0; count < 10; count += 1) {
    if (offset >= buffer.length)
      throw new OfficialComputerError(
        "The vendor returned a truncated response.",
        "INVALID_VENDOR_RESPONSE",
        502,
      );
    const byte = buffer[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw new OfficialComputerError(
    "The vendor returned an invalid response.",
    "INVALID_VENDOR_RESPONSE",
    502,
  );
}

function decodeProtoFields(input) {
  const buffer = Buffer.from(input);
  if (buffer.length > MAX_CONNECT_RESPONSE_BYTES) {
    throw new OfficialComputerError(
      "The vendor response exceeded the safety limit.",
      "VENDOR_RESPONSE_TOO_LARGE",
      502,
    );
  }
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNumber < 1)
      throw new OfficialComputerError(
        "The vendor returned an invalid response.",
        "INVALID_VENDOR_RESPONSE",
        502,
      );
    let value;
    if (wireType === 0) {
      const item = readVarint(buffer, offset);
      offset = item.offset;
      value = item.value;
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) throw safeError(new Error("truncated"));
      value = buffer.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const size = Number(length.value);
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        offset + size > buffer.length
      )
        throw new OfficialComputerError(
          "The vendor returned a truncated response.",
          "INVALID_VENDOR_RESPONSE",
          502,
        );
      value = buffer.subarray(offset, offset + size);
      offset += size;
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) throw safeError(new Error("truncated"));
      value = buffer.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new OfficialComputerError(
        "The vendor returned an unsupported response.",
        "INVALID_VENDOR_RESPONSE",
        502,
      );
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push(value);
  }
  return fields;
}

function protoString(fields, fieldNumber, maxLength = 65536) {
  const values = fields.get(fieldNumber) || [];
  if (values.length > 1)
    throw new OfficialComputerError(
      "The vendor returned a duplicate credential field.",
      "INVALID_VENDOR_RESPONSE",
      502,
    );
  const value = values[0];
  if (!Buffer.isBuffer(value)) return "";
  if (value.length > maxLength)
    throw new OfficialComputerError(
      "The vendor returned an oversized credential field.",
      "INVALID_VENDOR_RESPONSE",
      502,
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new OfficialComputerError(
      "The vendor returned invalid credential text.",
      "INVALID_VENDOR_RESPONSE",
      502,
    );
  }
}

function protoEnum(fields, fieldNumber) {
  const values = fields.get(fieldNumber) || [];
  if (values.length > 1)
    throw new OfficialComputerError(
      "The vendor returned a duplicate status field.",
      "INVALID_VENDOR_RESPONSE",
      502,
    );
  const value = values[0];
  return typeof value === "bigint" ? Number(value) : 0;
}

function decodeAccessStatus(input) {
  const fields = decodeProtoFields(input);
  return {
    state: protoEnum(fields, 1),
    purchaseChannel: protoEnum(fields, 2),
    blockReason: protoEnum(fields, 3),
  };
}

function decodeEnsureSandbox(input) {
  const fields = decodeProtoFields(input);
  return {
    networkToken: protoString(fields, 4),
    vncUrl: protoString(fields, 7),
  };
}

function exactObjectKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    keys.length === allowed.length &&
    keys.every((key, index) => key === [...allowed].sort()[index])
  );
}

function exactHeaders(value, expectedNames) {
  let headers;
  try {
    headers = new Headers(value || {});
  } catch {
    return null;
  }
  const names = [...headers.keys()].sort();
  const expected = [...expectedNames].sort();
  if (
    names.length !== expected.length ||
    !names.every((name, index) => name === expected[index])
  )
    return null;
  return headers;
}

function assertAllowedVendorRequest(rawUrl, init = {}, capability) {
  const serializedUrl = String(rawUrl);
  const url = new URL(serializedUrl);
  if (
    serializedUrl !== serializedUrl.trim() ||
    /[\u0000-\u001f\u007f]/.test(serializedUrl) ||
    url.origin !== API_ORIGIN ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new OfficialComputerError(
      "The official-computer network policy blocked this destination.",
      "NETWORK_POLICY_BLOCKED",
      403,
    );
  }
  const method = String(init.method || "GET").toUpperCase();
  if (capability === "auth-poll") {
    const headers = exactHeaders(init.headers, ["content-type"]);
    if (
      method !== "GET" ||
      url.pathname !== AUTH_POLL_PATH ||
      [...url.searchParams.keys()].sort().join(",") !== "uuid,verifier" ||
      !UUID_V4_PATTERN.test(url.searchParams.get("uuid") || "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("verifier") || "") ||
      headers?.get("content-type") !== "application/json"
    )
      throw new OfficialComputerError(
        "The official-computer auth request was blocked.",
        "NETWORK_POLICY_BLOCKED",
        403,
      );
    return;
  }
  if (capability === "token-refresh") {
    let body;
    try {
      body = JSON.parse(String(init.body || "{}"));
    } catch {
      body = null;
    }
    const headers = exactHeaders(init.headers, ["content-type"]);
    if (
      method !== "POST" ||
      url.pathname !== TOKEN_REFRESH_PATH ||
      url.search ||
      !exactObjectKeys(body, ["client_id", "grant_type", "refresh_token"]) ||
      body.client_id !== AUTH_CLIENT_ID ||
      body.grant_type !== "refresh_token" ||
      !isCredentialToken(body.refresh_token) ||
      headers?.get("content-type") !== "application/json"
    )
      throw new OfficialComputerError(
        "The official-computer refresh request was blocked.",
        "NETWORK_POLICY_BLOCKED",
        403,
      );
    return;
  }
  const expectedPath =
    capability === "access-status"
      ? ACCESS_PATH
      : capability === "ensure-box"
        ? ENSURE_PATH
        : null;
  const headers = exactHeaders(init.headers, [
    "authorization",
    "connect-protocol-version",
    "content-type",
    "user-agent",
    "x-cursor-checksum",
    "x-cursor-client-type",
    "x-cursor-client-version",
    "x-ghost-mode",
    "x-request-id",
    "x-sand-box-namespace",
  ]);
  if (
    expectedPath == null ||
    method !== "POST" ||
    url.pathname !== expectedPath ||
    url.search ||
    !Buffer.isBuffer(init.body) ||
    init.body.length !== 0 ||
    !headers ||
    !/^Bearer [^\u0000-\u001f\u007f]{1,65536}$/.test(
      headers.get("authorization") || "",
    ) ||
    headers.get("content-type") !== "application/proto" ||
    headers.get("connect-protocol-version") !== "1" ||
    headers.get("user-agent") !== "connect-es/1.6.1" ||
    !/^[A-Za-z0-9_-]{8}/.test(headers.get("x-cursor-checksum") || "") ||
    !UUID_PATTERN.test(
      String(headers.get("x-cursor-checksum") || "").slice(8),
    ) ||
    headers.get("x-cursor-client-type") !== "sand" ||
    headers.get("x-cursor-client-version") !== VENDOR_CLIENT_VERSION ||
    headers.get("x-sand-box-namespace") !== "prod" ||
    headers.get("x-ghost-mode") !== "true" ||
    !UUID_V4_PATTERN.test(headers.get("x-request-id") || "")
  ) {
    throw new OfficialComputerError(
      "The official-computer RPC request was blocked.",
      "NETWORK_POLICY_BLOCKED",
      403,
    );
  }
}

function validateLoginUrl(value) {
  const serializedUrl = String(value);
  const url = new URL(serializedUrl);
  if (
    serializedUrl !== serializedUrl.trim() ||
    /[\u0000-\u001f\u007f]/.test(serializedUrl) ||
    url.origin !== LOGIN_ORIGIN ||
    url.pathname !== LOGIN_PATH ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].sort().join(",") !==
      "challenge,mode,redirectTarget,uuid" ||
    url.searchParams.get("mode") !== "login" ||
    url.searchParams.get("redirectTarget") !== "sand" ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("challenge") || "") ||
    !UUID_V4_PATTERN.test(url.searchParams.get("uuid") || "")
  ) {
    throw new OfficialComputerError(
      "The Cursor sign-in URL was rejected.",
      "INVALID_LOGIN_URL",
      500,
    );
  }
  return url.toString();
}

function validateVncDescriptor(value) {
  const networkToken = String(value?.networkToken || "");
  if (
    networkToken.length < 16 ||
    networkToken.length > 4096 ||
    !/^[\x21-\x7e]+$/.test(networkToken)
  )
    throw new OfficialComputerError(
      "The official computer returned an invalid network credential.",
      "INVALID_VNC_DESCRIPTOR",
      502,
    );
  const serializedUrl = String(value?.vncUrl || "");
  const url = new URL(serializedUrl);
  if (
    serializedUrl !== serializedUrl.trim() ||
    /[\u0000-\u001f\u007f]/.test(serializedUrl) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !url.hostname ||
    !url.pathname.endsWith("/vnc.html") ||
    url.hash
  )
    throw new OfficialComputerError(
      "The official computer returned an invalid viewer address.",
      "INVALID_VNC_DESCRIPTOR",
      502,
    );
  const outerKeys = [...url.searchParams.keys()].sort();
  if (
    outerKeys.join(",") !==
      "network_token,path,resume_lower_s,resume_upper_s" ||
    url.searchParams.get("resume_lower_s") !== "900" ||
    url.searchParams.get("resume_upper_s") !== "18000"
  )
    throw new OfficialComputerError(
      "The official computer returned an unsupported viewer address.",
      "INVALID_VNC_DESCRIPTOR",
      502,
    );
  if (url.searchParams.get("network_token") !== networkToken)
    throw new OfficialComputerError(
      "The official computer viewer credential did not match.",
      "INVALID_VNC_DESCRIPTOR",
      502,
    );
  const nestedPath = url.searchParams.get("path") || "";
  const nested = new URL(`https://placeholder.invalid/${nestedPath}`);
  const nestedKeys = [...nested.searchParams.keys()].sort();
  if (
    nested.pathname !== "/websockify" ||
    nested.searchParams.get("network_token") !== networkToken ||
    nested.searchParams.get("resume_lower_s") !== "900" ||
    nested.searchParams.get("resume_upper_s") !== "18000" ||
    nestedKeys.join(",") !== "network_token,resume_lower_s,resume_upper_s" ||
    /[\u0000-\u001f\u007f]/.test(nestedPath) ||
    nestedPath.includes("\\") ||
    nestedPath.includes("#")
  )
    throw new OfficialComputerError(
      "The official computer returned an unsupported WebSocket route.",
      "INVALID_VNC_DESCRIPTOR",
      502,
    );
  return Object.freeze({
    origin: url.origin,
    networkToken,
    webSocketUrl: `wss://${url.host}${nested.pathname}${nested.search}`,
  });
}

function resolveChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found)
    throw new OfficialComputerError(
      "Chrome or Edge is required for the official cloud computer view.",
      "BROWSER_MISSING",
      500,
    );
  return found;
}

function buttonName(button) {
  if (Number(button) === 2) return "right";
  if (Number(button) === 3) return "middle";
  return "left";
}

const RFB_MODIFIER_KEYS = Object.freeze({
  CTRL: Object.freeze({ keysym: 0xffe3, code: "ControlLeft" }),
  SHIFT: Object.freeze({ keysym: 0xffe1, code: "ShiftLeft" }),
  ALT: Object.freeze({ keysym: 0xffe9, code: "AltLeft" }),
  META: Object.freeze({ keysym: 0xffeb, code: "MetaLeft" }),
});

const RFB_NAMED_KEYS = Object.freeze({
  BACKSPACE: Object.freeze({ keysym: 0xff08, code: "Backspace" }),
  TAB: Object.freeze({ keysym: 0xff09, code: "Tab" }),
  ENTER: Object.freeze({ keysym: 0xff0d, code: "Enter" }),
  ESCAPE: Object.freeze({ keysym: 0xff1b, code: "Escape" }),
  HOME: Object.freeze({ keysym: 0xff50, code: "Home" }),
  LEFT: Object.freeze({ keysym: 0xff51, code: "ArrowLeft" }),
  UP: Object.freeze({ keysym: 0xff52, code: "ArrowUp" }),
  RIGHT: Object.freeze({ keysym: 0xff53, code: "ArrowRight" }),
  DOWN: Object.freeze({ keysym: 0xff54, code: "ArrowDown" }),
  PAGEUP: Object.freeze({ keysym: 0xff55, code: "PageUp" }),
  PAGEDOWN: Object.freeze({ keysym: 0xff56, code: "PageDown" }),
  END: Object.freeze({ keysym: 0xff57, code: "End" }),
  INSERT: Object.freeze({ keysym: 0xff63, code: "Insert" }),
  DELETE: Object.freeze({ keysym: 0xffff, code: "Delete" }),
  SPACE: Object.freeze({ keysym: 0x20, code: "Space" }),
  F1: Object.freeze({ keysym: 0xffbe, code: "F1" }),
  F2: Object.freeze({ keysym: 0xffbf, code: "F2" }),
  F3: Object.freeze({ keysym: 0xffc0, code: "F3" }),
  F4: Object.freeze({ keysym: 0xffc1, code: "F4" }),
  F5: Object.freeze({ keysym: 0xffc2, code: "F5" }),
  F6: Object.freeze({ keysym: 0xffc3, code: "F6" }),
  F7: Object.freeze({ keysym: 0xffc4, code: "F7" }),
  F8: Object.freeze({ keysym: 0xffc5, code: "F8" }),
  F9: Object.freeze({ keysym: 0xffc6, code: "F9" }),
  F10: Object.freeze({ keysym: 0xffc7, code: "F10" }),
  F11: Object.freeze({ keysym: 0xffc8, code: "F11" }),
  F12: Object.freeze({ keysym: 0xffc9, code: "F12" }),
});

const RFB_KEY_ALIASES = Object.freeze({
  CONTROL: "CTRL",
  RETURN: "ENTER",
  ESC: "ESCAPE",
  ARROWLEFT: "LEFT",
  ARROWUP: "UP",
  ARROWRIGHT: "RIGHT",
  ARROWDOWN: "DOWN",
  WIN: "META",
  WINDOWS: "META",
  SUPER: "META",
  CMD: "META",
  COMMAND: "META",
});

function rfbKeyChord(value) {
  const source = String(value || "").trim();
  if (!source || source.length > 80 || /[\u0000-\u001f\u007f]/.test(source))
    throw new OfficialComputerError(
      "The official computer key chord is invalid.",
      "INVALID_ACTIONS",
      400,
    );
  const rawParts = source.split("+");
  if (
    rawParts.length > 5 ||
    rawParts.some((part) => !part || part !== part.trim())
  )
    throw new OfficialComputerError(
      "The official computer key chord is invalid.",
      "INVALID_ACTIONS",
      400,
    );
  const chord = [];
  const seenModifiers = new Set();
  let sawPrimary = false;
  for (const [index, rawPart] of rawParts.entries()) {
    const upper = rawPart.toUpperCase();
    const canonical = RFB_KEY_ALIASES[upper] || upper;
    const modifier = RFB_MODIFIER_KEYS[canonical];
    if (modifier) {
      if (sawPrimary || seenModifiers.has(canonical))
        throw new OfficialComputerError(
          "The official computer key chord is invalid.",
          "INVALID_ACTIONS",
          400,
        );
      seenModifiers.add(canonical);
      chord.push(modifier);
      continue;
    }
    if (sawPrimary || index !== rawParts.length - 1)
      throw new OfficialComputerError(
        "The official computer key chord is invalid.",
        "INVALID_ACTIONS",
        400,
      );
    sawPrimary = true;
    const named = RFB_NAMED_KEYS[canonical];
    if (named) {
      chord.push(named);
      continue;
    }
    const characters = [...rawPart];
    if (characters.length !== 1)
      throw new OfficialComputerError(
        "The official computer key chord is unsupported.",
        "INVALID_ACTIONS",
        400,
      );
    const character = /[A-Z]/i.test(characters[0])
      ? characters[0].toLowerCase()
      : characters[0];
    const code = /[a-z]/.test(character)
      ? `Key${character.toUpperCase()}`
      : /[0-9]/.test(character)
        ? `Digit${character}`
        : null;
    chord.push(
      Object.freeze({
        keysym: unicodeKeysymForCodePoint(character.codePointAt(0)),
        code,
      }),
    );
  }
  return Object.freeze(chord.map((item) => Object.freeze({ ...item })));
}

function sendRfbKeyChord(rfb, phase, chord) {
  if (!rfb || phase !== "connected") throw new Error("RFB is not connected");
  if (
    !Array.isArray(chord) ||
    chord.length < 1 ||
    chord.length > 5 ||
    chord.some(
      (item) =>
        !item ||
        !Number.isSafeInteger(item.keysym) ||
        item.keysym < 0 ||
        item.keysym > 0xffffffff ||
        (item.code !== null &&
          item.code !== undefined &&
          !/^[A-Za-z0-9]{1,24}$/.test(item.code)),
    )
  )
    throw new Error("Invalid RFB key chord");
  const held = [];
  let primaryError = null;
  try {
    for (const item of chord) {
      held.push(item);
      rfb.sendKey(item.keysym, item.code || null, true);
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let releaseError = null;
    for (const item of held.reverse()) {
      try {
        rfb.sendKey(item.keysym, item.code || null, false);
      } catch (error) {
        releaseError ||= error;
      }
    }
    if (!primaryError && releaseError) throw releaseError;
  }
}

function immutableActions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64)
    throw new OfficialComputerError(
      "One to 64 computer actions are required.",
      "INVALID_ACTIONS",
      400,
    );
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 256 * 1024)
    throw new OfficialComputerError(
      "The computer action batch is too large.",
      "INVALID_ACTIONS",
      413,
    );
  const actions = JSON.parse(json);
  let declaredBudgetMs = 0;
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action))
      throw new OfficialComputerError(
        "The computer action is invalid.",
        "INVALID_ACTIONS",
        400,
      );
    const kind = String(action.kind || "");
    if (
      ![
        "click",
        "mouseMove",
        "drag",
        "type",
        "key",
        "scroll",
        "wait",
        "screenshot",
      ].includes(kind)
    )
      throw new OfficialComputerError(
        "The computer action is unsupported.",
        "INVALID_ACTIONS",
        400,
      );
    if (kind === "type" && String(action.text || "").length > 20000)
      throw new OfficialComputerError(
        "Typed input is too long.",
        "INVALID_ACTIONS",
        400,
      );
    declaredBudgetMs += ACTION_STEP_BUDGET_MS;
    if (kind === "wait") {
      const durationMs =
        action.durationMs == null ? 1000 : Number(action.durationMs);
      if (
        !Number.isFinite(durationMs) ||
        !Number.isInteger(durationMs) ||
        durationMs < 0 ||
        durationMs > MAX_WAIT_ACTION_MS
      )
        throw new OfficialComputerError(
          `A wait must be an integer from 0 to ${MAX_WAIT_ACTION_MS} milliseconds.`,
          "INVALID_ACTIONS",
          400,
        );
      action.durationMs = durationMs;
      declaredBudgetMs += durationMs;
    }
    if (declaredBudgetMs > MAX_DECLARED_ACTION_BUDGET_MS)
      throw new OfficialComputerError(
        `The computer action batch exceeds the ${MAX_DECLARED_ACTION_BUDGET_MS} millisecond execution budget.`,
        "ACTION_BUDGET_EXCEEDED",
        400,
      );
  }
  return Object.freeze(actions.map((action) => Object.freeze(action)));
}

function unicodeKeysymForCodePoint(value) {
  const codePoint = Number(value);
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  )
    return 0xfffd;
  if (codePoint === 0x08) return 0xff08;
  if (codePoint === 0x09) return 0xff09;
  if (codePoint === 0x0a || codePoint === 0x0d) return 0xff0d;
  if (codePoint === 0x1b) return 0xff1b;
  if (codePoint === 0x7f) return 0xffff;
  if (codePoint <= 0xff) return codePoint;
  return 0x01000000 | codePoint;
}

function hardenNoVncSource(relative, source) {
  if (relative !== "core/rfb.js") return source;
  const clipboardStart = source.indexOf("    _handleServerCutText() {");
  const clipboardEnd = source.indexOf(
    "\n    _handleServerFenceMsg() {",
    clipboardStart,
  );
  if (clipboardStart < 0 || clipboardEnd < 0)
    throw new Error("Pinned noVNC clipboard hardening anchor is missing.");
  const clipboardReplacement = `    _handleServerCutText() {
        if (this._sock.rQwait("ServerCutText header", 7, 1)) { return false; }
        this._sock.rQskipBytes(3);
        let length = toSigned32bit(this._sock.rQshift32());
        if (Math.abs(length) > 1048576) { return this._fail("Server clipboard payload exceeds the safety limit"); }
        if (this._sock.rQwait("ServerCutText content", Math.abs(length), 8)) { return false; }
        this._sock.rQskipBytes(Math.abs(length));
        return true;
    }
`;
  let hardened =
    source.slice(0, clipboardStart) +
    clipboardReplacement +
    source.slice(clipboardEnd);
  const resizeAnchor = `    _resize(width, height) {
        this._fbWidth = width;`;
  if (!hardened.includes(resizeAnchor))
    throw new Error("Pinned noVNC framebuffer hardening anchor is missing.");
  hardened = hardened.replace(
    resizeAnchor,
    `    _resize(width, height) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 2160 || width * height > 8847360) {
            this._fail("Framebuffer dimensions exceed the safety limit");
            return;
        }
        this._fbWidth = width;`,
  );
  return hardened;
}

async function createRfbRelay(descriptor) {
  const validated = validateVncDescriptor(descriptor);
  const remote = new URL(validated.webSocketUrl);
  const resolution = await resolvePublicAddresses(remote.hostname);
  const selected = resolution.selected;
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const localPath = `/rfb/${sessionToken}`;
  let allowedOrigin = null;
  let localClient = null;
  let upstream = null;
  let closed = false;
  let inboundWindowStarted = Date.now();
  let inboundWindowBytes = 0;
  let localUrl = "";
  let localOrigin = "";
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
    maxPayload: 16 * 1024 * 1024,
    clientTracking: true,
  });
  function closePair(code = 1011, reason = "Remote computer disconnected") {
    if (localClient?.readyState === WebSocket.OPEN)
      localClient.close(code, reason.slice(0, 120));
    if (upstream?.readyState === WebSocket.OPEN)
      upstream.close(1000, "relay closed");
    else upstream?.terminate?.();
  }

  server.on("connection", (socket, request) => {
    let requestUrl;
    try {
      if (!localOrigin) throw new Error("relay is not ready");
      requestUrl = new URL(request.url || "/", localOrigin);
    } catch {
      socket.close(1008, "unauthorized relay client");
      return;
    }
    const origin = String(request.headers.origin || "");
    if (
      closed ||
      localClient != null ||
      requestUrl.pathname !== localPath ||
      requestUrl.search ||
      allowedOrigin == null ||
      origin !== allowedOrigin
    ) {
      socket.close(1008, "unauthorized relay client");
      return;
    }
    localClient = socket;
    const queued = [];
    let queuedBytes = 0;
    upstream = new WebSocket(validated.webSocketUrl, {
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 20000,
      rejectUnauthorized: true,
      servername: remote.hostname,
      headers: {
        "x-anyrun-network-token": validated.networkToken,
      },
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) {
          callback(null, [
            { address: selected.address, family: selected.family },
          ]);
          return;
        }
        callback(null, selected.address, selected.family);
      },
    });
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.isBuffer(data)
        ? data.length
        : Buffer.byteLength(data);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        queuedBytes += bytes;
        if (queuedBytes > 1024 * 1024) {
          closePair(1009, "relay queue exceeded");
          return;
        }
        queued.push([data, isBinary]);
      }
    });
    socket.on("close", () => {
      upstream?.close();
      localClient = null;
    });
    socket.on("error", () => closePair());
    upstream.on("open", () => {
      for (const [data, isBinary] of queued)
        upstream.send(data, { binary: isBinary });
      queued.length = 0;
    });
    upstream.on("message", (data, isBinary) => {
      const now = Date.now();
      if (now - inboundWindowStarted >= 10000) {
        inboundWindowStarted = now;
        inboundWindowBytes = 0;
      }
      inboundWindowBytes += Buffer.isBuffer(data)
        ? data.length
        : Buffer.byteLength(data);
      if (inboundWindowBytes > 64 * 1024 * 1024) {
        closePair(1009, "remote frame rate exceeded");
        return;
      }
      if (socket.readyState === WebSocket.OPEN)
        socket.send(data, { binary: isBinary });
    });
    upstream.on("close", () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.close(1011, "remote display closed");
    });
    upstream.on("error", () => closePair());
  });

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  localUrl = `ws://127.0.0.1:${address.port}${localPath}`;
  localOrigin = `ws://127.0.0.1:${address.port}`;

  return {
    localUrl,
    localOrigin,
    setAllowedOrigin(origin) {
      const parsed = new URL(String(origin));
      if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
        throw new Error(
          "The RFB relay requires an exact loopback viewer origin.",
        );
      allowedOrigin = parsed.origin;
    },
    async close() {
      if (closed) return;
      closed = true;
      closePair(1001, "session closed");
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function createNoVncHarnessServer(noVncRoot, webSocketOrigin) {
  const sessionToken = crypto.randomBytes(32).toString("base64url");
  const prefix = `/session/${sessionToken}/`;
  const viewerSource = `import RFB from "./core/rfb.js";
const state={phase:"idle",detail:""};
let rfb=null;
const unicodeKeysymForCodePoint=${unicodeKeysymForCodePoint.toString()};
const sendRfbKeyChord=${sendRfbKeyChord.toString()};
globalThis.__officialVncState=()=>({...state});
globalThis.__officialVncStart=(url)=>{
  if(rfb) return;
  state.phase="connecting";
  rfb=new RFB(document.getElementById("screen"),url,{shared:true});
  rfb.scaleViewport=true;
  rfb.resizeSession=false;
  rfb.viewOnly=false;
  rfb.focusOnClick=true;
  rfb.addEventListener("connect",()=>{state.phase="connected";});
  rfb.addEventListener("disconnect",event=>{state.phase="disconnected";state.detail=event.detail?.clean?"clean":"lost";});
  rfb.addEventListener("credentialsrequired",()=>{state.phase="error";state.detail="credentials";rfb.disconnect();});
  rfb.addEventListener("securityfailure",()=>{state.phase="error";state.detail="security";rfb.disconnect();});
  rfb.addEventListener("serververification",()=>{state.phase="error";state.detail="server-verification";rfb.disconnect();});
};
globalThis.__officialVncType=(text)=>{
  if(!rfb||state.phase!=="connected") throw new Error("RFB is not connected");
  for(const character of String(text)){
    const keysym=unicodeKeysymForCodePoint(character.codePointAt(0));
    rfb.sendKey(keysym,null,true);
    rfb.sendKey(keysym,null,false);
  }
};
globalThis.__officialVncKey=(chord)=>sendRfbKeyChord(rfb,state.phase,chord);
globalThis.__officialVncDisconnect=()=>{try{rfb?.disconnect();}catch{} rfb=null;state.phase="closed";};
`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Official cloud computer</title><style>html,body,#screen{width:100%;height:100%;margin:0;overflow:hidden;background:#000}#screen canvas{width:100%!important;height:100%!important;display:block}</style></head><body><div id="screen" role="application" aria-label="Official cloud computer"></div><script type="module" src="./viewer.js"></script></body></html>`;
  let address = null;
  const server = http.createServer((request, response) => {
    const remote = request.socket.remoteAddress;
    if (
      remote !== "127.0.0.1" &&
      remote !== "::1" &&
      remote !== "::ffff:127.0.0.1"
    ) {
      response.writeHead(403, { "Content-Length": "0" });
      response.end();
      return;
    }
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!requestUrl.pathname.startsWith(prefix) || requestUrl.search) {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
      return;
    }
    const relative = requestUrl.pathname.slice(prefix.length);
    const csp = `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src ${webSocketOrigin}; img-src 'self' data:;`;
    if (relative === "index.html") {
      const body = Buffer.from(html);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": body.length,
        "Content-Security-Policy": csp,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (relative === "viewer.js") {
      const body = Buffer.from(viewerSource);
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": body.length,
        "Content-Security-Policy": csp,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (!/^(?:core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(relative)) {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
      return;
    }
    const file = path.resolve(noVncRoot, relative);
    const root = `${path.resolve(noVncRoot)}${path.sep}`;
    if (!file.startsWith(root)) {
      response.writeHead(403, { "Content-Length": "0" });
      response.end();
      return;
    }
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("invalid");
      let source = fs.readFileSync(file, "utf8");
      source = hardenNoVncSource(relative, source);
      const body = Buffer.from(source);
      response.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Content-Length": body.length,
        "Content-Security-Policy": csp,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
    }
  });
  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      address = server.address();
      return `http://127.0.0.1:${address.port}${prefix}index.html`;
    },
    async close() {
      if (!address) return;
      await new Promise((resolve) => server.close(() => resolve()));
      address = null;
    },
  };
}

async function startNoVncViewer(page, relayUrl, signal) {
  throwIfAborted(signal);
  await page.waitForFunction(
    () => typeof globalThis.__officialVncStart === "function",
    null,
    { timeout: 15000 },
  );
  throwIfAborted(signal);
  await page.evaluate((url) => globalThis.__officialVncStart(url), relayUrl);
  throwIfAborted(signal);
}

async function createNoVncViewer(descriptor, options = {}) {
  const validated = validateVncDescriptor(descriptor);
  const noVncEntry = require.resolve("@novnc/novnc");
  const noVncRoot = path.dirname(path.dirname(noVncEntry));
  const signal = options.signal;
  let relay;
  let harness;
  let browser;
  let context;
  let page;
  let canvas;
  let cleanupTail = Promise.resolve();
  const closeResources = () => {
    cleanupTail = cleanupTail.then(async () => {
      const closingPage = page;
      const closingContext = context;
      const closingBrowser = browser;
      const closingRelay = relay;
      const closingHarness = harness;
      page = null;
      canvas = null;
      context = null;
      browser = null;
      relay = null;
      harness = null;
      await closingPage
        ?.evaluate(() => globalThis.__officialVncDisconnect?.())
        .catch(() => {});
      await closingContext?.close().catch(() => {});
      await closingBrowser?.close().catch(() => {});
      await closingRelay?.close().catch(() => {});
      await closingHarness?.close().catch(() => {});
    });
    return cleanupTail;
  };
  const abortCleanup = () => void closeResources();
  signal?.addEventListener("abort", abortCleanup, { once: true });
  try {
    throwIfAborted(signal);
    relay = await createRfbRelay(descriptor);
    throwIfAborted(signal);
    harness = createNoVncHarnessServer(noVncRoot, relay.localOrigin);
    const harnessUrl = await harness.listen();
    throwIfAborted(signal);
    const harnessOrigin = new URL(harnessUrl).origin;
    relay.setAllowedOrigin(harnessOrigin);
    browser = await chromium.launch({
      executablePath: options.chromePath || resolveChrome(),
      headless: true,
      chromiumSandbox: true,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-domain-reliability",
        "--disable-sync",
        "--disable-features=OptimizationHints,MediaRouter",
        "--disable-dev-shm-usage",
        "--force-device-scale-factor=1",
        `--window-size=${WIDTH},${HEIGHT}`,
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        ...CHROMIUM_HARDENING_ARGS,
      ],
    });
    throwIfAborted(signal);
    context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      screen: { width: WIDTH, height: HEIGHT },
      acceptDownloads: false,
      serviceWorkers: "block",
      locale: "en-US",
      colorScheme: "dark",
      deviceScaleFactor: 1,
    });
    throwIfAborted(signal);
    await installBrowserPageHardening(context);
    throwIfAborted(signal);
    await context.clearPermissions().catch(() => {});
    await context.route("**/*", async (route, request) => {
      let allowed = false;
      try {
        const url = new URL(request.url());
        allowed =
          url.origin === harnessOrigin &&
          url.pathname.startsWith(
            new URL(harnessUrl).pathname.replace(/index\.html$/, ""),
          );
      } catch {}
      if (allowed) await route.continue();
      else await route.abort("blockedbyclient");
    });
    throwIfAborted(signal);
    page = await context.newPage();
    throwIfAborted(signal);
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    await page.goto(harnessUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    throwIfAborted(signal);
    await startNoVncViewer(page, relay.localUrl, signal);
    await page.waitForFunction(
      () => globalThis.__officialVncState?.().phase === "connected",
      null,
      { timeout: 60000 },
    );
    throwIfAborted(signal);
    canvas = page.locator("#screen canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 15000 });
    throwIfAborted(signal);
    const dimensions = await canvas.evaluate((element) => ({
      width: element.width,
      height: element.height,
    }));
    if (
      dimensions.width < 1 ||
      dimensions.height < 1 ||
      dimensions.width > 4096 ||
      dimensions.height > 4096 ||
      dimensions.width * dimensions.height > 16 * 1024 * 1024
    )
      throw new OfficialComputerError(
        "The remote framebuffer dimensions exceeded the safety limit.",
        "FRAMEBUFFER_LIMIT",
        502,
      );

    let cursor = { x: Math.round(WIDTH / 2), y: Math.round(HEIGHT / 2) };
    async function point(value) {
      const box = await canvas.boundingBox();
      if (!box)
        throw new OfficialComputerError(
          "The official computer screen is unavailable.",
          "VIEW_UNAVAILABLE",
          503,
        );
      const sourceX = Math.max(0, Math.min(WIDTH, Number(value?.x || 0)));
      const sourceY = Math.max(0, Math.min(HEIGHT, Number(value?.y || 0)));
      cursor = { x: Math.round(sourceX), y: Math.round(sourceY) };
      return {
        x: box.x + (sourceX / WIDTH) * box.width,
        y: box.y + (sourceY / HEIGHT) * box.height,
      };
    }

    return {
      async capture() {
        const state = await page.evaluate(() =>
          globalThis.__officialVncState?.(),
        );
        if (state?.phase !== "connected")
          throw new OfficialComputerError(
            "The official computer screen disconnected.",
            "VIEW_DISCONNECTED",
            503,
          );
        const screenshot = await canvas.screenshot({ type: "png" });
        return { screenshotBase64: screenshot.toString("base64"), cursor };
      },
      async execute(actions, executionOptions = {}) {
        const ensureContinues = () => {
          if (typeof executionOptions.assertContinue === "function") {
            executionOptions.assertContinue();
            return;
          }
          if (
            typeof executionOptions.shouldContinue === "function" &&
            executionOptions.shouldContinue() !== true
          )
            throw new OfficialComputerError(
              "The user took control before the official-computer action batch finished.",
              "ACTION_INTERRUPTED",
              409,
            );
        };
        for (const action of actions) {
          ensureContinues();
          const kind = action.kind;
          if (kind === "mouseMove") {
            const target = await point(action.coordinate);
            await page.mouse.move(target.x, target.y);
          } else if (kind === "click") {
            const target = await point(action.coordinate);
            await page.mouse.click(target.x, target.y, {
              button: buttonName(action.button),
              clickCount: Math.max(1, Math.min(3, Number(action.count || 1))),
            });
          } else if (kind === "drag") {
            const points = Array.isArray(action.path) ? action.path : [];
            if (points.length < 2)
              throw new OfficialComputerError(
                "A drag requires at least two points.",
                "INVALID_ACTIONS",
                400,
              );
            const first = await point(points[0]);
            await page.mouse.move(first.x, first.y);
            const dragButton = buttonName(action.button);
            let mouseIsDown = false;
            try {
              await page.mouse.down({ button: dragButton });
              mouseIsDown = true;
              for (const item of points.slice(1, 64)) {
                ensureContinues();
                const target = await point(item);
                await page.mouse.move(target.x, target.y, { steps: 2 });
              }
            } finally {
              if (mouseIsDown)
                await page.mouse.up({ button: dragButton }).catch(() => {});
            }
          } else if (kind === "type") {
            await page.evaluate(
              (text) => globalThis.__officialVncType(text),
              String(action.text || ""),
            );
          } else if (kind === "key") {
            await page.evaluate(
              (chord) => globalThis.__officialVncKey(chord),
              rfbKeyChord(action.key),
            );
          } else if (kind === "scroll") {
            const target = await point(action.coordinate || cursor);
            await page.mouse.move(target.x, target.y);
            const amount =
              Math.max(1, Math.min(12, Number(action.amount || 3))) * 180;
            const direction = Number(action.direction || 2);
            await page.mouse.wheel(
              direction === 3 ? -amount : direction === 4 ? amount : 0,
              direction === 1 ? -amount : direction === 2 ? amount : 0,
            );
          } else if (kind === "wait") {
            let remaining = Math.max(
              0,
              Math.min(
                MAX_WAIT_ACTION_MS,
                Number(action.durationMs == null ? 1000 : action.durationMs),
              ),
            );
            while (remaining > 0) {
              ensureContinues();
              const duration = Math.min(100, remaining);
              await page.waitForTimeout(duration);
              remaining -= duration;
            }
          }
          ensureContinues();
        }
      },
      async close() {
        signal?.removeEventListener("abort", abortCleanup);
        await closeResources();
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", abortCleanup);
    await closeResources();
    if (signal?.aborted) throw cancelledError();
    throw safeError(error);
  }
}

function createOfficialComputerCore(options = {}) {
  const stateDir =
    options.stateDir ||
    process.env.CODEX_OFFICIAL_COMPUTER_STATE ||
    path.join(
      process.env.LOCALAPPDATA || __dirname,
      "Open Bot",
      "official-computer",
    );
  const configPath = path.join(stateDir, "credentials.json");
  const permissionPath = path.join(stateDir, "permissions.json");
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const actionNow = options.actionNow || Date.now;
  const sleep =
    options.sleep ||
    ((ms, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }));
  const protect = options.protectSecret || protectSecret;
  const unprotect = options.unprotectSecret || unprotectSecret;
  const viewerFactory = options.viewerFactory || createNoVncViewer;
  let authEpoch = 0;
  let pendingLogin = null;
  let refreshAttempt = null;
  let viewer = null;
  let viewerPromise = null;
  let viewerSetupController = null;
  let descriptor = null;
  let generation = 0;
  let frameGeneration = 0;
  let frameSequence = 0;
  let frameHash = "";
  let frameCaptureQueue = Promise.resolve();
  let actionEpoch = 0;
  let phase = "disconnected";
  let lastError = null;
  let retryAttempt = 0;
  let retryAt = 0;
  let retryStage = null;
  let actionQueue = Promise.resolve();
  let credentialsCache = { modified: null, value: null };
  let permissionCache = { modified: null, value: false };
  const pendingApprovalSeats = new Set();
  const pendingApprovalFrames = new Map();
  const approvals = new BrowserActionApprovalCoordinator({
    pendingTtlMs: OFFICIAL_ACTION_APPROVAL_TTL_MS,
  });
  const trustedApprover = approvals.createTrustedUserApprover();
  const controls = new BrowserControlLeaseCoordinator({
    onAcquire: () => {
      for (const seatId of pendingApprovalSeats) {
        approvals.cancelAgentAction(seatId);
        pendingApprovalFrames.delete(seatId);
      }
    },
  });

  function resetViewerRecovery() {
    retryAttempt = 0;
    retryAt = 0;
    retryStage = null;
  }

  function retryClock() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function retryDelay(attempt) {
    const exponent = Math.min(
      Math.max(0, attempt - 1),
      Math.ceil(Math.log2(OFFICIAL_RETRY_MAX_MS / OFFICIAL_RETRY_BASE_MS)),
    );
    return Math.min(
      OFFICIAL_RETRY_BASE_MS * 2 ** exponent,
      OFFICIAL_RETRY_MAX_MS,
    );
  }

  function retryRemainingMs() {
    if (!retryAttempt) return 0;
    return Math.max(
      0,
      Math.min(OFFICIAL_RETRY_MAX_MS, Math.ceil(retryAt - retryClock())),
    );
  }

  function isRecoverableViewerFailure(error) {
    const safe = safeError(error);
    return !NON_RECOVERABLE_VIEWER_CODES.has(safe.code);
  }

  function recordViewerRecovery(error, stage) {
    const safe = safeError(error);
    if (!isRecoverableViewerFailure(safe)) {
      resetViewerRecovery();
      return safe;
    }
    retryAttempt = Math.min(retryAttempt + 1, OFFICIAL_RETRY_MAX_ATTEMPT);
    retryAt = retryClock() + retryDelay(retryAttempt);
    retryStage = ["access", "provision", "viewer"].includes(stage)
      ? stage
      : "viewer";
    return safe;
  }

  function assertViewerRetryDue() {
    const remainingMs = retryRemainingMs();
    if (!remainingMs) return;
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    throw new OfficialComputerError(
      `The official cloud computer is recovering. Retry in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      "OFFICIAL_RETRY_PENDING",
      503,
    );
  }

  function config() {
    const loaded = readJson(configPath, {});
    if (!loaded || loaded.version !== CONFIG_VERSION) return {};
    return loaded;
  }

  function mode() {
    return config().mode === "official" ? "official" : "private";
  }

  function alwaysAllowComputerActions() {
    let modified = -1;
    try {
      modified = fs.statSync(permissionPath).mtimeMs;
    } catch {}
    if (permissionCache.modified === modified) return permissionCache.value;
    let value = false;
    try {
      const stored = readJson(permissionPath, {});
      if (
        stored?.version !== PERMISSION_VERSION ||
        stored?.provider !== OFFICIAL_PERMISSION_PROVIDER ||
        typeof stored.protectedPolicy !== "string" ||
        stored.protectedPolicy.length < 1 ||
        stored.protectedPolicy.length > MAX_CREDENTIAL_BYTES
      )
        throw new Error("invalid protected permission");
      const policy = JSON.parse(unprotect(stored.protectedPolicy));
      if (
        !policy ||
        Object.keys(policy).sort().join(",") !==
          "alwaysAllowComputerActions,provider,version" ||
        policy.version !== PERMISSION_VERSION ||
        policy.provider !== OFFICIAL_PERMISSION_PROVIDER ||
        policy.alwaysAllowComputerActions !== true
      )
        throw new Error("invalid protected permission");
      value = true;
    } catch {
      value = false;
    }
    permissionCache = { modified, value };
    return value;
  }

  function setComputerPermissions(
    alwaysAllow,
    acknowledged = false,
    provider = OFFICIAL_PERMISSION_PROVIDER,
  ) {
    if (
      typeof alwaysAllow !== "boolean" ||
      provider !== OFFICIAL_PERMISSION_PROVIDER
    )
      throw new OfficialComputerError(
        "The vendor computer permission setting is invalid.",
        "INVALID_PERMISSION",
        400,
      );
    if (alwaysAllow && acknowledged !== true)
      throw new OfficialComputerError(
        "Acknowledge the vendor computer permission warning before allowing actions automatically.",
        "PERMISSION_ACKNOWLEDGEMENT_REQUIRED",
        400,
      );
    if (alwaysAllow && !readCredentials())
      throw new OfficialComputerError(
        "Connect the official vendor account before enabling Always allow.",
        "OFFICIAL_SIGN_IN_REQUIRED",
        401,
      );
    if (!alwaysAllow) {
      try {
        fs.rmSync(permissionPath, { force: true });
      } catch {
        throw new OfficialComputerError(
          "Windows could not disable the vendor computer permission.",
          "PERMISSION_WRITE_FAILED",
          500,
        );
      }
      permissionCache = { modified: -1, value: false };
      return computerPermissions();
    }
    const protectedPolicy = protect(
      JSON.stringify({
        version: PERMISSION_VERSION,
        provider: OFFICIAL_PERMISSION_PROVIDER,
        alwaysAllowComputerActions: true,
      }),
    );
    atomicWriteJson(permissionPath, {
      version: PERMISSION_VERSION,
      provider: OFFICIAL_PERMISSION_PROVIDER,
      protectedPolicy,
      updatedAt: new Date(now()).toISOString(),
    });
    let modified = -1;
    try {
      modified = fs.statSync(permissionPath).mtimeMs;
    } catch {}
    permissionCache = { modified, value: true };
    return computerPermissions();
  }

  function clearComputerPermissions() {
    return setComputerPermissions(false, false, OFFICIAL_PERMISSION_PROVIDER);
  }

  function computerPermissions() {
    return Object.freeze({
      provider: OFFICIAL_PERMISSION_PROVIDER,
      alwaysAllowComputerActions: alwaysAllowComputerActions(),
    });
  }

  function writeConfig(patch) {
    const previous = config();
    atomicWriteJson(configPath, {
      ...previous,
      ...patch,
      version: CONFIG_VERSION,
      updatedAt: new Date(now()).toISOString(),
    });
  }

  function readCredentials() {
    const stored = config();
    if (
      !stored.protectedAccessToken ||
      !stored.protectedRefreshToken ||
      (!stored.protectedMachineId && !UUID_PATTERN.test(stored.machineId || ""))
    )
      return null;
    let modified = -1;
    try {
      modified = fs.statSync(configPath).mtimeMs;
    } catch {}
    if (credentialsCache.modified === modified) return credentialsCache.value;
    try {
      const accessToken = unprotect(stored.protectedAccessToken);
      const refreshToken = unprotect(stored.protectedRefreshToken);
      const legacyMachineId = UUID_PATTERN.test(stored.machineId || "")
        ? stored.machineId
        : "";
      const machineId = stored.protectedMachineId
        ? unprotect(stored.protectedMachineId)
        : legacyMachineId;
      if (
        !isCredentialToken(accessToken) ||
        !isCredentialToken(refreshToken) ||
        !UUID_PATTERN.test(machineId)
      )
        throw new Error("invalid protected credential");
      const value = {
        accessToken,
        refreshToken,
        machineId,
      };
      if (!stored.protectedMachineId) {
        const { machineId: _legacyMachineId, ...withoutLegacyMachineId } =
          stored;
        atomicWriteJson(configPath, {
          ...withoutLegacyMachineId,
          protectedMachineId: protect(machineId),
          updatedAt: new Date(now()).toISOString(),
        });
        try {
          modified = fs.statSync(configPath).mtimeMs;
        } catch {}
      }
      credentialsCache = { modified, value };
      return value;
    } catch {
      credentialsCache = { modified, value: null };
      return null;
    }
  }

  function storeCredentials(credentials) {
    if (
      !isCredentialToken(credentials?.accessToken) ||
      !isCredentialToken(credentials?.refreshToken) ||
      !UUID_PATTERN.test(credentials?.machineId || "")
    )
      throw new OfficialComputerError(
        "The vendor returned an invalid authentication credential.",
        "INVALID_VENDOR_RESPONSE",
        502,
      );
    const previous = config();
    atomicWriteJson(configPath, {
      version: CONFIG_VERSION,
      mode: previous.mode === "official" ? "official" : "private",
      experimentalAcceptedAt: previous.experimentalAcceptedAt || null,
      protectedMachineId: protect(credentials.machineId),
      protectedAccessToken: protect(credentials.accessToken),
      protectedRefreshToken: protect(credentials.refreshToken),
      updatedAt: new Date(now()).toISOString(),
    });
    let modified = -1;
    try {
      modified = fs.statSync(configPath).mtimeMs;
    } catch {}
    credentialsCache = { modified, value: { ...credentials } };
    resetViewerRecovery();
  }

  function forgetCredentials({ preserveMode = true } = {}) {
    const previous = config();
    clearComputerPermissions();
    credentialsCache = { modified: null, value: null };
    resetViewerRecovery();
    if (preserveMode) {
      atomicWriteJson(configPath, {
        version: CONFIG_VERSION,
        mode: previous.mode === "official" ? "official" : "private",
        experimentalAcceptedAt: previous.experimentalAcceptedAt || null,
        updatedAt: new Date(now()).toISOString(),
      });
      return;
    }
    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      throw new OfficialComputerError(
        "Windows could not remove the protected official-computer credentials. Close programs using the file and try signing out again.",
        "CREDENTIAL_ERASURE_FAILED",
        500,
      );
    }
    if (fs.existsSync(configPath)) {
      throw new OfficialComputerError(
        "Windows could not remove the protected official-computer credentials. Close programs using the file and try signing out again.",
        "CREDENTIAL_ERASURE_FAILED",
        500,
      );
    }
  }

  async function vendorFetch(url, init, capability) {
    assertAllowedVendorRequest(url, init, capability);
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: "error" });
    } catch (error) {
      throw safeError(error);
    }
    return response;
  }

  function cancelRefresh() {
    refreshAttempt?.controller.abort();
    refreshAttempt = null;
  }

  async function pollLogin(attempt, epoch) {
    let consecutiveErrors = 0;
    for (let index = 0; index < 150; index += 1) {
      if (attempt.controller.signal.aborted || epoch !== authEpoch) return;
      const url = new URL(AUTH_POLL_PATH, API_ORIGIN);
      url.searchParams.set("uuid", attempt.uuid);
      url.searchParams.set("verifier", attempt.verifier);
      let response;
      try {
        response = await vendorFetch(
          url,
          {
            method: "GET",
            headers: { "Content-Type": "application/json" },
            signal: attempt.controller.signal,
          },
          "auth-poll",
        );
      } catch {
        if (attempt.controller.signal.aborted || epoch !== authEpoch) return;
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) break;
        await sleep(
          Math.min(1000 * 1.2 ** index, 10000),
          attempt.controller.signal,
        );
        continue;
      }
      if (response.status === 404) {
        consecutiveErrors = 0;
        await sleep(
          Math.min(1000 * 1.2 ** index, 10000),
          attempt.controller.signal,
        );
        continue;
      }
      if (response.status === 403) {
        phase = "sign-in-blocked";
        lastError = "The vendor sign-in policy rejected this account.";
        pendingLogin = null;
        return;
      }
      if (!response.ok) {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 3) break;
        await sleep(
          Math.min(1000 * 1.2 ** index, 10000),
          attempt.controller.signal,
        );
        continue;
      }
      let result;
      try {
        result = await readBoundedJsonResponse(
          response,
          attempt.controller.signal,
        );
      } catch {
        break;
      }
      if (
        !result ||
        !isCredentialToken(result.accessToken) ||
        !isCredentialToken(result.refreshToken)
      )
        break;
      if (epoch !== authEpoch || attempt.controller.signal.aborted) return;
      storeCredentials({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        machineId: attempt.machineId,
      });
      pendingLogin = null;
      phase = "signed-in";
      lastError = null;
      return;
    }
    if (epoch === authEpoch && !attempt.controller.signal.aborted) {
      pendingLogin = null;
      phase = "sign-in-error";
      lastError = "Cursor sign-in did not complete. Try again.";
    }
  }

  async function startLogin() {
    clearComputerPermissions();
    authEpoch += 1;
    cancelRefresh();
    pendingLogin?.controller.abort();
    pendingLogin = null;
    resetViewerRecovery();
    const existingMachineId = readCredentials()?.machineId;
    if (mode() === "official" || viewer || viewerPromise) await closeViewer();
    const epoch = authEpoch;
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(
      crypto.createHash("sha256").update(verifier).digest(),
    );
    const uuid = crypto.randomUUID();
    const login = new URL(LOGIN_PATH, LOGIN_ORIGIN);
    login.searchParams.set("challenge", challenge);
    login.searchParams.set("uuid", uuid);
    login.searchParams.set("mode", "login");
    login.searchParams.set("redirectTarget", "sand");
    const controller = new AbortController();
    const attempt = {
      uuid,
      verifier,
      controller,
      epoch,
      machineId: existingMachineId || crypto.randomUUID(),
    };
    pendingLogin = attempt;
    phase = "signing-in";
    lastError = null;
    void pollLogin(attempt, epoch);
    return {
      loginUrl: validateLoginUrl(login),
      state: phase,
    };
  }

  function cancelLogin() {
    authEpoch += 1;
    cancelRefresh();
    pendingLogin?.controller.abort();
    pendingLogin = null;
    resetViewerRecovery();
    phase = readCredentials() ? "signed-in" : "disconnected";
    lastError = null;
    return true;
  }

  async function validCredentials() {
    const credentials = readCredentials();
    if (!credentials)
      throw new OfficialComputerError(
        "Connect a Cursor account first.",
        "OFFICIAL_SIGN_IN_REQUIRED",
        401,
      );
    if (!tokenNeedsRefresh(credentials.accessToken, now)) return credentials;
    if (refreshAttempt) return refreshAttempt.promise;
    const epoch = authEpoch;
    const controller = new AbortController();
    const attempt = { epoch, controller, promise: null };
    attempt.promise = (async () => {
      const response = await vendorFetch(
        new URL(TOKEN_REFRESH_PATH, API_ORIGIN),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: AUTH_CLIENT_ID,
            grant_type: "refresh_token",
            refresh_token: credentials.refreshToken,
          }),
          signal: controller.signal,
        },
        "token-refresh",
      );
      const result = await readBoundedJsonResponse(response, controller.signal);
      if (epoch !== authEpoch || controller.signal.aborted)
        throw new OfficialComputerError(
          "The official-computer authentication changed during refresh.",
          "CANCELLED",
          409,
        );
      if (!response.ok || result?.shouldLogout) {
        forgetCredentials();
        phase = "disconnected";
        throw new OfficialComputerError(
          "The Cursor sign-in expired. Connect again.",
          "OFFICIAL_SIGN_IN_REQUIRED",
          401,
        );
      }
      if (
        !isCredentialToken(result?.access_token) ||
        (result?.refresh_token != null &&
          !isCredentialToken(result.refresh_token))
      )
        throw new OfficialComputerError(
          "The vendor returned an invalid authentication credential.",
          "INVALID_VENDOR_RESPONSE",
          502,
        );
      const refreshed = {
        accessToken: result.access_token,
        refreshToken: result.refresh_token || credentials.refreshToken,
        machineId: credentials.machineId,
      };
      if (epoch !== authEpoch || controller.signal.aborted)
        throw new OfficialComputerError(
          "The official-computer authentication changed during refresh.",
          "CANCELLED",
          409,
        );
      storeCredentials(refreshed);
      return refreshed;
    })().finally(() => {
      if (refreshAttempt === attempt) refreshAttempt = null;
    });
    refreshAttempt = attempt;
    return attempt.promise;
  }

  function connectHeaders(credentials) {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "User-Agent": "connect-es/1.6.1",
      "x-cursor-checksum": createCursorChecksum(credentials.machineId, now),
      "x-cursor-client-type": "sand",
      "x-cursor-client-version": VENDOR_CLIENT_VERSION,
      "x-sand-box-namespace": "prod",
      "x-ghost-mode": "true",
      "x-request-id": crypto.randomUUID(),
    };
  }

  async function connectRpc(pathname, capability, signal) {
    throwIfAborted(signal);
    const credentials = await validCredentials();
    throwIfAborted(signal);
    const response = await vendorFetch(
      new URL(pathname, API_ORIGIN),
      {
        method: "POST",
        headers: connectHeaders(credentials),
        body: Buffer.alloc(0),
        signal,
      },
      capability,
    );
    const body = await readBoundedResponseBody(
      response,
      MAX_CONNECT_RESPONSE_BYTES,
      "The vendor response exceeded the safety limit.",
      signal,
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new OfficialComputerError(
          "The Cursor account does not authorize this request.",
          "OFFICIAL_ACCESS_DENIED",
          403,
        );
      }
      if (response.status === 402 || response.status === 429) {
        throw new OfficialComputerError(
          "Official cloud-computer access requires vendor plan capacity or credits.",
          "PAYMENT_REQUIRED",
          402,
        );
      }
      throw new OfficialComputerError(
        "The official cloud-computer service is unavailable.",
        "VENDOR_UNAVAILABLE",
        503,
      );
    }
    return body;
  }

  async function ensureViewer() {
    if (viewer) return viewer;
    if (pendingLogin)
      throw new OfficialComputerError(
        "Finish the Cursor sign-in before opening its computer.",
        "OFFICIAL_SIGN_IN_PENDING",
        409,
      );
    if (viewerPromise) return viewerPromise;
    assertViewerRetryDue();
    const operationAuthEpoch = authEpoch;
    const currentGeneration = ++generation;
    const setupController = new AbortController();
    const setupSignal = setupController.signal;
    let operationStage = "access";
    const operation = (async () => {
      try {
        phase = "checking-access";
        const access = decodeAccessStatus(
          await connectRpc(ACCESS_PATH, "access-status", setupSignal),
        );
        if (access.state !== 1) {
          phase = access.state === 3 ? "payment-required" : "unavailable";
          const message =
            access.state === 3
              ? "Official cloud-computer access requires vendor plan capacity or credits."
              : "Official cloud-computer access is unavailable for this vendor account.";
          lastError = message;
          throw new OfficialComputerError(
            message,
            access.state === 3 ? "PAYMENT_REQUIRED" : "OFFICIAL_UNAVAILABLE",
            access.state === 3 ? 402 : 403,
          );
        }
        if (
          currentGeneration !== generation ||
          operationAuthEpoch !== authEpoch ||
          mode() !== "official"
        )
          throw new OfficialComputerError(
            "The official computer session changed while checking access.",
            "SESSION_CHANGED",
            409,
          );
        operationStage = "provision";
        phase = "provisioning";
        const ensured = decodeEnsureSandbox(
          await connectRpc(ENSURE_PATH, "ensure-box", setupSignal),
        );
        const validated = validateVncDescriptor(ensured);
        if (
          currentGeneration !== generation ||
          operationAuthEpoch !== authEpoch ||
          mode() !== "official"
        )
          throw new OfficialComputerError(
            "The official computer session changed while provisioning.",
            "SESSION_CHANGED",
            409,
          );
        descriptor = Object.freeze({
          networkToken: ensured.networkToken,
          vncUrl: ensured.vncUrl,
          origin: validated.origin,
        });
        operationStage = "viewer";
        phase = "connecting-view";
        const launched = await viewerFactory(descriptor, {
          ...(options.viewerOptions || {}),
          signal: setupSignal,
        });
        if (
          setupSignal.aborted ||
          currentGeneration !== generation ||
          operationAuthEpoch !== authEpoch ||
          mode() !== "official"
        ) {
          await launched.close().catch(() => {});
          throw new OfficialComputerError(
            "The official computer session changed while connecting.",
            "SESSION_CHANGED",
            409,
          );
        }
        viewer = launched;
        resetViewerRecovery();
        phase = "ready";
        lastError = null;
        return viewer;
      } catch (error) {
        descriptor = null;
        const setupError = setupSignal.aborted ? cancelledError() : error;
        if (
          currentGeneration === generation &&
          operationAuthEpoch === authEpoch &&
          mode() === "official"
        ) {
          const safe = safeError(setupError);
          recordViewerRecovery(safe, operationStage);
          if (!["payment-required", "unavailable"].includes(phase))
            phase = "error";
          lastError = safe.message;
        }
        throw setupError;
      }
    })();
    viewerPromise = operation;
    viewerSetupController = setupController;
    try {
      return await operation;
    } finally {
      if (viewerPromise === operation) {
        viewerPromise = null;
        if (viewerSetupController === setupController)
          viewerSetupController = null;
      }
    }
  }

  async function closeViewer() {
    generation += 1;
    actionEpoch += 1;
    frameGeneration = generation;
    frameSequence = 0;
    frameHash = "";
    frameCaptureQueue = Promise.resolve();
    const pending = viewerPromise;
    viewerSetupController?.abort();
    const closing = viewer;
    viewer = null;
    descriptor = null;
    for (const seatId of pendingApprovalSeats)
      approvals.clearSeatAuthorizations(seatId);
    pendingApprovalSeats.clear();
    pendingApprovalFrames.clear();
    controls.clearSeat(SHARED_CONTROL_SEAT);
    if (closing) await closing.close().catch(() => {});
    if (pending) await pending.catch(() => {});
  }

  async function setMode(requestedMode, acknowledged = false) {
    if (requestedMode !== "private" && requestedMode !== "official")
      throw new OfficialComputerError(
        "Unknown computer mode.",
        "INVALID_MODE",
        400,
      );
    if (requestedMode === "private") {
      resetViewerRecovery();
      writeConfig({ mode: "private" });
      await closeViewer();
      phase = readCredentials() ? "signed-in" : "disconnected";
      lastError = null;
      return status();
    }
    if (acknowledged !== true)
      throw new OfficialComputerError(
        "Acknowledge the vendor billing and background-service warning before enabling official mode.",
        "ACKNOWLEDGEMENT_REQUIRED",
        400,
      );
    if (!readCredentials())
      throw new OfficialComputerError(
        "Connect a Cursor account first.",
        "OFFICIAL_SIGN_IN_REQUIRED",
        401,
      );
    resetViewerRecovery();
    writeConfig({
      mode: "official",
      experimentalAcceptedAt: new Date(now()).toISOString(),
    });
    try {
      await ensureViewer();
    } catch (error) {
      await closeViewer();
      throw error;
    }
    return status();
  }

  function status() {
    const credentials = readCredentials();
    const selectedMode = mode();
    let currentPhase = pendingLogin
      ? "signing-in"
      : viewer
        ? "ready"
        : phase === "ready"
          ? "signed-in"
          : phase;
    if (credentials && currentPhase === "disconnected")
      currentPhase = "signed-in";
    return {
      mode: selectedMode,
      connected: Boolean(credentials),
      state: currentPhase,
      ready: Boolean(viewer && selectedMode === "official"),
      generation,
      shared: true,
      provider: "official-grok-cloud",
      experimental: true,
      billingPossible: true,
      permissions: computerPermissions(),
      lastError,
      retrying: retryAttempt > 0,
      retryAfterMs: retryRemainingMs(),
      retryAttempt,
      retryStage,
    };
  }

  async function invalidateActiveViewer(active, error) {
    if (active !== viewer || mode() !== "official") return;
    await closeViewer();
    if (mode() !== "official") return;
    const safe = recordViewerRecovery(error, "viewer");
    if (isRecoverableViewerFailure(safe)) {
      phase = "error";
      lastError = safe.message;
    }
  }

  async function captureTrustedFrame(active) {
    const captureGeneration = generation;
    const operation = frameCaptureQueue.then(async () => {
      if (
        active !== viewer ||
        captureGeneration !== generation ||
        mode() !== "official"
      )
        throw new OfficialComputerError(
          "The official computer session changed before the screen was captured.",
          "SESSION_CHANGED",
          409,
        );
      const frame = await active.capture();
      if (
        active !== viewer ||
        captureGeneration !== generation ||
        mode() !== "official"
      )
        throw new OfficialComputerError(
          "The official computer session changed while the screen was captured.",
          "SESSION_CHANGED",
          409,
        );
      const screenshot = Buffer.from(
        String(frame?.screenshotBase64 || ""),
        "base64",
      );
      if (!screenshot.length)
        throw new OfficialComputerError(
          "The official computer returned an invalid framebuffer.",
          "INVALID_FRAMEBUFFER",
          502,
        );
      const hash = crypto.createHash("sha256").update(screenshot).digest("hex");
      if (frameGeneration !== captureGeneration) {
        frameGeneration = captureGeneration;
        frameSequence = 0;
        frameHash = "";
      }
      if (hash !== frameHash) {
        frameSequence += 1;
        frameHash = hash;
      }
      return {
        frame,
        binding: Object.freeze({
          generation: captureGeneration,
          sequence: frameSequence,
          sha256: hash,
        }),
      };
    });
    frameCaptureQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function captureSeat() {
    if (mode() !== "official")
      throw new OfficialComputerError(
        "Official computer mode is not enabled.",
        "OFFICIAL_MODE_DISABLED",
        409,
      );
    const active = await ensureViewer();
    let captured;
    try {
      captured = await captureTrustedFrame(active);
    } catch (error) {
      await invalidateActiveViewer(active, error);
      throw error;
    }
    const frame = captured.frame;
    return {
      ...frame,
      cursorPosition: frame.cursorPosition || frame.cursor || { x: 0, y: 0 },
      url: "official-computer://shared-primary",
      title: "Official vendor cloud computer",
      pageState: "loaded",
      profileId: "official-cloud-primary",
      activeSeatCount: 1,
      provider: "official",
      shared: true,
      generation,
    };
  }

  async function executeSeatActions(seatKey, rawActions, options = {}) {
    if (mode() !== "official")
      throw new OfficialComputerError(
        "Official computer mode is not enabled.",
        "OFFICIAL_MODE_DISABLED",
        409,
      );
    const seatId = String(seatKey || "").trim();
    if (!seatId || seatId.length > 200)
      throw new OfficialComputerError(
        "A valid employee seat key is required.",
        "INVALID_SEAT",
        400,
      );
    const actions = immutableActions(rawActions);
    const actor = options.actor === "user" ? "user" : "agent";
    const controlId = String(options.controlId || "");
    const actionStartedAt = actionNow();
    const requestedDeadline = Number(options.deadlineMs);
    const localDeadline = actionStartedAt + MAX_ACTION_BATCH_RUNTIME_MS;
    const actionDeadline = Number.isFinite(requestedDeadline)
      ? Math.min(requestedDeadline, localDeadline)
      : localDeadline;
    let mutationMayHaveExecuted = false;
    const actionDeadlineError = () => {
      if (mutationMayHaveExecuted)
        return new OfficialComputerError(
          "The official computer action deadline expired after a change may have occurred. Its outcome is uncertain; inspect the fresh screen before retrying.",
          "ACTION_OUTCOME_UNCERTAIN",
          504,
        );
      return new OfficialComputerError(
        "The official computer action deadline expired before the batch could finish.",
        "ACTION_DEADLINE_EXCEEDED",
        504,
      );
    };
    const assertWithinDeadline = () => {
      if (actionNow() < actionDeadline) return;
      throw actionDeadlineError();
    };
    const beforeDeadline = async (startOperation) => {
      assertWithinDeadline();
      const remainingMs = Math.max(1, actionDeadline - actionNow());
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(startOperation),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(actionDeadlineError()),
              remainingMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (actor === "agent") controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
    else controls.authorizeUser(SHARED_CONTROL_SEAT, controlId);
    const queuedGeneration = generation;
    const run = actionQueue.then(async () => {
      assertWithinDeadline();
      const active = await ensureViewer();
      assertWithinDeadline();
      const executionGeneration = generation;
      if (queuedGeneration !== 0 && queuedGeneration !== executionGeneration)
        throw new OfficialComputerError(
          "The official computer session changed before this action ran.",
          "SESSION_CHANGED",
          409,
        );
      const executionActionEpoch = actionEpoch;
      const assertExecutionContinues = () => {
        if (
          actor === "agent" &&
          (executionActionEpoch !== actionEpoch ||
            controls.status(SHARED_CONTROL_SEAT).controlled)
        )
          throw new OfficialComputerError(
            "The user took control before the official-computer action batch finished.",
            "ACTION_INTERRUPTED",
            409,
          );
        assertWithinDeadline();
      };
      if (actor === "agent") controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
      else controls.authorizeUser(SHARED_CONTROL_SEAT, controlId);
      const requestMutationApproval = async (action) => {
        assertExecutionContinues();
        controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
        let captured;
        try {
          captured = await beforeDeadline(() => captureTrustedFrame(active));
        } catch (error) {
          await invalidateActiveViewer(active, error);
          throw error;
        }
        assertExecutionContinues();
        controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
        if (executionGeneration !== generation)
          throw new OfficialComputerError(
            "The official computer session changed before approval was requested.",
            "SESSION_CHANGED",
            409,
          );
        const trustedContext = {
          frame: captured.binding,
          actions: [
            {
              target: {
                tagName: "canvas",
                role: "application",
                name: "Shared official cloud computer",
              },
            },
          ],
        };
        if (alwaysAllowComputerActions()) {
          return Object.freeze({
            captured,
            decision: Object.freeze({
              allowed: true,
              decision: "always-allow",
              source: "persisted-official-provider-permission",
              riskClass: "permission",
            }),
          });
        }
        pendingApprovalSeats.add(seatId);
        let pendingRequestId = "";
        let decision;
        try {
          const decisionPromise = approvals.requestAgentAction(
            {
              seatId,
              origin: "https://official-cloud-computer.invalid",
              actions: [action],
            },
            trustedContext,
          );
          const pending = approvals.getPendingStatus(seatId);
          if (pending) {
            pendingRequestId = pending.requestId;
            pendingApprovalFrames.set(
              seatId,
              Object.freeze({
                requestId: pendingRequestId,
                frame: Object.freeze({
                  ...captured.binding,
                  screenshotBase64: String(
                    captured.frame?.screenshotBase64 || "",
                  ),
                }),
              }),
            );
            decision = await decisionPromise;
          } else {
            decision = await decisionPromise;
            if (
              decision?.riskClass !== "automatic" ||
              decision?.decision !== "automatic" ||
              decision?.source !== "policy"
            )
              throw new OfficialComputerError(
                "The official-computer approval could not be presented.",
                "APPROVAL_PRESENTATION_FAILED",
                500,
              );
          }
        } finally {
          pendingApprovalSeats.delete(seatId);
          if (pendingApprovalFrames.get(seatId)?.requestId === pendingRequestId)
            pendingApprovalFrames.delete(seatId);
        }
        assertExecutionContinues();
        controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
        if (executionGeneration !== generation)
          throw new OfficialComputerError(
            "The official computer session changed while awaiting approval.",
            "SESSION_CHANGED",
            409,
          );
        if (!decision.allowed)
          throw new OfficialComputerError(
            decision.decision === "deny"
              ? "The user denied this official-computer action."
              : "The official-computer action was not approved before it expired.",
            "ACTION_NOT_APPROVED",
            409,
          );
        return Object.freeze({ captured, decision });
      };
      let agentFrame = null;
      try {
        for (const action of actions) {
          assertExecutionContinues();
          if (actor === "agent")
            controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
          if (actor === "agent" && MUTATING_ACTIONS.has(action.kind)) {
            let permissionBypass = false;
            for (
              let attempt = 1;
              attempt <= MAX_STALE_APPROVAL_ATTEMPTS;
              attempt += 1
            ) {
              const approval = await requestMutationApproval(action);
              permissionBypass =
                approval.decision.source ===
                "persisted-official-provider-permission";
              if (approval.decision.riskClass === "automatic") break;
              const currentFrame = await beforeDeadline(() =>
                captureTrustedFrame(active),
              );
              assertExecutionContinues();
              controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
              if (
                frameStillMatchesApprovedAction(
                  action,
                  approval.captured,
                  currentFrame,
                )
              ) {
                if (permissionBypass && !alwaysAllowComputerActions())
                  throw new OfficialComputerError(
                    "The vendor computer permission was disabled before this action ran.",
                    "ACTION_NOT_APPROVED",
                    409,
                  );
                break;
              }
              if (attempt === MAX_STALE_APPROVAL_ATTEMPTS)
                throw new OfficialComputerError(
                  "The official computer screen kept changing while awaiting approval. Inspect the fresh screen before retrying.",
                  "ACTION_APPROVAL_STALE",
                  409,
                );
            }
          }
          if (MUTATING_ACTIONS.has(action.kind)) mutationMayHaveExecuted = true;
          await beforeDeadline(() =>
            active.execute([action], {
              assertContinue: assertExecutionContinues,
            }),
          );
        }
        assertExecutionContinues();
        if (actor === "agent") controls.assertAgentAllowed(SHARED_CONTROL_SEAT);
        if (actor === "agent")
          agentFrame = await beforeDeadline(() => captureSeat());
      } catch (error) {
        if (error?.code === "ACTION_INTERRUPTED") throw error;
        if (error?.code === "ACTION_APPROVAL_STALE") throw error;
        if (error?.code === "ACTION_NOT_APPROVED") throw error;
        if (error?.code === "SESSION_CHANGED") throw error;
        if (
          error?.code === "ACTION_DEADLINE_EXCEEDED" ||
          error?.code === "ACTION_OUTCOME_UNCERTAIN"
        ) {
          await invalidateActiveViewer(active, error);
          throw error;
        }
        if (mutationMayHaveExecuted) {
          await invalidateActiveViewer(active, error);
          throw new OfficialComputerError(
            "The official computer connection failed during an action. Its outcome is uncertain; inspect the fresh screen before retrying.",
            "ACTION_OUTCOME_UNCERTAIN",
            502,
          );
        }
        await invalidateActiveViewer(active, error);
        throw error;
      }
      if (actor === "user") {
        return {
          screenshotBase64: "",
          cursorPosition: { x: 0, y: 0 },
          url: "official-computer://shared-primary",
          title: "Official vendor cloud computer",
          pageState: "loaded",
          profileId: "official-cloud-primary",
          activeSeatCount: 1,
          provider: "official",
          shared: true,
          generation,
        };
      }
      return agentFrame;
    });
    actionQueue = run.catch(() => {});
    return run;
  }

  function pendingApprovalForSeat(seatKey) {
    const seatId = String(seatKey || "");
    const pending = approvals.getPendingStatus(seatId);
    if (!pending) return null;
    const preview = pendingApprovalFrames.get(seatId);
    if (!preview || preview.requestId !== pending.requestId) return pending;
    return Object.freeze({ ...pending, frame: preview.frame });
  }

  function pendingApprovals() {
    return [...pendingApprovalFrames.keys()]
      .map((seatKey) => pendingApprovalForSeat(seatKey))
      .filter(Boolean);
  }

  function decidePendingApproval(seatKey, decision, binding) {
    const seatId = String(seatKey || "");
    if (seatId !== String(binding?.seatId || ""))
      throw new OfficialComputerError(
        "The approval does not match this employee.",
        "INVALID_APPROVAL",
        400,
      );
    if (decision === "allow-once") {
      const pending = approvals.getPendingStatus(seatId);
      const preview = pendingApprovalFrames.get(seatId);
      const presentedFrame = exactPresentedFrameBinding(
        binding?.presentedFrame,
      );
      if (!presentedFrame)
        throw new OfficialComputerError(
          "Display the exact approval screen before allowing this action.",
          "APPROVAL_FRAME_NOT_PRESENTED",
          409,
        );
      if (
        !pending ||
        !preview ||
        pending.requestId !== preview.requestId ||
        pending.requestId !== String(binding?.requestId || "") ||
        !sameFrameBinding(presentedFrame, preview.frame)
      )
        throw new OfficialComputerError(
          "The displayed approval screen does not match this action.",
          "APPROVAL_FRAME_MISMATCH",
          409,
        );
      return trustedApprover.allowOnce(binding);
    }
    if (decision === "deny") return trustedApprover.deny(binding);
    throw new OfficialComputerError(
      "Official computer actions support Allow once or Deny.",
      "INVALID_APPROVAL",
      400,
    );
  }

  async function acquireUserControl(_seatKey, ownerId) {
    const wasControlled = controls.status(SHARED_CONTROL_SEAT).controlled;
    controls.acquire(SHARED_CONTROL_SEAT, ownerId);
    if (!wasControlled) actionEpoch += 1;
    for (const seatId of pendingApprovalSeats)
      approvals.cancelAgentAction(seatId);
    await actionQueue.catch(() => {});
    return controls.heartbeat(SHARED_CONTROL_SEAT, ownerId);
  }

  function heartbeatUserControl(_seatKey, ownerId) {
    return controls.heartbeat(SHARED_CONTROL_SEAT, ownerId);
  }

  function releaseUserControl(_seatKey, ownerId) {
    return controls.release(SHARED_CONTROL_SEAT, ownerId);
  }

  function controlStatusForSeat() {
    return controls.status(SHARED_CONTROL_SEAT);
  }

  async function closeSeatForKey(seatKey) {
    const seatId = String(seatKey || "");
    approvals.clearSeatAuthorizations(seatId);
    pendingApprovalSeats.delete(seatId);
    pendingApprovalFrames.delete(seatId);
    return true;
  }

  async function logout() {
    authEpoch += 1;
    cancelRefresh();
    pendingLogin?.controller.abort();
    pendingLogin = null;
    await closeViewer();
    forgetCredentials({ preserveMode: false });
    phase = "disconnected";
    lastError = null;
    return status();
  }

  async function shutdown() {
    authEpoch += 1;
    cancelRefresh();
    pendingLogin?.controller.abort();
    pendingLogin = null;
    await closeViewer();
    approvals.dispose();
  }

  return Object.freeze({
    startLogin,
    cancelLogin,
    setMode,
    computerPermissions,
    setComputerPermissions,
    status,
    captureSeat,
    executeSeatActions,
    pendingApprovalForSeat,
    pendingApprovals,
    decidePendingApproval,
    acquireUserControl,
    heartbeatUserControl,
    releaseUserControl,
    controlStatusForSeat,
    closeSeatForKey,
    logout,
    shutdown,
  });
}

const IPC_METHODS = Object.freeze({
  status: (core) => core.status(),
  "login.start": (core) => core.startLogin(),
  "login.cancel": (core) => core.cancelLogin(),
  logout: (core) => core.logout(),
  "mode.set": (core, args) => core.setMode(args?.mode, args?.acknowledged),
  "permission.get": (core) => core.computerPermissions(),
  "permission.set": (core, args) =>
    core.setComputerPermissions(
      args?.alwaysAllowComputerActions,
      args?.acknowledged,
      args?.provider,
    ),
  "frame.get": (core) => core.captureSeat(),
  "input.send": (core, args) =>
    core.executeSeatActions(args?.seatKey, args?.actions, {
      actor: args?.actor,
      controlId: args?.controlId,
      deadlineMs: args?.deadlineMs,
    }),
  "approval.get": (core, args) => core.pendingApprovalForSeat(args?.seatKey),
  "approval.list": (core) => core.pendingApprovals(),
  "approval.decide": (core, args) =>
    core.decidePendingApproval(args?.seatKey, args?.decision, args?.binding),
  "control.get": (core, args) => core.controlStatusForSeat(args?.seatKey),
  "control.acquire": (core, args) =>
    core.acquireUserControl(args?.seatKey, args?.controlId),
  "control.heartbeat": (core, args) =>
    core.heartbeatUserControl(args?.seatKey, args?.controlId),
  "control.release": (core, args) =>
    core.releaseUserControl(args?.seatKey, args?.controlId),
  "seat.close": (core, args) => core.closeSeatForKey(args?.seatKey),
  shutdown: (core) => core.shutdown(),
});

function runIpcHelper() {
  const core = createOfficialComputerCore();
  process.on("message", async (message) => {
    const id = String(message?.id || "");
    const method = String(message?.method || "");
    if (
      !/^[A-Za-z0-9_-]{8,128}$/.test(id) ||
      !Object.hasOwn(IPC_METHODS, method)
    ) {
      process.send?.({
        id,
        ok: false,
        error: {
          code: "INVALID_HELPER_REQUEST",
          message: "The official-computer helper rejected this request.",
          statusCode: 400,
        },
      });
      return;
    }
    try {
      const result = await IPC_METHODS[method](core, message.args || {});
      if (method === "shutdown") {
        if (typeof process.send === "function")
          process.send({ id, ok: true, result }, () => process.exit(0));
        else process.exit(0);
        return;
      }
      process.send?.({ id, ok: true, result });
    } catch (error) {
      const safe = safeError(error);
      process.send?.({
        id,
        ok: false,
        error: {
          code: safe.code,
          message: safe.message,
          statusCode: safe.statusCode,
        },
      });
    }
  });
  process.on("disconnect", () => {
    const forceExit = setTimeout(() => process.exit(0), 10000);
    void core.shutdown().finally(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}

if (require.main === module) runIpcHelper();

module.exports = {
  API_ORIGIN,
  LOGIN_ORIGIN,
  ACCESS_PATH,
  ENSURE_PATH,
  MAX_ACTION_BATCH_RUNTIME_MS,
  MAX_DECLARED_ACTION_BUDGET_MS,
  MAX_WAIT_ACTION_MS,
  OFFICIAL_ACTION_APPROVAL_TTL_MS,
  OFFICIAL_RETRY_BASE_MS,
  OFFICIAL_RETRY_MAX_MS,
  OfficialComputerError,
  assertAllowedVendorRequest,
  createCursorChecksum,
  createOfficialComputerCore,
  decodeAccessStatus,
  decodeEnsureSandbox,
  hardenNoVncSource,
  validateLoginUrl,
  validateVncDescriptor,
  immutableActions,
  readBoundedJsonResponse,
  rfbKeyChord,
  sendRfbKeyChord,
  startNoVncViewer,
  unicodeKeysymForCodePoint,
};
