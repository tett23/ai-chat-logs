// docs/adr/0011: message content as compact text for AI agents.

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; input: string }
  | { kind: "tool_result"; text: string }
  | { kind: "other"; type: string };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// docs/adr/0013: runs of 200 or more base64 characters (with a data: URL prefix) are not worth reading as text.
const BASE64_RUN = /(?:data:[\w.+-]+\/[\w.+-]+;base64,)?[A-Za-z0-9+/=]{200,}/g;
export const replaceBase64 = (text: string): string => text.replace(BASE64_RUN, (m) => `[base64 ${m.length} 文字]`);

// Text of a tool result; blocks other than text (images and so on) become their type.
const toolResultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (isObject(c) && c.type === "text" ? str(c.text) : `[${isObject(c) && typeof c.type === "string" ? c.type : "unknown"}]`)).join("\n")
      : content === undefined || content === null
        ? ""
        : JSON.stringify(content);

const toBlock = (item: unknown): Block => {
  if (!isObject(item)) return { kind: "other", type: typeof item };
  switch (item.type) {
    case "text":
      return { kind: "text", text: str(item.text) };
    case "thinking":
      return { kind: "thinking", text: str(item.thinking) };
    case "tool_use":
      return { kind: "tool_use", name: str(item.name), input: JSON.stringify(item.input ?? {}) };
    case "tool_result":
      return { kind: "tool_result", text: toolResultText(item.content) };
    default:
      return { kind: "other", type: typeof item.type === "string" ? item.type : "unknown" };
  }
};

const withoutBase64 = (b: Block): Block =>
  b.kind === "tool_use" ? { ...b, input: replaceBase64(b.input) } : b.kind === "other" ? b : { ...b, text: replaceBase64(b.text) };

export const toBlocks = (content: unknown): Block[] =>
  (typeof content === "string" ? [{ kind: "text", text: content } as Block] : Array.isArray(content) ? content.map(toBlock) : []).map(
    withoutBase64,
  );

// The first `max` characters with a note of the original length; 0 keeps the whole text.
export const truncate = (text: string, max: number): string => {
  const chars = [...text];
  return max === 0 || chars.length <= max ? text : `${chars.slice(0, max).join("")}…（${chars.length} 文字のうち ${max} 文字）`;
};

const SUMMARY_CHARS = 200;
const oneLine = (text: string): string => [...text.replace(/\s+/g, " ").trim()].slice(0, SUMMARY_CHARS).join("");

export type RenderOptions = { thinking: boolean; tools: boolean; maxChars: number };

// One block as text; null when it is hidden.
export const renderBlock = (block: Block, o: RenderOptions): string | null => {
  switch (block.kind) {
    case "text":
      return truncate(block.text.trimEnd(), o.maxChars);
    case "thinking":
      return o.thinking ? `[thinking] ${truncate(block.text.trimEnd(), o.maxChars)}` : null;
    case "tool_use":
      return o.tools ? `[tool_use ${block.name}]\n${truncate(block.input, o.maxChars)}` : `[tool_use ${block.name}] ${oneLine(block.input)}`;
    case "tool_result":
      return o.tools ? `[tool_result]\n${truncate(block.text, o.maxChars)}` : `[tool_result] ${oneLine(block.text)}`;
    case "other":
      return `[${block.type}]`;
  }
};

// A block for --json, with long bodies cut and their original length in truncated_from.
export const jsonBlock = (block: Block, maxChars: number): Record<string, unknown> => {
  const cut = (text: string) => {
    const chars = [...text];
    return maxChars === 0 || chars.length <= maxChars ? { text } : { text: chars.slice(0, maxChars).join(""), truncated_from: chars.length };
  };
  switch (block.kind) {
    case "text":
    case "thinking":
    case "tool_result":
      return { kind: block.kind, ...cut(block.text) };
    case "tool_use": {
      const { text, ...rest } = cut(block.input);
      return { kind: block.kind, name: block.name, input: text, ...rest };
    }
    case "other":
      return { kind: block.kind, type: block.type };
  }
};
