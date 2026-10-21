// docs/adr/0011: text and JSON Lines output of chat-log.
import { jsonBlock, type RenderOptions, renderBlock, truncate } from "./blocks.ts";
import type { Hit, Message, Session } from "./store.ts";

const short = (id: string | null): string => (id ?? "").slice(0, 8);
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");

export const sessionLine = (s: Session): string =>
  [s.last_at ?? "", s.provider, short(s.session_id), String(s.message_count), s.title ? flat(s.title) : "", s.cwd ?? ""].join("\t");

// docs/adr/0013: a hit only in thinking is marked so that the reader knows to look at the thinking.
export const hitLines = (h: Hit): string => {
  const mark = h.matched_in.length === 1 && h.matched_in[0] === "thinking" ? "[thinking] " : "";
  return `${h.timestamp ?? ""}\t${h.provider}\t${short(h.session_id)}#${h.index ?? "?"}\t${h.role ?? ""}\t${h.title ? flat(h.title) : ""}\n\t${mark}${flat(h.snippet)}`;
};

// A message as text, or null when nothing of it is shown (docs/adr/0013).
export const messageText = (m: Message, o: RenderOptions): string | null => {
  const body = m.blocks.map((b) => renderBlock(b, o)).filter((t): t is string => t !== null);
  return body.length === 0 ? null : [`## #${m.index} ${m.role ?? "?"} ${m.timestamp ?? ""}`, ...body].join("\n");
};

export type Page = { from: number; to: number; total: number; center: number | null; previous: boolean };

// Messages of a page; the center message (show --around) shows its thinking. Lines tell how to read
// the messages before and after the page.
export const messagesText = (messages: readonly Message[], o: RenderOptions, page: Page): string => {
  const shown = messages
    .map((m) => messageText(m, m.index === page.center ? { ...o, thinking: true } : o))
    .filter((t): t is string => t !== null);
  const before = page.previous && page.from > 1 ? [`（前：#1〜#${page.from - 1} は --offset 0 で出す）`] : [];
  const after = page.to < page.total ? [`（続き：#${page.to + 1} から。--offset ${page.to} で出す）`] : [];
  const parts = [...before, ...shown, ...after];
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
};

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
