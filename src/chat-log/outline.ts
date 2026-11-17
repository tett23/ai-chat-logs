// docs/adr/0043: the prompts of a session and the last reply of each turn, one line each.
import { truncate } from "./blocks.ts";
import { flat } from "./format.ts";
import type { Message } from "./store.ts";

export type Turn = { prompt: Message | null; reply: Message | null };

const hasText = (m: Message): boolean => m.blocks.some((b) => b.kind === "text");
const isPrompt = (m: Message): boolean => m.role === "user" && !m.is_sidechain && hasText(m);
const isReply = (m: Message): boolean => m.role === "assistant" && !m.is_sidechain && hasText(m);

// The text blocks joined by newlines, on one line and trimmed.
export const outlineText = (m: Message): string =>
  flat(m.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])).join("\n")).trim();

// Turns in order: a prompt opens one; messages before the first prompt form a turn without one.
export const turns = (messages: Message[]): Turn[] =>
  messages.reduce<Turn[]>((acc, m) => {
    if (isPrompt(m)) return [...acc, { prompt: m, reply: null }];
    if (!isReply(m)) return acc.length === 0 ? [{ prompt: null, reply: null }] : acc;
    const last = acc.at(-1) ?? { prompt: null, reply: null };
    return [...acc.slice(0, -1), { ...last, reply: m }];
  }, []);

const entries = (t: Turn): { message: Message; indent: string }[] => [
  ...(t.prompt === null ? [] : [{ message: t.prompt, indent: "" }]),
  ...(t.reply === null ? [] : [{ message: t.reply, indent: "  " }]),
];

export type OutlinePage = { offset: number; limit: number; maxChars: number };

const turnLines = (t: Turn, maxChars: number): string[] =>
  entries(t).map(({ message: m, indent }) => `${indent}#${m.index} ${m.role} ${m.timestamp ?? ""} ${truncate(outlineText(m), maxChars)}`);

// docs/adr/0044: the text outline. It takes the most turns from the offset, up to the limit, whose output
// (heading, turn lines, and the continuation line when turns remain) fits in maxBytes; it always takes the
// turn at the offset. maxBytes 0 means no byte limit.
export const outlineTextPage = (all: Turn[], p: OutlinePage & { maxBytes: number }, head: string, more: (next: number) => string): string => {
  const render = (k: number): string => {
    const next = p.offset + k;
    const body = all.slice(p.offset, next).flatMap((t) => turnLines(t, p.maxChars));
    return `${[head, ...body, ...(next < all.length ? [more(next)] : [])].join("\n")}\n`;
  };
  if (p.offset >= all.length) return render(0);
  const most = Math.min(p.limit, all.length - p.offset);
  if (p.maxBytes === 0) return render(most);
  const fits = (k: number) => Buffer.byteLength(render(k), "utf8") <= p.maxBytes;
  const k = Array.from({ length: most }, (_, i) => most - i).find(fits) ?? 1;
  return render(k);
};

export const outlineJson = (all: Turn[], p: OutlinePage): Record<string, unknown>[] =>
  all.slice(p.offset, p.offset + p.limit).flatMap(entries).map(({ message: m }) => {
    const chars = [...outlineText(m)];
    const cut = p.maxChars !== 0 && chars.length > p.maxChars;
    return {
      index: m.index,
      uuid: m.uuid,
      timestamp: m.timestamp,
      role: m.role,
      text: cut ? chars.slice(0, p.maxChars).join("") : chars.join(""),
      truncated_from: cut ? chars.length : null,
    };
  });

export const promptCount = (all: Turn[]): number => all.filter((t) => t.prompt !== null).length;
