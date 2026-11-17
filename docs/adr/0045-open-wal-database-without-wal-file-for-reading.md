# ADR 0045: `-wal` のファイルが無いときも、chat-log と GUI がデータベースを開ける

Status: accepted-pending

## 文脈

[ADR 0041](0041-append-codex-snapshots-instead-of-copying.md) の整理（`codex-store-dedupe`）を、2026-11-18 に本番のデータの小さい写しで試した。
その途中で、`chat-log` が写しのデータベースを開けなくなり、`SQLITE_CANTOPEN`（「unable to open database file」）で落ちた。
原因を調べると、`sqlite3` コマンドでデータベースを開いて閉じた後に、WAL のファイルが消えていた。
`chat-log` は読み取り専用の接続で開くので、`-wal` のファイルが無いと開けない。

README は、データベースを縮める手順（`VACUUM`）とバックアップの手順で、`sqlite3` コマンドを使うよう書いている。
そのため、利用者が README のとおりに `VACUUM` を実行すると、取り込みのジョブが次にデータベースを開くまで、`chat-log` が使えなくなる。
GUI も読み取り専用の接続で開くので、同じことが起きると見込む。

この ADR では、次の語を使う。

- **WAL のファイル**：WAL のモードのデータベース `<パス>` の隣にできる `<パス>-wal` と `<パス>-shm`。
- **読み取り専用の接続**：SQLite の `SQLITE_OPEN_READONLY` で開いた接続。Bun の `new Database(path, { readonly: true })` と、rusqlite の `OpenFlags::SQLITE_OPEN_READ_ONLY` がこれに当たる。
- **query_only の接続**：読み書きのできる接続を、ファイルを作らない指定（`SQLITE_OPEN_CREATE` を付けない）で開き、すぐに `PRAGMA query_only = ON` を実行したもの。

この ADR は、`chat-log` と GUI がデータベースを開く接続を、読み取り専用の接続から query_only の接続に変えることを決める。

## 調査した事項

### 再現

macOS 27.0 で、Bun 1.4.4（SQLite 3.54.0）のスクリプトと `sqlite3` コマンド（3.54.0）を使い、`$TMPDIR` に作った小さなデータベースで試した。
「WAL のファイル」の列は、その操作の後にあった WAL のファイルの数である。

| 操作 | WAL のファイル | 後で読み取り専用の接続を開くと |
| --- | --- | --- |
| Bun で WAL のモードにして書き、`close()` | 2 | 開けた |
| Bun で書き、`close()` | 2 | 開けた |
| Bun で書き、閉じずにプロセスを終える | 2 | 開けた |
| `sqlite3 db.sqlite "select 1"` | 0 | `SQLITE_CANTOPEN` で開けなかった |
| 上の後に、Bun で書き、`close()` | 2 | 開けた |
| Bun で作って閉じた後に `-shm` だけを消す | 1 | 開けた（開いた後に `-shm` が作りなおされた） |
| Bun で作って閉じた後に `-wal` だけを消す | 1 | `SQLITE_CANTOPEN` で開けなかった |
| Bun で作って閉じた後に両方を消す | 0 | `SQLITE_CANTOPEN` で開けなかった |

開けないのは `-wal` が無いときで、`-shm` が無いだけなら開けた。
Bun の接続は、閉じても WAL のファイルを残した（`-wal` は 0 バイト）。
`sqlite3` コマンドは、最後の接続として閉じると WAL のファイルを消した。

query_only の接続（Bun の `new Database(path)` の後に `PRAGMA query_only = ON`）を、`-wal` だけが無いときと、両方が無いときに開いた。
どちらでも `select count(*)` が読め、`insert` は「attempt to write a readonly database」で拒まれ、閉じた後に WAL のファイルが2つあった。
`PRAGMA journal_mode` は `wal` のままだった。
精読のときの再現では、Bun の `{ readwrite: true, create: false }` で無いパスを開くと「unable to open database file」になり、ファイルはできなかった。

[ADR 0041](0041-append-codex-snapshots-instead-of-copying.md) の写しで、`codex-store-dedupe` の後に `chat-log` が落ちたときも、その前に `sqlite3` で件数を数えていた。
`codex-store-dedupe` は Bun で開くので、上の表のとおり WAL のファイルを残すと見込むが、本番では確かめていない（未確認）。

GUI の rusqlite（0.40.2、`bundled`）で、`-wal` が無いときに読み取り専用の接続が開けないかは、確かめていない（未確認）。
読み取り専用の接続は `-wal` を作れないので、同じく開けないと見込む（推測）。

### データベースを開いている箇所

`rg -n "readonly: true|SQLITE_OPEN_READ_ONLY|query_only|new Database\(|open_with_flags"` で、`src`、`gui/src-tauri/src`、`bin` を探した。
読み取り専用の接続を開く製品のコードは、次の3か所だった。

| 箇所 | 開き方 | 使い方 |
| --- | --- | --- |
| `src/chat-log/store.ts:19` の `openReadOnly` | `new Database(path, { readonly: true })`、busy_timeout なし | `chat-log` のすべてのサブコマンド |
| `gui/src-tauri/src/store.rs:56-60` の `open_read_only` | `SQLITE_OPEN_READ_ONLY \| SQLITE_OPEN_NO_MUTEX`、busy_timeout 10 秒 | GUI の一覧、検索、会話の表示 |
| `gui/src-tauri/src/setup.rs:195` の `database_stats` | `SQLITE_OPEN_READ_ONLY` | GUI の「環境の検査」のデータベースの欄 |

`src/cli/codex-store-dedupe.ts:24-26` の `--dry-run` は、`new Database(path)`（作成もする既定の開き方）の後に `PRAGMA query_only = ON` を実行している。
テストのコードの `tests/chat-log-payloads.test.ts:49` にも読み取り専用の接続があるが、テストなのでこの ADR の対象にしない。

### README の記述

`rg -n "sqlite3 |読み取り専用" README.md` で、次を見つけた。

- `sqlite3` を使う手順：`.backup` によるバックアップ（85行）、`PRAGMA journal_mode=DELETE`（93行）、`codex-store-dedupe` の後の `VACUUM`（165行）、ペイロードの確かめ（279行）、`VACUUM`（293行）。
- 93〜94行は、旧バイナリに戻すときに、WAL の補助ファイルが無いバックアップを読み取り専用の CLI でも開けるよう、`journal_mode=DELETE` にする手順を書いている。
- 299行「GUI は読み取り専用で開くので、`VACUUM` の間は開いていてもよい」、305行「読み取り専用の CLI」、333行「データベースは読み取り専用で開くため、pm2 の取り込みと同時に使える。」

## 実装すること

### 1. `chat-log`

`openReadOnly` は、`new Database(path, { readwrite: true, create: false })` で開き、すぐに `PRAGMA query_only = ON` を実行する。
続けて `PRAGMA busy_timeout = 10000` を実行し、その後に `PRAGMA user_version` を読む。
busy_timeout は、`-wal` を作りなおすときに取り込みと競っても待つためで、GUI の `open_read_only` と同じ 10 秒にする。
データベースのファイルが無いときに終了コード2で知らせること（`existsSync` の検査）と、スキーマの版が古いときの扱いは変えない。
関数の名前は変えない。

### 2. GUI

`open_read_only` と `database_stats` は、`OpenFlags::SQLITE_OPEN_READ_WRITE`（`open_read_only` は `SQLITE_OPEN_NO_MUTEX` も）で開き、`SQLITE_OPEN_CREATE` を付けない。
開いた直後に `PRAGMA query_only = ON` を実行する。
`open_read_only` の busy_timeout と、ファイルが無いときに `NotFound` を返すことは変えない。
`database_stats` は版が古いデータベースの版も返すので、`open_read_only`（版が古いと `OldSchema` を返す）を使わず、開き方だけをそろえる。

### 3. 文書

`docs/specifications.md` の179行（GUI）と272行（`chat-log`）の「読み取り専用」を、「読み書きのできる接続をファイルを作らない指定で開き、すぐに `PRAGMA query_only = ON` を実行する。表と行は変えない」に直し、この ADR へのリンクを付ける。

README は次のとおり直す。

- 299行と333行の「読み取り専用で開く」を、「書き込まない接続（query_only）で開く」に直す。
- 305行の「読み取り専用の CLI」は、書き込まないことを表す語なので、変えない。
- 93〜94行の `journal_mode=DELETE` の手順は、この ADR より前の旧バイナリに戻すときの手順なので、変えない。
- `sqlite3` の手順は変えない。この ADR の後は、`sqlite3` で WAL のファイルが消えても、`chat-log` と GUI が開けるためである。

## 実装しないこと

- WAL のファイルが消えないようにすること。WAL のファイルは、最後の接続が閉じたときに SQLite が消すことがあり、どの道具が最後の接続になるかは決められない。
- README の手順に、`sqlite3` の後で取り込みを動かすことを足すこと。読む側を直せば要らない。
- `immutable` で開くこと。取り込みと同時に読むので、データベースが変わらないとは言えない。
- テストのコードの読み取り専用の接続。

## 不変条件

- I1：WAL のモードのデータベースで、`-wal` と `-shm` の一方または両方が無いとき、`chat-log sessions` は終了コード0で、両方があるときと同じ出力を出す。
- I2：`openReadOnly` で開いた接続で `INSERT` を実行すると、例外になる。
- I3：`chat-log sessions` を動かした前と後で、`records` のすべての行（`rowid` と `raw`）と、`PRAGMA user_version` と `PRAGMA journal_mode` が変わらない。
- I4：GUI の `open_read_only` は、`-wal` と `-shm` の一方または両方が無いデータベースを開け、その接続での `INSERT` は失敗する。
- I5：GUI の `database_stats` は、`-wal` と `-shm` の一方または両方が無いデータベースの版と件数を、両方があるときと同じに返す。
- I6：GUI の `database_stats` が開いた接続での `INSERT` は失敗する。
- I7：データベースのファイルが無いとき、`chat-log` は終了コード2、GUI の `open_read_only` は `NotFound` を返し、どちらもそのパスにファイルを作らない。

| 入力 | `chat-log sessions` | `open_read_only` | `database_stats` | 不変条件 |
| --- | --- | --- | --- | --- |
| WAL のファイルが2つともある | 終了コード0、フィクスチャのセッションを出す | 開ける | 版と件数 | I1, I3, I4, I5 |
| 2つとも無い（`sqlite3` で閉じた後） | 同上 | 開ける | 同上 | I1, I3, I4, I5 |
| `-wal` だけが無い（`-shm` はある） | 同上 | 開ける | 同上 | I1, I3, I4, I5 |
| `-shm` だけが無い | 同上 | 開ける | 同上 | I1, I3, I4, I5 |
| 開いた接続で `INSERT` | 例外 | 失敗 | 失敗 | I2, I4, I6 |
| データベースのファイルが無い | 終了コード2、ファイルを作らない | `NotFound`、ファイルを作らない | （対象外） | I7 |

## 受けいれ条件

- A1：本番のデータベースで、GUI を閉じ、`pm2 stop ai-chat-logs-sync ai-chat-logs-codex-sync` で取り込みを止め、`sqlite3 ~/.local/share/ai-chat-logs/logs.sqlite "select 1"` を実行して、`ls` で `-wal` と `-shm` が無いことを確かめる。その後に、`chat-log sessions --limit 1` が終了コード0で1行を出し、GUI を開くと一覧が出る。

## テスト設計

`tests/chat-log.test.ts` に、次のテストを足す。
テストの名前は `ADR 0045 I<番号>: ...` とする。
WAL のファイルを消すテストは、共有のフィクスチャを壊さないよう、`tempDir()` にフィクスチャのデータベースを写して使う。
写したデータベースは、Bun で開いて `PRAGMA wal_checkpoint(TRUNCATE)` を実行してから閉じ、その後に WAL のファイルを消す。
`sqlite3` コマンドを使わないので、CI（ubuntu-latest）にあるかに左右されない。

1. `ADR 0045 I1, I3`：WAL のファイルが2つとも無い、`-wal` だけが無い、`-shm` だけが無い、の3つの写しで、`chat-log sessions` の終了コードと出力が、両方があるときと同じである。前と後で `records` の `rowid` と `raw`、`user_version`、`journal_mode` が同じである。
2. `ADR 0045 I2`：`openReadOnly` で開いた接続で `INSERT` を実行すると例外になる。
3. `ADR 0045 I7`：いまの「a missing or old database exits 2」のテストに、無いパスにファイルができないことの確かめを足し、名前の先頭に `ADR 0045 I7: ` を付ける。

`gui/src-tauri/src/store.rs` と `setup.rs` に、次のテストを足す。
テストの名前は `adr0045_i<番号>_...` とする。
データベースは、`crate::store::scratch_path` のパスに `Connection::open` と `PRAGMA journal_mode = WAL` で作り、テストごとに別に作る。
WAL のファイルは、`PRAGMA wal_checkpoint(TRUNCATE)` の後に接続を閉じてから消す。

4. `adr0045_i4_open_read_only_without_wal_files`：2つとも無い、`-wal` だけが無い、`-shm` だけが無い、の3つで、`open_read_only` が開けて読め、`INSERT` が失敗する。
5. `adr0045_i5_i6_database_stats_without_wal_files`：同じ3つで、`database_stats` が版と件数を返す。`database_stats` と同じ開き方の接続で `INSERT` が失敗する（開き方を関数に分け、その関数を確かめる）。
6. `adr0045_i7_open_read_only_missing_file`：いまの `reports_a_missing_database` に、ファイルができないことの確かめを足し、名前を `adr0045_i7_reports_a_missing_database` にする。

A1 は、実装を本番に入れた後に手で確かめる。

## トレードオフ

- query_only の接続には、データベースのファイルとそのディレクトリに書き込む権限が要る。`chat-log` と GUI は取り込みと同じ利用者で動くので、この権限はある。
- query_only の接続も、最後の接続として閉じると、SQLite がチェックポイントでデータベースのファイルを書きかえ、WAL のファイルを消すことがある。表と行は変わらない。次に開く `chat-log` と GUI も query_only の接続なので、開ける。
- 書き込まない道具が読み書きのできる接続を持つので、`query_only` を付け忘れると書き込めてしまう。開く箇所は `chat-log` と GUI の3か所で、I2、I4、I6 でどれもが書き込みを拒むことを確かめる。

## 参考文献

- SQLite「Write-Ahead Logging」の「Read-Only Databases」：https://www.sqlite.org/wal.html
- SQLite「PRAGMA query_only」：https://www.sqlite.org/pragma.html#pragma_query_only
- [ADR 0041](0041-append-codex-snapshots-instead-of-copying.md)：整理を写しで試したときに見つけた。
