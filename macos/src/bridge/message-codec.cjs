"use strict";

const MAX_REQUEST_BYTES = 1_000_000;
const MAX_MESSAGES = 512;
const MAX_TOOLS = 256;
const MAX_DEPTH = 12;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

class BridgePayloadError extends Error {
  constructor() {
    super("Codex bridge payload is invalid.");
    this.name = "BridgePayloadError";
    this.code = "CODEX_BRIDGE_PAYLOAD_INVALID";
  }
}

function fail() {
  throw new BridgePayloadError();
}

function dataObject(value, allowed, required = []) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (allowed instanceof Set && !allowed.has(key)),
    )
  ) {
    fail();
  }
  if (required.some((key) => !Object.hasOwn(descriptors, key))) fail();
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || descriptor.get || descriptor.set) fail();
  }
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function arrayValues(value, maximum) {
  if (!Array.isArray(value)) fail();
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail();
  }
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail();
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9]\d*)$/.test(key)),
    )
  ) {
    fail();
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) {
      fail();
    }
    output.push(descriptor.value);
  }
  return output;
}

function cloneJson(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_DEPTH) fail();
  if (
    value == null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) fail();
  seen.add(value);
  if (Array.isArray(value)) {
    const output = arrayValues(value, 10_000).map((item) =>
      cloneJson(item, seen, depth + 1),
    );
    seen.delete(value);
    return Object.freeze(output);
  }
  const source = dataObject(value, null);
  const output = {};
  for (const [key, item] of Object.entries(source)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) fail();
    output[key] = cloneJson(item, seen, depth + 1);
  }
  seen.delete(value);
  return Object.freeze(output);
}

function imageUrl(part) {
  const sourceCount = [part.image, part.data, part.url].filter(
    (value) => value !== undefined,
  ).length;
  if (sourceCount !== 1) fail();
  const source = part.image ?? part.data ?? part.url;
  if (typeof source !== "string" || source.length === 0) fail();
  const mimeType = part.mimeType ?? "image/png";
  if (
    typeof mimeType !== "string" ||
    !/^image\/[A-Za-z0-9.+-]{1,64}$/.test(mimeType)
  ) {
    fail();
  }
  let url;
  if (/^(?:data:image\/|https:\/\/)/.test(source)) url = source;
  else if (/^[A-Za-z0-9+/]+={0,2}$/.test(source)) {
    url = `data:${mimeType};base64,${source}`;
  } else fail();
  return Object.freeze({
    type: "image_url",
    image_url: Object.freeze({ url }),
  });
}

function userPart(value) {
  const part = dataObject(
    value,
    new Set(["type", "text", "image", "data", "url", "mimeType", "filename", "name"]),
    ["type"],
  );
  if (part.type === "text") {
    if (typeof part.text !== "string") fail();
    return Object.freeze({ type: "text", text: part.text });
  }
  if (part.type === "image") return imageUrl(part);
  if (part.type === "file") {
    const name = part.filename ?? part.name ?? part.mimeType ?? "file";
    if (typeof name !== "string" || name.length < 1 || name.length > 512) fail();
    return Object.freeze({ type: "text", text: `[Attached file: ${name}]` });
  }
  fail();
}

function toolResultContent(result) {
  const source = dataObject(result, new Set(["content"]), ["content"]);
  const parts = arrayValues(source.content, 1_000);
  const text = [];
  const images = [];
  for (const value of parts) {
    const item = dataObject(
      value,
      new Set(["type", "text", "image", "data", "url", "mimeType"]),
      ["type"],
    );
    if (item.type === "text") {
      if (typeof item.text !== "string") fail();
      text.push(item.text);
    } else if (item.type === "image") images.push(imageUrl(item));
    else fail();
  }
  return { text: text.join("\n"), images };
}

function encodeMessages(messages) {
  const history = arrayValues(messages, MAX_MESSAGES);
  const output = [];
  const calls = new Set();
  const results = new Set();
  for (const value of history) {
    const message = dataObject(
      value,
      new Set(["id", "role", "content", "providerOptions"]),
      ["role", "content"],
    );
    if (message.role === "system" || message.role === "developer") {
      if (typeof message.content !== "string") fail();
      output.push(Object.freeze({ role: message.role, content: message.content }));
      continue;
    }
    if (message.role === "user") {
      if (typeof message.content === "string") {
        output.push(Object.freeze({ role: "user", content: message.content }));
      } else {
        const content = Object.freeze(
          arrayValues(message.content, 1_000).map(userPart),
        );
        output.push(Object.freeze({ role: "user", content }));
      }
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        output.push(Object.freeze({ role: "assistant", content: message.content }));
        continue;
      }
      let text = "";
      const toolCalls = [];
      for (const item of arrayValues(message.content, 1_000)) {
        const part = dataObject(
          item,
          new Set(["type", "text", "toolCallId", "toolName", "args"]),
          ["type"],
        );
        if (part.type === "text") {
          if (typeof part.text !== "string") fail();
          text += part.text;
          continue;
        }
        if (
          part.type !== "tool-call" ||
          typeof part.toolCallId !== "string" ||
          part.toolCallId.length < 1 ||
          part.toolCallId.length > 256 ||
          calls.has(part.toolCallId) ||
          typeof part.toolName !== "string" ||
          !TOOL_NAME.test(part.toolName)
        ) {
          fail();
        }
        calls.add(part.toolCallId);
        const args = cloneJson(part.args);
        toolCalls.push(
          Object.freeze({
            id: part.toolCallId,
            type: "function",
            function: Object.freeze({
              name: part.toolName,
              arguments: JSON.stringify(args),
            }),
          }),
        );
      }
      const converted = { role: "assistant", content: text || null };
      if (toolCalls.length > 0) converted.tool_calls = Object.freeze(toolCalls);
      output.push(Object.freeze(converted));
      continue;
    }
    if (message.role === "tool") {
      for (const item of arrayValues(message.content, 1_000)) {
        const part = dataObject(
          item,
          new Set(["type", "toolCallId", "toolName", "result", "isError"]),
          ["type", "toolCallId", "result"],
        );
        if (
          part.type !== "tool-result" ||
          typeof part.toolCallId !== "string" ||
          !calls.has(part.toolCallId) ||
          results.has(part.toolCallId)
        ) {
          fail();
        }
        results.add(part.toolCallId);
        const converted = toolResultContent(part.result);
        output.push(
          Object.freeze({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: converted.text,
          }),
        );
        if (converted.images.length > 0) {
          output.push(
            Object.freeze({
              role: "user",
              content: Object.freeze([
                Object.freeze({
                  type: "text",
                  text: "<tool_visual_result>Machine-observed tool output.</tool_visual_result>",
                }),
                ...converted.images,
              ]),
            }),
          );
        }
      }
      continue;
    }
    fail();
  }
  const frozen = Object.freeze(output);
  let serialized;
  try {
    serialized = JSON.stringify(frozen);
  } catch {
    fail();
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) fail();
  return frozen;
}

function encodeTools(tools) {
  const source = arrayValues(tools ?? [], MAX_TOOLS);
  const names = new Set();
  const output = source.map((value) => {
    const tool = dataObject(
      value,
      new Set(["type", "name", "description", "parameters"]),
      ["name", "parameters"],
    );
    if (
      (tool.type != null && tool.type !== "function") ||
      typeof tool.name !== "string" ||
      !TOOL_NAME.test(tool.name) ||
      names.has(tool.name) ||
      (tool.description != null && typeof tool.description !== "string")
    ) {
      fail();
    }
    names.add(tool.name);
    const parameters = cloneJson(tool.parameters);
    if (parameters == null || Array.isArray(parameters) || typeof parameters !== "object") {
      fail();
    }
    return Object.freeze({
      type: "function",
      function: Object.freeze({
        name: tool.name,
        description: tool.description ?? "",
        parameters,
      }),
    });
  });
  const frozen = Object.freeze(output);
  if (Buffer.byteLength(JSON.stringify(frozen), "utf8") > MAX_REQUEST_BYTES) fail();
  return frozen;
}

function encodeToolChoice(toolChoice, toolNames) {
  if (toolChoice == null || toolChoice === "auto") return "auto";
  if (toolChoice === "none") return "none";
  const choice = dataObject(
    toolChoice,
    new Set(["toolName", "name"]),
  );
  const keys = Object.keys(choice);
  if (keys.length !== 1) fail();
  const name = choice.toolName ?? choice.name;
  if (
    typeof name !== "string" ||
    !(toolNames instanceof Set) ||
    !toolNames.has(name)
  ) {
    fail();
  }
  return Object.freeze({
    type: "function",
    function: Object.freeze({ name }),
  });
}

module.exports = {
  BridgePayloadError,
  MAX_REQUEST_BYTES,
  cloneJsonValue: cloneJson,
  encodeMessages,
  encodeToolChoice,
  encodeTools,
};
