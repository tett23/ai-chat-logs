// docs/adr/0011: text and JSON Lines output of chat-log.
import { jsonBlock, type RenderOptions, renderBlock, truncate } from "./blocks.ts";
import type { Hit, Message, Session } from "./store.ts";

const short = (id: string | null): string => (id ?? "").slice(0, 8);
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");

export const sessionLine = (s: Session): string =>
  [s.last_at ?? "", s.provider, short(s.session_id), String(s.message_count), s.title ? flat(s.title) : "", s.cwd ?? ""].join("\t");

export const hitLines = (h: Hit): string =>
  `${h.timestamp ?? ""}\t${h.provider}\t${short(h.session_id)}#${h.index ?? "?"}\t${h.role ?? ""}\t${h.title ? flat(h.title) : ""}\n\t${flat(h.snippet)}`;

export const messageText = (m: Message, o: RenderOptions): string => {
  const body = m.blocks.map((b) => renderBlock(b, o)).filter((t): t is string => t !== null);
  return [`## #${m.index} ${m.role ?? "?"} ${m.timestamp ?? ""}`, ...body].join("\n");
};

export const messagesText = (messages: readonly Message[], o: RenderOptions, next: number | null): string =>
  messages.length === 0
    ? ""
    : `${messages.map((m) => messageText(m, o)).join("\n\n")}\n${next !== null ? `\n（続き：--offset ${next}）\n` : ""}`;

export const messageJson = (m: Message, maxChars: number): Record<string, unknown> => ({
  index: m.index,
  uuid: m.uuid,
  timestamp: m.timestamp,
  role: m.role,
  model: m.model,
  is_sidechain: m.is_sidechain,
  blocks: m.blocks.map((b) => jsonBlock(b, maxChars)),
});

// The text of a message for context: only text blocks, on one paragraph.
export const plainText = (m: Message): string =>
  m.blocks
    .flatMap((b) => (b.kind === "text" ? [b.text] : []))
    .join("\n")
    .trim();

export type ContextEntry = { session: Session; last: Message[] };

export const contextText = (label: string, entries: readonly ContextEntry[], maxChars: number): string => {
  const head = `# ${label} の最近のセッション（${entries.length}）`;
  if (entries.length === 0) return `${head}\n該当するセッションがありません。--all ですべてのセッションを出せます。\n`;
  const sections = entries.map(({ session: s, last }) =>
    [
      `## ${s.title ? flat(s.title) : s.session_id}（${s.provider}、${short(s.session_id)}、${s.first_at ?? ""}〜${s.last_at ?? ""}、${s.message_count} 件）`,
      ...last.map((m) => `#${m.index} ${m.role ?? "?"}: ${truncate(plainText(m), maxChars)}`),
    ].join("\n"),
  );
  return `${head}\n\n${sections.join("\n\n")}\n`;
};

export const jsonLines = (values: readonly unknown[]): string => values.map((v) => `${JSON.stringify(v)}\n`).join("");
