# ADR 0005: 履歴の GUI の訂正と細部

ステータス: 採択→GUI での設定ファイルと .env の読み込みは[ADR 0007](0007-settings-and-setup-screen.md)

## 文脈

[ADR 0003](0003-tauri-log-viewer-with-search.md) は、GUI がデータベースを探す規則を「[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) と同じ規則」とし、括弧の中で既定のパスを `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude.sqlite` と書いた。
[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) は、採択の前に、Claude 以外の AI の余地を残すため既定のファイル名を `logs.sqlite` に改めた。
[ADR 0003](0003-tauri-log-viewer-with-search.md) の括弧の中だけが古い名前のまま残り、コミット済みのため書きかえられない。

また、[ADR 0003](0003-tauri-log-viewer-with-search.md) を実装するにあたり、[ADR 0003](0003-tauri-log-viewer-with-search.md) が決めていない細部をいくつか決める必要があった。

- セッションの要約に、メッセージの無いセッション（`mode` などのレコードだけのファイル）を含めるか。
- FTS5 の `snippet()` は `MATCH` のある問い合わせでしか使えない。3文字未満の語だけで検索するときの抜粋をどう作るか。
- 抜粋で強調する部分の区切りの文字。
- 実際の履歴では、同じセッションの JSONL が2つのプロジェクトのディレクトリに写しとして残っていることがある（セッションの fork によるものと見られる）。中のレコードは `uuid` もセッション ID も同じため、どちらのファイルからも取り込まれ、検索の結果、会話、件数が二重になった。
- 実際の履歴で最大のセッションは 15,104 件、68MB あり、その大半はツールの入出力だった。[ADR 0003](0003-tauri-log-viewer-with-search.md) のとおり会話をすべて一度に送って描くと、開くのに約20秒かかった。
- GUI を Finder などから起動すると、シェルの環境変数も、[ADR 0004](0004-load-environment-from-dotenv.md) の `.env` も読まれない。

## 実装すること

### 訂正：データベースの既定の場所

GUI のデータベースの既定の場所は、[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) のとおり `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite` とする。
`AI_CHAT_LOGS_DB` があればそれを使う。

### 細部

- 本文の取り出しの規則と、セッションの要約の作り方は、SQL のビュー（`record_text_source`、`session_summary_source`）に書く。取り込みの差分の反映と、マイグレーションのときの既存の行からの作成の両方で、同じビューを使う。提供元を足すときは、ビューに `UNION ALL` の枝を足す。
- セッションの要約は、`user` か `assistant` のレコードが1つ以上あるセッションだけを作る。
- セッションの `first_at`、`last_at` は、そのセッションの `user` と `assistant` のレコードの時刻の最小と最大とする。`cwd` は、時刻の順で最初の、`cwd` を持つ `user` か `assistant` のレコードのもの。
- `custom-title` の「最後」は、ファイルのパスと行番号の順で最後のものとする（`custom-title` のレコードには時刻が無い）。
- デスクトップアプリのセッションの「最新の版」は、`file_versions` に最後に入った版とする。
- 抜粋の強調の区切りには、私用領域の文字 U+E000（開始）と U+E001（終了）を使う。履歴の本文に現れにくく、HTML の特殊文字とも重ならない。
- 3文字以上の語があるときは、FTS5 の `snippet()` で抜粋を作る。3文字未満の語だけのときは、Rust で本文から最初に一致した語の前後を切り出し、同じ区切りの文字で囲む。
- 同じ提供元・同じセッション ID・同じ `uuid` のレコードは、ファイルのパス、`generation`、行番号の順で最初のものだけを、会話と検索の結果に出し、要約の件数にも1回だけ数える。`uuid` の無いレコードは重複を除かない。`records` の行は [ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) のとおりすべて残し、除くのはビューと問い合わせの中だけとする。
  - `session_messages` ビューで重複を除き、`get_session` と要約はこのビューを使う。
  - 検索は、一致した行から同じ方法で重複を除いてから、並べて件数を切る。
- `get_session` の各メッセージには、`records` の `rowid` を付ける。
- `thinking`、`tool_use`、`tool_result`、その他のブロックの本文は、4,000 文字を超えたら先頭の 4,000 文字だけを送り、切ったことと元の文字数を付ける。新しいコマンド `get_block`（引数は `rowid` とブロックの位置）で、そのブロックの全文を返す。画面では、切ったブロックに「全文を読み込む」のボタンを出す。
- 折りたたんだ部分（`thinking` などのブロックと、サイドチェーンのレコード）の中身は、開いたときに初めて組み立てる。
- GUI は `.env` を読まない。Finder などから起動した場合は、`AI_CHAT_LOGS_DB` も無いため、既定の場所を探す。既定以外の場所を使う場合は、シェルから `AI_CHAT_LOGS_DB` を付けて起動する。

### テスト設計への追加

[ADR 0003](0003-tauri-log-viewer-with-search.md) のテスト設計に、次を足す。

1. メッセージの無いセッションの要約が作られない。
2. 3文字未満の語だけの検索で、本文から切り出した抜粋が区切りの文字で囲まれて返る。
3. データベースの既定の場所が `ai-chat-logs/logs.sqlite` で終わり、`AI_CHAT_LOGS_DB` が優先される。
4. 同じセッション ID と `uuid` のレコードが2つのファイルにあっても、要約の件数は1回だけ数えられ、`get_session` と検索の結果にも1回だけ出る。`uuid` の無いレコードは重複を除かない。
5. 4,000 文字を超えるブロックは切られて、切ったことと元の文字数が付き、`get_block` で全文が返る。4,000 文字以下のブロックは切られない。

## 実装しないこと

- GUI での `.env` の読み込み。必要になったら別の ADR で足す（Rust で [ADR 0004](0004-load-environment-from-dotenv.md) と同じ書式のパーサが要る）。
- 同じパスの複数の版（`generation`）にまたがる重複の除去のうち、`uuid` の無いレコードのもの。
- 会話のページ分け（一部だけを読み込むこと）。ブロックを切ることで足りるかを先に確かめる。

## テスト設計

上の「テスト設計への追加」のとおり。[ADR 0003](0003-tauri-log-viewer-with-search.md) のテストとあわせて実行する。

## トレードオフ

- 規則を SQL のビューに書くため、取り込みの側の TypeScript の抽出の関数（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md)）と書き方が揃わない。そのかわり、差分の反映とマイグレーションで同じ定義を使え、Rust のテストでもスキーマを当てるだけで同じ規則が手に入る。
- 3文字未満の語だけのときの抜粋は、FTS5 の `snippet()` と切り出し方が少し異なる。
- 重複を除く規則（パスの順で最初のもの）は、写しの内容が食い違っていても片方しか見せない。`uuid` が同じなら同じレコードとみなす。
- ブロックを切るため、長いツールの出力の全文を見るにはボタンを押す必要がある。そのかわり、大きなセッションでも送る量が抑えられる。
- 検索の索引（`record_texts`）には、重複したレコードも入る。索引から除くと、後から取り込んだファイルが「最初」になったときに索引を入れかえる必要があるため、除くのは問い合わせの時点にする。

## 参考文献

- SQLite FTS5 の補助関数（`snippet()`）：https://www.sqlite.org/fts5.html#the_snippet_function
- Unicode の私用領域（Private Use Area）：https://www.unicode.org/faq/private_use.html
