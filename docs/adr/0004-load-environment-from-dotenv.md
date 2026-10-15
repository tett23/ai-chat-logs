# ADR 0004: .env から環境変数を読む

ステータス: 採択→設定ファイルからの読み込みは[ADR 0007](0007-settings-and-setup-screen.md)

## 文脈

[ADR 0001](0001-import-claude-chat-logs-into-sqlite.md) と [ADR 0002](0002-periodic-sync-with-pm2.md) の設定は、すべて環境変数で渡す（`AI_CHAT_LOGS_DB`、`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`AI_CHAT_LOGS_CRON`）。
pm2 で動かす場合は、`pm2 start` を実行したシェルの環境変数を引き継ぐため、設定を変えるたびに環境変数を付けて登録しなおす必要があり、何を設定したかが残らない。
設定をファイルに書いて残せるように、`.env` から環境変数を読めるようにする。

`.env` を読む側は2つある。

- 取り込みの CLI（`src/cli/sources.ts`、`src/cli/import.ts`）。Bun で動く。
- `ecosystem.config.cjs`。pm2 が Node.js で読む。`AI_CHAT_LOGS_CRON` はここで読む。

既存の仕組みを手元（Bun 1.4.3、Node.js 26.11.1）で確かめたところ、次の違いがあった。

| | Bun の自動の読み込み | Bun の `--env-file` | Node.js の `process.loadEnvFile()` |
|---|---|---|---|
| 読むファイル | 実行したディレクトリの `.env` など | 指定したファイル | 指定したファイル |
| ファイルが無いとき | 何もしない | 何もしない | 例外（`ENOENT`） |
| 既にある環境変数 | 上書きしない | 上書きしない | 上書きしない |
| `$X` の展開 | する | する | しない |

Bun の自動の読み込みは、実行したディレクトリに依存する。
別のプロジェクトのディレクトリで `bin/sync` を実行すると、そのプロジェクトの `.env` を読んでしまう。
また、`$` の展開の有無が Bun と Node.js で異なるため、同じ `.env` が CLI と pm2 で別の値になりうる。

`.env` の書式は単純で、必要な機能も限られるため、パーサを自前で書き、CLI と `ecosystem.config.cjs` の両方から同じものを使う。

## 実装すること

### 読むファイル

- 既定は、リポジトリのルートの `.env`（`ecosystem.config.cjs` と同じディレクトリ）。実行したディレクトリには依存しない。
- 環境変数 `AI_CHAT_LOGS_ENV_FILE` があれば、そのパスのファイルを読む。
- ファイルが無ければ何もしない（エラーにしない）。
- 既にある環境変数は上書きしない。シェルや pm2 から渡した値が `.env` より優先される。
- 名前の制限はしない。どの変数も `.env` に書ける。このツールが読むのは `AI_CHAT_LOGS_DB`、`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`AI_CHAT_LOGS_CRON`。

### 読む場所

- CLI は、起動の直後、ほかの環境変数を読む前に `.env` を読む。
- Bun の自動の読み込みは止める。`bin/sync` は `bun --no-env-file` で CLI を実行し、CLI のシバンも `#!/usr/bin/env -S bun --no-env-file` にする。
- `ecosystem.config.cjs` は、`cron_restart` を決める前に `.env` を読む。CLI は自分で `.env` を読むため、pm2 からアプリに渡す環境変数は変えない（`PATH` だけ）。

### 書式

`.env` は UTF-8 の行の並び。各行を次のように解釈する。

- 行末の `\r` は除く。
- 空の行と、空白を除いた先頭が `#` の行は飛ばす。
- 先頭に `export ` があれば除く。
- 最初の `=` の左を名前、右を値とする。名前は前後の空白を除き、`[A-Za-z_][A-Za-z0-9_]*` でなければエラー。`=` の無い行もエラー。
- 値は前後の空白を除いてから、次のように解釈する。
  - `"` で始まる場合：次の、`\` で逃がされていない `"` までが値。`\n`、`\"`、`\\` を、それぞれ改行、`"`、`\` にする。ほかの `\` はそのまま残す。
  - `'` で始まる場合：次の `'` までが値。中身はそのまま。
  - 閉じる引用符の後には、空白と、`#` で始まるコメントだけを置ける。ほかの文字や、閉じる引用符が無い場合はエラー。
  - 引用符で始まらない場合：空白の直後の `#` から後ろをコメントとして除き、残りの後ろの空白を除いたものが値。
- `$` による変数の展開と `~` の展開はしない。
- 引用符の中で行をまたぐ値は扱わない。
- 同じ名前が2回以上あれば、後のものを使う。

エラーのメッセージには、ファイルのパスと行番号を含める。
CLI はエラーを標準エラー出力に書いて終了コード2で終わる。`ecosystem.config.cjs` は例外を投げる（`pm2 start` が失敗する）。

### モジュール

- パーサと読み込みは `src/dotenv.cjs` に置く。`ecosystem.config.cjs` が `require` でき、Bun の TypeScript からも `import` できるように、CommonJS の JavaScript で書く。型は `src/dotenv.d.cts` に書く。
- 文字列を解釈する `parseDotenv(text)` と、既にある環境変数を除いて設定する組を選ぶ `pickUnset(env, entries)` は、入出力の無い関数にする。ファイルを読んで `process.env` に設定する `loadDotenv(path, env)` は、それらを組み合わせる。
- クラスは使わない。

### その他

- `.env` は `.gitignore` に入れる。
- 設定できる変数と既定の値を、コメントつきで書いた `.env.example` をリポジトリに置く。中身はすべてコメントにしておき、そのまま `.env` に写しても既定の振る舞いが変わらないようにする。
- README と仕様書に、`.env` の場所、優先順位、書式を書く。

## 実装しないこと

- 実行したディレクトリの `.env`、`.env.local`、`.env.<NODE_ENV>` などの読み込み。
- 変数の展開（`$X`、`${X}`）と `~` の展開。
- 行をまたぐ値。
- XDG の設定ディレクトリ（`~/.config/ai-chat-logs/`）など、リポジトリの外の設定ファイル。
- 環境変数の名前の検査（知らない名前の警告など）。

## テスト設計

### パーサ（`parseDotenv`）

1. `KEY=value` の行、空の行、`#` の行、`export ` つきの行。
2. 値の中の `=`（`A=b=c` は `b=c`）、空の値（`A=`）、前後の空白。
3. 引用符のない値の、空白の直後の `#` からのコメントの除去。空白の無い `#`（`A=b#c` は `b#c`）は残る。
4. `"` で囲んだ値：`#` と空白を含む値、`\n`、`\"`、`\\` の変換、ほかの `\` は残る、閉じた後のコメント。
5. `'` で囲んだ値：中身がそのまま（`\n` も `$` もそのまま）。
6. `$X` と `~` が展開されない。
7. 行末の `\r` が除かれる。
8. 同じ名前は後のものが使われる。
9. エラー：名前が不正（`1A=x`、`A-B=x`）、`=` が無い行、閉じない引用符、閉じた引用符の後の余計な文字。メッセージに行番号が含まれる。

### 読み込み（`pickUnset`、`loadDotenv`）

10. 既にある環境変数は上書きされず、無いものだけが設定される。
11. ファイルが無いときは何もせず、エラーにならない。
12. 書式のエラーのメッセージに、ファイルのパスと行番号が含まれる。

### CLI と `bin/sync`

13. `AI_CHAT_LOGS_ENV_FILE` で指定した `.env` の `CLAUDE_CONFIG_DIR` を `claude-log-sources` が使う。
14. `AI_CHAT_LOGS_ENV_FILE` で指定した `.env` の `AI_CHAT_LOGS_DB` を `chat-log-import` が使う。シェルの `AI_CHAT_LOGS_DB` があればそちらが優先される。
15. 実行したディレクトリにある `.env` は読まれない（`AI_CHAT_LOGS_DB` を書いた `.env` のあるディレクトリで実行しても、その値が使われない）。
16. 書式のエラーのある `.env` では、CLI が終了コード2で終わり、標準エラー出力にパスと行番号が出る。
17. `bin/sync` が、`AI_CHAT_LOGS_ENV_FILE` で指定した `.env` の `AI_CHAT_LOGS_DB` に取り込む。

### `ecosystem.config.cjs`

18. `.env` の `AI_CHAT_LOGS_CRON` が `cron_restart` になる。環境変数の `AI_CHAT_LOGS_CRON` があればそちらが優先される。
19. 書式のエラーのある `.env` では、読み込みが例外で失敗する。

### `.env.example`

20. `.env.example` を `parseDotenv` で解釈すると、組が1つも無い（すべてコメント）。

## トレードオフ

- 自前のパーサにするため、dotenv の流儀の一部（展開、行をまたぐ値）に対応しない。そのかわり、Bun と Node.js で同じ値になり、書式を仕様書で決めきれる。必要な値はパスと cron の式だけで、展開が無くても困らない。
- パーサを CommonJS の JavaScript で書くため、ほかの TypeScript のソースと書き方が揃わない。`ecosystem.config.cjs` から `require` するために、型の宣言のファイルを別に置くほうを選ぶ。
- 既にある環境変数を優先するため、シェルに古い値が残っていると `.env` の値が効かない。一般的な dotenv の流儀と、Bun・Node.js の振る舞いに合わせる。
- 実行したディレクトリの `.env` を読まないため、Bun の流儀とは異なる。どこから実行しても同じ設定になることを優先する。

## 参考文献

- Bun の環境変数（`.env` の自動の読み込み、`--env-file`、`--no-env-file`）：https://bun.com/docs/runtime/environment-variables
- Node.js `process.loadEnvFile()`：https://nodejs.org/api/process.html#processloadenvfilepath
- dotenv の書式（motdotla/dotenv）：https://github.com/motdotla/dotenv#readme
