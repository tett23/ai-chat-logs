import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot } from "./helpers.ts";

const load = (env: Record<string, string | undefined>) => {
  const script = `console.log(JSON.stringify(require(${JSON.stringify(join(repoRoot, "ecosystem.config.cjs"))})))`;
  const result = Bun.spawnSync(["bun", "-e", script], { env: { PATH: process.env.PATH ?? "", ...env } });
  return JSON.parse(result.stdout.toString());
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
});
