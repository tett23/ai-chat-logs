# ADR 0015: ADR のステータスで「採択」と「採択（未実装）」を区別する

ステータス: 採択（未実装）

## 文脈

このリポジトリの ADR は、ステータスの行（`ステータス: …`）を持つ。
[adr-guard](https://github.com/tett23/adr-guard) は、コミット済みの ADR の変更をステータスの行を除いて拒否する。
adr-guard v0.8.3（[ADR 0012](0012-update-adr-guard-to-v0-8-3.md) で導入）は、`採択（未実装）…` で始まる値を「採択されたが、まだ実装されていない」（AcceptedNotImplemented）として、`採択…` の採択済み（Accepted）と区別する。
`adr-guard unimplemented` は、ステータスが `採択（未実装）` の ADR を一覧する。

これまでのステータスの値は、`提案`、`採択`、`採択→…（変更部分）は ADR NNNN` の3種類だけで、採択した時点と実装が済んだ時点を区別していなかった。
そのため、ステータスの行からは、ADR が実装済みかどうかが分からない。
実際、ADR を採択してから実装の PR がマージされるまでのあいだ（AI 向けの CLI の ADR など）も、ステータスは `採択` だった。

利用者の運用では、採択して実装を待つ ADR を `採択（未実装）` とし、未実装の ADR をまとめて実装する手順（エージェントに、`採択（未実装）` の ADR を探して実装させ、実装の PR でステータスを `採択` にさせる）をとっている。
adr-guard は道具としてこの区別を持つが、このリポジトリでいつどの値を使うかを決めた ADR は無い。

また、[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) の参考文献は、adr-guard のリポジトリの ADR 0015 を、リンクの無い「tett23/adr-guard ADR 0015」という文字で書いている。
adr-guard のリンクの検査（`adr-guard links`）は、文書の中の `ADR 0015` の形の参照に、このリポジトリの ADR 0015 へのリンクを求める。
このリポジトリに ADR 0015 を足すと、[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) の参考文献の行が、リンクの無い参照として CI の `adr` ジョブで失敗する。

## 実装すること

### ステータスの値

| 値 | 意味 |
|---|---|
| `提案` | レビュー待ち。コミットしない |
| `採択（未実装）` | 採択した。実装はまだ main に入っていない |
| `採択` | 採択し、実装が main に入った（実装の要らない ADR は、採択した時点で `採択`） |
| `採択→<変わった部分>は ADR NNNN` | 採択し、一部が後の ADR で変わった。実装の状態は、変えた側の ADR のステータスで分かる |
| `却下`、`破棄` | これまでどおり |

- adr-guard v0.8.3 は、`採択（未実装）` を AcceptedNotImplemented、`採択` を Accepted として区別する。未実装の ADR は `adr-guard unimplemented` で一覧できる。

### 移り方

1. ADR を書いて `提案` のままレビューを受ける（コミットしない）。
2. 採択されたら、実装の要る ADR は `採択（未実装）` にしてコミットする。実装の要らない ADR（手順や方針だけを決めるもの）は `採択` にしてコミットする。
3. 実装の PR に、その ADR のステータスを `採択（未実装）` から `採択` にする変更を含める。PR がマージされた時点で、main の ADR は `採択` になる。
4. 実装を複数の PR に分けるときは、最後の PR で `採択` にする。

ステータスの行の変更は、adr-guard の `--allow-status` で許可されている。

### 既存の ADR

- main にある ADR（0001〜0010、0012）は、すべて実装が main に入っているので、`採択` のままにする。
- 実装中の ADR（0011、0013、0014）は、コミットするときに `採択（未実装）` とし、それぞれの実装の PR で `採択` にする。
- この ADR は、README への記載を実装とする。この ADR を `採択（未実装）` で入れ、README に書く実装の PR で `採択` にする。

### [ADR 0009](0009-update-adr-guard-to-v0-8-2.md) の参考文献のリンク

[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) の参考文献の「tett23/adr-guard ADR 0015「…」：<URL>」の「tett23/adr-guard ADR 0015「…」」の部分を、`[tett23/adr-guard ADR 0015「…」](<URL>)` のリンクで囲む。見える文字（後ろの「：<URL>」を含む）は変えない。
リンクの文字の中の `ADR 0015` は、adr-guard のリンクの検査の対象外になる。
コミット済みの ADR の、リンクだけの変更であり、adr-guard v0.8.2 からの `--allow-links` で許可される。
この修正は、この ADR を入れる PR に含める（この ADR だけを入れると、CI のリンクの検査が [ADR 0009](0009-update-adr-guard-to-v0-8-2.md) で失敗するため）。

### ドキュメント

README の「開発」に、ステータスの値と移り方を短く書く。
`docs/specifications.md` は製品の仕様を書く文書なので、変えない。

## 実装しないこと

- CI で、`採択（未実装）` のまま main に残っている ADR を検出すること（`adr-guard unimplemented` で手元で一覧できる）。
- 過去の ADR のステータスの履歴を書き足すこと（git の履歴で分かる）。

## テスト設計

自動テストの対象になるコードは無い。次のことを確かめる。

1. `adr-guard check-status` が、`採択（未実装）` のステータスの行を持つ ADR を違反にせず、`adr-guard unimplemented` がその ADR を出力する。
2. コミット済みの ADR のステータスを `採択（未実装）` から `採択` に変えるコミットが、pre-commit の adr-guard（`--allow-status`）を通り、`adr-guard unimplemented` から消える。
3. この ADR を足した状態で `adr-guard links` が終了コード0で終わる（[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) の参考文献のリンクの修正が効いている）。[ADR 0009](0009-update-adr-guard-to-v0-8-2.md) の変更のコミットが、pre-commit の adr-guard（`--allow-links`）を通る。
4. 次に実装する ADR（0011、0013、0014 のいずれか）の PR で、上の移り方のとおりにステータスが変わり、CI の `adr` ジョブが通る。

## トレードオフ

- ステータスで実装の状態が分かるようになるが、実装の PR でステータスを変えるのを忘れると、実装済みなのに `採択（未実装）` のまま残る。CI での検出は入れず、PR のレビューで確かめる。
- `採択→…` のステータスは実装の状態を示さない。変えた側の ADR のステータスを見る必要がある。

## 参考文献

- adr-guard の README（ステータスの行、`--allow-status`、`--allow-links`、`unimplemented`）：https://github.com/tett23/adr-guard
- [tett23/adr-guard ADR 0016「ステータス `採択（未実装）` を加え、未実装のADRを一覧する `unimplemented` サブコマンド」](https://github.com/tett23/adr-guard/blob/main/docs/adr/0016-accepted-not-implemented-status.md)
