# ADR 0007: パスの設定と初期化を行う管理画面

ステータス: 採択

## 文脈

設定（データベースや履歴の場所）は、環境変数と、リポジトリの `.env`（[ADR 0004](0004-load-environment-from-dotenv.md)）で渡している。
初期化（データベースの作成と最初の取り込み）は、README の手順に沿ってシェルで行う。
利用者から、各種のパスの設定と初期化を行う管理画面が欲しいと求められた。

これまでの決定との関係は次のとおり。

- [ADR 0003](0003-tauri-log-viewer-with-search.md) は、GUI を読むだけにし、「設定画面」と「GUI からの取り込みの実行」を作らないとした。
- [ADR 0005](0005-log-viewer-corrections-and-details.md) は、GUI が `.env` を読まないとした。Finder から起動したアプリには環境変数が渡らないため、既定以外の場所は起動のたびに渡す必要がある。
- リポジトリの `.env` は、リポジトリの場所に依存する。GUI のアプリはリポジトリの外（`/Applications` など）にも置かれる。

利用者と決めたこと：

- 設定は `~/.config` の設定ファイルに保存し、CLI と GUI の両方が読む。
- 管理画面は、いまの GUI に画面として足す。
- 初期化に含めるのは、環境の検査、データベースの作成と取り込み、claude.ai のエクスポートの取り込み（[ADR 0006](0006-import-cowork-and-claude-ai-chats.md)）。pm2 への登録は含めない。

## 実装すること

### 1. 設定ファイル

- 場所は `AI_CHAT_LOGS_CONFIG`、無ければ `${XDG_CONFIG_HOME:-~/.config}/ai-chat-logs/config.env`。
- 書式は [ADR 0004](0004-load-environment-from-dotenv.md) の `.env` と同じ。
- 値の優先順位は、高いほうから次のとおり。
  1. 環境変数
  2. リポジトリの `.env`（`AI_CHAT_LOGS_ENV_FILE`。[ADR 0004](0004-load-environment-from-dotenv.md)）
  3. 設定ファイル
  4. 既定の値
- CLI（`claude-log-sources`、`chat-log-import`、`claude-ai-export-convert`）と `ecosystem.config.cjs` は、`.env` を読んだ後に、設定ファイルを同じ規則（既にある変数は上書きしない）で読む。
- GUI も、環境変数、リポジトリの `.env`、設定ファイルを同じ順で読む。[ADR 0005](0005-log-viewer-corrections-and-details.md) の「GUI は `.env` を読まない」を改める。
- GUI が書くのは設定ファイルだけ。環境変数とリポジトリの `.env` は書かない。

### 2. 設定する項目

| 変数 | 意味 | 既定 |
|---|---|---|
| `AI_CHAT_LOGS_DB` | データベースのパス | `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite` |
| `CLAUDE_CONFIG_DIR` | Claude Code の設定ディレクトリ | `~/.claude` |
| `AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR` | デスクトップアプリのディレクトリ（新しく設定できるようにする） | `~/Library/Application Support/Claude` |
| `AI_CHAT_LOGS_CLAUDE_AI_DIR` | claude.ai のエクスポートの保存用のディレクトリ（[ADR 0006](0006-import-cowork-and-claude-ai-chats.md)） | `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude-ai` |
| `AI_CHAT_LOGS_REPO` | このリポジトリの場所。GUI が取り込みのコマンドを実行するのに使う | GUI のビルド時のリポジトリの場所 |
| `AI_CHAT_LOGS_BUN` | `bun` のパス。GUI が取り込みのコマンドを実行するのに使う | 下の「`bun` の探し方」 |

- `AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR` は、CLI の列挙（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md)、[ADR 0006](0006-import-cowork-and-claude-ai-chats.md)）でも使う。
- `AI_CHAT_LOGS_REPO` と `AI_CHAT_LOGS_BUN` は GUI だけが使う。
- `AI_CHAT_LOGS_CRON` は管理画面では扱わない。pm2 の登録をしなおす必要があり、pm2 の操作は管理画面に含めないため。
- `XDG_DATA_HOME` と `XDG_CONFIG_HOME` は管理画面では扱わない（ほかのアプリと共通の変数のため）。

`bun` の探し方（GUI）：`AI_CHAT_LOGS_BUN`、環境変数 `PATH` の中、`~/.bun/bin/bun`、`~/.local/share/mise/shims/bun`、`/opt/homebrew/bin/bun`、`/usr/local/bin/bun` の順で、最初に実行できるもの。Finder から起動したアプリの `PATH` は最小限のため、よく使う場所も探す。

### 3. 管理画面

画面の上に「閲覧」と「管理」の切り替えを置く。
データベースが見つからない、またはスキーマが古いときは、起動時に管理画面を開く。

管理画面は3つの節からなる。

#### 設定

- 各項目について、いまの値と、その値がどこから来たか（環境変数、`.env`、設定ファイル、既定）を出す。
- 値を入力して保存すると、設定ファイルに書く。空にして保存すると、設定ファイルからその項目を消す（既定に戻る）。
- 環境変数か `.env` で決まっている項目は、設定ファイルに書いても効かないため、その旨を出す。
- 保存すると、データベースを開きなおす。

設定ファイルの書き方：

- 項目ごとに `名前="値"` の1行で書く。値の `\` と `"` は `\\`、`\"` にする。改行を含む値は保存しない（エラーを出す）。
- 管理画面が扱う項目以外の行（コメントやほかの変数）は、そのまま残す。扱う項目の行は、最初の行を書きかえ、2行目以降を消す。
- 一時ファイルに書いてから名前を変えて置きかえる。ディレクトリが無ければ作る。

#### 環境の検査

次を一覧で出す。読むだけで、何も変えない。

- 各パスがあるか（ファイルかディレクトリか）。
- データベース：あるか、スキーマの版、レコードの数、セッションの数、最後の取り込み（`runs` の最後の行の時刻、件数、失敗）。
- `bun`：見つかったパスと版（`bun --version`）。
- pm2：`pm2` が見つかるか（`bun` と同じディレクトリ、`PATH`、`~/.bun/bin`、`~/.cache/.bun/bin`）、`ai-chat-logs-sync` が登録されているか（`pm2 jlist`）、`~/Library/LaunchAgents/pm2.*.plist` があるか。見つからない場合は、README の「手動で行う作業」を見るよう出す。

#### 初期化

- 「取り込む」：`<AI_CHAT_LOGS_REPO>/bin/sync` を実行する。データベースが無ければ、このとき作られる。
- 「claude.ai のエクスポートを取り込む」：ファイルを選ぶ画面で zip を選ぶと、`claude-ai-export-convert <zip>` を実行し、続けて `bin/sync` を実行する。
- コマンドは、`bun` のディレクトリを `PATH` の先頭に足し、設定の値を環境変数として渡して実行する。
- 実行中はボタンを押せなくし、「実行中」と出す。終わったら、終了コードと標準エラー出力の最後の20行を出し、データベースを開きなおす。
- 同時に実行できるのは1つだけ。

ファイルを選ぶ画面には、Tauri の公式のプラグイン `tauri-plugin-dialog` を使う。WebView の `<input type="file">` ではファイルのパスが得られないため。

### 4. 書き方とモジュール

- Rust に、[ADR 0004](0004-load-environment-from-dotenv.md) と同じ書式のパーサを書く（`dotenv.rs`）。TypeScript の `src/dotenv.cjs` と解釈がずれないように、入力と期待する結果の組を `tests/fixtures/dotenv-cases.json` に置き、`bun test` と `cargo test` の両方で使う。
- 設定の解決（各項目の値と出どころ）、設定ファイルの書きかえ、`bun` の探し方の候補の並び、コマンドの引数と環境変数の組み立ては、入出力の無い関数にする。

## 実装しないこと

- pm2 の操作（登録、`startup`、`save`、削除）。状態を出すだけ。
- `AI_CHAT_LOGS_CRON`、`XDG_DATA_HOME`、`XDG_CONFIG_HOME` の編集。
- リポジトリの `.env` の編集。
- 取り込みの進み具合の逐次表示。終わってから結果を出す。
- 取り込みの中断。
- データベースの削除や作りなおし。

## テスト設計

### 設定ファイル（`bun test`）

1. `tests/fixtures/dotenv-cases.json` の各組について、`parseDotenv` の結果が期待どおり。
2. CLI が設定ファイルを読む：設定ファイルの `CLAUDE_CONFIG_DIR` を `claude-log-sources` が使う。`.env` と環境変数があれば、そちらが優先される。`AI_CHAT_LOGS_CONFIG` で場所を変えられる。設定ファイルが無くてもエラーにならない。
3. 書式の誤りのある設定ファイルでは、CLI が終了コード2で終わり、パスと行番号が出る。
4. `ecosystem.config.cjs` が、設定ファイルの `AI_CHAT_LOGS_CRON` を使う。
5. `AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR` で、デスクトップアプリのディレクトリを変えられる。

### GUI のバックエンド（`cargo test`）

6. `tests/fixtures/dotenv-cases.json` の各組について、Rust のパーサの結果が期待どおり。
7. 設定の解決：環境変数、`.env`、設定ファイル、既定の順に決まり、出どころが正しい。空の値は無いものとして扱う。
8. 設定ファイルの書きかえ：扱う項目の行の置きかえ、重複した行の削除、空の値での削除、ほかの行とコメントの保持、`\` と `"` の逃がし。書いた結果を読みなおすと、書いた値になる。改行を含む値はエラー。
9. 設定ファイルの保存：ディレクトリが無ければ作り、一時ファイルから置きかえる。
10. `bun` の探し方：候補の並びが上のとおりで、実行できる最初のものを選ぶ。
11. コマンドの組み立て：`bin/sync` と `claude-ai-export-convert` の引数、`PATH` の先頭に `bun` のディレクトリ、設定の値が環境変数に入る。
12. 環境の検査：データベースがある・無い・古い場合の結果。`runs` の最後の行が返る。

### 手で確かめること

1. データベースの無い状態（`AI_CHAT_LOGS_DB` に存在しないパスを指定）で GUI を起動すると、管理画面が開く。「取り込む」でデータベースが作られ、閲覧の画面に一覧が出る。
2. 設定でデータベースのパスを変えて保存すると、`config.env` に書かれ、そのデータベースが開く。シェルの CLI もその値を使う。
3. 環境の検査に、`bun`、pm2 の登録、launchd の登録が正しく出る。
4. claude.ai のエクスポートの zip を選んで取り込むと、閲覧の画面に「claude.ai」の会話が出る（[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) の実装の後）。
5. Finder から起動したアプリ（`/Applications` に置いたもの）でも、上の 1〜3 が動く。

## トレードオフ

- 設定の置き場所が、環境変数、リポジトリの `.env`、設定ファイルの3つになる。管理画面で各項目の出どころを出すことで、どれが効いているかを分かるようにする。
- 同じ書式のパーサを TypeScript と Rust の2つに持つ。共通の入力例でテストして、ずれを防ぐ。
- GUI がリポジトリのコマンドを実行するため、GUI だけでは完結せず、リポジトリと `bun` が要る。取り込みの実装を Rust で持ちなおすより、既存の CLI を使うほうを選ぶ。
- `tauri-plugin-dialog` の依存が増える。ファイルのパスを得る手段がほかに無いため。
- GUI のデータベースは読み取り専用のまま。書き込むのは子プロセスの CLI だけにする。

## 参考文献

- Tauri の dialog プラグイン：https://v2.tauri.app/plugin/dialog/
- XDG Base Directory Specification：https://specifications.freedesktop.org/basedir-spec/latest/
