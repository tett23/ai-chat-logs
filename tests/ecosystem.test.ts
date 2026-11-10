import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isolatedEnv, repoRoot, tempDir, writeFile } from "./helpers.ts";

const load = (env: Record<string, string | undefined>) => {
  const script = `console.log(JSON.stringify(require(${JSON.stringify(join(repoRoot, "ecosystem.config.cjs"))})))`;
  const result = Bun.spawnSync(["node", "-e", script], { env: isolatedEnv(env) });
  return { ...JSON.parse(result.stdout.toString() || "{}"), exitCode: result.exitCode, stderr: result.stderr.toString() };
};

describe("ecosystem.config.cjs", () => {
  test("H4 defines independent full and Codex schedules", () => {
    const { apps } = load({});
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ name: "ai-chat-logs-sync", script: "bin/sync", autorestart: false, cron_restart: "0 */4 * * *", cwd: repoRoot });
    expect(apps[1]).toMatchObject({ name: "ai-chat-logs-codex-sync", script: "bin/sync-codex", interpreter: "/bin/sh", autorestart: false, cron_restart: "30 * * * *", cwd: repoRoot });
    expect(apps[0].env.PATH).toBe(process.env.PATH);
  });

  test("takes the schedule from AI_CHAT_LOGS_CRON", () => {
    const { apps } = load({ AI_CHAT_LOGS_CRON: "*/5 * * * *" });
    expect(apps[0].cron_restart).toBe("*/5 * * * *");
    expect(apps[1].cron_restart).toBe("30 * * * *");
  });

  test("H4 takes only the Codex schedule from AI_CHAT_LOGS_CODEX_CRON", () => {
    const { apps } = load({ AI_CHAT_LOGS_CODEX_CRON: "15 * * * *" });
    expect(apps[0].cron_restart).toBe("0 */4 * * *");
    expect(apps[1].cron_restart).toBe("15 * * * *");
  });

  test("H4 Codex schedule follows environment, .env, config precedence", () => {
    const dir = tempDir();
    const config = writeFile(join(dir, "config.env"), 'AI_CHAT_LOGS_CODEX_CRON="10 * * * *"\n');
    const envFile = writeFile(join(dir, "my.env"), 'AI_CHAT_LOGS_CODEX_CRON="20 * * * *"\n');
    expect(load({ AI_CHAT_LOGS_CONFIG: config }).apps[1].cron_restart).toBe("10 * * * *");
    expect(load({ AI_CHAT_LOGS_CONFIG: config, AI_CHAT_LOGS_ENV_FILE: envFile }).apps[1].cron_restart).toBe("20 * * * *");
    expect(load({ AI_CHAT_LOGS_CONFIG: config, AI_CHAT_LOGS_ENV_FILE: envFile, AI_CHAT_LOGS_CODEX_CRON: "40 * * * *" }).apps[1].cron_restart).toBe("40 * * * *");
  });

  test("takes the schedule from the env file", () => {
    const envFile = writeFile(join(tempDir(), "my.env"), 'AI_CHAT_LOGS_CRON="*/10 * * * *"\n');
    expect(load({ AI_CHAT_LOGS_ENV_FILE: envFile }).apps[0].cron_restart).toBe("*/10 * * * *");
  });

  test("prefers AI_CHAT_LOGS_CRON from the environment", () => {
    const envFile = writeFile(join(tempDir(), "my.env"), "AI_CHAT_LOGS_CRON=*/10 * * * *\n");
    expect(load({ AI_CHAT_LOGS_ENV_FILE: envFile, AI_CHAT_LOGS_CRON: "*/5 * * * *" }).apps[0].cron_restart).toBe("*/5 * * * *");
  });

  test("fails on a malformed env file", () => {
    const envFile = writeFile(join(tempDir(), "bad.env"), "nope\n");
    const result = load({ AI_CHAT_LOGS_ENV_FILE: envFile });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`${envFile}: line 1`);
  });

  test("takes the schedule from the config file below the .env file", () => {
    const dir = tempDir();
    const config = writeFile(join(dir, "config.env"), 'AI_CHAT_LOGS_CRON="*/15 * * * *"\n');
    expect(load({ AI_CHAT_LOGS_CONFIG: config }).apps[0].cron_restart).toBe("*/15 * * * *");
    const envFile = writeFile(join(dir, "my.env"), 'AI_CHAT_LOGS_CRON="*/20 * * * *"\n');
    expect(load({ AI_CHAT_LOGS_CONFIG: config, AI_CHAT_LOGS_ENV_FILE: envFile }).apps[0].cron_restart).toBe("*/20 * * * *");
  });
});

