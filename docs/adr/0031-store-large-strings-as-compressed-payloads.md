# ADR 0031: 記録の中の大きな文字列を、重複を除いて圧縮した別の表に移す

ステータス: 採択

## 文脈

データベースは 7.8 GB になった（2026-11-08）。古い記録は消さない。すべての記録を、元の行と同じ形で残すことが、このリポジトリの目的である（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md)）。

`dbstat` で測った内訳は次のとおり。

| もの | 大きさ |
|---|---|
| `records`（元の行の `raw` を含む） | 5,767 MB |
| `record_tool_texts`（[ADR 0021](0021-search-tool-inputs-and-results.md)。`_data` と `_content`） | 1,395 MB |
| `blobs` | 224 MB |
| 索引（4つ） | 250 MB |
| `record_texts`（`_data` と `_content`） | 164 MB |

`raw` の合計は 5.18 GB（84.5 万行）である。

- `user` の行で `tool_result` を含むものが 3.15 GB を占める。
- base64 を含む行は 2.63 GB ある。base64 の文字列そのもの（`"data"` の値）は 1.55 GB で、重複を除くと 1.24 GB になる。
- 同じ `uuid` を持つ写し（[ADR 0005](0005-log-viewer-corrections-and-details.md)）の、2つ目以降の行が 1.06 GB ある。

増え方は、2026-10 の1か月で `raw` が 2.78 GB、2026-11 の最初の7日で 0.65 GB だった。このままだと、1年で 40 GB 以上増える。

利用者に次の案を示し、1 と 2 を選ばれた。

1. `raw` を1行ずつ zstd で圧縮する。無作為に選んだ 3,000 行では、元の約 40% になった。
2. base64 の画像を、中身のハッシュで別の表に移し、バイナリで持つ。

1 をそのまま行うと、`raw` は SQL の JSON の関数で読めなくなる。いまは次の SQL が `raw` を読んでいる。

- 検索の索引を作るビュー：`record_text_source`、`record_tool_text_source`。
- セッションの要約のビュー：`session_summary_source`。`$.cwd`、`$.customTitle`、`$.isMeta`、本文を読む。
- `messages` のビュー。
- `chat-log` と GUI の検索の問い合わせ：`raw ->> '$.message.role'`。

`bun:sqlite` は、SQL の関数をアプリケーションから足せない。圧縮した `raw` を SQL で読むには、これらをすべて TypeScript と Rust に移す必要がある。

そこで、1 と 2 を次の形にまとめた案を、手元のデータベースで試算した（`raw` を JSON として読み、規則に合う文字列を数えた）。

- 1024 バイト以上の文字列のうち、SQL が読む場所に無いものを `raw` から抜き出す。
- 抜き出したものは、中身のハッシュで重複を除き、zstd（レベル3）で圧縮する。base64 はバイナリに戻す。

| 抜き出す大きさの下限 | `raw` に残る分 | 抜き出した分（重複を含む） | 重複を除いた数 | 圧縮した文字列 | バイナリにした base64 | 合計 |
|---|---|---|---|---|---|---|
| 256 B | 1.46 GB | 3.77 GB | 18.5 万 | 0.13 GB | 1.01 GB | 2.59 GB |
| 1 KiB | 1.62 GB | 3.58 GB | 9.9 万 | 0.10 GB | 1.00 GB | 2.72 GB |
| 4 KiB | 2.02 GB | 3.17 GB | 2.1 万 | 0.06 GB | 0.96 GB | 3.03 GB |

抜き出した 3.58 GB（1 KiB のとき）のうち、重複を除いた文字列は 1.58 GB（base64 の 1.33 GB を含む）しかない。同じツールの結果や添付が、写しや別の行に何度も出ているためである。
`raw` 全体を1行ずつ圧縮する案（約 2.1 GB と見積もる）と比べると、0.6 GB ほど大きい。その代わり、SQL が読む場所は元のまま残る。

## 実装すること

### 1. 抜き出す文字列（ペイロード）

取り込む行（`records.raw`）の JSON の文字列のうち、次をすべて満たすものを「ペイロード」として `raw` から抜き出す。

- 文字列のリテラル（両端の `"` とエスケープを含む、`raw` の中のバイト列）が 1024 バイト以上である。
- SQL が読む次の場所に無い。
  - 最上位のメンバーの値（`$.cwd`、`$.customTitle`、`$.isMeta` など）。
  - `$.message` の直下のメンバーの値（`role`、`model`、文字列の `content` など）。
  - `$.message.content[*]` の直下のメンバーの値（`type`、`text`、`thinking` など）。

`tool_result` の `content`（文字列、または配列の中の `text`）、`tool_use` の `input` の中の文字列、画像の `source.data` などが抜き出される。

### 2. 保存の形

スキーマの移行 `schema/0006-payloads.sql` を足す（`user_version` は 6）。

```sql
CREATE TABLE payloads (
  sha256   TEXT    PRIMARY KEY,        -- リテラルのバイト列の SHA-256（16進）
  size     INTEGER NOT NULL,           -- リテラルのバイト数
  encoding TEXT    NOT NULL CHECK (encoding IN ('zstd', 'base64')),
  content  BLOB    NOT NULL
);
ALTER TABLE records ADD COLUMN payload_state INTEGER;  -- NULL: 未処理、0: 抜き出したものが無い、1: 抜き出した
```

- `encoding = 'zstd'`：`content` は、リテラルのバイト列を zstd（レベル3）で圧縮したもの。
- `encoding = 'base64'`：リテラルが `"` と、標準の base64（`A-Za-z0-9+/`、`=` による埋め、改行もエスケープも無い）と、`"` だけでできている。さらに、復号して符号化しなおすと元と同じになる。このとき `content` は、復号したバイナリとする。圧縮はしない（画像はもともと圧縮されている）。
- `raw` の中のリテラルは、目印のリテラル `"\u0000ai-chat-logs-payload:<sha256>"` に置きかえる。置きかえた後の `raw` も、正しい JSON のままである。
- ある行の `raw` が、置きかえる前から `\u0000ai-chat-logs-payload:` という文字の並びを含むときは、その行からは何も抜き出さない（`payload_state = 0`）。目印と、元からある文字列を取り違えないためである。
- `payloads` の行は消さない（記録を消さないので、指す先も消えない）。

### 3. 元に戻すこと

- `payload_state = 1` の行は、`raw` の中の目印のリテラルを、`payloads` の中身から作ったリテラルに置きかえて戻す。文字列としての置きかえであり、JSON を読み書きしなおさない。そのため、戻したものは、取り込んだ行とバイト単位で同じになる。
- 取り込みでは、抜き出した後に戻したものが元の行と同じであることを確かめる。同じでなければ、その行からは抜き出さない（`payload_state = 0`）。
- 戻す処理は、TypeScript（`chat-log` が使う。zstd は Bun の `Bun.zstdDecompressSync`）と、Rust（GUI が使う）の両方に置く。
  - Rust の zstd は、クレート `zstd` を依存に足す。zstd の伸長は、再実装するには大きすぎる。
  - base64 の符号化は、Rust で再実装する。依存に足さない。
- `chat-log`（`show`、`search`、`export`、`context`）と GUI（会話の表示、ツールの結果の詳細）は、`raw` を JSON として読む前に、必ず戻す。
- `chat-log` が求めるスキーマの版を 6 にする。GUI が求める版も 6 にする。古い版のままだと、目印を本文として出してしまうためである。

### 4. 取り込みの順

- 行を、これまでどおり元の `raw` のまま `records` に入れる。続けて、検索の索引（`indexTextsAfter`）とセッションの要約（`rebuildSessions`）を作る。
- その後、同じトランザクションの中で、新しい行からペイロードを抜き出す。
- 検索の索引を作るビューは、抜き出す前の `raw` を読む。そのため、ツールの結果の検索（[ADR 0021](0021-search-tool-inputs-and-results.md)）は変わらない。

### 5. いまある行の変換

- `bin/sync` の取り込みの後に、`payload_state IS NULL` の行を rowid の順に、1万行ずつのトランザクションで変換する。変換には件数の上限を設けない。
- 最初の実行で、いまある 84.5 万行をすべて変換する。途中で止まっても、次の実行で続きから変換する。
- 変換で空いたページは、SQLite の空きページとして残る。そのため、ファイルの大きさはすぐには縮まない。空きページは、次からの取り込みで使いまわされる。
- ファイルを縮めるには、取り込みを止めて `VACUUM` を実行する。その手順を README に書く。`VACUUM` は、データベースと同じくらいの空き容量と、数分の時間を要する。

### 6. ドキュメント

- `docs/specifications.md` のデータベースの節に、`payloads` の表、目印、戻し方を書く。
- `docs/specifications.md` に、SQL で `raw` を直に読むと（`sqlite3` や `messages` のビュー）、抜き出した文字列が目印として見えることを書く。
- README に、移行にかかる時間、`VACUUM` の手順、`chat-log` と GUI の入れなおしを書く。

## 実装しないこと

- 1024 バイト未満の文字列や、SQL が読む場所の文字列を圧縮すること。
- `record_tool_texts` の本文の写し（`_content`）を外すこと。これは、利用者に示した案の 3 で、選ばれていない。
- `blobs`（claude.ai のエクスポートなど）の圧縮。
- 写しの行を、元の行への参照にすること（案の 4）。写しが持つ大きな文字列は、ペイロードとして重複が除かれる。
- `VACUUM` を自動で実行すること。
- SQL から戻せるようにすること（SQL の関数を足すこと）。

## テスト設計

### 関数（`bun test`）

1. 抜き出し：次の JSON の行で、1024 バイト以上の文字列が目印に置きかわり、ペイロードが作られる。
   - `tool_result` の文字列の `content`。
   - `tool_result` の配列の `content` の中の `text`。
   - `tool_use` の `input` の中の文字列。
   - 画像の `source.data`。
2. 抜き出さないもの：次は抜き出さない。
   - 1023 バイトの文字列。
   - 最上位のメンバーの値。
   - `$.message.content` の文字列。
   - `$.message.content[*].text` と `$.message.content[*].thinking`。
3. エスケープ：`\n`、`\"`、`\\`、`\uXXXX`（サロゲートペアを含む）、`/` のエスケープを含む文字列も、戻すとバイト単位で元と同じになる。リテラルの大きさは、エスケープを含めて数える。
4. base64：標準の base64 はバイナリで持ち、戻すと元と同じになる。次は `zstd` で持つ。
   - 埋めの無いもの。
   - 改行を含むもの。
   - URL 用の文字（`-`、`_`）を含むもの。
   - 符号化しなおすと元と違うもの。
5. 重複：同じリテラルを2つ持つ行と、同じリテラルを持つ2つの行は、どちらも `payloads` の1行を指す。
6. 目印の取り違え：元から `\u0000ai-chat-logs-payload:` を含む行は、何も抜き出さず `payload_state = 0` になる。
7. 往復：テストのフィクスチャのすべての行で、抜き出して戻したものが元の行とバイト単位で同じになる。
8. 正しい JSON でない行は、何も抜き出さない。

### 取り込み（`bun test`）

9. 取り込んだ行は `payload_state` が 0 か 1 になる。`record_texts`、`record_tool_texts`、`session_summaries` は、抜き出さないときと同じ中身になる。
10. スキーマ 5 のデータベースに `payload_state IS NULL` の行があると、`bin/sync` が変換する。変換の前後で、戻した `raw` が同じになる。
11. 移行のテストの版を `SCHEMA_VERSION` で比べる（既存）。

### `chat-log`（`bun test`、コマンド）

12. ペイロードを持つセッションの `show --tools --max-chars 0`、`show --json`、`export` の出力が、抜き出さないときと同じになる。
13. スキーマ 5 のデータベースでは、これまでどおり終了コード2と、取り込みを促す説明を出す。

### GUI（`cargo test`）

14. 戻す関数：`zstd` と `base64` のペイロードを戻すと、元の行と同じになる。`payload_state` が 0 の行は、そのまま返す。
15. 会話を読む問い合わせが、抜き出した行の本文とツールの結果を元のとおりに返す。
16. base64 の符号化：RFC 4648 のテストベクタ（空、`f`、`fo`、`foo`、`foob`、`fooba`、`foobar`）。

### 手で確かめること

1. 手元のデータベースの写しで `bin/sync` を実行し、次を測る。
   - 変換にかかった時間。
   - `payloads` と `records` の大きさ（`dbstat`）。
   - `VACUUM` の後のファイルの大きさ。
2. 変換した写しで、すべての行の戻した `raw` が、変換の前の `raw` と同じであることを確かめる。比べたあと、写しは消す。
3. GUI と `chat-log` で、画像を含む会話、長いツールの結果を含む会話を開き、これまでどおりに出ることを確かめる。
4. 大きなセッション（Golem）の `chat-log export` の時間を、[ADR 0026](0026-export-sessions-and-highlight-terms.md) の手で確かめた値（14.6 秒）と比べる。

## トレードオフ

- `raw` は、SQL からはそのままでは読めなくなる（抜き出した部分が目印になる）。`sqlite3` で直に調べるときや、SQL で検索の索引を作りなおすときは、アプリケーションで戻す必要がある。SQL が読む場所を抜き出さないので、いまのビューと問い合わせはそのまま動く。
- `raw` 全体を圧縮する案より、0.6 GB ほど大きい。SQL を TypeScript と Rust に移す手間と、ビューを失うことを避ける方を選ぶ。
- 会話を読むたびに、ペイロードを引いて伸長する。zstd の伸長は速いが、大きなセッションの `export` は遅くなりうる。手で測る。
- GUI が zstd のクレートに頼る。
- 変換の後も、`VACUUM` するまでファイルは縮まない。`VACUUM` には、一時的に同じくらいの空き容量が要る。
- `record_tool_texts`（1.4 GB）は残るので、データベース全体は 7.8 GB から約 5 GB になる見込みである。増え方は、`raw` の部分がおおよそ半分になる。

## 参考文献

- RFC 8259（The JavaScript Object Notation (JSON) Data Interchange Format）：https://www.rfc-editor.org/rfc/rfc8259
- RFC 4648（The Base16, Base32, and Base64 Data Encodings）：https://www.rfc-editor.org/rfc/rfc4648
- RFC 8878（Zstandard Compression and the application/zstd Media Type）：https://www.rfc-editor.org/rfc/rfc8878
- Bun の `Bun.zstdCompressSync`：https://bun.com/docs/api/utils
- SQLite の `VACUUM`：https://www.sqlite.org/lang_vacuum.html
- SQLite の `dbstat`：https://www.sqlite.org/dbstat.html
- zstd のクレート：https://crates.io/crates/zstd
