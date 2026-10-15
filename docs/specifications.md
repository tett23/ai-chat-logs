# 仕様

ai-chat-logs の現行の仕様をまとめる。
設計判断の経緯は `docs/adr/` のADRに記録する。

## 取り込み

[ADR 0001](adr/0001-import-claude-chat-logs-into-sqlite.md)

### コマンド

| コマンド | 入力 | 出力 |
|---|---|---|
| `claude-log-sources`（`src/cli/sources.ts`） | なし | Claude の取り込む対象の、`<種類><タブ><絶対パス>` の行（パスの順） |
| `chat-log-import`（`src/cli/import.ts`） | 標準入力に `claude-log-sources` の形の行 | 標準エラー出力に、失敗ごとの `error<タブ><パス><タブ><理由>` と、要約の `run=… sources=… records=… blobs=… errors=…` |
| `bin/sync` | なし | 上の2つを順に実行する。列挙に失敗したら取り込まない |

`chat-log-import` は、失敗が1つでもあれば終了コード1で終わる。不明な種類の行も失敗とする。

### 種類と提供元

種類の名前は `<提供元>/<種類>`。提供元は履歴を書くツールの名前で、いまは `claude-code`、`claude-desktop`、`claude-cowork`、`claude-ai`（[ADR 0006](adr/0006-import-cowork-and-claude-ai-chats.md)）。
列挙は提供元ごとのコマンド（いまは `claude-log-sources`）、取り込みは提供元に依存しない `chat-log-import` が行う。
提供元を足すときは、列挙のコマンド、`src/kinds.ts` の種類、行ごとの種類の抽出の関数（`src/extract.ts`）、必要なら `messages` ビューの `UNION ALL` の枝を足す。表は変えない。

### 取り込む対象

| 種類 | 対象 | 取り込み方 |
|---|---|---|
| `claude-code/transcript` | `$CLAUDE_CONFIG_DIR/projects/` 以下の `*.jsonl`（`memory/` 以下を除く） | 行ごと・差分 |
| `claude-code/history` | `$CLAUDE_CONFIG_DIR/history.jsonl` | 行ごと・差分 |
| `claude-code/file` | `projects/<プロジェクト>/<セッションID>/` 以下の JSONL 以外のファイル、`projects/<プロジェクト>/*.json` | ファイルごと |
| `claude-desktop/session` | `~/Library/Application Support/Claude/claude-code-sessions/` 以下の `*.json` | ファイルごと |
| `claude-cowork/transcript` | `~/Library/Application Support/Claude/local-agent-mode-sessions/<ID>/<ID>/local_<ID>/.claude/projects/` 以下の `*.jsonl`（`memory/` を除く） | 行ごと・差分 |
| `claude-cowork/file` | 同じく `projects/<プロジェクト>/<セッションID>/` 以下の JSONL 以外のファイル | ファイルごと |
| `claude-cowork/session` | `local-agent-mode-sessions/<ID>/<ID>/local_<ID>.json` | ファイルごと |
| `claude-cowork/audit` | `local-agent-mode-sessions/<ID>/<ID>/local_<ID>/audit.jsonl` | 行ごと・差分（会話・検索・要約には使わない） |
| `claude-ai/conversation` | `$AI_CHAT_LOGS_CLAUDE_AI_DIR/<ID>/messages.jsonl` | 行ごと・差分 |
| `claude-ai/export` | `$AI_CHAT_LOGS_CLAUDE_AI_DIR/<ID>/` の `conversations.json`、`projects.json`、`users.json` | ファイルごと |

`CLAUDE_CONFIG_DIR` の既定は `~/.claude`。存在しないディレクトリは飛ばす。

### 行ごとの取り込み

- 前回までに取り込んだバイト数（`consumed_bytes`）より後ろを読み、最後の改行までの行を取り込む。最後の改行より後ろは書きかけとして次回に回す。
- 64MiB ずつ区切って読む。1行が区切りより長ければ、区切りを広げる。
- 各行は改行と末尾の `\r` を除いた文字列のまま `records.raw` に入れる。空の行は入れないが、行番号（1始まり）は数える。JSON として正しくない行も入れる。
- 種類ごとの抽出の関数で、`records` の `type`、`uuid`、`session_id`、`timestamp` を埋める。JSON として正しくない行、オブジェクトでない行、型の合わない値は NULL。

| 種類 | `type` | `uuid` | `session_id` | `timestamp` |
|---|---|---|---|---|
| `claude-code/transcript` | `$.type` | `$.uuid` | `$.sessionId` | `$.timestamp`（文字列のまま） |
| `claude-code/history` | NULL | NULL | `$.sessionId` | `$.timestamp`（ミリ秒）を ISO 8601（UTC、`Z`）にしたもの |
| `claude-cowork/transcript`、`claude-ai/conversation` | `claude-code/transcript` と同じ | | | |
| `claude-cowork/audit` | `$.type` | `$.uuid` | `$.session_id` | `$._audit_timestamp`（文字列のまま） |
- ファイルが `consumed_bytes` より短くなったか、先頭 `min(4096, consumed_bytes)` バイトの SHA-256 が変わったら、書きかえとみなし、`generation` を上げた `sources` の行を作って先頭から読む。前の版の行は残す。
- 1ファイルを1つのトランザクションで取り込む。

### ファイルごとの取り込み

ファイルの中身を SHA-256 で `blobs` に入れ、パスごとの版を `file_versions` に記録する。同じパスで同じ中身は版を増やさない。

### 消えたファイル

`--mark-missing` を付けると、標準入力に無い取り込み済みのパスの `sources.missing_since` に時刻を入れる。行は消さない。再び取り込むと NULL に戻る。

### データベース

- 場所：`--db`、`AI_CHAT_LOGS_DB`、`${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite` の順（環境変数は `.env` から読んだものを含む）。
- 権限 `0600` で作る。`journal_mode=WAL`、`busy_timeout=10000`。
- スキーマは `schema/NNNN-<名前>.sql` を順に当てる。当てた数を `PRAGMA user_version` に持つ（現在は3）。

| 表・ビュー | 中身 |
|---|---|
| `sources` | 取り込んだファイル（種類、提供元（種類の `/` より前の生成列）、パス、`generation`、取り込み済みのバイト数と行数、先頭のハッシュ、大きさ、更新時刻、最初と最後に見た時刻、見つからなくなった時刻） |
| `records` | JSONL の1行（`raw`）と、抽出した `type`、`uuid`、`session_id`、`timestamp` |
| `blobs` | ファイルの中身（SHA-256 で重複を除く） |
| `file_versions` | ファイルごとの種類の、パスと中身の版 |
| `runs` | 実行ごとの開始・終了の時刻、件数、失敗（JSON の配列） |
| `record_texts` | 会話の本文の全文検索（FTS5、`trigram`）。`rowid` は `records.rowid` |
| `session_summaries` | セッションの要約（提供元、セッションID、`cwd`、タイトル、最初と最後の時刻、メッセージの数） |
| `record_text_source`（ビュー） | 本文の取り出しの規則 |
| `copied_records`（ビュー） | 別のファイルに写された、同じ提供元・セッション・`uuid` のレコードのうち、2つ目以降のもの |
| `session_messages`（ビュー） | セッションのメッセージ（写しを除く） |
| `session_summary_source`（ビュー） | 要約の作り方 |
| `messages`（ビュー） | 会話のメッセージ。いまは `claude-code/transcript` の `user` と `assistant` のレコード（提供元、セッションID、`uuid`、親の `uuid`、時刻、役割、モデル、サイドチェーンか、`cwd`、内容、元のパス） |

### 検索の索引とセッションの要約

[ADR 0003](adr/0003-tauri-log-viewer-with-search.md)、[ADR 0005](adr/0005-log-viewer-corrections-and-details.md)

- 会話の種類：`claude-code/transcript`、`claude-cowork/transcript`、`claude-ai/conversation`。
- 本文：会話の種類の `user` と `assistant` のレコードの、文字列の `message.content`、または `text` と `thinking` のブロックを改行でつないだもの。`tool_use` と `tool_result` は入れない。空なら入れない。
- 写し：同じ提供元・セッションID・`uuid` のレコードが複数のファイルにあれば、パス、`generation`、行番号の順で最初のものだけを、会話・検索・要約で使う。`uuid` の無いレコードは除かない。`records` と `record_texts` からは消さない。
- 要約：メッセージが1つ以上あるセッションだけ。`first_at`・`last_at` はメッセージの時刻の最小と最大、`cwd` は時刻の順で最初のもの。
- タイトル：最後の `custom-title`（パスと行番号の順）、無ければセッションのファイルの最新の版の `title`（`cliSessionId` で対応。`claude-code` は `claude-desktop/session`、`claude-cowork` は `claude-cowork/session`）、無ければ最初の `isMeta` でない `user` の本文の先頭80文字。
- 行を取り込むたびに、増えた行の本文を索引に足し、増えた行のセッションの要約を作りなおす。デスクトップアプリのセッションの版が増えたら、その `cliSessionId` のセッションの要約を作りなおす。

### claude.ai のエクスポートの変換

[ADR 0006](adr/0006-import-cowork-and-claude-ai-chats.md)

- `claude-ai-export-convert <zip | ディレクトリ | conversations.json>`。zip は `unzip` で展開する。`conversations.json` は入力の直下か、その1段下から探す。
- 出力先は `$AI_CHAT_LOGS_CLAUDE_AI_DIR/<conversations.json の SHA-256 の先頭16文字>/`。`conversations.json`、`projects.json`、`users.json`（あるもの）を写し、`messages.jsonl` を書く。既にあるファイルは上書きしない。出力先を標準出力に書く。
- `conversations.json` が無い、JSON でない、配列でないときは、終了コード1で終わり、何も書かない。
- `messages.jsonl`：会話を `created_at`、`uuid` の順に、名前があれば `{"type":"custom-title","customTitle","sessionId"}` の行、続けて各メッセージを `{"type","uuid","parentUuid","sessionId","timestamp","message":{"role","content"},"claudeAi":{"conversation","sender","attachments","files"}}` の行にする。`sender` が `human` なら `user`。`content` が空なら `text` から1つのテキストのブロックを作る。

## GUI

[ADR 0003](adr/0003-tauri-log-viewer-with-search.md)、[ADR 0005](adr/0005-log-viewer-corrections-and-details.md)

- `gui/`。Tauri 2、Rust（`rusqlite`）、TypeScript（フレームワークなし）、Tailwind CSS 4。
- データベースは読み取り専用で開く。場所は `AI_CHAT_LOGS_DB`（環境変数、`.env`、設定ファイルの順。[ADR 0007](adr/0007-settings-and-setup-screen.md)）、無ければ `${XDG_DATA_HOME:-$HOME/.local/share}/ai-chat-logs/logs.sqlite`。見つからない、またはスキーマの版が2より古いときは、その旨を画面に出す。
- コマンド：`status`、`list_projects`（提供元と `cwd` ごと）、`list_sessions`（`provider`、`cwd`、`offset`、`limit`。`last_at` の新しい順）、`get_session`（`session_id`。パス・`generation`・行番号の順）、`get_block`（`rowid`、ブロックの位置。全文）、`search`（`query`、`provider`、`cwd`、`offset`、`limit`。時刻の新しい順）。
- プロジェクトの絞り込み：Claude Code は `cwd` ごと、ほかの提供元は提供元ごとに1項目。一覧と検索の結果に、Claude Code 以外の提供元の名前を出す。
- 検索：空白で区切った語のうち、3文字以上の語は二重引用符で囲んだ FTS5 の語として AND でつなぎ、3文字未満の語は `LIKE`（`%`、`_`、`\` をエスケープ）で絞る。抜粋は、FTS5 の `snippet()`、3文字未満の語だけのときは本文から最初の一致の前後32文字を切り出したもの。強調は U+E000 と U+E001 で囲む。
- `get_session` のブロックのうち、`thinking`、`tool_use`、`tool_result`、その他の本文は、4,000 文字を超えたら先頭の 4,000 文字と元の文字数を返す。
- 画面：本文はプレーンテキスト。` ``` ` で囲まれた部分だけ等幅にする。`thinking`、`tool_use`、`tool_result`、サイドチェーンのレコードは折りたたみ、開いたときに中身を組み立てる。文字列は HTML として解釈させない。

## 定期実行

[ADR 0002](adr/0002-periodic-sync-with-pm2.md)

- `ecosystem.config.cjs` に、pm2 のアプリ `ai-chat-logs-sync` を1つ定義する。`bin/sync` を `/bin/sh` で実行し、`autorestart: false`、`cron_restart` は `AI_CHAT_LOGS_CRON`（`.env` から読んだものを含む。既定は `0 * * * *`）。
- `pm2 start` の時点の `PATH` をアプリに渡す。
- `bin/sync` は、`bun` が `PATH` に無ければ終了コード127で終わる。

## .env

[ADR 0004](adr/0004-load-environment-from-dotenv.md)

### 読むファイルと優先順位

- `AI_CHAT_LOGS_ENV_FILE` があればそのファイルを、無ければリポジトリのルートの `.env` を読む。ファイルが無ければ何もしない。
- 既にある環境変数は上書きしない。
- 実行したディレクトリの `.env` は読まない。CLI は `bun --no-env-file` で動かし、Bun の自動の読み込みを止める。
- CLI（`claude-log-sources`、`chat-log-import`）は起動の直後に、`ecosystem.config.cjs` は `cron_restart` を決める前に読む。
- 名前の制限は無い。このツールが読むのは `AI_CHAT_LOGS_DB`、`XDG_DATA_HOME`、`CLAUDE_CONFIG_DIR`、`AI_CHAT_LOGS_CRON`。
- 設定できる変数は `.env.example` にコメントで示す。`.env` は git の管理外。

### 書式

- 行末の `\r` を除く。空の行と、空白を除いた先頭が `#` の行は飛ばす。先頭の `export ` は除く。
- 最初の `=` の左が名前（前後の空白を除き、`[A-Za-z_][A-Za-z0-9_]*`）、右が値。
- 値は前後の空白を除いてから解釈する。
  - `"…"`：`\n`、`\"`、`\\` を改行、`"`、`\` にする。ほかの `\` は残す。
  - `'…'`：中身をそのまま使う。
  - 閉じる引用符の後には、空白と `#` で始まるコメントだけを置ける。
  - 引用符なし：空白の直後の `#` から後ろを除き、後ろの空白を除く。
- `$` と `~` は展開しない。行をまたぐ値は扱わない。同じ名前は後のものを使う。
- 名前が不正な行、`=` の無い行、閉じない引用符、閉じる引用符の後の余計な文字はエラー。メッセージは `<パス>: line <行番号>: <理由>`。CLI は終了コード2で終わり、`ecosystem.config.cjs` は例外を投げる。

## 設定ファイル

[ADR 0007](adr/0007-settings-and-setup-screen.md)

- 場所：`AI_CHAT_LOGS_CONFIG`、無ければ `${XDG_CONFIG_HOME:-~/.config}/ai-chat-logs/config.env`。書式は `.env` と同じ。
- 優先順位：環境変数、`.env`、設定ファイル、既定。CLI、`ecosystem.config.cjs`、GUI のすべてが、この順で読む。
- GUI の管理画面が書くのは設定ファイルだけ。項目は `AI_CHAT_LOGS_DB`、`CLAUDE_CONFIG_DIR`、`AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR`、`AI_CHAT_LOGS_CLAUDE_AI_DIR`、`AI_CHAT_LOGS_REPO`、`AI_CHAT_LOGS_BUN`。
- 書き方：`名前="値"`（`\` と `"` を逃がす）。改行を含む値は保存しない。最初の行を書きかえ、同じ名前の2行目以降を消す。空の値で保存するとその名前の行を消す。ほかの行は残す。一時ファイルから名前を変えて置きかえる。
- `AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR`（既定は `~/Library/Application Support/Claude`）は、CLI の列挙でも使う。`AI_CHAT_LOGS_REPO`（既定は GUI をビルドしたリポジトリ）と `AI_CHAT_LOGS_BUN` は GUI だけが使う。
- GUI の `bun` の探し方：`AI_CHAT_LOGS_BUN`、`PATH`、`~/.bun/bin/bun`、`~/.local/share/mise/shims/bun`、`/opt/homebrew/bin/bun`、`/usr/local/bin/bun` の順で、最初に実行できるもの。

## 管理画面

[ADR 0007](adr/0007-settings-and-setup-screen.md)

- 画面の上の「閲覧」と「管理」で切りかえる。データベースが開けないときは、起動時に「管理」を開く。
- コマンド：`get_settings`、`save_setting`（`key`、`value`。保存後にデータベースを開きなおす）、`check_environment`、`run_sync`、`import_claude_ai_export`（`zip`）。
- 環境の検査は読むだけ。pm2 は `bun` の隣、`PATH`、`~/.bun/bin`、`~/.cache/.bun/bin` から探し、`bun` で `pm2 jlist` を実行して `ai-chat-logs-sync` の登録を調べる。launchd は `~/Library/LaunchAgents/pm2.*.plist` の有無を見る。
- 取り込み：`/bin/sh <リポジトリ>/bin/sync`。claude.ai のエクスポート：ファイルを選ぶ画面（`tauri-plugin-dialog`）で zip を選び、`bun <リポジトリ>/src/cli/claude-ai-export-convert.ts <zip>` の後に取り込みを実行する。どちらも `PATH` の先頭に `bun` のディレクトリを足し、CLI が使う設定を環境変数で渡す。同時に1つだけ実行する。終わったら、終了コードと出力の最後の20行を出し、データベースを開きなおす。

## インストール

[ADR 0008](adr/0008-install-compiled-commands.md)

- `bin/install [<インストール先>]`（既定は `~/.local/bin`）。`claude-log-sources`、`chat-log-import`、`claude-ai-export-convert` を `bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig` で実行ファイルにし、`ai-chat-logs-sync` を写す。置いたファイルのパスを1行ずつ標準出力に書く。一時ファイルから名前を変えて置きかえる。
- リポジトリの絶対パスを `--define AI_CHAT_LOGS_REPO_AT_BUILD=...` で埋めこむ（環境変数 `AI_CHAT_LOGS_REPO_AT_BUILD` で変えられる）。実行ファイルの `.env` の既定の場所は、埋めこんだリポジトリの `.env`。
- `ai-chat-logs-sync`：同じディレクトリの `claude-log-sources` の出力を一度受けてから、`chat-log-import --mark-missing` に渡す。引数は `chat-log-import` に渡す。

## 破棄したADR

なし
