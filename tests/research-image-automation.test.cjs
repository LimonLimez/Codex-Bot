"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const connectionPath = path.join(root, "src", "codex-connection.cjs");
const connectionStateKey = Symbol.for("open-bot.codex-connection-state");

function isolatedConnection(t) {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "open-bot-research-"),
  );
  const previous = {
    stateRoot: process.env.CODEX_BOT_STATE_ROOT,
    authDir: process.env.GROK_BOT_CODEX_AUTH_DIR,
  };
  process.env.CODEX_BOT_STATE_ROOT = stateRoot;
  process.env.GROK_BOT_CODEX_AUTH_DIR = path.join(stateRoot, "oauth");
  globalThis[connectionStateKey] = null;
  delete require.cache[require.resolve(connectionPath)];
  t.after(() => {
    if (previous.stateRoot == null) delete process.env.CODEX_BOT_STATE_ROOT;
    else process.env.CODEX_BOT_STATE_ROOT = previous.stateRoot;
    if (previous.authDir == null) delete process.env.GROK_BOT_CODEX_AUTH_DIR;
    else process.env.GROK_BOT_CODEX_AUTH_DIR = previous.authDir;
    globalThis[connectionStateKey] = null;
    delete require.cache[require.resolve(connectionPath)];
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  return require(connectionPath);
}

test("Research mode persists globally and per employee with strict validation", (t) => {
  const connection = isolatedConnection(t);
  assert.equal(connection.getPreferences().effective.responseMode, "chat");
  connection.setDefaultPreferences({ responseMode: "research" });
  assert.equal(connection.getConnection().responseMode, "research");
  connection.setAgentPreferences("researcher-1", { responseMode: "chat" });
  assert.equal(connection.getConnection("researcher-1").responseMode, "chat");
  assert.throws(
    () =>
      connection.setAgentPreferences("researcher-1", { responseMode: "deep" }),
    /responseMode must be one of: chat, search, research/,
  );
});

test("OpenAI API-key validation rejects keys for other local integrations before any request", (t) => {
  const connection = isolatedConnection(t);
  assert.throws(
    () => connection.validateOpenAiApiKey(`ak_${"x".repeat(40)}`),
    /Composio project key.*Connected apps/i,
  );
  assert.throws(
    () => connection.validateOpenAiApiKey(`sk-or-v1-${"x".repeat(40)}`),
    /OpenRouter key/i,
  );
  assert.throws(
    () => connection.validateOpenAiApiKey(`pk_${"x".repeat(40)}`),
    /direct OpenAI API key/i,
  );
  assert.doesNotThrow(() =>
    connection.validateOpenAiApiKey(`sk-proj-${"x".repeat(40)}`),
  );
});

test("GPT Image 2 is API-key gated and returns only a bounded PNG data URL", async (t) => {
  const connection = isolatedConnection(t);
  const unavailable = connection.imageCapability();
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /direct OpenAI API key/);

  connection.setApiKey(`sk-test-${"x".repeat(40)}`);
  assert.equal(connection.imageCapability().available, true);
  let captured = null;
  const imageBytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from("bounded-test-image-payload"),
  ]);
  const output = await connection.generateImage(
    {
      prompt: "A careful field sketch of a moonlit fox",
      size: "1024x1024",
      quality: "low",
    },
    async (url, init) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  assert.equal(captured.url, "https://api.openai.com/v1/images/generations");
  assert.deepEqual(JSON.parse(captured.init.body), {
    model: "gpt-image-2",
    prompt: "A careful field sketch of a moonlit fox",
    size: "1024x1024",
    quality: "low",
  });
  assert.match(captured.init.headers.Authorization, /^Bearer sk-test-/);
  assert.deepEqual(output, {
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "low",
    dataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
  });
  assert.doesNotMatch(JSON.stringify(output), /sk-test-/);
});

test("research UI and Always On scheduler expose the durable behavior", () => {
  const renderer = fs.readFileSync(
    path.join(root, "src", "renderer", "codex-ui.js"),
    "utf8",
  );
  const connection = fs.readFileSync(
    path.join(root, "src", "codex-connection.cjs"),
    "utf8",
  );
  const bridge = fs.readFileSync(path.join(root, "src", "bridge.cjs"), "utf8");
  const patcher = fs.readFileSync(
    path.join(root, "scripts", "patch-app.cjs"),
    "utf8",
  );
  const alwaysOn = fs.readFileSync(
    path.join(root, "src", "runtime", "Enable-Always-On.ps1"),
    "utf8",
  );

  assert.match(renderer, /data-codex-pick-mode="research"/);
  assert.match(renderer, /data-codex-pick-mode="search"/);
  assert.match(renderer, /Browse \+ sources/);
  assert.match(renderer, /data-codex-image-form/);
  assert.match(connection, /GPT Image 2 requires a direct OpenAI API key/);
  assert.match(bridge, /Consult at least two independent, relevant sources/);
  assert.match(bridge, /compact \*\*Sources\*\* section/);
  assert.match(patcher, /localRoutineScanInFlight/);
  assert.match(patcher, /localRoutineRunsInFlight/);
  assert.match(patcher, /localRoutineRecentlyCompleted/);
  assert.match(patcher, /localRoutineCatchupWindowMs = 24 \* 60 \* 60 \* 1e3/);
  assert.match(patcher, /latestDueRoutineTime/);
  assert.match(alwaysOn, /-StartWhenAvailable/);
  assert.match(alwaysOn, /-MultipleInstances IgnoreNew/);
  assert.match(alwaysOn, /-RestartCount 10/);
});
