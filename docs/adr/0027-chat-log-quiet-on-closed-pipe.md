# ADR 0027: chat-log の出力先のパイプが閉じられたら静かに終わる

ステータス: 採択

## 文脈

`chat-log`（[ADR 0011](0011-cli-for-ai-agents.md)）は、結果を1つの文字列にまとめて、最後に標準出力へ1回で書く。

出力を `head` などに流し、受け手が途中で読むのをやめると、`chat-log` は次のように終わる（`~/.local/bin` に入れた実行ファイル、2026-11-07 に確かめた）。

| コマンド | 終了コード | 標準エラー出力 |
|---|---|---|
| `chat-log show f0f40b1f --limit 2000 --max-chars 0 \| head -1` | 1 | `EPIPE: broken pipe, write` と Bun のスタックの 7 行 |
| `chat-log search ADR --limit 500 \| head -1` | 1 | 同じ |
| `chat-log export f0f40b1f \| head -1` | 1 | 同じ |
| `chat-log sessions --limit 500 \| head -1` | 0 | なし |
| `chat-log context --all --limit 50 \| head -1` | 0 | なし |
| `chat-log --help \| head -1` | 0 | なし |

出力の小さいもの（パイプの溜め、macOS では 64 KB に収まるもの）では起きず、大きいものでだけ起きると見ている。
`head` や `less` に流す使い方は、全文を書き出す `export`（[ADR 0026](0026-export-sessions-and-highlight-terms.md)）を足したことで増える。
出力そのもの（受け手が読んだ分）は正しいが、エラーとスタックが出るため、失敗したように見える。
AI のエージェントが `chat-log ... | head` を実行したときも、失敗と取り違えうる。

## 実装すること

- `chat-log` の標準出力への書き込みが、出力先のパイプが閉じられたために失敗したとき（`EPIPE`）は、標準エラー出力に何も書かず、終了コード 0 で終わる。
- それ以外の書き込みの失敗は、これまでどおり扱う（エラーを出し、0 以外で終わる）。
- 使い方の誤りやセッションが無いときの終了コード（1、2）と、そのメッセージは変えない。

## 実装しないこと

- 出力を少しずつ書くようにすること（いまは1回で書く）。
- ほかの CLI（`claude-log-sources`、`chat-log-import` など）の変更。これらは `bin/sync` の中で互いにつながれ、受け手が途中で読むのをやめることが無い。
- `SIGPIPE` で終わったときと同じ終了コード（141）を返すこと。

## テスト設計

### `chat-log`（`bun test`、コマンド）

1. パイプの溜めより大きな出力（`export` で全文を書く、10 万文字のメッセージを持つセッション）を、1 行だけ読んで閉じる受け手につなぐと、`chat-log` が終了コード 0 で終わり、標準エラー出力が空になる。
2. 同じことを `show`（`--max-chars 0`）と `search` でも確かめる。
3. 受け手が最後まで読むときの出力と終了コードは変わらない（既存のテスト）。

### 手で確かめること

1. `bin/install` で入れた実行ファイルで、文脈の表の `show`、`search`、`export` を `| head -1` で実行し、終了コードが 0 で、標準エラー出力に何も出ないことを確かめる。

## トレードオフ

- `set -o pipefail` のもとでも、`chat-log ... | head` は成功として扱われる。受け手が読むのをやめたのは受け手の判断であり、`chat-log` の失敗ではないとする。
- GNU の道具の多くは `SIGPIPE` で終わり、シェルには終了コード 141 として見える。`chat-log` はそれと異なり 0 を返す。`pipefail` のスクリプトで `| head` が失敗にならないことを優先する。

## 参考文献

- POSIX `write()`（EPIPE と SIGPIPE）：https://pubs.opengroup.org/onlinepubs/9799919799/functions/write.html
- Node.js の `process.stdout` と EPIPE：https://nodejs.org/api/process.html#a-note-on-process-io
