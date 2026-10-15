# ADR 0002: pm2 で取り込みを定期的に実行する

ステータス: 採択

## 文脈

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) の `bin/sync` は、1回の実行で差分を取り込んで終わる。
Claude Code は既定で30日を過ぎた履歴を削除するため、それより十分に短い間隔で `bin/sync` を繰り返し実行する必要がある。
定期実行には pm2 を使う（ゴールでの指定）。

pm2 は常駐するプロセスの管理ツールだが、`cron_restart` に cron の式を、`autorestart` に `false` を指定すると、終了するプロセスを決まった時刻に起動しなおす使い方ができる。
`pm2 start` の時点で1回実行され、以後は cron の式の時刻ごとに実行される。
2026-10-14 時点で、手元に pm2 は入っていない。

## 実装すること

### ecosystem ファイル

リポジトリのルートに `ecosystem.config.cjs` を置く。

```js
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
```

- 既定の間隔は毎時0分。環境変数 `AI_CHAT_LOGS_CRON` で変えられる。
- `PATH` は `pm2 start` を実行したシェルのものを渡す。`pm2 startup` で launchd から pm2 が起動した場合も、mise などで入れた `bun` が見つかるようにするため。
- データベースの場所は [ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) のとおり（`AI_CHAT_LOGS_DB` を `pm2 start` の時点の環境から渡せる）。

### `bin/sync` の振る舞い

- `bun` が見つからなければ、その旨を標準エラー出力に書いて終了コード127で終わる。
- 1回の実行が次の時刻までに終わらず pm2 に起動しなおされても、[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) のとおり1ファイル1トランザクションのため、取り込み済みの分は失われず、次の実行で続きから取り込む。

### README

次の手順を書く。

1. pm2 を入れる（例：`bun add -g pm2`）。
2. `pm2 start ecosystem.config.cjs` で登録する。
3. `pm2 startup` と `pm2 save` を必須の手順として書く。pm2 のデーモンは再起動やログアウトで止まり、`pm2 startup` をしていないと、再起動の後は取り込みが黙って止まり、30日で Claude Code の履歴が失われるため。`pm2 startup` が表示するコマンドは、利用者が内容を確かめてから実行する。登録を変えたら `pm2 save` をやりなおすことも書く。
4. 状態は `pm2 status ai-chat-logs-sync`、ログは `pm2 logs ai-chat-logs-sync` で見る。実行の履歴はデータベースの `runs` 表でも見られる。
5. 止めるときは `pm2 delete ai-chat-logs-sync`。

## 実装しないこと

- pm2 のインストールと、`pm2 startup` による launchd への登録の自動化。システムの設定を変えるため、利用者が手で行う。
- pm2 のログのローテーション（pm2-logrotate）。1回の出力は数行のため。
- pm2 以外（launchd、cron、systemd）の設定ファイル。
- 実行の失敗の通知。

## テスト設計

### 自動テスト

1. `ecosystem.config.cjs` を `require` し、アプリが1つで、`script` が `bin/sync`、`autorestart` が `false`、`cron_restart` の既定が `0 * * * *` であること。
2. `AI_CHAT_LOGS_CRON` を設定して読み込むと、`cron_restart` がその値になること。
3. `PATH` から `bun` を除いて `bin/sync` を実行すると、終了コード127で終わること。

### 手で確かめること

自動テストにできない pm2 との結合は、実装の後に次の手順で確かめ、結果をプルリクエストに書く。

1. 一時のデータベースを `AI_CHAT_LOGS_DB` に指定し、`AI_CHAT_LOGS_CRON="*/2 * * * *"` で `pm2 start ecosystem.config.cjs` を実行する。
2. 直後に `runs` 表に1行入り、`pm2 status` で `stopped`（終了コード0）になっていること。
3. 2分後と4分後に `runs` 表の行が増えていること。
4. `pm2 delete ai-chat-logs-sync` で登録を消す。

## トレードオフ

- pm2 は Node.js の常駐プロセスを1つ必要とする。launchd の `StartCalendarInterval` や cron なら常駐プロセスは要らないが、ログの閲覧や状態の確認を pm2 の操作で統一できる。
- `cron_restart` は、前の実行が終わっていなくても時刻になれば起動しなおす。重なりを防ぐ排他は入れず、取り込みの冪等性とトランザクションで安全を保つ。
- 毎時の実行は30日の削除の期限に対して十分に短い。差分だけを読むため、1回の実行の費用は、各ファイルの `stat` と追記された分の読み込みにとどまる。

## 参考文献

- PM2 Restart Strategies（`cron_restart`、`autorestart`）：https://pm2.keymetrics.io/docs/usage/restart-strategies/
- PM2 Ecosystem File：https://pm2.keymetrics.io/docs/usage/application-declaration/
- PM2 Startup Script：https://pm2.keymetrics.io/docs/usage/startup/
- Claude Code の設定（`cleanupPeriodDays`）：https://code.claude.com/docs/en/settings
