import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { importSources, type SourceEntry } from "../src/import.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

// docs/adr/0011
const dir = tempDir();
const dbPath = join(dir, "logs.sqlite");
const S1 = "aaaaaaaa-1111";
const S2 = "bbbbbbbb-2222";
const S3 = "cccccccc-3333";
const AI = "dddddddd-4444";
const BIG = "eeeeeeee-5555";

const rec = (session: string, uuid: string, timestamp: string, role: string, content: unknown, cwd: string | null) => ({
  type: role,
  uuid,
  sessionId: session,
  timestamp,
  ...(cwd ? { cwd } : {}),
  message: { role, model: role === "assistant" ? "claude-opus-5-5" : undefined, content },
});

const s1 = [
  { type: "custom-title", customTitle: "設計の議論", sessionId: S1 },
  rec(S1, "u1", "2026-10-01T00:00:00.000Z", "user", "全文検索の設計を決めたい", "/work/proj"),
  rec(S1, "a1", "2026-10-01T00:01:00.000Z", "assistant", [
    { type: "thinking", thinking: "秘密の考え" },
    { type: "text", text: "写しを除くことにした" },
    { type: "tool_use", name: "Bash", input: { command: "ls" } },
  ], "/work/proj"),
  rec(S1, "u2", "2026-10-01T00:02:00.000Z", "user", [{ type: "tool_result", content: "結果" }], "/work/proj"),
  rec(S1, "a2", "2026-10-01T00:03:00.000Z", "assistant", [{ type: "text", text: "了解しました" }], "/work/proj"),
];

const SUB = "ssssssss-7777";
const SNIP = "gggggggg-8888";
const EMPTY = "hhhhhhhh-9999";

// docs/adr/0013
const T = "tttttttt-6666";
const t = [
  rec(T, "t1", "2026-07-01T00:00:00.000Z", "user", "思考の確認", "/work/think"),
  rec(T, "t2", "2026-07-01T00:01:00.000Z", "assistant", [{ type: "thinking", thinking: "内緒の検討メモ" }], "/work/think"),
  rec(T, "t3", "2026-07-01T00:02:00.000Z", "assistant", [{ type: "text", text: "これは**太字の語**です" }], "/work/think"),
  rec(T, "t4", "2026-07-01T00:03:00.000Z", "user", [{ type: "tool_result", content: [{ type: "image", source: { data: "Q".repeat(300) } }] }], "/work/think"),
];

beforeAll(() => {
  const files: SourceEntry[] = [
    ["p/s1.jsonl", jsonl(...s1)],
    ["q/fork-copy.jsonl", jsonl(...s1.slice(1))],
    ["p/s2.jsonl", jsonl(rec(S2, "w1", "2026-10-05T00:00:00.000Z", "user", "worktree での作業", "/work/proj/.claude/worktrees/x"))],
    ["p/s3.jsonl", jsonl(rec(S3, "o1", "2026-10-06T00:00:00.000Z", "user", "別のプロジェクトの全文検索", "/work/project-other"))],
    ["p/big.jsonl", jsonl(...Array.from({ length: 120 }, (_, i) => rec(BIG, `b${i}`, `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, "user", "長".repeat(100_000), "/work/big")))],
    ["p/think.jsonl", jsonl(...t)],
    // docs/adr/0016: a subagent's records interleave with the parent's in time
    ["p/sub.jsonl", jsonl(rec(SUB, "p1", "2026-06-01T00:00:00.000Z", "user", "親の最初", "/work/sub"), rec(SUB, "p2", "2026-06-01T00:02:00.000Z", "assistant", [{ type: "text", text: "親の最後" }], "/work/sub"))],
    ["p/sub/subagents/agent-1.jsonl", jsonl(rec(SUB, "q1", "2026-06-01T00:01:00.000Z", "assistant", [{ type: "text", text: "子の時系列の確認" }], "/work/sub"))],
    // docs/adr/0019: thinking with and without a body
    ["p/empty.jsonl", jsonl(
      rec(EMPTY, "h1", "2026-04-01T00:00:00.000Z", "user", "空の思考の確認", "/work/empty"),
      rec(EMPTY, "h2", "2026-04-01T00:01:00.000Z", "assistant", [{ type: "thinking", thinking: "" }], "/work/empty"),
      rec(EMPTY, "h3", "2026-04-01T00:02:00.000Z", "assistant", [{ type: "thinking", thinking: "  " }, { type: "text", text: "空でない本文" }], "/work/empty"),
      rec(EMPTY, "h4", "2026-04-01T00:03:00.000Z", "assistant", [{ type: "thinking", thinking: "前後の考え" }], "/work/empty"),
      rec(EMPTY, "h5", "2026-04-01T00:04:00.000Z", "user", "最後", "/work/empty"),
    )],
    // docs/adr/0018: terms far apart in one text
    ["p/snip.jsonl", jsonl(rec(SNIP, "n1", "2026-05-01T00:00:00.000Z", "user", `apricot と梨${"ー".repeat(100)}blueberry と柿`, "/work/snip"))],
    ["p/f1.jsonl", jsonl(rec("ffffffff-0001", "f1", "2026-08-01T00:00:00.000Z", "user", "一つ目", "/work/f"))],
    ["p/f2.jsonl", jsonl(rec("ffffffff-0002", "f2", "2026-08-02T00:00:00.000Z", "user", "二つ目", "/work/f"))],
  ].map(([rel, content]) => ({ kind: "claude-code/transcript", path: writeFile(join(dir, "src", rel as string), content as string) }));
  const ai = writeFile(
    join(dir, "src/ai/x/messages.jsonl"),
    jsonl(
      { type: "custom-title", customTitle: "claude.ai の会話", sessionId: AI },
      rec(AI, "c1", "2026-10-07T00:00:00.000Z", "user", [{ type: "text", text: "claude.ai での全文検索" }], null),
    ),
  );
  const db = openDatabase(dbPath);
  importSources(db, [...files, { kind: "claude-ai/conversation", path: ai }], {});
  db.close();
}, 60_000);

const chatLog = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) => {
  const r = Bun.spawnSync([join(repoRoot, "src/cli/chat-log.ts"), ...args], {
    cwd: options.cwd,
    env: isolatedEnv({ HOME: dir, AI_CHAT_LOGS_DB: dbPath, ...options.env }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const lines = (out: string) => out.split("\n").filter((l) => l !== "");
const json = (out: string) => lines(out).map((l) => JSON.parse(l));

describe("chat-log sessions", () => {
  test("lists sessions newest first as tab-separated lines", () => {
    const r = chatLog(["sessions", "--limit", "3"]);
    expect(r.code).toBe(0);
    expect(lines(r.out)).toEqual([
      "2026-10-07T00:00:00.000Z\tclaude-ai\tdddddddd\t1\tclaude.ai の会話\t",
      "2026-10-06T00:00:00.000Z\tclaude-code\tcccccccc\t1\t別のプロジェクトの全文検索\t/work/project-other",
      "2026-10-05T00:00:00.000Z\tclaude-code\tbbbbbbbb\t1\tworktree での作業\t/work/proj/.claude/worktrees/x",
    ]);
  });

  test("filters by provider, cwd (including subdirectories only), since and offset", () => {
    const ids = (args: string[]) => lines(chatLog(["sessions", ...args]).out).map((l) => l.split("\t")[2]);
    expect(ids(["--provider", "claude-ai"])).toEqual(["dddddddd"]);
    expect(ids(["--cwd", "/work/proj"])).toEqual(["bbbbbbbb", "aaaaaaaa"]);
    expect(ids(["--since", "2026-10-05T12:00:00Z"])).toEqual(["dddddddd", "cccccccc"]);
    expect(ids(["--limit", "1", "--offset", "1"])).toEqual(["cccccccc"]);
    // docs/adr/0018: sessions that overlap the period
    expect(ids(["--since", "2026-10-04", "--until", "2026-10-06T12:00:00Z"])).toEqual(["cccccccc", "bbbbbbbb"]);
  });

  test("--json prints one object per line", () => {
    const [first] = json(chatLog(["sessions", "--limit", "1", "--json"]).out);
    expect(first).toEqual({
      provider: "claude-ai",
      session_id: AI,
      title: "claude.ai の会話",
      cwd: null,
      first_at: "2026-10-07T00:00:00.000Z",
      last_at: "2026-10-07T00:00:00.000Z",
      message_count: 1,
    });
  });
});

describe("chat-log search", () => {
  test("finds terms of three or more characters, once per copied record, with the message number", () => {
    const r = chatLog(["search", "全文検索"]);
    expect(r.code).toBe(0);
    const out = lines(r.out);
    expect(out).toEqual([
      "2026-10-07T00:00:00.000Z\tclaude-ai\tdddddddd#1\tuser\tclaude.ai の会話",
      "\tclaude.ai での⟪全文検索⟫",
      "2026-10-06T00:00:00.000Z\tclaude-code\tcccccccc#1\tuser\t別のプロジェクトの全文検索",
      "\t別のプロジェクトの⟪全文検索⟫",
      "2026-10-01T00:00:00.000Z\tclaude-code\taaaaaaaa#1\tuser\t設計の議論",
      "\t⟪全文検索⟫の設計を決めたい",
    ]);
  });

  test("finds short terms with LIKE and matches show's numbering", () => {
    const out = lines(chatLog(["search", "写し", "--cwd", "/work/proj"]).out);
    expect(out[0]).toBe("2026-10-01T00:01:00.000Z\tclaude-code\taaaaaaaa#2\tassistant\t設計の議論");
    expect(out[1]).toContain("⟪写し⟫");
    const shown = chatLog(["show", "aaaaaaaa", "--around", "2", "--limit", "1"]).out;
    expect(shown).toContain("## #2 assistant 2026-10-01T00:01:00.000Z");
  });

  test("--json and no results", () => {
    const [hit] = json(chatLog(["search", "了解しました", "--json"]).out);
    expect(hit).toMatchObject({ provider: "claude-code", session_id: S1, index: 4, uuid: "a2", role: "assistant", title: "設計の議論" });
    expect(hit.snippet).toContain("⟪了解しました⟫");
    const none = chatLog(["search", "存在しない語句"]);
    expect([none.code, none.out]).toEqual([0, ""]);
  });
});

describe("chat-log show", () => {
  test("prints messages in order, hiding thinking and summarizing tools", () => {
    const r = chatLog(["show", "aaaaaaaa"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "## #1 user 2026-10-01T00:00:00.000Z",
        "全文検索の設計を決めたい",
        "",
        "## #2 assistant 2026-10-01T00:01:00.000Z",
        "写しを除くことにした",
        '[tool_use Bash] {"command":"ls"}',
        "",
        "## #3 user 2026-10-01T00:02:00.000Z",
        "[tool_result] 結果",
        "",
        "## #4 assistant 2026-10-01T00:03:00.000Z",
        "了解しました",
        "",
      ].join("\n"),
    );
  });

  test("--thinking and --tools", () => {
    const out = chatLog(["show", S1, "--thinking", "--tools"]).out;
    expect(out).toContain("[thinking] 秘密の考え");
    expect(out).toContain("[tool_result]\n結果");
  });

  test("--around, --limit and the continuation line", () => {
    const out = chatLog(["show", BIG, "--limit", "2", "--max-chars", "10"]).out;
    expect(lines(out).filter((l) => l.startsWith("## #"))).toHaveLength(2);
    expect(out).toContain("…（100000 文字のうち 10 文字）");
    expect(out.trimEnd().endsWith("（続き：#3 から。--offset 2 で出す）")).toBe(true);
    const around = lines(chatLog(["show", BIG, "--around", "50", "--limit", "4", "--max-chars", "5"]).out).filter((l) => l.startsWith("## #"));
    expect(around.map((l) => l.split(" ")[1])).toEqual(["#48", "#49", "#50", "#51"]);
  });

  test("unknown and ambiguous sessions exit 1", () => {
    const missing = chatLog(["show", "99999999"]);
    expect(missing.code).toBe(1);
    const ambiguous = chatLog(["show", "ffffffff"]);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err).toContain("ffffffff-0001");
    expect(ambiguous.err).toContain("ffffffff-0002");
  });

  test("--json prints messages with blocks", () => {
    const messages = json(chatLog(["show", "aaaaaaaa", "--json"]).out);
    expect(messages.map((m) => m.index)).toEqual([1, 2, 3, 4]);
    expect(messages[1]).toMatchObject({ uuid: "a1", role: "assistant", model: "claude-opus-5-5", is_sidechain: false });
    expect(messages[1].blocks.map((b: { kind: string }) => b.kind)).toEqual(["thinking", "text", "tool_use"]);
  });
});

describe("chat-log context", () => {
  test("shows the recent sessions of the working directory with their last messages", () => {
    const r = chatLog(["context", "--limit", "1", "--messages", "2"], { cwd: "/" , env: {} });
    expect(r.code).toBe(0);
    const proj = chatLog(["context", "--cwd", "/work/proj", "--messages", "2"]).out;
    expect(proj.split("\n")[0]).toBe("# /work/proj の最近のセッション（2）");
    expect(proj).toContain("## 設計の議論（claude-code、aaaaaaaa、2026-10-01T00:00:00.000Z〜2026-10-01T00:03:00.000Z、4 件）");
    expect(proj).toContain("了解しました");
    expect(proj).not.toContain("秘密の考え");
    expect(proj).not.toContain("別のプロジェクト");
  });

  test("defaults to the working directory, and --all lifts the filter", () => {
    const here = tempDir();
    const none = chatLog(["context"], { cwd: here });
    expect(none.code).toBe(0);
    expect(none.out).toContain("--all");
    const all = chatLog(["context", "--all", "--limit", "2"], { cwd: here }).out;
    expect(all.split("\n")[0]).toBe("# すべて の最近のセッション（2）");
  });

  test("--json prints sessions with their last messages", () => {
    const [first] = json(chatLog(["context", "--cwd", "/work/proj", "--json", "--messages", "1"]).out);
    expect(first.session_id).toBe(S2);
    expect(first.last_messages).toHaveLength(1);
  });
});

describe("chat-log errors and help", () => {
  test("a missing or old database exits 2", () => {
    const missing = chatLog(["sessions"], { env: { AI_CHAT_LOGS_DB: join(tempDir(), "none.sqlite") } });
    expect(missing.code).toBe(2);
    const oldPath = join(tempDir(), "old.sqlite");
    const old = openDatabase(oldPath);
    old.run("PRAGMA user_version = 2");
    old.close();
    expect(chatLog(["sessions"], { env: { AI_CHAT_LOGS_DB: oldPath } }).code).toBe(2);
  });

  test("usage errors exit 2", () => {
    expect(chatLog(["frobnicate"]).code).toBe(2);
    expect(chatLog(["sessions", "--since", "someday"]).code).toBe(2);
    expect(chatLog(["search"]).code).toBe(2);
  });

  test("--help covers the subcommands, output formats, exit codes and the suggested order", () => {
    const help = chatLog(["--help"]).out;
    ["context", "sessions", "search", "show", "--json", "--max-chars", "終了コード", "context → search → show --around"].forEach((s) =>
      expect(help).toContain(s),
    );
    expect(chatLog(["show", "--help"]).out).toContain("--around");
  });

  test("the default output of a session with huge messages stays bounded", () => {
    const out = chatLog(["show", BIG]).out;
    expect(out.length).toBeLessThan(50 * 2100 + 2000);
  });
});

describe("chat-log output corrections (docs/adr/0013)", () => {
  test("Markdown bold in a snippet stays distinguishable from the highlight", () => {
    const out = lines(chatLog(["search", "太字の語"]).out);
    expect(out[1]).toBe("\tこれは**⟪太字の語⟫**です");
    const [hit] = json(chatLog(["search", "太字の語", "--json"]).out);
    expect(hit.snippet).toBe("これは**⟪太字の語⟫**です");
  });

  test("hits only in thinking are marked, and show --around reveals the thinking of the center message", () => {
    const out = lines(chatLog(["search", "検討メモ"]).out);
    expect(out[0]).toContain("tttttttt#2");
    expect(out[1]).toBe("\t[thinking] 内緒の⟪検討メモ⟫");
    expect(json(chatLog(["search", "検討メモ", "--json"]).out)[0].matched_in).toEqual(["thinking"]);
    expect(json(chatLog(["search", "太字の語", "--json"]).out)[0].matched_in).toEqual(["text"]);
    const around = chatLog(["show", T, "--around", "2", "--limit", "3"]).out;
    expect(around).toContain("[thinking] 内緒の検討メモ");
    // docs/adr/0019: the thinking of the other messages of the range shows too
    const notCenter = chatLog(["show", T, "--around", "3", "--limit", "3"]).out;
    expect(notCenter).toContain("[thinking] 内緒の検討メモ");
  });

  test("messages with nothing to show are left out of the text, keeping the numbers", () => {
    const out = chatLog(["show", T]).out;
    expect(out).not.toContain("## #2 ");
    expect(lines(out).filter((l) => l.startsWith("## #")).map((l) => l.split(" ")[1])).toEqual(["#1", "#3", "#4"]);
    expect(json(chatLog(["show", T, "--json"]).out).map((m) => m.index)).toEqual([1, 2, 3, 4]);
    const limited = lines(chatLog(["show", T, "--limit", "2"]).out).filter((l) => l.startsWith("## #"));
    expect(limited.map((l) => l.split(" ")[1])).toEqual(["#1"]);
  });

  test("images in tool results are not dumped, even with --tools", () => {
    const out = chatLog(["show", T, "--tools"]).out;
    expect(out).toContain("[tool_result]\n[image]");
    expect(out).not.toContain("QQQQ");
    const [, , , last] = json(chatLog(["show", T, "--json"]).out);
    expect(JSON.stringify(last.blocks)).not.toContain("QQQQ");
  });

  test("the previous and next lines with --around", () => {
    const out = chatLog(["show", BIG, "--around", "50", "--limit", "4", "--max-chars", "5"]).out;
    // docs/adr/0023: the page right before the range
    expect(out.split("\n")[0]).toBe("（前：#44〜#47 は --offset 43 で出す）");
    expect(out.trimEnd().endsWith("（続き：#52 から。--offset 51 で出す）")).toBe(true);
  });

  test("the help explains --cwd ., --around and the continuation lines", () => {
    const help = chatLog(["--help"]).out;
    ["--cwd .", "--limit 1", "（続き：#", "（前：#", "[thinking]", "⟪"].forEach((s) => expect(help).toContain(s));
  });
});

describe("numbering in time order (docs/adr/0016)", () => {
  test("show numbers a subagent's records between the parent's by time", () => {
    const out = lines(chatLog(["show", SUB]).out).filter((l) => l.startsWith("## #"));
    expect(out).toEqual([
      "## #1 user 2026-06-01T00:00:00.000Z",
      "## #2 assistant 2026-06-01T00:01:00.000Z",
      "## #3 assistant 2026-06-01T00:02:00.000Z",
    ]);
    expect(lines(chatLog(["search", "子の時系列"]).out)[0]).toContain("ssssssss#2");
  });

  test("numbers several hits of one session together (docs/adr/0017)", () => {
    const heads = lines(chatLog(["search", "親の", "--cwd", "/work/sub"]).out).filter((l) => !l.startsWith("\t"));
    expect(heads.map((l) => l.split("\t")[2])).toEqual(["ssssssss#3", "ssssssss#1"]);
  });
});


// docs/adr/0018
describe("chat-log snippets, --until, --around and the help terms", () => {
  const partial = /⟪[^⟫]*⟫/g;
  test("every term of an AND search is marked, long or short, and never in part", () => {
    const long = lines(chatLog(["search", "apricot", "blueberry"]).out)[1] as string;
    expect(long).toContain("⟪apricot⟫");
    expect(long).toContain("⟪blueberry⟫");
    expect(long.match(partial)).toEqual(["⟪apricot⟫", "⟪blueberry⟫"]);
    const short = lines(chatLog(["search", "梨", "柿", "--cwd", "/work/snip"]).out)[1] as string;
    expect(short.match(partial)).toEqual(["⟪梨⟫", "⟪柿⟫"]);
  });

  test("--until keeps messages before the time", () => {
    const ids = (args: string[]) => lines(chatLog(["search", "全文検索", ...args]).out).filter((l) => !l.startsWith("\t")).map((l) => l.split("\t")[2]);
    expect(ids(["--until", "2026-10-06T00:00:00Z"])).toEqual(["aaaaaaaa#1"]);
    expect(ids(["--since", "2026-10-02", "--until", "2026-10-07"])).toEqual(["cccccccc#1"]);
    expect(chatLog(["search", "全文検索", "--until", "someday"]).code).toBe(2);
  });

  test("show --around defaults to 10 messages, 5 before", () => {
    const heads = (args: string[]) => lines(chatLog(["show", BIG, "--max-chars", "5", ...args]).out).filter((l) => l.startsWith("## #")).map((l) => l.split(" ")[1]);
    expect(heads(["--around", "50"])).toEqual(["#45", "#46", "#47", "#48", "#49", "#50", "#51", "#52", "#53", "#54"]);
    expect(heads(["--around", "50", "--limit", "3"])).toEqual(["#49", "#50", "#51"]);
    expect(heads([])).toHaveLength(50);
  });

  test("the help defines 写し and the message number, and explains --until and the time formats", () => {
    const help = chatLog(["--help"]).out;
    ["用語:", "写し:", "メッセージの番号:", "--until <時刻>", "UTC の 0 時", "手元の時刻帯"].forEach((s) => expect(help).toContain(s));
    expect(chatLog(["show", "--help"]).out).toContain("--around を付けて --limit が無いときは 10");
  });
});

// docs/adr/0019
describe("chat-log thinking around a hit", () => {
  const heads = (out: string) => lines(out).filter((l) => l.startsWith("## #")).map((l) => l.split(" ")[1]);
  const emptyThinking = (out: string) => lines(out).filter((l) => l.trim() === "[thinking]");

  test("show --around shows the thinking of every message in the range", () => {
    const out = chatLog(["show", EMPTY, "--around", "1"]).out;
    expect(out).toContain("[thinking] 前後の考え");
    expect(heads(out)).toEqual(["#1", "#3", "#4", "#5"]);
    expect(emptyThinking(out)).toEqual([]);
  });

  test("without --around, thinking shows only with --thinking, and empty thinking never", () => {
    const plain = chatLog(["show", EMPTY]).out;
    expect(plain).not.toContain("前後の考え");
    expect(heads(plain)).toEqual(["#1", "#3", "#5"]);
    const thinking = chatLog(["show", EMPTY, "--thinking"]).out;
    expect(heads(thinking)).toEqual(["#1", "#3", "#4", "#5"]);
    expect(emptyThinking(thinking)).toEqual([]);
  });

  test("--json keeps empty thinking blocks", () => {
    const second = json(chatLog(["show", EMPTY, "--json"]).out)[1];
    expect(second.blocks).toEqual([{ kind: "thinking", text: "" }]);
  });

  test("the help explains the thinking of --around and the empty thinking", () => {
    const help = chatLog(["show", "--help"]).out;
    ["その範囲のメッセージの思考も", "本文が空の思考"].forEach((s) => expect(help).toContain(s));
  });
});

// docs/adr/0020
describe("chat-log marks omitted messages", () => {
  test("show prints a line with the numbers and the reason where it leaves messages out", () => {
    const out = chatLog(["show", EMPTY]).out;
    expect(out).toContain("（#2 は省いた：表示する本文が無い）");
    expect(out).toContain("（#4 は省いた：思考だけ。--thinking で出す）");
    const thinking = chatLog(["show", EMPTY, "--thinking"]).out;
    expect(thinking).toContain("（#2 は省いた：表示する本文が無い）");
    expect(thinking).not.toContain("#4 は省いた");
    expect(chatLog(["show", EMPTY, "--around", "3"]).out).not.toContain("#4 は省いた");
  });

  test("--json is unchanged and the help explains the line", () => {
    expect(json(chatLog(["show", EMPTY, "--json"]).out)).toHaveLength(5);
    expect(chatLog(["show", "--help"]).out).toContain("（#<番号> は省いた：<理由>）");
  });
});

// docs/adr/0023
describe("chat-log --around navigation lines", () => {
  const heads = (out: string) => lines(out).filter((l) => l.startsWith("## #")).map((l) => l.split(" ")[1]);

  test("the previous line points to the page right before the range, and works as given", () => {
    const out = chatLog(["show", BIG, "--around", "50", "--max-chars", "5"]).out;
    expect(out.split("\n")[0]).toBe("（前：#35〜#44 は --offset 34 で出す）");
    expect(heads(chatLog(["show", BIG, "--offset", "34", "--limit", "10", "--max-chars", "5"]).out)).toEqual(
      ["#35", "#36", "#37", "#38", "#39", "#40", "#41", "#42", "#43", "#44"],
    );
    expect(chatLog(["show", BIG, "--around", "8", "--max-chars", "5"]).out.split("\n")[0]).toBe("（前：#1〜#2 は --offset 0 で出す）");
  });

  test("--around with --limit 1 prints no navigation lines; show without --around keeps its next line", () => {
    const one = chatLog(["show", BIG, "--around", "50", "--limit", "1", "--max-chars", "5"]).out;
    expect(one).not.toContain("（前：");
    expect(one).not.toContain("（続き：");
    expect(chatLog(["show", BIG, "--limit", "2", "--max-chars", "5"]).out.trimEnd().endsWith("（続き：#3 から。--offset 2 で出す）")).toBe(true);
  });

  test("the help explains the previous line and --limit 1", () => {
    const help = chatLog(["show", "--help"]).out;
    ["直前の同じ件数の範囲", "--limit 1 のときは、前と続きの行を出さない"].forEach((s) => expect(help).toContain(s));
  });
});
