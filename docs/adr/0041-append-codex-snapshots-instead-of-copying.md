# ADR 0041: Codex のログを写しの作りなおしでなく追記で保存し、重複を除く

Status: proposed

## 文脈

データベースが、2026-11-08 の `VACUUM` の直後の 5.35 GB から、2026-11-17 に 45.0 GB まで増えた。
増えた分のほとんどは、Codex の取り込み（[ADR 0034](0034-import-codex-rollouts.md)、[ADR 0036](0036-codex-hourly-collection.md)、[ADR 0038](0038-save-logs-before-compaction.md)）による同じ行の重複である。

この ADR では、次の語を使う。

- 元のファイル：Codex が書く JSONL（`~/.codex/sessions` と `archived_sessions` の下）。
- 保存用ディレクトリ：`AI_CHAT_LOGS_CODEX_STORE`（既定は `~/.local/share/ai-chat-logs/codex`）。
- 保存先：保存用ディレクトリの直下の、名前が SHA-256 の16進64桁のディレクトリ。元データの写し `rollout.jsonl`、変換結果 `messages-v1.jsonl`、manifest を持つ。
- スナップショット：この ADR より前の規則で作られた保存先。

[ADR 0034](0034-import-codex-rollouts.md) は、元のファイルが伸びるたびに、その時点の完成した行までをまるごと新しい保存先として保存すると決めた。
保存先の名前は、その内容の SHA-256 である。
取り込み（`chat-log-import`）は、保存先ごとの `rollout.jsonl` と `messages-v1.jsonl` を、別々の取り込み元（`sources` の行）として全行入れる。
その ADR は、差分の保存をしないとし、容量は実装の後に測るとしていた。
[ADR 0036](0036-codex-hourly-collection.md) で毎時の収集を、[ADR 0038](0038-save-logs-before-compaction.md) で圧縮の直前の保存を加えたため、長く続く会話ほど、ほぼ同じスナップショットが何十個もできる。

利用者からは、DB の増え方を抑えたい、ただし古いログは消さない、と求められている。
本 ADR は、保存先を作りなおす保存をやめて追記にし、いまある重複を、記録を失わないことを確かめたうえで除く。

## 調査した事項

2026-11-17 に、手元の環境で次を確かめた。

DB（`~/.local/share/ai-chat-logs/logs.sqlite`）は 45,015,601,152 バイトで、スキーマは 8 だった。
`dbstat` による表ごとの大きさは次のとおり（MB）。

| 表 | 大きさ |
|---|---|
| `records` | 23,021 |
| `record_tool_texts_data` | 9,771 |
| `record_tool_texts_content` | 4,397 |
| `payloads` | 1,880 |
| `record_texts_data` | 1,636 |
| `records_session_order` | 1,287 |
| `record_texts_content` | 879 |
| `records_uuid_session` | 753 |

`records` を取り込み元の種類ごとに数えると、次のとおりだった（`raw` はバイト数の合計）。

| 種類 | 行 | `raw` |
|---|---|---|
| `codex/rollout` | 8,673,033 | 8.02 GB |
| `codex/conversation` | 3,545,407 | 3.41 GB |
| `claude-code/transcript` | 1,150,335 | 2.23 GB |
| そのほか | 5,215 | 0.02 GB |

保存用ディレクトリは 21 GB で、スナップショットは 2,071 個あった。
`manifest-v1.json` の `sourcePath` で数えると、元のファイルは 911 個だった。
一つの元のファイルから作られたスナップショットは、最も多いもので 106 個だった。
`~/.codex/sessions` は 1.8 GB で、JSONL は 903 個だった。
911 と 903 の違いは、移されたか消された元のファイルのスナップショットが残っているためと見ている（未確認）。

スナップショットの大きさを合計すると、`rollout.jsonl` は 15.86 GB、`messages-v1.jsonl` は 6.18 GB だった。
`sourcePath` ごとに `rollout.jsonl` の最も大きいスナップショットだけを数えると、`rollout.jsonl` は 1.97 GB、`messages-v1.jsonl` は 0.72 GB だった。

`sourcePath` ごとに、最も大きいスナップショットのほかのスナップショット 1,160 個の `rollout.jsonl` を、最も大きいものの先頭と比べた。
1,160 個すべてが、最も大きいものの先頭とバイト単位で一致した。
つまり、古いスナップショットの `rollout.jsonl` にしか無い行は無い。

DB の側では、最も大きいスナップショットから入った行と、ほかのスナップショットから入った行は次のとおりだった。

| 種類 | 最も大きいスナップショット | ほかのスナップショット |
|---|---|---|
| `codex/rollout` | 853,684 行、1.10 GB | 7,819,349 行、6.92 GB |
| `codex/conversation` | 336,544 行、0.51 GB | 3,208,863 行、2.90 GB |

変換（`src/codex.ts` の `convertCodexLines`）が、元のファイルの先頭の一部を変換した結果と、全体を変換した結果の先頭とで一致するかを確かめた。
`~/.codex/sessions/2026/11` の大きい順の 40 ファイルで、行数の 10%、30%、50%、70%、90% で切った 200 通りを比べた。
199 通りで、一部の変換の結果は、全体の変換の結果の先頭と一致した。
一致しなかった 1 通りは、先頭の `custom-title` の行だけが違った。
切った範囲に通常の user の本文が無く、タイトルが会話 ID になったためである。
変換は、タイトルを最初の通常の user の本文から決め、その行を出力の先頭に置く（`src/codex.ts` の 103 行目）。
表示項目の行が 1 つも無いときは、`custom-title` の行を出さない（同じ行）。

取り込みは、行の種類の取り込み元について、同じパスのファイルに追記された行だけを、同じ取り込み元に足す（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md)。`src/import.ts` の `importLines`）。
Codex の表示用のデータ（[ADR 0037](0037-codex-session-presentation.md)。`src/codex-presentation.ts`）は、会話ごとに `rollout.jsonl` の取り込み元の `consumed_bytes` の最も大きいものを代表とし、そのディレクトリ名をハッシュとして記録する。
取り込み元の最大の rowid、代表のハッシュ、規則の版が前と同じ会話は、作りなおしを飛ばす。

表の無い SQLite のデータベースの `BEGIN EXCLUSIVE` が、プロセスのあいだのロックとして働くかを、Bun（`bun:sqlite`）で確かめた。
プロセス A が `BEGIN EXCLUSIVE` を 3 秒持つあいだ、`busy_timeout` を 1000 ミリ秒にしたプロセス B の `BEGIN EXCLUSIVE` は、1,089 ミリ秒後に `database is locked` で失敗した。
A が終わった後のプロセス C は、すぐにロックを取れた。
`BEGIN EXCLUSIVE` の後に `SIGKILL` で止めたプロセスの後も、プロセス D はすぐにロックを取れた。

利用者の Codex は、2026-11-17 の時点で使える量を使い切っており、新しい Codex のログは作れない。

## 実装すること

### 1. 保存先への追記

元のファイル 1 つにつき、追記の対象の保存先を 1 つにし、伸びた分を追記する。

#### manifest

保存先に `manifest-v2.json` を置く。
`manifest-v1.json` と両方あるときは、`manifest-v2.json` を正とする。
この ADR の後に作る保存先には、`manifest-v2.json` だけを置く。
`manifest-v2.json` は次を持つ。

| キー | 中身 |
|---|---|
| `converterVersion` | 変換器の版 |
| `sourcePath` | 保存先を作ったときの元のファイルのパス。追記で変えない |
| `firstLineSha256` | `rollout.jsonl` の 1 行目（改行を含む）の SHA-256。完成した行が無ければ null |
| `rolloutBytes`、`rolloutLines`、`rolloutSha256` | 公開した `rollout.jsonl` の範囲のバイト数、行数、SHA-256 |
| `messagesBytes` | 公開した `messages-v1.jsonl` の範囲のバイト数 |
| `messageLines` | 公開した `messages-v1.jsonl` の範囲の、`custom-title` でない行の数（`manifest-v1.json` と同じ意味） |
| `lastSourceOrder` | 公開した `messages-v1.jsonl` の、`custom-title` でない行の `sourceOrder` の最大。行が無ければ 0 |
| `title` | 公開した `messages-v1.jsonl` の最後の `custom-title` の値。無ければ null |
| `sessions` | 公開した範囲の会話の数 |
| `warnings`、`status` | 最後に追記した変換の、伸びた分の行の警告の件数と、全体を変換した終了コード |

`converterVersion` は変換器の版であり、manifest の形の版はファイル名で表す。
`manifest-v2.json` が JSON として読めないか、必要なキーが無いか、`rolloutBytes` と `messagesBytes` がファイルの大きさを超える保存先は、候補にも列挙にも入れず、失敗として報告する。

「公開した範囲」とは、ファイルの先頭から manifest に書いたバイト数までをいう。
公開した範囲より後ろのバイトは、まだ公開していない。

#### 保存先の名前

保存先の名前は、作ったときの内容の SHA-256 とする。
名前は識別子であり、後から追記しても変えない。
そのため、追記した後の保存先では、名前と内容の SHA-256 が一致しない。
[ADR 0037](0037-codex-session-presentation.md) の「代表スナップショットのハッシュ」は代表の保存先の名前と読み、同じ大きさのときに「SHA-256 の辞書順で最小」を選ぶ決まりは、名前の辞書順で最小を選ぶと読む。

#### 保存先の決め方

変換は、元のファイルを読み（[ADR 0034](0034-import-codex-rollouts.md) の読み取りの確かめはそのまま）、完成した行までを入力とする。
名前が 16 進 64 桁の保存先のうち、入力の 1 行目の SHA-256 と同じ `firstLineSha256` を持つものを候補とし、次の順に決める。
この決め方と、追記、新しい保存先の作成は、すべて下のロックを取ったまま行う。

1. 入力が空か、完成した行が無いときは、[ADR 0034](0034-import-codex-rollouts.md) のとおり、0 行の保存先を作るか、同じ名前のものを使う。この保存先は追記の対象にしない。
2. 候補のどれかの公開した範囲の先頭が、入力とバイト単位で一致する（入力が候補の先頭か、候補と同じ）ときは、何もしない。そのときの終了コードは、その候補の manifest の `status` とする（[ADR 0034](0034-import-codex-rollouts.md) の、既存の同じスナップショットを使うときも失敗の状態を返す決まりを引き継ぐ）。
3. 公開した範囲が入力の先頭とバイト単位で一致する候補があれば、その中で `rolloutBytes` の最も大きいものに追記する。同じ大きさのものが複数あれば、名前の辞書順で最小のものを使う。
4. どれでもないときは、新しい保存先を作る。元のファイルが書きかえられた（先頭が一致しない）ときもこれに当たり、ほかの保存先は変えない。

一致は、ファイルの該当する範囲の SHA-256 を比べて確かめる。
候補には、`manifest-v1.json` だけを持つ保存先も含める。
その保存先の公開した範囲は、`rollout.jsonl` 全体とする。
`manifest-v1.json` だけを持つ保存先に追記するときは、ファイルに何かを書く前に、そのときの `rollout.jsonl` と `messages-v1.jsonl` の全体を公開した範囲とする `manifest-v2.json` を作る。

#### ロック

保存先を決め、作り、追記する処理と、下の 3 の整理は、保存用ディレクトリ全体で 1 つの排他ロックを取ってから行う。

- ロックには、保存用ディレクトリの `.lock.sqlite`（SQLite のデータベース）を使い、`BEGIN EXCLUSIVE` のトランザクションを持つあいだをロックを取っているとする。このファイルには表を作らない。
- SQLite のロックは OS のファイルのロックなので、プロセスが止まると OS が外す。プロセスの ID で生死を確かめることはしない。
- 待つのは 5 秒（`busy_timeout`）までとする。待っても取れなければ、その元のファイルを飛ばし、変換を終了コード 1 にする。飛ばした分は、次の実行で追記される。
- ロックは、元のファイル 1 つの処理（保存先を決め、作るか追記し、manifest を置きかえるまで）ごとに取り、終わったら放す。
- ロックは、`bin/sync`、`bin/sync-codex`、圧縮の直前の保存（[ADR 0038](0038-save-logs-before-compaction.md)）のどれが変換しても取る。

#### 追記の手順

ロックを取った後、次の順で追記する。

1. `rollout.jsonl` と `messages-v1.jsonl` が公開した範囲より長ければ、公開した範囲まで切り詰める。
2. `rollout.jsonl` の末尾に、入力の、公開した範囲より後ろの完成した行を書く。
3. 元のファイルの先頭から入力の終わりまでを `convertCodexLines` にかける。その結果の `custom-title` でない行のうち、`sourceOrder` が `lastSourceOrder` より大きいものを、出力の順に `messages-v1.jsonl` の末尾に書く。
4. 3 の結果に `custom-title` の行があり、その値が `title` と違えば、その行を `messages-v1.jsonl` の末尾に書く。
5. 両方のファイルを `fsync` してから、`manifest-v2.json` を一時ファイルに書き、`rename` で置きかえる。
6. ロックを放す。

公開した範囲のバイトは、後から書きかえも切り詰めもしない。
切り詰めるのは、公開していない範囲だけである。
変換の警告は、元のファイルの行の番号が、追記の前の `rolloutLines` より大きい行のものだけを出す。

#### 新しい保存先を作るとき

[ADR 0034](0034-import-codex-rollouts.md) のとおり、一時ディレクトリに書き、`rename` で公開する。
置くのは `rollout.jsonl`、`messages-v1.jsonl`、`manifest-v2.json` とする。
同じ名前の保存先がすでにあるときは、その保存先が 2 の条件を満たすので、何もしない。

### 2. 取り込み

保存先 1 つの `rollout.jsonl` と `messages-v1.jsonl` を、これまでどおり、それぞれ 1 つの取り込み元として扱う。
追記された行は、取り込みの既存の規則（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md)）で、同じ取り込み元に足される。

取り込みは、`codex/rollout` と `codex/conversation` の取り込み元を、同じ保存先の公開した範囲までしか読まない。
そのため、取り込みはファイルごとに次の順で読む。

1. ファイルの大きさを `stat` で得る。
2. 同じ保存先の `manifest-v2.json` を一度だけ読む。あれば、`rolloutBytes` か `messagesBytes` と 1 の大きさの小さいほうを、そのファイルの「取り込む大きさ」とする。無ければ、1 の大きさを取り込む大きさとする。
3. 取り込む大きさを、ファイルの大きさの代わりに、変更の判定（`detectChange`）、読む範囲の終わり、`sources.size` に使う。

追記は、`manifest-v2.json` を作るより前にファイルを伸ばさない（1 の「保存先の決め方」と「追記の手順」）。
そのため、2 で `manifest-v2.json` が無ければ、1 で得た大きさは公開した範囲を超えない。
取り込む大きさは公開した範囲を超えないので、公開していない範囲が後で切り詰められても、取り込み済みの範囲は変わらない。

`codex-log-sources` は、`manifest-v1.json` か `manifest-v2.json` を持ち、名前が SHA-256 の 16 進 64 桁の保存先を列挙する。

### 3. いまある重複の整理

一度だけ実行するコマンド `codex-store-dedupe` を足す。
`--dry-run` では何も変えず、消す予定の保存先、取り込み元、行の数と大きさ、消さない保存先とその理由を出す。
利用者は、pm2 の `ai-chat-logs-sync` と `ai-chat-logs-codex-sync` を止めてから実行する。
圧縮の直前の保存（[ADR 0038](0038-save-logs-before-compaction.md)）は止められないので、コマンドは保存先ごとのロックを取ってから扱う。

コマンドは、`sourcePath` ごとに、残す保存先を次のとおり決める。

- `rollout.jsonl` の公開した範囲の最も大きい保存先を残す。同じ大きさのものが複数あれば、名前の辞書順で最小のものを残す。
- 残す保存先の 2 つの取り込み元が DB に無ければ、その `sourcePath` の保存先は何も消さない。

残さない保存先は、次の条件をすべて満たすときだけ消す。

- その保存先の `rollout.jsonl` が、残す保存先の `rollout.jsonl` の先頭とバイト単位で一致する。
- DB の、その保存先の `codex/rollout` の取り込み元の各行の `raw`（ペイロードを戻したもの。[ADR 0031](0031-store-large-strings-as-compressed-payloads.md)）が、残す保存先の取り込み元の、同じ `line_no` の行と一致する。
- 消す保存先と残す保存先の、どの取り込み元も `generation` が 1 つだけである。
- DB の、その保存先の `codex/conversation` の取り込み元の、`custom-title` でない各行の `raw` が、残す保存先の取り込み元のどれかの行と一致する。

条件を満たさない保存先は消さず、理由を出す。
元のファイルのパスが変わり、`sourcePath` が違う保存先は、別のものとして扱う。

消す手順は、途中で止まっても、もう一度実行すれば終わるように、次の順とする。

1. 残す保存先に `manifest-v2.json` が無ければ作る。
2. 消す保存先の名前を、`.dedupe-<元の名前>` に変える。この名前は列挙されない。
3. `sourcePath` ごとに 1 つのトランザクションで、消す保存先の 2 つの取り込み元の `records`、`record_texts` と `record_tool_texts` の行、`sources` の行を消す。続けて、影響したセッションの要約と、`codex_session_presentation` と `codex_item_presentation` の行を消し、作りなおす。4. すべての `sourcePath` を終えた後に、別のトランザクションで、`payload_state` が 1 のどの `records.raw` も目印（`"\u0000ai-chat-logs-payload:<sha256>"`）として含まない `payloads` の行を消す。
5. `.dedupe-` で始まる保存先を消す。

もう一度実行したときは、`.dedupe-` で始まる保存先を、名前を変えた後の状態として 3 から続ける。
3 で取り込み元がすでに無い `.dedupe-` の保存先は、5 で消す。

### 4. 消してよい行

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) と `docs/specifications.md` の、取り込み済みの行を消さない決まり、および [ADR 0031](0031-store-large-strings-as-compressed-payloads.md) の「`payloads` の行は消さない」には、次の例外を設ける。

- `codex-store-dedupe` は、残す保存先に同じ `raw` があると確かめた行を消してよい。
- `codex-store-dedupe` は、`codex/conversation` の `custom-title` の行を消してよい。この行は `rollout.jsonl` から変換しなおせば得られ、残す保存先にも、その時点の全体から求めたタイトルの行がある。
- `codex-store-dedupe` は、どの `records.raw` からも指されない `payloads` の行を消してよい。

ほかのコマンドは、これまでどおり行を消さない。

### 5. 変わる決まり

この ADR は、次の決まりを置きかえる。

| ADR | 置きかえる決まり | この ADR での決まり |
|---|---|---|
| [ADR 0034](0034-import-codex-rollouts.md) | 「同じハッシュの保存先が公開済みなら再変換しない」 | 1 の「保存先の決め方」 |
| [ADR 0034](0034-import-codex-rollouts.md) | 「公開済みファイルを上書きしない」 | 公開した範囲を書きかえない。公開していない範囲は切り詰める |
| [ADR 0034](0034-import-codex-rollouts.md) | manifest に「原本のハッシュ」を保存する | `manifest-v2.json` の `rolloutSha256` |
| [ADR 0034](0034-import-codex-rollouts.md) | 「Codex の入力が伸びた場合は、その時点の完成した行までを別のスナップショットとして保存する」 | 追記の対象の保存先に追記する |
| [ADR 0034](0034-import-codex-rollouts.md) | 「初版ではスナップショット間の差分保存をしない」 | 伸びた分だけを追記する |
| [ADR 0034](0034-import-codex-rollouts.md) | 実装しないこと「スナップショットの自動削除、差分だけを保存する最適化」 | 差分の追記をする。削除は 3 の整理だけ |
| [ADR 0034](0034-import-codex-rollouts.md) | 不変条件 P6「列挙される保存先は、原本、変換結果、manifest が揃っている」 | 列挙される保存先は、manifest と、公開した範囲の原本と変換結果が揃っている |
| [ADR 0036](0036-codex-hourly-collection.md) | 実装しないこと「スナップショットの削除、差分保存」 | 差分の追記をする。削除は 3 の整理だけ |
| [ADR 0036](0036-codex-hourly-collection.md) | 実装しないこと「独自のスケジューラや実行ロックの追加」 | 1 のロックを足す |
| [ADR 0036](0036-codex-hourly-collection.md) | 「公開の競合は既存のスナップショット公開規則…で扱い」 | 公開の競合は 1 のロックで扱う |
| [ADR 0037](0037-codex-session-presentation.md) | 同じ大きさなら「SHA-256 の辞書順で最小のもの」を代表にする | 保存先の名前の辞書順で最小のもの |
| [ADR 0037](0037-codex-session-presentation.md) | 「新しいスナップショットを取り込んだ場合は、その会話の代表選択と項目情報を再計算する」 | 保存先に行が追記されて取り込まれた場合も再計算する |
| [ADR 0031](0031-store-large-strings-as-compressed-payloads.md) | 「`payloads` の行は消さない」 | 4 の例外 |
| [ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) | 「元のファイルが書きかえられたり削除されたりしても、取り込み済みの行は消さない」 | 4 の例外 |

採択したら、置きかえた ADR のステータスを、置きかえた部分を指して変える。

### 6. 文書

`docs/specifications.md` の次の節を直す。

- 「Codex の原本と変換」（伸びたログを全体の新しいスナップショットとして保持する、という記述）
- 「行ごとの取り込み」
- 「ペイロード」（消さない、という記述）
- 「検索の索引とセッションの要約」（`records` から消さない、という記述）
- 「Codex の表示」と「Codex の会話表示」（[ADR 0037](0037-codex-session-presentation.md)）
- 「Codex の毎時収集」（[ADR 0036](0036-codex-hourly-collection.md)）と「圧縮直前の取り込み」（[ADR 0038](0038-save-logs-before-compaction.md)）

README の「Codex のログを保存する」と「データベースを縮める」に、`codex-store-dedupe` の手順を書く。
手順は、取り込みを止める、`--dry-run`、実行、`VACUUM`、取り込みを再開する、の順とする。

## 実装しないこと

- 元のファイルのパスが変わったときに、`sourcePath` の違う保存先を同じ会話とみなして整理すること。1 行目と先頭の内容が一致すれば、新しい内容は同じ保存先に追記される。
- 書きかえられた元のファイル（先頭が一致しないもの）の差分の保存。
- Claude の取り込み元や、ほかの種類の重複の整理。
- 全文検索の索引の構成の変更（本文の写しを索引から外すことなど）。
- `codex-store-dedupe` を `bin/sync` から自動で実行すること。
- `VACUUM` を自動で実行すること。

## 不変条件

- I1: 追記を何回に分けても、各変換の後、保存先の `rollout.jsonl` の公開した範囲は、元のファイルの先頭の同じバイト数とバイト単位で一致する。
- I2: 追記を何回に分けても、`messages-v1.jsonl` の公開した範囲の `custom-title` でない行の並びは、その時点の `rollout.jsonl` の公開した範囲を一度に `convertCodexLines` にかけた結果の `custom-title` でない行の並びと一致する。
- I3: 追記を何回に分けても、`messages-v1.jsonl` の公開した範囲の最後の `custom-title` の行の値は、一度に変換した結果の `custom-title` の値と一致する。一度に変換した結果に `custom-title` の行が無ければ、`messages-v1.jsonl` にも無い。
- I4: 変換の前の公開した範囲のバイト列は、変換の後の同じファイルの先頭と一致する。元のファイルが伸びていなければ、`rollout.jsonl`、`messages-v1.jsonl`、`manifest-v2.json` のどれも変わらない。
- I5: 各保存先について、取り込みの後、その `rollout.jsonl` を取り込み元とする `codex/rollout` の行の数は、公開した範囲の空でない行の数と一致する。
- I6: 取り込みは、公開した範囲より後ろの行を DB に入れない。
- I7: 元のファイルの先頭が、どの保存先の公開した範囲とも一致しなくなったとき、新しい保存先が作られ、ほかの保存先のファイルは変わらない。
- I8: ほかのプロセスがロックを持つあいだ、変換は保存用ディレクトリに書かず、5 秒待っても取れなければ終了コードは 1 になる。同じ元のファイルを 2 つのプロセスが同時に変換しても、I1、I2、I5 が成り立ち、追記の対象の保存先は 1 つである。
- I9: `codex-store-dedupe` が消す行の `raw`（ペイロードを戻したもの）は、`custom-title` の行を除き、すべて残す保存先の取り込み元の行として DB に残る。
- I10: `codex-store-dedupe` の後、どれかの `records.raw` が目印として含む SHA-256 の `payloads` の行はすべて残り、どれも含まない行は残らない。
- I11: `codex-store-dedupe --dry-run` は、DB と保存用ディレクトリのどちらも変えない。
- I12: `codex-store-dedupe` をどの手順の後で止めても、もう一度実行すれば、止めずに実行したときと同じ DB と保存用ディレクトリになる。
- I13: `codex-log-sources` は、`manifest-v2.json` だけを持つ保存先も列挙し、`.dedupe-` で始まる保存先は列挙しない。保存先の決め方も、`.dedupe-` で始まる保存先を候補にしない。
- I14: `manifest-v1.json` だけを持つ保存先に追記すると、追記の前の `rollout.jsonl` と `messages-v1.jsonl` の全体が公開した範囲の先頭に残り、取り込みは追記の前に入れた行を入れなおさない。

| 入力 | 期待 | 不変条件 |
|---|---|---|
| 空の元のファイル | 0 行の保存先。追記の対象にならない | I1, I5 |
| `session_meta` の 1 行だけの元のファイル | `rollout.jsonl` は 1 行、`messages-v1.jsonl` は空、`title` は null | I1, I3 |
| 末尾が未完の行 | 未完の行は書かない | I1 |
| 1 行ずつ追記して毎回変換 | 一度に変換した結果と一致 | I1, I2, I3, I4 |
| 最初の user の本文が後から来る | 新しい `custom-title` の行が追記される | I3 |
| 何も伸びていない | ファイルも `manifest-v2.json` も変わらない | I4, I5 |
| 既存の保存先より短い同じ先頭の入力 | 何もしない | I4, I7 |
| 先頭の 1 バイトが書きかわった | 新しい保存先 | I7 |
| `rollout.jsonl` を行の途中まで書いて止まった | 取り込みは公開した範囲まで。次の実行で切り詰めて書きなおし、行は重複しない | I1, I5, I6 |
| `messages-v1.jsonl` を書いた後、manifest を書く前に止まった | 同上 | I2, I5, I6 |
| ほかのプロセスがロックを 5 秒より長く持つ | 書かずに終了コード 1 | I8 |
| 2 つのプロセスが同じ元のファイルを同時に変換 | 追記の対象は 1 つで、行は重複しない | I1, I2, I5, I8 |
| 候補が 2 つあり、同じ大きさ | 名前の辞書順で最小のものに追記 | I1 |
| `manifest-v1.json` だけを持つ保存先が伸びた | `manifest-v2.json` を作ってから追記し、取り込みは入れなおさない | I6, I14 |
| 古いスナップショットが先頭と一致しない | 消さずに理由を出す | I9 |
| 古いスナップショットにだけある `messages-v1.jsonl` の行 | そのスナップショットを消さない | I9 |
| 残す保存先が DB に無い | 何も消さない | I9 |
| どこからも指されなくなったペイロード | 消える | I10 |
| 整理の手順 2 の後で止めて再実行 | 止めずに実行したときと同じ | I12 |
| `generation` が 2 つある取り込み元 | 消さずに理由を出す | I9 |

## 受けいれ条件

- A1: 手元の DB と保存用ディレクトリの写しで `codex-store-dedupe` を実行し、次を測って実装の PR に書く。
  - 消した保存先、取り込み元、行の数
  - 消さなかった保存先とその理由
  - 実行時間
  - `VACUUM` の後のファイルの大きさと、保存用ディレクトリの大きさ
- A2: A1 の写しで、整理の前後に、すべての Codex のセッションの `chat-log export` の出力を比べ、タイトルの行を除いて一致することを確かめる。
- A3: A1 の写しで、元のファイルの写しを途中で切ってから元に戻して伸びた状態を模し、変換と取り込みを行い、行が重複しないことと、[ADR 0037](0037-codex-session-presentation.md) の表示用のデータが作りなおされることを確かめる。
- A4: 実際の Codex のログが伸びたときに、追記で保存され、DB の行が重複しないことを確かめる。利用者の Codex が使えるようになってから行い、それまでは確かめていないことを実装の PR に書く。

## テスト設計

### 関数とコマンド（`bun test`）

1. `ADR 0041 I1, I4, I5`：フィクスチャの元のファイルに 1 行ずつ追記しながら変換と取り込みを繰り返し、毎回 `rollout.jsonl` の公開した範囲が元のファイルの先頭と一致し、前の公開した範囲が先頭に残り、DB の行が重複しない。
2. `ADR 0041 I2, I3`：最初の user の本文が途中で現れるフィクスチャで、1 行ずつ変換した `messages-v1.jsonl` と、一度に変換した結果を比べる。`session_meta` だけのフィクスチャでは `custom-title` の行が無い。
3. `ADR 0041 I1, I5`：空のファイル、`session_meta` だけのファイル、末尾が未完の行のファイル。
4. `ADR 0041 I4, I7`：既存の保存先より短い同じ先頭の入力では何もしない。先頭が書きかわった入力では新しい保存先ができ、ほかの保存先のファイルが変わらない。
5. `ADR 0041 I1, I2, I5, I6`：`rollout.jsonl` を行の途中まで書いた状態と、`messages-v1.jsonl` を書いた後で manifest を書く前の状態を作る。それぞれで取り込みが公開した範囲までしか入れず、次の変換で整い、DB の行が重複しない。
6. `ADR 0041 I8`：テストのプロセスが `.lock.sqlite` の `BEGIN EXCLUSIVE` を持つあいだ、変換は書かずに終了コード 1 になる。ロックを持ったプロセスを止めると、次の変換は追記する。2 つの変換を同時に動かしても、追記の対象は 1 つで、行は重複しない。
6a. `ADR 0041 I1`：同じ大きさの候補が 2 つあるとき、名前の辞書順で最小のものに追記する。
6b. `ADR 0041 I6, I14`：`manifest-v1.json` だけを持つ保存先を取り込んだ後に、元のファイルを伸ばして変換と取り込みを行い、`manifest-v2.json` ができ、追記の前の行が入れなおされない。
7. `ADR 0041 I9`：スナップショットを 3 つ持つ元のファイルの DB と保存用ディレクトリで `codex-store-dedupe` を実行し、残す保存先の取り込み元に、消した行の `raw` がすべてある。先頭が一致しないスナップショット、`messages-v1.jsonl` にだけ違う行があるスナップショット、残す保存先が DB に無い場合、`generation` が 2 つある場合は消えない。
8. `ADR 0041 I10`：消したスナップショットにだけあったペイロードが消え、残る行が指すペイロードは残る。
9. `ADR 0041 I11`：`--dry-run` の前後で、DB のファイルと保存用ディレクトリの内容のハッシュが変わらない。
10. `ADR 0041 I12`：手順 1 から 4 のそれぞれの後と、手順 5 で一部の保存先を消した後で止めた状態から再実行し、止めずに実行した結果と同じ DB の行と保存用ディレクトリになる。
11. `ADR 0041 I13`：`codex-log-sources` が `manifest-v2.json` だけを持つ保存先を列挙し、`.dedupe-` で始まる保存先を列挙しない。保存先の決め方が `.dedupe-` で始まる保存先に追記しない。

### 手で確かめること

受けいれ条件の A1 から A4 を手で確かめる。
A1 から A3 は、DB と保存用ディレクトリの写しで行い、確かめた後に写しを消す。

## トレードオフ

- 保存先のファイルが追記で変わるようになり、[ADR 0034](0034-import-codex-rollouts.md) の「公開済みファイルを上書きしない」より弱くなる。代わりに、公開した範囲を変えないこと（I4）と、取り込みが公開した範囲までしか読まないこと（I6）を保つ。
- ロックと、公開していない範囲の切り詰めが加わる。`rename` で一度に公開するやり方より、手順が多い。
- ロックは保存用ディレクトリ全体で 1 つなので、別々の元のファイルの変換も順に行われる。毎時の収集と圧縮の直前の保存が重なると、一方が最大 5 秒待ち、取れなければ次の実行に回る。
- 変換は、伸びるたびに元のファイルの先頭から全体を変換する。変換の時間はこれまでと同じだが、書く量と DB に入れる量は伸びた分だけになる。
- タイトルが変わるたびに `custom-title` の行が増える。セッションのタイトルは、パスと行番号の順で最後の `custom-title` で決まる。取り込み元が 1 つのセッションでは、最後の行が全体から求めたタイトルになる。書きかえで保存先が 2 つ以上になったセッションでは、保存先の名前の順で決まり、古いタイトルが選ばれることがある。この決め方は変えない。
- `codex-store-dedupe` は DB の行と保存用ディレクトリのファイルを消す。消すのは、残す保存先に同じ内容があると確かめた行とファイル、変換しなおせば得られる `custom-title` の行、どこからも指されないペイロードだけである。
- 元のファイルのパスが変わった会話のスナップショットは、整理の対象にならず、重複が残る。
- A4 は、利用者の Codex が使えるようになるまで確かめられない。そのあいだは、A3 の模した伸び方で確かめる。

## 参考文献

- SQLite の `VACUUM`：https://www.sqlite.org/lang_vacuum.html
- SQLite の `dbstat`：https://www.sqlite.org/dbstat.html
- SQLite の File Locking And Concurrency：https://www.sqlite.org/lockingv3.html
- SQLite の `BEGIN EXCLUSIVE`：https://www.sqlite.org/lang_transaction.html
