"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const { once } = require("node:events");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const stateRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-bot-privacy-test-"),
);
process.env.CODEX_BOT_STATE_ROOT = stateRoot;
process.env.GROK_BOT_BROWSER_SEAT_DATA = path.join(stateRoot, "browser-seats");
process.env.GROK_BOT_BROWSER_VIEW_TOKEN = "test-view-token-".padEnd(32, "x");

const connection = require(path.join(root, "src", "codex-connection.cjs"));
const bridge = require(path.join(root, "src", "bridge.cjs"));
const seatBridge = require(path.join(root, "src", "browser-seat-bridge.cjs"));

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test("central log redaction removes URL secrets and credential-shaped values", () => {
  const credentialUrl =
    "https://alice" +
    ":password@example.com/private/path?token=query-secret#fragment";
  const apiKey = "sk-proj-" + "a".repeat(32);
  const jwt = ["eyJ" + "a".repeat(32), "b".repeat(32), "c".repeat(24)].join(
    ".",
  );
  const input = `request ${credentialUrl} Authorization: Bearer bearer-secret api_key=${apiKey} jwt=${jwt} device code ABCD-EFGH`;
  const redacted = connection.redactSensitiveText(input);

  assert.match(redacted, /https:\/\/example\.com/);
  assert.doesNotMatch(
    redacted,
    /alice|password|private\/path|query-secret|fragment|bearer-secret/,
  );
  assert.doesNotMatch(redacted, new RegExp(apiKey.replaceAll("-", "\\-")));
  assert.doesNotMatch(redacted, new RegExp(jwt.replaceAll(".", "\\.")));
  assert.doesNotMatch(redacted, /ABCD-EFGH/);
  assert.match(redacted, /\[REDACTED\]/);

  const fields = connection.redactLogDetails({
    target: credentialUrl,
    authorization: `Bearer ${apiKey}`,
    nested: { deviceCode: "WXYZ-1234" },
  });
  assert.equal(fields.target, "https://example.com");
  assert.equal(fields.authorization, "[REDACTED]");
  assert.equal(fields.nested.deviceCode, "[REDACTED]");
});

test("browser bridge returns and logs redacted tool errors", async () => {
  const credentialUrl =
    "https://user" + ":pass@example.net/account?access_token=secret#private";
  const apiKey = "sk-" + "z".repeat(36);
  const original = seatBridge.privateManager.executeSeatActions;
  seatBridge.privateManager.executeSeatActions = async () => {
    throw new Error(
      `Navigation failed at ${credentialUrl}; Authorization: Bearer ${apiKey}`,
    );
  };

  class Value {
    constructor(value) {
      Object.assign(this, value);
    }
  }

  try {
    const executor = seatBridge.createExecutor({
      seatKey: "privacy-test-seat",
      ComputerUseResult: Value,
      ComputerUseSuccess: Value,
      ComputerUseError: Value,
      Coordinate: Value,
    });
    const result = await executor.execute(null, {
      actions: [],
      toolCallId: "privacy-test-call",
    });
    const returned = result.result.value.error;
    assert.match(returned, /https:\/\/example\.net/);
    assert.doesNotMatch(returned, /user|pass|account|access_token|secret|sk-/i);

    const log = fs.readFileSync(
      path.join(stateRoot, "logs", "browser-seats.jsonl"),
      "utf8",
    );
    assert.doesNotMatch(log, /user|pass|account|access_token|secret|sk-/i);
  } finally {
    seatBridge.privateManager.executeSeatActions = original;
  }
});

test("seat-control JSON parsing accepts normal bodies and drains oversized bodies without retention", async () => {
  const valid = new PassThrough();
  const validResult = seatBridge.readJson(valid);
  valid.end(Buffer.from('{"ok":true}', "utf8"));
  assert.deepEqual(await validResult, { ok: true });

  const oversized = new PassThrough();
  const ended = once(oversized, "end");
  const rejected = seatBridge.readJson(oversized);
  oversized.write(Buffer.alloc(seatBridge.MAX_JSON_BODY_BYTES + 1, 0x61));
  oversized.end(Buffer.alloc(seatBridge.MAX_JSON_BODY_BYTES * 2, 0x62));
  await assert.rejects(rejected, /too large/i);
  await ended;
  assert.equal(oversized.readableLength, 0);
});

test("SSE parsing accepts split events and aborts an oversized event line", async () => {
  const events = [];
  for await (const event of bridge.sseEvents(
    Readable.from([
      Buffer.from('data: {"choices":[', "utf8"),
      Buffer.from('{"delta":{"content":"ok"}}]}\n\n', "utf8"),
      Buffer.from("data: [DONE]\n", "utf8"),
    ]),
  ))
    events.push(event);
  assert.deepEqual(events, [{ choices: [{ delta: { content: "ok" } }] }]);

  let iteratorClosed = false;
  async function* oversizedBody() {
    try {
      yield Buffer.from(
        `data: ${"x".repeat(bridge.MAX_SSE_LINE_BYTES + 1)}`,
        "utf8",
      );
    } finally {
      iteratorClosed = true;
    }
  }

  const iterator = bridge.sseEvents(oversizedBody());
  await assert.rejects(iterator.next(), /SSE event line is too large/i);
  assert.equal(iteratorClosed, true);
});
