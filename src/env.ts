import { join } from "node:path";
import { loadDotenv } from "./dotenv.cjs";

type Env = Record<string, string | undefined>;

const repoRoot = join(import.meta.dir, "..");

// docs/adr/0004: the env file is the repository's .env unless AI_CHAT_LOGS_ENV_FILE names another.
export const envFilePath = (env: Env): string => env.AI_CHAT_LOGS_ENV_FILE || join(repoRoot, ".env");

// docs/adr/0007: the config file written by the GUI's settings screen; null when no base directory is known.
export const configFilePath = (env: Env): string | null => {
  if (env.AI_CHAT_LOGS_CONFIG) return env.AI_CHAT_LOGS_CONFIG;
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : null);
  return base ? join(base, "ai-chat-logs/config.env") : null;
};

// Load the env file, then the config file, into process.env without overriding; exit 2 on a syntax error.
export const loadEnvFile = (): void => {
  try {
    loadDotenv(envFilePath(process.env), process.env);
    const config = configFilePath(process.env);
    if (config) loadDotenv(config, process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
};
