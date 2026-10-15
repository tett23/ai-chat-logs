import { join } from "node:path";
import { loadDotenv } from "./dotenv.cjs";

const repoRoot = join(import.meta.dir, "..");

// docs/adr/0004: the env file is the repository's .env unless AI_CHAT_LOGS_ENV_FILE names another.
export const envFilePath = (env: Record<string, string | undefined>): string =>
  env.AI_CHAT_LOGS_ENV_FILE || join(repoRoot, ".env");

// Load the env file into process.env; exit 2 on a syntax error.
export const loadEnvFile = (): void => {
  try {
    loadDotenv(envFilePath(process.env), process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
};
