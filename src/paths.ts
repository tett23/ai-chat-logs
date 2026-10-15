import { join } from "node:path";

type Env = Record<string, string | undefined>;

const home = (env: Env): string => {
  if (!env.HOME) throw new Error("HOME is not set");
  return env.HOME;
};

export const claudeConfigDir = (env: Env): string => env.CLAUDE_CONFIG_DIR || join(home(env), ".claude");

export const desktopAppDir = (env: Env): string =>
  env.AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR || join(home(env), "Library/Application Support/Claude");

const dataHome = (env: Env): string => env.XDG_DATA_HOME || join(home(env), ".local/share");

export const defaultDatabasePath = (env: Env): string => env.AI_CHAT_LOGS_DB || join(dataHome(env), "ai-chat-logs/logs.sqlite");

// docs/adr/0006: where claude-ai-export-convert keeps exports and converted messages.
export const claudeAiDir = (env: Env): string => env.AI_CHAT_LOGS_CLAUDE_AI_DIR || join(dataHome(env), "ai-chat-logs/claude-ai");

