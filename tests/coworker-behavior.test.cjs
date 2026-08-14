"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const stateRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "codex-bot-coworker-test-"),
);
process.env.CODEX_BOT_STATE_ROOT = stateRoot;

const root = path.resolve(__dirname, "..");
const connectionManager = require(
  path.join(root, "src", "codex-connection.cjs"),
);
const bridge = require(path.join(root, "src", "bridge.cjs"));
const patcher = require(path.join(root, "scripts", "patch-app.cjs"));

test.after(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

const COMPUTER_ACTIONS = [
  "screenshot",
  "click",
  "move",
  "drag",
  "type",
  "key",
  "scroll",
  "wait",
];
const COMPUTER_FOLLOW_UP_ACTIONS = COMPUTER_ACTIONS.filter(
  (action) => action !== "screenshot",
);

function computerActionProperties(actions) {
  return {
    action: { type: "string", enum: [...actions] },
    x: { type: "integer" },
    y: { type: "integer" },
    text: { type: "string" },
    durationMs: { type: "integer", minimum: 0, maximum: 30_000 },
  };
}

function computerParameters() {
  return {
    type: "object",
    properties: {
      ...computerActionProperties(COMPUTER_ACTIONS),
      then: {
        type: "array",
        minItems: 1,
        maxItems: 9,
        items: {
          type: "object",
          properties: computerActionProperties(COMPUTER_FOLLOW_UP_ACTIONS),
          required: ["action"],
        },
      },
      description: { type: "string" },
    },
    required: ["action"],
  };
}

function computerTool(overrides = {}) {
  return {
    name: "Computer",
    description: "Control the box desktop.",
    parameters: computerParameters(),
    ...overrides,
  };
}

function aiSdkJsonSchema(jsonSchema, overrides = {}) {
  return {
    [Symbol.for("vercel.ai.schema")]: true,
    _type: undefined,
    [Symbol.for("vercel.ai.validator")]: true,
    jsonSchema,
    validate: undefined,
    ...overrides,
  };
}

function updateStateParameters() {
  return {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["memory", "profile", "settings"],
      },
      action: { type: "string", enum: ["write", "forget", "set"] },
      name: { type: "string", minLength: 1 },
      description: { type: "string" },
    },
    required: ["target", "action"],
  };
}

test("coworker compatibility policy supplements and preserves specific host context", () => {
  const profile =
    "Agent profile:\nTitle: Timmy\nDescription: Head of Marketing";
  const directory = "Your teammates:\n- Corry (id: corry) — marketing designer";
  const converted = bridge.convertMessages([
    { role: "system", content: profile },
    { role: "developer", content: directory },
    { role: "user", content: "[first run] This is your very first turn." },
  ]);

  assert.deepEqual(converted[0], { role: "system", content: profile });
  assert.deepEqual(converted[1], { role: "developer", content: directory });
  assert.equal(converted[2].role, "system");
  assert.match(
    converted[2].content,
    /supplement the host's conversation policy/i,
  );
  assert.match(converted[2].content, /first run/i);
  assert.match(converted[2].content, /phrases such as "you're Bob"/i);
  assert.match(converted[2].content, /common typed\/voice variant "your Bob"/i);
  assert.match(
    converted[2].content,
    /update_state target "profile" action "set"/i,
  );
  assert.match(converted[2].content, /ordinary predicates and possessives/i);
  assert.match(converted[2].content, /SendToAgent/);
  assert.doesNotMatch(converted[2].content, /replace earlier/i);
  assert.doesNotMatch(
    converted[2].content,
    /Do not send an opening acknowledgement/i,
  );
  assert.deepEqual(converted[3], {
    role: "user",
    content: "[first run] This is your very first turn.",
  });
});

test("team messaging and question-widget schemas pass through the local tool bridge", () => {
  const widgetParameters = {
    type: "object",
    properties: {
      type: { enum: ["text", "widget"] },
      widget: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          allowCustom: { type: "boolean" },
        },
      },
    },
  };
  const converted = bridge.convertTools([
    {
      name: "SendMessage",
      description: "talk to the user",
      parameters: widgetParameters,
    },
    {
      name: "SendToAgent",
      description: "talk to a teammate",
      parameters: { type: "object" },
    },
    {
      name: "ReactToMessage",
      description: "react",
      parameters: { type: "object" },
    },
  ]);

  assert.deepEqual(
    converted.map((tool) => tool.function.name),
    ["SendMessage", "SendToAgent", "ReactToMessage"],
  );
  assert.deepEqual(converted[0].function.parameters, widgetParameters);
});

test("Computer compatibility is schema-gated, bounded, and fail-closed", () => {
  const converted = bridge.convertTools([computerTool()]);
  const guidance = bridge.computerToolUseMessage(converted);
  assert.ok(guidance);
  assert.match(guidance.content, /\{"action":"screenshot"\}/);
  assert.match(guidance.content, /later actions in "then"/i);
  assert.match(guidance.content, /Never send an "actions" property/i);
  assert.match(guidance.content, /CTRL\+L/);
  assert.match(guidance.content, /type the canonical https:\/\/ URL/i);
  assert.match(
    guidance.content,
    /Do not click or type into a webpage search field/i,
  );
  assert.match(guidance.content, /do not claim success/i);
  assert.match(guidance.content, /do not use META/i);
  assert.match(converted[0].function.description, /flattened action object/i);

  const livePayload = { actions: [{ action: "screenshot" }] };
  assert.deepEqual(
    bridge.normalizeComputerToolCallArgs("Computer", livePayload, converted),
    { action: "screenshot" },
  );
  const alreadyFlattened = { action: "screenshot" };
  assert.strictEqual(
    bridge.normalizeComputerToolCallArgs(
      "Computer",
      alreadyFlattened,
      converted,
    ),
    alreadyFlattened,
  );
  const batchPayload = {
    actions: [
      { action: "click", x: 120, y: 240 },
      { action: "type", text: "hello" },
      { action: "wait", durationMs: 250 },
    ],
  };
  assert.deepEqual(
    bridge.normalizeComputerToolCallArgs("Computer", batchPayload, converted),
    {
      action: "click",
      x: 120,
      y: 240,
      then: [
        { action: "type", text: "hello" },
        { action: "wait", durationMs: 250 },
      ],
    },
  );

  const malformed = [
    {},
    { actions: [] },
    {
      action: "screenshot",
      actions: [{ action: "screenshot" }],
    },
    { actions: [{ action: "not-real" }] },
    { actions: [{ action: "click", x: "120", y: 240 }] },
    { actions: [{ action: "screenshot", unexpected: true }] },
    {
      actions: [{ action: "click", x: 1, y: 2 }, { action: "screenshot" }],
    },
    {
      actions: [
        { action: "screenshot" },
        ...Array.from({ length: 10 }, () => ({ action: "wait" })),
      ],
    },
  ];
  for (const payload of malformed) {
    assert.strictEqual(
      bridge.normalizeComputerToolCallArgs("Computer", payload, converted),
      payload,
    );
  }

  const unknownPayload = { actions: [{ action: "screenshot" }] };
  assert.strictEqual(
    bridge.normalizeComputerToolCallArgs(
      "SomeOtherTool",
      unknownPayload,
      converted,
    ),
    unknownPayload,
  );

  const liveParameters = computerParameters();
  const wrappedTool = computerTool({
    parameters: aiSdkJsonSchema(liveParameters),
  });
  const liveConverted = bridge.convertTools([wrappedTool]);
  assert.strictEqual(liveConverted[0].function.parameters, liveParameters);
  assert.deepEqual(
    bridge.normalizeComputerToolCallArgs(
      "Computer",
      livePayload,
      liveConverted,
    ),
    { action: "screenshot" },
  );
  assert.strictEqual(
    wrappedTool.parameters.jsonSchema,
    liveParameters,
    "conversion must not mutate the host's branded schema wrapper",
  );

  const wrappedUnknownParameters = aiSdkJsonSchema(computerParameters());
  const wrappedUnknown = bridge.convertTools([
    {
      name: "SomeOtherTool",
      parameters: wrappedUnknownParameters,
    },
  ]);
  assert.strictEqual(
    wrappedUnknown[0].function.parameters,
    wrappedUnknownParameters,
    "only the actual Computer tool may unwrap the compatibility schema",
  );

  for (const parameters of [
    { jsonSchema: computerParameters() },
    aiSdkJsonSchema(computerParameters(), {
      [Symbol.for("vercel.ai.validator")]: false,
    }),
    aiSdkJsonSchema(computerParameters(), { validate: "not-a-validator" }),
  ]) {
    const lookalike = bridge.convertTools([computerTool({ parameters })]);
    assert.equal(bridge.computerToolUseMessage(lookalike), null);
    assert.strictEqual(
      bridge.normalizeComputerToolCallArgs(
        "Computer",
        unknownPayload,
        lookalike,
      ),
      unknownPayload,
    );
  }

  const unqualified = bridge.convertTools([
    computerTool({
      parameters: {
        type: "object",
        properties: { actions: { type: "array" } },
        required: ["actions"],
      },
    }),
  ]);
  assert.equal(bridge.computerToolUseMessage(unqualified), null);
  assert.strictEqual(
    bridge.normalizeComputerToolCallArgs(
      "Computer",
      unknownPayload,
      unqualified,
    ),
    unknownPayload,
  );
  const duplicates = bridge.convertTools([computerTool(), computerTool()]);
  assert.equal(bridge.computerToolUseMessage(duplicates), null);
  assert.strictEqual(
    bridge.normalizeComputerToolCallArgs(
      "Computer",
      unknownPayload,
      duplicates,
    ),
    unknownPayload,
  );
});

test("explicit personal-name assignments are constrained without treating predicates or roles as names", () => {
  for (const [text, expected] of [
    ["call yourself Launch Fox", "Launch Fox"],
    ["set your name to O'Connor", "O'Connor"],
    ["Your name is 小明", "小明"],
  ]) {
    assert.equal(bridge.assignedNameFromText(text), expected, text);
  }
  for (const text of [
    "Be my marketing researcher",
    "You're my marketing researcher",
    "You are our launch assistant",
    "Your role is design lead",
    "You're awesome",
    "You are right",
    "You're welcome",
    "You are amazing",
    "Your turn",
    "Your computer",
    "Your account",
    "Your email",
    "Your screen",
    "Your website",
    "Your keyboard",
    "Your browser",
    "Your password",
    "Your session",
    "Your cursor",
    "Your bob",
    "You're Bob",
    "You are Fantastic",
    "You are Brilliant",
    "You are Perfect",
    "go to x.com",
    "your",
  ]) {
    assert.equal(bridge.assignedNameFromText(text), null, text);
  }

  assert.equal(
    bridge.assignedNameFromMessages([
      {
        role: "user",
        content:
          "<timestamp>now</timestamp><user_query>[t0u]\nYour bob\n\n[SAND_HIDDEN_PROMPT]<agent_profile_update>Current name: Your bob</agent_profile_update></user_query>",
      },
    ]),
    null,
  );
  assert.equal(
    bridge.assignedNameFromMessages([
      { role: "user", content: "call yourself bob" },
      {
        role: "user",
        content:
          "[SAND_HIDDEN_PROMPT]<agent_profile_update>Current name: bob</agent_profile_update>",
      },
    ]),
    null,
  );
});

test(
  "colloquial names and ordinary predicates stay on the normal model path",
  { concurrency: false },
  async () => {
    const originalGetConnection = connectionManager.getConnection;
    const originalFetch = globalThis.fetch;
    const payloads = [];
    connectionManager.getConnection = () => ({
      mode: "codex-oauth",
      route: "cliproxyapi-codex-oauth",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "local-test-key",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      fastMode: false,
    });
    globalThis.fetch = async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      const body = [
        {
          id: "ordinary-response",
          choices: [{ delta: { content: "Normal model reply." } }],
        },
        {
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const tools = [
      {
        name: "SendMessage",
        description: "Send a visible message.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "update_state",
        description: "Change your state.",
        parameters: aiSdkJsonSchema(updateStateParameters()),
      },
    ];
    const messages = [
      "Your bob",
      "You're Bob",
      "Your account",
      "Your password",
      "Your screen",
      "You are Fantastic",
      "You are Brilliant",
      "You are Perfect",
    ];
    try {
      for (const content of messages) {
        const session = bridge.createPromptSession({
          agentId: "ordinary-language-bot",
        });
        const result = session
          .getExecutor([{ role: "user", content }])
          .stream({}, `ordinary-${payloads.length}`, tools, {});
        const events = [];
        for await (const event of result.fullStream) events.push(event);
        const payload = payloads.at(-1);

        assert.equal(payload.tool_choice, "auto", content);
        assert.equal(payload.parallel_tool_calls, true, content);
        assert.deepEqual(
          payload.tools.map((tool) => tool.function.name),
          ["SendMessage", "update_state"],
          content,
        );
        assert.equal(
          payload.messages.some((message) =>
            String(message.content).includes("<active_name_assignment>"),
          ),
          false,
          content,
        );
        assert.equal(
          events.some(
            (event) =>
              event.type === "text-delta" &&
              event.textDelta === "Normal model reply.",
          ),
          true,
          content,
        );
      }
    } finally {
      connectionManager.getConnection = originalGetConnection;
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  "an explicit personal name forces one exact self-profile update",
  { concurrency: false },
  async () => {
    const originalGetConnection = connectionManager.getConnection;
    const originalFetch = globalThis.fetch;
    let payload;
    connectionManager.getConnection = () => ({
      mode: "codex-oauth",
      route: "cliproxyapi-codex-oauth",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "local-test-key",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      fastMode: false,
    });
    globalThis.fetch = async (_url, options) => {
      payload = JSON.parse(options.body);
      const args = JSON.stringify({
        target: "settings",
        action: "forget",
        name: "alice",
      });
      const body = [
        {
          id: "name-assignment-response",
          choices: [
            {
              delta: {
                content: "I think you meant bob.",
                tool_calls: [
                  {
                    index: 0,
                    id: "rename-self",
                    function: { name: "SendMessage", arguments: args },
                  },
                  {
                    index: 1,
                    id: "rename-self-duplicate",
                    function: { name: "update_state", arguments: args },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const tools = [
      {
        name: "SendMessage",
        description: "Send a visible message.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "update_state",
        description: "Change your state.",
        parameters: aiSdkJsonSchema(updateStateParameters()),
      },
    ];
    try {
      const session = bridge.createPromptSession({ agentId: "name-bot" });
      const result = session
        .getExecutor([
          {
            role: "user",
            content:
              "<timestamp>now</timestamp><user_query>[t0u]\ncall yourself bob\n\n[SAND_HIDDEN_PROMPT]<agent_profile_update>Current name: New Bot</agent_profile_update></user_query>",
          },
        ])
        .stream({}, "name-assignment-invocation", tools, {});
      const events = [];
      for await (const event of result.fullStream) events.push(event);
      const response = await result.response;

      assert.deepEqual(payload.tool_choice, {
        type: "function",
        function: { name: "update_state" },
      });
      assert.equal(payload.parallel_tool_calls, false);
      assert.deepEqual(
        payload.tools.map((tool) => tool.function.name),
        ["update_state"],
      );
      assert.deepEqual(payload.tools[0].function.parameters, {
        type: "object",
        properties: {
          target: { type: "string", enum: ["profile"] },
          action: { type: "string", enum: ["set"] },
          name: { type: "string", enum: ["bob"] },
        },
        required: ["target", "action", "name"],
        additionalProperties: false,
      });
      const instruction = payload.messages.find((message) =>
        String(message.content).includes("<active_name_assignment>"),
      );
      assert.ok(instruction);
      assert.match(instruction.content, /"bob"/);
      assert.equal(
        events.filter((event) => event.type === "tool-call").length,
        1,
      );
      assert.equal(
        events.some((event) => event.type === "text-delta"),
        false,
      );
      assert.deepEqual(
        JSON.parse(
          events
            .filter((event) => event.type === "tool-call-delta")
            .map((event) => event.argsTextDelta)
            .join(""),
        ),
        { target: "profile", action: "set", name: "bob" },
      );
      assert.deepEqual(response.messages[0].content, [
        {
          type: "tool-call",
          toolCallId: "rename-self",
          toolName: "update_state",
          args: { target: "profile", action: "set", name: "bob" },
        },
      ]);
    } finally {
      connectionManager.getConnection = originalGetConnection;
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  "explicit rename routing fails closed for an incompatible update_state schema",
  { concurrency: false },
  async () => {
    const originalGetConnection = connectionManager.getConnection;
    const originalFetch = globalThis.fetch;
    let payload;
    connectionManager.getConnection = () => ({
      mode: "codex-oauth",
      route: "cliproxyapi-codex-oauth",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "local-test-key",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      fastMode: false,
    });
    globalThis.fetch = async (_url, options) => {
      payload = JSON.parse(options.body);
      const body = [
        {
          id: "incompatible-schema-response",
          choices: [{ delta: { content: "Cannot safely force the rename." } }],
        },
        {
          choices: [],
          usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const tools = [
      {
        name: "SendMessage",
        description: "Send a visible message.",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "update_state",
        description: "Malformed test-only state tool.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "integer" },
            action: { type: "string", enum: ["set"] },
            name: { type: "string" },
          },
        },
      },
    ];
    try {
      const result = bridge
        .createPromptSession({ agentId: "incompatible-name-bot" })
        .getExecutor([{ role: "user", content: "call yourself bob" }])
        .stream({}, "incompatible-name-invocation", tools, {});
      const events = [];
      for await (const event of result.fullStream) events.push(event);

      assert.equal(payload.tool_choice, "auto");
      assert.equal(payload.parallel_tool_calls, true);
      assert.deepEqual(
        payload.tools.map((tool) => tool.function.name),
        ["SendMessage", "update_state"],
      );
      assert.equal(
        payload.messages.some((message) =>
          String(message.content).includes("<active_name_assignment>"),
        ),
        false,
      );
      assert.equal(
        events.some(
          (event) =>
            event.type === "text-delta" &&
            event.textDelta === "Cannot safely force the rename.",
        ),
        true,
      );
    } finally {
      connectionManager.getConnection = originalGetConnection;
      globalThis.fetch = originalFetch;
    }
  },
);

test("explicit role-orientation requests are distinguished from concrete assignments", () => {
  assert.equal(
    bridge.isRoleOrientationTurn([
      {
        role: "user",
        content:
          "You’re my launch operations partner. Help me keep weekly launches organized across design, content, and publishing. Start by understanding how I want you to work with me.",
      },
    ]),
    true,
  );
  assert.equal(
    bridge.isRoleOrientationTurn([
      {
        role: "user",
        content:
          "You're my launch operations partner. Publish this week's approved launch checklist now.",
      },
    ]),
    false,
  );
  assert.equal(
    bridge.isRoleOrientationTurn([
      { role: "user", content: "[first run] This is your very first turn." },
    ]),
    false,
  );
});

test(
  "an active role-orientation turn is one constrained question widget with no immediate duplicate path",
  { concurrency: false },
  async () => {
    const originalGetConnection = connectionManager.getConnection;
    const originalFetch = globalThis.fetch;
    let payload;
    connectionManager.getConnection = () => ({
      mode: "codex-oauth",
      route: "cliproxyapi-codex-oauth",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "local-test-key",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      fastMode: false,
    });
    globalThis.fetch = async (_url, options) => {
      payload = JSON.parse(options.body);
      const args = JSON.stringify({
        type: "widget",
        widget: {
          prompt:
            "I’ll keep the weekly launch moving across design, content, and publishing. How proactively should I drive the plan?",
          options: [
            { label: "Drive it", value: "Drive it proactively" },
            { label: "Check in", value: "Check in at key decisions" },
            { label: "Track only", value: "Track and report only" },
          ],
          allowCustom: true,
        },
      });
      const body = [
        {
          id: "role-orientation-response",
          choices: [
            {
              delta: {
                content:
                  "I’ll help with launches. Here is the same acknowledgement outside the widget.",
                tool_calls: [
                  {
                    index: 0,
                    id: "send-role-orientation",
                    function: { name: "SendMessage", arguments: args },
                  },
                  {
                    index: 1,
                    id: "send-role-orientation-duplicate",
                    function: { name: "SendMessage", arguments: args },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const sendMessageParameters = {
      type: "object",
      properties: {
        type: { type: "string", enum: ["text", "widget"] },
        content: { type: "string" },
        widget: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            options: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: {
                type: "object",
                properties: { label: { type: "string" } },
                required: ["label"],
              },
            },
            allowCustom: { type: "boolean" },
          },
          required: ["prompt", "options"],
        },
      },
      required: ["type"],
    };
    const tools = [
      {
        name: "SendMessage",
        description: "Send one visible message to the user.",
        parameters: sendMessageParameters,
      },
      {
        name: "Computer",
        description: "Control the browser.",
        parameters: { type: "object", properties: {} },
      },
    ];
    const history = [
      {
        role: "system",
        content:
          "Agent profile:\nTitle: New Bot\nDescription: General assistant",
      },
      { role: "user", content: "[first run] This is your very first turn." },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "send-greeting",
            toolName: "SendMessage",
            args: {
              type: "text",
              content: "Hey, I’m New Bot. Glad to be here.",
            },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "send-greeting",
            toolName: "SendMessage",
            result: { content: [{ type: "text", text: "Message sent" }] },
          },
        ],
      },
      {
        role: "user",
        content:
          "You’re my launch operations partner. Help me keep weekly launches organized across design, content, and publishing. Start by understanding how I want you to work with me.",
      },
    ];

    try {
      const session = bridge.createPromptSession({ agentId: "role-bot" });
      const result = session
        .getExecutor(history)
        .stream({}, "role-orientation-invocation", tools, {});
      const events = [];
      for await (const event of result.fullStream) events.push(event);
      const response = await result.response;

      assert.deepEqual(payload.tool_choice, {
        type: "function",
        function: { name: "SendMessage" },
      });
      assert.equal(payload.parallel_tool_calls, false);
      const activeInstruction = payload.messages.find((message) =>
        String(message.content).includes("<active_role_orientation>"),
      );
      assert.ok(activeInstruction);
      assert.match(activeInstruction.content, /exactly one SendMessage call/i);
      assert.match(activeInstruction.content, /entire visible response/i);

      const sendTool = payload.tools.find(
        (tool) => tool.function.name === "SendMessage",
      );
      const parameters = sendTool.function.parameters;
      assert.deepEqual(parameters.properties.type.enum, ["widget"]);
      assert.equal(parameters.properties.widget.properties.options.minItems, 3);
      assert.equal(parameters.properties.widget.properties.options.maxItems, 5);
      assert.deepEqual(
        parameters.properties.widget.properties.allowCustom.enum,
        [true],
      );
      assert.ok(parameters.properties.widget.required.includes("allowCustom"));
      assert.deepEqual(sendMessageParameters.properties.type.enum, [
        "text",
        "widget",
      ]);
      assert.equal(
        sendMessageParameters.properties.widget.properties.options.minItems,
        1,
      );

      assert.equal(
        events.filter((event) => event.type === "tool-call").length,
        1,
      );
      assert.equal(
        events.some((event) => event.type === "text-delta"),
        false,
      );
      assert.equal(response.messages[0].content.length, 1);
      assert.equal(response.messages[0].content[0].toolName, "SendMessage");

      const nextStepTools = bridge.convertToolsForStep(tools, [
        ...history,
        response.messages[0],
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "send-role-orientation",
              toolName: "SendMessage",
              result: { content: [{ type: "text", text: "Message sent" }] },
            },
          ],
        },
      ]);
      assert.equal(
        nextStepTools.some((tool) => tool.function.name === "SendMessage"),
        false,
      );
    } finally {
      connectionManager.getConnection = originalGetConnection;
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  "the exact live Computer actions payload is normalized before streamed validation",
  { concurrency: false },
  async () => {
    const originalGetConnection = connectionManager.getConnection;
    const originalFetch = globalThis.fetch;
    let requestPayload;
    connectionManager.getConnection = () => ({
      mode: "codex-oauth",
      route: "cliproxyapi-codex-oauth",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "local-test-key",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      fastMode: false,
    });
    globalThis.fetch = async (_url, options) => {
      requestPayload = JSON.parse(options.body);
      const body = [
        {
          id: "computer-compatibility-response",
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "computer-live-call",
                    function: {
                      name: "Computer",
                      arguments: '{"actions":[',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: '{"action":"screenshot"}]}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      return new Response(`${body}data: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const liveParameters = computerParameters();
    const tool = computerTool({
      parameters: aiSdkJsonSchema(liveParameters),
    });
    try {
      const session = bridge.createPromptSession({ agentId: "computer-bot" });
      const result = session
        .getExecutor([{ role: "user", content: "Take a screenshot." }])
        .stream({}, "computer-compatibility-invocation", [tool], {});
      const events = [];
      for await (const event of result.fullStream) events.push(event);
      const response = await result.response;

      const deltas = events.filter((event) => event.type === "tool-call-delta");
      assert.equal(deltas.length, 1);
      assert.deepEqual(JSON.parse(deltas[0].argsTextDelta), {
        action: "screenshot",
      });
      assert.doesNotMatch(deltas[0].argsTextDelta, /"actions"/);

      const completed = events.find((event) => event.type === "tool-call");
      assert.deepEqual(completed.args, { action: "screenshot" });
      assert.deepEqual(response.messages[0].content[0].args, {
        action: "screenshot",
      });

      const guidance = requestPayload.messages.find((message) =>
        String(message.content).includes("<computer_tool_argument_format>"),
      );
      assert.ok(guidance);
      assert.match(guidance.content, /exactly \{"action":"screenshot"\}/);
      assert.match(guidance.content, /CTRL\+L/);
      assert.match(guidance.content, /do not use META/i);
      const sentTool = requestPayload.tools.find(
        (candidate) => candidate.function.name === "Computer",
      );
      assert.match(sentTool.function.description, /Never send an "actions"/i);
      assert.deepEqual(sentTool.function.parameters, liveParameters);
      assert.equal(tool.description, "Control the box desktop.");
      assert.equal(
        Object.hasOwn(tool.parameters.jsonSchema.properties, "actions"),
        false,
      );
    } finally {
      connectionManager.getConnection = originalGetConnection;
      globalThis.fetch = originalFetch;
    }
  },
);

test("tool images are fenced as machine observations rather than user messages", () => {
  const converted = bridge.convertMessages([
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "computer-1",
          toolName: "Computer",
          result: {
            content: [
              {
                type: "image",
                image: Buffer.from("png"),
                mimeType: "image/png",
              },
            ],
          },
        },
      ],
    },
  ]);
  const visual = converted.find((message) => message.role === "user");

  assert.ok(visual);
  assert.equal(visual.content[0].text.startsWith("<tool_visual_result>"), true);
  assert.match(visual.content[0].text, /not a new user message/i);
  assert.match(visual.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.deepEqual(visual.content.at(-1), {
    type: "text",
    text: "</tool_visual_result>",
  });
});

test("the vendor patch preserves stock onboarding and acknowledgement safeguards", () => {
  const stockAckChain =
    "        const executor = host.isSubagentRunner || isSilenceAllowed ? diskPressureExecutor : applyStartOfTurnAckReminder(applySendMessageReminder(diskPressureExecutor));";
  const representativeHost = [
    "var SAND_ONBOARDING_KICKSTART_PROMPT = [",
    '  "[first run] This is your very first turn."',
    "];",
    stockAckChain,
  ].join("\n");

  assert.doesNotThrow(() =>
    patcher.verifyCoworkerHostBehaviorSource(representativeHost),
  );
  assert.throws(
    () =>
      patcher.verifyCoworkerHostBehaviorSource(
        representativeHost.replace(
          "applyStartOfTurnAckReminder",
          "removedAckReminder",
        ),
      ),
    /start-of-turn acknowledgement middleware chain/,
  );
  assert.throws(
    () =>
      patcher.verifyCoworkerHostBehaviorSource(
        representativeHost.replace(
          "SAND_ONBOARDING_KICKSTART_PROMPT",
          "REMOVED_ONBOARDING",
        ),
      ),
    /first-run coworker onboarding cue/,
  );

  const patchSource = fs.readFileSync(
    path.join(root, "scripts", "patch-app.cjs"),
    "utf8",
  );
  assert.doesNotMatch(patchSource, /coworker acknowledgement behavior/);
  assert.doesNotMatch(
    patchSource,
    /applySendMessageReminder\(diskPressureExecutor\);",\s*"coworker acknowledgement behavior/,
  );
});
