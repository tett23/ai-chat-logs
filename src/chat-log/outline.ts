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

export const outlineLines = (all: Turn[], p: OutlinePage): string[] =>
  all.slice(p.offset, p.offset + p.limit).flatMap(entries).map(({ message: m, indent }) =>
    `${indent}#${m.index} ${m.role} ${m.timestamp ?? ""} ${truncate(outlineText(m), p.maxChars)}`);

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
