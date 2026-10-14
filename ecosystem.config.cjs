// docs/adr/0002: run bin/sync on a cron schedule with pm2.
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
