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
| `claude-ai-export-scan`（`src/cli/claude-ai-export-scan.ts`） | なし | 受け取り用のディレクトリの新しい claude.ai のエクスポートを変換し、出力先を1行ずつ書く（[ADR 0010](adr/0010-scan-downloads-for-claude-ai-exports.md)） |
| `codex-log-convert`（`src/cli/codex-log-convert.ts`） | 設定したログディレクトリ | Codex の原本と変換 JSONL を保存する |
| `codex-log-sources`（`src/cli/codex-log-sources.ts`） | 設定した保存先 | Codex の `<種類><タブ><絶対パス>` を列挙する |
| `bin/sync` | なし | claude.ai のスキャン、Codex の変換、全提供元の列挙、取り込みを行う。列挙に失敗したら取り込まず、スキャンや変換の部分失敗では残りを取り込み、最後に1を返す |

`chat-log-import` は、失敗が1つでもあれば終了コード1で終わる。不明な種類の行も失敗とする。

### 種類と提供元

種類の名前は `<提供元>/<種類>`。提供元は履歴を書くツールの名前で、いまは `claude-code`、`claude-desktop`、`claude-cowork`、`claude-ai`、`codex`（[ADR 0006](adr/0006-import-cowork-and-claude-ai-chats.md)、[ADR 0034](adr/0034-import-codex-rollouts.md)）。
列挙は提供元ごとのコマンド（`claude-log-sources`、`codex-log-sources`）、取り込みは提供元に依存しない `chat-log-import` が行う。
提供元を足すときは、列挙のコマンド、`src/kinds.ts` の種類、行ごとの種類の抽出の関数（`src/extract.ts`）、本文、ツール、会話の各ビューの対象を追加する。表は変えない。

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

### Codex の原本と変換

[ADR 0034](adr/0034-import-codex-rollouts.md)

- `AI_CHAT_LOGS_CODEX_DIR` の `sessions` と `archived_sessions` 以下の通常ファイル `*.jsonl` を再帰的に読む。シンボリックリンクは辿らない。存在しないディレクトリは空、読めないものは失敗にする。
- 完成した改行までのバイト列を SHA-256 の64桁で識別し、`AI_CHAT_LOGS_CODEX_STORE/<hash>/` に原本、`messages-v1.jsonl`、`manifest-v1.json` を保存する。一時ディレクトリから rename して公開し、ディレクトリは0700、ファイルは0600で保持する。
- 先頭の `session_meta.payload.id` が会話 ID。後続のメタデータや `payload.session_id` で切り替えない。親から継承された履歴もそのファイルの記録として残す。
- 変換行は `codex/conversation`、原本の行は `codex/rollout`。前者は既存と同じ `type`、`uuid`、`sessionId`、`timestamp`、`message` を持つ。元の位置は `sourceOrder` と `openai` に保持する。
- user と assistant のテキスト、公開された reasoning summary、ツールの入出力、agent_message を変換する。event_msg を本文に加えない。system と developer や補助情報は原本だけに残す。
- uuid は提供元、会話 ID、元の項目 ID、表示内容、role、親 ID、ブロックの種類を正規化した JSON の SHA-256。パスと取り込み時刻は含めない。元 IDが無い場合は物理行番号を使う。同文でも元 IDが異なれば別項目、内容が変われば別の版になる。
- 未知の型と暗号化は警告として原本に残す。壊れた JSONや先頭の会話 ID の欠落は変換の終了コード1とし、正常な独立入力は続ける。末尾の未完行は次回に回す。
- 同じ入力は再利用する。伸びたログは全体の新しいスナップショットとして保持する。自動削除や差分だけの保存はしない。

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
- スキーマは `schema/NNNN-<名前>.sql` を順に当てる。当てた数を `PRAGMA user_version` に持つ（現在は7）。

| 表・ビュー | 中身 |
|---|---|
| `sources` | 取り込んだファイル（種類、提供元（種類の `/` より前の生成列）、パス、`generation`、取り込み済みのバイト数と行数、先頭のハッシュ、大きさ、更新時刻、最初と最後に見た時刻、見つからなくなった時刻） |
| `records` | JSONL の1行（`raw`）と、抽出した `type`、`uuid`、`session_id`、`timestamp`、`payload_state`（ペイロードの処理の状態。下の「ペイロード」） |
| `payloads` | `raw` から抜き出した大きな文字列（ペイロード）。リテラルの SHA-256、バイト数、`encoding`（`zstd` か `base64`）、中身（[ADR 0031](adr/0031-store-large-strings-as-compressed-payloads.md)） |
| `blobs` | ファイルの中身（SHA-256 で重複を除く） |
| `file_versions` | ファイルごとの種類の、パスと中身の版 |
| `runs` | 実行ごとの開始・終了の時刻、件数、失敗（JSON の配列） |
| `record_texts` | 会話の本文の全文検索（FTS5、`trigram`）。`rowid` は `records.rowid` |
| `session_summaries` | セッションの要約（提供元、セッションID、`cwd`、タイトル、最初と最後の時刻、メッセージの数） |
| `record_text_source`（ビュー） | 本文の取り出しの規則 |
| `record_tool_texts` | ツールのテキストの全文検索（FTS5、`trigram`）。`rowid` は `records.rowid`。`chat-log search --tools` が使う（[ADR 0021](adr/0021-search-tool-inputs-and-results.md)） |
| `record_tool_text_source`（ビュー） | ツールのテキストの取り出しの規則：`tool_use` は名前と `input` の JSON、`tool_result` は文字列の `content`、配列なら `text` のブロックだけ（画像などは入れない） |
| `copied_records`（ビュー） | 別のファイルに写された、同じ提供元・セッション・`uuid` のレコードのうち、2つ目以降のもの |
| `session_messages`（ビュー） | セッションのメッセージ（写しを除く。写しの規則は `copied_records` と同じものを、索引で覆えるように直接書く。[ADR 0017](adr/0017-faster-message-numbers-for-search-hits.md)） |
| `session_summary_source`（ビュー） | 要約の作り方 |
| `messages`（ビュー） | 会話のメッセージ。`claude-code/transcript`、`claude-cowork/transcript`、`claude-ai/conversation`、`codex/conversation` の `user` と `assistant` のレコード（提供元、セッションID、`uuid`、親の `uuid`、時刻、役割、モデル、サイドチェーンか、`cwd`、内容、元のパス） |

- `records` の索引：`(session_id, timestamp)`、`(session_id, type, timestamp, uuid, source_id, line_no)`、`(uuid, session_id, source_id, line_no)`。後ろの2つで、セッションのメッセージの選び出しと写しの判定を、`records` の本体を読まずに行う（`type` と `uuid` は `raw` の後ろの列で、読むと `raw` のオーバーフローのページをたどるため。[ADR 0017](adr/0017-faster-message-numbers-for-search-hits.md)）。

### スキーマ 7 の会話識別

[ADR 0033](adr/0033-codex-conversation-database-migration.md)

- スキーマ 7では会話用のビューに `codex/conversation` を加える。`codex/rollout` は原本の保存用で、会話、件数、本文検索、ツール検索の対象にしない。
- マイグレーションは既存の表、rowid、FTS5 索引、要約を保持し、ビューとスキーマ版を1トランザクションで変更する。失敗時は版6の状態に戻る。
- 会話を開く、ページを読む、件数と検索番号を求める、書き出す処理には、`provider` と `session_id` の組を渡す。保存済みの IDは書き換えない。
- `show` と `export` の候補も提供元と IDの組とする。`--provider` を省略したときに複数の組が一致すれば終了コード2で候補を示し、1組なら取得する。
- Codex の順序は、時刻、最上位の `sourceOrder`、uuid の順。時刻なしは空文字列として比較する。既存の提供元の順序は変えない。
- Codex の写し判定では種類も一致させ、原本と変換行が同じ uuidでも変換行を除外しない。`copied_records` と `session_messages` に同じ条件を使う。既存提供元の判定は維持する。
- Codex の `openai.itemId` と `openai.version` を会話表示と Markdownで示し、同じ元 IDの異なる保存版を区別する。
- GUI と CLIは版7を要求する。移行後の旧バイナリ使用は保証しない。バックアップと復元の手順は READMEに記載する。

### ペイロード

[ADR 0031](adr/0031-store-large-strings-as-compressed-payloads.md)

- 取り込んだ行の JSON の文字列のうち、リテラル（両端の `"` とエスケープを含む、`raw` の中のバイト列）が 1024 バイト以上で、SQL が読む場所に無いものを `payloads` に移す。SQL が読む場所：最上位のメンバーの値、`$.message` の直下のメンバーの値、`$.message.content[*]` の `type`、`text`、`thinking`。`tool_result` の `content`、`tool_use` の `input` の中の文字列、画像の `data`、思考の `signature` などは移る。オブジェクトのキーは移さない。
- `payloads` の行はリテラルの SHA-256 で重複を除く。`base64`：リテラルが標準の base64（`=` の埋めを含み、改行もエスケープも無い）だけで、復号して符号化しなおすと同じになるもの。中身は復号したバイナリ。`zstd`：それ以外。中身はリテラルを zstd（レベル3）で圧縮したもの。消さない。
- `raw` のリテラルは、目印のリテラル `"\u0000ai-chat-logs-payload:<sha256>"` に置きかえる。置きかえた後も正しい JSON である。戻すときは目印を文字列として置きかえるので、取り込んだ行とバイト単位で同じになる。取り込みでは、戻したものが元の行と同じになることを確かめ、同じでなければ移さない。正しい JSON でない行と、元から `\u0000ai-chat-logs-payload:` を含む行からは移さない。
- `payload_state`：`NULL` はまだ処理していない、`0` は移したものが無い、`1` は `raw` に目印がある。
- 取り込みでは、行を元のまま入れて索引と要約を作った後に、同じトランザクションの中で移す。`chat-log-import` は取り込みの後に、`payload_state` が `NULL` の行（スキーマ 6 より前に取り込んだもの）を、1万行ずつのトランザクションで移す。
- `chat-log` と GUI は、`raw` を JSON として読む前に、`payload_state` が `1` なら戻す。本文と思考は移らないので、検索の一致した種類の判定（`matched_in`）は戻さずに読む。
- SQL で `raw` を直に読むと（`sqlite3` や `messages` のビュー）、移した文字列は目印として見える。
- 移して空いたページは SQLite の空きページとして残り、次からの取り込みで使いまわされる。ファイルを縮めるには、取り込みを止めて `VACUUM` を実行する。

### 検索の索引とセッションの要約

[ADR 0003](adr/0003-tauri-log-viewer-with-search.md)、[ADR 0005](adr/0005-log-viewer-corrections-and-details.md)

- 会話の種類：`claude-code/transcript`、`claude-cowork/transcript`、`claude-ai/conversation`、`codex/conversation`。
- 本文：会話の種類の `user` と `assistant` のレコードの、文字列の `message.content`、または `text` と `thinking` のブロックを改行でつないだもの。`tool_use` と `tool_result` は入れない。空なら入れない。
- 写し：同じ提供元・セッションID・`uuid`（Codex は種類も一致）のレコードが複数のファイルにあれば、パス、`generation`、行番号の順で最初のものだけを、会話・検索・要約で使う。`uuid` の無いレコードは除かない。`records` と `record_texts` からは消さない。
- 要約：メッセージが1つ以上あるセッションだけ。`first_at`・`last_at` はメッセージの時刻の最小と最大、`cwd` は時刻の順で最初のもの。
- タイトル：最後の `custom-title`（パスと行番号の順）、無ければセッションのファイルの最新の版の `title`（`cliSessionId` で対応。`claude-code` は `claude-desktop/session`、`claude-cowork` は `claude-cowork/session`）、無ければ最初の `isMeta` でない `user` の本文の先頭80文字。
- 行を取り込むたびに、増えた行の本文とツールのテキストを索引に足し、増えた行のセッションの要約を作りなおす。デスクトップアプリのセッションの版が増えたら、その `cliSessionId` のセッションの要約を作りなおす。

### claude.ai のエクスポートの変換

[ADR 0006](adr/0006-import-cowork-and-claude-ai-chats.md)

- `claude-ai-export-convert <zip | ディレクトリ | conversations.json>`。zip は `unzip` で展開する。`conversations.json` は入力の直下か、その1段下から探す。
- 出力先は `$AI_CHAT_LOGS_CLAUDE_AI_DIR/<conversations.json の SHA-256 の先頭16文字>/`。`conversations.json`、`projects.json`、`users.json`（あるもの）を写し、`messages.jsonl` を書く。既にあるファイルは上書きしない。出力先を標準出力に書く。
- `conversations.json` が無い、JSON でない、配列でないときは、終了コード1で終わり、何も書かない。
- `messages.jsonl`：会話を `created_at`、`uuid` の順に、名前があれば `{"type":"custom-title","customTitle","sessionId"}` の行、続けて各メッセージを `{"type","uuid","parentUuid","sessionId","timestamp","message":{"role","content"},"claudeAi":{"conversation","sender","attachments","files"}}` の行にする。`sender` が `human` なら `user`。`content` が空なら `text` から1つのテキストのブロックを作る。

### ダウンロードしたエクスポートの自動の変換

[ADR 0010](adr/0010-scan-downloads-for-claude-ai-exports.md)

- 受け取り用のディレクトリ：`AI_CHAT_LOGS_CLAUDE_AI_INBOX`（環境変数、`.env`、設定ファイル）、無ければ `~/Downloads`。
- 直下の `*.zip` を名前の順に見る。中身の一覧（`unzip -Z1`）に、ルートか1段下の `conversations.json` があるものをエクスポートとみなす。
- `conversations.json` を展開せずに読み（`unzip -p`）、`<AI_CHAT_LOGS_CLAUDE_AI_DIR>/<SHA-256 の先頭16文字>/messages.jsonl` が既にあれば飛ばす。無ければ `claude-ai-export-convert` と同じ変換で置く（同じ階層の `projects.json`、`users.json` も写す）。
- zip ごとの失敗と、受け取り用のディレクトリを読めないこと（TCC の拒否を含む）は標準エラー出力に書き、終了コードを1にする。受け取り用のディレクトリが無ければ何もしない。zip は消さない。

## GUI

[ADR 0003](adr/0003-tauri-log-viewer-with-search.md)、[ADR 0005](adr/0005-log-viewer-corrections-and-details.md)

- `gui/`。Tauri 2、Rust（`rusqlite`）、TypeScript（フレームワークなし）、Tailwind CSS 4。
- アイコン：元は `gui/app-icon.svg`（暗い紺の角丸の正方形に、縦の時間軸と3本の記録の帯）。`gui/` で `bun run tauri icon app-icon.svg` を実行して作り、`tauri.conf.json` の `bundle.icon` が指すファイルと `icon.png` だけをコミットする（ほかのプラットフォーム向けのファイルはコミットしない。[ADR 0030](adr/0030-gui-app-icon.md)）。
- データベースは読み取り専用で開く。場所は `AI_CHAT_LOGS_DB`（環境変数、`.env`、設定ファイルの順。[ADR 0007](adr/0007-settings-and-setup-screen.md)）、無ければ `${XDG_DATA_HOME:-$HOME/.local/share}/ai-chat-logs/logs.sqlite`。見つからない、またはスキーマの版が7より古いときは、その旨を画面に出す。`raw` は、ペイロードを戻してから読む（[ADR 0031](adr/0031-store-large-strings-as-compressed-payloads.md)）。
- コマンド：`status`、`list_projects`（提供元と `cwd` ごと）、`list_sessions`（`provider`、`cwd`、`cwd_missing`、`offset`、`limit`。`last_at` の新しい順）、`get_messages`（`provider`、`session_id`、`from`、`limit`。写しを除いたメッセージに、時刻（`timestamp`）の順（同じ時刻は Codex では `sourceOrder`・uuid の順、既存の提供元ではパス・`generation`・行番号の順）で1始まりの番号を付け、番号が `from`〜`from + limit - 1` のものと、総数（`session_summaries` のメッセージ数）を返す。[ADR 0014](adr/0014-load-conversations-in-pages.md)、[ADR 0016](adr/0016-show-conversations-newest-first.md)）、`get_block`（`rowid`、ブロックの位置。全文）、`search`（`query`、`provider`、`cwd`、`cwd_missing`、`offset`、`limit`。時刻の新しい順。各件にメッセージの番号 `index`。番号は、1ページのヒットをセッションごとにまとめて1回で求める。[ADR 0017](adr/0017-faster-message-numbers-for-search-hits.md)）。
- トップページ（セッションを開く前の会話の欄）：`データベース: <パス>（<容量>）`。容量はデータベースの本体、`-wal`、`-shm` のファイルの大きさの合計で、`status` が返す（本体が無ければ無しで、パスだけを出す）。1000 を単位に B、KB、MB、GB、TB のうち値が 1000 未満になる最も大きい単位で、小数第2位まで（B は整数）。トップページを出すたびに読みなおす（[ADR 0025](adr/0025-gui-show-database-size.md)）。
- 会話の並び：メッセージを新しい順（番号の大きい順）に出す。いちばん上が最後のメッセージ。1つのメッセージの中のブロックの順は変えない（[ADR 0016](adr/0016-show-conversations-newest-first.md)）。
- 会話の読みこみ：1ページ100件。一覧から開くと最後の1ページ（`総数 − 99`〜総数。総数は一覧のメッセージ数で、読みこんだ結果の総数と違えばその総数で読みこみなおす）、検索の結果から開くと一致した番号 N の 50 件前から100件。会話の欄の下端の 600px 以内までスクロールすると古い1ページを下に、上端の 600px 以内までスクロールすると新しい1ページを上に足す（上に足したときは、見ていた位置を保つ）。読みこんだメッセージは DOM から外さない。別のセッションを開いたら、前のセッションの読みこみの結果は捨てる。
- 会話の欄の上端：読みこんだ範囲と総数（`<最初>〜<最後> / <総数>`）と「表示」のメニューを、スクロールしても上端に残す。メッセージの並びの上に余白を置き、一番上でもメッセージに重ならない（[ADR 0024](adr/0024-gui-conversation-header-and-block-filter.md)）。
- 書き出し：会話の欄の上端の「書き出す」ボタン（セッションを開いているときだけ押せる）で保存先を選ぶと（既定のファイル名は `<タイトル>.md`。`/` と `:` は `-`、タイトルが無ければセッションID）、`<AI_CHAT_LOGS_REPO>/src/cli/chat-log.ts export <セッションID> --provider <提供元>` を取り込みと同じ環境で `bun` で実行し、標準出力を保存先と同じディレクトリの一時ファイルに書いてから置きかえる。失敗したら一時ファイルを消し、終了コードと標準エラー出力の最後の20行を出す（[ADR 0026](adr/0026-export-sessions-and-highlight-terms.md)）。
- 検索の語句の強調：検索の結果から開いた会話では、そのときの検索の語句（空白で分けたもの）を、テキストと開いた思考の本文（コードブロックの中を含む）で `<mark>` で強調する。ASCII の大文字と小文字を区別せず、重なる・隣りあう一致は1つにまとめる。ツールのブロックと見出しは強調しない。一覧から開いたときは強調しない（[ADR 0026](adr/0026-export-sessions-and-highlight-terms.md)）。
- 「表示」のメニュー：thinking、tool_use、tool_result のチェックボックス（既定ですべて入る）。外した種類のブロックを隠し、出すブロックが無くなったメッセージは見出しごと隠す（ブロックの無いメッセージは隠さない。番号は変えない）。テキストと「その他」のブロックは隠せない。検索の結果から開いて強調するメッセージは、メッセージも中のブロックも隠さない。状態は WebView の `localStorage`（`ai-chat-logs:shown`）に保存し、読めなければすべて入った状態にする（[ADR 0024](adr/0024-gui-conversation-header-and-block-filter.md)）。
- プロジェクトの絞り込み：Claude Code と Codex は `cwd` ごと、ほかの提供元は提供元ごとに1項目。
  一覧と検索の結果には、Claude Code を含むすべての提供元の名前を出す。
- 閲覧の画面の、プロジェクトの絞り込みの下に「ダウンロードしたエクスポートを取り込む」（[ADR 0010](adr/0010-scan-downloads-for-claude-ai-exports.md)）。コマンド `scan_claude_ai_exports` で `claude-ai-export-scan` と `bin/sync` を実行し、結果（取り込んだ件数、新しいものが無い旨、失敗と終了コード）を短く出し、詳しい出力を折りたたんで出す。終わったらプロジェクトの絞り込み（選択は保つ）とセッションの一覧を読みなおし、開いている会話はそのままにする。ボタンの `title` に受け取り用のディレクトリを出す。
- 検索：空白で区切った語のうち、3文字以上の語は二重引用符で囲んだ FTS5 の語として AND でつなぎ、3文字未満の語は `LIKE`（`%`、`_`、`\` をエスケープ）で絞る。抜粋は、FTS5 の `snippet()`、3文字未満の語だけのときは本文から最初の一致の前後32文字を切り出したもの。強調は U+E000 と U+E001 で囲む。
- `get_messages` のブロックのうち、`thinking`、`tool_use`、`tool_result`、その他の本文は、4,000 文字を超えたら先頭の 4,000 文字と元の文字数を返す。
- 画面：本文はプレーンテキスト。` ``` ` で囲まれた部分だけ等幅にする。`thinking`、`tool_use`、`tool_result`、サイドチェーンのレコードは折りたたみ、開いたときに中身を組み立てる。文字列は HTML として解釈させない。

### Codex の表示

[ADR 0032](adr/0032-codex-import-ui-and-provider-labels.md)

- 一覧、検索結果、ヘッダーの表示名は Claude Code、claude.ai、Cowork、Codex。未知の提供元は内部識別子を表示する。タイトルは書き換えない。
- Codex の選択肢は作業ディレクトリ単位。`cwd_missing` が真なら値なしの会話だけを選ぶ。偽または省略は従来どおりで、非 NULL の `cwd`と同時に真を指定した場合は入力エラーにする。
- 取り込みはGUI 全体で同時に1件だけ。画面切り替え後も排他を維持する。環境の検査だけでは入力、設定、DBを変更しない。

## 定期実行

[ADR 0002](adr/0002-periodic-sync-with-pm2.md)

- `ecosystem.config.cjs` に、pm2 のアプリ `ai-chat-logs-sync` を1つ定義する。`bin/sync` を `/bin/sh` で実行し、`autorestart: false`、`cron_restart` は `AI_CHAT_LOGS_CRON`（`.env` から読んだものを含む。既定は `0 */4 * * *`。[ADR 0029](adr/0029-sync-every-four-hours-by-default.md)）。
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
- GUI の管理画面が書くのは設定ファイルだけ。項目は `AI_CHAT_LOGS_DB`、`CLAUDE_CONFIG_DIR`、`AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR`、`AI_CHAT_LOGS_CLAUDE_AI_DIR`、`AI_CHAT_LOGS_CLAUDE_AI_INBOX`、`AI_CHAT_LOGS_CODEX_DIR`、`AI_CHAT_LOGS_CODEX_STORE`、`AI_CHAT_LOGS_REPO`、`AI_CHAT_LOGS_BUN`。
- 書き方：`名前="値"`（`\` と `"` を逃がす）。改行を含む値は保存しない。最初の行を書きかえ、同じ名前の2行目以降を消す。空の値で保存するとその名前の行を消す。ほかの行は残す。一時ファイルから名前を変えて置きかえる。
- `AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR`（既定は `~/Library/Application Support/Claude`）は、CLI の列挙でも使う。`AI_CHAT_LOGS_REPO`（既定は GUI をビルドしたリポジトリ）と `AI_CHAT_LOGS_BUN` は GUI だけが使う。
- GUI の `bun` の探し方：`AI_CHAT_LOGS_BUN`、`PATH`、`~/.bun/bin/bun`、`~/.local/share/mise/shims/bun`、`/opt/homebrew/bin/bun`、`/usr/local/bin/bun` の順で、最初に実行できるもの。

### Codex の設定

[ADR 0032](adr/0032-codex-import-ui-and-provider-labels.md)

- `AI_CHAT_LOGS_CODEX_DIR` の既定は `~/.codex`、`AI_CHAT_LOGS_CODEX_STORE` の既定は `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/codex`。CLI と GUI は同じ優先順位で解決する。
- GUI は新しい2項目を、既存と同じ設定行と環境の検査に追加する。上位の設定による上書きを表示し、空欄保存では設定ファイルのキーだけを除く。


## 管理画面

[ADR 0007](adr/0007-settings-and-setup-screen.md)

- 画面の上の「閲覧」と「管理」で切りかえる。データベースが開けないときは、起動時に「管理」を開く。
- コマンド：`get_settings`、`save_setting`（`key`、`value`。保存後にデータベースを開きなおす）、`check_environment`、`run_sync`、`import_claude_ai_export`（`zip`）。
- 環境の検査は読むだけ。pm2 は `bun` の隣、`PATH`、`~/.bun/bin`、`~/.cache/.bun/bin` から探し、`bun` で `pm2 jlist` を実行して `ai-chat-logs-sync` の登録を調べる。launchd は `~/Library/LaunchAgents/pm2.*.plist` の有無を見る。
- 取り込み：`/bin/sh <リポジトリ>/bin/sync`。claude.ai のエクスポート：ファイルを選ぶ画面（`tauri-plugin-dialog`）で zip を選び、`bun <リポジトリ>/src/cli/claude-ai-export-convert.ts <zip>` の後に取り込みを実行する。どちらも `PATH` の先頭に `bun` のディレクトリを足し、CLI が使う設定を環境変数で渡す。同時に1つだけ実行する。終わったら、終了コードと出力の最後の20行を出し、データベースを開きなおす。

## AI 向けの CLI（chat-log）

[ADR 0011](adr/0011-cli-for-ai-agents.md)、[ADR 0013](adr/0013-chat-log-output-corrections.md)、[ADR 0018](adr/0018-chat-log-snippets-until-and-help.md)、[ADR 0019](adr/0019-chat-log-thinking-around-hits.md)、[ADR 0020](adr/0020-chat-log-mark-omitted-messages.md)、[ADR 0021](adr/0021-search-tool-inputs-and-results.md)、[ADR 0022](adr/0022-search-exclude-terms.md)、[ADR 0023](adr/0023-chat-log-around-navigation-lines.md)

- `chat-log <context | sessions | search | show | export>`。読み取り専用。データベースの場所は取り込みと同じ規則。スキーマの版が7より古ければ終了コード2（[ADR 0033](adr/0033-codex-conversation-database-migration.md)）。
- 共通のオプション：`--provider`、`--cwd`（そのディレクトリか、その下。既定で絞るのは `context` だけ）、`--all`（`context`）、`--since`・`--until`（ISO 8601 か `7d`・`12h`・`30m`。日付だけは UTC の 0 時、オフセットの無い時刻は手元の時刻帯。`search` はメッセージの時刻、`sessions` と `context` は `--since` を最後の時刻・`--until` を最初の時刻と比べる。`show` には効かない）、`--limit`、`--offset`、`--max-chars`（0 で切らない）、`--json`（JSON Lines）。
- `sessions`：`<最後の時刻>\t<提供元>\t<IDの先頭8文字>\t<メッセージ数>\t<タイトル>\t<cwd>`。新しい順。既定 50 件。
- `search <語...>`：GUI と同じ検索の規則（3文字以上は FTS5、3文字未満は `LIKE`、写しは除く）。1件2行（`<時刻>\t<提供元>\t<ID>#<番号>\t<役割>\t<タイトル>`、`\t<抜粋>`）。抜粋は本文から作り、語ごとに最初に一致した位置の前後32文字を切り出して、重なる・隣りあう範囲をまとめ、一致を切らないように広げ、範囲のあいだと切ったところに `…` を置く（どの語も見つからなければ先頭の64文字）。範囲の中のすべての一致を `⟪ ⟫` で囲み、重なる・隣りあう強調は1つにまとめる。思考にだけ一致したときは抜粋の先頭に `[thinking] `。`--tools` を付けると `record_tool_texts` も探し、本文かツールのテキストのどちらかがすべての語を含むレコードを出す（両方に一致すれば本文の一致とする）。ツールにだけ一致したときは、抜粋をツールのテキストから作り、先頭に `[tool] `。`--exclude <語>`（何度でも）は、一致したテキストにどれかの除く語を含むものを除く（3文字以上は FTS5、3文字未満は `NOT LIKE`。抜粋では強調しない。語が無ければ終了コード2）。`--json` の `matched_in`（ツールにだけ一致したときは `["tool"]`）。既定 20 件。
- `show <セッションID>`：先頭8文字以上で一意なら可。番号はセッションの中の通し番号（写しを除き、時刻の順。同じ時刻は Codex では `sourceOrder`・uuid の順、既存の提供元ではパス・`generation`・行番号の順。[ADR 0016](adr/0016-show-conversations-newest-first.md)）。本文はテキストだけ。思考は `--thinking`（本文が空の思考は出さない）、ツールの全文は `--tools`（既定は1行・200文字）。テキストでないブロックは `[<種類>]`、200文字以上の base64 は `[base64 N 文字]`。表示するものが無いメッセージはテキストの出力で省き（番号は詰めない）、続けて省いたものごとに「（#<番号> は省いた：<理由>）」（複数なら「#<最初>〜#<最後>」）の1行を出す。理由は、本文のある思考を `--thinking` が無いために出さなかったものを含めば「思考だけ。--thinking で出す」、そうでなければ「表示する本文が無い」。`--around N` は N を含む `--limit` 件（N の前に半分。`--limit` が無ければ 10 件）、範囲のメッセージの思考も `--thinking` なしで出す。続きは「（続き：#<次> から。--offset <数> で出す）」、`--around` で前があれば「（前：#<a>〜#<範囲の最初 − 1> は --offset <a − 1> で出す）」（`a` は範囲の最初から `--limit` 件前。1 より小さければ 1）。`--around` で `--limit 1` のときは、前と続きの行を出さない。既定 50 件、2000 文字。
- `export <セッションID>`：1つのセッションの写しを除いた全メッセージを、番号の順に Markdown で標準出力に書く（[ADR 0026](adr/0026-export-sessions-and-highlight-terms.md)）。先頭にタイトル（無ければセッションID）の見出しと、セッションID・提供元・cwd（あれば）・期間・件数の箇条。各メッセージは `## #<番号> <役割> <時刻>`（モデルがあれば続けて、サブエージェントは末尾に `(サブエージェント)`）。テキストはそのまま、思考は `<details><summary>thinking</summary>` の中に引用で、`tool_use` は `<details><summary>tool_use: <名前></summary>` の中に整形した JSON のコードブロックで、`tool_result` は `<details><summary>tool_result</summary>`（エラーは `tool_result（エラー）`）の中にコードブロックで、その他は `[<種類>]`。切らないが、200文字以上の base64 は `[base64 N 文字]`。コードブロックの囲みは、中身のバッククォートの最長の連続より1つ長く（3つ以上）。本文が空の思考と、書くものが無いメッセージは書かない。`--provider` で提供元を選べる。`--cwd`、`--since`、`--until`、`--limit`、`--offset`、`--max-chars`、`--json` は終了コード2。
- `context`：既定で実行したディレクトリのセッション 5 件と、それぞれの最後のテキストのメッセージ 4 件（500 文字）。
- 終了コード：0 成功（0件を含む）、1 セッションが無い、2 セッションを区別できない・使い方の誤り・データベースが無い・古い・設定の書式の誤り。出力先のパイプが閉じられて書けなかったとき（`EPIPE`。`| head` など）は、標準エラー出力に何も書かず 0 で終わる（[ADR 0027](adr/0027-chat-log-quiet-on-closed-pipe.md)）。

## インストール

[ADR 0008](adr/0008-install-compiled-commands.md)

- `bin/install [<インストール先>]`（既定は `~/.local/bin`）。`claude-log-sources`、`chat-log-import`、`claude-ai-export-convert`、`claude-ai-export-scan`、`codex-log-convert`、`codex-log-sources`、`chat-log` を `bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig` で実行ファイルにし、`ai-chat-logs-sync` を写す。置いたファイルのパスを1行ずつ標準出力に書く。一時ファイルから名前を変えて置きかえる。
- リポジトリの絶対パスを `--define AI_CHAT_LOGS_REPO_AT_BUILD=...` で埋めこむ（環境変数 `AI_CHAT_LOGS_REPO_AT_BUILD` で変えられる）。実行ファイルの `.env` の既定の場所は、埋めこんだリポジトリの `.env`。
- `ai-chat-logs-sync`：同じディレクトリの `claude-ai-export-scan` と `codex-log-convert` を実行してから、`claude-log-sources` と `codex-log-sources` の全出力を受けて `chat-log-import --mark-missing` に渡す。引数は `chat-log-import` に渡す。スキャンや変換が失敗しても続け、最後に終了コード1を返す。

## ADR の保護

[ADR 0009](adr/0009-update-adr-guard-to-v0-8-2.md)、[ADR 0012](adr/0012-update-adr-guard-to-v0-8-3.md)、[ADR 0028](adr/0028-update-adr-guard-to-v0-10-0.md)

- コミット済みの ADR の変更は、adr-guard で拒否する。pre-commit の hook（`.githooks/pre-commit`）は `adr-guard pre-commit --allow-status --allow-links`、CI の `adr` ジョブは `tett23/adr-guard@v0.10.0`（`allow-status: true`、`allow-links: true`）。CI は ADR の番号の重複も検査する（`adr-guard check-numbers`）。
- 許可するのは、ステータスの行の変更と、リンクだけの変更（リンクの追加・削除・リンク先の変更、画像のリンク先、リンクの参照定義の行）。リンクのテキスト、画像の追加・削除、自動リンクや本文の URL の変更は拒否する。
- ADR のステータスには、`採択（未実装）`（採択したが、まだ実装していない）を使える。`adr-guard unimplemented` で一覧できる。
- ADR の参照（`ADR NNNN`）の直前に空白1つで置いた語は修飾子とみなされる。`/` を含む語はディレクトリ、`-` を含む語はモジュール（`docs/<モジュール>/adr/`）を表し、そのディレクトリや ADR が無ければ検査で失敗する。ほかのリポジトリの ADR は、リンクのテキストごと外部リンクにして書く（例：`[tett23/adr-guard ADR 0019「…」](https://github.com/tett23/adr-guard/blob/main/docs/adr/…)`）。

## 破棄したADR

なし

## Codex の毎時収集

[ADR 0036](adr/0036-codex-hourly-collection.md) に従い、全提供元の4時間ごとの取り込みとは別に、既定で毎時30分に Codex を収集する。専用ジョブは変換後に Codex の入力だけを列挙し、列挙に成功した場合だけ取り込む。変換に失敗しても公開済みの入力を取り込み、失敗を終了コードで知らせる。専用ジョブでは行方不明の入力を判定しない。
