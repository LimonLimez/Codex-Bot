(function exposeChatContent(root, factory) {
  const adapter = factory();
  if (typeof module === "object" && module.exports) module.exports = adapter;
  if (root) root.CodexChatContent = adapter;
})(typeof window === "object" ? window : null, function createChatContent() {
  "use strict";

  const REPLACEMENT_RANGE_UNIT = "utf16-code-units";

  function string(value) {
    return typeof value === "string" ? value : "";
  }

  function safeWebURL(value) {
    const original = string(value);
    try {
      const parsed = new URL(original);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? original : "";
    } catch {
      return "";
    }
  }

  function fileName(value) {
    return string(value).split(/[\\/]/).filter(Boolean).at(-1) || "file";
  }

  function visibleBlock(block) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return "";
    if (block.type === "text" || block.type === "markdown") return string(block.text);
    if (block.type === "link") {
      const label = string(block.label);
      const url = safeWebURL(block.url);
      return url ? `[${label}](${url})` : "";
    }
    if (block.type === "image" && block.image) return `[Image: ${string(block.image.altText)}]`;
    if (block.type === "file" && block.file) return `[File: ${string(block.file.fileName)}]`;
    if (block.type === "toolActivity" && block.toolActivity) {
      const name = string(block.toolActivity.name);
      const summary = string(block.toolActivity.summary);
      return `${name}: ${summary}`;
    }
    if (block.type === "localImage" || block.type === "image") return `[Image: ${fileName(block.path || block.url)}]`;
    if (block.type === "localAudio" || block.type === "audio") return `[Audio: ${fileName(block.path || block.url)}]`;
    return "";
  }

  function visibleText(content) {
    if (!Array.isArray(content)) return "";
    return content.map(visibleBlock).join("\n\n");
  }

  function isScalarBoundary(text, offset) {
    if (offset <= 0 || offset >= text.length) return true;
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF);
  }

  function applyReplacementRange(previous, inserted, range) {
    const text = string(previous);
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length)
      || range.start < 0 || range.length < 0) return null;
    const end = range.start + range.length;
    if (!Number.isSafeInteger(end) || end > text.length
      || !isScalarBoundary(text, range.start) || !isScalarBoundary(text, end)) return null;
    return `${text.slice(0, range.start)}${string(inserted)}${text.slice(end)}`;
  }

  return Object.freeze({ REPLACEMENT_RANGE_UNIT, applyReplacementRange, safeWebURL, visibleBlock, visibleText });
});
