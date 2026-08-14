const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REPLACEMENT_RANGE_UNIT,
  applyReplacementRange,
  visibleText,
} = require("../src/renderer/chat-content.js");

test("one Chat adapter preserves every sanitized content block without private metadata", () => {
  const content = [
    { type: "text", text: "Plain" },
    { type: "markdown", text: "**Markdown**" },
    { type: "link", label: "OpenAI", url: "https://openai.com/" },
    { type: "image", image: { imageID: "private-image-id", mimeType: "image/png", byteCount: 42, width: 4, height: 5, altText: "A chart" } },
    { type: "file", file: { attachmentID: "private-file-id", fileName: "report.pdf", mimeType: "application/pdf", byteCount: 99 } },
    { type: "toolActivity", toolActivity: { name: "Search", summary: "Found two sources", metadata: { secret: "must-not-render" } } },
  ];

  const rendered = visibleText(content);
  assert.equal(rendered, "Plain\n\n**Markdown**\n\n[OpenAI](https://openai.com/)\n\n[Image: A chart]\n\n[File: report.pdf]\n\nSearch: Found two sources");
  for (const privateValue of ["private-image-id", "private-file-id", "must-not-render", "application/pdf", "image/png"]) {
    assert.doesNotMatch(rendered, new RegExp(privateValue));
  }
});

test("v1 visible projection matches Swift for every valid empty sanitized value", () => {
  const swiftGolden = [
    { content: [{ type: "text", text: "A" }, { type: "text", text: "" }, { type: "text", text: "B" }], projection: "A\n\n\n\nB", utf16Length: 6 },
    { content: [{ type: "markdown", text: "" }], projection: "", utf16Length: 0 },
    { content: [{ type: "link", label: "", url: "https://openai.com/" }], projection: "[](https://openai.com/)", utf16Length: 23 },
    { content: [{ type: "image", image: { imageID: "image-1", mimeType: "image/png", byteCount: 0, width: 1, height: 1, altText: "" } }], projection: "[Image: ]", utf16Length: 9 },
    { content: [{ type: "toolActivity", toolActivity: { name: "Search", summary: "", metadata: {} } }], projection: "Search: ", utf16Length: 8 },
    { content: [{ type: "toolActivity", toolActivity: { name: "", summary: "Found", metadata: {} } }], projection: ": Found", utf16Length: 7 },
    { content: [{ type: "toolActivity", toolActivity: { name: "", summary: "", metadata: {} } }], projection: ": ", utf16Length: 2 },
  ];

  for (const golden of swiftGolden) {
    const projection = visibleText(golden.content);
    assert.equal(projection, golden.projection);
    assert.equal(projection.length, golden.utf16Length);
  }
});

test("replacement ranges are v1 UTF-16 code-unit offsets", () => {
  assert.equal(REPLACEMENT_RANGE_UNIT, "utf16-code-units");
  assert.equal(applyReplacementRange("A🐈e\u0301Z", "ok", { start: 1, length: 4 }), "AokZ");
  assert.equal(applyReplacementRange("A🐈B", "x", { start: 2, length: 1 }), null);
});
