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

// docs/adr/0020: a run of messages with nothing shown becomes one item, saying whether --thinking
// would show something.
export type PageItem = { kind: "message"; index: number; text: string } | { kind: "omitted"; from: number; to: number; reason: "thinking" | "empty" };

const hiddenThinking = (m: Message, o: RenderOptions): boolean => !o.thinking && m.blocks.some((b) => b.kind === "thinking" && b.text.trim() !== "");

export const pageItems = (messages: readonly Message[], o: RenderOptions): PageItem[] =>
  messages.reduce<PageItem[]>((acc, m) => {
    const text = messageText(m, o);
    if (text !== null) return [...acc, { kind: "message", index: m.index, text }];
    const reason = hiddenThinking(m, o) ? "thinking" : "empty";
    const last = acc[acc.length - 1];
    return last?.kind === "omitted" && last.to === m.index - 1
      ? [...acc.slice(0, -1), { ...last, to: m.index, reason: last.reason === "thinking" ? "thinking" : reason }]
      : [...acc, { kind: "omitted", from: m.index, to: m.index, reason }];
  }, []);

const REASONS = { thinking: "思考だけ。--thinking で出す", empty: "表示する本文が無い" } as const;

const itemText = (it: PageItem): string =>
  it.kind === "message" ? it.text : `（${it.from === it.to ? `#${it.from}` : `#${it.from}〜#${it.to}`} は省いた：${REASONS[it.reason]}）`;

// Messages of a page; with show --around every message of the page shows its thinking
// (docs/adr/0019). Lines tell how to read the messages before and after the page.
export const messagesText = (messages: readonly Message[], o: RenderOptions, page: Page): string => {
  const options = page.center !== null ? { ...o, thinking: true } : o;
  const shown = pageItems(messages, options).map(itemText);
  // docs/adr/0023: the previous line points to the page of the same size right before the range,
  // and a single message read with --around has no navigation lines.
  const size = page.to - page.from + 1;
  const single = page.center !== null && size === 1;
  const first = Math.max(1, page.from - size);
  const before = page.previous && page.from > 1 && !single ? [`（前：#${first}〜#${page.from - 1} は --offset ${first - 1} で出す）`] : [];
  const after = page.to < page.total && !single ? [`（続き：#${page.to + 1} から。--offset ${page.to} で出す）`] : [];
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
