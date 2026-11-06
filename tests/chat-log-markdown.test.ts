import { describe, expect, test } from "bun:test";
import { toBlocks } from "../src/chat-log/blocks.ts";
import { fence, sessionMarkdown } from "../src/chat-log/markdown.ts";
import type { Message, Session } from "../src/chat-log/store.ts";

// docs/adr/0026
const session: Session = {
  provider: "claude-code",
  session_id: "aaaaaaaa-1111",
  title: "設計の議論",
  cwd: "/work/proj",
  first_at: "2026-10-01T00:00:00.000Z",
  last_at: "2026-10-01T00:03:00.000Z",
  message_count: 3,
};
const msg = (index: number, role: string, content: unknown, extra: Partial<Message> = {}): Message => ({
  index,
  uuid: `u${index}`,
  timestamp: `2026-10-01T00:0${index}:00.000Z`,
  role,
  model: null,
  is_sidechain: false,
  blocks: toBlocks(content),
  ...extra,
});

describe("fence", () => {
  test("three backticks, or one more than the longest run in the text", () => {
    expect(fence("plain")).toBe("```");
    expect(fence("a ``` b")).toBe("````");
    expect(fence("`````")).toBe("``````");
  });
});

describe("sessionMarkdown", () => {
  test("the header and every kind of block", () => {
    const b64 = "A".repeat(250);
    const md = sessionMarkdown(session, [
      msg(1, "user", "全文検索の設計を決めたい"),
      msg(2, "assistant", [
        { type: "thinking", thinking: "一行目\n二行目" },
        { type: "text", text: "写しを除くことにした" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ], { model: "claude-opus-5-5" }),
      msg(3, "user", [
        { type: "tool_result", content: [{ type: "text", text: "結果" }, { type: "image", source: { data: b64 } }] },
        { type: "tool_result", is_error: true, content: `失敗 ${b64}` },
        { type: "injected_prompt_block" },
      ], { is_sidechain: true }),
    ]);
    expect(md).toBe(
      [
        "# 設計の議論",
        "",
        "- セッション: aaaaaaaa-1111",
        "- 提供元: claude-code",
        "- cwd: /work/proj",
        "- 期間: 2026-10-01T00:00:00.000Z 〜 2026-10-01T00:03:00.000Z",
        "- メッセージ: 3 件",
        "",
        "## #1 user 2026-10-01T00:01:00.000Z",
        "",
        "全文検索の設計を決めたい",
        "",
        "## #2 assistant 2026-10-01T00:02:00.000Z claude-opus-5-5",
        "",
        "<details><summary>thinking</summary>",
        "",
        "> 一行目",
        "> 二行目",
        "",
        "</details>",
        "",
        "写しを除くことにした",
        "",
        "<details><summary>tool_use: Bash</summary>",
        "",
        "```json",
        "{",
        '  "command": "ls"',
        "}",
        "```",
        "",
        "</details>",
        "",
        "## #3 user 2026-10-01T00:03:00.000Z (サブエージェント)",
        "",
        "<details><summary>tool_result</summary>",
        "",
        "```",
        "結果",
        "[image]",
        "```",
        "",
        "</details>",
        "",
        "<details><summary>tool_result（エラー）</summary>",
        "",
        "```",
        "失敗 [base64 250 文字]",
        "```",
        "",
        "</details>",
        "",
        "[injected_prompt_block]",
        "",
      ].join("\n"),
    );
  });

  test("without a title or cwd, the session ID heads the file and the cwd line is left out", () => {
    const md = sessionMarkdown({ ...session, title: null, cwd: null }, []);
    expect(md.split("\n").slice(0, 4)).toEqual(["# aaaaaaaa-1111", "", "- セッション: aaaaaaaa-1111", "- 提供元: claude-code"]);
    expect(md).not.toContain("- cwd:");
  });

  test("a code block holding ``` is fenced with four backticks", () => {
    const md = sessionMarkdown(session, [msg(1, "user", [{ type: "tool_result", content: "```ts\nx\n```" }])]);
    expect(md).toContain("````\n```ts\nx\n```\n````");
  });

  test("empty thinking is left out, and so is a message with nothing to write", () => {
    const md = sessionMarkdown(session, [
      msg(1, "assistant", [{ type: "thinking", thinking: "  " }]),
      msg(2, "assistant", [{ type: "thinking", thinking: "" }, { type: "text", text: "本文" }]),
    ]);
    expect(md).not.toContain("## #1 ");
    expect(md).not.toContain("<summary>thinking</summary>");
    expect(md).toContain("## #2 assistant");
  });
});
