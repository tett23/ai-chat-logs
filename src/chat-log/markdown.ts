// docs/adr/0026: a whole session as Markdown, for chat-log export and the GUI's 書き出す button.
import type { Block } from "./blocks.ts";
import type { Message, Session } from "./store.ts";

// Three backticks, or one more than the longest run of backticks in the text.
export const fence = (text: string): string => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

const codeBlock = (text: string, lang = ""): string => {
  const f = fence(text);
  return `${f}${lang}\n${text}\n${f}`;
};

const folded = (summary: string, body: string): string => `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;

const quoted = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

const prettyJson = (input: string): string => {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
};

// A block as Markdown; null for thinking with an empty body (docs/adr/0019).
const blockMarkdown = (b: Block): string | null => {
  switch (b.kind) {
    case "text":
      return b.text.trimEnd();
    case "thinking":
      return b.text.trim() === "" ? null : folded("thinking", quoted(b.text));
    case "tool_use":
      return folded(`tool_use: ${b.name}`, codeBlock(prettyJson(b.input), "json"));
    case "tool_result":
      return folded(b.error ? "tool_result（エラー）" : "tool_result", codeBlock(b.text.trimEnd()));
    case "other":
      return `[${b.type}]`;
  }
};

const messageMarkdown = (m: Message): string | null => {
  const body = m.blocks.map(blockMarkdown).filter((t): t is string => t !== null);
  if (body.length === 0) return null;
  const head = [`## #${m.index}`, m.role ?? "?", m.timestamp ?? "", ...(m.model ? [m.model] : []), ...(m.is_sidechain ? ["(サブエージェント)"] : [])].join(" ");
  return [head, ...body].join("\n\n");
};

export const sessionMarkdown = (s: Session, messages: readonly Message[]): string => {
  const header = [
    `# ${s.title ?? s.session_id}`,
    "",
    `- セッション: ${s.session_id}`,
    `- 提供元: ${s.provider}`,
    ...(s.cwd ? [`- cwd: ${s.cwd}`] : []),
    `- 期間: ${s.first_at ?? ""} 〜 ${s.last_at ?? ""}`,
    `- メッセージ: ${s.message_count} 件`,
  ].join("\n");
  return `${[header, ...messages.map(messageMarkdown).filter((t): t is string => t !== null)].join("\n\n")}\n`;
};
