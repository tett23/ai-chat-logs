# ADR 0001: Claude のチャット履歴を SQLite に取り込む

ステータス: 採択→Claude 以外の会話（Cowork と claude.ai）の取り込みは[ADR 0006](0006-import-cowork-and-claude-ai-chats.md)、bin/sync での claude.ai のエクスポートの自動の取り込みは[ADR 0010](0010-scan-downloads-for-claude-ai-exports.md)

## 文脈

Claude Code は、会話の履歴を手元の JSONL に書く。
既定では、最終更新から30日を過ぎたセッションの履歴を起動時に削除する（設定 `cleanupPeriodDays`）。
手元の `~/.claude/settings.json` にはこの設定が無いため、30日より古い履歴は失われていく。
履歴を検索・集計できる形で残すため、SQLite のデータベースに取り込む。

2026-10-14 時点で、手元の履歴は次の場所にある（macOS）。

| 場所 | 中身 | 規模 |
|---|---|---|
| `~/.claude/projects/<プロジェクト>/<セッションID>.jsonl` | セッションの記録。1行が1レコード（`user`、`assistant`、`attachment`、`system`、`custom-title`、`mode` など） | 184ファイル、合計 2.6GB（下の行を含む） |
| `~/.claude/projects/<プロジェクト>/<セッションID>/subagents/*.jsonl` | サブエージェントの記録。形式はセッションと同じ | 上の行に含む |
| `~/.claude/projects/<プロジェクト>/<セッションID>/` のその他のファイル | `tool-results/` の長いツール出力（`.txt`）、画像、PDF、`custom-title.json` など | 約530ファイル、27MB |
| `~/.claude/projects/<プロジェクト>/memory/` | Claude の記憶。会話の履歴ではない | — |
| `~/.claude/history.jsonl` | 入力したプロンプトの履歴（`display`、`timestamp`、`project`、`sessionId`） | 1ファイル |
| `~/Library/Application Support/Claude/claude-code-sessions/<ID>/<ID>/*.json` | デスクトップアプリの Code タブのセッションの属性（タイトル、作業ディレクトリ、モデル、`cliSessionId` など）。会話の本体は上の JSONL にある | 2.1MB |

JSONL のレコードの形は Claude Code の版ごとに増減する。
`assistant` のレコードには、`message` の下に API の応答（`content` の `text`、`thinking`、`tool_use` のブロック、`usage`、`model`）がある。
記録の途中のセッションでは、最後の行が書きかけのことがある。
大きなものでは、1ファイルが 2GB を超える（2,172,483,212 バイトの JSONL があった）。JavaScript の文字列の長さの上限（約 2^31 文字）を超えるため、ファイル全体を1つの文字列として読めない。

いまは Claude の履歴だけを取り込むが、将来、Claude 以外の AI のツール（Codex CLI、Gemini CLI など）の履歴も同じデータベースに入れられるよう、スキーマに余地を残す（利用者の指定）。
ほかのツールの履歴も、多くは JSONL などのファイルで手元にあるが、レコードの形はツールごとに異なる。

実装は Bun と TypeScript で行う（ゴールでの指定）。
SQLite には Bun に組み込みの `bun:sqlite` を使い、依存パッケージは入れない。

## 実装すること

### 方針：生のレコードを失わずに残す

レコードの形は版ごとに変わるため、取り込みの時点で正規化はしない。
JSONL の1行を、パースせずにそのままの文字列で保存する。
よく使う項目（種類、ID、セッションID、時刻）は、取り込みのときに種類ごとの関数で取り出して列に入れる。そのほかの項目はビューで引き出す。
元のファイルが書きかえられたり削除されたりしても、取り込み済みの行は消さない。

### 小さなツールに分ける

UNIX 哲学にしたがい、列挙と取り込みを別のコマンドにし、パイプでつなぐ。

| コマンド | 役割 |
|---|---|
| `claude-log-sources` | Claude の、取り込む対象のファイルを列挙し、`<種類><タブ><絶対パス>` の行を標準出力に書く |
| `chat-log-import --db <パス>` | 標準入力から `<種類><タブ><絶対パス>` の行を読み、データベースに差分を取り込む。件数の要約を標準エラー出力に書く。どの AI のものかには依存しない |
| `bin/sync` | 上の2つをつなぐシェルスクリプト。`claude-log-sources \| chat-log-import --db "$DB"` |

どのコマンドも `bun` で直接実行できるようにし、`package.json` の `bin` に登録する。

### Claude 以外の AI のための余地

- 種類の名前は `<提供元>/<種類>` とする。提供元は、履歴を書くツールの名前（`claude-code`、`claude-desktop`。将来は `codex`、`gemini-cli` など）。`sources.provider` は、種類の `/` より前を取る生成列にする。
- 表（`sources`、`records`、`blobs`、`file_versions`、`runs`）は提供元に依存しない形にする。提供元ごとに異なる解釈は、取り込みの側の種類ごとの抽出の関数と、ビューに閉じこめる。
- 列挙は提供元ごとのコマンドにする（いまは `claude-log-sources` だけ）。取り込みの `chat-log-import` は1つで、知っている種類のどれでも取り込む。
- 提供元を足すときは、次を行う。表の変更は要らない。
  1. 列挙のコマンドを足し、`bin/sync` でその出力も取り込みに渡す。
  2. 種類を `src/kinds.ts` に足し、行ごとの種類には抽出の関数を足す。
  3. 必要なら、`messages` ビューに `UNION ALL` で枝を足すマイグレーションを書く。
- データベースのファイル名も、Claude に限らない `logs.sqlite` にする。

### 取り込む対象と種類

| 種類 | 対象 | 取り込み方 |
|---|---|---|
| `claude-code/transcript` | `projects/` 以下の `*.jsonl`（`subagents/` を含む。`memory/` 以下は除く） | 行ごと・差分 |
| `claude-code/history` | `history.jsonl` | 行ごと・差分 |
| `claude-code/file` | `projects/<プロジェクト>/<セッションID>/` 以下の JSONL 以外のファイル、`projects/<プロジェクト>/*.json` | ファイルごと・内容が変わったら新しい版 |
| `claude-desktop/session` | `claude-code-sessions/` 以下の `*.json` | ファイルごと・内容が変わったら新しい版 |

- Claude Code の設定ディレクトリは、環境変数 `CLAUDE_CONFIG_DIR` があればそれを、無ければ `~/.claude` を使う。
- デスクトップアプリのディレクトリは `~/Library/Application Support/Claude` を使う。無ければ（macOS 以外を含む）その種類は列挙しない。
- 存在しないディレクトリは、エラーにせずに飛ばす。

### データベースの場所

- 既定は `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite`。環境変数 `AI_CHAT_LOGS_DB` か `--db` で変えられる。
- 履歴には秘密の情報が含まれうるため、データベースのファイルは作成時に権限を `0600` にする。
- `journal_mode=WAL` と `busy_timeout` を設定する。

### データ構造

```sql
-- 取り込んだファイル。書きかえを検出したら generation を上げて別の行にする
CREATE TABLE sources (
  id             INTEGER PRIMARY KEY,
  kind           TEXT    NOT NULL,            -- <提供元>/<種類>
  provider       TEXT GENERATED ALWAYS AS (substr(kind, 1, instr(kind, '/') - 1)) VIRTUAL,
  path           TEXT    NOT NULL,
  generation     INTEGER NOT NULL DEFAULT 0,
  consumed_bytes INTEGER NOT NULL DEFAULT 0,  -- 取り込み済みのバイト数（行ごとの種類だけ）
  consumed_lines INTEGER NOT NULL DEFAULT 0,  -- 取り込み済みの行数（空の行を含む。次の行番号を決める）
  head_sha256    TEXT,                        -- 先頭 min(4096, consumed_bytes) バイトの SHA-256
  size           INTEGER,
  mtime_ms       INTEGER,
  first_seen_at  TEXT    NOT NULL,
  last_seen_at   TEXT    NOT NULL,
  missing_since  TEXT,                        -- 元のファイルが見つからなくなった時刻
  UNIQUE (path, generation)
);
CREATE INDEX sources_provider ON sources (provider);

-- JSONL の1行。type から timestamp は、取り込みのときに種類ごとの抽出の関数で埋める（取り出せなければ NULL）
CREATE TABLE records (
  source_id   INTEGER NOT NULL REFERENCES sources(id),
  line_no     INTEGER NOT NULL,               -- 1始まり
  raw         TEXT    NOT NULL,               -- 行の文字列そのもの（改行は除く）
  imported_at TEXT    NOT NULL,
  type        TEXT,                           -- レコードの種類
  uuid        TEXT,                           -- レコードの ID
  session_id  TEXT,                           -- セッションの ID
  timestamp   TEXT,                           -- ISO 8601（UTC）
  PRIMARY KEY (source_id, line_no)
);
CREATE INDEX records_session ON records (session_id, timestamp);
CREATE INDEX records_uuid    ON records (uuid);

-- ファイルごとに取り込む種類の中身。SHA-256 で重複を除く
CREATE TABLE blobs (
  sha256  TEXT PRIMARY KEY,
  size    INTEGER NOT NULL,
  content BLOB    NOT NULL
);

-- ファイルごとに取り込む種類の版
CREATE TABLE file_versions (
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  sha256        TEXT    NOT NULL REFERENCES blobs(sha256),
  first_seen_at TEXT    NOT NULL,
  PRIMARY KEY (source_id, sha256)
);

-- 実行の記録
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  sources_seen  INTEGER NOT NULL DEFAULT 0,
  records_added INTEGER NOT NULL DEFAULT 0,
  blobs_added   INTEGER NOT NULL DEFAULT 0,
  errors        TEXT                         -- ファイルごとの失敗（JSON の配列）
);

-- 会話のメッセージを引き出すビュー。いまは claude-code/transcript の user と assistant だけ。
-- 提供元を足すときは、同じ列の並びで UNION ALL の枝を足す
CREATE VIEW messages AS
SELECT s.provider, r.session_id, r.uuid,
       r.raw ->> '$.parentUuid'        AS parent_uuid,
       r.type,
       r.timestamp,
       r.raw ->> '$.message.role'      AS role,
       r.raw ->> '$.message.model'     AS model,
       r.raw ->> '$.isSidechain'       AS is_sidechain,
       r.raw ->> '$.cwd'               AS cwd,
       r.raw -> '$.message.content'    AS content,
       s.path                          AS source_path
FROM records r JOIN sources s ON s.id = r.source_id
WHERE s.kind = 'claude-code/transcript' AND r.type IN ('user', 'assistant');
```

抽出の関数は次のとおり。JSON として正しくない行、オブジェクトでない行、型の合わない値は NULL にする。

| 種類 | `type` | `uuid` | `session_id` | `timestamp` |
|---|---|---|---|---|
| `claude-code/transcript` | `$.type`（文字列） | `$.uuid`（文字列） | `$.sessionId`（文字列） | `$.timestamp`（文字列。そのまま） |
| `claude-code/history` | NULL | NULL | `$.sessionId`（文字列） | `$.timestamp`（エポックからのミリ秒の数）を ISO 8601（UTC、ミリ秒つき、`Z`）にしたもの |

`schema_version` を `PRAGMA user_version` に持ち、起動時に足りないマイグレーションを順に当てる。
マイグレーションの SQL は `schema/NNNN-<名前>.sql` のファイルに置く。

### アルゴリズム：行ごとの差分の取り込み

ファイルごとに、1つのトランザクション（`BEGIN IMMEDIATE`）で次を行う。

1. `stat` で大きさと更新時刻を得る。`path` の最新の `generation` の行を `sources` から引く（無ければ作る）。
2. 次のどちらかなら、ファイルが書きかえられたとみなし、`generation` を1つ上げた行を新しく作って先頭から読む。前の版の行はそのまま残す。
   - 大きさが `consumed_bytes` より小さい。
   - 先頭 `min(4096, consumed_bytes)` バイトの SHA-256 が `head_sha256` と違う。
3. 大きさが `consumed_bytes` と同じなら、何もしない（`last_seen_at` だけ更新する）。
4. `consumed_bytes` から末尾までをバイト列として読み、最後の改行（`0x0A`）までを取り込む。最後の改行より後ろは書きかけとみなし、次の実行に回す。
   読み込みは 64MiB ずつ区切って進める。区切りの中に改行が無ければ（1行が区切りより長ければ）、区切りを2倍に広げて読みなおす。
5. 改行で分けた各行を UTF-8 として復号し、末尾の `\r` を除き、種類の抽出の関数で項目を取り出して `records` に入れる。空の行は飛ばすが、行番号は数える。
6. `consumed_bytes`、`consumed_lines`、`head_sha256`、`size`、`mtime_ms`、`last_seen_at` を更新する。

バイト単位で区切ってから復号するため、マルチバイト文字が読み込みの境界で割れることはない。
JSON として正しくない行もそのまま保存する（取り出す項目は NULL になる）。

### アルゴリズム：ファイルごとの取り込み

1. ファイルを読み、SHA-256 を求める。
2. `blobs` に無ければ入れる。
3. `file_versions` に `(source_id, sha256)` が無ければ入れる。内容が前の版に戻った場合は、新しい行を作らない。

### 消えたファイル

列挙に現れなかったが、`sources` にあって `missing_since` が NULL の行は、`missing_since` に現在時刻を入れる。
行は消さない。再び現れたら `missing_since` を NULL に戻す。
消えたかどうかは、`chat-log-import` に `--mark-missing` を付けたときだけ判定する（標準入力が全体の列挙だと分かっているときだけ使う）。`bin/sync` は付ける。

### 失敗の扱い

1つのファイルの失敗（読めない、など）は `runs.errors` に記録して、ほかのファイルの取り込みを続ける。
1つでも失敗があれば、終了コードを1にする。

### TypeScript の書き方

- クラスは使わない。関数とデータで組む。
- 行の分割、書きかえの判定、列挙の絞り込みなど、入出力の無い部分は純粋な関数にして、単体でテストする。

## 実装しないこと

- claude.ai（Web とデスクトップアプリのチャット）の会話。手元にデータが無く、取るにはサーバーへの問い合わせか、公式のデータのエクスポートが要る。必要になったら、エクスポートの取り込みを別の ADR で検討する。
- 取り込み時の正規化（メッセージや内容のブロックを別の表に分けること）。必要になったらビューか別の ADR で足す。
- 全文検索の索引と、閲覧・検索の GUI。[ADR 0003](0003-tauri-log-viewer-with-search.md) で扱う。
- 秘密の情報のマスキング。データベースは手元に `0600` で置く前提とする。
- データベースの圧縮。
- Claude 以外の AI の履歴の取り込み（列挙のコマンドと抽出の関数）。スキーマとコマンドの分け方に余地だけを残す。
- Windows と Linux のデスクトップアプリの場所。

## テスト設計

`bun test` で実行する。
本物の履歴は秘密を含むため、テストの入力はテスト内で一時ディレクトリに作る合成のファイルだけにする。

### 純粋な関数

1. 行の分割：最後の改行までを完全な行として返し、残りのバイト数を返す。改行で終わらない入力、空の入力、改行だけの入力、`\r\n` の行。
2. マルチバイト文字（日本語、絵文字）を含む行を、文字の途中で区切ったバイト列で与えても、完全な行だけが正しく復号される。
3. 書きかえの判定：大きさが減った、先頭のハッシュが違う、変化なし、追記だけ、の4通り。
4. 列挙の絞り込み：`memory/` 以下を除く、`subagents/` 以下の JSONL を含む、JSONL 以外のファイルを `claude-code/file` に分ける。

### 列挙（`claude-log-sources`）

5. 一時ディレクトリを `CLAUDE_CONFIG_DIR` に指定し、上の表の各種類のファイルが、正しい種類と絶対パスで1行ずつ出力される。
6. `projects/` もデスクトップアプリのディレクトリも無いとき、エラーにならず、何も出力しない。

### 取り込み（`chat-log-import`）

7. 新しい JSONL：すべての完全な行が、1始まりの行番号と、元の行と同じ文字列で入る。
8. 追記：行を足して再び実行すると、足した行だけが入る。
9. 冪等：変化の無いファイルで再び実行しても、行が増えない。
10. 書きかけの行：改行で終わらない最後の行は入らず、改行が書かれた後の実行で入る。
11. 書きかえ：ファイルを短くするか先頭を変えると、`generation` が上がった `sources` の行ができ、前の版の `records` は残る。
12. 消えたファイル：`--mark-missing` を付けた実行で、列挙に無いファイルの `missing_since` が入り、`records` は残る。再び現れると NULL に戻る。
13. JSON として正しくない行：保存され、取り出す項目が NULL になり、取り込みは止まらない。
14. ファイルごとの種類：同じ内容では版が増えない。内容を変えると版が増える。別のパスの同じ内容は `blobs` を共有する。前の内容に戻しても版は増えない。
15. `messages` ビュー：`user` と `assistant` だけが、セッションID、時刻、役割、モデルとともに返る。
16. データベースのファイルが権限 `0600` で作られる。
17. 実行ごとに `runs` に1行入り、件数が正しい。
18. 読めないファイル（権限 `000`）があっても、ほかのファイルは取り込まれ、`runs.errors` に記録され、終了コードが1になる。
19. マイグレーション：空のデータベースに最新の `user_version` までスキーマが作られ、2回目の起動では何もしない。
20. 区切って読む：区切りの大きさを1行より小さくしても（テストでは区切りの大きさを引数で小さくする）、空の行、マルチバイト文字、書きかけの最後の行を含めて、区切らない場合と同じ行と行番号が入る。

### `bin/sync`

21. 一時ディレクトリの設定ディレクトリと一時のデータベースで `bin/sync` を実行し、取り込まれた件数を確かめる。

### Claude 以外の AI のための余地

22. 抽出の関数：`claude-code/transcript` の行から `type`、`uuid`、`session_id`、`timestamp` が取り出される。値が文字列でない、JSON として正しくない、オブジェクトでない（配列や数）行では NULL になる。
23. 抽出の関数：`claude-code/history` の行の、ミリ秒の数の `timestamp` が ISO 8601（UTC、`Z`）になり、`sessionId` が `session_id` に入る。`timestamp` が数でなければ NULL になる。
24. `sources.provider` が、種類の `/` より前（`claude-code`、`claude-desktop`）になる。
25. `messages` ビューに `provider` の列がある。
26. 既定のデータベースのパスが `ai-chat-logs/logs.sqlite` で終わる。

## トレードオフ

- 生のまま保存するため、データベースはおおむね元の JSONL の合計と同じ大きさ（現時点で 2.6GB 程度）になる。正規化や圧縮で小さくできるが、版ごとの形の変化に追従する手間と、取りこぼしの危険が増える。
- よく使う項目は、生成列ではなく、取り込みのときに埋める普通の列にする。生成列の式は種類によって変えられない（同じ表の列しか参照できず、JSON の形が提供元ごとに異なる）ため。そのかわり、列の分だけ容量が増え、抽出の規則を変えたときは既存の行を埋めなおすマイグレーションが要る。
- 提供元の列を `sources` に持たせ、`records` には持たせない。提供元で絞るときは `sources` との結合が要るが、行ごとの重複を避ける。
- `mode` などの同じ内容の行が多く重複するが、行番号を主キーにして元の並びをそのまま残すほうを選ぶ。
- 書きかえを先頭 4KiB のハッシュで判定するため、4KiB より後ろだけの書きかえ（追記以外）は検出できない。Claude Code の記録は追記だけなので、全体のハッシュを毎回求める費用を避ける。
- 1ファイル1トランザクションにするため、途中で止まっても、取り込み済みのファイルはそのまま残り、次の実行で続きから取り込める。
- 依存パッケージを入れず、`bun:sqlite` と Bun の API だけを使う。Node.js では動かない。

## 参考文献

- Claude Code の設定（`cleanupPeriodDays`、`CLAUDE_CONFIG_DIR`）：https://code.claude.com/docs/en/settings
- Bun の SQLite：https://bun.com/docs/api/sqlite
- SQLite の生成列：https://www.sqlite.org/gencol.html
- SQLite の JSON 関数と `->>` 演算子：https://www.sqlite.org/json1.html
- XDG Base Directory Specification：https://specifications.freedesktop.org/basedir-spec/latest/
