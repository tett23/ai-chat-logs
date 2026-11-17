import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { importSources, type SourceEntry } from "../src/import.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

// docs/adr/0043: chat-log outline.
const dir = tempDir();
const dbPath = join(dir, "logs.sqlite");
const MIX = "mix00000-0000-0000-0000-000000000001";
const PRE = "pre00000-0000-0000-0000-000000000001";
const SOLO = "solo0000-0000-0000-0000-000000000001";
const LONG = "long0000-0000-0000-0000-000000000001";
const AMB_A = "amb00000-0000-0000-0000-00000000000a";
const AMB_B = "amb00000-0000-0000-0000-00000000000b";
// docs/adr/0044: a session whose text outline is over 8,000 bytes by default.
const MANY = "many0000-0000-0000-0000-000000000001";
const EIGHTY = "eighty00-0000-0000-0000-000000000001";
const body80 = (c: string, i: number) => `${c}${String(i).padStart(3, "0")}`.padEnd(80, c);
const atMany = (i: number): string => new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString();
const recMany = (i: number, role: string, content: unknown) => ({
  type: role, uuid: `many-${String(i).padStart(4, "0")}`, sessionId: MANY, timestamp: atMany(i), cwd: "/work/outline", isSidechain: false, message: { role, content },
});
const many = Array.from({ length: 120 }, (_, k) => [recMany(2 * k + 1, "user", body80("q", k)), recMany(2 * k + 2, "assistant", [{ type: "text", text: body80("a", k) }])]).flat();

const at = (i: number): string => `2026-10-01T00:${String(i).padStart(2, "0")}:00.000Z`;
const rec = (session: string, i: number, role: string, content: unknown, sidechain = false) => ({
  type: role,
  uuid: `${session.slice(0, 4)}-${String(i).padStart(4, "0")}`,
  sessionId: session,
  timestamp: at(i),
  cwd: "/work/outline",
  isSidechain: sidechain,
  message: { role, content },
});
const text = (t: string) => [{ type: "text", text: t }];

// MIX: four turns. #1 is a reply before any prompt; #8 and #9 belong to a subagent.
const mix = [
  { type: "custom-title", customTitle: "流れの\n確認", sessionId: MIX },
  rec(MIX, 1, "assistant", text("前置き")),
  rec(MIX, 2, "user", "依頼 1"),
  rec(MIX, 3, "assistant", [{ type: "thinking", thinking: "考える" }]),
  rec(MIX, 4, "assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
  rec(MIX, 5, "user", [{ type: "tool_result", tool_use_id: "t1", content: "a b" }]),
  rec(MIX, 6, "assistant", text("途中")),
  rec(MIX, 7, "assistant", text("報告 1")),
  rec(MIX, 8, "user", "子の依頼", true),
  rec(MIX, 9, "assistant", text("子の報告"), true),
  rec(MIX, 10, "user", [{ type: "text", text: "  依頼 2\n\n  続き  " }]),
  rec(MIX, 11, "user", "依頼 3"),
  rec(MIX, 12, "assistant", text("報告 3")),
];
// PRE: the first turn has no prompt and nothing to print.
const pre = [
  rec(PRE, 1, "assistant", [{ type: "thinking", thinking: "準備" }]),
  rec(PRE, 2, "user", "始め"),
  rec(PRE, 3, "assistant", text("終わり")),
];

beforeAll(() => {
  const files: SourceEntry[] = [
    ["mix.jsonl", jsonl(...mix)],
    ["pre.jsonl", jsonl(...pre)],
    ["solo.jsonl", jsonl(rec(SOLO, 1, "user", "一つだけ"))],
    ["long.jsonl", jsonl(rec(LONG, 1, "user", "あいうえおかきくけこ"), rec(LONG, 2, "assistant", text("あいうえおかきくけこさ")))],
    ["amb-a.jsonl", jsonl(rec(AMB_A, 1, "user", "A"))],
    ["many.jsonl", jsonl(...many)],
    ["eighty.jsonl", jsonl(rec(EIGHTY, 1, "user", "x".repeat(80)), rec(EIGHTY, 2, "user", "y".repeat(81)))],
    ["amb-b.jsonl", jsonl(rec(AMB_B, 1, "user", "B"))],
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
const entries = (out: string) => lines(out).filter((l) => /^ {0,2}#\d+ /.test(l));
const entry = (line: string) => {
  const m = /^( {0,2})#(\d+) (user|assistant) (\S*) (.*)$/.exec(line);
  if (m === null) throw new Error(`not an entry: ${line}`);
  return { index: Number(m[2]), role: m[3], timestamp: m[4], body: m[5] as string };
};

describe("chat-log outline", () => {
  test("ADR 0043 I1, I2, I3: prompts and the last reply of each turn, matching show", () => {
    const r = chatLog(["outline", MIX]);
    expect(r.code).toBe(0);
    const out = lines(r.out);
    expect(out[0]).toBe(`# claude-code ${MIX} 流れの 確認（12 件、発言 3 件）`);
    expect(entries(r.out)).toEqual([
      `  #1 assistant ${at(1)} 前置き`,
      `#2 user ${at(2)} 依頼 1`,
      `  #7 assistant ${at(7)} 報告 1`,
      `#10 user ${at(10)} 依頼 2 続き`,
      `#11 user ${at(11)} 依頼 3`,
      `  #12 assistant ${at(12)} 報告 3`,
    ]);
    for (const e of entries(r.out).map(entry)) {
      const [shown] = lines(chatLog(["show", MIX, "--around", String(e.index), "--limit", "1", "--json"]).out).map((l) => JSON.parse(l));
      expect({ role: shown.role, timestamp: shown.timestamp }).toEqual({ role: e.role, timestamp: e.timestamp });
    }
  });

  test("ADR 0043 I3, ADR 0044 I3: a turn without a prompt, an empty first turn and a prompt without a reply", () => {
    expect(entries(chatLog(["outline", SOLO]).out)).toEqual([`#1 user ${at(1)} 一つだけ`]);
    expect(entries(chatLog(["outline", PRE]).out)).toEqual([`#2 user ${at(2)} 始め`, `  #3 assistant ${at(3)} 終わり`]);
    const first = lines(chatLog(["outline", PRE, "--limit", "1"]).out);
    expect(first).toEqual([`# claude-code ${PRE} 始め（3 件、発言 1 件）`, `（続き：chat-log outline ${PRE} --offset 1）`]);
  });

  test("ADR 0043 I4: subagent messages never appear", () => {
    const out = chatLog(["outline", MIX]).out;
    expect(out).not.toContain("子の");
    expect(entries(out).map((l) => entry(l).index)).not.toContain(8);
    expect(entries(out).map((l) => entry(l).index)).not.toContain(9);
  });

  test("ADR 0043 I5, I7: bodies are one line and cut at --max-chars", () => {
    const cut = entries(chatLog(["outline", LONG, "--max-chars", "10"]).out).map((l) => entry(l).body);
    expect(cut).toEqual(["あいうえおかきくけこ", "あいうえおかきくけこ…（11 文字のうち 10 文字）"]);
    const whole = entries(chatLog(["outline", LONG, "--max-chars", "0"]).out).map((l) => entry(l).body);
    expect(whole).toEqual(["あいうえおかきくけこ", "あいうえおかきくけこさ"]);
    const rows = lines(chatLog(["outline", LONG, "--max-chars", "10", "--json"]).out).map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.text, x.truncated_from])).toEqual([["あいうえおかきくけこ", null], ["あいうえおかきくけこ", 11]]);
    entries(chatLog(["outline", MIX]).out).forEach((l) => expect(l).not.toContain("\n"));
  });

  test("ADR 0044 I3: with --max-bytes 0, --offset and --limit count turns and the continuation line resumes", () => {
    const all = entries(chatLog(["outline", MIX, "--max-bytes", "0"]).out);
    const turns = [[all[0]], [all[1], all[2]], [all[3]], [all[4], all[5]]];
    for (let a = 0; a <= 5; a++) {
      for (let b = 1; b <= 5; b++) {
        const r = chatLog(["outline", MIX, "--offset", String(a), "--limit", String(b), "--max-bytes", "0"]);
        expect(entries(r.out)).toEqual(turns.slice(a, a + b).flat());
        const more = lines(r.out).find((l) => l.startsWith("（続き："));
        expect(more).toBe(a + b < turns.length ? `（続き：chat-log outline ${MIX} --offset ${a + b}）` : undefined);
      }
    }
    expect(lines(chatLog(["outline", MIX, "--limit", "1", "--provider", "claude-code"]).out).at(-1)).toBe(
      `（続き：chat-log outline ${MIX} --offset 1 --provider claude-code）`,
    );
  });

  test("ADR 0044 I6: --json has the same entries as the text without a byte limit", () => {
    const text = entries(chatLog(["outline", MIX, "--max-bytes", "0"]).out).map(entry);
    const rows = lines(chatLog(["outline", MIX, "--json"]).out).map((l) => JSON.parse(l));
    expect(rows.map((x) => [x.index, x.role, x.text])).toEqual(text.map((e) => [e.index, e.role, e.body]));
    expect(Object.keys(rows[0])).toEqual(["index", "uuid", "timestamp", "role", "text", "truncated_from"]);
  });

  test.each([
    ["--around", "3"], ["--message", "mix0-0002"], ["--range", "1"], ["--thinking"], ["--tools"], ["--cwd", "."], ["--since", "7d"], ["--until", "7d"],
    ["--all"], ["--messages", "2"], ["--session", MIX], ["--exclude", "x"],
  ])("ADR 0043 I8: outline rejects %s", (...option) => {
    const r = chatLog(["outline", MIX, ...option]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  });

  test("ADR 0043 I9: a missing session exits 1 and an ambiguous one exits 2 with candidates", () => {
    expect(chatLog(["outline", "nonexist-0000"]).code).toBe(1);
    const amb = chatLog(["outline", "amb00000"]);
    expect(amb.code).toBe(2);
    expect(amb.err).toContain(`claude-code\t${AMB_A}`);
    expect(amb.err).toContain(`claude-code\t${AMB_B}`);
  });

  test("ADR 0044 I7: the help explains outline", () => {
    const help = chatLog(["outline", "--help"]).out;
    ["--limit 100", "区切り", "--max-chars 80", "--max-bytes 8000"].forEach((s) => expect(help).toContain(s));
    const main = chatLog(["--help"]).out;
    const ids = main.slice(main.indexOf("利用者からIDを渡されたとき"), main.indexOf("使う順序の勧め"));
    expect(ids).toContain("chat-log outline <セッションID>");
  });

  // docs/adr/0044
  const bytes = (out: string) => Buffer.byteLength(out, "utf8");
  const nextOffset = (out: string): number | null => {
    const m = /（続き：chat-log outline \S+ --offset (\d+)/.exec(out);
    return m === null ? null : Number(m[1]);
  };
  const walk = (args: string[]): string[] => {
    const seen: string[] = [];
    for (let o: number | null = 0, guard = 0; o !== null && guard < 500; guard++) {
      const out = chatLog(["outline", MANY, "--offset", String(o), ...args]).out;
      seen.push(...entries(out));
      o = nextOffset(out);
    }
    return seen;
  };

  test("ADR 0044 I1, I2, I3: --max-bytes stops at whole turns and the continuation lines cover every turn", () => {
    const fullOut = chatLog(["outline", MANY, "--max-bytes", "0", "--limit", "1000"]).out;
    const full = entries(fullOut);
    expect(full).toHaveLength(240);
    const total = bytes(fullOut);
    const all = chatLog(["outline", MANY, "--max-bytes", String(total), "--limit", "1000"]);
    expect(entries(all.out)).toEqual(full);
    expect(nextOffset(all.out)).toBeNull();
    const less = chatLog(["outline", MANY, "--max-bytes", String(total - 1), "--limit", "1000"]);
    expect(bytes(less.out)).toBeLessThanOrEqual(total - 1);
    expect(entries(less.out)).toEqual(full.slice(0, entries(less.out).length));
    expect(nextOffset(less.out)).toBe(entries(less.out).length / 2);
    for (const b of ["10", "300", "8000"]) {
      for (const l of ["1", "5", "100"]) {
        const first = chatLog(["outline", MANY, "--max-bytes", b, "--limit", l]).out;
        const k = entries(first).length / 2;
        expect(entries(first)).toEqual(full.slice(0, 2 * k));
        if (k >= 2) expect(bytes(first)).toBeLessThanOrEqual(Number(b));
        expect(walk(["--max-bytes", b, "--limit", l])).toEqual(full);
      }
    }
    const tiny = chatLog(["outline", MANY, "--max-bytes", "10"]).out;
    expect(entries(tiny)).toEqual(full.slice(0, 2));
    expect(nextOffset(tiny)).toBe(1);
    expect(lines(chatLog(["outline", MANY, "--offset", "120"]).out)).toHaveLength(1);
    expect(lines(chatLog(["outline", MANY, "--max-bytes", "10", "--provider", "claude-code"]).out).at(-1)).toBe(
      `（続き：chat-log outline ${MANY} --offset 1 --provider claude-code）`,
    );
    expect(lines(chatLog(["outline", PRE, "--max-bytes", "10"]).out)).toEqual([`# claude-code ${PRE} 始め（3 件、発言 1 件）`, `（続き：chat-log outline ${PRE} --offset 1）`]);
  }, 300_000);

  test("ADR 0044 I1: the default output of a long session stays within 8,000 bytes", () => {
    const out = chatLog(["outline", MANY]).out;
    expect(bytes(out)).toBeLessThanOrEqual(8000);
    expect(nextOffset(out)).not.toBeNull();
  });

  test("ADR 0044 I4: bodies are cut at 80 characters by default", () => {
    expect(entries(chatLog(["outline", EIGHTY]).out).map((l) => entry(l).body)).toEqual(["x".repeat(80), `${"y".repeat(80)}…（81 文字のうち 80 文字）`]);
  });

  test.each([
    [["outline", MANY, "--json", "--max-bytes", "100"]],
    [["outline", MANY, "--json", "--max-bytes", "0"]],
    [["show", MANY, "--max-bytes", "100"]],
    [["outline", MANY, "--max-bytes", "-1"]],
    [["outline", MANY, "--max-bytes", "abc"]],
  ])("ADR 0044 I5: %p is a usage error", (args) => {
    const r = chatLog(args as string[]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  });

  test("ADR 0044 I6: --json is not limited by bytes", () => {
    const rows = lines(chatLog(["outline", MANY, "--json", "--limit", "1000"]).out);
    expect(rows).toHaveLength(entries(chatLog(["outline", MANY, "--max-bytes", "0", "--limit", "1000"]).out).length);
    expect(rows.length).toBeGreaterThan(entries(chatLog(["outline", MANY, "--limit", "1000"]).out).length);
  });
});
