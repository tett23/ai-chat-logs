import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isolatedEnv, jsonl, repoRoot, tempDir, writeFile } from "./helpers.ts";

const setup = (installed: boolean) => {
  const dir = tempDir(), log = join(dir, "calls"), mock = join(dir, "mock");
  mkdirSync(mock);
  if (installed) {
    copyFileSync(join(repoRoot, "bin/ai-chat-logs-codex-sync"), join(dir, "ai-chat-logs-codex-sync"));
    for (const name of ["codex-log-convert", "codex-log-sources", "chat-log-import"])
      writeFile(join(dir, name), `#!/bin/sh\nexec "${mock}/command" ${name} "$@"\n`);
  } else writeFile(join(mock, "bun"), `#!/bin/sh\ncommand_name=$(basename "$2" .ts)\n[ "$command_name" = import ] && command_name=chat-log-import\nshift 2\nexec "${mock}/command" "$command_name" "$@"\n`);
  writeFile(join(mock, "command"), `#!/bin/sh
printf '%s %s\\n' "$1" "$*" >> "$CALL_LOG"
case "$1" in
  codex-log-convert) exit "${"$"}CONVERT_EXIT" ;;
  codex-log-sources) printf 'codex/rollout\\t/source\\n'; exit "${"$"}SOURCES_EXIT" ;;
  chat-log-import) cat > "$IMPORT_INPUT"; exit "${"$"}IMPORT_EXIT" ;;
esac
exit 99
`);
  for (const name of installed ? ["ai-chat-logs-codex-sync", "codex-log-convert", "codex-log-sources", "chat-log-import"] : ["bun"])
    chmodSync(join(installed ? dir : mock, name), 0o755);
  chmodSync(join(mock, "command"), 0o755);
  const env = isolatedEnv({ PATH: `${mock}:/usr/bin:/bin`, CALL_LOG: log, IMPORT_INPUT: join(dir, "input"), CONVERT_EXIT: "0", SOURCES_EXIT: "0", IMPORT_EXIT: "0" });
  const command = installed ? join(dir, "ai-chat-logs-codex-sync") : join(repoRoot, "bin/sync-codex");
  return { command, env, log, input: join(dir, "input") };
};

describe("ADR 0036 dedicated Codex sync", () => {
  for (const installed of [false, true]) {
    const form = installed ? "installed" : "repository";
    test(`H1 H2 ${form} uses Codex commands only and never marks missing`, async () => {
      const f = setup(installed);
      const r = Bun.spawnSync(["/bin/sh", f.command], { env: f.env });
      expect(r.exitCode).toBe(0);
      expect(await Bun.file(f.log).text()).toBe("codex-log-convert codex-log-convert\ncodex-log-sources codex-log-sources\nchat-log-import chat-log-import\n");
      expect(await Bun.file(f.input).text()).toBe("codex/rollout\t/source\n");
    });

    test(`H2 H3 ${form} rejects arguments before side effects`, async () => {
      for (const arg of ["unknown", "--mark-missing"]) {
        const f = setup(installed);
        expect(Bun.spawnSync(["/bin/sh", f.command, arg], { env: f.env }).exitCode).toBe(2);
        expect(await Bun.file(f.log).exists()).toBe(false);
      }
    });

    test(`H3 ${form} imports after conversion failure but never after listing failure`, async () => {
      const f = setup(installed);
      expect(Bun.spawnSync(["/bin/sh", f.command], { env: { ...f.env, CONVERT_EXIT: "1" } }).exitCode).toBe(1);
      expect(await Bun.file(f.input).exists()).toBe(true);
      const g = setup(installed);
      expect(Bun.spawnSync(["/bin/sh", g.command], { env: { ...g.env, SOURCES_EXIT: "1" } }).exitCode).toBe(1);
      expect(await Bun.file(g.input).exists()).toBe(false);
      expect((await Bun.file(g.log).text()).split("\n").filter(Boolean)).toHaveLength(2);
      const h = setup(installed);
      expect(Bun.spawnSync(["/bin/sh", h.command], { env: { ...h.env, IMPORT_EXIT: "2" } }).exitCode).toBe(1);
    });
  }

  test("H2 H5 real DB keeps Claude missing state and deduplicates repeated Codex sync", () => {
    const home = tempDir(), dbPath = join(home, "out.sqlite");
    writeFile(join(home, ".claude/history.jsonl"), jsonl({ display: "Claude" }));
    writeFile(join(home, ".codex/sessions/one.jsonl"), jsonl(
      { type: "session_meta", payload: { id: "codex-one", cwd: "/repo" } },
      { type: "response_item", timestamp: "2026-11-11T00:00:00Z", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "Codex" }] } },
    ));
    const env = isolatedEnv({ HOME: home, AI_CHAT_LOGS_DB: dbPath });
    expect(Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync")], { env }).exitCode).toBe(0);
    const db = new Database(dbPath);
    db.run("UPDATE sources SET missing_since='2026-01-01' WHERE kind LIKE 'claude-%'");
    db.run("UPDATE sources SET missing_since='2026-01-01' WHERE kind LIKE 'codex/%'");
    const before = db.query("SELECT count(*) c FROM session_messages WHERE provider = 'codex'").get();
    for (let i = 0; i < 2; i++) expect(Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync-codex")], { env }).exitCode).toBe(0);
    expect(db.query("SELECT count(*) c FROM session_messages WHERE provider = 'codex'").get()).toEqual(before);
    expect(db.query("SELECT DISTINCT missing_since m FROM sources WHERE kind LIKE 'claude-%'").all()).toEqual([{ m: "2026-01-01" }]);
    expect(db.query("SELECT DISTINCT missing_since m FROM sources WHERE kind LIKE 'codex/%'").all()).toEqual([{ m: null }]);
    db.close();
  });

  test("H5 concurrent full and dedicated runs do not duplicate Codex messages", async () => {
    const home = tempDir(), dbPath = join(home, "out.sqlite");
    writeFile(join(home, ".codex/sessions/one.jsonl"), jsonl(
      { type: "session_meta", payload: { id: "codex-one", cwd: "/repo" } },
      { type: "response_item", timestamp: "2026-11-11T00:00:00Z", payload: { type: "message", id: "m1", role: "user", content: [{ type: "input_text", text: "Codex" }] } },
    ));
    const env = isolatedEnv({ HOME: home, AI_CHAT_LOGS_DB: dbPath });
    expect(Bun.spawnSync(["/bin/sh", join(repoRoot, "bin/sync-codex")], { env }).exitCode).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    const before = db.query("SELECT count(*) c FROM session_messages WHERE provider = 'codex'").get();
    db.close();
    const full = Bun.spawn(["/bin/sh", join(repoRoot, "bin/sync")], { env, stdout: "pipe", stderr: "pipe" });
    const codex = Bun.spawn(["/bin/sh", join(repoRoot, "bin/sync-codex")], { env, stdout: "pipe", stderr: "pipe" });
    const codes = await Promise.all([full.exited, codex.exited]);
    expect(codes.every((code) => code === 0)).toBe(true);
    const after = new Database(dbPath, { readonly: true });
    expect(after.query("SELECT count(*) c FROM session_messages WHERE provider = 'codex'").get()).toEqual(before);
    after.close();
  });
});
