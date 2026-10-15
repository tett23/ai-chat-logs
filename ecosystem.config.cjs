// docs/adr/0002: run bin/sync on a cron schedule with pm2.
// docs/adr/0004, docs/adr/0007: AI_CHAT_LOGS_CRON may come from the env file or the config file;
// the CLIs read both themselves.
const { join } = require("node:path");
const { loadDotenv } = require("./src/dotenv.cjs");

loadDotenv(process.env.AI_CHAT_LOGS_ENV_FILE || join(__dirname, ".env"), process.env);
const configBase = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
const configFile = process.env.AI_CHAT_LOGS_CONFIG || (configBase && join(configBase, "ai-chat-logs/config.env"));
if (configFile) loadDotenv(configFile, process.env);

module.exports = {
  apps: [
    {
      name: "ai-chat-logs-sync",
      script: "bin/sync",
      interpreter: "/bin/sh",
      cwd: __dirname,
      cron_restart: process.env.AI_CHAT_LOGS_CRON ?? "0 * * * *",
      autorestart: false,
      env: {
        PATH: process.env.PATH,
      },
    },
  ],
};
