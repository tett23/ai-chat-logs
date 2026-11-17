#!/usr/bin/env -S bun --no-env-file
// docs/adr/0011: a read-only CLI for AI agents to look up the chat logs.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { contextText, flat, hitLines, jsonLines, messageJson, messagesText, plainText, sessionLine } from "../chat-log/format.ts";
import { HELP, MAIN_HELP, subcommandHelp } from "../chat-log/help.ts";
import { messageSectionMarkdown, sessionMarkdown } from "../chat-log/markdown.ts";
import { outlineJson, outlineTextPage, promptCount, turns } from "../chat-log/outline.ts";
import { planSearch } from "../chat-log/search.ts";
import {
  exitError,
  type Filter,
  isExitError,
  listSessions,
  messageCount,
  messageIds,
  messageIndex,
  type MessageKey,
  openReadOnly,
  search,
  sessionIds,
  sessionMessages,
  sessionSummary,
  type SessionKey,
} from "../chat-log/store.ts";
import { MIN_PREFIX, parseTime } from "../chat-log/values.ts";
import { loadEnvFile } from "../env.ts";
import { defaultDatabasePath } from "../paths.ts";

// docs/adr/0042: a usage error ends with the line naming the help to read; see helpHint.
const usage = (message: string): never => {
  throw Object.assign(exitError(2, message), { usage: true });
};
const isUsage = (e: unknown): boolean => (e as { usage?: unknown } | null)?.usage === true;
const helpHint = (argv: string[]): string =>
  argv[0] !== undefined && Object.hasOwn(HELP, argv[0]) ? `chat-log ${argv[0]} --help で使い方を出す。` : "chat-log --help で使い方を出す。";

const parse = (argv: string[]) => {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: "string" },
        cwd: { type: "string" },
        all: { type: "boolean", default: false },
        since: { type: "string" },
        until: { type: "string" },
        exclude: { type: "string", multiple: true },
        limit: { type: "string" },
        offset: { type: "string" },
        "max-chars": { type: "string" },
        "max-bytes": { type: "string" },
        json: { type: "boolean", default: false },
        around: { type: "string" },
        thinking: { type: "boolean", default: false },
        tools: { type: "boolean", default: false },
        messages: { type: "string" },
        session: { type: "string" },
        message: { type: "string" },
        range: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    return usage(e instanceof Error ? e.message : String(e));
  }
};

const count = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) usage(`--${name} には0以上の整数を指定する: ${value}`);
  return Number(value);
};

const EXPORT_REJECTS = ["cwd", "since", "until", "limit", "offset", "max-chars", "json"] as const;
// docs/adr/0040
// docs/adr/0043
const OUTLINE_REJECTS = ["around", "message", "range", "thinking", "tools", "cwd", "since", "until", "all", "messages", "session", "exclude"] as const;
const EXPORT_MESSAGE_REJECTS = [...EXPORT_REJECTS, "range", "around", "thinking", "tools"] as const;
const SHOW_MESSAGE_REJECTS = ["around", "limit", "offset", "since", "until", "cwd"] as const;
const SEARCH_SESSION_REJECTS = ["cwd", "since", "until"] as const;

type Values = ReturnType<typeof parse>["values"];
const rejectWith = (v: Values, names: readonly (keyof Values)[], what: string): void => {
  const rejected = names.filter((name) => v[name] !== undefined && v[name] !== false);
  if (rejected.length > 0) usage(`${what} には ${rejected.map((n) => `--${String(n)}`).join("、")} を付けられない`);
};

// docs/adr/0040: --range <before>[:<after>].
export const parseRange = (value: string | undefined): [number, number] => {
  if (value === undefined) return [5, 5];
  const m = /^(\d+)(?::(\d+))?$/.exec(value);
  if (m === null) return usage(`--range には <前> か <前>:<後>（0以上の整数）を指定する: ${value}`);
  return [Number(m[1]), Number(m[2] ?? m[1])];
};

const main = (argv: string[]): string => {
  const { values: v, positionals } = parse(argv);
  const [command, ...rest] = positionals;
  if (command === undefined) return MAIN_HELP;
  if (!Object.hasOwn(HELP, command)) usage(`知らないサブコマンドです: ${command}`);
  // docs/adr/0044: only the text outline takes a byte limit.
  if (v["max-bytes"] !== undefined && command !== "outline") usage(`${command} には --max-bytes を付けられない`);
  if (v.help) return subcommandHelp(command);

  loadEnvFile();
  const time = (value: string | undefined): string | undefined => {
    try {
      return value === undefined ? undefined : parseTime(value);
    } catch (e) {
      return usage(e instanceof Error ? e.message : String(e));
    }
  };
  const since = time(v.since);
  const until = time(v.until);
  const filter = (cwd: string | undefined): Filter => ({ provider: v.provider, cwd: cwd === undefined ? undefined : resolve(cwd), since, until });
  const db = openReadOnly(defaultDatabasePath(process.env));
  const offset = count(v.offset, "offset", 0);
  // A session ID or a unique prefix of it.
  const sessionOf = (prefix: string): SessionKey => {
    if (prefix.length < MIN_PREFIX) usage("セッションIDは先頭8文字以上で指定する");
    const candidates = sessionIds(db, prefix, v.provider);
    const exact = candidates.filter((c) => c.session_id === prefix);
    const matches = exact.length > 0 ? exact : candidates;
    if (matches.length === 0) throw exitError(1, `セッションが見つかりません: ${prefix}`);
    if (matches.length > 1) throw exitError(2, `セッションIDが区別できません: ${prefix}\n候補:\n${matches.map((c) => `${c.provider}\t${c.session_id}`).join("\n")}\n--provider <提供元> で絞ってください。`);
    return matches[0] as SessionKey;
  };
  // docs/adr/0040: a message ID or a unique prefix of it, within a session when one is given.
  const messageOf = (prefix: string, session?: SessionKey): MessageKey & { index: number } => {
    if (prefix.length < MIN_PREFIX) usage("メッセージIDは先頭8文字以上で指定する");
    const candidates = messageIds(db, prefix, session?.provider ?? v.provider, session?.session_id);
    const exact = candidates.filter((c) => c.uuid === prefix);
    const matches = exact.length > 0 ? exact : candidates;
    if (matches.length === 0) throw exitError(1, `メッセージが見つかりません: ${prefix}`);
    if (matches.length > 1)
      throw exitError(2, `メッセージIDが区別できません: ${prefix}\n候補:\n${matches.map((c) => `${c.provider}\t${c.session_id}\t${c.uuid}`).join("\n")}\nchat-log show <セッションID> --message <メッセージID> のようにセッションIDを添えてください。`);
    const found = matches[0] as MessageKey;
    const index = messageIndex(db, found.provider, found.session_id, found.uuid);
    if (index === null) throw exitError(1, `メッセージが見つかりません: ${prefix}`);
    return { ...found, index };
  };

  // docs/adr/0040: show --message <ID> [--range <before>[:<after>]]
  const showMessage = (id: string, sessionArg: string | undefined): string => {
    rejectWith(v, SHOW_MESSAGE_REJECTS, "--message");
    const [before, after] = parseRange(v.range);
    const m = messageOf(id, sessionArg === undefined ? undefined : sessionOf(sessionArg));
    const total = messageCount(db, m.provider, m.session_id);
    const from = Math.max(1, m.index - before);
    const to = Math.min(total, m.index + after);
    const messages = sessionMessages(db, m.provider, m.session_id, from, to);
    const maxChars = count(v["max-chars"], "max-chars", 2000);
    if (v.json) return jsonLines(messages.map((x) => ({ ...messageJson(x, maxChars), provider: m.provider, session_id: m.session_id })));
    const title = sessionSummary(db, m.provider, m.session_id)?.title;
    const head = `# ${m.provider} ${m.session_id} ${title ? flat(title) : ""}（メッセージ #${m.index}）`;
    const body = messagesText(messages, { thinking: v.thinking, tools: v.tools, maxChars }, {
      from, to, total, center: m.index, previous: true, command: `chat-log show ${m.session_id}${v.provider !== undefined ? ` --provider ${m.provider}` : ""}`,
    });
    return `${head}\n\n${body}`;
  };

  switch (command) {
    case "sessions": {
      const sessions = listSessions(db, filter(v.cwd), count(v.limit, "limit", 50), offset);
      return v.json ? jsonLines(sessions) : sessions.map((s) => `${sessionLine(s)}\n`).join("");
    }
    case "search": {
      if (rest.length === 0) usage("search には語を指定する");
      if (v.session !== undefined) rejectWith(v, SEARCH_SESSION_REJECTS, "--session");
      const session = v.session !== undefined ? sessionOf(v.session) : undefined;
      const f = session !== undefined ? { provider: session.provider, session: session.session_id } : filter(v.cwd);
      const hits = search(db, planSearch(rest.join(" "), v.exclude ?? []), f, count(v.limit, "limit", 20), offset, v.tools === true);
      return v.json ? jsonLines(hits) : hits.map((h) => `${hitLines(h)}\n`).join("");
    }
    case "show": {
      if (v.message === undefined && v.range !== undefined) usage("--range は --message と合わせて付ける");
      if (v.message !== undefined) return showMessage(v.message, rest[0]);
      const id = sessionOf(rest[0] ?? usage("show にはセッションIDを指定する"));
      // docs/adr/0018: --around reads a few messages around a hit unless --limit says otherwise.
      const limit = count(v.limit, "limit", v.around !== undefined ? 10 : 50);
      const maxChars = count(v["max-chars"], "max-chars", 2000);
      const total = messageCount(db, id.provider, id.session_id);
      const from = v.around !== undefined ? Math.max(1, count(v.around, "around", 1) - Math.floor(limit / 2)) : offset + 1;
      const to = from + limit - 1;
      const messages = sessionMessages(db, id.provider, id.session_id, from, to);
      if (v.json) return jsonLines(messages.map((m) => messageJson(m, maxChars)));
      const center = v.around !== undefined ? count(v.around, "around", 1) : null;
      return messagesText(messages, { thinking: v.thinking, tools: v.tools, maxChars }, { from, to, total, center, previous: center !== null });
    }
    // docs/adr/0043: the prompts and the last reply of each turn.
    case "outline": {
      rejectWith(v, OUTLINE_REJECTS, "outline");
      const id = sessionOf(rest[0] ?? usage("outline にはセッションIDを指定する"));
      if (v.json && v["max-bytes"] !== undefined) usage("outline --json には --max-bytes を付けられない");
      const page = { offset, limit: count(v.limit, "limit", 100), maxChars: count(v["max-chars"], "max-chars", 80), maxBytes: count(v["max-bytes"], "max-bytes", 8000) };
      const total = messageCount(db, id.provider, id.session_id);
      const all = turns(sessionMessages(db, id.provider, id.session_id, 1, total));
      if (v.json) return jsonLines(outlineJson(all, page));
      const title = sessionSummary(db, id.provider, id.session_id)?.title;
      const head = `# ${id.provider} ${id.session_id} ${title ? flat(title) : ""}（${total} 件、発言 ${promptCount(all)} 件）`;
      const more = (next: number) => `（続き：chat-log outline ${id.session_id} --offset ${next}${v.provider !== undefined ? ` --provider ${id.provider}` : ""}）`;
      return outlineTextPage(all, page, head, more);
    }
    // docs/adr/0026: the whole session as Markdown.
    case "export": {
      if (v.message !== undefined) {
        rejectWith(v, EXPORT_MESSAGE_REJECTS, "export --message");
        const m = messageOf(v.message, rest[0] === undefined ? undefined : sessionOf(rest[0]));
        const [message] = sessionMessages(db, m.provider, m.session_id, m.index, m.index);
        if (message === undefined) throw exitError(1, `メッセージが見つかりません: ${v.message}`);
        return messageSectionMarkdown(message);
      }
      const id = sessionOf(rest[0] ?? usage("export にはセッションIDを指定する"));
      const rejected = EXPORT_REJECTS.filter((name) => v[name] !== undefined && v[name] !== false);
      if (rejected.length > 0) usage(`export には ${rejected.map((n) => `--${n}`).join("、")} を付けられない`);
      const session = sessionSummary(db, id.provider, id.session_id);
      if (session === null) throw exitError(1, `セッションが見つかりません: ${id.session_id}`);
      return sessionMarkdown(session, sessionMessages(db, id.provider, id.session_id, 1, messageCount(db, id.provider, id.session_id)));
    }
    case "context": {
      const cwd = v.all ? undefined : (v.cwd ?? process.cwd());
      const maxChars = count(v["max-chars"], "max-chars", 500);
      const wanted = count(v.messages, "messages", 4);
      const entries = listSessions(db, filter(cwd), count(v.limit, "limit", 5), offset).map((session) => {
        const total = messageCount(db, session.provider, session.session_id);
        const recent = sessionMessages(db, session.provider, session.session_id, Math.max(1, total - Math.max(wanted * 5, 20) + 1), total);
        const withText = recent.filter((m) => plainText(m) !== "");
        return { session, last: wanted === 0 ? [] : withText.slice(-wanted) };
      });
      if (v.json) return jsonLines(entries.map(({ session, last }) => ({ ...session, last_messages: last.map((m) => messageJson(m, maxChars)) })));
      return contextText(cwd === undefined ? "すべて" : resolve(cwd), entries, maxChars);
    }
    default:
      return usage(`知らないサブコマンドです: ${command}`);
  }
};

// docs/adr/0027: a reader that stops early (`| head`) closes the pipe; end quietly with 0 then.
const isClosedPipe = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === "EPIPE";
process.stdout.on("error", (e) => {
  if (isClosedPipe(e)) process.exit(0);
  throw e;
});

try {
  const argv = process.argv.slice(2);
  process.stdout.write(argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) ? MAIN_HELP : main(argv));
} catch (e) {
  if (isClosedPipe(e)) process.exit(0);
  if (isExitError(e)) {
    console.error(isUsage(e) ? `${e.message}\n${helpHint(process.argv.slice(2))}` : e.message);
    process.exit(e.exitCode);
  }
  throw e;
}
