import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { convertCodexLines } from "../src/codex.ts";
import { convertCodexLogs, listCodexSources } from "../src/codex-store.ts";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

const meta = (id = "owner", cwd: string | null = "/repo") => ({ type: "session_meta", payload: { id, session_id: "parent", cwd } });
const response = (id: string, text: string, role = "assistant") => ({
  type: "response_item", timestamp: "2026-11-11T00:00:01Z",
  payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
});
const lines = (value: string) => value.trimEnd().split("\n").map((x) => JSON.parse(x) as Record<string, unknown>);

describe("Codex conversion", () => {
  test("P1 P4 uses the first metadata id, not the parent's session_id or a later metadata record", () => {
    const result = convertCodexLines([meta(), response("m1", "hello", "user"), meta("parent"), response("m2", "answer")].map(JSON.stringify));
    expect(result.status).toBe(0);
    expect(result.sessionId).toBe("owner");
    const messages = lines(result.messages).filter((r) => r.type !== "custom-title");
    expect(messages.map((r) => r.sessionId)).toEqual(["owner", "owner"]);
    expect(messages.map((r) => r.sourceOrder)).toEqual([2, 4]);
    expect(messages[0]?.cwd).toBe("/repo");
  });

  test("P2 P3 distinguishes revisions while deduplicating the same item across snapshots", () => {
    const base = [meta(), response("m1", "same", "user")].map(JSON.stringify);
    const first = lines(convertCodexLines(base).messages)[1];
    const repeated = lines(convertCodexLines([...base, response("m2", "same", "user")].map((x) => typeof x === "string" ? x : JSON.stringify(x))).messages);
    expect(repeated[1]?.uuid).toBe(first?.uuid);
    expect(repeated[2]?.uuid).not.toBe(first?.uuid);
    const revised = lines(convertCodexLines([meta(), response("m1", "changed", "user")].map(JSON.stringify)).messages)[1];
    expect(revised?.uuid).not.toBe(first?.uuid);
    expect((revised?.openai as Record<string, unknown>).version).toBe((revised?.uuid as string).slice(0, 12));
  });

  test("P5 converts only response_item, keeping public thinking, tool input and encrypted markers", () => {
    const rows = [meta(), response("m1", "answer"),
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "answer" } },
      { type: "response_item", payload: { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "visible" }], encrypted_content: "secret" } },
      { type: "response_item", payload: { type: "function_call", id: "t", call_id: "c", name: "shell", arguments: "{invalid" } },
      { type: "response_item", payload: { type: "function_call_output", id: "o", call_id: "c", output: "done" } },
      { type: "response_item", payload: { type: "agent_message", id: "a", author: "agent", recipient: "parent", content: [{ type: "encrypted_content", encrypted_content: "secret" }] } },
      { type: "response_item", payload: { type: "message", id: "dev", role: "developer", content: [{ type: "input_text", text: "hidden" }] } },
    ];
    const result = convertCodexLines(rows.map(JSON.stringify));
    const projected = lines(result.messages).filter((r) => r.type !== "custom-title");
    expect(projected).toHaveLength(5);
    expect(JSON.stringify(projected)).toContain("visible");
    expect((projected.find((row) => (row.openai as Record<string, unknown>)?.itemId === "r")?.message as Record<string, unknown>).content).toHaveLength(2);
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("hidden");
    expect(JSON.stringify(projected)).toContain("{invalid");
    expect(JSON.stringify(projected)).toContain("表示できない");
  });

  test("P7 keeps valid rows if one complete JSON row is broken", () => {
    const result = convertCodexLines([JSON.stringify(meta()), "{broken", JSON.stringify(response("ok", "kept"))]);
    expect(result.status).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.messages).toContain("kept");
  });
});

describe("Codex snapshot storage", () => {
  test("P1 P2 P6 publishes a complete private snapshot and reuses identical bytes", () => {
    const root = tempDir(), store = join(root, "store"), source = writeFile(join(root, "codex/sessions/2026/11/11/one.jsonl"), jsonl(meta(), response("m1", "hi")));
    const first = convertCodexLogs(join(root, "codex"), store);
    expect(first.status).toBe(0);
    expect(first.published).toBe(1);
    const directory = first.directories[0] as string;
    expect(readdirSync(directory).sort()).toEqual(["manifest-v1.json", "messages-v1.jsonl", "rollout.jsonl"]);
    expect(readFileSync(join(directory, "rollout.jsonl"), "utf8")).toBe(readFileSync(source, "utf8"));
    expect(directory.endsWith(createHash("sha256").update(readFileSync(source)).digest("hex"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest-v1.json"), "utf8"));
    expect(manifest).toMatchObject({ converterVersion: 1, sessions: 1, messageLines: 1, warnings: 0, status: 0 });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "rollout.jsonl")).mode & 0o777).toBe(0o600);
    expect(convertCodexLogs(join(root, "codex"), store).published).toBe(0);
    expect(listCodexSources(store).map((s) => s.kind)).toEqual(["codex/conversation", "codex/rollout"]);
  });

  test("P1 P6 handles missing source roots, empty files, incomplete tails and symlinks", () => {
    const root = tempDir(), store = join(root, "store"), codex = join(root, "codex");
    expect(convertCodexLogs(codex, store).published).toBe(0);
    writeFile(join(codex, "sessions/empty.jsonl"), "");
    writeFile(join(codex, "sessions/partial.jsonl"), `${JSON.stringify(meta())}\n{incomplete`);
    symlinkSync(join(codex, "sessions/partial.jsonl"), join(codex, "sessions/link.jsonl"));
    const result = convertCodexLogs(codex, store);
    expect(result.status).toBe(0);
    expect(result.published).toBe(2);
    expect(listCodexSources(store)).toHaveLength(4);
    expect(readFileSync(join(result.directories.find((d) => readFileSync(join(d, "rollout.jsonl"), "utf8").length > 0) as string, "rollout.jsonl"), "utf8"))
      .toBe(`${JSON.stringify(meta())}\n`);
  });

  test("P1 P2 creates a new prefix snapshot when a source grows", () => {
    const root = tempDir(), store = join(root, "store"), codex = join(root, "codex");
    const source = writeFile(join(codex, "sessions/one.jsonl"), `${JSON.stringify(meta())}\n${JSON.stringify(response("m1", "first"))}\n{partial`);
    const first = convertCodexLogs(codex, store);
    expect(first.published).toBe(1);
    appendFileSync(source, `-fixed}\n${JSON.stringify(response("m2", "second"))}\n`);
    const second = convertCodexLogs(codex, store);
    expect(second.published).toBe(1);
    expect(second.directories[0]).not.toBe(first.directories[0]);
    expect(readFileSync(join(first.directories[0] as string, "rollout.jsonl"), "utf8")).not.toContain("partial");
    expect(readFileSync(join(second.directories[0] as string, "rollout.jsonl"), "utf8")).toContain("second");
    expect(convertCodexLogs(codex, store).published).toBe(0);
  });

  test("P7 reports a bad source while publishing the good source", () => {
    const root = tempDir(), store = join(root, "store"), codex = join(root, "codex");
    writeFile(join(codex, "sessions/good.jsonl"), jsonl(meta("good"), response("m1", "ok")));
    writeFile(join(codex, "sessions/bad.jsonl"), jsonl(response("m2", "orphan")));
    const result = convertCodexLogs(codex, store);
    expect(result.status).toBe(1);
    expect(result.published).toBe(2);
    expect(listCodexSources(store)).toHaveLength(4);
    expect(listCodexSources(store).some((s) => readFileSync(s.path, "utf8").includes("ok"))).toBe(true);
  });

  test("P6 ignores incomplete staging directories and refuses unreadable source roots", () => {
    const root = tempDir(), store = join(root, "store");
    writeFile(join(store, ".partial-test/rollout.jsonl"), "x");
    expect(listCodexSources(store)).toEqual([]);
    writeFile(join(root, "codex/sessions"), "not a directory");
    expect(convertCodexLogs(join(root, "codex"), store).status).toBe(1);
  });
});

test("P7 codex-log-sources prints kinds and codex-log-convert reports partial failure", () => {
  const home = tempDir(), codex = join(home, "codex"), store = join(home, "store");
  writeFile(join(codex, "sessions/a.jsonl"), jsonl(meta(), response("m1", "ok")));
  writeFile(join(codex, "sessions/b.jsonl"), jsonl(response("m2", "orphan")));
  const env = isolatedEnv({ HOME: home, AI_CHAT_LOGS_CODEX_DIR: codex, AI_CHAT_LOGS_CODEX_STORE: store });
  const converted = Bun.spawnSync([join(repoRoot, "src/cli/codex-log-convert.ts")], { env });
  expect(converted.exitCode).toBe(1);
  const listed = Bun.spawnSync([join(repoRoot, "src/cli/codex-log-sources.ts")], { env });
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout.toString().split("\n").filter(Boolean)).toHaveLength(4);
});
