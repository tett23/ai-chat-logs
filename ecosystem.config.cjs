// docs/adr/0002: run bin/sync on a cron schedule with pm2.
// docs/adr/0004: AI_CHAT_LOGS_CRON may come from the env file; the CLIs read the env file themselves.
const { join } = require("node:path");
const { loadDotenv } = require("./src/dotenv.cjs");

loadDotenv(process.env.AI_CHAT_LOGS_ENV_FILE || join(__dirname, ".env"), process.env);

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
