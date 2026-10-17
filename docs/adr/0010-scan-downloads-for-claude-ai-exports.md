# ADR 0010: ダウンロードした claude.ai のエクスポートを自動で取り込む

ステータス: 採択

## 文脈

[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) で、claude.ai の会話は公式のエクスポートの zip を `claude-ai-export-convert` に渡して取り込むことにした。
エクスポートは、claude.ai の設定で要求し、メールで届いたリンクから zip をダウンロードする。
[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) は、この要求とダウンロードの自動化を実装しないとした（ログインした状態のブラウザの操作や、認証情報の扱いが要るため）。

いまは、ダウンロードした後も、利用者が zip を `claude-ai-export-convert` か GUI の管理画面（[ADR 0007](0007-settings-and-setup-screen.md)）に渡す必要がある。
利用者と相談し、要求とダウンロードは手で行い、ダウンロードした後を自動にすることにした。

2026-10-17 に、手元の実物のエクスポートを確かめた。

- ダウンロードフォルダに `conversations-000.zip` があり、中身はルートの `conversations.json` 1つだった。
- 名前の `-000` から、エクスポートが複数の zip に分かれる場合があると見られるが、実物は1つしか無い。分かれ方（各 zip に `conversations.json` の一部が入るのか、など）は分からない。
- 公式の名前の決まりは公開されていない。

macOS は、ダウンロードフォルダなどを、プライバシーの保護（TCC）の対象にしている。
ターミナルから起動したプロセスはターミナルの許可を引き継ぐが、launchd から起動した pm2 の子プロセスが読もうとすると、許可を求めるダイアログが出るか、黙って拒否される（`EPERM`）ことがある。
pm2 の定期実行（[ADR 0002](0002-periodic-sync-with-pm2.md)）は `pm2 startup` で launchd から起動するため、この影響を受けうる。

## 実装すること

### 受け取り用のディレクトリ

- 新しい設定 `AI_CHAT_LOGS_CLAUDE_AI_INBOX`。既定は `~/Downloads`。環境変数、`.env`、設定ファイルから読む（[ADR 0004](0004-load-environment-from-dotenv.md)、[ADR 0007](0007-settings-and-setup-screen.md)）。
- GUI の管理画面の設定の項目と、環境の検査のパスの一覧に加える（[ADR 0007](0007-settings-and-setup-screen.md) の表に1行足す）。

### `claude-ai-export-scan`

新しいコマンド `claude-ai-export-scan` を足す。

1. 受け取り用のディレクトリの直下にある `*.zip` を、名前の順に見る（下の階層は見ない）。
2. 各 zip の中身の一覧（`unzip -Z1`。展開はしない）に、ルートか1段下の `conversations.json` があるものを、claude.ai のエクスポートとみなす。名前の形には頼らない。ほかの zip は飛ばす。
3. エクスポートとみなした zip の `conversations.json` の SHA-256 を、展開せずに読んで求める（`unzip -p`）。[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) の出力先 `<AI_CHAT_LOGS_CLAUDE_AI_DIR>/<SHA-256 の先頭16文字>/messages.jsonl` が既にあれば、取り込み済みとして飛ばす。
4. まだのものは、[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) の変換（`claude-ai-export-convert` と同じ処理）で出力先に置く。
5. 新しく置いた出力先のディレクトリを、1行ずつ標準出力に書く。
6. 受け取り用のディレクトリが無ければ、何もせずに終わる。
7. zip ごとの失敗（壊れた zip、正しくない JSON）は標準エラー出力に書き、ほかの zip を続ける。読めないディレクトリ（TCC の拒否を含む）は標準エラー出力に書く。どちらかがあれば、終了コードを1にする。

zip は消さない、動かさない。
変換の処理は `claude-ai-export-convert` と共通の関数にする。

### `bin/sync` と `ai-chat-logs-sync`

`bin/sync`（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md)）と、インストールした `ai-chat-logs-sync`（[ADR 0008](0008-install-compiled-commands.md)）は、列挙の前に `claude-ai-export-scan` を実行する。

- `claude-ai-export-scan` が失敗しても、列挙と取り込みは続ける。最後の終了コードは、どちらかが失敗していれば1にする。
- これにより、pm2 の毎時の取り込みでも、ダウンロードしたエクスポートが自動で取り込まれる。
- `bin/install` は `claude-ai-export-scan` も実行ファイルにして入れる。

### GUI の閲覧の画面

閲覧の画面（[ADR 0003](0003-tauri-log-viewer-with-search.md)）の左の、プロジェクトの絞り込みの近くに、小さなボタン「ダウンロードしたエクスポートを取り込む」を足す。
管理画面（[ADR 0007](0007-settings-and-setup-screen.md)）の「初期化」の節には置かない。取り込みやデータベースの作成のボタンの隣で押し間違えないようにするため。

- 押すと、`claude-ai-export-scan` を実行し、続けて `bin/sync` を実行する。[ADR 0007](0007-settings-and-setup-screen.md) の「取り込む」と同じく、`bun` のディレクトリを `PATH` の先頭に足し、設定の値を環境変数で渡し、[ADR 0007](0007-settings-and-setup-screen.md) の操作と合わせて同時に1つだけ実行する。
- 実行中はボタンを押せなくし、ボタンの下に「取り込み中」と出す。
- 終わったら、ボタンの下に短く結果を出す。新しいエクスポートがあれば「claude.ai のエクスポートを N 件取り込みました」、無ければ「新しいエクスポートはありません」、失敗したら「失敗しました（終了コード N）」。詳しい出力（`claude-ai-export-scan` の出力先の一覧と、出力の最後の20行）は、その下に折りたたんで出す。
- `claude-ai-export-scan` が失敗しても `bin/sync` は実行し、失敗したことを出す。
- 終わったら、データベースを開きなおし、プロジェクトの絞り込みとセッションの一覧を読みなおす。開いている会話はそのままにする。
- ボタンにマウスを重ねると、いまの受け取り用のディレクトリを出す（`title` 属性）。
- 新しいコマンド `scan_claude_ai_exports`（引数なし）を足す。

GUI は、ターミナルや pm2 とは別のアプリとして TCC の許可を受ける。GUI からは読めても pm2 からは読めない、またはその逆がありうる。

### README

「手動で行う作業」の claude.ai の手順を、「エクスポートを要求し、届いたリンクから zip をダウンロードする。あとは次の取り込みで自動で入る」に改める。
pm2 がダウンロードフォルダを読めない場合の確かめ方（`pm2 logs ai-chat-logs-sync` に `Operation not permitted` が出る）と、対処（ダウンロードフォルダ以外を `AI_CHAT_LOGS_CLAUDE_AI_INBOX` に設定して zip をそこに置く、または システム設定 → プライバシーとセキュリティ で許可する）を書く。

## 実装しないこと

- エクスポートの要求、メールの受信、zip のダウンロードの自動化（[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) のとおり）。
- 取り込んだ zip の削除や移動。
- 受け取り用のディレクトリの下の階層の探索。
- 展開済みの `conversations.json`（zip でないもの）の自動の取り込み。手で `claude-ai-export-convert` に渡す。ダウンロードフォルダの JSON ファイルを、エクスポートかどうか確実に見分けられないため。
- ファイルの変化の監視（毎時の取り込みのときに見るだけ）。
- TCC の許可を自動で求めること。
- GUI での受け取り用のディレクトリの監視（ボタンを押したときと、毎時の取り込みのときだけ見る）。

## テスト設計

`bun test` で、一時ディレクトリを受け取り用のディレクトリにして確かめる。

1. ルートに `conversations.json` がある zip と、1段下にある zip が変換され、出力先が標準出力に出る。
2. 名前が `conversations-*.zip` でない zip でも、中に `conversations.json` があれば変換される。中に無い zip は飛ばされる。
3. 下の階層の zip は見ない。zip でないファイル（`conversations.json` を含む）は見ない。
4. 2回目の実行では、取り込み済みの zip を変換しなおさず、何も出力しない。同じ中身の zip が2つあっても、1回だけ変換される。
5. 分割を想定し、それぞれ別の `conversations.json` を持つ2つの zip が、別々の出力先に変換される。
6. 壊れた zip と、正しくない JSON を持つ zip があっても、ほかの zip は変換され、終了コードが1になる。
7. 受け取り用のディレクトリが無いときは、何もせずに終了コード0で終わる。
8. 設定 `AI_CHAT_LOGS_CLAUDE_AI_INBOX` を、環境変数、`.env`、設定ファイルから読む。既定は `~/Downloads`。
9. `bin/sync`：受け取り用のディレクトリにエクスポートの zip を置いて実行すると、claude.ai の会話がデータベースに入る。`claude-ai-export-scan` が失敗しても取り込みは行われ、終了コードが1になる。
10. `bin/install` が `claude-ai-export-scan` も入れ、`ai-chat-logs-sync` が受け取り用のディレクトリの zip を取り込む。
11. GUI（`cargo test`）：設定の項目に `AI_CHAT_LOGS_CLAUDE_AI_INBOX` があり、既定が `~/Downloads`。コマンドの環境変数に渡る。
12. GUI（`cargo test`）：`claude-ai-export-scan` のコマンドの組み立て（`bun` と、リポジトリの `src/cli/claude-ai-export-scan.ts`、環境変数）。
13. GUI（`cargo test`）：`claude-ai-export-scan` の標準出力から、新しく取り込んだエクスポートの出力先の一覧を取り出す（空の出力では空の一覧）。

### 手で確かめること

1. ダウンロードフォルダに実物のエクスポートがある状態で、pm2 の定期実行（launchd から起動したもの）が zip を読めるか。`pm2 logs ai-chat-logs-sync` と、データベースの `runs` 表で確かめる。読めない場合は、README の対処を試し、結果をプルリクエストに書く。
2. 実物の `conversations-000.zip` が、取り込み済み（[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) で手で取り込んだもの）として飛ばされる。
3. 閲覧の画面の「ダウンロードしたエクスポートを取り込む」を押すと、新しいエクスポートが無い旨が出る。受け取り用のディレクトリに新しいエクスポートの zip を置いて押すと、取り込んだ件数が出て、セッションの一覧に会話が出る。開いていた会話はそのまま残る。GUI からダウンロードフォルダを読めるか（TCC）もここで確かめる。

## トレードオフ

- 要求とダウンロードは手のままのため、claude.ai の会話は利用者がエクスポートしたときにしか新しくならない。そのかわり、認証情報もブラウザの操作も要らない。
- zip の中身で見分けるため、毎時、受け取り用のディレクトリの zip の一覧を読む。zip の中身の一覧は中央ディレクトリだけを読むので軽い。エクスポートとみなした zip だけ `conversations.json` を読んでハッシュを求める（実物で 36MB）。取り込み済みかどうかの記録を別に持てば読まずに済むが、状態のファイルを増やさないほうを選ぶ。
- ダウンロードフォルダは TCC の対象のため、環境によっては pm2 から読めない。読めない場合は、受け取り用のディレクトリを変える手段を残す。
- zip を消さないため、ダウンロードフォルダに古いエクスポートが残り続ける。取り込み済みかは中身のハッシュで分かるので、残っていても二重には入らない。

## 参考文献

- Claude のデータのエクスポート（Anthropic のヘルプセンター）：https://support.anthropic.com/en/articles/9450526-how-can-i-export-my-claude-ai-data
- Info-ZIP の `unzip`（`-Z1`、`-p`）：`man unzip`、`man zipinfo`
- Apple のプラットフォームのセキュリティ（ユーザデータの保護、TCC）：https://support.apple.com/guide/security/welcome/web
