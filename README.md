# ai-chat-logs

AI のチャット履歴を SQLite に書き出し、定期的に保存するためのツール群。
いまは Claude（Claude Code とデスクトップアプリの Code タブ）の履歴に対応する。スキーマは、Claude 以外の AI の履歴も入れられる形にしてある。

Claude Code は、既定で30日を過ぎたセッションの履歴を削除する。
このツールは、手元の履歴（`~/.claude/projects` の JSONL など）を差分で SQLite に取り込み、元のファイルが消えても取り込み済みの行を残す。

## 必要なもの

- [Bun](https://bun.com/)
- [pm2](https://pm2.keymetrics.io/)（定期実行する場合）

## 使い方

### 1回だけ取り込む

```sh
bin/sync
```

取り込む対象の列挙と取り込みは、別のコマンドに分かれている。`bin/sync` は次の2つをつなぐ。

```sh
bun src/cli/sources.ts                             # "<種類>\t<絶対パス>" を1行ずつ出力する
bun src/cli/sources.ts | bun src/cli/import.ts     # 標準入力の対象を差分で取り込む
```

`chat-log-import`（`src/cli/import.ts`）のオプション：

| オプション | 意味 |
|---|---|
| `--db <パス>` | データベースのパス |
| `--mark-missing` | 標準入力に無い取り込み済みのファイルに、見つからなくなった時刻を記録する（`bin/sync` は付ける） |

ファイルの読み込みなどに1つでも失敗すると、ほかのファイルを取り込んだうえで終了コード1で終わる。

### 定期的に取り込む（pm2）

```sh
bun add -g pm2
pm2 start ecosystem.config.cjs
```

- 登録した時点で1回実行され、以後は毎時0分に実行される。間隔は `AI_CHAT_LOGS_CRON`（cron の式。環境変数か `.env`）で変えられる。
- `pm2 start` を実行したシェルの `PATH` を引き継ぐ。`bun` が見つからないと、`bin/sync` は終了コード127で終わる。
- ログイン時に自動で起動させる場合は、`pm2 save` と `pm2 startup` を実行する。`pm2 startup` が表示するコマンドの実行は、内容を確かめてから判断する。
- 状態は `pm2 status ai-chat-logs-sync`、ログは `pm2 logs ai-chat-logs-sync` で見る。
- 止めるときは `pm2 delete ai-chat-logs-sync`。

### 設定（環境変数と .env）

| 変数 | 意味 | 既定 |
|---|---|---|
| `AI_CHAT_LOGS_DB` | データベースのパス | `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite` |
| `XDG_DATA_HOME` | データベースの既定の場所の基準 | `~/.local/share` |
| `CLAUDE_CONFIG_DIR` | Claude Code の設定ディレクトリ | `~/.claude` |
| `AI_CHAT_LOGS_CRON` | pm2 で実行する時刻（cron の式） | `0 * * * *` |
| `AI_CHAT_LOGS_ENV_FILE` | 読む `.env` のパス | リポジトリのルートの `.env` |

これらは、リポジトリのルートの `.env` にも書ける。

```sh
cp .env.example .env   # 使う行のコメントを外して値を書く
```

- 既にある環境変数は `.env` より優先される。
- 実行したディレクトリの `.env` は読まない。どこから実行しても、リポジトリのルートの `.env`（または `AI_CHAT_LOGS_ENV_FILE`）だけを読む。
- `$` と `~` は展開しない。パスは絶対パスで書く。
- 書式に誤りがあると、CLI は終了コード2で終わり、`pm2 start` は失敗する。メッセージにファイルのパスと行番号が出る。
- `AI_CHAT_LOGS_CRON` は `pm2 start` のときに読まれる。変えたら `pm2 delete ai-chat-logs-sync` と `pm2 start ecosystem.config.cjs` で登録しなおす。

書式の詳細は [docs/specifications.md](docs/specifications.md) を参照。

データベースには秘密の情報が含まれうるため、権限 `0600` で作られる。

### データベースを読む

```sh
sqlite3 ~/.local/share/ai-chat-logs/logs.sqlite \
  "SELECT timestamp, role, substr(content, 1, 80) FROM messages WHERE session_id = '<セッションID>' ORDER BY timestamp"
```

表とビューは [docs/specifications.md](docs/specifications.md) を参照。

## 開発

クローン後、gitのhookを有効化する。コミット済みのADRの変更は [adr-guard](https://github.com/tett23/adr-guard) で拒否する。

```sh
git config core.hooksPath .githooks
```

テストは `bun test` で実行する。

設計判断は `docs/adr/` にADRとして記録する。仕様は [docs/specifications.md](docs/specifications.md) を参照。

## License

[MIT](LICENSE)
