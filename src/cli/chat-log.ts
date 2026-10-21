#!/usr/bin/env -S bun --no-env-file
// docs/adr/0011: a read-only CLI for AI agents to look up the chat logs.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { contextText, hitLines, jsonLines, messageJson, messagesText, plainText, sessionLine } from "../chat-log/format.ts";
import { HELP, MAIN_HELP } from "../chat-log/help.ts";
import { planSearch } from "../chat-log/search.ts";
import {
  exitError,
  type Filter,
  isExitError,
  listSessions,
  messageCount,
  openReadOnly,
  search,
  sessionIds,
  sessionMessages,
} from "../chat-log/store.ts";
import { matchSession, parseSince } from "../chat-log/values.ts";
import { loadEnvFile } from "../env.ts";
import { defaultDatabasePath } from "../paths.ts";

const usage = (message: string): never => {
  throw exitError(2, `${message}\nchat-log --help で使い方を出す。`);
};

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
        limit: { type: "string" },
        offset: { type: "string" },
        "max-chars": { type: "string" },
        json: { type: "boolean", default: false },
        around: { type: "string" },
        thinking: { type: "boolean", default: false },
        tools: { type: "boolean", default: false },
        messages: { type: "string" },
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

const main = (argv: string[]): string => {
  const { values: v, positionals } = parse(argv);
  const [command, ...rest] = positionals;
  if (command === undefined) return MAIN_HELP;
  const help = HELP[command] ?? usage(`知らないサブコマンドです: ${command}`);
  if (v.help) return `${help}\n`;

  loadEnvFile();
  const since = (() => {
    try {
      return v.since === undefined ? undefined : parseSince(v.since);
    } catch (e) {
      return usage(e instanceof Error ? e.message : String(e));
    }
  })();
  const filter = (cwd: string | undefined): Filter => ({ provider: v.provider, cwd: cwd === undefined ? undefined : resolve(cwd), since });
  const db = openReadOnly(defaultDatabasePath(process.env));
  const offset = count(v.offset, "offset", 0);

  switch (command) {
    case "sessions": {
      const sessions = listSessions(db, filter(v.cwd), count(v.limit, "limit", 50), offset);
      return v.json ? jsonLines(sessions) : sessions.map((s) => `${sessionLine(s)}\n`).join("");
    }
    case "search": {
      if (rest.length === 0) usage("search には語を指定する");
      const hits = search(db, planSearch(rest.join(" ")), filter(v.cwd), count(v.limit, "limit", 20), offset);
      return v.json ? jsonLines(hits) : hits.map((h) => `${hitLines(h)}\n`).join("");
    }
    case "show": {
      const prefix = rest[0] ?? usage("show にはセッションIDを指定する");
      const match = matchSession(prefix, sessionIds(db, prefix));
      if (match.kind === "short") usage("セッションIDは先頭8文字以上で指定する");
      if (match.kind === "none") throw exitError(1, `セッションが見つかりません: ${prefix}`);
      if (match.kind === "ambiguous") throw exitError(1, `セッションIDが区別できません: ${prefix}\n候補:\n${match.ids.join("\n")}`);
      const id = match.kind === "found" ? match.id : "";
      const limit = count(v.limit, "limit", 50);
      const maxChars = count(v["max-chars"], "max-chars", 2000);
      const total = messageCount(db, id);
      const from = v.around !== undefined ? Math.max(1, count(v.around, "around", 1) - Math.floor(limit / 2)) : offset + 1;
      const to = from + limit - 1;
      const messages = sessionMessages(db, id, from, to);
      if (v.json) return jsonLines(messages.map((m) => messageJson(m, maxChars)));
      const center = v.around !== undefined ? count(v.around, "around", 1) : null;
      return messagesText(messages, { thinking: v.thinking, tools: v.tools, maxChars }, { from, to, total, center, previous: center !== null });
    }
    case "context": {
      const cwd = v.all ? undefined : (v.cwd ?? process.cwd());
      const maxChars = count(v["max-chars"], "max-chars", 500);
      const wanted = count(v.messages, "messages", 4);
      const entries = listSessions(db, filter(cwd), count(v.limit, "limit", 5), offset).map((session) => {
        const total = messageCount(db, session.session_id);
        const recent = sessionMessages(db, session.session_id, Math.max(1, total - Math.max(wanted * 5, 20) + 1), total);
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

try {
  const argv = process.argv.slice(2);
  process.stdout.write(argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) ? MAIN_HELP : main(argv));
} catch (e) {
  if (isExitError(e)) {
    console.error(e.message);
    process.exit(e.exitCode);
  }
  throw e;
}
