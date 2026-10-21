# ADR 0017: 検索の結果のメッセージ番号を速く求める

ステータス: 採択（未実装）

## 文脈

GUI の検索（[ADR 0003](0003-tauri-log-viewer-with-search.md)）と `chat-log search`（[ADR 0011](0011-cli-for-ai-agents.md)）は、結果の各件に、セッションの中のメッセージの番号を付ける（[ADR 0014](0014-load-conversations-in-pages.md)）。
番号は、写しを除いたセッションのメッセージ（`session_messages`）を、時刻の順（[ADR 0016](0016-show-conversations-newest-first.md)）に数えたものである。

いまの実装は、ヒットごとに次の2つの問い合わせを行う。

1. そのレコードの時刻、パス、`generation`、行番号を引く。
2. 同じセッションで、それ以下のメッセージを `count(*)` で数える。

最大のセッション（Golem、79,083 件）では、2 の1回が約 0.52 秒かかる（取り込み済みのデータベース、3.8 GB、レコード 355,342 件）。
1ページ（50 件）のヒットが大きなセッションに集まると、結果が出るまで十数秒かかる。
検索そのもの（FTS5 で 50 件を引く）は約 8 ミリ秒なので、時間のほとんどは番号を求める部分である。
パスの順に番号を付けていたとき（[ADR 0016](0016-show-conversations-newest-first.md) より前）も、速さは同じだった。

遅い理由は次の2つ。

- `records` の行は、`raw`（JSON の全文）の後ろに `type`、`uuid`、`session_id`、`timestamp` を持つ。`raw` が長い行では、後ろの列を読むのに `raw` のオーバーフローのページをたどる。`session_messages` の条件（`type`）と写しの判定（`uuid`）が、セッションの全行でこれを起こす。
- 写しの判定（`copied_records` のビュー）は、`record_rowid = r.rowid` で引かれるため、行ごとに `records` を rowid で読みなおす。

データベースの写しで、次のことを確かめた。

| 方法 | Golem の1回 |
|---|---|
| いまの `count(*)` | 0.52 秒 |
| `records (session_id, type, uuid, timestamp, source_id, line_no)` の索引を足すだけ | 2 分以上で打ち切り（写しの判定の副問い合わせがこの索引を選び、セッションの全行を行ごとに走査した） |
| 写しの判定を `session_messages` の中に直接書き、下の2つの索引を足す | 0.15 秒（数は同じ 40,001） |
| 上に加え、同じセッションのヒットを窓関数（`row_number()`）でまとめて1回で求める | ヒットの数によらず 0.31 秒（いまのビューのままでは 0.56 秒） |

## 実装すること

### スキーマ（`schema/0004-session-message-indexes.sql`）

- 索引 `records_session_order ON records (session_id, type, timestamp, uuid, source_id, line_no)` を足す。`session_messages` の行を、`records` の本体を読まずに選べる。
- 索引 `records_uuid_session ON records (uuid, session_id, source_id, line_no)` を足す。写しの判定を、`records` の本体を読まずに行える。
- `records_uuid` は `records_uuid_session` の先頭と同じ列なので消す。
- `session_messages` のビューを作りなおす。写しの判定を、`copied_records` を引く形から、外側の `r` と `s` の列を使う `EXISTS` に書きかえる。条件は `copied_records` と同じ（同じ提供元・セッションID・`uuid` で、パス、`generation`、行番号の順で前にあるものがあれば除く）なので、返す行は変わらない。
- `copied_records` のビューはそのまま残す（検索の写しの除去で使う）。
- スキーマの版は 4 になる。取り込み（`bin/sync`）で移行する。

### 番号の求め方（GUI の `search`、`chat-log` の `search`）

- 1ページのヒットをセッションごとに分け、セッションごとに1回、`session_messages` に時刻の順（[ADR 0016](0016-show-conversations-newest-first.md) と同じ順）で `row_number()` を付け、そのページのヒットの `record_rowid` の番号を引く。
- 写しとして除かれたレコードがヒットしたとき（検索は写しを除くので、ふつうは起きない）は、これまでどおり番号は無し（GUI は `null`、`chat-log` は番号無し）。
- GUI と `chat-log` が求めるスキーマの版（GUI は 2、`chat-log` は 3）は変えない。版 3 のデータベースでも同じ番号が出る（遅いまま）。

## 実装しないこと

- 番号を取り込みのときに計算して保存すること。取り込みのたびに、時刻の順の途中に入るメッセージ（サブエージェントの記録など）で番号がずれるため、セッションごとに数えなおす処理が要り、仕組みが大きくなる。
- `get_messages`（会話の読みこみ）と `chat-log show` の問い合わせの変更。ビューの変更で速くなるが、問い合わせの形は変えない。
- 検索の本体の問い合わせの変更。

## テスト設計

### スキーマ（`bun test`）

1. 版 3 のデータベースを開くと版 4 に移り、`records_session_order` と `records_uuid_session` があり、`records_uuid` が無い。
2. 写しを含む取り込みの後、`session_messages` の行が、版 3 の定義（`copied_records` を引く形）と同じになる（同じ提供元・セッション・`uuid` の写しは、パス、`generation`、行番号の順で最初のものだけ。`uuid` の無いレコードは除かない。別のセッションの同じ `uuid` は除かない）。
3. セッションの番号を求める問い合わせの計画（`EXPLAIN QUERY PLAN`）が、`records` に対して `records_session_order` と `records_uuid_session` を覆う索引（COVERING INDEX）として使う。

### 番号（`cargo test`、`bun test`）

4. GUI：同じセッションに複数のヒットがあり、別のセッションにもヒットがあるとき、各ヒットの `index` が `get_messages` の番号と一致する。
5. `chat-log`：同じ形の履歴で、`search` の `#<番号>` が `show` の番号と一致する。

### 手で確かめること

1. データベースの写しで、Golem のヒットが多く出る語で検索したときの1ページの時間を、変える前と後で測る。
2. GUI で「adr-guard links」を検索し、結果が数秒以内に出て、ヒットを開くとそのメッセージまでスクロールする。

## トレードオフ

- 索引が2つ増え、1つ減る。写しで測った大きさは、`records_session_order` が 37 MB、`records_uuid_session` が 27 MB、消す `records_uuid` が 13 MB（データベースは約 3.4 GB）。取り込みの書き込みは、索引の分だけ少し遅くなる。
- `session_messages` と `copied_records` に、同じ写しの規則を2か所に書くことになる。`copied_records` から引く形では索引で覆えないため。テスト2で、2つが同じ行を返すことを確かめる。
- セッションごとに1回の問い合わせは、セッションの全件を並べかえる（Golem で約 0.3 秒）。ヒットが1件だけのセッションでは、`count(*)`（約 0.15 秒）より遅いが、手順を1つにするため、ヒットの数で方法を変えない。
- 1ページのヒットが多くの大きなセッションに分かれると、まだ数秒かかる。

## 参考文献

- SQLite Query Planning（覆う索引）：https://www.sqlite.org/queryplanner.html
- SQLite File Format（オーバーフローのページ）：https://www.sqlite.org/fileformat2.html
