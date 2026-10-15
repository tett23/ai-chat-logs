import { join } from "node:path";

type Env = Record<string, string | undefined>;

const home = (env: Env): string => {
  if (!env.HOME) throw new Error("HOME is not set");
  return env.HOME;
};

export const claudeConfigDir = (env: Env): string => env.CLAUDE_CONFIG_DIR || join(home(env), ".claude");

export const desktopAppDir = (env: Env): string => join(home(env), "Library/Application Support/Claude");

export const defaultDatabasePath = (env: Env): string =>
  env.AI_CHAT_LOGS_DB || join(env.XDG_DATA_HOME || join(home(env), ".local/share"), "ai-chat-logs/logs.sqlite");
