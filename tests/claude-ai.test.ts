import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { convertConversations, exportId } from "../src/claude-ai.ts";
import { isolatedEnv, repoRoot, tempDir, writeFile } from "./helpers.ts";

const conversation = (overrides: Record<string, unknown> = {}) => ({
  uuid: "c1",
  name: "会話の名前",
  created_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
  chat_messages: [
    {
      uuid: "m1",
      sender: "human",
      text: "質問の本文",
      content: [{ type: "text", text: "質問の本文" }],
      created_at: "2026-01-02T00:00:01Z",
      attachments: [{ file_name: "a.txt", extracted_content: "添付" }],
      files: [],
    },
    {
      uuid: "m2",
      parent_message_uuid: "m1",
      sender: "assistant",
      text: "答えの本文",
      content: [],
      created_at: "2026-01-02T00:00:02Z",
    },
  ],
  ...overrides,
});

const parseLines = (lines: string[]) => lines.map((l) => JSON.parse(l));

describe("convertConversations", () => {
  test("writes a title line and one line per message in the transcript shape", () => {
    const [title, user, assistant] = parseLines(convertConversations([conversation()]));
    expect(title).toEqual({ type: "custom-title", customTitle: "会話の名前", sessionId: "c1" });
    expect(user).toEqual({
      type: "user",
      uuid: "m1",
      parentUuid: null,
      sessionId: "c1",
      timestamp: "2026-01-02T00:00:01Z",
      message: { role: "user", content: [{ type: "text", text: "質問の本文" }] },
      claudeAi: {
        conversation: { uuid: "c1", name: "会話の名前", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
        sender: "human",
        attachments: [{ file_name: "a.txt", extracted_content: "添付" }],
        files: [],
      },
    });
    expect(assistant).toMatchObject({
      type: "assistant",
      uuid: "m2",
      parentUuid: "m1",
      message: { role: "assistant", content: [{ type: "text", text: "答えの本文" }] },
      claudeAi: { sender: "assistant", attachments: [], files: [] },
    });
  });

  test("orders conversations by created_at then uuid and skips titles of unnamed ones", () => {
    const lines = parseLines(
      convertConversations([
        conversation({ uuid: "late", name: "", created_at: "2026-02-01T00:00:00Z", chat_messages: [] }),
        conversation({ uuid: "b", name: "B", created_at: "2026-01-01T00:00:00Z", chat_messages: [] }),
        conversation({ uuid: "a", name: "A", created_at: "2026-01-01T00:00:00Z", chat_messages: [] }),
      ]),
    );
    expect(lines).toEqual([
      { type: "custom-title", customTitle: "A", sessionId: "a" },
      { type: "custom-title", customTitle: "B", sessionId: "b" },
    ]);
  });

  test("tolerates missing fields and unknown values", () => {
    const lines = parseLines(
      convertConversations([
        { uuid: "c", chat_messages: [{ uuid: "m", sender: "system", content: [{ type: "mystery", x: 1 }] }, { sender: "human" }] },
        { uuid: "d" },
      ]),
    );
    expect(lines[0]).toMatchObject({
      type: "system",
      uuid: "m",
      sessionId: "c",
      timestamp: null,
      message: { role: "system", content: [{ type: "mystery", x: 1 }] },
    });
    expect(lines[1]).toMatchObject({ type: "user", uuid: null, message: { role: "user", content: [{ type: "text", text: "" }] } });
    expect(lines).toHaveLength(2);
  });

  test("rejects input that is not an array", () => {
    expect(() => convertConversations({})).toThrow();
  });

  test("exportId is the first 16 hex characters of the SHA-256", () => {
    expect(exportId("[]")).toBe("4f53cda18c2baa0c");
  });
});

const exportFiles = (dir: string, convs: unknown[] = [conversation()]) => {
  writeFile(join(dir, "conversations.json"), JSON.stringify(convs));
  writeFile(join(dir, "projects.json"), "[]");
  return dir;
};

const runConvert = (input: string, aiDir: string) =>
  Bun.spawnSync([join(repoRoot, "src/cli/claude-ai-export-convert.ts"), input], {
    env: isolatedEnv({ HOME: tempDir(), AI_CHAT_LOGS_CLAUDE_AI_DIR: aiDir }),
  });

const snapshot = (dir: string) =>
  Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));

describe("claude-ai-export-convert CLI", () => {
  test("produces the same directory from a zip, a directory and conversations.json, idempotently", () => {
    const src = exportFiles(join(tempDir(), "export"));
    const zip = join(tempDir(), "export.zip");
    expect(Bun.spawnSync(["zip", "-q", "-r", zip, "."], { cwd: src }).exitCode).toBe(0);

    const results = [zip, src, join(src, "conversations.json")].map((input) => {
      const aiDir = tempDir();
      const r = runConvert(input, aiDir);
      expect(r.exitCode).toBe(0);
      const out = r.stdout.toString().trim();
      return { out: out.slice(aiDir.length), files: snapshot(out) };
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(Object.keys(results[0].files).sort()).toEqual(["conversations.json", "messages.jsonl", "projects.json"]);
    expect(results[0].files["messages.jsonl"].trim().split("\n")).toHaveLength(3);

    const aiDir = tempDir();
    const first = runConvert(zip, aiDir).stdout.toString().trim();
    const mtime = statSync(join(first, "messages.jsonl")).mtimeMs;
    expect(runConvert(zip, aiDir).stdout.toString().trim()).toBe(first);
    expect(statSync(join(first, "messages.jsonl")).mtimeMs).toBe(mtime);
  });

  test("finds conversations.json one level down in a zip", () => {
    const root = tempDir();
    exportFiles(join(root, "data-2026"));
    const zip = join(tempDir(), "nested.zip");
    Bun.spawnSync(["zip", "-q", "-r", zip, "."], { cwd: root });
    const aiDir = tempDir();
    const r = runConvert(zip, aiDir);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(r.stdout.toString().trim(), "messages.jsonl"))).toBe(true);
  });

  test.each([
    ["missing", (dir: string) => dir],
    ["not JSON", (dir: string) => writeFile(join(dir, "conversations.json"), "{oops")],
    ["not an array", (dir: string) => writeFile(join(dir, "conversations.json"), "{}")],
  ])("exits 1 and writes nothing when conversations.json is %s", (_, make) => {
    const dir = tempDir();
    const input = make(dir);
    const aiDir = join(tempDir(), "ai");
    const r = runConvert(input, aiDir);
    expect(r.exitCode).toBe(1);
    expect(existsSync(aiDir) ? readdirSync(aiDir) : []).toEqual([]);
  });
});
