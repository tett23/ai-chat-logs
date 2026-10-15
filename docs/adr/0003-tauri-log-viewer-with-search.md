# ADR 0003: Tauri で履歴を閲覧・検索する GUI を作る

ステータス: 採択→データベースの既定の場所と実装の細部は[ADR 0005](0005-log-viewer-corrections-and-details.md)

## 文脈

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) で、Claude Code の履歴を SQLite に生のまま取り込む。
[ADR 0002](0002-periodic-sync-with-pm2.md) で、取り込みを毎時実行する。
取り込んだ履歴を、セッションごとに読み返したり、語句で探したりする GUI が欲しい。
GUI は Tauri で作る（利用者の指定）。

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) のデータベースには、次の性質がある。

- `records.raw` は JSON の文字列のままで、本文を探すには毎回 JSON を解析する必要がある。全体で 2.6GB 程度あるため、検索のたびに全件を走査するのは遅い。
- セッションの一覧（タイトル、最後の時刻、件数）も、毎回 `records` を集計すると遅い。
- 履歴には日本語が多い。SQLite の FTS5 の既定のトークナイザ（unicode61）は、空白で区切らない日本語の語を分けられない。FTS5 の `trigram` トークナイザなら、3文字以上の任意の部分文字列で索引を引ける（SQLite 3.34 以降）。手元の Bun の SQLite（3.54.0）で、`trigram` と `snippet()` が日本語で動くことを確かめた。

そこで、検索の索引とセッションの要約は取り込みの側（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) のツール）で作り、GUI はデータベースを読むだけにする。

## 実装すること

### 1. 取り込みの側：検索の索引とセッションの要約

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) のスキーマに、マイグレーションを1つ足す。

```sql
-- 会話の本文の全文検索。rowid は records の rowid
CREATE VIRTUAL TABLE record_texts USING fts5(
  text,
  tokenize = 'trigram'
);

-- セッションの要約。取り込みのたびに、取り込んだ行のセッションについて作りなおす
CREATE TABLE session_summaries (
  provider      TEXT NOT NULL,  -- sources.provider
  session_id    TEXT NOT NULL,
  cwd           TEXT,     -- 最初に現れた cwd
  title         TEXT,     -- 下の規則で決める
  first_at      TEXT,     -- 最初の timestamp
  last_at       TEXT,     -- 最後の timestamp
  message_count INTEGER NOT NULL, -- user と assistant のレコードの数（サイドチェーンを含む）
  PRIMARY KEY (provider, session_id)
);
CREATE INDEX session_summaries_last_at ON session_summaries (last_at);
```

本文の取り出し（`record_texts` に入れる文字列）は、[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) の抽出の関数と同じく、種類ごとの関数で行う。いまの規則は次のとおり。

- 対象は種類が `claude-code/transcript` の `user` と `assistant` のレコードだけ。
- `message.content` が文字列ならそのまま。配列なら、`type` が `text` のブロックの `text` と、`thinking` のブロックの `thinking` を、改行でつないだもの。
- `tool_use` と `tool_result` のブロックは入れない。
- 取り出した文字列が空なら入れない。

セッションのタイトルは、次の順で最初に見つかったものとする。

1. そのセッションの最後の `custom-title` のレコードの `customTitle`。
2. デスクトップアプリのセッション（`claude-desktop/session`）の最新の版で、`cliSessionId` がそのセッションID のものの `title`。
3. そのセッションの最初の、`isMeta` でない `user` のレコードの本文の先頭80文字。

取り込みの手順：

- `records` に行を入れるのと同じトランザクションで、本文を `record_texts` に入れる。
- ファイルの取り込みの後に、そのファイルで行が増えたセッションの `session_summaries` を作りなおす。デスクトップアプリのセッションの版が増えたときは、その `cliSessionId` のセッションを作りなおす。
- マイグレーションの適用時に、既存の `records` から `record_texts` と `session_summaries` を作る。

マイグレーションの SQL は、TypeScript と Rust の両方から読めるように、`schema/NNNN-<名前>.sql` のファイルに置く。

### 2. GUI：`gui/` 以下の Tauri アプリ

構成：

| 部分 | 技術 |
|---|---|
| 枠 | Tauri 2 |
| バックエンド | Rust。`rusqlite`（`bundled` の機能。FTS5 を含む） |
| フロントエンド | TypeScript。フレームワークは使わず、DOM を直接組む。Bun の HTML のバンドラでビルドする |
| スタイル | Tailwind CSS 4。Bun の HTML のバンドラに `bun-plugin-tailwind` を入れてビルドする |

- データベースは読み取り専用（`SQLITE_OPEN_READ_ONLY`）で開く。WAL のため、pm2 の取り込みと同時に開いていてよい。
- データベースの場所は [ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) と同じ規則（`AI_CHAT_LOGS_DB`、無ければ `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude.sqlite`）。見つからないときは、その旨とパスを画面に出す。
- スキーマの `user_version` が想定より古いときは、`chat-log-import` を実行するよう画面に出す。

Tauri のコマンド（バックエンドの関数）：

| コマンド | 引数 | 返すもの |
|---|---|---|
| `list_sessions` | `cwd`（任意）、`offset`、`limit` | `session_summaries` を `last_at` の新しい順に |
| `list_projects` | なし | `session_summaries` の `cwd` ごとのセッション数 |
| `get_session` | `session_id` | そのセッションの `user` と `assistant` のレコードを、ファイルと行番号の順に。各レコードは、`uuid`、時刻、役割、モデル、サイドチェーンか、内容のブロックの配列 |
| `search` | `query`、`cwd`（任意）、`offset`、`limit` | 一致したレコードの、セッションID、`uuid`、時刻、役割、セッションのタイトル、`snippet()` による抜粋。時刻の新しい順に |

検索の規則：

- 3文字以上の語は、FTS5 の `MATCH` で引く。利用者の入力は、FTS5 の構文として解釈させないため、空白で区切った各語を二重引用符で囲み（中の `"` は `""` にする）、AND でつなぐ。
- 3文字未満の語を含むときは、その語を `record_texts.text LIKE '%語%'`（`%`、`_`、`\` はエスケープ）で絞る。全件を走査するため遅いことを画面に出す。

画面：

- 見た目は簡素でよい。凝った装飾やテーマの切り替えは作らない。
- スタイルは要素の `class` に書く Tailwind のユーティリティクラスだけで付ける。CSS のファイルは `@import "tailwindcss";` の1行だけにし、独自の CSS は書かない（生の CSS を読まずに済むようにするため）。
- 左：プロジェクト（`cwd`）の絞り込みと、セッションの一覧（タイトル、最後の時刻、件数）。下までスクロールすると続きを読む。
- 上：検索の入力欄。入力すると、一覧の代わりに検索の結果を出す。抜粋の一致した部分を強調する。
- 右：選んだセッションの会話。検索の結果から開いた場合は、そのレコードまでスクロールして強調する。
- 会話の表示：
  - 本文はプレーンテキストとして、空白と改行を保って表示する。Markdown は描画しない。
  - ` ``` ` で囲まれた部分だけ、等幅のブロックにする。
  - `thinking`、`tool_use`、`tool_result` のブロックと、サイドチェーンのレコードは、折りたたんで表示する。
  - 文字列は必ずテキストとして DOM に入れ、HTML として解釈させない（`innerHTML` を使わない）。抜粋の強調も、区切りの文字で分けてから要素を組む。

### 書き方

- Rust は関数型のスタイルを優先する。SQL の組み立てや行の変換は、入出力の無い関数に分ける。
- TypeScript はクラスを使わない。

### CI

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) の取り込みのジョブとは別に、`gui` のジョブを足す。`cargo fmt --check`、`cargo clippy -- -D warnings`、`cargo test`、フロントエンドの `bun test` を実行する。

## 実装しないこと

- 履歴の編集・削除。GUI は読むだけ。
- GUI からの取り込みの実行と、pm2 の操作。
- Markdown の描画とシンタックスハイライト。
- `tool_use` と `tool_result` の内容の検索。索引が大きくなるため。必要になったら別の ADR で足す。
- 正規表現での検索、検索の結果の並べ替えの切り替え。
- 署名・公証したアプリの配布と、リリースでのビルド。手元で `bun run tauri build` してビルドする。
- macOS 以外での動作の確認。
- E2E テスト（tauri-driver）。手で確かめる。
- 設定画面（データベースの場所は環境変数で変える）。

## テスト設計

### 取り込みの側（`bun test`）

1. 文字列の `content`、`text` と `thinking` のブロックの配列、`tool_use` と `tool_result` だけの配列（入らない）から、正しい本文が取り出される。
2. 取り込んだ `user` と `assistant` のレコードの本文が `record_texts` に入り、`MATCH` で日本語の3文字の語が見つかる。`user`・`assistant` 以外のレコードと、`claude-code/history` の行は入らない。
3. 追記して取り込むと、増えた行の本文だけが足される（重複しない）。
4. `session_summaries`：件数、最初と最後の時刻、`cwd` が正しい。
5. タイトルの規則：`custom-title` があればその最後のもの、無ければデスクトップアプリのセッションの `title`、それも無ければ最初の `isMeta` でない `user` の本文の先頭80文字。デスクトップアプリのセッションのファイルだけが後から変わっても、タイトルが更新される。
6. マイグレーション：古いスキーマのデータベースに行がある状態でマイグレーションを当てると、既存の行から `record_texts` と `session_summaries` が作られる。

### GUI のバックエンド（`cargo test`）

テストでは、`schema/*.sql` を当てた一時のデータベースに、合成の行を入れて使う。

7. FTS5 の語の引用：空白、`"`、`*`、`NEAR`、`OR` などを含む入力が、構文として解釈されずに語として扱われる。
8. LIKE のエスケープ：`%`、`_`、`\` を含む語が、文字どおりに一致する。
9. 検索：3文字以上の語は `MATCH` で、3文字未満の語を含む場合は LIKE で絞られ、どちらも正しい行を返す。`cwd` で絞れる。新しい順に並ぶ。
10. `list_sessions`：`last_at` の新しい順、`offset` と `limit` が効く、`cwd` で絞れる。
11. `get_session`：ファイルと行番号の順に並び、内容のブロックの種類が保たれる。
12. データベースを読み取り専用で開き、書き込みが失敗する。
13. `user_version` が古いデータベースを開くと、所定のエラーを返す。

### GUI のフロントエンド（`bun test`）

14. 抜粋の分割：`snippet()` の区切りの文字で、強調する部分としない部分に正しく分けられる。HTML の特殊文字を含む文字列が、そのまま文字として扱われる。
15. ` ``` ` で囲まれた部分の分割：閉じていない囲み、言語名つきの囲み、入れ子にならない場合。

### 手で確かめること

実装の後に次を確かめ、結果をプルリクエストに書く。

1. 実際の履歴を取り込んだデータベースで `bun run tauri dev` を起動し、セッションの一覧が数秒以内に出る。
2. 日本語の3文字以上の語と、英語の語で検索し、結果から会話を開くと、該当のレコードまでスクロールする。
3. 2文字の語で検索すると、遅い旨の表示とともに結果が出る。
4. pm2 の取り込みが動いている間も、GUI でエラーが出ない。

## トレードオフ

- 索引を取り込みの側で作るため、[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) の取り込みが少し遅くなり、データベースも大きくなる。`trigram` の索引は本文の数倍の大きさになりうる。`tool_use` と `tool_result` を除くことで、大きさを抑える。
- `trigram` は3文字未満の語を索引で引けない。日本語の2文字の語（「検索」など）は全件の走査になる。形態素解析のトークナイザなら2文字の語も引けるが、SQLite の拡張と辞書が要り、Bun と Rust の両方で同じものを読み込む必要がある。
- `session_summaries` は、`records` から作れる情報の複製になる。一覧を速く出すために、整合を取り込みの側の責任にする。
- Tailwind を使うため、ビルドに `tailwindcss` と `bun-plugin-tailwind` の依存が増える。生の CSS を書かず、見た目の指定を要素の近くに置けることを優先する。
- フロントエンドにフレームワークを使わないため、画面の状態の管理を自分で書く。画面が3つと小さいため、依存を増やさないほうを選ぶ。
- GUI の側の `rusqlite` は SQLite を同梱するため、取り込みの側（Bun が使うシステムの SQLite）と版が異なる。FTS5 と `trigram` があり、同じファイル形式を読めれば足りる。

## 参考文献

- Tauri 2：https://v2.tauri.app/
- Tauri のコマンド：https://v2.tauri.app/develop/calling-rust/
- SQLite FTS5（`trigram` トークナイザ、`snippet()`）：https://www.sqlite.org/fts5.html
- rusqlite：https://docs.rs/rusqlite/
- Bun の HTML のバンドラ：https://bun.com/docs/bundler/html
- Tailwind CSS：https://tailwindcss.com/docs
- bun-plugin-tailwind：https://github.com/oven-sh/bun-plugin-tailwind
