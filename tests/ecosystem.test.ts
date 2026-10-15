import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { isolatedEnv, repoRoot, tempDir, writeFile } from "./helpers.ts";

const load = (env: Record<string, string | undefined>) => {
  const script = `console.log(JSON.stringify(require(${JSON.stringify(join(repoRoot, "ecosystem.config.cjs"))})))`;
  const result = Bun.spawnSync(["node", "-e", script], { env: isolatedEnv(env) });
  return { ...JSON.parse(result.stdout.toString() || "{}"), exitCode: result.exitCode, stderr: result.stderr.toString() };
};

describe("ecosystem.config.cjs", () => {
  test("defines one hourly app running bin/sync without autorestart", () => {
    const { apps } = load({});
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "ai-chat-logs-sync", script: "bin/sync", autorestart: false, cron_restart: "0 * * * *", cwd: repoRoot });
    expect(apps[0].env.PATH).toBe(process.env.PATH);
  });

  test("takes the schedule from AI_CHAT_LOGS_CRON", () => {
    const { apps } = load({ AI_CHAT_LOGS_CRON: "*/5 * * * *" });
    expect(apps[0].cron_restart).toBe("*/5 * * * *");
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
});
