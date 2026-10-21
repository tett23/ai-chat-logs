# ai-chat-logs

AI のチャット履歴を SQLite に書き出し、定期的に保存するためのツール群。
いまは Claude の履歴に対応する。Claude Code（デスクトップアプリの Code タブを含む）と Cowork は自動で、claude.ai のチャットは公式のエクスポートから取り込む。スキーマは、Claude 以外の AI の履歴も入れられる形にしてある。

Claude Code は、既定で30日を過ぎたセッションの履歴を削除する。
このツールは、手元の履歴（`~/.claude/projects` の JSONL など）を差分で SQLite に取り込み、元のファイルが消えても取り込み済みの行を残す。

## 必要なもの

- [Bun](https://bun.com/)
- [pm2](https://pm2.keymetrics.io/)（定期実行する場合）

## 手動で行う作業

このツールは、システムの設定を変える作業（pm2 のインストール、launchd への登録、PATH の設定）を自動では行わない（[ADR 0002](docs/adr/0002-periodic-sync-with-pm2.md)）。次の作業は手で行う。

### 最初に一度

1. Bun を入れる。
2. pm2 を入れる：`bun add -g pm2`
3. Bun のグローバルの bin を PATH に入れる。場所は `bun pm bin -g` で分かる（例：`~/.cache/.bun/bin`）。シェルの設定ファイル（`~/.zshrc` など）に `export PATH="<その場所>:$PATH"` を書き、シェルを開きなおす。
   - これをしないと `pm2` が見つからない。zsh では `zsh: correct 'pm2' to '_pm2' [nyae]?` と聞かれる（`n` で答える）。
   - 一時的に PATH を足すだけでも動くが、`pm2 startup` がその時点の PATH を launchd に書き込むため、設定ファイルに書いて永続させる。
4. `bun` と `pm2` の両方が見つかるシェルで、リポジトリのルートから取り込みを登録する：`pm2 start ecosystem.config.cjs`
   - 登録した時点で1回目の取り込みが始まる。履歴の量によっては数十秒から数分かかる。`pm2 status ai-chat-logs-sync` が `stopped` になれば終わり。
5. `pm2 startup` を実行し、表示された `sudo` のコマンドを、内容を確かめてから実行する。
6. `pm2 save` を実行する。
7. 確かめる：`pm2 logs ai-chat-logs-sync --lines 5` に `run=… errors=0` が出ていること。

5 と 6 をしないと、再起動の後に取り込みが黙って止まる（下の「定期的に取り込む」を参照）。

### claude.ai の会話を取り込むとき

claude.ai（Web とデスクトップアプリのチャット）の会話は手元に無いため、公式のエクスポートから取り込む（[ADR 0006](docs/adr/0006-import-cowork-and-claude-ai-chats.md)）。自動では最新にならないので、取り込みたいときに繰り返す。

1. claude.ai の設定 → Privacy → Export data でエクスポートを要求する。
2. 届いたメールのリンクから zip をダウンロードする（ダウンロードフォルダに置く）。
3. あとは次の取り込み（pm2 の毎時の定期実行か `bin/sync`）で、自動で変換されてデータベースに入る（[ADR 0010](docs/adr/0010-scan-downloads-for-claude-ai-exports.md)）。すぐに取り込みたいときは、GUI の閲覧の画面の「ダウンロードしたエクスポートを取り込む」を押す。

- 受け取り用のディレクトリは `AI_CHAT_LOGS_CLAUDE_AI_INBOX`（既定は `~/Downloads`）で変えられる。直下の zip のうち、中に `conversations.json` があるものをエクスポートとみなす。名前は問わない。
- 取り込み済みかどうかは中身で見分けるので、zip を残しておいても二重には入らない。zip は消さない。
- 元のファイルと変換した `messages.jsonl` は `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude-ai/<ID>/` に置かれる（場所は `AI_CHAT_LOGS_CLAUDE_AI_DIR` で変えられる）。
- 手で変換することもできる：`bun src/cli/claude-ai-export-convert.ts <zip か conversations.json>`。GUI の管理画面の「claude.ai のエクスポートを取り込む」では、zip を選んで取り込める。
- macOS はダウンロードフォルダをプライバシー保護（TCC）の対象にしているため、pm2 の定期実行から読めないことがある。`pm2 logs ai-chat-logs-sync` に `cannot read` と `Operation not permitted` が出たら、受け取り用のディレクトリをダウンロードフォルダ以外にして zip をそこへ置くか、システム設定 → プライバシーとセキュリティ → ファイルとフォルダ（またはフルディスクアクセス）で許可する。GUI も別のアプリとして許可を受ける。

何度エクスポートしても、同じメッセージは会話・検索・件数に1回だけ出る。

### 設定を変えたとき

- `.env` の `AI_CHAT_LOGS_DB`、`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`AI_CHAT_LOGS_CLAUDE_AI_DIR`、`AI_CHAT_LOGS_CLAUDE_AI_INBOX` は、次の取り込みから効く。登録しなおす必要は無い。
- `AI_CHAT_LOGS_CRON` を変えたら、`pm2 delete ai-chat-logs-sync`、`pm2 start ecosystem.config.cjs`、`pm2 save` で登録しなおす。

### コマンドをインストールするとき

`bin/install` で、コマンドを単体で動く実行ファイルにビルドし、`~/.local/bin`（引数で変えられる）に入れる（[ADR 0008](docs/adr/0008-install-compiled-commands.md)）。

```sh
bin/install
```

- 入るもの：`claude-log-sources`、`chat-log-import`、`claude-ai-export-convert`、`claude-ai-export-scan`（それぞれ 70MB ほど）と、それらで取り込む `ai-chat-logs-sync`。`bun` が無い環境でも動く。
- リポジトリの場所を埋めこむ。`.env` は、埋めこんだリポジトリのものを読む。実行したディレクトリの `.env` は読まない。
- pm2 の定期実行と GUI の取り込みは、これまでどおりリポジトリの `bin/sync` を使う。インストールしたコマンドには依存しない。

### リポジトリを更新したとき

- `git pull` するだけでよい。スキーマの変更（マイグレーション）は、次の取り込みのときに自動で当たる。
- `bin/install` でコマンドを入れている場合は、`bin/install` を実行しなおす。リポジトリを動かした場合も同じ。
- `ecosystem.config.cjs` が変わったときは、`pm2 delete ai-chat-logs-sync`、`pm2 start ecosystem.config.cjs`、`pm2 save` で登録しなおす。

### pm2 や Bun を入れなおしたとき

pm2 や `bun` の場所が変わると、launchd に書き込まれた PATH と合わなくなる。`pm2 unstartup` で登録を消し、表示された `sudo` のコマンドを実行してから、上の 5 と 6 をやりなおす。

### 再起動の後

`pm2 status ai-chat-logs-sync` でアプリがあることを確かめる。無ければ `pm2 startup` か `pm2 save` が済んでいない。

### GUI を使うとき

`gui/` でビルドし、アプリを起動する（下の「閲覧・検索する」を参照）。データベースが既定の場所に無い場合は、起動するときに `AI_CHAT_LOGS_DB` を渡す。

### 開発するとき

クローンごとに `git config core.hooksPath .githooks` を実行する（下の「開発」を参照）。

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
| `AI_CHAT_LOGS_CLAUDE_AI_INBOX` | claude.ai のエクスポートの受け取り用のディレクトリ | `~/Downloads` |
| `AI_CHAT_LOGS_CLAUDE_AI_DIR` | claude.ai のエクスポートの保存用のディレクトリ | `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude-ai` |
| `AI_CHAT_LOGS_CRON` | pm2 で実行する時刻（cron の式） | `0 * * * *` |
| `AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR` | デスクトップアプリのディレクトリ | `~/Library/Application Support/Claude` |
| `AI_CHAT_LOGS_ENV_FILE` | 読む `.env` のパス | リポジトリのルートの `.env` |
| `AI_CHAT_LOGS_CONFIG` | 読む設定ファイルのパス | `${XDG_CONFIG_HOME:-~/.config}/ai-chat-logs/config.env` |

これらは、リポジトリのルートの `.env` と、設定ファイル（GUI の管理画面が書く）にも書ける。値は、環境変数、`.env`、設定ファイル、既定の順に決まる（[ADR 0007](docs/adr/0007-settings-and-setup-screen.md)）。書式はどちらも同じ。

```sh
cp .env.example .env   # 使う行のコメントを外して値を書く
```

- 既にある環境変数は `.env` と設定ファイルより、`.env` は設定ファイルより優先される。
- 実行したディレクトリの `.env` は読まない。どこから実行しても、リポジトリのルートの `.env`（または `AI_CHAT_LOGS_ENV_FILE`）だけを読む。
- `$` と `~` は展開しない。パスは絶対パスで書く。
- `.env` か設定ファイルの書式に誤りがあると、CLI は終了コード2で終わり、`pm2 start` は失敗する。メッセージにファイルのパスと行番号が出る。
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
bun run tauri build        # アプリをビルドする（src-tauri/target/release/bundle/macos/AI Chat Logs.app）
```

- 必要なもの：Rust（stable）と、Tauri の前提のライブラリ（macOS では Xcode の Command Line Tools）。
- 設定は CLI と同じく、環境変数、`.env`、設定ファイル、既定の順に決まる。Finder から起動したアプリには環境変数が渡らないため、既定以外の場所は管理画面で設定ファイルに書く。
- 「管理」の画面で次ができる（[ADR 0007](docs/adr/0007-settings-and-setup-screen.md)）。データベースが開けないときは、起動時にこの画面が開く。
  - 設定：各パスと `bun` の場所の確認と変更（設定ファイルに書く）。値がどこから来たかも出す。
  - 環境の検査：パス、データベース、最後の取り込み、`bun`、pm2 の登録、launchd の登録。
  - 初期化：取り込み（データベースが無ければ作る）と、claude.ai のエクスポートの zip の取り込み。
- GUI は取り込みのときに、このリポジトリ（`AI_CHAT_LOGS_REPO`。既定はビルドしたリポジトリ）のコマンドを `bun` で実行する。pm2 の操作はしない。
- 左にセッションの一覧、上に検索の入力欄、右に会話を出す。プロジェクトの絞り込みで、Claude Code のプロジェクトのほか「claude.ai」「Cowork」を選べる。3文字以上の語は全文検索の索引で引き、3文字未満の語は全件を走査する（遅い）。
- ツールの入出力などの長いブロックは先頭の 4,000 文字だけを出し、「全文を読み込む」で残りを読む。

## 開発

クローン後、gitのhookを有効化する。コミット済みのADRの変更は [adr-guard](https://github.com/tett23/adr-guard) で拒否する。ただし、ステータスの行とリンクだけの変更は許可する（[ADR 0009](docs/adr/0009-update-adr-guard-to-v0-8-2.md)、[ADR 0012](docs/adr/0012-update-adr-guard-to-v0-8-3.md)）。

```sh
git config core.hooksPath .githooks
```

テストは `bun test` で実行する。GUI のテストは `gui/` で `bun test`、`gui/src-tauri/` で `cargo test`。

設計判断は `docs/adr/` にADRとして記録する。仕様は [docs/specifications.md](docs/specifications.md) を参照。

## License

[MIT](LICENSE)
