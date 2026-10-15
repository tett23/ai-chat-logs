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

次の4つをすべて行う。

```sh
bun add -g pm2                  # 1. pm2 を入れる
pm2 start ecosystem.config.cjs  # 2. 取り込みを登録する
pm2 startup                     # 3. OS の起動時に pm2 が立ち上がるようにする
pm2 save                        # 4. 登録したアプリを保存する
```

**`pm2 startup` と `pm2 save` は必須。**
pm2 のデーモンは、再起動やログアウトで止まる。
`pm2 startup` をしていないと、再起動の後は取り込みが一度も実行されず、エラーも出ない。
そのまま30日が過ぎると、Claude Code が古い履歴を削除し、取り込まれないまま失われる。

- `pm2 startup` は、launchd（macOS）や systemd（Linux）に登録するためのコマンドを表示する。表示されたコマンドを、内容を確かめてから実行する（`sudo` が要る）。
- `pm2 save` は、その時点で登録されているアプリを保存し、起動時に復元させる。`pm2 start` や `pm2 delete` で登録を変えたら、`pm2 save` をやりなおす。
- 再起動の後に `pm2 status ai-chat-logs-sync` でアプリがあること、データベースの `runs` 表に新しい行が入っていることを確かめるとよい。
- 登録した時点で1回実行され、以後は毎時0分に実行される。間隔は `AI_CHAT_LOGS_CRON`（cron の式。環境変数か `.env`）で変えられる。
- `pm2 start` を実行したシェルの `PATH` を引き継ぎ、`pm2 save` で保存される。`bun` が見つからないと、`bin/sync` は終了コード127で終わる。
- 状態は `pm2 status ai-chat-logs-sync`、ログは `pm2 logs ai-chat-logs-sync` で見る。
- 止めるときは `pm2 delete ai-chat-logs-sync` の後に `pm2 save` を実行する（しないと、次の起動時に復元される）。

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
- `AI_CHAT_LOGS_CRON` は `pm2 start` のときに読まれる。変えたら `pm2 delete ai-chat-logs-sync`、`pm2 start ecosystem.config.cjs`、`pm2 save` で登録しなおす。

書式の詳細は [docs/specifications.md](docs/specifications.md) を参照。

データベースには秘密の情報が含まれうるため、権限 `0600` で作られる。

### データベースを読む

```sh
sqlite3 ~/.local/share/ai-chat-logs/logs.sqlite \
  "SELECT timestamp, role, substr(content, 1, 80) FROM messages WHERE session_id = '<セッションID>' ORDER BY timestamp"
```

表とビューは [docs/specifications.md](docs/specifications.md) を参照。

### 閲覧・検索する（GUI）

`gui/` に、履歴を閲覧・検索する Tauri のアプリがある。データベースは読み取り専用で開くため、pm2 の取り込みと同時に使える。

```sh
cd gui
bun install
bun run tauri dev          # 開発用に起動する
bun run tauri build        # アプリをビルドする（src-tauri/target/release/bundle/）
```

- 必要なもの：Rust（stable）と、Tauri の前提のライブラリ（macOS では Xcode の Command Line Tools）。
- データベースは `AI_CHAT_LOGS_DB`、無ければ `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite` を開く。GUI は `.env` を読まない。Finder から起動したアプリには環境変数が渡らないため、既定以外の場所は `open --env AI_CHAT_LOGS_DB=<パス> "AI Chat Logs.app"` のように渡す。
- 左にセッションの一覧、上に検索の入力欄、右に会話を出す。3文字以上の語は全文検索の索引で引き、3文字未満の語は全件を走査する（遅い）。
- ツールの入出力などの長いブロックは先頭の 4,000 文字だけを出し、「全文を読み込む」で残りを読む。

## 開発

クローン後、gitのhookを有効化する。コミット済みのADRの変更は [adr-guard](https://github.com/tett23/adr-guard) で拒否する。

```sh
git config core.hooksPath .githooks
```

テストは `bun test` で実行する。GUI のテストは `gui/` で `bun test`、`gui/src-tauri/` で `cargo test`。

設計判断は `docs/adr/` にADRとして記録する。仕様は [docs/specifications.md](docs/specifications.md) を参照。

## License

[MIT](LICENSE)
