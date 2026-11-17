import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { importSources, type SourceEntry } from "../src/import.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

// docs/adr/0040: session and message IDs.
const dir = tempDir();
const dbPath = join(dir, "logs.sqlite");
const R = "rrrrrrrr-0000-0000-0000-000000000001";
const ONE = "oooooooo-0000-0000-0000-000000000001";
const DUP_A = "dddddddd-0000-0000-0000-00000000000a";
const DUP_B = "dddddddd-0000-0000-0000-00000000000b";
const SEARCH_A = "ssssssss-0000-0000-0000-00000000000a";
const SEARCH_B = "ssssssss-0000-0000-0000-00000000000b";

const mid = (i: number): string => `m${String(i).padStart(7, "0")}-1111-1111-1111-111111111111`;
const SHARED = "shared00-2222-2222-2222-222222222222";
const ONLY = "only0000-3333-3333-3333-333333333333";
const SYSTEM = "system00-4444-4444-4444-444444444444";
const EMPTY = "empty000-5555-5555-5555-555555555555";

const rec = (session: string, uuid: string, timestamp: string, role: string, content: unknown, cwd = "/work/ids") => ({
  type: role,
  uuid,
  sessionId: session,
  timestamp,
  cwd,
  message: { role, model: role === "assistant" ? "claude-opus-5-5" : undefined, content },
});
const at = (i: number): string => `2026-10-01T00:${String(i).padStart(2, "0")}:00.000Z`;

// Session R: 20 messages numbered #1–#20, #6 of which is an assistant with only empty thinking.
const r = [
  { type: "custom-title", customTitle: "IDの\n確認", sessionId: R },
  ...Array.from({ length: 20 }, (_, k) => {
    const i = k + 1;
    if (i === 6) return rec(R, EMPTY, at(i), "assistant", [{ type: "thinking", thinking: "" }]);
    return i % 2 === 1 ? rec(R, mid(i), at(i), "user", `質問 ${i}`) : rec(R, mid(i), at(i), "assistant", [{ type: "thinking", thinking: `考え ${i}` }, { type: "text", text: `答え ${i}` }]);
  }),
  { type: "system", uuid: SYSTEM, sessionId: R, timestamp: at(21), content: "system line" },
];

beforeAll(() => {
  const files: SourceEntry[] = [
    ["p/r.jsonl", jsonl(...r)],
    // a copy of session R's first lines: the same uuids under the same session
    ["q/r-copy.jsonl", jsonl(...r.slice(1, 4))],
    ["p/one.jsonl", jsonl(rec(ONE, ONLY, at(0), "user", "一つだけ"))],
    ["p/dup-a.jsonl", jsonl(rec(DUP_A, SHARED, at(0), "user", "重なるID A"))],
    ["p/dup-b.jsonl", jsonl(rec(DUP_B, SHARED, at(0), "user", "重なるID B"))],
    ["p/search-a.jsonl", jsonl(rec(SEARCH_A, "sa000000-0000", at(0), "user", "共通の検索語 A", "/work/a"))],
    ["p/search-b.jsonl", jsonl(rec(SEARCH_B, "sb000000-0000", at(1), "user", "共通の検索語 B", "/work/b"))],
  ].map(([rel, content]) => ({ kind: "claude-code/transcript", path: writeFile(join(dir, "src", rel as string), content as string) }));
  const db = openDatabase(dbPath);
  importSources(db, files, {});
  db.close();
}, 60_000);

const chatLog = (args: string[]) => {
  const p = Bun.spawnSync([join(repoRoot, "src/cli/chat-log.ts"), ...args], { env: isolatedEnv({ HOME: dir, AI_CHAT_LOGS_DB: dbPath }) });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};
const lines = (out: string) => out.split("\n").filter((l) => l !== "");
const json = (out: string) => lines(out).map((l) => JSON.parse(l));
const indexes = (args: string[]): number[] => json(chatLog([...args, "--json"]).out).map((m) => m.index);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, k) => from + k);

describe("chat-log show --message", () => {
  test("ADR 0040 I1, I2: the message and the messages around it, by number", () => {
    expect(indexes(["show", "--message", mid(10)])).toEqual(range(5, 15));
    expect(indexes(["show", "--message", mid(10), "--range", "0"])).toEqual([10]);
    expect(indexes(["show", "--message", mid(10), "--range", "3"])).toEqual(range(7, 13));
    expect(indexes(["show", "--message", mid(10), "--range", "2:7"])).toEqual(range(8, 17));
    const rows = json(chatLog(["show", "--message", mid(10).slice(0, 8), "--json"]).out);
    expect(rows.filter((m) => m.uuid === mid(10))).toHaveLength(1);
    expect(rows.every((m) => m.provider === "claude-code" && m.session_id === R)).toBe(true);
  });

  test("ADR 0040 I1: the range is cut at both ends of the session, not shifted", () => {
    expect(indexes(["show", "--message", mid(1)])).toEqual(range(1, 6));
    expect(indexes(["show", "--message", mid(20)])).toEqual(range(15, 20));
    expect(indexes(["show", "--message", ONLY])).toEqual([1]);
    const first = chatLog(["show", "--message", mid(1)]).out;
    expect(first).not.toContain("（前：");
    expect(first).toContain(`（続き：#7 から。chat-log show ${R} --offset 6 で出す）`);
    const last = chatLog(["show", "--message", mid(20)]).out;
    expect(last).toContain(`（前：#9〜#14 は chat-log show ${R} --offset 8 で出す）`);
    expect(last).not.toContain("（続き：");
    const single = chatLog(["show", "--message", mid(10), "--range", "0"]).out;
    expect(single).not.toContain("（前：");
    expect(single).not.toContain("（続き：");
  });

  test("ADR 0040 I1: the text output starts with the provider, the whole session ID and the title", () => {
    const out = chatLog(["show", "--message", mid(10)]).out;
    expect(out.split("\n")[0]).toBe(`# claude-code ${R} IDの 確認（メッセージ #10）`);
    expect(out).toContain("考え 10"); // thinking in the range shows without --thinking
  });

  test("ADR 0040 I3: --range equals --around with the same width when the range is not cut", () => {
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ provider: _p, session_id: _s, ...rest }) => rest);
    expect(strip(json(chatLog(["show", "--message", mid(10), "--range", "4", "--json"]).out))).toEqual(
      json(chatLog(["show", R, "--around", "10", "--limit", "9", "--json"]).out),
    );
    expect(indexes(["show", "--message", mid(10), "--range", "4:3"])).toEqual(indexes(["show", R, "--around", "10", "--limit", "8"]));
  });

  test("ADR 0040 I4, I11: an ID in two sessions needs the session ID; short IDs are usage errors", () => {
    const ambiguous = chatLog(["show", "--message", SHARED]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.out).toBe("");
    expect(ambiguous.err).toContain(DUP_A);
    expect(ambiguous.err).toContain(DUP_B);
    expect(chatLog(["show", "--message", SHARED, "--provider", "claude-code"]).code).toBe(2);
    const narrowed = json(chatLog(["show", DUP_B, "--message", SHARED, "--json"]).out);
    expect(narrowed.map((m) => [m.session_id, m.uuid])).toEqual([[DUP_B, SHARED]]);
    const short = chatLog(["show", "--message", "m000001"]);
    expect(short.code).toBe(2);
    expect(chatLog(["show", "--message", "zzzzzzzz"]).code).toBe(1);
  });

  test("ADR 0040 I2: a copy's ID finds the original; an ID only on a non-message line exits 1", () => {
    expect(indexes(["show", "--message", mid(2), "--range", "0"])).toEqual([2]);
    expect(chatLog(["show", "--message", SYSTEM]).code).toBe(1);
  });

  test("usage errors", () => {
    for (const args of [
      ["--range", "-1"], ["--range", "1:2:3"], ["--range", "a"], ["--range", ""],
      ["--around", "3"], ["--limit", "3"], ["--offset", "3"], ["--since", "7d"], ["--until", "7d"], ["--cwd", "."],
    ]) {
      expect(chatLog(["show", "--message", mid(10), ...args]).code).toBe(2);
    }
    expect(chatLog(["show", R, "--range", "3"]).code).toBe(2);
    expect(chatLog(["show", "--message"]).code).toBe(2);
  });
});

describe("chat-log search --session", () => {
  test("ADR 0040 I5: only the hits of the session", () => {
    const all = json(chatLog(["search", "共通の検索語", "--json"]).out);
    expect(all.map((h) => h.session_id).sort()).toEqual([SEARCH_A, SEARCH_B]);
    const one = json(chatLog(["search", "共通の検索語", "--session", SEARCH_A, "--json"]).out);
    expect(one).toEqual(all.filter((h) => h.session_id === SEARCH_A));
    const none = chatLog(["search", "質問", "--session", SEARCH_A]);
    expect(none.code).toBe(0);
    expect(none.out).toBe("");
  });

  test("ADR 0040 I5: session errors and options that cannot go with --session", () => {
    expect(chatLog(["search", "共通の検索語", "--session", "ssssssss"]).code).toBe(2);
    expect(chatLog(["search", "共通の検索語", "--session", "99999999"]).code).toBe(1);
    expect(chatLog(["search", "共通の検索語", "--session", "short"]).code).toBe(2);
    for (const extra of [["--cwd", "."], ["--since", "7d"], ["--until", "7d"]]) {
      expect(chatLog(["search", "共通の検索語", "--session", SEARCH_A, ...extra]).code).toBe(2);
    }
  });
});

describe("chat-log export --message", () => {
  test("ADR 0040 I6: the section of the message in the whole export", () => {
    const whole = chatLog(["export", R]).out;
    const one = chatLog(["export", "--message", mid(10)]);
    expect(one.code).toBe(0);
    expect(one.out.startsWith("## #10 assistant ")).toBe(true);
    expect(one.out.endsWith("\n")).toBe(true);
    expect(whole).toContain(`\n\n${one.out.slice(0, -1)}\n\n## #11 `);
    const withSession = chatLog(["export", R, "--message", mid(10)]).out;
    expect(withSession).toBe(one.out);
  });

  test("ADR 0040 I7: a message with nothing to write still gives its head", () => {
    const out = chatLog(["export", "--message", EMPTY]).out;
    expect(out).toBe(`## #6 assistant ${at(6)} claude-opus-5-5\n\n（書く本文が無い）\n`);
  });

  test("exit codes and the options it does not take", () => {
    expect(chatLog(["export", "--message", SHARED]).code).toBe(2);
    expect(chatLog(["export", "--message", "zzzzzzzz"]).code).toBe(1);
    for (const extra of [["--range", "1"], ["--around", "1"], ["--thinking"], ["--tools"], ["--json"], ["--limit", "1"]]) {
      expect(chatLog(["export", "--message", mid(10), ...extra]).code).toBe(2);
    }
  });
});

describe("chat-log help for AI agents (docs/adr/0040)", () => {
  test("the help says what to run with IDs given by the user", () => {
    const help = chatLog(["--help"]).out;
    expect(help).toContain("利用者からIDを渡されたとき");
    expect(help).toContain("chat-log show --message <メッセージID>");
    expect(help).toContain("--session <セッションID>");
    expect(chatLog(["show", "--help"]).out).toContain("--range <前>[:<後>]"); // docs/adr/0042
    expect(help).toContain("メッセージID:");
    expect(help.indexOf("利用者からIDを渡されたとき")).toBeLessThan(help.indexOf("使う順序の勧め"));
    const exportHelp = chatLog(["export", "--help"]).out;
    expect(exportHelp).not.toContain("人が読む");
    expect(exportHelp).not.toContain("> <ファイル>");
    expect(exportHelp).toContain("--message <メッセージID>");
  });
});
