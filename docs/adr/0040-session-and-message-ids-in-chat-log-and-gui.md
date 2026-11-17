# ADR 0040: chat-log と GUI でのセッションIDとメッセージIDの扱い

Status: accepted-pending

## 文脈

利用者から、次の5点を求められた（2026-11-17）。

1. `chat-log` で、セッションIDを指定できるようにする。
2. `chat-log` で、メッセージIDを指定し、その前後のメッセージを範囲で取れるようにする。
3. GUI で、セッションIDとメッセージIDをコピーできるようにする。あわせて、セッション全体と、1つのメッセージをコピーするボタンを置く。
4. GUI で、セッションのメタデータを会話の上の部分に出す。サイドバーには、メタデータを最大2行に短くまとめて出す。
5. `chat-log` のヘルプは、人ではなく AI のエージェントが読むものとして書く。

この ADR では、次の語を使う。

- **セッションID**：`session_summaries.session_id` の値。Claude Code では UUID、Codex ではスレッドの ID である。
- **メッセージID**：会話のメッセージ（`session_messages` の行）の `records.uuid` の値。Claude では UUID、Codex の会話の行（[ADR 0034](0034-import-codex-rollouts.md)）では 64 文字の16進である。GUI が「元ID」として出す Codex の `openai.itemId` とは別の値である。
- **メッセージの番号**：セッションの中の通し番号（1始まり、時刻の順。写しは数えない。[ADR 0011](0011-cli-for-ai-agents.md)）。
- **会話の欄**：GUI の右側の、1つのセッションのメッセージを出す欄。
- **会話の欄の見出し**：会話の欄の上端の、スクロールしても残る部分（[ADR 0024](0024-gui-conversation-header-and-block-filter.md)）。いまは、1段目に提供元の表示（`conversation-provider`）、ページの状態（`statusText`）、書き出すボタン、「表示」のメニューを、2段目に文脈の行（`contextBar`）を、3段目に書き出しの結果の欄（`exportStatus`）を置いている。
- **サイドバー**：GUI の左側の、セッションの一覧と検索の結果を出す欄。

いまの `chat-log` は、`show` と `export` の引数にセッションIDを取る。
しかし、`search` には特定のセッションに絞る手段が無い。
また、メッセージは番号でしか指せず（`show <セッションID> --around <番号>`）、メッセージIDから引く手段が無い。
メッセージIDは `search --json` と `show --json` の `uuid` に出るだけである。

いまの GUI は、セッションIDもメッセージIDも画面に出さない。
会話の欄の見出しの文脈の行には、タイトル、種類、Codex のエージェントの名前・役割・パス・詳細、親のスレッドだけを出す。
サイドバーのセッションの項目は、1行目がタイトル（はみ出す分は切る）、2行目が最後の時刻とメッセージの件数である。
GUI からセッションを Markdown にする手段は、ファイルへの書き出し（[ADR 0026](0026-export-sessions-and-highlight-terms.md)）だけで、クリップボードへのコピーは無い。

この5点の目的は、利用者が GUI で見つけた会話を、IDで AI のエージェントに渡せるようにすることである。
エージェントは、渡されたIDを `chat-log` に与えて、その会話を読む。

## 調査した事項

手元のデータベース（2026-11-17、スキーマの版 8）で、次を確かめた。

- `session_messages` の行のうち、`records.uuid` が NULL のものは、どの提供元にも無い。

  ```
  $ sqlite3 -readonly logs.sqlite "SELECT s.provider, count(*), sum(r.uuid IS NULL) FROM session_messages m JOIN records r ON r.rowid=m.record_rowid JOIN sources s ON s.id=r.source_id GROUP BY 1;"
  claude-ai|2651|0
  claude-code|380280|0
  claude-cowork|76|0
  codex|335655|0
  ```

- メッセージIDは、セッションをまたいで重なることがある。異なる (提供元, セッションID, メッセージID) の組 718,385 個のうち、277 個のメッセージIDが2つのセッションに現れる。3つ以上のセッションや、2つの提供元にまたがるものは無い。重なるのは Claude Code の4つのセッションだけである（fork や再開で、同じ uuid の行が別のセッションIDのファイルに書かれたものと見られる。推測）。

  ```
  $ sqlite3 -readonly logs.sqlite "WITH m AS (SELECT DISTINCT m.provider, m.session_id, r.uuid FROM session_messages m JOIN records r ON r.rowid=m.record_rowid) SELECT count(*), sum(n>1), max(n), sum(n>1 AND np>1) FROM (SELECT uuid, count(*) n, count(DISTINCT provider) np FROM m GROUP BY uuid);"
  718385|277|2|0
  $ sqlite3 -readonly logs.sqlite "WITH m AS (...), d AS (SELECT uuid FROM m GROUP BY uuid HAVING count(*)>1) SELECT m.provider, count(*), count(DISTINCT m.session_id) FROM m JOIN d USING(uuid) GROUP BY 1;"
  claude-code|554|4
  ```

- 1つのセッションの中では、メッセージIDは重ならない。(提供元, セッションID, メッセージID) ごとの `session_messages` の行の数は、最大で1だった。

  ```
  $ sqlite3 -readonly logs.sqlite "SELECT max(n), sum(n>1) FROM (SELECT count(*) n FROM session_messages m JOIN records r ON r.rowid=m.record_rowid GROUP BY m.provider, m.session_id, r.uuid);"
  1|0
  ```

- 写し（[ADR 0011](0011-cli-for-ai-agents.md) の用語。同じ提供元、セッションID、uuid の行が複数あるもの）は、同じ uuid の元の行を持つ。このため、写しの行の uuid で引くと、`session_messages` にある元の行に当たる。

- メッセージIDの先頭8文字から、索引 `records_uuid_session (uuid, session_id, source_id, line_no)` で行を引ける。範囲の条件（`uuid >= '98d7f31b' AND uuid < '98d7f31c'`）での問い合わせは 0.024 秒だった。

  ```
  $ time sqlite3 -readonly logs.sqlite "SELECT DISTINCT s.provider, r.session_id, r.uuid FROM records r JOIN sources s ON s.id=r.source_id WHERE r.uuid >= '98d7f31b' AND r.uuid < '98d7f31c' AND r.type IN ('user','assistant') AND s.kind IN (...);"
  codex|01a0aaeb-b1bb-7ab1-a01a-3a45a78c25cd|98d7f31b5c78...
  0.024 total
  ```

- GUI のバックエンドは、`chat-log export` を `bun` で実行して、セッションの Markdown を作っている（`gui/src-tauri/src/setup.rs:70` の `export_command`）。Markdown の形は `src/chat-log/markdown.ts` の `sessionMarkdown` が決め、メッセージ1つの節は `messageMarkdown` が作る。
- GUI の権限（`gui/src-tauri/capabilities/default.json`）は `core:default`、`dialog:allow-open`、`dialog:allow-save` だけで、クリップボードのプラグインは入っていない。

## 実装すること

### 1. `chat-log search --session <セッションID>`

- `search` に `--session <セッションID>` を足す。そのセッションのメッセージだけを探す。
- セッションIDの決め方は `show` と同じである。ほかと区別できれば先頭8文字以上でよく、区別できないときは候補を標準エラー出力に書いて終了コード2、無いときは終了コード1にする。`--provider` で提供元を絞れる。
- `--session` を付けたときは、`--cwd`、`--since`、`--until` を付けられない（使い方の誤り。終了コード2）。セッションが決まれば、これらの絞り込みは要らないためである。

### 2. `chat-log show --message <メッセージID> [--range <前>[:<後>]]`

- `show` に `--message <メッセージID>` を足す。そのメッセージと、その前後のメッセージを出す。
- メッセージIDの候補は、`session_messages` の行（写しを除いた会話のメッセージ）の (提供元, セッションID, メッセージID) の組に限る。ツールの記録や Codex の原本の行など、`session_messages` に無い行は候補にしない。
- メッセージIDは、先頭8文字以上で指定する。8文字未満は使い方の誤り（終了コード2）にする。候補のうちメッセージIDが指定と完全に一致するものがあれば、それだけを候補にする。無ければ、指定で始まるものを候補にする（セッションIDと同じ規則）。
- 候補が0個なら終了コード1、1個ならそれを使う。2個以上なら、候補（提供元、セッションID、メッセージID）をすべて標準エラー出力に書き、標準出力には何も書かずに終了コード2にする。
- セッションIDは省ける。添えたとき（`show <セッションID> --message <メッセージID>`）は、そのセッションの中の候補だけを見る。`--provider` を付けたときは、その提供元の候補だけを見る。いまのデータベースで2つのセッションにあるメッセージID（277 個）は、どれも同じ提供元（claude-code）の中の重なりなので、`--provider` では区別できず、セッションIDを添える必要がある。
- 写しの行の uuid で引くと、元のメッセージが出る（調査した事項）。
- `--range <前>:<後>` は、そのメッセージの前に `<前>` 件、後に `<後>` 件を足して出す。`--range <数>` は `--range <数>:<数>` と同じである。`<前>`、`<後>`、`<数>` は0以上の整数で、ほかの形は使い方の誤り（終了コード2）にする。既定は `--range 5`（前に5件、後に5件。合わせて11件）とする。範囲はセッションの1件目と最後の件で切り、`--around` のように反対側へずらさない。`--range 0` はそのメッセージだけを出す。
- 範囲の数は番号で数える。表示するものが無く省いたメッセージも数える（`--around` と同じ）。
- `show --message` で受けつけるオプションは、`--provider`、`--range`、`--tools`、`--max-chars`、`--json` である。範囲の中の思考は、`--around` と同じく常に出すので、`--thinking` は付けても付けなくても同じである。`--tools` と `--max-chars` の意味と既定（2000）は `show` と同じである。
- `--message` と、`--around`、`--limit`、`--offset`、`--since`、`--until`、`--cwd` は併用できない（使い方の誤り。終了コード2）。`--range` は `--message` が無いと付けられない。
- テキストの出力は、`show` の形の前に、次の1行を置く。エージェントが続きを読むときに、このセッションIDを `show` に渡す。

  ```
  # <提供元> <セッションID（全体）> <タイトル>（メッセージ #<番号>）
  ```

  前と続きの行（[ADR 0023](0023-chat-log-around-navigation-lines.md)）は、`--message` のときは `--offset <数>` の代わりに `chat-log show <セッションID（全体）> --offset <数>` と、そのまま実行できる形で案内する。`--message` と `--offset` は併用できないためである。前の行は、範囲が1件目より後から始まるときに出し、続きの行は、範囲が最後の件より前で終わるときに出す。`--range 0` のときは、どちらも出さない。
- `--json` の出力は、`show --json` と同じ形の行を範囲の分だけ出す。各行に `provider` と `session_id` を足す。`--range 0` では1行になる。

### 3. `chat-log export --message <メッセージID>`

- `export` に `--message <メッセージID>` を足す。そのメッセージ1つの節（`messageMarkdown` が作る、`## #<番号> …` から始まる文字列）に改行を1つ足したものだけを書く。セッションの見出しは書かない。
- メッセージIDの決め方と、終了コードは `show --message` と同じである。セッションIDは省ける。
- `export --message` で受けつけるオプションは `--provider` だけである。いまの `export` が拒むもの（`--cwd`、`--since`、`--until`、`--limit`、`--offset`、`--max-chars`、`--json`）に加えて、`--range`、`--around`、`--thinking`、`--tools` も使い方の誤り（終了コード2）にする。`export` は思考とツールを常に書くので、`--thinking` と `--tools` は意味を持たないためである。`--message` の無い `export` には、いまどおり `--thinking` と `--tools` を付けられる。
- 書くものが無いメッセージ（本文が空の思考だけのものなど、`messageMarkdown` が null を返すもの）は、`messageMarkdown` と同じ見出しの行（モデルと「(サブエージェント)」を含む）と、空行と、「（書く本文が無い）」の行を書く。コピーしたものが空にならないようにするためである。
- GUI のメッセージのコピー（5.）は、これを使う。

### 4. ヘルプを AI のエージェント向けに書く

`chat-log` のヘルプ（`chat-log --help` と、各サブコマンドの `--help`）の読み手は、AI のエージェントとする。人の利用者は GUI を使う。ヘルプは次の決まりで書く。

- 各オプションに、受けつける値の形、既定値、出力の形、ほかのオプションとの組み合わせの制限、終了コードを書く。
- 出力の各形に、次に何を実行すればよいか（どの値をどのコマンドのどの引数に渡すか）を書く。
- 人に向けた案内（GUI の操作、好みの使い方、ファイルの保存のしかた）は書かない。`export` のヘルプの「人が読むためのもの」「ファイルに残すときは > <ファイル> で受ける」は、「Markdown の全文を出す。会話を読むには show を使う」に改める。
- 全体のヘルプの「使う順序の勧め」の前に、「利用者からIDを渡されたとき」の節を置く。

  ```
  利用者からIDを渡されたとき（GUI でコピーしたもの）:
    セッションID   chat-log show <セッションID>               最初から読む
                   chat-log search <語> --session <セッションID>  その中を探す
    メッセージID   chat-log show --message <メッセージID>      その前後を読む（--range で広げる）
  ```

- 用語の節に「セッションID」と「メッセージID」を足す。メッセージIDが `search --json` と `show --json` の `uuid` と同じ値であることを書く。

### 5. GUI：IDとセッションとメッセージのコピー

- クリップボードへの書き込みには、Tauri の公式のプラグイン `tauri-plugin-clipboard-manager`（2 系）を使い、権限 `clipboard-manager:allow-write-text` を足す。書き込みはバックエンド（Rust）で行い、セッションの Markdown を画面側に渡さない。
- バックエンドに3つのコマンドを足す。
  - `copy_text(text)`：文字列をクリップボードに書く。IDのコピーに使う。
  - `copy_session(provider, session_id)`：`chat-log export <セッションID> --provider <提供元>` の標準出力をクリップボードに書く。中身は、書き出すボタンが書くファイルと同じである。
  - `copy_message(provider, session_id, message_id)`：`chat-log export <セッションID> --provider <提供元> --message <メッセージID>` の標準出力をクリップボードに書く。
  - `chat-log` を起動できなかったとき（`bun` が無いなど）は、クリップボードを変えず、起動の誤りを返す（書き出すボタンと同じく、設定の誤りとして返す）。
  - `chat-log` が終了コード0以外で終わったときは、クリップボードを変えず、終了コードと標準エラー出力の末尾20行を返す（書き出すボタンと同じ）。
- コピーのボタンは、押した後に2秒間「コピーしました」と出す。失敗したときは、会話の欄の見出しの書き出しの結果の欄（`exportStatus`）に理由を出す。
- 会話の欄の見出しに、「セッションIDをコピー」と「セッションをコピー」のボタンを、書き出すボタンの隣に置く。
- 各メッセージの見出し（役割、モデル、時刻の行）の右端に、「IDをコピー」と「コピー」のボタンを置く。メッセージIDの無いメッセージ（いまのデータベースには無い）では、この2つを出さない。

### 6. GUI：会話の欄の上にメタデータを出す

- 会話の欄の見出しの2段目にある文脈の行（`contextBar`）を、メタデータの欄に置きかえる。見出しはスクロールしても残るので、メタデータは常に会話の上に見える。見出しの1段目（提供元の表示、ページの状態、書き出すボタン、「表示」のメニュー）と3段目（書き出しの結果の欄）は、いまの場所に残す。
- メタデータの欄は2段にする。
  - 1段目：タイトル。GUI の `get_session_summary` が返すタイトル（Codex では [ADR 0037](0037-codex-session-presentation.md) の `codex_session_presentation.display_title`、ほかは `session_summaries.title`）を出す。
  - 2段目：提供元、セッションID（全体）、cwd、期間（最初の時刻〜最後の時刻）、メッセージの件数。続けて、いまの文脈の行にある種類、Codex のエージェントの名前・役割・パス・詳細、親のスレッド（親へのボタン）を出す。
- セッションIDと cwd は、選んで写せる文字列として出す。

### 7. GUI：サイドバーのセッションの項目を最大2行にまとめる

- サイドバーのセッションの項目は、最大2行にする。
  - 1行目：提供元のバッジとタイトル（タイトルが無ければセッションID）。
  - 2行目：最後の時刻、メッセージの件数、cwd の最後の要素（ディレクトリの名前）、セッションIDの先頭8文字を、この順に「·」で区切って出す。cwd が無ければ cwd の要素を省く。
  - どちらの行も折り返さず、はみ出す分は末尾を「…」で切る。
- 項目にマウスを載せたときのツールチップ（`title` 属性）に、タイトル、セッションID（全体）、cwd（全体）、期間を出す。
- 検索の結果の項目は、いまの形（タイトル、役割と時刻、抜粋）のままにする。

### 8. 文書

- `docs/specifications.md` の `chat-log` の節に、`search --session`、`show --message --range`、`export --message`、ヘルプの読み手を書く。GUI の節に、コピーのボタン、メタデータの欄、サイドバーの項目を書く。
- README の `chat-log` と GUI の説明に、同じことを書く。

## 実装しないこと

- 番号でメッセージを指すいまの形（`show --around <番号>`）を変えること。
- `context` と `sessions` に `--session` を足すこと。`sessions` で1つのセッションを見るには `show` を使う。
- テキストの出力（`search`、`show`）の各行にメッセージIDを出すこと。行が長くなり、エージェントが読む量が増えるためである。メッセージIDは `--json` で得られる。
- GUI で、IDを貼りつけてセッションやメッセージを開くこと。
- 複数のメッセージを選んでまとめてコピーすること。
- 検索の結果の項目の形を変えること。

## 不変条件

- I1：`show --message <ID> --range <前>:<後>` が出すメッセージの番号は、そのメッセージの番号を n、セッションの件数を N として、`max(1, n−前)` から `min(N, n+後)` までの連続した番号である。
- I2：`show --message <ID> --json` の出力には、`uuid` が、決まったメッセージのメッセージIDと一致する行がちょうど1つある。
- I3：前と後が等しいか、前が後より1大きく、かつ n−前 ≥ 1 と n+後 ≤ N が成り立つとき、`show --message <ID> --range <前>:<後> --json` と `show <そのセッションID> --around <n> --limit <前+後+1> --json` は、同じ番号のメッセージを同じ順に出す（`provider` と `session_id` のキーを除く）。
- I4：候補が2個以上のときは、終了コード2で、候補をすべて標準エラー出力に書き、標準出力には何も書かない。
- I5：`search <語> --session <ID>` の結果は、`search <語>` の結果のうち、そのセッションのものと同じ集合である（`--limit` と `--offset` を十分に大きくしたとき）。
- I6：`export <セッションID> --message <ID>` の出力は、`export <セッションID>` の出力の中の、そのメッセージの節と同じ文字列である（書くものが無いメッセージを除く）。
- I7：`export --message <ID>` の出力は空にならない。
- I8：GUI の `copy_session` がクリップボードに書く文字列は、同じセッションの `chat-log export` の標準出力と同じである。
- I9：GUI の `copy_session` と `copy_message` は、`chat-log` を起動できなかったとき、または終了コード0以外で終わったとき、クリップボードを変えない。
- I10：サイドバーのセッションの項目の高さは、どのセッションでも2行を超えない。
- I11：8文字未満のメッセージIDは、データベースの中身によらず、終了コード2になる。

| 入力 | 期待 | 不変条件 |
| --- | --- | --- |
| メッセージIDが7文字 | 使い方の誤り。終了コード2 | I11 |
| メッセージIDが8文字ちょうどで、一致する候補が無い | 終了コード1 | なし |
| メッセージIDの先頭8文字が1つに一致 | そのメッセージと前後 | I1, I2 |
| 2つのセッションにあるメッセージID（完全なID）、セッションID無し | 候補2つ。終了コード2 | I4 |
| 同じIDに、セッションIDを添えた | そのセッションのものを出す | I1, I2 |
| 写しの行のメッセージID | 元のメッセージと前後 | I1, I2 |
| ツールの記録など、`session_messages` に無い行だけの uuid | 終了コード1 | なし |
| 1件目のメッセージ、`--range 5` | #1〜#6 | I1 |
| 最後のメッセージ、`--range 5` | #N−5〜#N。続きの行は無い | I1 |
| 1件だけのセッション、`--range 5` | #1 だけ | I1, I2 |
| `--range 0` | そのメッセージだけ。前と続きの行は無い | I1, I2 |
| `--range 2:7` | n−2〜n+7 | I1 |
| `--range -1`、`--range 1:2:3`、`--range a` | 使い方の誤り。終了コード2 | なし |
| `--message` と `--around` | 使い方の誤り。終了コード2 | なし |
| `--range` だけ（`--message` 無し） | 使い方の誤り。終了コード2 | なし |
| `search --session` で、語がそのセッションに無い | 0件。終了コード0 | I5 |
| `search --session` と `--cwd` | 使い方の誤り。終了コード2 | なし |
| 本文が空の思考だけのメッセージを `export --message` | 見出しと「（書く本文が無い）」 | I7 |
| `export --message` と `--thinking` | 使い方の誤り。終了コード2 | なし |
| `bun` が無いパスで `copy_session` | 起動の誤りを返し、クリップボードはそのまま | I9 |
| `chat-log` が終了コード1で終わる `copy_message` | 失敗を返し、クリップボードはそのまま | I9 |
| タイトルが長く cwd も長いセッション | 2行で、末尾を切る | I10 |

## 受けいれ条件

- A1：手元のデータベースで、GUI でコピーしたメッセージIDを `chat-log show --message <ID>` に渡すと、GUI で見ていたメッセージとその前後が出る（Claude Code と Codex のセッションで1つずつ）。
- A2：GUI の「セッションをコピー」で写した文字列が、同じセッションを書き出すボタンで書いたファイルと一致する（`pbpaste | cmp - <ファイル>`）。
- A3：GUI の「コピー」で写したメッセージの文字列が、`chat-log export <セッションID> --message <ID>` の出力と一致する。
- A4：AI のエージェント（Claude Code）に、`chat-log --help` とセッションIDかメッセージIDだけを渡すと、追加の説明なしに `show` か `show --message` で会話を読める。

## テスト設計

`bun test`（`tests/chat-log.test.ts`、`tests/chat-log-markdown.test.ts`）と、Rust の `cargo test`（`gui/src-tauri`）、GUI の純粋な関数のテスト（`gui/tests/`）で、次を先に書いて失敗させる。

1. `ADR 0040 I1, I2`：番号 1〜20 のセッションの #10 のメッセージIDで、`--range` 無し、`--range 0`、`--range 3`、`--range 2:7` の番号の範囲を `--json` で確かめる。
2. `ADR 0040 I1`：#1 と #20 と、1件だけのセッションで、範囲が両端で切られる。テキストの出力で、前と続きの行の有無と、その行が `chat-log show <セッションID> --offset <数>` の形であることを確かめる。
3. `ADR 0040 I3`：#10 で、`--range 4`（4:4）と `--around 10 --limit 9`、`--range 4:3` と `--around 10 --limit 8` のメッセージの番号の並びが同じになる。
4. `ADR 0040 I4, I11`：同じ uuid の行を2つのセッションに置き、セッションID無しでは終了コード2と候補2つ（標準出力は空）、セッションIDを添えると1つが出る。7文字のIDは終了コード2。
5. `ADR 0040 I2`：写しの行の uuid で引くと元のメッセージが出る。`assistant` でも `user` でもない行だけが持つ uuid は終了コード1。
6. `ADR 0040 I5`：2つのセッションに同じ語を置き、`--session` で一方だけが出る。`--session` と `--cwd`・`--since`・`--until` は終了コード2。
7. `ADR 0040 I6, I7`：`export --message` の出力が `export` の全体の中の同じ節（末尾の改行を含めて比べる）と一致する。本文が空の思考だけのメッセージで、見出しと「（書く本文が無い）」が出る。
8. 使い方の誤り：`--range` の不正な値、`show --message` と `--around`・`--limit`・`--offset`・`--since`・`--until`・`--cwd`、`--message` 無しの `--range`、`export --message` と `--range`・`--around`・`--thinking`・`--tools` が終了コード2。
9. `--json`：`show --message --json` の各行に `provider` と `session_id` があり、`uuid` が入力のIDに一致する行が1つある。
10. ヘルプ：`chat-log --help` に「利用者からIDを渡されたとき」の節と、`--session`、`--message`、`--range` の説明があり、`export` のヘルプに「人が読む」が無い。
11. `ADR 0040 I8, I9`（Rust）：`copy_session` と `copy_message` のコマンドの組み立て（`export_command` と同じく、引数の並びを確かめる）。クリップボードへの書き込みを関数の引数にし、`chat-log` を起動できなかったときと、終了コードが0以外のときに、書き込みの関数が呼ばれないことを確かめる。
12. `ADR 0040 I10`（GUI の純粋な関数）：サイドバーの2行目の文字列を作る関数が、cwd の有無で要素を正しく並べ、cwd の最後の要素を取る（末尾の `/` があっても）。2行に収めることは CSS（`truncate`）で行い、手で確かめる（A1 の確かめのときに、長いタイトルと cwd のセッションで見る）。

A1〜A3 は、実装の後に GUI を作りなおして手で確かめる。A4 は、新しい Claude Code のセッションで、ヘルプとIDだけを渡して確かめる。

## トレードオフ

- メッセージIDは、まれに2つのセッションで重なる（277 個）。この場合はセッションIDを添えないと引けない。重ならないIDを新たに作ると、取り込みとスキーマを変えることになるため、いまの uuid をそのまま使う。
- `--range` を `--around` と別に設けるため、前後を取る方法が2つになる。`--around` は番号と件数（`--limit`）で、`--range` はIDと前後の件数で指す。番号は search の結果から、IDは GUI から来るので、入力の出どころに合わせた。
- セッション全体のコピーは、大きなセッションでは数 MB の文字列をクリップボードに置く。書き出すボタンと同じ `chat-log export` を使うので、`chat-log` が無い環境ではコピーもできない。Markdown の規則を Rust と TypeScript の2か所に持たないことを優先した（[ADR 0026](0026-export-sessions-and-highlight-terms.md) と同じ理由）。
- クリップボードに公式のプラグインを足す。画面側の `navigator.clipboard` は、`chat-log` の終了を待った後では、WebKit がユーザーの操作の外として拒むおそれがある（未確認）。プラグインはバックエンドから書くので、この制約を受けない。
- サイドバーの2行目に cwd とIDを足すので、時刻と件数の幅が狭くなることがある。全体はツールチップで見られる。

## 参考文献

- Tauri の Clipboard のプラグイン：https://v2.tauri.app/plugin/clipboard/
- MDN の Clipboard.writeText（ユーザーの操作の要件）：https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText
