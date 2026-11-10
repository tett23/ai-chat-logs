# ai-chat-logs

AI のチャット履歴を SQLite に書き出し、定期的に保存するためのツール群。
Claude Code（デスクトップアプリの Code タブを含む）、claude.ai、Cowork、Codex を区別して保存する。
Claude Code、Cowork、Codex はローカルログから、claude.ai は公式のエクスポートから取り込む。

Claude Code は、既定で30日を過ぎたセッションの履歴を削除する。
このツールは、手元の履歴（`~/.claude/projects` の JSONL など）を差分で SQLite に取り込み、元のファイルが消えても取り込み済みの行を残す。

## 必要なもの

- [Bun](https://bun.com/)
- [pm2](https://pm2.keymetrics.io/)（定期実行する場合）

## 手動で行う作業

このツールは、システムの設定を変える作業（pm2 のインストール、launchd への登録、PATH の設定）を自動では行わない（[ADR 0002](docs/adr/0002-periodic-sync-with-pm2.md)）。次の作業は手で行う。

### 最初に一度

1. Bun を入れる。
2. pm2 を入れる：`bun add -g pm2`
3. Bun のグローバルの bin を PATH に入れる。場所は `bun pm bin -g` で分かる（例：`~/.cache/.bun/bin`）。シェルの設定ファイル（`~/.zshrc` など）に `export PATH="<その場所>:$PATH"` を書き、シェルを開きなおす。
   - これをしないと `pm2` が見つからない。zsh では `zsh: correct 'pm2' to '_pm2' [nyae]?` と聞かれる（`n` で答える）。
   - 一時的に PATH を足すだけでも動くが、`pm2 startup` がその時点の PATH を launchd に書き込むため、設定ファイルに書いて永続させる。
4. `bun` と `pm2` の両方が見つかるシェルで、リポジトリのルートから取り込みを登録する：`pm2 start ecosystem.config.cjs`
   - 登録した時点で1回目の取り込みが始まる。履歴の量によっては数十秒から数分かかる。`pm2 status ai-chat-logs-sync` が `stopped` になれば終わり。
5. `pm2 startup` を実行し、表示された `sudo` のコマンドを、内容を確かめてから実行する。
6. `pm2 save` を実行する。
7. 確かめる：`pm2 logs ai-chat-logs-sync --lines 5` に `run=… errors=0` が出ていること。

5 と 6 をしないと、再起動の後に取り込みが黙って止まる（下の「定期的に取り込む」を参照）。

### claude.ai の会話を取り込むとき

claude.ai（Web とデスクトップアプリのチャット）の会話は手元に無いため、公式のエクスポートから取り込む（[ADR 0006](docs/adr/0006-import-cowork-and-claude-ai-chats.md)）。自動では最新にならないので、取り込みたいときに繰り返す。

1. claude.ai の設定 → Privacy → Export data でエクスポートを要求する。
2. 届いたメールのリンクから zip をダウンロードする（ダウンロードフォルダに置く）。
3. あとは次の取り込み（pm2 の定期実行（既定では4時間ごと）か `bin/sync`）で、自動で変換されてデータベースに入る（[ADR 0010](docs/adr/0010-scan-downloads-for-claude-ai-exports.md)）。すぐに取り込みたいときは、GUI の閲覧の画面の「ダウンロードしたエクスポートを取り込む」を押す。

- 受け取り用のディレクトリは `AI_CHAT_LOGS_CLAUDE_AI_INBOX`（既定は `~/Downloads`）で変えられる。直下の zip のうち、中に `conversations.json` があるものをエクスポートとみなす。名前は問わない。
- 取り込み済みかどうかは中身で見分けるので、zip を残しておいても二重には入らない。zip は消さない。
- 元のファイルと変換した `messages.jsonl` は `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude-ai/<ID>/` に置かれる（場所は `AI_CHAT_LOGS_CLAUDE_AI_DIR` で変えられる）。
- 手で変換することもできる：`bun src/cli/claude-ai-export-convert.ts <zip か conversations.json>`。GUI の管理画面の「claude.ai のエクスポートを取り込む」では、zip を選んで取り込める。
- macOS はダウンロードフォルダをプライバシー保護（TCC）の対象にしているため、pm2 の定期実行から読めないことがある。`pm2 logs ai-chat-logs-sync` に `cannot read` と `Operation not permitted` が出たら、受け取り用のディレクトリをダウンロードフォルダ以外にして zip をそこへ置くか、システム設定 → プライバシーとセキュリティ → ファイルとフォルダ（またはフルディスクアクセス）で許可する。GUI も別のアプリとして許可を受ける。

何度エクスポートしても、同じメッセージは会話・検索・件数に1回だけ出る。

### 設定を変えたとき

- `.env` の `AI_CHAT_LOGS_DB`、`CLAUDE_CONFIG_DIR`、`XDG_DATA_HOME`、`AI_CHAT_LOGS_CLAUDE_AI_DIR`、`AI_CHAT_LOGS_CLAUDE_AI_INBOX` は、次の取り込みから効く。登録しなおす必要は無い。
- `AI_CHAT_LOGS_CRON` を変えたら、`pm2 delete ai-chat-logs-sync`、`pm2 start ecosystem.config.cjs`、`pm2 save` で登録しなおす。

### コマンドをインストールするとき

`bin/install` で、コマンドを単体で動く実行ファイルにビルドし、`~/.local/bin`（引数で変えられる）に入れる（[ADR 0008](docs/adr/0008-install-compiled-commands.md)）。

```sh
bin/install
```

- 入るもの：`claude-log-sources`、`chat-log-import`、`claude-ai-export-convert`、`claude-ai-export-scan`、`chat-log`（それぞれ 70MB ほど）、`codex-log-convert`、`codex-log-sources` と、それらで取り込む `ai-chat-logs-sync`。`bun` が無い環境でも動く。
- リポジトリの場所を埋めこむ。`.env` は、埋めこんだリポジトリのものを読む。実行したディレクトリの `.env` は読まない。
- pm2 の定期実行と GUI の取り込みは、これまでどおりリポジトリの `bin/sync` を使う。インストールしたコマンドには依存しない。

### リポジトリを更新したとき

- `git pull` するだけでよい。スキーマの変更（マイグレーション）は、次の取り込みのときに自動で当たる。
- スキーマ 6（[ADR 0031](docs/adr/0031-store-large-strings-as-compressed-payloads.md)）へは、最初の取り込みで、いまある行をすべて変換する（84.5 万行で約40秒）。更新手順は以下のスキーマ別の説明を参照。ファイルを縮めるには、[データベースを縮める](#データベースを縮める)。
- `bin/install` でコマンドを入れている場合は、`bin/install` を実行しなおす。リポジトリを動かした場合も同じ。
- `ecosystem.config.cjs` が変わったときは、`pm2 delete ai-chat-logs-sync`、`pm2 start ecosystem.config.cjs`、`pm2 save` で登録しなおす。

### スキーマ 8 へ更新するとき

GUI はスキーマ 8、読み出し用の `chat-log` は 7 以降を使用する。定期取り込みと GUI を終了し、SQLite の `.backup` でバックアップを取ってから、新しい `chat-log-import` で取り込む。初回は保存済みの Codex 原本から表示用の情報を作る。既存の会話、全文検索の索引、原本はそのまま残る。更新後は GUI で会話と検索を確認して定期取り込みを再開する。

### スキーマ 7 へ更新するとき

スキーマ 7 は、Codex の会話を保存するためのビューと、提供元を区別する会話取得に対応する（[ADR 0033](docs/adr/0033-codex-conversation-database-migration.md)）。
既存の記録、検索索引、要約は保持する。
この版の `chat-log` と GUI はスキーマ 7 が必要になる。

1. `pm2 stop ai-chat-logs-sync` で定期取り込みを止め、GUI からの取り込みも終了させる。
2. SQLite のバックアップ機能で退避する。既定の DBなら `sqlite3 ~/.local/share/ai-chat-logs/logs.sqlite '.backup /absolute/path/logs-before-v7.sqlite'` とする。稼働中の DB本体だけをコピーしない。
3. 復旧用に旧 CLI と GUI を別の場所へ保存してから、新しい CLI と GUI をビルドし、インストールする。
4. `bin/sync` を1回実行する。最初の取り込みでマイグレーションが適用される。
5. 新しい GUI と `chat-log` で既存の会話と検索を確認し、`pm2 start ai-chat-logs-sync` で定期取り込みを再開する。

移行後に旧バイナリを使わない。
戻す場合はすべての取り込みと GUIを終了させ、バックアップと旧バイナリを対で復元する。
復元先の DB 本体と WAL/SHM を別の退避先に移してから、バックアップを DB のパスに戻す。
復元後、全アプリを閉じたまま `sqlite3 <復元先のDBパス> "PRAGMA journal_mode=DELETE;"` を実行してから旧 GUI と CLI を開く。
WAL の補助ファイルが無いバックアップを、読み取り専用の CLI でも開けるようにする。
次の取り込みでは通常どおり WAL に戻る。
バックアップ後の記録は退避した DB と元ログから再取り込みする必要があるため、元ログも消さない。

### pm2 や Bun を入れなおしたとき

pm2 や `bun` の場所が変わると、launchd に書き込まれた PATH と合わなくなる。`pm2 unstartup` で登録を消し、表示された `sudo` のコマンドを実行してから、上の 5 と 6 をやりなおす。

### 再起動の後

`pm2 status ai-chat-logs-sync` でアプリがあることを確かめる。無ければ `pm2 startup` か `pm2 save` が済んでいない。

### GUI を使うとき

`gui/` でビルドし、アプリを起動する（下の「閲覧・検索する」を参照）。データベースが既定の場所に無い場合は、起動するときに `AI_CHAT_LOGS_DB` を渡す。

### 開発するとき

クローンごとに `git config core.hooksPath .githooks` を実行する（下の「開発」を参照）。

## Codex のログを保存する

Codex の `~/.codex/sessions` と `~/.codex/archived_sessions` 以下の JSONL を、既存の `bin/sync` と定期取り込みで保存する（[ADR 0034](docs/adr/0034-import-codex-rollouts.md)）。
読み込み元は `AI_CHAT_LOGS_CODEX_DIR`、保存先は `AI_CHAT_LOGS_CODEX_STORE` で変えられる。

元ログの完成した行までを、その完成した範囲の SHA-256 を名前にしたディレクトリへコピーする。
同じディレクトリに、閲覧用の `messages-v1.jsonl` と処理結果の `manifest-v1.json` を置く。
元ログは変更しない。
同じ入力を再取り込みしても、会話の写しは増えない。
ログが伸びた場合は新しいコピーを残すため、長い会話では保存容量が増える。

Codex の親とサブエージェントは別会話になる。
公開された本文、思考の要約、ツールの呼び出しと結果、エージェント間通信を表示する。
暗号化された内容は復号せず、表示できない旨を示す。
同じ元 IDで内容が変わった項目は異なる版として保持する。

`bin/install` でコマンドをインストールした後、変換、列挙、取り込みを分けて実行することもできる。

```sh
codex-log-convert
codex-log-sources | chat-log-import
```

単独の Codex 列挙に `--mark-missing` を付けると、Claude の入力を見つからないものとして記録するため、付けない。
全提供元をまとめて処理するときは `bin/sync` を使う。

## 使い方

### 1回だけ取り込む

```sh
bin/sync
```

取り込む対象の列挙と取り込みは、別のコマンドに分かれている。
`bin/sync` は claude.ai のスキャンと Codex の変換を行い、全提供元の列挙をまとめて取り込む。
次は Claude だけを列挙する例。

```sh
bun src/cli/sources.ts                             # "<種類>\t<絶対パス>" を1行ずつ出力する
bun src/cli/sources.ts | bun src/cli/import.ts     # 標準入力の対象を差分で取り込む
```

`chat-log-import`（`src/cli/import.ts`）のオプション：

| オプション | 意味 |
|---|---|
| `--db <パス>` | データベースのパス |
| `--mark-missing` | 標準入力に無い取り込み済みのファイルに、見つからなくなった時刻を記録する（`bin/sync` は付ける） |

ファイルの読み込みなどに1つでも失敗すると、ほかのファイルを取り込んだうえで終了コード1で終わる。

### 定期的に取り込む（pm2）

次の4つをすべて行う。

```sh
bun add -g pm2                  # 1. pm2 を入れる
pm2 start ecosystem.config.cjs  # 2. 取り込みを登録する
pm2 startup                     # 3. OS の起動時に pm2 が立ち上がるようにする
pm2 save                        # 4. 登録したアプリを保存する
```

**`pm2 startup` と `pm2 save` は必須。**
pm2 のデーモンは、再起動やログアウトで止まる。
`pm2 startup` をしていないと、再起動の後は取り込みが一度も実行されず、エラーも出ない。
そのまま30日が過ぎると、Claude Code が古い履歴を削除し、取り込まれないまま失われる。

- `pm2 startup` は、launchd（macOS）や systemd（Linux）に登録するためのコマンドを表示する。表示されたコマンドを、内容を確かめてから実行する（`sudo` が要る）。
- `pm2 save` は、その時点で登録されているアプリを保存し、起動時に復元させる。`pm2 start` や `pm2 delete` で登録を変えたら、`pm2 save` をやりなおす。
- 再起動の後に `pm2 status ai-chat-logs-sync` でアプリがあること、データベースの `runs` 表に新しい行が入っていることを確かめるとよい。
- 登録した時点で1回実行され、以後は4時間ごと（0、4、8、12、16、20時）の0分に実行される（[ADR 0029](docs/adr/0029-sync-every-four-hours-by-default.md)）。間隔は `AI_CHAT_LOGS_CRON`（cron の式。環境変数か `.env`）で変えられる。
- 間隔の既定や `AI_CHAT_LOGS_CRON` を変えたときは、`pm2 delete ai-chat-logs-sync`、`pm2 start ecosystem.config.cjs`、`pm2 save` で登録しなおす。登録したときの値が使われ続ける。
- `pm2 start` を実行したシェルの `PATH` を引き継ぎ、`pm2 save` で保存される。`bun` が見つからないと、`bin/sync` は終了コード127で終わる。
- 状態は `pm2 status ai-chat-logs-sync`、ログは `pm2 logs ai-chat-logs-sync` で見る。
- 止めるときは `pm2 delete ai-chat-logs-sync` の後に `pm2 save` を実行する（しないと、次の起動時に復元される）。

### 設定（環境変数と .env）

| 変数 | 意味 | 既定 |
|---|---|---|
| `AI_CHAT_LOGS_DB` | データベースのパス | `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/logs.sqlite` |
| `XDG_DATA_HOME` | データベースの既定の場所の基準 | `~/.local/share` |
| `CLAUDE_CONFIG_DIR` | Claude Code の設定ディレクトリ | `~/.claude` |
| `AI_CHAT_LOGS_CLAUDE_AI_INBOX` | claude.ai のエクスポートの受け取り用のディレクトリ | `~/Downloads` |
| `AI_CHAT_LOGS_CLAUDE_AI_DIR` | claude.ai のエクスポートの保存用のディレクトリ | `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/claude-ai` |
| `AI_CHAT_LOGS_CRON` | pm2 で実行する時刻（cron の式） | `0 */4 * * *` |
| `AI_CHAT_LOGS_CLAUDE_DESKTOP_DIR` | デスクトップアプリのディレクトリ | `~/Library/Application Support/Claude` |
| `AI_CHAT_LOGS_ENV_FILE` | 読む `.env` のパス | リポジトリのルートの `.env` |
| `AI_CHAT_LOGS_CODEX_DIR` | Codex のローカルログを読むディレクトリ | `~/.codex` |
| `AI_CHAT_LOGS_CODEX_STORE` | Codex の原本と変換結果の保存先 | `${XDG_DATA_HOME:-~/.local/share}/ai-chat-logs/codex` |
| `AI_CHAT_LOGS_CONFIG` | 読む設定ファイルのパス | `${XDG_CONFIG_HOME:-~/.config}/ai-chat-logs/config.env` |

これらは、リポジトリのルートの `.env` と、設定ファイル（GUI の管理画面が書く）にも書ける。値は、環境変数、`.env`、設定ファイル、既定の順に決まる（[ADR 0007](docs/adr/0007-settings-and-setup-screen.md)）。書式はどちらも同じ。

```sh
cp .env.example .env   # 使う行のコメントを外して値を書く
```

- 既にある環境変数は `.env` と設定ファイルより、`.env` は設定ファイルより優先される。
- 実行したディレクトリの `.env` は読まない。どこから実行しても、リポジトリのルートの `.env`（または `AI_CHAT_LOGS_ENV_FILE`）だけを読む。
- `$` と `~` は展開しない。パスは絶対パスで書く。
- `.env` か設定ファイルの書式に誤りがあると、CLI は終了コード2で終わり、`pm2 start` は失敗する。メッセージにファイルのパスと行番号が出る。
- `AI_CHAT_LOGS_CRON` は `pm2 start` のときに読まれる。変えたら `pm2 delete ai-chat-logs-sync`、`pm2 start ecosystem.config.cjs`、`pm2 save` で登録しなおす。

書式の詳細は [docs/specifications.md](docs/specifications.md) を参照。

データベースには秘密の情報が含まれうるため、権限 `0600` で作られる。

### データベースを読む

```sh
sqlite3 ~/.local/share/ai-chat-logs/logs.sqlite \
  "SELECT timestamp, role, substr(content, 1, 80) FROM messages WHERE provider = '<提供元>' AND session_id = '<セッションID>' ORDER BY timestamp"
```

表とビューは [docs/specifications.md](docs/specifications.md) を参照。

`records.raw` のうち、1024 バイト以上の文字列（ツールの結果、ツールの入力、画像など）は `payloads` の表に移してあり、`raw` には目印（`"\u0000ai-chat-logs-payload:<sha256>"`）が入っている。本文、思考、`cwd` などの SQL で読む値は移さない。元のとおりの行が要るときは、`chat-log show --json` や `chat-log export` を使う（[ADR 0031](docs/adr/0031-store-large-strings-as-compressed-payloads.md)）。

### データベースを縮める

スキーマ 6（[ADR 0031](docs/adr/0031-store-large-strings-as-compressed-payloads.md)）への移行で、大きな文字列は `payloads` の表に、重複を除いて圧縮して移る。移した後の空きは、次からの取り込みで使いまわされるが、ファイルは縮まない。ファイルを縮めるときは、取り込みを止めて `VACUUM` を実行する。

```sh
pm2 stop ai-chat-logs-sync
sqlite3 ~/.local/share/ai-chat-logs/logs.sqlite VACUUM
pm2 start ai-chat-logs-sync
```

- `VACUUM` は、データベースと同じくらいの空き容量を一時的に使う。
- 2026-11-08 の手元のデータベース（7.78 GB、84.5 万行）では、移行の変換が 38 秒、その後の `VACUUM INTO` が 10 秒かかり、5.33 GB になった（`records` が 5,767 MB から 2,359 MB に、`payloads` が 1,156 MB）。
- GUI は読み取り専用で開くので、`VACUUM` の間は開いていてもよいが、待たされることがある。

### AI に履歴を引かせる（chat-log）

`chat-log` は、AI のエージェント（Claude Code など）が過去の経緯や決定を思い出して文脈を戻すための、読み取り専用の CLI（[ADR 0011](docs/adr/0011-cli-for-ai-agents.md)、[ADR 0013](docs/adr/0013-chat-log-output-corrections.md)、[ADR 0018](docs/adr/0018-chat-log-snippets-until-and-help.md)）。使い方は `chat-log --help` に全部書いてあり、AI はヘルプだけで使える。

```sh
bun src/cli/chat-log.ts context                     # いまのプロジェクトの最近のセッションと最後のやりとり
bun src/cli/chat-log.ts search 写し --cwd .          # 全文検索（結果に <セッションID>#<番号> が出る）
bun src/cli/chat-log.ts search 'uuid のみ' --tools --cwd .   # ツールの入出力（ファイルの編集など）も探す
bun src/cli/chat-log.ts search 写し --exclude 写して --cwd .   # 語を除く
bun src/cli/chat-log.ts export f0f40b1f > session.md   # セッションの全文を Markdown で書き出す
bun src/cli/chat-log.ts show f0f40b1f --provider claude-code --around 563   # その前後の10件を読む
bun src/cli/chat-log.ts search pm2 --since 2026-10-01 --until 2026-10-08   # 期間で絞る
```

- `bin/install` で `~/.local/bin/chat-log` に入る。
- 会話は提供元と IDの組で識別する。`show` と `export` で IDが複数の提供元に一致したときは、`--provider claude-code` などで指定する。候補が無い場合は終了コード1、複数の場合は2になる。
- 出力は短い決まった形のテキスト（`--json` で JSON Lines）。本文は既定で切りつめ、ツールの入出力は1行に要約し、思考は出さない（オプションで出せる）。
- 抜粋は語ごとに一致した位置の前後で、すべての語の一致を `⟪ ⟫` で囲む（本文の `**` は Markdown の太字）。
- AI に使わせるときは、作業の指示や `CLAUDE.md` に「過去の経緯は `chat-log --help` を読んで `chat-log` で調べる」と書いておく。
- 履歴には秘密の情報が含まれうる。AI に読ませた内容は、その AI の提供元に送られる。

### 閲覧・検索する（GUI）

`gui/` に、履歴を閲覧・検索する Tauri のアプリがある。データベースは読み取り専用で開くため、pm2 の取り込みと同時に使える。

```sh
cd gui
bun install
bun run tauri dev          # 開発用に起動する
bun run tauri build        # アプリをビルドする（src-tauri/target/release/bundle/macos/AI Chat Logs.app）
```

- アイコンの元は `gui/app-icon.svg`。変えたら `gui/` で `bun run tauri icon app-icon.svg` を実行し、`src-tauri/icons/` のうち、もとからあるファイル（`32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.icns`、`icon.ico`、`icon.png`）だけをコミットする。ほかに作られたファイル（iOS、Android、Windows のストア向け）は消す（[ADR 0030](docs/adr/0030-gui-app-icon.md)）。

- 必要なもの：Rust（stable）と、Tauri の前提のライブラリ（macOS では Xcode の Command Line Tools）。
- 設定は CLI と同じく、環境変数、`.env`、設定ファイル、既定の順に決まる。Finder から起動したアプリには環境変数が渡らないため、既定以外の場所は管理画面で設定ファイルに書く。
- 「管理」の画面で次ができる（[ADR 0007](docs/adr/0007-settings-and-setup-screen.md)）。データベースが開けないときは、起動時にこの画面が開く。
  - 設定：各パスと `bun` の場所の確認と変更（設定ファイルに書く）。値がどこから来たかも出す。
  - 環境の検査：パス、データベース、最後の取り込み、`bun`、pm2 の登録、launchd の登録。
  - 初期化：取り込み（データベースが無ければ作る）と、claude.ai のエクスポートの zip の取り込み。
- GUI は取り込みのときに、このリポジトリ（`AI_CHAT_LOGS_REPO`。既定はビルドしたリポジトリ）のコマンドを `bun` で実行する。pm2 の操作はしない。
- 左にセッションの一覧、上に検索の入力欄、右に会話を出す。会話を開く前の右の欄には、データベースのパスと、ディスクで使っている容量（`-wal` と `-shm` を含む）が出る（[ADR 0025](docs/adr/0025-gui-show-database-size.md)）。プロジェクトの絞り込みで、Claude Code と Codex の作業ディレクトリのほか「claude.ai」「Cowork」を選べる。3文字以上の語は全文検索の索引で引き、3文字未満の語は全件を走査する（遅い）。
- ツールの入出力などの長いブロックは先頭の 4,000 文字だけを出し、「全文を読み込む」で残りを読む。
- 会話は新しい順に出す（いちばん上が最後のメッセージ。[ADR 0016](docs/adr/0016-show-conversations-newest-first.md)）。100件ずつ読みこみ、下へスクロールすると古いほうを、検索の結果から途中を開いたときは上へスクロールすると新しいほうを読みこむ（[ADR 0014](docs/adr/0014-load-conversations-in-pages.md)）。会話の上に、読みこんだ範囲と総数が出る。番号は時刻の順に付く（`chat-log` と同じ）。
- 会話の上の「書き出す」で、開いているセッションの全文を Markdown のファイルに書き出せる（中身は `chat-log export` と同じ）。検索の結果から開いた会話では、本文の中の検索の語句が強調される（[ADR 0026](docs/adr/0026-export-sessions-and-highlight-terms.md)）。
- 会話の上の「表示」のメニューで、thinking、tool_use、tool_result の行を隠せる。何も出なくなったメッセージは見出しごと隠れる。選んだ状態は次に起動したときも残る（[ADR 0024](docs/adr/0024-gui-conversation-header-and-block-filter.md)）。

### Codex の表示と設定

会話一覧、検索結果、会話ヘッダーでは、Claude Code、claude.ai、Cowork、Codex をそれぞれの名前で表示する（[ADR 0032](docs/adr/0032-codex-import-ui-and-provider-labels.md)）。
保存済みのタイトルは変えない。
Codex は作業ディレクトリごとに絞れ、記録にディレクトリが無い会話は「Codex / 作業ディレクトリなし」で選べる。

起動時の一覧と検索には、通常の会話と分類できない会話を表示する。Codex のサブエージェントや内部処理を探すには、会話の種類を切り替える。親の会話が保存されていれば、子から親を開ける。Codex の見出しには先頭の環境指示を取り除いた利用者の依頼を使う（[ADR 0037](docs/adr/0037-codex-session-presentation.md)）。

暗号化されて読めない箇所を確認したいときは「表示できない内容」をオンにする。この設定は次回も引き継ぐ。置き換え表示の文言は検索対象から除くが、利用者自身が同じ文言を書いた発言は検索できる。

管理画面では、既存の設定と同じ方法で Codex の読み込み元と保存先を設定する。
空欄で保存するとその設定を消し、環境変数、`.env`、設定ファイル、既定の順に値を決め直す。
Codex 専用の取り込みボタンは追加せず、既存の「取り込む」を使う。
ChatGPT のエクスポートは未対応である。

## 開発

クローン後、gitのhookを有効化する。コミット済みのADRの変更は [adr-guard](https://github.com/tett23/adr-guard) で拒否する。ただし、ステータスの行とリンクだけの変更は許可する（[ADR 0009](docs/adr/0009-update-adr-guard-to-v0-8-2.md)、[ADR 0012](docs/adr/0012-update-adr-guard-to-v0-8-3.md)、[ADR 0028](docs/adr/0028-update-adr-guard-to-v0-10-0.md)）。

```sh
git config core.hooksPath .githooks
```

テストは `bun test` で実行する。GUI のテストは `gui/` で `bun test`、`gui/src-tauri/` で `cargo test`。

設計判断は `docs/adr/` にADRとして記録する。仕様は [docs/specifications.md](docs/specifications.md) を参照。

ADR のステータスは次のように移る（[ADR 0015](docs/adr/0015-distinguish-accepted-and-unimplemented-adrs.md)）。

| 値 | 意味 |
|---|---|
| `提案` | レビュー待ち。コミットしない |
| `採択（未実装）` | 採択した。実装はまだ main に入っていない。`adr-guard unimplemented` で一覧できる |
| `採択` | 実装が main に入った（実装の要らない ADR は採択した時点で `採択`） |
| `採択→<変わった部分>は ADR NNNN` | 一部が後の ADR で変わった |

- 採択した ADR は `採択（未実装）` でコミットし、実装の PR でステータスを `採択` にする。実装を複数の PR に分けるときは、最後の PR で変える。

## License

[MIT](LICENSE)
