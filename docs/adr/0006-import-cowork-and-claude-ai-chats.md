# ADR 0006: Cowork と claude.ai の会話を取り込んで検索する

ステータス: 採択

## 文脈

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) は Claude Code の履歴だけを取り込み、claude.ai（Web とデスクトップアプリのチャット）の会話は「手元にデータが無い」として対象外にした。
利用者から、Claude Code 以外の会話も取り込んで検索できるようにしたいと求められた。

2026-10-15 時点で、手元（macOS）を調べた結果は次のとおり。

### Cowork（デスクトップアプリのローカルのエージェントモード）

`~/Library/Application Support/Claude/local-agent-mode-sessions/<ID>/<ID>/` に、セッションごとに次がある（3セッション、計 6MB）。

| 場所 | 中身 |
|---|---|
| `local_<ID>.json` | セッションの属性。`title`、`cliSessionId`、`model`、`createdAt` など。Code タブの `claude-code-sessions/` の JSON と同じ形 |
| `local_<ID>/.claude/` | このセッション専用の Claude Code の設定ディレクトリ。`projects/<プロジェクト>/<cliSessionId>.jsonl` に、Claude Code と同じ形式の記録がある（`user`、`assistant`、`attachment` など。キーも同じ） |
| `local_<ID>/audit.jsonl` | 監査の記録。SDK のストリームの形式（`type`、`uuid`、`session_id`、`message`、`_audit_timestamp`、`_audit_hmac`）。`session_id` は `cliSessionId` ではなく `local_` の後ろの ID |
| `local_<ID>/uploads/`、`outputs/` | 利用者が渡したファイルと、作られたファイル。会話の記録ではない |
| `memory/`、`rpm/`、`cowork-*.json`、`scheduled-tasks.json` | 記憶、プラグイン、キャッシュ、予定のタスク。会話の記録ではない |

`.claude/` は Claude Code の設定ディレクトリなので、Claude Code と同じく古い記録が消される可能性がある。

### claude.ai のチャット

会話の本体はサーバーにある。
手元にあるのは、デスクトップアプリの `IndexedDB/https_claude.ai_0.indexeddb.leveldb`（4.6MB）などのキャッシュだけである。
キャッシュは形式が公開されておらず（LevelDB と Chromium の直列化）、開いたことのある会話の一部しか入っていない。

公式の手段として、claude.ai の設定（Privacy → Export data）からデータをエクスポートできる。
エクスポートはメールで届く zip で、`conversations.json`（会話とメッセージの配列）、`projects.json`、`users.json` を含む。
`conversations.json` の各会話は `uuid`、`name`、`created_at`、`updated_at`、`chat_messages` を持ち、各メッセージは `uuid`、`sender`（`human` か `assistant`）、`text`、`content`（`text`、`thinking`、`tool_use`、`tool_result` などのブロックの配列）、`created_at`、`attachments`、`files` を持つ。
この形式は公開の仕様ではなく、手元にまだ実物が無い。項目の欠けや増減に耐えるように読む。

エクスポートは、そのときまでのすべての会話を含む。
繰り返しエクスポートすると、同じ会話とメッセージが何度も現れる。

## 実装すること

### 1. Cowork：定期的な取り込みに加える

`claude-log-sources` が、デスクトップアプリのディレクトリの `local-agent-mode-sessions/` も列挙する。

| 種類 | 対象（`local-agent-mode-sessions/<ID>/<ID>/` からの相対） | 取り込み方 |
|---|---|---|
| `claude-cowork/transcript` | `local_<ID>/.claude/projects/` 以下の `*.jsonl`（`subagents/` を含む） | 行ごと・差分 |
| `claude-cowork/file` | `local_<ID>/.claude/projects/<プロジェクト>/<セッションID>/` 以下の JSONL 以外のファイル | ファイルごと |
| `claude-cowork/session` | `local_<ID>.json` | ファイルごと |
| `claude-cowork/audit` | `local_<ID>/audit.jsonl` | 行ごと・差分 |

- 上の表に無いもの（`uploads/`、`outputs/`、`memory/`、`rpm/`、キャッシュ、`.claude/` のほかのファイル）は取り込まない。
- `claude-cowork/transcript` の抽出の関数は、`claude-code/transcript` と同じ。
- `claude-cowork/audit` の抽出の関数は、`type`、`uuid`、`session_id`、`_audit_timestamp`（文字列のまま）を、`type`、`uuid`、`session_id`、`timestamp` に入れる。
- `claude-cowork/audit` は、記録を失わないために生のまま残すだけで、会話・検索・要約には使わない。同じ会話が `claude-cowork/transcript` にあり、両方を使うと二重になるため。

### 2. claude.ai：エクスポートを変換して取り込む

UNIX 哲学にしたがい、エクスポートの変換を別のコマンドにする。

| コマンド | 役割 |
|---|---|
| `claude-ai-export-convert <パス>` | エクスポートの zip、展開したディレクトリ、または `conversations.json` を受け取る。元のファイルを保存用のディレクトリに写し、メッセージを1行ずつの JSONL に変換して置く。置いたディレクトリを標準出力に書く |

- 保存用のディレクトリは `AI_CHAT_LOGS_CLAUDE_AI_DIR`、無ければ `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude-ai`。環境変数は [ADR 0004](0004-load-environment-from-dotenv.md) の `.env` からも読む。
- エクスポートごとに `<保存用のディレクトリ>/<conversations.json の SHA-256 の先頭16文字>/` を作り、次を置く。同じエクスポートを2回変換しても、同じディレクトリに同じ中身ができる（ファイルがあれば上書きしない）。
  - `conversations.json`、`projects.json`、`users.json`（エクスポートにあるものだけ。そのまま写す）
  - `messages.jsonl`（下の形式に変換したもの）
- zip は `unzip`（macOS に標準である）で一時ディレクトリに展開してから読む。

`claude-log-sources` は、保存用のディレクトリの次も列挙する。

| 種類 | 対象 | 取り込み方 |
|---|---|---|
| `claude-ai/conversation` | `*/messages.jsonl` | 行ごと・差分 |
| `claude-ai/export` | `*/conversations.json`、`*/projects.json`、`*/users.json` | ファイルごと |

`messages.jsonl` の形式（このツールが決める形式）：

- 会話を `created_at` の順（同じなら `uuid` の順）に、各会話について次の行を書く。
  1. 会話の `name` が空でなければ、`{"type": "custom-title", "customTitle": <name>, "sessionId": <会話の uuid>}`。
  2. `chat_messages` の各メッセージを、配列の順に1行ずつ。

```json
{
  "type": "user | assistant",
  "uuid": "<メッセージの uuid>",
  "parentUuid": "<parent_message_uuid があればそれ、無ければ null>",
  "sessionId": "<会話の uuid>",
  "timestamp": "<メッセージの created_at>",
  "message": { "role": "user | assistant", "content": [ ...ブロック ] },
  "claudeAi": {
    "conversation": { "uuid": "...", "name": "...", "created_at": "...", "updated_at": "..." },
    "sender": "<元の sender>",
    "attachments": [ ... ],
    "files": [ ... ]
  }
}
```

- `type` と `role` は、`sender` が `human` なら `user`、`assistant` なら `assistant`。ほかの値なら、その値をそのまま `type` に入れ、`role` は元の値にする。
- `content` は、元の `content` が空でない配列ならそのまま使う。無いか空なら、元の `text` を `[{"type": "text", "text": <text>}]` にする。
- `claudeAi` には、元の会話とメッセージの、上に挙げた項目をそのまま入れる。
- Claude Code の記録と同じ形にそろえることで、[ADR 0003](0003-tauri-log-viewer-with-search.md)・[ADR 0005](0005-log-viewer-corrections-and-details.md) の本文の取り出し、タイトル（`custom-title`）、写しの除去、GUI の会話の表示をそのまま使う。
- 元の `conversations.json` も `claude-ai/export` としてそのまま残すため、変換で落とした項目もデータベースから失われない。
- 何度もエクスポートして同じメッセージが複数の `messages.jsonl` にあっても、[ADR 0005](0005-log-viewer-corrections-and-details.md) の写しの除去（同じ提供元・セッション・`uuid`）で、会話・検索・件数には1回だけ出る。

`claude-ai/conversation` の抽出の関数は、`claude-code/transcript` と同じ。

### 3. 提供元と、ビューの枝

| 提供元 | 種類 |
|---|---|
| `claude-code` | 既存 |
| `claude-desktop` | 既存 |
| `claude-cowork` | `claude-cowork/transcript`、`claude-cowork/file`、`claude-cowork/session`、`claude-cowork/audit` |
| `claude-ai` | `claude-ai/conversation`、`claude-ai/export` |

マイグレーション `0003` で、ビューを作りなおす（`DROP VIEW` と `CREATE VIEW`）。

- 会話として扱う種類（以下「会話の種類」）を、`claude-code/transcript`、`claude-cowork/transcript`、`claude-ai/conversation` とする。`record_text_source`、`session_messages`、`messages` は、会話の種類のレコードを対象にする。
- タイトルの規則の2番目（デスクトップアプリのセッションの `title`）を、提供元 `claude-code` には `claude-desktop/session` を、提供元 `claude-cowork` には `claude-cowork/session` を対応させる。
- 取り込みの側：`claude-cowork/session` の版が増えたときも、その `cliSessionId` のセッション（提供元 `claude-cowork`）の要約を作りなおす。
- マイグレーションのときに、既存の行から `record_texts` と `session_summaries` を作りなおす（既存の行に新しい種類は無いが、ビューの定義が変わるため、要約は作りなおす）。

### 4. GUI

- `list_projects` は、提供元と `cwd` の組ごとのセッション数を返す。
- `list_sessions` と `search` は、`cwd` に加えて `provider`（任意）で絞れるようにする。`provider` だけを指定すると、その提供元のすべてのセッションになる。
- プロジェクトの絞り込みの一覧に、提供元ごとの項目（「claude.ai」「Cowork」）を出す。claude.ai のセッションは `cwd` が無い。
- セッションの一覧と検索の結果に、提供元が `claude-code` でないときは、提供元の名前（「claude.ai」「Cowork」）を小さく出す。

### ドキュメント

- README に、claude.ai のエクスポートの手順（設定からエクスポートを要求し、届いた zip を `claude-ai-export-convert` に渡す）を、「手動で行う作業」に書く。エクスポートは手動のため、定期的に繰り返す必要があることも書く。

## 実装しないこと

- claude.ai のキャッシュ（IndexedDB、Local Storage）の読み取り。形式が公開されておらず、一部の会話しか無いため。
- claude.ai への問い合わせ（非公式の API、ログインのクッキーの利用）。認証情報を扱うことになるため。
- エクスポートの自動化（メールの受信、ダウンロード）。
- `projects.json` のプロジェクトとの対応（会話をプロジェクトで絞ること）。`projects.json` は保存だけする。
- 添付ファイル（`attachments` の `extracted_content`）の検索。保存だけする。
- Cowork の `uploads/`、`outputs/` の取り込み。
- `claude-cowork/audit` を会話・検索に使うこと。

## テスト設計

### 列挙（`claude-log-sources`）

1. 一時ディレクトリの `HOME` に、Cowork のセッションの各ファイルを置くと、上の表の4種類が正しく出力され、`uploads/`、`outputs/`、`memory/`、キャッシュ、`.claude/` のほかのファイルは出力されない。
2. 保存用のディレクトリの `*/messages.jsonl` が `claude-ai/conversation`、`*/conversations.json` などが `claude-ai/export` として出力される。`AI_CHAT_LOGS_CLAUDE_AI_DIR` と `.env` が効く。
3. どちらのディレクトリも無いとき、エラーにならない。

### 抽出の関数

4. `claude-cowork/audit` の行から、`type`、`uuid`、`session_id`、`_audit_timestamp` が取り出される。
5. `claude-cowork/transcript` と `claude-ai/conversation` は、`claude-code/transcript` と同じ結果になる。

### 変換（`claude-ai-export-convert`）

6. 会話とメッセージの変換：`sender` から `type` と `role`、`content` があればそのまま、無ければ `text` から作る、`parent_message_uuid`、`claudeAi` の項目。
7. 名前のある会話だけ `custom-title` の行が出る。会話は `created_at`、`uuid` の順、メッセージは配列の順。
8. 項目の欠けに耐える：`chat_messages` が無い、`content` が空、`created_at` が無い、知らない `sender`、知らないブロックの種類。
9. zip、展開したディレクトリ、`conversations.json` の3通りの入力で、同じディレクトリに同じ中身ができる。同じ入力を2回変換しても、ファイルが変わらない。
10. `projects.json`、`users.json` があれば写し、無くてもエラーにならない。
11. `conversations.json` が無い、JSON として正しくない、配列でないときは、終了コード1で終わり、何も置かない。

### 取り込みと要約

12. Cowork：`claude-cowork/transcript` の本文が `record_texts` に入り、要約の提供元が `claude-cowork`、タイトルが `local_<ID>.json` の `title` になる。`claude-cowork/audit` の行は本文にも要約の件数にも入らない。
13. claude.ai：変換した `messages.jsonl` を取り込むと、要約の提供元が `claude-ai`、タイトルが会話の名前、件数がメッセージの数になる。
14. 同じ会話を含む2つのエクスポートを取り込んでも、要約の件数は1回分になる。
15. マイグレーション：版2のデータベースに当てると、ビューが新しい定義になり、既存の要約と本文が同じになる。

### GUI（`cargo test`）

16. `list_projects` が提供元を返す。`list_sessions` と `search` を `provider` だけ、`provider` と `cwd` で絞れる。
17. claude.ai の会話（`messages.jsonl` の形）を `get_session` で読むと、ブロックが正しく返る。

### 手で確かめること

1. 実際の Cowork のセッションが取り込まれ、GUI に「Cowork」として出て、検索できる。
2. 利用者が実際にエクスポートした zip を `claude-ai-export-convert` に渡して取り込み、GUI に「claude.ai」として出て、検索できる。形式が想定と違った場合は、ここで直す。

## トレードオフ

- claude.ai の会話はエクスポートが手動のため、自動では最新にならない。キャッシュや非公式の API を使えば自動にできるが、形式の不安定さと認証情報の扱いを避ける。
- 変換した `messages.jsonl` はこのツールの形式で、元の形式ではない。元の `conversations.json` も残すことで、変換の誤りがあっても後で変換しなおせる。
- `messages.jsonl` を Claude Code の記録と同じ形にそろえるため、claude.ai に固有の項目は `claudeAi` の下に押しこむ。ビューや GUI に claude.ai 専用の枝を作らずに済む。
- エクスポートを繰り返すと、データベースに同じメッセージが何度も入る。容量は増えるが、[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) の「生のまま失わずに残す」方針と、[ADR 0005](0005-log-viewer-corrections-and-details.md) の写しの除去で扱う。
- Cowork の `audit.jsonl` は会話の記録と重なるが、`.claude/` の記録が消された場合に備えて残す。

## 参考文献

- Claude のデータのエクスポート（Anthropic のヘルプセンター）：https://support.anthropic.com/en/articles/9450526-how-can-i-export-my-claude-ai-data
- Claude Code の設定（`CLAUDE_CONFIG_DIR`、`cleanupPeriodDays`）：https://code.claude.com/docs/en/settings
