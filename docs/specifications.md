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

種類の名前は `<提供元>/<種類>`。提供元は履歴を書くツールの名前で、いまは `claude-code` と `claude-desktop`。
列挙は提供元ごとのコマンド（いまは `claude-log-sources`）、取り込みは提供元に依存しない `chat-log-import` が行う。
提供元を足すときは、列挙のコマンド、`src/kinds.ts` の種類、行ごとの種類の抽出の関数（`src/extract.ts`）、必要なら `messages` ビューの `UNION ALL` の枝を足す。表は変えない。

### 取り込む対象

| 種類 | 対象 | 取り込み方 |
|---|---|---|
| `claude-code/transcript` | `$CLAUDE_CONFIG_DIR/projects/` 以下の `*.jsonl`（`memory/` 以下を除く） | 行ごと・差分 |
| `claude-code/history` | `$CLAUDE_CONFIG_DIR/history.jsonl` | 行ごと・差分 |
| `claude-code/file` | `projects/<プロジェクト>/<セッションID>/` 以下の JSONL 以外のファイル、`projects/<プロジェクト>/*.json` | ファイルごと |
| `claude-desktop/session` | `~/Library/Application Support/Claude/claude-code-sessions/` 以下の `*.json` | ファイルごと |

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
- ファイルが `consumed_bytes` より短くなったか、先頭 `min(4096, consumed_bytes)` バイトの SHA-256 が変わったら、書きかえとみなし、`generation` を上げた `sources` の行を作って先頭から読む。前の版の行は残す。
- 1ファイルを1つのトランザクションで取り込む。

### ファイルごとの取り込み

ファイルの中身を SHA-256 で `blobs` に入れ、パスごとの版を `file_versions` に記録する。同じパスで同じ中身は版を増やさない。

### 消えたファイル

`--mark-missing` を付けると、標準入力に無い取り込み済みのパスの `sources.missing_since` に時刻を入れる。行は消さない。再び取り込むと NULL に戻る。

### データベース

- 場所：`--db`、`AI_CHAT_LOGS_DB`、`${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite` の順（環境変数は `.env` から読んだものを含む）。
- 権限 `0600` で作る。`journal_mode=WAL`、`busy_timeout=10000`。
- スキーマは `schema/NNNN-<名前>.sql` を順に当てる。当てた数を `PRAGMA user_version` に持つ（現在は1）。

| 表・ビュー | 中身 |
|---|---|
| `sources` | 取り込んだファイル（種類、提供元（種類の `/` より前の生成列）、パス、`generation`、取り込み済みのバイト数と行数、先頭のハッシュ、大きさ、更新時刻、最初と最後に見た時刻、見つからなくなった時刻） |
| `records` | JSONL の1行（`raw`）と、抽出した `type`、`uuid`、`session_id`、`timestamp` |
| `blobs` | ファイルの中身（SHA-256 で重複を除く） |
| `file_versions` | ファイルごとの種類の、パスと中身の版 |
| `runs` | 実行ごとの開始・終了の時刻、件数、失敗（JSON の配列） |
| `messages`（ビュー） | 会話のメッセージ。いまは `claude-code/transcript` の `user` と `assistant` のレコード（提供元、セッションID、`uuid`、親の `uuid`、時刻、役割、モデル、サイドチェーンか、`cwd`、内容、元のパス） |

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

## 破棄したADR

なし
