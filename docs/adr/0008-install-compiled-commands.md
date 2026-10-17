# ADR 0008: コマンドを実行ファイルにビルドして ~/.local/bin に入れる

ステータス: 採択→claude-ai-export-scan のインストールは[ADR 0010](0010-scan-downloads-for-claude-ai-exports.md)

## 文脈

取り込みのコマンド（[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) の `claude-log-sources`、`chat-log-import`、[ADR 0006](0006-import-cowork-and-claude-ai-chats.md) の `claude-ai-export-convert`）は、リポジトリの中で `bun src/cli/<名前>.ts` として実行している。
利用者から、すべてのコマンドをビルドして `~/.local/bin` に入れたいと求められた。

Bun の `bun build --compile` で、Bun の実行環境を含む単体の実行ファイルを作れる。
手元（Bun 1.4.3）で確かめたところ、そのまま実行ファイルにすると次の2つが ADR と食い違う。

- 実行ファイルの中では `import.meta.dir` が `/$bunfs/root` になる。リポジトリの `.env` の既定の場所（[ADR 0004](0004-load-environment-from-dotenv.md)）を `import.meta.dir` から求めているため、`.env` が見つからなくなる。
- 実行ファイルは、既定で実行したディレクトリの `.env` を自動で読む（`--compile-autoload-dotenv` が既定で有効）。[ADR 0004](0004-load-environment-from-dotenv.md) は、実行したディレクトリの `.env` を読まないと決めている。

`bun build --define` で、ビルドのときに値を埋めこめることも確かめた。

## 実装すること

### `bin/install`

シェルスクリプト `bin/install [<インストール先>]` を置く。インストール先の既定は `~/.local/bin`。

1. 次の3つのコマンドを `bun build --compile` で実行ファイルにし、インストール先に置く。名前は `package.json` の `bin` と同じ。
   - `claude-log-sources`（`src/cli/sources.ts`）
   - `chat-log-import`（`src/cli/import.ts`）
   - `claude-ai-export-convert`（`src/cli/claude-ai-export-convert.ts`）
2. ビルドには次を付ける。
   - `--no-compile-autoload-dotenv`、`--no-compile-autoload-bunfig`：実行したディレクトリの `.env` と `bunfig.toml` を読まない。
   - `--define AI_CHAT_LOGS_REPO_AT_BUILD='"<リポジトリの絶対パス>"'`：リポジトリの場所を埋めこむ。`.env` の既定の場所は、埋めこんだリポジトリの `.env` になる。
3. 取り込みのスクリプト `ai-chat-logs-sync` をインストール先に置く。`bin/sync` と同じく、列挙の結果を一度受けてから取り込みに渡すが、`bun` とリポジトリではなく、同じディレクトリにインストールした実行ファイルを使う。引数は `chat-log-import` に渡す。
4. 置いたファイルのパスを1行ずつ標準出力に書く。
5. 書きこみは、一時ファイルに作ってから名前を変えて置きかえる（実行中のファイルを壊さないため）。

埋めこむリポジトリの場所は、テストのために環境変数 `AI_CHAT_LOGS_REPO_AT_BUILD` で変えられる。

### `src/env.ts`

リポジトリの場所を、`AI_CHAT_LOGS_REPO_AT_BUILD` が定義されていればその値、無ければこれまでどおり `import.meta.dir` の親とする。

### 更新

リポジトリを更新したら、`bin/install` を実行しなおす。README の「手動で行う作業」に書く。

pm2 の定期実行（[ADR 0002](0002-periodic-sync-with-pm2.md)）と GUI の取り込み（[ADR 0007](0007-settings-and-setup-screen.md)）は、これまでどおりリポジトリの `bin/sync` を使う。インストールした実行ファイルには依存しない。

## 実装しないこと

- GUI のインストール（`/Applications` への配置）。
- pm2 の定期実行を、インストールした `ai-chat-logs-sync` に切りかえること。
- アンインストールのコマンド（置いたファイルを消せば足りる）。
- 署名と公証。
- macOS（Apple Silicon）以外向けのビルド。

## テスト設計

`bun test` で、一時ディレクトリをインストール先にして `bin/install` を実行し、次を確かめる。

1. 3つの実行ファイルと `ai-chat-logs-sync` が置かれ、実行できる。標準出力に4つのパスが出る。
2. `claude-log-sources` の実行ファイルが、一時ディレクトリの `HOME` の履歴を列挙する。
3. 実行したディレクトリに `.env` があっても読まない。
4. 埋めこんだリポジトリの `.env`（テストでは `AI_CHAT_LOGS_REPO_AT_BUILD` で一時ディレクトリを埋めこむ）を読む。
5. 設定ファイル（[ADR 0007](0007-settings-and-setup-screen.md)）を読む。
6. `ai-chat-logs-sync` を、インストール先だけを `PATH` に足して実行すると、一時のデータベースに取り込まれる。`bun` が `PATH` に無くても動く。
7. 2回実行しても成功する（置きかえ）。

## トレードオフ

- 実行ファイルは Bun の実行環境を含むため、1つあたり数十MBになる。リポジトリの `bun src/cli/<名前>.ts` を呼ぶ薄いスクリプトなら小さく、リポジトリの更新もすぐ反映されるが、`bun` とリポジトリが要る。ビルドしたものを置くという求めに合わせて、単体で動く実行ファイルにする。
- リポジトリの場所を埋めこむため、リポジトリを動かしたら `bin/install` をやりなおす必要がある。
- リポジトリを更新しても、インストールした実行ファイルは古いままになる。データベースのスキーマ（マイグレーション）が新しい実行ファイルで先に当たると、古い実行ファイルは新しい版を知らないまま動く。更新のたびに `bin/install` を実行しなおす手順を README に書いて扱う。

## 参考文献

- Bun の単体の実行ファイル（`--compile`、`--compile-autoload-dotenv`、`--define`）：https://bun.com/docs/bundler/executables
